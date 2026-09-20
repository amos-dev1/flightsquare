import { createHash } from 'node:crypto';

import { ConflictError, isUniqueViolation } from '../http/errors.js';
import { withTenant, type Tx } from './context.js';

/**
 * §8.2: every write carries an idempotency key.
 *
 * The post-flight screen is used in exactly the conditions that produce
 * duplicate submissions — one bar of signal at a tiedown, a retry, the app
 * backgrounded mid-request. Logging the same flight twice would advance the
 * meters twice, and every maintenance countdown downstream would be wrong by
 * one flight.
 *
 * The work and the key are written in **one transaction**, which is what
 * makes a genuine race safe: if two requests carry the same key, one commits
 * and the other's unique violation rolls back its own duplicate work along
 * with it. The loser then reads the winner's stored response and returns it.
 * No claim-then-fill, and no window where a key exists without a result.
 */

/** Stable across key order, so a re-serialised retry is still the same request. */
function fingerprint(body: unknown): string {
  const canonical = JSON.stringify(body, (_key, value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
    );
  });
  return createHash('sha256').update(canonical ?? 'null').digest('base64url');
}

export interface IdempotentOutcome<T> {
  status: number;
  body: T;
  /** True when this response was served from a previous identical request. */
  replayed: boolean;
}

async function readStored<T>(
  trx: Tx,
  key: string,
  endpoint: string,
  print: string,
): Promise<IdempotentOutcome<T> | null> {
  const row = await trx
    .selectFrom('idempotency_keys')
    .select(['endpoint', 'fingerprint', 'status_code', 'response'])
    .where('key', '=', key)
    .executeTakeFirst();

  if (!row) return null;

  // Same key, different request. Not a retry — a client bug, and telling it
  // so is far kinder than silently returning somebody else's answer.
  if (row.endpoint !== endpoint || row.fingerprint !== print) {
    throw new ConflictError('that idempotency key was used for a different request');
  }

  return { status: row.status_code, body: row.response as T, replayed: true };
}

export async function withIdempotency<T>(
  ctx: { tenantId: string; userId: string },
  key: string,
  endpoint: string,
  requestBody: unknown,
  work: (trx: Tx) => Promise<{ status: number; body: T }>,
): Promise<IdempotentOutcome<T>> {
  const print = fingerprint(requestBody);

  try {
    return await withTenant(ctx, async (trx) => {
      const stored = await readStored<T>(trx, key, endpoint, print);
      if (stored) return stored;

      const result = await work(trx);

      await trx
        .insertInto('idempotency_keys')
        .values({
          tenant_id: ctx.tenantId,
          key,
          endpoint,
          fingerprint: print,
          status_code: result.status,
          response: JSON.stringify(result.body),
        })
        .execute();

      return { ...result, replayed: false };
    });
  } catch (error) {
    // Lost a race. The winner's work is committed and ours is rolled back,
    // so the only thing left to do is read what they wrote.
    if (!isUniqueViolation(error)) throw error;

    const stored = await withTenant(ctx, (trx) => readStored<T>(trx, key, endpoint, print));
    if (!stored) throw error;
    return stored;
  }
}
