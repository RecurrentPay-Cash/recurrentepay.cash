import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SubscriptionLink } from '../db/subscription-link.entity.js';

/** The fields a plan → subscription link records. */
export interface LinkUpsert {
  subscriptionId: string;
  channelId: number;
  planId?: number | null;
  supporterAccountId?: number | null;
}

/**
 * Store for the plan → subscription link (spec § Postgres schema —
 * `subscription_link`).
 *
 * The link is written when a creation carries a `planId` (or via an explicit
 * link call). It is the join the `channel`/`plan` subscription filters read.
 * Metadata only — the covenant never references the plan.
 */
@Injectable()
export class SubscriptionLinkRepository {
  constructor(
    @InjectRepository(SubscriptionLink)
    private readonly repo: Repository<SubscriptionLink>,
  ) {}

  /** Upsert the link for a subscription (one link per state category). */
  async link(row: LinkUpsert): Promise<SubscriptionLink> {
    await this.repo.save(
      this.repo.create({
        subscriptionId: row.subscriptionId,
        channelId: row.channelId,
        planId: row.planId ?? null,
        supporterAccountId: row.supporterAccountId ?? null,
      }),
    );
    return this.repo.findOneByOrFail({ subscriptionId: row.subscriptionId });
  }

  async findBySubscription(subscriptionId: string): Promise<SubscriptionLink | null> {
    return this.repo.findOne({ where: { subscriptionId } });
  }

  /**
   * State categories linked to the given channel **and** plan (filter helper).
   *
   * The filters combine with **AND**: `?channel=1&plan=2` returns only subs that
   * are in channel 1 *and* on plan 2. (A TypeORM `where` array would OR them —
   * that is the bug this single-object where fixes; Slice 6 review Minor 2.)
   */
  async findSubscriptionIdsByScope(scope: {
    channelId?: number;
    planId?: number;
  }): Promise<string[]> {
    const where: { channelId?: number; planId?: number } = {};
    if (scope.channelId !== undefined) where.channelId = scope.channelId;
    if (scope.planId !== undefined) where.planId = scope.planId;
    if (Object.keys(where).length === 0) return [];
    const rows = await this.repo.find({ where });
    return [...new Set(rows.map((r) => r.subscriptionId))];
  }
}
