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

## Design

CLAUDE.md §11 governs every screen. The parts that live in code rather than in
a reviewer's head:

- **Tokens are centralised in `src/app/globals.css`**, as the exact §11 hex
  values. Nothing hardcodes a colour.
- **Manrope is loaded with `next/font/google`**, so it is self-hosted — no
  runtime request to a font CDN and no swap-in shift.
- **Primary buttons are black.** Teal is emphasis, not a button fill: it
  appears exactly once in the app, as the active-navigation marker, and
  §11 is explicit that it means *selection* and never airworthiness.
- **Nothing is communicated by colour alone.** Status carries an icon and
  explicit wording; validation carries an icon; the active nav item carries
  weight as well as the marker.
- **Controls use `--color-control` (#8A8A8A), not the decorative border
  token.** §11 says the border token alone is not enough for accessible
  control contrast, and #E5E5E5 on white is not.
- Inputs are 16px, which is also what stops iOS zooming the page on focus.
  Buttons and inputs are 44px tall for touch.

### Logo

The approved assets live in `public/`: `logo.svg` is the horizontal lockup
(1864 × 380) and `logo-mark.svg` the standalone symbol (394 × 394). Both are
pure black artwork for light backgrounds.

`<Logo>` and `<LogoMark>` in `components/ui.tsx` render them **as supplied** —
never stretched, rotated, redrawn, recoloured or given effects, and never
recreated in CSS. Intrinsic dimensions are declared so the ratio is exact and
the header does not shift while the file loads. Header height is 30px, from
§11's 28–32px range, with clear space of a quarter of that.

The mark is also `src/app/icon.svg`, which Next serves as the favicon — the
same file, unmodified.

§11 prefers the *stacked* lockup for centred brand presentations. There is no
stacked asset, and constructing one by arranging the mark and wordmark would
be inventing a lockup, so nothing here does that. Sign-in is left-aligned and
uses the horizontal lockup, which is correct for that layout.
