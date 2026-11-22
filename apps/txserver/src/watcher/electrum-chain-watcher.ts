/**
 * Real Electrum/Fulcrum chain watcher (task 8.2, spec § Covenant watching).
 *
 * Speaks the Electrum Cash JSON-RPC protocol over a raw TCP socket (Node's `net`,
 * no new dependency — see the bch-dev skill's Fulcrum reference). The txserver
 * operates on **0-conf** throughout: it subscribes to the covenant **address**
 * (locking bytecode) and reacts on broadcast acceptance, not block confirmation.
 *
 * The watch is keyed on the covenant **address**, never on an outpoint txid: a
 * stray UTXO that arrives at the address in its own transaction (an external
 * wallet, a third party) must be observed and swept (spec § Strays are handled
 * regardless of source / § Stray-value sweep). The escrow is re-derived from the
 * co-created outpoint on every read, so a spend that moves both outpoints is
 * picked up automatically.
 */
import { connect, type Socket } from 'node:net';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { hash160, hexToBin, binToHex } from '@bitauth/libauth';
import type { ChainChange, ChainChangeListener, ChainWatcher, WatchedUtxo } from './chain-watcher.js';

export interface ElectrumOptions {
  host: string;
  port: number;
  /** Reconnect backoff floor in ms (default 500). */
  reconnectDelayMs?: number;
  /** Per-request timeout in ms (default 30_000). A silent server must not wedge the watch. */
  requestTimeoutMs?: number;
  /** Max receive buffer in bytes (default 4 MiB). Past this the socket is dropped. */
  maxBufferBytes?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /** Per-request timeout handle, cleared when the reply arrives. */
  timer: NodeJS.Timeout;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/**
 * Real Electrum/Fulcrum client. Connects on module init and closes on module
 * destroy, so the production app wires the socket lifecycle with no bootstrap
 * code (see `chain-watcher.module.ts`).
 */
@Injectable()
export class ElectrumChainWatcher implements ChainWatcher, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ElectrumChainWatcher.name);
  private socket?: Socket;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<ChainChangeListener>();
  /** scripthash (hex) → covenant locking bytecode hex, for change subjects. */
  private readonly subscribed = new Map<string, string>();
  /** Set while a reconnect is scheduled, so a burst of close/error events reconnects once. */
  private reconnecting = false;
  /** Consecutive reconnect attempts; reset on a successful connect. */
  private reconnectAttempts = 0;
  private closed = false;
  /** The scheduled reconnect timer, so `close()` can cancel it. */
  private reconnectTimer?: NodeJS.Timeout;

  constructor(private readonly options: ElectrumOptions) {}

  /** Connect on app bootstrap. A failed connect is non-fatal: the watcher self-heals. */
  async onModuleInit(): Promise<void> {
    try {
      await this.connect();
    } catch (error) {
      this.logger.warn(`initial Electrum connect failed: ${(error as Error).message}; retrying`);
      if (!this.closed && !this.reconnecting) this.scheduleReconnect();
    }
  }

  /** Close on app shutdown so in-flight calls reject and the socket is released. */
  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  /** The Electrum scripthash for a locking bytecode hex (hash160, reversed). */
  static scripthashForLockingBytecode(lockingBytecodeHex: string): string {
    const digest = hash160(hexToBin(lockingBytecodeHex));
    return binToHex(Uint8Array.from([...digest].reverse()));
  }

  async connect(): Promise<void> {
    this.closed = false;
    await this.open();
    await this.call('server.version', ['recurrentpay-txserver', '1.6']);
  }

  async close(): Promise<void> {
    this.closed = true;
    // Cancel any scheduled reconnect: a deliberate close must not self-heal.
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.reconnecting = false;

    const socket = this.socket;
    this.socket = undefined;
    // Reject in-flight calls *before* dropping the socket: `destroy()` emits
    // `'close'` on a later tick, by which time `this.socket` is already gone and
    // `onClose`'s guard would return early, leaving every pending call hung.
    this.rejectPending('ElectrumChainWatcher: connection closed');
    if (socket !== undefined) {
      socket.removeAllListeners();
      socket.destroy();
    }
  }

  async subscribe(subject: string): Promise<void> {
    // `subject` is the covenant address (locking bytecode hex); a `txid:vout`
    // outpoint is accepted for compatibility but the watch is always keyed on
    // the address — a txid scripthash would never see a stray sent to the
    // address in its own transaction (spec § Strays are handled regardless of
    // source).
    const lockingBytecode = subject.includes(':') ? subject.split(':')[0]! : subject;
    const scripthash = ElectrumChainWatcher.scripthashForLockingBytecode(lockingBytecode);
    this.subscribed.set(scripthash, lockingBytecode);
    await this.call('blockchain.scripthash.subscribe', [scripthash]);
  }

  async unsubscribe(subject: string): Promise<void> {
    const lockingBytecode = subject.includes(':') ? subject.split(':')[0]! : subject;
    const scripthash = ElectrumChainWatcher.scripthashForLockingBytecode(lockingBytecode);
    this.subscribed.delete(scripthash);
    await this.call('blockchain.scripthash.unsubscribe', [scripthash]);
  }

  async getUtxos(address: string): Promise<WatchedUtxo[]> {
    const scripthash = ElectrumChainWatcher.scripthashForLockingBytecode(address);
    const raw = (await this.call('blockchain.scripthash.listunspent', [scripthash])) as ElectrumUtxo[];
    return raw.map((u) => toWatchedUtxo(u, address));
  }

  async getRawTx(txid: string): Promise<string> {
    const hex = (await this.call('blockchain.transaction.get', [txid])) as string | null;
    if (hex === null) throw new Error(`ElectrumChainWatcher: unknown txid ${txid}`);
    return hex;
  }

  onChange(cb: ChainChangeListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // -- Connection lifecycle -------------------------------------------------

  /** Open a socket and wire its handlers. Rejects if the connection fails. */
  private open(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = connect(this.options.port, this.options.host, () => resolve());
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => this.onData(chunk));
      socket.on('error', (error) => {
        // Pre-connect errors reject; post-connect errors fall through to `close`.
        if (this.socket !== socket) reject(error);
      });
      socket.on('close', () => this.onClose(socket));
      this.socket = socket;
    });
  }

  private onClose(socket: Socket): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    // Fail every in-flight call: the connection is gone, so a reply can never
    // arrive. Without this, `call()` rejects forever and the watch dies silently.
    this.rejectPending('ElectrumChainWatcher: connection closed');
    if (this.closed || this.reconnecting) return;
    this.scheduleReconnect();
  }

  /** Reject every pending call and clear its timeout. */
  private rejectPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
  }

  private scheduleReconnect(): void {
    this.reconnecting = true;
    const floor = this.options.reconnectDelayMs ?? 500;
    // Exponential backoff, bounded so a long outage does not spin forever.
    const delay = Math.min(floor * 2 ** this.reconnectAttempts, 30_000);
    this.reconnectTimer = setTimeout(() => void this.reconnect(), delay);
    this.reconnectTimer.unref?.();
  }

  private async reconnect(): Promise<void> {
    this.reconnecting = false;
    this.reconnectTimer = undefined;
    if (this.closed) return;
    try {
      await this.open();
      await this.call('server.version', ['recurrentpay-txserver', '1.6']);
      this.reconnectAttempts = 0;
      // Re-issue every subscription: the server forgot them with the old socket.
      for (const scripthash of this.subscribed.keys()) {
        await this.call('blockchain.scripthash.subscribe', [scripthash]);
      }
      // Nudge derived state to re-sync against the (possibly changed) chain.
      for (const subject of this.subscribed.values()) {
        void this.emitChange(subject).catch(() => {});
      }
    } catch {
      this.reconnectAttempts += 1;
      if (!this.closed) this.scheduleReconnect();
    }
  }

  // -- JSON-RPC plumbing ----------------------------------------------------

  private call(method: string, params: unknown[]): Promise<unknown> {
    const socket = this.socket;
    if (socket === undefined) return Promise.reject(new Error('ElectrumChainWatcher: not connected'));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      // A silent server must not wedge the watch: reject if no reply arrives.
      const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ElectrumChainWatcher: request timed out (${method})`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    // Cap the receive buffer: an unauthenticated server must not be able to grow
    // it without bound (memory DoS). Drop the socket past the limit; the reconnect
    // loop re-establishes a clean connection.
    const maxBytes = this.options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    if (this.buffer.length > maxBytes) {
      this.logger.warn(`Electrum buffer exceeded ${maxBytes} bytes; dropping connection`);
      this.buffer = '';
      this.socket?.destroy();
      return;
    }
    let nl = this.buffer.indexOf('\n');
    while (nl >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line !== '') this.onMessage(line);
      nl = this.buffer.indexOf('\n');
    }
  }

  private onMessage(line: string): void {
    let msg: {
      id?: number;
      result?: unknown;
      error?: { message: string };
      method?: string;
      params?: unknown[];
    };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      // Untrusted input: a malformed line must not throw inside the socket
      // handler (that would be an uncaught exception and could crash the process).
      this.logger.warn('Electrum: ignoring malformed JSON line');
      return;
    }
    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (pending === undefined) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error !== undefined) pending.reject(new Error(msg.error.message));
      else pending.resolve(msg.result);
      return;
    }
    if (msg.method === 'blockchain.scripthash.subscribe') {
      const scripthash = String(msg.params?.[0]);
      const subject = this.subscribed.get(scripthash) ?? scripthash;
      // Fire-and-forget: a rejection here (e.g. the socket dropped between the
      // notification and the read) must not surface as an unhandled rejection.
      void this.emitChange(subject).catch((error: unknown) =>
        this.logger.warn(`Electrum change dispatch failed: ${(error as Error).message}`),
      );
    }
  }

  private async emitChange(subject: string): Promise<void> {
    const utxos = await this.getUtxos(subject);
    const change: ChainChange = { subject, utxos };
    for (const listener of this.listeners) {
      // One faulty listener must not starve the others.
      try {
        listener(change);
      } catch (error) {
        this.logger.warn(`Electrum change listener threw: ${(error as Error).message}`);
      }
    }
  }
}

/** The Electrum `listunspent` entry shape (subset). */
interface ElectrumUtxo {
  tx_hash: string;
  tx_pos: number;
  value: number;
  height?: number;
  token_data?: {
    category: string;
    amount: string;
    nft?: { capability: 'none' | 'mutable' | 'minting'; commitment: string };
  };
}

/** Map an Electrum UTXO to the watcher's `WatchedUtxo` (locking bytecode attached). */
function toWatchedUtxo(u: ElectrumUtxo, lockingBytecode: string): WatchedUtxo {
  const token = u.token_data;
  return {
    txid: u.tx_hash,
    vout: u.tx_pos,
    satoshis: BigInt(u.value),
    lockingBytecode,
    ...(token === undefined
      ? {}
      : {
          category: token.category,
          amount: BigInt(token.amount),
          ...(token.nft === undefined
            ? {}
            : { nftCapability: token.nft.capability, commitment: token.nft.commitment }),
        }),
  };
}
