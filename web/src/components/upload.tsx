'use client';

import { useRef, useState, useTransition } from 'react';
import { Paperclip, Upload } from 'lucide-react';

import { finishUpload, startUpload } from '@/app/actions';
import { Alert, Button } from '@/components/ui';

/**
 * Web's first upload, and the one new client mechanism in records.
 *
 * Three steps, and the middle one is the browser's: a server action signs a
 * PUT, the browser sends the bytes straight to object storage, and a second
 * action reads back what arrived. **The bytes do not pass through the Next.js
 * server either**, for the same reason they do not pass through the API — a
 * server that handles uploads needs a body limit, a parser and a retry story,
 * and object storage already has all three.
 *
 * The quota is asserted at step one, against what the browser says it is about
 * to send. Refusing after somebody has waited through an upload is not
 * enforcement, it is punishment — and step three re-counts from what storage
 * actually received, so a declaration is not taken on trust.
 */

export type UploadOwner =
  | { kind: 'completion'; id: string }
  | { kind: 'document'; id: string }
  | { kind: 'squawk'; id: string };

export function FileUpload({
  owner,
  label = 'Attach a file',
  fileKind,
  revalidate,
  onDone,
}: {
  owner: UploadOwner;
  label?: string;
  /** What the file is, for the list that renders it later. Not its source. */
  fileKind?: 'photo' | 'invoice' | 'logbook_entry' | 'document';
  /** The path whose cache this invalidates once the file has landed. */
  revalidate?: string;
  onDone?: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function send(file: File) {
    setError(null);
    setProgress('Preparing…');

    const signed = await startUpload(owner, {
      content_type: file.type || 'application/octet-stream',
      byte_size: file.size,
      ...(fileKind ? { kind: fileKind } : {}),
    });
    if (signed.error || !signed.upload_url || !signed.id) {
      setProgress(null);
      // The server's own words, which carry the quota numbers §1.6 puts in the
      // body precisely so a screen can say something accurate.
      setError(signed.error ?? 'that upload could not be started');
      return;
    }

    setProgress('Uploading…');
    const sent = await fetch(signed.upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    }).catch(() => null);

    if (!sent?.ok) {
      setProgress(null);
      setError('The upload did not finish. Nothing has been saved against the record.');
      return;
    }

    setProgress('Finishing…');
    const done = await finishUpload(owner, signed.id, revalidate);
    setProgress(null);
    if (done.error) {
      setError(done.error);
      return;
    }
    if (input.current) input.current.value = '';
    onDone?.();
  }

  return (
    <div className="space-y-2">
      <input
        ref={input}
        type="file"
        // What the API accepts, said here as well so the picker does not offer
        // what the server will refuse.
        accept="image/jpeg,image/png,image/heic,image/webp,application/pdf"
        className="sr-only"
        id={`upload-${owner.kind}-${owner.id}`}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) startTransition(() => void send(file));
        }}
      />

      <Button
        variant="secondary"
        disabled={pending}
        onClick={() => input.current?.click()}
        type="button"
      >
        {pending ? <Upload aria-hidden size={16} strokeWidth={2} /> : <Paperclip aria-hidden size={16} strokeWidth={2} />}
        {progress ?? label}
      </Button>

      {error ? <Alert>{error}</Alert> : null}
    </div>
  );
}
