/**
 * Node.js. Start it with the flag so Argus loads before your app's imports:
 *
 *   ARGUS_DSN=… node --import @naijacloud/argus/register app.js
 *
 * or call init() yourself (CommonJS apps, custom options).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomFillSync } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { hostname } from 'node:os';

import { captureException, getClient, setClient } from '../core/api.js';
import { Client, type Options, type Platform, Span, parseTraceparent } from '../core/client.js';
import { setRandom } from '../core/ids.js';
import { stripQuery } from '../core/scrub.js';
import { packageName } from './package-name.js';
import { VERSION } from '../version.js';

export * from '../core/api.js';
export type { ArgusEvent, Breadcrumb, CaptureContext, Client, Level, Options, User } from '../core/client.js';
export { Span } from '../core/client.js';
export { VERSION } from '../version.js';

setRandom((b) => randomFillSync(b));

// Shared across bundles (register, main, next) like the client itself.
const G = globalThis as unknown as Record<symbol, unknown>;
const ALS = Symbol.for('naijacloud.argus.als');
const als = (G[ALS] ??= new AsyncLocalStorage<Span>()) as AsyncLocalStorage<Span>;
const INSTALLED = Symbol.for('naijacloud.argus.installed');

function env(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n]?.trim();
    if (v) return v;
  }
  return undefined;
}

/** Starts Argus. Options win over ARGUS_* and then SENTRY_* environment variables. */
export function init(options: Options = {}): Client {
  const existing = getClient();
  if (existing) return existing;
  const platform: Platform = {
    sdkName: 'argus.javascript',
    platform: 'node',
    keyInUrl: false,
    serverName: hostname(),
    contexts: () => ({ runtime: { name: 'node', version: process.version } }),
    activeSpan: () => als.getStore(),
    withSpan: (span, fn) => als.run(span, fn),
    fetch: globalThis.fetch.bind(globalThis),
    // Cloudflare in front of ingest blocks some default user agents.
    userAgent: `argus.javascript/${VERSION}`,
  };
  const client = new Client(
    {
      ...options,
      dsn: options.dsn ?? env('ARGUS_DSN', 'SENTRY_DSN'),
      release: options.release ?? env('ARGUS_RELEASE', 'SENTRY_RELEASE'),
      environment: options.environment || env('ARGUS_ENVIRONMENT', 'SENTRY_ENVIRONMENT') || 'production',
      serviceName: options.serviceName || env('ARGUS_SERVICE_NAME', 'OTEL_SERVICE_NAME') || packageName() || 'app',
    },
    platform,
  );
  setClient(client);
  if (client.enabled && !G[INSTALLED]) {
    G[INSTALLED] = true;
    installProcessHandlers(client);
    installHttpServer(client);
    installFetch(client);
    installConsole(client);
  }
  return client;
}

function installProcessHandlers(client: Client): void {
  process.on('uncaughtException', (err, origin) => {
    client.captureException(err, { level: 'fatal', tags: { mechanism: origin } });
    const others = process.listeners('uncaughtException').length > 1;
    void client.flush(2000).finally(() => {
      if (!others) {
        // Node's own behaviour without a handler: print and exit 1.
        console.error(err);
        process.exit(1);
      }
    });
  });
  process.once('beforeExit', () => {
    void client.flush(2000);
  });
}

/** Traces every incoming request on node:http and node:https servers. */
function installHttpServer(client: Client): void {
  for (const proto of [http.Server.prototype, https.Server.prototype] as { emit: (...a: unknown[]) => boolean }[]) {
    const orig = proto.emit;
    proto.emit = function emit(this: unknown, event: unknown, ...args: unknown[]): boolean {
      if (event !== 'request') return orig.apply(this, [event, ...args]);
      const [req, res] = args as [http.IncomingMessage, http.ServerResponse];
      const method = req.method ?? 'GET';
      const path = stripQuery(req.url ?? '/');
      const span = client.startSpan(`${method} ${path}`, {
        kind: 2,
        parent: parseTraceparent(header(req.headers.traceparent)),
        attributes: { 'http.request.method': method, 'url.path': path, 'server.address': header(req.headers.host) },
      });
      res.once('finish', () => {
        span.setAttribute('http.response.status_code', res.statusCode);
        span.end(res.statusCode >= 500 ? `HTTP ${res.statusCode}` : undefined);
      });
      return als.run(span, () => orig.apply(this, [event, ...args]));
    };
  }
}

function header(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Breadcrumbs, child spans and traceparent for outgoing fetch() calls. */
function installFetch(client: Client): void {
  const orig = globalThis.fetch;
  if (typeof orig !== 'function') return;
  const ingest = client.dsn?.origin ?? '';
  globalThis.fetch = async function argusFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (ingest && url.startsWith(ingest)) return orig(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const parent = als.getStore();
    const span = parent ? client.startSpan(`${method} ${stripQuery(url)}`, { kind: 3, attributes: { 'http.request.method': method, 'url.full': stripQuery(url) } }) : undefined;
    let next = init;
    if (span) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      if (!headers.has('traceparent')) headers.set('traceparent', span.traceparent());
      next = { ...init, headers };
    }
    try {
      const res = await orig(input, next);
      span?.setAttribute('http.response.status_code', res.status);
      span?.end(res.status >= 500 ? `HTTP ${res.status}` : undefined);
      client.addBreadcrumb({ type: 'http', category: 'fetch', data: { method, url: stripQuery(url), status_code: res.status } });
      return res;
    } catch (err) {
      span?.end(err);
      client.addBreadcrumb({ type: 'http', category: 'fetch', level: 'error', data: { method, url: stripQuery(url) } });
      throw err;
    }
  } as typeof fetch;
}

/** console.* becomes breadcrumbs; with captureConsole, also logs. */
function installConsole(client: Client): void {
  const cc = client.options.captureConsole;
  const forward = new Set<string>(cc === true ? ['info', 'warn', 'error'] : Array.isArray(cc) ? cc : []);
  const levels = { log: 'info', info: 'info', warn: 'warn', error: 'error', debug: 'debug' } as const;
  for (const name of Object.keys(levels) as (keyof typeof levels)[]) {
    const orig = console[name].bind(console);
    console[name] = (...args: unknown[]) => {
      orig(...args);
      try {
        const msg = args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack ?? a.message : safeJson(a))).join(' ');
        client.addBreadcrumb({ category: 'console', level: levels[name] === 'warn' ? 'warning' : levels[name], message: msg.slice(0, 1000) });
        if (forward.has(name)) client.log(levels[name], msg);
      } catch {
        /* never break console */
      }
    };
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Express error middleware: `app.use(argusErrorHandler())` after your routes.
 * Express catches route errors itself, so they never reach the process handler.
 */
export function argusErrorHandler(): (err: unknown, req: http.IncomingMessage & { originalUrl?: string }, res: unknown, next: (err?: unknown) => void) => void {
  return (err, req, _res, next) => {
    captureException(err, { request: { method: req.method, url: stripQuery(req.originalUrl ?? req.url ?? '') } });
    next(err);
  };
}
