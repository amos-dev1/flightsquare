import { randomUUID } from 'node:crypto';

import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';

import { config } from '../config.js';
import { db } from '../db/pool.js';
import type { Database } from '../db/schema.js';
import type { Kysely } from 'kysely';
import { ApiError, ClientTooOldError, isRlsRefusal } from './errors.js';
import {
  assertRouteGatesDeclared,
  requestContext,
  type RequestContextOptions,
} from './plugins/request-context.js';
import { authRoutes } from './routes/auth.js';
import { aircraftRoutes } from './routes/aircraft.js';
import { entitlementsRoutes } from './routes/entitlements.js';
import { flightRoutes } from './routes/flights.js';
import { healthRoutes } from './routes/health.js';
import { referenceRoutes } from './routes/reference.js';
import { meRoutes } from './routes/me.js';
import { signupRoutes } from './routes/signup.js';
import { tenantRoutes } from './routes/tenant.js';

/** Compare dotted numeric versions. Missing segments count as zero. */
function isOlderThan(version: string, minimum: string): boolean {
  const a = version.split('.').map(Number);
  const b = minimum.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (Number.isNaN(left)) return false; // unparseable: let it through
    if (left !== right) return left < right;
  }
  return false;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** For reads that have no tenant — global reference data only. */
    db: Kysely<Database>;
  }
}

export interface RateLimitRule {
  max: number;
  timeWindow: string;
}

export interface ServerOptions {
  /**
   * Override how a request becomes a session. Tests inject a stub; nothing in
   * production should pass this.
   */
  resolveSession?: RequestContextOptions['resolveSession'];
  /** Override the configured limits, so a test can provoke a 429 deliberately. */
  rateLimits?: Partial<Record<'signup' | 'login' | 'refresh', RateLimitRule>>;
}

export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const limits = { ...config.rateLimits, ...options.rateLimits };
  const app = Fastify({
    logger: { level: config.logLevel },
    genReqId: () => randomUUID(),
  });

  // Global reference data has no tenant, so those routes read the pool
  // directly rather than through withTenant. Decorated here so the route
  // module does not import the pool and quietly grow other uses for it.
  app.decorate('db', db);

  // Synchronous, so it covers every route added from here on — including one
  // added directly on the instance, which a deferred plugin's hook would miss.
  app.addHook('onRoute', assertRouteGatesDeclared);

  /**
   * §8.1: a shipped iOS build cannot be force-updated, so the API needs a way
   * to tell a binary it is too old. Off until someone sets a floor.
   */
  app.addHook('onRequest', async (request) => {
    const client = request.headers['x-flightsquare-client'];
    const version = request.headers['x-flightsquare-client-version'];
    if (typeof client !== 'string' || typeof version !== 'string') return;

    const minimum = config.clients.minimumVersions[client];
    if (minimum && isOlderThan(version, minimum)) {
      throw new ClientTooOldError(client, minimum);
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      void reply.status(error.statusCode).send(error.toBody());
      return;
    }

    // Fastify's own schema validation.
    if ((error as { validation?: unknown }).validation) {
      const detail = error instanceof Error ? error.message : 'invalid request';
      void reply.status(400).send({ error: 'invalid_request', detail });
      return;
    }

    // Errors raised by Fastify or one of its plugins carry their own status —
    // the rate limiter's 429 above all. Without this they fall through to the
    // 500 below, and §1.6's "429 is rate limiting, never a quota" quietly
    // becomes "429 is an internal error".
    const status = (error as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      if (status === 429) {
        const retryAfter = Number(reply.getHeader('retry-after') ?? 60);
        void reply.status(429).send({ error: 'rate_limited', retry_after: retryAfter });
      } else {
        void reply.status(status).send({ error: 'invalid_request', detail: 'bad request' });
      }
      return;
    }

    if (isRlsRefusal(error)) {
      request.log.error(
        { err: error },
        'row-level security refused a write — the API attempted something outside its tenant',
      );
    } else {
      request.log.error({ err: error }, 'unhandled error');
    }

    // Never leak a database message to a client.
    void reply.status(500).send({ error: 'internal_error', request_id: request.id });
  });

  app.setNotFoundHandler((_request, reply) => {
    void reply.status(404).send({ error: 'not_found' });
  });

  /**
   * Rate limiting, off by default and opted into per route. §1.6 is explicit
   * that 429 is requests per unit time and is never a plan quota — the two
   * must not be conflated, so this deliberately shares nothing with the
   * entitlement path.
   *
   * Global is false because most routes are already bounded by requiring a
   * session; the ones that are not — login, signup — set their own limits.
   */
  void app.register(rateLimit, {
    global: false,
    // An attacker controls neither of these, so keying on the client address
    // is the best available signal until there is a session.
    keyGenerator: (request) => request.ip,
  });

  // Registered before the routes: it decorates the request and installs the
  // preHandler that resolves the session for routes that ask for one.
  void app.register(requestContext, { resolveSession: options.resolveSession });

  // Public.
  void app.register(healthRoutes);
  void app.register(signupRoutes, { prefix: '/auth', limit: limits.signup });
  void app.register(authRoutes, { prefix: '/auth', limits });

  // Session-scoped.
  void app.register(meRoutes);
  void app.register(tenantRoutes);
  void app.register(entitlementsRoutes);
  void app.register(aircraftRoutes);
  void app.register(flightRoutes);
  void app.register(referenceRoutes);

  return app;
}
