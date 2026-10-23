import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabase } from '../src/db/pool.js';
import { buildServer } from '../src/http/server.js';
import type { ResolvedSession } from '../src/http/session.js';
import { UnauthorizedError } from '../src/http/errors.js';
import { readMeters, type TextReader, type Word } from '../src/ocr/meters.js';
import { cleanupTestTenants, provisionTestTenant } from './helpers/fixtures.js';

/**
 * Reading Hobbs and tach off a photograph of the panel.
 *
 * The hard half is pure — which number is which — so most of this feeds it
 * words laid out the way Textract reports them and checks the answer. The
 * route tests only prove the door: who may use it, and that a reader which
 * fails or is missing is an answer rather than a 500.
 */

/** A word at (left, top), one standard height tall. */
function word(text: string, left: number, top: number, width = 0.08): Word {
  return { text, left, top, width, height: 0.04 };
}

const none = { hobbs: null, tach: null };

describe('which number is which', () => {
  it('follows the labels', () => {
    const words = [
      word('HOBBS', 0.1, 0.3),
      word('1234.5', 0.1, 0.36),
      word('TACH', 0.6, 0.3),
      word('1101.2', 0.6, 0.36),
    ];
    expect(readMeters(words, none)).toEqual({ hobbs: '1234.5', tach: '1101.2' });
  });

  it('reads "Airframe" as the Hobbs and "Flight" as the tach', () => {
    const words = [
      word('FLIGHT', 0.1, 0.3),
      word('0876.4', 0.1, 0.36),
      word('AIRFRAME', 0.6, 0.3),
      word('0903.1', 0.6, 0.36),
    ];
    expect(readMeters(words, none)).toEqual({ hobbs: '903.1', tach: '876.4' });
  });

  it('joins a drum counter that came back in pieces, last wheel as tenths', () => {
    const words = [
      word('HOBBS', 0.1, 0.3),
      word('01234', 0.1, 0.36, 0.1),
      word('5', 0.205, 0.36, 0.02),
    ];
    expect(readMeters(words, none).hobbs).toBe('1234.5');
  });

  it('lets history settle an undotted counter and two unlabelled ones', () => {
    // No labels, no decimal points: 12345 could be 1234.5 or 12345, and only
    // the aircraft's own last readings say which counter is which.
    const words = [word('11012', 0.1, 0.36), word('12345', 0.6, 0.36)];
    expect(readMeters(words, { hobbs: 1233.9, tach: 1100.0 })).toEqual({
      hobbs: '1234.5',
      tach: '1101.2',
    });
  });

  it('will not offer a meter running backwards', () => {
    const words = [word('HOBBS', 0.1, 0.3), word('1200.0', 0.1, 0.36)];
    expect(readMeters(words, { hobbs: 1234.5, tach: null }).hobbs).toBeNull();
  });

  it('leaves a box empty rather than guess', () => {
    // Two numbers, no labels and no history: nothing says which is which.
    const words = [word('1234.5', 0.1, 0.36), word('1101.2', 0.6, 0.36)];
    expect(readMeters(words, none)).toEqual(none);
  });

  it('ignores a registration', () => {
    const words = [word('N123AB', 0.1, 0.1), word('HOBBS', 0.1, 0.3)];
    expect(readMeters(words, none).hobbs).toBeNull();
  });
});

const SESSION_ID = '01920000-0000-7000-8000-0000000000fb';

afterAll(async () => {
  await cleanupTestTenants();
  await closeDatabase();
});

describe('POST /aircraft/:id/meter-scan', () => {
  let stub: ResolvedSession | null = null;
  let aircraftId: string;
  const apps: FastifyInstance[] = [];

  async function server(reader: TextReader | null) {
    const app = buildServer({
      meterReader: reader,
      resolveSession: async () => {
        if (!stub) throw new UnauthorizedError();
        return stub;
      },
    });
    await app.ready();
    apps.push(app);
    return app;
  }

  const panel: TextReader = {
    words: async () => [
      word('HOBBS', 0.1, 0.3),
      word('512.3', 0.1, 0.36),
      word('TACH', 0.6, 0.3),
      word('480.9', 0.6, 0.36),
    ],
  };

  const scan = (app: FastifyInstance, id = aircraftId) =>
    app.inject({
      method: 'POST',
      url: `/aircraft/${id}/meter-scan`,
      payload: { image: Buffer.from('not really a jpeg').toString('base64'), content_type: 'image/jpeg' },
    });

  beforeAll(async () => {
    await cleanupTestTenants();
    const tenant = await provisionTestTenant('meter-scan');
    stub = { sessionId: SESSION_ID, userId: tenant.user_id, tenantId: tenant.tenant_id };
    const app = await server(null);
    const created = await app.inject({
      method: 'POST',
      url: '/aircraft',
      payload: { registration: 'N512SC', type_code: 'C172', hobbs: '510.0', tach: '479.0' },
    });
    aircraftId = created.json().id;
  });

  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
  });

  it('reads the panel', async () => {
    const response = await scan(await server(panel));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'read', hobbs: '512.3', tach: '480.9' });
  });

  it('says so when nothing is configured to read it', async () => {
    expect((await scan(await server(null))).json()).toEqual({
      status: 'unavailable',
      hobbs: null,
      tach: null,
    });
  });

  it('turns a failing reader into an answer, not a 500', async () => {
    const broken: TextReader = {
      words: async () => {
        throw new Error('throttled');
      },
    };
    const response = await scan(await server(broken));
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('unavailable');
  });

  it('says when it found no meter', async () => {
    const blank: TextReader = { words: async () => [word('CESSNA', 0.1, 0.1)] };
    expect((await scan(await server(blank))).json().status).toBe('nothing_found');
  });

  it('is not found for an aircraft the caller cannot see', async () => {
    const response = await scan(await server(panel), '01920000-0000-7000-8000-00000000dead');
    expect(response.statusCode).toBe(404);
  });
});
