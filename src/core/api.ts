/**
 * The functions every entry point exports. They talk to the one client that
 * init() made; before init (or without a DSN) they do nothing.
 */
import type { Breadcrumb, CaptureContext, Client, Level, Span, User } from './client.js';
import type { Attrs } from './otlp.js';

// One client per process, even when the app loads both the ESM and CJS builds,
// or the register entry and the main one (each is bundled separately).
const KEY = Symbol.for('naijacloud.argus.client');
const g = globalThis as unknown as Record<symbol, Client | null | undefined>;

export function setClient(c: Client | null): void {
  g[KEY] = c;
}

/** The client init() made, if any. */
export function getClient(): Client | null {
  return g[KEY] ?? null;
}

export function captureException(error: unknown, ctx?: CaptureContext): string {
  return getClient()?.captureException(error, ctx) ?? '';
}

export function captureMessage(message: string, level?: Level, ctx?: CaptureContext): string {
  return getClient()?.captureMessage(message, level, ctx) ?? '';
}

export function setUser(user: User | null): void {
  getClient()?.setUser(user);
}

export function setTag(key: string, value: string): void {
  getClient()?.setTag(key, value);
}

export function setTags(tags: Record<string, string>): void {
  getClient()?.setTags(tags);
}

export function setContext(name: string, ctx: Record<string, unknown> | null): void {
  getClient()?.setContext(name, ctx);
}

export function addBreadcrumb(crumb: Breadcrumb): void {
  getClient()?.addBreadcrumb(crumb);
}

/** Logs sent to Argus Logs (the console is untouched). */
export const log = {
  trace: (msg: string, attrs?: Attrs) => getClient()?.log('trace', msg, attrs),
  debug: (msg: string, attrs?: Attrs) => getClient()?.log('debug', msg, attrs),
  info: (msg: string, attrs?: Attrs) => getClient()?.log('info', msg, attrs),
  warn: (msg: string, attrs?: Attrs) => getClient()?.log('warn', msg, attrs),
  error: (msg: string, attrs?: Attrs) => getClient()?.log('error', msg, attrs),
  fatal: (msg: string, attrs?: Attrs) => getClient()?.log('fatal', msg, attrs),
};

/** Custom metrics, aggregated and sent every 10 seconds. */
export const metrics = {
  /** Adds to a counter (default 1). */
  count: (name: string, value?: number, attrs?: Attrs) => getClient()?.count(name, value, attrs),
  /** Sets a gauge to its latest value. */
  gauge: (name: string, value: number, attrs?: Attrs, unit?: string) => getClient()?.gauge(name, value, attrs, unit),
  /** Records a value into a histogram (durations, sizes). */
  distribution: (name: string, value: number, attrs?: Attrs, unit?: string) => getClient()?.distribution(name, value, attrs, unit),
};

/** Runs fn inside a span named name. Works with sync and async functions. */
export function trace<T>(name: string, fn: (span: Span | undefined) => T, attrs?: Attrs): T {
  return getClient() ? (getClient() as Client).trace(name, fn, attrs) : fn(undefined);
}

/** Starts a span you end yourself, or undefined before init. */
export function startSpan(name: string, attrs?: Attrs): Span | undefined {
  return getClient()?.startSpan(name, { attributes: attrs });
}

/** Cron check-ins by the monitor's slug (create the monitor in Argus first). */
export const cron = {
  checkIn: (slug: string, status: 'start' | 'ok' | 'error' | number, output?: string) => getClient()?.checkIn(slug, status, output),
  withMonitor: <T>(slug: string, job: () => T | Promise<T>): Promise<T> =>
    getClient() ? (getClient() as Client).withMonitor(slug, job) : Promise.resolve().then(job),
};

/** Feature flags, evaluated by Argus for a subject (usually a user id). */
export const flags = {
  isOn: (key: string, subject: string, fallback = false, attrs?: Record<string, string>): Promise<boolean> =>
    getClient() ? (getClient() as Client).isOn(key, subject, fallback, attrs) : Promise.resolve(fallback),
  variant: (key: string, subject: string, fallback: string, attrs?: Record<string, string>): Promise<string> =>
    getClient() ? (getClient() as Client).variant(key, subject, fallback, attrs) : Promise.resolve(fallback),
  all: (subject: string, attrs?: Record<string, string>): Promise<Record<string, string>> =>
    getClient() ? (getClient() as Client).evaluateFlags(subject, attrs) : Promise.resolve({}),
};

/** Sends what's queued. True when it all went out within timeoutMs. */
export function flush(timeoutMs?: number): Promise<boolean> {
  return getClient() ? (getClient() as Client).flush(timeoutMs) : Promise.resolve(true);
}

/** Flushes and stops the SDK. */
export function close(timeoutMs?: number): Promise<boolean> {
  const c = getClient();
  setClient(null);
  return c ? c.close(timeoutMs) : Promise.resolve(true);
}
