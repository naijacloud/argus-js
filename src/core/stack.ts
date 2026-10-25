/** One stack frame in the order Argus wants: oldest first (spec §4). */
export interface Frame {
  filename?: string;
  abs_path?: string;
  function?: string;
  module?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
}

// V8: "    at fn (file:1:2)", "    at file:1:2", "    at async fn (file:1:2)"
const V8 = /^\s*at (?:(?:async )?(.+?) )?\(?((?:file|https?|blob|chrome-extension|webpack|node|\/|[a-zA-Z]:\\|<anonymous>)[^)]*?)(?::(\d+))?(?::(\d+))?\)?\s*$/;
// Firefox / Safari: "fn@file:1:2", "@file:1:2"
const GECKO = /^\s*(.*?)@(.+?)(?::(\d+))?(?::(\d+))?\s*$/;

function inApp(path: string): boolean {
  return !(
    path.includes('/node_modules/') ||
    path.startsWith('node:') ||
    path.startsWith('internal/') ||
    path === '<anonymous>' ||
    path === 'native'
  );
}

function frameFrom(fn: string | undefined, path: string, line?: string, col?: string): Frame {
  const abs = path.startsWith('file://') ? path.slice(7) : path;
  let filename = abs;
  if (/^https?:\/\//.test(abs)) {
    try {
      filename = new URL(abs).pathname;
    } catch {
      /* keep abs */
    }
  }
  const f: Frame = { abs_path: abs, filename, in_app: inApp(abs) };
  const name = fn?.trim();
  if (name && name !== '<anonymous>') f.function = name.replace(/^Object\./, '');
  if (line) f.lineno = Number(line);
  if (col) f.colno = Number(col);
  return f;
}

/** Parses an Error's `stack`. Unknown lines are skipped; at most 100 frames are kept. */
export function parseStack(stack: string | undefined): Frame[] {
  if (!stack) return [];
  const frames: Frame[] = [];
  for (const line of stack.split('\n').slice(0, 200)) {
    let m = V8.exec(line);
    if (m && line.trimStart().startsWith('at ')) {
      frames.push(frameFrom(m[1], m[2] ?? '', m[3], m[4]));
      continue;
    }
    m = GECKO.exec(line);
    if (m && m[2] && /[:/]/.test(m[2])) frames.push(frameFrom(m[1] || undefined, m[2], m[3], m[4]));
  }
  return frames.slice(0, 100).reverse();
}
