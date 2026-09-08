# DVB-I Receiver — Deployment & Operations

Browser player that loads and renders a DVB-I service list. Companion project: `rt-dvb-i-application-provider`
(generates the service list this app consumes) — see its `DEPLOYMENT.md` for admin-side details.

## Running

```
npm install && npm start   # http://localhost:5000
```

## The `/proxy` endpoint

The browser can't fetch arbitrary cross-origin service-list URLs directly (CORS), so the server
proxies them. `/proxy` is SSRF-guarded: it resolves the target host and rejects private/loopback/
link-local addresses and the cloud-metadata IP (`169.254.169.254`) — see `isPrivateIp`/`assertSafeUrl`
in `server.js`. It is also rate-limited per client IP (in-memory; a multi-instance deployment behind a
load balancer would need a shared store).

## Logging

Structured JSON-lines logs to stdout/stderr. Control verbosity with `LOG_LEVEL`
(`error` | `warn` | `info` [default] | `debug`).

## Native HTTPS (optional)

`HTTPS_KEY_PATH`/`HTTPS_CERT_PATH` (PEM file paths) enable native TLS termination; falls back to HTTP
if unset or unreadable. As with the admin app, terminating TLS at a reverse proxy is usually simpler.

## Pinned player libraries + CSP

`hls.js` and `dash.js` are loaded from CDNs pinned to exact versions with Subresource Integrity
(`hls.js@1.6.16`, `dash.js v5.2.0`). To upgrade: change the version in `public/index.html`, then
regenerate the hash: `curl -sL <pinned-url> | openssl dgst -sha384 -binary | openssl base64 -A`.

The CSP allows Google Fonts (`fonts.googleapis.com`/`fonts.gstatic.com`, used by `blue-bar.css`'s
`@import`) — this was found missing by the E2E test the first time the CSP was added; if you add any
new external resource (font, stylesheet, image host), the E2E suite (below) will catch a CSP mismatch
via a `console.error` assertion, but only for resources exercised by the test's page-load path.

## Tests

```
npm test          # unit tests (test/epg.test.js) + E2E (test/e2e.test.js, needs a browser — see below)
npm run test:unit # unit tests only, no browser required
npm run test:e2e  # E2E only
```

E2E uses Playwright with a real headless Chromium. First-time setup needs the browser binary:
```
npx playwright install chromium
```
If Chromium isn't installed, the E2E tests are skipped (not failed) so `npm test` still works for
quick iteration. CI (`.github/workflows/test.yml`) installs it automatically.
