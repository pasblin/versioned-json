import { defineConfig } from 'tsup';

export default defineConfig([
  // Library bundles: ESM + CJS, full d.ts, never inlines the optional Zod
  // peer dependency.
  {
    entry: {
      index: 'src/index.ts',
      'adapters/zod/index': 'src/adapters/zod/index.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    treeshake: true,
    minify: false,
    target: 'es2022',
    outDir: 'dist',
    external: ['zod'],
  },
  // CLI: ESM only. The shebang in src/cli/index.ts is preserved verbatim by
  // tsup so the published bin is directly executable.
  {
    entry: { 'cli/index': 'src/cli/index.ts' },
    format: ['esm'],
    sourcemap: true,
    clean: false,
    treeshake: true,
    minify: false,
    target: 'es2022',
    outDir: 'dist',
    external: ['zod'],
  },
]);
