/**
 * Validated environment configuration for the txserver.
 *
 * Secrets (the platform service key) live **only** in the environment — never in
 * the repo (design.md § Platform authorization). `.env.example` carries
 * placeholders only.
 */
export interface AppConfig {
  /** Postgres connection string. */
  databaseUrl: string;
  /** Electrum/Fulcrum server URL (chipnet by default). */
  electrumUrl: string;
  /** Chain-watcher implementation: `electrum` (default) or `mock`. */
  chainWatcher: 'electrum' | 'mock';
  /** Platform service pkh (hex) — the presence input for authorized txs. */
  servicePkh?: string;
  /** Platform service private key (hex) — env only, never committed. */
  serviceKey?: string;
  /** General Protocols oracle relay REST base URL (BCH subs). */
  oracleUrl: string;
  /** Top-up warning buffer as a fraction (e.g. 1.05 = 105%). */
  bufferPercent: number;
  /** Mutual-consent proposal expiry window, in seconds (default 24h). */
  proposalExpirySeconds: number;
  /** HTTP port. */
  port: number;
  /**
   * CORS allow-list (browser origins that may call the txserver directly, e.g.
   * the Next.js web app). Empty in production means "deny all cross-origin
   * requests" — the browser is the only client that needs CORS, and bearer
   * auth means no credentials are involved. Dev defaults to the local web app.
   */
  corsOrigins: string[];
}

const DEFAULTS = {
  electrumUrl: 'tcp://chipnet.imaginary.cash:50001',
  // The live General Protocols oracle relay. The client appends `/oracleMessages`.
  oracleUrl: 'https://oracles.generalprotocols.com/api/v1',
  bufferPercent: 1.05,
  // Spec § Mutual-consent relay — a proposal expires after 24h by default.
  proposalExpirySeconds: 24 * 60 * 60,
  port: 3001,
  // Dev default: the local Next.js web app. Production sets CORS_ORIGINS
  // explicitly (an empty value there denies all cross-origin requests).
  corsOrigins: ['http://localhost:3000'],
} as const;

/** Parse and validate the environment. Throws on missing/invalid required vars. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    throw new Error('config: DATABASE_URL is required');
  }

  const bufferRaw = env.BUFFER_PERCENT;
  const bufferPercent = bufferRaw === undefined ? DEFAULTS.bufferPercent : Number(bufferRaw);
  if (!Number.isFinite(bufferPercent) || bufferPercent < 1) {
    throw new Error('config: BUFFER_PERCENT must be a number >= 1 (e.g. 1.05)');
  }

  const portRaw = env.PORT;
  const port = portRaw === undefined ? DEFAULTS.port : Number(portRaw);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('config: PORT must be a positive integer');
  }

  const expiryRaw = env.PROPOSAL_EXPIRY_SECONDS;
  const proposalExpirySeconds =
    expiryRaw === undefined ? DEFAULTS.proposalExpirySeconds : Number(expiryRaw);
  if (!Number.isInteger(proposalExpirySeconds) || proposalExpirySeconds <= 0) {
    throw new Error('config: PROPOSAL_EXPIRY_SECONDS must be a positive integer');
  }

  return {
    databaseUrl,
    electrumUrl: env.ELECTRUM_URL ?? DEFAULTS.electrumUrl,
    chainWatcher: env.CHAIN_WATCHER === 'mock' ? 'mock' : 'electrum',
    servicePkh: env.SERVICE_PKH,
    serviceKey: env.SERVICE_KEY,
    oracleUrl: env.ORACLE_URL ?? DEFAULTS.oracleUrl,
    bufferPercent,
    proposalExpirySeconds,
    port,
    corsOrigins: parseCorsOrigins(env.CORS_ORIGINS),
  };
}

/**
 * Parse the comma-separated `CORS_ORIGINS` allow-list.
 *
 * - Unset → the dev default (`http://localhost:3000`).
 * - Set to an empty/whitespace string → `[]` (deny all cross-origin requests).
 * - Otherwise → the trimmed, non-empty entries.
 */
function parseCorsOrigins(raw: string | undefined): string[] {
  if (raw === undefined) return [...DEFAULTS.corsOrigins];
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');
}
