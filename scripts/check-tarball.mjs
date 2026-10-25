#!/usr/bin/env node
/**
 * Inspects the tarball `npm publish` would upload, before it uploads it.
 *
 * Two failures this catches, both of which are silent until a consumer hits
 * them: a build that stopped emitting one of the four entrypoints `exports`
 * points at, which installs fine and then throws on import; and `src/` or a
 * source map slipping into the package, which publishes the whole source tree
 * to npm through the back door — see the sourcemap note in tsup.config.ts.
 *
 * Run after `npm run build`. Needs the network only for nothing at all.
 */
import { execFileSync } from 'node:child_process';

// `exports` and `bin` in package.json name these, and nothing resolves without
// them. A dts build that half-failed still exits 0, so check the files.
const REQUIRED = [
  'dist/index.js', 'dist/index.cjs', 'dist/index.d.ts', 'dist/index.d.cts',
  'dist/register.js', 'dist/register.cjs',
  'dist/browser.js', 'dist/browser.cjs', 'dist/browser.d.ts', 'dist/browser.d.cts',
  'dist/next.js', 'dist/next.cjs', 'dist/next.d.ts', 'dist/next.d.cts',
  'dist/next.client.js', 'dist/next.client.cjs', 'dist/next.client.d.ts',
  'dist/bin.js',
];

// Everything in `files`, plus the manifest npm always adds.
const ALLOWED_ROOT = new Set([
  'package.json',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'SECURITY.md',
]);

const root = new URL('../', import.meta.url);
const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
  cwd: root,
  encoding: 'utf8',
  // npm writes the tarball listing to stderr as a notice; only stdout is JSON.
  stdio: ['ignore', 'pipe', 'ignore'],
});

const [packed] = JSON.parse(output);
const files = packed.files.map((file) => file.path);
const problems = [];

for (const required of REQUIRED) {
  if (!files.includes(required)) problems.push(`missing ${required} — \`exports\` points at a file the tarball does not have.`);
}

for (const file of files) {
  if (file.startsWith('dist/')) {
    if (file.endsWith('.map')) problems.push(`${file} — a source map embeds the original sources and publishes src/.`);
    continue;
  }
  if (!ALLOWED_ROOT.has(file)) problems.push(`${file} is not one of the files this package ships.`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`✗ ${problem}`);
  process.exit(1);
}

const kb = (packed.size / 1024).toFixed(1);
console.log(`✓ ${packed.name} ${packed.version}: ${files.length} files, ${kb} kB packed`);
