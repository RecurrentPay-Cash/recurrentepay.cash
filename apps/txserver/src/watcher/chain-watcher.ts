/**
 * Chain-watcher interface (task 8.2, Slice 1).
 *
 * The txserver watches the covenant address's UTXOs and reacts on **0-conf**
 * (mempool) acceptance, not block confirmation. Slice 1 ships the interface and
 * an in-memory mock so the derived-state engine and cycle logic are unit-testable
 * without a live node; the real Electrum/Fulcrum client is Slice 2.
 */
import type { WatchedUtxo as SharedWatchedUtxo } from 'shared';

/**
 * A UTXO as the watcher reports it. Extends the shared `WatchedUtxo` with the
 * locking bytecode the covenant-lock check needs — one definition of the concept,
 * kept in sync by the type checker instead of by hand.
 */
export interface WatchedUtxo extends SharedWatchedUtxo {
  /** Locking bytecode hex (used for the covenant-lock check). */
  lockingBytecode?: string;
}

/** A change notification for a watched address. */
export interface ChainChange {
  /** The watched address (locking bytecode hex) that changed. */
  subject: string;
  /** The current UTXO set for the subject. */
  utxos: WatchedUtxo[];
}

export type ChainChangeListener = (change: ChainChange) => void;

export interface ChainWatcher {
  /**
   * Subscribe to a covenant **address** (locking bytecode hex). The watch is
   * address-scoped, never keyed on an outpoint txid: a stray UTXO arriving at the
   * address in its own transaction must be observed (spec § Strays are handled
   * regardless of source). A `txid:vout` subject is accepted for compatibility but
   * the txid is discarded and the watch is keyed on the address.
   */
  subscribe(address: string): Promise<void>;
  /** Unsubscribe from a covenant address (locking bytecode hex). */
  unsubscribe(address: string): Promise<void>;
  /** The UTXO set for an address (locking bytecode hex). */
  getUtxos(address: string): Promise<WatchedUtxo[]>;
  /** The raw transaction hex for a txid. */
  getRawTx(txid: string): Promise<string>;
  /** Register a change callback; returns an unsubscribe function. */
  onChange(cb: ChainChangeListener): () => void;
}

/** DI token for the `ChainWatcher` implementation. */
export const CHAIN_WATCHER = Symbol('CHAIN_WATCHER');
