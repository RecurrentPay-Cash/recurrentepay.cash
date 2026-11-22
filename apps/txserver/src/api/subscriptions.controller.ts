/**
 * Subscription REST API (Slice 4, spec § API for web app, § Subscription
 * filtering, § Future-periods computation).
 *
 * All routes require the party-pkh auth guard; every read is scoped to the
 * authenticated pkh (a caller never sees another party's subscriptions). Derived
 * fields (`status`, `arrears` n', `futurePeriods`, `nextPaymentAt`) are
 * recomputed from the stored cache row + the clock on each request — the chain
 * remains the source of truth.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { hexToBin } from '@bitauth/libauth';
import { deriveState, type SubscriptionStatus } from 'shared';
import { Subscription } from '../db/subscription.entity.js';
import { Pull } from '../db/pull.entity.js';
import { SubscriptionRepository } from '../subscription/subscription.repository.js';
import { AuthGuard, type AuthedRequest } from '../auth/auth.guard.js';
import { AutoCancelPolicyRepository } from './auto-cancel-policy.repository.js';
import { NotificationRepository } from '../notifications/notification.repository.js';
import { NotificationReadRepository } from '../notifications/notification-read.repository.js';
import { toView as toNotificationView } from './notifications.controller.js';
import { ScheduledCancelService } from '../cancel/scheduled-cancel.service.js';
import { OffchainService } from '../offchain/offchain.service.js';
import { DiscoveryService } from '../discovery/discovery.service.js';
import { OracleActionsService } from '../pull/oracle-actions.service.js';
import { TokenActionsService } from '../pull/token-actions.service.js';
import { PullRepository } from '../pull/pull.repository.js';
import { parseId } from './query-id.js';

/** Filtering query (§ Subscription filtering — basic). */
export interface SubscriptionFilter {
  /** Restrict to subs the caller is party to in this role. */
  role?: 'supporter' | 'supportee' | 'service';
  /** Restrict to a derived state. */
  state?: SubscriptionStatus;
  /** Restrict by the off-chain channel link (Slice 6 populates links). */
  channel?: string;
  /** Restrict by the off-chain plan link (Slice 6 populates links). */
  plan?: string;
}

@Controller('subscriptions')
@UseGuards(AuthGuard)
export class SubscriptionsController {
  constructor(
    private readonly repository: SubscriptionRepository,
    private readonly policies: AutoCancelPolicyRepository,
    private readonly notifications: NotificationRepository,
    private readonly notificationReads: NotificationReadRepository,
    private readonly scheduledCancels: ScheduledCancelService,
    private readonly guard: AuthGuard,
    private readonly offchain: OffchainService,
    private readonly discovery: DiscoveryService,
    private readonly oracleActions: OracleActionsService,
    private readonly tokenActions: TokenActionsService,
    private readonly pulls: PullRepository,
  ) {}

  /** The caller's subscriptions, with derived fields and basic filtering. */
  @Get()
  async list(
    @Req() request: AuthedRequest,
    @Query('role') role?: string,
    @Query('state') state?: string,
    @Query('channel') channel?: string,
    @Query('plan') plan?: string,
  ): Promise<SubscriptionView[]> {
    const pkh = this.guard.caller(request);
    const rows = await this.repository.findByParty(pkh);
    const now = Math.floor(Date.now() / 1000);

    // channel/plan filters join through the off-chain `subscription_link` table
    // (Slice 6). A sub with no link matches neither filter; an unknown
    // channel/plan yields nothing (fail-closed, never "return everything").
    const channelId = parseId(channel);
    const planId = parseId(plan);
    let linkedIds: Set<string> | null = null;
    if (channelId !== undefined || planId !== undefined) {
      const ids = await this.offchain.linkedSubscriptionIds({
        channelId,
        planId,
      });
      linkedIds = new Set(ids);
    }

    let views = rows.map((row) => toView(row, pkh, now));
    if (role !== undefined) views = views.filter((v) => v.role === role);
    if (state !== undefined) views = views.filter((v) => v.status === state);
    if (linkedIds !== null) views = views.filter((v) => linkedIds.has(v.stateCategory));
    // Attach plan/channel context (dapp-handoff §12) — batched, links only.
    const context = await this.offchain.linkContextFor(views.map((v) => v.stateCategory));
    views = views.map((v) => withContext(v, context.get(v.stateCategory)));
    return views;
  }

  /** Subscription detail for a caller who is a party (404 otherwise). */
  @Get(':stateCategory')
  async detail(
    @Req() request: AuthedRequest,
    @Param('stateCategory') stateCategory: string,
  ): Promise<SubscriptionView> {
    const pkh = this.guard.caller(request);
    const row = await this.requireParty(stateCategory, pkh);
    const now = Math.floor(Date.now() / 1000);
    let view = toView(row, pkh, now);
    // History: the caller's notification log for this sub (newest first).
    view.history = await this.notifications.findBySubscription(stateCategory, 50);
    // Plan/channel context (dapp-handoff §12) — links only.
    const context = await this.offchain.linkContextFor([stateCategory]);
    view = withContext(view, context.get(stateCategory));
    return view;
  }

  /**
   * The caller's pull history for a subscription (dapp-handoff §13), newest
   * first. Read from the `pull` table; party-scoped (404 for a non-party).
   * Bigint columns are stored as strings and returned as decimal strings.
   */
  @Get(':stateCategory/pulls')
  async pullsFor(
    @Req() request: AuthedRequest,
    @Param('stateCategory') stateCategory: string,
  ): Promise<PullView[]> {
    const pkh = this.guard.caller(request);
    await this.requireParty(stateCategory, pkh);
    const rows = await this.pulls.findBySubscription(stateCategory);
    return rows.map(toPullView);
  }

  /** The caller's notification log for a subscription. */
  @Get(':stateCategory/notifications')
  async notificationsFor(
    @Req() request: AuthedRequest,
    @Param('stateCategory') stateCategory: string,
  ) {
    const pkh = this.guard.caller(request);
    await this.requireParty(stateCategory, pkh);
    const rows = await this.notifications.findBySubscription(stateCategory, 100);
    const readAt = await this.notificationReads.readAtByNotification(
      rows.map((r) => r.id),
      pkh,
    );
    return rows.map((row) => toNotificationView(row, readAt.get(row.id) ?? null));
  }

  /**
   * Set the supportee's auto-cancel policy (mutating → authenticated). The
   * firing logic is Slice 5; this only persists the opt-in. The supportee is the
   * caller (the only party that may arm the policy).
   */
  @Post(':stateCategory/auto-cancel-policy')
  async setAutoCancelPolicy(
    @Req() request: AuthedRequest,
    @Param('stateCategory') stateCategory: string,
    @Body() body: { thresholdPeriods?: number; graceSeconds?: number; enabled?: boolean },
  ) {
    const pkh = this.guard.caller(request);
    const row = await this.requireParty(stateCategory, pkh);
    if (row.supporteePkh.toLowerCase() !== pkh) {
      throw new BadRequestException('only the supportee may set the auto-cancel policy');
    }
    const thresholdPeriods = Number(body?.thresholdPeriods);
    const graceSeconds = Number(body?.graceSeconds);
    if (!Number.isInteger(thresholdPeriods) || thresholdPeriods <= 0) {
      throw new BadRequestException('thresholdPeriods must be a positive integer');
    }
    if (!Number.isInteger(graceSeconds) || graceSeconds < 0) {
      throw new BadRequestException('graceSeconds must be a non-negative integer');
    }
    return this.policies.upsert({
      subscriptionId: stateCategory,
      supporteePkh: pkh,
      thresholdPeriods,
      graceSeconds,
      enabled: body?.enabled ?? true,
    });
  }

  /**
   * Schedule a boundary-gated cancel (spec § Scheduled cancellation). The caller
   * must be a party to the sub; `requestedBy` defaults to the caller's pkh.
   */
  @Post(':stateCategory/scheduled-cancel')
  async scheduleCancel(
    @Req() request: AuthedRequest,
    @Param('stateCategory') stateCategory: string,
    @Body() body: { requestedBy?: string },
  ) {
    const pkh = this.guard.caller(request);
    await this.requireParty(stateCategory, pkh);
    const requestedBy = typeof body?.requestedBy === 'string' && body.requestedBy !== '' ? body.requestedBy : pkh;
    return this.scheduledCancels.schedule(stateCategory, requestedBy);
  }

  /** Revoke a pending scheduled cancel before the boundary; pulls resume. */
  @Delete(':stateCategory/scheduled-cancel')
  async revokeCancel(
    @Req() request: AuthedRequest,
    @Param('stateCategory') stateCategory: string,
  ): Promise<{ revoked: true }> {
    const pkh = this.guard.caller(request);
    await this.requireParty(stateCategory, pkh);
    await this.scheduledCancels.revoke(stateCategory, pkh);
    return { revoked: true };
  }

  /**
   * Prepare a **withdraw** for a supporter (spec § Withdraw — oracle-priced). The
   * server rebuilds the tx against the current outpoints and returns the
   * **unsigned** hex + the presence input(s) the client must sign. It never
   * broadcasts an unsigned tx and holds no party key.
   */
  @Post(':stateCategory/withdraw/prepare')
  async prepareWithdraw(
    @Req() request: AuthedRequest,
    @Param('stateCategory') stateCategory: string,
    @Body() body: { supporterInput?: RawOracleInput },
  ) {
    const pkh = this.guard.caller(request);
    const row = await this.requireSupporter(stateCategory, pkh);
    const now = Math.floor(Date.now() / 1000);
    const built = await this.oracleActions.buildOracleWithdraw(row, {
      now,
      supporterInput: parseOracleInput(body?.supporterInput),
    });
    return {
      stateCategory,
      unsignedHex: built.hex,
      signableInputs: built.signableInputs,
      sourceOutputs: built.sourceOutputs,
      gross: built.gross.toString(),
      fee: built.fee.toString(),
      payout: built.payout.toString(),
      retained: built.retained.toString(),
    };
  }

  /** Relay a **client-signed** withdraw tx (verified + broadcast; never re-signs). */
  @Post(':stateCategory/withdraw/broadcast')
  async broadcastWithdraw(
    @Req() request: AuthedRequest,
    @Param('stateCategory') stateCategory: string,
    @Body() body: { signedHex?: string },
  ) {
    const pkh = this.guard.caller(request);
    const row = await this.requireSupporter(stateCategory, pkh);
    if (typeof body?.signedHex !== 'string' || body.signedHex === '') {
      throw new BadRequestException('signedHex is required');
    }
    return this.oracleActions.broadcastOracleWithdraw(
      row,
      body.signedHex,
      Math.floor(Date.now() / 1000),
    );
  }

  /**
   * Prepare a **reactivate** for a supporter (spec § Reactivate — oracle-priced,
   * paused-only). The caller supplies the fresh-funding UTXO(s); the server
   * returns the unsigned hex + the funding inputs the client must sign.
   */
  @Post(':stateCategory/reactivate/prepare')
  async prepareReactivate(
    @Req() request: AuthedRequest,
    @Param('stateCategory') stateCategory: string,
    @Body() body: { fundingInputs?: RawOracleInput[] },
  ) {
    const pkh = this.guard.caller(request);
    const row = await this.requireSupporter(stateCategory, pkh);
    const fundingInputs = (body?.fundingInputs ?? []).map(parseOracleInput).filter((i) => i !== undefined);
    if (fundingInputs.length === 0) {
      throw new BadRequestException('at least one fundingInput is required');
    }
    const now = Math.floor(Date.now() / 1000);
    const built = await this.oracleActions.buildOracleReactivate(row, {
      now,
      fundingInputs,
    });
    return {
      stateCategory,
      unsignedHex: built.hex,
      signableInputs: built.signableInputs,
      sourceOutputs: built.sourceOutputs,
      supporteeAmount: built.supporteeAmount.toString(),
      fee: built.fee.toString(),
      newFunds: built.newFunds.toString(),
    };
  }

  /** Relay a **client-signed** reactivate tx (verified + broadcast). */
  @Post(':stateCategory/reactivate/broadcast')
  async broadcastReactivate(
    @Req() request: AuthedRequest,
    @Param('stateCategory') stateCategory: string,
    @Body() body: { signedHex?: string },
  ) {
    const pkh = this.guard.caller(request);
    const row = await this.requireSupporter(stateCategory, pkh);
    if (typeof body?.signedHex !== 'string' || body.signedHex === '') {
      throw new BadRequestException('signedHex is required');
    }
    const { broadcast: _b, txid } = await this.oracleActions.broadcastOracleReactivate(
      row,
      body.signedHex,
      Math.floor(Date.now() / 1000),
    );
    return { stateCategory, txid };
  }

  /**
   * Prepare an oracle-key **migrate**. Two paths (spec § Oracle contract):
   *
   *   - `mode: 'mutual'` — supporter + supportee both present; prices at the
   *     CURRENT oracle (a fresh message is required). Returns the unsigned hex +
   *     the two presence inputs the client signs, then `migrate/broadcast`.
   *   - `mode: 'service'` — the platform recovery path for a **dead oracle**: no
   *     oracle message, prices at `lastRate`. The server holds the service key, so
   *     it builds and broadcasts directly (`oracle-migrate`); `prepare` returns the
   *     unsigned hex for inspection only.
   *
   * Party-scoped: the caller must be a party to the sub.
   */
  @Post(':stateCategory/migrate/prepare')
  async prepareMigrate(
    @Req() request: AuthedRequest,
    @Param('stateCategory') stateCategory: string,
    @Body()
    body: {
      newOraclePubkey?: string;
      mode?: string;
      supporterInput?: RawOracleInput;
      counterpartyInput?: RawOracleInput;
    },
  ) {
    const pkh = this.guard.caller(request);
    const row = await this.requireParty(stateCategory, pkh);
    if (typeof body?.newOraclePubkey !== 'string' || !/^[0-9a-f]{66}$/i.test(body.newOraclePubkey)) {
      throw new BadRequestException('newOraclePubkey must be a 33-byte compressed pubkey hex');
    }
    const mode = body?.mode === 'service' ? 'service' : body?.mode === 'mutual' ? 'mutual' : undefined;
    if (mode === undefined) {
      throw new BadRequestException('mode must be "mutual" or "service"');
    }
    const built = await this.oracleActions.buildOracleMigrate(row, {
      now: Math.floor(Date.now() / 1000),
      newOraclePubkey: body.newOraclePubkey.toLowerCase(),
      mode,
      supporterInput: parseOracleInput(body?.supporterInput),
      counterpartyInput: parseOracleInput(body?.counterpartyInput),
    });
    return {
      stateCategory,
      mode,
      unsignedHex: built.hex,
      signableInputs: built.signableInputs,
      sourceOutputs: built.sourceOutputs,
      newOraclePkHash: built.newOraclePkHash,
      gross: built.gross.toString(),
      fee: built.fee.toString(),
    };
  }

  /** Relay a **client-signed** mutual migrate tx (verified + broadcast). */
  @Post(':stateCategory/migrate/broadcast')
  async broadcastMigrate(
    @Req() request: AuthedRequest,
    @Param('stateCategory') stateCategory: string,
    @Body() body: { signedHex?: string },
  ) {
    const pkh = this.guard.caller(request);
    const row = await this.requireParty(stateCategory, pkh);
    if (typeof body?.signedHex !== 'string' || body.signedHex === '') {
      throw new BadRequestException('signedHex is required');
    }
    const { broadcast: _b, txid } = await this.oracleActions.broadcastOracleMigrate(
      row,
      body.signedHex,
      Math.floor(Date.now() / 1000),
    );
    return { stateCategory, txid };
  }

  /**
   * **Service-only** oracle migrate — the dead-oracle recovery path. The server
   * builds and broadcasts directly (it holds the service key) and updates the row
   * to the new oracle. Party-scoped: the caller must be a party to the sub (the
   * service is the platform; this is gated to a party for the MVP).
   */
  @Post(':stateCategory/oracle-migrate')
  async oracleMigrate(
    @Req() request: AuthedRequest,
    @Param('stateCategory') stateCategory: string,
    @Body() body: { newOraclePubkey?: string },
  ) {
    const pkh = this.guard.caller(request);
    const row = await this.requireParty(stateCategory, pkh);
    if (typeof body?.newOraclePubkey !== 'string' || !/^[0-9a-f]{66}$/i.test(body.newOraclePubkey)) {
      throw new BadRequestException('newOraclePubkey must be a 33-byte compressed pubkey hex');
    }
    const result = await this.oracleActions.executeOracleMigrateService(row, {
      now: Math.floor(Date.now() / 1000),
      newOraclePubkey: body.newOraclePubkey.toLowerCase(),
    });
    return {
      stateCategory,
      txid: result.txid,
      newOraclePkHash: result.newOraclePkHash,
      gross: result.gross.toString(),
      fee: result.fee.toString(),
    };
  }

  // ---------------------------------------------------------------------------
  // Token-path actions: fund / withdraw / reactivate (no oracle, no party key).
  //
  // These mirror the oracle routes but operate on the **token** covenant (two
  // UTXOs: state NFT + co-created escrow). The server builds the tx against the
  // current outpoints with unsigned P2PKH placeholders, returns the hex + the
  // inputs the client must sign, and relays the client-signed tx. It holds no
  // party key. `withdraw`/`reactivate` are supporter-only; `fund` is
  // permissionless (any party to the sub may top it up).
  // ---------------------------------------------------------------------------

  /** Prepare a token **withdraw** (supporter only). Returns unsigned hex + signable inputs. */
  @Post(':stateCategory/withdraw-token/prepare')
  async prepareTokenWithdraw(
    @Req() request: AuthedRequest,
    @Param('stateCategory') stateCategory: string,
    @Body() body: { supporterInput?: RawOracleInput; strayInputs?: RawTokenInput[] },
  ) {
    const pkh = this.guard.caller(request);
    const row = await this.requireSupporter(stateCategory, pkh);
    const built = await this.tokenActions.buildTokenWithdraw(row, {
      now: Math.floor(Date.now() / 1000),
      supporterInput: parseOracleInput(body?.supporterInput),
      strayInputs: parseTokenInputs(body?.strayInputs),
    });
    return {
      stateCategory,
      unsignedHex: built.hex,
      signableInputs: built.signableInputs,
      sourceOutputs: built.sourceOutputs,
      gross: built.gross.toString(),
      fee: built.fee.toString(),
      payout: built.payout.toString(),
      retained: built.retained.toString(),
    };
  }

  /** Relay a **client-signed** token withdraw (verified + broadcast). */
  @Post(':stateCategory/withdraw-token/broadcast')
  async broadcastTokenWithdraw(
    @Req() request: AuthedRequest,
    @Param('stateCategory') stateCategory: string,
    @Body() body: { signedHex?: string },
  ) {
    const pkh = this.guard.caller(request);
    const row = await this.requireSupporter(stateCategory, pkh);
    if (typeof body?.signedHex !== 'string' || body.signedHex === '') {
      throw new BadRequestException('signedHex is required');
    }
    const { txid } = await this.tokenActions.broadcastTokenWithdraw(
      row,
      body.signedHex,
      Math.floor(Date.now() / 1000),
    );
    return { stateCategory, txid };
  }

  /** Prepare a token **reactivate** (supporter only, paused-only). */
  @Post(':stateCategory/reactivate-token/prepare')
  async prepareTokenReactivate(
    @Req() request: AuthedRequest,
    @Param('stateCategory') stateCategory: string,
    @Body() body: { fundingInputs?: RawTokenInput[] },
  ) {
    const pkh = this.guard.caller(request);
    const row = await this.requireSupporter(stateCategory, pkh);
    const fundingInputs = parseTokenInputs(body?.fundingInputs);
    if (fundingInputs.length === 0) {
      throw new BadRequestException('at least one fundingInput is required');
    }
    const built = await this.tokenActions.buildTokenReactivate(row, {
      now: Math.floor(Date.now() / 1000),
      fundingInputs,
    });
    return {
      stateCategory,
      unsignedHex: built.hex,
      signableInputs: built.signableInputs,
      sourceOutputs: built.sourceOutputs,
      supporteeAmount: built.supporteeAmount.toString(),
      fee: built.fee.toString(),
      newFunds: built.newFunds.toString(),
    };
  }

  /** Relay a **client-signed** token reactivate (verified + broadcast). */
  @Post(':stateCategory/reactivate-token/broadcast')
  async broadcastTokenReactivate(
    @Req() request: AuthedRequest,
    @Param('stateCategory') stateCategory: string,
    @Body() body: { signedHex?: string },
  ) {
    const pkh = this.guard.caller(request);
    const row = await this.requireSupporter(stateCategory, pkh);
    if (typeof body?.signedHex !== 'string' || body.signedHex === '') {
      throw new BadRequestException('signedHex is required');
    }
    const { txid } = await this.tokenActions.broadcastTokenReactivate(
      row,
      body.signedHex,
      Math.floor(Date.now() / 1000),
    );
    return { stateCategory, txid };
  }

  /** Prepare a token **fund** (permissionless top-up; any party). */
  @Post(':stateCategory/fund-token/prepare')
  async prepareTokenFund(
    @Req() request: AuthedRequest,
    @Param('stateCategory') stateCategory: string,
    @Body() body: { funderInput?: RawTokenInput; strayInputs?: RawTokenInput[] },
  ) {
    const pkh = this.guard.caller(request);
    const row = await this.requireParty(stateCategory, pkh);
    const funderInput = parseTokenInputs([body?.funderInput as RawTokenInput])[0];
    if (funderInput === undefined) {
      throw new BadRequestException('a funderInput is required');
    }
    const built = await this.tokenActions.buildTokenFund(row, {
      now: Math.floor(Date.now() / 1000),
      funderInput,
      strayInputs: parseTokenInputs(body?.strayInputs),
    });
    return {
      stateCategory,
      unsignedHex: built.hex,
      signableInputs: built.signableInputs,
      sourceOutputs: built.sourceOutputs,
      total: built.total.toString(),
    };
  }

  /** Relay a **client-signed** token fund (verified + broadcast). */
  @Post(':stateCategory/fund-token/broadcast')
  async broadcastTokenFund(
    @Req() request: AuthedRequest,
    @Param('stateCategory') stateCategory: string,
    @Body() body: { signedHex?: string },
  ) {
    const pkh = this.guard.caller(request);
    const row = await this.requireParty(stateCategory, pkh);
    if (typeof body?.signedHex !== 'string' || body.signedHex === '') {
      throw new BadRequestException('signedHex is required');
    }
    const { txid } = await this.tokenActions.broadcastTokenFund(
      row,
      body.signedHex,
      Math.floor(Date.now() / 1000),
    );
    return { stateCategory, txid };
  }

  /**
   * Track a subscription from its genesis transaction (the creation webhook).
   *
   * **Trigger (decision, review Major 1).** This route is the **web app's**
   * creation hook: after a wallet creates a sub on-chain, the app calls this
   * route (authenticated as a party) to have the txserver validate the genesis
   * and start watching. It is intentionally **authenticated** (class-level
   * `AuthGuard`) so only a party can register a sub. The txserver's **own
   * chain-scan path** (`DiscoveryService.onModuleInit` → `watcher.onChange`)
   * calls `DiscoveryService.discover` internally and needs no route, so no
   * unauthenticated variant is exposed. Party-scoped routes are not weakened.
   *
   * The creation path must capture the oracle pubkey for an oracle (BCH) sub: the
   * commitment stores only `hash160(oraclePk)`, so `oraclePubkey` (hex, compressed)
   * is supplied here and verified against the commitment's `oraclePkHash` by the
   * discovery service (a mismatch refuses to track). Token subs ignore it.
   */
  @Post('discover')
  async discover(
    @Body()
    body: {
      txid?: string;
      stateCategory?: string;
      assetType?: string;
      oraclePubkey?: string;
    },
  ) {
    if (typeof body?.txid !== 'string' || !/^[0-9a-f]{64}$/i.test(body.txid)) {
      throw new BadRequestException('txid must be a 64-char hex txid');
    }
    if (typeof body?.stateCategory !== 'string' || !/^[0-9a-f]{64}$/i.test(body.stateCategory)) {
      throw new BadRequestException('stateCategory must be a 32-byte category hex');
    }
    if (body.assetType !== undefined && body.assetType !== 'token' && body.assetType !== 'oracle') {
      throw new BadRequestException('assetType must be "token" or "oracle"');
    }
    if (body.oraclePubkey !== undefined && !/^[0-9a-f]{66}$/i.test(body.oraclePubkey)) {
      throw new BadRequestException('oraclePubkey must be a 33-byte compressed pubkey hex');
    }
    return this.discovery.discover({
      txid: body.txid.toLowerCase(),
      stateCategory: body.stateCategory.toLowerCase(),
      assetType: body.assetType as 'token' | 'oracle' | undefined,
      oraclePubkey: body.oraclePubkey?.toLowerCase(),
    });
  }

  /** Load a subscription the caller is a party to, or throw 404. */
  private async requireParty(stateCategory: string, pkh: string): Promise<Subscription> {
    const row = await this.repository.findByIdForParty(stateCategory, pkh);
    if (row === null) throw new NotFoundException('subscription not found');
    return row;
  }

  /** Load a subscription the caller is the **supporter** of, or throw 404. */
  private async requireSupporter(stateCategory: string, pkh: string): Promise<Subscription> {
    const row = await this.requireParty(stateCategory, pkh);
    if (row.supporterPkh.toLowerCase() !== pkh) {
      // 404 (not 403) — never reveal existence to a non-supporter.
      throw new NotFoundException('subscription not found');
    }
    return row;
  }
}

/** A raw presence/funding input supplied by the client (no key). */
interface RawOracleInput {
  txid?: string;
  vout?: number;
  satoshis?: string;
  lockingBytecode?: string;
}

/** Validate + normalise a caller-supplied input (whitelist; drops any extra field). */
function parseOracleInput(raw: RawOracleInput | undefined): {
  txid: string;
  vout: number;
  satoshis: bigint;
  lockingBytecode: string;
} | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw.txid !== 'string' || !/^[0-9a-f]{64}$/i.test(raw.txid)) {
    throw new BadRequestException('input txid must be a 64-char hex txid');
  }
  if (!Number.isInteger(raw.vout) || (raw.vout ?? -1) < 0) {
    throw new BadRequestException('input vout must be a non-negative integer');
  }
  if (typeof raw.satoshis !== 'string' || !/^\d+$/.test(raw.satoshis)) {
    throw new BadRequestException('input satoshis must be a decimal string');
  }
  if (typeof raw.lockingBytecode !== 'string' || !/^76a914[0-9a-f]{40}88ac$/i.test(raw.lockingBytecode)) {
    throw new BadRequestException('input lockingBytecode must be a P2PKH lock');
  }
  return {
    txid: raw.txid.toLowerCase(),
    vout: raw.vout as number,
    satoshis: BigInt(raw.satoshis),
    lockingBytecode: raw.lockingBytecode.toLowerCase(),
  };
}

/** A raw token input supplied by the client (a funds-category UTXO; no key). */
interface RawTokenInput {
  txid?: string;
  vout?: number;
  satoshis?: string;
  lockingBytecode?: string;
  category?: string;
  amount?: string;
}

/** Validate + normalise a caller-supplied token input (whitelist; drops extras). */
function parseTokenInputs(raw: RawTokenInput[] | undefined): Array<{
  txid: string;
  vout: number;
  satoshis: bigint;
  lockingBytecode: string;
  category: string;
  amount: bigint;
}> {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const base = parseOracleInput(entry);
    if (base === undefined) throw new BadRequestException('token input is required');
    if (typeof entry.category !== 'string' || !/^[0-9a-f]{64}$/i.test(entry.category)) {
      throw new BadRequestException('token input category must be a 32-byte category hex');
    }
    if (typeof entry.amount !== 'string' || !/^\d+$/.test(entry.amount)) {
      throw new BadRequestException('token input amount must be a decimal string');
    }
    return {
      ...base,
      category: entry.category.toLowerCase(),
      amount: BigInt(entry.amount),
    };
  });
}

/** The API view of a subscription: stored cache + clock-derived fields. */
export interface SubscriptionView {
  stateCategory: string;
  stateOutpoint: string | null;
  escrowOutpoint: string | null;
  assetType: string;
  mode: number;
  role: 'supporter' | 'supportee' | 'service';
  supporterPkh: string;
  supporteePkh: string;
  servicePkh: string;
  amount: string;
  amountNext: string;
  period: number;
  periodNext: number;
  lastPeriodTime: number;
  escrow: string;
  status: SubscriptionStatus;
  nextPaymentAt: number;
  n: string;
  m: string;
  arrears: string;
  payable: string;
  owedPreSettle: string;
  futurePeriods: string;
  history?: unknown[];
  /** Plan/channel context (dapp-handoff §12); omitted when the sub has no link. */
  channelId?: number;
  planId?: number;
  planTitle?: string;
  benefits?: string[];
}

/** The API view of a pull (dapp-handoff §13). */
export interface PullView {
  id: number;
  txid: string;
  periodsSettled: string;
  gross: string;
  fee: string;
  broadcastAt: number;
  status: string;
}

/**
 * Project a `pull` row to its API view. Bigint columns are stored as strings in
 * Postgres but come back as numbers from SQLite — `String(...)` normalises both
 * to the decimal-string contract the web app expects.
 */
export function toPullView(row: Pull): PullView {
  return {
    id: row.id,
    txid: row.txid,
    periodsSettled: String(row.periodsSettled),
    gross: String(row.gross),
    fee: String(row.fee),
    broadcastAt: row.broadcastAt,
    status: row.status,
  };
}

/** Attach plan/channel context to a view, leaving fields absent when no link. */
function withContext(
  view: SubscriptionView,
  context:
    | { channelId: number; planId: number | null; planTitle?: string; benefits?: string[] }
    | undefined,
): SubscriptionView {
  if (context === undefined) return view;
  return {
    ...view,
    channelId: context.channelId,
    planId: context.planId ?? undefined,
    planTitle: context.planTitle,
    benefits: context.benefits,
  };
}

/** Compute the view for a row, deriving status/arrears/future-periods at `now`. */
export function toView(row: Subscription, callerPkh: string, now: number): SubscriptionView {
  const derived = deriveRow(row, now);
  return {
    stateCategory: row.stateCategory,
    stateOutpoint: row.stateOutpoint,
    escrowOutpoint: row.escrowOutpoint,
    assetType: row.assetType,
    mode: row.mode,
    role: roleOf(row, callerPkh),
    supporterPkh: row.supporterPkh,
    supporteePkh: row.supporteePkh,
    servicePkh: row.servicePkh,
    amount: row.amount,
    amountNext: row.amountNext,
    period: row.period,
    periodNext: row.periodNext,
    lastPeriodTime: row.lastPeriodTime,
    escrow: row.escrowBalance,
    status: derived.status,
    nextPaymentAt: derived.nextPaymentAt,
    n: derived.n.toString(),
    m: derived.m.toString(),
    arrears: derived.arrears.toString(),
    payable: derived.payable.toString(),
    owedPreSettle: derived.owedPreSettle.toString(),
    futurePeriods: derived.futurePeriods.toString(),
  };
}

/**
 * Re-derive status/arrears from the stored cache row.
 *
 * When the state outpoint is gone the subscription is canceled. Otherwise the
 * commitment is decoded from the last-known outpoint via the chain watcher; if
 * the watcher cannot supply it (mock/degraded), the row's stored commitment-like
 * fields are used as a best-effort cache — the stored `status` is still
 * recomputed, never trusted.
 */
function deriveRow(row: Subscription, now: number): ReturnType<typeof deriveState> {
  const escrow = BigInt(row.escrowBalance);
  if (row.stateOutpoint === null) {
    return deriveState({ state: undefined, escrow, now });
  }
  // Surface the scheduler's `degraded` marker (a non-fresh oracle message deferred
  // the pull; spec § Oracle integration — Oracle fetch failure degrades safely).
  // It is a stored, internal retry flag, not a clock-derived state, so it takes
  // precedence over the recomputed `active|paused|due` — the dashboard needs to
  // see "oracle degraded". A canceled sub is never degraded.
  if (row.status === 'degraded') {
    return { ...deriveState({ state: undefined, escrow, now }), status: 'degraded' };
  }
  // The cache row carries the commitment fields; rebuild the state from them so
  // the clock-based derivation (n/m/arrears) is exact without a chain round-trip.
  const state = {
    supporterPkh: hexToBin(row.supporterPkh),
    supporteePkh: hexToBin(row.supporteePkh),
    servicePkh: hexToBin(row.servicePkh),
    amount: BigInt(row.amount),
    amountNext: BigInt(row.amountNext),
    period: row.period,
    periodNext: row.periodNext,
    lastPeriodTime: row.lastPeriodTime,
    mode: row.mode as 0 | 1,
    fundsCategory: hexToBin(row.fundsCategory),
  };
  // `settle()` anchors on `lastPeriodTime`; a clock before it is not a valid
  // derivation (the covenant would reject the tx). Clamp to the anchor so the
  // read never 500s on a row whose boundary is in the future.
  const anchor = Math.max(now, row.lastPeriodTime);
  return deriveState({ state, escrow, now: anchor });
}

function roleOf(row: Subscription, pkh: string): 'supporter' | 'supportee' | 'service' {
  if (row.supporterPkh.toLowerCase() === pkh) return 'supporter';
  if (row.supporteePkh.toLowerCase() === pkh) return 'supportee';
  return 'service';
}
