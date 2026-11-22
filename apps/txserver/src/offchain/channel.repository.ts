import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Channel } from '../db/channel.entity.js';

/** The fields a creator may set on a channel (all metadata). */
export interface ChannelUpsert {
  ownerAccountId: number;
  title: string;
  cover?: string | null;
  description?: string | null;
  payoutAddress?: string | null;
  offeredAssets?: string[] | null;
  defaultMode?: number;
}

/** Store for creator channels (spec § Postgres schema — `channel`). */
@Injectable()
export class ChannelRepository {
  constructor(
    @InjectRepository(Channel)
    private readonly repo: Repository<Channel>,
  ) {}

  async create(row: ChannelUpsert): Promise<Channel> {
    return this.repo.save(this.repo.create(row));
  }

  async findById(id: number): Promise<Channel | null> {
    return this.repo.findOne({ where: { id } });
  }

  /** The creator's channel — MVP has exactly one per owner account. */
  async findByOwner(ownerAccountId: number): Promise<Channel | null> {
    return this.repo.findOne({ where: { ownerAccountId } });
  }

  /** Every channel (used by the demo seed's idempotency lookup). */
  async findAll(): Promise<Channel[]> {
    return this.repo.find();
  }

  /** Apply a partial edit to an existing channel. */
  async update(id: number, patch: Partial<ChannelUpsert>): Promise<Channel> {
    await this.repo.update({ id }, patch);
    return this.repo.findOneByOrFail({ id });
  }
}
