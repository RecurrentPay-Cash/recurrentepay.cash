/**
 * Mutual-consent tx builder (Slice 7, spec § Mutual-consent relay).
 *
 * Builds the `modify` and `migrate` transactions. Both require **both parties
 * present in one transaction** (`isPresent(supporterPkh) && isPresent(supporteePkh)`),
 * so the tx carries:
 *
 *   - the covenant's state NFT + co-created escrow inputs;
 *   - the **initiator's** presence input (P2PKH) — the initiator pays the fee and
 *     receives the BCH change (spec § Mutual-consent relay — fee payer: initiator);
 *   - the **counterparty's** presence input (P2PKH), assembled at sign time.
 *
 * Output layout (contract `modify`/`migrate`):
 *   modify:  0 state, 1 funds (totalIn)
 *   migrate: [0 supportee, 1 service] if gross > 0, state, funds(new), old remainder
 *
 * **Rebuild, never replay.** The builder reads the covenant's UTXOs from the
 * provider on every call — the same rule as the scheduled cancel. A proposal
 * stores terms, not bytes; the tx is assembled against the *current* outpoints at
 * signing time, so an intervening covenant spend (or a `setPkh`) is picked up.
 *
 * Each party's presence input is modelled as a P2PKH UTXO supplied via the API
 * (`CounterpartyInput`: outpoint + satoshis + P2PKH lock). The covenant's
 * `isPresent` only reads the input's **locking bytecode**, so the relay assembles
 * a **correctly-sized unsigned placeholder** P2PKH input (107 B) — no signature is
 * required by the contract. **The relay never accepts or holds a private key**: the
 * relay returns the unsigned template plus `signableInputs`, and the party signs
 * the presence inputs client-side before the relay broadcasts.
 */
import {
  Contract,
  TransactionBuilder,
  type NetworkProvider,
  type Output,
  type SpendableUtxo,
  type Unlocker,
} from 'cashscript';
import { binToHex, hexToBin, lockingBytecodeToCashAddress, sha256 } from '@bitauth/libauth';
import tokenArtifact from 'contracts/artifacts/token-subscription.artifact.js';
import oracleArtifact from 'contracts/artifacts/oracle-subscription.artifact.js';
import {
  decodeCommitment,
  encodeCommitment,
  oracle,
  settle,
  toInternalCategory,
  SEED,
  type SubscriptionState,
} from 'shared';
import type { Subscription } from '../db/subscription.entity.js';
import type { ProposedTerms } from '../db/mutual-consent-proposal.entity.js';

/** Satoshis parked on each covenant UTXO (token dust limit is 1000). */
const COVENANT_SATS = 20_000n;

/**
 * A party presence input supplied by the API (a P2PKH UTXO they control).
 *
 * **No private key.** The relay never accepts signing material: the covenant's
 * `isPresent` only reads the locking bytecode, so the relay assembles an unsigned
 * placeholder presence input. The party signs client-side in production.
 */
export interface CounterpartyInput {
  /** Outpoint txid (display order, 64 hex chars). */
  txid: string;
  /** Output index. */
  vout: number;
  /** Satoshis carried by the output. */
  satoshis: bigint;
  /** The party's P2PKH locking bytecode hex (`76a914…88ac`). */
  lockingBytecode: string;
}

/**
 * A new-asset funding input for `migrate` (a token UTXO of the new funds
 * category the caller contributes). The contract's `newEscrow = totalIn(newFundsCategory)`
 * is the sum of these inputs' amounts, so the tx must carry at least one — a token
 * output with no matching input is an implicit mint the VM rejects.
 */
export interface NewAssetInput {
  /** Outpoint txid (display order, 64 hex chars). */
  txid: string;
  /** Output index. */
  vout: number;
  /** Satoshis carried by the output. */
  satoshis: bigint;
  /** The funding UTXO's P2PKH locking bytecode hex (`76a914…88ac`). */
  lockingBytecode: string;
  /** The new funds category (hex, **display** order — the form the provider stores). */
  category: string;
  /** The amount of the new category carried by the output. */
  amount: bigint;
}

export interface BuildMutualOptions {
  /** Unix seconds "now" — becomes the tx nLockTime. */
  now: number;
  /** The initiator's presence UTXO (pays the fee, receives change). */
  initiatorInput: CounterpartyInput;
  /** The counterparty's presence UTXO (assembled at sign time). */
  counterpartyInput: CounterpartyInput;
  /** `migrate` only: the new-category token UTXO(s) the caller funds the swap with. */
  newAssetInputs?: NewAssetInput[];
  /** Fee rate in sats/byte for the BCH change output (default 1). */
  feeRate?: number;
}

/** A presence/funding input the client must sign (P2PKH). */
export interface SignableInput {
  /** The input's index in the built tx. */
  index: number;
  /** The input's P2PKH locking bytecode (hex) — the client's key selector. */
  lockingBytecode: string;
  /** The input's satoshis (decimal string; the signing serialization's value). */
  satoshis: string;
  /**
   * The input's P2PKH CashAddress (chipnet prefix). The server knows only the
   * address, not the wallet's HD index, so the dapp maps it to an
   * `inputPaths: [[index, "receive", addressIndex]]` entry itself.
   */
  address: string;
  /**
   * The input's token (category hex display order + amount), when it carries one.
   * A `migrate` funding input does; the signing serialization commits to it.
   */
  token?: { category: string; amount: string };
}

/**
 * A source output as WizardConnect's `signTransaction` expects it (positional,
 * one per tx input in tx order). `unlockingBytecode` is empty: the wallet ignores
 * it for signing and fills the real unlock script itself.
 */
export interface SourceOutput {
  /** Outpoint txid (display order, 64 hex chars). */
  outpointTransactionHash: string;
  /** Output index within the previous transaction. */
  outpointIndex: number;
  /** Unlocking bytecode (empty for an unsigned source). */
  unlockingBytecode: string;
  /** Satoshis (decimal string). */
  valueSatoshis: string;
  /** Token contents, when the source carries one. */
  token?: {
    category: string;
    amount: string;
    nft?: { capability: 'none' | 'mutable' | 'minting'; commitment: string };
  };
}

/** The CashAddress prefix the txserver encodes for display (testnet/chipnet). */
const CASH_ADDRESS_PREFIX = 'bchtest';

/** Encode a P2PKH locking bytecode as a CashAddress, falling back to the raw hex. */
export function p2pkhAddress(lockingBytecode: string): string {
  const result = lockingBytecodeToCashAddress({
    bytecode: hexToBin(lockingBytecode),
    prefix: CASH_ADDRESS_PREFIX,
  });
  return typeof result === 'string' ? lockingBytecode : result.address;
}

/**
 * Map a builder's assembled inputs to the positional `sourceOutputs` array
 * WizardConnect needs (one entry per input, in tx order). The builder has each
 * input's outpoint + value + token; this is the only place that shape is derived.
 */
export function sourceOutputsOf(
  inputs: readonly { txid: string; vout: number; satoshis: bigint; token?: { category: string; amount: bigint; nft?: { capability: 'none' | 'mutable' | 'minting'; commitment: string } } }[],
): SourceOutput[] {
  return inputs.map((input) => ({
    outpointTransactionHash: input.txid,
    outpointIndex: input.vout,
    unlockingBytecode: '',
    valueSatoshis: input.satoshis.toString(),
    ...(input.token !== undefined && {
      token: {
        category: input.token.category,
        amount: input.token.amount.toString(),
        ...(input.token.nft !== undefined && { nft: input.token.nft }),
      },
    }),
  }));
}

export interface BuiltMutual {
  /**
   * The built tx hex. This carries correctly-sized **placeholder** P2PKH
   * unlockers — it is a template, **not valid to broadcast** until the client
   * signs the `signableInputs`.
   */
  hex: string;
  /** The txid the transaction will have once broadcast. */
  txid: string;
  /** The state written back on the state output. */
  nextState: SubscriptionState;
  /** The presence/funding inputs the client must sign (P2PKH). */
  signableInputs: SignableInput[];
  /** Positional source outputs (one per tx input, in tx order). */
  sourceOutputs: SourceOutput[];
}

/**
 * Build the signed `modify` transaction: both parties present, no settle, terms
 * always-replaced (`amountNext`/`periodNext` written; `amount`/`period` carried
 * through unchanged by the contract). The clock is untouched.
 */
export function buildModify(
  provider: NetworkProvider,
  sub: Subscription,
  terms: ProposedTerms,
  options: BuildMutualOptions,
): Promise<BuiltMutual> {
  const newAmountNext = requireAmount(terms.amountNext, 'amountNext');
  const newPeriodNext = requirePeriod(terms.periodNext, 'periodNext');
  return buildMutual(provider, sub, options, (state) => ({
    ...state,
    amountNext: newAmountNext,
    periodNext: newPeriodNext,
  }), 'modify', { newAmountNext, newPeriodNext });
}

/**
 * Build the signed `migrate` transaction: settle-then-swap the unearned remainder
 * into a new funds category. Both parties present.
 *
 * **Token path only.** The oracle contract's `migrate` (oracle-key swap) is
 * oracle-contract territory and is handled by `OracleActionsService`
 * (`buildOracleMigrate` / `executeOracleMigrateService`) — see
 * `MutualConsentService.propose` for the guard that refuses an oracle sub.
 */
export function buildMigrate(
  provider: NetworkProvider,
  sub: Subscription,
  terms: ProposedTerms,
  options: BuildMutualOptions,
): Promise<BuiltMutual> {
  const newFundsCategory = requireCategory(terms.newFundsCategory, 'newFundsCategory');
  const newAmount = requireAmount(terms.newAmount, 'newAmount');
  const newAmountNext = requireAmount(terms.newAmountNext, 'newAmountNext');
  return buildMutual(
    provider,
    sub,
    options,
    (state) => ({
      ...state,
      amount: newAmount,
      amountNext: newAmountNext,
      fundsCategory: hexToBin(toInternalCategory(newFundsCategory)),
    }),
    'migrate',
    { newFundsCategory, newAmount, newAmountNext },
  );
}

/**
 * Shared builder for `modify`/`migrate`.
 *
 * Reads the live covenant UTXOs, decodes the current commitment, computes the
 * next state, assembles the fixed output layout, and adds both parties' presence
 * inputs. The initiator's input pays the fee (it is added first after the
 * covenant inputs and it receives the BCH change).
 */
async function buildMutual(
  provider: NetworkProvider,
  sub: Subscription,
  options: BuildMutualOptions,
  nextStateOf: (state: SubscriptionState) => SubscriptionState,
  fn: 'modify' | 'migrate',
  args: Record<string, unknown>,
): Promise<BuiltMutual> {
  const now = options.now;
  const feeRate = options.feeRate ?? 1;
  const covenantAddress = sub.covenantAddress();

  // Oracle (BCH) subs are a single UTXO and use the oracle artifact. Only
  // `modify` is supported here (the oracle `modify(newAmountNext, newPeriodNext)`
  // signature matches the token one); `migrate` is an oracle-key swap handled by
  // `OracleActionsService.buildOracleMigrate` (refused upstream in
  // `MutualConsentService.propose`). Never build a token-script tx against an
  // oracle covenant.
  if (sub.assetType === 'oracle') {
    if (fn !== 'modify') {
      throw new Error(`${fn}: oracle subs use the oracle artifact (see OracleActionsService.buildOracleMigrate)`);
    }
    return buildOracleModify(provider, sub, options, nextStateOf);
  }

  const utxos = await provider.getUtxosForLockingBytecode(covenantAddress);
  const stateUtxo = utxos.find(
    (u) => u.token?.category === sub.stateCategory && u.token.nft !== undefined,
  );
  if (stateUtxo === undefined) throw new Error(`${fn}: no state UTXO for ${sub.stateCategory}`);

  const state = decodeCommitment(hexToBin(stateUtxo.token!.nft!.commitment));
  const escrowUtxo = utxos.find(
    (u) =>
      u.token?.category === sub.fundsCategory &&
      u.txid === stateUtxo.txid &&
      u.lockingBytecode === covenantAddress,
  );
  if (escrowUtxo === undefined) {
    throw new Error(`${fn}: no co-created escrow for ${sub.stateCategory}`);
  }

  const contract = new Contract(tokenArtifact, [toInternalCategory(sub.stateCategory)], {
    provider,
    contractType: 'p2sh32',
  });
  const unlock = contract.unlock as unknown as Record<string, (...a: unknown[]) => Unlocker>;

  const tx = new TransactionBuilder({ provider }).setLocktime(now);
  const unlockArgs =
    fn === 'modify'
      ? [args.newAmountNext, BigInt(args.newPeriodNext as number)]
      : [
          hexToBin(toInternalCategory(String(args.newFundsCategory))),
          args.newAmount,
          args.newAmountNext,
        ];
  tx.addInput(stateUtxo, unlock[fn]!(...unlockArgs));
  tx.addInput(escrowUtxo, unlock[fn]!(...unlockArgs));

  const covenantLock = hexToBin(contract.lockingBytecode);
  const fundsCategory = sub.fundsCategory;
  const nextState = nextStateOf(state);
  const signableInputs: SignableInput[] = [];

  const outputs: Output[] = [];
  if (fn === 'migrate') {
    // migrate: settle-then-swap. The settlement pays the supportee/service at
    // fixed indices 0/1 when gross > 0, then the state + new funds + old remainder.
    const escrow = escrowUtxo.token!.amount;
    const settlement = settle(state, escrow - SEED, now);
    if (settlement.gross > 0n) {
      outputs.push({
        to: p2pkhLock(state.supporteePkh),
        amount: COVENANT_SATS,
        token: { category: fundsCategory, amount: settlement.paid },
      });
      outputs.push({
        to: p2pkhLock(state.servicePkh),
        amount: COVENANT_SATS,
        token: { category: fundsCategory, amount: settlement.fee },
      });
    }
    // The new escrow is `totalIn(newFundsCategory)` — the sum of the caller's
    // new-category funding inputs. The contract requires `newEscrow ≥ carryOver + SEED`
    // (carryOver = the surviving `n − m` arrears + mode B's escrowed period, at the
    // new rate). The funding inputs are added below (they must be in the tx for the
    // VM to accept the new-category output — a token output with no matching input
    // is an implicit mint).
    const newFundsCategory = String(args.newFundsCategory);
    const newEscrowAmount = totalIn(options.newAssetInputs ?? [], newFundsCategory);
    if (newEscrowAmount <= 0n) {
      throw new Error('migrate: at least one new-asset funding input is required');
    }
    const carryOver =
      requireAmount(args.newAmount, 'newAmount') * (settlement.n - settlement.m + BigInt(state.mode));
    if (newEscrowAmount < carryOver + SEED) {
      throw new Error(
        `migrate: new escrow ${newEscrowAmount} is below the reserved amount ${carryOver + SEED}`,
      );
    }
    outputs.push({
      to: covenantLock,
      amount: COVENANT_SATS,
      token: {
        category: sub.stateCategory,
        amount: 0n,
        nft: { capability: 'mutable', commitment: binToHex(encodeCommitment(nextState)) },
      },
    });
    outputs.push({
      to: covenantLock,
      amount: COVENANT_SATS,
      token: { category: newFundsCategory, amount: newEscrowAmount },
    });
    // The old-asset remainder is `totalIn(oldFundsCategory) − gross` (strays included).
    const oldRemainder = escrow - settlement.gross;
    if (oldRemainder > 0n) {
      outputs.push({
        to: p2pkhLock(state.supporterPkh),
        amount: COVENANT_SATS,
        token: { category: fundsCategory, amount: oldRemainder },
      });
    }
  } else {
    // modify: 0 state, 1 funds (totalIn). The contract writes `totalIn(fundsCat)`
    // (the escrow plus any stray funds-category inputs); no strays are added here,
    // so `totalIn == escrow`. No settle — the clock is untouched.
    const balance = escrowUtxo.token!.amount;
    outputs.push({
      to: covenantLock,
      amount: COVENANT_SATS,
      token: {
        category: sub.stateCategory,
        amount: 0n,
        nft: { capability: 'mutable', commitment: binToHex(encodeCommitment(nextState)) },
      },
    });
    outputs.push({
      to: covenantLock,
      amount: COVENANT_SATS,
      token: { category: fundsCategory, amount: balance },
    });
  }
  tx.addOutputs(outputs);

  // `migrate` funding inputs: the new-category token UTXOs the caller contributes.
  // Their sum is the new escrow; without them the new-category output is an
  // implicit mint the VM rejects. Added before the presence inputs (the initiator's
  // input must be the one that receives the BCH change).
  if (fn === 'migrate') {
    for (const funding of options.newAssetInputs ?? []) {
      const index = tx.inputs.length;
      tx.addInput(toTokenSpendable(funding), unlockPresence(funding));
      signableInputs.push({
        index,
        lockingBytecode: funding.lockingBytecode.toLowerCase(),
        satoshis: funding.satoshis.toString(),
        address: p2pkhAddress(funding.lockingBytecode),
        token: { category: funding.category.toLowerCase(), amount: funding.amount.toString() },
      });
    }
  }

  // Both parties' presence inputs. The contract's `isPresent` accepts P2PKH or
  // P2SH20 of the party's hash; the MVP models each as a P2PKH UTXO the caller
  // supplies. The initiator's input is added first and receives the BCH change —
  // the initiator pays the fee (spec § Mutual-consent relay — fee payer).
  //
  // Each presence input is an **unsigned placeholder**: `isPresent` reads only the
  // locking bytecode, so no signature is needed by the contract. The relay never
  // accepts a private key; the party signs client-side in production.
  const initiatorLock = hexToBin(options.initiatorInput.lockingBytecode);
  const counterpartyLock = hexToBin(options.counterpartyInput.lockingBytecode);
  const initiatorIndex = tx.inputs.length;
  tx.addInput(toSpendable(options.initiatorInput, initiatorLock), unlockPresence(options.initiatorInput));
  const counterpartyIndex = tx.inputs.length;
  tx.addInput(toSpendable(options.counterpartyInput, counterpartyLock), unlockPresence(options.counterpartyInput));
  signableInputs.push(
    {
      index: initiatorIndex,
      lockingBytecode: options.initiatorInput.lockingBytecode.toLowerCase(),
      satoshis: options.initiatorInput.satoshis.toString(),
      address: p2pkhAddress(options.initiatorInput.lockingBytecode),
    },
    {
      index: counterpartyIndex,
      lockingBytecode: options.counterpartyInput.lockingBytecode.toLowerCase(),
      satoshis: options.counterpartyInput.satoshis.toString(),
      address: p2pkhAddress(options.counterpartyInput.lockingBytecode),
    },
  );
  tx.addBchChangeOutputIfNeeded({ to: initiatorLock, feeRate });
  const hex = tx.build();
  return { hex, txid: txidOf(hex), nextState, signableInputs, sourceOutputs: sourceOutputsOf(tx.inputs) };
}

/**
 * Build the `modify` transaction for an **oracle** (BCH) sub: a single UTXO
 * (state NFT + sats). The oracle covenant's `modify(newAmountNext, newPeriodNext)`
 * matches the token signature, but the output layout differs — a single state
 * output carrying the whole balance (no escrow, no funds output).
 *
 *   modify: 0 state (NFT + balance)
 *
 * Both parties must be present (the contract requires it). The relay holds no key.
 */
async function buildOracleModify(
  provider: NetworkProvider,
  sub: Subscription,
  options: BuildMutualOptions,
  nextStateOf: (state: SubscriptionState) => SubscriptionState,
): Promise<BuiltMutual> {
  const now = options.now;
  const feeRate = options.feeRate ?? 1;
  const covenantAddress = sub.covenantAddress();

  const utxos = await provider.getUtxosForLockingBytecode(covenantAddress);
  const stateUtxo = utxos.find(
    (u) => u.token?.category === sub.stateCategory && u.token.nft !== undefined,
  );
  if (stateUtxo === undefined) throw new Error(`modify: no state UTXO for ${sub.stateCategory}`);

  const state = oracle.decodeCommitment(hexToBin(stateUtxo.token!.nft!.commitment));
  const balance = stateUtxo.satoshis;

  const contract = new Contract(oracleArtifact, [toInternalCategory(sub.stateCategory)], {
    provider,
    contractType: 'p2sh32',
  });
  const unlock = contract.unlock as unknown as Record<string, (...a: unknown[]) => Unlocker>;

  // The oracle `modify` writes `amountNext`/`periodNext`; `amount`/`period` are
  // carried through unchanged. `nextStateOf` is the token-shaped patcher, so map
  // it onto the oracle state explicitly.
  const patched = nextStateOf(state as unknown as SubscriptionState);
  const nextState: oracle.OracleState = {
    ...state,
    amountNext: patched.amountNext,
    periodNext: patched.periodNext,
  };

  const covenantLock = hexToBin(contract.lockingBytecode);
  const tx = new TransactionBuilder({ provider }).setLocktime(now);
  tx.addInput(stateUtxo, unlock['modify']!(nextState.amountNext, BigInt(nextState.periodNext)));
  tx.addOutput({
    to: covenantLock,
    amount: balance,
    token: {
      category: sub.stateCategory,
      amount: 0n,
      nft: { capability: 'mutable', commitment: binToHex(oracle.encodeCommitment(nextState)) },
    },
  });

  // Both parties' presence inputs (unsigned placeholders; the client signs).
  const initiatorLock = hexToBin(options.initiatorInput.lockingBytecode);
  const counterpartyLock = hexToBin(options.counterpartyInput.lockingBytecode);
  const initiatorIndex = tx.inputs.length;
  tx.addInput(toSpendable(options.initiatorInput, initiatorLock), unlockPresence(options.initiatorInput));
  const counterpartyIndex = tx.inputs.length;
  tx.addInput(toSpendable(options.counterpartyInput, counterpartyLock), unlockPresence(options.counterpartyInput));
  tx.addBchChangeOutputIfNeeded({ to: initiatorLock, feeRate });

  const hex = tx.build();
  return {
    hex,
    txid: txidOf(hex),
    nextState: nextState as unknown as SubscriptionState,
    signableInputs: [
      {
        index: initiatorIndex,
        lockingBytecode: options.initiatorInput.lockingBytecode.toLowerCase(),
        satoshis: options.initiatorInput.satoshis.toString(),
        address: p2pkhAddress(options.initiatorInput.lockingBytecode),
      },
      {
        index: counterpartyIndex,
        lockingBytecode: options.counterpartyInput.lockingBytecode.toLowerCase(),
        satoshis: options.counterpartyInput.satoshis.toString(),
        address: p2pkhAddress(options.counterpartyInput.lockingBytecode),
      },
    ],
    sourceOutputs: sourceOutputsOf(tx.inputs),
  };
}

/**
 * The unlocker for a party's presence input.
 *
 * The covenant's `isPresent` only reads the input's locking bytecode, so an
 * **unsigned placeholder** authorizes the action — the signature is irrelevant to
 * the covenant. The relay never holds a key; the party signs client-side in
 * production (the relay only broadcasts).
 *
 * The placeholder's unlocking bytecode is a **correctly-sized** 107-byte P2PKH
 * dummy (DER sig push + pubkey push). The size matters: `TransactionBuilder`
 * computes the BCH change for the final signed size, so a real signature never
 * under-pays the fee. The placeholder is **not valid to broadcast** — the client
 * signs client-side (`test/client-signer.ts` models that wallet).
 */
function unlockPresence(input: CounterpartyInput): Unlocker {
  return {
    // 107 B = 1 (sig push) + 72 (DER sig + sighash) + 1 (pubkey push) + 33 (pubkey).
    generateUnlockingBytecode: () => new Uint8Array(107),
    placeholder: true,
    lockingBytecode: input.lockingBytecode.toLowerCase(),
  } as unknown as Unlocker;
}

/** The sum of the new-category funding inputs (the contract's `totalIn`). */
function totalIn(inputs: readonly NewAssetInput[], category: string): bigint {
  return inputs
    .filter((i) => i.category.toLowerCase() === category.toLowerCase())
    .reduce((sum, i) => sum + i.amount, 0n);
}

/** A P2PKH locking bytecode for a 20-byte pkh. */
function p2pkhLock(pkh: Uint8Array): Uint8Array {
  return Uint8Array.from([0x76, 0xa9, 0x14, ...pkh, 0x88, 0xac]);
}

/** Map an API-supplied input to a CashScript spendable UTXO. */
function toSpendable(input: CounterpartyInput, lockingBytecode: Uint8Array): SpendableUtxo {
  return {
    txid: input.txid,
    vout: input.vout,
    satoshis: input.satoshis,
    lockingBytecode: binToHex(lockingBytecode),
  } as unknown as SpendableUtxo;
}

/** Map an API-supplied new-asset funding input to a token-bearing spendable UTXO. */
function toTokenSpendable(input: NewAssetInput): SpendableUtxo {
  return {
    txid: input.txid,
    vout: input.vout,
    satoshis: input.satoshis,
    lockingBytecode: input.lockingBytecode.toLowerCase(),
    token: { category: input.category.toLowerCase(), amount: input.amount },
  } as unknown as SpendableUtxo;
}
function requireAmount(value: unknown, field: string): bigint {
  if (value === undefined || value === null || value === '') {
    throw new Error(`${field} is required`);
  }
  const amount = BigInt(value as string | number | bigint);
  if (amount <= 0n) throw new Error(`${field} must be positive`);
  return amount;
}

function requirePeriod(value: unknown, field: string): number {
  const period = Number(value);
  if (!Number.isInteger(period) || period <= 0) throw new Error(`${field} must be positive`);
  return period;
}

function requireCategory(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error(`${field} must be a 32-byte category hex`);
  }
  return value.toLowerCase();
}

/** The txid of a raw transaction hex (double-sha256, reversed). */
export function txidOf(hex: string): string {
  const bytes = hexToBin(hex);
  const digest = sha256.hash(sha256.hash(bytes));
  return Buffer.from(Uint8Array.from([...digest].reverse())).toString('hex');
}
