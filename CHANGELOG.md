# Changelog

All notable changes to `@naijacloud/argus` are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-25

First release, implementing the Argus SDK contract `argus.sdk/1`.

### Added

- **Node.js:** start with `node --import @naijacloud/argus/register app.js`, or
  call `init()`.
  - Uncaught exceptions and unhandled rejections are reported, and the process
    still exits 1 the way Node does.
  - Incoming requests on `node:http` and `node:https` are traced automatically,
    including a W3C `traceparent` from the caller.
  - Outgoing `fetch()` calls become child spans, carry `traceparent`, and leave
    breadcrumbs.
  - `console` calls become breadcrumbs; `captureConsole` also sends them as logs.
  - `argusErrorHandler()` for Express.
- **Browser** (`@naijacloud/argus/browser`):
  - uncaught errors and promise rejections;
  - breadcrumbs for clicks, navigation, `console`, `fetch` and XHR;
  - errors kept in `localStorage` while offline and sent when back online.
- **Next.js** (`@naijacloud/argus/next`): `instrumentation.ts`,
  `instrumentation-client.ts` and `onRequestError`.
- **Logs, metrics and traces** over OTLP/HTTP JSON:
  - `log.info()` and the other levels;
  - `metrics.count()`, `metrics.gauge()` and `metrics.distribution()`;
  - `trace()` and `startSpan()`.
- **Cron check-ins by monitor slug:** `cron.checkIn()` and `cron.withMonitor()`.
- **Feature flags:** `flags.isOn()`, `flags.variant()` and `flags.all()`.
- **Privacy defaults on:** sensitive keys, card numbers, tokens and JWTs are
  filtered, and IP addresses are not sent. Inside strings, sensitive pairs are
  filtered whether written `key=value`, `key: value` or as JSON
  `"key": "value"`, for the whole contract list of sensitive words. Short exact
  keys (`auth`, `pwd`, `pin`, `otp`, `session`, `card`, `sid`) count only as
  `key=value`. A sensitive header has its whole value filtered.
- **Transport:** never blocks your app and never throws.
  - Retries network errors and 5xx with backoff, up to 5 tries.
  - On a 429, sends nothing to that endpoint until `Retry-After` (or
    `X-Sentry-Rate-Limits`) has passed, then resends the request it was holding.
    The wait doesn't count as a try, and new data keeps queuing meanwhile.
  - Stops an endpoint after a 401 or 403. Any other 4xx (such as a cron 404 for
    an unknown slug) drops that one request only.
  - Each endpoint keeps at most 100 requests and 1 MB, dropping the oldest.
  - Splits OTLP logs, metrics and traces so no request body is over 512 KB.
  - Node sends `User-Agent: argus.javascript/<version>` on every request.
- **Feature flags transport:** a 2-second timeout and a 30-second cache. Stops
  asking after a 401 or 403, waits out a 429, and returns your fallback (or the
  last answer) when Argus can't answer.
- **Defaults:** `service.name` comes from the option, then `ARGUS_SERVICE_NAME`,
  then `OTEL_SERVICE_NAME`, then the `name` in `package.json`, else `app`. The
  environment comes from the option, then `ARGUS_ENVIRONMENT`, then
  `SENTRY_ENVIRONMENT`, else `production`.
- **`npx @naijacloud/argus test`:** sends a test event.
