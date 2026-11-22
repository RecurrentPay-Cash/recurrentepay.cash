/**
 * Spec: subscription-contract/spec.md — "Foreign-token cleanup and consolidation".
 *
 * Covers `tailOk`'s non-empty-category path on the oracle contract: a token of
 * any category other than the state category may be routed to `supporterPkh` by
 * any covenant function; the state category must never be routed out.
 */
import {
  MODE_B,
  encodeCommitment,
  promote,
  scenario,
  type Scenario,
} from './helpers/oracle-harness.js';
import { requireError, succeeds } from './helpers/expect.js';

const T = 1_764_000_000;
const DAY = 86_400;
const PRICE = 50_000n;
const GPP = 2_000_000n;

const base = (over: Partial<Parameters<typeof scenario>[0]> = {}): Scenario =>
  scenario({
    mode: MODE_B,
    amount: 1000n,
    period: DAY,
    balance: 5_000_000n,
    creationTime: T,
    lastRate: Number(PRICE),
    ...over,
  });

describe('foreign-token cleanup (oracle)', () => {
  it('a mis-sent token is swept to the supporter by pull', async () => {
    const sub = base();
    sub.advance(DAY);
    const foreign = sub.foreignToken(sub.supporter, 5n);
    const foreignCategory = foreign.token!.category;
    const s = sub.settlement(PRICE);
    const args = sub.oracleArgs({ price: Number(PRICE) });
    const tx = sub.base(() => sub.unlock()['pull']!(args.sig, args.message, args.pubkey));
    tx.addInput(foreign, sub.supporter.template.unlockP2PKH());
    tx.addOutput(sub.plainOutput(sub.supportee, s.paid));
    tx.addOutput(sub.plainOutput(sub.service, s.fee));
    tx.addOutput(sub.stateOutput(encodeCommitment({ ...sub.state, ...promote(s), lastRate: s.newLastRate }), sub.balanceAfter(s)));
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
    // A plain supporter input funds the top-up and pays the fee; the foreign
    // token UTXO is only the cleanup source.
    tx.addInput(sub.input(sub.supporter, 1_000_000n), sub.supporter.template.unlockP2PKH());
    tx.addOutput(sub.stateOutput(encodeCommitment(sub.state), sub.currentBalance + 1_000_000n - 5000n));
    tx.addOutput(sub.foreignOutput(sub.supporter, foreignCategory, 7n));
    expect(await succeeds(tx.addBchChangeOutputIfNeeded({ to: sub.supporter.lock, feeRate: 1 }))).toBe(true);
    expect(await sub.readRoleTokens(sub.supporter, foreignCategory)).toBe(7n);
  });

  it('a mis-sent token is swept to the supporter by cancel', async () => {
    const sub = base();
    sub.advance(DAY);
    const foreign = sub.foreignToken(sub.supporter, 3n);
    const foreignCategory = foreign.token!.category;
    const s = sub.settlement(PRICE);
    const tx = sub.base(() => sub.unlock()['cancel']!());
    tx.addInput(foreign, sub.supporter.template.unlockP2PKH());
    tx.addOutput(sub.plainOutput(sub.supportee, s.paid));
    tx.addOutput(sub.plainOutput(sub.service, s.fee));
    tx.addOutput(sub.plainOutput(sub.supporter, sub.currentBalance - s.gross));
    tx.addOutput(sub.foreignOutput(sub.supporter, foreignCategory, 3n));
    expect(await succeeds(sub.pay(tx, sub.service))).toBe(true);
    expect(await sub.readRoleTokens(sub.supporter, foreignCategory)).toBe(3n);
  });

  it('the state NFT cannot be routed out through the cleanup path', async () => {
    const sub = base();
    sub.advance(DAY);
    const s = sub.settlement(PRICE);
    const args = sub.oracleArgs({ price: Number(PRICE) });
    const tx = sub.base(() => sub.unlock()['pull']!(args.sig, args.message, args.pubkey));
    tx.addOutput(sub.plainOutput(sub.supportee, s.paid));
    tx.addOutput(sub.plainOutput(sub.service, s.fee));
    tx.addOutput(sub.stateOutput(encodeCommitment({ ...sub.state, ...promote(s), lastRate: s.newLastRate }), sub.balanceAfter(s)));
    // Attempt to route a state-category token to the supporter: rejected.
    tx.addOutput({
      to: sub.supporter.lock,
      amount: sub.covenantSats,
      token: { category: sub.stateCategoryDisplay, amount: 0n, nft: { capability: 'none', commitment: '' } },
    });
    const { message } = await requireError(sub.pay(tx, sub.service));
    expect(message).toMatch(/tail: state category must not be routed out|Implicit|state/);
  });
});
