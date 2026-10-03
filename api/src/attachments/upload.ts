import type { AttachmentResponse } from '@flightsquare/shared';

import { assertQuota } from '../db/entitlements.js';
import type { QuotaValue } from '../entitlements/values.js';
import { ownMembership } from '../db/membership.js';
import type { Tx } from '../db/context.js';
import { config } from '../config.js';
import { InvalidRequestError, NotFoundError } from '../http/errors.js';
import { isAllowedType, objectSize, signDownload, signUpload, storageKey } from '../storage/index.js';

/**
 * The three steps of an upload, in one place, so three doors can share them.
 *
 * Phase 2 gives attachments two more owners — a completion's invoice and an
 * aircraft document's file — and each needs a different permission (§1.5): a
 * defect photograph is `squawks`, an invoice is `maintenance.items`, a
 * certificate is `documents`.
 *
 * **Which is why there are three routes and not one.** A single endpoint
 * resolving the resource from its body would have to declare *something*
 * statically, and whatever it declared would be wrong for two of the three —
 * which defeats the boot-time check that every route names its gate, and moves
 * the permission decision out of the preHandler where §1.6's order (feature
 * 404 → permission 403 → quota 402) is enforced for free. So the gates stay in
 * route config, where they are greppable, and the plumbing lives here.
 *
 * The bytes never pass through any of it. A create signs a URL the device
 * uploads to directly; completion reads back what actually arrived.
 */

/**
 * Which owner, and never more than one (0038).
 *
 * `null` is the ownerless case the squawk door has always allowed and §8.1 will
 * not let us close. Nothing reaches such a row afterwards, which is the honest
 * outcome rather than a hole: the doors that could read it all name an owner.
 */
export type AttachmentOwner =
  | { squawk_id: string }
  | { compliance_record_id: string }
  | { aircraft_document_id: string }
  | null;

export type AttachmentKind = 'photo' | 'invoice' | 'logbook_entry' | 'document';

/**
 * What a form may not send.
 *
 * Refused before anything is signed rather than after it is sent: telling a
 * phone on one bar that its upload was wasted is not enforcement, it is
 * punishment.
 */
export function assertUploadable(contentType: string, byteSize: number): void {
  if (!isAllowedType(contentType)) {
    throw new InvalidRequestError('that is not a file type this accepts');
  }
  if (byteSize > config.storage.maxUploadBytes) {
    throw new InvalidRequestError(
      `that file is larger than ${Math.floor(config.storage.maxUploadBytes / (1024 * 1024))} MB`,
    );
  }
}

interface SignInput {
  tenantId: string;
  userId: string;
  quota: QuotaValue;
  owner: AttachmentOwner;
  kind: AttachmentKind;
  /** The client's id where it minted one (§8.2), so an offline write can name itself. */
  id?: string;
  contentType: string;
  byteSize: number;
}

/**
 * Reserve the quota, write the row, hand back a signed PUT.
 *
 * Runs inside the caller's transaction, because that is where §4.5's row lock
 * has to live.
 */
export async function signAttachmentUpload(
  trx: Tx,
  input: SignInput,
): Promise<{ id: string; uploadUrl: string }> {
  /*
    §4.5, and the order matters.

    The quota is asserted before the owner is looked up, which means a caller
    naming a record that does not exist while over its limit gets 402 rather
    than 404. That is the §1.6-preferred direction — a limit is a fact about
    the caller's own tenant, and existence is a fact about somebody's data —
    and the review instinct is to swap them.

    `amount` is what 0021 added the helper for: every other quota in the
    product counts things and consumes one, this one consumes as many units as
    the file has bytes.
  */
  await assertQuota(trx, 'storage.bytes', input.quota, { amount: input.byteSize });

  await assertOwnerExists(trx, input.owner);

  const id = input.id ?? crypto.randomUUID();
  const key = storageKey(input.tenantId, id, input.contentType);

  const created = await trx
    .insertInto('attachments')
    .values({
      id,
      tenant_id: input.tenantId,
      squawk_id: null,
      compliance_record_id: null,
      aircraft_document_id: null,
      ...(input.owner ?? {}),
      kind: input.kind,
      storage_key: key,
      content_type: input.contentType,
      byte_size: input.byteSize,
      uploaded_by: await ownMembership(trx, input.userId),
    })
    .returning(['id', 'storage_key', 'content_type'])
    .executeTakeFirstOrThrow();

  return {
    id: created.id,
    uploadUrl: await signUpload(created.storage_key, created.content_type),
  };
}

/**
 * The owner has to be there, and RLS has already decided whether it is.
 *
 * Without this the foreign key would refuse the insert and the caller would
 * get a 500 for what is a 404 — and §6 is explicit that the answer for a
 * record in another tenant is "not found", never "not yours".
 */
async function assertOwnerExists(trx: Tx, owner: AttachmentOwner): Promise<void> {
  if (owner === null) return;

  if ('squawk_id' in owner) {
    const row = await trx
      .selectFrom('squawks')
      .select('id')
      .where('id', '=', owner.squawk_id)
      .executeTakeFirst();
    if (!row) throw new NotFoundError();
    return;
  }
  if ('compliance_record_id' in owner) {
    const row = await trx
      .selectFrom('compliance_records')
      .select('id')
      .where('id', '=', owner.compliance_record_id)
      .executeTakeFirst();
    if (!row) throw new NotFoundError();
    return;
  }
  const row = await trx
    .selectFrom('aircraft_documents')
    .select('id')
    .where('id', '=', owner.aircraft_document_id)
    .executeTakeFirst();
  if (!row) throw new NotFoundError();
}

/** The columns every response here is built from. */
export const ATTACHMENT_COLUMNS = [
  'id',
  'squawk_id',
  'compliance_record_id',
  'aircraft_document_id',
  'kind',
  'status',
  'storage_key',
  'content_type',
  'byte_size',
  'uploaded_at',
  'removed_reason',
] as const;

export interface AttachmentRow {
  id: string;
  squawk_id: string | null;
  compliance_record_id: string | null;
  aircraft_document_id: string | null;
  kind: string;
  status: string;
  storage_key: string;
  content_type: string;
  byte_size: string | number | bigint;
  uploaded_at: Date | null;
  removed_reason: string | null;
}

/**
 * A row as the clients see it, with the URL signed for this response only.
 *
 * Never a stored link: it is a bearer credential for one object, and one that
 * lives in a database row outlives every permission change after it.
 */
export async function toAttachment(row: AttachmentRow): Promise<AttachmentResponse> {
  return {
    id: row.id,
    squawk_id: row.squawk_id,
    compliance_record_id: row.compliance_record_id,
    aircraft_document_id: row.aircraft_document_id,
    kind: row.kind as AttachmentKind,
    status: row.status as 'active' | 'removed',
    content_type: row.content_type,
    byte_size: Number(row.byte_size),
    uploaded: row.uploaded_at !== null,
    ...(row.removed_reason ? { removed_reason: row.removed_reason } : {}),
    // A removed file is not offered for reading. The row stays so the trail
    // does; the link does not, because nothing should be rendering it.
    ...(row.uploaded_at && row.status === 'active'
      ? { url: await signDownload(row.storage_key) }
      : {}),
  };
}

/**
 * What storage actually received, recorded.
 *
 * This is why `byte_size` is written twice. What the client declared is what
 * the quota was asserted against before anything was sent; what storage
 * reports is what the quota finally counts, because a client that declares one
 * megabyte and sends fifty should not get away with it. Until this runs the row
 * is a declaration, and 0020's trigger deliberately counts only rows that have
 * completed.
 *
 * Idempotent by nature — completing twice reads the same object and writes the
 * same size — so it needs no idempotency key.
 */
export async function recordArrival(storageKeyOf: string): Promise<number> {
  const size = await objectSize(storageKeyOf);
  if (size === null) {
    // The signed URL was never used, or expired unused. Saying so beats
    // marking an object that is not there as uploaded.
    throw new InvalidRequestError('nothing has been uploaded for that attachment yet');
  }
  return size;
}
