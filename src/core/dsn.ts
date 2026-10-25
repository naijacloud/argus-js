/** A parsed DSN: `https://<publicKey>@<host>/<projectId>`. */
export interface Dsn {
  publicKey: string;
  projectId: string;
  /** `https://argus-in.naijacloud.com`, with any path prefix before the project id. */
  origin: string;
  raw: string;
}

/** Parses a DSN, or returns null for anything that isn't one. Never throws. */
export function parseDsn(raw: string | undefined | null): Dsn | null {
  if (!raw || typeof raw !== 'string') return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const publicKey = decodeURIComponent(u.username);
  const parts = u.pathname.split('/').filter(Boolean);
  const projectId = parts.pop();
  if (!publicKey || !projectId || !/^\d+$/.test(projectId)) return null;
  const prefix = parts.length ? `/${parts.join('/')}` : '';
  return { publicKey, projectId, origin: `${u.protocol}//${u.host}${prefix}`, raw: raw.trim() };
}

/** The error endpoint for a DSN (spec §3). */
export function envelopeUrl(d: Dsn, withKey: boolean): string {
  const base = `${d.origin}/api/${d.projectId}/envelope/`;
  return withKey ? `${base}?sentry_key=${encodeURIComponent(d.publicKey)}&sentry_version=7` : base;
}

/** An ingest endpoint authenticated with ?key= (browsers) or nothing (servers use a header). */
export function ingestUrl(d: Dsn, path: string, withKey: boolean): string {
  const base = `${d.origin}${path}`;
  return withKey ? `${base}${base.includes('?') ? '&' : '?'}key=${encodeURIComponent(d.publicKey)}` : base;
}
