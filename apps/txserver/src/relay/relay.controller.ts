/**
 * Mutual-consent relay REST API (Slice 7, spec § Mutual-consent relay
 * (modify / migrate), § API for web app).
 *
 * Authenticated, party-scoped routes:
 *   POST /subscriptions/:stateCategory/proposals   — initiate a modify/migrate
 *   POST /proposals/:id/prepare                     — the counterparty prepares (unsigned)
 *   POST /proposals/:id/broadcast                   — the counterparty relays a client-signed tx
 *   POST /proposals/:id/revoke                      — the initiator revokes
 *   GET  /proposals/:id                             — read a proposal
 *   GET  /subscriptions/:stateCategory/proposals    — list a sub's proposals
 *
 * A non-party caller gets a 404 (never a 403 that leaks existence); an
 * unauthenticated caller gets a 401 from the guard.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, type AuthedRequest } from '../auth/auth.guard.js';
import { SubscriptionRepository } from '../subscription/subscription.repository.js';
import type { ProposalKind, ProposedTerms } from '../db/mutual-consent-proposal.entity.js';
import {
  MutualConsentService,
  type BroadcastResult,
  type PrepareResult,
  type ProposalView,
} from './mutual-consent.service.js';
import type { CounterpartyInput, NewAssetInput } from './mutual-consent-builder.js';

/** The body of a `propose` request. */
interface ProposeBody {
  kind?: string;
  terms?: ProposedTerms;
}

/** The body of a `prepare` request (the counterparty's input details). */
interface PrepareBody {
  /** The initiator's presence UTXO (pays the fee). */
  initiatorInput?: RawInput;
  /** The counterparty's presence UTXO (assembled at prepare time). */
  counterpartyInput?: RawInput;
  /** `migrate` only: the new-category token UTXO(s) that fund the swap. */
  newAssetInputs?: RawInput[];
}

/** The body of a `broadcast` request (the client-signed tx). */
interface BroadcastBody {
  /** The fully-signed tx hex the client produced from `prepare`'s `unsignedHex`. */
  signedHex?: string;
}

/**
 * A raw presence input. **Whitelisted**: only these fields are read, so a stray
 * `privateKey` (or any other field) in the body is dropped and can never reach the
 * builder. The relay never accepts signing material.
 */
interface RawInput {
  txid?: string;
  vout?: number;
  satoshis?: string | number;
  lockingBytecode?: string;
  /** `migrate` funding inputs only. */
  category?: string;
  amount?: string | number;
}

@Controller()
@UseGuards(AuthGuard)
export class RelayController {
  constructor(
    private readonly relay: MutualConsentService,
    private readonly subscriptions: SubscriptionRepository,
    private readonly guard: AuthGuard,
  ) {}

  /** Initiate a `modify`/`migrate` proposal for a sub the caller is a party to. */
  @Post('subscriptions/:stateCategory/proposals')
  async propose(
    @Req() request: AuthedRequest,
    @Param('stateCategory') stateCategory: string,
    @Body() body: ProposeBody,
  ): Promise<ProposalView> {
    const pkh = this.guard.caller(request);
    const sub = await this.subscriptions.findByIdForParty(stateCategory, pkh);
    if (sub === null) throw new NotFoundException('subscription not found');

    const kind = parseKind(body?.kind);
    const terms = parseTerms(body?.terms);
    return this.relay.propose({
      subscription: sub,
      callerPkh: pkh,
      kind,
      terms,
      now: Math.floor(Date.now() / 1000),
    });
  }

  /**
   * The counterparty prepares: the relay rebuilds the tx against the current
   * outpoints and returns the **unsigned** template + `signableInputs`. No
   * broadcast — the client signs the presence inputs and calls `broadcast`.
   */
  @Post('proposals/:id/prepare')
  async prepare(
    @Req() request: AuthedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: PrepareBody,
  ): Promise<PrepareResult> {
    const pkh = this.guard.caller(request);
    await this.assertCounterparty(id, pkh);

    return this.relay.prepare({
      proposalId: id,
      callerPkh: pkh,
      initiatorInput: parseInput(body?.initiatorInput, 'initiatorInput'),
      counterpartyInput: parseInput(body?.counterpartyInput, 'counterpartyInput'),
      newAssetInputs: parseNewAssetInputs(body?.newAssetInputs),
      now: Math.floor(Date.now() / 1000),
    });
  }

  /**
   * The counterparty broadcasts a client-signed tx. The relay verifies it (spends
   * the current state outpoint, carries both presence inputs) before relaying.
   */
  @Post('proposals/:id/broadcast')
  async broadcast(
    @Req() request: AuthedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: BroadcastBody,
  ): Promise<BroadcastResult> {
    const pkh = this.guard.caller(request);
    await this.assertCounterparty(id, pkh);

    if (typeof body?.signedHex !== 'string' || !/^[0-9a-f]+$/i.test(body.signedHex)) {
      throw new BadRequestException('signedHex must be hex');
    }

    return this.relay.broadcast({
      proposalId: id,
      callerPkh: pkh,
      signedHex: body.signedHex.toLowerCase(),
      now: Math.floor(Date.now() / 1000),
    });
  }

  /**
   * Party + role scope for the counterparty-only routes. A non-party or a
   * non-counterparty party gets the same 404 as a missing proposal (no role leak).
   */
  private async assertCounterparty(id: number, pkh: string): Promise<void> {
    const proposal = await this.relay.view(id);
    if (proposal === null) throw new NotFoundException('proposal not found');
    const sub = await this.subscriptions.findByIdForParty(proposal.subscriptionId, pkh);
    if (sub === null) throw new NotFoundException('proposal not found');
    if (normalizePkh(pkh) !== normalizePkh(proposal.counterpartyPkh)) {
      throw new NotFoundException('proposal not found');
    }
  }

  /** The initiator revokes a pending proposal before the counterparty signs. */
  @Post('proposals/:id/revoke')
  async revoke(
    @Req() request: AuthedRequest,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ProposalView> {
    const pkh = this.guard.caller(request);
    const proposal = await this.relay.view(id);
    if (proposal === null) throw new NotFoundException('proposal not found');
    const sub = await this.subscriptions.findByIdForParty(proposal.subscriptionId, pkh);
    if (sub === null) throw new NotFoundException('proposal not found');
    // Only the initiator may revoke; a non-initiator party gets 404 (no role leak).
    if (normalizePkh(pkh) !== normalizePkh(proposal.initiatorPkh)) {
      throw new NotFoundException('proposal not found');
    }
    return this.relay.revoke(id, pkh, Math.floor(Date.now() / 1000));
  }

  /** Read a proposal (party-scoped). */
  @Get('proposals/:id')
  async detail(
    @Req() request: AuthedRequest,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ProposalView> {
    const pkh = this.guard.caller(request);
    const proposal = await this.relay.view(id);
    if (proposal === null) throw new NotFoundException('proposal not found');
    const sub = await this.subscriptions.findByIdForParty(proposal.subscriptionId, pkh);
    if (sub === null) throw new NotFoundException('proposal not found');
    return proposal;
  }

  /** List a subscription's proposals (party-scoped). */
  @Get('subscriptions/:stateCategory/proposals')
  async list(
    @Req() request: AuthedRequest,
    @Param('stateCategory') stateCategory: string,
  ): Promise<ProposalView[]> {
    const pkh = this.guard.caller(request);
    const sub = await this.subscriptions.findByIdForParty(stateCategory, pkh);
    if (sub === null) throw new NotFoundException('subscription not found');
    return this.relay.listForSubscription(stateCategory);
  }

}

/** Canonical pkh form (lowercase hex). */
function normalizePkh(pkh: string): string {
  return pkh.toLowerCase();
}

function parseKind(value: unknown): ProposalKind {
  if (value === 'modify' || value === 'migrate') return value;
  throw new BadRequestException('kind must be "modify" or "migrate"');
}

function parseTerms(value: unknown): ProposedTerms {
  if (value === null || typeof value !== 'object') {
    throw new BadRequestException('terms is required');
  }
  return value as ProposedTerms;
}

/** Parse an API-supplied presence input into a `CounterpartyInput`. */
function parseInput(value: unknown, field: string): CounterpartyInput {
  if (value === null || typeof value !== 'object') {
    throw new BadRequestException(`${field} is required`);
  }
  const raw = value as RawInput;
  if (typeof raw.txid !== 'string' || !/^[0-9a-f]{64}$/i.test(raw.txid)) {
    throw new BadRequestException(`${field}.txid must be a 64-char hex txid`);
  }
  if (!Number.isInteger(raw.vout) || (raw.vout as number) < 0) {
    throw new BadRequestException(`${field}.vout must be a non-negative integer`);
  }
  let satoshis: bigint;
  try {
    satoshis = BigInt(raw.satoshis as string | number);
  } catch {
    throw new BadRequestException(`${field}.satoshis must be an integer`);
  }
  if (satoshis <= 0n) throw new BadRequestException(`${field}.satoshis must be positive`);
  if (typeof raw.lockingBytecode !== 'string' || !/^[0-9a-f]+$/i.test(raw.lockingBytecode)) {
    throw new BadRequestException(`${field}.lockingBytecode must be hex`);
  }
  return {
    txid: raw.txid.toLowerCase(),
    vout: raw.vout as number,
    satoshis,
    lockingBytecode: raw.lockingBytecode.toLowerCase(),
  };
}

/** Parse the `migrate` new-asset funding inputs (whitelisted fields only). */
function parseNewAssetInputs(value: unknown): NewAssetInput[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new BadRequestException('newAssetInputs must be an array');
  }
  return value.map((entry, index) => {
    const base = parseInput(entry, `newAssetInputs[${index}]`);
    const raw = entry as RawInput;
    if (typeof raw.category !== 'string' || !/^[0-9a-f]{64}$/i.test(raw.category)) {
      throw new BadRequestException(`newAssetInputs[${index}].category must be a 32-byte category hex`);
    }
    let amount: bigint;
    try {
      amount = BigInt(raw.amount as string | number);
    } catch {
      throw new BadRequestException(`newAssetInputs[${index}].amount must be an integer`);
    }
    if (amount <= 0n) {
      throw new BadRequestException(`newAssetInputs[${index}].amount must be positive`);
    }
    return { ...base, category: raw.category.toLowerCase(), amount };
  });
}
