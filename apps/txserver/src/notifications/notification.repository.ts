import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Notification } from '../db/notification.entity.js';

/** The fields an emit writes to the notification log (before delivery). */
export interface NotificationInsert {
  subscriptionId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
  idempotencyKey: string;
}

/**
 * Postgres-backed store for the notification log (spec § Postgres schema —
 * `notification`).
 *
 * `insert` is the **durable** step: it runs before any delivery is attempted, so
 * a delivery failure never loses the event. The unique `idempotency_key` makes
 * re-emitting the same event a no-op (`insert` returns the existing row) — the
 * dedupe guarantee for an at-least-once webhook.
 */
@Injectable()
export class NotificationRepository {
  constructor(
    @InjectRepository(Notification)
    private readonly repo: Repository<Notification>,
  ) {}

  /**
   * Persist an event idempotently. Returns `{ row, created }`; `created` is
   * `false` when a row with the same idempotency key already existed.
   */
  async insert(row: NotificationInsert): Promise<{ row: Notification; created: boolean }> {
    const existing = await this.findByIdempotencyKey(row.idempotencyKey);
    if (existing !== null) return { row: existing, created: false };
    const entity = this.repo.create({ ...row, deliveredAt: null, deliveryAttempts: 0 });
    await this.repo.save(entity);
    return { row: entity, created: true };
  }

  async findByIdempotencyKey(key: string): Promise<Notification | null> {
    return this.repo.findOne({ where: { idempotencyKey: key } });
  }

  /** A single notification by id (read-state marking), or `null`. */
  async findById(id: number): Promise<Notification | null> {
    return this.repo.findOne({ where: { id } });
  }

  /** The most recent row (test helper / diagnostics). */
  async latest(): Promise<Notification | null> {
    return this.repo.findOne({ where: {}, order: { id: 'DESC' } });
  }

  async count(): Promise<number> {
    return this.repo.count();
  }

  /** The log for a subscription, newest first. */
  async findBySubscription(subscriptionId: string, limit = 100): Promise<Notification[]> {
    return this.repo.find({
      where: { subscriptionId },
      order: { id: 'DESC' },
      take: limit,
    });
  }

  /** The log across a set of subscriptions (the caller's subs), newest first. */
  async findBySubscriptions(subscriptionIds: string[], limit = 100): Promise<Notification[]> {
    if (subscriptionIds.length === 0) return [];
    return this.repo
      .createQueryBuilder('n')
      .where('n.subscriptionId IN (:...ids)', { ids: subscriptionIds })
      .orderBy('n.id', 'DESC')
      .take(limit)
      .getMany();
  }

  /** Record a delivery attempt (success sets `delivered_at`). */
  async recordDelivery(
    id: number,
    attempts: number,
    deliveredAt: number | null,
  ): Promise<void> {
    await this.repo.update({ id }, { deliveryAttempts: attempts, deliveredAt });
  }
}
