#!/usr/bin/env node
/**
 * The version is written in three places that have to agree: `version` in
 * package.json, the `VERSION` literal in src/version.ts, and the tag that
 * triggered the release.
 *
 * A mismatch is not a build failure — it publishes a tarball that reports the
 * wrong version in every event's sdk.version to Argus, and npm refuses to unpublish
 * after 72 hours. So this runs on every CI job and again inside
 * `prepublishOnly`, not only at release time.
 */
import { appendFileSync, readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

// Deliberately narrower than semver: these are the tags this repo will ever
// cut, so anything else reaching here is a typo, not a release.
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

const pkg = JSON.parse(read('package.json'));
const version = pkg.version;
const parsed = SEMVER.exec(version ?? '');

if (!parsed) {
  console.error(
    `package.json version is not a version this repo can tag: ${JSON.stringify(version)}`,
  );
  process.exit(1);
}

const prerelease = parsed[4] ?? null;
const problems = [];

const source = read('src/version.ts');
const literal = /export const VERSION = '([^']*)';/.exec(source);

if (!literal) {
  problems.push("src/version.ts has no `export const VERSION = '…';` line to check.");
} else if (literal[1] !== version) {
  problems.push(
    `src/version.ts says ${literal[1]}, package.json says ${version}. ` +
      `The published sdk.version would claim ${literal[1]}.`,
  );
}

// `--tag v1.2.3` or `--tag=v1.2.3`. Absent outside the release workflow.
const argv = process.argv.slice(2);
const flag = argv.findIndex((arg) => arg === '--tag' || arg.startsWith('--tag='));
const tag = flag === -1 ? null : argv[flag].includes('=') ? argv[flag].slice(6) : argv[flag + 1];

if (flag !== -1 && tag !== `v${version}`) {
  problems.push(
    `tag ${tag ?? '(missing)'} does not match package.json ${version} — expected v${version}. ` +
      'Delete the tag, fix the version, and tag again.',
  );
}

// A prerelease gets no changelog section of its own; a stable release does, and
// the entries must have been moved out of Unreleased in the same commit that
// bumped the version, or the release notes come out empty.
if (!prerelease) {
  const heading = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm');
  if (!heading.test(read('CHANGELOG.md'))) {
    problems.push(
      `CHANGELOG.md has no "## [${version}]" heading. ` +
        'Move the Unreleased entries under it before tagging.',
    );
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`✗ ${problem}`);
  process.exit(1);
}

// The release workflow reads these back rather than parsing the version again
// in shell, so the prerelease rule lives in exactly one place.
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    [
      `version=${version}`,
      `tag=v${version}`,
      // `npm install` with no version resolves to the `latest` dist-tag, so a
      // prerelease published there would upgrade every caller on install.
      `npm_tag=${prerelease ? 'next' : 'latest'}`,
      `prerelease=${prerelease ? 'true' : 'false'}`,
    ].join('\n') + '\n',
  );
}

console.log(`✓ ${pkg.name} ${version}${prerelease ? ' (prerelease)' : ''}`);
