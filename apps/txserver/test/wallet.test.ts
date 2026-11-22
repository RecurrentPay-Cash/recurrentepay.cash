/**
 * Wallet UTXO lookup tests (dapp-handoff §3, P0).
 *
 * Exercises `GET /wallet/utxos` over supertest with the real auth guard and a
 * seeded `MockChainWatcher` (the `CHAIN_WATCHER` token) — no live node. Covers:
 * the caller's own UTXOs (BCH + token) are returned; a mismatched `pkh` is a
 * 403; an address that is not the caller's is a 403; unauthenticated is a 401.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { binToHex, encodeLockingBytecodeP2pkh, hexToBin, lockingBytecodeToCashAddress, secp256k1, sha256 } from '@bitauth/libauth';
import { utils } from 'cashscript';
import { ChallengeService } from '../src/auth/challenge.service.js';
import { SessionService } from '../src/auth/session.service.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { AuthController } from '../src/api/auth.controller.js';
import { WalletController } from '../src/api/wallet.controller.js';
import { CHAIN_WATCHER } from '../src/watcher/chain-watcher.js';
import { MockChainWatcher } from '../src/watcher/mock-chain-watcher.js';

const { hash160 } = utils;

const A_KEY = new Uint8Array(32).fill(0x11);
const A_PUBKEY = secp256k1.derivePublicKeyCompressed(A_KEY) as Uint8Array;
const A_PKH = binToHex(hash160(A_PUBKEY));
const A_LOCK = binToHex(encodeLockingBytecodeP2pkh(hexToBin(A_PKH)));

const B_KEY = new Uint8Array(32).fill(0x22);
const B_PUBKEY = secp256k1.derivePublicKeyCompressed(B_KEY) as Uint8Array;
const B_PKH = binToHex(hash160(B_PUBKEY));

const TOKEN_CAT = 'aa'.repeat(32);

function signChallenge(challenge: string, key: Uint8Array): string {
  const digest = sha256.hash(new TextEncoder().encode(challenge));
  return binToHex(secp256k1.signMessageHashSchnorr(key, digest) as Uint8Array);
}

describe('GET /wallet/utxos', () => {
  let app: INestApplication;
  let watcher: MockChainWatcher;
  let aToken: string;

  const sessionFor = async (pkh: string, pubkey: Uint8Array, key: Uint8Array): Promise<string> => {
    const challengeRes = await request(app.getHttpServer())
      .post('/auth/challenge')
      .send({ pkh })
      .expect(201);
    const challenge = challengeRes.body.challenge as string;
    const sessionRes = await request(app.getHttpServer())
      .post('/auth/session')
      .send({ pkh, pubkey: binToHex(pubkey), challenge, signature: signChallenge(challenge, key) })
      .expect(201);
    return sessionRes.body.token as string;
  };

  beforeAll(async () => {
    watcher = new MockChainWatcher();
    const challenges = new ChallengeService();
    const sessions = new SessionService(challenges);
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController, WalletController],
      providers: [
        { provide: CHAIN_WATCHER, useValue: watcher },
        { provide: ChallengeService, useValue: challenges },
        { provide: SessionService, useValue: sessions },
        { provide: AuthGuard, useValue: new AuthGuard(sessions) },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    aToken = await sessionFor(A_PKH, A_PUBKEY, A_KEY);
    watcher.setUtxos(A_LOCK, [
      { txid: 'aa'.repeat(32), vout: 0, satoshis: 1000n, lockingBytecode: A_LOCK },
      {
        txid: 'bb'.repeat(32),
        vout: 1,
        satoshis: 2000n,
        lockingBytecode: A_LOCK,
        category: TOKEN_CAT,
        amount: 500_000n,
      },
    ]);
  });

  it('rejects an unauthenticated read with 401', async () => {
    await request(app.getHttpServer()).get(`/wallet/utxos?pkh=${A_PKH}`).expect(401);
  });

  it('returns the caller\'s UTXOs (BCH + token) for their own pkh', async () => {
    const res = await request(app.getHttpServer())
      .get(`/wallet/utxos?pkh=${A_PKH}`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);

    expect(res.body).toHaveLength(2);
    const bch = res.body.find((u: { token?: unknown }) => u.token === undefined);
    expect(bch).toMatchObject({
      txid: 'aa'.repeat(32),
      vout: 0,
      satoshis: '1000',
      lockingBytecode: A_LOCK,
    });
    expect(typeof bch.address).toBe('string');
    expect(bch.address.startsWith('bchtest:')).toBe(true);

    const token = res.body.find((u: { token?: unknown }) => u.token !== undefined);
    expect(token.token).toEqual({ category: TOKEN_CAT, amount: '500000', nft: null });
  });

  it('rejects a pkh that is not the caller\'s with 403', async () => {
    await request(app.getHttpServer())
      .get(`/wallet/utxos?pkh=${B_PKH}`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(403);
  });

  it('accepts an address that belongs to the caller', async () => {
    const res = await request(app.getHttpServer())
      .get(`/wallet/utxos?address=${encodeAddress(A_LOCK)}`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(res.body).toHaveLength(2);
  });

  it('rejects an address that is not the caller\'s with 403', async () => {
    const bLock = binToHex(encodeLockingBytecodeP2pkh(hexToBin(B_PKH)));
    await request(app.getHttpServer())
      .get(`/wallet/utxos?address=${encodeAddress(bLock)}`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(403);
  });

  it('requires pkh or address', async () => {
    await request(app.getHttpServer())
      .get('/wallet/utxos')
      .set('Authorization', `Bearer ${aToken}`)
      .expect(400);
  });
});

/** Encode a P2PKH locking bytecode as a bchtest CashAddress (test helper). */
function encodeAddress(lockingBytecode: string): string {
  const result = lockingBytecodeToCashAddress({ bytecode: hexToBin(lockingBytecode), prefix: 'bchtest' });
  if (typeof result === 'string') throw new Error(result);
  return result.address;
}
