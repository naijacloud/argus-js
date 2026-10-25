let fill: (b: Uint8Array) => Uint8Array = (b) => {
  const c = (globalThis as { crypto?: { getRandomValues?: (b: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) return c.getRandomValues(b);
  for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
  return b;
};

/** Lets a platform supply its own random source (Node 18 has no global crypto). */
export function setRandom(f: (b: Uint8Array) => Uint8Array): void {
  fill = f;
}

/** n random bytes as lowercase hex. */
export function hex(n: number): string {
  const b = fill(new Uint8Array(n));
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export const eventId = (): string => hex(16);
export const traceId = (): string => hex(16);
export const spanId = (): string => hex(8);
