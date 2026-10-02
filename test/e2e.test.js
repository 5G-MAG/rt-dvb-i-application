// Browser E2E smoke test using Playwright (raw API, not @playwright/test, to keep the toolchain
// uniform with the rest of the suite — assertions still go through node:test).
// Serves the receiver itself (server.js: public/ and /proxy) plus compliant fixture service lists on
// one ephemeral HTTPS port (same-origin) so the test exercises real parsing/rendering without
// weakening the SSRF guard on /proxy (which correctly blocks localhost — see server.js isPrivateIp).
// HTTPS because TS 103 770 V1.2.1 clause 7.3 requires HTTP over TLS to a metadata endpoint that is not
// on the client's private subnet, which loopback is not; the certificate is a throwaway one.
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
// A plain HTTP origin for the clause 7.3 warning test, allowlisted so the proxy's address guard
// lets it through; read when server.js is required.
const PLAIN_PORT = 45995;
process.env.PROXY_ALLOW_ORIGINS = `http://127.0.0.1:${PLAIN_PORT}`;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { makeCertificate } = require('./tls-fixture.js');

let browser, page, server, baseUrl, plainServer;
const hits = { cg404List: 0, cg404Guide: 0, playlist: 0, registryQuery: '' };
const cgRequests = [];
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

// Instance precedence (clause 5.2.13): "Timed" has an instance with no @priority, so priority 0, that
// is on air for a few seconds from the moment the list is served, and a priority 5 instance that is
// always on air; "Locked" has one instance under conditional access only and one under a DRM system
// the player does not know, so neither can play in a browser.
function fixtureSelectXml(base) {
  const until = new Date(Date.now() + 4000).toISOString();
  const dash = name => `<DASHDeliveryParameters><UriBasedLocation contentType="application/dash+xml"><dvbisd-t:URI>${base}/dash/${name}.mpd</dvbisd-t:URI></UriBasedLocation></DASHDeliveryParameters>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<ServiceList xmlns="urn:dvb:metadata:servicediscovery:2024"
  xmlns:dvbisd-t="urn:dvb:metadata:servicediscovery-types:2023"
  id="tag:dvbi.example,2024:servicelist:select" version="1" xml:lang="en">
  <Name>Selection List</Name>
  <ProviderName>Sample Provider</ProviderName>
  <Service version="1">
    <UniqueIdentifier>tag:sample,2024:service:timed</UniqueIdentifier>
    <ServiceInstance priority="5">
      <DisplayName>Timed Late</DisplayName>
      ${dash('late')}
    </ServiceInstance>
    <ServiceInstance>
      <DisplayName>Timed Early</DisplayName>
      <Availability><Period validTo="${until}"/></Availability>
      ${dash('early')}
    </ServiceInstance>
    <ServiceName>Timed</ServiceName>
    <ProviderName>Sample Provider</ProviderName>
  </Service>
  <Service version="1">
    <UniqueIdentifier>tag:sample,2024:service:locked</UniqueIdentifier>
    <ServiceInstance priority="1">
      <ContentProtection><CASystemId>0x0B00</CASystemId></ContentProtection>
      ${dash('ca')}
    </ServiceInstance>
    <ServiceInstance priority="2">
      <ContentProtection>
        <DRMSystemId encryptionScheme="cbcs">urn:uuid:00000000-0000-0000-0000-000000000000</DRMSystemId>
      </ContentProtection>
      ${dash('drm')}
    </ServiceInstance>
    <ServiceName>Locked</ServiceName>
    <ProviderName>Sample Provider</ProviderName>
  </Service>
</ServiceList>`;
}

// Service list handling (clauses 5.2.3, 5.2.4.2, 5.2.5.3, 5.2.7.3, 5.5.2, 5.5.4, 5.5.12, 5.5.28, 5.5.29).
function fixtureHandlingXml(base) {
  const dash = name => `<DASHDeliveryParameters><UriBasedLocation contentType="application/dash+xml"><dvbisd-t:URI>${base}/dash/${name}.mpd</dvbisd-t:URI></UriBasedLocation></DASHDeliveryParameters>`;
  const app = (term, url, type = 'text/html') => `<RelatedMaterial><tva:HowRelated href="urn:dvb:metadata:cs:LinkedApplicationCS:2019:${term}"/><tva:MediaLocator><tva:MediaUri contentType="${type}">${url}</tva:MediaUri></tva:MediaLocator></RelatedMaterial>`;
  const service = (uid, name, body, extra = '') => `
  <Service version="1">
    <UniqueIdentifier>tag:h,2026:${uid}</UniqueIdentifier>
    ${body}
    <ServiceName>${name}</ServiceName>
    <ProviderName>P</ProviderName>${extra}
  </Service>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<ServiceList xmlns="urn:dvb:metadata:servicediscovery:2024" xmlns:tva="urn:tva:metadata:2024"
  xmlns:dvbisd-t="urn:dvb:metadata:servicediscovery-types:2023"
  id="tag:h,2026:list" version="1" xml:lang="en">
  <Name>Handling List</Name>
  <ProviderName>P</ProviderName>
  <SubscriptionPackageList><SubscriptionPackage>Gold</SubscriptionPackage></SubscriptionPackageList>
  <LCNTableList>
    <LCNTable>
      <TargetRegion>R-N</TargetRegion><TargetRegion>R-NE</TargetRegion>
      <LCN channelNumber="5" serviceRef="tag:h,2026:multi"/>
    </LCNTable>
    <LCNTable>
      <LCN channelNumber="1" serviceRef="tag:h,2026:linear"/>
      <LCN channelNumber="2" serviceRef="tag:h,2026:hidden" visible="false"/>
      <LCN channelNumber="3" serviceRef="tag:h,2026:hiddennosel" visible="false" selectable="false"/>
      <LCNRange start="100" end="199" fillMethod="fillGaps"/>
    </LCNTable>
  </LCNTableList>${
  service('linear', 'Linear Default', `<ServiceInstance>${dash('linear')}</ServiceInstance>`)}${
  service('multi', 'Multi Region', `<ServiceInstance>${dash('multi')}</ServiceInstance><TargetRegion>R-S</TargetRegion><TargetRegion>R-NE</TargetRegion>`)}${
  service('hidden', 'Hidden', `<ServiceInstance>${dash('hidden')}</ServiceInstance>`)}${
  service('hiddennosel', 'Hidden NoSel', `<ServiceInstance>${dash('hiddennosel')}</ServiceInstance>`)}${
  service('app', 'App Service', `
    <ServiceInstance priority="0">${app('1.2', `${base}/app/controlling.html`)}${dash('ignored')}</ServiceInstance>
    <ServiceInstance priority="1">${app('1.1', `${base}/app/parallel.html`)}${dash('appfallback')}</ServiceInstance>`,
    app('1.1', `${base}/app/service.html`))}${
  service('ait', 'AIT Service', `<ServiceInstance>${app('1.2', `${base}/app/ait.xml`, 'application/vnd.dvb.ait+xml')}</ServiceInstance>`)}${
  service('aitnone', 'AIT None', `
    <ServiceInstance priority="0">${app('1.2', `${base}/app/ait-hbbtv.xml`, 'application/vnd.dvb.ait+xml')}</ServiceInstance>
    <ServiceInstance priority="1">${dash('aitnone')}</ServiceInstance>`)}${
  service('offair', 'Off Air App', `<ServiceInstance><Availability><Period validTo="2020-01-01T00:00:00Z"/></Availability>${dash('offair')}</ServiceInstance>`,
    app('2', `${base}/app/offair.html`))}${
  service('gold', 'Gold Only', `<ServiceInstance><SubscriptionPackage>Gold</SubscriptionPackage>${dash('gold')}</ServiceInstance>`)}${
  service('rated', 'Rated', `<ServiceInstance>${dash('rated')}</ServiceInstance>`, '<ParentalRating><MinimumAge>18</MinimumAge></ParentalRating>')}${
  service('apptype', 'App Type', `
    <ServiceInstance priority="0">${app('1.2', `${base}/app/controlling.apk`, 'application/vnd.android.package-archive')}${dash('apptypeignored')}</ServiceInstance>
    <ServiceInstance priority="1">${dash('apptypefallback')}</ServiceInstance>`)}${
  service('apptypeonly', 'App Type Only', `<ServiceInstance>${app('1.2', `${base}/app/controlling.apk`, 'application/vnd.android.package-archive')}${dash('apptypeonlyignored')}</ServiceInstance>`)}${
  service('aittb', 'AIT Toolbar', `<ServiceInstance>${app('1.1', `${base}/app/ait-slow.xml`, 'application/vnd.dvb.ait+xml')}${dash('aittb')}</ServiceInstance>`)}${
  service('aittbnone', 'AIT Toolbar None', `<ServiceInstance>${app('1.1', `${base}/app/ait-hbbtv.xml`, 'application/vnd.dvb.ait+xml')}${dash('aittbnone')}</ServiceInstance>`)}${
  service('vod', 'VoD', `<ServiceInstance>${dash('vod')}<RelatedMaterial><tva:HowRelated href="urn:dvb:metadata:cs:HowRelatedCS:2021:1000.2"/><tva:MediaLocator><tva:MediaUri contentType="image/png">${base}/img/finished.png</tva:MediaUri></tva:MediaLocator></RelatedMaterial></ServiceInstance>`)}
</ServiceList>`.replace(/<ServiceInstance([^>]*)>([\s\S]*?)<\/ServiceInstance>/g, (m, attrs, inner) => {
    // Schema order inside ServiceInstance: RelatedMaterial before delivery parameters.
    const rm = (inner.match(/<RelatedMaterial>[\s\S]*?<\/RelatedMaterial>/g) || []).join('');
    return `<ServiceInstance${attrs}>${rm}${inner.replace(/<RelatedMaterial>[\s\S]*?<\/RelatedMaterial>/g, '')}</ServiceInstance>`;
  });
}

// An XML AIT with an HbbTV application of higher priority, which this client cannot start, and an
// HTML5 one (clause 5.2.4.2).
function fixtureAit(base, hbbtvOnly = false) {
  const a = (type, prio, loc) => `<mhp:Application><mhp:applicationDescriptor><mhp:type><mhp:OtherApp>${type}</mhp:OtherApp></mhp:type>
    <mhp:priority>${prio}</mhp:priority></mhp:applicationDescriptor>
    <mhp:applicationTransport><mhp:URLBase>${base}/app/</mhp:URLBase></mhp:applicationTransport>
    <mhp:applicationLocation>${loc}</mhp:applicationLocation></mhp:Application>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<mhp:ServiceDiscovery xmlns:mhp="urn:dvb:mhp:2009"><mhp:ApplicationDiscovery DomainName="example"><mhp:ApplicationList>
${a('application/vnd.hbbtv.xhtml+xml', 5, 'hbbtv.html')}${hbbtvOnly ? '' : a('text/html', 1, 'fromait.html')}
</mhp:ApplicationList></mhp:ApplicationDiscovery></mhp:ServiceDiscovery>`;
}

// A registry response (clause 5.3) with a plain list, a regulator's list, a list that requires DVB-T,
// and a list whose ServiceListId differs from the list's @id.
// With regulatorDvbs, the regulator's list requires DVB-S, which this client cannot receive.
function fixtureRegistryXml(base, { regulatorDvbs = false } = {}) {
  const offering = (name, uri, id, { flag = false, delivery = '<dvbisd-t:DASHDelivery/>', extra = '' } = {}) => `
    <ServiceListOffering${flag ? ' regulatorListFlag="true"' : ''}>
      <dvbisd-t:ServiceListName>${name}</dvbisd-t:ServiceListName>
      <dvbisd-t:ServiceListURI contentType="application/vnd.dvb.dvbisl+xml"><dvbisd-t:URI>${uri}</dvbisd-t:URI></dvbisd-t:ServiceListURI>
      <dvbisd-t:Delivery>${delivery}</dvbisd-t:Delivery>${extra}
      <dvbisd-t:ServiceListId>${id}</dvbisd-t:ServiceListId>
    </ServiceListOffering>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<ServiceListEntryPoints xml:lang="en" xmlns="urn:dvb:metadata:servicelistdiscovery:2024"
  xmlns:dvbisd-t="urn:dvb:metadata:servicediscovery-types:2023">
  <ServiceListRegistryEntity regulatorFlag="true"><Name>Test Registry</Name></ServiceListRegistryEntity>
  <ProviderOffering>
    <Provider><Name>Plain Provider</Name></Provider>${
    offering('Plain List', `${base}/service-list.xml`, 'tag:dvbi.example,2024:servicelist:default')}${
    offering('Wrong Id List', `${base}/service-list-5g.xml`, 'tag:wrong,2026:id')}${
    offering('Terrestrial List', `${base}/service-list.xml`, 'tag:t,2026:t', { delivery: '<dvbisd-t:DVBTDelivery required="true"/>' })}
  </ProviderOffering>
  <ProviderOffering>
    <Provider regulatorFlag="true"><Name>Regulator</Name></Provider>${
    offering('Regulator List', `${base}/service-list-handling.xml`, 'tag:h,2026:list', { flag: true,
      ...(regulatorDvbs ? { delivery: '<dvbisd-t:DVBSDelivery required="true"/>' } : {}), extra: '<dvbisd-t:Language>en</dvbisd-t:Language><dvbisd-t:TargetCountry>GBR</dvbisd-t:TargetCountry>' })}
  </ProviderOffering>
</ServiceListEntryPoints>`;
}

// Content guide sources by the precedence of clause 6.1: "Own" has its own ContentGuideSource,
// "Ref" a ContentGuideSourceRef into the ContentGuideSourceList and a ContentGuideServiceRef,
// "Top" neither, so the list-level ContentGuideSource applies.
function fixtureGuideListXml(base) {
  const cgs = (id, path, extra = '') => `<ContentGuideSource CGSID="${id}"><ProviderName>CG</ProviderName>
      <ScheduleInfoEndpoint contentType="application/xml"><dvbisd-t:URI>${base}/cg/${path}/schedule</dvbisd-t:URI></ScheduleInfoEndpoint>${extra}</ContentGuideSource>`;
  const full = `
      <ProgramInfoEndpoint contentType="application/xml"><dvbisd-t:URI>${base}/cg/top/program</dvbisd-t:URI></ProgramInfoEndpoint>
      <GroupInfoEndpoint contentType="application/xml"><dvbisd-t:URI>${base}/cg/top/group/</dvbisd-t:URI></GroupInfoEndpoint>
      <MoreEpisodesEndpoint contentType="application/xml"><dvbisd-t:URI>${base}/cg/top/more</dvbisd-t:URI></MoreEpisodesEndpoint>`;
  const service = (uid, name, guide) => `
  <Service version="1">
    <UniqueIdentifier>tag:g,2026:${uid}</UniqueIdentifier>
    <ServiceInstance><DASHDeliveryParameters><UriBasedLocation contentType="application/dash+xml"><dvbisd-t:URI>${base}/dash/${uid}.mpd</dvbisd-t:URI></UriBasedLocation></DASHDeliveryParameters></ServiceInstance>
    <ServiceName>${name}</ServiceName><ProviderName>P</ProviderName>${guide}
  </Service>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<ServiceList xmlns="urn:dvb:metadata:servicediscovery:2024" xmlns:dvbisd-t="urn:dvb:metadata:servicediscovery-types:2023"
  id="tag:g,2026:list" version="1" xml:lang="en">
  <Name>Guide List</Name><ProviderName>P</ProviderName>
  <ContentGuideSourceList>${cgs('listed', 'ref')}</ContentGuideSourceList>
  ${cgs('top', 'top', full)}${
  service('top', 'Top', '')}${
  service('ref', 'Ref', '<ContentGuideSourceRef>listed</ContentGuideSourceRef><ContentGuideServiceRef>shared</ContentGuideServiceRef>')}${
  service('own', 'Own', cgs('own', 'own'))}
</ServiceList>`;
}

// TV-Anytime responses as clauses 6.5 to 6.9 describe them. Schedule requests are checked against
// clause 6.5.2.1 and answered 400 when they break it; every request is recorded in cgRequests.
function fixtureGuide(req, res, base) {
  cgRequests.push(req.originalUrl);
  const q = new URL(req.originalUrl, base).searchParams;
  const path = req.params[0];
  const now = Date.now();
  const iso = ms => new Date(ms).toISOString();
  const tva = body => `<?xml version="1.0" encoding="UTF-8"?>
<TVAMain xmlns="urn:tva:metadata:2024" xmlns:mpeg7="urn:tva:mpeg7:2008" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xml:lang="en">
  <ProgramDescription>${body}</ProgramDescription></TVAMain>`;
  const pi = (crid, title, extra = '') => `<ProgramInformation programId="${crid}"><BasicDescription>
      <Title type="main">${title}</Title><Synopsis length="short">${title} short</Synopsis>${extra}</BasicDescription></ProgramInformation>`;
  const ev = (crid, startMs, mins) => `<ScheduleEvent><Program crid="${crid}"/><PublishedStartTime>${iso(startMs)}</PublishedStartTime><PublishedDuration>PT${mins}M</PublishedDuration></ScheduleEvent>`;
  const od = (crid, ait, template) => `<OnDemandProgram serviceIDRef="tag:g,2026:top"><Program crid="${crid}"/>
      <ProgramURL contentType="application/vnd.dvb.ait+xml">${base}/cg/ait/${ait}</ProgramURL>
      <AuxiliaryURL contentType="application/vnd.dvb.ait+xml">${base}/cg/ait/${template}</AuxiliaryURL>
      <PublishedDuration>PT30M</PublishedDuration><StartOfAvailability>${iso(now - 86400000)}</StartOfAvailability>
      <EndOfAvailability>${iso(now + 86400000)}</EndOfAvailability><DeliveryMode>streaming</DeliveryMode><Free value="true"/></OnDemandProgram>`;
  const ait = (type, loc) => `<?xml version="1.0" encoding="UTF-8"?><mhp:ServiceDiscovery xmlns:mhp="urn:dvb:mhp:2009"><mhp:ApplicationDiscovery DomainName="g">
    <mhp:ApplicationList><mhp:Application><mhp:applicationDescriptor><mhp:type><mhp:OtherApp>${type}</mhp:OtherApp></mhp:type><mhp:priority>1</mhp:priority></mhp:applicationDescriptor>
    <mhp:applicationTransport><mhp:URLBase>${base}/app/</mhp:URLBase></mhp:applicationTransport><mhp:applicationLocation>${loc}</mhp:applicationLocation></mhp:Application></mhp:ApplicationList></mhp:ApplicationDiscovery></mhp:ServiceDiscovery>`;
  const xml = body => res.type('application/xml').send(body);
  const group = (id, title, extra = '') => `<GroupInformation groupId="${id}"><BasicDescription><Title>${title}</Title>${extra}</BasicDescription></GroupInformation>`;
  const page = (href, url) => `<RelatedMaterial><HowRelated href="urn:fvc:metadata:cs:HowRelatedCS:2015-12:pagination:${href}"/><MediaLocator><MediaUri>${url.replace(/&/g, '&amp;')}</MediaUri></MediaLocator></RelatedMaterial>`;
  const member = (crid, index) => `<MemberOf xsi:type="MemberOfType" crid="${crid}" index="${index}"/>`;

  if (/\/schedule$/.test(path)) {
    if (q.get('now_next')) {
      // Clause 6.5.4.4: the current event in the now group, the next one in the later group. The
      // current one carries an 18 rating; listed later first, so order comes from the groups.
      const N = 'crid://dvb.org/metadata/schedules/now-next/';
      return xml(tva(`<ProgramInformationTable>
        ${pi('crid://g/next', 'Next Show').replace('</ProgramInformation>', member(N + 'later', 1) + '</ProgramInformation>')}
        ${pi('crid://g/now', 'Now Show', '<ParentalGuidance><mpeg7:MinimumAge>18</mpeg7:MinimumAge></ParentalGuidance>').replace('</ProgramInformation>', member(N + 'now', 1) + '</ProgramInformation>')}
      </ProgramInformationTable>
      <GroupInformationTable>${group(N + 'now', 'now')}${group(N + 'later', 'later')}</GroupInformationTable>
      <ProgramLocationTable><Schedule serviceIDRef="${q.get('sid')}">${ev('crid://g/next', now + 1200000, 30)}${ev('crid://g/now', now - 600000, 30)}</Schedule></ProgramLocationTable>`));
    }
    const start = Number(q.get('start')), end = Number(q.get('end'));
    if (!(start % 10800 === 0 && end % 10800 === 0 && [21600, 43200].includes(end - start))) return res.status(400).end();
    const pastStart = now - 45 * 60000;   // ended a quarter of an hour ago
    const inWindow = pastStart >= start * 1000 && pastStart < end * 1000;
    return xml(tva(`<ProgramInformationTable>${inWindow ? pi('crid://g/past', 'Past Show') : ''}</ProgramInformationTable>
      <ProgramLocationTable><Schedule serviceIDRef="${q.get('sid')}" start="${iso(start * 1000)}" end="${iso(end * 1000)}">${inWindow ? ev('crid://g/past', pastStart, 30) : ''}</Schedule>
      ${inWindow ? od('crid://g/past', 'deep.xml?pid=past', 'template-ok.xml') : ''}</ProgramLocationTable>`));
  }
  if (/\/program$/.test(path)) {
    return xml(tva(`<ProgramInformationTable><ProgramInformation programId="${q.get('pid')}"><BasicDescription><Title type="main">Detail</Title>
      <Synopsis length="long">The long synopsis from the programme information endpoint</Synopsis></BasicDescription></ProgramInformation></ProgramInformationTable><ProgramLocationTable/>`));
  }
  const results = (items, links = '') => xml(tva(`<ProgramInformationTable>${items.map(([crid, title, index]) =>
      pi(crid, title).replace('</ProgramInformation>', member('crid://g/results', index) + '</ProgramInformation>')).join('')}</ProgramInformationTable>
    <GroupInformationTable><GroupInformation groupId="crid://g/results" ordered="true" numOfItems="3"><BasicDescription>${links}</BasicDescription></GroupInformation></GroupInformationTable>
    <ProgramLocationTable>${items.map(([crid, , , template]) => od(crid, 'deep.xml?pid=' + encodeURIComponent(crid), template)).join('')}</ProgramLocationTable>`));
  if (/\/more$/.test(path)) {
    const next = `${base}/cg/top/more?pid=${encodeURIComponent(q.get('pid'))}&type=ondemand&page=2`;
    if (q.get('page') === '2') return results([['crid://g/ep3', 'Episode 3', 3, 'template-ok.xml']], page('first', next.replace('&page=2', '')) + page('prev', next.replace('&page=2', '')));
    return results([['crid://g/ep2', 'Episode 2', 2, 'template-ok.xml'], ['crid://g/ep1', 'Episode 1', 1, 'template-hbbtv.xml']],
      page('next', next) + page('last', next));
  }
  if (/\/group\/categories$/.test(path)) return xml(tva(`<GroupInformationTable>${group('crid://g/cat/drama', 'Drama')}</GroupInformationTable>`));
  if (/\/group\/$/.test(path)) {
    const tmpl = t => `<RelatedMaterial><HowRelated href="urn:fvc:metadata:cs:HowRelatedCS:2018:templateAIT"/><MediaLocator><MediaUri/><AuxiliaryURI contentType="application/vnd.dvb.ait+xml">${base}/cg/ait/${t}</AuxiliaryURI></MediaLocator></RelatedMaterial>`;
    return xml(tva(`<GroupInformationTable>${group('crid://g/box/ok', 'Playable Box', tmpl('template-ok.xml'))}${group('crid://g/box/hbbtv', 'HbbTV Box', tmpl('template-hbbtv.xml'))}</GroupInformationTable>`));
  }
  if (/\/group\/contents$/.test(path)) return results([['crid://g/box/e1', 'Box Episode', 1, 'template-ok.xml']]);
  if (path === 'ait/deep.xml') return res.type('application/vnd.dvb.ait+xml').send(ait('text/html', `ondemand.html?pid=${q.get('pid')}`));
  if (path === 'ait/template-ok.xml') return res.type('application/vnd.dvb.ait+xml').send(ait('text/html', ''));
  if (path === 'ait/template-hbbtv.xml') return res.type('application/vnd.dvb.ait+xml').send(ait('application/vnd.hbbtv.xhtml+xml', ''));
  res.status(404).end();
}

// DVB-I Playlists (clauses 5.2.7 and 5.7): a service whose instance is a playlist (application/xml)
// with a content finished image, and one whose playlist server answers 404 before a plain MPD.
function fixturePlaylistListXml(base) {
  const loc = (type, url) => `<DASHDeliveryParameters><UriBasedLocation contentType="${type}"><dvbisd-t:URI>${url}</dvbisd-t:URI></UriBasedLocation></DASHDeliveryParameters>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<ServiceList xmlns="urn:dvb:metadata:servicediscovery:2024" xmlns:tva="urn:tva:metadata:2024"
  xmlns:dvbisd-t="urn:dvb:metadata:servicediscovery-types:2023" id="tag:p,2026:list" version="1" xml:lang="en">
  <Name>Playlist List</Name><ProviderName>P</ProviderName>
  <Service version="1">
    <UniqueIdentifier>tag:p,2026:pl</UniqueIdentifier>
    <ServiceInstance>
      <RelatedMaterial><tva:HowRelated href="urn:dvb:metadata:cs:HowRelatedCS:2021:1000.2"/><tva:MediaLocator><tva:MediaUri contentType="image/png">${base}/img/finished.png</tva:MediaUri></tva:MediaLocator></RelatedMaterial>
      ${loc('application/xml', `${base}/playlists/mine.xml`)}
    </ServiceInstance>
    <ServiceName>Playlist Service</ServiceName><ProviderName>P</ProviderName>
  </Service>
  <Service version="1">
    <UniqueIdentifier>tag:p,2026:gone</UniqueIdentifier>
    <ServiceInstance priority="0">${loc('application/xml', `${base}/playlists/gone.xml`)}</ServiceInstance>
    <ServiceInstance priority="1">${loc('application/dash+xml', `${base}/dash/plain.mpd`)}</ServiceInstance>
    <ServiceName>Gone Playlist</ServiceName><ProviderName>P</ProviderName>
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
  plainServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end(rawXml);
  });
  await new Promise(r => { plainServer.once('error', () => { plainServer = null; r(); }); plainServer.listen(PLAIN_PORT, '127.0.0.1', r); });
  app.get('/epg/schedule', (req, res) => res.type('application/xml').send(fixtureEpgXml()));
  app.get('/epg/nownext',  (req, res) => res.type('application/xml').send(fixtureEpgXml()));
  app.get('/service-list-5g.xml', (req, res) => res.type('application/xml').send(fixture5gXml(baseUrl)));
  // A list whose content guide answers 404, to check the re-acquisition of clause 4.3.3.4.
  app.get('/service-list-cg404.xml', (req, res) => {
    hits.cg404List++;
    res.type('application/xml').send(fixtureCg404Xml(baseUrl));
  });
  app.get('/epg/gone', (req, res) => { hits.cg404Guide++; res.status(404).end(); });
  app.get('/service-list-select.xml', (req, res) => res.type('application/xml').send(fixtureSelectXml(baseUrl)));
  app.get('/service-list-handling.xml', (req, res) => res.type('application/xml').send(fixtureHandlingXml(baseUrl)));
  app.get('/app/:page.html', (req, res) => res.type('text/html').send(`<!doctype html><title>${req.params.page}</title><p>${req.params.page}</p>`));
  app.get('/app/ait.xml', (req, res) => res.type('application/vnd.dvb.ait+xml').send(fixtureAit(baseUrl)));
  app.get('/app/ait-slow.xml', (req, res) => setTimeout(() => res.type('application/vnd.dvb.ait+xml').send(fixtureAit(baseUrl)), 1000));
  app.get('/app/ait-hbbtv.xml', (req, res) => res.type('application/vnd.dvb.ait+xml').send(fixtureAit(baseUrl, true)));
  // Content guide server written from clause 6 (see fixtureGuide below).
  app.get('/service-list-guide.xml', (req, res) => res.type('application/xml').send(fixtureGuideListXml(baseUrl)));
  app.get(/^\/cg\/(.*)$/, (req, res) => fixtureGuide(req, res, baseUrl));
  app.get('/service-list-playlist.xml', (req, res) => res.type('application/xml').send(fixturePlaylistListXml(baseUrl)));
  app.get('/playlists/:name.xml', (req, res) => {
    hits.playlist++;
    if (req.params.name === 'gone') return res.status(404).end();
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Playlist xmlns="urn:dvb:metadata:servicediscovery:2024">
  <PlaylistEntry>${baseUrl}/dash/clip1.mpd</PlaylistEntry>
  <PlaylistEntry>${baseUrl}/dash/clip2.mpd</PlaylistEntry>
</Playlist>`);
  });
  app.get('/registry', (req, res) => { hits.registryQuery = req.originalUrl; res.type('application/xml').send(fixtureRegistryXml(baseUrl)); });
  app.get('/registry-reg-dvbs', (req, res) => res.type('application/xml').send(fixtureRegistryXml(baseUrl, { regulatorDvbs: true })));
  app.get('/img/finished.png', (req, res) => res.type('image/png').send(Buffer.alloc(0)));

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
  if (plainServer) await new Promise(r => plainServer.close(r));
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
  // The toolbar shows the playing instance's DisplayName (TS 103 770 V1.2.1 clause 5.5.4, table 16),
  // "Beta HLS", where the browser can play HLS natively; the service name where no instance can play
  // (hls.js is not loaded in this suite, and the other instance is multicast).
  await page.click('.ch-card:has(.ch-name:text("Beta Radio"))');
  await page.waitForSelector('#tb-name:text-matches("^Beta (Radio|HLS)$")', { timeout: 5000 });
  const tbName = (await page.textContent('#tb-name')).trim();
  const nativeHls = await page.evaluate(() => document.createElement('video').canPlayType('application/vnd.apple.mpegurl') !== '');
  assert.equal(tbName, nativeHls ? 'Beta HLS' : 'Beta Radio');
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

// TS 103 770 V1.2.1 clause 7.3 and the owner's decision: a service list over plain HTTP is loaded,
// and a warning beside it says the request is not over TLS and quotes the clause's exception.
test('a service list over plain HTTP loads, with the clause 7.3 warning beside it', { skip: !playwright }, async (t) => {
  if (!plainServer) { t.skip(`port ${PLAIN_PORT} is in use`); return; }
  await page.goto(`${baseUrl}/?url=${encodeURIComponent(`http://127.0.0.1:${PLAIN_PORT}/service-list.xml`)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ch-name', { timeout: 10000 });
  await page.waitForSelector('#tls-warn:not([hidden])', { timeout: 5000 });
  const warning = await page.textContent('#tls-warn');
  assert.match(warning, /Not over TLS/);
  assert.match(warning, /clause 7\.3/);
  assert.ok(warning.includes('For the specific case that a DVB-I client connects to a DVB-I metadata endpoint ' +
    'located on the same private subnet (see clause 3 of IETF RFC 1918 [27]), HTTP may be used without TLS.'));

  // The same list over TLS carries no warning.
  await page.goto(`${baseUrl}/?url=${encodeURIComponent(baseUrl + '/service-list.xml')}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ch-name', { timeout: 10000 });
  assert.equal(await page.isHidden('#tls-warn'), true);
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

// TS 103 770 V1.2.1 clause 5.2.13. The media player is replaced by a recorder (the suite has no
// dash.js, and Playwright's Chromium has no H.264), so what is checked is which instance the client
// hands to the player, and when.
test('instance precedence: @priority default 0, DisplayName, re-evaluation at the end of scheduled hours', { skip: !playwright }, async () => {
  await page.goto(`${baseUrl}/?url=${encodeURIComponent(baseUrl + '/service-list-select.xml')}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ch-name:text("Timed")', { timeout: 10000 });
  await page.evaluate(() => {
    window.dashjs = window.dashjs || {};
    window.__plays = [];
    DVBIPlayer.play = (video, url) => { window.__plays.push(url); };
  });
  await page.click('.ch-card:has(.ch-name:text("Timed"))');
  await page.waitForFunction(() => window.__plays.length === 1, null, { timeout: 5000 });
  assert.match(await page.evaluate(() => window.__plays[0]), /early\.mpd$/, 'the instance without @priority (0) comes before priority 5');
  assert.equal((await page.textContent('#tb-name')).trim(), 'Timed Early', 'the playing instance\'s DisplayName is shown');

  await page.waitForFunction(() => window.__plays.length === 2, null, { timeout: 8000 });
  assert.match(await page.evaluate(() => window.__plays[1]), /late\.mpd$/, 'leaving its scheduled hours hands over to the next instance');
  assert.equal((await page.textContent('#tb-name')).trim(), 'Timed Late');
});

test('instances that cannot play in a browser are discarded before any is tried', { skip: !playwright }, async () => {
  await page.evaluate(() => { window.__plays = []; });
  await page.click('.ch-card:has(.ch-name:text("Locked"))');
  await page.waitForSelector('#play-error:not([hidden])', { timeout: 5000 });
  const msg = (await page.textContent('#play-error-msg')).trim();
  assert.match(msg, /conditional access only/);
  assert.match(msg, /DRM systems this client does not know/);
  assert.equal(await page.evaluate(() => window.__plays.length), 0, 'nothing was handed to the player');
});

// Service list handling, TS 103 770 V1.2.1 clause 5. The player is a recorder, as above.
async function openHandlingList() {
  await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${baseUrl}/?url=${encodeURIComponent(baseUrl + '/service-list-handling.xml')}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ch-name:text("Linear Default")', { timeout: 10000 });
  await page.evaluate(() => {
    window.dashjs = window.dashjs || {};
    window.__plays = [];
    DVBIPlayer.play = (video, url) => { window.__plays.push(url); };
  });
}
// A locked service's name carries a lock sign in front.
const card = name => page.locator('.ch-card').filter({ has: page.locator('.ch-name', { hasText: new RegExp(`^(🔒 )?${name}$`) }) });
const lcnOf = async name => (await card(name).locator('.ch-lcn').textContent()).trim();
const plays = () => page.evaluate(() => window.__plays);

test('channel numbers: one table, @visible, @selectable, LCNRange, every TargetRegion', { skip: !playwright }, async () => {
  await openHandlingList();
  assert.equal(await lcnOf('Linear Default'), '1');
  assert.equal(await card('Hidden').count(), 1);
  assert.equal(await card('Hidden').isHidden(), true, '@visible false: not in the channel list');
  assert.equal(await lcnOf('Multi Region'), '100', 'no LCN in the national table: numbered from the LCNRange');

  // Direct entry reaches a hidden selectable service, not a hidden unselectable one.
  await page.keyboard.press('2');
  await page.waitForSelector('#tb-name:text("Hidden")', { timeout: 5000 });
  await page.keyboard.press('3');
  await new Promise(r => setTimeout(r, 2000));
  assert.equal((await page.textContent('#tb-name')).trim(), 'Hidden', '@selectable false: number 3 selects nothing');

  // Region R-NE: its table alone applies (not combined with the national one), and a service whose
  // second TargetRegion is R-NE is shown.
  await page.evaluate(() => { document.getElementById('settings-panel').classList.add('open'); });
  await page.fill('#region-filter', 'R-NE');
  await page.click('#region-apply-btn');
  assert.equal(await lcnOf('Multi Region'), '5');
  assert.equal(await card('Multi Region').isHidden(), false);
  assert.equal(await lcnOf('Linear Default'), '?', 'the national table is not combined with the regional one');
  await page.fill('#region-filter', '');
  await page.click('#region-apply-btn');
});

test('a service without ServiceType is linear television', { skip: !playwright }, async () => {
  await card('Linear Default').click();
  await page.waitForFunction(() => window.__plays.length > 0, null, { timeout: 5000 });
  assert.equal((await page.textContent('#overlay-type')).trim(), 'Linear TV');
});

test('an application controlling media presentation presents the service; its exit falls back', { skip: !playwright }, async () => {
  await page.evaluate(() => { window.__plays = []; });
  await card('App Service').click();
  await page.waitForSelector('#app-frame-wrap:not([hidden])', { timeout: 5000 });
  assert.match(await page.getAttribute('#app-frame', 'src'), /\/app\/controlling\.html\?sid=/);
  assert.deepEqual(await plays(), [], 'no media stream is presented, delivery parameters ignored');

  await page.click('#app-frame-close');
  await page.waitForFunction(() => window.__plays.length === 1, null, { timeout: 5000 });
  assert.match((await plays())[0], /appfallback\.mpd$/, 'on exit the instance is discarded and the next one plays');
  assert.equal(await page.isHidden('#app-frame-wrap'), true);
  assert.equal(await page.getAttribute('#tb-app-btn', 'data-url'), `${baseUrl}/app/parallel.html`,
    'the fallback instance\'s own application overrides the service-level one of the same type');
});

test('an XML AIT is processed to choose the application', { skip: !playwright }, async () => {
  await card('AIT Service').click();
  await page.waitForSelector('#app-frame-wrap:not([hidden])', { timeout: 5000 });
  assert.match(await page.getAttribute('#app-frame', 'src'), /\/app\/fromait\.html\?sid=/, 'the HTML5 application, not the HbbTV one');
});

test('an instance whose controlling application cannot be started is discarded', { skip: !playwright }, async () => {
  await page.evaluate(() => { window.__plays = []; });
  await card('AIT None').click();
  await page.waitForFunction(() => window.__plays.length === 1, null, { timeout: 5000 });
  assert.match((await plays())[0], /aitnone\.mpd$/, 'the XML AIT offers only HbbTV, which this client cannot start');
  assert.equal(await page.isHidden('#app-frame-wrap'), true);
});

// Clause 5.2.13 bullet and NOTE 1 i), clause 5.2.3.2: a controlling application of a type this client
// has no engine for discards its instance; its delivery parameters are never played.
test('an instance whose controlling application is of a type the client cannot start is discarded', { skip: !playwright }, async () => {
  await page.evaluate(() => { window.__plays = []; });
  await card('App Type').click();
  await page.waitForFunction(() => window.__plays.length === 1, null, { timeout: 5000 });
  assert.match((await plays())[0], /apptypefallback\.mpd$/, 'the next instance plays, not the ignored delivery parameters');
  assert.equal(await page.isHidden('#app-frame-wrap'), true);

  await page.evaluate(() => { window.__plays = []; });
  await card('App Type Only').click();
  await page.waitForSelector('#play-error:not([hidden])', { timeout: 5000 });
  assert.match(await page.textContent('#play-error-msg'), /application controlling media presentation is of type application\/vnd\.android\.package-archive/);
  assert.deepEqual(await plays(), [], 'no media is presented for it');
});

// Clause 5.2.4.2: "the client shall not issue an error to the user" when an XML AIT has no executable
// application. The toolbar offers an application with media in parallel only once its XML AIT has
// been read and has given one.
test('a toolbar application is offered only after its XML AIT gives one, and never with an error', { skip: !playwright }, async () => {
  await page.evaluate(() => { window.__plays = []; });
  await card('AIT Toolbar').click();
  await page.waitForFunction(() => window.__plays.length === 1, null, { timeout: 5000 });
  assert.equal(await page.isHidden('#tb-app-btn'), true, 'not offered while the XML AIT is being read');
  await page.waitForSelector('#tb-app-btn:not([hidden])', { timeout: 5000 });
  assert.equal(await page.getAttribute('#tb-app-btn', 'data-url'), `${baseUrl}/app/ait-slow.xml`);
  const [popup] = await Promise.all([page.context().waitForEvent('page'), page.click('#tb-app-btn')]);
  await popup.waitForURL(/\/app\/fromait\.html\?sid=/, { timeout: 5000 });
  await popup.close();

  await page.evaluate(() => { window.__plays = []; });
  await card('AIT Toolbar None').click();
  await page.waitForFunction(() => window.__plays.length === 1, null, { timeout: 5000 });
  assert.match((await plays())[0], /aittbnone\.mpd$/, 'the service plays');
  await new Promise(r => setTimeout(r, 1000));
  assert.equal(await page.isHidden('#tb-app-btn'), true, 'an XML AIT with only an HbbTV application is not offered');
  await page.keyboard.press('a');
  await new Promise(r => setTimeout(r, 500));
  const notice = await page.$eval('.version-notice', el => el.textContent).catch(() => '');
  assert.doesNotMatch(notice, /cannot be started/, 'no error is issued to the user');
});

test('outside scheduled hours the application for an inactive service is started', { skip: !playwright }, async () => {
  await card('Off Air App').click();
  await page.waitForSelector('#app-frame-wrap:not([hidden])', { timeout: 5000 });
  assert.match(await page.getAttribute('#app-frame', 'src'), /\/app\/offair\.html\?sid=/);
});

test('subscription packages decide which instances can be selected', { skip: !playwright }, async () => {
  await page.evaluate(() => { window.__plays = []; });
  await card('Gold Only').click();
  await page.waitForSelector('#play-error:not([hidden])', { timeout: 5000 });
  assert.match(await page.textContent('#play-error-msg'), /subscription packages this client is not associated with/);
  assert.deepEqual(await plays(), []);

  await page.evaluate(() => { document.getElementById('settings-panel').classList.add('open'); });
  await page.check('#sub-packages-list input[type=checkbox]');
  await card('Gold Only').click();
  await page.waitForFunction(() => window.__plays.length === 1, null, { timeout: 5000 });
  assert.match((await plays())[0], /gold\.mpd$/);
});

test('parental rating is enforced with a threshold even without a PIN', { skip: !playwright }, async () => {
  await page.evaluate(() => { window.__plays = []; });
  await page.selectOption('#pg-threshold', '16');
  await card('Rated').click();
  await page.waitForSelector('#play-error:not([hidden])', { timeout: 5000 });
  assert.match(await page.textContent('#play-error-msg'), /Blocked by parental control: rated 18\+/);
  assert.deepEqual(await plays(), []);
  await page.selectOption('#pg-threshold', '');
});

test('a content finished image is shown when the VoD has played out', { skip: !playwright }, async () => {
  await card('VoD').click();
  await page.waitForFunction(() => window.__plays.some(u => u.endsWith('vod.mpd')), null, { timeout: 5000 });
  await page.evaluate(() => document.getElementById('video').dispatchEvent(new Event('ended')));
  await page.waitForSelector('#content-finished:not([hidden])', { timeout: 5000 });
  assert.equal(await page.getAttribute('#content-finished', 'src'), `${baseUrl}/img/finished.png`);
});

// Service list discovery, TS 103 770 V1.2.1 clause 8.5.3.2 and clause 5.3.
async function registryLookup(registryPath = '/registry') {
  await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${baseUrl}/?url=${encodeURIComponent(baseUrl + '/service-list.xml')}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ch-name', { timeout: 10000 });
  await page.evaluate(() => { document.getElementById('settings-panel').classList.add('open'); });
  await page.fill('#slr-endpoint', `${baseUrl}${registryPath}`);
  await page.fill('#slr-input', 'GBR');
  await page.click('#slr-load-btn');
  await page.waitForSelector('#slr-results:not([hidden]) .preset-btn', { timeout: 5000 });
  assert.match(await page.textContent('#slr-results .settings-label'), /from Test Registry \(a recognized regulator\)/);
  return page.$$eval('#slr-results .preset-btn', bs => bs.map(b => ({
    text: b.textContent.trim(), disabled: b.disabled, active: b.classList.contains('active'), focused: b === document.activeElement, title: b.title,
  })));
}

test('the registry picker offers the regulator\'s list as the default and holds back a DVB-T one', { skip: !playwright }, async () => {
  const buttons = await registryLookup();
  assert.match(buttons[0].text, /^Regulator List \(default · regulator list · provider is a regulator · en · GBR\)$/);
  assert.equal(buttons[0].active && buttons[0].focused, true, 'the default is marked and focused');
  const terrestrial = buttons.find(b => b.text.startsWith('Terrestrial List'));
  assert.equal(terrestrial.disabled, true, 'a list that requires DVB-T is not installed by this client');
  assert.match(terrestrial.title, /requires DVB-T/);
  assert.equal(buttons[buttons.length - 1], terrestrial, 'and comes last');

  await page.click('#slr-results .preset-btn.active');
  await page.waitForSelector('#list-name:text("Handling List")', { timeout: 5000 });
});

// Clause 5.1.3.2: reserved characters of RFC 3986 clause 2.2 in a query value are percent-encoded,
// the sub-delims ( ) * included, which encodeURIComponent and the browser both leave as they are.
test('the registry query percent-encodes every reserved character of the country value', { skip: !playwright }, async () => {
  await page.goto(`${baseUrl}/?url=${encodeURIComponent(baseUrl + '/service-list.xml')}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ch-name', { timeout: 10000 });
  await page.evaluate(() => { document.getElementById('settings-panel').classList.add('open'); });
  hits.registryQuery = '';
  await page.fill('#slr-endpoint', `${baseUrl}/registry`);
  await page.fill('#slr-input', 'G(B)*!');
  await page.click('#slr-load-btn');
  await page.waitForSelector('#slr-results:not([hidden]) .preset-btn', { timeout: 5000 });
  assert.equal(hits.registryQuery, '/registry?TargetCountry=G%28B%29%2A%21');
});

// Table 83 NOTE 2: the default is a regulator list whenever the response has one, even one this
// client cannot install; the picker says why it cannot be installed.
test('a regulator list that cannot be installed stays the default, with the reason shown', { skip: !playwright }, async () => {
  const buttons = await registryLookup('/registry-reg-dvbs');
  assert.ok(buttons[0].text.startsWith('Regulator List (default · regulator list'), buttons[0].text);
  assert.equal(buttons[0].active, true, 'the regulator list is marked as the default');
  assert.equal(buttons[0].disabled, true, 'and is not installed');
  assert.match(buttons[0].text, /Cannot be installed here: requires DVB-S, which this client cannot receive/);
  assert.equal(buttons.filter(b => b.active).length, 1, 'no other list is marked as the default');
  assert.equal(buttons.find(b => b.text.startsWith('Plain List')).disabled, false, 'the others can still be chosen');
});

test('a list whose @id differs from the registry\'s ServiceListId is treated as an error', { skip: !playwright }, async () => {
  await registryLookup();
  const logged = [];
  const onConsole = msg => logged.push(msg.text());
  page.on('console', onConsole);
  await page.click('#slr-results .preset-btn:has-text("Wrong Id List")');
  await page.waitForFunction(() => document.querySelector('.version-notice')?.textContent.includes('keeping the current one'), null, { timeout: 5000 });
  page.off('console', onConsole);
  assert.ok(logged.some(t => t.includes("does not match the registry's ServiceListId tag:wrong,2026:id")),
    `the mismatch is the reported cause: ${JSON.stringify(logged)}`);
  assert.notEqual((await page.textContent('#list-name')).trim(), '5G Broadcast List');
});

// Content guide, TS 103 770 V1.2.1 clause 6, against the server above.
async function openGuideList() {
  await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  cgRequests.length = 0;
  await page.goto(`${baseUrl}/?url=${encodeURIComponent(baseUrl + '/service-list-guide.xml')}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ch-name:text("Top")', { timeout: 10000 });
  await page.evaluate(() => { window.dashjs = window.dashjs || {}; window.__plays = []; DVBIPlayer.play = (v, url) => { window.__plays.push(url); }; });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && cgRequests.filter(u => u.includes('now_next')).length < 3) await new Promise(r => setTimeout(r, 100));
}

test('content guide sources by clause 6.1 precedence, now/next with sid by clause 6.5.2.2', { skip: !playwright }, async () => {
  await openGuideList();
  const nn = cgRequests.filter(u => u.includes('now_next=true'));
  assert.ok(nn.some(u => u.startsWith('/cg/top/schedule?sid=tag%3Ag%2C2026%3Atop&now_next=true')), `list-level source: ${JSON.stringify(nn)}`);
  assert.ok(nn.some(u => u.startsWith('/cg/ref/schedule?sid=shared&now_next=true')), 'ContentGuideSourceRef resolved, ContentGuideServiceRef as sid');
  assert.ok(nn.some(u => u.startsWith('/cg/own/schedule?')), 'the service\'s own source');
  assert.equal(cgRequests.filter(u => /start=/.test(u)).length, 0, 'the channel list asks now/next, not a schedule');
  // Clause 6.5.4.4: the now group decides what is on air, whatever the document order.
  await page.waitForFunction(() => document.querySelector('#ch-now-0 .ch-now-title, .ch-now-title')?.textContent.includes('Show'), null, { timeout: 5000 });
  const nowTitles = await page.$$eval('.ch-now-title', els => els.map(e => e.textContent.trim()));
  assert.ok(nowTitles.includes('Now Show'), `now/next current programme: ${JSON.stringify(nowTitles)}`);
  // The selected service gets the wider now_next=window answer (clause 6.5.3.1).
  await page.click('.ch-card:has(.ch-name:text-is("Ref"))');
  await page.waitForFunction(() => true);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !cgRequests.includes('/cg/ref/schedule?sid=shared&now_next=window')) await new Promise(r => setTimeout(r, 100));
  assert.ok(cgRequests.includes('/cg/ref/schedule?sid=shared&now_next=window'), JSON.stringify(cgRequests));
});

test('a programme rated above the threshold blocks the service during that programme', { skip: !playwright }, async () => {
  await page.evaluate(() => { document.getElementById('settings-panel').classList.add('open'); window.__plays = []; });
  await page.selectOption('#pg-threshold', '16');
  await page.click('.ch-card:has(.ch-name:text-is("Top"))');
  await page.waitForSelector('#play-error:not([hidden])', { timeout: 5000 });
  assert.match(await page.textContent('#play-error-msg'), /rated 18\+/);
  assert.deepEqual(await page.evaluate(() => window.__plays), [], 'the guide rating takes precedence: nothing played');
  await page.selectOption('#pg-threshold', '');
  await page.evaluate(() => { document.getElementById('settings-panel').classList.remove('open'); });
});

test('schedule requests use 3-hour aligned windows of 12 hours, and programme information by pid', { skip: !playwright }, async () => {
  await page.click('.ch-card:has(.ch-name:text-is("Top"))');
  cgRequests.length = 0;
  await page.keyboard.press('e');
  await page.waitForSelector('.epg-event:has-text("Past Show")', { timeout: 5000 });
  const sched = cgRequests.filter(u => u.startsWith('/cg/top/schedule?start='));
  assert.ok(sched.length >= 1);
  for (const u of sched) {
    const q = new URL(u, baseUrl).searchParams;
    assert.equal(Number(q.get('start')) % 10800, 0);
    assert.equal(Number(q.get('end')) - Number(q.get('start')), 43200);
  }
  await page.click('.epg-event:has-text("Past Show")');
  await page.waitForFunction(() => document.querySelector('#epg-detail')?.textContent.includes('long synopsis'), null, { timeout: 5000 });
  assert.ok(cgRequests.includes('/cg/top/program?pid=crid%3A%2F%2Fg%2Fpast'));
});

test('watch again launches the on-demand player from the deep-linked XML AIT', { skip: !playwright }, async () => {
  await page.waitForSelector('#epg-detail .catchup-btn:has-text("Watch again")', { timeout: 5000 });
  await page.click('#epg-detail .catchup-btn:has-text("Watch again")');
  await page.waitForSelector('#app-frame-wrap:not([hidden])', { timeout: 5000 });
  assert.match(await page.getAttribute('#app-frame', 'src'), /\/app\/ondemand\.html\?pid=past/);
  assert.ok(cgRequests.some(u => u.startsWith('/cg/ait/deep.xml?pid=past&lloc=epg')), 'contextual parameters of clause 5.2.4.4.6');
  assert.ok(cgRequests.some(u => u.startsWith('/cg/ait/template-ok.xml?lloc=epg')), 'the Template XML AIT was checked first');
  await page.click('#back-to-live-btn');
});

test('more episodes: ordered by MemberOf@index, incompatible hidden, next page on request', { skip: !playwright }, async () => {
  await page.keyboard.press('e');
  await page.click('.epg-event:has-text("Past Show")');
  await page.click('#epg-detail .catchup-btn:has-text("More episodes")');
  await page.waitForSelector('#browse-list .browse-item', { timeout: 5000 });
  assert.deepEqual(await page.$$eval('#browse-list .browse-item-title', e => e.map(x => x.textContent)), ['Episode 2'],
    'Episode 1 needs HbbTV by its Template XML AIT and is hidden');
  assert.ok(cgRequests.includes('/cg/top/more?pid=crid%3A%2F%2Fg%2Fpast&type=ondemand'));
  assert.equal(cgRequests.filter(u => u.includes('page=2')).length, 0, 'the next page is not fetched pre-emptively');
  await page.click('#browse-more');
  await page.waitForSelector('#browse-list .browse-item:has-text("Episode 3")', { timeout: 5000 });
  assert.equal(await page.isHidden('#browse-more'), true, 'no next link on the last page');
  await page.click('#browse-close');
});

test('box sets: categories, lists filtered by Template XML AIT, contents', { skip: !playwright }, async () => {
  await page.click('#tb-boxset-btn');
  await page.waitForSelector('#browse-list .browse-item:has-text("Drama")', { timeout: 5000 });
  assert.ok(cgRequests.includes('/cg/top/group/categories?sid%5B%5D=tag%3Ag%2C2026%3Atop'));
  await page.click('#browse-list .browse-item:has-text("Drama")');
  await page.waitForSelector('#browse-list .browse-item:has-text("Playable Box")', { timeout: 5000 });
  assert.equal(await page.locator('#browse-list .browse-item:has-text("HbbTV Box")').count(), 0);
  await page.click('#browse-list .browse-item:has-text("Playable Box")');
  await page.waitForSelector('#browse-list .browse-item:has-text("Box Episode")', { timeout: 5000 });
  assert.ok(cgRequests.includes('/cg/top/group/contents?groupId=crid%3A%2F%2Fg%2Fbox%2Fok&format=paginated'));
  await page.click('#browse-back');
  await page.waitForSelector('#browse-list .browse-item:has-text("Playable Box")', { timeout: 5000 });
  await page.click('#browse-close');
});

// DVB-I Playlists, TS 103 770 V1.2.1 clauses 5.2.7 and 5.7.1.
test('a playlist is fetched on selection and its entries play in order, then the content finished image', { skip: !playwright }, async () => {
  hits.playlist = 0;
  await page.goto(`${baseUrl}/?url=${encodeURIComponent(baseUrl + '/service-list-playlist.xml')}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ch-name:text("Playlist Service")', { timeout: 10000 });
  await page.evaluate(() => { window.dashjs = window.dashjs || {}; window.__plays = []; DVBIPlayer.play = (v, url) => { window.__plays.push(url); }; });
  assert.equal(hits.playlist, 0, 'not fetched before the instance is selected');
  await page.click('.ch-card:has(.ch-name:text-is("Playlist Service"))');
  await page.waitForFunction(() => window.__plays.length === 1, null, { timeout: 5000 });
  assert.match((await page.evaluate(() => window.__plays))[0], /clip1\.mpd$/, 'the first PlaylistEntry, not the playlist document');
  await page.evaluate(() => document.getElementById('video').dispatchEvent(new Event('ended')));
  await page.waitForFunction(() => window.__plays.length === 2, null, { timeout: 5000 });
  assert.match((await page.evaluate(() => window.__plays))[1], /clip2\.mpd$/);
  assert.equal(await page.isHidden('#content-finished'), true, 'not finished after the first item');
  await page.evaluate(() => document.getElementById('video').dispatchEvent(new Event('ended')));
  await page.waitForSelector('#content-finished:not([hidden])', { timeout: 5000 });
});

test('a playlist server 404 fails the instance and the next one plays', { skip: !playwright }, async () => {
  await page.evaluate(() => { window.__plays = []; });
  await page.click('.ch-card:has(.ch-name:text-is("Gone Playlist"))');
  await page.waitForFunction(() => window.__plays.length === 1, null, { timeout: 5000 });
  assert.match((await page.evaluate(() => window.__plays))[0], /plain\.mpd$/);
});
