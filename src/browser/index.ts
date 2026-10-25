/**
 * Browsers: `import { init } from '@naijacloud/argus/browser'`.
 * Catches uncaught errors and promise rejections, keeps breadcrumbs of clicks,
 * navigation, console and fetch/XHR, and queues errors while offline.
 */
import { getClient, setClient } from '../core/api.js';
import { Client, type Options, type Platform, type Span } from '../core/client.js';
import { stripQuery } from '../core/scrub.js';
import type { Request } from '../core/transport.js';

export * from '../core/api.js';
export type { ArgusEvent, Breadcrumb, CaptureContext, Client, Level, Options, User } from '../core/client.js';
export { Span } from '../core/client.js';
export { VERSION } from '../version.js';

const MAX_STORED = 30;
const MAX_STORED_BYTES = 512 * 1024;

let active: Span | undefined;

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Starts Argus in the browser. */
export function init(options: Options = {}): Client {
  const existing = getClient();
  if (existing) return existing;
  let queueKey = '';
  const platform: Platform = {
    sdkName: 'argus.javascript',
    platform: 'javascript',
    keyInUrl: true,
    contexts: () => ({
      browser: { name: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown' },
      ...(typeof location !== 'undefined' ? { page: { url: stripQuery(location.href) } } : {}),
    }),
    activeSpan: () => active,
    withSpan: (span, fn) => {
      const prev = active;
      active = span;
      try {
        return fn();
      } finally {
        active = prev;
      }
    },
    onOffline: (lane: string, req: Request) => (lane === 'errors' ? store(queueKey, req) : false),
    fetch: globalThis.fetch.bind(globalThis),
  };
  const client = new Client(options, platform);
  setClient(client);
  if (!client.enabled || typeof window === 'undefined') return client;
  queueKey = `argus:queue:${client.dsn?.projectId ?? ''}`;

  window.addEventListener('error', (e: ErrorEvent) => {
    client.captureException(e.error ?? new Error(e.message || 'Script error'), { tags: { mechanism: 'onerror' } });
  });
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    client.captureException(e.reason, { tags: { mechanism: 'unhandledrejection' } });
  });
  installClicks(client);
  installNavigation(client);
  installConsole(client);
  installFetch(client);
  installXhr(client);

  window.addEventListener('online', () => replay(client, queueKey));
  replay(client, queueKey);
  window.addEventListener('pagehide', () => {
    client.flushLogs();
    client.flushSpans();
    client.flushMetrics();
    for (const lane of ['errors', 'logs', 'metrics', 'traces']) {
      for (const req of client.transport.drain(lane)) {
        const ok = typeof navigator !== 'undefined' && navigator.sendBeacon?.(req.url, new Blob([req.body], { type: req.headers['Content-Type'] ?? 'text/plain' }));
        if (!ok && lane === 'errors') store(queueKey, req);
      }
    }
  });
  return client;
}

function store(key: string, req: Request): boolean {
  const s = storage();
  if (!s || !key) return false;
  try {
    const list = JSON.parse(s.getItem(key) ?? '[]') as Request[];
    list.push(req);
    while (list.length > MAX_STORED || JSON.stringify(list).length > MAX_STORED_BYTES) list.shift();
    s.setItem(key, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

function replay(client: Client, key: string): void {
  const s = storage();
  if (!s || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
  let list: Request[] = [];
  try {
    list = JSON.parse(s.getItem(key) ?? '[]') as Request[];
    s.removeItem(key);
  } catch {
    return;
  }
  for (const req of list) client.transport.send('errors', req);
}

function describe(el: Element | null): string {
  if (!el) return '';
  const parts: string[] = [];
  let cur: Element | null = el;
  for (let i = 0; cur && i < 4; i++, cur = cur.parentElement) {
    let p = cur.tagName.toLowerCase();
    if (cur.id) p += `#${cur.id}`;
    const cls = typeof cur.className === 'string' ? cur.className.trim().split(/\s+/).slice(0, 2).filter(Boolean) : [];
    if (cls.length) p += `.${cls.join('.')}`;
    parts.unshift(p);
  }
  return parts.join(' > ');
}

/** Clicks: which element, never what was typed. */
function installClicks(client: Client): void {
  document.addEventListener(
    'click',
    (e) => {
      const t = e.target instanceof Element ? e.target : null;
      if (t) client.addBreadcrumb({ category: 'ui.click', message: describe(t) });
    },
    true,
  );
}

function installNavigation(client: Client): void {
  let from = stripQuery(location.pathname);
  const record = () => {
    const to = stripQuery(location.pathname);
    if (to !== from) client.addBreadcrumb({ category: 'navigation', data: { from, to } });
    from = to;
  };
  for (const m of ['pushState', 'replaceState'] as const) {
    const orig = history[m].bind(history);
    history[m] = (...args: Parameters<History['pushState']>) => {
      orig(...args);
      record();
    };
  }
  window.addEventListener('popstate', record);
}

function installConsole(client: Client): void {
  const cc = client.options.captureConsole;
  const forward = new Set<string>(cc === true ? ['warn', 'error'] : Array.isArray(cc) ? cc : []);
  const levels = { log: 'info', info: 'info', warn: 'warn', error: 'error' } as const;
  for (const name of Object.keys(levels) as (keyof typeof levels)[]) {
    const orig = console[name].bind(console);
    console[name] = (...args: unknown[]) => {
      orig(...args);
      try {
        const msg = args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : String(a))).join(' ');
        client.addBreadcrumb({ category: 'console', level: levels[name] === 'warn' ? 'warning' : levels[name], message: msg.slice(0, 1000) });
        if (forward.has(name)) client.log(levels[name], msg);
      } catch {
        /* never break console */
      }
    };
  }
}

function installFetch(client: Client): void {
  const orig = window.fetch?.bind(window);
  if (!orig) return;
  const ingest = client.dsn?.origin ?? '';
  window.fetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (ingest && url.startsWith(ingest)) return orig(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    try {
      const res = await orig(input, init);
      client.addBreadcrumb({ type: 'http', category: 'fetch', data: { method, url: stripQuery(url), status_code: res.status } });
      return res;
    } catch (err) {
      client.addBreadcrumb({ type: 'http', category: 'fetch', level: 'error', data: { method, url: stripQuery(url) } });
      throw err;
    }
  };
}

function installXhr(client: Client): void {
  if (typeof XMLHttpRequest === 'undefined') return;
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  const info = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    info.set(this, { method: method.toUpperCase(), url: stripQuery(String(url)) });
    return (open as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const i = info.get(this);
    if (i) this.addEventListener('loadend', () => client.addBreadcrumb({ type: 'http', category: 'xhr', data: { ...i, status_code: this.status } }));
    return send.call(this, body);
  };
}
