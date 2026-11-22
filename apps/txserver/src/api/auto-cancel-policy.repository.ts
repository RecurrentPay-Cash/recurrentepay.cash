import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AutoCancelPolicy } from '../db/auto-cancel-policy.entity.js';

/** The fields `POST /subscriptions/:id/auto-cancel-policy` writes. */
export interface AutoCancelPolicyUpsert {
  subscriptionId: string;
  supporteePkh: string;
  thresholdPeriods: number;
  graceSeconds: number;
  enabled: boolean;
}

/**
 * Store for the supportee's opt-in auto-cancel policy (spec § Postgres schema —
 * `auto_cancel_policy`). Slice 4 only persists it; the firing logic is Slice 5.
 */
@Injectable()
export class AutoCancelPolicyRepository {
  constructor(
    @InjectRepository(AutoCancelPolicy)
    private readonly repo: Repository<AutoCancelPolicy>,
  ) {}

  async upsert(row: AutoCancelPolicyUpsert): Promise<AutoCancelPolicy> {
    await this.repo.save(this.repo.create(row));
    return this.repo.findOneByOrFail({ subscriptionId: row.subscriptionId });
  }

  async find(subscriptionId: string): Promise<AutoCancelPolicy | null> {
    return this.repo.findOne({ where: { subscriptionId } });
  }
}
