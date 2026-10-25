/**
 * Sending (spec §6): one queue per endpoint, never blocking the app and never
 * throwing. Network errors and 5xx back off and retry; 429 waits Retry-After;
 * any other 4xx drops the request.
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

interface Lane {
  queue: Request[];
  bytes: number;
  busy: Promise<void> | null;
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
      l = { queue: [], bytes: 0, busy: null, blockedUntil: 0, dead: false };
      this.lanes.set(name, l);
    }
    return l;
  }

  /** Queues a request on a lane. Returns false when it was dropped. */
  send(laneName: string, req: Request): boolean {
    const l = this.lane(laneName);
    if (l.dead) return false;
    if (this.now() < l.blockedUntil) {
      this.log(`${laneName}: rate limited, dropping`);
      return false;
    }
    l.queue.push(req);
    l.bytes += req.body.length;
    while (l.queue.length > MAX_ITEMS || l.bytes > MAX_BYTES) {
      const old = l.queue.shift();
      if (old) l.bytes -= old.body.length;
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
      const done = await this.attempt(name, l, req);
      if (l.queue[0] === req) {
        l.queue.shift();
        l.bytes -= req.body.length;
      }
      if (!done) break;
    }
  }

  /** Sends one request with retries. False stops the lane for now (rate limited, or dead). */
  private async attempt(name: string, l: Lane, req: Request): Promise<boolean> {
    for (let tryNo = 0; tryNo < MAX_TRIES; tryNo++) {
      let res: Response;
      try {
        res = await this.opts.fetch(req.url, { method: 'POST', body: req.body, headers: req.headers, keepalive: req.body.length < 60_000 });
      } catch (err) {
        if (req.persist && this.opts.onOffline?.(name, req)) return true;
        this.log(`${name}: network error (${String(err)}), try ${tryNo + 1}`);
        await this.sleep(Math.min(60_000, 1000 * 2 ** tryNo));
        continue;
      }
      if (res.ok) return true;
      if (res.status === 429) {
        l.blockedUntil = this.now() + retryAfterMs(res.headers);
        this.log(`${name}: 429, waiting ${l.blockedUntil - this.now()} ms`);
        l.queue.splice(0);
        l.bytes = 0;
        return false;
      }
      if (res.status === 401 || res.status === 403) {
        this.log(`${name}: ${res.status}, the key was refused; stopping this endpoint until restart`);
        l.dead = true;
        l.queue.splice(0);
        l.bytes = 0;
        return false;
      }
      if (res.status >= 400 && res.status < 500) {
        this.log(`${name}: ${res.status}, dropped`);
        return true;
      }
      this.log(`${name}: ${res.status}, try ${tryNo + 1}`);
      await this.sleep(Math.min(60_000, 1000 * 2 ** tryNo));
    }
    return true;
  }

  private log(msg: string): void {
    if (this.opts.debug) console.warn(`[argus] ${msg}`);
  }
}

/** Reads Retry-After, then X-Sentry-Rate-Limits; at least 1 s, at most 1 h. */
export function retryAfterMs(h: Headers): number {
  const ra = Number(h.get('retry-after'));
  let s = Number.isFinite(ra) && ra > 0 ? ra : 0;
  if (!s) {
    const rl = h.get('x-sentry-rate-limits');
    const first = rl ? Number(rl.split(':')[0]) : 0;
    s = Number.isFinite(first) && first > 0 ? first : 60;
  }
  return Math.min(3600, Math.max(1, s)) * 1000;
}
