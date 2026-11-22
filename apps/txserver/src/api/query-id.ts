/**
 * Parse a numeric query filter (`channel`/`plan`/`channelId`), or `undefined`
 * when absent/invalid.
 *
 * Strict: only a plain positive integer is accepted. `Number.isInteger` alone
 * lets `1e3`, `0x10`, `-5` and `0` through; those are rejected here so a typo
 * fails closed (the caller treats `undefined` as "no filter" or "empty result",
 * never "match everything"). Shared by the subscription filter and the plan
 * data API so the two cannot drift (Slice 6 review Nit 6/7).
 */
export function parseId(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
