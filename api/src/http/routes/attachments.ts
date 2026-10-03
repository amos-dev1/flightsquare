import type { FastifyInstance } from 'fastify';
import type { AttachmentResponse, CreateAttachmentRequest } from '@flightsquare/shared';

import {
  ATTACHMENT_COLUMNS,
  assertUploadable,
  recordArrival,
  signAttachmentUpload,
  toAttachment,
} from '../../attachments/upload.js';
import { NotFoundError } from '../errors.js';

/**
 * Attachments (§3.8) — photographs of a defect, to begin with.
 *
 * **The bytes never come through here.** A create signs a URL the device
 * uploads to directly, which keeps the Fastify body parser as it is, keeps
 * the 1 MiB default limit where it is, and means a phone on a bad connection
 * retries against storage rather than against us.
 *
 * Three steps, and the middle one is not ours:
 *
 *   1. POST /attachments        — quota, row, signed PUT
 *   2. the device PUTs the file to storage
 *   3. POST /attachments/:id/complete — read back what actually arrived
 *
 * Step 3 is why `byte_size` is written twice. What the client declares is
 * what the quota is asserted against *before* anything is sent, because
 * refusing after a phone has uploaded fifteen megabytes over a bad connection
 * is a cruel way to enforce a limit. What storage reports is what the quota
 * finally counts, because a client that declares one megabyte and sends fifty
 * should not get away with it. Until step 3 the row is a declaration, and
 * 0020's trigger deliberately counts only rows that have completed.
 *
 * Gated on `squawks`, not on a resource of its own: the photograph belongs to
 * the defect, and whoever may report one may illustrate it.
 *
 * **These four doors stayed squawk-shaped when records arrived.** An invoice on
 * a completion needs `maintenance.items` and a certificate needs `documents`
 * (§1.5), so each got a door of its own rather than this one learning to decide
 * which permission it needed — a route whose gate depends on its body is a
 * route the boot-time check cannot verify.
 *
 * The consequence is a predicate repeated below: the single-row doors refuse a
 * row owned by a completion or a document. Without it, `squawks: write` would
 * complete somebody else's upload and the three-door split would collapse back
 * into one. Squawk-owned *or ownerless* is what they serve, and the second half
 * is §8.1 — an ownerless attachment is creatable through this door today, so a
 * rule an old client would now fail does not get tightened.
 */
export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  const createSchema = {
    body: {
      type: 'object',
      required: ['content_type', 'byte_size'],
      additionalProperties: false,
      properties: {
        // §8.2: the client generates ids, so an offline write can name
        // itself before the server has heard of it.
        id: { type: 'string', format: 'uuid' },
        squawk_id: { type: 'string', format: 'uuid' },
        content_type: { type: 'string', maxLength: 100 },
        byte_size: { type: 'integer', minimum: 1 },
      },
    },
  } as const;

  app.post<{ Body: CreateAttachmentRequest }>(
    '/attachments',
    {
      schema: createSchema,
      config: { requiresTenant: true, permission: ['squawks', 'write'] },
    },
    async (request, reply) => {
      const body = request.body;
      assertUploadable(body.content_type, body.byte_size);

      const { entitlements } = await request.loadGates();
      const tenantId = request.ctx!.tenantId!;

      const created = await request.withTenant((trx) =>
        signAttachmentUpload(trx, {
          tenantId,
          userId: request.ctx!.userId,
          quota: entitlements.quota('storage.bytes'),
          // Still the only owner this door accepts, and still optional — see
          // the §8.1 note in the header.
          owner: body.squawk_id ? { squawk_id: body.squawk_id } : null,
          kind: body.kind ?? 'photo',
          ...(body.id ? { id: body.id } : {}),
          contentType: body.content_type,
          byteSize: body.byte_size,
        }),
      );

      return reply.status(201).send({
        id: created.id,
        squawk_id: body.squawk_id ?? null,
        compliance_record_id: null,
        aircraft_document_id: null,
        kind: body.kind ?? 'photo',
        status: 'active',
        content_type: body.content_type,
        byte_size: body.byte_size,
        uploaded: false,
        upload_url: created.uploadUrl,
      } satisfies AttachmentResponse);
    },
  );

  /**
   * The upload landed. Record what storage actually holds.
   *
   * Idempotent by nature — completing twice reads the same object and writes
   * the same size — so no idempotency key: a retry cannot double anything.
   */
  app.post<{ Params: { id: string } }>(
    '/attachments/:id/complete',
    { config: { requiresTenant: true, permission: ['squawks', 'write'] } },
    async (request) => {
      const row = await request.withTenant((trx) =>
        trx
          .selectFrom('attachments')
          .select(ATTACHMENT_COLUMNS)
          .where('id', '=', request.params.id)
          // Squawk-owned or ownerless, and nothing else — see the header.
          .where('compliance_record_id', 'is', null)
          .where('aircraft_document_id', 'is', null)
          .executeTakeFirst(),
      );
      if (!row) throw new NotFoundError();

      const size = await recordArrival(row.storage_key);

      await request.withTenant((trx) =>
        trx
          .updateTable('attachments')
          .set({ byte_size: size, uploaded_at: new Date() })
          .where('id', '=', request.params.id)
          .execute(),
      );

      return toAttachment({ ...row, byte_size: size, uploaded_at: new Date() });
    },
  );

  /**
   * Where to read it from, for a little while.
   *
   * A signed URL per request rather than a stored public one: the link is a
   * bearer credential for one object, and one that lives in a database row
   * is one that outlives every permission change after it.
   */
  app.get<{ Params: { id: string } }>(
    '/attachments/:id',
    { config: { requiresTenant: true, permission: ['squawks', 'read'] } },
    async (request) => {
      const row = await request.withTenant((trx) =>
        trx
          .selectFrom('attachments')
          .select(ATTACHMENT_COLUMNS)
          .where('id', '=', request.params.id)
          // Squawk-owned or ownerless, and nothing else — see the header.
          .where('compliance_record_id', 'is', null)
          .where('aircraft_document_id', 'is', null)
          .executeTakeFirst(),
      );
      if (!row) throw new NotFoundError();

      return toAttachment(row);
    },
  );

  /** Everything hanging off one squawk. */
  app.get<{ Params: { id: string } }>(
    '/squawks/:id/attachments',
    { config: { requiresTenant: true, permission: ['squawks', 'read'] } },
    async (request) => {
      const rows = await request.withTenant((trx) =>
        trx
          .selectFrom('attachments')
          .select(ATTACHMENT_COLUMNS)
          .where('squawk_id', '=', request.params.id)
          // A file filed by mistake is not rendered beside the defect. The row
          // stays and the bytes stay counted; the list is about what is there.
          .where('status', '=', 'active')
          .orderBy('created_at')
          .execute(),
      );

      return Promise.all(rows.map(toAttachment)) satisfies Promise<AttachmentResponse[]>;
    },
  );
}

