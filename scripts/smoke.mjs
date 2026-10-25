#!/usr/bin/env node
/**
 * The built package on the oldest supported Node. The test tools need Node 22,
 * but the package promises Node 18, so CI builds once on 22 and runs this on
 * 18 and 20: start an app with `--import register` against a loopback stand-in
 * for Argus and check an error, a span and a log arrive. Needs `npm run build`.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const got = [];
const argus = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    got.push({ path: new URL(req.url, 'http://x').pathname, body });
    res.setHeader('Content-Type', 'application/json');
    res.end('{}');
  });
});
await new Promise((r) => argus.listen(0, '127.0.0.1', r));
const dsn = `http://0000smoke0000@127.0.0.1:${argus.address().port}/7`;

const dir = mkdtempSync(join(tmpdir(), 'argus-smoke-'));
writeFileSync(
  join(dir, 'app.mjs'),
  `import http from 'node:http';
   import { captureException, log, flush } from ${JSON.stringify(join(dist, 'index.js'))};
   const s = http.createServer((q, r) => { log.info('hello'); captureException(new Error('smoke')); r.end(); });
   await new Promise((r) => s.listen(0, '127.0.0.1', r));
   await fetch('http://127.0.0.1:' + s.address().port + '/smoke');
   await flush(3000);
   process.exit(0);`,
);
const code = await new Promise((resolve) => {
  const p = spawn(process.execPath, ['--import', join(dist, 'register.js'), join(dir, 'app.mjs')], {
    env: { PATH: process.env.PATH, ARGUS_DSN: dsn },
    stdio: 'inherit',
  });
  p.on('exit', resolve);
});
argus.close();

assert.equal(code, 0, 'the app exited non-zero');
assert.ok(got.some((g) => g.path === '/api/7/envelope/' && g.body.includes('"smoke"')), 'no error envelope arrived');
assert.ok(got.some((g) => g.path === '/v1/traces' && g.body.includes('GET /smoke')), 'no request span arrived');
assert.ok(got.some((g) => g.path === '/v1/logs' && g.body.includes('hello')), 'no log arrived');
console.log(`✓ smoke on Node ${process.version}: error, span and log arrived`);
