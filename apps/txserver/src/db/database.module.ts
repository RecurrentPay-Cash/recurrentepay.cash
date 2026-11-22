import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { AppConfig } from '../config.js';
import { Subscription } from './subscription.entity.js';
import { Pull } from './pull.entity.js';
import { OracleMessage } from './oracle-message.entity.js';
import { Notification } from './notification.entity.js';
import { WebhookEndpoint } from './webhook-endpoint.entity.js';
import { AutoCancelPolicy } from './auto-cancel-policy.entity.js';
import { Cancel } from './cancel.entity.js';
import { ScheduledCancel } from './scheduled-cancel.entity.js';

/**
 * Postgres access via TypeORM.
 *
 * **Why TypeORM over Prisma** (documented per task 8.1): the txserver is a
 * NestJS app and `@nestjs/typeorm` is the first-party integration; TypeORM's
 * entity/decorator model fits the Nest DI style, migrations are plain TS classes
 * (no separate schema DSL or generated client step), and it supports the
 * `bigint`-as-string mapping the token amounts need. Prisma would add a codegen
 * step and a second schema language for a schema this small. Both are
 * Unlicense-compatible (Apache-2.0 / MIT).
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const app = config.get<AppConfig>('app');
        if (app === undefined) throw new Error('DatabaseModule: app config missing');
        return {
          type: 'postgres' as const,
          url: app.databaseUrl,
          entities: [
            Subscription,
            Pull,
            OracleMessage,
            Notification,
            WebhookEndpoint,
            AutoCancelPolicy,
            Cancel,
            ScheduledCancel,
          ],
          synchronize: false,
        };
      },
    }),
    TypeOrmModule.forFeature([
      Subscription,
      Pull,
      OracleMessage,
      Notification,
      WebhookEndpoint,
      AutoCancelPolicy,
      Cancel,
      ScheduledCancel,
    ]),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
