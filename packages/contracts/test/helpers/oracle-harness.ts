/**
 * Test harness for the oracle (BCH) subscription covenant.
 *
 * Mirrors `contracts/oracle-subscription.cash`: the commitment codec, the
 * settlement arithmetic and the canonical output layout of every covenant spend.
 * Unlike the token harness, the covenant is a **single UTXO** — the mutable state
 * NFT and the satoshis live in the same output, so the settlement balance is that
 * output's value and there is no escrow/seed. `spendable = balance − DUST`.
 *
 * The harness *derives* the expected transaction layout from
 * (state, balance, clock, price) — the same computation the txserver performs — so
 * each test cross-checks the covenant against an independent reference.
 */
import {
  Contract,
  MockNetworkProvider,
  SignatureTemplate,
  TransactionBuilder,
  utils,
  type Output,
  type SpendableUtxo,
  type Unlocker,
} from 'cashscript';
import { binToHex, hexToBin, secp256k1 } from '@bitauth/libauth';
import 'cashscript/jest';
import artifact from '../../artifacts/oracle-subscription.artifact.js';
import {
  COMMITMENT_SIZE,
  MODE_A,
  MODE_B,
  encodeCommitment,
  decodeCommitment,
  settleOracle,
  type OracleState,
  type Settlement,
  type Mode,
} from '../../src/oracle-commitment.js';
import { DUST, perPeriodFee, grossPerPeriod } from '../../src/oracle-constants.js';
import { encodeMessage, signMessage, type OracleMessage } from '../../src/oracle-message.js';

const { hash160 } = utils;

export {
  COMMITMENT_SIZE,
  MODE_A,
  MODE_B,
  encodeCommitment,
  decodeCommitment,
  settleOracle,
  DUST,
  perPeriodFee,
  grossPerPeriod,
};
export type { OracleState, Settlement, Mode };

// ---------------------------------------------------------------------------
// Keys, addresses and locking bytecode
// ---------------------------------------------------------------------------

export interface Role {
  name: string;
  template: SignatureTemplate;
  pkh: Uint8Array;
  /** P2PKH locking bytecode for this role's standard address. */
  lock: Uint8Array;
}

export function makeRole(name: string, seed: number): Role {
  const template = new SignatureTemplate(new Uint8Array(32).fill(seed));
  const pkh = Uint8Array.from(hash160(template.publicKey));
  const lock = Uint8Array.from([0x76, 0xa9, 0x14, ...pkh, 0x88, 0xac]);
  return { name, template, pkh, lock };
}

/** P2SH20 locking bytecode for a script hash — used for the "script actor" test. */
export function p2sh20Lock(scriptHash: Uint8Array): Uint8Array {
  return Uint8Array.from([0xa9, 0x14, ...scriptHash, 0x87]);
}

/** The contract's ABI as a callable map (`noUncheckedIndexedAccess`-safe). */
type UnlockerMap = Record<string, (...args: any[]) => Unlocker>;

const randomHex = (bytes: number): string => {
  let out = '';
  while (out.length < bytes * 2) {
    out += Math.random().toString(16).slice(2);
  }
  return out.slice(0, bytes * 2);
};

const randomTxid = (): string => randomHex(32);

/** A random 32-byte token category in internal (unreversed) byte order. */
export const randomCategory = (): string => randomHex(32);

/** Byte-reverse a category hex string (its own inverse). */
export const reverseCategory = (hex: string): string => {
  const bin = hexToBin(hex);
  return binToHex(Uint8Array.from([...bin].reverse()));
};

export const toDisplayCategory = reverseCategory;
export const toInternalCategory = reverseCategory;

// ---------------------------------------------------------------------------
// Mock oracle (oracles.cash / General Protocols)
// ---------------------------------------------------------------------------

/**
 * A Schnorr oracle key plus a helper that produces the `(message, sig, pubkey)`
 * unlock args a covenant function expects. The signature is over
 * `sha256(message)`, which is what CashScript's `checkDataSig` verifies.
 */
export class MockOracle {
  readonly privateKey: Uint8Array;
  readonly publicKey: Uint8Array;
  /** `hash160(oraclePk)` — stored in the commitment as `oraclePkHash`. */
  readonly pkHash: Uint8Array;
  private sequence = 0;

  constructor(seed = 0x55) {
    this.privateKey = new Uint8Array(32).fill(seed);
    this.publicKey = secp256k1.derivePublicKeyCompressed(this.privateKey) as Uint8Array;
    this.pkHash = Uint8Array.from(hash160(this.publicKey));
  }

  /** Builds a signed GP message with the given fields. */
  message(over: Partial<OracleMessage> = {}): { message: Uint8Array; sig: Uint8Array; pubkey: Uint8Array } {
    this.sequence += 1;
    const m: OracleMessage = {
      messageTimestamp: 0,
      messageSequence: this.sequence,
      contentSequence: 1,
      price: 50_000,
      ...over,
    };
    const message = encodeMessage(m);
    return { message, sig: signMessage(this.privateKey, message), pubkey: this.publicKey };
  }
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

export interface ScenarioOptions {
  mode: Mode;
  /** USD cents per period. */
  amount: bigint;
  period: number;
  /** The covenant's balance in satoshis (state NFT + sats in one output). */
  balance?: bigint;
  /** Creation time in unix seconds. */
  creationTime: number;
  amountNext?: bigint;
  periodNext?: number;
  /** Initial `lastRate` (cents/BCH). */
  lastRate?: number;
  /** Satoshis parked on the covenant UTXO (must be ≥ DUST). */
  covenantSats?: bigint;
}

/** Default covenant balance (sats). */
const COVENANT_SATS = 200_000n;
/** Satoshis on each actor input — enough to cover fees and change. */
const ACTOR_SATS = 1_000_000n;

/** The fields `settleOracle()` writes back on top of the spent state. */
export interface Promoted {
  amount: bigint;
  period: number;
  lastPeriodTime: number;
}

export const promote = (s: Settlement): Promoted => ({
  amount: s.newAmount,
  period: s.newPeriod,
  lastPeriodTime: s.newLastPeriodTime,
});

export class Scenario {
  readonly provider: MockNetworkProvider;
  readonly contract: Contract;
  /** State-NFT category in internal order (as libauth UTXOs/outputs carry it). */
  readonly stateCategory = randomCategory();
  /** State-NFT category in display order (the order the VM introspects). */
  readonly stateCategoryDisplay = toDisplayCategory(this.stateCategory);
  readonly supporter: Role;
  readonly supportee: Role;
  readonly service: Role;
  readonly oracle: MockOracle;
  readonly creationTime: number;
  /** The clock: transactions are built with `now` in nLocktime. */
  now: number;
  covenantSats: bigint;

  private state_: OracleState;
  /** The covenant balance (sats) — the settlement balance. */
  private balance: bigint;
  private stateUtxo!: SpendableUtxo;
  private nonce = 0;

  constructor(options: ScenarioOptions) {
    this.provider = new MockNetworkProvider({ vmTarget: 'BCH_2026_05' });
    this.supporter = makeRole('supporter', 0x11);
    this.supportee = makeRole('supportee', 0x22);
    this.service = makeRole('service', 0x33);
    this.oracle = new MockOracle();
    this.creationTime = options.creationTime;
    this.now = options.creationTime;
    this.covenantSats = options.covenantSats ?? COVENANT_SATS;

    this.state_ = {
      supporterPkh: this.supporter.pkh,
      supporteePkh: this.supportee.pkh,
      servicePkh: this.service.pkh,
      amount: options.amount,
      amountNext: options.amountNext ?? options.amount,
      period: options.period,
      periodNext: options.periodNext ?? options.period,
      lastPeriodTime:
        options.mode === MODE_A ? options.creationTime - options.period : options.creationTime,
      mode: options.mode,
      oraclePkHash: this.oracle.pkHash,
      lastRate: options.lastRate ?? 50_000,
    };
    this.balance = options.balance ?? COVENANT_SATS;

    this.contract = new Contract(artifact, [this.stateCategory], {
      provider: this.provider,
      contractType: 'p2sh32',
    });
    this.refresh();
  }

  get stateCategoryArg(): string {
    return this.stateCategory;
  }

  stranger(): Role {
    return makeRole('stranger', 0x99);
  }

  get mode(): Mode {
    return this.state.mode;
  }

  get state(): OracleState {
    return this.state_;
  }

  /** The covenant balance (sats). */
  get currentBalance(): bigint {
    return this.balance;
  }

  /** The settlement balance: `balance − DUST`. */
  get spendable(): bigint {
    return this.balance - DUST;
  }

  /** The covenant balance after a settle: `balance − gross`. */
  balanceAfter(s: Settlement): bigint {
    return this.balance - s.gross;
  }

  /** (Re)creates the covenant UTXO from the current state and balance. */
  refresh(): void {
    this.provider.reset();
    const commitment = binToHex(encodeCommitment(this.state));
    this.stateUtxo = this.provider.addUtxo(this.contract.lockingBytecode, {
      txid: randomTxid(),
      vout: 1,
      satoshis: this.balance,
      token: {
        category: this.stateCategoryDisplay,
        amount: 0n,
        nft: { capability: 'mutable', commitment },
      },
    });
    this.nonce += 1;
  }

  setState(patch: Partial<OracleState>): void {
    this.state_ = { ...this.state_, ...patch };
    this.refresh();
  }

  setBalance(balance: bigint): void {
    this.balance = balance;
    this.refresh();
  }

  commitmentSize(): number {
    return encodeCommitment(this.state_).length;
  }

  /** Reads the covenant's post-transaction state + balance from the UTXO set. */
  async readCovenant(): Promise<{ state?: OracleState; sats?: bigint }> {
    const utxos = await this.provider.getUtxosForLockingBytecode(hexToBin(this.contract.lockingBytecode));
    for (const utxo of utxos) {
      if (utxo.token?.category === this.stateCategoryDisplay) {
        const commitment = utxo.token.nft?.commitment ?? '';
        return { state: decodeCommitment(hexToBin(commitment)), sats: utxo.satoshis };
      }
    }
    return {};
  }

  /** Total satoshis held by `role`'s address in the provider's UTXO set. */
  async readRoleSats(role: Role): Promise<bigint> {
    const utxos = await this.provider.getUtxosForLockingBytecode(role.lock);
    return utxos.reduce((sum, u) => sum + u.satoshis, 0n);
  }

  /** Satoshis held by `role` in outputs carrying no token (payment outputs). */
  async readRolePaidSats(role: Role): Promise<bigint> {
    const utxos = await this.provider.getUtxosForLockingBytecode(role.lock);
    return utxos.filter((u) => u.token === undefined).reduce((sum, u) => sum + u.satoshis, 0n);
  }

  /** The value of the covenant's state output (NFT + sats) after a transition. */
  async readCovenantSats(): Promise<bigint | undefined> {
    const utxos = await this.provider.getUtxosForLockingBytecode(hexToBin(this.contract.lockingBytecode));
    return utxos.find((u) => u.token?.category === this.stateCategoryDisplay)?.satoshis;
  }

  /** Moves the clock. */
  advance(seconds: number): void {
    this.now += seconds;
  }

  async send(tx: TransactionBuilder): Promise<void> {
    await tx.send();
    await this.sync();
  }

  /** Settlement against the current balance at `price` (defaults to lastRate). */
  settlement(price: bigint = BigInt(this.state.lastRate)): Settlement {
    return settleOracle(this.state, this.spendable, this.now, price);
  }

  settlementWithBalance(balance: bigint, price: bigint): Settlement {
    return settleOracle(this.state, balance - DUST, this.now, price);
  }

  // -- inputs & outputs -----------------------------------------------------

  private nextOutpoint(): { txid: string; vout: number } {
    return { txid: randomTxid(), vout: this.nonce % 4 };
  }

  /** A plain P2PKH input controlled by `role` (presence auth + fee payer). */
  input(role: Role, satoshis: bigint = ACTOR_SATS): SpendableUtxo {
    return this.provider.addUtxo(binToHex(role.lock), {
      ...this.nextOutpoint(),
      satoshis,
    });
  }

  /** A foreign token UTXO of an unrelated category, controlled by `owner`. */
  foreignToken(owner: Role, amount: bigint, category: string = randomCategory()): SpendableUtxo {
    return this.provider.addUtxo(binToHex(owner.lock), {
      ...this.nextOutpoint(),
      satoshis: this.covenantSats,
      token: { category: toDisplayCategory(category), amount },
    });
  }

  /** A token output of an unrelated category locked to `role` (cleanup target). */
  foreignOutput(role: Role, category: string, amount: bigint): Output {
    return {
      to: role.lock,
      amount: this.covenantSats,
      token: { category, amount },
    };
  }

  covenantLock(): Uint8Array {
    return hexToBin(this.contract.lockingBytecode);
  }

  /** The state output: NFT + the given satoshis (the covenant's whole balance). */
  stateOutput(commitment: Uint8Array, sats: bigint): Output {
    return {
      to: this.covenantLock(),
      amount: sats,
      token: {
        category: this.stateCategoryDisplay,
        amount: 0n,
        nft: { capability: 'mutable', commitment: binToHex(commitment) },
      },
    };
  }

  plainOutput(role: Role, amount: bigint): Output {
    return { to: role.lock, amount };
  }

  // -- tx plumbing ----------------------------------------------------------

  unlock(): UnlockerMap {
    return this.contract.unlock as unknown as UnlockerMap;
  }

  /** Starts a builder with the clock set and the covenant input unlocked. */
  base(fn: (unlock: UnlockerMap) => Unlocker): TransactionBuilder {
    const unlocker = fn(this.unlock());
    const tx = new TransactionBuilder({ provider: this.provider }).setLocktime(this.now);
    tx.addInput(this.stateUtxo, unlocker);
    return tx;
  }

  /** Adds the acting role's P2PKH input (presence auth) and a BCH change output. */
  pay(tx: TransactionBuilder, payer: Role): TransactionBuilder {
    tx.addInput(this.input(payer), payer.template.unlockP2PKH());
    return tx.addBchChangeOutputIfNeeded({ to: payer.lock, feeRate: 1 });
  }

  /** A signed oracle message at `timestamp` with `price` (defaults to now/lastRate). */
  oracleArgs(over: Partial<OracleMessage> = {}): { message: Uint8Array; sig: Uint8Array; pubkey: Uint8Array } {
    return this.oracle.message({
      messageTimestamp: over.messageTimestamp ?? this.now,
      price: over.price ?? this.state.lastRate,
      ...over,
    });
  }

  // -- canonical transitions ------------------------------------------------

  /** Canonical `pull`: settles every coverable period, recreates the covenant. */
  pull(price: bigint = BigInt(this.state.lastRate)): TransactionBuilder {
    const s = this.settlement(price);
    const next = { ...this.state, ...promote(s), lastRate: s.newLastRate };
    const args = this.oracleArgs({ price: Number(price) });
    const tx = this.base(() => this.unlock()['pull']!(args.sig, args.message, args.pubkey));
    if (s.gross > 0n) {
      tx.addOutput(this.plainOutput(this.supportee, s.paid));
      tx.addOutput(this.plainOutput(this.service, s.fee));
    }
    tx.addOutput(this.stateOutput(encodeCommitment(next), this.balanceAfter(s)));
    return this.pay(tx, this.service);
  }

  /** Canonical `cancel`: settle at lastRate, refund the remainder, burn the NFT. */
  cancel(authorizer: Role = this.service): TransactionBuilder {
    const s = this.settlement();
    const tx = this.base(() => this.unlock()['cancel']!());
    if (s.gross > 0n) {
      tx.addOutput(this.plainOutput(this.supportee, s.paid));
      tx.addOutput(this.plainOutput(this.service, s.fee));
    }
    tx.addOutput(this.plainOutput(this.supporter, this.balance - s.gross));
    return this.pay(tx, authorizer);
  }

  /** Canonical `modify`: writes the pending terms, moves nothing. */
  modify(amountNext: bigint, periodNext: number, payer: Role = this.supporter): TransactionBuilder {
    const next = { ...this.state, amountNext, periodNext };
    const tx = this.base(() => this.unlock()['modify']!(amountNext, BigInt(periodNext)));
    tx.addOutput(this.stateOutput(encodeCommitment(next), this.balance));
    return this.pay(tx, payer);
  }

  /** Canonical `modify` with both consenting parties present. */
  modifyMutual(amountNext: bigint, periodNext: number, payer: Role = this.supporter): TransactionBuilder {
    const next = { ...this.state, amountNext, periodNext };
    const tx = this.base(() => this.unlock()['modify']!(amountNext, BigInt(periodNext)));
    tx.addInput(this.input(payer), payer.template.unlockP2PKH());
    const other = payer === this.supporter ? this.supportee : this.supporter;
    tx.addInput(this.input(other), other.template.unlockP2PKH());
    tx.addOutput(this.stateOutput(encodeCommitment(next), this.balance));
    return tx.addBchChangeOutputIfNeeded({ to: payer.lock, feeRate: 1 });
  }

  /** Canonical `setPkh`: moves exactly one role, authorised by its holder. */
  setPkh(
    patch: { supporter?: Uint8Array; supportee?: Uint8Array; service?: Uint8Array },
    payer: Role,
  ): TransactionBuilder {
    const next = {
      ...this.state,
      supporterPkh: patch.supporter ?? this.state.supporterPkh,
      supporteePkh: patch.supportee ?? this.state.supporteePkh,
      servicePkh: patch.service ?? this.state.servicePkh,
    };
    const tx = this.base(() =>
      this.unlock()['setPkh']!(next.supporterPkh, next.supporteePkh, next.servicePkh),
    );
    tx.addOutput(this.stateOutput(encodeCommitment(next), this.balance));
    return this.pay(tx, payer);
  }

  /** Canonical `fund`: adds `amount` sats, state untouched. */
  fund(amount: bigint, funder: Role = this.supporter): TransactionBuilder {
    const tx = this.base(() => this.unlock()['fund']!());
    tx.addInput(this.input(funder, amount), funder.template.unlockP2PKH());
    tx.addOutput(this.stateOutput(encodeCommitment(this.state), this.balance + amount));
    this.balance += amount;
    return this.pay(tx, funder);
  }

  /** Rebuilds the covenant UTXO from the on-chain state after a transition. */
  async sync(): Promise<void> {
    const live = await this.readCovenant();
    if (live.state !== undefined) this.state_ = live.state;
    this.balance = live.sats ?? 0n;
    this.refresh();
  }

  /** Canonical `withdraw`: settle at the oracle, reclaim `spendable − owedPreSettle`. */
  withdraw(price: bigint = BigInt(this.state.lastRate)): TransactionBuilder {
    const s = this.settlement(price);
    const next = { ...this.state, ...promote(s), lastRate: s.newLastRate };
    const retained = s.owedPreSettle - s.gross + DUST;
    const payout = this.balance - s.gross - retained;
    const args = this.oracleArgs({ price: Number(price) });
    const tx = this.base(() => this.unlock()['withdraw']!(args.sig, args.message, args.pubkey));
    if (s.gross > 0n) {
      tx.addOutput(this.plainOutput(this.supportee, s.paid));
      tx.addOutput(this.plainOutput(this.service, s.fee));
    }
    tx.addOutput(this.stateOutput(encodeCommitment(next), retained));
    tx.addOutput(this.plainOutput(this.supporter, payout));
    return this.pay(tx, this.supporter);
  }

  /** Canonical `reactivate`: pay the whole balance except DUST, waive the rest. */
  reactivate(
    extraFunding: bigint,
    price: bigint = BigInt(this.state.lastRate),
    funder: Role = this.supporter,
  ): TransactionBuilder {
    const gppOld = grossPerPeriod(this.state.amount, price);
    const gppNew = grossPerPeriod(this.state.amountNext, price);
    const spendable = this.balance - DUST;
    const n = BigInt(Math.floor((this.now - this.state.lastPeriodTime) / this.state.period));
    const m = spendable / gppOld;
    const mode = this.state.mode;
    const fee = m * perPeriodFee(gppOld) + (mode === 1 ? 0n : perPeriodFee(gppNew));
    const supporteeAmount = spendable + (mode === 1 ? 0n : gppNew) - fee;
    const newAnchor = this.state.lastPeriodTime + Number(n) * this.state.period;
    const next = {
      ...this.state,
      amount: this.state.amountNext,
      period: this.state.periodNext,
      lastPeriodTime: newAnchor,
      lastRate: Number(price),
    };
    const contractBalance = DUST + (mode === 1 ? extraFunding : extraFunding - gppNew);

    const args = this.oracleArgs({ price: Number(price) });
    const tx = this.base(() => this.unlock()['reactivate']!(args.sig, args.message, args.pubkey));
    if (extraFunding > 0n) {
      tx.addInput(this.input(funder, extraFunding), funder.template.unlockP2PKH());
    }
    let idx = 0;
    if (supporteeAmount > 0n) {
      tx.addOutput(this.plainOutput(this.supportee, supporteeAmount));
      idx = 1;
    }
    if (fee > 0n) {
      tx.addOutput(this.plainOutput(this.service, fee));
      idx = idx + 1;
    }
    tx.addOutput(this.stateOutput(encodeCommitment(next), contractBalance));
    return this.pay(tx, this.supporter);
  }

  /** Canonical `migrate`: settle, then swap the oracle key. */
  migrate(
    newOracle: MockOracle,
    price: bigint = BigInt(this.state.lastRate),
    mutual = true,
    payer: Role = this.supporter,
  ): TransactionBuilder {
    const s = this.settlement(price);
    const next = {
      ...this.state,
      lastPeriodTime: s.newLastPeriodTime,
      oraclePkHash: newOracle.pkHash,
      lastRate: mutual ? Number(price) : this.state.lastRate,
    };
    const args = mutual
      ? this.oracleArgs({ price: Number(price) })
      : this.oracleArgs({ price: Number(price) });
    const tx = this.base(() => this.unlock()['migrate']!(newOracle.pkHash, args.sig, args.message, args.pubkey));
    if (payer === this.supporter) {
      tx.addInput(this.input(this.supporter), this.supporter.template.unlockP2PKH());
      if (mutual) tx.addInput(this.input(this.supportee), this.supportee.template.unlockP2PKH());
    } else {
      tx.addInput(this.input(this.service), this.service.template.unlockP2PKH());
    }
    if (s.gross > 0n) {
      tx.addOutput(this.plainOutput(this.supportee, s.paid));
      tx.addOutput(this.plainOutput(this.service, s.fee));
    }
    tx.addOutput(this.stateOutput(encodeCommitment(next), this.balance - s.gross));
    return tx.addBchChangeOutputIfNeeded({ to: payer.lock, feeRate: 1 });
  }
}

/** Convenience wrapper: a subscription whose terms match a spec scenario. */
export function scenario(options: ScenarioOptions): Scenario {
  return new Scenario(options);
}
