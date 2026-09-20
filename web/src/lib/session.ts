import 'server-only';

import { cookies } from 'next/headers';

/**
 * The browser never sees an API token.
 *
 * §8.1 treats every client as untrusted, and a refresh token living in
 * localStorage is one XSS away from being someone else's. Instead this app is
 * a backend-for-frontend: the tokens live in an httpOnly cookie that only the
 * Next server can read, and every API call is made server-side. The browser
 * holds a cookie it cannot inspect and cannot forward anywhere else.
 */
export const SESSION_COOKIE = 'fs_session';

export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  /** ISO timestamp. Used by the middleware to refresh before a render fails. */
  expiresAt: string;
  tenantId?: string;
}

export async function readSession(): Promise<StoredSession | null> {
  const raw = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredSession;
  } catch {
    // A malformed cookie is no session, not a crash.
    return null;
  }
}

/** Only callable from a Server Action or Route Handler; Next forbids the rest. */
export async function writeSession(session: StoredSession): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, JSON.stringify(session), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    // Matches the API's absolute session ceiling. The access token inside
    // rotates long before this.
    maxAge: 90 * 24 * 60 * 60,
  });
}

export async function clearSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}
