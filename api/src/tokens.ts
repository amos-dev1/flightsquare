import { createHash, randomBytes } from 'node:crypto';

/**
 * Session tokens: 256 bits of randomness, stored only as a hash.
 *
 * SHA-256 rather than the scrypt used for passwords, and deliberately so. A
 * password is low-entropy and chosen by a human, which is why it needs a slow
 * memory-hard KDF — an attacker with the hash can guess. A token is 256
 * random bits: there is nothing to guess, so the only job of the hash is to
 * make a database dump useless, and a fast hash does that perfectly.
 *
 * The stored form is prefixed so the algorithm is visible in the row and can
 * be changed later without guessing what old rows contain.
 */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return `sha256:${createHash('sha256').update(token).digest('base64url')}`;
}

/** Short, because a stolen access token is only useful until it expires. */
export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;

/** Long, because §8.4 wants a phone to stay signed in; rotated on every use. */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Absolute ceiling. Refreshing extends the access token, never this. */
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
