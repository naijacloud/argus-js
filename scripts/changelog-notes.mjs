#!/usr/bin/env node
/**
 * Prints the CHANGELOG.md section for one version, for the body of the GitHub
 * Release. The changelog is hand-written and stays the single source of truth —
 * generating notes from commit subjects instead would publish a second, worse
 * account of the same release.
 */
import { readFileSync } from 'node:fs';

const version = process.argv[2];

if (!version) {
  console.error('usage: node scripts/changelog-notes.mjs <version>');
  process.exit(1);
}

const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const heading = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\].*$`, 'm');
const start = heading.exec(changelog);

if (!start) {
  // A prerelease has no section of its own, by design — check-version.mjs only
  // requires one for stable versions. Point at the changelog rather than fail
  // the release over the notes.
  console.log(`See [CHANGELOG.md](https://github.com/naijacloud/argus-js/blob/v${version}/CHANGELOG.md).`);
  process.exit(0);
}

const body = changelog.slice(start.index + start[0].length);
const next = /^## /m.exec(body);
const section = next ? body.slice(0, next.index) : body;

// The oldest version's section runs into the link-reference definitions at the
// foot of the file. They resolve nothing once the section is lifted out, so
// they would render as literal `[0.1.0]: https://…` lines in the release body.
console.log(
  section
    .split('\n')
    .filter((line) => !/^\[[^\]]+\]:\s+\S+$/.test(line))
    .join('\n')
    .trim(),
);
