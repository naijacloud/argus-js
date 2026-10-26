import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Client, MAX_OTLP_BODY, type Platform, Span } from '../src/core/client.js';
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

describe('OTLP batch splitting', () => {
  const bytes = (s: string) => new TextEncoder().encode(s).length;

  it('splits logs so each request body is at most 512 KB', async () => {
    const c = client();
    // 150 logs of ~6 KB: 3,000 characters but 6,000 bytes, so bytes are what count.
    for (let i = 0; i < 150; i++) c.log('info', `line ${i} ${'é'.repeat(3000)}`);
    await c.flush(5000);
    const reqs = argus.on('/v1/logs');
    expect(reqs.length).toBeGreaterThan(1);
    for (const r of reqs) expect(bytes(r.body)).toBeLessThanOrEqual(MAX_OTLP_BODY);
    const records = reqs.flatMap((r) => JSON.parse(r.body).resourceLogs[0].scopeLogs[0].logRecords);
    expect(records).toHaveLength(150);
    expect(records.map((l: any) => l.body.stringValue.split(' ')[1])).toEqual([...Array(150).keys()].map(String));
  });

  it('splits traces and metrics too, and leaves small batches whole', async () => {
    const c = client();
    for (let i = 0; i < 200; i++) c.trace(`op ${i}`, () => undefined, { note: 'x'.repeat(4000) });
    for (let i = 0; i < 200; i++) c.count('jobs', 1, { job: `${i}-${'y'.repeat(4000)}` });
    c.log('info', 'one small line');
    await c.flush(5000);
    for (const path of ['/v1/traces', '/v1/metrics']) {
      const reqs = argus.on(path);
      expect(reqs.length, path).toBeGreaterThan(1);
      for (const r of reqs) expect(bytes(r.body), path).toBeLessThanOrEqual(MAX_OTLP_BODY);
    }
    const spans = argus.on('/v1/traces').flatMap((r) => JSON.parse(r.body).resourceSpans[0].scopeSpans[0].spans);
    expect(spans).toHaveLength(200);
    const metrics = argus.on('/v1/metrics').flatMap((r) => JSON.parse(r.body).resourceMetrics[0].scopeMetrics[0].metrics);
    expect(metrics).toHaveLength(200);
    expect(argus.on('/v1/logs')).toHaveLength(1);
  });
});

describe('User-Agent', () => {
  it('sends the platform user agent on every endpoint', async () => {
    const c = client({}, { userAgent: 'argus.javascript/9.9.9' });
    c.captureMessage('hello');
    c.log('info', 'x');
    c.count('n');
    c.trace('t', () => undefined);
    c.checkIn('job', 'ok');
    await c.isOn('f', 'user-1');
    await c.flush();
    const paths = new Set(argus.received.map((r) => r.path.split('/').slice(0, 3).join('/')));
    expect(paths.size).toBeGreaterThanOrEqual(6);
    for (const r of argus.received) expect(r.headers['user-agent'], r.path).toBe('argus.javascript/9.9.9');
  });

  it('sets none when the platform has none (browsers)', async () => {
    const c = client({}, { keyInUrl: true });
    c.captureMessage('hello');
    await c.flush();
    expect(argus.on('/api/42/envelope/')[0]?.headers['user-agent']).not.toMatch(/^argus/);
  });
});

describe('flags transport', () => {
  it('caches for 30 s per subject', async () => {
    argus.flags = { a: 'on' };
    const c = client();
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      expect(await c.isOn('a', 'u1')).toBe(true);
      now += 29_000;
      expect(await c.isOn('a', 'u1')).toBe(true);
      expect(argus.on('/v1/flags/evaluate')).toHaveLength(1);
      now += 2_000;
      await c.isOn('a', 'u1');
      expect(argus.on('/v1/flags/evaluate')).toHaveLength(2);
    } finally {
      Date.now = realNow;
    }
  });

  it('gives up after 2 s and returns the caller default', async () => {
    let calls = 0;
    const hang = (async () => {
      calls++;
      return new Promise<Response>(() => undefined); // never answers, ignores the signal
    }) as unknown as typeof fetch;
    const c = client({ fetch: hang });
    const t0 = Date.now();
    expect(await c.variant('theme', 'u1', 'light')).toBe('light');
    expect(await c.isOn('new-checkout', 'u2', true)).toBe(true);
    const took = Date.now() - t0;
    expect(calls).toBe(2);
    expect(took).toBeGreaterThanOrEqual(3900);
    expect(took).toBeLessThan(6000);
  }, 10_000);

  it('aborts the request on timeout', async () => {
    let aborted = false;
    const f = (async (_u: string, init: RequestInit) =>
      new Promise<Response>((_r, reject) => {
        init.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      })) as unknown as typeof fetch;
    const c = client({ fetch: f });
    expect(await c.isOn('x', 'u1', false)).toBe(false);
    expect(aborted).toBe(true);
  }, 10_000);

  it('stops asking after 401 or 403, returning the default', async () => {
    for (const code of [401, 403]) {
      argus.received = [];
      argus.status['/v1/flags/evaluate'] = code;
      argus.flags = { a: 'on' };
      const c = client();
      expect(await c.isOn('a', 'u1', false)).toBe(false);
      delete argus.status['/v1/flags/evaluate'];
      expect(await c.isOn('a', 'u2', false)).toBe(false);
      expect(argus.on('/v1/flags/evaluate')).toHaveLength(1);
      // Other endpoints are unaffected.
      c.log('info', 'still here');
      await c.flush();
      expect(argus.on('/v1/logs')).toHaveLength(1);
    }
  });

  it('honours 429 Retry-After, then asks again', async () => {
    argus.status['/v1/flags/evaluate'] = 429;
    argus.headers['/v1/flags/evaluate'] = { 'Retry-After': '30' };
    argus.flags = { a: 'on' };
    const c = client();
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      expect(await c.isOn('a', 'u1', false)).toBe(false);
      delete argus.status['/v1/flags/evaluate'];
      now += 10_000;
      expect(await c.isOn('a', 'u1', false)).toBe(false);
      expect(argus.on('/v1/flags/evaluate')).toHaveLength(1);
      now += 21_000;
      expect(await c.isOn('a', 'u1', false)).toBe(true);
      expect(argus.on('/v1/flags/evaluate')).toHaveLength(2);
    } finally {
      Date.now = realNow;
    }
  });

  it('serves the last answer when a refresh fails', async () => {
    argus.flags = { a: 'on' };
    const c = client();
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      expect(await c.isOn('a', 'u1', false)).toBe(true);
      argus.status['/v1/flags/evaluate'] = 503;
      now += 31_000;
      expect(await c.isOn('a', 'u1', false)).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });

  it('returns the default for a network error or a body that is not JSON', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await client({ fetch: down }).variant('t', 'u1', 'light')).toBe('light');
    const junk = (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch;
    expect(await client({ fetch: junk }).variant('t', 'u1', 'light')).toBe('light');
  });
});

describe('cron 404', () => {
  it('drops that check-in only and keeps the endpoint open', async () => {
    argus.status['/v1/cron/missing'] = 404;
    const c = client();
    c.checkIn('missing', 'ok');
    await c.flush();
    c.checkIn('nightly', 'start');
    c.checkIn('missing', 'ok');
    c.checkIn('nightly', 'ok');
    await c.flush();
    expect(argus.on('/v1/cron/').map((r) => r.path)).toEqual([
      '/v1/cron/missing',
      '/v1/cron/nightly/start',
      '/v1/cron/missing',
      '/v1/cron/nightly',
    ]);
  });
});
