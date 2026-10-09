# syntax=docker/dockerfile:1.7
#
# The web app (CLAUDE.md §9), as a container for App Runner.
#
# Amplify Hosting would have been the shorter road and cannot take this app:
# its compute SSR provider supports Next.js 12 through 15, and web/ is on 16.
# A container sidesteps the question entirely, because the runtime is ours.
#
# BUILD (from the repo root, not from web/):
#   docker buildx build -f web/Dockerfile --platform linux/amd64,linux/arm64 .
#
# Both architectures for the same reason as api/Dockerfile: App Runner exposes
# no architecture setting, and nothing in here compiles.

# ---------------------------------------------------------------------------
# deps — the workspace install, cached on the manifests alone
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /repo

# Only the files that decide the dependency tree. `packages/shared` has to be
# present for npm to resolve the workspace link, even though web imports
# nothing from it at runtime.
COPY package.json package-lock.json ./
COPY web/package.json web/
COPY packages/shared/package.json packages/shared/

RUN npm ci --ignore-scripts

# ---------------------------------------------------------------------------
# build — Next's standalone output
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /repo

COPY tsconfig*.json ./
# shared's source, not a build of it: the package has no build step and exports
# `./src/index.ts` directly, so Next compiles it through `transpilePackages`.
# Every import of it in web/ is `import type`, so it erases entirely and never
# reaches the runtime stage.
COPY packages/shared packages/shared
COPY web web

# Fails the build rather than shipping a server that cannot reach the API.
# `FS_API_URL` is read at request time, not baked in, so it is NOT needed here
# — it is set on the service. This is only a guard against the config drifting
# into something that needs it at build time.
RUN npm run build -w web

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /repo

ENV NODE_ENV=production

# No `npm ci` here, unlike api/Dockerfile. Next's standalone output already
# contains the traced subset of node_modules it actually needs, so installing
# again would add the rest of the tree for nothing.
#
# The output keeps the workspace's shape: `standalone/` holds `node_modules`
# and `web/`, so the server is at `web/server.js` relative to this WORKDIR.
COPY --from=build /repo/web/.next/standalone ./

# Neither of these is included in the standalone trace, and both are served by
# the Node server rather than by a CDN in this setup. Without them the pages
# render unstyled and the logo 404s.
COPY --from=build /repo/web/.next/static ./web/.next/static
COPY --from=build /repo/web/public ./web/public

# Not root; the node image ships this user for exactly this.
USER node

ENV PORT=3000
EXPOSE 3000

# Bind every interface, and set it on the command rather than with ENV.
#
# Next's standalone server binds `process.env.HOSTNAME`, and HOSTNAME is a
# variable every container runtime sets to the container's own hostname — so
# `ENV HOSTNAME=0.0.0.0` is overridden before node ever reads it. App Runner
# did exactly that: the server came up on `ip-10-0-177-243.ec2.internal:3000`,
# reported "Ready", and failed its health check for eighteen minutes, because
# the platform probes an address that name does not answer on.
#
# Assigning it in the command is after the override and wins. `exec` so node is
# PID 1 and receives SIGTERM directly, which is what lets App Runner stop an
# instance without waiting out a kill timeout.
CMD ["sh", "-c", "HOSTNAME=0.0.0.0 exec node web/server.js"]
