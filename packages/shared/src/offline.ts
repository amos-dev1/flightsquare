import type { CreateFlightRequest } from './index.js';
import { ApiError } from './client.js';

/**
 * The offline write queue (§8.2).
 *
 * "The most important screen in the product is used standing at a tiedown on
 * a rural field with one bar or none. If post-flight entry requires
 * connectivity, it doesn't get done" — and §3.4's failure mode arrives by a
 * different road: stale meters and wrong maintenance numbers.
 *
 * This module is deliberately free of React Native imports so its behaviour
 * can be tested in Node. The device supplies a store; expo-sqlite is one
 * implementation of that interface and not a dependency of the logic.
 */

export type QueuedState = 'pending' | 'failed';

export interface QueuedFlight {
  /** Client-generated UUIDv7 — the row names itself before the server hears of it. */
  id: string;
  /** Stable across every retry, which is what makes a retry safe. */
  idempotencyKey: string;
  payload: CreateFlightRequest;
  /** When the flight ended. The server orders by this, not by arrival. */
  recordedAt: string;
  /** When it went into the queue, which may be days before it is sent. */
  queuedAt: string;
  attempts: number;
  state: QueuedState;
  lastError?: string;
}

export interface QueueStore {
  all(): Promise<QueuedFlight[]>;
  put(entry: QueuedFlight): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface FlushResult {
  sent: number;
  /** Entries that will never succeed and are now waiting on a human. */
  failed: number;
  /** Entries still pending because the network or the server was not ready. */
  deferred: number;
}

/** A submitter, so tests do not need an HTTP layer. */
export type SubmitFlight = (
  payload: CreateFlightRequest,
  idempotencyKey: string,
) => Promise<unknown>;

/**
 * A 4xx will not become a 2xx by being sent again: the payload is wrong, the
 * aircraft is gone, or the key was reused for a different request. Retrying
 * those forever would block everything queued behind them.
 *
 * 408 and 429 are the exceptions — both mean "not now" rather than "not ever".
 */
function isPermanent(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 408 || error.status === 429) return false;
  return error.status >= 400 && error.status < 500;
}

/**
 * Send what is waiting, oldest flight first.
 *
 * Ordered by when the flight *happened* rather than when it was queued: §8.2
 * says readings can arrive out of order and the server sorts by recorded-at,
 * but sending them in order keeps a meter gap meaningful instead of an
 * artefact of sync sequence.
 *
 * Stops at the first transient failure. If the network is down for one write
 * it is down for the next, and hammering it just burns battery.
 */
export async function flushQueue(
  store: QueueStore,
  submit: SubmitFlight,
  now: () => string = () => new Date().toISOString(),
): Promise<FlushResult> {
  const entries = (await store.all())
    .filter((entry) => entry.state === 'pending')
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));

  const result: FlushResult = { sent: 0, failed: 0, deferred: 0 };

  for (const [index, entry] of entries.entries()) {
    try {
      // The same key every time. A replay returns the original response
      // rather than logging the flight twice, which would put every
      // maintenance countdown downstream out by one.
      await submit(entry.payload, entry.idempotencyKey);
      await store.remove(entry.id);
      result.sent += 1;
    } catch (error) {
      if (isPermanent(error)) {
        await store.put({
          ...entry,
          state: 'failed',
          attempts: entry.attempts + 1,
          lastError: describe(error),
          queuedAt: entry.queuedAt || now(),
        });
        result.failed += 1;
        continue;
      }

      await store.put({
        ...entry,
        attempts: entry.attempts + 1,
        lastError: describe(error),
      });
      // Everything behind this one stays pending, untouched.
      result.deferred = entries.length - index;
      return result;
    }
  }

  return result;
}

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { error?: string; detail?: string } | null;
    return body?.detail ?? body?.error ?? `HTTP ${error.status}`;
  }
  return error instanceof Error ? error.message : 'Unknown error';
}

/** An in-memory store, used by the tests and as the reference implementation. */
export function createMemoryQueueStore(initial: QueuedFlight[] = []): QueueStore {
  const entries = new Map(initial.map((entry) => [entry.id, entry]));
  return {
    all: async () => [...entries.values()],
    put: async (entry) => {
      entries.set(entry.id, entry);
    },
    remove: async (id) => {
      entries.delete(id);
    },
  };
}
