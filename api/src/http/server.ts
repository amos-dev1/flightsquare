import { randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';

import { config } from '../config.js';
import { ApiError, ClientTooOldError, isRlsRefusal } from './errors.js';
import { requestContext, type RequestContextOptions } from './plugins/request-context.js';
import { healthRoutes } from './routes/health.js';
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

export interface ServerOptions {
  /**
   * Override how a request becomes a session. Tests inject a stub; nothing in
   * production should pass this.
   */
  resolveSession?: RequestContextOptions['resolveSession'];
}

export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: { level: config.logLevel },
    genReqId: () => randomUUID(),
  });

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

  // Registered before the routes: it decorates the request and installs the
  // preHandler that resolves the session for routes that ask for one.
  void app.register(requestContext, { resolveSession: options.resolveSession });

  // Public.
  void app.register(healthRoutes);
  void app.register(signupRoutes, { prefix: '/auth' });

  // Session-scoped.
  void app.register(meRoutes);
  void app.register(tenantRoutes);

  return app;
}
