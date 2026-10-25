/**
 * Next.js, browser side. In instrumentation-client.ts:
 *
 *   import { init } from '@naijacloud/argus/next'
 *   init({ dsn: process.env.NEXT_PUBLIC_ARGUS_DSN })
 */
import { init as browserInit } from '../browser/index.js';
import type { Options } from '../core/client.js';

export * from '../core/api.js';
export type { ArgusEvent, Breadcrumb, CaptureContext, Client, Level, Options, User } from '../core/client.js';
export { VERSION } from '../version.js';

export function init(options: Options = {}): void {
  browserInit(options);
}

/** Server-only; a no-op in the browser build so one import works in both files. */
export function onRequestError(): void {}
