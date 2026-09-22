import { config } from '../config.js';
import { closeDatabase } from '../db/pool.js';
import { sweepTenant } from './maintenance.js';
import { assertSchedulerRole, schedulerDatabase, tenantsToSweep } from './tenants.js';

/**
 * The sweep: `npm run sweep -w api`, or `npm run sweep -w api -- --once`.
 *
 * One job today — the maintenance digest — and the shape is built for the
 * others that will want it: retention expiry, and §5.4's auto-archive timer
 * if it is ever turned on. All of them are "for each tenant, look at
 * something the clock has changed", and all of them need the same list from
 * the same narrow role.
 */

const once = process.argv.includes('--once');
const scheduler = schedulerDatabase();

try {
  await assertSchedulerRole(scheduler);
} catch (error) {
  console.error('[sweep] refusing to start:', (error as Error).message);
  await scheduler.destroy();
  process.exit(1);
}

async function pass(): Promise<void> {
  const tenants = await tenantsToSweep(scheduler);
  let queued = 0;

  for (const tenantId of tenants) {
    try {
      const result = await sweepTenant(tenantId);
      queued += result.notified;
      if (result.items > 0) {
        console.log(
          `[sweep] ${tenantId}: ${result.items} item(s) changed, ${result.notified} told`,
        );
      }
    } catch (error) {
      // One tenant's bad data must not stop the other four hundred. This is
      // the loop §1.1 describes, and a failure in it is per-tenant by
      // construction because the context is.
      console.error(`[sweep] ${tenantId} failed:`, (error as Error).message);
    }
  }

  console.log(`[sweep] ${tenants.length} tenant(s), ${queued} notice(s) queued`);
}

async function shutdown(code = 0): Promise<never> {
  await scheduler.destroy();
  await closeDatabase();
  process.exit(code);
}

if (once) {
  await pass();
  await shutdown();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void shutdown());
}

console.log(`[sweep] every ${config.scheduler.everyHours}h`);
// eslint-disable-next-line no-constant-condition
while (true) {
  await pass();
  await new Promise((resolve) =>
    setTimeout(resolve, config.scheduler.everyHours * 60 * 60 * 1000),
  );
}
