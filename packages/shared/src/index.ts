/**
 * Shared domain for RecurrentPay.Cash.
 *
 * This package is the **single source of truth** for the off-chain derivation of
 * subscription state. It does NOT fork the contract's codec — it re-exports
 * `packages/contracts/src` so the txserver, the web app and the contract tests
 * can never drift apart (design.md § Escrow identity, § Settlement semantics).
 */
export * from './commitment.js';
export * from './escrow.js';
export * from './fee.js';
export * from './derived-state.js';
// Namespaced: the oracle names (`MODE`, `DUST`, `perPeriodFee`, `encodeCommitment`)
// collide with the token ones, so they must not be flattened into this module.
export * as oracle from './oracle.js';
