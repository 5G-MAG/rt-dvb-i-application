# Changelog — rt-dvb-i-application

## 2026-10 — No error for an XML AIT without an executable application (TS 103 770 V1.2.1 clause 5.2.4.2)

- **The toolbar application is offered only once it has been resolved**: an XML AIT is read first,
  and the button appears when it gives an application this client can start. When it gives none,
  the application is not offered and no error is shown; the service keeps playing.

## 2026-10 — Controlling applications this client cannot start (TS 103 770 V1.2.1 clauses 5.2.13, 5.2.3.2)

- **An instance whose application controlling media presentation is of a type this client cannot
  start is discarded**, and the next instance is tried; its delivery parameters are never played.
  When no other instance can play, the error names the application type.

## 2026-10 — Query values percent-encoded per IETF RFC 3986 (TS 103 770 V1.2.1 clauses 5.1.3.2, 6.2.2)

- **Every reserved character of RFC 3986 clause 2.2 in a query key or value is percent-encoded**,
  including `! ' ( ) *`, which `encodeURIComponent` leaves as they are: the registry query, every
  content guide request and the XML AIT contextual parameters.

## 2026-10 — A regulator list is always the default (TS 103 770 V1.2.1 table 83 NOTE 2)

- **When a registry response includes a list with `@regulatorListFlag`, a regulator list is the
  default**, even when this client cannot install it: it stays marked as the default, disabled,
  with the reason shown under its name. An installable regulator list is preferred over one that
  is not; the other lists can still be chosen.

## 2026-10 — Plain HTTP with a warning (TS 103 770 V1.2.1 clause 7.3)

- **An `http://` service list, registry or content guide is fetched, with a warning**, instead of
  being refused off the private subnet. The server logs a warning for every plain HTTP request it
  makes, and the page shows one under the list name when the service list itself is plain HTTP;
  both say the request is not over TLS and quote the clause 7.3 exception for an endpoint on the
  same private subnet, and the log says whether the endpoint is on one of the host's private subnets. The
  address guard, the allowlist and the other proxy checks are unchanged.
- **The default list is `http://localhost:4000/service-list.xml` again**, the provider's default.
- Same-origin requests are made directly again, whatever the scheme.

## 2026-10 — DVB-I Playlists (TS 103 770 V1.2.1 clauses 5.2.7 and 5.7)

- **A `DASHDeliveryParameters` location with `@contentType="application/xml"` is a Playlist**: it
  is fetched when the instance is selected, its `PlaylistEntry` MPDs play one after the other, and
  the content finished image follows the last one. A playlist that cannot be fetched or holds no
  entry fails its instance, so the next instance plays.

## 2026-10 — Content guide per TS 103 770 V1.2.1 clause 6

- **Source by the precedence of clause 6.1** (`public/guide.js`): the service's own
  `ContentGuideSource`, then the `ContentGuideSourceList` entry its `ContentGuideSourceRef` names,
  then the list-level `ContentGuideSource`. `ContentGuideServiceRef` is the `sid` when present; it
  is no longer looked up as a CGSID.
- **Requests as clause 6 sets them**: now/next with `now_next=true` for the channel list and
  `now_next=window` for the selected service, ordered by the structural now/later/earlier groups;
  schedules in 12-hour windows starting on 3-hour boundaries, combined; programme information by
  `pid`; square brackets percent-encoded; the extra `serviceId` parameter is gone.
- **More Episodes and Box Sets** (categories, lists, contents) in a browse panel, ordered by
  `MemberOf@index`, one page at a time through the pagination links.
- **On demand through the XML AIT**: `ProgramURL` is a content deep-linked XML AIT whose HTML5
  application is started in the player; an item is offered only within its availability window and
  when its Template XML AIT has an HTML5 application (cached as clause 5.2.4.4.5 says); XML AIT
  requests carry `regionID[]` and `lloc=epg`. Results whose Template XML AIT fails are hidden.
- **Programme ratings at playback**: the rating of the programme on air, per country, is checked at
  selection and again when the programme changes, and before an on-demand programme starts.
- The proxy passes `Expires` back as well.

## 2026-10 — Registry responses acted on per TS 103 770 V1.2.1 clause 8.5.3.2

- **A regulator's list is the default** (`public/discovery.js`): offerings with
  `@regulatorListFlag` come first in the picker, the first installable one marked default and
  focused; a provider or registry with `@regulatorFlag` is labelled.
- **`Delivery` is read**: an offering whose required delivery (DVB-T, DVB-C, DVB-S, RTSP, multicast,
  an application type or extension this client cannot use) is unusable is listed, disabled, with
  the reason, and never auto-loaded.
- **`Language`, `TargetCountry` and the service list logo** are shown; lists in the preferred audio
  language come first, and a list for another country than the one looked up is held back.
- **`ServiceList@id` is checked against `ServiceListId`**; a mismatch fails that URI like any other
  error.

## 2026-10 — Service list handling per TS 103 770 V1.2.1 clause 5

- **Channel numbers from one LCN table** (`public/servicelist.js`), chosen by the exact `@regionID`
  (any of a table's `TargetRegion`s) and subscription packages, never combined with another table;
  `LCNRange` numbers the services left without an LCN; `@visible="false"` services are left out of
  the channel list and guide grid but reachable by number unless `@selectable="false"`. The fixed
  800+ numbers for out-of-region services are gone; services no table numbers show `?`.
- **Every `TargetRegion` of a service** counts, and the region filter is matched exactly as typed.
- **A service without `ServiceType` is linear television.**
- **Linked applications**: an application controlling media presentation (term 1.2) is shown in the
  player instead of any stream, and closing it falls back to the next instance; one that cannot be
  started discards its instance; instance-level applications override service-level ones of the
  same type; after a fallback the toolbar offers that instance's own application; an XML AIT is
  read to choose its HTML5 application by priority; outside scheduled hours the application for an
  inactive service (term 2) is started. The page's CSP allows framing such applications.
- **Content finished image** (`HowRelatedCS:2021:1000.2`) after a VoD instance has played out.
- **Parental rating**: a threshold blocks rated services even without a PIN; `MinimumAge` is taken
  for the user's country (the one last entered for a registry lookup); the content guide rating of
  the programme on air takes precedence over the service rating.
- **Subscription packages** are chosen in settings from the list's `SubscriptionPackageList`, and an
  instance in packages the user has not chosen is not selected; the notice before playback is gone.
- **The daily update check** runs at a random time of day instead of 03:00.

## 2026-10 — Service instance precedence per TS 103 770 V1.2.1 clause 5.2.13

- **Availability is per instance** (`public/instances.js`): every Period and Interval of an
  instance's `Availability` is read (days, recurrence from the week of `@validFrom`, times past
  midnight), instances outside their scheduled hours are not tried, and the selected instance is
  re-evaluated when one of them enters or leaves its hours. A service is off air only when all of
  its instances are, and the message says when it is back.
- **Instances known not to play are discarded before trying**: multicast, DASH or HLS without a
  player, conditional access only, DRM without EME, or DRM systems the player does not know.
- **`@priority` defaults to 0**, as the schema says, not 99; on an error, precedence is applied
  again without the failed instance.
- **The playing instance's `DisplayName`** is shown in the toolbar and overlay.
- **ContentProtection**: every `DRMSystemId` of an element is read, with its `@encryptionScheme`,
  and `CASystemId` is read.

## 2026-10 — HTTP behaviour and TLS per TS 103 770 V1.2.1 clauses 4.3 and 7.3

- **One HTTP client for every DVB-I request** (`public/dvbi-http.js`): service lists, the registry
  and the content guide. It honours `Cache-Control: max-age` per response and answers a repeated
  request from its cache while fresh, sends `If-Modified-Since` with the `Last-Modified` it holds,
  does not repeat a request that got 400 or 406, waits for `Retry-After` after 401 or 403, and
  after 500, 502, 504 or a connection failure waits the random back-off of clause 4.3.3.7.
- **The proxy passes the headers through**: `If-Modified-Since` upstream; `Last-Modified`,
  `Cache-Control` and `Retry-After` back, and relays a 304.
- **Version polling** no longer requests the list before its max-age has passed, and retries after
  a failure on the clause 4.3.3.7 back-off instead of a fixed doubling capped at one hour.
- **A 404 from a content guide URL re-acquires the service list**, and backs off if the guide
  still answers 404 (clause 4.3.3.4).
- **Plain HTTP only on the same private subnet** (clause 7.3): `/proxy` refuses an `http://`
  endpoint, or redirect hop, that is not on an RFC 1918 subnet of one of its interfaces, and the
  browser sends every `http://` request through `/proxy` so that the check applies. The default
  list is now `https://localhost:4000/service-list.xml`.
- The tests serve over HTTPS with a throwaway certificate; `npm test` runs `test/*.test.js`.

## 2026-10 — 5G Broadcast signalling checked, local extension dropped

- **5G Broadcast is read from `IdentifierBasedDeliveryParameters`** holding an `mbms://` locator, as
  the provider now emits it, instead of the 5G-MAG extension `urn:5g-mag:metadata:dvbi-5g:2026`.
- **The locator is checked** against 3GPP TS 26.347 V18.1.0 clause 8.2.2 (`public/mbms-url.js`), and
  the 5G badge shows it, its priority and its MBMS User Service, or says what is wrong.
- **The texts no longer claim a unicast fallback is played.** The extension's `UnicastFallback` was
  read and never used while the tooltip and the 5G-only message said otherwise; a unicast copy is
  now simply another instance of the service.

## 2026-09 (cont. 6) — Registry lookup: conformant responses, and a configurable endpoint

- **A conformant registry response is now understood.** The lookup accepted only a
  `ProviderOffering` root in the `servicediscovery` namespace, so a `ServiceListEntryPoints`
  document, which is what ETSI TS 103 770 V1.2.1 clause 5.1.3.2 and its schema specify, was
  rejected and then mistaken for a service list. Both shapes are parsed now, matching on local
  name so the three namespaces a registry response spans all resolve.

- **The registry endpoint is configurable.** It was hard-coded to a public third-party service.
  Clause 5.1.3.2 names manufacturers, regulators, operators, a central registry and aggregators as
  possible operators of one, so which to ask is a deployment choice. A settings field sets it,
  remembered per browser, defaulting to the service it shipped with.


## 2026-09 (cont. 5) — Dependency security fixes

- **`body-parser` 1.20.5 to 1.20.8**, which carries a fixed `qs` 6.16.0 for its own use. Lockfile
  only; the declared range already admitted it.
- **Two moderate advisories remain open.** Express 4.22.2 pins `qs` to `~6.15.1` while the fix is
  `qs` 6.16.0, and 4.22.2 is the last release of the 4.x line, so only Express 5 closes them. Both
  concern query string parsing, which this server reaches on `/proxy`. They are left rather than
  forced: `npm audit fix --force` would move a major version under a suite that has not run against
  it.


## 2026-09 (cont. 4) — /proxy response size limit

- **`/proxy` will not read an unbounded response into memory.** It fetched the upstream body in
  full before answering, so one request naming a large or endless resource exhausted the process.
  `PROXY_MAX_BYTES` (10 MB by default) bounds it, checked both against a declared `Content-Length`
  and while reading, since the declaration can be absent or wrong. An oversized body is refused
  rather than truncated: a truncated service list is invalid XML and would surface as a parse
  error rather than as the size limit it is.


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
