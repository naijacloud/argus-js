#!/usr/bin/env node
/**
 * Contract test against a real Argus (staging or prod), not a stand-in.
 *
 *   ARGUS_CONTRACT_DSN=<dsn of a test source> \
 *   ARGUS_CONTRACT_API=https://argus-api.naijacloud-staging.com \
 *   ARGUS_CONTRACT_TOKEN=<a token that can read that workspace> \
 *   npm run test:contract
 *
 * Sends an error, a log, a span, a metric, a cron check-in and a flag
 * evaluation with the built package, checks Argus answered 2xx to each, and,
 * when ARGUS_CONTRACT_API and _TOKEN are set, waits for the error to show up
 * as an issue. Needs `npm run build`. The cron check-in expects a monitor with
 * slug `argus-js-contract` (404 is reported, not failed, when it's missing).
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const dsn = process.env.ARGUS_CONTRACT_DSN;
if (!dsn) {
  console.error('set ARGUS_CONTRACT_DSN to a test source DSN');
  process.exit(2);
}
const { init, close, captureException, log, metrics, trace, cron, flags } = await import(new URL('../../dist/index.js', import.meta.url));

const statuses = [];
init({
  dsn,
  release: 'argus-js@contract',
  environment: 'contract',
  serviceName: 'argus-js-contract',
  fetch: async (url, opts) => {
    const res = await fetch(url, opts);
    statuses.push({ path: new URL(url).pathname, status: res.status });
    return res;
  },
});

const marker = `argus-js contract ${randomBytes(4).toString('hex')}`;
await trace('contract.run', async () => {
  try {
    JSON.parse('{not json');
  } catch (err) {
    captureException(new Error(marker, { cause: err }), { extra: { password: 'hunter2' } });
  }
  log.info('contract log line', { marker });
});
metrics.count('argus_js_contract_runs', 1);
cron.checkIn('argus-js-contract', 'ok');
const flagValue = await flags.isOn('argus-js-contract-flag', 'contract-user', false);
assert.equal(await close(10_000), true, 'flush timed out');

const by = (p) => statuses.filter((s) => s.path.startsWith(p)).map((s) => s.status);
const ok = (p) => {
  const got = by(p);
  assert.ok(got.length > 0 && got.every((s) => s >= 200 && s < 300), `${p}: ${JSON.stringify(got)}`);
  console.log(`✓ ${p} ${got.join(',')}`);
};
ok('/api/');
ok('/v1/logs');
ok('/v1/traces');
ok('/v1/metrics');
const cronStatus = by('/v1/cron/');
console.log(cronStatus.every((s) => s === 200) ? `✓ /v1/cron/ ${cronStatus}` : `• /v1/cron/ ${cronStatus} (create a cron monitor with slug argus-js-contract to check this)`);
console.log(`✓ flags evaluated (argus-js-contract-flag = ${flagValue})`);

const api = process.env.ARGUS_CONTRACT_API;
const token = process.env.ARGUS_CONTRACT_TOKEN;
if (api && token) {
  let found;
  for (let i = 0; i < 30 && !found; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(`${api}/v1/issues?q=${encodeURIComponent(marker)}&limit=5`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) found = ((await res.json()).issues ?? []).find((i) => String(i.title ?? '').includes(marker));
  }
  assert.ok(found, `the error "${marker}" never showed up as an issue`);
  console.log(`✓ issue ${found.id} grouped from the Argus SDK`);
}
console.log('contract passed');
