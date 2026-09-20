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
  logLevel: process.env.FS_LOG_LEVEL ?? 'info',
} as const;
