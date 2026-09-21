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
