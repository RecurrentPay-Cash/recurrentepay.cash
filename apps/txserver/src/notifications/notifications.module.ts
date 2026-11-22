/**
 * Notifications module (Slice 4, spec § Notifications).
 *
 * Provides the notification log + webhook-endpoint repositories and the
 * `NotificationService`. The service is wired into the scheduler
 * (`SchedulerService.onEvent` → `NotificationService.emit`) so the existing
 * `pull_success`/`paused`/`buffer_warning` events are persisted and delivered.
 * The webhook HTTP transport is `fetch` by default; tests override
 * `WEBHOOK_HTTP_CLIENT`.
 */
import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Notification } from '../db/notification.entity.js';
import { WebhookEndpoint } from '../db/webhook-endpoint.entity.js';
import { SubscriptionModule } from '../subscription/subscription.module.js';
import { SchedulerModule } from '../scheduler/scheduler.module.js';
import { SchedulerService, type NotificationEvent } from '../scheduler/scheduler.service.js';
import { CancelModule } from '../cancel/cancel.module.js';
import { CancelExecutorService } from '../cancel/cancel-executor.service.js';
import { AutoCancelService } from '../cancel/auto-cancel.service.js';
import { SubscriptionRepository } from '../subscription/subscription.repository.js';
import { NotificationRepository } from './notification.repository.js';
import { WebhookEndpointRepository } from './webhook-endpoint.repository.js';
import {
  NotificationService,
  WEBHOOK_HTTP_CLIENT,
  type WebhookHttpClient,
} from './notification.service.js';

/** The default webhook client: global `fetch`, narrowed to the interface we use. */
const fetchClient: WebhookHttpClient = (url, init) => fetch(url, init);

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([Notification, WebhookEndpoint]),
    SubscriptionModule,
    SchedulerModule,
    CancelModule,
  ],
  providers: [
    NotificationRepository,
    WebhookEndpointRepository,
    { provide: WEBHOOK_HTTP_CLIENT, useValue: fetchClient },
    NotificationService,
  ],
  exports: [NotificationRepository, WebhookEndpointRepository, NotificationService],
})
export class NotificationsModule implements OnModuleInit {
  constructor(
    private readonly scheduler: SchedulerService,
    private readonly notifications: NotificationService,
    private readonly subscriptions: SubscriptionRepository,
    private readonly cancelExecutor: CancelExecutorService,
    private readonly autoCancel: AutoCancelService,
  ) {}

  /**
   * Route every event into the notification service (persist-before-deliver).
   *
   * The scheduler's own events (`pull_success`/`paused`/`buffer_warning`) go
   * straight through. The cancel services own separate emitters, so they are
   * subscribed here and forwarded via `scheduler.forward` — the same path — so
   * `stray_value_notice`, `auto_cancel_warning` and the auto-cancel `canceled`
   * event are persisted + delivered too (review B2, spec § Notifications).
   */
  onModuleInit(): void {
    this.scheduler.onEvent((event) => {
      void this.handle(event).catch(() => undefined);
    });
    this.cancelExecutor.onEvent((event) => this.scheduler.forward(event));
    this.autoCancel.onEvent((event) => this.scheduler.forward(event));
  }

  private async handle(event: NotificationEvent): Promise<void> {
    const row = await this.subscriptions.findById(event.subscriptionId);
    const recipients =
      row === null
        ? []
        : [row.supporterPkh, row.supporteePkh, row.servicePkh].map((p) => p.toLowerCase());
    await this.notifications.emit(event, { recipients });
  }
}

export { WEBHOOK_HTTP_CLIENT };
export type { WebhookHttpClient };
