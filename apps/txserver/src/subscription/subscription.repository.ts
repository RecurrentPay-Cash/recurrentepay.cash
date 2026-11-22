import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Subscription } from '../db/subscription.entity.js';

/** The fields a cycle computes and upserts into the derived-state cache. */
export interface SubscriptionUpsert {
  stateCategory: string;
  stateOutpoint: string | null;
  escrowOutpoint: string | null;
  assetType: 'token' | 'oracle';
  fundsCategory: string;
  mode: number;
  supporterPkh: string;
  supporteePkh: string;
  servicePkh: string;
  amount: bigint;
  amountNext: bigint;
  period: number;
  periodNext: number;
  lastPeriodTime: number;
  escrowBalance: bigint;
  status: string;
  nextPaymentAt: number | null;
  /** Oracle subs only: the commitment's `oraclePkHash` (hex, 20 B). */
  oraclePkHash?: string | null;
  /** Oracle subs only: the pubkey mapped from `oraclePkHash` (hex). */
  oraclePubkey?: string | null;
  /** Oracle subs only: `lastRate` (cents/BCH) read from the commitment. */
  lastRate?: number | null;
}

/**
 * Postgres-backed store for the `subscription` derived-state cache.
 *
 * `upsert` overwrites every derived column, so a stale cache is never served as
 * truth (spec § Derived values refresh each cycle).
 */
@Injectable()
export class SubscriptionRepository {
  constructor(
    @InjectRepository(Subscription)
    private readonly repo: Repository<Subscription>,
  ) {}

  async upsert(row: SubscriptionUpsert): Promise<Subscription> {
    const entity = this.repo.create({
      stateCategory: row.stateCategory,
      stateOutpoint: row.stateOutpoint,
      escrowOutpoint: row.escrowOutpoint,
      assetType: row.assetType,
      fundsCategory: row.fundsCategory,
      mode: row.mode,
      // Canonical pkh case (lowercase) at the write boundary: the session issues
      // lowercase, so a mixed-case commitment must not be stored verbatim or
      // `findByParty` would silently hide the party's own subscriptions.
      supporterPkh: normalizePkh(row.supporterPkh),
      supporteePkh: normalizePkh(row.supporteePkh),
      servicePkh: normalizePkh(row.servicePkh),
      amount: row.amount.toString(),
      amountNext: row.amountNext.toString(),
      period: row.period,
      periodNext: row.periodNext,
      lastPeriodTime: row.lastPeriodTime,
      escrowBalance: row.escrowBalance.toString(),
      status: row.status,
      nextPaymentAt: row.nextPaymentAt,
      oraclePkHash: row.oraclePkHash ?? null,
      oraclePubkey: row.oraclePubkey ?? null,
      lastRate: row.lastRate ?? null,
    });
    await this.repo.save(entity);
    return entity;
  }
  async findById(stateCategory: string): Promise<Subscription | null> {
    return this.repo.findOne({ where: { stateCategory } });
  }

  /**
   * The subscription a party is a member of, by state category — or `null` when
   * the row is missing or the party is not one of its three pkhs. Case-insensitive
   * (both sides normalized), so a mixed-case commitment cannot hide a party.
   */
  async findByIdForParty(stateCategory: string, pkh: string): Promise<Subscription | null> {
    const row = await this.findById(stateCategory);
    if (row === null) return null;
    const key = normalizePkh(pkh);
    const parties = [row.supporterPkh, row.supporteePkh, row.servicePkh].map(normalizePkh);
    return parties.includes(key) ? row : null;
  }

  async findAll(): Promise<Subscription[]> {
    return this.repo.find();
  }

  /**
   * Every subscription the pkh is a party to (supporter, supportee or service).
   * Reads are scoped to the caller: a pkh only sees its own rows (spec § API for
   * web app — reads scoped to the caller).
   */
  async findByParty(pkh: string): Promise<Subscription[]> {
    const key = normalizePkh(pkh);
    return this.repo.find({
      where: [{ supporterPkh: key }, { supporteePkh: key }, { servicePkh: key }],
      order: { createdAt: 'DESC' },
    });
  }
}

/** Canonical pkh form (lowercase hex) — the single convention for store + query. */
export function normalizePkh(pkh: string): string {
  return pkh.toLowerCase();
}
