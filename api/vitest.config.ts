import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Named so `vitest run --project api` can address it; without this the
    // filter matches nothing, since projects are filtered by name and not by
    // directory.
    name: 'api',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The suite talks to one real Postgres. Running files in parallel would
    // interleave provisioning against a shared database for no benefit.
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
    // The server under test logs every request; useful in dev, noise here.
    env: {
      FS_LOG_LEVEL: 'silent',
      // Turn §8.1's handshake on so it is actually covered.
      FS_MIN_CLIENT_VERSIONS: 'ios=1.4.0',
      // Generous, so the suite exercises the endpoints rather than the
      // limiter. One test overrides these downwards to check the 429 itself.
      FS_RATE_LIMIT_SIGNUP_MAX: '10000',
      FS_RATE_LIMIT_LOGIN_MAX: '10000',
      FS_RATE_LIMIT_REFRESH_MAX: '10000',
    },
  },
});
