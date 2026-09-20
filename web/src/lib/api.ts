import 'server-only';

import { readSession } from './session';

export const API_URL = process.env.FS_API_URL ?? 'http://127.0.0.1:3000';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`API responded ${status}`);
  }
}

/**
 * Every call the web app makes to the API, server-side, with the bearer token
 * attached from the httpOnly cookie.
 *
 * §8.1: the client hiding a button is cosmetics. Nothing here decides what a
 * user may do — it asks, and renders whatever the API allows. A 404 from a
 * feature gate and a 404 from a missing record look the same on purpose, and
 * this layer does not try to tell them apart.
 */
export async function apiFetch<T>(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<T> {
  const token = init.token ?? (await readSession())?.accessToken;

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-flightsquare-client': 'web',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(response.status, body);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Errors a form should show rather than crash on. */
export function messageFor(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Try again.';

  const body = error.body as { error?: string; detail?: string; quota?: string } | null;
  switch (body?.error) {
    case 'quota_exceeded':
      // §1.6: the 402 body is machine-readable so the UI can offer the right
      // remediation. Upsell copy belongs here, never in a status code.
      return `Your plan allows only one active aircraft. Archive the one you have, or upgrade.`;
    case 'forbidden':
      return 'You do not have permission to do that.';
    case 'conflict':
      return 'That registration is already in your fleet.';
    case 'invalid_request':
      return body.detail ?? 'Check the form and try again.';
    case 'not_found':
      return 'Not found.';
    default:
      return 'Something went wrong. Try again.';
  }
}
