import type { FastifyInstance } from 'fastify';
import type {
  AircraftDocumentResponse,
  AttachFileRequest,
  AttachmentResponse,
  CreateAircraftDocumentRequest,
  UpdateAircraftDocumentRequest,
} from '@flightsquare/shared';

import {
  ATTACHMENT_COLUMNS,
  assertUploadable,
  recordArrival,
  signAttachmentUpload,
  toAttachment,
  type AttachmentRow,
} from '../../attachments/upload.js';
import { ownMembership } from '../../db/membership.js';
import type { Tx } from '../../db/context.js';
import { InvalidRequestError, NotFoundError } from '../errors.js';

/**
 * Aircraft documents (§3.2) — the paperwork that belongs to the aeroplane
 * rather than to a job of work.
 *
 * The AROW set is the reason: airworthiness certificate, registration,
 * operating limitations, weight and balance. A pilot is responsible for those
 * being aboard and currently has to take it on trust or go and look. Insurance
 * is not AROW and is here because it is the one a club actually chases.
 *
 * **Gated on `documents`, which has existed since `0005` and been wired to
 * nothing.** Admin holds `write`, Pilot holds `read` — seeded that way in
 * `0027`, so no migration and no change to the resource list. SPEC §3 asks for
 * a `maintenance.records` resource instead; a resource nothing else would ever
 * reference is a column in the permission model, not a resource.
 *
 * No feature flag. SPEC gates records off on Free and §8.3 forbids crippling
 * the free tier — "deliberately crippling the free tier to push people to the
 * web is itself grounds for rejection" — so `storage.bytes` is the only limit,
 * which is honest and already enforced.
 *
 * **Expiry is a notice and never a grounding.** `aircraft_availability` keeps
 * its three inputs and the booking path never consults this. §11 forbids
 * inferring airworthiness from an absence of warnings, and the mirror binds
 * just as hard: the club may have renewed and not uploaded, a registration may
 * have a renewal pending with the FAA, and a standard airworthiness certificate
 * does not expire at all. Grounding an aeroplane over a stale scan would be the
 * app making an airworthiness determination from missing data.
 */

const documentFields = {
  kind: {
    type: 'string',
    enum: [
      'airworthiness',
      'registration',
      'operating_limitations',
      'weight_balance',
      'insurance',
      'other',
    ],
  },
  title: { type: 'string', minLength: 1, maxLength: 200 },
  reference: { type: 'string', maxLength: 100 },
  issued_on: { type: 'string', format: 'date' },
  expires_on: { type: 'string', format: 'date' },
  notes: { type: 'string', maxLength: 2000 },
} as const;

const createSchema = {
  body: {
    type: 'object',
    required: ['kind', 'title'],
    additionalProperties: false,
    properties: { ...documentFields, supersedes_id: { type: 'string', format: 'uuid' } },
  },
} as const;

const updateSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: {
      title: documentFields.title,
      reference: documentFields.reference,
      issued_on: documentFields.issued_on,
      expires_on: documentFields.expires_on,
      notes: documentFields.notes,
      // Only one direction. A removed document is not restored by setting this
      // back — if the file belongs on the aeroplane, upload it again.
      status: { type: 'string', enum: ['removed'] },
      removed_reason: { type: 'string', minLength: 5, maxLength: 500 },
    },
  },
} as const;

const attachSchema = {
  body: {
    type: 'object',
    required: ['content_type', 'byte_size'],
    additionalProperties: false,
    properties: {
      // §8.2: the client may name it, so an offline write can refer to itself.
      id: { type: 'string', format: 'uuid' },
      kind: { type: 'string', enum: ['photo', 'invoice', 'logbook_entry', 'document'] },
      content_type: { type: 'string', maxLength: 100 },
      byte_size: { type: 'integer', minimum: 1 },
    },
  },
} as const;

export async function documentRoutes(app: FastifyInstance): Promise<void> {
  /** Everything on one aeroplane, current first, with the files signed. */
  app.get<{ Params: { id: string } }>(
    '/aircraft/:id/documents',
    { config: { requiresTenant: true, permission: ['documents', 'read'] } },
    async (request) => {
      return request.withTenant<AircraftDocumentResponse[]>(async (trx) => {
        await requireAircraft(trx, request.params.id);
        return listDocuments(trx, request.params.id);
      });
    },
  );

  /**
   * The document, written before its file.
   *
   * That order is the whole reason the foreign key points from the attachment
   * to the document: the owner exists first and the upload names it, which is
   * how a squawk photograph already works and what makes the offline queue's
   * ordering correct. It also means a club can record that the insurance
   * expires on 31 March before anybody has scanned it.
   */
  app.post<{ Params: { id: string }; Body: CreateAircraftDocumentRequest }>(
    '/aircraft/:id/documents',
    {
      schema: createSchema,
      config: { requiresTenant: true, permission: ['documents', 'write'] },
    },
    async (request, reply) => {
      const body = request.body;

      const created = await request.withTenant(async (trx) => {
        await requireAircraft(trx, request.params.id);

        if (body.supersedes_id) {
          // RLS hides another tenant's row; this turns the foreign-key
          // violation that would follow into the answer §6 asks for.
          const previous = await trx
            .selectFrom('aircraft_documents')
            .select(['id', 'kind'])
            .where('id', '=', body.supersedes_id)
            .where('aircraft_id', '=', request.params.id)
            .executeTakeFirst();
          if (!previous) throw new NotFoundError();
          if (previous.kind !== body.kind) {
            // A registration does not supersede an insurance certificate, and
            // a list that let it would stop meaning anything.
            throw new InvalidRequestError('a renewal replaces a document of the same kind');
          }
        }

        const row = await trx
          .insertInto('aircraft_documents')
          .values({
            tenant_id: request.ctx!.tenantId!,
            aircraft_id: request.params.id,
            kind: body.kind,
            title: body.title,
            reference: body.reference ?? null,
            issued_on: body.issued_on ?? null,
            expires_on: body.expires_on ?? null,
            notes: body.notes ?? null,
            supersedes_id: body.supersedes_id ?? null,
            uploaded_by: await ownMembership(trx, request.ctx!.userId),
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        const [saved] = await listDocuments(trx, request.params.id, row.id);
        if (!saved) throw new NotFoundError();
        return saved;
      });

      return reply.status(201).send(created);
    },
  );

  /**
   * Correcting a document, or taking it off the list.
   *
   * There is no delete (§10): a document filed by mistake is `removed` with a
   * reason, and a superseded one is not removed at all — the 2024 policy is
   * what answers a question about a 2024 claim.
   */
  app.patch<{ Params: { id: string }; Body: UpdateAircraftDocumentRequest }>(
    '/aircraft-documents/:id',
    {
      schema: updateSchema,
      config: { requiresTenant: true, permission: ['documents', 'write'] },
    },
    async (request) => {
      const body = request.body;

      if (body.status === 'removed' && !body.removed_reason) {
        throw new InvalidRequestError('say why it is being removed');
      }

      return request.withTenant<AircraftDocumentResponse>(async (trx) => {
        const existing = await trx
          .selectFrom('aircraft_documents')
          .select(['id', 'aircraft_id', 'status'])
          .where('id', '=', request.params.id)
          .executeTakeFirst();
        if (!existing) throw new NotFoundError();

        await trx
          .updateTable('aircraft_documents')
          .set({
            ...(body.title !== undefined ? { title: body.title } : {}),
            ...(body.reference !== undefined ? { reference: body.reference } : {}),
            ...(body.issued_on !== undefined ? { issued_on: body.issued_on } : {}),
            ...(body.notes !== undefined ? { notes: body.notes } : {}),
            ...(body.expires_on !== undefined
              ? {
                  expires_on: body.expires_on,
                  // A new date is a new question, so whatever was already said
                  // about the old one no longer applies.
                  notified_state: null,
                }
              : {}),
            ...(body.status === 'removed'
              ? {
                  status: 'removed' as const,
                  removed_at: new Date(),
                  removed_by: await ownMembership(trx, request.ctx!.userId),
                  removed_reason: body.removed_reason ?? null,
                }
              : {}),
          })
          .where('id', '=', request.params.id)
          .execute();

        const [saved] = await listDocuments(trx, existing.aircraft_id, request.params.id);
        if (!saved) throw new NotFoundError();
        return saved;
      });
    },
  );

  /**
   * The file, in the three steps every upload here uses.
   *
   * One document can carry several — a two-page certificate is two rows
   * against one document, which is what the foreign key's direction buys.
   */
  app.post<{ Params: { id: string }; Body: AttachFileRequest }>(
    '/aircraft-documents/:id/attachments',
    {
      schema: attachSchema,
      config: { requiresTenant: true, permission: ['documents', 'write'] },
    },
    async (request, reply) => {
      const body = request.body;
      assertUploadable(body.content_type, body.byte_size);

      const { entitlements } = await request.loadGates();

      const created = await request.withTenant((trx) =>
        signAttachmentUpload(trx, {
          tenantId: request.ctx!.tenantId!,
          userId: request.ctx!.userId,
          quota: entitlements.quota('storage.bytes'),
          owner: { aircraft_document_id: request.params.id },
          kind: body.kind ?? 'document',
          ...(body.id ? { id: body.id } : {}),
          contentType: body.content_type,
          byteSize: body.byte_size,
        }),
      );

      return reply.status(201).send({
        id: created.id,
        squawk_id: null,
        compliance_record_id: null,
        aircraft_document_id: request.params.id,
        kind: body.kind ?? 'document',
        status: 'active',
        content_type: body.content_type,
        byte_size: body.byte_size,
        uploaded: false,
        upload_url: created.uploadUrl,
      } satisfies AttachmentResponse);
    },
  );

  /**
   * The upload landed.
   *
   * The attachment is matched against the document in the `WHERE` rather than
   * compared in an `if`: a mismatched pair is then a 404 produced by RLS and a
   * predicate, which is both shorter and harder to get wrong.
   */
  app.post<{ Params: { id: string; attachmentId: string } }>(
    '/aircraft-documents/:id/attachments/:attachmentId/complete',
    { config: { requiresTenant: true, permission: ['documents', 'write'] } },
    async (request) => {
      const row = await request.withTenant((trx) =>
        trx
          .selectFrom('attachments')
          .select(ATTACHMENT_COLUMNS)
          .where('id', '=', request.params.attachmentId)
          .where('aircraft_document_id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (!row) throw new NotFoundError();

      const size = await recordArrival(row.storage_key);

      await request.withTenant((trx) =>
        trx
          .updateTable('attachments')
          .set({ byte_size: size, uploaded_at: new Date() })
          .where('id', '=', request.params.attachmentId)
          .execute(),
      );

      return toAttachment({ ...row, byte_size: size, uploaded_at: new Date() });
    },
  );
}

/**
 * Documents with their files, and whether anything has replaced them.
 *
 * `superseded` is a left join that found nothing rather than a column somebody
 * had to remember to write — the same reason §3.7 snapshots a rate instead of
 * pointing at one. Two current insurance certificates is not a state this can
 * report, because nothing stores the fact twice.
 */
async function listDocuments(
  trx: Tx,
  aircraftId: string,
  onlyId?: string,
): Promise<AircraftDocumentResponse[]> {
  let query = trx
    .selectFrom('aircraft_documents as d')
    .leftJoin('aircraft_documents as later', 'later.supersedes_id', 'd.id')
    .select([
      'd.id',
      'd.aircraft_id',
      'd.kind',
      'd.title',
      'd.reference',
      'd.issued_on',
      'd.expires_on',
      'd.notes',
      'd.supersedes_id',
      'd.status',
      'd.removed_reason',
      'd.created_at',
      'later.id as superseded_by',
    ])
    .where('d.aircraft_id', '=', aircraftId);

  if (onlyId) query = query.where('d.id', '=', onlyId);

  const rows = await query
    // Current first, then by kind so the AROW set reads in a stable order.
    .orderBy('d.status')
    .orderBy('d.kind')
    .orderBy('d.created_at', 'desc')
    .execute();

  if (rows.length === 0) return [];

  const files = await trx
    .selectFrom('attachments')
    .select(ATTACHMENT_COLUMNS)
    .where(
      'aircraft_document_id',
      'in',
      rows.map((row) => row.id),
    )
    .where('status', '=', 'active')
    .orderBy('created_at')
    .execute();

  const byDocument = new Map<string, AttachmentRow[]>();
  for (const file of files) {
    const key = file.aircraft_document_id!;
    byDocument.set(key, [...(byDocument.get(key) ?? []), file]);
  }

  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      aircraft_id: row.aircraft_id,
      kind: row.kind,
      title: row.title,
      reference: row.reference,
      issued_on: row.issued_on,
      expires_on: row.expires_on,
      notes: row.notes,
      supersedes_id: row.supersedes_id,
      superseded: row.superseded_by !== null,
      status: row.status,
      removed_reason: row.removed_reason,
      attachments: await Promise.all((byDocument.get(row.id) ?? []).map(toAttachment)),
      created_at: new Date(row.created_at as unknown as string).toISOString(),
    })),
  );
}

/** RLS has already decided; this turns its silence into §6's answer. */
async function requireAircraft(trx: Tx, aircraftId: string): Promise<void> {
  const row = await trx
    .selectFrom('aircraft')
    .select('id')
    .where('id', '=', aircraftId)
    .executeTakeFirst();
  if (!row) throw new NotFoundError();
}
