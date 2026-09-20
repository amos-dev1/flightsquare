import { NextResponse, type NextRequest } from 'next/server';

import { SESSION_COOKIE, type StoredSession } from './lib/session';

const API_URL = process.env.FS_API_URL ?? 'http://127.0.0.1:3000';
/** Refresh a little early, so a slow render never straddles the expiry. */
const REFRESH_MARGIN_MS = 60_000;

/**
 * Rotate the access token before a page needs it.
 *
 * This lives in middleware because a Server Component cannot set a cookie —
 * so refreshing lazily inside a render would obtain a new token and have
 * nowhere to put it. Middleware runs first and owns the response, which is
 * the one place in a Next app that can both call the API and write the
 * result back.
 */
export async function middleware(request: NextRequest) {
  const raw = request.cookies.get(SESSION_COOKIE)?.value;
  if (!raw) return NextResponse.next();

  let session: StoredSession;
  try {
    session = JSON.parse(raw) as StoredSession;
  } catch {
    return NextResponse.next();
  }

  const expiresAt = Date.parse(session.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt - Date.now() > REFRESH_MARGIN_MS) {
    return NextResponse.next();
  }

  const refreshed = await fetch(`${API_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: session.refreshToken }),
  }).catch(() => null);

  const response = NextResponse.next();

  if (!refreshed?.ok) {
    // Expired, revoked, or the token was replayed and the API burned the
    // session. All of them mean: sign in again.
    response.cookies.delete(SESSION_COOKIE);
    return response;
  }

  const body = (await refreshed.json()) as {
    access_token: string;
    refresh_token: string;
    expires_at: string;
  };

  response.cookies.set(
    SESSION_COOKIE,
    JSON.stringify({
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: body.expires_at,
      tenantId: session.tenantId,
    } satisfies StoredSession),
    {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 90 * 24 * 60 * 60,
    },
  );
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
