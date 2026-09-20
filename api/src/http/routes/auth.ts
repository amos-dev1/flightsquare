import type { FastifyInstance } from 'fastify';
import type {
  LoginResponse,
  RefreshResponse,
  SelectTenantResponse,
} from '@flightsquare/shared';

import {
  consumeRefreshToken,
  findUserByEmail,
  listMembershipsForUser,
} from '../../db/auth.js';
import {
  createSession,
  revokeSession,
  rotateSession,
  selectSessionTenant,
} from '../../db/sessions.js';
import { hashPassword, verifyPassword } from '../../password.js';
import { hashToken } from '../../tokens.js';
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

const loginSchema = {
  body: {
    type: 'object',
    required: ['email', 'password'],
    additionalProperties: false,
    properties: {
      email: { type: 'string', minLength: 3, maxLength: 320 },
      password: { type: 'string', minLength: 1, maxLength: 1024 },
    },
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
  limits?: Partial<Record<'login' | 'refresh', { max: number; timeWindow: string }>>;
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
  app.post<{ Body: { email: string; password: string } }>(
    '/login',
    {
      schema: loginSchema,
      config: { rateLimit: limits.login ?? { max: 10, timeWindow: '5 minutes' } },
    },
    async (request, reply) => {
      const { email, password } = request.body;

      const user = await findUserByEmail(email);
      const hash = user?.password_hash ?? (await decoy());
      const ok = await verifyPassword(password, hash);

      if (!user || !ok || user.status !== 'active') {
        throw new UnauthorizedError();
      }

      const client = request.headers['x-flightsquare-client'];
      const session = await createSession(user.user_id, {
        client: typeof client === 'string' ? client : undefined,
      });

      // The tenant picker, so a client does not need a second round trip
      // before it can show anything (§3.1: many memberships is the norm).
      const memberships = await listMembershipsForUser(user.user_id);

      const body: LoginResponse = {
        access_token: session.accessToken,
        refresh_token: session.refreshToken,
        expires_at: session.accessExpiresAt.toISOString(),
        mfa_required: user.mfa_enabled,
        memberships,
      };
      return reply.status(200).send(body);
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
