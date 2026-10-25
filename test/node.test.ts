/**
 * The built package in a real Node process, started the documented way:
 * `node --import @naijacloud/argus/register app.mjs`. Needs `npm run build`.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakeArgus } from './support/argus.js';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const built = existsSync(join(dist, 'register.js'));

let argus: FakeArgus;
beforeEach(async () => {
  argus = await new FakeArgus().start();
});
afterEach(async () => {
  await argus.stop();
});

function run(script: string, env: Record<string, string> = {}): Promise<{ code: number | null; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'argus-js-'));
  const file = join(dir, 'app.mjs');
  writeFileSync(file, script.replaceAll('__DIST__', dist));
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--import', join(dist, 'register.js'), file], {
      env: { PATH: process.env.PATH ?? '', ARGUS_DSN: argus.dsn, ARGUS_RELEASE: '1.4.2', ARGUS_ENVIRONMENT: 'staging', ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    p.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    p.on('exit', (code) => resolve({ code, stderr }));
  });
}

describe.skipIf(!built)('node --import @naijacloud/argus/register', () => {
  it('traces incoming requests, propagates to fetch, and shares one client with the app', async () => {
    const { code, stderr } = await run(`
      import http from 'node:http';
      import { captureMessage, flush, metrics } from '__DIST__index.js';
      let seen = '';
      const downstream = http.createServer((req, res) => { seen = req.headers.traceparent ?? ''; res.end('ok'); });
      await new Promise((r) => downstream.listen(0, '127.0.0.1', r));
      const app = http.createServer(async (req, res) => {
        await fetch('http://127.0.0.1:' + downstream.address().port + '/rates?secret=1');
        captureMessage('inside the request');
        res.statusCode = 201;
        res.end();
      });
      await new Promise((r) => app.listen(0, '127.0.0.1', r));
      await fetch('http://127.0.0.1:' + app.address().port + '/pay?card=4111', {
        headers: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
      });
      metrics.count('orders');
      await flush(3000);
      if (!seen.startsWith('00-4bf92f3577b34da6a3ce929d0e0e4736-')) { console.error('no traceparent downstream: ' + seen); process.exit(3); }
      process.exit(0);
    `);
    expect(stderr).toBe('');
    expect(code).toBe(0);

    const spans = argus.on('/v1/traces').flatMap((r) => JSON.parse(r.body).resourceSpans[0].scopeSpans[0].spans);
    const server = spans.find((s: any) => s.name === 'POST /pay' || s.name === 'GET /pay');
    expect(server).toBeDefined();
    expect(server.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(server.parentSpanId).toBe('00f067aa0ba902b7');
    expect(server.attributes).toContainEqual({ key: 'http.response.status_code', value: { intValue: '201' } });
    const client = spans.find((s: any) => s.kind === 3);
    expect(client.parentSpanId).toBe(server.spanId);
    expect(client.name).not.toContain('secret');

    const [ev] = argus.events();
    expect(ev).toMatchObject({ message: 'inside the request', release: '1.4.2', environment: 'staging', contexts: { trace: { trace_id: '4bf92f3577b34da6a3ce929d0e0e4736' } } });
    expect(ev?.breadcrumbs.values.some((b: any) => b.category === 'fetch' && !String(b.data.url).includes('?'))).toBe(true);
    expect(argus.on('/v1/metrics')).toHaveLength(1);
  });

  it('reports an uncaught exception, then exits 1 like Node does', async () => {
    const { code, stderr } = await run(`setTimeout(() => { throw new Error('boom at startup'); }, 10);`);
    expect(code).toBe(1);
    expect(stderr).toContain('boom at startup');
    const [ev] = argus.events();
    expect(ev).toMatchObject({ level: 'fatal', tags: { mechanism: 'uncaughtException' } });
    expect(ev?.exception.values.at(-1).value).toBe('boom at startup');
  });

  it('reports an unhandled rejection', async () => {
    const { code } = await run(`Promise.reject(new Error('nobody caught me'));`);
    expect(code).toBe(1);
    expect(argus.events()[0]?.exception.values.at(-1).value).toBe('nobody caught me');
  });

  it('does nothing without a DSN', async () => {
    const { code, stderr } = await run(`import { captureMessage } from '__DIST__index.js'; captureMessage('x');`, { ARGUS_DSN: '' });
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(argus.received).toHaveLength(0);
  });

  it('falls back to SENTRY_DSN', async () => {
    const { code } = await run(`import { captureMessage, flush } from '__DIST__index.js'; captureMessage('via sentry dsn'); await flush(2000);`, {
      ARGUS_DSN: '',
      SENTRY_DSN: argus.dsn,
    });
    expect(code).toBe(0);
    expect(argus.events()[0]?.message).toBe('via sentry dsn');
  });
});
