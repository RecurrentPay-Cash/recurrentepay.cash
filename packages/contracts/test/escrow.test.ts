/**
 * Spec: subscription-contract/spec.md — "Escrow identity (co-created outpoint)".
 *
 * Covers task 4.2. The escrow is the funds-category input co-created with the
 * state NFT (same `outpointTransactionHash`). Every function requires it.
 */
import { MODE_B, SEED, encodeCommitment, scenario, type Scenario } from './helpers/harness.js';
import { requireError } from './helpers/expect.js';

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

describe('escrow identity (co-created outpoint)', () => {
  it('rejects a pull that omits the escrow input', async () => {
    const sub = base();
    sub.advance(DAY);
    // Only the state UTXO is spent: the escrow is missing.
    const tx = sub.base(() => sub.unlock()['pull']!());
    const { message } = await requireError(tx);
    expect(message).toMatch(/escrow: missing co-created escrow input|Implicit burning/);
  });

  it('rejects a fund that omits the escrow input', async () => {
    const sub = base();
    const tx = sub.base(() => sub.unlock()['fund']!());
    const { message } = await requireError(tx);
    expect(message).toMatch(/escrow: missing co-created escrow input|Implicit burning/);
  });

  it('rejects a modify that omits the escrow input', async () => {
    const sub = base();
    const tx = sub.base(() => sub.unlock()['modify']!(20n, BigInt(DAY)));
    const { message } = await requireError(tx);
    expect(message).toMatch(/escrow: missing co-created escrow input|Implicit burning/);
  });

  it('rejects a setPkh that omits the escrow input', async () => {
    const sub = base();
    const newSupporter = Uint8Array.from(new Array(20).fill(0xab));
    const tx = sub.base(() =>
      sub.unlock()['setPkh']!(newSupporter, sub.state.supporteePkh, sub.state.servicePkh),
    );
    const { message } = await requireError(tx);
    expect(message).toMatch(/escrow: missing co-created escrow input|Implicit burning/);
  });

  it('rejects a withdraw that omits the escrow input', async () => {
    const sub = base();
    const tx = sub.base(() => sub.unlock()['withdraw']!());
    const { message } = await requireError(tx);
    expect(message).toMatch(/escrow: missing co-created escrow input|Implicit burning/);
  });

  it('rejects a reactivate that omits the escrow input', async () => {
    const sub = base({ escrow: SEED });
    sub.advance(2 * DAY);
    const tx = sub.base(() => sub.unlock()['reactivate']!());
    const { message } = await requireError(tx);
    expect(message).toMatch(/escrow: missing co-created escrow input|Implicit burning/);
  });

  it('rejects a cancel that omits the escrow input', async () => {
    const sub = base();
    sub.advance(DAY);
    const tx = sub.base(() => sub.unlock()['cancel']!());
    const { message } = await requireError(tx);
    expect(message).toMatch(/escrow: missing co-created escrow input|Implicit burning/);
  });

  it('rejects a migrate that omits the escrow input', async () => {
    const sub = base();
    sub.advance(DAY);
    const tx = sub.base(() => sub.unlock()['migrate']!(randomHex32(), 10n, 10n));
    const { message } = await requireError(tx);
    expect(message).toMatch(/escrow: missing co-created escrow input|Implicit burning/);
  });

  it('rejects a stray funds UTXO offered *as* the escrow (different txid)', async () => {
    // The state NFT is present, but the only funds-category input is a stray
    // (different txid). The co-creation check must reject it.
    const sub = base();
    sub.advance(DAY);
    const stray = sub.stray(100n);
    const tx = sub.base(() => sub.unlock()['pull']!());
    tx.addInput(stray, sub.supporter.template.unlockP2PKH());
    tx.addOutput(sub.paymentOutput(sub.supportee, sub.fundsCategoryDisplay, 0n));
    tx.addOutput(sub.paymentOutput(sub.service, sub.fundsCategoryDisplay, 0n));
    tx.addOutput(sub.stateOutput(encodeCommitment(sub.state)));
    tx.addOutput(sub.fundsOutput(sub.fundsCategoryDisplay, SEED));
    const { message } = await requireError(sub.pay(tx, sub.supporter));
    expect(message).toMatch(/escrow: missing co-created escrow input|Implicit burning/);
  });

  it('rejects a co-created escrow locked to a different script', async () => {
    // The escrow shares the state NFT's txid (co-created) but is locked to the
    // supporter's P2PKH instead of the covenant. The covenant-lock check must
    // reject it, so a creation whose escrow is locked elsewhere is unusable.
    const sub = base();
    sub.advance(DAY);
    const elsewhere = sub.coCreatedEscrowElsewhere(101n);
    const tx = sub.base(() => sub.unlock()['pull']!());
    tx.addInput(elsewhere, sub.supporter.template.unlockP2PKH());
    tx.addOutput(sub.paymentOutput(sub.supportee, sub.fundsCategoryDisplay, 0n));
    tx.addOutput(sub.paymentOutput(sub.service, sub.fundsCategoryDisplay, 0n));
    tx.addOutput(sub.stateOutput(encodeCommitment(sub.state)));
    tx.addOutput(sub.fundsOutput(sub.fundsCategoryDisplay, SEED));
    const { message } = await requireError(sub.pay(tx, sub.supporter));
    expect(message).toMatch(/escrow: input not owned by the covenant|Implicit burning/);
  });
});

const randomHex32 = (): string => {
  let out = '';
  while (out.length < 64) out += Math.random().toString(16).slice(2);
  return out.slice(0, 64);
};
