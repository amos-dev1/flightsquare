import { describe, expect, it, beforeEach } from 'vitest';

import { resetUuidv7Counter, uuidv7 } from '../src/uuidv7.js';

/** Deterministic, so the assertions are about layout rather than luck. */
const fixedRandom = (length: number) => new Uint8Array(length).fill(0xff);

describe('uuidv7', () => {
  beforeEach(() => resetUuidv7Counter());

  it('is a well-formed v7 uuid', () => {
    const id = uuidv7(Date.UTC(2026, 8, 20, 12, 0, 0), fixedRandom);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('sorts in creation order, which is the whole reason for v7', () => {
    // §6 chose v7 for time-sortable keys; §8.2 notes that is why it matters,
    // because the phone names the row before the server hears about it.
    const earlier = uuidv7(1_700_000_000_000, fixedRandom);
    const later = uuidv7(1_700_000_001_000, fixedRandom);
    expect(earlier < later).toBe(true);
  });

  it('stays ordered within a single millisecond', () => {
    // A pilot logging two legs in quick succession still gets ids that sort
    // the way the flights happened.
    const ids = Array.from({ length: 50 }, () => uuidv7(1_700_000_000_000, fixedRandom));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('encodes the timestamp it was given', () => {
    const when = Date.UTC(2026, 0, 2, 3, 4, 5);
    const id = uuidv7(when, fixedRandom);
    const millis = Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16);
    expect(millis).toBe(when);
  });

  it('produces distinct ids with real randomness', () => {
    const ids = new Set(Array.from({ length: 500 }, () => uuidv7()));
    expect(ids.size).toBe(500);
  });
});
