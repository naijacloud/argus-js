import { describe, expect, it } from 'vitest';

import { Transport, retryAfterMs } from '../src/core/transport.js';

function fakeFetch(answers: (number | Error)[], headers: Record<string, string> = {}) {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    const a = answers.length > 1 ? answers.shift() : answers[0];
    if (a instanceof Error) throw a;
    return new Response('{}', { status: a, headers });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const req = (n = 1) => ({ url: `https://in/x/${n}`, body: '{}', headers: {} });
const noSleep = () => Promise.resolve();

describe('transport', () => {
  it('sends, and flush resolves when done', async () => {
    const { f, calls } = fakeFetch([200]);
    const t = new Transport({ fetch: f, sleep: noSleep });
    t.send('errors', req(1));
    t.send('errors', req(2));
    expect(await t.flush(1000)).toBe(true);
    expect(calls).toEqual(['https://in/x/1', 'https://in/x/2']);
  });

  it('retries network errors and 5xx, then gives up after five tries', async () => {
    const { f, calls } = fakeFetch([new Error('ECONNRESET'), 503, 200]);
    const t = new Transport({ fetch: f, sleep: noSleep });
    t.send('logs', req());
    await t.flush(1000);
    expect(calls).toHaveLength(3);

    const dead = fakeFetch([500]);
    const t2 = new Transport({ fetch: dead.f, sleep: noSleep });
    t2.send('logs', req());
    await t2.flush(1000);
    expect(dead.calls).toHaveLength(5);
  });

  it('drops a 400 without retrying', async () => {
    const { f, calls } = fakeFetch([400]);
    const t = new Transport({ fetch: f, sleep: noSleep });
    t.send('errors', req());
    await t.flush(1000);
    expect(calls).toHaveLength(1);
  });

  it('stops the endpoint on 429 until Retry-After passes', async () => {
    let now = 1_000_000;
    const { f, calls } = fakeFetch([429, 200], { 'Retry-After': '30' });
    const t = new Transport({ fetch: f, sleep: noSleep, now: () => now });
    t.send('errors', req(1));
    await t.flush(1000);
    expect(t.send('errors', req(2))).toBe(false);
    expect(t.send('logs', req(3))).toBe(true); // other endpoints keep going
    now += 31_000;
    expect(t.send('errors', req(4))).toBe(true);
    await t.flush(1000);
    expect(calls).toContain('https://in/x/4');
    expect(calls).not.toContain('https://in/x/2');
  });

  it('stops the endpoint for good on 401', async () => {
    const { f, calls } = fakeFetch([401]);
    const t = new Transport({ fetch: f, sleep: noSleep });
    t.send('errors', req(1));
    await t.flush(1000);
    expect(t.send('errors', req(2))).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('hands failed requests to the offline queue instead of retrying', async () => {
    const { f, calls } = fakeFetch([new Error('offline')]);
    const saved: string[] = [];
    const t = new Transport({ fetch: f, sleep: noSleep, onOffline: (_lane, r) => (saved.push(r.url), true) });
    t.send('errors', { ...req(1), persist: true });
    await t.flush(1000);
    expect(calls).toHaveLength(1);
    expect(saved).toEqual(['https://in/x/1']);
  });

  it('reads Retry-After and the Sentry rate-limit header', () => {
    expect(retryAfterMs(new Headers({ 'Retry-After': '12' }))).toBe(12_000);
    expect(retryAfterMs(new Headers({ 'X-Sentry-Rate-Limits': '45:error;default:organization' }))).toBe(45_000);
    expect(retryAfterMs(new Headers())).toBe(60_000);
  });
});
