import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../src/client.js';
import {
  createMemoryQueueStore,
  discardFailed,
  flushQueue,
  retryFailed,
  type QueuedAttachment,
  type QueuedFlight,
  type QueuedSquawk,
} from '../src/offline.js';

function entry(overrides: Partial<QueuedFlight> = {}): QueuedFlight {
  return {
    kind: 'flight',
    id: overrides.id ?? 'flight-1',
    idempotencyKey: overrides.idempotencyKey ?? 'key-1',
    payload: { aircraft_id: 'a1', flight_date: '2026-09-20', hobbs_end: '1202.3' },
    recordedAt: overrides.recordedAt ?? '2026-09-20T18:00:00.000Z',
    queuedAt: '2026-09-20T18:00:05.000Z',
    attempts: 0,
    state: 'pending',
    ...overrides,
  };
}

/**
 * §8.2's offline queue. The failure this guards against is not a crash — it
 * is a flight logged twice, which puts every maintenance countdown
 * downstream out by one and nobody notices for months.
 */
describe('flushQueue', () => {
  it('sends what is waiting and clears it', async () => {
    const store = createMemoryQueueStore([entry()]);
    const submit = vi.fn().mockResolvedValue({});

    const result = await flushQueue(store, submit);

    expect(result).toEqual({ sent: 1, failed: 0, deferred: 0 });
    expect(await store.all()).toEqual([]);
  });

  it('reuses the same idempotency key on a retry', async () => {
    // The point of the whole mechanism: a dropped connection must not turn
    // one flight into two.
    const store = createMemoryQueueStore([entry({ idempotencyKey: 'stable-key' })]);
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({});

    await flushQueue(store, submit);
    await flushQueue(store, submit);

    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[0]![0].idempotencyKey).toBe('stable-key');
    expect(submit.mock.calls[1]![0].idempotencyKey).toBe('stable-key');
    expect(await store.all()).toEqual([]);
  });

  it('sends oldest flight first, by when it was flown', async () => {
    // §8.2: readings can arrive out of order and the server sorts by
    // recorded-at. Sending in order keeps a meter gap meaningful rather than
    // an artefact of which phone synced first.
    const store = createMemoryQueueStore([
      entry({ id: 'second', idempotencyKey: 'k2', recordedAt: '2026-09-20T15:00:00.000Z' }),
      entry({ id: 'first', idempotencyKey: 'k1', recordedAt: '2026-09-20T09:00:00.000Z' }),
    ]);
    const submit = vi.fn().mockResolvedValue({});

    await flushQueue(store, submit);

    expect(submit.mock.calls.map((call) => call[0].idempotencyKey)).toEqual(['k1', 'k2']);
  });

  it('carries a squawk filed on the same walk back, and sends it after the flight', async () => {
    // §8.2 is about the post-flight entry, and the defect noticed while
    // making it is filed in the same minute on the same field. Ordering by
    // when each happened is what lets the squawk name the flight it was
    // found on.
    const squawk: QueuedSquawk = {
      kind: 'squawk',
      id: 'squawk-1',
      idempotencyKey: 'sq-1',
      payload: { aircraft_id: 'a1', summary: 'Left brake soft', severity: 'grounding' },
      recordedAt: '2026-09-20T18:10:00.000Z',
      queuedAt: '2026-09-20T18:10:05.000Z',
      attempts: 0,
      state: 'pending',
    };
    const store = createMemoryQueueStore([squawk, entry()]);
    const submit = vi.fn().mockResolvedValue({});

    const result = await flushQueue(store, submit);

    expect(result).toEqual({ sent: 2, failed: 0, deferred: 0 });
    expect(submit.mock.calls.map((call) => call[0].kind)).toEqual(['flight', 'squawk']);
    expect(await store.all()).toEqual([]);
  });

  it('sends the flight, then the defect, then the photograph of it', async () => {
    // Three writes made within a minute of each other at the same tiedown,
    // and the order is not cosmetic: the squawk names the flight and the
    // photograph names the squawk, both by ids minted on the device before
    // any of them has reached the server (§8.2).
    const squawk: QueuedSquawk = {
      kind: 'squawk',
      id: 'squawk-1',
      idempotencyKey: 'sq-1',
      payload: { id: 'squawk-1', aircraft_id: 'a1', summary: 'Cracked fairing' },
      recordedAt: '2026-09-20T18:10:00.000Z',
      queuedAt: '2026-09-20T18:10:05.000Z',
      attempts: 0,
      state: 'pending',
    };
    const photo: QueuedAttachment = {
      kind: 'attachment',
      id: 'photo-1',
      idempotencyKey: 'ph-1',
      payload: {
        squawkId: 'squawk-1',
        localUri: 'file:///documents/attachments/photo-1.jpg',
        contentType: 'image/jpeg',
        byteSize: 482_133,
      },
      // One millisecond behind the squawk, which is the whole mechanism.
      recordedAt: '2026-09-20T18:10:00.001Z',
      queuedAt: '2026-09-20T18:10:06.000Z',
      attempts: 0,
      state: 'pending',
    };

    // Queued in the wrong order on purpose: the store is a set, and the
    // ordering is the algorithm's job rather than the insert order's.
    const store = createMemoryQueueStore([photo, squawk, entry()]);
    const submit = vi.fn().mockResolvedValue({});

    const result = await flushQueue(store, submit);

    expect(result).toEqual({ sent: 3, failed: 0, deferred: 0 });
    expect(submit.mock.calls.map((call) => call[0].kind)).toEqual([
      'flight',
      'squawk',
      'attachment',
    ]);
  });

  it('holds a photograph back when its own squawk has not gone yet', async () => {
    // The case this is really protecting: no signal, and the squawk defers.
    // A photograph sent anyway would be uploaded against a squawk id the
    // server has never heard of, and 404 is permanent — it would be parked
    // for a person while the squawk it belonged to sent perfectly well on the
    // next pass.
    const squawk: QueuedSquawk = {
      kind: 'squawk',
      id: 'squawk-2',
      idempotencyKey: 'sq-2',
      payload: { id: 'squawk-2', aircraft_id: 'a1', summary: 'Nav light out' },
      recordedAt: '2026-09-20T19:00:00.000Z',
      queuedAt: '2026-09-20T19:00:01.000Z',
      attempts: 0,
      state: 'pending',
    };
    const photo: QueuedAttachment = {
      kind: 'attachment',
      id: 'photo-2',
      idempotencyKey: 'ph-2',
      payload: {
        squawkId: 'squawk-2',
        localUri: 'file:///documents/attachments/photo-2.jpg',
        contentType: 'image/jpeg',
        byteSize: 1024,
      },
      recordedAt: '2026-09-20T19:00:00.001Z',
      queuedAt: '2026-09-20T19:00:02.000Z',
      attempts: 0,
      state: 'pending',
    };

    const store = createMemoryQueueStore([squawk, photo]);
    const submit = vi.fn().mockRejectedValue(new Error('network down'));

    const result = await flushQueue(store, submit);

    expect(result).toEqual({ sent: 0, failed: 0, deferred: 2 });
    // One attempt, on the squawk. The photograph was never tried.
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]![0].kind).toBe('squawk');

    const after = await store.all();
    expect(after.find((row) => row.id === 'photo-2')!.attempts).toBe(0);
    expect(after.every((row) => row.state === 'pending')).toBe(true);
  });

  it('leaves a transient failure pending, and stops trying the rest', async () => {
    const store = createMemoryQueueStore([
      entry({ id: 'a', idempotencyKey: 'ka', recordedAt: '2026-09-20T09:00:00.000Z' }),
      entry({ id: 'b', idempotencyKey: 'kb', recordedAt: '2026-09-20T10:00:00.000Z' }),
    ]);
    const submit = vi.fn().mockRejectedValue(new ApiError(503, null));

    const result = await flushQueue(store, submit);

    // If the network is down for one it is down for the next; hammering it
    // just burns battery on a phone that is already out of signal.
    expect(submit).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ sent: 0, failed: 0, deferred: 2 });
    const all = await store.all();
    expect(all.every((e) => e.state === 'pending')).toBe(true);
    expect(all.find((e) => e.id === 'a')!.attempts).toBe(1);
  });

  it('does not let a permanently broken write block the queue', async () => {
    // A 400 will not become a 201 by being sent again, and everything queued
    // behind it would wait forever.
    const store = createMemoryQueueStore([
      entry({ id: 'broken', idempotencyKey: 'kb', recordedAt: '2026-09-20T09:00:00.000Z' }),
      entry({ id: 'fine', idempotencyKey: 'kf', recordedAt: '2026-09-20T10:00:00.000Z' }),
    ]);
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(400, { error: 'invalid_request', detail: 'no meter' }))
      .mockResolvedValueOnce({});

    const result = await flushQueue(store, submit);

    expect(result).toEqual({ sent: 1, failed: 1, deferred: 0 });
    const remaining = await store.all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.state).toBe('failed');
    // Kept, with the reason, so a human can see what went wrong rather than
    // the flight silently disappearing.
    expect(remaining[0]!.lastError).toBe('no meter');
  });

  it('treats rate limiting and timeouts as "not now", not "not ever"', async () => {
    for (const status of [408, 429]) {
      const store = createMemoryQueueStore([entry()]);
      const submit = vi.fn().mockRejectedValue(new ApiError(status, null));

      const result = await flushQueue(store, submit);

      expect(result.failed, `status ${status}`).toBe(0);
      expect((await store.all())[0]!.state, `status ${status}`).toBe('pending');
    }
  });

  it('leaves entries already marked failed alone', async () => {
    const store = createMemoryQueueStore([entry({ state: 'failed' })]);
    const submit = vi.fn();

    const result = await flushQueue(store, submit);

    expect(submit).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, failed: 0, deferred: 0 });
  });
});

/**
 * The other half of a parked write.
 *
 * `flushQueue` only looks at `pending`, which is what makes a 4xx terminal —
 * and, until these existed, what made it a dead end: an entry could not be
 * retried, read or removed from the device, and the screen reporting it told
 * people to open it on the web, where there is no such screen. A flight that
 * cannot be retried is a meter reading nothing else has.
 */
describe('a refused write', () => {
  it('goes back in the queue and sends on the next pass', async () => {
    const store = createMemoryQueueStore([
      entry({ state: 'failed', attempts: 1, lastError: 'aircraft not found' }),
    ]);

    expect(await retryFailed(store, 'flight-1')).toBe(true);

    const [requeued] = await store.all();
    expect(requeued?.state).toBe('pending');
    expect(requeued?.lastError).toBeUndefined();
    // The count is kept: it is the honest record of how hard this has been,
    // and it is what says whether the problem was transient.
    expect(requeued?.attempts).toBe(1);

    const submit = vi.fn().mockResolvedValue({});
    expect(await flushQueue(store, submit)).toEqual({ sent: 1, failed: 0, deferred: 0 });
    expect(await store.all()).toEqual([]);
  });

  it('will not resurrect something that is already waiting', async () => {
    // A pending entry is not stuck, and "try again" on one would reset an
    // error that is about to be overwritten anyway.
    const store = createMemoryQueueStore([entry()]);
    expect(await retryFailed(store, 'flight-1')).toBe(false);
    expect((await store.all())[0]?.state).toBe('pending');
  });

  it('can be given up on, but only once it has actually failed', async () => {
    const pending = createMemoryQueueStore([entry()]);
    expect(await discardFailed(pending, 'flight-1')).toBe(false);
    expect(await pending.all()).toHaveLength(1);

    const failed = createMemoryQueueStore([entry({ state: 'failed', attempts: 2 })]);
    expect(await discardFailed(failed, 'flight-1')).toBe(true);
    expect(await failed.all()).toEqual([]);
  });

  it('says so when the entry is not there at all', async () => {
    const store = createMemoryQueueStore([]);
    expect(await retryFailed(store, 'gone')).toBe(false);
    expect(await discardFailed(store, 'gone')).toBe(false);
  });
});
