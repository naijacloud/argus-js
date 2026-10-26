/**
 * Sending (spec §6): one queue per endpoint, never blocking the app and never
 * throwing.
 *
 * - network errors and 5xx back off 1 s, 2 s, 4 s … (capped at 60 s), 5 tries;
 * - 429 waits `Retry-After` (or `X-Sentry-Rate-Limits`), sends nothing on that
 *   endpoint until then, then resends the held request; the wait is not a try;
 * - 401 and 403 stop the endpoint until restart;
 * - any other 4xx drops that request only;
 * - at most 100 requests and 1 MB per endpoint; when full, the oldest waiting
 *   request is dropped (never the one in flight).
 */

export interface Request {
  url: string;
  body: string;
  headers: Record<string, string>;
  /** Browser: may be written to storage when the network is down. */
  persist?: boolean;
}

export interface TransportOptions {
  fetch: typeof fetch;
  debug?: boolean;
  /** Called with a request the network refused, instead of retrying (browser offline queue). */
  onOffline?: (lane: string, req: Request) => boolean;
  /** Test hook. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const MAX_ITEMS = 100;
const MAX_BYTES = 1 << 20;
const MAX_TRIES = 5;
/** A request held back by 429s is resent this many times, then dropped, so a server that answers 429 forever can't pin it in memory. */
const MAX_429_WAITS = 10;

interface Lane {
  queue: Request[];
  bytes: number;
  busy: Promise<void> | null;
  /** The request being sent, which the size bounds never drop. */
  inFlight: Request | null;
  blockedUntil: number;
  dead: boolean;
}

export class Transport {
  private lanes = new Map<string, Lane>();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly opts: TransportOptions) {
    this.sleep =
      opts.sleep ??
      ((ms) =>
        new Promise((r) => {
          const t = setTimeout(r, ms) as unknown as { unref?: () => void };
          t.unref?.();
        }));
    this.now = opts.now ?? Date.now;
  }

  private lane(name: string): Lane {
    let l = this.lanes.get(name);
    if (!l) {
      l = { queue: [], bytes: 0, busy: null, inFlight: null, blockedUntil: 0, dead: false };
      this.lanes.set(name, l);
    }
    return l;
  }

  /** Queues a request on a lane. Returns false when it was dropped. */
  send(laneName: string, req: Request): boolean {
    const l = this.lane(laneName);
    if (l.dead) return false;
    // A rate-limited endpoint keeps queuing (within the bounds); the pump
    // sends nothing until the wait is over.
    l.queue.push(req);
    l.bytes += req.body.length;
    // Drop the oldest, but never the request in flight, and always keep the
    // newest so an oversize one still gets its chance.
    const start = l.inFlight && l.queue[0] === l.inFlight ? 1 : 0;
    while ((l.queue.length > MAX_ITEMS || l.bytes > MAX_BYTES) && l.queue.length > start + 1) {
      const [old] = l.queue.splice(start, 1);
      if (old) l.bytes -= old.body.length;
      this.log(`${laneName}: queue full, dropped the oldest request`);
    }
    if (!l.busy) l.busy = this.pump(laneName, l).finally(() => (l.busy = null));
    return true;
  }

  /** Resolves when every lane is empty, or after timeoutMs. True when everything was sent. */
  async flush(timeoutMs = 2000): Promise<boolean> {
    const all = Promise.all([...this.lanes.values()].map((l) => l.busy ?? Promise.resolve())).then(() => true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((r) => {
      timer = setTimeout(() => r(false), timeoutMs);
    });
    try {
      return await Promise.race([all, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Requests still queued (for the browser's pagehide beacon). */
  drain(laneName: string): Request[] {
    const l = this.lanes.get(laneName);
    if (!l) return [];
    const out = l.queue.splice(0);
    l.bytes = 0;
    return out;
  }

  private async pump(name: string, l: Lane): Promise<void> {
    while (l.queue.length && !l.dead) {
      const req = l.queue[0] as Request;
      l.inFlight = req;
      try {
        await this.attempt(name, l, req);
      } finally {
        l.inFlight = null;
      }
      if (l.queue[0] === req) {
        l.queue.shift();
        l.bytes -= req.body.length;
      }
    }
  }

  /** Sends one request with retries. Returns when it was sent, dropped, or the endpoint stopped. */
  private async attempt(name: string, l: Lane, req: Request): Promise<void> {
    let tries = 0;
    let waits429 = 0;
    while (tries < MAX_TRIES) {
      const wait = l.blockedUntil - this.now();
      if (wait > 0) {
        await this.sleep(wait);
        // Drained meanwhile (the browser's pagehide beacon took it).
        if (l.queue[0] !== req || l.dead) return;
      }
      let res: Response;
      try {
        res = await this.opts.fetch(req.url, { method: 'POST', body: req.body, headers: req.headers, keepalive: req.body.length < 60_000 });
      } catch (err) {
        if (req.persist && this.opts.onOffline?.(name, req)) return;
        tries++;
        this.log(`${name}: network error (${String(err)}), try ${tries}`);
        if (tries < MAX_TRIES) await this.sleep(backoffMs(tries));
        continue;
      }
      if (res.ok) return;
      if (res.status === 429) {
        const ms = retryAfterMs(res.headers);
        l.blockedUntil = this.now() + ms;
        if (++waits429 > MAX_429_WAITS) {
          this.log(`${name}: 429 ${waits429} times, dropped`);
          return;
        }
        this.log(`${name}: 429, sending nothing on this endpoint for ${ms} ms, then resending`);
        continue; // not counted as a try
      }
      if (res.status === 401 || res.status === 403) {
        this.log(`${name}: ${res.status}, the key was refused; stopping this endpoint until restart`);
        l.dead = true;
        l.queue.splice(1);
        l.bytes = req.body.length;
        return;
      }
      if (res.status >= 300 && res.status < 500) {
        this.log(`${name}: ${res.status}, dropped`);
        return;
      }
      tries++;
      this.log(`${name}: ${res.status}, try ${tries}`);
      if (tries < MAX_TRIES) await this.sleep(backoffMs(tries));
    }
  }

  private log(msg: string): void {
    if (this.opts.debug) console.warn(`[argus] ${msg}`);
  }
}

const backoffMs = (tries: number): number => Math.min(60_000, 1000 * 2 ** (tries - 1));

/** Reads Retry-After (seconds or an HTTP date), then X-Sentry-Rate-Limits; at least 1 s, at most 1 h. */
export function retryAfterMs(h: Headers, now: number = Date.now()): number {
  let s = 0;
  const ra = h.get('retry-after')?.trim();
  if (ra) {
    const n = Number(ra);
    if (Number.isFinite(n)) s = n;
    else {
      const when = Date.parse(ra);
      if (Number.isFinite(when)) s = (when - now) / 1000;
    }
  }
  if (!(s > 0)) {
    const rl = h.get('x-sentry-rate-limits');
    const first = rl ? Number(rl.split(',')[0]?.split(':')[0]) : 0;
    s = Number.isFinite(first) && first > 0 ? first : 60;
  }
  return Math.min(3600, Math.max(1, s)) * 1000;
}
