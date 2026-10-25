import { defineConfig } from 'tsup';

// No source maps on purpose: esbuild embeds the original sources in the map,
// which would publish src/ to npm through the back door.
const shared = { dts: true, splitting: false, treeshake: true, sourcemap: false } as const;

export default defineConfig([
  {
    ...shared,
    clean: true,
    entry: { index: 'src/node/index.ts', register: 'src/node/register.ts', next: 'src/next/server.ts' },
    format: ['esm', 'cjs'],
    platform: 'node',
    target: 'node18',
  },
  {
    ...shared,
    entry: { browser: 'src/browser/index.ts', 'next.client': 'src/next/client.ts' },
    format: ['esm', 'cjs'],
    platform: 'browser',
    target: 'es2020',
  },
  {
    ...shared,
    dts: false,
    entry: { bin: 'src/bin.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node18',
  },
]);
