// Browser E2E smoke test using Playwright (raw API, not @playwright/test, to keep the toolchain
// uniform with the rest of the suite — assertions still go through node:test).
// Serves the receiver's own public/ folder plus a compliant fixture service list on one ephemeral
// port (same-origin) so the test exercises real parsing/rendering without weakening the SSRF guard
// on /proxy (which correctly blocks localhost — see server.js isPrivateIp).
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');

let browser, page, server, baseUrl;
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

// A service list carrying the LOCAL 5G delivery extension the provider emits (namespace
// urn:5g-mag:metadata:dvbi-5g:2026, see the provider's schemas/dvbi-5g-ext-1.0.xsd). Nothing in
// TS 103 770 defines MBMS delivery parameters, so the receiver must both understand the extension
// and make plain to the viewer that it is not DVB-defined. Two services: one hybrid (5G broadcast
// with a DASH unicast instance that actually plays), one 5G-only (nothing playable in a browser).
function fixture5gXml(base) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ServiceList
  xmlns="urn:dvb:metadata:servicediscovery:2024"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:dvbi5g="urn:5g-mag:metadata:dvbi-5g:2026"
  id="tag:dvbi.example,2024:servicelist:5g" version="1" xml:lang="en">
  <Name>5G Extension List</Name>
  <ProviderName>Sample Provider</ProviderName>
  <Service version="1">
    <UniqueIdentifier>tag:sample,2024:service:hybrid</UniqueIdentifier>
    <ServiceInstance priority="1">
      <DisplayName>Hybrid 5G</DisplayName>
      <OtherDeliveryParameters extensionName="urn:5g-mag:dvbi-5g:mbms" xsi:type="dvbi5g:MBMSDeliveryParametersType">
        <dvbi5g:ServiceLocator>urn:3gpp:mbms:service:hybrid</dvbi5g:ServiceLocator>
        <dvbi5g:ServiceClass>urn:dvb:metadata:serviceClass:DVB-I_Service_Instance:1</dvbi5g:ServiceClass>
        <dvbi5g:UnicastFallback>${base}/dash/hybrid.mpd</dvbi5g:UnicastFallback>
      </OtherDeliveryParameters>
    </ServiceInstance>
    <ServiceInstance priority="2">
      <DisplayName>Hybrid 5G</DisplayName>
      <DASHDeliveryParameters>
        <UriBasedLocation contentLinkType="application/dash+xml"><URI>${base}/dash/hybrid.mpd</URI></UriBasedLocation>
      </DASHDeliveryParameters>
    </ServiceInstance>
    <ServiceName>Hybrid 5G</ServiceName>
    <ProviderName>Sample Provider</ProviderName>
  </Service>
  <Service version="1">
    <UniqueIdentifier>tag:sample,2024:service:5gonly</UniqueIdentifier>
    <ServiceInstance priority="1">
      <DisplayName>Only 5G</DisplayName>
      <OtherDeliveryParameters extensionName="urn:5g-mag:dvbi-5g:mbms" xsi:type="dvbi5g:MBMSDeliveryParametersType">
        <dvbi5g:ServiceLocator>urn:3gpp:mbms:service:only</dvbi5g:ServiceLocator>
        <dvbi5g:ServiceClass>urn:dvb:metadata:serviceClass:DVB-I_Service_Instance:1</dvbi5g:ServiceClass>
      </OtherDeliveryParameters>
    </ServiceInstance>
    <ServiceName>Only 5G</ServiceName>
    <ProviderName>Sample Provider</ProviderName>
  </Service>
  <Service version="1">
    <UniqueIdentifier>tag:sample,2024:service:5gfallback</UniqueIdentifier>
    <ServiceInstance priority="1">
      <DisplayName>5G With Fallback</DisplayName>
      <OtherDeliveryParameters extensionName="urn:5g-mag:dvbi-5g:mbms" xsi:type="dvbi5g:MBMSDeliveryParametersType">
        <dvbi5g:ServiceLocator>urn:3gpp:mbms:service:fb</dvbi5g:ServiceLocator>
        <dvbi5g:ServiceClass>urn:dvb:metadata:serviceClass:DVB-I_Service_Instance:1</dvbi5g:ServiceClass>
        <dvbi5g:UnicastFallback>${base}/hls/fallback.m3u8</dvbi5g:UnicastFallback>
      </OtherDeliveryParameters>
    </ServiceInstance>
    <ServiceName>5G With Fallback</ServiceName>
    <ProviderName>Sample Provider</ProviderName>
  </Service>
</ServiceList>`;
}

before(async () => {
  if (!playwright) { console.log('playwright not installed — skipping E2E suite'); return; }

  const app = express();
  app.use(express.static(path.join(__dirname, '..', 'public')));
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Rewrite the fixture's placeholder EPG hosts to this ephemeral test server (port is only known
  // at runtime), so ContentGuideSource/customEpgUrl point at real, same-origin EPG endpoints.
  const rawXml = fs.readFileSync(path.join(__dirname, 'fixtures', 'service-list.xml'), 'utf8')
    .replace(/https:\/\/epg\.example\.com\/beta/g, `${baseUrl}/epg/schedule`)
    .replace(/https:\/\/example\.com\/epg\//g, `${baseUrl}/epg/`);
  app.get('/service-list.xml', (req, res) => res.type('application/xml').send(rawXml));
  app.get('/epg/schedule', (req, res) => res.type('application/xml').send(fixtureEpgXml()));
  app.get('/epg/nownext',  (req, res) => res.type('application/xml').send(fixtureEpgXml()));
  app.get('/service-list-5g.xml', (req, res) => res.type('application/xml').send(fixture5gXml(baseUrl)));

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
  page = await browser.newPage();

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

// The 5G delivery extension is local, not DVB-defined, so a viewer must be able to see both that
// the service reaches them over 5G broadcast and that this rests on an extension no DVB
// specification carries. Checks the badge on both the hybrid service (which still plays, over its
// unicast instance) and the 5G-only one (which cannot play in a browser and must say why).
// Runs last: it navigates away from the main fixture list.
test('services using the local 5G extension are badged as an extension', { skip: !playwright }, async () => {
  await page.goto(`${baseUrl}/?url=${encodeURIComponent(baseUrl + '/service-list-5g.xml')}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ch-name', { timeout: 10000 });

  const hybrid = page.locator('.ch-card:has(.ch-name:text("Hybrid 5G"))');
  const badge = hybrid.locator('.ch-badge-5g');
  assert.equal((await badge.textContent()).trim(), '5G ext');
  const tip = await badge.getAttribute('data-tooltip');
  assert.match(tip, /LOCAL extension/, 'the badge must say the extension is local, not DVB-defined');
  assert.match(tip, /urn:5g-mag:dvbi-5g:mbms/, 'the badge must name the extension');
  // The hybrid service still has a playable unicast instance, so it is not marked as undeliverable.
  assert.equal(await hybrid.evaluate(el => el.classList.contains('no-delivery')), false);

  const only = page.locator('.ch-card:has(.ch-name:text("Only 5G"))');
  assert.ok(await only.locator('.ch-badge-5g').count(), 'the 5G-only service carries the extension badge too');
  assert.equal((await only.locator('.ch-badge-mc').textContent()).trim(), '5G only');
  await only.click();
  await page.waitForSelector('#play-error:not([hidden])', { timeout: 5000 });
  assert.match((await page.textContent('#play-error-msg')).trim(), /5G broadcast \(MBMS\) only/);
});

// A service whose only instance is the local 5G extension, with a UnicastFallback URL: the
// receiver cannot join an MBMS bearer, so the fallback is what it must play, rather than showing
// "5G only" and saying the service lists no fallback. The fallback URL is not repeated by another
// instance in this service, and is an HLS playlist here to check the type is taken from the URL.
test('the 5G extension UnicastFallback is played when the 5G instance cannot be', { skip: !playwright }, async () => {
  await page.goto(`${baseUrl}/?url=${encodeURIComponent(baseUrl + '/service-list-5g.xml')}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ch-name', { timeout: 10000 });

  const card = page.locator('.ch-card:has(.ch-name:text("5G With Fallback"))');
  assert.equal(await card.locator('.ch-badge-mc').count(), 0, 'not shown as "5G only" when a fallback exists');
  assert.equal(await card.evaluate(el => el.classList.contains('no-delivery')), false);

  const inst = await page.evaluate(() => services.find(s => s.name === '5G With Fallback').instances);
  assert.equal(inst.length, 1);
  assert.equal(inst[0].url, `${baseUrl}/hls/fallback.m3u8`);
  assert.equal(inst[0].type, 'application/vnd.apple.mpegurl');

  // The player is the part that needs CDN libraries, so record what it is asked to play.
  await page.evaluate(() => { window.__played = []; DVBIPlayer.play = (v, url, type) => window.__played.push({ url, type }); });
  await card.click();
  const played = await page.evaluate(() => window.__played);
  assert.deepEqual(played, [{ url: `${baseUrl}/hls/fallback.m3u8`, type: 'application/vnd.apple.mpegurl' }]);
  assert.equal(await page.locator('#play-error').isHidden(), true, 'no "lists no unicast fallback" error');

  // Where the service already lists the same URL as an instance of its own, it is not doubled.
  const hybrid = await page.evaluate(() => services.find(s => s.name === 'Hybrid 5G').instances.map(i => i.url));
  assert.deepEqual(hybrid, [`${baseUrl}/dash/hybrid.mpd`]);
});

// There is no confirmed public registry address (the former default answers 404), so the field
// starts empty, a lookup without an address says so instead of sending a request, and the retired
// default stored by an earlier version is not offered again. The dead "DVB Sample" preset is gone.
test('the registry address has no default and says so when it is missing', { skip: !playwright }, async () => {
  await page.goto(`${baseUrl}/?url=${encodeURIComponent(baseUrl + '/service-list.xml')}`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('dvbi-slr-endpoint', 'https://slrdb.org/dvbi/provider-offerings'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ch-name', { timeout: 10000 });

  assert.equal(await page.inputValue('#slr-endpoint'), '', 'the retired default must not come back');
  assert.equal(await page.locator('.preset-btn:text("DVB Sample")').count(), 0);
  const presets = await page.$$eval('.preset-btn', els => els.map(e => e.dataset.url));
  assert.ok(presets.every(u => !/DVBproject\/dvbi-api-demos/.test(u)), 'no preset points at the 404 repository');

  const requests = [];
  page.on('request', r => requests.push(r.url()));
  await page.evaluate(() => { $('slr-input').value = 'GBR'; $('slr-load-btn').click(); });
  await page.waitForSelector('#slr-results:not([hidden])', { state: 'attached', timeout: 3000 });
  assert.match(await page.textContent('#slr-results'), /No Service List Registry address is set/);
  assert.equal(requests.filter(u => /TargetCountry|slrdb/.test(u)).length, 0, 'no request is sent without an address');
});

// TS 103 770 V1.2.1 table 16 / schema: ServiceInstance@priority is optional and defaults to 0, the
// highest priority. An instance without it must therefore come before one that says priority="1".
test('a ServiceInstance without @priority has priority 0 and sorts first', { skip: !playwright }, async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ServiceList xmlns="urn:dvb:metadata:servicediscovery:2024" id="tag:t,2026:l" version="1" xml:lang="en">
  <Name>P</Name><ProviderName>P</ProviderName>
  <Service version="1">
    <UniqueIdentifier>tag:t,2026:service:p</UniqueIdentifier>
    <ServiceInstance priority="1"><DisplayName>Explicit one</DisplayName>
      <DASHDeliveryParameters><UriBasedLocation contentType="application/dash+xml"><URI>https://x.example/one.mpd</URI></UriBasedLocation></DASHDeliveryParameters>
    </ServiceInstance>
    <ServiceInstance><DisplayName>No priority</DisplayName>
      <DASHDeliveryParameters><UriBasedLocation contentType="application/dash+xml"><URI>https://x.example/none.mpd</URI></UriBasedLocation></DASHDeliveryParameters>
    </ServiceInstance>
    <ServiceName>P</ServiceName><ProviderName>P</ProviderName>
  </Service>
</ServiceList>`;
  const inst = await page.evaluate(x => {
    const r = parseServiceList(new DOMParser().parseFromString(x, 'application/xml'));
    return r.services[0].instances.map(i => ({ url: i.url, priority: i.priority }));
  }, xml);
  assert.deepEqual(inst, [
    { url: 'https://x.example/none.mpd', priority: 0 },
    { url: 'https://x.example/one.mpd', priority: 1 },
  ]);
});
