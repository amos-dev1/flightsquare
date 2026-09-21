import { flushQueue, uuidv7, type CreateFlightRequest, type FlushResult } from '@flightsquare/shared';

import { api, withAuth } from './api';
import { sqliteQueueStore } from './queue';

/**
 * Saving a flight always succeeds.
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

export async function sync(): Promise<FlushResult> {
  return flushQueue(sqliteQueueStore, (payload, idempotencyKey) =>
    withAuth(() => api.createFlight(payload, idempotencyKey)),
  );
}

export async function pendingCount(): Promise<{ pending: number; failed: number }> {
  const all = await sqliteQueueStore.all();
  return {
    pending: all.filter((entry) => entry.state === 'pending').length,
    failed: all.filter((entry) => entry.state === 'failed').length,
  };
}
