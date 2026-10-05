import * as SecureStore from 'expo-secure-store';

/**
 * Tokens live in the device keychain, not in AsyncStorage.
 *
 * §8.1 treats every client as untrusted, and a refresh token that survives
 * for thirty days in plain storage is worth more to an attacker than the
 * access token it mints.
 */
const KEY = 'flightsquare.session';

export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  tenantId?: string;
}

export async function readSession(): Promise<StoredSession | null> {
  const raw = await SecureStore.getItemAsync(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
}

export async function writeSession(session: StoredSession): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(session));
}

export async function clearSession(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}

/**
 * The device token, kept apart from the session on purpose.
 *
 * It outlives every sign-out: that is the whole point of a remembered device,
 * and `clearSession` deliberately leaves it alone. Signing out says "not me
 * right now", not "this phone is no longer mine" — and the alternative would
 * mean a code on every sign-in for anybody who ever signs out, which is the
 * friction §3.4 cannot afford at a tiedown.
 *
 * Its own keychain entry rather than a field on the session, so that neither
 * operation can clear the other by accident.
 */
const DEVICE_KEY = 'flightsquare.device';

export async function readDeviceToken(): Promise<string | null> {
  return SecureStore.getItemAsync(DEVICE_KEY);
}

export async function writeDeviceToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(DEVICE_KEY, token);
}

/**
 * Forget this device, which is a different act from signing out.
 *
 * For "this was not me" — the server revokes its row, and the next sign-in
 * here needs a code again.
 */
export async function clearDeviceToken(): Promise<void> {
  await SecureStore.deleteItemAsync(DEVICE_KEY);
}
