/**
 * Signed-challenge **transaction** auth tests (handoff §2 — WizardConnect signs
 * transactions, not messages).
 *
 * The alternate proof: the server builds a challenge tx spending a UTXO owned by
 * the claimed pkh, carrying the challenge nonce in an `OP_RETURN`; the wallet
 * signs input 0 with `SIGHASH_ALL | FORKID | UTXOS` (`0x61`) and returns the
 * signed tx (never broadcast). The server verifies the signature over the BCH
 * signing serialization, that the tx still spends the same UTXO, that the
 * `OP_RETURN` still carries the nonce, and that `hash160(pubkey) === pkh`.
 *
 * The message-signature path (`auth.test.ts`) stays byte-for-byte functional.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  binToHex,
  decodeTransaction,
  encodeAuthenticationInstructions,
  encodeTransaction,
  generateSigningSerializationBch,
  hash256,
  hexToBin,
  secp256k1,
  sha256,
} from '@bitauth/libauth';
import { utils } from 'cashscript';
import { AuthController } from '../src/api/auth.controller.js';
import { ChallengeService } from '../src/auth/challenge.service.js';
import { SessionService } from '../src/auth/session.service.js';
import { CHAIN_WATCHER } from '../src/watcher/chain-watcher.js';
import { MockChainWatcher } from '../src/watcher/mock-chain-watcher.js';

const { hash160 } = utils;

/** The wallet keypair. pkh = hash160(pubkey). */
const WALLET_KEY = new Uint8Array(32).fill(0x42);
const WALLET_PUBKEY = secp256k1.derivePublicKeyCompressed(WALLET_KEY) as Uint8Array;
const WALLET_PKH = binToHex(hash160(WALLET_PUBKEY));
const WALLET_LOCK = '76a914' + WALLET_PKH + '88ac';

/** A second key not controlled by the wallet (wrong-key case). */
const OTHER_KEY = new Uint8Array(32).fill(0x99);

/** The UTXO the challenge spends. */
const FUNDING_TXID = 'ab'.repeat(32);
const FUNDING_VOUT = 0;
const FUNDING_SATS = 100_000n;

/** The BCH signing serialization flags WizardConnect enforces. */
const SIGHASH_ALL_FORKID_UTXOS = Uint8Array.of(0x01 | 0x40 | 0x20); // 0x61

/** Sign the challenge tx client-side (a stand-in for WizardConnect). */
function signChallengeTx(
  unsignedHex: string,
  sourceOutputs: Array<{ outpointTransactionHash: string; outpointIndex: number; valueSatoshis: string }>,
  key: Uint8Array = WALLET_KEY,
): string {
  const decoded = decodeTransaction(hexToBin(unsignedHex));
  if (typeof decoded === 'string') throw new Error(decoded);
  const tx = decoded;

  const libauthSources = sourceOutputs.map((s) => ({
    lockingBytecode: hexToBin(WALLET_LOCK),
    valueSatoshis: BigInt(s.valueSatoshis),
  }));

  const preimage = generateSigningSerializationBch(
    { transaction: tx, sourceOutputs: libauthSources, inputIndex: 0 },
    { coveredBytecode: hexToBin(WALLET_LOCK), signingSerializationType: SIGHASH_ALL_FORKID_UTXOS },
  );
  const digest = hash256(preimage);
  const sig = secp256k1.signMessageHashSchnorr(key, digest) as Uint8Array;
  const pubkey = secp256k1.derivePublicKeyCompressed(key) as Uint8Array;

  const push = (data: Uint8Array) => ({ opcode: data.length < 76 ? data.length : 0x4c, data });
  tx.inputs[0]!.unlockingBytecode = encodeAuthenticationInstructions([
    push(Uint8Array.from([...sig, 0x61])),
    push(pubkey),
  ]);
  return binToHex(encodeTransaction(tx));
}

describe('Signed-challenge transaction auth', () => {
  let app: INestApplication;
  let watcher: MockChainWatcher;

  beforeAll(async () => {
    watcher = new MockChainWatcher();
    const challenges = new ChallengeService(watcher);
    const sessions = new SessionService(challenges);
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: ChallengeService, useValue: challenges },
        { provide: SessionService, useValue: sessions },
        { provide: CHAIN_WATCHER, useValue: watcher },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    watcher.setUtxos(WALLET_LOCK, [
      { txid: FUNDING_TXID, vout: FUNDING_VOUT, satoshis: FUNDING_SATS },
    ]);
  });

  it('builds a challenge tx spending the pkh UTXO with the nonce in an OP_RETURN', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/challenge')
      .send({ pkh: WALLET_PKH, addresses: [{ address: WALLET_LOCK, index: 0 }] })
      .expect(201);

    expect(res.body.challenge).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.unsignedHex).toMatch(/^[0-9a-f]+$/);
    expect(res.body.inputIndex).toBe(0);
    expect(res.body.addressIndex).toBe(0);
    expect(res.body.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // `sourceOutputs` is positional (one entry per input).
    expect(res.body.sourceOutputs).toHaveLength(1);
    expect(res.body.sourceOutputs[0]).toMatchObject({
      outpointTransactionHash: FUNDING_TXID,
      outpointIndex: FUNDING_VOUT,
      valueSatoshis: FUNDING_SATS.toString(),
    });

    // Output 0 pays the same pkh; an OP_RETURN output carries the nonce.
    const decoded = decodeTransaction(hexToBin(res.body.unsignedHex));
    if (typeof decoded === 'string') throw new Error(decoded);
    expect(decoded.locktime).toBe(0);
    expect(binToHex(decoded.outputs[0]!.lockingBytecode)).toBe(WALLET_LOCK);
    const opReturn = decoded.outputs.find(
      (o) => binToHex(o.lockingBytecode).startsWith('6a'),
    );
    expect(opReturn).toBeDefined();
    expect(binToHex(opReturn!.lockingBytecode)).toContain(res.body.challenge);
  });

  it('returns 409 no-spendable-utxo when the addresses hold nothing', async () => {
    watcher.setUtxos(WALLET_LOCK, []);
    const res = await request(app.getHttpServer())
      .post('/auth/challenge')
      .send({ pkh: WALLET_PKH, addresses: [{ address: WALLET_LOCK, index: 0 }] })
      .expect(409);
    expect(res.body.code).toBe('no-spendable-utxo');
  });

  it('a client-signed challenge tx yields a session token', async () => {
    const challengeRes = await request(app.getHttpServer())
      .post('/auth/challenge')
      .send({ pkh: WALLET_PKH, addresses: [{ address: WALLET_LOCK, index: 0 }] })
      .expect(201);

    const signedTransaction = signChallengeTx(
      challengeRes.body.unsignedHex,
      challengeRes.body.sourceOutputs,
    );

    const sessionRes = await request(app.getHttpServer())
      .post('/auth/session')
      .send({ pkh: WALLET_PKH, challenge: challengeRes.body.challenge, signedTransaction })
      .expect(201);
    expect(sessionRes.body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionRes.body.pkh).toBe(WALLET_PKH);
  });

  it('rejects a signature from a key whose hash is not the claimed pkh (401)', async () => {
    const challengeRes = await request(app.getHttpServer())
      .post('/auth/challenge')
      .send({ pkh: WALLET_PKH, addresses: [{ address: WALLET_LOCK, index: 0 }] })
      .expect(201);

    const signedTransaction = signChallengeTx(
      challengeRes.body.unsignedHex,
      challengeRes.body.sourceOutputs,
      OTHER_KEY,
    );

    await request(app.getHttpServer())
      .post('/auth/session')
      .send({ pkh: WALLET_PKH, challenge: challengeRes.body.challenge, signedTransaction })
      .expect(401);
  });

  it('rejects a tampered challenge (nonce changed in the OP_RETURN) with 401', async () => {
    const challengeRes = await request(app.getHttpServer())
      .post('/auth/challenge')
      .send({ pkh: WALLET_PKH, addresses: [{ address: WALLET_LOCK, index: 0 }] })
      .expect(201);

    const signedTransaction = signChallengeTx(
      challengeRes.body.unsignedHex,
      challengeRes.body.sourceOutputs,
    );

    // A different challenge string than the one bound to the signed tx.
    await request(app.getHttpServer())
      .post('/auth/session')
      .send({
        pkh: WALLET_PKH,
        challenge: 'ff'.repeat(32),
        signedTransaction,
      })
      .expect(401);
  });

  it('rejects reuse of a challenge (single-use) with 401', async () => {
    const challengeRes = await request(app.getHttpServer())
      .post('/auth/challenge')
      .send({ pkh: WALLET_PKH, addresses: [{ address: WALLET_LOCK, index: 0 }] })
      .expect(201);

    const signedTransaction = signChallengeTx(
      challengeRes.body.unsignedHex,
      challengeRes.body.sourceOutputs,
    );
    const body = { pkh: WALLET_PKH, challenge: challengeRes.body.challenge, signedTransaction };

    await request(app.getHttpServer()).post('/auth/session').send(body).expect(201);
    // The challenge is consumed on success; a replay fails.
    await request(app.getHttpServer()).post('/auth/session').send(body).expect(401);
  });

  it('keeps the message-signature path working', async () => {
    const challengeRes = await request(app.getHttpServer())
      .post('/auth/challenge')
      .send({ pkh: WALLET_PKH })
      .expect(201);
    const challenge = challengeRes.body.challenge as string;
    // The message path signs `sha256(utf8(challenge))` — single SHA-256, not hash256.
    const digest = sha256.hash(new TextEncoder().encode(challenge));
    const signature = binToHex(secp256k1.signMessageHashSchnorr(WALLET_KEY, digest) as Uint8Array);

    await request(app.getHttpServer())
      .post('/auth/session')
      .send({ pkh: WALLET_PKH, pubkey: binToHex(WALLET_PUBKEY), challenge, signature })
      .expect(201);
  });
});
