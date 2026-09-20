import { withUser } from './context.js';
import {
  ACCESS_TOKEN_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  SESSION_TTL_MS,
  generateToken,
  hashToken,
} from '../tokens.js';

/**
 * Writing session state.
 *
 * None of this needs a definer function. By the time anything here runs the
 * user is known — the password has been checked, or a refresh token has been
 * resolved — so the API sets app.user_id and writes through the ordinary
 * user_isolation policy. Only the two lookups that genuinely precede any
 * knowledge of who is asking are on the §2.1 list.
 */

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
}

export interface CreatedSession extends IssuedTokens {
  sessionId: string;
}

export async function createSession(
  userId: string,
  options: { client?: string | undefined } = {},
): Promise<CreatedSession> {
  const now = Date.now();
  const accessToken = generateToken();
  const refreshToken = generateToken();
  const accessExpiresAt = new Date(now + ACCESS_TOKEN_TTL_MS);
  const refreshExpiresAt = new Date(now + REFRESH_TOKEN_TTL_MS);

  return withUser(userId, async (trx) => {
    const session = await trx
      .insertInto('sessions')
      .values({
        user_id: userId,
        access_token_hash: hashToken(accessToken),
        access_expires_at: accessExpiresAt,
        expires_at: new Date(now + SESSION_TTL_MS),
        client: options.client ?? null,
        last_used_at: new Date(now),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await trx
      .insertInto('refresh_tokens')
      .values({
        session_id: session.id,
        token_hash: hashToken(refreshToken),
        expires_at: refreshExpiresAt,
      })
      .execute();

    return {
      sessionId: session.id,
      accessToken,
      refreshToken,
      accessExpiresAt,
      refreshExpiresAt,
    };
  });
}

/**
 * Issue a fresh pair on an existing session.
 *
 * The old refresh token has already been marked used by
 * auth.consume_refresh_token; this is the other half of the rotation.
 */
export async function rotateSession(
  sessionId: string,
  userId: string,
): Promise<IssuedTokens> {
  const now = Date.now();
  const accessToken = generateToken();
  const refreshToken = generateToken();
  const accessExpiresAt = new Date(now + ACCESS_TOKEN_TTL_MS);
  const refreshExpiresAt = new Date(now + REFRESH_TOKEN_TTL_MS);

  return withUser(userId, async (trx) => {
    await trx
      .updateTable('sessions')
      .set({
        access_token_hash: hashToken(accessToken),
        access_expires_at: accessExpiresAt,
        last_used_at: new Date(now),
      })
      .where('id', '=', sessionId)
      .execute();

    await trx
      .insertInto('refresh_tokens')
      .values({
        session_id: sessionId,
        token_hash: hashToken(refreshToken),
        expires_at: refreshExpiresAt,
      })
      .execute();

    return { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt };
  });
}

export async function revokeSession(sessionId: string, userId: string): Promise<void> {
  await withUser(userId, async (trx) => {
    await trx
      .updateTable('sessions')
      .set({ revoked_at: new Date() })
      .where('id', '=', sessionId)
      .execute();
    await trx
      .updateTable('refresh_tokens')
      .set({ revoked_at: new Date() })
      .where('session_id', '=', sessionId)
      .where('revoked_at', 'is', null)
      .execute();
  });
}

/**
 * Pick which tenant this session is acting in.
 *
 * No new token is issued: the access token is opaque and the selection lives
 * on the session row, so switching tenant is one UPDATE. The caller checks
 * the membership first — this function trusts that it did.
 */
export async function selectSessionTenant(
  sessionId: string,
  userId: string,
  tenantId: string,
): Promise<void> {
  await withUser(userId, async (trx) => {
    await trx
      .updateTable('sessions')
      .set({ selected_tenant_id: tenantId })
      .where('id', '=', sessionId)
      .execute();
  });
}
