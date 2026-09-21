import { API_URL } from '@/lib/api';
import { readSession } from '@/lib/session';

/**
 * The statement download, proxied rather than linked.
 *
 * The browser cannot fetch the API directly: the token lives in an httpOnly
 * cookie only this server can read (§8.1's backend-for-frontend), so an
 * `<a href>` straight at the API arrives unauthenticated. A route handler is
 * the smallest thing that can hold the token and stream the answer back.
 *
 * It forwards rather than reformats. The CSV is the API's, so a treasurer
 * downloading from the web and a script pulling the same URL get identical
 * bytes.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ member: string }> },
): Promise<Response> {
  const session = await readSession();
  if (!session?.accessToken) return new Response('Sign in first.', { status: 401 });

  const { member } = await params;
  const incoming = new URL(request.url);
  const query = new URLSearchParams({ member });
  // Only the two the statement understands — never the caller's whole query
  // string, which would let anything be appended to an authenticated request.
  for (const key of ['from', 'to'] as const) {
    const value = incoming.searchParams.get(key);
    if (value) query.set(key, value);
  }

  const response = await fetch(`${API_URL}/statement.csv?${query}`, {
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      'x-flightsquare-client': 'web',
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    return new Response('That statement could not be produced.', { status: response.status });
  }

  return new Response(response.body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition':
        response.headers.get('content-disposition') ?? 'attachment; filename="statement.csv"',
    },
  });
}
