import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Client, type Platform, Span } from '../src/core/client.js';
import { FakeArgus } from './support/argus.js';

let argus: FakeArgus;
let clients: Client[] = [];

function platform(over: Partial<Platform> = {}): Platform {
  let active: Span | undefined;
  return {
    sdkName: 'argus.javascript',
    platform: 'node',
    keyInUrl: false,
    contexts: () => ({ runtime: { name: 'node', version: 'v22' } }),
    serverName: 'web-1',
    activeSpan: () => active,
    withSpan: (s, fn) => {
      const prev = active;
      active = s;
      try {
        return fn();
      } finally {
        active = prev;
      }
    },
    fetch: globalThis.fetch.bind(globalThis),
    ...over,
  };
}

function client(opts = {}, over: Partial<Platform> = {}): Client {
  const c = new Client({ dsn: argus.dsn, release: '1.4.2', serviceName: 'checkout-api', ...opts }, platform(over));
  clients.push(c);
  return c;
}

beforeEach(async () => {
  argus = await new FakeArgus().start();
});
afterEach(async () => {
  for (const c of clients) await c.close(500);
  clients = [];
  await argus.stop();
});

describe('errors', () => {
  it('sends an envelope Argus can read', async () => {
    const c = client();
    c.setUser({ id: 'buyer-7', ip_address: '1.2.3.4' });
    c.setTag('region', 'af-west');
    c.addBreadcrumb({ category: 'console', message: 'loading cart' });
    const id = c.captureException(new Error('Card declined'), { extra: { password: 'hunter2', cart: 3 } });
    await c.flush(2000);

    const [r] = argus.on('/api/42/envelope/');
    expect(r?.headers['x-sentry-auth']).toContain('sentry_key=0000public0000key');
    expect(r?.headers['content-type']).toBe('application/x-sentry-envelope');
    const lines = r!.body.trim().split('\n');
    expect(JSON.parse(lines[0] as string)).toMatchObject({ event_id: id, sdk: { name: 'argus.javascript' } });
    expect(JSON.parse(lines[1] as string)).toEqual({ type: 'event', content_type: 'application/json' });
    const ev = JSON.parse(lines[2] as string);
    expect(ev).toMatchObject({
      event_id: id,
      level: 'error',
      platform: 'node',
      release: '1.4.2',
      environment: 'production',
      server_name: 'web-1',
      tags: { region: 'af-west' },
      user: { id: 'buyer-7' },
      extra: { password: '[Filtered]', cart: 3 },
    });
    expect(ev.user.ip_address).toBeUndefined();
    expect(ev.exception.values.at(-1)).toMatchObject({ type: 'Error', value: 'Card declined' });
    expect(ev.exception.values.at(-1).stacktrace.frames.length).toBeGreaterThan(0);
    expect(ev.breadcrumbs.values[0]).toMatchObject({ category: 'console', message: 'loading cart' });
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('sends the same error object once', async () => {
    const c = client();
    const e = new Error('once');
    c.captureException(e);
    expect(c.captureException(e)).toBe('');
    await c.flush();
    expect(argus.events()).toHaveLength(1);
  });

  it('honours beforeSend and sampleRate 0', async () => {
    const c = client({ beforeSend: (ev: { tags?: Record<string, string> }) => (ev.tags?.drop ? null : ev) });
    c.captureMessage('kept');
    c.captureMessage('dropped', 'info', { tags: { drop: '1' } });
    const z = client({ sampleRate: 0 });
    z.captureMessage('never');
    await c.flush();
    await z.flush();
    expect(argus.events().map((e) => e.message)).toEqual(['kept']);
  });

  it('does nothing without a DSN, and never throws', async () => {
    const c = new Client({}, platform());
    clients.push(c);
    expect(c.enabled).toBe(false);
    expect(c.captureException(new Error('x'))).toBe('');
    c.log('info', 'x');
    c.count('x');
    c.checkIn('job', 'ok');
    expect(await c.isOn('f', 'u', true)).toBe(true);
    await c.flush();
    expect(argus.received).toHaveLength(0);
  });

  it('puts the key in the URL for browsers', async () => {
    const c = client({}, { keyInUrl: true, platform: 'javascript' });
    c.captureMessage('hi');
    await c.flush();
    const [r] = argus.on('/api/42/envelope/');
    expect(r?.query.get('sentry_key')).toBe('0000public0000key');
    expect(r?.headers['x-sentry-auth']).toBeUndefined();
    expect(r?.headers['content-type']).toContain('text/plain');
  });
});

describe('logs, metrics, traces', () => {
  it('sends logs as OTLP JSON, scrubbed, with the trace they ran in', async () => {
    const c = client();
    c.trace('checkout', () => c.log('warn', 'retrying with token=abcdefgh123', { order: 9, secret: 's' }));
    await c.flush();
    const [r] = argus.on('/v1/logs');
    expect(r?.headers.authorization).toBe('Bearer 0000public0000key');
    const body = JSON.parse(r!.body);
    const res = body.resourceLogs[0].resource.attributes;
    expect(res).toContainEqual({ key: 'service.name', value: { stringValue: 'checkout-api' } });
    expect(res).toContainEqual({ key: 'service.version', value: { stringValue: '1.4.2' } });
    const rec = body.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(rec.severityText).toBe('WARN');
    expect(rec.body.stringValue).toBe('retrying with token=[Filtered]');
    expect(rec.attributes).toContainEqual({ key: 'secret', value: { stringValue: '[Filtered]' } });
    expect(rec.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('aggregates metrics into counters, gauges and histograms', async () => {
    const c = client();
    c.count('orders', 1, { method: 'card' });
    c.count('orders', 2, { method: 'card' });
    c.gauge('queue.depth', 4);
    c.gauge('queue.depth', 7);
    for (const v of [3, 40, 2000]) c.distribution('checkout.ms', v, undefined, 'ms');
    await c.flush();
    const body = JSON.parse(argus.on('/v1/metrics')[0]!.body);
    const ms = body.resourceMetrics[0].scopeMetrics[0].metrics;
    const orders = ms.find((m: any) => m.name === 'orders');
    expect(orders.sum.dataPoints[0].asDouble).toBe(3);
    expect(orders.sum.aggregationTemporality).toBe(1);
    expect(ms.find((m: any) => m.name === 'queue.depth').gauge.dataPoints[0].asDouble).toBe(7);
    const h = ms.find((m: any) => m.name === 'checkout.ms').histogram.dataPoints[0];
    expect(h.count).toBe('3');
    expect(h.sum).toBe(2043);
  });

  it('sends spans with parents and errors', async () => {
    const c = client();
    await c.trace('POST /pay', async () => {
      await c.trace('db.query', async () => undefined, { 'db.system': 'postgresql' });
      try {
        c.trace('paystack', () => {
          throw new Error('timeout');
        });
      } catch {
        /* expected */
      }
    });
    await c.flush();
    const spans = JSON.parse(argus.on('/v1/traces')[0]!.body).resourceSpans[0].scopeSpans[0].spans;
    const root = spans.find((s: any) => s.name === 'POST /pay');
    const db = spans.find((s: any) => s.name === 'db.query');
    const ps = spans.find((s: any) => s.name === 'paystack');
    expect(db.parentSpanId).toBe(root.spanId);
    expect(db.traceId).toBe(root.traceId);
    expect(ps.status).toEqual({ code: 2, message: 'timeout' });
    expect(root.parentSpanId).toBeUndefined();
  });

  it('sends no spans when tracesSampleRate is 0', async () => {
    const c = client({ tracesSampleRate: 0 });
    c.trace('x', () => 1);
    await c.flush();
    expect(argus.on('/v1/traces')).toHaveLength(0);
  });
});

describe('crons and flags', () => {
  it('checks crons in by slug', async () => {
    const c = client();
    await c.withMonitor('nightly-invoices', async () => 'done');
    await expect(
      c.withMonitor('nightly-invoices', async () => {
        throw new Error('smtp down');
      }),
    ).rejects.toThrow('smtp down');
    c.checkIn('nightly-invoices', 2);
    await c.flush();
    expect(argus.on('/v1/cron/').map((r) => r.path)).toEqual([
      '/v1/cron/nightly-invoices/start',
      '/v1/cron/nightly-invoices',
      '/v1/cron/nightly-invoices/start',
      '/v1/cron/nightly-invoices/fail',
      '/v1/cron/nightly-invoices/2',
    ]);
    expect(argus.on('/v1/cron/nightly-invoices/fail')[0]?.body).toBe('smtp down');
  });

  it('evaluates flags, caches them, and falls back', async () => {
    argus.flags = { 'new-checkout': 'on', theme: 'dark' };
    const c = client();
    expect(await c.isOn('new-checkout', 'user-1')).toBe(true);
    expect(await c.variant('theme', 'user-1', 'light')).toBe('dark');
    expect(await c.isOn('unknown', 'user-1', true)).toBe(true);
    expect(argus.on('/v1/flags/evaluate')).toHaveLength(1);
    expect(JSON.parse(argus.on('/v1/flags/evaluate')[0]!.body)).toMatchObject({ subject: 'user-1', environment: 'production' });

    argus.status['/v1/flags/evaluate'] = 500;
    expect(await c.isOn('new-checkout', 'user-2', false)).toBe(false);
  });
});
