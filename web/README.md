# web

Next.js — the tenant-facing app, and eventually marketing, signup and
subscription checkout (§8.3 keeps checkout on the web, never in the iOS app).

Runs on **port 3001**; the API is on 3000. Start both:

```sh
npm run dev       # api  -> http://127.0.0.1:3000
npm run dev:web   # web  -> http://127.0.0.1:3001
```

## The browser never sees an API token

This app is a backend-for-frontend. Tokens live in an httpOnly cookie only
the Next server can read, and every API call is made server-side — §8.1
treats every client as untrusted, and a refresh token in `localStorage` is one
XSS away from being someone else's.

`src/middleware.ts` rotates the access token before a page needs it, because a
Server Component cannot set a cookie: refreshing lazily inside a render would
obtain a new token and have nowhere to put it. Middleware runs first and owns
the response, which is the one place that can do both.

## What it does not decide

Nothing here is a control. The client's job is to hide buttons; every gate is
enforced server-side, every time (§1.5, §1.6). The footer shows the plan and
quota by **fetching** resolved entitlements rather than carrying a table of
what each plan includes — that table would go stale and, on the App Store,
could not be corrected without a release (§8.1).

## Imports are extensionless

`moduleResolution: bundler`, unlike the `api` workspace's NodeNext. A `.js`
suffix on a relative import typechecks here and then fails to resolve in the
bundler, which is a confusing way to spend an afternoon.
