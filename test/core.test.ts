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

  // The cases below mirror argus-python's tests/test_scrub.py one for one.
  it('matches the spec contains-list, normalised (lowercase, no - _ or spaces)', () => {
    for (const k of [
      'password', 'user_password', 'PassWD', 'client-secret', 'access_token', 'X-Api-Key', 'apiKey', 'AccessKeyId',
      'Authorization', 'aws_credentials', 'Set-Cookie', 'private_key', 'card_number', 'creditCard', 'customer_bvn',
      'cvv2', 'CVC', 'session_id', 'sessionToken', 'webhook signature',
    ])
      expect(sensitiveKey(k), k).toBe(true);
  });

  it('matches the spec exact keys', () => {
    for (const k of ['auth', 'PWD', 'pin', 'otp', 'session', 'card', 'sid', 'S-I-D']) expect(sensitiveKey(k), k).toBe(true);
  });

  it('leaves look-alike keys alone', () => {
    for (const k of ['author', 'pinned', 'cardinality', 'sidebar', 'user_id', 'email', 'authority']) expect(sensitiveKey(k), k).toBe(false);
  });

  it('filters card numbers that pass Luhn only', () => {
    expect(scrubString('card 4111 1111 1111 1111 ok')).toBe('card [Filtered] ok');
    expect(scrubString('5500-0000-0000-0004')).toBe('[Filtered]');
    expect(scrubString('order 1234567812345678')).toBe('order 1234567812345678');
    expect(scrubString('short 411111111111')).toBe('short 411111111111');
  });

  it('filters credentials after a scheme, once', () => {
    expect(scrubString('Authorization: Bearer abcdefgh12345678')).toBe('Authorization: Bearer [Filtered]');
    expect(scrubString('Basic dXNlcjpwYXNzd29yZA==')).toBe('Basic [Filtered]');
    expect(scrubString('token abcdefgh1234')).toBe('token [Filtered]');
  });

  it('filters JWTs', () => {
    // A made-up token, joined here so secret scanners don't flag the fixture.
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'].join('.');
    expect(scrubString(`got ${jwt}`)).toBe('got [Filtered]');
  });

  it('filters key=value, key: value and JSON pairs for the contains-list', () => {
    expect(scrubString('login password=hunter2 ok')).toBe('login password=[Filtered] ok');
    expect(scrubString('{"api_key": "abc123"}')).toBe('{"api_key": "[Filtered]"}');
    expect(scrubString('{"api_key":"abc123","user":"ada"}')).toBe('{"api_key":"[Filtered]","user":"ada"}');
    expect(scrubString('?client_secret=s3cr3t&x=1')).toBe('?client_secret=[Filtered]&x=1');
    expect(scrubString('password: hunter2')).toBe('password: [Filtered]');
    expect(scrubString("cookie: 'abc'")).toBe("cookie: '[Filtered]'");
    for (const k of ['authorization', 'cookie', 'cardNumber', 'credit-card', 'cvc', 'session_id', 'sessionToken', 'signature', 'privateKey']) {
      expect(scrubString(`${k}=v4lue`), k).toBe(`${k}=[Filtered]`);
      expect(scrubString(`{"${k}": "v4lue"}`), k).toBe(`{"${k}": "[Filtered]"}`);
    }
  });

  it('filters exact keys only in key=value form', () => {
    expect(scrubString('pin=1234')).toBe('pin=[Filtered]');
    expect(scrubString('otp=998877 sid=abc')).toBe('otp=[Filtered] sid=[Filtered]');
    expect(scrubString('?auth=xyz&x=1')).toBe('?auth=[Filtered]&x=1');
    // Prose survives: `key: value` doesn't count for exact keys, nor does a longer word.
    expect(scrubString('card: declined')).toBe('card: declined');
    expect(scrubString('session: started')).toBe('session: started');
    expect(scrubString('spin=3')).toBe('spin=3');
  });

  it('leaves plain text untouched', () => {
    const s = 'order ord_81 placed for 18500 kobo at 2026-10-25';
    expect(scrubString(s)).toBe(s);
  });

  it('filters the whole value of a sensitive header', () => {
    const out = scrub({
      headers: { Authorization: 'Bearer x', Cookie: 'a=1; b=2', 'X-Api-Key': 'k', 'Set-Cookie': ['s=1', 's=2'], Accept: '*/*' },
    }) as Record<string, any>;
    expect(out.headers).toEqual({ Authorization: '[Filtered]', Cookie: '[Filtered]', 'X-Api-Key': '[Filtered]', 'Set-Cookie': '[Filtered]', Accept: '*/*' });
  });

  it('filters sensitive keys at any depth, keeping empty values', () => {
    const out = scrub({
      user: { name: 'Ada', password: 'hunter2', nested: [{ token: 't' }] },
      empty_password: '',
      none_token: null,
    }) as Record<string, any>;
    expect(out.user.password).toBe('[Filtered]');
    expect(out.user.nested[0].token).toBe('[Filtered]');
    expect(out.user.name).toBe('Ada');
    expect(out.empty_password).toBe('');
    expect(out.none_token).toBeNull();
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
