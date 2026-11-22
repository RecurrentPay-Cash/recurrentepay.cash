/**
 * Oracle (BCH) `withdraw` / `reactivate` executors (spec § Withdraw (settle,
 * then reclaim unearned funds), § Reactivate (waive arrears, promote terms, stay
 * on the grid), § Oracle contract — rate sources and coupling).
 *
 * Both are **oracle-priced** (they need a fresh signed message) and both operate
 * on the covenant's **single UTXO** (the mutable state NFT + sats share one
 * output; `spendable = balance − DUST`).
 *
 * ---------------------------------------------------------------------------
 * withdraw — supporter only
 * ---------------------------------------------------------------------------
 *   s = settleOracle(state, spendable, now, price)
 *   next = { ...promote(s), lastRate: s.newLastRate }
 *   retained = s.owedPreSettle − s.gross + DUST
 *   payout   = balance − s.gross − retained
 *
 * Output layout (contract `withdraw`, fixed indices; `gross = 0` shifts later
 * outputs down):
 *   [0 supportee (gross − fee), 1 service (fee)] if gross > 0,
 *   then state (commitment = next, value = retained),
 *   then supporter payout.
 *
 * Unlock `withdraw(sig, message, pubkey)`; supporter presence input;
 * `nLockTime = now`; BCH change tail.
 *
 * ---------------------------------------------------------------------------
 * reactivate — supporter only, only while paused, requires fresh funding
 * ---------------------------------------------------------------------------
 *   gppOld = grossPerPeriod(amount, price)
 *   gppNew = grossPerPeriod(amountNext, price)
 *   spendable = balance − DUST
 *   n = floor((now − lastPeriodTime) / period)
 *   m = spendable / gppOld
 *   fee = m·perPeriodFee(gppOld) + (mode === 1 ? 0 : perPeriodFee(gppNew))
 *   supporteeAmount = spendable + (mode === 1 ? 0 : gppNew) − fee
 *   newAnchor = lastPeriodTime + n·period
 *   next = { ..., amount: amountNext, period: periodNext,
 *            lastPeriodTime: newAnchor, lastRate: price }
 *   newFunds = extraFunding
 *   contractBalance = mode === 1 ? balance + newFunds : balance + newFunds − gppNew
 *
 * Gate: the sub must be **paused** (`balance < payable`) and `newFunds ≥ gppNew`
 * (at least one fresh period funded). The covenant reads `newFunds` from the
 * **state output value − balance**, so the fresh funding is carried by an extra
 * sponsor input.
 *
 * Output layout (contract `reactivate`):
 *   [0 supportee supporteeAmount] if > 0, [service fee] if > 0,
 *   then state (commitment = next, value = contractBalance).
 * Plus the funder's extra funding input + a separate fee-paying input + BCH change.
 *
 * ---------------------------------------------------------------------------
 * Freshness / deferral
 * ---------------------------------------------------------------------------
 * The price comes from a freshly fetched, signed oracle message
 * (`OracleClientService.fetchFresh`). When the message is not fresh (stale,
 * wrong-period, unreachable, …) this throws `OracleActionDeferredError` and
 * broadcasts nothing — the caller retries next cycle. A stale or partial tx is
 * never broadcast.
 *
 * ---------------------------------------------------------------------------
 * Funding / signing model (reactivate)
 * ---------------------------------------------------------------------------
 * The covenant needs real satoshis in the tx to fund the fresh period, but the
 * txserver **must not hold party keys** (same rule as the mutual-consent relay).
 * The clean MVP is therefore the relay's two-step model: the caller supplies the
 * funding UTXO(s) as `CounterpartyInput` (outpoint + satoshis + P2PKH lock), the
 * executor assembles a correctly-sized **unsigned placeholder** for them, and the
 * client signs client-side before broadcast. `withdraw` needs no fresh funds, so
 * it is built and broadcast by the server directly (the supporter's presence is
 * the only extra input, funded by the service key).
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
import { binToHex, decodeTransaction, hash160, hexToBin, sha256 } from '@bitauth/libauth';
import artifact from 'contracts/artifacts/oracle-subscription.artifact.js';
import { oracle, toInternalCategory, type oracle as OracleNs } from 'shared';
import type { Subscription } from '../db/subscription.entity.js';
import { OracleClientService } from '../oracle/oracle-client.service.js';
import { SubscriptionRepository } from '../subscription/subscription.repository.js';
import type { CounterpartyInput, SignableInput } from '../relay/mutual-consent-builder.js';
import type { PullExecutorConfig } from './pull-executor.service.js';

/** Thrown when a fresh oracle message is unavailable — the caller retries. */
export class OracleActionDeferredError extends Error {
  constructor(
    readonly subscriptionId: string,
    readonly action: 'withdraw' | 'reactivate' | 'migrate',
    readonly reason: string,
  ) {
    super(`oracle ${action} deferred for ${subscriptionId}: ${reason}`);
    this.name = 'OracleActionDeferredError';
  }
}

export interface BuildOracleWithdrawOptions {
  /** Unix seconds "now" — becomes the tx nLockTime. */
  now: number;
  /**
   * The supporter's presence UTXO (P2PKH, no key held). The covenant requires
   * `isPresent(supporterPkh)`; the server assembles an unsigned placeholder and
   * the supporter signs client-side in production.
   */
  supporterInput?: CounterpartyInput;
  /** Fee rate in sats/byte for the BCH change output (default 1). */
  feeRate?: number;
}

export interface BuiltOracleWithdraw {
  /**
   * The built tx hex. It carries a correctly-sized **placeholder** P2PKH unlocker
   * for the supporter presence input — a template, **not valid to broadcast**
   * until the client signs the `signableInputs`.
   */
  hex: string;
  /** The txid the transaction will have once broadcast. */
  txid: string;
  /** Gross paid to the supportee (`m · grossPerPeriod`). */
  gross: bigint;
  /** Service fee (`m · perPeriodFee(grossPerPeriod)`). */
  fee: bigint;
  /** Sats reclaimed by the supporter (`balance − gross − retained`). */
  payout: bigint;
  /** Sats retained by the covenant (`(owedPreSettle − gross) + DUST`). */
  retained: bigint;
  /** The state written back on the state output. */
  nextState: OracleNs.OracleState;
  /** The supporter presence input the client must sign (P2PKH). */
  signableInputs: SignableInput[];
}

export interface BuildOracleReactivateOptions {
  /** Unix seconds "now" — becomes the tx nLockTime. */
  now: number;
  /** The fresh-funding UTXO(s) the supporter contributes (P2PKH, no key held). */
  fundingInputs: CounterpartyInput[];
  /** Fee rate in sats/byte for the BCH change output (default 1). */
  feeRate?: number;
}

export interface BuiltOracleReactivate {
  /**
   * The built tx hex. It carries correctly-sized **placeholder** P2PKH unlockers
   * for the funding input(s) — a template, **not valid to broadcast** until the
   * client signs the `signableInputs`.
   */
  hex: string;
  /** The txid the transaction will have once broadcast. */
  txid: string;
  /** Sats paid to the supportee (`spendable + prepaid − fee`). */
  supporteeAmount: bigint;
  /** Service fee. */
  fee: bigint;
  /** The fresh funding locked into the covenant (`newFunds`). */
  newFunds: bigint;
  /** The state written back on the state output. */
  nextState: OracleNs.OracleState;
  /** The funding input(s) the client must sign (P2PKH). */
  signableInputs: SignableInput[];
}

/**
 * Build options for `migrate` (oracle-key swap).
 *
 * `mode: 'mutual'` requires both the supporter and the supportee present (both
 * supply a P2PKH presence UTXO; the client signs them) and a fresh signed oracle
 * message for the CURRENT oracle. `mode: 'service'` needs only the platform
 * service presence (the server holds the service key) and **no oracle message** —
 * it prices at the stored `lastRate` (the dead-oracle recovery path).
 */
export interface BuildOracleMigrateOptions {
  /** Unix seconds "now" — becomes the tx nLockTime. */
  now: number;
  /** The replacement oracle public key (hex, compressed) — swapped in. */
  newOraclePubkey: string;
  /** `mutual` (supporter + supportee) or `service` (platform-only recovery). */
  mode: 'mutual' | 'service';
  /** Mutual only: the supporter's presence UTXO (P2PKH, no key held). */
  supporterInput?: CounterpartyInput;
  /** Mutual only: the supportee's presence UTXO (P2PKH, no key held). */
  counterpartyInput?: CounterpartyInput;
  /** Fee rate in sats/byte for the BCH change output (default 1). */
  feeRate?: number;
}

export interface BuiltOracleMigrate {
  /**
   * The built tx hex. In `mutual` mode it carries correctly-sized **placeholder**
   * P2PKH unlockers for the two presence inputs — a template, **not valid to
   * broadcast** until the client signs the `signableInputs`. In `service` mode the
   * service key already signed and the hex is directly broadcastable.
   */
  hex: string;
  /** The txid the transaction will have once broadcast. */
  txid: string;
  /** Gross paid to the supportee (`m · grossPerPeriod`). */
  gross: bigint;
  /** Service fee (`m · perPeriodFee(grossPerPeriod)`). */
  fee: bigint;
  /** `hash160(newOraclePubkey)` — the key written into the commitment. */
  newOraclePkHash: string;
  /** The state written back on the state output. */
  nextState: OracleNs.OracleState;
  /** The presence input(s) the client must sign (P2PKH); empty in `service` mode. */
  signableInputs: SignableInput[];
}

@Injectable()
export class OracleActionsService {
  private readonly logger = new Logger(OracleActionsService.name);
  /** In-process serialization: `category:action` → the tail of its chain. */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    @Inject('PULL_NETWORK_PROVIDER') private readonly provider: NetworkProvider,
    private readonly oracleClient: OracleClientService,
    @Optional() @Inject('PULL_EXECUTOR_CONFIG') private readonly config?: PullExecutorConfig,
    @Optional() private readonly subscriptions?: SubscriptionRepository,
  ) {}

  /**
   * Build the signed `withdraw` transaction for a subscription.
   *
   * Reads the covenant's single UTXO, decodes the commitment, fetches a fresh
   * signed oracle message and settles against it. Throws
   * `OracleActionDeferredError` when no fresh message is available.
   */
  async buildOracleWithdraw(
    sub: Subscription,
    options: BuildOracleWithdrawOptions,
  ): Promise<BuiltOracleWithdraw> {
    const now = options.now;
    const feeRate = options.feeRate ?? 1;
    const covenantAddress = sub.covenantAddress();

    const utxos = await this.provider.getUtxosForLockingBytecode(covenantAddress);
    const stateUtxo = utxos.find(
      (u) => u.token?.category === sub.stateCategory && u.token.nft !== undefined,
    );
    if (stateUtxo === undefined) {
      throw new Error(`oracle withdraw: no state UTXO for ${sub.stateCategory}`);
    }

    const state = oracle.decodeCommitment(hexToBin(stateUtxo.token!.nft!.commitment));
    const balance = stateUtxo.satoshis;

    const { price, fresh } = await this.freshPrice(sub, state, now, 'withdraw');
    const settlement = oracle.settleOracle(state, balance - oracle.DUST, now, price);

    const nextState: OracleNs.OracleState = {
      ...oracle.promoted(state),
      lastPeriodTime: settlement.newLastPeriodTime,
      lastRate: settlement.newLastRate,
    };

    // The covenant retains `(owedPreSettle − gross) + DUST`; the supporter takes
    // the rest. `spendable ≥ owedPreSettle` is a contract gate — surface it here
    // with a clear error rather than building a doomed tx.
    const retained = settlement.owedPreSettle - settlement.gross + oracle.DUST;
    const payout = balance - settlement.gross - retained;
    if (payout < 0n) {
      throw new Error(
        `oracle withdraw: balance ${balance} is below the reserved amount for ${sub.stateCategory}`,
      );
    }

    const contract = this.contract(sub.stateCategory);
    const unlock = contract.unlock as unknown as Record<string, (...args: any[]) => Unlocker>;
    const covenantLock = hexToBin(contract.lockingBytecode);

    const tx = new TransactionBuilder({ provider: this.provider }).setLocktime(now);
    tx.addInput(stateUtxo, unlock['withdraw']!(fresh.sig, fresh.message, fresh.pubkey));
    const payments: Output[] =
      settlement.gross > 0n
        ? [
            { to: p2pkhLock(state.supporteePkh), amount: settlement.paid },
            { to: p2pkhLock(state.servicePkh), amount: settlement.fee },
          ]
        : [];
    const stateOutput: Output = {
      to: covenantLock,
      amount: retained,
      token: {
        category: sub.stateCategory,
        amount: 0n,
        nft: { capability: 'mutable', commitment: binToHex(oracle.encodeCommitment(nextState)) },
      },
    };
    const payoutOutput: Output = { to: p2pkhLock(state.supporterPkh), amount: payout };
    tx.addOutputs([...payments, stateOutput, payoutOutput]);

    // Supporter presence input (the contract's `isPresent(supporterPkh)`). The
    // service key funds the fee and receives the change; the supporter's own
    // P2PKH UTXO supplies the presence the covenant requires. The supporter signs
    // this input client-side in production (the server holds no party key); the
    // executor assembles an unsigned placeholder and returns it in
    // `signableInputs` for the client to sign before broadcast.
    const signableInputs: SignableInput[] = [];
    if (options.supporterInput !== undefined) {
      const index = tx.inputs.length;
      tx.addInput(toSpendable(options.supporterInput), unlockPresence(options.supporterInput));
      signableInputs.push({
        index,
        lockingBytecode: options.supporterInput.lockingBytecode.toLowerCase(),
        satoshis: options.supporterInput.satoshis.toString(),
      });
    }
    const serviceLock = this.serviceLock();
    const serviceUtxo = await this.serviceUtxo(serviceLock);
    tx.addInput(serviceUtxo, this.serviceTemplate().unlockP2PKH());
    tx.addBchChangeOutputIfNeeded({ to: serviceLock, feeRate });

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
    };
  }

  /**
   * Build the `reactivate` transaction for a paused subscription.
   *
   * The fresh funding is carried by the caller-supplied P2PKH UTXO(s), assembled
   * as unsigned placeholders (the client signs them). Throws
   * `OracleActionDeferredError` when no fresh oracle message is available, and a
   * plain error when the sub is not paused or the funding is short.
   */
  async buildOracleReactivate(
    sub: Subscription,
    options: BuildOracleReactivateOptions,
  ): Promise<BuiltOracleReactivate> {
    const now = options.now;
    const feeRate = options.feeRate ?? 1;
    const covenantAddress = sub.covenantAddress();

    const utxos = await this.provider.getUtxosForLockingBytecode(covenantAddress);
    const stateUtxo = utxos.find(
      (u) => u.token?.category === sub.stateCategory && u.token.nft !== undefined,
    );
    if (stateUtxo === undefined) {
      throw new Error(`oracle reactivate: no state UTXO for ${sub.stateCategory}`);
    }

    const state = oracle.decodeCommitment(hexToBin(stateUtxo.token!.nft!.commitment));
    const balance = stateUtxo.satoshis;

    const { price, fresh } = await this.freshPrice(sub, state, now, 'reactivate');

    const gppOld = oracle.grossPerPeriod(state.amount, price);
    const gppNew = oracle.grossPerPeriod(state.amountNext, price);
    const n = BigInt(Math.floor((now - state.lastPeriodTime) / state.period));
    const payable = gppOld * n;
    // Paused ⟺ balance < payable (the contract's own gate).
    if (balance >= payable) {
      throw new Error(`oracle reactivate: rejected while funded for ${sub.stateCategory}`);
    }

    const spendable = balance - oracle.DUST;
    const m = spendable / gppOld;
    const mode = state.mode;
    const fee = m * oracle.perPeriodFee(gppOld) + (mode === 1 ? 0n : oracle.perPeriodFee(gppNew));
    const supporteeAmount = spendable + (mode === 1 ? 0n : gppNew) - fee;

    const newFunds = options.fundingInputs.reduce((sum, i) => sum + i.satoshis, 0n);
    if (newFunds < gppNew) {
      throw new Error(
        `oracle reactivate: at least one fresh period (${gppNew} sats) must be funded for ${sub.stateCategory}`,
      );
    }

    const newAnchor = state.lastPeriodTime + Number(n) * state.period;
    const nextState: OracleNs.OracleState = {
      ...state,
      amount: state.amountNext,
      period: state.periodNext,
      lastPeriodTime: newAnchor,
      lastRate: Number(price),
    };
    const contractBalance = mode === 1 ? balance + newFunds : balance + newFunds - gppNew;

    const contract = this.contract(sub.stateCategory);
    const unlock = contract.unlock as unknown as Record<string, (...args: any[]) => Unlocker>;
    const covenantLock = hexToBin(contract.lockingBytecode);

    const tx = new TransactionBuilder({ provider: this.provider }).setLocktime(now);
    tx.addInput(stateUtxo, unlock['reactivate']!(fresh.sig, fresh.message, fresh.pubkey));
    // The funding input(s): the caller's P2PKH UTXO(s), assembled as unsigned
    // placeholders. The client signs them before broadcast (the relay model).
    const signableInputs: SignableInput[] = [];
    for (const funding of options.fundingInputs) {
      const index = tx.inputs.length;
      tx.addInput(toSpendable(funding), unlockPresence(funding));
      signableInputs.push({
        index,
        lockingBytecode: funding.lockingBytecode.toLowerCase(),
        satoshis: funding.satoshis.toString(),
      });
    }

    const outputs: Output[] = [];
    if (supporteeAmount > 0n) outputs.push({ to: p2pkhLock(state.supporteePkh), amount: supporteeAmount });
    if (fee > 0n) outputs.push({ to: p2pkhLock(state.servicePkh), amount: fee });
    outputs.push({
      to: covenantLock,
      amount: contractBalance,
      token: {
        category: sub.stateCategory,
        amount: 0n,
        nft: { capability: 'mutable', commitment: binToHex(oracle.encodeCommitment(nextState)) },
      },
    });
    tx.addOutputs(outputs);

    // A separate fee-paying input (does not count toward `newFunds` — the contract
    // reads `newFunds` from the state output, not from all inputs). The service
    // key pays the fee and receives the BCH change.
    const serviceLock = this.serviceLock();
    const serviceUtxo = await this.serviceUtxo(serviceLock);
    tx.addInput(serviceUtxo, this.serviceTemplate().unlockP2PKH());
    tx.addBchChangeOutputIfNeeded({ to: serviceLock, feeRate });

    const hex = tx.build();
    return {
      hex,
      txid: txidOf(hex),
      supporteeAmount,
      fee,
      newFunds,
      nextState,
      signableInputs,
    };
  }

  async broadcastOracleWithdraw(
    sub: Subscription,
    signedHex: string,
    now: number,
  ): Promise<{ broadcast: boolean; txid: string }> {
    return this.serializedBroadcast(sub, signedHex, now, 'withdraw');
  }

  /**
   * Build the `migrate` transaction (oracle-key swap).
   *
   * `mode: 'service'` is the **dead-oracle recovery path**: no oracle fetch, the
   * price is the stored `lastRate`, and the platform service presence authorizes
   * it (the server holds the service key, so the tx is directly broadcastable).
   * `mode: 'mutual'` requires a fresh signed message for the CURRENT oracle and
   * both parties' presence inputs (unsigned placeholders the client signs).
   *
   * Both settle (`settleOracle`) and write `oraclePkHash = hash160(newOraclePubkey)`.
   * Mutual refreshes `lastRate` to the verified price; service carries it through.
   */
  async buildOracleMigrate(
    sub: Subscription,
    options: BuildOracleMigrateOptions,
  ): Promise<BuiltOracleMigrate> {
    const now = options.now;
    const feeRate = options.feeRate ?? 1;
    const covenantAddress = sub.covenantAddress();

    const utxos = await this.provider.getUtxosForLockingBytecode(covenantAddress);
    const stateUtxo = utxos.find(
      (u) => u.token?.category === sub.stateCategory && u.token.nft !== undefined,
    );
    if (stateUtxo === undefined) {
      throw new Error(`oracle migrate: no state UTXO for ${sub.stateCategory}`);
    }

    const state = oracle.decodeCommitment(hexToBin(stateUtxo.token!.nft!.commitment));
    const balance = stateUtxo.satoshis;

    const newOraclePkHash = binToHex(hash160(hexToBin(options.newOraclePubkey)));
    const mutual = options.mode === 'mutual';
    if (mutual && (options.supporterInput === undefined || options.counterpartyInput === undefined)) {
      throw new Error(`oracle migrate: mutual mode requires a supporter and counterparty input`);
    }

    // Mutual prices at the CURRENT oracle (a fresh message is required); service
    // prices at the stored `lastRate` and needs no message (dead-oracle recovery).
    let price: bigint;
    let args: { sig: Uint8Array; message: Uint8Array; pubkey: Uint8Array };
    if (mutual) {
      const fresh = await this.freshPrice(sub, state, now, 'migrate');
      price = fresh.price;
      args = fresh.fresh;
    } else {
      price = BigInt(state.lastRate);
      // The contract's `verifyOracle` is skipped on the service path, so the
      // message/sig/pubkey args are never read — correctly-typed dummies satisfy
      // CashScript's ABI encoder (a datasig is 64 B, a pubkey 33 B).
      args = {
        sig: new Uint8Array(64),
        message: new Uint8Array(16),
        pubkey: new Uint8Array(33),
      };
    }

    const settlement = oracle.settleOracle(state, balance - oracle.DUST, now, price);
    const nextState: OracleNs.OracleState = {
      ...state,
      lastPeriodTime: settlement.newLastPeriodTime,
      oraclePkHash: hexToBin(newOraclePkHash),
      lastRate: mutual ? Number(price) : state.lastRate,
    };

    const contract = this.contract(sub.stateCategory);
    const unlock = contract.unlock as unknown as Record<string, (...args: any[]) => Unlocker>;
    const covenantLock = hexToBin(contract.lockingBytecode);

    const tx = new TransactionBuilder({ provider: this.provider }).setLocktime(now);
    tx.addInput(
      stateUtxo,
      unlock['migrate']!(hexToBin(newOraclePkHash), args.sig, args.message, args.pubkey),
    );

    const payments: Output[] =
      settlement.gross > 0n
        ? [
            { to: p2pkhLock(state.supporteePkh), amount: settlement.paid },
            { to: p2pkhLock(state.servicePkh), amount: settlement.fee },
          ]
        : [];
    const stateOutput: Output = {
      to: covenantLock,
      amount: balance - settlement.gross,
      token: {
        category: sub.stateCategory,
        amount: 0n,
        nft: { capability: 'mutable', commitment: binToHex(oracle.encodeCommitment(nextState)) },
      },
    };
    tx.addOutputs([...payments, stateOutput]);

    // Mutual: both parties' presence inputs (unsigned placeholders; the client
    // signs). Service: the platform service presence (the server signs).
    const signableInputs: SignableInput[] = [];
    if (mutual) {
      for (const input of [options.supporterInput!, options.counterpartyInput!]) {
        const index = tx.inputs.length;
        tx.addInput(toSpendable(input), unlockPresence(input));
        signableInputs.push({
          index,
          lockingBytecode: input.lockingBytecode.toLowerCase(),
          satoshis: input.satoshis.toString(),
        });
      }
      const serviceLock = this.serviceLock();
      const serviceUtxo = await this.serviceUtxo(serviceLock);
      tx.addInput(serviceUtxo, this.serviceTemplate().unlockP2PKH());
      tx.addBchChangeOutputIfNeeded({ to: serviceLock, feeRate });
    } else {
      const serviceLock = this.serviceLock();
      const serviceUtxo = await this.serviceUtxo(serviceLock);
      tx.addInput(serviceUtxo, this.serviceTemplate().unlockP2PKH());
      tx.addBchChangeOutputIfNeeded({ to: serviceLock, feeRate });
    }

    const hex = tx.build();
    return {
      hex,
      txid: txidOf(hex),
      gross: settlement.gross,
      fee: settlement.fee,
      newOraclePkHash,
      nextState,
      signableInputs,
    };
  }

  /**
   * Build (service mode) and broadcast the oracle-key swap directly — the
   * **dead-oracle recovery path**. The server holds the service key, so no party
   * key is needed. On success the subscription row is updated to the new oracle.
   */
  async executeOracleMigrateService(
    sub: Subscription,
    options: { now: number; newOraclePubkey: string; feeRate?: number },
  ): Promise<{ broadcast: boolean; txid: string; newOraclePkHash: string; gross: bigint; fee: bigint }> {
    const key = `${sub.stateCategory}:migrate`;
    const previous = this.inFlight.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      const built = await this.buildOracleMigrate(sub, {
        now: options.now,
        newOraclePubkey: options.newOraclePubkey,
        mode: 'service',
        feeRate: options.feeRate,
      });
      await this.verifySpendsCurrentState(sub, built.hex);
      const txid = await this.provider.sendRawTransaction(built.hex);
      this.logger.log(`oracle migrate (service) broadcast for ${sub.stateCategory}: ${txid}`);
      await this.updateOracleRow(sub, built.newOraclePkHash, options.newOraclePubkey);
      return {
        broadcast: true,
        txid,
        newOraclePkHash: built.newOraclePkHash,
        gross: built.gross,
        fee: built.fee,
      };
    });
    const chain = run.catch(() => undefined);
    this.inFlight.set(key, chain);
    void chain.finally(() => {
      if (this.inFlight.get(key) === chain) this.inFlight.delete(key);
    });
    return run;
  }

  /** Broadcast a client-signed mutual migrate (verified + relayed; never re-signs). */
  async broadcastOracleMigrate(
    sub: Subscription,
    signedHex: string,
    now: number,
  ): Promise<{ broadcast: boolean; txid: string }> {
    return this.serializedBroadcast(sub, signedHex, now, 'migrate');
  }

  /** Persist the swapped oracle key onto the subscription cache row. */
  private async updateOracleRow(
    sub: Subscription,
    oraclePkHash: string,
    oraclePubkey: string,
  ): Promise<void> {
    if (this.subscriptions === undefined) {
      this.logger.warn(`oracle migrate: no SubscriptionRepository wired; row not updated`);
      return;
    }
    await this.subscriptions.upsert({
      stateCategory: sub.stateCategory,
      stateOutpoint: sub.stateOutpoint,
      escrowOutpoint: sub.escrowOutpoint,
      assetType: sub.assetType,
      fundsCategory: sub.fundsCategory,
      mode: sub.mode,
      supporterPkh: sub.supporterPkh,
      supporteePkh: sub.supporteePkh,
      servicePkh: sub.servicePkh,
      amount: BigInt(sub.amount),
      amountNext: BigInt(sub.amountNext),
      period: sub.period,
      periodNext: sub.periodNext,
      lastPeriodTime: sub.lastPeriodTime,
      escrowBalance: BigInt(sub.escrowBalance),
      status: sub.status,
      nextPaymentAt: sub.nextPaymentAt,
      oraclePkHash,
      oraclePubkey,
      lastRate: sub.lastRate,
    });
  }

  /** Broadcast a client-signed reactivate (verified + relayed; never re-signs). */
  async broadcastOracleReactivate(
    sub: Subscription,
    signedHex: string,
    now: number,
  ): Promise<{ broadcast: boolean; txid: string }> {
    return this.serializedBroadcast(sub, signedHex, now, 'reactivate');
  }

  private serializedBroadcast(
    sub: Subscription,
    signedHex: string,
    now: number,
    action: 'withdraw' | 'reactivate' | 'migrate',
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
    action: 'withdraw' | 'reactivate' | 'migrate',
  ): Promise<{ broadcast: boolean; txid: string }> {
    await this.verifySpendsCurrentState(sub, signedHex);
    const txid = await this.provider.sendRawTransaction(signedHex);
    this.logger.log(`oracle ${action} broadcast for ${sub.stateCategory}: ${txid} at ${now}`);
    return { broadcast: true, txid };
  }

  /** Verify a client-signed tx spends the covenant's current state outpoint. */
  private async verifySpendsCurrentState(sub: Subscription, signedHex: string): Promise<void> {
    let decoded: ReturnType<typeof decodeTransaction>;
    try {
      decoded = decodeTransaction(hexToBin(signedHex));
    } catch {
      throw new Error(`oracle actions: signedHex does not decode`);
    }
    if (typeof decoded === 'string') throw new Error(`oracle actions: signedHex does not decode`);
    const utxos = await this.provider.getUtxosForLockingBytecode(sub.covenantAddress());
    const stateUtxo = utxos.find(
      (u) => u.token?.category === sub.stateCategory && u.token.nft !== undefined,
    );
    if (stateUtxo === undefined) throw new Error(`oracle actions: no current state UTXO`);
    const spends = decoded.inputs.some(
      (i) => binToHex(i.outpointTransactionHash) === stateUtxo.txid && i.outpointIndex === stateUtxo.vout,
    );
    if (!spends) throw new Error(`oracle actions: tx does not spend the current state outpoint`);
  }

  /**
   * Fetch a fresh signed oracle message and return the price + the args the
   * unlocker needs.
   *
   * The pubkey is resolved from the subscription row and re-verified against the
   * live commitment (the commitment carries only `hash160(oraclePk)`). A missing
   * pubkey or a non-fresh message throws `OracleActionDeferredError` — the caller
   * retries next cycle and never broadcasts a stale/partial tx.
   *
   * The message is **returned** (not stashed in a shared map), so two concurrent
   * builds for the same subscription can never read each other's message.
   */
  private async freshPrice(
    sub: Subscription,
    state: OracleNs.OracleState,
    now: number,
    action: 'withdraw' | 'reactivate' | 'migrate',
  ): Promise<{
    price: bigint;
    fresh: { sig: Uint8Array; message: Uint8Array; pubkey: Uint8Array };
  }> {
    const pubkey = this.resolvePubkey(sub, state, action);
    const fresh = await this.oracleClient.fetchFresh(toHex(state.oraclePkHash), pubkey, {
      now,
      lastPeriodTime: state.lastPeriodTime,
      period: state.period,
    });
    if (!fresh.fresh) {
      throw new OracleActionDeferredError(sub.stateCategory, action, fresh.reason);
    }
    return {
      price: BigInt(fresh.message.message.price),
      fresh: {
        sig: hexToBin(fresh.message.signature),
        message: hexToBin(fresh.message.messageHex),
        pubkey: hexToBin(fresh.message.pubkey),
      },
    };
  }

  /** Resolve + re-verify the oracle pubkey against the live commitment. */
  private resolvePubkey(
    sub: Subscription,
    state: OracleNs.OracleState,
    action: 'withdraw' | 'reactivate' | 'migrate',
  ): string {
    if (sub.oraclePubkey === null || sub.oraclePubkey === undefined || sub.oraclePubkey === '') {
      throw new OracleActionDeferredError(sub.stateCategory, action, 'pubkey-unresolvable');
    }
    const pubkey = sub.oraclePubkey.toLowerCase();
    if (binToHex(hash160(hexToBin(pubkey))) !== binToHex(state.oraclePkHash)) {
      throw new OracleActionDeferredError(sub.stateCategory, action, 'pubkey-mismatch');
    }
    return pubkey;
  }

  private contract(stateCategory: string): Contract {
    return new Contract(artifact, [toInternalCategory(stateCategory)], {
      provider: this.provider,
      contractType: 'p2sh32',
    });
  }

  private serviceTemplate(): SignatureTemplate {
    if (this.config?.serviceKey === undefined || this.config.serviceKey === '') {
      throw new Error('oracle actions: SERVICE_KEY is not configured');
    }
    return new SignatureTemplate(hexToBin(this.config.serviceKey));
  }

  private serviceLock(): Uint8Array {
    if (this.config?.servicePkh === undefined || this.config.servicePkh === '') {
      throw new Error('oracle actions: SERVICE_PKH is not configured');
    }
    return p2pkhLock(hexToBin(this.config.servicePkh));
  }

  private async serviceUtxo(lock: Uint8Array): Promise<SpendableUtxo> {
    const utxos = await this.provider.getUtxosForLockingBytecode(lock);
    if (utxos.length === 0) {
      throw new Error('oracle actions: no service UTXOs to pay the fee');
    }
    return utxos.reduce((best, u) => (u.satoshis > best.satoshis ? u : best));
  }
}

/** A P2PKH locking bytecode for a 20-byte pkh. */
function p2pkhLock(pkh: Uint8Array): Uint8Array {
  return Uint8Array.from([0x76, 0xa9, 0x14, ...pkh, 0x88, 0xac]);
}

/** The unlocker for a party's funding input (unsigned placeholder; client signs). */
function unlockPresence(input: CounterpartyInput): Unlocker {
  return {
    // 107 B = 1 (sig push) + 72 (DER sig + sighash) + 1 (pubkey push) + 33 (pubkey).
    generateUnlockingBytecode: () => new Uint8Array(107),
    placeholder: true,
    lockingBytecode: input.lockingBytecode.toLowerCase(),
  } as unknown as Unlocker;
}

/** Map an API-supplied funding input to a CashScript spendable UTXO. */
function toSpendable(input: CounterpartyInput): SpendableUtxo {
  return {
    txid: input.txid,
    vout: input.vout,
    satoshis: input.satoshis,
    lockingBytecode: input.lockingBytecode.toLowerCase(),
  } as unknown as SpendableUtxo;
}

/** The txid of a raw transaction hex (double-sha256, reversed). */
function txidOf(hex: string): string {
  const bytes = hexToBin(hex);
  const digest = sha256.hash(sha256.hash(bytes));
  return Buffer.from(Uint8Array.from([...digest].reverse())).toString('hex');
}

const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
