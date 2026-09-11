# DVB-I Application

A browser DVB-I client: it discovers a service list, presents the channels in it with their content
guide, and plays them.

## At a glance

|  |  |
|---|---|
| **Implements** | ETSI TS 103 770 V1.2.1 (2024-09), client side |
| **Runs on** | Node.js 18 or newer, serving a browser page |
| **Plays** | DASH and HLS over HTTP, via dash.js and hls.js |
| **Works with** | [`rt-dvb-i-application-provider`](../rt-dvb-i-application-provider) (the list and guide), [`rt-dvb-i-service-list-registry`](../rt-dvb-i-service-list-registry) (discovery), [`rt-dvb-i-examples`](../rt-dvb-i-examples) (runnable demos) |

## Introduction

This is the DVB-I client of the architecture in TS 103 770 clause 4.1. The small Node server exists
to serve the page and to proxy metadata requests the browser cannot make itself because of CORS;
media segments are fetched by the player directly, not through it.

It can be pointed at a service list URL, or can ask a Service List Registry which lists exist for a
country and offer the results.

## Running

```bash
npm install
npm start           # http://localhost:5000
```

It loads `http://localhost:4000/service-list.xml` by default, which is where the provider serves one.
To use a different list, open settings and set the URL, or pass it in the query string:

```
http://localhost:5000/?url=http://localhost:4000/service-list.xml
```

**A list published on the same machine needs `PROXY_ALLOW_ORIGINS`.** The `/proxy` endpoint refuses
private and loopback addresses, which is where a local provider sits, so name its origin explicitly:

```bash
PROXY_ALLOW_ORIGINS="http://localhost:4000,http://127.0.0.1:4000" npm start
```

See [DEPLOYMENT.md](DEPLOYMENT.md) for the rest.

## Development

```bash
npm test                    # unit tests, proxy guard tests, browser tests
BROWSER=firefox npm test    # where Chromium cannot run
npx playwright install chromium firefox
```

Some environments cannot run Chromium at all: every subresource fetch fails with
`ERR_INSUFFICIENT_RESOURCES` and the renderer crashes, so the page loads and nothing renders. That
looks like a defect in this application and is not one; `BROWSER=firefox` runs the identical suite.

## Documentation

- [DEPLOYMENT.md](DEPLOYMENT.md) — environment variables, HTTPS, the proxy guard
- [CHANGELOG.md](CHANGELOG.md)

## License

No licence file has been added to this repository yet, so no licence is granted. Add one before
publishing or sharing it.
