/**
 * Challenge issuance (Slice 4, spec § API for web app — "wallet signature over a
 * server-issued challenge").
 *
 * Two proof paths share one challenge store:
 *
 *   1. **Message signature** (original): the server issues a random nonce bound
 *      to a pkh; the wallet signs `sha256(challenge)` with Schnorr and returns
 *      `(pubkey, signature, challenge)`. `SessionService.verify` derives the pkh
 *      from the pubkey and checks it matches before issuing a session.
 *
 *   2. **Signed transaction** (handoff §2 — WizardConnect signs transactions, not
 *      messages): the server selects a spendable UTXO at one of the caller's
 *      addresses, builds an unsigned challenge tx (input 0 spends that UTXO;
 *      output 0 pays the same pkh; an `OP_RETURN` output carries the nonce), and
 *      returns it. The wallet signs input 0 and returns the signed tx (never
 *      broadcast). `SessionService.verifyTransaction` checks the signature over
 *      the BCH signing serialization.
 *
 * Both are single-use (consumed on a successful verify) and TTL'd.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  binToHex,
  encodeAuthenticationInstructions,
  encodeTransaction,
  hexToBin,
  cashAddressToLockingBytecode,
  OpcodesBch,
} from '@bitauth/libauth';
import { CHAIN_WATCHER, type ChainWatcher, type WatchedUtxo } from '../watcher/chain-watcher.js';

/** A challenge issued to a party (message-signature path). */
export interface Challenge {
  /** The nonce the wallet must sign (hex). */
  challenge: string;
  /** Unix seconds the challenge expires. */
  expiresAt: number;
}

/** A source output as WizardConnect's `signTransaction` expects it (positional). */
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

/** A challenge **transaction** issued to a party (signed-tx path). */
export interface ChallengeTx {
  /** The nonce bound into the tx's `OP_RETURN`. */
  challenge: string;
  /** The unsigned challenge tx hex (input 0 placeholder; never broadcast). */
  unsignedHex: string;
  /** Positional source outputs (one per input). */
  sourceOutputs: SourceOutput[];
  /** The input the wallet must sign (always 0 here). */
  inputIndex: number;
  /** The HD index of the chosen UTXO (from the caller's `addresses` list). */
  addressIndex: number;
  /** Unix seconds the challenge expires. */
  expiresAt: number;
}

/** An address + HD index the caller offers for UTXO selection. */
export interface ChallengeAddress {
  address: string;
  index: number;
}

/** Default challenge lifetime in seconds (5 minutes). */
export const CHALLENGE_TTL_SECONDS = 300;

/** The fee (sats) deducted from the challenge tx's output 0. */
export const CHALLENGE_FEE_SATS = 1000n;

/** A stored challenge record — the message path stores only the nonce; the tx
 * path also binds the outpoint + address index so `verifyTransaction` can check
 * the signed tx spends the same UTXO. */
interface StoredChallenge {
  challenge: string;
  expiresAt: number;
  /** Present for the signed-transaction path. */
  tx?: {
    outpointTransactionHash: string;
    outpointIndex: number;
    addressIndex: number;
    sourceOutput: SourceOutput;
    /** The P2PKH locking bytecode of the spent UTXO (`76a914…88ac`). */
    lockingBytecode: string;
  };
}

@Injectable()
export class ChallengeService {
  /** pkh → the outstanding challenge (single-use). */
  private readonly issued = new Map<string, StoredChallenge>();

  constructor(@Optional() @Inject(CHAIN_WATCHER) private readonly watcher?: ChainWatcher) {}

  /** Issue (and store) a fresh message-signature challenge for a pkh. */
  issue(pkh: string, now: number = Math.floor(Date.now() / 1000)): Challenge {
    this.evictExpired(now);
    const challenge: Challenge = {
      challenge: randomNonce(),
      expiresAt: now + CHALLENGE_TTL_SECONDS,
    };
    this.issued.set(pkh, challenge);
    return challenge;
  }

  /**
   * Issue a challenge **transaction** for a pkh: select a spendable UTXO at one
   * of the caller's addresses, build the unsigned tx, and store the record bound
   * to the chosen outpoint. Returns `null` when no UTXO is spendable (the caller
   * maps that to `409 no-spendable-utxo`).
   */
  async issueTransaction(
    pkh: string,
    addresses: readonly ChallengeAddress[],
    now: number = Math.floor(Date.now() / 1000),
  ): Promise<ChallengeTx | null> {
    if (this.watcher === undefined) return null;
    this.evictExpired(now);

    const chosen = await this.selectUtxo(addresses);
    if (chosen === null) return null;

    const challenge = randomNonce();
    const sourceOutput: SourceOutput = {
      outpointTransactionHash: chosen.utxo.txid,
      outpointIndex: chosen.utxo.vout,
      unlockingBytecode: '',
      valueSatoshis: chosen.utxo.satoshis.toString(),
      ...(chosen.utxo.category !== undefined && {
        token: {
          category: chosen.utxo.category,
          amount: (chosen.utxo.amount ?? 0n).toString(),
          ...(chosen.utxo.nftCapability !== undefined && {
            nft: {
              capability: chosen.utxo.nftCapability,
              commitment: chosen.utxo.commitment ?? '',
            },
          }),
        },
      }),
    };

    const unsignedHex = buildChallengeTx(chosen.lockingBytecode, sourceOutput, challenge);
    const record: StoredChallenge = {
      challenge,
      expiresAt: now + CHALLENGE_TTL_SECONDS,
      tx: {
        outpointTransactionHash: chosen.utxo.txid,
        outpointIndex: chosen.utxo.vout,
        addressIndex: chosen.addressIndex,
        sourceOutput,
        lockingBytecode: chosen.lockingBytecode,
      },
    };
    this.issued.set(pkh, record);

    return {
      challenge,
      unsignedHex,
      sourceOutputs: [sourceOutput],
      inputIndex: 0,
      addressIndex: chosen.addressIndex,
      expiresAt: record.expiresAt,
    };
  }

  /**
   * Consume the outstanding challenge for a pkh. Returns the stored record when
   * it matches and has not expired, otherwise `null`. The entry is removed either
   * way, so a replayed proof cannot succeed.
   */
  consume(
    pkh: string,
    challenge: string,
    now: number = Math.floor(Date.now() / 1000),
  ): StoredChallenge | null {
    const stored = this.issued.get(pkh);
    this.issued.delete(pkh);
    if (stored === undefined || stored.challenge !== challenge) return null;
    if (stored.expiresAt < now) return null;
    return stored;
  }

  /** Select the first spendable UTXO across the offered addresses. */
  private async selectUtxo(
    addresses: readonly ChallengeAddress[],
  ): Promise<{ utxo: WatchedUtxo; addressIndex: number; lockingBytecode: string } | null> {
    for (const { address, index } of addresses) {
      const lockingBytecode = toLockingBytecode(address);
      if (lockingBytecode === null) continue;
      const utxos = await this.watcher!.getUtxos(lockingBytecode);
      const spendable = utxos.find((u) => u.satoshis > CHALLENGE_FEE_SATS);
      if (spendable !== undefined) {
        return { utxo: spendable, addressIndex: index, lockingBytecode };
      }
    }
    return null;
  }

  /** Drop expired challenges so a long-running process does not accumulate them. */
  private evictExpired(now: number): void {
    for (const [pkh, entry] of this.issued) {
      if (entry.expiresAt < now) this.issued.delete(pkh);
    }
  }
}

/** A 32-byte random nonce (hex). */
function randomNonce(): string {
  return binToHex(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * Resolve an address (CashAddress or a raw locking-bytecode hex) to its locking
 * bytecode hex. Returns `null` when it is neither.
 */
function toLockingBytecode(address: string): string | null {
  if (/^[0-9a-f]+$/i.test(address) && address.length % 2 === 0) {
    return address.toLowerCase();
  }
  const decoded = cashAddressToLockingBytecode(address);
  if (typeof decoded === 'string') return null;
  return binToHex(decoded.bytecode);
}

/**
 * Build the unsigned challenge tx.
 *
 *   input 0  = the P2PKH UTXO (correctly-sized 107-byte placeholder unlocker;
 *              the wallet replaces it when signing — never broadcast)
 *   output 0 = the same pkh, `value − fee`
 *   output 1 = `OP_RETURN` carrying the 32-byte nonce
 *   nLockTime = 0
 */
function buildChallengeTx(lockingBytecode: string, source: SourceOutput, nonce: string): string {
  const lock = hexToBin(lockingBytecode);
  const value = BigInt(source.valueSatoshis);
  const change = value - CHALLENGE_FEE_SATS;

  const tx = {
    version: 2,
    locktime: 0,
    inputs: [
      {
        outpointTransactionHash: hexToBin(source.outpointTransactionHash),
        outpointIndex: source.outpointIndex,
        sequenceNumber: 0xffffffff,
        // 107 B = 1 (sig push) + 72 (DER sig + sighash) + 1 (pubkey push) + 33 (pubkey).
        unlockingBytecode: new Uint8Array(107),
      },
    ],
    outputs: [
      { lockingBytecode: lock, valueSatoshis: change },
      {
        lockingBytecode: encodeAuthenticationInstructions([
          { opcode: OpcodesBch.OP_RETURN },
          { opcode: OpcodesBch.OP_PUSHBYTES_32, data: hexToBin(nonce) },
        ]),
        valueSatoshis: 0n,
      },
    ],
  };
  return binToHex(encodeTransaction(tx));
}
