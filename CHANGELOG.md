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
  filtered, and IP addresses are not sent.
- **Transport:** retries with backoff, respects `Retry-After` and 429s, stops on
  a refused key, and never throws.
- **`npx @naijacloud/argus test`:** sends a test event.
