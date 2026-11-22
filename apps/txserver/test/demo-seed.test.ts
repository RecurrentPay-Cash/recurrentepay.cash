/**
 * Demo seed tests (Slice 6, task 8.19 — a task, not a requirement).
 *
 * The judge demo seed creates a mock channel + plans so the demo has data. The
 * key property is **idempotence**: running it twice does not duplicate anything.
 */
import { DataSource } from 'typeorm';
import { Account } from '../src/db/account.entity.js';
import { Channel } from '../src/db/channel.entity.js';
import { Plan } from '../src/db/plan.entity.js';
import { SubscriptionLink } from '../src/db/subscription-link.entity.js';
import { AccountRepository } from '../src/offchain/account.repository.js';
import { ChannelRepository } from '../src/offchain/channel.repository.js';
import { PlanRepository } from '../src/offchain/plan.repository.js';
import { DemoSeedService } from '../src/offchain/demo-seed.service.js';

describe('Demo seed', () => {
  let dataSource: DataSource;
  let seed: DemoSeedService;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Account, Channel, Plan, SubscriptionLink],
      synchronize: true,
    });
    await dataSource.initialize();
    seed = new DemoSeedService(
      new AccountRepository(dataSource.getRepository(Account)),
      new ChannelRepository(dataSource.getRepository(Channel)),
      new PlanRepository(dataSource.getRepository(Plan)),
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.getRepository(Plan).clear();
    await dataSource.getRepository(Channel).clear();
    await dataSource.getRepository(Account).clear();
  });

  it('creates a demo channel with plans', async () => {
    const result = await seed.seed();
    expect(result.created).toBe(true);
    expect(result.planIds.length).toBeGreaterThan(0);

    const channels = await dataSource.getRepository(Channel).find();
    expect(channels).toHaveLength(1);
    expect(channels[0]?.title).toBe('Demo Creator');

    const plans = await dataSource.getRepository(Plan).find();
    expect(plans.length).toBe(result.planIds.length);
    expect(plans.every((p) => p.visible)).toBe(true);
  });

  it('is idempotent — running twice does not duplicate', async () => {
    const first = await seed.seed();
    const second = await seed.seed();

    expect(second.created).toBe(false);
    expect(second.channelId).toBe(first.channelId);
    expect(second.planIds).toEqual(first.planIds);

    expect(await dataSource.getRepository(Channel).count()).toBe(1);
    expect(await dataSource.getRepository(Plan).count()).toBe(first.planIds.length);
    expect(await dataSource.getRepository(Account).count()).toBe(1);
  });
});
