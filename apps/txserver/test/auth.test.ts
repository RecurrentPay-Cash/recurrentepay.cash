/**
 * Auth tests (Slice 4, spec § API for web app — "the caller proves control of a
 * party pkh ... wallet signature over a server-issued challenge", spec
 * § Operational safety — auth).
 *
 * The scheme: the server issues a challenge nonce for a pkh; the wallet signs the
 * challenge with its key (Schnorr over `sha256(challenge)` — the same preimage
 * the oracle client verifies and the contract's `checkDataSig` uses); the server
 * derives the pkh from the pubkey, checks it matches, and issues a short-lived
 * bearer session. No session → 401 on protected routes; a valid session scopes
 * every read to the caller's pkh.
 */
import { DataSource } from 'typeorm';
import { binToHex, secp256k1, sha256 } from '@bitauth/libauth';
import { utils } from 'cashscript';
import { Subscription } from '../src/db/subscription.entity.js';
import { SubscriptionRepository } from '../src/subscription/subscription.repository.js';
import { ChallengeService } from '../src/auth/challenge.service.js';
import { SessionService } from '../src/auth/session.service.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { DAY, FUNDS_CAT, STATE_CAT, T } from './fixtures.js';

const { hash160 } = utils;

/** A wallet keypair. The pkh is `hash160(pubkey)` (P2PKH). */
const WALLET_KEY = new Uint8Array(32).fill(0x42);
const WALLET_PUBKEY = secp256k1.derivePublicKeyCompressed(WALLET_KEY) as Uint8Array;
const WALLET_PKH = binToHex(hash160(WALLET_PUBKEY));

/** Sign the challenge: Schnorr over `sha256(challenge)`. */
function signChallenge(challenge: string, key: Uint8Array = WALLET_KEY): string {
  const digest = sha256.hash(new TextEncoder().encode(challenge));
  return binToHex(secp256k1.signMessageHashSchnorr(key, digest) as Uint8Array);
}

describe('ChallengeService + SessionService', () => {
  let dataSource: DataSource;
  let repository: SubscriptionRepository;
  let challenges: ChallengeService;
  let sessions: SessionService;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Subscription],
      synchronize: true,
    });
    await dataSource.initialize();
    repository = new SubscriptionRepository(dataSource.getRepository(Subscription));
    challenges = new ChallengeService();
    sessions = new SessionService(challenges);
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  it('issues a challenge for a pkh', () => {
    const challenge = challenges.issue(WALLET_PKH);
    expect(challenge.challenge).toMatch(/^[0-9a-f]+$/);
    expect(challenge.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('a valid signature over sha256(challenge) yields a session', () => {
    const { challenge } = challenges.issue(WALLET_PKH);
    const result = sessions.verify({
      pkh: WALLET_PKH,
      pubkey: binToHex(WALLET_PUBKEY),
      challenge,
      signature: signChallenge(challenge),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.pkh).toBe(WALLET_PKH);
    expect(result.session.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a bad signature', () => {
    const { challenge } = challenges.issue(WALLET_PKH);
    const result = sessions.verify({
      pkh: WALLET_PKH,
      pubkey: binToHex(WALLET_PUBKEY),
      challenge,
      signature: signChallenge('a different message'),
    });
    expect(result).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects a pubkey that does not hash to the claimed pkh', () => {
    const { challenge } = challenges.issue(WALLET_PKH);
    const wrongKey = new Uint8Array(32).fill(0x99);
    const result = sessions.verify({
      pkh: WALLET_PKH,
      pubkey: binToHex(secp256k1.derivePublicKeyCompressed(wrongKey) as Uint8Array),
      challenge,
      signature: signChallenge(challenge),
    });
    expect(result).toEqual({ ok: false, reason: 'pkh-mismatch' });
  });

  it('rejects an unknown or already-consumed challenge', () => {
    const result = sessions.verify({
      pkh: WALLET_PKH,
      pubkey: binToHex(WALLET_PUBKEY),
      challenge: 'deadbeef',
      signature: '00'.repeat(64),
    });
    expect(result).toEqual({ ok: false, reason: 'unknown-challenge' });
  });

  it('consumes the challenge so a replayed proof fails', () => {
    const { challenge } = challenges.issue(WALLET_PKH);
    const proof = {
      pkh: WALLET_PKH,
      pubkey: binToHex(WALLET_PUBKEY),
      challenge,
      signature: signChallenge(challenge),
    };
    expect(sessions.verify(proof).ok).toBe(true);
    expect(sessions.verify(proof)).toEqual({ ok: false, reason: 'unknown-challenge' });
  });

  it('validates a session token and resolves the pkh', () => {
    const { challenge } = challenges.issue(WALLET_PKH);
    const issued = sessions.verify({
      pkh: WALLET_PKH,
      pubkey: binToHex(WALLET_PUBKEY),
      challenge,
      signature: signChallenge(challenge),
    });
    if (!issued.ok) throw new Error('expected a session');
    expect(sessions.validate(issued.session.token)).toBe(WALLET_PKH);
  });

  it('rejects an unknown session token', () => {
    expect(sessions.validate('00'.repeat(32))).toBeNull();
  });

  it('rejects an expired session token', () => {
    const { challenge } = challenges.issue(WALLET_PKH);
    const issued = sessions.verify(
      {
        pkh: WALLET_PKH,
        pubkey: binToHex(WALLET_PUBKEY),
        challenge,
        signature: signChallenge(challenge),
      },
      { now: 1000, ttlSeconds: 60 },
    );
    if (!issued.ok) throw new Error('expected a session');
    expect(sessions.validate(issued.session.token, 2000)).toBeNull();
    expect(sessions.validate(issued.session.token, 1030)).toBe(WALLET_PKH);
  });

  it('scopes reads to the caller pkh (findByParty)', async () => {
    await repository.upsert({
      stateCategory: STATE_CAT,
      stateOutpoint: 'co:1',
      escrowOutpoint: 'co:0',
      assetType: 'token',
      fundsCategory: FUNDS_CAT,
      mode: 1,
      supporterPkh: WALLET_PKH,
      supporteePkh: 'bb'.repeat(20),
      servicePkh: 'cc'.repeat(20),
      amount: 10n,
      amountNext: 10n,
      period: DAY,
      periodNext: DAY,
      lastPeriodTime: T,
      escrowBalance: 101n,
      status: 'active',
      nextPaymentAt: T + DAY,
    });
    const mine = await repository.findByParty(WALLET_PKH);
    expect(mine.map((s) => s.stateCategory)).toEqual([STATE_CAT]);
    // A different caller sees nothing.
    expect(await repository.findByParty('ff'.repeat(20))).toEqual([]);
  });

  it('normalizes pkh case on write and query (findByParty)', async () => {
    // Stored in mixed case (as a commitment could carry it); queried in the
    // canonical lowercase the session issues. Both sides normalize, so the list
    // endpoint cannot silently hide a party's own subscriptions.
    const mixed = WALLET_PKH.toUpperCase();
    await repository.upsert({
      stateCategory: STATE_CAT,
      stateOutpoint: 'co:1',
      escrowOutpoint: 'co:0',
      assetType: 'token',
      fundsCategory: FUNDS_CAT,
      mode: 1,
      supporterPkh: mixed,
      supporteePkh: 'BB'.repeat(20),
      servicePkh: 'CC'.repeat(20),
      amount: 10n,
      amountNext: 10n,
      period: DAY,
      periodNext: DAY,
      lastPeriodTime: T,
      escrowBalance: 101n,
      status: 'active',
      nextPaymentAt: T + DAY,
    });

    const row = await repository.findById(STATE_CAT);
    expect(row!.supporterPkh).toBe(WALLET_PKH); // stored canonical (lowercase)

    // A lowercase query finds the mixed-case write, and vice-versa.
    expect((await repository.findByParty(WALLET_PKH)).map((s) => s.stateCategory)).toEqual([
      STATE_CAT,
    ]);
    expect((await repository.findByParty(mixed)).map((s) => s.stateCategory)).toEqual([STATE_CAT]);
  });
});

describe('AuthGuard', () => {
  it('builds a guard that rejects a missing bearer token', async () => {
    const guard = new AuthGuard(new SessionService());
    const context = fakeContext(undefined);
    expect(() => guard.canActivate(context)).toThrow();
  });

  it('accepts a valid bearer token and attaches the caller pkh', () => {
    const sessions = new SessionService();
    const challenges = sessions.challenges;
    const { challenge } = challenges.issue(WALLET_PKH);
    const issued = sessions.verify({
      pkh: WALLET_PKH,
      pubkey: binToHex(WALLET_PUBKEY),
      challenge,
      signature: signChallenge(challenge),
    });
    if (!issued.ok) throw new Error('expected a session');
    const guard = new AuthGuard(sessions);
    const request = { headers: { authorization: `Bearer ${issued.session.token}` } };
    expect(guard.canActivate(fakeContext(request))).toBe(true);
    expect(guard.caller(request)).toBe(WALLET_PKH);
  });
});

/** A minimal ExecutionContext double for the guard. */
function fakeContext(request: unknown): never {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as never;
}
