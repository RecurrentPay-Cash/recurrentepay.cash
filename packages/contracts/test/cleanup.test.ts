/**
 * Spec: subscription-contract/spec.md — "Foreign-token cleanup and consolidation".
 *
 * Covers task 4.9. A token of any category other than the funds and state
 * categories may be routed to `supporterPkh` by any function; the state category
 * must never be routed out.
 */
import { MODE_B, SEED, encodeCommitment, scenario, randomCategory, toDisplayCategory, type Scenario } from './helpers/harness.js';
import { requireError, succeeds } from './helpers/expect.js';

const T = 1_764_000_000;
const DAY = 86_400;

const base = (over: Partial<Parameters<typeof scenario>[0]> = {}): Scenario =>
  scenario({
    mode: MODE_B,
    amount: 10n,
    period: DAY,
    escrow: 101n,
    creationTime: T,
    ...over,
  });

describe('foreign-token cleanup', () => {
  it('a mis-sent token is swept to the supporter by pull', async () => {
    const sub = base();
    sub.advance(DAY);
    const foreign = sub.foreignToken(sub.supporter, 5n);
    const foreignCategory = foreign.token!.category;
    const tx = sub.base(() => sub.unlock()['pull']!());
    tx.addInput(foreign, sub.supporter.template.unlockP2PKH());
    const s = sub.settlement();
    tx.addOutput(sub.paymentOutput(sub.supportee, sub.fundsCategoryDisplay, s.paid));
    tx.addOutput(sub.paymentOutput(sub.service, sub.fundsCategoryDisplay, s.fee));
    tx.addOutput(sub.stateOutput(encodeCommitment({ ...sub.state, ...promote(s) })));
    tx.addOutput(sub.fundsOutput(sub.fundsCategoryDisplay, sub.escrowAfter(s)));
    // The foreign token is routed to the supporter (the cleanup output).
    tx.addOutput(sub.foreignOutput(sub.supporter, foreignCategory, 5n));
    expect(await succeeds(sub.pay(tx, sub.service))).toBe(true);
    expect(await sub.readRoleTokens(sub.supporter, foreignCategory)).toBe(5n);
  });

  it('a mis-sent token is swept to the supporter by fund', async () => {
    const sub = base();
    const foreign = sub.foreignToken(sub.supporter, 7n);
    const foreignCategory = foreign.token!.category;
    const tx = sub.base(() => sub.unlock()['fund']!());
    tx.addInput(foreign, sub.supporter.template.unlockP2PKH());
    tx.addOutput(sub.stateOutput(encodeCommitment(sub.state)));
    tx.addOutput(sub.fundsOutput(sub.fundsCategoryDisplay, sub.currentEscrow));
    tx.addOutput(sub.foreignOutput(sub.supporter, foreignCategory, 7n));
    expect(await succeeds(sub.pay(tx, sub.supporter))).toBe(true);
    expect(await sub.readRoleTokens(sub.supporter, foreignCategory)).toBe(7n);
  });

  it('a mis-sent token is swept to the supporter by cancel', async () => {
    const sub = base();
    sub.advance(DAY);
    const foreign = sub.foreignToken(sub.supporter, 3n);
    const foreignCategory = foreign.token!.category;
    const tx = sub.base(() => sub.unlock()['cancel']!());
    tx.addInput(foreign, sub.supporter.template.unlockP2PKH());
    const s = sub.settlement();
    tx.addOutput(sub.paymentOutput(sub.supportee, sub.fundsCategoryDisplay, s.paid));
    tx.addOutput(sub.paymentOutput(sub.service, sub.fundsCategoryDisplay, s.fee));
    tx.addOutput(sub.paymentOutput(sub.supporter, sub.fundsCategoryDisplay, sub.currentEscrow - s.gross));
    tx.addOutput(sub.foreignOutput(sub.supporter, foreignCategory, 3n));
    expect(await succeeds(sub.pay(tx, sub.service))).toBe(true);
    expect(await sub.readRoleTokens(sub.supporter, foreignCategory)).toBe(3n);
  });

  it('the state NFT cannot be routed out through the cleanup path', async () => {
    const sub = base();
    sub.advance(DAY);
    const tx = sub.base(() => sub.unlock()['pull']!());
    const s = sub.settlement();
    tx.addOutput(sub.paymentOutput(sub.supportee, sub.fundsCategoryDisplay, s.paid));
    tx.addOutput(sub.paymentOutput(sub.service, sub.fundsCategoryDisplay, s.fee));
    tx.addOutput(sub.stateOutput(encodeCommitment({ ...sub.state, ...promote(s) })));
    tx.addOutput(sub.fundsOutput(sub.fundsCategoryDisplay, sub.escrowAfter(s)));
    // Attempt to route a state-category token to the supporter: rejected.
    tx.addOutput({
      to: sub.supporter.lock,
      amount: sub.covenantSats,
      token: { category: sub.stateCategoryDisplay, amount: 0n, nft: { capability: 'none', commitment: '' } },
    });
    const { message } = await requireError(sub.pay(tx, sub.service));
    expect(message).toMatch(/tail: state category must not be routed out|Implicit|state/);
  });

  it('a funds-category token cannot appear in the tail', async () => {
    const sub = base();
    sub.advance(DAY);
    const tx = sub.base(() => sub.unlock()['pull']!());
    const s = sub.settlement();
    tx.addOutput(sub.paymentOutput(sub.supportee, sub.fundsCategoryDisplay, s.paid));
    tx.addOutput(sub.paymentOutput(sub.service, sub.fundsCategoryDisplay, s.fee));
    tx.addOutput(sub.stateOutput(encodeCommitment({ ...sub.state, ...promote(s) })));
    tx.addOutput(sub.fundsOutput(sub.fundsCategoryDisplay, sub.escrowAfter(s)));
    // A funds-category token in the tail is rejected (it would leak escrow).
    tx.addOutput(sub.paymentOutput(sub.supporter, sub.fundsCategoryDisplay, 1n));
    const { message } = await requireError(sub.pay(tx, sub.service));
    expect(message).toMatch(/tail: funds category must not be in the tail|Implicit/);
  });
});

const promote = (s: { newAmount: bigint; newPeriod: number; newLastPeriodTime: number }) => ({
  amount: s.newAmount,
  period: s.newPeriod,
  lastPeriodTime: s.newLastPeriodTime,
});
