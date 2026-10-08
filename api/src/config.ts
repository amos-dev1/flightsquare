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


/**
 * A role's credentials, as AWS Secrets Manager hands them over.
 *
 * The deployed API is given `APP_ROLE_SECRET`, whose value is the whole secret
 * as JSON — `{"username":"app_role","password":"…"}` — because that is what
 * App Runner's `environmentSecrets` and ECS's `secrets` both inject when no
 * single JSON key is named. So this parses rather than assuming a connection
 * string.
 *
 * Absent locally, where `docker compose` supplies the password through
 * `FS_APP_PASSWORD` and the default below is the dev one. That is the whole
 * reason this returns null rather than throwing: one code path, two
 * environments, and no `NODE_ENV` branch deciding which.
 *
 * A malformed secret throws, and should: starting with the wrong credentials
 * means the API either cannot connect or connects as something it should not
 * be, and §1.2's failure mode is silent.
 */
function roleSecret(
  raw: string | undefined,
  name: string,
): { username: string; password: string } | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} is set but is not JSON`);
  }
  const value = parsed as { username?: unknown; password?: unknown };
  if (typeof value.username !== 'string' || typeof value.password !== 'string') {
    throw new Error(`${name} must carry a username and a password`);
  }
  return { username: value.username, password: value.password };
}

const appRole = roleSecret(process.env.APP_ROLE_SECRET, 'APP_ROLE_SECRET');

// The mail worker's own role. Its own secret too, because the worker is its
// own process by design (api/src/mail/index.ts) and must not be reachable with
// app_role's credentials — app_role cannot read the outbox at all.
const mailRole = roleSecret(process.env.MAIL_ROLE_SECRET, 'MAIL_ROLE_SECRET');

export const config = {
  http: {
    host: process.env.FS_API_HOST ?? '127.0.0.1',
    port: int('FS_API_PORT', 3000),
  },
  db: {
    // `DB_HOST`/`DB_PORT`/`DB_NAME` are what the deployed stack sets; the
    // `FS_`-prefixed ones are local. Deployed wins where both exist, because
    // only one of them is ever set in a container.
    host: process.env.DB_HOST ?? process.env.FS_DB_HOST ?? '127.0.0.1',
    port: int('DB_PORT', int('FS_DB_PORT', 5432)),
    database: process.env.DB_NAME ?? process.env.FS_DB_NAME ?? 'flightsquare',
    // §9: the application never runs migrations and never holds the owner's
    // credentials. Startup asserts this is really what it connected as, which
    // is the check that makes a copied secret loud instead of silent.
    user: appRole?.username ?? process.env.FS_DB_USER ?? 'app_role',
    password: appRole?.password ?? process.env.FS_APP_PASSWORD ?? 'app_dev_password',
    max: int('FS_DB_POOL_MAX', 10),
    /**
     * TLS to RDS, and none to a container on this machine.
     *
     * `PGSSLMODE=require` is what the stack sets. `rejectUnauthorized: false`
     * is deliberate and is what `require` means in libpq: encrypt, but do not
     * verify the chain. Verifying would need the RDS CA bundle in the image;
     * worth doing, and a different change from making the thing deploy.
     */
    ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined,
  },
  clients: {
    minimumVersions: parseMinimumVersions(process.env.FS_MIN_CLIENT_VERSIONS),
  },
  /**
   * Object storage for §3.8's attachments.
   *
   * One interface in development and in production: MinIO speaks S3, so
   * deploying is a change of endpoint and credentials rather than a change of
   * code, and §9's deferred hosting decision stays deferred.
   *
   * `forcePathStyle` is what MinIO needs — bucket-in-the-hostname requires DNS
   * that a container on loopback does not have. Real S3 accepts it too.
   *
   * `FS_STORAGE_ENDPOINT` is the one switch between the two worlds, and the
   * credentials follow it rather than being decided separately:
   *
   *   unset  — the MinIO container on loopback, with the development key, so
   *            `docker compose up` needs no environment at all.
   *   set    — a real deployment. A key is used only if one was also supplied;
   *            otherwise none is passed and the SDK's provider chain finds the
   *            instance role.
   *
   * That last part is why they are one decision. Defaulting the key would hand
   * real S3 the string 'flightsquare' and a development password, which fails
   * as an authentication error rather than as a configuration one — and the
   * instance role sitting right there would never be tried.
   */
  storage: {
    ...(process.env.FS_STORAGE_ENDPOINT
      ? {
          endpoint: process.env.FS_STORAGE_ENDPOINT,
          accessKeyId: process.env.FS_STORAGE_KEY,
          secretAccessKey: process.env.FS_STORAGE_SECRET,
        }
      : {
          endpoint: 'http://127.0.0.1:9000',
          accessKeyId: process.env.FS_STORAGE_KEY ?? 'flightsquare',
          secretAccessKey: process.env.FS_STORAGE_SECRET ?? 'storage_dev_password',
        }),
    region: process.env.FS_STORAGE_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
    bucket: process.env.FS_STORAGE_BUCKET ?? process.env.S3_BUCKET ?? 'flightsquare',
    forcePathStyle: (process.env.FS_STORAGE_PATH_STYLE ?? 'true') === 'true',
    /**
     * How long a signed URL lives.
     *
     * Short, because it is a bearer credential for one object: anybody
     * holding the link can use it until it expires, which is exactly why the
     * API hands one out per request rather than storing a public URL.
     */
    urlTtlSeconds: int('FS_STORAGE_URL_TTL', 300),
    /**
     * A phone photograph or a scanned certificate, not a video (§8.2). Refused
     * before it is signed.
     *
     * One limit for every type rather than one per type. A per-type ceiling has
     * to be explained in the error — "images to 15 MB, PDFs to 25 MB" — and the
     * explanation buys nothing, because the limit people actually meet is
     * `storage.bytes`, which they can see in `/entitlements` and act on.
     *
     * 25 MiB covers a multi-page scan, and the free-tier arithmetic is worth
     * saying out loud: 1 GiB is about forty full-size documents, which is ample
     * for one aeroplane. §8.3 forbids crippling the free tier to drive
     * upgrades, and that is the number that honours it.
     */
    maxUploadBytes: int('FS_STORAGE_MAX_UPLOAD', 25 * 1024 * 1024),
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
    user: mailRole?.username ?? process.env.FS_DB_MAIL_USER ?? 'mail_role',
    password: mailRole?.password ?? process.env.FS_MAIL_PASSWORD ?? 'mail_dev_password',
    apiKey: process.env.FS_MAIL_API_KEY ?? '',
    from: process.env.FS_MAIL_FROM ?? 'FlightSquare <no-reply@flightsquare.local>',
    /**
     * Which transport sends. Explicit rather than inferred, because the
     * inference this replaced ("a key means Resend, no key means the log") has
     * no room for a third answer, and silently logging instead of sending is
     * the one failure mode that looks like success.
     *
     * 'ses' needs no key: it signs with the task role, which is why the
     * deployed worker holds no mail credential at all.
     */
    provider: (process.env.FS_MAIL_PROVIDER ?? '') as '' | 'ses' | 'resend' | 'log',
    region: process.env.FS_MAIL_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
    /**
     * Log the full body of every message, including its links and codes.
     *
     * Off by default and deliberately awkward to turn on. The log transport
     * has always refused to do this — a log line holding a live
     * password-reset URL defeats the reason `app_role` cannot read the outbox
     * in the first place — and that reasoning does not stop being true in a
     * deployed environment, where the log is CloudWatch and its retention
     * outlives the token by a month.
     *
     * It exists because SES in sandbox can only deliver to verified
     * addresses, so during setup the log is the only inbox an invited member
     * has. The dev stack sets it; the prod stack must never.
     */
    logBodies: (process.env.FS_MAIL_LOG_BODIES ?? '') === 'true',
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
   * The sweep (M8): `npm run sweep -w api`.
   *
   * Its own role, because enumerating tenants is the one thing nothing else
   * in the design may do, and its own process for the same reason the mail
   * worker is one.
   */
  scheduler: {
    user: process.env.FS_DB_SCHEDULER_USER ?? 'scheduler_role',
    password: process.env.FS_SCHEDULER_PASSWORD ?? 'scheduler_dev_password',
    /**
     * Hourly, since SPEC §9.
     *
     * It was daily, on the reasoning that maintenance moves on a scale of days
     * and a digest arriving more often than the thing it reports is noise. That
     * reasoning still holds for the *digest*, and the digest still only fires on
     * a state change — an item that has been overdue a month is news no more.
     *
     * What changed is what else the sweep does. It now re-evaluates date rules
     * in each aeroplane's own zone, expires grounding overrides, and flags
     * bookings standing over an aeroplane that went down. Those are answers that
     * go stale within the day: an override that ended at nine should not still
     * be letting people book at five.
     */
    everyHours: int('FS_SWEEP_EVERY_HOURS', 1),
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
     * Guesses against one MFA challenge, keyed on the challenge rather than on
     * the caller's address.
     *
     * Somebody here has already passed a password check — that is what the
     * second factor is for — so what needs limiting is attempts against *this*
     * attempt. Five of a million, and then the challenge is spent whether or
     * not it was ever right.
     */
    mfa: { max: int('FS_RATE_LIMIT_MFA_MAX', 5), timeWindow: '10 minutes' },
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
