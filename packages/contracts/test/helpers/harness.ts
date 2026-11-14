/**
 * Test harness for the token subscription covenant.
 *
 * Everything here mirrors `contracts/token-subscription.cash`: the commitment
 * codec, the settlement arithmetic and the canonical output layout of every
 * covenant spend. The harness *derives* the expected transaction layout from
 * (state, balance, clock) — the same computation the txserver performs — so each
 * test cross-checks the contract against an independent reference implementation.
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
import { binToHex, hexToBin } from '@bitauth/libauth';
import 'cashscript/jest';
import artifact from '../../artifacts/token-subscription.artifact.js';
import {
  COMMITMENT_SIZE,
  MODE_A,
  MODE_B,
  encodeCommitment,
  decodeCommitment,
  settle,
  type SubscriptionState,
  type Settlement,
  type Mode,
} from '../../src/commitment.js';

const { hash160 } = utils;

export { COMMITMENT_SIZE, MODE_A, MODE_B, encodeCommitment, decodeCommitment, settle };
export type { SubscriptionState, Settlement, Mode };

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

/**
 * Byte-reverse a category hex string.
 *
 * The VM's `tokenCategory` introspection reverses the category it renders, so the
 * value a covenant compares against (`stateCategory + 0x01`, `totalIn(category)`)
 * is in *display* order, while libauth UTXOs/outputs carry the raw *internal*
 * order. `reverseCategory` converts between the two (it is its own inverse).
 */
export const reverseCategory = (hex: string): string => {
  const bin = hexToBin(hex);
  return binToHex(Uint8Array.from([...bin].reverse()));
};

/** Internal → display (the order the VM introspects). */
export const toDisplayCategory = reverseCategory;

/** Display → internal (the order libauth UTXOs/outputs carry). */
export const toInternalCategory = reverseCategory;

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

export interface ScenarioOptions {
  mode: Mode;
  amount: bigint;
  period: number;
  balance: bigint;
  /** Creation time in unix seconds. */
  creationTime: number;
  fundsCategory?: string;
  amountNext?: bigint;
  periodNext?: number;
  /** Satoshis parked on each covenant UTXO (token outputs need ≥ 1000 for dust). */
  covenantSats?: bigint;
}

/** Satoshis parked on each covenant UTXO. */
const COVENANT_SATS = 2000n;
/** Satoshis on each actor input — enough to cover fees and change. */
const ACTOR_SATS = 1_000_000n;

/** The fields `settle()` writes back on top of the spent state (always-replace). */
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
  /** Funds-asset category in internal order. */
  readonly fundsCategory: string;
  /** Funds-asset category in display order. */
  readonly fundsCategoryDisplay: string;
  readonly supporter: Role;
  readonly supportee: Role;
  readonly service: Role;
  readonly creationTime: number;
  /** The clock: transactions are built with `now` in nLocktime. */
  now: number;
  covenantSats: bigint;

  private state_: SubscriptionState;
  private balance: bigint;
  private stateUtxo!: SpendableUtxo;
  private fundsUtxo?: SpendableUtxo;
  private nonce = 0;

  constructor(options: ScenarioOptions) {
    this.provider = new MockNetworkProvider({ vmTarget: 'BCH_2026_05' });
    this.fundsCategory = options.fundsCategory
      ? toInternalCategory(options.fundsCategory)
      : randomCategory();
    this.fundsCategoryDisplay = toDisplayCategory(this.fundsCategory);
    this.supporter = makeRole('supporter', 0x11);
    this.supportee = makeRole('supportee', 0x22);
    this.service = makeRole('service', 0x33);
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
      fundsCategory: hexToBin(this.fundsCategory),
    };
    this.balance = options.balance;

    this.contract = new Contract(artifact, [this.stateCategory], {
      provider: this.provider,
      contractType: 'p2sh32',
    });
    this.refresh();
  }

  /** The contract's constructor argument, in internal order (raw libauth bytes). */
  get stateCategoryArg(): string {
    return this.stateCategory;
  }

  /** A key that is not one of the three covenant roles (for unauthorised-spend tests). */
  stranger(): Role {
    return makeRole('stranger', 0x99);
  }

  get mode(): Mode {
    return this.state.mode;
  }

  get state(): SubscriptionState {
    return this.state_;
  }

  get currentBalance(): bigint {
    return this.balance;
  }

  /** (Re)creates the covenant UTXOs from the current state and balance. */
  refresh(): void {
    this.provider.reset();
    const commitment = binToHex(encodeCommitment(this.state));
    // The contract constructor receives the state category in *internal* order
    // (raw libauth bytes); the VM's `tokenCategory` introspection reverses the
    // category it renders, so a UTXO registered with the display-order form is
    // what `stateInputIndex`'s `stateCategory + 0x01` comparison expects.
    this.stateUtxo = this.provider.addUtxo(this.contract.lockingBytecode, {
      txid: randomTxid(),
      vout: 0,
      satoshis: this.covenantSats,
      token: {
        category: this.stateCategoryDisplay,
        amount: 0n,
        nft: { capability: 'mutable', commitment },
      },
    });
    this.fundsUtxo =
      this.balance > 0n
        ? this.provider.addUtxo(this.contract.lockingBytecode, {
            txid: randomTxid(),
            vout: 0,
            satoshis: this.covenantSats,
            token: { category: this.fundsCategoryDisplay, amount: this.balance },
          })
        : undefined;
    this.nonce += 1;
  }

  /** Mutates the stored state (then re-creates the UTXOs). */
  setState(patch: Partial<SubscriptionState>): void {
    this.state_ = { ...this.state_, ...patch };
    this.refresh();
  }

  /** Mutates the covenant's funds balance (then re-creates the UTXOs). */
  setBalance(balance: bigint): void {
    this.balance = balance;
    this.refresh();
  }

  /** Commitment size in bytes (asserted against the 128-byte network limit). */
  commitmentSize(): number {
    return encodeCommitment(this.state_).length;
  }

  /** Reads the covenant's post-transaction state straight out of the UTXO set. */
  async readCovenant(): Promise<{ state?: SubscriptionState; funds?: bigint }> {
    const utxos = await this.provider.getUtxosForLockingBytecode(hexToBin(this.contract.lockingBytecode));
    let state: SubscriptionState | undefined;
    let funds: bigint | undefined;
    for (const utxo of utxos) {
      const token = utxo.token;
      if (token === undefined) continue;
      if (token.category === this.stateCategoryDisplay) {
        const commitment = token.nft?.commitment ?? '';
        state = decodeCommitment(hexToBin(commitment));
      } else if (token.category === this.fundsCategoryDisplay) {
        funds = token.amount;
      }
    }
    return { state, funds };
  }

  /** Moves the clock. */
  advance(seconds: number): void {
    this.now += seconds;
  }

  settlement(): Settlement {
    return settle(this.state, this.balance, this.now);
  }

  settlementWith(balance: bigint): Settlement {
    return settle(this.state, balance, this.now);
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

  /** A token input controlled by `role` (fund / migrate funding). */
  tokenInput(role: Role, category: string, amount: bigint): SpendableUtxo {
    return this.provider.addUtxo(binToHex(role.lock), {
      ...this.nextOutpoint(),
      satoshis: this.covenantSats,
      token: { category, amount },
    });
  }

  covenantLock(): Uint8Array {
    return hexToBin(this.contract.lockingBytecode);
  }

  /** A token category in display order is what both the provider and the ABI expect. */
  stateOutput(commitment: Uint8Array, sats: bigint = this.covenantSats): Output {
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

  fundsOutput(category: string, amount: bigint, sats: bigint = this.covenantSats): Output {
    return { to: this.covenantLock(), amount: sats, token: { category, amount } };
  }

  paymentOutput(role: Role, category: string, amount: bigint, sats: bigint = this.covenantSats): Output {
    return { to: role.lock, amount: sats, token: { category, amount } };
  }

  plainOutput(role: Role, amount: bigint): Output {
    return { to: role.lock, amount };
  }

  // -- tx plumbing ----------------------------------------------------------

  /** Typed accessor over the contract's ABI (avoids `noUncheckedIndexedAccess`). */
  unlock(): UnlockerMap {
    return this.contract.unlock as unknown as UnlockerMap;
  }

  /** Starts a builder with the clock set and both covenant inputs unlocked. */
  base(fn: (unlock: UnlockerMap) => Unlocker): TransactionBuilder {
    const unlocker = fn(this.unlock());
    const tx = new TransactionBuilder({ provider: this.provider }).setLocktime(this.now);
    tx.addInput(this.stateUtxo, unlocker);
    if (this.fundsUtxo !== undefined) {
      tx.addInput(this.fundsUtxo, unlocker);
    }
    return tx;
  }

  /** Adds the acting role's P2PKH input (presence auth) and a BCH change output. */
  pay(tx: TransactionBuilder, payer: Role): TransactionBuilder {
    tx.addInput(this.input(payer), payer.template.unlockP2PKH());
    return tx.addBchChangeOutputIfNeeded({ to: payer.lock, feeRate: 1 });
  }

  // -- canonical transitions ------------------------------------------------

  /** Canonical `pull`: settles every coverable period, recreates the covenant. */
  pull(): TransactionBuilder {
    const s = this.settlement();
    const next = { ...this.state, ...promote(s) };
    const tx = this.base(() => this.unlock()['pull']!());
    if (s.paid > 0n) {
      tx.addOutput(this.paymentOutput(this.supportee, this.fundsCategoryDisplay, s.paid));
    }
    tx.addOutput(this.stateOutput(encodeCommitment(next)));
    if (s.remaining > 0n) {
      tx.addOutput(this.fundsOutput(this.fundsCategoryDisplay, s.remaining));
    }
    return this.pay(tx, this.service);
  }

  /** Canonical `cancel`: settle, refund the remainder, burn the state NFT. */
  cancel(authorizer: Role = this.service): TransactionBuilder {
    const s = this.settlement();
    const tx = this.base(() => this.unlock()['cancel']!());
    if (s.paid > 0n) {
      tx.addOutput(this.paymentOutput(this.supportee, this.fundsCategoryDisplay, s.paid));
    }
    if (s.remaining > 0n) {
      tx.addOutput(this.paymentOutput(this.supporter, this.fundsCategoryDisplay, s.remaining));
    }
    return this.pay(tx, authorizer);
  }

  /** Canonical `modify`: writes the pending terms, moves nothing. */
  modify(amountNext: bigint, periodNext: number, payer: Role = this.supporter): TransactionBuilder {
    const next = { ...this.state, amountNext, periodNext };
    const tx = this.base(() => this.unlock()['modify']!(amountNext, BigInt(periodNext)));
    tx.addOutput(this.stateOutput(encodeCommitment(next)));
    if (this.balance > 0n) {
      tx.addOutput(this.fundsOutput(this.fundsCategoryDisplay, this.balance));
    }
    return this.pay(tx, payer);
  }

  /**
   * Canonical `modify` with both consenting parties present (the contract requires
   * supporter **and** supportee presence). `payer` pays the fee.
   */
  modifyMutual(
    amountNext: bigint,
    periodNext: number,
    payer: Role = this.supporter,
  ): TransactionBuilder {
    const next = { ...this.state, amountNext, periodNext };
    const tx = this.base(() => this.unlock()['modify']!(amountNext, BigInt(periodNext)));
    tx.addInput(this.input(payer), payer.template.unlockP2PKH());
    const other = payer === this.supporter ? this.supportee : this.supporter;
    tx.addInput(this.input(other), other.template.unlockP2PKH());
    tx.addOutput(this.stateOutput(encodeCommitment(next)));
    if (this.balance > 0n) {
      tx.addOutput(this.fundsOutput(this.fundsCategoryDisplay, this.balance));
    }
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
    tx.addOutput(this.stateOutput(encodeCommitment(next)));
    if (this.balance > 0n) {
      tx.addOutput(this.fundsOutput(this.fundsCategoryDisplay, this.balance));
    }
    return this.pay(tx, payer);
  }

  /** Canonical `fund`: adds `amount` tokens of the asset, state untouched. */
  fund(amount: bigint, funder: Role = this.supporter): TransactionBuilder {
    const funding = this.tokenInput(funder, this.fundsCategoryDisplay, amount);
    const tx = this.base(() => this.unlock()['fund']!());
    tx.addInput(funding, funder.template.unlockP2PKH());
    tx.addOutput(this.stateOutput(encodeCommitment(this.state)));
    tx.addOutput(this.fundsOutput(this.fundsCategoryDisplay, this.balance + amount));
    // The covenant now holds the extra funds; keep the tracked balance in sync so
    // subsequent transitions (pull/withdraw/…) compute the right settlement.
    this.balance += amount;
    return this.pay(tx, funder);
  }

  /**
   * Rebuilds the covenant UTXOs from the *on-chain* state after a transition that
   * changed the UTXO set (e.g. `pull`, `fund`). Reads the live commitment and
   * funds balance out of the provider, then re-creates the spendable UTXOs.
   */
  async sync(): Promise<void> {
    const live = await this.readCovenant();
    if (live.state !== undefined) this.state_ = live.state;
    this.balance = live.funds ?? 0n;
    this.refresh();
  }

  /** Canonical `withdraw`: settle, then reclaim `balance − reserved`. */
  withdraw(): TransactionBuilder {
    const s = this.settlement();
    const next = { ...this.state, ...promote(s) };
    const retained = s.reserved - s.paid;
    const payout = s.remaining - retained;
    const tx = this.base(() => this.unlock()['withdraw']!());
    if (s.paid > 0n) {
      tx.addOutput(this.paymentOutput(this.supportee, this.fundsCategoryDisplay, s.paid));
    }
    tx.addOutput(this.stateOutput(encodeCommitment(next)));
    if (retained > 0n) {
      tx.addOutput(this.fundsOutput(this.fundsCategoryDisplay, retained));
    }
    if (payout > 0n) {
      tx.addOutput(this.paymentOutput(this.supporter, this.fundsCategoryDisplay, payout));
    }
    return this.pay(tx, this.supporter);
  }

  /**
   * Canonical `reactivate`: settle, waive the surviving arrears, re-anchor the
   * clock to `now`. `extraFunding` is the additional period(s) the supporter
   * funds inside the same transaction.
   */
  reactivate(extraFunding: bigint = 0n, funder: Role = this.supporter): TransactionBuilder {
    const funded = this.balance + extraFunding;
    const s = this.settlementWith(funded);
    const next = { ...this.state, ...promote(s), lastPeriodTime: this.now };
    const tx = this.base(() => this.unlock()['reactivate']!());
    if (extraFunding > 0n) {
      // The funder's contribution is an input; it must be added *before* the BCH
      // change output that `pay()` appends, but after the two covenant inputs.
      tx.addInput(this.tokenInput(funder, this.fundsCategoryDisplay, extraFunding), funder.template.unlockP2PKH());
    }
    if (s.paid > 0n) {
      tx.addOutput(this.paymentOutput(this.supportee, this.fundsCategoryDisplay, s.paid));
    }
    tx.addOutput(this.stateOutput(encodeCommitment(next)));
    if (s.remaining > 0n) {
      tx.addOutput(this.fundsOutput(this.fundsCategoryDisplay, s.remaining));
    }
    return this.pay(tx, this.supporter);
  }

  /**
   * Canonical `migrate`: settle, then swap only the unearned remainder.
   * `funding` is the amount of the NEW asset the supporter brings in.
   * `newFundsCategory` is in internal order (the contract argument is compared
   * against VM introspection, so it is passed display-order).
   */
  migrate(
    newFundsCategory: string,
    newAmount: bigint,
    newAmountNext: bigint,
    funding: bigint,
    funder: Role = this.supporter,
  ): TransactionBuilder {
    const s = this.settlement();
    const newDisplay = toDisplayCategory(newFundsCategory);
    // `migrate` re-denominates by mutual agreement: the new amount/amountNext are
    // written immediately (not promoted from the old terms), and the clock is the
    // settle's new anchor. The commitment stores the category in *display* order —
    // the same form VM `tokenCategory` introspection reports.
    const next = {
      ...this.state,
      amount: newAmount,
      amountNext: newAmountNext,
      lastPeriodTime: s.newLastPeriodTime,
      fundsCategory: hexToBin(newDisplay),
    };
    const tx = this.base(() => this.unlock()['migrate']!(newDisplay, newAmount, newAmountNext));
    // The funder's token input carries the new asset in display order (the form the
    // provider stores); the covenant then sees it via `totalIn`.
    tx.addInput(this.tokenInput(funder, newDisplay, funding), funder.template.unlockP2PKH());
    // The contract requires supporter AND supportee presence: add the other party.
    const other = funder === this.supporter ? this.supportee : this.supporter;
    tx.addInput(this.input(other), other.template.unlockP2PKH());
    if (s.paid > 0n) {
      tx.addOutput(this.paymentOutput(this.supportee, this.fundsCategoryDisplay, s.paid));
    }
    tx.addOutput(this.stateOutput(encodeCommitment(next)));
    if (funding > 0n) {
      tx.addOutput(this.fundsOutput(newDisplay, funding));
    }
    // The old-asset remainder comes only when settle left something behind.
    if (this.balance - s.paid > 0n) {
      tx.addOutput(this.paymentOutput(this.supporter, this.fundsCategoryDisplay, this.balance - s.paid));
    }
    return tx.addBchChangeOutputIfNeeded({ to: funder.lock, feeRate: 1 });
  }
}

/** Convenience wrapper: a subscription whose terms match a spec scenario. */
export function scenario(options: ScenarioOptions): Scenario {
  return new Scenario(options);
}

