/**
 * Judge demo seed entrypoint (task 8.19).
 *
 * Usage: `pnpm --filter txserver seed:demo` (requires `DATABASE_URL`). Creates a
 * mock creator channel + plans so the demo has data. Idempotent — safe to run
 * repeatedly.
 */
import { createDataSource } from '../db/data-source.js';
import { loadConfig } from '../config.js';
import { AccountRepository } from './account.repository.js';
import { ChannelRepository } from './channel.repository.js';
import { PlanRepository } from './plan.repository.js';
import { DemoSeedService } from './demo-seed.service.js';
import { Account } from '../db/account.entity.js';
import { Channel } from '../db/channel.entity.js';
import { Plan } from '../db/plan.entity.js';
import { SubscriptionLink } from '../db/subscription-link.entity.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const dataSource = createDataSource(config.databaseUrl, {
    entities: [Account, Channel, Plan, SubscriptionLink],
  });
  await dataSource.initialize();
  const seed = new DemoSeedService(
    new AccountRepository(dataSource.getRepository(Account)),
    new ChannelRepository(dataSource.getRepository(Channel)),
    new PlanRepository(dataSource.getRepository(Plan)),
  );
  const result = await seed.seed();
  await dataSource.destroy();
  console.log(`demo seed: ${JSON.stringify(result)}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
