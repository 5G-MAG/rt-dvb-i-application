# Changelog — rt-dvb-i-application

## 2026-09 (cont. 3) — The browser suite can pick its engine

- **`BROWSER` selects the Playwright engine**, chromium by default because it is the closest
  stand-in for what most viewers run. `BROWSER=firefox npm test` runs the same suite on Firefox.

  This exists because chromium cannot run in some environments: where the sandbox stops a renderer
  process acquiring resources, every subresource fetch fails with `net::ERR_INSUFFICIENT_RESOURCES`
  and the renderer crashes, so the page loads and nothing renders. All four browser tests then fail
  while the rest pass, which reads like a defect in the application and is not one. On such a
  machine Firefox runs the identical suite green and repeatably, which is a better answer than the
  `--single-process` chromium workaround recorded previously: that one was itself erratic, measured
  at 4/4, 3/4, 4/4 and later 0/4 on unchanged code.

- **Playback verified end to end** on that engine for the first time, against a live local origin:
  a tuned channel reaches `readyState` 4, 960x540, with `currentTime` advancing in real time and
  the buffer growing across successive samples, no media error, and dash.js fetching init and media
  segments from the origin. Until now every check had stopped at the HTTP and XML level.


## 2026-09 (cont. 2) — Say which URL failed, and relay the origin's status

- **A service list that will not parse now names the URL and what arrived.** Pointing the receiver
  at a portal's home page, or at an API, gets a 200 carrying HTML or JSON, and the old message,
  "Service list is not valid XML", gave no hint that the URL itself was the mistake. It now reads,
  for example: `http://localhost:4000/ returned an HTML page, not a DVB-I service list. Check the
  URL in settings: it should be the service list itself, for example
  http://localhost:4000/service-list.xml`. An empty response is reported as empty rather than as
  malformed.

- **`/proxy` relays the upstream status code** instead of answering 200 regardless. Flattening it
  hid the real failure: a 404 from the origin reached the caller as a 200 whose body was an error
  page, which then surfaced as unparseable content rather than as a missing document.

## 2026-09 (cont.) — /proxy allowlist replaces the blanket bypass

- **`PROXY_ALLOW_ORIGINS` replaces `ALLOW_LOOPBACK_PROXY`.** Local testing needs the receiver to
  fetch a service list published on the same machine, which the SSRF guard correctly refuses. The
  old flag solved that by switching the guard off entirely; the new one names the origins that may
  be fetched anyway, matched exactly on scheme, host and port:

  ```bash
  PROXY_ALLOW_ORIGINS="http://localhost:4000,http://127.0.0.1:4000" npm start
  ```

  Everything not named stays guarded. Even the same host on a different port is refused, which the
  old flag allowed. An allowlisted origin does skip the address check by design, so name only
  origins you control.

  `ALLOW_LOOPBACK_PROXY` is now ignored and logs an error saying what to use instead, rather than
  being silently dropped, which would leave a deployment believing it still had the exemption.

- **`test/proxy.test.js`**, 5 cases pinning the guard: allowlisted origins pass, the same host on
  another port does not, private/loopback/link-local and cloud metadata stay blocked, non-http
  schemes are refused, public addresses still work.


## 2026-09 — E2E launch flags, and the rename

- **`CHROMIUM_ARGS`** passes extra launch flags to the Playwright browser in `test/e2e.test.js`.
  Unset by default, so a normal machine still tests the normal multi-process browser, which is what
  a real viewer runs.

  It exists for environments whose sandbox stops a renderer process acquiring resources. There, every
  subresource fetch fails with `net::ERR_INSUFFICIENT_RESOURCES` and the renderer then crashes: the
  page loads but nothing renders, so all four browser tests fail while the unit tests pass. The
  application is not at fault, and this was confirmed rather than assumed: the same page, server and
  fixture render all three channels under `--single-process`, and fail under every multi-process
  launch mode, including with all external resources stubbed locally. It is not machine load, not a
  cgroup pid or memory cap, and not page weight, each of which was ruled out separately.

  On such a machine:

  ```bash
  CHROMIUM_ARGS="--no-sandbox --disable-dev-shm-usage --disable-gpu --single-process" npm test
  ```

- **Renamed** from `dvb-i-client` to `rt-dvb-i-application`, alongside `dvb-i-admin` becoming
  `rt-dvb-i-application-provider`.


## 2026-07 (cont. 3) — Broadcast-only services no longer silently disappear

- Services whose only `ServiceInstance` uses broadcast delivery (`DVBTDeliveryParameters`,
  `DVBSDeliveryParameters`, `DVBCDeliveryParameters` — the DVB-T/S/C tuning triplet) yield zero
  playable instances in a browser (no TV tuner access), and were previously dropped from the parsed
  service list entirely with no indication why. Found via a real external list (Sofia Digital) where
  channel(s) simply never appeared.
- `parseServiceList()` now keeps these services (flagged `noIpDelivery` + `hasBroadcastDelivery`)
  instead of filtering them out. `renderChannelList()` shows them with a dimmed "Broadcast only" badge
  (`.ch-card.no-delivery`). Selecting one shows a clear message ("Broadcast-only service (DVB-T/S/C) —
  not available via broadband in this browser") instead of attempting playback or showing a generic
  "stream unavailable" error.
- Added a `test/fixtures/service-list.xml` service (Gamma TV, DVB-T only) and an `test/e2e.test.js`
  regression test covering the badge and the selection message.

## 2026-07 (cont. 2) — Critical fix: EPG never loaded for any cross-origin service list

- **`DVBIEpg.load()` silently returned `null` for every cross-origin EPG endpoint** — the most common
  real-world case (the service list's `ContentGuideSource` lives on a different host than the
  receiver). Root cause, two compounding bugs: (1) a stale `^https?://` guard rejected the relative
  `/proxy?url=...` string `resolveUrl()` produces for cross-origin targets, silently returning `null`
  before ever calling `fetch()` — no network request, no console error, the EPG strip stuck on
  "Loading…" forever; (2) even without guard (1), naively appending `?sid=...` params to an
  already-proxy-wrapped URL would have put those params on the `/proxy` request itself rather than
  the actual target URL, since the receiver's `/proxy` handler only forwards its own `url` param.
  Fixed by building the full endpoint+params URL from the RAW absolute XML-sourced endpoint first,
  then resolving/proxying that complete URL — not the other way around. All 4 call sites in `app.js`
  updated to pass the raw endpoint instead of pre-resolving it.
- Added a regression test (`test/e2e.test.js`) that serves real fixture EPG data and asserts the EPG
  strip actually renders programme content after selecting a channel — this test fails under the old
  code (times out waiting past "Loading…") and passes with the fix.
- Also fixed: `ALLOW_LOOPBACK_PROXY=1` dev flag (`server.js`) so local admin+receiver testing on
  separate localhost ports doesn't hit the (correct, production-safe) SSRF guard; blue bar wired with
  cross-navigation links between the two apps; header button height normalized (`.btn` line-height).

## 2026-07 (cont.) — Real browser E2E testing, ops hardening

- **Playwright E2E test suite** (`test/e2e.test.js`) — a real headless Chromium loads the app, fetches
  a compliant fixture service list, and verifies channels render and selection works. This immediately
  caught a **real bug no static check could**: the CSP blocked `blue-bar.css`'s Google Fonts `@import`
  (`fonts.googleapis.com`/`fonts.gstatic.com`), silently breaking the intended Poppins font in every
  deployment. Fixed by adding those hosts to `style-src`/`font-src`. CI installs Chromium via
  `npx playwright install --with-deps chromium`.
- `test/epg.test.js` — unit tests for `parseISODuration` (days, case-insensitivity, invalid input) and
  `getNowNext` (including the gap-doesn't-return-a-stale-event regression).
- Ops hardening: in-memory rate limiting on `/proxy` (429 after the window); structured JSON-lines
  request logging (`LOG_LEVEL` env var); optional native HTTPS via `HTTPS_KEY_PATH`/`HTTPS_CERT_PATH`.
- CI workflow (`.github/workflows/test.yml`) runs the full suite (unit + E2E) on every push/PR.

## 2026-07 — Compliance sync, playback, security

### Parser sync with the compliant generator (wire-format changes)
- `URI` matched by localName in any namespace (now emitted as `dvbisd-t:URI`).
- Now/next endpoint read from `ProgramInfoEndpoint` (and legacy `NowNextInfoEndpoint`).
- `TargetRegion` and `LCNTable/TargetRegion` read as child elements (legacy attribute tolerated).
- `IPMulticastAddress` read as `Address`/`Port` (legacy lowercase tolerated).
- `AccessibilityAttributes` wrapper matched namespace-agnostically (DVB-I element, `tva:` children).
- Namespace detection for service list and TVA EPG (2019/2021/2024).

### Playback (player.js)
- DASH live timeshift detected via the DVR window / seekable range (not `duration()`).
- DASH failover only on non-recoverable errors (inspects the error payload).
- Subtitle track selection by object identity (fixes wrong-track selection).
- FairPlay without a certificate now surfaces a clear error instead of failing opaquely.
- Multi-DRM: HLS `drmSystems` seeded from all systems; native-HLS listener leak fixed.
- CMCD UUIDv7 session id shared across dash.js and hls.js.

### EPG / UX
- ISO-8601 duration parser supports days and is case-tolerant; negative-duration events rejected.
- `getNowNext` returns the next *upcoming* event during gaps.
- Nightly refresh no longer blanks the UI / interrupts playback on a `304`.
- now/next vs full-schedule cache split; grid loads full schedules on open.
- Parental "Change PIN" requires the current PIN; region change preserves the active channel.

### Security
- Fixed DOM XSS: unescaped EPG service name; inline `onclick` single-quote breakouts (catch-up,
  favourites, custom-list); `javascript:`-scheme linked-app URLs blocked.
- SSRF guard on the `/proxy` endpoint (blocks private/loopback/link-local + cloud metadata).
- `hls.js`/`dash.js` pinned with Subresource Integrity; Content-Security-Policy added.
