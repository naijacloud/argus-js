import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { close, getClient } from '../src/core/api.js';
import { init } from '../src/node/index.js';
import { packageName } from '../src/node/package-name.js';
import { VERSION } from '../src/version.js';
import { FakeArgus } from './support/argus.js';

const VARS = ['ARGUS_SERVICE_NAME', 'OTEL_SERVICE_NAME', 'ARGUS_ENVIRONMENT', 'SENTRY_ENVIRONMENT', 'npm_package_name'];
const saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
let argus: FakeArgus | undefined;

afterEach(async () => {
  await close(500);
  await argus?.stop();
  argus = undefined;
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

async function resource(options: Parameters<typeof init>[0] = {}): Promise<Record<string, string>> {
  argus ??= await new FakeArgus().start();
  init({ dsn: argus.dsn, ...options });
  getClient()?.log('info', 'x');
  await getClient()?.flush(2000);
  const r = argus.on('/v1/logs').at(-1);
  const attrs = JSON.parse(r!.body).resourceLogs[0].resource.attributes as { key: string; value: { stringValue: string } }[];
  await close(500);
  argus.received = [];
  return Object.fromEntries(attrs.map((a) => [a.key, a.value.stringValue]));
}

describe('node defaults', () => {
  it('service.name: option, then ARGUS_SERVICE_NAME, then OTEL_SERVICE_NAME, then package.json', async () => {
    process.env.ARGUS_SERVICE_NAME = 'from-argus';
    process.env.OTEL_SERVICE_NAME = 'from-otel';
    expect((await resource({ serviceName: 'from-option' }))['service.name']).toBe('from-option');
    expect((await resource())['service.name']).toBe('from-argus');
    delete process.env.ARGUS_SERVICE_NAME;
    expect((await resource())['service.name']).toBe('from-otel');
    delete process.env.OTEL_SERVICE_NAME;
    // The test runs in this repo, so package.json says @naijacloud/argus.
    expect((await resource())['service.name']).toBe('@naijacloud/argus');
  });

  it('reads the name from package.json in the working directory, else npm, else nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'argus-pkg-'));
    delete process.env.npm_package_name;
    expect(packageName(dir)).toBeUndefined();
    process.env.npm_package_name = 'from-npm';
    expect(packageName(dir)).toBe('from-npm');
    writeFileSync(join(dir, 'package.json'), '{"name":"checkout-api"}');
    expect(packageName(dir)).toBe('checkout-api');
    writeFileSync(join(dir, 'package.json'), 'not json');
    expect(packageName(dir)).toBe('from-npm');
  });

  it('environment: option, then ARGUS_ENVIRONMENT, then SENTRY_ENVIRONMENT, then production', async () => {
    process.env.ARGUS_ENVIRONMENT = 'staging';
    process.env.SENTRY_ENVIRONMENT = 'qa';
    expect((await resource({ environment: 'dev' }))['deployment.environment']).toBe('dev');
    expect((await resource())['deployment.environment']).toBe('staging');
    delete process.env.ARGUS_ENVIRONMENT;
    expect((await resource())['deployment.environment']).toBe('qa');
    delete process.env.SENTRY_ENVIRONMENT;
    expect((await resource())['deployment.environment']).toBe('production');
  });

  it('sends User-Agent argus.javascript/<version> from Node', async () => {
    argus = await new FakeArgus().start();
    init({ dsn: argus.dsn });
    getClient()?.captureMessage('hi');
    getClient()?.log('info', 'x');
    await getClient()?.isOn('f', 'u1');
    await getClient()?.flush(2000);
    expect(argus.received.length).toBe(3);
    for (const r of argus.received) expect(r.headers['user-agent'], r.path).toBe(`argus.javascript/${VERSION}`);
  });
});
