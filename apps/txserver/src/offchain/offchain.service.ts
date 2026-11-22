import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Account } from '../db/account.entity.js';
import { Channel } from '../db/channel.entity.js';
import { Plan } from '../db/plan.entity.js';
import { SubscriptionLink } from '../db/subscription-link.entity.js';
import { AccountRepository } from './account.repository.js';
import { ChannelRepository, type ChannelUpsert } from './channel.repository.js';
import { PlanRepository, type PlanUpsert } from './plan.repository.js';
import { SubscriptionLinkRepository } from './subscription-link.repository.js';

/** A creator's channel + its plans, as the API exposes them. */
export interface ChannelView {
  id: number;
  ownerAccountId: number;
  title: string;
  cover: string | null;
  description: string | null;
  payoutAddress: string | null;
  offeredAssets: string[] | null;
  defaultMode: number;
  plans: PlanView[];
}

export interface PlanView {
  id: number;
  channelId: number;
  title: string;
  description: string | null;
  amount: string;
  period: number;
  asset: string;
  unit: string | null;
  benefits: string[] | null;
  defaultMode: number;
  visible: boolean;
}

/** A channel as the public picker exposes it (no owner/plan detail). */
export interface PublicChannelSummary {
  id: number;
  title: string;
  cover: string | null;
  description: string | null;
}

/** The allowed display denominations for a plan's `unit` (dapp-handoff §7). */
export const PLAN_UNITS = ['BCH', 'PUSD', 'MUSD', 'USD', 'XAU'] as const;

/**
 * Off-chain platform service (spec § Off-chain channel and plan management).
 *
 * Owns the creator's channel + plan CRUD, the plan data API, and the plan →
 * subscription link. Everything here is **metadata**: the covenant has no
 * concept of channel/plan, and none of these writes ever alters a live sub's
 * on-chain terms. Plans are soft-deleted (hidden), never hard-deleted.
 *
 * **Ownership:** the authenticated caller pkh maps to a creator account (created
 * lazily on first use — MVP: one channel per creator). A caller can only read
 * or edit their own channel/plans; another creator's channel is a 403.
 */
@Injectable()
export class OffchainService {
  constructor(
    private readonly accounts: AccountRepository,
    private readonly channels: ChannelRepository,
    private readonly plans: PlanRepository,
    private readonly links: SubscriptionLinkRepository,
  ) {}

  /**
   * Resolve (or lazily create) the creator account for a caller pkh.
   *
   * The account is keyed on the **exact pkh** (unique column), so two distinct
   * creators can never alias onto one account — the ownership key is the pkh,
   * not a lossy hash (Slice 6 review Major 1).
   */
  async accountFor(pkh: string): Promise<Account> {
    return this.accounts.findOrCreateByPkh(pkh);
  }

  /** The caller's channel, or `null` when they have not created one yet. */
  async myChannel(pkh: string): Promise<ChannelView | null> {
    const account = await this.accountFor(pkh);
    const channel = await this.channels.findByOwner(account.id);
    if (channel === null) return null;
    return this.toChannelView(channel);
  }

  /** Create the caller's channel (one per creator for MVP). */
  async createChannel(pkh: string, body: Partial<ChannelUpsert>): Promise<ChannelView> {
    const account = await this.accountFor(pkh);
    const existing = await this.channels.findByOwner(account.id);
    if (existing !== null) {
      throw new BadRequestException('channel already exists (one per creator for MVP)');
    }
    const title = requireString(body.title, 'title');
    const channel = await this.channels.create({
      ownerAccountId: account.id,
      title,
      cover: body.cover ?? null,
      description: body.description ?? null,
      payoutAddress: body.payoutAddress ?? null,
      offeredAssets: body.offeredAssets ?? null,
      defaultMode: normalizeMode(body.defaultMode),
    });
    return this.toChannelView(channel);
  }

  /** Edit the caller's channel (403 when they own none / another's). */
  async updateChannel(pkh: string, body: Partial<ChannelUpsert>): Promise<ChannelView> {
    const channel = await this.requireOwnChannel(pkh);
    const patch: Partial<ChannelUpsert> = {};
    if (body.title !== undefined) patch.title = requireString(body.title, 'title');
    if (body.cover !== undefined) patch.cover = body.cover;
    if (body.description !== undefined) patch.description = body.description;
    if (body.payoutAddress !== undefined) patch.payoutAddress = body.payoutAddress;
    if (body.offeredAssets !== undefined) patch.offeredAssets = body.offeredAssets;
    if (body.defaultMode !== undefined) patch.defaultMode = normalizeMode(body.defaultMode);
    const updated = await this.channels.update(channel.id, patch);
    return this.toChannelView(updated);
  }

  /** Add a plan to the caller's channel. */
  async createPlan(pkh: string, body: Partial<PlanUpsert>): Promise<PlanView> {
    const channel = await this.requireOwnChannel(pkh);
    const plan = await this.plans.create({
      channelId: channel.id,
      title: requireString(body.title, 'title'),
      description: body.description ?? null,
      amount: requireAmount(body.amount),
      period: requirePeriod(body.period),
      asset: body.asset ?? 'BCH',
      unit: requireUnit(body.unit),
      benefits: body.benefits ?? null,
      defaultMode: normalizeMode(body.defaultMode ?? channel.defaultMode),
    });
    return toPlanView(plan);
  }

  /** Edit a plan on the caller's channel (403 for another creator's plan). */
  async updatePlan(pkh: string, planId: number, body: Partial<PlanUpsert>): Promise<PlanView> {
    const plan = await this.requireOwnPlan(pkh, planId);
    const patch: Partial<PlanUpsert> = {};
    if (body.title !== undefined) patch.title = requireString(body.title, 'title');
    if (body.description !== undefined) patch.description = body.description;
    if (body.amount !== undefined) patch.amount = requireAmount(body.amount);
    if (body.period !== undefined) patch.period = requirePeriod(body.period);
    if (body.asset !== undefined) patch.asset = body.asset;
    if (body.unit !== undefined) patch.unit = requireUnit(body.unit);
    if (body.benefits !== undefined) patch.benefits = body.benefits;
    if (body.defaultMode !== undefined) patch.defaultMode = normalizeMode(body.defaultMode);
    const updated = await this.plans.update(plan.id, patch);
    return toPlanView(updated);
  }

  /**
   * Soft-delete a plan (hide it). The plan disappears from discovery but linked
   * subscriptions stay valid — the link row is untouched (spec § Hidden plan
   * keeps live subs valid).
   */
  async hidePlan(pkh: string, planId: number): Promise<PlanView> {
    const plan = await this.requireOwnPlan(pkh, planId);
    const hidden = await this.plans.hide(plan.id);
    return toPlanView(hidden);
  }

  /** The caller's plans (visible only) — seeds the create wizard. */
  async myPlans(pkh: string): Promise<PlanView[]> {
    const channel = await this.myChannel(pkh);
    if (channel === null) return [];
    return channel.plans;
  }

  /** The plan data API: every visible plan (discovery feed). */
  async visiblePlans(channelId?: number): Promise<PlanView[]> {
    const rows =
      channelId === undefined
        ? await this.plans.findAllVisible()
        : await this.plans.findVisibleByChannel(channelId);
    return rows.map(toPlanView);
  }

  /**
   * Public channel read by id (dapp-handoff §4): the channel plus its **visible**
   * plans. Unknown or hidden channel → `404`. No auth: it exposes only discovery
   * metadata (never a party's subscriptions), so it is safe to serve publicly.
   */
  async publicChannel(channelId: number): Promise<ChannelView> {
    const channel = await this.channels.findById(channelId);
    if (channel === null) throw new NotFoundException('channel not found');
    return this.toChannelView(channel);
  }

  /** Public channel list for the picker (dapp-handoff §4): id/title/cover/description. */
  async publicChannels(): Promise<PublicChannelSummary[]> {
    const rows = await this.channels.findAll();
    return rows
      .map((channel) => ({
        id: channel.id,
        title: channel.title,
        cover: channel.cover,
        description: channel.description,
      }))
      .sort((a, b) => a.id - b.id);
  }

  /** Resolve a plan for the wizard, regardless of visibility (hidden resolves). */
  async planById(planId: number): Promise<PlanView> {
    const plan = await this.plans.findById(planId);
    if (plan === null) throw new NotFoundException('plan not found');
    return toPlanView(plan);
  }

  /**
   * Write the plan → subscription link when a creation carries a `planId`.
   *
   * The link is metadata: it records provenance for filtering/grouping and never
   * changes the sub's on-chain terms. A hidden plan still links (a supporter may
   * create from a plan they already had open). The supporter's account is
   * recorded when the caller is known (`supporterPkh`), so the link carries the
   * supporter identity without the caller having to pass an internal id.
   */
  async linkSubscription(input: {
    subscriptionId: string;
    planId?: number | null;
    channelId?: number | null;
    supporterAccountId?: number | null;
    /** The supporter's pkh — resolves (and records) their account when given. */
    supporterPkh?: string | null;
  }): Promise<SubscriptionLink> {
    const subscriptionId = requireString(input.subscriptionId, 'subscriptionId');
    let channelId = input.channelId ?? null;
    if (input.planId !== undefined && input.planId !== null) {
      const plan = await this.plans.findById(input.planId);
      if (plan === null) throw new NotFoundException('plan not found');
      channelId = plan.channelId;
    }
    if (channelId === null) throw new BadRequestException('channelId or planId is required');
    let supporterAccountId = input.supporterAccountId ?? null;
    if (supporterAccountId === null && input.supporterPkh) {
      supporterAccountId = (await this.accountFor(input.supporterPkh)).id;
    }
    return this.links.link({
      subscriptionId,
      channelId,
      planId: input.planId ?? null,
      supporterAccountId,
    });
  }

  /** The link for a subscription, or `null`. */
  async linkFor(subscriptionId: string): Promise<SubscriptionLink | null> {
    return this.links.findBySubscription(subscriptionId);
  }

  /**
   * Link a subscription the caller is a party to (the authenticated link route).
   *
   * Ownership is enforced on both sides: the caller must be a party to the
   * subscription (via `partyOf`), and the plan must be on the caller's own
   * channel — a creator cannot link their sub to another creator's plan. The
   * supporter's account is recorded from the caller's pkh.
   */
  async linkForCaller(input: {
    callerPkh: string;
    subscriptionId: string;
    planId: number;
    partyOf: (subscriptionId: string, pkh: string) => Promise<boolean>;
  }): Promise<SubscriptionLink> {
    const subscriptionId = requireString(input.subscriptionId, 'subscriptionId');
    const isParty = await input.partyOf(subscriptionId, input.callerPkh);
    if (!isParty) throw new NotFoundException('subscription not found');
    const plan = await this.plans.findById(input.planId);
    if (plan === null) throw new NotFoundException('plan not found');
    const channel = await this.channels.findById(plan.channelId);
    const account = await this.accountFor(input.callerPkh);
    if (channel === null || channel.ownerAccountId !== account.id) {
      throw new ForbiddenException('plan belongs to another creator');
    }
    return this.links.link({
      subscriptionId,
      channelId: plan.channelId,
      planId: plan.id,
      supporterAccountId: account.id,
    });
  }

  /** State categories linked to a channel / plan (the filter join). */
  async linkedSubscriptionIds(scope: { channelId?: number; planId?: number }): Promise<string[]> {
    return this.links.findSubscriptionIdsByScope(scope);
  }

  private async requireOwnChannel(pkh: string): Promise<Channel> {
    const account = await this.accountFor(pkh);
    const channel = await this.channels.findByOwner(account.id);
    if (channel === null) throw new ForbiddenException('no channel for this creator');
    return channel;
  }

  private async requireOwnPlan(pkh: string, planId: number): Promise<Plan> {
    const plan = await this.plans.findById(planId);
    if (plan === null) throw new NotFoundException('plan not found');
    const channel = await this.requireOwnChannel(pkh);
    if (plan.channelId !== channel.id) {
      throw new ForbiddenException('plan belongs to another creator');
    }
    return plan;
  }

  private async toChannelView(channel: Channel): Promise<ChannelView> {
    const plans = await this.plans.findVisibleByChannel(channel.id);
    return {
      id: channel.id,
      ownerAccountId: channel.ownerAccountId,
      title: channel.title,
      cover: channel.cover,
      description: channel.description,
      payoutAddress: channel.payoutAddress,
      offeredAssets: channel.offeredAssets,
      defaultMode: channel.defaultMode,
      plans: plans.map(toPlanView),
    };
  }
}

/** The API view of a plan. */
export function toPlanView(plan: Plan): PlanView {
  return {
    id: plan.id,
    channelId: plan.channelId,
    title: plan.title,
    description: plan.description,
    amount: plan.amount,
    period: plan.period,
    asset: plan.asset,
    unit: plan.unit,
    benefits: plan.benefits,
    defaultMode: plan.defaultMode,
    visible: plan.visible,
  };
}

function normalizeMode(mode: unknown): number {
  if (mode === undefined || mode === null) return 1;
  const value = Number(mode);
  if (value !== 0 && value !== 1) throw new BadRequestException('defaultMode must be 0 or 1');
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestException(`${field} is required`);
  }
  return value;
}

function requireAmount(value: unknown): bigint {
  if (value === undefined || value === null || value === '') {
    throw new BadRequestException('amount is required');
  }
  let amount: bigint;
  try {
    amount = BigInt(value as string | number | bigint);
  } catch {
    throw new BadRequestException('amount must be an integer');
  }
  if (amount <= 0n) throw new BadRequestException('amount must be positive');
  return amount;
}

function requirePeriod(value: unknown): number {
  const period = Number(value);
  if (!Number.isInteger(period) || period <= 0) {
    throw new BadRequestException('period must be a positive integer');
  }
  return period;
}

/**
 * Validate a plan's display `unit` against the allowed set (dapp-handoff §7).
 * `undefined`/`null`/`''` → `null` (unset); an unknown unit is a 400.
 */
function requireUnit(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !(PLAN_UNITS as readonly string[]).includes(value)) {
    throw new BadRequestException(`unit must be one of ${PLAN_UNITS.join(', ')}`);
  }
  return value;
}
