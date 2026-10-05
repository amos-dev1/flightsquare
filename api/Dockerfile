# syntax=docker/dockerfile:1.7
#
# The API, and the migration runner — one image, two commands.
#
# The stack runs `npm run migrate` from this same image as a one-off Fargate
# task and then serves `node dist/index.js` from App Runner. That is why
# `db/migrations` is in the final layer even though the API never reads it, and
# why `postgresql-client` is installed: the migration runner is a bash script
# driving psql, and the forward-only checksum logic in `scripts/migrate.sh` is
# the only implementation of it there is.
#
# BUILD (from the repo root, not from api/):
#   docker buildx build -f api/Dockerfile --platform linux/amd64,linux/arm64 .
#
# Both architectures, deliberately. The migration task is pinned to ARM64 in
# the stack, and App Runner exposes no architecture setting anywhere in its API
# or its documentation — which in practice means x86_64. A manifest carrying
# both lets one tag serve both runtimes, and it costs almost nothing here
# because nothing in this image compiles: `pg`, `kysely` and `fastify` are pure
# JavaScript, and passwords use `node:crypto` scrypt precisely so there is no
# native binding to build per-architecture.

# ---------------------------------------------------------------------------
# deps — the workspace install, cached on the manifests alone
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /repo

# Only the files that decide the dependency tree, so editing source does not
# re-run the install. The workspace members have to be present for npm to
# resolve `@flightsquare/shared`, which is a workspace link rather than a
# registry package.
COPY package.json package-lock.json ./
COPY api/package.json api/
COPY packages/shared/package.json packages/shared/

# `--ignore-scripts`: nothing here has a legitimate install script, and the one
# that appears later is the one worth noticing.
RUN npm ci --ignore-scripts

# ---------------------------------------------------------------------------
# build — compile the API and the shared package it imports
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /repo

COPY tsconfig*.json ./
COPY packages/shared packages/shared
COPY api api

# Just the API.
#
# `@flightsquare/shared` is never built and does not need to be: every import
# of it in api/src is `import type`, so tsc erases all of them and the
# specifier appears nowhere in the output. The package exports raw TypeScript
# (`"import": "./src/index.ts"`), which Node could not load — and never has to.
# Its source is copied above only because tsc needs the types to compile
# against.
RUN npm run build -w @flightsquare/api

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /repo

# bash and psql for the migration runner; both absent from the base image.
# postgresql17-client matches the RDS major version in the stack.
RUN apk add --no-cache bash postgresql17-client

ENV NODE_ENV=production

# Production dependencies only — the build's devDependencies stay behind.
COPY package.json package-lock.json ./
COPY api/package.json api/
# shared's manifest, not its source: `npm ci` has to resolve the workspace
# link even though nothing at runtime imports through it.
COPY packages/shared/package.json packages/shared/
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Only the API's output. No shared dist, because there is none to copy —
# see the build stage.
COPY --from=build /repo/api/dist api/dist

# The migration runner, and what it runs. `db/migrations` is the reason this
# image is also the migration image: the same artifact that serves traffic
# carries the schema it expects, so the two cannot drift.
COPY db/migrations db/migrations
COPY db/roles.sql db/
COPY scripts/lib.sh scripts/migrate.sh scripts/roles.sh scripts/

# Not root. App Runner and Fargate both run whatever the image says, and the
# node image ships a `node` user for exactly this.
USER node

EXPOSE 3000

# The API. The migration task overrides this with `npm run migrate`.
CMD ["node", "api/dist/index.js"]
