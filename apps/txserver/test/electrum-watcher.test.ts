/**
 * Electrum-watcher tests (task 8.2, spec § Covenant watching).
 *
 * A fake in-process Electrum server (newline-delimited JSON-RPC over a real TCP
 * socket) exercises the client end-to-end without a live node: subscribe,
 * 0-conf notification, re-resolve both outpoints after a spend, stray
 * classification, and reorg re-derivation.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { ElectrumChainWatcher } from '../src/watcher/electrum-chain-watcher.js';
import { deriveEscrow, toDisplayCategory, type WatchedUtxo } from 'shared';
import {
  COVENANT_LOCK,
  FUNDS_CAT,
  STATE_CAT,
  escrowUtxo,
  makeState,
  stateUtxo,
  strayUtxo,
} from './fixtures.js';

/** Fixture categories are internal order; the wire (Fulcrum) reports display. */
const STATE_CAT_DISPLAY = toDisplayCategory(STATE_CAT);
const FUNDS_CAT_DISPLAY = toDisplayCategory(FUNDS_CAT);

/** Minimal Electrum-protocol fake: script-hash subscriptions + raw txs. */
class FakeElectrum {
  private server!: Server;
  private readonly sockets = new Set<Socket>();
  /** scripthash (hex) → UTXOs. */
  readonly utxos = new Map<string, WatchedUtxo[]>();
  /** txid → raw hex. */
  readonly rawTxs = new Map<string, string>();
  /** Every `blockchain.scripthash.subscribe` the client has sent (in order). */
  readonly subscribeCalls: string[] = [];
  /** Methods the fake deliberately never answers (silent-server simulation). */
  private readonly silenced = new Set<string>();
  port = 0;

  async start(): Promise<void> {
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let nl = buffer.indexOf('\n');
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line !== '') this.handle(socket, line);
          nl = buffer.indexOf('\n');
        }
      });
      socket.on('close', () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    this.port = address.port;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Push a 0-conf notification to every subscriber of `scripthash`. */
  notify(scripthash: string, status: string): void {
    for (const socket of this.sockets) {
      socket.write(JSON.stringify({ jsonrpc: '2.0', method: 'blockchain.scripthash.subscribe', params: [scripthash, status] }) + '\n');
    }
  }

  /** Abruptly drop every live socket (simulates a server/network failure). */
  killSockets(): void {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  /** The live sockets (for tests that push raw bytes). */
  liveSockets(): Socket[] {
    return [...this.sockets];
  }

  /** Stop replying to `method` (simulates a silently-stalled server). */
  silence(method: string): void {
    this.silenced.add(method);
  }

  private handle(socket: Socket, line: string): void {
    const req = JSON.parse(line) as { id: number; method: string; params: unknown[] };
    if (this.silenced.has(req.method)) return;
    const reply = (result: unknown): void => {
      socket.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n');
    };
    switch (req.method) {
      case 'server.version':
        reply(['fake', '1.6']);
        break;
      case 'blockchain.scripthash.subscribe':
        this.subscribeCalls.push(String(req.params[0]));
        reply(null);
        break;
      case 'blockchain.scripthash.listunspent':
        reply(this.listUnspent(String(req.params[0])));
        break;
      case 'blockchain.transaction.get':
        reply(this.rawTxs.get(String(req.params[0])) ?? null);
        break;
      default:
        reply(null);
    }
  }

  private listUnspent(scripthash: string): unknown[] {
    const utxos = this.utxos.get(scripthash) ?? [];
    return utxos.map((u) => ({
      tx_hash: u.txid,
      tx_pos: u.vout,
      value: Number(u.satoshis),
      height: 0, // 0-conf (mempool)
      token_data: toTokenData(u),
    }));
  }
}

/** Reverse a category hex string (its own inverse); internal ↔ display order. */
function reverseCategory(hex: string): string {
  return Buffer.from(Uint8Array.from(Buffer.from(hex, 'hex')).reverse()).toString('hex');
}

/**
 * Map a `WatchedUtxo` to Electrum's `token_data` shape.
 *
 * Fulcrum reports `token_data.category` in **display** order (the reverse of the
 * internal wire bytes). The fixtures carry categories in internal order, so the
 * fake reverses them on the way out — exactly what a real server does. Without
 * this, the fake would echo the client's own bytes and hide a byte-order bug.
 */
function toTokenData(u: WatchedUtxo): unknown {
  if (u.category === undefined) return undefined;
  return {
    category: reverseCategory(u.category),
    amount: u.amount === undefined ? '0' : u.amount.toString(),
    ...(u.nftCapability === undefined
      ? {}
      : { nft: { capability: u.nftCapability, commitment: u.commitment ?? '' } }),
  };
}

describe('ElectrumChainWatcher', () => {
  let fake: FakeElectrum;
  let watcher: ElectrumChainWatcher;

  beforeEach(async () => {
    fake = new FakeElectrum();
    await fake.start();
    watcher = new ElectrumChainWatcher({ host: '127.0.0.1', port: fake.port });
    await watcher.connect();
  });

  afterEach(async () => {
    await watcher.close();
    await fake.stop();
  });

  it('reads the covenant UTXO set over the wire (0-conf)', async () => {
    fake.utxos.set(covenantScripthash(), [stateUtxo(makeState()), escrowUtxo(101n)]);
    const utxos = await watcher.getUtxos(COVENANT_LOCK);
    expect(utxos).toHaveLength(2);
    expect(utxos.find((u) => u.category === FUNDS_CAT_DISPLAY)?.amount).toBe(101n);
    expect(utxos.find((u) => u.category === STATE_CAT_DISPLAY)?.nftCapability).toBe('mutable');
  });

  it('emits a change on a 0-conf scripthash notification', async () => {
    const changes: string[] = [];
    watcher.onChange((c) => changes.push(c.subject));
    await watcher.subscribe(COVENANT_LOCK);

    fake.utxos.set(covenantScripthash(), [stateUtxo(makeState()), escrowUtxo(101n)]);
    fake.notify(covenantScripthash(), 'status-1');

    await waitFor(() => changes.length > 0);
    expect(changes[0]).toBe(COVENANT_LOCK);
  });

  it('re-resolves both outpoints after a spend (new co-created txid)', async () => {
    // Before: state+escrow co-created at txid `co`.
    fake.utxos.set(covenantScripthash(), [stateUtxo(makeState(), 'co'), escrowUtxo(101n, 'co')]);
    const before = deriveEscrow(await watcher.getUtxos(COVENANT_LOCK), {
      stateCategory: STATE_CAT_DISPLAY,
      fundsCategory: FUNDS_CAT_DISPLAY,
    });
    expect(before.stateUtxo?.txid).toBe('co');
    expect(before.escrowUtxo?.txid).toBe('co');

    // After a spend: the covenant moved to a new co-created txid `co2`.
    fake.utxos.set(covenantScripthash(), [stateUtxo(makeState(), 'co2'), escrowUtxo(91n, 'co2')]);
    const after = deriveEscrow(await watcher.getUtxos(COVENANT_LOCK), {
      stateCategory: STATE_CAT_DISPLAY,
      fundsCategory: FUNDS_CAT_DISPLAY,
    });
    expect(after.stateUtxo?.txid).toBe('co2');
    expect(after.escrowUtxo?.txid).toBe('co2');
    expect(after.escrow).toBe(91n);
  });

  it('classifies a stray and never counts it as escrow', async () => {
    fake.utxos.set(covenantScripthash(), [
      stateUtxo(makeState(), 'co'),
      escrowUtxo(11n, 'co'),
      strayUtxo(1_000_000n, 'stray'),
    ]);
    const d = deriveEscrow(await watcher.getUtxos(COVENANT_LOCK), {
      stateCategory: STATE_CAT_DISPLAY,
      fundsCategory: FUNDS_CAT_DISPLAY,
    });
    expect(d.escrow).toBe(11n);
    expect(d.strayFunds).toHaveLength(1);
    expect(d.strayFunds[0]?.amount).toBe(1_000_000n);
  });

  it('re-resolves the escrow with asymmetric categories (display order over the wire)', async () => {
    // Regression guard for the byte-order blocker: Fulcrum reports categories in
    // display order; the stored/spec categories are display order too. With
    // asymmetric fixtures a wrong order yields escrow 0 and no state UTXO.
    fake.utxos.set(covenantScripthash(), [stateUtxo(makeState(), 'co'), escrowUtxo(101n, 'co')]);
    const utxos = await watcher.getUtxos(COVENANT_LOCK);
    expect(utxos.find((u) => u.nftCapability !== undefined)?.category).toBe(STATE_CAT_DISPLAY);
    expect(utxos.find((u) => u.amount === 101n)?.category).toBe(FUNDS_CAT_DISPLAY);

    const d = deriveEscrow(utxos, { stateCategory: STATE_CAT_DISPLAY, fundsCategory: FUNDS_CAT_DISPLAY });
    expect(d.stateUtxo?.txid).toBe('co');
    expect(d.escrow).toBe(101n);
  });

  it('fetches a raw transaction by txid', async () => {
    fake.rawTxs.set('deadbeef', '00');
    expect(await watcher.getRawTx('deadbeef')).toBe('00');
  });

  it('re-derives state from the winning chain after a reorg', async () => {
    // 0-conf: a spend moved the covenant to `co2` with escrow 91.
    fake.utxos.set(covenantScripthash(), [stateUtxo(makeState(), 'co2'), escrowUtxo(91n, 'co2')]);
    const provisional = deriveEscrow(await watcher.getUtxos(COVENANT_LOCK), {
      stateCategory: STATE_CAT_DISPLAY,
      fundsCategory: FUNDS_CAT_DISPLAY,
    });
    expect(provisional.escrow).toBe(91n);

    // Reorg: the 0-conf tx is dropped; the winning chain still has `co`.
    fake.utxos.set(covenantScripthash(), [stateUtxo(makeState(), 'co'), escrowUtxo(101n, 'co')]);
    const reconciled = deriveEscrow(await watcher.getUtxos(COVENANT_LOCK), {
      stateCategory: STATE_CAT_DISPLAY,
      fundsCategory: FUNDS_CAT_DISPLAY,
    });
    expect(reconciled.escrow).toBe(101n);
    expect(reconciled.stateUtxo?.txid).toBe('co');
  });

  it('re-derives state from the winning chain after a reorg notification (no manual re-read)', async () => {
    // Provisional 0-conf state: covenant at `co2`, escrow 91.
    fake.utxos.set(covenantScripthash(), [stateUtxo(makeState(), 'co2'), escrowUtxo(91n, 'co2')]);
    await watcher.subscribe(COVENANT_LOCK);

    const seen: Array<{ subject: string; escrow: bigint }> = [];
    watcher.onChange((c) => {
      seen.push({
        subject: c.subject,
        escrow: deriveEscrow(c.utxos, {
          stateCategory: STATE_CAT_DISPLAY,
          fundsCategory: FUNDS_CAT_DISPLAY,
        }).escrow,
      });
    });

    // Reorg: the winning chain reverts to `co` with escrow 101, then Fulcrum
    // pushes a fresh scripthash notification for the same address.
    fake.utxos.set(covenantScripthash(), [stateUtxo(makeState(), 'co'), escrowUtxo(101n, 'co')]);
    fake.notify(covenantScripthash(), 'status-reorg');

    await waitFor(() => seen.length > 0);
    expect(seen[0]?.subject).toBe(COVENANT_LOCK);
    expect(seen[0]?.escrow).toBe(101n);
  });

  it('subscribes the covenant address, not the outpoint txid (address watch)', async () => {
    // The watch is keyed on the covenant address's scripthash. A txid scripthash
    // would never see a stray arriving in its own transaction (spec § Strays are
    // handled regardless of source).
    await watcher.subscribe(COVENANT_LOCK);

    expect(fake.subscribeCalls).toContain(covenantScripthash());
    // The txid is not a locking bytecode — hashing the txid string would produce
    // a different scripthash, which must never be subscribed.
    expect(fake.subscribeCalls).not.toContain(
      ElectrumChainWatcher.scripthashForLockingBytecode('deadbeef'),
    );

    // A `txid:vout` subject is accepted for compatibility but keys the same
    // address watch (the txid is discarded, not hashed).
    await watcher.subscribe(`${COVENANT_LOCK}:0`);
    expect(fake.subscribeCalls).not.toContain(
      ElectrumChainWatcher.scripthashForLockingBytecode(`${COVENANT_LOCK}:0`),
    );
  });

  it('observes a stray sent to the covenant address in a separate transaction', async () => {
    // The subscription is keyed on the address, so a UTXO arriving in its own
    // transaction (a stray from an external wallet) triggers the same watch.
    const changes: Array<{ subject: string; utxos: WatchedUtxo[] }> = [];
    watcher.onChange((c) => changes.push({ subject: c.subject, utxos: c.utxos }));
    await watcher.subscribe(COVENANT_LOCK);

    // A stray funds UTXO lands at the covenant address in its own txid `stray`.
    fake.utxos.set(covenantScripthash(), [
      stateUtxo(makeState(), 'co'),
      escrowUtxo(11n, 'co'),
      strayUtxo(1_000_000n, 'stray'),
    ]);
    fake.notify(covenantScripthash(), 'status-stray');

    await waitFor(() => changes.length > 0);
    const change = changes[0]!;
    expect(change.subject).toBe(COVENANT_LOCK);
    const d = deriveEscrow(change.utxos, {
      stateCategory: STATE_CAT_DISPLAY,
      fundsCategory: FUNDS_CAT_DISPLAY,
    });
    // The stray is classified as stray-funds, never counted as escrow.
    expect(d.escrow).toBe(11n);
    expect(d.strayFunds).toHaveLength(1);
    expect(d.strayFunds[0]?.txid).toBe('stray');
    expect(d.strayFunds[0]?.amount).toBe(1_000_000n);
  });

  it('rejects an in-flight call when close() is called (no hang at shutdown)', async () => {
    // A call in flight when the watcher is closed must settle (reject), not hang
    // forever. `close()` nulls the socket before `'close'` fires, so the pending
    // map must be rejected explicitly.
    const pending = watcher.getUtxos(COVENANT_LOCK); // the fake never replies to listunspent here
    const settled = pending.then(
      () => 'resolved',
      () => 'rejected',
    );
    await watcher.close();
    await expect(settled).resolves.toBe('rejected');
    await expect(pending).rejects.toThrow(/closed/i);
  });

  it('onModuleInit connects the watcher (production bootstrap path)', async () => {
    // A fresh watcher is not connected until the module lifecycle runs.
    const fresh = new ElectrumChainWatcher({ host: '127.0.0.1', port: fake.port });
    await expect(fresh.getUtxos(COVENANT_LOCK)).rejects.toThrow(/not connected/i);
    await fresh.onModuleInit();
    await expect(fresh.getUtxos(COVENANT_LOCK)).resolves.toEqual([]);
    await fresh.onModuleDestroy();
  });

  it('ignores a malformed JSON line without crashing', async () => {
    // Untrusted input: a non-JSON line must be dropped, and the connection must
    // keep working for subsequent valid replies.
    const utxos = watcher.getUtxos(COVENANT_LOCK);
    for (const socket of fake.liveSockets()) socket.write('this is not json\n');
    await expect(utxos).resolves.toEqual([]);
  });

  it('rejects a request that never gets a reply (per-request timeout)', async () => {
    const silent = new ElectrumChainWatcher({ host: '127.0.0.1', port: fake.port, requestTimeoutMs: 50 });
    await silent.connect();
    fake.silence('blockchain.scripthash.listunspent');
    await expect(silent.getUtxos(COVENANT_LOCK)).rejects.toThrow(/timed out/i);
    await silent.close();
  });

  it('drops the connection when the receive buffer exceeds the cap', async () => {
    const capped = new ElectrumChainWatcher({
      host: '127.0.0.1',
      port: fake.port,
      maxBufferBytes: 64,
    });
    await capped.connect();
    const pending = capped.getUtxos(COVENANT_LOCK);
    const settled = pending.then(
      () => 'resolved',
      () => 'rejected',
    );
    // A newline-free flood: the buffer cap must drop the socket (and reject the
    // in-flight call) rather than grow without bound.
    for (const socket of fake.liveSockets()) socket.write('x'.repeat(1024));
    await expect(settled).resolves.toBe('rejected');
    await capped.close();
  });

  it('reconnects after the socket drops and re-subscribes every watched address', async () => {
    const changes: string[] = [];
    watcher.onChange((c) => changes.push(c.subject));
    await watcher.subscribe(COVENANT_LOCK);
    expect(fake.subscribeCalls).toHaveLength(1);

    // The server drops the connection: the client must reconnect with backoff
    // and re-issue the subscription, or the watch dies silently.
    fake.killSockets();

    await waitFor(() => fake.subscribeCalls.length >= 2);

    // A change delivered after the reconnect still reaches the listener.
    fake.utxos.set(covenantScripthash(), [stateUtxo(makeState(), 'co'), escrowUtxo(101n, 'co')]);
    fake.notify(covenantScripthash(), 'status-after-reconnect');

    await waitFor(() => changes.length > 0);
    expect(changes[0]).toBe(COVENANT_LOCK);
  });
});

/** The Electrum scripthash for the covenant lock (hash160, reversed). */
function covenantScripthash(): string {
  // The fake keys its map by whatever the client sends; the client sends the
  // scripthash it computes. We compute the same value here via the watcher's own
  // helper to avoid duplicating the hash in the test.
  return ElectrumChainWatcher.scripthashForLockingBytecode(COVENANT_LOCK);
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
