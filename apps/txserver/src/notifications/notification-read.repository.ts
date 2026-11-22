import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { NotificationRead } from '../db/notification-read.entity.js';

/**
 * Postgres-backed store for per-recipient notification read state (dapp handoff
 * §8).
 *
 * The `notification` table is per-event (one row, all recipients), so read state
 * is a join table keyed on `(notification_id, party_pkh)`. `markRead` is
 * idempotent: the unique constraint means a second call for the same pair is a
 * no-op. `readAtByNotification` returns the caller's read timestamps for a set
 * of notifications, so the API can decorate rows with `readAt`/`unread`.
 */
@Injectable()
export class NotificationReadRepository {
  constructor(
    @InjectRepository(NotificationRead)
    private readonly repo: Repository<NotificationRead>,
  ) {}

  /**
   * Mark one notification read for a party (idempotent). Returns `true` when a
   * row was created, `false` when it already existed.
   */
  async markRead(notificationId: number, partyPkh: string, readAt: number): Promise<boolean> {
    const pkh = partyPkh.toLowerCase();
    const existing = await this.repo.findOne({ where: { notificationId, partyPkh: pkh } });
    if (existing !== null) return false;
    await this.repo.save(this.repo.create({ notificationId, partyPkh: pkh, readAt }));
    return true;
  }

  /** Mark every given notification read for a party (idempotent). */
  async markAllRead(notificationIds: number[], partyPkh: string, readAt: number): Promise<void> {
    if (notificationIds.length === 0) return;
    const pkh = partyPkh.toLowerCase();
    const existing = await this.repo.find({
      where: { notificationId: In(notificationIds), partyPkh: pkh },
    });
    const seen = new Set(existing.map((r) => r.notificationId));
    const toCreate = notificationIds
      .filter((id) => !seen.has(id))
      .map((id) => this.repo.create({ notificationId: id, partyPkh: pkh, readAt }));
    if (toCreate.length > 0) await this.repo.save(toCreate);
  }

  /** The caller's read timestamps for a set of notifications (`id → readAt`). */
  async readAtByNotification(
    notificationIds: number[],
    partyPkh: string,
  ): Promise<Map<number, number>> {
    if (notificationIds.length === 0) return new Map();
    const rows = await this.repo.find({
      where: { notificationId: In(notificationIds), partyPkh: partyPkh.toLowerCase() },
    });
    return new Map(rows.map((r) => [r.notificationId, r.readAt]));
  }
}
