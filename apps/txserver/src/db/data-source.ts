import { DataSource, type DataSourceOptions } from 'typeorm';
import { Subscription } from './subscription.entity.js';
import { Pull } from './pull.entity.js';
import { OracleMessage } from './oracle-message.entity.js';
import { Notification } from './notification.entity.js';
import { NotificationRead } from './notification-read.entity.js';
import { WebhookEndpoint } from './webhook-endpoint.entity.js';
import { AutoCancelPolicy } from './auto-cancel-policy.entity.js';
import { Cancel } from './cancel.entity.js';
import { ScheduledCancel } from './scheduled-cancel.entity.js';
import { Account } from './account.entity.js';
import { Channel } from './channel.entity.js';
import { Plan } from './plan.entity.js';
import { SubscriptionLink } from './subscription-link.entity.js';
import { MutualConsentProposal } from './mutual-consent-proposal.entity.js';
import { ChannelAutoCancelPolicy } from './channel-auto-cancel-policy.entity.js';

/**
 * Build the TypeORM data source options.
 *
 * `synchronize` is off: the schema is owned by migrations (see
 * `src/db/migrations/`). Tests may pass `synchronize: true` for an ephemeral DB.
 */
export function buildDataSourceOptions(
  databaseUrl: string,
  overrides: Partial<DataSourceOptions> = {},
): DataSourceOptions {
  return {
    type: 'postgres',
    url: databaseUrl,
    entities: [
      Subscription,
      Pull,
      OracleMessage,
      Notification,
      NotificationRead,
      WebhookEndpoint,
      AutoCancelPolicy,
      Cancel,
      ScheduledCancel,
      Account,
      Channel,
      Plan,
      SubscriptionLink,
      MutualConsentProposal,
      ChannelAutoCancelPolicy,
    ],
    migrations: [],
    synchronize: false,
    ...overrides,
  } as DataSourceOptions;
}

/** Create a data source from a connection string. */
export function createDataSource(
  databaseUrl: string,
  overrides: Partial<DataSourceOptions> = {},
): DataSource {
  return new DataSource(buildDataSourceOptions(databaseUrl, overrides));
}
