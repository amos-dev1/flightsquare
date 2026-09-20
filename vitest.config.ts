import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['api', 'packages/*'],
    // Every project talks to the one local Postgres. Running them in parallel
    // would interleave provisioning against a shared database for no gain.
    fileParallelism: false,
  },
});
