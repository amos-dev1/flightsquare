import { config } from './config.js';
import { assertEntitlementRegistryComplete } from './db/entitlements.js';
import { assertApplicationRole, closeDatabase } from './db/pool.js';
import { buildServer } from './http/server.js';
import { ensureBucket } from './storage/index.js';

const app = buildServer();

try {
  // Before accepting a single request: prove we are not a role that can see
  // across tenants (§1.2).
  await assertApplicationRole();
  // §1.4: an undeclared key is a startup error, not a runtime false. Boot
  // fails loudly rather than silently disabling a feature in production.
  await assertEntitlementRegistryComplete();
  // A dev stack that needs somebody to open a console and click "create
  // bucket" is a dev stack that does not start. Harmless against a real
  // bucket that already exists, and not fatal if storage is not up — an
  // attachment would fail, and nothing else in the product should.
  await ensureBucket().catch((error: unknown) => {
    app.log.warn({ err: error }, 'object storage is unreachable; attachments will fail');
  });
  await app.listen({ host: config.http.host, port: config.http.port });
} catch (error) {
  app.log.error({ err: error }, 'failed to start');
  await closeDatabase();
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void (async () => {
      await app.close();
      await closeDatabase();
    })();
  });
}
