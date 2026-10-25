import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Received {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: string;
}

/** A loopback stand-in for Argus ingest that records what it receives. */
export class FakeArgus {
  received: Received[] = [];
  /** Status to answer per path prefix; default 200. */
  status: Record<string, number> = {};
  headers: Record<string, Record<string, string>> = {};
  flags: Record<string, string> = {};
  private server: Server;
  port = 0;

  constructor() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const u = new URL(req.url ?? '/', 'http://x');
        this.received.push({ method: req.method ?? '', path: u.pathname, query: u.searchParams, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        const prefix = Object.keys(this.status).find((p) => u.pathname.startsWith(p));
        const code = prefix ? (this.status[prefix] as number) : 200;
        for (const [k, v] of Object.entries((prefix && this.headers[prefix]) || {})) res.setHeader(k, v);
        res.statusCode = code;
        res.setHeader('Content-Type', 'application/json');
        if (u.pathname === '/v1/flags/evaluate') res.end(JSON.stringify({ flags: this.flags, environment: 'production' }));
        else res.end(u.pathname.includes('/envelope/') ? '{"id":"x"}' : '{}');
      });
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  get dsn(): string {
    return `http://0000public0000key@127.0.0.1:${this.port}/42`;
  }

  on(path: string): Received[] {
    return this.received.filter((r) => r.path === path || r.path.startsWith(path));
  }

  /** The event payload of every envelope received. */
  events(): Record<string, any>[] {
    return this.on('/api/42/envelope/').map((r) => JSON.parse(r.body.trim().split('\n')[2] as string));
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}
