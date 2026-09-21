import * as SQLite from 'expo-sqlite';
import type { QueueStore, QueuedFlight } from '@flightsquare/shared';

/**
 * expo-sqlite behind the QueueStore interface from packages/shared.
 *
 * All the behaviour that can be got wrong — ordering, retry, when to give up
 * — lives in the shared module and is tested in Node. This file is only
 * storage, which is why it is this short.
 */

let database: SQLite.SQLiteDatabase | null = null;

export async function openQueue(): Promise<SQLite.SQLiteDatabase> {
  database ??= await SQLite.openDatabaseAsync('flightsquare.db');
  await database.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS queued_flights (
      id              TEXT PRIMARY KEY NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload         TEXT NOT NULL,
      recorded_at     TEXT NOT NULL,
      queued_at       TEXT NOT NULL,
      attempts        INTEGER NOT NULL DEFAULT 0,
      state           TEXT NOT NULL DEFAULT 'pending',
      last_error      TEXT
    );
  `);
  return database;
}

interface Row {
  id: string;
  idempotency_key: string;
  payload: string;
  recorded_at: string;
  queued_at: string;
  attempts: number;
  state: string;
  last_error: string | null;
}

function toEntry(row: Row): QueuedFlight {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    payload: JSON.parse(row.payload) as QueuedFlight['payload'],
    recordedAt: row.recorded_at,
    queuedAt: row.queued_at,
    attempts: row.attempts,
    state: row.state === 'failed' ? 'failed' : 'pending',
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}

export const sqliteQueueStore: QueueStore = {
  async all() {
    const db = await openQueue();
    const rows = await db.getAllAsync<Row>('SELECT * FROM queued_flights');
    return rows.map(toEntry);
  },

  async put(entry) {
    const db = await openQueue();
    await db.runAsync(
      `INSERT INTO queued_flights
         (id, idempotency_key, payload, recorded_at, queued_at, attempts, state, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         attempts = excluded.attempts,
         state = excluded.state,
         last_error = excluded.last_error`,
      [
        entry.id,
        entry.idempotencyKey,
        JSON.stringify(entry.payload),
        entry.recordedAt,
        entry.queuedAt,
        entry.attempts,
        entry.state,
        entry.lastError ?? null,
      ],
    );
  },

  async remove(id) {
    const db = await openQueue();
    await db.runAsync('DELETE FROM queued_flights WHERE id = ?', [id]);
  },
};
