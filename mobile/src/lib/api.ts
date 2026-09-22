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

/**
 * A failure, in a sentence, for a screen at a tiedown.
 *
 * The quota case is the one with a rule attached. §8.3 keeps this app inside
 * Apple's 3.1.3(f) — a free companion to a paid web tool needs no in-app
 * purchase *provided there is no purchasing inside the app and no call to
 * action for purchase outside it* — so this says what the limit is and stops.
 * No price, no link, not the word upgrade, and no "ask your administrator to
 * visit…", which would be the same thing wearing a hat.
 *
 * The web app says more (`web/src/lib/api.ts`), because the web app is where
 * a plan can actually be changed.
 */
export function messageFor(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'That did not send. It is saved here and will go when there is a signal.';
  }

  const body = error.body as {
    error?: string;
    quota?: string;
    limit?: number;
    detail?: string;
  } | null;

  switch (body?.error) {
    case 'quota_exceeded': {
      // The number is always the server's, never one compiled into a build
      // that cannot be corrected without a release (§8.1).
      const noun = QUOTA_NOUNS[body.quota ?? ''] ?? 'of these';
      return typeof body.limit === 'number'
        ? `This club's plan allows ${body.limit} ${noun}.`
        : `This club's plan limits ${noun}.`;
    }

    case 'forbidden':
      return 'You do not have permission to do that.';

    case 'not_found':
      return 'That is not here.';

    case 'client_too_old':
      return 'This version of the app is too old to talk to FlightSquare. Update it to carry on.';

    case 'invalid_request':
      return body.detail ?? 'Something in that entry was not accepted.';

    default:
      return error.status >= 500
        ? 'FlightSquare had a problem. Your entry is saved here and will go again.'
        : 'That did not work.';
  }
}

/** Labels, not plan data. */
const QUOTA_NOUNS: Record<string, string> = {
  'aircraft.active': 'aircraft',
  'members.active': 'members',
  'storage.bytes': 'bytes of storage',
};
