/*
License: 5G-MAG Public License (v1.0)
Authors: Jordi J. Gimenez (5G-MAG)
Copyright: (C) 2026 5G-MAG Association

For full license terms please see the LICENSE file distributed with this
program. If this file is missing then the license can be retrieved from
https://www.5g-mag.com/license
*/
// Content guide requests, ETSI TS 103 770 V1.2.1 clause 6 (public/guide.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const G = require('../public/guide.js');

test('clause 6.1: service source, then ContentGuideSourceRef, then the list-level source', () => {
  const own = { cgsid: 'own' }, a = { cgsid: 'a' }, top = { cgsid: 'top' };
  assert.equal(G.resolveSource({ own, ref: 'a', list: { a }, listLevel: top }), own);
  assert.equal(G.resolveSource({ ref: 'a', list: { a }, listLevel: top }), a);
  assert.equal(G.resolveSource({ ref: 'missing', list: { a }, listLevel: top }), top);
  assert.equal(G.resolveSource({ list: { a } }), null, 'no reference and no list-level source: none, not the first entry');
});

test('clause 6.5.2.2: sid is ContentGuideServiceRef when present', () => {
  assert.equal(G.serviceId('tag:x:uid', 'shared-ref'), 'shared-ref');
  assert.equal(G.serviceId('tag:x:uid', ''), 'tag:x:uid');
});

test('clause 6.5.2.1: windows start on 3-hour boundaries and span 12 hours', () => {
  const now = Date.UTC(2015, 5, 2, 13, 20) ;                 // 13:20 UTC
  const wins = G.scheduleWindows(now - 3600e3, now + 12 * 3600e3);
  for (const w of wins) {
    assert.equal(w.start % 10800, 0);
    assert.equal(w.end % 10800, 0);
    assert.equal(w.end - w.start, 43200);
  }
  assert.equal(wins[0].start, Date.UTC(2015, 5, 2, 12, 0) / 1000, '12:00, the boundary at or before 12:20');
  assert.ok(wins[wins.length - 1].end * 1000 >= now + 12 * 3600e3, 'the requested period is covered');
  assert.equal(wins.length, 2);
});

test('request URLs of clauses 6.5.2.2, 6.5.3.1 and 6.6.2', () => {
  assert.equal(G.scheduleUrl('https://cg.example/schedule', '12345', { start: 1433246400, end: 1433268000 }),
    'https://cg.example/schedule?start=1433246400&end=1433268000&sid=12345', 'the example URL of clause 6.5.2.2');
  assert.equal(G.nowNextUrl('https://cg.example/schedule', '12345'), 'https://cg.example/schedule?sid=12345&now_next=true',
    'the example URL of clause 6.5.3.1');
  assert.equal(G.nowNextUrl('https://cg.example/schedule', '12345', 'window'), 'https://cg.example/schedule?sid=12345&now_next=window');
  assert.equal(G.programUrl('https://cg.example/program', 'crid://channel7.co.uk/n19alr19'),
    'https://cg.example/program?pid=crid%3A%2F%2Fchannel7.co.uk%2Fn19alr19', 'reserved characters percent-encoded');
});

test('clause 6.2.2: square brackets of repeated parameters are percent-encoded', () => {
  assert.equal(G.moreEpisodesUrl('https://cg.example/more', 'crid://a/b', ['1234', '5678']),
    'https://cg.example/more?pid=crid%3A%2F%2Fa%2Fb&type=ondemand&regionID%5B%5D=1234&regionID%5B%5D=5678');
  assert.equal(G.boxSetCategoriesUrl('https://cg.example/group/', ['s1'], []), 'https://cg.example/group/categories?sid%5B%5D=s1');
  assert.equal(G.boxSetListsUrl('https://cg.example/group/', 'crid://cat/1', ['s1'], ['r']),
    'https://cg.example/group/?groupId=crid%3A%2F%2Fcat%2F1&sid%5B%5D=s1&regionID%5B%5D=r');
  assert.equal(G.boxSetContentsUrl('https://cg.example/group/', 'crid://box/1', []),
    'https://cg.example/group/contents?groupId=crid%3A%2F%2Fbox%2F1&format=paginated');
});

test('clause 5.2.4.4.6: contextual parameters on an XML AIT URL, with ? or &', () => {
  assert.equal(G.aitUrl('https://channel7.co.uk/ait.aitx?pid=b01myjsy', ['Piemonte'], 'epg'),
    'https://channel7.co.uk/ait.aitx?pid=b01myjsy&regionID%5B%5D=Piemonte&lloc=epg');
  assert.equal(G.aitUrl('https://channel7.co.uk/ait.aitx', [], 'epg'), 'https://channel7.co.uk/ait.aitx?lloc=epg');
});

// TS 102 796 V1.8.1 clause 6.2.2.6.2: lloc "is added before the first number sign (#) character in
// the URL if there is one, or at the end if there is not, using either a "?" or a "&" character".
test('clause 5.2.3.1: the launch location goes into the query, before any fragment', () => {
  assert.equal(G.linkedAppUrl('http://www.example.com/hbbtv-application#mode4', 'playerpage'),
    'http://www.example.com/hbbtv-application?lloc=playerpage#mode4', 'TS 102 796 clause 6.2.2.6.2, example 4');
  assert.equal(G.linkedAppUrl('http://www.example.com/deeplink?cid=is38g7bv', 'epg'),
    'http://www.example.com/deeplink?cid=is38g7bv&lloc=epg', 'example 3');
  assert.equal(G.linkedAppUrl('https://a.example/app?x=1#f?g', 'service'), 'https://a.example/app?x=1&lloc=service#f?g',
    'a "?" in the fragment is not the query');
  assert.equal(G.linkedAppUrl('https://a.example/app', null), 'https://a.example/app', 'no location, no parameter');
  assert.equal(G.aitUrl('https://a.example/ait.xml#x', [], 'epg'), 'https://a.example/ait.xml?lloc=epg#x');
});

test('table 52: on-demand availability window', () => {
  const od = { start: '2014-03-18T22:00:00Z', end: '2014-04-17T21:00:00Z' };
  assert.equal(G.onDemandAvailable(od, Date.parse('2014-03-20T00:00:00Z')), true);
  assert.equal(G.onDemandAvailable(od, Date.parse('2014-03-18T21:00:00Z')), false, 'not yet');
  assert.equal(G.onDemandAvailable(od, Date.parse('2014-04-18T00:00:00Z')), false, 'no longer');
  assert.equal(G.onDemandAvailable(null, 0), false);
});

test('clause 5.2.4.4.5: Template XML AIT expiry from max-age, else Expires, else 24 hours', () => {
  const now = Date.parse('2026-10-02T10:00:00Z');
  assert.equal(G.templateAitExpiry(now, 60000, 'Fri, 02 Oct 2026 12:00:00 GMT'), now + 60000, 'max-age wins over Expires');
  assert.equal(G.templateAitExpiry(now, null, 'Fri, 02 Oct 2026 12:00:00 GMT'), Date.parse('2026-10-02T12:00:00Z'));
  assert.equal(G.templateAitExpiry(now, null, null), now + 86400000);
});

test('clauses 6.7.3 and 6.9: results by MemberOf@index, duplicates dropped', () => {
  const items = [{ programId: 'b', index: 6 }, { programId: 'a', index: 5 }, { programId: 'b', index: 7 }];
  assert.deepEqual(G.orderResults(items).map(i => `${i.programId}${i.index}`), ['a5', 'b6']);
});

// Clauses 5.1.3.2 and 6.2.2: every reserved character of IETF RFC 3986 clause 2.2 in a key or value
// is percent-encoded; encodeURIComponent alone leaves the sub-delims ! ' ( ) * as they are.
test('clauses 5.1.3.2 and 6.2.2: all RFC 3986 reserved characters in keys and values are percent-encoded', () => {
  const reserved = ':/?#[]@' + "!$&'()*+,;=";
  const encoded = G.encodeQueryComponent(reserved);
  assert.equal(encoded, '%3A%2F%3F%23%5B%5D%40%21%24%26%27%28%29%2A%2B%2C%3B%3D');
  assert.equal(G.encodeQueryComponent('Az09-._~'), 'Az09-._~', 'unreserved characters are left as they are');
  assert.equal(G.programUrl('https://cg.example/program', "crid://x.example/it's(1)*!"),
    'https://cg.example/program?pid=crid%3A%2F%2Fx.example%2Fit%27s%281%29%2A%21');
  assert.equal(G.moreEpisodesUrl('https://cg.example/more', 'p', ['r(1)']),
    'https://cg.example/more?pid=p&type=ondemand&regionID%5B%5D=r%281%29');
});
