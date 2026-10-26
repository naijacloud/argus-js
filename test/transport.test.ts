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

  it('on 429 waits Retry-After, sends nothing meanwhile, then resends the held request', async () => {
    let now = 1_000_000;
    const sleeps: number[] = [];
    const calls: { url: string; at: number }[] = [];
    const answers = [429, 200];
    const f = (async (url: string) => {
      calls.push({ url, at: now });
      return new Response('{}', { status: answers.length > 1 ? (answers.shift() as number) : (answers[0] as number), headers: { 'Retry-After': '30' } });
    }) as unknown as typeof fetch;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = new Transport({
      fetch: f,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        await gate;
        now += ms;
      },
    });
    t.send('errors', req(1));
    await new Promise((r) => setTimeout(r, 10));
    // Held, and new items keep queuing on the blocked endpoint.
    expect(t.send('errors', req(2))).toBe(true);
    expect(t.send('logs', req(3))).toBe(true); // other endpoints keep going
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.map((c) => c.url)).toEqual(['https://in/x/1', 'https://in/x/3']);
    release();
    expect(await t.flush(1000)).toBe(true);
    expect(sleeps).toEqual([30_000]);
    const errs = calls.filter((c) => c.url !== 'https://in/x/3');
    expect(errs.map((c) => c.url)).toEqual(['https://in/x/1', 'https://in/x/1', 'https://in/x/2']);
    expect(errs[1]!.at - errs[0]!.at).toBe(30_000);
  });

  it('does not count a 429 wait as a try', async () => {
    let now = 0;
    // Four 5xx and a 429 in between: still five real tries, so the last 200 lands.
    const { f, calls } = fakeFetch([500, 500, 429, 500, 500, 200], { 'Retry-After': '1' });
    const t = new Transport({ fetch: f, now: () => now, sleep: async (ms) => void (now += ms) });
    t.send('errors', req(1));
    expect(await t.flush(1000)).toBe(true);
    expect(calls).toHaveLength(6);
  });

  it('gives up on a request after ten 429s in a row, so it is not held forever', async () => {
    let now = 0;
    const { f, calls } = fakeFetch([429], { 'Retry-After': '1' });
    const t = new Transport({ fetch: f, now: () => now, sleep: async (ms) => void (now += ms) });
    t.send('errors', req(1));
    expect(await t.flush(1000)).toBe(true);
    expect(calls).toHaveLength(11);
  });

  it('keeps at most 100 requests per endpoint while held, dropping the oldest but never the one in flight', async () => {
    let now = 0;
    const urls: string[] = [];
    const answers = [429, 200];
    const f = (async (url: string) => {
      urls.push(url);
      return new Response('{}', { status: answers.length > 1 ? (answers.shift() as number) : 200, headers: { 'Retry-After': '5' } });
    }) as unknown as typeof fetch;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = new Transport({ fetch: f, now: () => now, sleep: async (ms) => (await gate, void (now += ms)) });
    t.send('logs', req(0));
    await new Promise((r) => setTimeout(r, 10));
    for (let i = 1; i <= 150; i++) t.send('logs', req(i));
    release();
    await t.flush(1000);
    expect(urls[0]).toBe('https://in/x/0');
    expect(urls[1]).toBe('https://in/x/0'); // the held one, resent
    const rest = urls.slice(2);
    expect(rest).toHaveLength(99);
    expect(rest[0]).toBe('https://in/x/52');
    expect(rest.at(-1)).toBe('https://in/x/150');
  });

  it('keeps at most 1 MB per endpoint, dropping the oldest', async () => {
    const urls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = (async (url: string) => {
      urls.push(url);
      await gate;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const t = new Transport({ fetch: f, sleep: noSleep });
    const big = 'x'.repeat(300 * 1024);
    for (let i = 0; i < 6; i++) t.send('logs', { url: `https://in/x/${i}`, body: big, headers: {} });
    release();
    await t.flush(1000);
    // 0 is in flight; three 300 KB requests make 900 KB, so only the two newest fit next to it.
    expect(urls).toEqual(['https://in/x/0', 'https://in/x/4', 'https://in/x/5']);
  });

  it('stops the endpoint for good on 401 and 403', async () => {
    for (const code of [401, 403]) {
      const { f, calls } = fakeFetch([code]);
      const t = new Transport({ fetch: f, sleep: noSleep });
      t.send('errors', req(1));
      t.send('errors', req(2));
      await t.flush(1000);
      expect(t.send('errors', req(3))).toBe(false);
      expect(t.send('logs', req(4))).toBe(true);
      await t.flush(1000);
      expect(calls).toEqual(['https://in/x/1', 'https://in/x/4']);
    }
  });

  it('drops a 404 without stopping the endpoint', async () => {
    const { f, calls } = fakeFetch([404, 200]);
    const t = new Transport({ fetch: f, sleep: noSleep });
    t.send('crons', req(1));
    await t.flush(1000);
    expect(t.send('crons', req(2))).toBe(true);
    await t.flush(1000);
    expect(calls).toEqual(['https://in/x/1', 'https://in/x/2']);
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
    expect(retryAfterMs(new Headers({ 'X-Sentry-Rate-Limits': '20:transaction, 90:error' }))).toBe(20_000);
    expect(retryAfterMs(new Headers({ 'Retry-After': '0.2' }))).toBe(1000); // at least 1 s
    expect(retryAfterMs(new Headers({ 'Retry-After': '99999' }))).toBe(3_600_000); // at most 1 h
    const now = Date.parse('2026-10-26T12:00:00Z');
    expect(retryAfterMs(new Headers({ 'Retry-After': 'Mon, 26 Oct 2026 12:00:40 GMT' }), now)).toBe(40_000);
  });
});
