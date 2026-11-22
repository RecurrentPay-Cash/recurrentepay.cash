import { createDataSource } from './data-source.js';
import { CreateSubscription1700000000000 } from './migrations/1700000000000-create-subscription.js';
import { CreatePull1700000000001 } from './migrations/1700000000001-create-pull.js';
import { CreateOracleMessage1700000000002 } from './migrations/1700000000002-create-oracle-message.js';
import { CreateNotificationWebhook1700000000003 } from './migrations/1700000000003-create-notification-webhook.js';
import { CreateScheduledCancel1700000000004 } from './migrations/1700000000004-create-scheduled-cancel.js';
import { AddPolicyWarnedAt1700000000005 } from './migrations/1700000000005-add-policy-warned-at.js';
import { loadConfig } from '../config.js';

/**
 * Run the migrations against `DATABASE_URL`.
 *
 * Usage: `pnpm --filter txserver migration:run`.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const dataSource = createDataSource(config.databaseUrl, {
    migrations: [
      CreateSubscription1700000000000,
      CreatePull1700000000001,
      CreateOracleMessage1700000000002,
      CreateNotificationWebhook1700000000003,
      CreateScheduledCancel1700000000004,
      AddPolicyWarnedAt1700000000005,
    ],
  });
  await dataSource.initialize();
  await dataSource.runMigrations();
  await dataSource.destroy();
  console.log('migrations: done');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
