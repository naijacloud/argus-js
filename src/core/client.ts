import { type Dsn, envelopeUrl, ingestUrl, parseDsn } from './dsn.js';
import { eventId, spanId as newSpanId, traceId as newTraceId } from './ids.js';
import {
  type Attrs,
  type LogRecord,
  type MetricPoint,
  type SpanData,
  logsRequest,
  metricsRequest,
  tracesRequest,
} from './otlp.js';
import { scrub, scrubString } from './scrub.js';
import { type Frame, parseStack } from './stack.js';
import { type Request, Transport, retryAfterMs } from './transport.js';
import { CONTRACT, VERSION } from '../version.js';

export type Level = 'fatal' | 'error' | 'warning' | 'info' | 'debug';

export interface User {
  id?: string;
  email?: string;
  username?: string;
  ip_address?: string;
}

export interface Breadcrumb {
  timestamp?: number;
  type?: string;
  category?: string;
  message?: string;
  level?: Level;
  data?: Record<string, unknown>;
}

export interface ArgusEvent {
  event_id: string;
  timestamp: number;
  platform: string;
  level: Level;
  release?: string;
  environment: string;
  server_name?: string;
  transaction?: string;
  message?: string;
  exception?: { values: { type: string; value: string; stacktrace?: { frames: Frame[] } }[] };
  tags?: Record<string, string>;
  user?: User;
  breadcrumbs?: { values: Breadcrumb[] };
  contexts?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  request?: { method?: string; url?: string; headers?: Record<string, string> };
  fingerprint?: string[];
  sdk: { name: string; version: string };
}

export interface Options {
  /** `https://<key>@argus-in.naijacloud.com/<project>`. Without one, nothing is sent. */
  dsn?: string;
  release?: string;
  environment?: string;
  /** service.name on logs, metrics and traces. */
  serviceName?: string;
  serverName?: string;
  /** Share of errors to send, 0–1. Default 1. */
  sampleRate?: number;
  /** Share of traces to send, 0–1. Default 1. */
  tracesSampleRate?: number;
  /** Send the user's IP address. Off by default. */
  sendDefaultPii?: boolean;
  maxBreadcrumbs?: number;
  /** Change an event, or return null to drop it. Runs before scrubbing. */
  beforeSend?: (event: ArgusEvent) => ArgusEvent | null;
  beforeBreadcrumb?: (crumb: Breadcrumb) => Breadcrumb | null;
  /** Forward console.warn/error (and info/log) calls as logs. Off by default. */
  captureConsole?: boolean | ('log' | 'info' | 'warn' | 'error')[];
  /** Print what the SDK does to the console. */
  debug?: boolean;
  /** Set false to turn the SDK off without removing it. */
  enabled?: boolean;
  /** Override fetch (tests, proxies). */
  fetch?: typeof fetch;
}

export interface CaptureContext {
  level?: Level;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  user?: User;
  fingerprint?: string[];
  request?: ArgusEvent['request'];
  transaction?: string;
}

/** What a platform (Node, browser, edge) gives the client. */
export interface Platform {
  sdkName: string;
  platform: 'node' | 'javascript';
  /** Put the key in the URL instead of a header (browsers, to avoid preflights). */
  keyInUrl: boolean;
  contexts(): Record<string, unknown>;
  serverName?: string;
  activeSpan(): Span | undefined;
  withSpan<T>(span: Span, fn: () => T): T;
  onOffline?: (lane: string, req: Request) => boolean;
  fetch: typeof fetch;
  /** Sent as User-Agent on every request (servers; browsers can't set it). */
  userAgent?: string;
}

const FLUSH_LOGS_MS = 5000;
const FLUSH_SPANS_MS = 5000;
const FLUSH_METRICS_MS = 10_000;
const MAX_LOGS = 1000;
const MAX_SPANS = 512;
const HIST_BOUNDS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000];
const CAPTURED = Symbol.for('argus.captured');
/** An OTLP body larger than this is split, so a batch always fits the 1 MB queue. */
export const MAX_OTLP_BODY = 512 * 1024;
const FLAGS_TIMEOUT_MS = 2000;
const FLAGS_CACHE_MS = 30_000;

const utf8 = new TextEncoder();
const byteLength = (s: string): number => utf8.encode(s).length;

/** A unit of work in a trace. End it once. */
export class Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly sampled: boolean;
  readonly startMs: number;
  name: string;
  attributes: Attrs;
  private ended = false;

  constructor(
    private readonly client: Client | null,
    name: string,
    readonly kind: 1 | 2 | 3,
    parent?: { traceId: string; spanId: string; sampled: boolean },
    attributes: Attrs = {},
  ) {
    this.name = name;
    this.attributes = attributes;
    this.traceId = parent?.traceId ?? newTraceId();
    this.parentSpanId = parent?.spanId;
    this.spanId = newSpanId();
    this.sampled = parent ? parent.sampled : (client?.sampleTrace() ?? false);
    this.startMs = Date.now();
  }

  setAttribute(key: string, value: string | number | boolean | undefined): this {
    this.attributes[key] = value;
    return this;
  }

  /** W3C traceparent for outgoing requests. */
  traceparent(): string {
    return `00-${this.traceId}-${this.spanId}-${this.sampled ? '01' : '00'}`;
  }

  end(error?: unknown): void {
    if (this.ended) return;
    this.ended = true;
    if (!this.sampled || !this.client) return;
    this.client.recordSpan({
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      kind: this.kind,
      startMs: this.startMs,
      endMs: Date.now(),
      error: error === undefined || error === false ? undefined : error instanceof Error ? error.message : String(error),
      attributes: this.attributes,
    });
  }
}

/** Parses a W3C traceparent header. */
export function parseTraceparent(h: string | null | undefined): { traceId: string; spanId: string; sampled: boolean } | undefined {
  const m = h ? /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(h.trim()) : null;
  if (!m || /^0+$/.test(m[1] as string)) return undefined;
  return { traceId: m[1] as string, spanId: m[2] as string, sampled: (parseInt(m[3] as string, 16) & 1) === 1 };
}

interface MetricAgg {
  kind: 'sum' | 'gauge' | 'histogram';
  name: string;
  unit?: string;
  attributes?: Attrs;
  value: number;
  count: number;
  sum: number;
  min: number;
  max: number;
  buckets: number[];
}

export class Client {
  readonly dsn: Dsn | null;
  readonly options: Options & { environment: string };
  readonly transport: Transport;
  private breadcrumbs: Breadcrumb[] = [];
  private user?: User;
  private tags: Record<string, string> = {};
  private contexts: Record<string, unknown> = {};
  private logBuf: LogRecord[] = [];
  private spanBuf: SpanData[] = [];
  private metricAgg = new Map<string, MetricAgg>();
  private metricStart = Date.now();
  private timers: ReturnType<typeof setInterval>[] = [];
  private flagCache = new Map<string, { at: number; flags: Record<string, string> }>();
  /** 401/403 from the flags endpoint: stop asking until restart. */
  private flagsDead = false;
  /** 429 from the flags endpoint: ask again after this time. */
  private flagsBlockedUntil = 0;
  private closed = false;

  constructor(options: Options, readonly platform: Platform) {
    this.options = { ...options, environment: options.environment || 'production' };
    this.dsn = options.enabled === false ? null : parseDsn(options.dsn);
    if (options.dsn && !this.dsn && options.debug) console.warn('[argus] the DSN is not valid; nothing will be sent');
    this.transport = new Transport({ fetch: options.fetch ?? platform.fetch, debug: options.debug, onOffline: platform.onOffline });
    if (this.dsn) {
      this.every(FLUSH_LOGS_MS, () => this.flushLogs());
      this.every(FLUSH_SPANS_MS, () => this.flushSpans());
      this.every(FLUSH_METRICS_MS, () => this.flushMetrics());
    }
  }

  /** Whether a DSN was given and the SDK will send anything. */
  get enabled(): boolean {
    return this.dsn !== null && !this.closed;
  }

  private every(ms: number, fn: () => void): void {
    const t = setInterval(fn, ms) as unknown as { unref?: () => void };
    t.unref?.();
    this.timers.push(t as unknown as ReturnType<typeof setInterval>);
  }

  // ---- scope ----

  setUser(user: User | null): void {
    this.user = user ?? undefined;
  }

  setTag(key: string, value: string): void {
    this.tags[key] = String(value);
  }

  setTags(tags: Record<string, string>): void {
    for (const [k, v] of Object.entries(tags)) this.setTag(k, v);
  }

  setContext(name: string, ctx: Record<string, unknown> | null): void {
    if (ctx === null) delete this.contexts[name];
    else this.contexts[name] = ctx;
  }

  addBreadcrumb(crumb: Breadcrumb): void {
    let c: Breadcrumb | null = { timestamp: Date.now() / 1000, ...crumb };
    if (this.options.beforeBreadcrumb) {
      try {
        c = this.options.beforeBreadcrumb(c);
      } catch {
        /* keep the crumb */
      }
    }
    if (!c) return;
    this.breadcrumbs.push(c);
    const max = this.options.maxBreadcrumbs ?? 100;
    if (this.breadcrumbs.length > max) this.breadcrumbs.splice(0, this.breadcrumbs.length - max);
  }

  // ---- errors ----

  /** Sends an error. Returns its event id, or '' when nothing was sent. */
  captureException(error: unknown, ctx: CaptureContext = {}): string {
    if (!this.enabled) return '';
    if (error && typeof error === 'object') {
      if ((error as Record<symbol, unknown>)[CAPTURED]) return '';
      try {
        Object.defineProperty(error, CAPTURED, { value: true, enumerable: false });
      } catch {
        /* frozen */
      }
    }
    return this.sendEvent({ exception: { values: exceptionChain(error) } }, ctx);
  }

  captureMessage(message: string, level: Level = 'info', ctx: CaptureContext = {}): string {
    if (!this.enabled) return '';
    return this.sendEvent({ message }, { level, ...ctx });
  }

  private sendEvent(partial: Partial<ArgusEvent>, ctx: CaptureContext): string {
    if (Math.random() >= (this.options.sampleRate ?? 1)) return '';
    const active = this.platform.activeSpan();
    let event: ArgusEvent | null = {
      event_id: eventId(),
      timestamp: Date.now() / 1000,
      platform: this.platform.platform,
      level: ctx.level ?? 'error',
      release: this.options.release,
      environment: this.options.environment,
      server_name: this.options.serverName ?? this.platform.serverName,
      transaction: ctx.transaction ?? active?.name,
      tags: { ...this.tags, ...ctx.tags },
      user: ctx.user ?? this.user,
      breadcrumbs: { values: [...this.breadcrumbs] },
      contexts: {
        ...this.platform.contexts(),
        ...this.contexts,
        ...(active ? { trace: { trace_id: active.traceId, span_id: active.spanId } } : {}),
      },
      extra: ctx.extra,
      request: ctx.request,
      fingerprint: ctx.fingerprint,
      sdk: { name: this.platform.sdkName, version: VERSION },
      ...partial,
    };
    if (event.user && !this.options.sendDefaultPii) {
      const { ip_address: _ip, ...rest } = event.user;
      event.user = rest;
    }
    if (this.options.beforeSend) {
      try {
        event = this.options.beforeSend(event);
      } catch {
        /* send it unchanged */
      }
      if (!event) return '';
    }
    const { sdk, ...rest } = event;
    const clean = { ...scrub(rest), sdk } as ArgusEvent;
    const d = this.dsn as Dsn;
    const body =
      `${JSON.stringify({ event_id: clean.event_id, sent_at: new Date().toISOString(), dsn: d.raw, sdk })}\n` +
      `${JSON.stringify({ type: 'event', content_type: 'application/json' })}\n${JSON.stringify(clean)}\n`;
    this.transport.send('errors', {
      url: envelopeUrl(d, this.platform.keyInUrl),
      body,
      headers: this.platform.keyInUrl
        ? { 'Content-Type': 'text/plain;charset=UTF-8' }
        : {
            'Content-Type': 'application/x-sentry-envelope',
            'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=${sdk.name}/${VERSION}, sentry_key=${d.publicKey}`,
            ...this.uaHeader(),
          },
      persist: true,
    });
    return clean.event_id;
  }

  // ---- logs ----

  log(severity: LogRecord['severity'], body: string, attributes?: Attrs): void {
    if (!this.enabled) return;
    const span = this.platform.activeSpan();
    this.logBuf.push({
      timeMs: Date.now(),
      severity,
      body: scrubString(String(body)).slice(0, 16_384),
      attributes: attributes ? scrub(attributes) : undefined,
      traceId: span?.traceId,
      spanId: span?.spanId,
    });
    if (this.logBuf.length >= MAX_LOGS) this.flushLogs();
  }

  // ---- metrics ----

  private metric(kind: MetricAgg['kind'], name: string, value: number, attributes?: Attrs, unit?: string): void {
    if (!this.enabled || !Number.isFinite(value)) return;
    const key = `${kind}|${name}|${JSON.stringify(attributes ?? {})}`;
    let m = this.metricAgg.get(key);
    if (!m) {
      if (this.metricAgg.size >= 2000) return;
      m = { kind, name, unit, attributes, value: 0, count: 0, sum: 0, min: Infinity, max: -Infinity, buckets: new Array(HIST_BOUNDS.length + 1).fill(0) };
      this.metricAgg.set(key, m);
    }
    if (kind === 'sum') m.value += value;
    else if (kind === 'gauge') m.value = value;
    else {
      m.count++;
      m.sum += value;
      m.min = Math.min(m.min, value);
      m.max = Math.max(m.max, value);
      let i = HIST_BOUNDS.findIndex((b) => value <= b);
      if (i === -1) i = HIST_BOUNDS.length;
      m.buckets[i] = (m.buckets[i] ?? 0) + 1;
    }
  }

  count(name: string, value = 1, attributes?: Attrs): void {
    this.metric('sum', name, value, attributes);
  }

  gauge(name: string, value: number, attributes?: Attrs, unit?: string): void {
    this.metric('gauge', name, value, attributes, unit);
  }

  distribution(name: string, value: number, attributes?: Attrs, unit?: string): void {
    this.metric('histogram', name, value, attributes, unit);
  }

  // ---- traces ----

  sampleTrace(): boolean {
    return this.enabled && Math.random() < (this.options.tracesSampleRate ?? 1);
  }

  /** Starts a span under the active one (or a new trace). */
  startSpan(name: string, opts: { kind?: 1 | 2 | 3; attributes?: Attrs; parent?: { traceId: string; spanId: string; sampled: boolean } } = {}): Span {
    const parent = opts.parent ?? this.platform.activeSpan();
    return new Span(this.enabled ? this : null, name, opts.kind ?? 1, parent, opts.attributes);
  }

  /** Runs fn inside a span; the span ends when fn (or its promise) does. */
  trace<T>(name: string, fn: (span: Span) => T, attributes?: Attrs): T {
    const span = this.startSpan(name, { attributes });
    let out: T;
    try {
      out = this.platform.withSpan(span, () => fn(span));
    } catch (err) {
      span.end(err);
      throw err;
    }
    if (out && typeof (out as { then?: unknown }).then === 'function') {
      return (out as unknown as Promise<unknown>).then(
        (v) => {
          span.end();
          return v;
        },
        (err: unknown) => {
          span.end(err);
          throw err;
        },
      ) as T;
    }
    span.end();
    return out;
  }

  recordSpan(s: SpanData): void {
    if (!this.enabled) return;
    if (s.attributes) s.attributes = scrub(s.attributes);
    this.spanBuf.push(s);
    if (this.spanBuf.length >= MAX_SPANS) this.flushSpans();
  }

  // ---- crons ----

  /** Reports a cron run to the Argus cron monitor with this slug. */
  checkIn(slug: string, status: 'start' | 'ok' | 'error' | number, output?: string): void {
    if (!this.enabled) return;
    const kind = status === 'start' ? '/start' : status === 'error' ? '/fail' : typeof status === 'number' ? `/${status}` : '';
    this.otel('crons', `/v1/cron/${encodeURIComponent(slug)}${kind}`, output ? scrubString(output).slice(0, 2048) : '', 'text/plain;charset=UTF-8');
  }

  /** Runs a job and reports it: start, then ok or error. Rethrows the job's error. */
  async withMonitor<T>(slug: string, job: () => T | Promise<T>): Promise<T> {
    this.checkIn(slug, 'start');
    try {
      const v = await job();
      this.checkIn(slug, 'ok');
      return v;
    } catch (err) {
      this.checkIn(slug, 'error', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  // ---- flags ----

  /**
   * Every flag's variant for a subject (a user id), cached for 30 s. {} (so
   * the caller's fallback) when Argus can't answer within 2 s, refused the key
   * (401/403: not asked again until restart) or is rate limiting (429: not
   * asked again until Retry-After passes).
   */
  async evaluateFlags(subject: string, attributes?: Record<string, string>): Promise<Record<string, string>> {
    if (!this.enabled || !subject) return {};
    const cacheKey = `${subject}|${JSON.stringify(attributes ?? {})}`;
    const hit = this.flagCache.get(cacheKey);
    if (hit && Date.now() - hit.at < FLAGS_CACHE_MS) return hit.flags;
    const stale = hit?.flags ?? {};
    if (this.flagsDead || Date.now() < this.flagsBlockedUntil) return stale;
    const d = this.dsn as Dsn;
    const ac = typeof AbortController === 'function' ? new AbortController() : undefined;
    const timer = setTimeout(() => ac?.abort(), FLAGS_TIMEOUT_MS) as unknown as { unref?: () => void };
    timer.unref?.();
    try {
      const request = (this.options.fetch ?? this.platform.fetch)(ingestUrl(d, '/v1/flags/evaluate', this.platform.keyInUrl), {
        method: 'POST',
        headers: this.platform.keyInUrl
          ? { 'Content-Type': 'text/plain;charset=UTF-8' }
          : { 'Content-Type': 'application/json', Authorization: `Bearer ${d.publicKey}`, ...this.uaHeader() },
        body: JSON.stringify({ subject, environment: this.options.environment, attributes: attributes ?? {} }),
        signal: ac?.signal,
      });
      // The timeout holds even for a fetch that ignores the signal.
      const res = await Promise.race([
        request,
        new Promise<never>((_r, reject) => {
          ac?.signal.addEventListener('abort', () => reject(new Error('flags: timed out')));
        }),
      ]);
      if (res.status === 401 || res.status === 403) {
        this.flagsDead = true;
        if (this.options.debug) console.warn(`[argus] flags: ${res.status}, the key was refused; stopping until restart`);
        return stale;
      }
      if (res.status === 429) {
        this.flagsBlockedUntil = Date.now() + retryAfterMs(res.headers);
        return stale;
      }
      if (!res.ok) return stale;
      const raw = ((await res.json()) as { flags?: unknown }).flags;
      const out: Record<string, string> = {};
      if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) out[k] = String(v);
      if (this.flagCache.size > 1000) this.flagCache.clear();
      this.flagCache.set(cacheKey, { at: Date.now(), flags: out });
      return out;
    } catch (err) {
      if (this.options.debug) console.warn(`[argus] flags: ${String(err)}`);
      return stale;
    } finally {
      clearTimeout(timer as unknown as ReturnType<typeof setTimeout>);
    }
  }

  /** A flag's variant, or fallback when it's unknown or Argus can't be reached. */
  async variant(key: string, subject: string, fallback: string, attributes?: Record<string, string>): Promise<string> {
    const flags = await this.evaluateFlags(subject, attributes);
    return flags[key] ?? fallback;
  }

  /** Whether a boolean flag is on for a subject; fallback when unknown. */
  async isOn(key: string, subject: string, fallback = false, attributes?: Record<string, string>): Promise<boolean> {
    const v = await this.variant(key, subject, fallback ? 'on' : 'off', attributes);
    return v === 'on' || v === 'true';
  }

  // ---- sending ----

  private resource(): Attrs {
    return {
      'service.name': this.options.serviceName || 'app',
      'service.version': this.options.release,
      'deployment.environment': this.options.environment,
      'telemetry.sdk.name': this.platform.sdkName,
      'telemetry.sdk.version': VERSION,
      'argus.contract': CONTRACT,
    };
  }

  private uaHeader(): Record<string, string> {
    return this.platform.userAgent ? { 'User-Agent': this.platform.userAgent } : {};
  }

  private otel(lane: string, path: string, body: string, contentType = 'application/json'): void {
    const d = this.dsn as Dsn;
    this.transport.send(lane, {
      url: ingestUrl(d, path, this.platform.keyInUrl),
      body,
      headers: this.platform.keyInUrl
        ? { 'Content-Type': contentType }
        : { 'Content-Type': contentType, Authorization: `Bearer ${d.publicKey}`, ...this.uaHeader() },
    });
  }

  /** Builds an OTLP body, halving the batch until each body is at most 512 KB. */
  private otlp<T>(lane: string, path: string, build: (resource: Attrs, items: T[]) => string, items: T[]): void {
    const body = build(this.resource(), items);
    if (items.length > 1 && byteLength(body) > MAX_OTLP_BODY) {
      const half = Math.ceil(items.length / 2);
      this.otlp(lane, path, build, items.slice(0, half));
      this.otlp(lane, path, build, items.slice(half));
      return;
    }
    this.otel(lane, path, body);
  }

  flushLogs(): void {
    if (!this.logBuf.length || !this.dsn) return;
    this.otlp('logs', '/v1/logs', logsRequest, this.logBuf.splice(0, MAX_LOGS));
  }

  flushSpans(): void {
    if (!this.spanBuf.length || !this.dsn) return;
    this.otlp('traces', '/v1/traces', tracesRequest, this.spanBuf.splice(0, MAX_SPANS));
  }

  flushMetrics(): void {
    if (!this.metricAgg.size || !this.dsn) return;
    const end = Date.now();
    const points: MetricPoint[] = [];
    for (const m of this.metricAgg.values()) {
      if (m.kind === 'sum') points.push({ kind: 'sum', name: m.name, unit: m.unit, attributes: m.attributes, value: m.value, startMs: this.metricStart, endMs: end });
      else if (m.kind === 'gauge') points.push({ kind: 'gauge', name: m.name, unit: m.unit, attributes: m.attributes, value: m.value, endMs: end });
      else
        points.push({
          kind: 'histogram',
          name: m.name,
          unit: m.unit,
          attributes: m.attributes,
          count: m.count,
          sum: m.sum,
          min: m.min,
          max: m.max,
          bounds: HIST_BOUNDS,
          buckets: m.buckets,
          startMs: this.metricStart,
          endMs: end,
        });
    }
    this.metricAgg.clear();
    this.metricStart = end;
    this.otlp('metrics', '/v1/metrics', metricsRequest, points);
  }

  /** Sends everything queued. Resolves true when it all went out within timeoutMs. */
  async flush(timeoutMs = 2000): Promise<boolean> {
    this.flushLogs();
    this.flushSpans();
    this.flushMetrics();
    return this.transport.flush(timeoutMs);
  }

  /** Flushes, then stops sending. */
  async close(timeoutMs = 2000): Promise<boolean> {
    const ok = await this.flush(timeoutMs);
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    return ok;
  }
}

/** The error and its causes, oldest (deepest cause) first, as Argus expects. */
export function exceptionChain(error: unknown): { type: string; value: string; stacktrace?: { frames: Frame[] } }[] {
  const out: { type: string; value: string; stacktrace?: { frames: Frame[] } }[] = [];
  let cur: unknown = error;
  for (let i = 0; i < 5 && cur !== undefined && cur !== null; i++) {
    if (cur instanceof Error) {
      const frames = parseStack(cur.stack);
      out.unshift({ type: cur.name || 'Error', value: cur.message, ...(frames.length ? { stacktrace: { frames } } : {}) });
      cur = (cur as { cause?: unknown }).cause;
    } else {
      let value: string;
      try {
        value = typeof cur === 'string' ? cur : JSON.stringify(cur);
      } catch {
        value = String(cur);
      }
      out.unshift({ type: 'Error', value: `Non-Error thrown: ${value}`.slice(0, 1000) });
      break;
    }
  }
  return out;
}
