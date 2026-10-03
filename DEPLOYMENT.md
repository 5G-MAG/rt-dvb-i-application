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

`/proxy` fetches `http://` targets, and every plain HTTP redirect hop, with a warning in the log
(ETSI TS 103 770 V1.2.1 clause 7.3 requires HTTP over TLS except to an endpoint on the same private
subnet): the warning quotes that exception and says whether every address of the endpoint lies in an
IETF RFC 1918 clause 3 block on the subnet of one of this host's interfaces (`plainHttpWarning` in
`server.js`). Loopback is not an RFC 1918 block. The browser shows the same warning under the list
name. Redirects are followed by the proxy itself, up to 20 as fetch does, so that each hop is
checked. `If-Modified-Since` and `If-None-Match` are passed
upstream and `Last-Modified`, `ETag`, `Cache-Control`, `Retry-After` and `Expires` are passed back
(clause 4.3; `ETag` and `If-None-Match` for ETSI TS 102 796 clause 7.3.2.6, which clause 4.3.2.1
refers to; `Expires` for Template XML AITs, clause 5.2.4.4.5).

`https://` targets are fetched with a fixed TLS profile (`UPSTREAM_TLS` in `server.js`), the one
TS 103 770 clause 7.3 takes from ETSI TS 102 796 V1.8.1 clause 11.2: TLS 1.2 or 1.3; for TLS 1.2 only
the five cipher suites of table 15a, in its order; the table 15b signature algorithms that are not
forbidden; the curves X25519, P-256, P-384 and P-521; and OpenSSL security level 2, so RSA keys and
root certificates under 2 048 bits and SHA-1 or MD5 certificate signatures are refused. It does not
depend on the Node.js release (Node.js 20 accepts 1 024-bit RSA keys by default). Root certificates
are the runtime's, plus `NODE_EXTRA_CA_CERTS`; they are not compared with the HbbTV root list.

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `5000` | port to listen on |
| `PROXY_ALLOW_ORIGINS` | unset | comma-separated origins `/proxy` may fetch despite resolving to a private or loopback address, matched exactly on scheme, host and port. **Without it a service list published on the same machine cannot be loaded**, because the SSRF guard correctly refuses it. Example: `http://localhost:4000,http://127.0.0.1:4000`. Everything not named stays guarded. |
| `PROXY_MAX_BYTES` | `10485760` | ceiling on a proxied response. Raise it for an unusually large service list; a body over the limit is refused with 502 rather than truncated. |
| `NODE_EXTRA_CA_CERTS` | unset | Node.js's own variable: a PEM file of extra certificate authorities `/proxy` trusts, for example a local provider's self-signed certificate. |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug` |
| `HTTPS_KEY_PATH`, `HTTPS_CERT_PATH` | unset | serve HTTPS directly instead of behind a proxy |
| `BROWSER` | `chromium` | engine for the Playwright tests. Some environments cannot run Chromium at all, where every subresource fails with `ERR_INSUFFICIENT_RESOURCES`; `BROWSER=firefox` runs the same suite there. |
| `CHROMIUM_ARGS` | unset | extra Chromium launch flags, applied only when `BROWSER` is Chromium |

`ALLOW_LOOPBACK_PROXY` is no longer supported. It disabled the address guard entirely; use
`PROXY_ALLOW_ORIGINS` to name the origins instead. Setting it now logs an error and is ignored.

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
