/**
 * Oracle client (task 8.4, spec § Oracle integration (BCH subs), § Oracle message
 * freshness enforcement, § Service-migrate handling).
 *
 * Fetches the latest signed GP price message from the General Protocols relay
 * for a given oracle public key, validates it against the contract's freshness
 * bounds, and returns it only when it is safe to include in an **oracle-priced**
 * transaction. A stale, wrong-period, future-dated, metadata-only or
 * bad-signature message is never returned — the caller waits for a fresher one
 * (spec § Freshness window respected).
 *
 * The HTTP client is injectable (`ORACLE_HTTP_CLIENT`), so unit tests mock it and
 * never touch the network. The endpoint is the General Protocols oracle relay:
 * `GET {base}/oracleMessages?publicKey=<hex>&count=1`, returning
 * `{ oracleMessages: [{ message: <hex>, publicKey, signature }] }`.
 *
 * `oraclePkHash` → pubkey mapping: the commitment stores only `hash160(oraclePk)`
 * (20 B), so the caller resolves the pubkey and this client verifies
 * `hash160(pubkey) == oraclePkHash` before validating the message against that
 * key (spec § oraclePkHash to pubkey mapping).
 *
 * The message is Schnorr-signed over `sha256(message)` (the same preimage the
 * contract's `checkDataSig` uses), so this client verifies the signature before
 * trusting the payload — a bad relay cannot make the txserver build a doomed
 * transaction or write a bogus audit row.
 *
 * **Not here:** the BCH pull-transaction builder (Slice 3c). This service only
 * produces a validated message + the mapped pubkey for the builder to consume.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { hash160, hexToBin, binToHex, secp256k1 } from '@bitauth/libauth';
import { parseGpMessageHex, gpMessageDigest, type GpMessage } from './gp-message.js';
import { OracleMessageRepository } from './oracle-message.repository.js';

/**
 * Freshness bound: `now − messageTimestamp <= FRESHNESS`
 * (spec § Oracle message freshness enforcement).
 */
export const FRESHNESS_SECONDS = 3600;

/** A Schnorr signature is 64 bytes (128 hex chars). */
const SCHNORR_SIGNATURE_HEX = /^[0-9a-f]{128}$/i;

/** DI token for the injectable HTTP client (mocked in tests). */
export const ORACLE_HTTP_CLIENT = 'ORACLE_HTTP_CLIENT';

/** The minimal HTTP surface the client needs; `fetch` satisfies it. */
export interface OracleHttpClient {
  (url: string): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}

/** The shape of the relay's `oracleMessages` response (only the fields used). */
interface OracleMessagesResponse {
  oracleMessages?: Array<{ message?: string; publicKey?: string; signature?: string }>;
}

/** A validated oracle message ready for an oracle-priced transaction. */
export interface FreshOracleMessage {
  /** The oracle public key (hex) — the unlock arg the builder passes. */
  pubkey: string;
  /** The commitment's `oraclePkHash` (hex, 20 B) this message is for. */
  oraclePkHash: string;
  /** The parsed 16-byte message. */
  message: GpMessage;
  /** The raw message hex (what the contract's `checkDataSig` verifies). */
  messageHex: string;
  /** The Schnorr signature hex (passed to `checkDataSig`). */
  signature: string;
}

/** Why a fetch did not yield a usable message (the caller waits/retries). */
export type OracleFetchFailure =
  | 'unreachable'
  | 'no-message'
  | 'key-mismatch'
  | 'bad-signature'
  | 'future-dated'
  | 'stale'
  | 'wrong-period'
  | 'metadata';

export type OracleFetchResult =
  | { fresh: true; message: FreshOracleMessage }
  | { fresh: false; reason: OracleFetchFailure };

/** Inputs the freshness bounds need from the subscription's commitment. */
export interface FreshnessContext {
  /** Unix seconds "now" (the tx nLockTime). */
  now: number;
  /** The commitment's `lastPeriodTime`. */
  lastPeriodTime: number;
  /** The commitment's `period`. */
  period: number;
}

@Injectable()
export class OracleClientService {
  private readonly logger = new Logger(OracleClientService.name);

  constructor(
    @Inject(ORACLE_HTTP_CLIENT) private readonly http: OracleHttpClient,
    private readonly repository: OracleMessageRepository,
    private readonly baseUrl: string,
  ) {}

  /**
   * Fetch and validate the latest message for an oracle.
   *
   * Resolves the pubkey from `oraclePkHash` (the caller supplies the candidate
   * pubkey; this method verifies the hash matches), fetches, and enforces every
   * freshness bound. On any failure it returns `{ fresh: false }` — the caller
   * skips the oracle-priced transaction and retries next cycle (spec § Oracle
   * fetch failure degrades safely). It never throws on a network failure.
   */
  async fetchFresh(
    oraclePkHash: string,
    pubkey: string,
    context: FreshnessContext,
  ): Promise<OracleFetchResult> {
    // 1. oraclePkHash → pubkey mapping: the commitment carries only the hash, so
    //    the pubkey must hash back to it before we trust any message signed by it.
    if (binToHex(hash160(hexToBin(pubkey))) !== oraclePkHash.toLowerCase()) {
      return { fresh: false, reason: 'key-mismatch' };
    }

    // 2. Fetch the latest message. A network failure degrades safely.
    let raw: OracleMessagesResponse;
    try {
      const response = await this.http(this.messagesUrl(pubkey));
      if (!response.ok) return { fresh: false, reason: 'unreachable' };
      raw = (await response.json()) as OracleMessagesResponse;
    } catch (error) {
      this.logger.warn(`oracle fetch failed for ${oraclePkHash}: ${(error as Error).message}`);
      return { fresh: false, reason: 'unreachable' };
    }

    const entry = raw.oracleMessages?.[0];
    if (entry?.message === undefined || entry.signature === undefined) {
      return { fresh: false, reason: 'no-message' };
    }

    // 3. Parse + freshness bounds (spec § Oracle message freshness enforcement).
    let message: GpMessage;
    try {
      message = parseGpMessageHex(entry.message);
    } catch {
      return { fresh: false, reason: 'no-message' };
    }

    const failure = this.freshnessFailure(message, context);
    if (failure !== null) return { fresh: false, reason: failure };

    // 4. Verify the Schnorr signature before trusting the payload. The pubkey is
    //    already bound to the commitment (step 1); the signature binds the
    //    message to that key over `sha256(message)` — the same preimage the
    //    contract's `checkDataSig` uses. A malformed or forged signature is
    //    rejected here, so a bad relay cannot make us build a doomed tx.
    if (!this.verifySignature(entry.message, entry.signature, pubkey)) {
      return { fresh: false, reason: 'bad-signature' };
    }

    // 5. Persist to the audit table (the durable store; it is not a cache).
    const fresh: FreshOracleMessage = {
      pubkey,
      oraclePkHash,
      message,
      messageHex: entry.message,
      signature: entry.signature,
    };
    await this.repository.insert({
      source: this.sourceHost(),
      oraclePkHash,
      price: message.price,
      timestamp: message.messageTimestamp,
      messageSequence: message.messageSequence,
      contentSequence: message.contentSequence,
    });
    return { fresh: true, message: fresh };
  }

  /**
   * Verify the relay's Schnorr signature over the 16-byte message. Returns
   * `false` for a malformed signature (not 64 bytes / 128 hex) or a failed
   * verify — never throws.
   */
  private verifySignature(messageHex: string, signatureHex: string, pubkeyHex: string): boolean {
    if (!SCHNORR_SIGNATURE_HEX.test(signatureHex)) return false;
    try {
      const digest = gpMessageDigest(hexToBin(messageHex));
      return secp256k1.verifySignatureSchnorr(
        hexToBin(signatureHex),
        hexToBin(pubkeyHex),
        digest,
      );
    } catch {
      return false;
    }
  }

  /** The relay hostname, for the audit row's `source` (truthful, not hardcoded). */
  private sourceHost(): string {
    try {
      return new URL(this.baseUrl).host;
    } catch {
      return this.baseUrl;
    }
  }

  /**
   * Enforce the contract's bounds. Returns the failure reason, or `null` when the
   * message is fresh and from the current period.
   */
  private freshnessFailure(message: GpMessage, context: FreshnessContext): OracleFetchFailure | null {
    // Metadata-only messages carry no price.
    if (message.contentSequence <= 0) return 'metadata';
    // Never submit a future-dated message (the contract rejects `timestamp > now`).
    if (message.messageTimestamp > context.now) return 'future-dated';
    // Freshness window: a message older than FRESHNESS is stale regardless of
    // which period it falls in (the two bounds overlap when `period < FRESHNESS`).
    if (context.now - message.messageTimestamp > FRESHNESS_SECONDS) return 'stale';
    // The price must be from the current period: `timestamp >= lastPeriodTime + n·period`.
    // `n` is the elapsed-periods count at `now`; the current period began at
    // `lastPeriodTime + n·period`.
    const n = Math.floor((context.now - context.lastPeriodTime) / context.period);
    const currentPeriodStart = context.lastPeriodTime + n * context.period;
    if (message.messageTimestamp < currentPeriodStart) return 'wrong-period';
    return null;
  }

  /** The relay's message endpoint for an oracle pubkey. */
  private messagesUrl(pubkey: string): string {
    const base = this.baseUrl.replace(/\/+$/, '');
    return `${base}/oracleMessages?publicKey=${pubkey}&count=1`;
  }
}
