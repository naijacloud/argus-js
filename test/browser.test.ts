// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { close, init } from '../src/browser/index.js';

const DSN = 'https://0000public0000key@argus-in.example.com/42';

afterEach(async () => {
  await close(200);
  localStorage.clear();
});

function fetchStub(fail = false) {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  const f = vi.fn(async (url: string, opts: RequestInit) => {
    calls.push({ url, body: String(opts.body), headers: opts.headers as Record<string, string> });
    if (fail) throw new TypeError('Failed to fetch');
    return new Response('{}', { status: 200 });
  });
  return { f: f as unknown as typeof fetch, calls };
}

describe('browser', () => {
  it('catches uncaught errors with breadcrumbs, key in the URL', async () => {
    const { f, calls } = fetchStub();
    init({ dsn: DSN, fetch: f, release: 'web@1.0.0' });
    document.body.innerHTML = '<button id="pay" class="btn primary">Pay</button><input name="card" />';
    (document.getElementById('pay') as HTMLButtonElement).click();
    console.warn('slow network');
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('Cannot read cart'), message: 'Cannot read cart' }));
    await close(1000);

    const env = calls.find((c) => c.url.includes('/api/42/envelope/'));
    expect(env?.url).toContain('sentry_key=0000public0000key');
    expect(env?.headers['Content-Type']).toContain('text/plain');
    const ev = JSON.parse(env!.body.trim().split('\n')[2] as string);
    expect(ev).toMatchObject({ platform: 'javascript', release: 'web@1.0.0', tags: { mechanism: 'onerror' } });
    expect(ev.exception.values.at(-1).value).toBe('Cannot read cart');
    const crumbs = ev.breadcrumbs.values;
    expect(crumbs.find((b: { category: string }) => b.category === 'ui.click')?.message).toContain('button#pay.btn.primary');
    expect(crumbs.find((b: { category: string }) => b.category === 'console')?.message).toBe('slow network');
  });

  it('keeps errors in localStorage while offline and sends them when back', async () => {
    const off = fetchStub(true);
    init({ dsn: DSN, fetch: off.f });
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('offline error') }));
    await close(1000);
    const stored = JSON.parse(localStorage.getItem('argus:queue:42') ?? '[]');
    expect(stored).toHaveLength(1);
    expect(off.calls).toHaveLength(1);

    const on = fetchStub();
    init({ dsn: DSN, fetch: on.f });
    await close(1000);
    expect(on.calls.some((c) => c.body.includes('offline error'))).toBe(true);
    expect(localStorage.getItem('argus:queue:42')).toBeNull();
  });
});
