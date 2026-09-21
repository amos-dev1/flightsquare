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

/**
 * Turn an API failure into something a pilot can act on.
 *
 * §1.6 gives every gate a machine-readable body precisely so the UI can say
 * the right thing; the previous version of this function threw most of that
 * away and hardcoded one sentence about aircraft. The rule here is that the
 * *values* always come off the wire — a limit, a field, a reason — and only
 * the wording is local. §8.1: the client must never carry its own table of
 * what a plan includes, because that table goes stale where it cannot be
 * corrected.
 */

/** Labels, not plan data. The numbers always come from the response. */
const QUOTA_NOUNS: Record<string, string> = {
  'aircraft.active': 'active aircraft',
  'members.active': 'members',
  'storage.bytes': 'bytes of storage',
  'exports.per_month': 'exports a month',
  'api.calls_per_day': 'API calls a day',
};

const RESOURCE_NOUNS: Record<string, string> = {
  aircraft: 'the fleet',
  reservations: 'bookings',
  flights: 'flight records',
  squawks: 'squawks',
  maintenance: 'maintenance records',
  rates: 'rates',
  charges: 'charges',
  qualifications: 'qualifications',
  documents: 'documents',
  members: 'members',
  subscription: 'the subscription',
  settings: 'settings',
};

const FIELD_LABELS: Record<string, string> = {
  registration: 'registration',
  type_code: 'aircraft type',
  home_base: 'home base',
  year_manufactured: 'year',
  seats: 'seats',
  serial_number: 'serial number',
  flight_date: 'flight date',
  hobbs_start: 'Hobbs out',
  hobbs_end: 'Hobbs in',
  tach_start: 'tach out',
  tach_end: 'tach in',
  departed_from: 'departure airport',
  arrived_at: 'arrival airport',
  summary: 'defect summary',
  complied_on: 'signed-off date',
  complied_at_hours: 'meter reading',
  expires_on: 'deferral expiry',
};

/**
 * Fastify's validation text names the field and the rule, in neither
 * English nor a form worth showing anyone: `body/registration must match
 * pattern "^[A-Z0-9][A-Z0-9-]{1,15}$"`.
 *
 * Anything that does not start with `body/` was written by one of our own
 * handlers and is already a sentence, so it passes through untouched.
 */
function friendlyDetail(detail: string | undefined): string {
  if (!detail) return 'Check the form and try again.';

  const match = /^body\/([A-Za-z_]+)\s+(.*)$/s.exec(detail);
  if (!match) return detail;

  const field = FIELD_LABELS[match[1]!] ?? match[1]!.replace(/_/g, ' ');
  const rule = match[2]!;

  if (rule.includes('must match pattern')) return `That ${field} is not in a valid format.`;
  if (rule.includes('fewer than')) return `That ${field} is too short.`;
  if (rule.includes('more than')) return `That ${field} is too long.`;
  if (rule.includes('required')) return `${field[0]!.toUpperCase()}${field.slice(1)} is required.`;
  return `Check the ${field} field.`;
}

function sentence(text: string): string {
  const trimmed = text.trim();
  const capitalised = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}

/** Errors a form should show rather than crash on. */
export function messageFor(error: unknown): string {
  // Not an ApiError at all: the API was unreachable, or something threw
  // before a response existed. Saying "something went wrong" hides which.
  if (!(error instanceof ApiError)) {
    return 'Could not reach the server. Check that it is running, then try again.';
  }

  const body = error.body as {
    error?: string;
    detail?: string;
    reason?: string;
    quota?: string;
    limit?: number;
    remediation?: string[];
    resource?: string;
    level?: string;
    retry_after?: number;
  } | null;

  switch (body?.error) {
    case 'quota_exceeded': {
      // The limit is whatever the server resolved for THIS tenant and THIS
      // key — never a number compiled in here.
      const noun = QUOTA_NOUNS[body.quota ?? ''] ?? (body.quota ?? 'items');
      const limit = typeof body.limit === 'number' ? body.limit : undefined;
      const cap = limit === undefined ? `Your plan limits ${noun}.` : `Your plan allows ${limit} ${noun}.`;
      // Only offer remediation the server said was available. "Upgrade" is
      // deliberately absent until there is somewhere to upgrade.
      return body.remediation?.includes('archive')
        ? `${cap} Archive one to make room.`
        : cap;
    }

    case 'forbidden': {
      const noun = RESOURCE_NOUNS[body.resource ?? ''] ?? body.resource ?? 'that';
      return body.level === 'write'
        ? `You do not have permission to change ${noun}.`
        : `You do not have permission to see ${noun}.`;
    }

    case 'conflict':
      // The only conflict a pilot can produce is a replayed write, and the
      // API's own wording for it is machinery rather than English.
      if (body.reason?.includes('idempotency')) {
        return 'That looks like a duplicate submission. Reload the page and try again.';
      }
      return body.reason ? sentence(body.reason) : 'That conflicts with something already saved.';

    case 'invalid_request':
      return friendlyDetail(body.detail);

    case 'not_found':
      return 'Not found. It may have been archived or removed.';

    case 'rate_limited':
      return 'Too many attempts. Wait a few minutes and try again.';

    case 'unauthorized':
      return 'Your session has expired. Sign in again.';

    case 'tenant_required':
      return 'No organisation is selected for this session. Sign in again.';

    case 'client_too_old':
      return 'This app is out of date. Reload the page to get the current version.';

    default:
      return 'Something went wrong. Try again.';
  }
}
