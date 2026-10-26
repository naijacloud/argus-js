<p align="center">
  <a href="https://www.naijacloud.com/argus">
    <img alt="Naijacloud Argus, JavaScript SDK" src="https://raw.githubusercontent.com/naijacloud/argus-js/main/.github/assets/banner.png" width="100%">
  </a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@naijacloud/argus"><img alt="npm" src="https://img.shields.io/badge/npm-@naijacloud%2Fargus-008751?style=flat-square&labelColor=0A0E0C"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D_18.18-3178C6?style=flat-square&labelColor=0A0E0C">
  <img alt="dependencies" src="https://img.shields.io/badge/dependencies-0-46C98A?style=flat-square&labelColor=0A0E0C">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-8A988F?style=flat-square&labelColor=0A0E0C"></a>
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#nodejs">Node.js</a> ·
  <a href="#nextjs">Next.js</a> ·
  <a href="#browser">Browser</a> ·
  <a href="#errors">Errors</a> ·
  <a href="#logs-metrics-and-traces">Logs, metrics, traces</a> ·
  <a href="#cron-check-ins">Crons</a> ·
  <a href="#feature-flags">Flags</a> ·
  <a href="#privacy">Privacy</a>
</p>

# @naijacloud/argus

The official JavaScript SDK for [Argus](https://www.naijacloud.com/argus),
Naijacloud's monitoring. One package sends errors, logs, metrics, traces, cron
check-ins and feature-flag checks, with one key: your app's **DSN**.

It has no dependencies, implements the Argus SDK contract `argus.sdk/1`, and
works for apps hosted anywhere, not only on Naijacloud.

**Already using Sentry's library?** Keep it. Argus accepts it: change the `dsn`
line and you're done. Switch to this SDK when you want logs, metrics, cron
check-ins and flags through the same setup.

## Install

```sh
npm install @naijacloud/argus
```

Copy the DSN (your app's key) from the source in Argus. It looks like
`https://<key>@argus-in.naijacloud.com/<number>`.

## Node.js

Start your app with the flag. Argus then loads before your own imports:

```sh
ARGUS_DSN=https://…@argus-in.naijacloud.com/41 node --import @naijacloud/argus/register app.js
```

That's it. You get:

- **Uncaught exceptions and unhandled rejections.** The process still exits
  with code 1, as Node does without a handler.
- **Incoming requests traced automatically,** on any `node:http` or
  `node:https` server: Express, Fastify, NestJS, Koa and plain `http`. A
  `traceparent` header from the caller continues its trace.
- **Outgoing `fetch()` calls** as child spans, with a `traceparent` header
  added, and breadcrumbs.
- **`console` calls as breadcrumbs** on the next error.

The flag works for ESM and CommonJS. It reads `ARGUS_DSN`, `ARGUS_RELEASE` and
`ARGUS_ENVIRONMENT`, falling back to `SENTRY_DSN`, `SENTRY_RELEASE` and
`SENTRY_ENVIRONMENT`. Without a DSN it does nothing. Apps hosted on Naijacloud
get these variables set when the Argus tab is on.

**Express** catches errors from your routes itself, so add one line after them:

```js
import { argusErrorHandler } from '@naijacloud/argus';
app.use(argusErrorHandler());
```

**NestJS** catches errors in its exception filters. Report the ones you want
from a filter with `captureException(exception)`.

**Prefer code to a flag?** Call `init()` first thing in your entry file. For
ESM, the flag is more reliable, because imports load before any code runs.

```js
const { init } = require('@naijacloud/argus');
init({ dsn: process.env.ARGUS_DSN, release: '1.4.2' });
```

## Next.js

Two files, one import:

```ts
// instrumentation.ts
import { init } from '@naijacloud/argus/next';
export const register = () => init({ dsn: process.env.ARGUS_DSN });
export { onRequestError } from '@naijacloud/argus/next';
```

```ts
// instrumentation-client.ts
import { init } from '@naijacloud/argus/next';
init({ dsn: process.env.NEXT_PUBLIC_ARGUS_DSN });
```

The server file covers route handlers, server actions and rendering errors
(`onRequestError`, Next.js 15+). The client file covers the browser. The same
import resolves to the right build in each. Argus doesn't run in the Edge
runtime yet: nothing is reported from Edge routes or middleware.

## Browser

```js
import { init } from '@naijacloud/argus/browser';
init({ dsn: 'https://…@argus-in.naijacloud.com/41', release: 'web@1.4.2' });
```

- **Errors:** uncaught errors and promise rejections.
- **Breadcrumbs:** clicks (which element was clicked, never what was typed),
  navigation, `console`, `fetch` and XHR.
- **Offline:** errors raised while offline are kept in `localStorage` (up to 30)
  and sent when the browser is back online.

The DSN's key is safe in a browser: it can only send data to that one source.

## Errors

```js
import { captureException, captureMessage, setUser, setTag, addBreadcrumb } from '@naijacloud/argus';

try {
  await chargeCard(order);
} catch (err) {
  captureException(err, { tags: { provider: 'paystack' }, extra: { orderId: order.id } });
}

captureMessage('Webhook signature mismatch', 'warning');
setUser({ id: user.id });
setTag('region', 'af-west');
```

- **Causes:** an error's `cause` chain is sent too.
- **Duplicates:** the same error object is sent once, however many handlers
  see it.
- **`beforeSend(event)`** lets you change an event, or return `null` to drop it.

## Logs, metrics and traces

```js
import { log, metrics, trace } from '@naijacloud/argus';

log.info('order placed', { orderId: 'ord_81', total: 18500 });
log.error('paystack timed out', { attempt: 3 });

metrics.count('orders.placed', 1, { method: 'card' });
metrics.gauge('queue.depth', jobs.length);
metrics.distribution('checkout.ms', elapsed, undefined, 'ms');

await trace('charge card', async (span) => {
  span?.setAttribute('provider', 'paystack');
  await paystack.charge(order);
});
```

- **Logs** are sent in batches every 5 seconds. A log written inside a request
  carries that request's trace id. Set `captureConsole: true` to also send
  `console.info`, `console.warn` and `console.error` as logs.
- **Metrics** are added up and sent every 10 seconds.
- **Spans** join the request they run in.
- **Sample traces** with `tracesSampleRate` (0–1, default 1).

## Cron check-ins

Create a cron monitor in Argus first, then report runs by its slug:

```js
import { cron } from '@naijacloud/argus';

await cron.withMonitor('nightly-invoices', () => sendInvoices());
// or by hand:
cron.checkIn('nightly-invoices', 'start');
cron.checkIn('nightly-invoices', 'ok'); // or 'error', or an exit code
```

`withMonitor` reports the start, then success or failure, and rethrows your
job's error. If no monitor has that slug, Argus answers 404 and that check-in is
dropped; other check-ins keep going.

## Feature flags

```js
import { flags } from '@naijacloud/argus';

if (await flags.isOn('new-checkout', user.id)) {
  // …
}
const theme = await flags.variant('theme', user.id, 'light');
```

- **Caching:** answers are cached for 30 seconds per user.
- **Fallback:** you get the fallback you passed if the flag doesn't exist, or if
  Argus doesn't answer within 2 seconds, refuses the key, or rate-limits the
  request. After a refused key (401 or 403) the SDK stops asking until the
  process restarts. After a 429 it waits for `Retry-After` before asking again.
  Until then you get the last answer it had, or your fallback.

## Privacy

On by default:

- The values of keys such as `password`, `token`, `secret`, `authorization`,
  `cookie`, `bvn` and `card` are replaced with `[Filtered]`, at any depth. A
  sensitive header, such as `Authorization`, `Cookie` or `X-Api-Key`, has its
  whole value filtered.
- Card numbers, bearer tokens and JWTs are filtered inside strings, and so are
  sensitive pairs written as `password=…`, `password: …` or JSON
  `"password": "…"`. Short keys such as `pin`, `otp`, `sid` and `card` count only
  in the `pin=…` form, so a log line like `card: declined` stays readable.
- Query strings are removed from URLs in breadcrumbs and spans.
- The user's IP address is not sent unless you set `sendDefaultPii: true`.

Argus filters again on arrival.

## Options

| Option | Default | |
| -- | -- | -- |
| `dsn` | `ARGUS_DSN`, then `SENTRY_DSN` | Without one, nothing is sent |
| `release` | `ARGUS_RELEASE` | Your app's version, like `1.4.2` or a git commit |
| `environment` | `ARGUS_ENVIRONMENT`, then `SENTRY_ENVIRONMENT`, else `production` | |
| `serviceName` | `ARGUS_SERVICE_NAME`, then `OTEL_SERVICE_NAME`, then the `name` in your `package.json`, else `app` | Shown on logs, metrics and traces |
| `sampleRate` | `1` | Share of errors sent |
| `tracesSampleRate` | `1` | Share of traces sent |
| `sendDefaultPii` | `false` | Send the user's IP address |
| `maxBreadcrumbs` | `100` | |
| `beforeSend` / `beforeBreadcrumb` | | Change or drop an event or crumb |
| `captureConsole` | `false` | Also send `console` calls as logs |
| `debug` | `false` | Print what the SDK does (or `ARGUS_DEBUG=1` with the flag) |
| `enabled` | `true` | Turn the SDK off without removing it |

Call `await flush()` before a short script exits. Long-running servers don't
need to.

## Sending

The SDK never blocks your app and never throws. Each kind of data (errors,
logs, metrics, traces, crons) has its own queue of at most 100 requests and
1 MB. When a queue is full, the oldest waiting request is dropped. Logs, metrics
and traces are split so that no request is larger than 512 KB.

- **Network errors and 5xx:** the SDK retries after 1 s, 2 s, 4 s and so on,
  up to 5 tries.
- **429:** the SDK sends nothing more to that endpoint until `Retry-After` has
  passed (or the `X-Sentry-Rate-Limits` time). Then it resends the request it
  was holding. The wait doesn't count as a try. New data keeps queuing in the
  meantime.
- **401 or 403:** the key was refused. The SDK stops sending to that endpoint
  until the process restarts.
- **Any other 4xx:** that request is dropped.

On Node, every request carries `User-Agent: argus.javascript/<version>`.

## Check it works

```sh
npx @naijacloud/argus test --dsn https://…@argus-in.naijacloud.com/41
```

It sends one test event and tells you whether Argus accepted it. Without
`--dsn`, it uses `ARGUS_DSN`.

## Source maps

To see your real code instead of minified code in browser stack traces,
upload source maps from your build with
[`@naijacloud/argus-cli`](https://github.com/naijacloud/argus-cli).

## Not in this version

These are planned, and not done yet:

- automatic spans for database clients and `node:http` outgoing requests
  (only `fetch` is traced);
- browser page-load and route-change traces;
- session replay through this package (use the Argus website script for
  replay today).

## License

MIT
