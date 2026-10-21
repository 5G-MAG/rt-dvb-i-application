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
| **Part of** | [DVB-I Services over 5G Systems](https://www.5g-mag.com/reference-tools/dvb-i), alongside [rt-dvb-i-application-provider](https://github.com/5G-MAG/rt-dvb-i-application-provider) (the list and guide), [rt-dvb-i-service-list-registry](https://github.com/5G-MAG/rt-dvb-i-service-list-registry) (discovery), [rt-dvb-i-examples](https://github.com/5G-MAG/rt-dvb-i-examples) (runnable demos) and [rt-5gms-application](https://github.com/5G-MAG/rt-5gms-application) (the Exo DVB-I Player) |

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

The 5G broadcast signalling this client also understands is a local extension, not part of
TS 103 770; see [The local 5G broadcast extension](#the-local-5g-broadcast-extension) below.

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

A service list published on the same machine, such as the provider's, is reached through the
`/proxy` endpoint, which refuses private and loopback addresses unless their origin is named in
`PROXY_ALLOW_ORIGINS`. When the variable is not set, the origins of the default local list,
`http://localhost:4000` and `http://127.0.0.1:4000`, are allowed, so the default list loads with a
plain `npm start`. For a list on any other local address or port, name its origin:

```bash
PROXY_ALLOW_ORIGINS="http://localhost:4000,http://192.168.1.20:8080" npm start
```

Setting the variable replaces the default, and setting it empty (`PROXY_ALLOW_ORIGINS=""`) allows
no local origin, which is what a public deployment should do. If a list is refused, the error shown
in the channel list names this setting.

By default the client loads `http://localhost:4000/service-list.xml`, which is where the provider
serves one. To use a different list, open settings and set the URL, or pass it in the query string:

```
http://localhost:5000/?url=http://localhost:4000/service-list.xml
```

The Service List Registry address has no default: no registry address is given by TS 103 770 or
TR 103 972, and the one this client used earlier no longer answers. Enter the registry's query
address in settings before looking up a country.
The host names in the examples of TS 103 770 clause 5.1.3 (`csr.dvbservices.com`) are examples only,
not designated defaults: the specification notes that at the time of writing there is no Central
Service List Registry.

## Configuration

The server is configured through environment variables: `PORT` (default `5000`),
`PROXY_ALLOW_ORIGINS`, `PROXY_MAX_BYTES`, `LOG_LEVEL`, and `HTTPS_KEY_PATH` with `HTTPS_CERT_PATH`
for native HTTPS. [DEPLOYMENT.md](DEPLOYMENT.md) gives each one with its default, and describes
HTTPS, the proxy guard and the pinned player libraries.

## The local 5G broadcast extension

A service list may carry service instances delivered over 5G broadcast (MBMS). **No DVB
specification defines that signalling.** It arrives as `OtherDeliveryParameters` with an `xsi:type`
from the 5G-MAG namespace `urn:5g-mag:metadata:dvbi-5g:2026`, which the provider repository defines
in `schemas/dvbi-5g-ext-1.0.xsd`.

This receiver understands it and says so plainly: affected services get a dashed **5G ext** badge
whose tooltip names the extension and states that it is local, and a service reachable *only* over
5G shows "5G only" with a message explaining that a browser cannot join an MBMS bearer. Playback,
where it happens, uses another instance of the service or the unicast fallback the extension names.
`UnicastFallback` is a local extension; it is not in TS 103 770 or TR 103 972. Following the model
of TR 103 972 clauses 6.4.3.1 and 6.4.3.2 (unicast and 5G as separate service instances, the 5G
one with the higher priority), the receiver turns it into a separate unicast instance with a lower
priority than the 5G instance (its priority + 1). That instance inherits the 5G instance's content
protection and content attributes, and takes its media type from the element's `type` attribute,
else from the URL extension (`.m3u8` HLS, `.mpd` DASH), else DASH.

A receiver that did not know the namespace would simply find no delivery parameters it understands
on that instance and move on, which is the intended behaviour.

## Development

```bash
npm test                    # unit tests, proxy guard tests, browser tests
BROWSER=firefox npm test    # where Chromium cannot run
npx playwright install chromium firefox
```

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
