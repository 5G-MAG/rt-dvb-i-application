# Changelog — dvb-i-receiver

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
