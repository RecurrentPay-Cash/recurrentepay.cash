import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Account } from '../db/account.entity.js';

/**
 * Store for creator accounts (spec § Postgres schema — `account`).
 *
 * MVP: one channel per creator, so the account is created lazily the first time
 * a creator touches the channel API. The account's **identity is the creator
 * pkh** (unique column) — resolving by pkh (create-on-miss) is idempotent and
 * collision-free, unlike the earlier lossy hash-derived id.
 */
@Injectable()
export class AccountRepository {
  constructor(
    @InjectRepository(Account)
    private readonly repo: Repository<Account>,
  ) {}

  /** The account for `id`, or `null`. */
  async findById(id: number): Promise<Account | null> {
    return this.repo.findOne({ where: { id } });
  }

  /** The account for a creator pkh (normalized lowercase), or `null`. */
  async findByPkh(pkh: string): Promise<Account | null> {
    return this.repo.findOne({ where: { pkh: normalizePkh(pkh) } });
  }

  /**
   * Resolve the account for a pkh, creating it on first use. Idempotent: the
   * pkh is unique, so a concurrent create loses the unique race and the
   * existing row is returned.
   */
  async findOrCreateByPkh(pkh: string): Promise<Account> {
    const normalized = normalizePkh(pkh);
    const existing = await this.findByPkh(normalized);
    if (existing !== null) return existing;
    try {
      return await this.repo.save(this.repo.create({ pkh: normalized }));
    } catch {
      // Lost the unique race — another request created it first.
      const raced = await this.findByPkh(normalized);
      if (raced === null) throw new Error(`account create failed for pkh ${normalized}`);
      return raced;
    }
  }
}

/** Canonical pkh form (lowercase hex) — the single convention for store + query. */
export function normalizePkh(pkh: string): string {
  return pkh.toLowerCase();
}
