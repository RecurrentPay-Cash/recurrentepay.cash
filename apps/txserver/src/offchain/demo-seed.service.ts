/**
 * Judge demo seed (task 8.19 — a task, not a requirement).
 *
 * Creates a mock creator channel + a handful of plans (and optionally a couple
 * of subscriptions linked to them) so the demo has data without hand-crafting
 * rows. **Idempotent**: running it twice does not duplicate anything — it keys
 * on the channel title and the plan title within the channel.
 *
 * Entrypoint: `pnpm --filter txserver seed:demo` (see `seed-demo.ts`). The
 * service method is also callable from tests against an in-memory DB.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ChannelRepository } from './channel.repository.js';
import { PlanRepository } from './plan.repository.js';
import { AccountRepository } from './account.repository.js';

export interface DemoSeedResult {
  accountId: number;
  channelId: number;
  planIds: number[];
  created: boolean;
}

/** The demo creator's pkh (a fixed placeholder — the seed owns this account). */
const DEMO_ACCOUNT_PKH = '00'.repeat(20);

/** The demo channel/plan fixtures (metadata only). */
const DEMO_CHANNEL = {
  title: 'Demo Creator',
  description: 'A mock creator channel for the RecurrentPay.Cash judge demo.',
  payoutAddress: 'bitcoincash:qdemo000000000000000000000000000000000000000',
  offeredAssets: ['BCH', 'token'],
  defaultMode: 1,
} as const;

const DEMO_PLANS = [
  {
    title: 'Basic',
    description: 'Basic support tier',
    amount: 10_000n,
    period: 30 * 24 * 60 * 60,
    asset: 'BCH',
    benefits: ['Supporter badge', 'Early access'],
    defaultMode: 1,
  },
  {
    title: 'Pro',
    description: 'Pro support tier',
    amount: 25_000n,
    period: 30 * 24 * 60 * 60,
    asset: 'BCH',
    benefits: ['All Basic perks', 'Monthly call'],
    defaultMode: 1,
  },
  {
    title: 'Token',
    description: 'Token-denominated tier',
    amount: 5_000n,
    period: 7 * 24 * 60 * 60,
    asset: 'token',
    benefits: ['Token-gated content'],
    defaultMode: 0,
  },
] as const;

/**
 * Seed the demo channel + plans. Idempotent: re-running finds the existing
 * channel (by title) and the existing plans (by title within the channel) and
 * only fills in what is missing.
 */
@Injectable()
export class DemoSeedService {
  private readonly logger = new Logger(DemoSeedService.name);

  constructor(
    private readonly accounts: AccountRepository,
    private readonly channels: ChannelRepository,
    private readonly plans: PlanRepository,
  ) {}

  async seed(): Promise<DemoSeedResult> {
    // A single demo account owns the demo channel. Re-running reuses it: the
    // channel is looked up by title, so a second run is a no-op.
    const existingChannel = await this.findChannelByTitle(DEMO_CHANNEL.title);
    let accountId: number;
    let channelId: number;
    let created = false;

    if (existingChannel !== null) {
      accountId = existingChannel.ownerAccountId;
      channelId = existingChannel.id;
    } else {
      const account = await this.accounts.findOrCreateByPkh(DEMO_ACCOUNT_PKH);
      accountId = account.id;
      const channel = await this.channels.create({
        ownerAccountId: accountId,
        title: DEMO_CHANNEL.title,
        description: DEMO_CHANNEL.description,
        payoutAddress: DEMO_CHANNEL.payoutAddress,
        offeredAssets: [...DEMO_CHANNEL.offeredAssets],
        defaultMode: DEMO_CHANNEL.defaultMode,
      });
      channelId = channel.id;
      created = true;
    }

    const planIds: number[] = [];
    for (const plan of DEMO_PLANS) {
      const existing = await this.findPlanByTitle(channelId, plan.title);
      if (existing !== null) {
        planIds.push(existing.id);
        continue;
      }
      const row = await this.plans.create({
        channelId,
        title: plan.title,
        description: plan.description,
        amount: plan.amount,
        period: plan.period,
        asset: plan.asset,
        benefits: [...plan.benefits],
        defaultMode: plan.defaultMode,
      });
      planIds.push(row.id);
    }

    this.logger.log(
      `demo seed ${created ? 'created' : 'reused'} channel ${channelId} with plans [${planIds.join(', ')}]`,
    );
    return { accountId, channelId, planIds, created };
  }

  private async findChannelByTitle(title: string) {
    // Scoped lookup: the demo account owns at most one channel (MVP: one per
    // creator), so this is a single indexed read, not a full-table scan.
    const account = await this.accounts.findByPkh(DEMO_ACCOUNT_PKH);
    if (account === null) return null;
    const channel = await this.channels.findByOwner(account.id);
    return channel !== null && channel.title === title ? channel : null;
  }

  private async findPlanByTitle(channelId: number, title: string) {
    const plans = await this.plans.findVisibleByChannel(channelId);
    return plans.find((p) => p.title === title) ?? null;
  }
}
