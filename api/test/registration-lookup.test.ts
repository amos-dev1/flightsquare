import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabase } from '../src/db/pool.js';
import { buildServer } from '../src/http/server.js';
import type { ResolvedSession } from '../src/http/session.js';
import { UnauthorizedError } from '../src/http/errors.js';
import {
  cleanupTestTenants,
  provisionTestTenant,
  removeFaaRegistry,
  seedFaaRegistry,
} from './helpers/fixtures.js';

/**
 * A US tail number looked up in the FAA registry (0045): what the add form
 * offers, the ICAO designator the rules map it to, and nothing for what the
 * registry does not hold.
 */

const SESSION_ID = '01920000-0000-7000-8000-0000000000fd';
const REGISTRATIONS = ['N0VT1', 'N0VT2', 'N0VT3'];
const CODES = ['VITEST1', 'VITEST2', 'VITEST3'];

describe('GET /reference/registrations/:registration', () => {
  let app: FastifyInstance;
  let stub: ResolvedSession | null = null;

  beforeAll(async () => {
    await cleanupTestTenants();
    await seedFaaRegistry(
      [
        { code: 'VITEST1', manufacturer: 'CESSNA', model: '172S', seats: 4 },
        { code: 'VITEST2', manufacturer: 'CESSNA', model: '172RG', seats: 4 },
        { code: 'VITEST3', manufacturer: 'SMITH JOHN', model: 'RV-7A', seats: 2 },
      ],
      [
        { registration: 'N0VT1', model_code: 'VITEST1', serial_number: '172S8001', year_manufactured: 1998 },
        { registration: 'N0VT2', model_code: 'VITEST2', year_manufactured: 1980 },
        { registration: 'N0VT3', model_code: 'VITEST3', kit_manufacturer: 'VANS', kit_model: 'RV-7' },
      ],
    );
    const tenant = await provisionTestTenant('registration-lookup');
    app = buildServer({
      resolveSession: async () => {
        if (!stub) throw new UnauthorizedError();
        return stub;
      },
    });
    await app.ready();
    stub = { sessionId: SESSION_ID, userId: tenant.user_id, tenantId: tenant.tenant_id };
  });

  afterAll(async () => {
    await app.close();
    await removeFaaRegistry(REGISTRATIONS, CODES);
    await cleanupTestTenants();
    await closeDatabase();
  });

  const lookup = (registration: string) =>
    app.inject({ method: 'GET', url: `/reference/registrations/${registration}` });

  it('returns what the registry says, with the ICAO designator it maps to', async () => {
    const response = await lookup('n0vt1');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      registration: 'N0VT1',
      serial_number: '172S8001',
      year_manufactured: 1998,
      manufacturer: 'CESSNA',
      model: '172S',
      seats: 4,
      type_code: 'C172',
      source: 'faa',
    });
  });

  it('leaves the type empty rather than map a variant with a designator of its own', async () => {
    expect((await lookup('N0VT2')).json().type_code).toBeNull();
  });

  it('reads an amateur-built aeroplane by its kit', async () => {
    expect((await lookup('N0VT3')).json()).toMatchObject({
      manufacturer: 'VANS',
      model: 'RV-7',
      type_code: 'RV7',
    });
  });

  it('is not found for an unregistered or non-US tail number', async () => {
    expect((await lookup('N0VT9')).statusCode).toBe(404);
    expect((await lookup('G-ABCD')).statusCode).toBe(404);
  });
});
