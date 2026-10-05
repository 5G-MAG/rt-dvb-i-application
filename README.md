<p align="center">
  <img src=".github/banner.svg" width="100%" alt="Reference Tools · DVB-I Services over 5G Systems: DVB-I Application">
</p>

<p align="center">
  A browser DVB-I client that discovers a service list, presents its channels with their content
  guide, and plays them, per ETSI TS 103 770.
</p>

<p align="center">
  <img alt="Status: under development"
    src="https://img.shields.io/badge/Status-Under_Development-yellow">
  <a href="https://github.com/5G-MAG/rt-dvb-i-application/releases"><img alt="Version"
    src="https://img.shields.io/github/v/release/5G-MAG/rt-dvb-i-application?label=Version&sort=semver"></a>
  <a href="LICENSE"><img alt="License: 5G-MAG Public License v1.0"
    src="https://img.shields.io/badge/License-5G--MAG%20PL%20v1.0-blue"></a>
</p>

<p align="center">
  <a href="https://www.5g-mag.com/reference-tools/dvb-i">Project page</a> &nbsp;&middot;&nbsp;
  <a href="https://github.com/5G-MAG/rt-dvb-i-application/issues">Issues</a> &nbsp;&middot;&nbsp;
  <a href="https://www.5g-mag.com/contributing">Contributing</a>
</p>

---

## At a glance

|  |  |
|---|---|
| **Implements** | ETSI TS 103 770 V1.2.1 (2024-09), *Digital Video Broadcasting (DVB); Service Discovery and Programme Metadata for DVB-I*, client side |
| **Runs on** | Node.js, serving a browser page (CI uses Node.js 20, the Dockerfile `node:22-alpine`) |
| **Plays** | DASH and HLS over HTTP, via dash.js and hls.js |
| **Part of** | [DVB-I Services over 5G Systems](https://www.5g-mag.com/reference-tools/dvb-i), alongside [rt-dvb-i-android-application](https://github.com/5G-MAG/rt-dvb-i-android-application) (the Android receiver), [rt-dvb-i-application-provider](https://github.com/5G-MAG/rt-dvb-i-application-provider) (the list and guide), [rt-dvb-i-service-list-registry](https://github.com/5G-MAG/rt-dvb-i-service-list-registry) (discovery), [rt-dvb-i-examples](https://github.com/5G-MAG/rt-dvb-i-examples) (runnable demos) and [rt-5gms-application](https://github.com/5G-MAG/rt-5gms-application) (the Exo DVB-I Player) |

## Introduction

The DVB-I client: a browser page, served by a small Node.js server, that loads a DVB-I service list
and its content guide and plays the services. The server also proxies the metadata requests the
browser cannot make itself. It is used with the service list and content guide of
`rt-dvb-i-application-provider` and the registry of `rt-dvb-i-service-list-registry`.

## Specification

Built against **ETSI TS 103 770 V1.2.1 (2024-09)**.

What the specification defines, and what this repository implements and does not, is on the project
page: <https://www.5g-mag.com/reference-tools/dvb-i>

## Install dependencies

Node.js 20 or later, with npm, and `openssl` for the tests.

## Downloading

```bash
cd ~
git clone https://github.com/5G-MAG/rt-dvb-i-application.git
```

## Building

```bash
cd rt-dvb-i-application
npm install
```

## Running

```bash
npm install
npm start           # http://localhost:5000
```

By default it loads `http://localhost:4000/service-list.xml`, which is where the provider serves one
when it runs without a certificate, its default. To use a different list, open settings and set the
URL, or pass it in the query string:

```
http://localhost:5000/?url=http://localhost:4000/service-list.xml
```

A list published on the same machine needs `PROXY_ALLOW_ORIGINS`, and a self-signed certificate on
an HTTPS provider is trusted through `NODE_EXTRA_CA_CERTS`:

```bash
PROXY_ALLOW_ORIGINS="http://localhost:4000,http://127.0.0.1:4000" npm start
PROXY_ALLOW_ORIGINS="https://localhost:4000,https://127.0.0.1:4000" \
NODE_EXTRA_CA_CERTS=/path/to/provider-cert.pem npm start
```

## Configuration

| Variable | Default | What it sets |
|---|---|---|
| `PORT` | `5000` | port to listen on |
| `PROXY_ALLOW_ORIGINS` | unset | comma-separated origins `/proxy` may fetch although they resolve to a private or loopback address, matched exactly on scheme, host and port. Without it a service list published on the same machine cannot be loaded. Example: `http://localhost:4000,http://127.0.0.1:4000`. |
| `PROXY_MAX_BYTES` | `10485760` | largest proxied response; a larger body is refused with 502 |
| `NODE_EXTRA_CA_CERTS` | unset | a PEM file of extra certificate authorities `/proxy` trusts, for example a local provider's self-signed certificate |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug`; logs are JSON lines on stdout and stderr |
| `HTTPS_KEY_PATH`, `HTTPS_CERT_PATH` | unset | PEM key and certificate to serve HTTPS directly instead of behind a reverse proxy |
| `BROWSER` | `chromium` | engine for the Playwright tests |
| `CHROMIUM_ARGS` | unset | extra Chromium launch flags, applied only when `BROWSER` is Chromium |

`hls.js` and `dash.js` are loaded from CDNs pinned to exact versions with Subresource Integrity. To
upgrade one, change the version in `public/index.html` and regenerate its hash:

```bash
curl -sL <pinned-url> | openssl dgst -sha384 -binary | openssl base64 -A
```

## Development

```bash
npm test                    # unit tests, proxy guard tests, browser tests
BROWSER=firefox npm test    # where Chromium cannot run
npx playwright install chromium firefox
```

```
npm run test:unit # unit tests only, no browser required
npm run test:e2e  # E2E only
```

The browser and proxy tests serve over HTTPS with a throwaway certificate made with `openssl`. In
environments where Chromium cannot run (every subresource fails with `ERR_INSUFFICIENT_RESOURCES`),
`BROWSER=firefox` runs the same suite. CI runs the tests from `.github/workflows/test.yml`.

## Contributing

Contributions are welcome. How to raise an issue, fork the repository and open a pull request, and
the Contributor License Agreement required before code can be merged, are described at
<https://www.5g-mag.com/contributing>.

## License

Distributed under the 5G-MAG Public License v1.0. See [LICENSE](LICENSE).
