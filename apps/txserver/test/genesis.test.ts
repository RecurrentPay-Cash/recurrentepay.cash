/**
 * Genesis validation on discovery (task 8.11, spec § Genesis validation on discovery).
 *
 * The creation invariants (one `mutable` state NFT, no `minting` NFT of the
 * category, escrow ≥ `amount + seed`, escrow locked to the covenant script) are
 * builder invariants the contract cannot check — creation is not a covenant
 * spend. The txserver verifies them on the genesis transaction before tracking a
 * subscription, and this stays even after the factory ships (its guarantee is
 * per-path).
 */
import { covenantLockingBytecode, encodeCommitment, type SubscriptionState } from 'shared';
import artifact from 'contracts/artifacts/token-subscription.artifact.js';
import {
  FOREIGN_CAT,
  FUNDS_CAT,
  STATE_CAT,
  makeState,
  reverseCategory,
} from './fixtures.js';
import { buildGenesisTx, type GenesisSpec } from './genesis-fixtures.js';
import { validateGenesis } from '../src/discovery/genesis-validation.js';

/**
 * The genesis tx carries categories in **internal** order (raw libauth bytes), so
 * the fixtures pass the internal form. `STATE_CAT`/`FUNDS_CAT` are display order;
 * reverse them to build the raw tx.
 */
const STATE_CAT_INTERNAL = reverseCategory(STATE_CAT);
const FUNDS_CAT_INTERNAL = reverseCategory(FUNDS_CAT);
/** The covenant address is `f(stateCategory)` — the real P2SH32 lock. */
const COVENANT_LOCK = covenantLockingBytecode(STATE_CAT_INTERNAL, artifact.bytecode);
/** The artifact bytecode, for the anchoring check. */
const COVENANT_BYTECODE = artifact.bytecode;

/** A canonical creation: one `mutable` state NFT + escrow ≥ amount + seed. */
function canonical(over: Partial<GenesisSpec> = {}): GenesisSpec {
  const state = makeState();
  return {
    stateCategory: STATE_CAT_INTERNAL,
    fundsCategory: FUNDS_CAT_INTERNAL,
    stateLockingBytecode: COVENANT_LOCK,
    escrowLockingBytecode: COVENANT_LOCK,
    escrowAmount: state.amount + 1n, // amount + seed
    stateCommitment: encodeCommitment(state),
    stateCapability: 'mutable',
    ...over,
  };
}

describe('validateGenesis', () => {
  it('accepts a canonical creation', () => {
    const tx = buildGenesisTx(canonical());
    const result = validateGenesis(tx, { stateCategory: STATE_CAT, covenantBytecode: COVENANT_BYTECODE });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.escrowAmount).toBe(11n);
      expect(result.stateOutputIndex).toBeGreaterThanOrEqual(0);
      expect(result.escrowOutputIndex).toBeGreaterThanOrEqual(0);
    }
  });

  it('rejects a genesis that minted a `minting` NFT of the state category', () => {
    // A minting NFT would let its holder mint further NFTs of the category,
    // breaking the single-state-UTXO identity guarantee.
    const tx = buildGenesisTx(
      canonical({
        stateCapability: 'mutable',
        extraOutputs: [
          {
            lockingBytecode: COVENANT_LOCK,
            valueSatoshis: 1000n,
            token: {
              category: STATE_CAT_INTERNAL,
              amount: 0n,
              nft: { capability: 'minting', commitment: new Uint8Array(0) },
            },
          },
        ],
      }),
    );
    const result = validateGenesis(tx, { stateCategory: STATE_CAT, covenantBytecode: COVENANT_BYTECODE });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/minting/i);
  });

  it('rejects a genesis with more than one state NFT of the category', () => {
    const state = makeState();
    const tx = buildGenesisTx(
      canonical({
        extraOutputs: [
          {
            lockingBytecode: COVENANT_LOCK,
            valueSatoshis: 1000n,
            token: {
              category: STATE_CAT_INTERNAL,
              amount: 0n,
              nft: { capability: 'mutable', commitment: encodeCommitment(state) },
            },
          },
        ],
      }),
    );
    const result = validateGenesis(tx, { stateCategory: STATE_CAT, covenantBytecode: COVENANT_BYTECODE });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/exactly one|one state/i);
  });

  it('rejects a genesis whose state NFT is not `mutable`', () => {
    const tx = buildGenesisTx(canonical({ stateCapability: 'none' }));
    const result = validateGenesis(tx, { stateCategory: STATE_CAT, covenantBytecode: COVENANT_BYTECODE });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/mutable/i);
  });

  it('rejects an underfunded creation (escrow only the seed)', () => {
    const tx = buildGenesisTx(canonical({ escrowAmount: 1n })); // seed only
    const result = validateGenesis(tx, { stateCategory: STATE_CAT, covenantBytecode: COVENANT_BYTECODE });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/amount \+ seed|underfunded|minimum/i);
  });

  it('rejects an escrow locked to a script other than the covenant script', () => {
    const elsewhere = '76a914' + '99'.repeat(20) + '88ac';
    const tx = buildGenesisTx(canonical({ escrowLockingBytecode: elsewhere }));
    const result = validateGenesis(tx, { stateCategory: STATE_CAT, covenantBytecode: COVENANT_BYTECODE });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/covenant|script/i);
  });

  it('rejects a genesis whose state NFT is not locked to f(stateCategory)', () => {
    // The covenant address is derived from the state category. A genesis whose
    // state NFT (and escrow) are both locked to an attacker-controlled script
    // must be rejected — otherwise the txserver would watch a bogus address.
    const attackerLock = '76a914' + '99'.repeat(20) + '88ac';
    const tx = buildGenesisTx(
      canonical({ stateLockingBytecode: attackerLock, escrowLockingBytecode: attackerLock }),
    );
    const result = validateGenesis(tx, { stateCategory: STATE_CAT, covenantBytecode: COVENANT_BYTECODE });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/f\(stateCategory\)|covenant/i);
  });

  it('rejects a genesis with no escrow output at all', () => {
    const tx = buildGenesisTx(canonical({ omitEscrow: true }));
    const result = validateGenesis(tx, { stateCategory: STATE_CAT, covenantBytecode: COVENANT_BYTECODE });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/escrow/i);
  });

  it('rejects a genesis whose state commitment does not parse', () => {
    const tx = buildGenesisTx(canonical({ stateCommitment: new Uint8Array(3) }));
    const result = validateGenesis(tx, { stateCategory: STATE_CAT, covenantBytecode: COVENANT_BYTECODE });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/commitment/i);
  });

  it('rejects a genesis with no state NFT of the category', () => {
    const tx = buildGenesisTx(canonical({ omitState: true }));
    const result = validateGenesis(tx, { stateCategory: STATE_CAT, covenantBytecode: COVENANT_BYTECODE });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/state/i);
  });

  // -- gap-fillers -----------------------------------------------------------

  it('checks the state category BEFORE the escrow: an underfunded escrow is not misreported as missing', () => {
    // Guards the documented check order (minting → single state → mutable →
    // commitment → escrow lock → funding). If the escrow scan ran first, a
    // canonical pair with a short escrow would be rejected as "no escrow locked
    // to the covenant script" — indistinguishable from the non-covenant case to
    // a caller that only inspects the reason.
    const tx = buildGenesisTx(canonical({ escrowAmount: 1n })); // seed only
    const result = validateGenesis(tx, { stateCategory: STATE_CAT, covenantBytecode: COVENANT_BYTECODE });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/underfunded|amount \+ seed|minimum/i);
      expect(result.reason).not.toMatch(/no escrow/i);
    }
  });

  it('rejects a genesis with a non-`minting` extra NFT of the category (counts as a second state NFT)', () => {
    // Two state NFTs of the category — even a `none`-capability one — break the
    // single-state-UTXO identity guarantee, exactly like a duplicate `mutable`.
    const state = makeState();
    const tx = buildGenesisTx(
      canonical({
        extraOutputs: [
          {
            lockingBytecode: COVENANT_LOCK,
            valueSatoshis: 1000n,
            token: {
              category: STATE_CAT_INTERNAL,
              amount: 0n,
              nft: { capability: 'none', commitment: encodeCommitment(state) },
            },
          },
        ],
      }),
    );
    const result = validateGenesis(tx, { stateCategory: STATE_CAT, covenantBytecode: COVENANT_BYTECODE });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/exactly one|one state/i);
  });

  it('rejects a genesis whose escrow carries the wrong category (a foreign token cannot fund the sub)', () => {
    // The escrow is identified by `fundsCategory` from the commitment. A token
    // of another category locked to the covenant is not the escrow, so the sub
    // is unusable.
    const tx = buildGenesisTx(canonical({ fundsCategory: reverseCategory(FOREIGN_CAT) }));
    const result = validateGenesis(tx, { stateCategory: STATE_CAT, covenantBytecode: COVENANT_BYTECODE });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/escrow/i);
  });

  it('matches the state category across internal↔display order (asymmetric category)', () => {
    // Regression guard for the byte-order blocker: the genesis tx carries the
    // category in internal order, the caller passes it in display order. A
    // uniform-byte fixture cannot catch a wrong order; `STATE_CAT` is asymmetric.
    const tx = buildGenesisTx(canonical());
    // Display order (what the caller/explorer uses) is accepted.
    expect(validateGenesis(tx, { stateCategory: STATE_CAT, covenantBytecode: COVENANT_BYTECODE }).ok).toBe(true);
    // The reversed (internal) form must NOT match — proving the order matters.
    expect(validateGenesis(tx, { stateCategory: STATE_CAT_INTERNAL, covenantBytecode: COVENANT_BYTECODE }).ok).toBe(false);
  });

  it('rejects a genesis with no state-nft output when a fungible token of the category is present', () => {
    // A category match without an NFT is not a state output; the escrow scan
    // must not treat it as one, and the state check must fail.
    const tx = buildGenesisTx(
      canonical({
        omitState: true,
        extraOutputs: [
          {
            lockingBytecode: COVENANT_LOCK,
            valueSatoshis: 1000n,
            token: { category: STATE_CAT_INTERNAL, amount: 1n },
          },
        ],
      }),
    );
    const result = validateGenesis(tx, { stateCategory: STATE_CAT, covenantBytecode: COVENANT_BYTECODE });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/state/i);
  });
});

describe('validateGenesis — amount + seed boundary', () => {
  it('accepts exactly amount + seed', () => {
    const state: SubscriptionState = makeState({ amount: 10n });
    const tx = buildGenesisTx(
      canonical({ stateCommitment: encodeCommitment(state), escrowAmount: 11n }),
    );
    expect(validateGenesis(tx, { stateCategory: STATE_CAT, covenantBytecode: COVENANT_BYTECODE }).ok).toBe(true);
  });

  it('rejects one unit below amount + seed', () => {
    const state: SubscriptionState = makeState({ amount: 10n });
    const tx = buildGenesisTx(
      canonical({ stateCommitment: encodeCommitment(state), escrowAmount: 10n }),
    );
    const result = validateGenesis(tx, { stateCategory: STATE_CAT, covenantBytecode: COVENANT_BYTECODE });
    expect(result.ok).toBe(false);
  });

  it('uses the commitment amount, not a caller-supplied one', () => {
    // The commitment says amount = 10; the escrow holds 11 → valid, even though
    // the caller passed nothing. Guards against trusting an off-chain amount.
    const tx = buildGenesisTx(canonical({ escrowAmount: 11n }));
    const result = validateGenesis(tx, { stateCategory: STATE_CAT, covenantBytecode: COVENANT_BYTECODE });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.state.amount).toBe(10n);
  });
});
