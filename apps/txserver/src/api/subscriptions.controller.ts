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
import { SubscriptionRepository } from '../subscription/subscription.repository.js';
import { AuthGuard, type AuthedRequest } from '../auth/auth.guard.js';
import { AutoCancelPolicyRepository } from './auto-cancel-policy.repository.js';
import { NotificationRepository } from '../notifications/notification.repository.js';
import { ScheduledCancelService } from '../cancel/scheduled-cancel.service.js';
import { OffchainService } from '../offchain/offchain.service.js';
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
    private readonly scheduledCancels: ScheduledCancelService,
    private readonly guard: AuthGuard,
    private readonly offchain: OffchainService,
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
    const view = toView(row, pkh, now);
    // History: the caller's notification log for this sub (newest first).
    view.history = await this.notifications.findBySubscription(stateCategory, 50);
    return view;
  }

  /** The caller's notification log for a subscription. */
  @Get(':stateCategory/notifications')
  async notificationsFor(
    @Req() request: AuthedRequest,
    @Param('stateCategory') stateCategory: string,
  ) {
    const pkh = this.guard.caller(request);
    await this.requireParty(stateCategory, pkh);
    return this.notifications.findBySubscription(stateCategory, 100);
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

  /** Load a subscription the caller is a party to, or throw 404. */
  private async requireParty(stateCategory: string, pkh: string): Promise<Subscription> {
    const row = await this.repository.findByIdForParty(stateCategory, pkh);
    if (row === null) throw new NotFoundException('subscription not found');
    return row;
  }
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
