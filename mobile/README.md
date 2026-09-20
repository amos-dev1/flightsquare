# mobile

Expo (React Native) for iOS/iPadOS, per CLAUDE.md §9. Intentionally empty.

**When this becomes real, Expo needs Metro configured for npm workspaces** —
`watchFolders` pointing at the repo root and `nodeModulesPaths` covering the
hoisted root `node_modules`. Metro does not follow workspace symlinks by
default, and the failure looks like unresolvable imports rather than anything
about the monorepo.

What §8 already decides for it:

- **Offline is a requirement** (§8.2). The most important screen in the
  product is used at a tiedown with one bar or none. `expo-sqlite` holds the
  write queue; the client generates UUIDv7 ids, every write carries an
  idempotency key, and records carry both a recorded-at and a received-at
  time.
- **The client never computes anything that matters.** Charges, maintenance
  countdowns and availability are computed server-side on sync.
- **No steering to the web for upgrades** from inside the app (§8.3). Hitting
  a quota returns 402 and the app explains the limit without linking out.
