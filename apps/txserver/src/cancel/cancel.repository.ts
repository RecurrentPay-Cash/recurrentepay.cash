import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cancel } from '../db/cancel.entity.js';

/** The fields a cancel cycle writes when it broadcasts. */
export interface CancelInsert {
  subscriptionId: string;
  txid: string;
  broadcastAt: number;
  gross?: bigint;
  fee?: bigint;
  status?: string;
}

/**
 * Postgres-backed store for broadcast cancels (spec § Postgres schema).
 *
 * The row is written before the broadcast so a concurrent cycle can see the
 * pending cancel and skip it (the per-boundary idempotency guard). A unique index
 * on `(subscription_id, broadcast_at)` backs the guard across processes.
 * `gross`/`fee` mirror `pull` (0 for a seed-only cancel).
 */
@Injectable()
export class CancelRepository {
  constructor(
    @InjectRepository(Cancel)
    private readonly repo: Repository<Cancel>,
  ) {}

  async insert(row: CancelInsert): Promise<Cancel> {
    const entity = this.repo.create({
      subscriptionId: row.subscriptionId,
      txid: row.txid,
      broadcastAt: row.broadcastAt,
      gross: (row.gross ?? 0n).toString(),
      fee: (row.fee ?? 0n).toString(),
      status: row.status ?? 'accepted',
    });
    await this.repo.save(entity);
    return entity;
  }

  /** The most recent cancel for a subscription, or `null`. */
  async findLatest(subscriptionId: string): Promise<Cancel | null> {
    return this.repo.findOne({ where: { subscriptionId }, order: { id: 'DESC' } });
  }

  /** Mark a cancel `failed` after a broadcast error (keeps the audit honest). */
  async markFailed(id: number): Promise<void> {
    await this.repo.update({ id }, { status: 'failed' });
  }
}
