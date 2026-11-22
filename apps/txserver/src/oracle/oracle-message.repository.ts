import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OracleMessage } from '../db/oracle-message.entity.js';

/** The fields a fetch writes to the audit table. */
export interface OracleMessageInsert {
  source: string;
  oraclePkHash: string;
  price: number;
  timestamp: number;
  messageSequence: number;
  contentSequence: number;
}

/**
 * Postgres-backed store for fetched oracle messages (spec § Postgres schema —
 * `oracle_message`). Every validated fetch is persisted: it is the **audit
 * store** (a stale/degraded oracle is diagnosable after the fact), not a cache.
 */
@Injectable()
export class OracleMessageRepository {
  constructor(
    @InjectRepository(OracleMessage)
    private readonly repo: Repository<OracleMessage>,
  ) {}

  async insert(row: OracleMessageInsert): Promise<OracleMessage> {
    const entity = this.repo.create(row);
    await this.repo.save(entity);
    return entity;
  }

  /** The most recently fetched message for an oracle, or `null`. */
  async findLatest(oraclePkHash: string): Promise<OracleMessage | null> {
    return this.repo.findOne({
      where: { oraclePkHash },
      order: { id: 'DESC' },
    });
  }
}
