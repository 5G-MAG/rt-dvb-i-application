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

  browser = await playwright.chromium.launch();
  page = await browser.newPage();
});

after(async () => {
  if (page) await page.close();
  if (browser) await browser.close();
  if (server) await new Promise(r => server.close(r));
});

test('receiver loads a service list and renders channels from it', { skip: !playwright }, async () => {
  const consoleErrors = [];
  page.on('pageerror', e => consoleErrors.push(String(e)));
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

  await page.goto(`${baseUrl}/?url=${encodeURIComponent(baseUrl + '/service-list.xml')}`, { waitUntil: 'networkidle' });

  // Channel list should render both services from the fixture (Alpha One, Beta Radio).
  await page.waitForSelector('.ch-name', { timeout: 10000 });
  const names = await page.$$eval('.ch-name', els => els.map(e => e.textContent.trim()));
  assert.equal(names.length, 2, `expected 2 channels, got: ${JSON.stringify(names)}`);
  assert.ok(names.some(n => n.includes('Alpha One')), `expected "Alpha One" among: ${JSON.stringify(names)}`);
  assert.ok(names.some(n => n.includes('Beta Radio')), `expected "Beta Radio" among: ${JSON.stringify(names)}`);

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
