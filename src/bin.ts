#!/usr/bin/env node
/**
 * `npx @naijacloud/argus test [--dsn <dsn>]`: sends one test error, so you can
 * see it arrive in Argus. Uses ARGUS_DSN (then SENTRY_DSN) when --dsn is absent.
 */
import { close, init } from './node/index.js';

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd !== 'test') {
    console.log('usage: argus test [--dsn <dsn>]\n\nSends one test error to Argus. Uses ARGUS_DSN when --dsn is not given.');
    return cmd === undefined || cmd === '--help' || cmd === '-h' ? 0 : 2;
  }
  const i = rest.indexOf('--dsn');
  const dsn = i >= 0 ? rest[i + 1] : (process.env.ARGUS_DSN ?? process.env.SENTRY_DSN);
  if (!dsn) {
    console.error('No DSN: pass --dsn <dsn> or set ARGUS_DSN. Copy it from the source in Argus.');
    return 2;
  }
  let status = 0;
  const client = init({
    dsn,
    fetch: async (url, opts) => {
      const res = await fetch(url, opts);
      status = res.status;
      return res;
    },
  });
  if (!client.enabled) {
    console.error('That DSN is not valid. It looks like https://<key>@argus-in.naijacloud.com/<number>.');
    return 2;
  }
  const id = client.captureMessage('Argus test event from @naijacloud/argus', 'info', { tags: { argus_test: 'true' } });
  const ok = await close(10_000);
  if (!ok || status < 200 || status >= 300) {
    console.error(`Argus didn't accept the test event (HTTP ${status || 'no response'}). Check the DSN.`);
    return 1;
  }
  console.log(`Sent. Look for event ${id} in Argus under Errors.`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
