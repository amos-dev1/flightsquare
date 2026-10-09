/**
 * Liveness for the container platform. Unauthenticated, and it touches nothing.
 *
 * The same contract as the API's `/health`: is this process up and serving?
 * It deliberately does not call the API, read a cookie or render a page,
 * because a health check that depends on something else turns that thing's
 * outage into this service being replaced.
 *
 * It exists because `/` answers 307 — unauthenticated visitors are redirected
 * to sign in — and a redirect is a poor thing to hang a health check on: it
 * passes or fails on auth routing rather than on whether the server is alive.
 *
 * No `export const dynamic`: this version's own docs
 * (node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md)
 * state that route handlers are not cached by default, and the option exists
 * for opting *into* caching with 'force-static'. Declaring 'force-dynamic'
 * here asked for the behaviour already in force and implied a caching risk
 * that is not there.
 */
export function GET(): Response {
  return Response.json({ status: 'ok' });
}
