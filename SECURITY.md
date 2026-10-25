# Security Policy

## Reporting a vulnerability

Email **security@naijacloud.com**. Don't open a public issue, discussion or
pull request for a security problem.

Include the version, the Node or browser version, a minimal snippet and what
you expected instead. We acknowledge reports within two working days, tell you
our assessment and a fix timeline, and credit you in the changelog unless you
would rather we didn't.

## Supported versions

The latest minor release receives security fixes. Before 1.0.0 that is the
latest release.

## What this SDK guarantees

These are enforced in code and covered by tests. A regression in any of them is
a security bug worth reporting:

- **The DSN's public key is the only credential the SDK holds.** It is safe in
  a browser: it can send data to one Argus source and read nothing.
- **Personal data is filtered before anything leaves your app.**
  - The values of keys such as password, token, secret, authorization,
    cookie, bvn and card are replaced with `[Filtered]`, at any depth.
  - Card numbers, bearer tokens and JWTs are filtered inside strings.
  - Query strings are removed from URLs in breadcrumbs and spans.
  - The user's IP address is not sent unless you set `sendDefaultPii: true`.
- **Click breadcrumbs record the element, never what was typed.**
- **The SDK never throws into your code,** and a network failure never blocks
  your app.
