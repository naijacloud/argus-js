/**
 * Privacy defaults (spec §7). The same rules Argus applies again on arrival;
 * the SDK doesn't rely on that.
 */
export const FILTERED = '[Filtered]';

const CONTAINS = [
  'password', 'passwd', 'secret', 'token', 'apikey', 'accesskey', 'authorization',
  'credential', 'cookie', 'privatekey', 'cardnumber', 'creditcard', 'bvn', 'cvv', 'cvc',
  'sessionid', 'sessiontoken', 'signature',
];
const EXACT = new Set(['auth', 'pwd', 'pin', 'otp', 'session', 'card', 'sid']);

/** Whether a field name's value should be filtered. */
export function sensitiveKey(key: string): boolean {
  const n = key.toLowerCase().replace(/[-_ ]/g, '');
  if (EXACT.has(n)) return true;
  return CONTAINS.some((c) => n.includes(c));
}

const CARD = /\b(?:\d[ -]?){12,18}\d\b/g;
const BEARER = /\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
// The value of a sensitive pair, unless it is already filtered or is a
// `Bearer …` credential (the pattern above has filtered its secret part).
const VALUE = String.raw`(?!\[Filtered\])(?!(?:bearer|basic|token)\s)([^"'\s,;&})<>\[\]]+)`;
// `key=value`, `key: value` and JSON `"key": "value"` where the key contains a
// word from the spec's contains list, spelled to allow `_`/`-` inside it.
const KV = new RegExp(
  String.raw`\b([a-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|authorization` +
    String.raw`|credential|cookie|private[_-]?key|card[_-]?number|credit[_-]?card|bvn|cvv|cvc` +
    String.raw`|session[_-]?id|session[_-]?token|signature)[a-z0-9_-]*)(["']?\s*[:=]\s*)(["']?)` +
    VALUE,
  'gi',
);
// The spec's exact keys. Only `=` counts: "pin: 1234" is rare, while
// "session: started" or "card: declined" in a log line are not secrets.
// (A capture, not a lookbehind, so older Safari can still parse it.)
const KV_EXACT = new RegExp(String.raw`(^|[^A-Za-z0-9_-])(auth|pwd|pin|otp|session|card|sid)(["']?\s*=\s*)(["']?)` + VALUE, 'gi');

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Filters card numbers, credentials, JWTs and sensitive `key=value` / `key: value` / JSON pairs inside a string. */
export function scrubString(s: string): string {
  if (!s) return s;
  return s
    .replace(CARD, (m) => {
      const digits = m.replace(/[ -]/g, '');
      return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? FILTERED : m;
    })
    .replace(BEARER, (_m, scheme: string) => `${scheme} ${FILTERED}`)
    .replace(JWT, FILTERED)
    .replace(KV, (_m, k: string, sep: string, q: string) => `${k}${sep}${q}${FILTERED}`)
    .replace(KV_EXACT, (_m, pre: string, k: string, sep: string, q: string) => `${pre}${k}${sep}${q}${FILTERED}`);
}

/** Deep-scrubs a JSON-like value. Cycles and depth beyond 8 are cut. */
export function scrub<T>(value: T, depth = 0, seen: WeakSet<object> = new WeakSet()): T {
  if (typeof value === 'string') return scrubString(value) as T;
  if (value === null || typeof value !== 'object') return value;
  if (depth > 8 || seen.has(value as object)) return '[…]' as T;
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1, seen)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = sensitiveKey(k) && v !== null && v !== undefined && v !== '' ? FILTERED : scrub(v, depth + 1, seen);
  }
  return out as T;
}

/** Removes the query string and fragment from a URL, keeping it readable. */
export function stripQuery(url: string): string {
  const i = url.search(/[?#]/);
  return i === -1 ? url : url.slice(0, i);
}
