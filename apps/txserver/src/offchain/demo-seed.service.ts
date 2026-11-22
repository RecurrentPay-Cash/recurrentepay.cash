/**
 * Judge demo seed (task 8.19 — a task, not a requirement).
 *
 * Creates two mock creator channels + a handful of plans (and optionally a
 * couple of subscriptions linked to them) so the demo has data without
 * hand-crafting rows. **Idempotent**: running it twice does not duplicate
 * anything — it keys on the channel title and the plan title within the channel.
 *
 * **Stable ids** (dapp-handoff §4): `1 = RecurrentPay.Cash`, `2 = Alice`. The
 * web channel picker links to `/channels/1` and `/channels/2`, so the ids must
 * be deterministic across re-seeds. The seed pins them by inserting the two
 * channels in order on a fresh DB (AUTOINCREMENT starts at 1) and reuses the
 * existing rows on a re-run.
 *
 * Entrypoint: `pnpm --filter txserver seed:demo` (see `seed-demo.ts`). The
 * service method is also callable from tests against an in-memory DB.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ChannelRepository } from './channel.repository.js';
import { PlanRepository } from './plan.repository.js';
import { AccountRepository } from './account.repository.js';
import { DEMO_WALLETS, MAINNET_TEST_WALLETS, type DemoWallet } from './demo-wallets.js';

export interface DemoSeedResult {
  accountId: number;
  channelId: number;
  planIds: number[];
  created: boolean;
  /** Every seeded channel (stable ids), in insertion order. */
  channels: Array<{ id: number; title: string }>;
}

/** The demo creators' pkhs (fixed placeholders — the seed owns these accounts). */
const DEMO_ACCOUNT_PKH = '00'.repeat(20);
const ALICE_ACCOUNT_PKH = '11'.repeat(20);

interface DemoPlan {
  title: string;
  description: string;
  amount: bigint;
  period: number;
  asset: string;
  unit: string;
  benefits: string[];
  defaultMode: number;
}

interface DemoChannel {
  accountPkh: string;
  title: string;
  description: string;
  payoutAddress: string;
  offeredAssets: string[];
  defaultMode: number;
  plans: DemoPlan[];
}

const MONTH = 30 * 24 * 60 * 60;
const WEEK = 7 * 24 * 60 * 60;

/**
 * The deterministic persona channels (task: judge demo wallets). One channel per
 * supportee persona, owned by that persona's derived account, with 1–3 plans.
 * Supporters have accounts but no channel. Appended **after** the two legacy
 * channels so `/channels/1` and `/channels/2` keep their ids.
 */
const PERSONA_PLANS: Record<string, DemoPlan[]> = {
  kallisti_supportee: [
    {
      title: 'Supporter',
      description: 'Recurring support for Kallisti',
      amount: 10_000n,
      period: MONTH,
      asset: 'BCH',
      unit: 'USD',
      benefits: ['Supporter badge'],
      defaultMode: 1,
    },
    {
      title: 'Patron',
      description: 'Higher tier with perks',
      amount: 50_000n,
      period: MONTH,
      asset: 'BCH',
      unit: 'USD',
      benefits: ['All Supporter perks', 'Monthly call'],
      defaultMode: 1,
    },
  ],
  sayoshi_supportee: [
    {
      title: 'Weekly',
      description: 'Weekly support for Sayoshi',
      amount: 2_000n,
      period: WEEK,
      asset: 'BCH',
      unit: 'USD',
      benefits: ['Weekly shout-out'],
      defaultMode: 1,
    },
  ],
  elliot_supportee: [
    {
      title: 'Coffee',
      description: 'Buy Elliot a coffee each month',
      amount: 5_000n,
      period: MONTH,
      asset: 'BCH',
      unit: 'USD',
      benefits: ['Supporter shout-out'],
      defaultMode: 1,
    },
    {
      title: 'Token',
      description: 'Token-denominated support',
      amount: 5_000n,
      period: MONTH,
      asset: 'token',
      unit: 'PUSD',
      benefits: ['Token-gated content'],
      defaultMode: 0,
    },
  ],
};

/** The six persona channels (metadata only), in `DEMO_WALLETS` order. */
const PERSONA_CHANNELS: DemoChannel[] = DEMO_WALLETS.map((wallet) => ({
  accountPkh: wallet.pkh,
  title: `${personaPrefix(wallet.persona)} (${wallet.persona.endsWith('_supportee') ? 'supportee' : 'supporter'})`,
  description: `Demo channel for ${wallet.persona}.`,
  payoutAddress: wallet.address,
  offeredAssets: ['BCH'],
  defaultMode: 1,
  // Supporters get an account but no channel; give them an empty plan list.
  plans: PERSONA_PLANS[wallet.persona] ?? [],
}));

/** `kallisti_supportee` → `Kallisti`. */
function personaPrefix(persona: string): string {
  const name = persona.split('_')[0] ?? persona;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** The two legacy demo channels (metadata only), in stable-id order. */
const DEMO_CHANNELS: DemoChannel[] = [
  {
    accountPkh: DEMO_ACCOUNT_PKH,
    title: 'RecurrentPay.Cash',
    description: 'The official RecurrentPay.Cash demo channel.',
    payoutAddress: 'bitcoincash:qdemo000000000000000000000000000000000000000',
    offeredAssets: ['BCH', 'token'],
    defaultMode: 1,
    plans: [
      {
        title: 'Basic',
        description: 'Basic support tier',
        amount: 10_000n,
        period: MONTH,
        asset: 'BCH',
        unit: 'USD',
        benefits: ['Supporter badge', 'Early access'],
        defaultMode: 1,
      },
      {
        title: 'Pro',
        description: 'Pro support tier',
        amount: 25_000n,
        period: MONTH,
        asset: 'BCH',
        unit: 'USD',
        benefits: ['All Basic perks', 'Monthly call'],
        defaultMode: 1,
      },
      {
        title: 'Token',
        description: 'Token-denominated tier',
        amount: 5_000n,
        period: WEEK,
        asset: 'token',
        unit: 'PUSD',
        benefits: ['Token-gated content'],
        defaultMode: 0,
      },
    ],
  },
  {
    accountPkh: ALICE_ACCOUNT_PKH,
    title: 'Alice',
    description: 'Alice’s creator channel.',
    payoutAddress: 'bitcoincash:qalice00000000000000000000000000000000000000',
    offeredAssets: ['BCH'],
    defaultMode: 1,
    plans: [
      {
        title: 'Coffee',
        description: 'Buy Alice a coffee each month',
        amount: 5_000n,
        period: MONTH,
        asset: 'BCH',
        unit: 'USD',
        benefits: ['Supporter shout-out'],
        defaultMode: 1,
      },
    ],
  },
];

/**
 * Seed the demo channels + plans. Idempotent: re-running finds the existing
 * channel (by owner + title) and the existing plans (by title within the
 * channel) and only fills in what is missing.
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
    const channels: Array<{ id: number; title: string }> = [];
    let firstAccountId = 0;
    let firstChannelId = 0;
    let firstPlanIds: number[] = [];
    let created = false;

    for (const fixture of [...DEMO_CHANNELS, ...PERSONA_CHANNELS]) {
      const account = await this.accounts.findOrCreateByPkh(fixture.accountPkh);
      // Supporters have an account but no channel (empty plan list).
      if (fixture.plans.length === 0) continue;
      const existing = await this.channels.findByOwner(account.id);
      let channelId: number;
      if (existing !== null) {
        channelId = existing.id;
      } else {
        const channel = await this.channels.create({
          ownerAccountId: account.id,
          title: fixture.title,
          description: fixture.description,
          payoutAddress: fixture.payoutAddress,
          offeredAssets: [...fixture.offeredAssets],
          defaultMode: fixture.defaultMode,
        });
        channelId = channel.id;
        created = true;
      }

      const planIds: number[] = [];
      for (const plan of fixture.plans) {
        const existingPlan = await this.findPlanByTitle(channelId, plan.title);
        if (existingPlan !== null) {
          planIds.push(existingPlan.id);
          continue;
        }
        const row = await this.plans.create({
          channelId,
          title: plan.title,
          description: plan.description,
          amount: plan.amount,
          period: plan.period,
          asset: plan.asset,
          unit: plan.unit,
          benefits: [...plan.benefits],
          defaultMode: plan.defaultMode,
        });
        planIds.push(row.id);
      }

      channels.push({ id: channelId, title: fixture.title });
      if (channels.length === 1) {
        firstAccountId = account.id;
        firstChannelId = channelId;
        firstPlanIds = planIds;
      }
    }

    this.logger.log(
      `demo seed ${created ? 'created' : 'reused'} channels [${channels.map((c) => `${c.id}:${c.title}`).join(', ')}]`,
    );

    // Env-gated mainnet test pair: accounts only (they are parties, not
    // creators). The derived secrets are printed by `seed-demo.ts`, never
    // committed. Skipped entirely when `DEMO_MAINNET_SEED` is unset.
    if (MAINNET_TEST_WALLETS.length === 0) {
      this.logger.log('set DEMO_MAINNET_SEED to derive the mainnet test wallets');
    } else {
      for (const wallet of MAINNET_TEST_WALLETS) {
        await this.accounts.findOrCreateByPkh(wallet.pkh);
      }
      this.logger.log(
        `demo seed mainnet test accounts [${MAINNET_TEST_WALLETS.map((w) => w.persona).join(', ')}]`,
      );
    }

    return {
      accountId: firstAccountId,
      channelId: firstChannelId,
      planIds: firstPlanIds,
      created,
      channels,
    };
  }

  private async findPlanByTitle(channelId: number, title: string) {
    const plans = await this.plans.findVisibleByChannel(channelId);
    return plans.find((p) => p.title === title) ?? null;
  }
}
