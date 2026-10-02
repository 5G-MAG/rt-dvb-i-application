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
