import { Directory, File, Paths } from 'expo-file-system';
import {
  discardFailed,
  flushQueue,
  retryFailed,
  uuidv7,
  type CreateFlightRequest,
  type CreateSquawkRequest,
  type FlushResult,
  type QueuedAttachment,
  type QueuedWrite,
} from '@flightsquare/shared';

import { api, withAuth } from './api';
import { sqliteQueueStore } from './queue';

/**
 * Saving always succeeds.
 *
 * §8.2: the most important screen in the product is used standing at a
 * tiedown on a rural field with one bar or none. If post-flight entry
 * requires connectivity it does not get done, and §3.4's failure mode —
 * stale meters, wrong maintenance numbers — arrives by a different road.
 *
 * So the write lands in SQLite first and syncs afterwards. The id and the
 * idempotency key are minted here, on the device, before the server has
 * heard of either.
 */
export async function saveFlight(payload: CreateFlightRequest): Promise<string> {
  const id = uuidv7();
  const now = new Date().toISOString();

  await sqliteQueueStore.put({
    kind: 'flight',
    id,
    // One key for this flight, for the life of the queue entry. Every retry
    // presents the same one, which is what stops a dropped connection from
    // turning one flight into two.
    idempotencyKey: id,
    // The flight carries the same id. §8.2 mints it here so a squawk filed
    // on the same walk back can name the flight it was found on, whether or
    // not either has reached the server yet.
    payload: { ...payload, id, recorded_at: payload.recorded_at ?? now },
    recordedAt: payload.recorded_at ?? now,
    queuedAt: now,
    attempts: 0,
    state: 'pending',
  });

  // Best effort. Failing here is not a failure to save.
  void sync();
  return id;
}

/**
 * A defect, queued for exactly the same reason.
 *
 * It is noticed on the walk back from the aeroplane, on the same field with
 * the same missing signal — and of the two writes, this is the one that must
 * not be lost. A flight that syncs late leaves the meters stale for an hour.
 * A squawk that was never filed because the form wanted a network leaves the
 * next pilot walking out to an aircraft nobody warned them about.
 */
export async function saveSquawk(payload: CreateSquawkRequest): Promise<string> {
  const id = uuidv7();
  const now = new Date().toISOString();

  await sqliteQueueStore.put({
    kind: 'squawk',
    id,
    idempotencyKey: id,
    // The squawk carries the id too, so a photograph queued in the same
    // minute has something to point at. Neither has reached the server.
    payload: { ...payload, id, reported_at: payload.reported_at ?? now },
    recordedAt: payload.reported_at ?? now,
    queuedAt: now,
    attempts: 0,
    state: 'pending',
  });

  void sync();
  return id;
}

/**
 * A photograph of the defect.
 *
 * The file is copied out of the picker's cache into the app's own document
 * directory first, because the cache is exactly what iOS reclaims when it
 * wants space — and a queue entry pointing at a file the system has deleted
 * is a squawk that arrives without the picture somebody took specifically so
 * it would arrive.
 *
 * `recordedAt` is nudged one millisecond past the owner's, which is what
 * keeps the ordering honest: `flushQueue` sorts by recorded-at, and a file
 * that sorts ahead of its own owner would be sent to an id the server has
 * never seen.
 */
export async function saveAttachment(input: {
  /** What it belongs to: a squawk's photograph or a completion's invoice. */
  owner: QueuedAttachment['payload']['owner'];
  /** Where the picker left it. Copied, not referenced. */
  uri: string;
  contentType: string;
  fileKind?: QueuedAttachment['payload']['fileKind'];
  /** The owner's recorded-at, so this sorts immediately behind it. */
  after: string;
}): Promise<string> {
  const id = uuidv7();
  const now = new Date().toISOString();

  const source = new File(input.uri);
  const kept = new File(attachmentDirectory(), `${id}.${extensionFor(input.contentType)}`);
  source.copy(kept);

  await sqliteQueueStore.put({
    kind: 'attachment',
    id,
    idempotencyKey: id,
    payload: {
      owner: input.owner,
      localUri: kept.uri,
      contentType: input.contentType,
      byteSize: kept.size ?? 0,
      ...(input.fileKind ? { fileKind: input.fileKind } : {}),
    },
    recordedAt: new Date(new Date(input.after).getTime() + 1).toISOString(),
    queuedAt: now,
    attempts: 0,
    state: 'pending',
  });

  void sync();
  return id;
}

function attachmentDirectory(): Directory {
  const directory = new Directory(Paths.document, 'attachments');
  if (!directory.exists) directory.create({ intermediates: true });
  return directory;
}

/**
 * What to call the local copy.
 *
 * `pdf` is on the list because records arrived: a three-branch ternary that
 * fell through to `.jpg` would have written an invoice to the device's own
 * storage under a name that lied about it, which is the kind of thing that only
 * shows up when somebody opens the file months later.
 */
function extensionFor(contentType: string): string {
  const known: Record<string, string> = {
    'image/png': 'png',
    'image/heic': 'heic',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
    'image/jpeg': 'jpg',
  };
  return known[contentType] ?? 'bin';
}

/** Which endpoint a queued write belongs to. The queue does not decide it. */
function submit(entry: QueuedWrite): Promise<unknown> {
  if (entry.kind === 'attachment') return uploadAttachment(entry);
  return withAuth<unknown>(() =>
    entry.kind === 'squawk'
      ? api.createSquawk(entry.payload, entry.idempotencyKey)
      : api.createFlight(entry.payload, entry.idempotencyKey),
  );
}

/**
 * Three steps, and only the first and third are ours.
 *
 * The bytes go straight to object storage through a signed URL the API
 * returned, which is the arrangement that keeps a photograph off the API's
 * body parser entirely. The completion is what turns the row from a
 * declaration into an attachment, and until it happens `storage.bytes` does
 * not count it.
 *
 * Every failure here propagates, which is the point: a 402 because the club
 * is out of storage is permanent and parks the entry for a person to see,
 * while a dropped connection is transient and the whole thing is retried from
 * the beginning. Retrying the beginning costs one abandoned row.
 */
async function uploadAttachment(entry: QueuedAttachment): Promise<unknown> {
  const { owner } = entry.payload;

  // One door per owner, because each needs a different permission (§1.5) and
  // the API declares its gate per route rather than reading the body.
  const created = await withAuth(() =>
    owner.kind === 'squawk'
      ? api.createAttachment({
          squawk_id: owner.squawkId,
          ...(entry.payload.fileKind ? { kind: entry.payload.fileKind } : {}),
          content_type: entry.payload.contentType,
          byte_size: entry.payload.byteSize,
        })
      : api.createCompletionAttachment(owner.complianceRecordId, {
          ...(entry.payload.fileKind ? { kind: entry.payload.fileKind } : {}),
          content_type: entry.payload.contentType,
          byte_size: entry.payload.byteSize,
        }),
  );

  const file = new File(entry.payload.localUri);
  const response = await fetch(created.upload_url!, {
    method: 'PUT',
    headers: { 'Content-Type': entry.payload.contentType },
    body: await file.bytes(),
  });
  if (!response.ok) {
    throw new Error(`the upload was refused (${response.status})`);
  }

  const completed = await withAuth(() =>
    owner.kind === 'squawk'
      ? api.completeAttachment(created.id)
      : api.completeCompletionAttachment(owner.complianceRecordId, created.id),
  );

  // The local copy existed to survive the queue, and the queue is done with
  // it. Leaving it behind fills the device with photographs of defects that
  // were fixed months ago.
  try {
    file.delete();
  } catch {
    // Not worth failing a sent attachment over.
  }
  return completed;
}

export async function sync(): Promise<FlushResult> {
  return flushQueue(sqliteQueueStore, submit);
}

/** Everything on the device, for the screen that shows it. */
export async function queued(): Promise<QueuedWrite[]> {
  return sqliteQueueStore.all();
}

/**
 * Put a refused write back in the queue, or give up on it.
 *
 * Both live in `packages/shared/src/offline.ts` beside the algorithm they
 * complement, so they are tested in Node rather than on a phone. These two
 * lines are the whole of what this workspace adds: the store.
 */
export async function retry(id: string): Promise<boolean> {
  return retryFailed(sqliteQueueStore, id);
}

export async function discard(id: string): Promise<boolean> {
  return discardFailed(sqliteQueueStore, id);
}

export async function pendingCount(): Promise<{ pending: number; failed: number }> {
  const all = await sqliteQueueStore.all();
  return {
    pending: all.filter((entry) => entry.state === 'pending').length,
    failed: all.filter((entry) => entry.state === 'failed').length,
  };
}
