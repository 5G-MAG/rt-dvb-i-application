// Browser E2E smoke test using Playwright (raw API, not @playwright/test, to keep the toolchain
// uniform with the rest of the suite — assertions still go through node:test).
// Serves the receiver itself (server.js: public/ and /proxy) plus compliant fixture service lists on
// one ephemeral HTTPS port (same-origin) so the test exercises real parsing/rendering without
// weakening the SSRF guard on /proxy (which correctly blocks localhost — see server.js isPrivateIp).
// HTTPS because TS 103 770 V1.2.1 clause 7.3 has the client refuse plain HTTP to a metadata endpoint
// that is not on its private subnet, which loopback is not; the certificate is a throwaway one.
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { makeCertificate } = require('./tls-fixture.js');

let browser, page, server, baseUrl;
const hits = { cg404List: 0, cg404Guide: 0 };
let playwright;
try { playwright = require('playwright'); }
catch { /* handled in before() */ }

// Minimal but real TVAMain fixture with one event that is airing "now" (relative to Date.now()),
// so the EPG strip has something to actually render — proves the fetch -> parse -> render pipeline
// works end to end, not just that a request was attempted.
function fixtureEpgXml() {
  const now = Date.now();
  const start = new Date(now - 10 * 60000).toISOString();
  const end = new Date(now + 20 * 60000).toISOString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<TVAMain xmlns="urn:tva:metadata:2024" xmlns:mpeg7="urn:tva:mpeg7:2008" xml:lang="en">
  <ProgramDescription>
    <ProgramInformationTable>
      <ProgramInformation programId="crid://fixture.example.com/prog/1">
        <BasicDescription>
          <Title type="main">Fixture Now Playing</Title>
          <Synopsis length="short">E2E test programme</Synopsis>
        </BasicDescription>
      </ProgramInformation>
    </ProgramInformationTable>
    <ProgramLocationTable>
      <Schedule serviceIDRef="fixture" start="${start}" end="${end}">
        <ScheduleEvent>
          <Program crid="crid://fixture.example.com/prog/1"/>
          <PublishedStartTime>${start}</PublishedStartTime>
          <PublishedDuration>PT30M</PublishedDuration>
          <ActualStartTime>${start}</ActualStartTime>
          <ActualEndTime>${end}</ActualEndTime>
        </ScheduleEvent>
      </Schedule>
    </ProgramLocationTable>
  </ProgramDescription>
</TVAMain>`;
}

// A service list with 5G Broadcast instances as the provider emits them: IdentifierBasedDeliveryParameters
// holding an mbms:// locator (TS 103 770 V1.2.1 clause 5.5.4, table 16; TS 26.347 clause 8.2.2).
// Three services: one hybrid (5G Broadcast plus a DASH instance that actually plays), one 5G-only
// (nothing playable in a browser), and one whose locator is not an MBMS URL, which must be reported.
function fixture5gXml(base) {
  const svc = (uid, name, locator, dash) => `
  <Service version="1">
    <UniqueIdentifier>tag:sample,2024:service:${uid}</UniqueIdentifier>
    <ServiceInstance priority="1">
      <DisplayName>${name}</DisplayName>
      <IdentifierBasedDeliveryParameters>${locator}</IdentifierBasedDeliveryParameters>
    </ServiceInstance>${dash ? `
    <ServiceInstance priority="2">
      <DisplayName>${name}</DisplayName>
      <DASHDeliveryParameters>
        <UriBasedLocation contentLinkType="application/dash+xml"><URI>${base}/dash/hybrid.mpd</URI></UriBasedLocation>
      </DASHDeliveryParameters>
    </ServiceInstance>` : ''}
    <ServiceName>${name}</ServiceName>
    <ProviderName>Sample Provider</ProviderName>
  </Service>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<ServiceList
  xmlns="urn:dvb:metadata:servicediscovery:2024"
  id="tag:dvbi.example,2024:servicelist:5g" version="1" xml:lang="en">
  <Name>5G Broadcast List</Name>
  <ProviderName>Sample Provider</ProviderName>${
    svc('hybrid', 'Hybrid 5G', 'mbms://service1000.mbms.operator.com&amp;label=http://www.example.com/hybrid.mpd', true)}${
    svc('5gonly', 'Only 5G', 'mbms://example.com/userservice/1', false)}${
    svc('bad5g', 'Bad 5G', 'mbms://example.com&amp;foo=1', false)}
</ServiceList>`;
}

// One service whose only ContentGuideSource answers 404.
function fixtureCg404Xml(base) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ServiceList xmlns="urn:dvb:metadata:servicediscovery:2024"
  xmlns:dvbisd-t="urn:dvb:metadata:servicediscovery-types:2023"
  id="tag:dvbi.example,2024:servicelist:cg404" version="1" xml:lang="en">
  <Name>Guide 404 List</Name>
  <ProviderName>Sample Provider</ProviderName>
  <ContentGuideSource CGSID="gone">
    <ProviderName>Sample EPG</ProviderName>
    <ScheduleInfoEndpoint contentType="application/xml"><dvbisd-t:URI>${base}/epg/gone</dvbisd-t:URI></ScheduleInfoEndpoint>
  </ContentGuideSource>
  <Service version="1">
    <UniqueIdentifier>tag:sample,2024:service:cg404</UniqueIdentifier>
    <ServiceInstance priority="1">
      <DASHDeliveryParameters>
        <UriBasedLocation contentType="application/dash+xml"><dvbisd-t:URI>${base}/dash/x.mpd</dvbisd-t:URI></UriBasedLocation>
      </DASHDeliveryParameters>
    </ServiceInstance>
    <ServiceName>Guide Gone</ServiceName>
    <ProviderName>Sample Provider</ProviderName>
  </Service>
</ServiceList>`;
}

before(async () => {
  if (!playwright) { console.log('playwright not installed — skipping E2E suite'); return; }

  const { app } = require('../server.js');
  server = https.createServer(makeCertificate(), app).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  baseUrl = `https://127.0.0.1:${server.address().port}`;

  // Rewrite the fixture's placeholder EPG hosts to this ephemeral test server (port is only known
  // at runtime), so ContentGuideSource/customEpgUrl point at real, same-origin EPG endpoints.
  const rawXml = fs.readFileSync(path.join(__dirname, 'fixtures', 'service-list.xml'), 'utf8')
    .replace(/https:\/\/epg\.example\.com\/beta/g, `${baseUrl}/epg/schedule`)
    .replace(/https:\/\/example\.com\/epg\//g, `${baseUrl}/epg/`);
  app.get('/service-list.xml', (req, res) => res.type('application/xml').send(rawXml));
  app.get('/epg/schedule', (req, res) => res.type('application/xml').send(fixtureEpgXml()));
  app.get('/epg/nownext',  (req, res) => res.type('application/xml').send(fixtureEpgXml()));
  app.get('/service-list-5g.xml', (req, res) => res.type('application/xml').send(fixture5gXml(baseUrl)));
  // A list whose content guide answers 404, to check the re-acquisition of clause 4.3.3.4.
  app.get('/service-list-cg404.xml', (req, res) => {
    hits.cg404List++;
    res.type('application/xml').send(fixtureCg404Xml(baseUrl));
  });
  app.get('/epg/gone', (req, res) => { hits.cg404Guide++; res.status(404).end(); });

  // BROWSER selects the engine, chromium by default because it is the closest stand-in for what
  // most viewers run. Some environments cannot run it: where the sandbox stops a renderer process
  // acquiring resources, every subresource fetch fails with net::ERR_INSUFFICIENT_RESOURCES and
  // the renderer crashes, so the page loads and nothing renders. BROWSER=firefox runs the same
  // suite on an engine that does not use that process model and is unaffected.
  //
  // CHROMIUM_ARGS passes extra flags, and applies only to chromium: --single-process is one
  // workaround for the above, though a different engine is the more reliable one.
  const engine = process.env.BROWSER || 'chromium';
  if (!playwright[engine]) throw new Error(`Unknown BROWSER "${engine}", expected chromium, firefox or webkit`);
  const extraArgs = (process.env.CHROMIUM_ARGS || '').split(/\s+/).filter(Boolean);
  const opts = engine === 'chromium' && extraArgs.length ? { args: extraArgs } : {};
  browser = await playwright[engine].launch(opts);
  page = await browser.newPage({ ignoreHTTPSErrors: true });

  // The suite is hermetic: everything not served by the test server above is aborted. The receiver
  // pulls dash.js, hls.js and a web font from public CDNs, and those are <script> elements in the
  // document head, so where they are unreachable the document never reaches DOMContentLoaded and
  // page.goto times out however long it is given. Nothing asserted here needs a media player.
  await page.route('**/*', route => {
    route.request().url().startsWith(baseUrl) ? route.continue() : route.abort();
  });
});

after(async () => {
  if (page) await page.close();
  if (browser) await browser.close();
  if (server) await new Promise(r => server.close(r));
});

// Every goto waits for domcontentloaded, not networkidle. The receiver pulls dash.js, hls.js and a
// web font from public CDNs; where those are unreachable the requests stay open for as long as the
// environment takes to give up, so networkidle depends on the network rather than on the page being
// ready. What each test actually needs is asserted below with an explicit wait.
// Consequences of the deliberate abort above, not defects: the browser reports each blocked script
// as a CORS failure and as an integrity mismatch. Anything mentioning an origin the page was never
// allowed to reach is dropped; everything the receiver's own code raises is kept.
// Chromium reports a blocked request as "Failed to load resource: net::ERR_FAILED", with the URL only in
// the message's location, so the location is checked as well as the text. The fixture's logos sit on
// example.com, which is blocked the same way.
const BLOCKED_ORIGINS = ['cdn.jsdelivr.net', 'cdn.dashjs.org', 'fonts.gstatic.com', 'fonts.googleapis.com', 'example.com'];
const fromBlockedOrigin = (text, url = '') => BLOCKED_ORIGINS.some(h => text.includes(h) || url.includes(h));

test('receiver loads a service list and renders channels from it', { skip: !playwright }, async () => {
  const consoleErrors = [];
  const collect = (text, url) => { if (!fromBlockedOrigin(text, url)) consoleErrors.push(text); };
  page.on('pageerror', e => collect(String(e)));
  page.on('console', msg => { if (msg.type() === 'error') collect(msg.text(), msg.location().url); });

  await page.goto(`${baseUrl}/?url=${encodeURIComponent(baseUrl + '/service-list.xml')}`, { waitUntil: 'domcontentloaded' });

  // Channel list should render all three services from the fixture (Alpha One, Beta Radio,
  // and Gamma TV — the last being broadcast-only/DVB-T with no IP delivery, listed rather
  // than silently dropped).
  await page.waitForSelector('.ch-name', { timeout: 10000 });
  const names = await page.$$eval('.ch-name', els => els.map(e => e.textContent.trim()));
  assert.equal(names.length, 3, `expected 3 channels, got: ${JSON.stringify(names)}`);
  assert.ok(names.some(n => n.includes('Alpha One')), `expected "Alpha One" among: ${JSON.stringify(names)}`);
  assert.ok(names.some(n => n.includes('Beta Radio')), `expected "Beta Radio" among: ${JSON.stringify(names)}`);
  assert.ok(names.some(n => n.includes('Gamma TV')), `expected "Gamma TV" among: ${JSON.stringify(names)}`);

  // No uncaught JS errors during load/parse/render.
  assert.deepEqual(consoleErrors, [], `unexpected console/page errors: ${JSON.stringify(consoleErrors)}`);
});

test('selecting a channel updates the toolbar name', { skip: !playwright }, async () => {
  // Beta Radio has no subscriptionPackage, so selection is immediate (no gate modal to dismiss
  // first) — Alpha One in the fixture is gated and would need that separate interaction tested).
  await page.click('.ch-card:has(.ch-name:text("Beta Radio"))');
  await page.waitForSelector('#tb-name:has-text("Beta Radio")', { timeout: 5000 });
  const tbName = (await page.textContent('#tb-name')).trim();
  assert.equal(tbName, 'Beta Radio');
  assert.ok(await page.$('.ch-card.active:has(.ch-name:text("Beta Radio"))'), 'clicked card should get the .active class');
});

// Regression test: DVBIEpg.load() used to silently return null whenever resolveUrl() produced a
// relative "/proxy?url=..." string (any cross-origin EPG endpoint), because a stale http(s)-only
// guard rejected it before ever calling fetch() — the EPG strip stayed on "Loading…" forever with
// no console error and no network request at all. Fixed by building the full endpoint+params URL
// BEFORE resolving/proxying it, not after.
test('EPG data actually loads and renders (not stuck on "Loading…")', { skip: !playwright }, async () => {
  await page.waitForSelector('.epg-label:has-text("Beta Radio")', { timeout: 5000 });
  await page.waitForFunction(
    () => !document.querySelector('#epg-strip')?.textContent.includes('Loading…'),
    { timeout: 8000 }
  );
  const stripText = await page.textContent('#epg-strip');
  assert.ok(stripText.includes('Fixture Now Playing'), `expected the fixture programme title in the EPG strip, got: ${stripText}`);
});

// Regression test: services whose only ServiceInstance is broadcast delivery (DVB-T/S/C tuning
// triplet, no DASH/HLS/multicast) used to be silently excluded from the channel list entirely —
// a browser has no TV tuner so there was nothing to play, but the service just vanished with no
// indication of why. Now it is listed with a "Broadcast only" badge, and selecting it shows a
// clear explanation instead of a confusing "stream unavailable" error or a crash.
test('broadcast-only service is listed with a badge and a clear selection message', { skip: !playwright }, async () => {
  const card = page.locator('.ch-card:has(.ch-name:text("Gamma TV"))');
  await card.waitFor({ timeout: 5000 });
  assert.ok(await card.evaluate(el => el.classList.contains('no-delivery')), 'Gamma TV card should have the no-delivery class');
  const badge = await card.locator('.ch-badge:text("Broadcast only")').textContent();
  assert.equal(badge.trim(), 'Broadcast only');

  await card.click();
  await page.waitForSelector('#tb-name:has-text("Gamma TV")', { timeout: 5000 });
  await page.waitForSelector('#play-error:not([hidden])', { timeout: 5000 });
  const errorText = (await page.textContent('#play-error-msg')).trim();
  assert.match(errorText, /Broadcast-only service.*not available via broadband/);
});

// The registry is a distinct component of the DVB-I architecture (TS 103 770 V1.2.1 clause 4.1),
// and its response format is not the one some deployed registries return. Both shapes are parsed,
// so this checks the conformant one without losing the other.
test('the registry lookup parses a conformant ServiceListEntryPoints document', { skip: !playwright }, async () => {
  const conformant = `<?xml version="1.0" encoding="UTF-8"?>
<ServiceListEntryPoints xml:lang="en"
  xmlns="urn:dvb:metadata:servicelistdiscovery:2024"
  xmlns:dvbisd-t="urn:dvb:metadata:servicediscovery-types:2023">
  <ServiceListRegistryEntity><Name>Test Registry</Name></ServiceListRegistryEntity>
  <ProviderOffering>
    <Provider><Name>Test Provider</Name></Provider>
    <ServiceListOffering>
      <dvbisd-t:ServiceListName>Test List</dvbisd-t:ServiceListName>
      <dvbisd-t:ServiceListURI contentType="application/xml">
        <dvbisd-t:URI>https://example.com/a.xml</dvbisd-t:URI>
      </dvbisd-t:ServiceListURI>
      <dvbisd-t:ServiceListURI contentType="application/xml">
        <dvbisd-t:URI>https://backup.example.com/a.xml</dvbisd-t:URI>
      </dvbisd-t:ServiceListURI>
      <dvbisd-t:Delivery><dvbisd-t:DASHDelivery/></dvbisd-t:Delivery>
      <dvbisd-t:ServiceListId>tag:example.com,2026:list:a</dvbisd-t:ServiceListId>
    </ServiceListOffering>
  </ProviderOffering>
</ServiceListEntryPoints>`;

  const entries = await page.evaluate(xml => {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    return parseSLRResponse(doc);
  }, conformant);

  assert.ok(entries, 'a conformant registry response must be understood');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'Test List');
  assert.deepEqual(entries[0].urls,
    ['https://example.com/a.xml', 'https://backup.example.com/a.xml'],
    'both URIs of one offering are kept, as fallbacks for the same list');
});

test('the registry lookup still parses the older ProviderOffering shape', { skip: !playwright }, async () => {
  const legacy = `<?xml version="1.0" encoding="UTF-8"?>
<ProviderOffering xmlns="urn:dvb:metadata:servicediscovery:2024">
  <ProviderName>Legacy Provider</ProviderName>
  <ServiceList>
    <ServiceListName>Legacy List</ServiceListName>
    <ServiceListURI>https://legacy.example.com/list.xml</ServiceListURI>
  </ServiceList>
</ProviderOffering>`;

  const entries = await page.evaluate(xml => {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    return parseSLRResponse(doc);
  }, legacy);

  assert.ok(entries, 'the shape deployed registries return must keep working');
  assert.equal(entries[0].name, 'Legacy List');
  assert.deepEqual(entries[0].urls, ['https://legacy.example.com/list.xml']);
});

// This client cannot reach an MBMS Client, so for 5G Broadcast it checks the signalling and shows it:
// the badge names the locator and its MBMS User Service, or says what is wrong with the locator.
// The hybrid service still plays over its DASH instance; the others cannot play and say why.
// Runs last: it navigates away from the main fixture list.
test('5G Broadcast instances are badged with their checked mbms:// signalling', { skip: !playwright }, async () => {
  await page.goto(`${baseUrl}/?url=${encodeURIComponent(baseUrl + '/service-list-5g.xml')}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ch-name', { timeout: 10000 });

  const hybrid = page.locator('.ch-card:has(.ch-name:text("Hybrid 5G"))');
  const badge = hybrid.locator('.ch-badge-5g');
  assert.equal((await badge.textContent()).trim(), '5G');
  const tip = await badge.getAttribute('data-tooltip');
  assert.match(tip, /MBMS User Service mbms:\/\/service1000\.mbms\.operator\.com\./, 'the badge names the serviceId');
  assert.match(tip, /plays another instance/);
  assert.equal(await hybrid.locator('.ch-badge-5g-bad').count(), 0);
  // The hybrid service still has a playable unicast instance, so it is not marked as undeliverable.
  assert.equal(await hybrid.evaluate(el => el.classList.contains('no-delivery')), false);

  const only = page.locator('.ch-card:has(.ch-name:text("Only 5G"))');
  assert.ok(await only.locator('.ch-badge-5g').count(), 'the 5G-only service carries the 5G badge too');
  assert.equal((await only.locator('.ch-badge-mc').textContent()).trim(), '5G only');
  await only.click();
  await page.waitForSelector('#play-error:not([hidden])', { timeout: 5000 });
  assert.match((await page.textContent('#play-error-msg')).trim(), /5G Broadcast only/);

  const bad = page.locator('.ch-card:has(.ch-name:text("Bad 5G"))');
  assert.ok(await bad.locator('.ch-badge-5g-bad').count(), 'an invalid locator is marked as such');
  assert.match(await bad.locator('.ch-badge-5g').getAttribute('data-tooltip'), /signalling is wrong/);
});

// TS 103 770 V1.2.1 clause 7.3: plain HTTP to a metadata endpoint that is not on the client's private
// subnet is refused, and the user is told why. Loopback is not an RFC 1918 subnet.
test('a service list over plain HTTP off the private subnet is refused, with the reason', { skip: !playwright }, async () => {
  const port = new URL(baseUrl).port;
  await page.goto(`${baseUrl}/?url=${encodeURIComponent(`http://127.0.0.1:${port}/service-list.xml`)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ch-error', { timeout: 10000 });
  assert.equal((await page.textContent('#list-name')).trim(), 'Load failed');
  assert.match(await page.textContent('.ch-error'), /HTTP 400: .*clause 7\.3/);
});

// TS 103 770 V1.2.1 clause 4.3.3.4: a 404 from a ContentGuideSource URL makes the client re-acquire the
// service list; a 404 again after that backs off rather than repeating the request.
test('a 404 from the content guide re-acquires the service list once, then backs off', { skip: !playwright }, async () => {
  hits.cg404List = 0; hits.cg404Guide = 0;
  await page.goto(`${baseUrl}/?url=${encodeURIComponent(baseUrl + '/service-list-cg404.xml')}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ch-name:text("Guide Gone")', { timeout: 10000 });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (hits.cg404List < 2 || hits.cg404Guide < 2)) await new Promise(r => setTimeout(r, 100));
  assert.equal(hits.cg404List, 2, 'the list is requested again after the guide 404');
  assert.equal(hits.cg404Guide, 2, 'the guide is requested again after the re-acquisition');
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(hits.cg404Guide, 2, 'a second 404 is not followed by an immediate repeat');
  assert.equal(hits.cg404List, 2, 'and the list is not re-acquired again');
});
