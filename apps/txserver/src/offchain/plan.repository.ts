import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Plan } from '../db/plan.entity.js';

/** The fields a creator may set on a plan (all metadata). */
export interface PlanUpsert {
  channelId: number;
  title: string;
  description?: string | null;
  amount: bigint;
  period: number;
  asset?: string;
  /** Display denomination (`BCH` | `PUSD` | `MUSD` | `USD` | `XAU`), or null. */
  unit?: string | null;
  benefits?: string[] | null;
  defaultMode?: number;
}

/**
 * Store for channel plans (spec § Postgres schema — `plan`).
 *
 * Plans are **soft-deleted** via `hide` (`visible = false`), never removed:
 * a hard delete would orphan live subscriptions. `findVisible*` powers the plan
 * data API (discovery); `findById` still resolves a hidden plan so a linked sub
 * stays valid.
 */
@Injectable()
export class PlanRepository {
  constructor(
    @InjectRepository(Plan)
    private readonly repo: Repository<Plan>,
  ) {}

  async create(row: PlanUpsert): Promise<Plan> {
    return this.repo.save(
      this.repo.create({ ...row, amount: row.amount.toString(), visible: true }),
    );
  }

  /** Resolve a plan regardless of visibility (a hidden plan still resolves). */
  async findById(id: number): Promise<Plan | null> {
    return this.repo.findOne({ where: { id } });
  }

  /** Visible plans for a channel — what the create wizard may offer. */
  async findVisibleByChannel(channelId: number): Promise<Plan[]> {
    return this.repo.find({ where: { channelId, visible: true }, order: { id: 'ASC' } });
  }

  /** Every visible plan across channels — the discovery feed. */
  async findAllVisible(): Promise<Plan[]> {
    return this.repo.find({ where: { visible: true }, order: { id: 'ASC' } });
  }

  /** Apply a partial edit to an existing plan. */
  async update(id: number, patch: Partial<PlanUpsert>): Promise<Plan> {
    const normalized: Record<string, unknown> = { ...patch };
    if (patch.amount !== undefined) normalized.amount = patch.amount.toString();
    await this.repo.update({ id }, normalized);
    return this.repo.findOneByOrFail({ id });
  }

  /** Soft-delete: hide the plan from discovery. Never hard-deletes. */
  async hide(id: number): Promise<Plan> {
    await this.repo.update({ id }, { visible: false });
    return this.repo.findOneByOrFail({ id });
  }
}
