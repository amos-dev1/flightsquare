import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Named so `vitest run --project shared` addresses it; projects are
    // filtered by name, not by directory.
    name: 'shared',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
