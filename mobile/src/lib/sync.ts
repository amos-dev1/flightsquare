import {
  discardFailed,
  flushQueue,
  retryFailed,
  uuidv7,
  type CreateFlightRequest,
  type CreateSquawkRequest,
  type FlushResult,
  type QueuedWrite,
} from '@flightsquare/shared';

import { api, withAuth } from './api';
import { sqliteQueueStore } from './queue';

/**
 * Saving always succeeds.
 *
 * §8.2: the most important screen in the product is used standing at a
 * tiedown on a rural field with one bar or none. If post-flight entry
 * requires connectivity it does not get done, and §3.4's failure mode —
 * stale meters, wrong maintenance numbers — arrives by a different road.
 *
 * So the write lands in SQLite first and syncs afterwards. The id and the
 * idempotency key are minted here, on the device, before the server has
 * heard of either.
 */
export async function saveFlight(payload: CreateFlightRequest): Promise<string> {
  const id = uuidv7();
  const now = new Date().toISOString();

  await sqliteQueueStore.put({
    kind: 'flight',
    id,
    // One key for this flight, for the life of the queue entry. Every retry
    // presents the same one, which is what stops a dropped connection from
    // turning one flight into two.
    idempotencyKey: id,
    payload: { ...payload, recorded_at: payload.recorded_at ?? now },
    recordedAt: payload.recorded_at ?? now,
    queuedAt: now,
    attempts: 0,
    state: 'pending',
  });

  // Best effort. Failing here is not a failure to save.
  void sync();
  return id;
}

/**
 * A defect, queued for exactly the same reason.
 *
 * It is noticed on the walk back from the aeroplane, on the same field with
 * the same missing signal — and of the two writes, this is the one that must
 * not be lost. A flight that syncs late leaves the meters stale for an hour.
 * A squawk that was never filed because the form wanted a network leaves the
 * next pilot walking out to an aircraft nobody warned them about.
 */
export async function saveSquawk(payload: CreateSquawkRequest): Promise<string> {
  const id = uuidv7();
  const now = new Date().toISOString();

  await sqliteQueueStore.put({
    kind: 'squawk',
    id,
    idempotencyKey: id,
    payload: { ...payload, reported_at: payload.reported_at ?? now },
    recordedAt: payload.reported_at ?? now,
    queuedAt: now,
    attempts: 0,
    state: 'pending',
  });

  void sync();
  return id;
}

/** Which endpoint a queued write belongs to. The queue does not decide it. */
function submit(entry: QueuedWrite): Promise<unknown> {
  return withAuth<unknown>(() =>
    entry.kind === 'squawk'
      ? api.createSquawk(entry.payload, entry.idempotencyKey)
      : api.createFlight(entry.payload, entry.idempotencyKey),
  );
}

export async function sync(): Promise<FlushResult> {
  return flushQueue(sqliteQueueStore, submit);
}

/** Everything on the device, for the screen that shows it. */
export async function queued(): Promise<QueuedWrite[]> {
  return sqliteQueueStore.all();
}

/**
 * Put a refused write back in the queue, or give up on it.
 *
 * Both live in `packages/shared/src/offline.ts` beside the algorithm they
 * complement, so they are tested in Node rather than on a phone. These two
 * lines are the whole of what this workspace adds: the store.
 */
export async function retry(id: string): Promise<boolean> {
  return retryFailed(sqliteQueueStore, id);
}

export async function discard(id: string): Promise<boolean> {
  return discardFailed(sqliteQueueStore, id);
}

export async function pendingCount(): Promise<{ pending: number; failed: number }> {
  const all = await sqliteQueueStore.all();
  return {
    pending: all.filter((entry) => entry.state === 'pending').length,
    failed: all.filter((entry) => entry.state === 'failed').length,
  };
}
