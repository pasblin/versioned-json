import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.{test,spec}.ts',
        'src/__tests__/**',
        // Pure re-export barrel and type-only declarations have no runtime
        // statements to cover.
        'src/index.ts',
        'src/core/types.ts',
        // CLI entry: thin wiring layer between Node IO and runUpgrade();
        // covered end-to-end by a smoke test on the built binary instead.
        'src/cli/index.ts',
      ],
    },
  },
});
