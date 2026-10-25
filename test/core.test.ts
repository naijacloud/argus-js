import { describe, expect, it } from 'vitest';

import { parseDsn, envelopeUrl, ingestUrl } from '../src/core/dsn.js';
import { scrub, scrubString, sensitiveKey, stripQuery } from '../src/core/scrub.js';
import { parseStack } from '../src/core/stack.js';
import { exceptionChain, parseTraceparent } from '../src/core/client.js';

describe('dsn', () => {
  it('parses a DSN and builds endpoints', () => {
    const d = parseDsn('https://abc000def@argus-in.naijacloud.com/41');
    expect(d).toMatchObject({ publicKey: 'abc000def', projectId: '41', origin: 'https://argus-in.naijacloud.com' });
    expect(envelopeUrl(d!, false)).toBe('https://argus-in.naijacloud.com/api/41/envelope/');
    expect(envelopeUrl(d!, true)).toBe('https://argus-in.naijacloud.com/api/41/envelope/?sentry_key=abc000def&sentry_version=7');
    expect(ingestUrl(d!, '/v1/logs', true)).toBe('https://argus-in.naijacloud.com/v1/logs?key=abc000def');
  });

  it('refuses things that are not DSNs, without throwing', () => {
    for (const bad of ['', 'nope', 'https://argus-in.naijacloud.com/41', 'https://k@host/notanumber', 'ftp://k@h/1', undefined, null]) {
      expect(parseDsn(bad as string)).toBeNull();
    }
  });
});

describe('privacy defaults', () => {
  it('knows sensitive keys', () => {
    for (const k of ['password', 'X-Api-Key', 'access_token', 'BVN', 'card', 'sid', 'Authorization', 'set-cookie']) expect(sensitiveKey(k)).toBe(true);
    for (const k of ['user', 'path', 'cart', 'id', 'status']) expect(sensitiveKey(k)).toBe(false);
  });

  it('filters values inside strings', () => {
    expect(scrubString('paid with 4111 1111 1111 1111 today')).toBe('paid with [Filtered] today');
    expect(scrubString('order 1234567890123')).toBe('order 1234567890123'); // not Luhn-valid
    expect(scrubString('Authorization: Bearer abcdefghijkl123')).toContain('Bearer [Filtered]');
    expect(scrubString('login password=hunter22 ok')).toBe('login password=[Filtered] ok');
    expect(scrubString('t eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSM end')).toBe('t [Filtered] end');
  });

  it('deep-scrubs objects and survives cycles', () => {
    const a: Record<string, unknown> = { user: 'ada', password: 'x', nested: { apiKey: 'k', ok: 1 } };
    a.self = a;
    const out = scrub(a) as Record<string, any>;
    expect(out.password).toBe('[Filtered]');
    expect(out.nested.apiKey).toBe('[Filtered]');
    expect(out.nested.ok).toBe(1);
    expect(out.user).toBe('ada');
  });

  it('strips query strings', () => {
    expect(stripQuery('https://a.ng/pay?token=1#x')).toBe('https://a.ng/pay');
  });
});

describe('stack traces', () => {
  it('parses V8, oldest frame first', () => {
    const stack = `TypeError: x is undefined
    at getLineTotal (/app/src/cart/price.js:12:7)
    at async Promise.all (index 0)
    at checkout (file:///app/src/checkout.js:40:3)
    at Layer.handle (/app/node_modules/express/lib/router/layer.js:95:5)
    at node:internal/process/task_queues:95:5`;
    const f = parseStack(stack);
    expect(f[f.length - 1]).toMatchObject({ function: 'getLineTotal', filename: '/app/src/cart/price.js', lineno: 12, colno: 7, in_app: true });
    expect(f.find((x) => x.function === 'checkout')).toMatchObject({ abs_path: '/app/src/checkout.js', lineno: 40 });
    expect(f.find((x) => x.function === 'Layer.handle')?.in_app).toBe(false);
    expect(f[0]?.in_app).toBe(false);
  });

  it('parses Firefox and Safari', () => {
    const f = parseStack('n@https://shop.ng/assets/index-a1.js:1:536\n@https://shop.ng/assets/index-a1.js:2:10');
    expect(f).toHaveLength(2);
    expect(f[1]).toMatchObject({ function: 'n', filename: '/assets/index-a1.js', abs_path: 'https://shop.ng/assets/index-a1.js', colno: 536 });
  });
});

describe('errors and causes', () => {
  it('lists causes first and the error itself last', () => {
    const root = new Error('connect ECONNREFUSED');
    const err = new Error('payment failed', { cause: root });
    const chain = exceptionChain(err);
    expect(chain.map((c) => c.value)).toEqual(['connect ECONNREFUSED', 'payment failed']);
  });

  it('turns non-errors into readable values', () => {
    expect(exceptionChain('boom')[0]?.value).toBe('Non-Error thrown: boom');
    expect(exceptionChain({ code: 7 })[0]?.value).toBe('Non-Error thrown: {"code":7}');
  });
});

describe('traceparent', () => {
  it('parses and rejects', () => {
    expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toEqual({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      sampled: true,
    });
    expect(parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01')).toBeUndefined();
    expect(parseTraceparent('garbage')).toBeUndefined();
  });
});
