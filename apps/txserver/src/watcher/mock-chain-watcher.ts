import type { ChainChange, ChainChangeListener, ChainWatcher, WatchedUtxo } from './chain-watcher.js';

/**
 * In-memory `ChainWatcher` for tests and local dev (Slice 1).
 *
 * Holds a UTXO set per address and a raw-tx map; `emit()` lets a test simulate a
 * 0-conf broadcast. No network, no node.
 */
export class MockChainWatcher implements ChainWatcher {
  private readonly utxosByAddress = new Map<string, WatchedUtxo[]>();
  private readonly rawTxs = new Map<string, string>();
  private readonly subscriptions = new Set<string>();
  private readonly listeners = new Set<ChainChangeListener>();

  /** Set the UTXO set for an address (replaces any previous set). */
  setUtxos(address: string, utxos: WatchedUtxo[]): void {
    this.utxosByAddress.set(address, [...utxos]);
  }

  /** Register a raw transaction (for `getRawTx`). */
  setRawTx(txid: string, hex: string): void {
    this.rawTxs.set(txid, hex);
  }

  /** Simulate a 0-conf change: update the UTXO set and notify listeners. */
  emit(address: string, utxos: WatchedUtxo[]): void {
    this.setUtxos(address, utxos);
    const change: ChainChange = { subject: address, utxos: [...utxos] };
    for (const listener of this.listeners) listener(change);
  }

  async subscribe(outpoint: string): Promise<void> {
    this.subscriptions.add(outpoint);
  }

  async unsubscribe(outpoint: string): Promise<void> {
    this.subscriptions.delete(outpoint);
  }

  /** The outpoints currently subscribed (test helper). */
  subscribedOutpoints(): string[] {
    return [...this.subscriptions];
  }

  async getUtxos(address: string): Promise<WatchedUtxo[]> {
    return [...(this.utxosByAddress.get(address) ?? [])];
  }

  async getRawTx(txid: string): Promise<string> {
    const hex = this.rawTxs.get(txid);
    if (hex === undefined) throw new Error(`MockChainWatcher: unknown txid ${txid}`);
    return hex;
  }

  onChange(cb: ChainChangeListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
