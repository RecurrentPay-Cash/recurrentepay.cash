/**
 * Notifications REST API (Slice 4, spec § Notifications, § API for web app;
 * read-state per dapp handoff §8).
 *
 * `GET /notifications` — the caller's notification log across all their
 * subscriptions (the web app polls this for in-dapp delivery). Reads are scoped
 * to the authenticated pkh. Each row carries `readAt` (nullable) and `unread`
 * (boolean) **for the caller** (joined from `notification_read` on the caller's
 * pkh). `POST /notifications/:id/read` and `POST /notifications/read-all` mark
 * the caller's rows read, idempotently.
 */
import { Controller, Get, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { SubscriptionRepository } from '../subscription/subscription.repository.js';
import { NotificationRepository } from '../notifications/notification.repository.js';
import { NotificationReadRepository } from '../notifications/notification-read.repository.js';
import type { Notification } from '../db/notification.entity.js';
import { AuthGuard, type AuthedRequest } from '../auth/auth.guard.js';

/** The API view of a notification: the log row + the caller's read state. */
export interface NotificationView {
  id: number;
  subscriptionId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
  deliveredAt: number | null;
  /** When the caller read it (unix seconds), or `null` when unread. */
  readAt: number | null;
  /** Whether the caller has not read it (`readAt === null`). */
  unread: boolean;
}

@Controller('notifications')
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(
    private readonly subscriptions: SubscriptionRepository,
    private readonly notifications: NotificationRepository,
    private readonly reads: NotificationReadRepository,
    private readonly guard: AuthGuard,
  ) {}

  @Get()
  async list(@Req() request: AuthedRequest): Promise<NotificationView[]> {
    const pkh = this.guard.caller(request);
    const subs = await this.subscriptions.findByParty(pkh);
    const rows = await this.notifications.findBySubscriptions(
      subs.map((s) => s.stateCategory),
      100,
    );
    return this.decorate(rows, pkh);
  }

  /**
   * Mark one notification read for the caller. Idempotent. 404 when the caller
   * is not a party to the notification's subscription — a caller can only mark
   * notifications it can see (never reveal another party's log).
   */
  @Post(':id/read')
  async markRead(
    @Req() request: AuthedRequest,
    @Param('id') id: string,
  ): Promise<NotificationView> {
    const pkh = this.guard.caller(request);
    const notificationId = Number(id);
    const row =
      Number.isInteger(notificationId) && notificationId > 0
        ? await this.notifications.findById(notificationId)
        : null;
    if (row === null) throw new NotFoundException('notification not found');
    await this.requireParty(row.subscriptionId, pkh);
    await this.reads.markRead(row.id, pkh, Math.floor(Date.now() / 1000));
    const [view] = await this.decorate([row], pkh);
    return view!;
  }

  /** Mark every notification the caller can see read (idempotent). */
  @Post('read-all')
  async markAllRead(@Req() request: AuthedRequest): Promise<{ marked: number }> {
    const pkh = this.guard.caller(request);
    const subs = await this.subscriptions.findByParty(pkh);
    const rows = await this.notifications.findBySubscriptions(
      subs.map((s) => s.stateCategory),
      100,
    );
    await this.reads.markAllRead(
      rows.map((r) => r.id),
      pkh,
      Math.floor(Date.now() / 1000),
    );
    return { marked: rows.length };
  }

  /** Decorate log rows with the caller's `readAt`/`unread`. */
  private async decorate(rows: Notification[], pkh: string): Promise<NotificationView[]> {
    const readAt = await this.reads.readAtByNotification(
      rows.map((r) => r.id),
      pkh,
    );
    return rows.map((row) => toView(row, readAt.get(row.id) ?? null));
  }

  /** Throw 404 unless the caller is a party to the subscription. */
  private async requireParty(stateCategory: string, pkh: string): Promise<void> {
    const row = await this.subscriptions.findByIdForParty(stateCategory, pkh);
    if (row === null) throw new NotFoundException('notification not found');
  }
}

/** The API view of a notification row for a specific caller. */
export function toView(row: Notification, readAt: number | null): NotificationView {
  return {
    id: row.id,
    subscriptionId: row.subscriptionId,
    type: row.type,
    payload: row.payload,
    createdAt: row.createdAt,
    deliveredAt: row.deliveredAt,
    readAt,
    unread: readAt === null,
  };
}
