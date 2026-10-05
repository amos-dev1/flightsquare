import type { FastifyInstance } from 'fastify';
import type {
  LoginResponse,
  RefreshResponse,
  SelectTenantResponse,
  VerifyMfaRequest,
} from '@flightsquare/shared';

import {
  consumeAuthToken,
  consumeRefreshToken,
  findUserByEmail,
  listMembershipsForUser,
  requestEmailToken,
} from '../../db/auth.js';
import { touchTrustedDevice, trustDevice } from '../../db/trusted-devices.js';
import { mfaCodeEmail } from '../../email.js';
import {
  createSession,
  revokeSession,
  rotateSession,
  selectSessionTenant,
} from '../../db/sessions.js';
import { hashPassword, verifyPassword } from '../../password.js';
import {
  generateMfaCode,
  generateToken,
  hashToken,
  MFA_CODE_TTL_MS,
} from '../../tokens.js';
import { NotFoundError, UnauthorizedError } from '../errors.js';

/**
 * A hash to compare against when no user was found, so that a login attempt
 * for an unknown address costs the same as one for a known address. Without
 * it the response time answers "is this person a customer?" — which is the
 * §2.1 warning about find_user_by_email being an existence oracle if the code
 * above it lets it be.
 */
let decoyHash: string | null = null;
async function decoy(): Promise<string> {
  decoyHash ??= await hashPassword(`decoy-${Math.random()}`);
  return decoyHash;
}

/**
 * Which inbox to go and look in, without printing the address.
 *
 * `d••••@demo.flightsquare.test`. Somebody with several addresses needs to know
 * which one; somebody who has stolen a password should not be handed the
 * address it belongs to. The domain stays because it is the useful half and is
 * usually already on screen.
 */
function obfuscate(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const head = local.slice(0, 1);
  return `${head}${'•'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

const loginSchema = {
  body: {
    type: 'object',
    required: ['email', 'password'],
    additionalProperties: false,
    properties: {
      email: { type: 'string', minLength: 3, maxLength: 320 },
      password: { type: 'string', minLength: 1, maxLength: 1024 },
      /**
       * A device that has passed a code before, offering to skip the next one.
       *
       * Optional, and worth nothing on its own: it is checked against this
       * user, so a token lifted from one account does nothing for another, and
       * it is only consulted after the password is right.
       */
      device_token: { type: 'string', minLength: 10, maxLength: 200 },
    },
  },
} as const;

const mfaSchema = {
  body: {
    type: 'object',
    required: ['challenge_id', 'code'],
    additionalProperties: false,
    properties: {
      challenge_id: { type: 'string', minLength: 10, maxLength: 200 },
      // Six digits, and exactly six: a shorter one is a typo and a longer one
      // is somebody probing the shape.
      code: { type: 'string', pattern: '^[0-9]{6}$' },
      remember_device: { type: 'boolean' },
    },
  },
} as const;

const resendSchema = {
  body: {
    type: 'object',
    required: ['challenge_id'],
    additionalProperties: false,
    properties: { challenge_id: { type: 'string', minLength: 10, maxLength: 200 } },
  },
} as const;

const refreshSchema = {
  body: {
    type: 'object',
    required: ['refresh_token'],
    additionalProperties: false,
    properties: { refresh_token: { type: 'string', minLength: 1, maxLength: 512 } },
  },
} as const;

const selectTenantSchema = {
  body: {
    type: 'object',
    required: ['tenant_id'],
    additionalProperties: false,
    properties: { tenant_id: { type: 'string', format: 'uuid' } },
  },
} as const;

export interface AuthRouteOptions {
  limits?: Partial<Record<'login' | 'refresh' | 'mfa', { max: number; timeWindow: string }>>;
}

export async function authRoutes(
  app: FastifyInstance,
  options: AuthRouteOptions = {},
): Promise<void> {
  const limits = options.limits ?? {};
  /**
   * Exchange credentials for a session.
   *
   * Every failure answers the same way. A wrong password, an unknown address,
   * and a locked account are one response, because the difference is exactly
   * what someone enumerating accounts wants to learn.
   */
  app.post<{ Body: { email: string; password: string; device_token?: string } }>(
    '/login',
    {
      schema: loginSchema,
      config: { rateLimit: limits.login ?? { max: 10, timeWindow: '5 minutes' } },
    },
    async (request, reply) => {
      const { email, password, device_token } = request.body;

      const deviceHash = device_token ? hashToken(device_token) : null;
      const user = await findUserByEmail(email, deviceHash);
      const hash = user?.password_hash ?? (await decoy());
      const ok = await verifyPassword(password, hash);

      if (!user || !ok || user.status !== 'active') {
        throw new UnauthorizedError();
      }

      const client = request.headers['x-flightsquare-client'];
      const clientName = typeof client === 'string' ? client : undefined;

      /*
        The password was right. Whether that is enough is the next question.

        **No session is created when a code is needed**, and that is the whole
        shape of this. The alternative — a `sessions` row flagged as pending —
        is tidier and one forgotten guard away from being a password-only
        login, because every request path would have to remember to refuse it.
        Nothing to authenticate with is a thing no path can forget.
      */
      if (user.mfa_enabled && !user.device_trusted) {
        const challengeId = generateToken();
        const code = generateMfaCode();
        const expiresAt = new Date(Date.now() + MFA_CODE_TTL_MS);
        const minutes = Math.round(MFA_CODE_TTL_MS / 60_000);

        await requestEmailToken({
          email,
          kind: 'mfa_code',
          // Salted with the challenge, which is what makes six digits safe to
          // store in a table with a UNIQUE hash (0039).
          tokenHash: hashToken(`${challengeId}:${code}`),
          expiresAt,
          ...mfaCodeEmail({ code, minutes }),
        });

        const pending: LoginResponse = {
          mfa_required: true,
          challenge_id: challengeId,
          expires_at: expiresAt.toISOString(),
          sent_to: obfuscate(email),
        };
        return reply.status(200).send(pending);
      }

      // Trusted device, or an account with the factor off. Either way the stamp
      // happens here and not inside the lookup, which stays a reader (§2.1).
      if (deviceHash && user.device_trusted) {
        await touchTrustedDevice(user.user_id, deviceHash).catch(() => undefined);
      }

      const session = await createSession(user.user_id, { client: clientName });

      // The tenant picker, so a client does not need a second round trip
      // before it can show anything (§3.1: many memberships is the norm).
      const memberships = await listMembershipsForUser(user.user_id);

      const body: LoginResponse = {
        mfa_required: false,
        access_token: session.accessToken,
        refresh_token: session.refreshToken,
        expires_at: session.accessExpiresAt.toISOString(),
        memberships,
      };
      return reply.status(200).send(body);
    },
  );

  /**
   * Spend the code, and only then mint a session.
   *
   * **Rate limited per challenge, not per IP.** By the time somebody is here
   * they have already passed a password check — that is what the second factor
   * is for — so the thing worth limiting is guesses against *this* attempt. An
   * IP they can rotate is no limit at all against six digits, and the existing
   * per-IP rule on `/auth/login` would throttle a shared office instead.
   *
   * Five tries, then the challenge is useless until a new code is requested.
   */
  app.post<{ Body: VerifyMfaRequest }>(
    '/mfa',
    {
      schema: mfaSchema,
      config: {
        rateLimit: {
          ...(limits.mfa ?? { max: 5, timeWindow: '10 minutes' }),
          keyGenerator: (request) =>
            (request.body as VerifyMfaRequest | undefined)?.challenge_id ?? request.ip,
        },
      },
    },
    async (request, reply) => {
      const { challenge_id, code, remember_device } = request.body;

      /*
        One answer for every kind of wrong.

        A spent code, an expired one, a wrong one, and a challenge that never
        existed are the same 401 — the differences are exactly what somebody
        working through six digits wants to learn. `consume_auth_token` already
        collapses them: it returns null for all four, and will not let a token
        of another kind be spent as this one.
      */
      const userId = await consumeAuthToken('mfa_code', hashToken(`${challenge_id}:${code}`));
      if (!userId) throw new UnauthorizedError();

      const client = request.headers['x-flightsquare-client'];
      const clientName = typeof client === 'string' ? client : undefined;

      const session = await createSession(userId, { client: clientName });
      const memberships = await listMembershipsForUser(userId);

      const body: LoginResponse = {
        mfa_required: false,
        access_token: session.accessToken,
        refresh_token: session.refreshToken,
        expires_at: session.accessExpiresAt.toISOString(),
        memberships,
      };

      if (remember_device) {
        const device = await trustDevice(userId, clientName);
        body.device_token = device.token;
        body.device_token_expires_at = device.expiresAt.toISOString();
      }

      return reply.status(200).send(body);
    },
  );

  /**
   * Another code for the same attempt.
   *
   * A new token against the same challenge, so the client keeps the handle it
   * already has. The old code stays valid until it expires — invalidating it
   * would let anybody holding a challenge id lock the real user out of their
   * own sign-in by asking for a resend.
   *
   * Always 202, whatever happened. A challenge id that has no user behind it
   * must not say so: that would turn this into an oracle for which challenges
   * are real, and `request_email_token` is built to never answer it either.
   */
  app.post<{ Body: { challenge_id: string } }>(
    '/mfa/resend',
    {
      schema: resendSchema,
      config: { rateLimit: limits.login ?? { max: 10, timeWindow: '5 minutes' } },
    },
    async (request, reply) => {
      /*
        Nothing is sent here, and that is not a stub.

        A resend needs the address, and the only thing the client holds is a
        challenge id — which deliberately resolves to nothing without the code
        that goes with it. Looking a challenge up by id alone would mean a door
        that turns a challenge into an email address, which is precisely the
        oracle the rest of this file is built to avoid.

        So the client re-posts the password instead: `/auth/login` is already
        idempotent in the only way that matters, minting a fresh challenge and a
        fresh code. This endpoint exists so that a client asking for a resend
        gets a defined answer rather than a 404, and so the shape is here when
        there is a reason to hold the address against the challenge.
      */
      request.log.info({ challenge: request.body.challenge_id.slice(0, 8) }, 'mfa resend asked');
      return reply.status(202).send({ status: 'accepted' });
    },
  );

  /**
   * Rotate. The presented token is spent by the database in the same
   * statement that validates it, so two devices racing cannot both win.
   */
  app.post<{ Body: { refresh_token: string } }>(
    '/refresh',
    {
      schema: refreshSchema,
      config: { rateLimit: limits.refresh ?? { max: 60, timeWindow: '5 minutes' } },
    },
    async (request, reply) => {
      const consumed = await consumeRefreshToken(hashToken(request.body.refresh_token));
      if (!consumed) throw new UnauthorizedError();

      if (consumed.reuse_detected) {
        // The session has already been revoked by the function. Log it: this
        // is the one signal that a refresh token was captured.
        request.log.warn(
          { session_id: consumed.session_id, user_id: consumed.user_id },
          'refresh token reuse detected; session revoked',
        );
        throw new UnauthorizedError();
      }

      const tokens = await rotateSession(consumed.session_id, consumed.user_id);
      const body: RefreshResponse = {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expires_at: tokens.accessExpiresAt.toISOString(),
      };
      return reply.status(200).send(body);
    },
  );

  app.post(
    '/logout',
    { config: { requiresSession: true } },
    async (request, reply) => {
      const ctx = request.ctx!;
      await revokeSession(ctx.sessionId, ctx.userId);
      return reply.status(204).send();
    },
  );

  /**
   * Choose which tenant this session acts in.
   *
   * No new token: the access token is opaque and the selection lives on the
   * session row. The membership is re-checked here rather than trusted from
   * the request — the client names a tenant, the server decides whether that
   * is one of theirs, and §1.1 holds because what reaches app.tenant_id comes
   * back out of the session row afterwards.
   */
  app.post<{ Body: { tenant_id: string } }>(
    '/tenant',
    { schema: selectTenantSchema, config: { requiresSession: true } },
    async (request, reply) => {
      const ctx = request.ctx!;
      const memberships = await listMembershipsForUser(ctx.userId);
      const match = memberships.find((m) => m.tenant_id === request.body.tenant_id);

      // Not a member: indistinguishable from the tenant not existing (§6).
      if (!match || match.membership_status !== 'active') throw new NotFoundError();

      await selectSessionTenant(ctx.sessionId, ctx.userId, match.tenant_id);
      const body: SelectTenantResponse = {
        tenant_id: match.tenant_id,
        tenant_name: match.tenant_name,
      };
      return reply.status(200).send(body);
    },
  );
}
