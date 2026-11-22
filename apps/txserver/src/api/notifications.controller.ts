/**
 * Notifications REST API (Slice 4, spec § Notifications, § API for web app).
 *
 * `GET /notifications` — the caller's notification log across all their
 * subscriptions (the web app polls this for in-dapp delivery). Reads are scoped
 * to the authenticated pkh.
 */
import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { SubscriptionRepository } from '../subscription/subscription.repository.js';
import { NotificationRepository } from '../notifications/notification.repository.js';
import { AuthGuard, type AuthedRequest } from '../auth/auth.guard.js';

@Controller('notifications')
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(
    private readonly subscriptions: SubscriptionRepository,
    private readonly notifications: NotificationRepository,
    private readonly guard: AuthGuard,
  ) {}

  @Get()
  async list(@Req() request: AuthedRequest) {
    const pkh = this.guard.caller(request);
    const subs = await this.subscriptions.findByParty(pkh);
    return this.notifications.findBySubscriptions(
      subs.map((s) => s.stateCategory),
      100,
    );
  }
}
