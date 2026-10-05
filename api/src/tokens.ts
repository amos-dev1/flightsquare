import { createHash, randomBytes, randomInt } from 'node:crypto';

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

/**
 * A six-digit login code, drawn without modulo bias.
 *
 * Short because a human reads it off an email and types it into a phone,
 * which is the whole reason it is not a 256-bit token like everything else
 * here — and the reason it needs the protections a long token does not.
 *
 * Three of them, together:
 *
 * 1. It is stored hashed with a **challenge id** — 32 random bytes minted at
 *    the password check and handed to that one caller — so the stored hash is
 *    unique per attempt and a code is worthless without the challenge it
 *    belongs to. Two users drawing 123456 is otherwise a collision on
 *    `auth_tokens.token_hash`, and either spending the other's token.
 * 2. It is single-use and short-lived, which `auth.consume_auth_token` has
 *    enforced for every email token since 0009.
 * 3. Attempts are capped per challenge at the boundary, not per IP. An
 *    attacker at this point already has the password — that is what MFA is
 *    for — so the thing to limit is guesses against *this* challenge, and an
 *    IP they can change is no limit at all.
 *
 * `randomInt` is rejection-sampled by Node, so every code is equally likely.
 * `% 1000000` over random bytes would not be, and the bias would be in the
 * leading digit.
 */
export function generateMfaCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Long enough to walk inside and find the email, short enough that a code
 * read over somebody's shoulder is stale by the time it is useful.
 */
export const MFA_CODE_TTL_MS = 10 * 60 * 1000;

/**
 * How long a device stays trusted.
 *
 * The number that makes mandatory MFA usable rather than resented (§3.4): a
 * pilot at a tiedown with one bar must not need an email to log the flight they
 * just made. Thirty days is the same order as the refresh token, so a device in
 * regular use renews quietly and one left in a drawer stops counting.
 */
export const TRUSTED_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
