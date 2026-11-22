/**
 * Token-path `withdraw` / `reactivate` / `fund` executors (spec § Withdraw (settle,
 * then reclaim unearned funds), § Reactivate (waive arrears, promote terms, stay
 * on the grid), § Stray-value sweep — `fund` absorbs same-cat strays).
 *
 * These three actions need **no oracle message and no party key**: the covenant
 * authorizes them by the party's **presence** (`isPresent`, a P2PKH locking-bytecode
 * check). The server therefore uses the same no-key `prepare → client-sign →
 * broadcast` model as `OracleActionsService`: `prepare` builds the tx against the
 * covenant's **current** outpoints with correctly-sized P2PKH **placeholders** for
 * the presence/funding inputs and returns `{ unsignedHex, signableInputs }` — it
 * **never broadcasts**. `broadcast` accepts the client-signed hex, verifies it
 * spends the covenant's current state (and co-created escrow) outpoint, then relays.
 *
 * ---------------------------------------------------------------------------
 * withdraw — supporter only
 * ---------------------------------------------------------------------------
 *   s = settle(state, escrow − SEED, now)
 *   next = { ...state, ...promoted(s) }
 *   retained = s.owedPreSettle − s.gross + SEED
 *   payout   = escrow − s.gross − retained   (+ same-cat strays, folded via totalIn)
 *
 * Output layout (contract `withdraw`, fixed indices; `gross = 0` shifts later
 * outputs down):
 *   [0 supportee (gross − fee), 1 service (fee)] if gross > 0,
 *   then state (commitment = next, value = COVENANT_SATS),
 *   funds (retained), supporter payout.
 *
 * ---------------------------------------------------------------------------
 * reactivate — supporter only, only while paused, requires fresh funding
 * ---------------------------------------------------------------------------
 *   spendable = escrow − SEED
 *   n = floor((now − lastPeriodTime) / period)
 *   m = spendable / amount
 *   fee = m·perPeriodFee(amount) + (mode === 1 ? 0 : perPeriodFee(amountNext))
 *   supporteeAmount = spendable + (mode === 1 ? 0 : amountNext) − fee
 *   newAnchor = lastPeriodTime + n·period
 *   next = { ...promoted(state), lastPeriodTime: newAnchor }
 *   contractBalance = SEED + (mode === 1 ? newFunds : newFunds − amountNext)
 *
 * Gate: the sub must be **paused** (`escrow < payable`) and `newFunds ≥ amountNext`.
 * `newFunds` is the caller-supplied fresh funds-category token UTXO(s) total.
 *
 * Output layout (contract `reactivate`):
 *   [0 supportee supporteeAmount] if > 0, [service fee] if > 0,
 *   then state (commitment = next, value = COVENANT_SATS), funds(contractBalance).
 *
 * ---------------------------------------------------------------------------
 * fund — permissionless top-up, funder presence, no settle
 * ---------------------------------------------------------------------------
 *   total = escrow + contributions + same-cat strays
 *   state unchanged; outputs state(state), funds(total).
 *
 * All three add a BCH change tail. The server signs only its own **service key**
 * input (fee payer); it never holds a party key.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  Contract,
  SignatureTemplate,
  TransactionBuilder,
  type NetworkProvider,
  type Output,
  type SpendableUtxo,
  type Unlocker,
} from 'cashscript';
import { binToHex, decodeTransaction, hexToBin, sha256 } from '@bitauth/libauth';
import artifact from 'contracts/artifacts/token-subscription.artifact.js';
import {
  decodeCommitment,
  encodeCommitment,
  settle,
  toInternalCategory,
  SEED,
  perPeriodFee,
  type SubscriptionState,
} from 'shared';
import type { Subscription } from '../db/subscription.entity.js';
import { SubscriptionRepository } from '../subscription/subscription.repository.js';
import type { CounterpartyInput, SignableInput, SourceOutput } from '../relay/mutual-consent-builder.js';
import { p2pkhAddress, sourceOutputsOf } from '../relay/mutual-consent-builder.js';
import type { PullExecutorConfig } from './pull-executor.service.js';

/** Satoshis parked on each covenant UTXO (token dust limit is 1000). */
const COVENANT_SATS = 20_000n;

/** A caller-supplied token UTXO (funds-category) for funding/stray inputs. */
export interface TokenFundingInput extends CounterpartyInput {
  /** The token category (hex, **display** order — the form the provider stores). */
  category: string;
  /** The fungible amount carried by the output. */
  amount: bigint;
}

export interface BuildTokenWithdrawOptions {
  /** Unix seconds "now" — becomes the tx nLockTime. */
  now: number;
  /** The supporter's presence UTXO (P2PKH, no key held). */
  supporterInput?: CounterpartyInput;
  /** Same-category stray funds UTXO(s) to fold into the supporter payout. */
  strayInputs?: TokenFundingInput[];
  /** Fee rate in sats/byte for the BCH change output (default 1). */
  feeRate?: number;
}

export interface BuiltTokenWithdraw {
  /** The built tx hex (placeholder presence input; not valid to broadcast). */
  hex: string;
  /** The txid the transaction will have once broadcast. */
  txid: string;
  /** Gross paid to the supportee (`m · amount`). */
  gross: bigint;
  /** Service fee (`m · perPeriodFee(amount)`). */
  fee: bigint;
  /** Sats reclaimed by the supporter (`escrow − gross − retained` + strays). */
  payout: bigint;
  /** Funds retained by the covenant (`(owedPreSettle − gross) + SEED`). */
  retained: bigint;
  /** The state written back on the state output. */
  nextState: SubscriptionState;
  /** The presence/funding inputs the client must sign (P2PKH). */
  signableInputs: SignableInput[];
  /** Positional source outputs (one per tx input, in tx order) for WizardConnect. */
  sourceOutputs: SourceOutput[];
}

export interface BuildTokenReactivateOptions {
  /** Unix seconds "now" — becomes the tx nLockTime. */
  now: number;
  /** The fresh-funding funds-category token UTXO(s) the supporter contributes. */
  fundingInputs: TokenFundingInput[];
  /** Fee rate in sats/byte for the BCH change output (default 1). */
  feeRate?: number;
}

export interface BuiltTokenReactivate {
  /** The built tx hex (placeholder funding input(s); not valid to broadcast). */
  hex: string;
  /** The txid the transaction will have once broadcast. */
  txid: string;
  /** Tokens paid to the supportee (`spendable + prepaid − fee`). */
  supporteeAmount: bigint;
  /** Service fee. */
  fee: bigint;
  /** The fresh funding locked into the covenant (`newFunds`). */
  newFunds: bigint;
  /** The state written back on the state output. */
  nextState: SubscriptionState;
  /** The funding input(s) the client must sign (P2PKH). */
  signableInputs: SignableInput[];
  /** Positional source outputs (one per tx input, in tx order) for WizardConnect. */
  sourceOutputs: SourceOutput[];
}

export interface BuildTokenFundOptions {
  /** Unix seconds "now" — becomes the tx nLockTime. */
  now: number;
  /** The funder's funds-category token UTXO(s) to lock into the escrow. */
  funderInput: TokenFundingInput;
  /** Same-category stray funds UTXO(s) to absorb into the escrow. */
  strayInputs?: TokenFundingInput[];
  /** Fee rate in sats/byte for the BCH change output (default 1). */
  feeRate?: number;
}

export interface BuiltTokenFund {
  /** The built tx hex (placeholder funder input; not valid to broadcast). */
  hex: string;
  /** The txid the transaction will have once broadcast. */
  txid: string;
  /** The escrow after the top-up (`escrow + contributions + strays`). */
  total: bigint;
  /** The state written back on the state output (unchanged). */
  nextState: SubscriptionState;
  /** The funding input(s) the client must sign (P2PKH). */
  signableInputs: SignableInput[];
  /** Positional source outputs (one per tx input, in tx order) for WizardConnect. */
  sourceOutputs: SourceOutput[];
}

@Injectable()
export class TokenActionsService {
  private readonly logger = new Logger(TokenActionsService.name);
  /** In-process serialization: `category:action` → the tail of its chain. */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    @Inject('PULL_NETWORK_PROVIDER') private readonly provider: NetworkProvider,
    @Optional() private readonly subscriptions?: SubscriptionRepository,
    @Optional() @Inject('PULL_EXECUTOR_CONFIG') private readonly config?: PullExecutorConfig,
  ) {}

  /**
   * Build the `withdraw` transaction for a token subscription.
   *
   * Reads the covenant's state + co-created escrow, settles at `now`, and lets the
   * supporter reclaim `escrow − gross − retained` (plus any same-cat strays). The
   * supporter's presence input is an unsigned placeholder the client signs.
   */
  async buildTokenWithdraw(
    sub: Subscription,
    options: BuildTokenWithdrawOptions,
  ): Promise<BuiltTokenWithdraw> {
    const now = options.now;
    const feeRate = options.feeRate ?? 1;
    this.assertToken(sub, 'withdraw');

    const { stateUtxo, escrowUtxo, state } = await this.readCovenant(sub);
    const escrow = escrowUtxo.token!.amount;
    const settlement = settle(state, escrow - SEED, now);

    const retained = settlement.owedPreSettle - settlement.gross + SEED;
    const strays = (options.strayInputs ?? []).reduce((sum, i) => sum + i.amount, 0n);
    const payout = escrow - settlement.gross - retained + strays;
    if (payout < 0n) {
      throw new Error(
        `token withdraw: escrow ${escrow} is below the reserved amount for ${sub.stateCategory}`,
      );
    }

    // Always-replace: the state output carries the promoted terms + the settle's
    // new anchor (mirrors the contract's `writeState` on `withdraw`).
    const nextState: SubscriptionState = {
      ...state,
      amount: settlement.newAmount,
      period: settlement.newPeriod,
      lastPeriodTime: settlement.newLastPeriodTime,
    };
    const contract = this.contract(sub.stateCategory);
    const unlock = contract.unlock as unknown as Record<string, () => Unlocker>;
    const covenantLock = hexToBin(contract.lockingBytecode);

    const tx = new TransactionBuilder({ provider: this.provider }).setLocktime(now);
    tx.addInput(stateUtxo, unlock['withdraw']!());
    tx.addInput(escrowUtxo, unlock['withdraw']!());

    const signableInputs: SignableInput[] = [];
    for (const stray of options.strayInputs ?? []) {
      this.pushTokenInput(tx, signableInputs, stray);
    }

    const outputs: Output[] = [];
    if (settlement.gross > 0n) {
      outputs.push({
        to: p2pkhLock(state.supporteePkh),
        amount: COVENANT_SATS,
        token: { category: sub.fundsCategory, amount: settlement.paid },
      });
      outputs.push({
        to: p2pkhLock(state.servicePkh),
        amount: COVENANT_SATS,
        token: { category: sub.fundsCategory, amount: settlement.fee },
      });
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
      token: { category: sub.fundsCategory, amount: retained },
    });
    outputs.push({
      to: p2pkhLock(state.supporterPkh),
      amount: COVENANT_SATS,
      token: { category: sub.fundsCategory, amount: payout },
    });
    tx.addOutputs(outputs);

    this.addSupporterPresence(tx, signableInputs, options.supporterInput);
    await this.addServiceFeeInput(tx, feeRate);

    const hex = tx.build();
    return {
      hex,
      txid: txidOf(hex),
      gross: settlement.gross,
      fee: settlement.fee,
      payout,
      retained,
      nextState,
      signableInputs,
      sourceOutputs: sourceOutputsOf(tx.inputs),
    };
  }

  /**
   * Build the `reactivate` transaction for a paused token subscription.
   *
   * The fresh funding is carried by the caller-supplied funds-category token
   * UTXO(s), assembled as unsigned placeholders (the client signs them). Throws a
   * plain error when the sub is not paused or the funding is short.
   */
  async buildTokenReactivate(
    sub: Subscription,
    options: BuildTokenReactivateOptions,
  ): Promise<BuiltTokenReactivate> {
    const now = options.now;
    const feeRate = options.feeRate ?? 1;
    this.assertToken(sub, 'reactivate');

    const { stateUtxo, escrowUtxo, state } = await this.readCovenant(sub);
    const escrow = escrowUtxo.token!.amount;

    const n = BigInt(Math.floor((now - state.lastPeriodTime) / state.period));
    const payable = state.amount * n;
    // Paused ⟺ escrow < payable (the contract's own gate).
    if (escrow >= payable) {
      throw new Error(`token reactivate: rejected while funded for ${sub.stateCategory}`);
    }

    const spendable = escrow - SEED;
    const m = spendable / state.amount;
    const mode = state.mode;
    const fee =
      m * perPeriodFee(state.amount) + (mode === 1 ? 0n : perPeriodFee(state.amountNext));
    const supporteeAmount = spendable + (mode === 1 ? 0n : state.amountNext) - fee;

    const newFunds = options.fundingInputs.reduce((sum, i) => sum + i.amount, 0n);
    if (newFunds < state.amountNext) {
      throw new Error(
        `token reactivate: at least one fresh period (${state.amountNext} units) must be funded for ${sub.stateCategory}`,
      );
    }

    const newAnchor = state.lastPeriodTime + Number(n) * state.period;
    const nextState: SubscriptionState = {
      ...state,
      amount: state.amountNext,
      period: state.periodNext,
      lastPeriodTime: newAnchor,
    };
    const contractBalance = SEED + (mode === 1 ? newFunds : newFunds - state.amountNext);

    const contract = this.contract(sub.stateCategory);
    const unlock = contract.unlock as unknown as Record<string, () => Unlocker>;
    const covenantLock = hexToBin(contract.lockingBytecode);

    const tx = new TransactionBuilder({ provider: this.provider }).setLocktime(now);
    tx.addInput(stateUtxo, unlock['reactivate']!());
    tx.addInput(escrowUtxo, unlock['reactivate']!());

    const signableInputs: SignableInput[] = [];
    for (const funding of options.fundingInputs) {
      this.pushTokenInput(tx, signableInputs, funding);
    }

    const outputs: Output[] = [];
    if (supporteeAmount > 0n) {
      outputs.push({
        to: p2pkhLock(state.supporteePkh),
        amount: COVENANT_SATS,
        token: { category: sub.fundsCategory, amount: supporteeAmount },
      });
    }
    if (fee > 0n) {
      outputs.push({
        to: p2pkhLock(state.servicePkh),
        amount: COVENANT_SATS,
        token: { category: sub.fundsCategory, amount: fee },
      });
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
      token: { category: sub.fundsCategory, amount: contractBalance },
    });
    tx.addOutputs(outputs);

    // The supporter is the only party required present (the contract's
    // `isPresent(supporterPkh)`); the funding inputs already carry the supporter's
    // P2PKH lock, which satisfies it. No separate presence input is needed.
    await this.addServiceFeeInput(tx, feeRate);

    const hex = tx.build();
    return {
      hex,
      txid: txidOf(hex),
      supporteeAmount,
      fee,
      newFunds,
      nextState,
      signableInputs,
      sourceOutputs: sourceOutputsOf(tx.inputs),
    };
  }

  /**
   * Build the permissionless `fund` (top-up) transaction: the funder locks
   * funds-category tokens into the co-created escrow. No settle, state unchanged.
   */
  async buildTokenFund(sub: Subscription, options: BuildTokenFundOptions): Promise<BuiltTokenFund> {
    const now = options.now;
    const feeRate = options.feeRate ?? 1;
    this.assertToken(sub, 'fund');

    const { stateUtxo, escrowUtxo, state } = await this.readCovenant(sub);
    const escrow = escrowUtxo.token!.amount;

    const contributions = options.funderInput.amount;
    const strays = (options.strayInputs ?? []).reduce((sum, i) => sum + i.amount, 0n);
    const total = escrow + contributions + strays;

    const contract = this.contract(sub.stateCategory);
    const unlock = contract.unlock as unknown as Record<string, () => Unlocker>;
    const covenantLock = hexToBin(contract.lockingBytecode);

    const tx = new TransactionBuilder({ provider: this.provider }).setLocktime(now);
    tx.addInput(stateUtxo, unlock['fund']!());
    tx.addInput(escrowUtxo, unlock['fund']!());

    const signableInputs: SignableInput[] = [];
    for (const stray of options.strayInputs ?? []) {
      this.pushTokenInput(tx, signableInputs, stray);
    }
    this.pushTokenInput(tx, signableInputs, options.funderInput);

    tx.addOutputs([
      {
        to: covenantLock,
        amount: COVENANT_SATS,
        token: {
          category: sub.stateCategory,
          amount: 0n,
          nft: { capability: 'mutable', commitment: binToHex(encodeCommitment(state)) },
        },
      },
      {
        to: covenantLock,
        amount: COVENANT_SATS,
        token: { category: sub.fundsCategory, amount: total },
      },
    ]);

    await this.addServiceFeeInput(tx, feeRate);

    const hex = tx.build();
    return { hex, txid: txidOf(hex), total, nextState: state, signableInputs, sourceOutputs: sourceOutputsOf(tx.inputs) };
  }

  /** Relay a client-signed `withdraw` (verified + broadcast; never re-signs). */
  async broadcastTokenWithdraw(
    sub: Subscription,
    signedHex: string,
    now: number,
  ): Promise<{ broadcast: boolean; txid: string }> {
    return this.serializedBroadcast(sub, signedHex, now, 'withdraw');
  }

  /** Relay a client-signed `reactivate` (verified + broadcast; never re-signs). */
  async broadcastTokenReactivate(
    sub: Subscription,
    signedHex: string,
    now: number,
  ): Promise<{ broadcast: boolean; txid: string }> {
    return this.serializedBroadcast(sub, signedHex, now, 'reactivate');
  }

  /** Relay a client-signed `fund` (verified + broadcast; never re-signs). */
  async broadcastTokenFund(
    sub: Subscription,
    signedHex: string,
    now: number,
  ): Promise<{ broadcast: boolean; txid: string }> {
    return this.serializedBroadcast(sub, signedHex, now, 'fund');
  }

  private serializedBroadcast(
    sub: Subscription,
    signedHex: string,
    now: number,
    action: 'withdraw' | 'reactivate' | 'fund',
  ): Promise<{ broadcast: boolean; txid: string }> {
    const key = `${sub.stateCategory}:${action}`;
    const previous = this.inFlight.get(key) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() => this.runBroadcast(sub, signedHex, now, action));
    const chain = run.catch(() => undefined);
    this.inFlight.set(key, chain);
    void chain.finally(() => {
      if (this.inFlight.get(key) === chain) this.inFlight.delete(key);
    });
    return run;
  }

  private async runBroadcast(
    sub: Subscription,
    signedHex: string,
    now: number,
    action: 'withdraw' | 'reactivate' | 'fund',
  ): Promise<{ broadcast: boolean; txid: string }> {
    this.assertToken(sub, action);
    await this.verifySpendsCurrentState(sub, signedHex);
    const txid = await this.provider.sendRawTransaction(signedHex);
    this.logger.log(`token ${action} broadcast for ${sub.stateCategory}: ${txid} at ${now}`);
    return { broadcast: true, txid };
  }

  /** Verify a client-signed tx spends the covenant's current state outpoint. */
  private async verifySpendsCurrentState(sub: Subscription, signedHex: string): Promise<void> {
    let decoded: ReturnType<typeof decodeTransaction>;
    try {
      decoded = decodeTransaction(hexToBin(signedHex));
    } catch {
      throw new Error(`token actions: signedHex does not decode`);
    }
    if (typeof decoded === 'string') throw new Error(`token actions: signedHex does not decode`);
    const utxos = await this.provider.getUtxosForLockingBytecode(sub.covenantAddress());
    const stateUtxo = utxos.find(
      (u) => u.token?.category === sub.stateCategory && u.token.nft !== undefined,
    );
    if (stateUtxo === undefined) throw new Error(`token actions: no current state UTXO`);
    const spends = decoded.inputs.some(
      (i) =>
        binToHex(i.outpointTransactionHash) === stateUtxo.txid && i.outpointIndex === stateUtxo.vout,
    );
    if (!spends) throw new Error(`token actions: tx does not spend the current state outpoint`);
  }

  /** Read the covenant's state + co-created escrow UTXOs and decode the commitment. */
  private async readCovenant(sub: Subscription): Promise<{
    stateUtxo: SpendableUtxo;
    escrowUtxo: SpendableUtxo;
    state: SubscriptionState;
  }> {
    const covenantAddress = sub.covenantAddress();
    const utxos = await this.provider.getUtxosForLockingBytecode(covenantAddress);
    const stateUtxo = utxos.find(
      (u) => u.token?.category === sub.stateCategory && u.token.nft !== undefined,
    );
    if (stateUtxo === undefined) {
      throw new Error(`token actions: no state UTXO for ${sub.stateCategory}`);
    }
    const escrowUtxo = utxos.find(
      (u) =>
        u.token?.category === sub.fundsCategory &&
        u.txid === stateUtxo.txid &&
        u.lockingBytecode === covenantAddress,
    );
    if (escrowUtxo === undefined) {
      throw new Error(`token actions: no co-created escrow for ${sub.stateCategory}`);
    }
    const state = decodeCommitment(hexToBin(stateUtxo.token!.nft!.commitment));
    return { stateUtxo, escrowUtxo, state };
  }

  /** Add a caller-supplied token input as an unsigned placeholder + signable. */
  private pushTokenInput(
    tx: TransactionBuilder,
    signableInputs: SignableInput[],
    input: TokenFundingInput,
  ): void {
    const index = tx.inputs.length;
    tx.addInput(toTokenSpendable(input), unlockPresence(input));
    signableInputs.push({
      index,
      lockingBytecode: input.lockingBytecode.toLowerCase(),
      satoshis: input.satoshis.toString(),
      address: p2pkhAddress(input.lockingBytecode),
      token: { category: input.category.toLowerCase(), amount: input.amount.toString() },
    });
  }

  /** Add the supporter's presence input (unsigned placeholder; client signs). */
  private addSupporterPresence(
    tx: TransactionBuilder,
    signableInputs: SignableInput[],
    input: CounterpartyInput | undefined,
  ): void {
    if (input === undefined) return;
    const index = tx.inputs.length;
    tx.addInput(toSpendable(input), unlockPresence(input));
    signableInputs.push({
      index,
      lockingBytecode: input.lockingBytecode.toLowerCase(),
      satoshis: input.satoshis.toString(),
      address: p2pkhAddress(input.lockingBytecode),
    });
  }

  /** Add the service fee input (the server signs; pays the fee, receives change). */
  private async addServiceFeeInput(tx: TransactionBuilder, feeRate: number): Promise<void> {
    const serviceLock = this.serviceLock();
    const serviceUtxo = await this.serviceUtxo(serviceLock);
    tx.addInput(serviceUtxo, this.serviceTemplate().unlockP2PKH());
    tx.addBchChangeOutputIfNeeded({ to: serviceLock, feeRate });
  }

  private assertToken(sub: Subscription, action: string): void {
    if (sub.assetType !== 'token') {
      throw new Error(
        `token ${action}: oracle subs use the oracle artifact (see OracleActionsService)`,
      );
    }
  }

  private contract(stateCategory: string): Contract {
    return new Contract(artifact, [toInternalCategory(stateCategory)], {
      provider: this.provider,
      contractType: 'p2sh32',
    });
  }

  private serviceTemplate(): SignatureTemplate {
    if (this.config?.serviceKey === undefined || this.config.serviceKey === '') {
      throw new Error('token actions: SERVICE_KEY is not configured');
    }
    return new SignatureTemplate(hexToBin(this.config.serviceKey));
  }

  private serviceLock(): Uint8Array {
    if (this.config?.servicePkh === undefined || this.config.servicePkh === '') {
      throw new Error('token actions: SERVICE_PKH is not configured');
    }
    return p2pkhLock(hexToBin(this.config.servicePkh));
  }

  private async serviceUtxo(lock: Uint8Array): Promise<SpendableUtxo> {
    const utxos = await this.provider.getUtxosForLockingBytecode(lock);
    if (utxos.length === 0) {
      throw new Error('token actions: no service UTXOs to pay the fee');
    }
    return utxos.reduce((best, u) => (u.satoshis > best.satoshis ? u : best));
  }
}

/** A P2PKH locking bytecode for a 20-byte pkh. */
function p2pkhLock(pkh: Uint8Array): Uint8Array {
  return Uint8Array.from([0x76, 0xa9, 0x14, ...pkh, 0x88, 0xac]);
}

/** The unlocker for a party's presence/funding input (unsigned placeholder). */
function unlockPresence(input: CounterpartyInput): Unlocker {
  return {
    // 107 B = 1 (sig push) + 72 (DER sig + sighash) + 1 (pubkey push) + 33 (pubkey).
    generateUnlockingBytecode: () => new Uint8Array(107),
    placeholder: true,
    lockingBytecode: input.lockingBytecode.toLowerCase(),
  } as unknown as Unlocker;
}

/** Map an API-supplied presence input to a CashScript spendable UTXO. */
function toSpendable(input: CounterpartyInput): SpendableUtxo {
  return {
    txid: input.txid,
    vout: input.vout,
    satoshis: input.satoshis,
    lockingBytecode: input.lockingBytecode.toLowerCase(),
  } as unknown as SpendableUtxo;
}

/** Map an API-supplied token input to a token-bearing spendable UTXO. */
function toTokenSpendable(input: TokenFundingInput): SpendableUtxo {
  return {
    txid: input.txid,
    vout: input.vout,
    satoshis: input.satoshis,
    lockingBytecode: input.lockingBytecode.toLowerCase(),
    token: { category: input.category.toLowerCase(), amount: input.amount },
  } as unknown as SpendableUtxo;
}

/** The txid of a raw transaction hex (double-sha256, reversed). */
function txidOf(hex: string): string {
  const bytes = hexToBin(hex);
  const digest = sha256.hash(sha256.hash(bytes));
  return Buffer.from(Uint8Array.from([...digest].reverse())).toString('hex');
}
