import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load the repo-root .env, the same file docker compose and scripts/lib.sh
 * read, without taking a dependency for twenty lines. Existing environment
 * variables win, so a real deployment's configuration is never overwritten.
 */
function loadRootEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = join(here, '..', '..', '..', '.env');
  let contents: string;
  try {
    contents = readFileSync(envPath, 'utf8');
  } catch {
    return; // Defaults below match .env.example, so this is not an error.
  }
  for (const line of contents.split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match as unknown as [string, string, string];
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^["'](.*)["']$/, '$1');
  }
}

loadRootEnv();

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * Minimum supported client versions (§8.1), as "ios=1.4.0,web=2.0.0".
 *
 * A shipped iOS build cannot be force-updated, so the handshake that lets the
 * API say "you are too old" has to exist from day one — it cannot be added
 * retroactively to binaries already on people's phones. Empty by default:
 * nothing is rejected until someone sets a floor.
 */
function parseMinimumVersions(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const entry of raw.split(',')) {
    const [client, version] = entry.split('=').map((part) => part.trim());
    if (client && version) out[client] = version;
  }
  return out;
}

export const config = {
  http: {
    host: process.env.FS_API_HOST ?? '127.0.0.1',
    port: int('FS_API_PORT', 3000),
  },
  db: {
    host: process.env.FS_DB_HOST ?? '127.0.0.1',
    port: int('FS_DB_PORT', 5432),
    database: process.env.FS_DB_NAME ?? 'flightsquare',
    // §9: the application never runs migrations and never holds the owner's
    // credentials. Startup asserts this is really what it connected as.
    user: process.env.FS_DB_USER ?? 'app_role',
    password: process.env.FS_APP_PASSWORD ?? 'app_dev_password',
    max: int('FS_DB_POOL_MAX', 10),
  },
  clients: {
    minimumVersions: parseMinimumVersions(process.env.FS_MIN_CLIENT_VERSIONS),
  },
  web: {
    /**
     * Where the links in emails point. The API is not a place a person
     * clicks — verification, invitation and reset all land on a page in the
     * web app, which then calls back here.
     */
    baseUrl: process.env.FS_WEB_URL ?? 'http://127.0.0.1:3001',
  },
  /**
   * The mail sender (M8). Runs as its own database role and its own process:
   * `npm run mail -w api`.
   *
   * With no API key it logs each message and marks it delivered, which is a
   * real pass through the worker rather than a skipped one —
   * `scripts/outbox.sh` is where a link is actually read in development.
   */
  mail: {
    user: process.env.FS_DB_MAIL_USER ?? 'mail_role',
    password: process.env.FS_MAIL_PASSWORD ?? 'mail_dev_password',
    apiKey: process.env.FS_MAIL_API_KEY ?? '',
    from: process.env.FS_MAIL_FROM ?? 'FlightSquare <no-reply@flightsquare.local>',
    /** How often to look, when the last look found nothing. */
    pollSeconds: int('FS_MAIL_POLL_SECONDS', 10),
    /** How many to take in one pass. */
    batchSize: int('FS_MAIL_BATCH', 20),
    /**
     * After this many failures a message is left alone with its last error,
     * for a person. A queue that retries forever is how a sending domain
     * gets itself blocked.
     */
    maxAttempts: int('FS_MAIL_MAX_ATTEMPTS', 8),
  },
  /**
   * Platform billing (§8.3) — tenant to FlightSquare, web only.
   *
   * With no secret key the API runs the stub provider, which signs and
   * delivers the same events to the same endpoint. That is not a degraded
   * mode for development: it is how the whole flow is tested, and turning it
   * into the real thing is these two variables and nothing else.
   */
  billing: {
    secretKey: process.env.FS_STRIPE_SECRET_KEY ?? '',
    /**
     * Stripe prints this when you run `stripe listen`. The stub's default is
     * a fixed development string on purpose — it is not a secret, because
     * the only thing it authenticates is this process talking to itself.
     */
    webhookSecret: process.env.FS_STRIPE_WEBHOOK_SECRET ?? 'whsec_stub_development',
    /**
     * Where this API answers, from the outside. The stub builds its own
     * checkout and portal URLs against it, and they are visited by a
     * browser — so in development it must be the host the web app is served
     * from (127.0.0.1, not localhost; see web/next.config.ts).
     */
    apiBaseUrl:
      process.env.FS_API_PUBLIC_URL ??
      `http://${process.env.FS_API_HOST ?? '127.0.0.1'}:${int('FS_API_PORT', 3000)}`,
  },
  /**
   * Rate limits on the unauthenticated endpoints. 429 is requests per unit
   * time and is never a plan quota (§1.6) — nothing here touches
   * entitlements, and nothing in entitlements reaches here.
   *
   * Configurable because the right number is an operational question, and
   * because the test suite has to be able to exercise both the limit and the
   * behaviour behind it.
   */
  rateLimits: {
    signup: { max: int('FS_RATE_LIMIT_SIGNUP_MAX', 5), timeWindow: '1 hour' },
    login: { max: int('FS_RATE_LIMIT_LOGIN_MAX', 10), timeWindow: '5 minutes' },
    refresh: { max: int('FS_RATE_LIMIT_REFRESH_MAX', 60), timeWindow: '5 minutes' },
    /**
     * The webhook is unauthenticated in the session sense — anyone can POST
     * at it, and the signature is what decides whether it is listened to.
     * Generous, because a real provider retries in bursts and a dropped
     * webhook is a plan that silently never changed.
     */
    webhook: { max: int('FS_RATE_LIMIT_WEBHOOK_MAX', 300), timeWindow: '1 minute' },
  },
  logLevel: process.env.FS_LOG_LEVEL ?? 'info',
} as const;
