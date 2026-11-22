/**
 * Genesis-transaction fixtures for the discovery tests.
 *
 * Builds a real, libauth-encoded genesis transaction (`P.txid` = state category,
 * one `mutable` state NFT + escrow) so `validateGenesis` parses genuine bytes —
 * the same path the txserver takes against `getRawTx`. No live node.
 */
import { encodeTransaction, hexToBin } from '@bitauth/libauth';

/**
 * A token output as libauth's `Output` expects it.
 *
 * `category` is the **internal** (unreversed) byte order: libauth round-trips the
 * raw wire bytes verbatim, and the commitment stores `fundsCategory` in internal
 * order. This is the opposite of what explorers/Electrum print (display order).
 */
export interface GenesisOutput {
  lockingBytecode: string;
  valueSatoshis: bigint;
  token?: {
    category: string;
    amount: bigint;
    nft?: { capability: 'none' | 'mutable' | 'minting'; commitment: Uint8Array };
  };
}

export interface GenesisSpec {
  /** State-NFT category (hex, **internal** order — the raw libauth bytes). */
  stateCategory: string;
  /** Payment-asset category (hex, **internal** order — matches the commitment). */
  fundsCategory: string;
  /** Locking bytecode hex for the state NFT output. */
  stateLockingBytecode: string;
  /** Locking bytecode hex for the escrow output. */
  escrowLockingBytecode: string;
  /** Escrow token amount (seed included). */
  escrowAmount: bigint;
  /** State-NFT commitment bytes. */
  stateCommitment: Uint8Array;
  /** State-NFT capability. Defaults to `mutable`. */
  stateCapability?: 'none' | 'mutable' | 'minting';
  /** Drop the state NFT output (for the "no state" case). */
  omitState?: boolean;
  /** Drop the escrow output (for the "no escrow" case). */
  omitEscrow?: boolean;
  /** Extra outputs appended after the canonical pair. */
  extraOutputs?: GenesisOutput[];
}

const toOutput = (o: GenesisOutput) => ({
  lockingBytecode: hexToBin(o.lockingBytecode),
  valueSatoshis: o.valueSatoshis,
  ...(o.token === undefined
    ? {}
    : {
        token: {
          amount: o.token.amount,
          category: hexToBin(o.token.category),
          ...(o.token.nft === undefined ? {} : { nft: o.token.nft }),
        },
      }),
});

/** Build a genesis transaction and return its raw hex. */
export function buildGenesisTx(spec: GenesisSpec): string {
  const outputs: GenesisOutput[] = [];

  if (spec.omitState !== true) {
    outputs.push({
      lockingBytecode: spec.stateLockingBytecode,
      valueSatoshis: 1000n,
      token: {
        category: spec.stateCategory,
        amount: 0n,
        nft: {
          capability: spec.stateCapability ?? 'mutable',
          commitment: spec.stateCommitment,
        },
      },
    });
  }

  if (spec.omitEscrow !== true) {
    outputs.push({
      lockingBytecode: spec.escrowLockingBytecode,
      valueSatoshis: 1000n,
      token: { category: spec.fundsCategory, amount: spec.escrowAmount },
    });
  }

  if (spec.extraOutputs !== undefined) outputs.push(...spec.extraOutputs);

  const tx = {
    version: 2,
    inputs: [
      {
        outpointTransactionHash: new Uint8Array(32).fill(0x07),
        outpointIndex: 0,
        unlockingBytecode: new Uint8Array(0),
        sequenceNumber: 0xffffffff,
      },
    ],
    outputs: outputs.map(toOutput),
    locktime: 0,
  };

  return Buffer.from(encodeTransaction(tx)).toString('hex');
}
