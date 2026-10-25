/**
 * Next.js, server side (Node.js runtime). In instrumentation.ts:
 *
 *   import { init } from '@naijacloud/argus/next'
 *   export const register = () => init({ dsn: process.env.ARGUS_DSN })
 *   export { onRequestError } from '@naijacloud/argus/next'
 *
 * The browser half goes in instrumentation-client.ts with the same import;
 * the package resolves the browser build there by itself.
 */
import { captureException } from '../core/api.js';
import { stripQuery } from '../core/scrub.js';
import { init as nodeInit } from '../node/index.js';
import type { Options } from '../core/client.js';

export * from '../core/api.js';
export type { ArgusEvent, Breadcrumb, CaptureContext, Client, Level, Options, User } from '../core/client.js';
export { VERSION } from '../version.js';

/** Starts Argus on the server. Does nothing in the Edge runtime. */
export function init(options: Options = {}): void {
  if (process.env.NEXT_RUNTIME === 'edge') return;
  nodeInit({ ...options, dsn: options.dsn ?? process.env.ARGUS_DSN ?? process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_ARGUS_DSN });
}

/** Next.js 15's request error hook: `export { onRequestError } from '@naijacloud/argus/next'`. */
export function onRequestError(
  error: unknown,
  request: { path?: string; method?: string },
  context: { routerKind?: string; routePath?: string; routeType?: string },
): void {
  captureException(error, {
    transaction: context.routePath,
    request: { method: request.method, url: stripQuery(request.path ?? '') },
    tags: {
      ...(context.routerKind ? { 'next.router': context.routerKind } : {}),
      ...(context.routeType ? { 'next.route_type': context.routeType } : {}),
    },
  });
}
