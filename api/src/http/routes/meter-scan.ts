import type { FastifyInstance } from 'fastify';
import type { MeterScanRequest, MeterScanResponse } from '@flightsquare/shared';

import { readMeters, type TextReader } from '../../ocr/meters.js';
import { NotFoundError } from '../errors.js';

/**
 * Reading Hobbs and tach off a photograph of the panel, for the log-flight
 * form to offer back to the pilot.
 *
 * The photograph comes in the body rather than through a signed upload, which
 * `storage/index.ts` otherwise insists on. That rule is about files that are
 * kept: this one is read and dropped, never stored and never an attachment —
 * a meter photo the aircraft asks for is still filed the usual way once the
 * flight exists. The clients shrink it first, so it fits Fastify's default
 * 1 MiB body limit and that limit is not raised for anybody.
 *
 * Gated on `flights: write`, the permission of the form it serves. It reads
 * the aircraft's own meters to judge what is plausible, so the aircraft has to
 * be one the caller can see: §6's 404 otherwise.
 */

const schema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    required: ['image', 'content_type'],
    additionalProperties: false,
    properties: {
      // Base64, under the body limit with room for the JSON around it.
      image: { type: 'string', minLength: 1, maxLength: 1_000_000 },
      content_type: { type: 'string', enum: ['image/jpeg', 'image/png'] },
    },
  },
} as const;

export async function meterScanRoutes(
  app: FastifyInstance,
  options: { reader: TextReader | null },
): Promise<void> {
  app.post<{ Params: { id: string }; Body: MeterScanRequest }>(
    '/aircraft/:id/meter-scan',
    {
      schema,
      config: {
        requiresTenant: true,
        permission: ['flights', 'write'],
        // A Textract call costs money per page; a loop should meet a 429 long
        // before it meets the bill. Generous for a pilot retaking a photo.
        rateLimit: { max: 30, timeWindow: '5 minutes' },
      },
    },
    async (request): Promise<MeterScanResponse> => {
      const aircraft = await request.withTenant((trx) =>
        trx
          .selectFrom('aircraft')
          .select(['hobbs', 'tach'])
          .where('id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (!aircraft) throw new NotFoundError();

      if (!options.reader) return { status: 'unavailable', hobbs: null, tach: null };

      let words;
      try {
        words = await options.reader.words(Buffer.from(request.body.image, 'base64'));
      } catch (error) {
        // An unreadable image and an unreachable service end the same way for
        // the pilot — type the numbers — so neither is worth a 500.
        request.log.warn({ err: error }, 'meter scan failed');
        return { status: 'unavailable', hobbs: null, tach: null };
      }

      const reading = readMeters(words, {
        hobbs: aircraft.hobbs === null ? null : Number(aircraft.hobbs),
        tach: aircraft.tach === null ? null : Number(aircraft.tach),
      });
      const found = reading.hobbs !== null || reading.tach !== null;
      return { status: found ? 'read' : 'nothing_found', ...reading };
    },
  );
}
