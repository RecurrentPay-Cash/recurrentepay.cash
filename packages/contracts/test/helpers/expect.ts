export interface ContractError {
  message: string;
}

/**
 * Runs a covenant transition and returns the require error it throws.
 *
 * CashScript's built-in `toFailRequire` funnels failures through `tx.debug()`, which
 * prints a multi-megabyte Bitauth IDE import URL for every scenario. That noise
 * dominates the test output and slows CI, so the suite uses this helper instead:
 * it sends the transaction (a failing require throws a plain `Error`) and returns
 * the message, leaving assertions to match on the require string.
 */
export async function requireError<T extends { send(): Promise<unknown> }>(
  tx: T,
): Promise<ContractError> {
  try {
    await tx.send();
  } catch (error) {
    return { message: error instanceof Error ? error.message : String(error) };
  }
  throw new Error('expected the transaction to fail a require statement, but it succeeded');
}

/** True when the transition succeeded (no require failure). */
export async function succeeds<T extends { send(): Promise<unknown> }>(tx: T): Promise<boolean> {
  try {
    await tx.send();
    return true;
  } catch {
    return false;
  }
}
