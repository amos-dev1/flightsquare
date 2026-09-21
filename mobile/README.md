# mobile

Expo (React Native) for iOS/iPadOS, per CLAUDE.md §9. Expo SDK 57.

```sh
npx expo start        # from mobile/
npx expo export --platform ios   # bundles; the closest thing to a build check
```

Point it at the API with `EXPO_PUBLIC_API_URL`; it defaults to
`http://127.0.0.1:3000`.

## Offline is the point, not a feature

§8.2: the most important screen in the product is used standing at a tiedown
on a rural field with one bar or none. If post-flight entry requires
connectivity it does not get done, and §3.4's failure mode — stale meters and
wrong maintenance numbers — arrives by a different road.

So **saving a flight always succeeds.** It lands in SQLite first and syncs
afterwards. The row names itself before the server has heard of it: the id is
a client-generated UUIDv7, which is why §6 chose v7 in the first place.

The logic that can be got wrong lives in `packages/shared/src/offline.ts` and
is tested in Node — ordering, retry, and when to stop trying. This workspace
only supplies storage (`src/lib/queue.ts`, about seventy lines of SQLite) and
screens. That split is deliberate: a queue that silently drops a flight is
not something to find out about on a ramp.

What the tests pin down:

- A retry presents the **same idempotency key**. A dropped connection must not
  turn one flight into two, which would put every maintenance countdown
  downstream out by one.
- Flights send oldest-first by *when they were flown*, so a meter gap stays
  meaningful rather than becoming an artefact of which phone synced first.
- A transient failure stops the flush — if the network is down for one write
  it is down for the next, and hammering it burns a battery already out of
  signal.
- A permanent failure (a 400 that will never become a 201) is parked with its
  reason rather than blocking everything queued behind it. 408 and 429 are
  "not now", not "not ever".

## Versions are Expo's, not the monorepo's

Expo SDK 57 pins React 19.2.3, React Native 0.86.3 and TypeScript 6, while the
rest of the repo is on React 19.3 and TypeScript 7. npm nests the Expo
versions under `mobile/node_modules` and everything else keeps the newer ones.

**Use `npx expo install`, not `npm install`,** for anything in this workspace —
plain npm picks the newest version and Metro then fails somewhere unrelated
(`Cannot find module 'react-native/rn-get-polyfills'` is what an RN version
half a release ahead of `@expo/metro-config` looks like).

## Metro and the workspace

`metro.config.js` does two things beyond the default:

1. Watches the workspace root and points `nodeModulesPaths` at both
   `mobile/node_modules` and the hoisted root, with hierarchical lookup
   disabled so two copies of React cannot both resolve.
2. Maps `./thing.js` to `./thing.ts` for relative imports **inside
   `packages/`**. That suffix is the NodeNext convention the `api` workspace
   requires, and Turbopack follows it happily; Metro is the only resolver here
   that cannot. The mapping is scoped to our own source, never
   `node_modules`, and only applies when the extensionless form really
   resolves — a genuinely missing module still fails loudly.

## Design

§11 applies here as it does on web. `src/theme.ts` carries the same tokens in
the form React Native can use: black primaries, teal only as emphasis, real
Manrope through `@expo-google-fonts/manrope`, 48px controls, and Hobbs and
tach always named rather than implied by column position.
