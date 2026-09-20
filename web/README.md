# web

Next.js, per CLAUDE.md §9: marketing, signup, subscription checkout, and the
full application. Intentionally empty.

Two things it already owes the rest of the system:

- **Subscription checkout lives here, not in the app** (§8.3). An IAP
  subscription belongs to an Apple ID rather than an organization, so when the
  member who bought it leaves the club nobody — including us — can cancel or
  manage it. Web checkout also keeps Stripe the single system of record for
  platform billing.
- **Entitlements are fetched, never compiled in** (§8.1). The client receives
  resolved flags and quotas and hides UI accordingly; it must never carry a
  table of what Pro includes.

It shares types and the generated API client with `mobile/` through
`packages/shared`, not UI code. Two UI codebases is the accepted cost of a web
surface good enough to sell subscriptions on.
