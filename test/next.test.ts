import { afterEach, describe, expect, it } from 'vitest';

import { close, getClient } from '../src/core/api.js';
import { init, onRequestError } from '../src/next/server.js';
import { FakeArgus } from './support/argus.js';

let argus: FakeArgus | undefined;
afterEach(async () => {
  await close(500);
  await argus?.stop();
  delete process.env.ARGUS_DSN;
});

describe('next (server)', () => {
  it('falls back to ARGUS_DSN when the option is undefined, and reports request errors', async () => {
    argus = await new FakeArgus().start();
    process.env.ARGUS_DSN = argus.dsn;
    init({ dsn: undefined });
    expect(getClient()?.enabled).toBe(true);
    onRequestError(new Error('render failed'), { path: '/orders/9?tab=x', method: 'GET' }, { routerKind: 'App Router', routePath: '/orders/[id]', routeType: 'render' });
    await getClient()?.flush(2000);
    const [ev] = argus.events();
    expect(ev).toMatchObject({ transaction: '/orders/[id]', request: { method: 'GET', url: '/orders/9' }, tags: { 'next.router': 'App Router', 'next.route_type': 'render' } });
  });
});
