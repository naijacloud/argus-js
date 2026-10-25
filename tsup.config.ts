import { defineConfig } from 'tsup';

// The three builds run in parallel, so none of them cleans dist/: one
// cleaning could delete another's output. `npm run build` empties it first.
//
// No source maps on purpose: esbuild embeds the original sources in the map,
// which would publish src/ to npm through the back door.
const shared = { dts: true, splitting: false, treeshake: true, sourcemap: false } as const;

export default defineConfig([
  {
    ...shared,
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
