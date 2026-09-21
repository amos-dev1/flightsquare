import * as SQLite from 'expo-sqlite';
import type {
  CreateFlightRequest,
  CreateSquawkRequest,
  QueueStore,
  QueuedWrite,
} from '@flightsquare/shared';

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
    CREATE TABLE IF NOT EXISTS queued_writes (
      id              TEXT PRIMARY KEY NOT NULL,
      kind            TEXT NOT NULL DEFAULT 'flight',
      idempotency_key TEXT NOT NULL,
      payload         TEXT NOT NULL,
      recorded_at     TEXT NOT NULL,
      queued_at       TEXT NOT NULL,
      attempts        INTEGER NOT NULL DEFAULT 0,
      state           TEXT NOT NULL DEFAULT 'pending',
      last_error      TEXT
    );
  `);

  // A build that only knew about flights may have left entries behind, and an
  // unsent flight is a flight that never happened as far as the meters are
  // concerned. Carry them over rather than stranding them.
  //
  // Checked in JavaScript rather than guarded inside the SQL: SQLite resolves
  // table names when it prepares a statement, so a SELECT from a table that
  // does not exist fails on a fresh install no matter what the WHERE says.
  const legacy = await database.getFirstAsync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'queued_flights'`,
  );
  if (legacy) {
    await database.execAsync(`
      INSERT OR IGNORE INTO queued_writes
        (id, kind, idempotency_key, payload, recorded_at, queued_at, attempts, state, last_error)
      SELECT id, 'flight', idempotency_key, payload, recorded_at, queued_at,
             attempts, state, last_error
        FROM queued_flights;
      DROP TABLE queued_flights;
    `);
  }

  return database;
}

interface Row {
  id: string;
  kind: string;
  idempotency_key: string;
  payload: string;
  recorded_at: string;
  queued_at: string;
  attempts: number;
  state: string;
  last_error: string | null;
}

function toEntry(row: Row): QueuedWrite {
  const shared = {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    recordedAt: row.recorded_at,
    queuedAt: row.queued_at,
    attempts: row.attempts,
    state: row.state === 'failed' ? ('failed' as const) : ('pending' as const),
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
  const payload: unknown = JSON.parse(row.payload);

  // Anything this build does not recognise is read back as a flight, which
  // is what every row written before this column existed actually is.
  return row.kind === 'squawk'
    ? { ...shared, kind: 'squawk', payload: payload as CreateSquawkRequest }
    : { ...shared, kind: 'flight', payload: payload as CreateFlightRequest };
}

export const sqliteQueueStore: QueueStore = {
  async all() {
    const db = await openQueue();
    const rows = await db.getAllAsync<Row>('SELECT * FROM queued_writes');
    return rows.map(toEntry);
  },

  async put(entry) {
    const db = await openQueue();
    await db.runAsync(
      `INSERT INTO queued_writes
         (id, kind, idempotency_key, payload, recorded_at, queued_at, attempts, state, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         attempts = excluded.attempts,
         state = excluded.state,
         last_error = excluded.last_error`,
      [
        entry.id,
        entry.kind,
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
    await db.runAsync('DELETE FROM queued_writes WHERE id = ?', [id]);
  },
};
