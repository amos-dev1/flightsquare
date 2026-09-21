import { API_URL } from '@/lib/api';
import { readSession } from '@/lib/session';

/**
 * §3.4's logbook export — "a CSV export of a member's own flight rows is a
 * reasonable convenience so they can transcribe into their real logbook.
 * That is the extent of the pilot-logbook story: an export, not a feature."
 *
 * Proxied for the same reason the statement is: the token is in an httpOnly
 * cookie, so the browser cannot ask the API itself. The API decides whose
 * rows these are — own only, by construction — and this only carries them.
 */
export async function GET(): Promise<Response> {
  const session = await readSession();
  if (!session?.accessToken) return new Response('Sign in first.', { status: 401 });

  const response = await fetch(`${API_URL}/flights/export.csv`, {
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      'x-flightsquare-client': 'web',
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    return new Response('That export could not be produced.', { status: response.status });
  }

  return new Response(response.body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="flights.csv"',
    },
  });
}
