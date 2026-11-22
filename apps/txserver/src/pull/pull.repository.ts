import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Pull } from '../db/pull.entity.js';

/** The fields a pull cycle writes when it broadcasts. */
export interface PullInsert {
  subscriptionId: string;
  txid: string;
  periodsSettled: bigint;
  gross: bigint;
  fee: bigint;
  broadcastAt: number;
  status?: string;
}

/**
 * Postgres-backed store for broadcast pulls (spec § Postgres schema — `pull`).
 *
 * The row is written before the broadcast so a concurrent cycle can see the
 * pending pull and skip it (the double-pull guard). A unique index on
 * `(subscription_id, broadcast_at)` backs the guard across processes: a second
 * instance inserting the same boundary fails and is treated as "already pulled".
 */
@Injectable()
export class PullRepository {
  constructor(
    @InjectRepository(Pull)
    private readonly repo: Repository<Pull>,
  ) {}

  async insert(row: PullInsert): Promise<Pull> {
    const entity = this.repo.create({
      subscriptionId: row.subscriptionId,
      txid: row.txid,
      periodsSettled: row.periodsSettled.toString(),
      gross: row.gross.toString(),
      fee: row.fee.toString(),
      broadcastAt: row.broadcastAt,
      status: row.status ?? 'accepted',
    });
    await this.repo.save(entity);
    return entity;
  }

  /** The most recent pull for a subscription, or `null`. */
  async findLatest(subscriptionId: string): Promise<Pull | null> {
    return this.repo.findOne({ where: { subscriptionId }, order: { id: 'DESC' } });
  }

  /** Every pull for a subscription, newest first (the API history view). */
  async findBySubscription(subscriptionId: string): Promise<Pull[]> {
    return this.repo.find({ where: { subscriptionId }, order: { id: 'DESC' } });
  }

  /**
   * Mark a pull `failed` after a broadcast error (spec § Postgres schema — the
   * `failed` status). Keeps the audit log honest: the row was written before the
   * broadcast, so a throw must not leave it looking `accepted`.
   */
  async markFailed(id: number): Promise<void> {
    await this.repo.update({ id }, { status: 'failed' });
  }
}
