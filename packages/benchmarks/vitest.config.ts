import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    benchmark: {
      include: ['src/**/*.bench.ts'],
      // Default reporter is enough; CI is not expected to consume these.
      reporters: ['default'],
    },
  },
});
