import { config } from './config.js';
import { assertEntitlementRegistryComplete } from './db/entitlements.js';
import { assertApplicationRole, closeDatabase } from './db/pool.js';
import { buildServer } from './http/server.js';

const app = buildServer();

try {
  // Before accepting a single request: prove we are not a role that can see
  // across tenants (§1.2).
  await assertApplicationRole();
  // §1.4: an undeclared key is a startup error, not a runtime false. Boot
  // fails loudly rather than silently disabling a feature in production.
  await assertEntitlementRegistryComplete();
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
