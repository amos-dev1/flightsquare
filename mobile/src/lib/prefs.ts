import * as SQLite from 'expo-sqlite';

/**
 * Small per-device UI preferences.
 *
 * SQLite rather than the keychain: `lib/auth.ts` is explicit that the
 * keychain is for tokens, because a refresh token in plain storage is worth
 * more to an attacker than the access token it mints. Which aeroplane
 * somebody last looked at is not a secret and does not belong there.
 *
 * Keys are scoped by **(user, tenant)** and not by user alone. §3.1: one
 * human, one login, many memberships — a member of two clubs at the same
 * field has a different aeroplane in mind at each of them, and a single
 * remembered id would follow them across and then point at a row the other
 * tenant cannot see.
 *
 * Nothing here is a control. A remembered id is checked against what the
 * server returns before it is used, so a stale one is a fallback rather than
 * a way to see somebody else's aircraft — RLS decided that already (§1.1).
 */

let database: SQLite.SQLiteDatabase | null = null;

async function open(): Promise<SQLite.SQLiteDatabase> {
  // The same file the offline queue uses; `openDatabaseAsync` hands back the
  // one handle, so this is not a second connection.
  database ??= await SQLite.openDatabaseAsync('flightsquare.db');
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS prefs (
      scope TEXT NOT NULL,
      key   TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (scope, key)
    );
  `);
  return database;
}

function scopeOf(userId: string, tenantId: string): string {
  return `${userId}:${tenantId}`;
}

export async function readPref(
  userId: string,
  tenantId: string,
  key: string,
): Promise<string | null> {
  try {
    const db = await open();
    const row = await db.getFirstAsync<{ value: string }>(
      'SELECT value FROM prefs WHERE scope = ? AND key = ?',
      [scopeOf(userId, tenantId), key],
    );
    return row?.value ?? null;
  } catch {
    // A preference that cannot be read is a preference that was never set.
    // Nothing on a screen should fail because a convenience did.
    return null;
  }
}

export async function writePref(
  userId: string,
  tenantId: string,
  key: string,
  value: string,
): Promise<void> {
  try {
    const db = await open();
    await db.runAsync(
      'INSERT OR REPLACE INTO prefs (scope, key, value) VALUES (?, ?, ?)',
      [scopeOf(userId, tenantId), key, value],
    );
  } catch {
    // Same reasoning: the selection still works for this session.
  }
}

/** The aeroplane the dashboard was last showing, per (user, tenant). */
export const SELECTED_AIRCRAFT = 'dashboard.aircraft';
