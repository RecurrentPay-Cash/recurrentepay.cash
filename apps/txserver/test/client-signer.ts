/**
 * Test-only **client signer** for the mutual-consent relay (Slice 7).
 *
 * The relay never holds a key: `prepare` returns an **unsigned** tx (with
 * correctly-sized P2PKH placeholders) plus the `signableInputs` descriptors. The
 * party signs **client-side** — this helper models that wallet. It lives in the
 * test tree on purpose: it is the stand-in for the real wallet, and it proves the
 * relay's no-key path end to end.
 *
 * It signs each P2PKH input with `SIGHASH_ALL | SIGHASH_FORKID` (0x41) using
 * libauth's signing serialization, producing a 64-byte Schnorr signature + the
 * compressed pubkey as the unlocking bytecode — exactly what a P2PKH wallet does.
 */
import {
  binToHex,
  decodeTransaction,
  encodeAuthenticationInstructions,
  encodeTransaction,
  generateSigningSerializationBch,
  hash256,
  hexToBin,
  secp256k1,
} from '@bitauth/libauth';

/** A signable input descriptor returned by the relay's `prepare`. */
export interface SignableInput {
  index: number;
  lockingBytecode: string;
  satoshis: string;
  token?: { category: string; amount: string };
}

/**
 * Sign a prepared (unsigned) tx client-side.
 *
 * @param unsignedHex - The relay's `unsignedHex` (placeholders in place).
 * @param signableInputs - The presence/funding input descriptors.
 * @param keyByLockingBytecode - The key controlling each input, keyed by its
 *   P2PKH locking bytecode (lowercase hex). The test holds these; the relay does not.
 * @returns The fully-signed tx hex.
 */
export function signPrepared(
  unsignedHex: string,
  signableInputs: readonly SignableInput[],
  keyByLockingBytecode: Record<string, Uint8Array>,
): string {
  const decoded = decodeTransaction(hexToBin(unsignedHex));
  if (typeof decoded === 'string') throw new Error(decoded);
  const tx = decoded;

  // The source outputs for the signed indices (SIGHASH_ALL commits to the covered
  // input's own output; the others are placeholders the preimage does not read).
  const sourceOutputs: Array<{
    lockingBytecode: Uint8Array;
    valueSatoshis: bigint;
    token?: { category: Uint8Array; amount: bigint };
  }> = tx.inputs.map(() => ({
    lockingBytecode: new Uint8Array(0),
    valueSatoshis: 0n,
  }));
  for (const si of signableInputs) {
    sourceOutputs[si.index] = {
      lockingBytecode: hexToBin(si.lockingBytecode.toLowerCase()),
      valueSatoshis: BigInt(si.satoshis),
      // The signing serialization commits to the input's token (a `migrate`
      // funding input carries one; the presence inputs do not).
      token: si.token && {
        category: hexToBin(si.token.category),
        amount: BigInt(si.token.amount),
      },
    };
  }

  // Sign every input against the SAME tx (the preimage commits to all inputs'
  // unlocking bytecode, so each signature must be computed before any is written).
  const signatures = signableInputs.map((si) => {
    const lock = si.lockingBytecode.toLowerCase();
    const key = keyByLockingBytecode[lock];
    if (key === undefined) throw new Error(`signPrepared: no key for ${lock}`);
    const preimage = generateSigningSerializationBch(
      { transaction: tx, sourceOutputs, inputIndex: si.index },
      { coveredBytecode: hexToBin(lock), signingSerializationType: Uint8Array.of(0x41) },
    );
    const digest = hash256(preimage);
    const sig = secp256k1.signMessageHashSchnorr(key, digest) as Uint8Array;
    const pubkey = secp256k1.derivePublicKeyCompressed(key) as Uint8Array;
    // A transaction signature is the 64-byte Schnorr signature + the sighash-type
    // byte (0x41 = SIGHASH_ALL | SIGHASH_FORKID).
    return { index: si.index, txSignature: Uint8Array.from([...sig, 0x41]), pubkey };
  });

  // P2PKH unlocking bytecode: push the signature then the pubkey, using the
  // minimal push opcode for each length (65 B → OP_PUSHDATA_1, 33 B → OP_PUSHBYTES_33).
  const push = (data: Uint8Array) => ({ opcode: data.length < 76 ? data.length : 0x4c, data });
  for (const { index, txSignature, pubkey } of signatures) {
    tx.inputs[index]!.unlockingBytecode = encodeAuthenticationInstructions([
      push(txSignature),
      push(pubkey),
    ]);
  }

  return binToHex(encodeTransaction(tx));
}
