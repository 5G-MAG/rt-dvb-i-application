/*
License: 5G-MAG Public License (v1.0)
Authors: Jordi J. Gimenez (5G-MAG)
Copyright: (C) 2026 5G-MAG Association

For full license terms please see the LICENSE file distributed with this
program. If this file is missing then the license can be retrieved from
https://www.5g-mag.com/license
*/
// Service list handling of ETSI TS 103 770 V1.2.1 applied after parsing (public/servicelist.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../public/servicelist.js');

const table = (o = {}) => ({ targetRegions: [], packages: [], entries: [], ranges: [], ...o });
const lcn = (channelNumber, serviceRef, o = {}) => ({ channelNumber, serviceRef, visible: true, selectable: true, ...o });
const range = (o = {}) => ({ start: 100, end: null, priority: 0, fillMethod: 'startFromHighest', serviceOrigin: 'dvbi', serviceType: null, serviceGenre: null, ...o });
const svc = (uid, o = {}) => ({ uid, serviceType: 'urn:dvb:metadata:cs:ServiceTypeCS:2019:linear', genres: [], ...o });

test('table 15 TargetRegion: none means anywhere, several mean any of them', () => {
  assert.equal(L.inRegion([], 'R1'), true);
  assert.equal(L.inRegion(['R1', 'R2'], 'R2'), true, 'the second region counts too');
  assert.equal(L.inRegion(['R1', 'R2'], 'R3'), false);
  assert.equal(L.inRegion(['R1'], ''), true, 'no region chosen');
});

test('clause 5.5.12: one table is selected, by region, else the one without TargetRegion', () => {
  const national = table({ entries: [lcn(1, 'a')] });
  const north = table({ targetRegions: ['N', 'NE'], entries: [lcn(5, 'a')] });
  const south = table({ targetRegions: ['S'], entries: [lcn(7, 'a')] });
  const tables = [north, national, south];
  assert.equal(L.selectLcnTable(tables, 'NE'), north, 'a table applies to every region it names');
  assert.equal(L.selectLcnTable(tables, 'S'), south);
  assert.equal(L.selectLcnTable(tables, 'W'), national, 'no table for the region: the unconstrained one');
  assert.equal(L.selectLcnTable(tables, ''), national);
  assert.equal(L.selectLcnTable([north], 'NEE'), null, 'a region ID that only shares a prefix does not match');
});

test('clause 5.5.12: tables are not combined', () => {
  const regional = table({ targetRegions: ['N'], entries: [lcn(5, 'a')] });
  const national = table({ entries: [lcn(1, 'a'), lcn(2, 'b')] });
  const map = L.assignChannelNumbers(L.selectLcnTable([regional, national], 'N'), [svc('a'), svc('b')]);
  assert.deepEqual(Object.keys(map), ['a'], 'b has no number from the national table in region N');
  assert.equal(map.a.lcn, 5);
});

test('deprecated table SubscriptionPackage still selects the table for the client\'s package', () => {
  const basic = table({ entries: [lcn(1, 'a')] });
  const movies = table({ packages: ['Movies'], entries: [lcn(9, 'a')] });
  assert.equal(L.selectLcnTable([basic, movies], '', ['Movies']), movies);
  assert.equal(L.selectLcnTable([basic, movies], '', []), basic);
});

test('table 23: @visible and @selectable are kept with the number', () => {
  const t = table({ entries: [lcn(1, 'a'), lcn(2, 'b', { visible: false }), lcn(3, 'c', { visible: false, selectable: false })] });
  const map = L.assignChannelNumbers(t, [svc('a'), svc('b'), svc('c')]);
  assert.equal(L.directlySelectable(map.a), true);
  assert.equal(map.b.visible, false);
  assert.equal(L.directlySelectable(map.b), true, 'hidden, reachable by number');
  assert.equal(L.directlySelectable(map.c), false, 'hidden and not selectable');
  assert.equal(L.directlySelectable({ visible: true, selectable: false }), true, '@selectable is read only when @visible is false');
});

test('table 37g: LCNRange numbers services without an LCN, in document order', () => {
  const t = table({ entries: [lcn(1, 'a'), lcn(101, 'x')], ranges: [range({ start: 100, end: 110, fillMethod: 'fillGaps' })] });
  const map = L.assignChannelNumbers(t, [svc('a'), svc('b'), svc('x'), svc('c')]);
  assert.equal(map.b.lcn, 100, 'fillGaps starts from @start');
  assert.equal(map.c.lcn, 102, 'and skips numbers already assigned');
});

test('table 37g: startFromHighest continues after the highest number assigned in the range', () => {
  const t = table({ entries: [lcn(105, 'x')], ranges: [range({ start: 100, end: 110 })] });
  const map = L.assignChannelNumbers(t, [svc('x'), svc('b'), svc('c')]);
  assert.equal(map.b.lcn, 106);
  assert.equal(map.c.lcn, 107);
});

test('table 37g: descending range, open range, priority order and filters', () => {
  const desc = L.assignChannelNumbers(table({ ranges: [range({ start: 50, end: 48, fillMethod: 'fillGaps' })] }),
    [svc('a'), svc('b'), svc('c'), svc('d')]);
  assert.deepEqual(['a', 'b', 'c'].map(u => desc[u].lcn), [50, 49, 48]);
  assert.equal(desc.d, undefined, 'the range is used up; the rest get no number');

  const open = L.assignChannelNumbers(table({ ranges: [range({ start: 900, end: null, fillMethod: 'fillGaps' })] }), [svc('a'), svc('b')]);
  assert.deepEqual([open.a.lcn, open.b.lcn], [900, 901], 'no @end: ascending');

  const two = L.assignChannelNumbers(table({ ranges: [
    range({ start: 10, end: 10, priority: 1, fillMethod: 'fillGaps' }),
    range({ start: 20, end: 20, priority: 0, fillMethod: 'fillGaps' }),
  ] }), [svc('a'), svc('b')]);
  assert.deepEqual([two.a.lcn, two.b.lcn], [20, 10], 'lower @priority value first');

  const radio = 'urn:dvb:metadata:cs:ServiceTypeCS:2019:linear-radio';
  const typed = L.assignChannelNumbers(table({ ranges: [range({ start: 700, end: 799, serviceType: radio, fillMethod: 'fillGaps' })] }),
    [svc('tv'), svc('r', { serviceType: radio })]);
  assert.equal(typed.tv, undefined, '@serviceType restricts the range');
  assert.equal(typed.r.lcn, 700);

  const bcast = L.assignChannelNumbers(table({ ranges: [range({ serviceOrigin: 'targetBroadcast' })] }), [svc('a')]);
  assert.equal(bcast.a, undefined, 'a range for non-DVB-I broadcast services does not number DVB-I services');
});

test('table 16 SubscriptionPackage: selectable only with one of the packages', () => {
  assert.equal(L.packageAllows([], []), true);
  assert.equal(L.packageAllows(['Gold'], []), false);
  assert.equal(L.packageAllows(['Gold', 'Silver'], ['Silver']), true);
});

test('clause 5.5.28: MinimumAge by country, a rating without country applies everywhere', () => {
  const ratings = [{ age: 12, countries: [] }, { age: 16, countries: ['DEU', 'AUT'] }];
  assert.equal(L.minimumAgeFor(ratings, 'AUT'), 16);
  assert.equal(L.minimumAgeFor(ratings, 'FRA'), 12);
  assert.equal(L.minimumAgeFor([{ age: 16, countries: ['DEU'] }], 'FRA'), null, 'no rating for France');
  assert.equal(L.minimumAgeFor(ratings, null), 16, 'country unknown: the most restrictive');
  assert.equal(L.minimumAgeFor([], 'FRA'), null);
});

test('clause 5.5.28: the guide rating of the programme takes precedence, both ways', () => {
  // The clause's examples, with a client restricting 16+.
  assert.equal(L.restricted(16, 12, null), false, 'service 12: permitted');
  assert.equal(L.restricted(16, 12, 18), true, 'programme 18 on that service: prohibited');
  assert.equal(L.restricted(16, 18, null), true, 'service 18: prohibited');
  assert.equal(L.restricted(16, 18, 12), false, 'programme 12 on that service: allowed');
  assert.equal(L.restricted(0, 18, null), false, 'no criterion set');
});

test('clause 5.2.3.4: instance-level applications override service-level ones of the same type', () => {
  const cs = 'urn:dvb:metadata:cs:LinkedApplicationCS:2019:';
  assert.equal(L.linkedAppTerm(cs + '1.2'), '1.2');
  assert.equal(L.linkedAppTerm('urn:other:1.2'), null);
  const service = [
    { term: '1.1', url: 'svc-html', contentType: 'text/html' },
    { term: '1.1', url: 'svc-ait', contentType: 'application/vnd.dvb.ait+xml' },
    { term: '2', url: 'svc-off', contentType: 'text/html' },
    { term: '3', url: 'svc-home', contentType: 'text/html' },
    { term: '1.1', url: 'svc-apk', contentType: 'application/vnd.android.package-archive' },
  ];
  const instance = [{ term: '1.2', url: 'inst-html', contentType: 'text/html' }, { term: '3', url: 'inst-home', contentType: 'text/html' }];
  const urls = L.effectiveApps(service, instance).map(a => a.url);
  assert.deepEqual(urls, ['inst-html', 'svc-ait', 'svc-off', 'svc-home'],
    'the instance 1.2 replaces the service 1.1 of the same type; other types stay; 3 only at service level; unknown types ignored');
});

// Clause 5.2.13 bullet and NOTE 1 i): a 1.2 application of a type this client cannot start is kept,
// marked, so that its instance is discarded instead of played from its delivery parameters.
test('clause 5.2.13: a controlling application of a type the client cannot start is kept and marked', () => {
  const apk = 'application/vnd.android.package-archive';
  const apps = L.effectiveApps([{ term: '1.1', url: 'svc-apk', contentType: apk }],
    [{ term: '1.2', url: 'inst-apk', contentType: apk }, { term: '1.1', url: 'inst-apk-11', contentType: apk }]);
  assert.deepEqual(apps, [{ term: '1.2', url: 'inst-apk', contentType: apk, unstartable: true }],
    'the 1.2 stays, marked; the 1.1 of that type is still ignored, and the service 1.1 of the same type is overridden');
  assert.equal(L.effectiveApps([], [{ term: '1.2', url: 'h', contentType: 'text/html' }])[0].unstartable, undefined);
});

test('clause 5.2.4.2: the XML AIT application with the highest priority of a startable type', () => {
  const apps = [
    { type: 'application/vnd.hbbtv.xhtml+xml', priority: 9, url: 'hbbtv' },
    { type: 'text/html', priority: 1, url: 'low' },
    { type: 'text/html', priority: 3, url: 'high' },
    { type: 'application/vnd.dvbi.non', priority: 5, url: 'none' },
  ];
  assert.equal(L.selectAitApplication(apps).url, 'high');
  assert.equal(L.selectAitApplication([{ type: 'application/vnd.dvbi.non', priority: 1, url: 'x' }]), null);
});

test('clause 5.1.7: the daily check falls anywhere in the 24 hours', () => {
  assert.equal(L.dailyUpdateDelay(() => 0), 0);
  assert.equal(L.dailyUpdateDelay(() => 0.5), 12 * 3600000);
  assert.ok(L.dailyUpdateDelay(() => 0.9999999) < 24 * 3600000);
});
