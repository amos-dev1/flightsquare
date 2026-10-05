import { withUser } from './context.js';
import { generateToken, hashToken, TRUSTED_DEVICE_TTL_MS } from '../tokens.js';

/**
 * Devices that have already passed a code (0039).
 *
 * Written and read under ordinary user context, through the `user_isolation`
 * policy — no definer function, because by the time a device is trusted the
 * session exists and `app.current_user_id()` is set. The one read that *cannot*
 * work that way is the one at the password check, and that goes through
 * `auth.find_user_by_email` instead.
 *
 * The device holds the token; the database holds its hash. What the device has
 * is a bearer credential that skips a factor, so a leaked table must not be one.
 */

/**
 * Trust this device for thirty days, and hand back the token it must present.
 *
 * Returned once and never again, like a refresh token: there is no endpoint that
 * will tell a client what its device token is, because anything that could
 * answer that is a way to ask on somebody else's behalf.
 */
export async function trustDevice(
  userId: string,
  client: string | undefined,
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + TRUSTED_DEVICE_TTL_MS);

  await withUser(userId, async (trx) => {
    await trx
      .insertInto('trusted_devices')
      .values({
        user_id: userId,
        token_hash: hashToken(token),
        client: client ?? null,
        expires_at: expiresAt,
      })
      .execute();
  });

  return { token, expiresAt };
}

/**
 * Stamp a device that was just used to skip a code.
 *
 * Deliberately not done inside `auth.find_user_by_email`: that would make the
 * credential check a writer and move it onto `db/tests/030`'s list of auth
 * functions that write, for a column nothing enforces. It happens here, after
 * the session exists, and a failure is not worth failing a sign-in over.
 */
export async function touchTrustedDevice(userId: string, tokenHash: string): Promise<void> {
  await withUser(userId, async (trx) => {
    await trx
      .updateTable('trusted_devices')
      .set({ last_used_at: new Date() })
      .where('token_hash', '=', tokenHash)
      .execute();
  });
}
