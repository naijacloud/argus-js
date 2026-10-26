import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The app's package.json name, read from the working directory, else the name
 * npm reports for the running script. Undefined when neither is there.
 */
export function packageName(dir: string = process.cwd()): string | undefined {
  try {
    const name = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }).name;
    if (typeof name === 'string' && name.trim()) return name.trim();
  } catch {
    /* no package.json, or not JSON */
  }
  return process.env.npm_package_name?.trim() || undefined;
}
