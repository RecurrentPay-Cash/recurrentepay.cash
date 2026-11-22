import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelAutoCancelPolicy } from '../db/channel-auto-cancel-policy.entity.js';

/** The fields `PUT /offchain/channel/auto-cancel` writes. */
export interface ChannelPolicyUpsert {
  channelId: number;
  thresholdPeriods: number;
  graceSeconds: number;
  enabled: boolean;
}

/** The effective channel policy the API exposes (persisted row or defaults). */
export interface ChannelPolicyView {
  thresholdPeriods: number;
  graceSeconds: number;
  enabled: boolean;
}

/**
 * The default channel auto-cancel policy when a channel has not set one. Disabled
 * by default — a creator opts in explicitly (dapp-handoff §14).
 */
export const DEFAULT_CHANNEL_POLICY: ChannelPolicyView = {
  thresholdPeriods: 1,
  graceSeconds: 0,
  enabled: false,
};

/**
 * Store for the channel-level default auto-cancel policy (dapp-handoff §14).
 *
 * One row per channel (`channel_id` is the primary key). The row is the channel
 * default; the per-sub `auto_cancel_policy` is the override. Metadata only —
 * never authoritative over a sub's on-chain terms.
 */
@Injectable()
export class ChannelAutoCancelPolicyRepository {
  constructor(
    @InjectRepository(ChannelAutoCancelPolicy)
    private readonly repo: Repository<ChannelAutoCancelPolicy>,
  ) {}

  /** Upsert the channel's default policy. */
  async upsert(row: ChannelPolicyUpsert): Promise<ChannelAutoCancelPolicy> {
    await this.repo.save(this.repo.create(row));
    return this.repo.findOneByOrFail({ channelId: row.channelId });
  }

  /** The channel's stored policy, or `null` when unset. */
  async find(channelId: number): Promise<ChannelAutoCancelPolicy | null> {
    return this.repo.findOne({ where: { channelId } });
  }

  /** Every enabled channel policy (the auto-cancel scan's inheritance source). */
  async findEnabled(): Promise<ChannelAutoCancelPolicy[]> {
    return this.repo.find({ where: { enabled: true } });
  }
}
