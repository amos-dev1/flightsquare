import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { config } from '../config.js';

/**
 * Object storage, and the one rule about it: the bytes never come through
 * here.
 *
 * §3.8 describes attachments as "object-store pointers, tenant-scoped
 * metadata". The API signs a URL and the device uploads to storage directly,
 * which is not only lighter — it means the Fastify body parser stays as it
 * is, the 1 MiB default limit never has to be raised, and a phone on a bad
 * connection retries against storage rather than against us.
 *
 * MinIO in development, S3 in production, one interface for both. §9 defers
 * the hosting decision, and this is written so that deploying is a change of
 * endpoint and credentials rather than a change of code.
 */

const client = new S3Client({
  region: config.storage.region,
  endpoint: config.storage.endpoint,
  forcePathStyle: config.storage.forcePathStyle,
  credentials: {
    accessKeyId: config.storage.accessKeyId,
    secretAccessKey: config.storage.secretAccessKey,
  },
});

/**
 * Where an attachment's bytes live.
 *
 * Tenant-prefixed so that a bucket listing is readable by a person and a
 * lifecycle rule can be written per tenant later. It is **not** a security
 * boundary — RLS on `attachments` is, and nothing derives access from the
 * shape of a key.
 *
 * The id is the row's, so the key is unguessable without having read the row.
 */
export function storageKey(tenantId: string, attachmentId: string, contentType: string): string {
  const extension = EXTENSIONS[contentType] ?? 'bin';
  return `attachments/${tenantId}/${attachmentId}.${extension}`;
}

/**
 * The types a stored file can be. Anything else is refused.
 *
 * One map, so the allowed set and the extension cannot disagree.
 *
 * PDF arrived with records (SPEC Phase 2): a shop emails an invoice as a PDF
 * and a broker emails an insurance certificate as one, and telling somebody to
 * photograph their screen would be the app's problem becoming theirs. Nothing
 * else follows from it here — `signUpload` pins the declared content type into
 * the signature, so a client cannot claim an image and send something else.
 *
 * What is *not* checked is magic bytes: `application/pdf` can carry 25 MiB of
 * anything. That is against the tenant's own quota and their own eyes, and
 * reading the bytes to find out would mean the API handling them, which the
 * header above exists to prevent.
 */
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

export function isAllowedType(contentType: string): boolean {
  return contentType in EXTENSIONS;
}

/**
 * A URL the device can PUT to, once, for a short while.
 *
 * The content type is signed in, so the upload cannot claim to be one thing
 * here and arrive as another.
 */
export function signUpload(key: string, contentType: string): Promise<string> {
  return getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: config.storage.bucket,
      Key: key,
      ContentType: contentType,
    }),
    { expiresIn: config.storage.urlTtlSeconds },
  );
}

/** A URL the device can GET from, for a short while. */
export function signDownload(key: string): Promise<string> {
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: config.storage.bucket, Key: key }),
    { expiresIn: config.storage.urlTtlSeconds },
  );
}

/**
 * What storage actually received.
 *
 * The client declared a size before uploading and the quota was asserted
 * against that declaration; this is the number the quota is finally counted
 * on. A client that says one megabyte and sends fifty does not get away with
 * it, because the completion step reads the object rather than the claim.
 */
export async function objectSize(key: string): Promise<number | null> {
  try {
    const head = await client.send(
      new HeadObjectCommand({ Bucket: config.storage.bucket, Key: key }),
    );
    return head.ContentLength ?? null;
  } catch {
    // Not there: the signed URL was never used, or expired unused.
    return null;
  }
}

/**
 * Make sure the bucket exists.
 *
 * Development convenience — MinIO starts empty, and a dev stack that needs
 * somebody to open a console and click "create bucket" is a dev stack that
 * does not start. Harmless against a real bucket that already exists.
 */
export async function ensureBucket(): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: config.storage.bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: config.storage.bucket }));
  }
}
