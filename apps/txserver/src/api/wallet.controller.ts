/**
 * Wallet UTXO lookup (dapp-handoff §3, P0).
 *
 * The web app has no indexer. This authenticated read lets a connected wallet
 * (a) build the auth challenge and (b) select inputs for `fund` / `reactivate`
 * / `withdraw` / `modify` / `migrate`. It reuses the Electrum/Fulcrum watcher
 * (`CHAIN_WATCHER`) — no new indexer — and is **scoped to the caller's own
 * pkh**: a caller may only enumerate UTXOs for their own pkh (or an address that
 * decodes to that same pkh). A mismatched `pkh` is a `403`; unauthenticated is
 * a `401` (the guard).
 */
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  binToHex,
  cashAddressToLockingBytecode,
  encodeLockingBytecodeP2pkh,
  hexToBin,
  lockingBytecodeToCashAddress,
} from '@bitauth/libauth';
import { AuthGuard, type AuthedRequest } from '../auth/auth.guard.js';
import { CHAIN_WATCHER, type ChainWatcher, type WatchedUtxo } from '../watcher/chain-watcher.js';

/** A UTXO as the wallet API exposes it (dapp-handoff §3 shape). */
export interface WalletUtxoView {
  txid: string;
  vout: number;
  satoshis: string;
  lockingBytecode: string;
  address: string;
  token?: { category: string; amount: string; nft: null };
}

/** The CashAddress prefix the txserver encodes for display (testnet/chipnet). */
const CASH_ADDRESS_PREFIX = 'bchtest';

@Controller('wallet')
@UseGuards(AuthGuard)
export class WalletController {
  constructor(
    @Inject(CHAIN_WATCHER) private readonly watcher: ChainWatcher,
    private readonly guard: AuthGuard,
  ) {}

  /**
   * `GET /wallet/utxos?pkh=<hex>` or `?address=<cashaddr>`.
   *
   * `pkh` is preferred: the txserver computes the standard P2PKH lock for the
   * pkh and reads the watcher. `address` is decoded to its locking bytecode and
   * must belong to the caller's pkh (a P2PKH address whose hash160 is the
   * caller's pkh). Either way the read is scoped to the caller.
   */
  @Get('utxos')
  async utxos(
    @Req() request: AuthedRequest,
    @Query('pkh') pkh?: string,
    @Query('address') address?: string,
  ): Promise<WalletUtxoView[]> {
    const caller = this.guard.caller(request);

    if (pkh !== undefined && pkh !== '') {
      if (normalizePkh(pkh) !== caller) {
        throw new ForbiddenException('pkh does not match the authenticated caller');
      }
      const lockingBytecode = binToHex(encodeLockingBytecodeP2pkh(hexToBin(caller)));
      return this.readUtxos(lockingBytecode);
    }

    if (address !== undefined && address !== '') {
      const decoded = cashAddressToLockingBytecode(address);
      if (typeof decoded === 'string') {
        throw new BadRequestException(`invalid address: ${decoded}`);
      }
      const lockingBytecode = binToHex(decoded.bytecode);
      if (lockingBytecode !== binToHex(encodeLockingBytecodeP2pkh(hexToBin(caller)))) {
        throw new ForbiddenException('address does not belong to the authenticated caller');
      }
      return this.readUtxos(lockingBytecode);
    }

    throw new BadRequestException('pkh or address is required');
  }

  /** Read the watcher's UTXO set for a locking bytecode and map it to the API view. */
  private async readUtxos(lockingBytecode: string): Promise<WalletUtxoView[]> {
    const utxos = await this.watcher.getUtxos(lockingBytecode);
    return utxos.map((utxo) => toWalletUtxo(utxo, lockingBytecode));
  }
}

/** Map a watcher UTXO to the wallet API view (token nested, `nft: null`). */
function toWalletUtxo(utxo: WatchedUtxo, lockingBytecode: string): WalletUtxoView {
  const view: WalletUtxoView = {
    txid: utxo.txid,
    vout: utxo.vout,
    satoshis: utxo.satoshis.toString(),
    lockingBytecode,
    address: encodeAddress(lockingBytecode),
  };
  if (utxo.category !== undefined && utxo.amount !== undefined) {
    view.token = { category: utxo.category, amount: utxo.amount.toString(), nft: null };
  }
  return view;
}

/** Encode a locking bytecode as a CashAddress, falling back to the raw hex. */
function encodeAddress(lockingBytecode: string): string {
  const result = lockingBytecodeToCashAddress({
    bytecode: hexToBin(lockingBytecode),
    prefix: CASH_ADDRESS_PREFIX,
  });
  return typeof result === 'string' ? lockingBytecode : result.address;
}

/** Canonical pkh form (lowercase hex) — matches the account/session convention. */
function normalizePkh(pkh: string): string {
  return pkh.trim().toLowerCase();
}
