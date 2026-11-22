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
import { MAINNET_TEST_WALLETS } from './demo-wallets.js';
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

  // The mainnet test pair is env-gated (`DEMO_MAINNET_SEED`). Print the derived
  // wallets so the operator can record them locally — never commit them.
  if (MAINNET_TEST_WALLETS.length === 0) {
    console.log('set DEMO_MAINNET_SEED to derive the mainnet test wallets');
  } else {
    console.log('mainnet test wallets (record locally, NEVER commit):');
    for (const w of MAINNET_TEST_WALLETS) {
      console.log(`${w.persona} · ${w.mnemonic} · ${w.pkh} · ${w.address} · ${w.path}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
