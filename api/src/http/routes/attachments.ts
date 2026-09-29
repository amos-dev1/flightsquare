import type { FastifyInstance } from 'fastify';
import type { AttachmentResponse, CreateAttachmentRequest } from '@flightsquare/shared';

import { assertQuota } from '../../db/entitlements.js';
import { ownMembership } from '../../db/membership.js';
import { config } from '../../config.js';
import { InvalidRequestError, NotFoundError } from '../errors.js';
import { isAllowedType, objectSize, signDownload, signUpload, storageKey } from '../../storage/index.js';

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

      if (!isAllowedType(body.content_type)) {
        return reply.status(400).send({
          error: 'invalid_request',
          detail: 'that is not an image type this accepts',
        });
      }
      if (body.byte_size > config.storage.maxUploadBytes) {
        // Refused before it is signed rather than after it is sent.
        return reply.status(400).send({
          error: 'invalid_request',
          detail: `that file is larger than ${Math.floor(
            config.storage.maxUploadBytes / (1024 * 1024),
          )} MB`,
        });
      }

      const { entitlements } = await request.loadGates();
      const tenantId = request.ctx!.tenantId!;

      const created = await request.withTenant(async (trx) => {
        // §4.5: inside the write transaction, because that is where the row
        // lock has to live. The limit is what §1.4 resolved; the counting and
        // the locking are the database's.
        //
        // `amount` is what 0021 added the helper for. Every other quota in the
        // product is a count of things and consumes one; this one consumes as
        // many units as the file has bytes, and a tenant one byte under 1 GiB
        // would otherwise upload a ten megabyte photograph without complaint.
        await assertQuota(trx, 'storage.bytes', entitlements.quota('storage.bytes'), {
          amount: body.byte_size,
        });

        if (body.squawk_id) {
          // RLS would hide another tenant's squawk anyway; this turns the
          // resulting foreign-key violation into an answer (§6).
          const squawk = await trx
            .selectFrom('squawks')
            .select('id')
            .where('id', '=', body.squawk_id)
            .executeTakeFirst();
          if (!squawk) throw new NotFoundError();
        }

        const id = body.id ?? crypto.randomUUID();
        const key = storageKey(tenantId, id, body.content_type);

        return trx
          .insertInto('attachments')
          .values({
            id,
            tenant_id: tenantId,
            squawk_id: body.squawk_id ?? null,
            storage_key: key,
            content_type: body.content_type,
            byte_size: body.byte_size,
            uploaded_by: await ownMembership(trx, request.ctx!.userId),
          })
          .returning(['id', 'storage_key', 'content_type'])
          .executeTakeFirstOrThrow();
      });

      return reply.status(201).send({
        id: created.id,
        squawk_id: body.squawk_id ?? null,
        content_type: created.content_type,
        byte_size: body.byte_size,
        uploaded: false,
        upload_url: await signUpload(created.storage_key, created.content_type),
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
          .select(['id', 'squawk_id', 'storage_key', 'content_type'])
          .where('id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (!row) throw new NotFoundError();

      const size = await objectSize(row.storage_key);
      if (size === null) {
        // The signed URL was never used, or expired unused. Saying so beats
        // marking an object that is not there as uploaded.
        throw new InvalidRequestError('nothing has been uploaded for that attachment yet');
      }

      await request.withTenant((trx) =>
        trx
          .updateTable('attachments')
          .set({ byte_size: size, uploaded_at: new Date() })
          .where('id', '=', request.params.id)
          .execute(),
      );

      return {
        id: row.id,
        squawk_id: row.squawk_id,
        content_type: row.content_type,
        byte_size: size,
        uploaded: true,
      } satisfies AttachmentResponse;
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
          .select(['id', 'squawk_id', 'storage_key', 'content_type', 'byte_size', 'uploaded_at'])
          .where('id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (!row) throw new NotFoundError();

      return {
        id: row.id,
        squawk_id: row.squawk_id,
        content_type: row.content_type,
        byte_size: Number(row.byte_size),
        uploaded: row.uploaded_at !== null,
        ...(row.uploaded_at ? { url: await signDownload(row.storage_key) } : {}),
      } satisfies AttachmentResponse;
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
          .select(['id', 'squawk_id', 'storage_key', 'content_type', 'byte_size', 'uploaded_at'])
          .where('squawk_id', '=', request.params.id)
          .orderBy('created_at')
          .execute(),
      );

      return Promise.all(
        rows.map(async (row) => ({
          id: row.id,
          squawk_id: row.squawk_id,
          content_type: row.content_type,
          byte_size: Number(row.byte_size),
          uploaded: row.uploaded_at !== null,
          ...(row.uploaded_at ? { url: await signDownload(row.storage_key) } : {}),
        })),
      ) satisfies Promise<AttachmentResponse[]>;
    },
  );
}
