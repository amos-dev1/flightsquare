import Constants from 'expo-constants';
import { ApiError, createClient } from '@flightsquare/shared';

import { clearSession, readSession, writeSession } from './auth';

const BASE_URL =
  (Constants.expoConfig?.extra?.apiUrl as string | undefined) ??
  process.env.EXPO_PUBLIC_API_URL ??
  'http://127.0.0.1:3000';

/**
 * The shared client (§9), wired to this device's keychain and its own
 * refresh loop.
 *
 * §8.1's version handshake is populated here because it is the client that
 * cannot be force-updated: a shipped binary keeps talking to the API long
 * after it is stale, and the header is how the API can say so.
 */
export const api = createClient({
  baseUrl: BASE_URL,
  client: 'ios',
  clientVersion: (Constants.expoConfig?.version as string | undefined) ?? '0.1.0',
  getToken: async () => (await readSession())?.accessToken ?? null,
});

let refreshing: Promise<boolean> | null = null;

/**
 * Rotate the access token, once, even if several screens notice at the same
 * moment. A second concurrent refresh would present a token the first one
 * already exchanged, and the API treats a replayed refresh token as theft —
 * it would burn the session rather than renew it.
 */
async function refreshOnce(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const session = await readSession();
      if (!session) return false;
      const next = await api.refresh(session.refreshToken);
      await writeSession({
        accessToken: next.access_token,
        refreshToken: next.refresh_token,
        expiresAt: next.expires_at,
        tenantId: session.tenantId,
      });
      return true;
    } catch {
      await clearSession();
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** Run a call, refreshing once if the token turns out to be stale. */
export async function withAuth<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401 && (await refreshOnce())) {
      return call();
    }
    throw error;
  }
}
