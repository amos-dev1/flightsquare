import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
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
    },
  },
});
