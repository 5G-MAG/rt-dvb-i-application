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

This is the DVB-I client of the architecture in TS 103 770 clause 4.1. The small Node server serves
the page and proxies the metadata requests the browser cannot make itself because of CORS. Media
segments are fetched by the player directly, not through the server.

The client can be pointed at a service list URL, or can ask a Service List Registry which lists
exist for a country and offer the results.

## Specification

Built against **ETSI TS 103 770 V1.2.1 (2024-09)**, a version rather than a release name.

Clause-by-clause coverage, and what is still absent, is recorded on the project page rather than
here: <https://www.5g-mag.com/reference-tools/dvb-i>

For 5G Broadcast it checks and shows the `mbms://` signalling rather than playing it; see
[5G Broadcast instances](#5g-broadcast-instances) below.

## Downloading

```bash
cd ~
git clone https://github.com/5G-MAG/rt-dvb-i-application.git
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

**Plain HTTP is loaded with a warning.** ETSI TS 103 770 V1.2.1 clause 7.3 requires HTTP over TLS to
service list registries, service list servers and content guide servers, except: "For the specific
case that a DVB-I client connects to a DVB-I metadata endpoint located on the same private subnet
(see clause 3 of IETF RFC 1918 [27]), HTTP may be used without TLS." An `http://` service list is
still loaded, and a warning under the list name says it is not over TLS and quotes that exception.
The proxy logs the same warning for every plain HTTP request it makes, redirect hops included, and
says whether every address of the endpoint is on one of this server's private subnets. Use
`https://` to meet the clause outside a private subnet.

**HTTPS requests use the TLS profile of ETSI TS 102 796 clause 11.2**, which TS 103 770 clause 7.3
names: TLS 1.2 or 1.3, the table 15a cipher suites, no forbidden signature algorithm and no RSA key
under 2 048 bits. A server that offers nothing within it is refused; [DEPLOYMENT.md](DEPLOYMENT.md)
gives the profile.

**A list published on the same machine needs `PROXY_ALLOW_ORIGINS`.** The `/proxy` endpoint refuses
private and loopback addresses, which is where a local provider sits, so name its origin explicitly.
A self-signed certificate on an HTTPS provider is trusted through Node.js's `NODE_EXTRA_CA_CERTS`:

```bash
PROXY_ALLOW_ORIGINS="http://localhost:4000,http://127.0.0.1:4000" npm start
PROXY_ALLOW_ORIGINS="https://localhost:4000,https://127.0.0.1:4000" \
NODE_EXTRA_CA_CERTS=/path/to/provider-cert.pem npm start
```

## Configuration

The server is configured through environment variables: `PORT` (default `5000`),
`PROXY_ALLOW_ORIGINS`, `PROXY_MAX_BYTES`, `LOG_LEVEL`, and `HTTPS_KEY_PATH` with `HTTPS_CERT_PATH`
for native HTTPS. [DEPLOYMENT.md](DEPLOYMENT.md) gives each one with its default, and describes
HTTPS, the proxy guard and the pinned player libraries.

## 5G Broadcast instances

A service list may carry service instances delivered over 5G Broadcast (MBMS), as
`IdentifierBasedDeliveryParameters` holding an `mbms://` locator. ETSI TS 103 770 V1.2.1 clause
9.3.3 has the client pass that locator to an MBMS Client; a browser has no MBMS Client, so this one
checks the signalling and shows it instead:

- a **5G** badge whose tooltip gives the locator, its priority and the MBMS User Service it names
  (the part before the first `&`, ETSI TS 126 347 clause 8.2.2);
- a red **5G** badge saying what is wrong when the locator is not an MBMS URL by that clause;
- "5G only", with a message, when the service lists no other instance. Otherwise another instance of
  the service plays.

The check is `public/mbms-url.js`, tested by `test/mbms-url.test.js`.

## Development

```bash
npm test                    # unit tests, proxy guard tests, browser tests
BROWSER=firefox npm test    # where Chromium cannot run
npx playwright install chromium firefox
```

The browser and proxy tests serve over HTTPS with a throwaway certificate made by the `openssl`
command line when they start, so `openssl` must be installed.

Some environments cannot run Chromium at all: every subresource fetch fails with
`ERR_INSUFFICIENT_RESOURCES` and the renderer crashes, so the page loads and nothing renders. That
looks like a defect in this application and is not one; `BROWSER=firefox` runs the identical suite.

The tests are in `test/`, and CI runs them from `.github/workflows/test.yml`. Changes are recorded
in [CHANGELOG.md](CHANGELOG.md).

## Contributing

Contributions are welcome. How to raise an issue, fork the repository and open a pull request, and
the Contributor License Agreement required before code can be merged, are described at
<https://www.5g-mag.com/contributing>.

## License

Distributed under the 5G-MAG Public License v1.0. See [LICENSE](LICENSE).
