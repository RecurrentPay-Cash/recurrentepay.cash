import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  MutualConsentProposal,
  type ProposalKind,
  type ProposalStatus,
  type ProposedTerms,
} from '../db/mutual-consent-proposal.entity.js';

/** The fields a `propose` writes to the proposal log. */
export interface ProposalInsert {
  subscriptionId: string;
  initiatorAccountId: number;
  counterpartyAccountId: number;
  kind: ProposalKind;
  proposedTerms: ProposedTerms;
  createdAt: number;
  expiresAt: number;
}

/**
 * Postgres-backed store for mutual-consent proposals (spec § Postgres schema —
 * `mutual_consent_proposal`, § Mutual-consent relay).
 *
 * Stores the **proposal**, never raw signed bytes: the relay rebuilds the tx at
 * signing time against the live outpoints, so a pre-signed tx (invalidated by any
 * intervening spend) is never held. The row is the state machine
 * pending → signed → broadcast | expired | revoked | void.
 */
@Injectable()
export class MutualConsentProposalRepository {
  constructor(
    @InjectRepository(MutualConsentProposal)
    private readonly repo: Repository<MutualConsentProposal>,
  ) {}

  async insert(row: ProposalInsert): Promise<MutualConsentProposal> {
    return this.repo.save(
      this.repo.create({
        subscriptionId: row.subscriptionId,
        initiatorAccountId: row.initiatorAccountId,
        counterpartyAccountId: row.counterpartyAccountId,
        kind: row.kind,
        proposedTerms: row.proposedTerms,
        status: 'pending',
        txid: null,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      }),
    );
  }

  async findById(id: number): Promise<MutualConsentProposal | null> {
    return this.repo.findOne({ where: { id } });
  }

  /** Proposals for a subscription, newest first. */
  async findBySubscription(subscriptionId: string): Promise<MutualConsentProposal[]> {
    return this.repo.find({ where: { subscriptionId }, order: { id: 'DESC' } });
  }

  /** Every pending proposal (the expiry scan). */
  async findPending(): Promise<MutualConsentProposal[]> {
    return this.repo.find({ where: { status: 'pending' } });
  }

  /** Set the proposal's status (optionally recording the broadcast txid). */
  async setStatus(
    id: number,
    status: ProposalStatus,
    txid: string | null = null,
  ): Promise<void> {
    await this.repo.update({ id }, { status, txid });
  }
}
