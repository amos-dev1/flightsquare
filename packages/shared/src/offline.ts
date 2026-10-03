import type { CreateFlightRequest, CreateSquawkRequest } from './index.js';
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

interface QueuedWriteBase {
  /** Client-generated UUIDv7 — the row names itself before the server hears of it. */
  id: string;
  /** Stable across every retry, which is what makes a retry safe. */
  idempotencyKey: string;
  /** When it happened. The server orders by this, not by arrival. */
  recordedAt: string;
  /** When it went into the queue, which may be days before it is sent. */
  queuedAt: string;
  attempts: number;
  state: QueuedState;
  lastError?: string;
}

export interface QueuedFlight extends QueuedWriteBase {
  kind: 'flight';
  payload: CreateFlightRequest;
}

/**
 * A squawk queues for the same reason a flight does, and usually in the same
 * minute: the defect is noticed on the walk back from the aeroplane, on the
 * same field with the same one bar of signal. A defect that did not get
 * reported because the form needed a network is the worst outcome available
 * here — the next pilot walks out to an aircraft nobody warned them about.
 */
export interface QueuedSquawk extends QueuedWriteBase {
  kind: 'squawk';
  payload: CreateSquawkRequest;
}

/**
 * A photograph of the defect, queued behind the defect.
 *
 * The only queue entry whose payload is not a request body: the bytes are on
 * the device's own filesystem, and the three-step upload (create a row, PUT
 * the file, record what arrived) belongs to the submitter rather than to the
 * queue. What is stored here is where to find the file and what to say about
 * it.
 *
 * The owner's id is client-generated, which is the whole reason
 * `CreateSquawkRequest` and `CreateCompletionRequest` both grew one. Both
 * writes are made in the same place at the same time and neither has reached
 * the server; without a device-side id the file would have nothing to point at
 * until its owner synced.
 *
 * Ordering does the rest. `flushQueue` sends oldest-recorded first and stops
 * at the first transient failure, so the squawk is created before the
 * photograph that names it — and if the squawk is permanently refused, the
 * attachment's 404 parks it beside the write it belonged to instead of
 * uploading a picture of nothing.
 */
export interface QueuedAttachment extends QueuedWriteBase {
  kind: 'attachment';
  payload: {
    /**
     * What this belongs to, named on the device (§8.2).
     *
     * Two owners queue: a squawk's photograph and a completion's invoice. The
     * second is why `CreateCompletionRequest` grew an id — a mark-complete is
     * filled in beside an open cowling with a paper invoice in hand, and a
     * hangar at the far end of a field is worse for signal than a tiedown, not
     * better.
     *
     * The failure mode is worse too. A squawk whose photograph fails is a
     * filed defect with no picture; a completion whose invoice fails after the
     * completion posted is a compliance record claiming paperwork that is not
     * there — and it cannot be fixed by re-saving the sheet, because
     * `compliance_records` takes inserts only and a second post would roll the
     * item forward twice.
     *
     * Aircraft documents do not queue. An insurance certificate arrives as an
     * email attachment from a broker and is filed at a desk, not on one bar.
     */
    owner:
      | { kind: 'squawk'; squawkId: string }
      | { kind: 'completion'; complianceRecordId: string };
    /** A file:// URI in the app's own document directory, not the picker cache. */
    localUri: string;
    contentType: string;
    byteSize: number;
    /** What the file is, for the UI that renders it later (0038). */
    fileKind?: 'photo' | 'invoice' | 'logbook_entry' | 'document';
  };
}

export type QueuedWrite = QueuedFlight | QueuedSquawk | QueuedAttachment;

export interface QueueStore {
  all(): Promise<QueuedWrite[]>;
  put(entry: QueuedWrite): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface FlushResult {
  sent: number;
  /** Entries that will never succeed and are now waiting on a human. */
  failed: number;
  /** Entries still pending because the network or the server was not ready. */
  deferred: number;
}

/**
 * A submitter, so tests do not need an HTTP layer.
 *
 * It takes the whole entry rather than a payload and a key, because which
 * endpoint a write belongs to is part of the entry and the queue is not the
 * place that decides it.
 */
export type SubmitWrite = (entry: QueuedWrite) => Promise<unknown>;

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
 * Send what is waiting, oldest first.
 *
 * Ordered by when the write *happened* rather than when it was queued: §8.2
 * says readings can arrive out of order and the server sorts by recorded-at,
 * but sending them in order keeps a meter gap meaningful instead of an
 * artefact of sync sequence. It also lands a flight before the squawk found
 * on it, which is what lets the squawk name the flight.
 *
 * Stops at the first transient failure. If the network is down for one write
 * it is down for the next, and hammering it just burns battery.
 */
export async function flushQueue(
  store: QueueStore,
  submit: SubmitWrite,
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
      await submit(entry);
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

/**
 * Put a parked entry back in the queue.
 *
 * `flushQueue` only ever looks at `pending`, which is what makes a 4xx
 * terminal — and, until this existed, what made it a dead end. A failed
 * entry could not be retried, edited or removed from the device, and the
 * screen that reported it told people to "open them on the web", where there
 * is no such screen. A flight that cannot be retried is a meter reading
 * nobody can recover.
 *
 * The attempt count is kept rather than reset. It is the honest record of
 * how hard this has been, and it is what tells somebody looking at the row
 * later whether the problem was transient.
 */
export async function retryFailed(store: QueueStore, id: string): Promise<boolean> {
  const entry = (await store.all()).find((candidate) => candidate.id === id);
  if (!entry || entry.state !== 'failed') return false;

  await store.put({ ...entry, state: 'pending', lastError: undefined });
  return true;
}

/**
 * Give up on one, permanently.
 *
 * Only for a `failed` entry, and only on an explicit instruction from the
 * person whose flight it is — §11 wants a destructive act worded plainly and
 * confirmed, and discarding one of these loses a meter reading that nothing
 * else in the system has.
 */
export async function discardFailed(store: QueueStore, id: string): Promise<boolean> {
  const entry = (await store.all()).find((candidate) => candidate.id === id);
  if (!entry || entry.state !== 'failed') return false;

  await store.remove(id);
  return true;
}

/** An in-memory store, used by the tests and as the reference implementation. */
export function createMemoryQueueStore(initial: QueuedWrite[] = []): QueueStore {
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
