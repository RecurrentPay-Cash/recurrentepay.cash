import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { WebhookEndpoint } from '../db/webhook-endpoint.entity.js';

/** The fields a registration writes. */
export interface WebhookEndpointInsert {
  url: string;
  secret: string;
  partyPkh: string;
  active?: boolean;
}

/**
 * Postgres-backed store for webhook endpoints (spec § Postgres schema —
 * `webhook_endpoint`).
 */
@Injectable()
export class WebhookEndpointRepository {
  constructor(
    @InjectRepository(WebhookEndpoint)
    private readonly repo: Repository<WebhookEndpoint>,
  ) {}

  async create(row: WebhookEndpointInsert): Promise<WebhookEndpoint> {
    const entity = this.repo.create({
      ...row,
      // Canonical pkh case, matching `SubscriptionRepository` (a party's endpoints
      // must be found by the same lowercase pkh the session issues).
      partyPkh: row.partyPkh.toLowerCase(),
      active: row.active ?? true,
    });
    await this.repo.save(entity);
    return entity;
  }

  /** The active endpoints for a set of parties (`deliverTo` reads this). */
  async findActiveByParties(partyPkhs: string[]): Promise<WebhookEndpoint[]> {
    if (partyPkhs.length === 0) return [];
    return this.repo.find({
      where: { partyPkh: In(partyPkhs.map((p) => p.toLowerCase())), active: true },
    });
  }

  /** Every endpoint registered by a party (the caller's own, for `GET /webhooks`). */
  async findByParty(partyPkh: string): Promise<WebhookEndpoint[]> {
    return this.repo.find({
      where: { partyPkh: partyPkh.toLowerCase() },
      order: { id: 'DESC' },
    });
  }
}
