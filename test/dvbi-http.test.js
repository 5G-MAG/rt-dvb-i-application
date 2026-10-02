// HTTP behaviour towards DVB-I endpoints, ETSI TS 103 770 V1.2.1 clause 4.3 (public/dvbi-http.js).
// The client is driven with a fake fetch and a fake clock, so every rule is checked without a network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const DVBIHttp = require('../public/dvbi-http.js');

// A fake fetch answering from a queue of { status, headers, body } and recording each request.
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, headers: { ...(init && init.headers) } });
    const r = responses.shift();
    if (!r) throw new Error('no response queued');
    if (r.throws) throw new Error(r.throws);
    const headers = new Map(Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status: r.status, ok: r.status >= 200 && r.status < 300,
      headers: { get: k => headers.get(k.toLowerCase()) ?? null },
      text: async () => r.body || '',
    };
  };
  fn.calls = calls;
  return fn;
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: ms => { t += ms; } };
}

test('clause 4.3.3.7: minwait and maxwait for each retry, capped at the tenth', () => {
  assert.deepEqual(DVBIHttp.backoffRange(1), { min: 100, max: 400 });       // "up to 400ms before the first retry"
  assert.deepEqual(DVBIHttp.backoffRange(2), { min: 400, max: 1600 });      // "up to 1 600 ms before the second"
  assert.deepEqual(DVBIHttp.backoffRange(10), { min: 26214400, max: 104857600 }); // "104 857 600 ms"
  assert.deepEqual(DVBIHttp.backoffRange(11), DVBIHttp.backoffRange(10), 'CurrentRetry is not incremented past 10');
});

test('clause 4.3.3.7: the wait is random between minwait and maxwait', () => {
  assert.equal(DVBIHttp.backoffDelay(3, () => 0), 1600);
  assert.equal(DVBIHttp.backoffDelay(3, () => 0.5), 1600 + 0.5 * (6400 - 1600));
  assert.ok(DVBIHttp.backoffDelay(3, () => 0.999999) < 6400);
});

test('max-age and Retry-After are parsed (RFC 9111 clause 5.2.2.1, RFC 9110 clause 10.2.3)', () => {
  assert.equal(DVBIHttp.maxAgeMs('max-age=3600'), 3600000);
  assert.equal(DVBIHttp.maxAgeMs('public, max-age=5'), 5000);
  assert.equal(DVBIHttp.maxAgeMs('no-cache'), null);
  assert.equal(DVBIHttp.maxAgeMs('max-age="5"'), null, 'the quoted form is not generated, and not accepted');
  assert.equal(DVBIHttp.maxAgeMs(null), null);
  assert.equal(DVBIHttp.retryAfterMs('120', 0), 120000);
  const now = Date.parse('Fri, 31 Dec 1999 23:58:59 GMT');
  assert.equal(DVBIHttp.retryAfterMs('Fri, 31 Dec 1999 23:59:59 GMT', now), 60000);
  assert.equal(DVBIHttp.retryAfterMs('soon', 0), null);
});

test('clause 4.3.2.2: If-Modified-Since is omitted without a Last-Modified time, then sent with it', async () => {
  const LM = 'Wed, 19 Jun 2019 19:43:31 GMT';
  const f = fakeFetch([
    { status: 200, headers: { 'Last-Modified': LM }, body: '<a/>' },
    { status: 304 },
  ]);
  const c = DVBIHttp.createClient({ fetch: f });
  const first = await c.get('https://sl.example/list.xml');
  assert.equal(first.status, 200);
  assert.equal(f.calls[0].headers['If-Modified-Since'], undefined);
  const second = await c.get('https://sl.example/list.xml');
  assert.equal(f.calls[1].headers['If-Modified-Since'], LM);
  assert.equal(second.status, 304);
  assert.equal(second.notModified, true);
  assert.equal(second.body, '<a/>', 'a 304 keeps the cached body');
});

// Clause 4.3.2.1 has the client follow ETSI TS 102 796 clause 7.3.2.6: If-None-Match "where a server
// provides an ETag header".
test('TS 102 796 clause 7.3.2.6: If-None-Match is omitted without an ETag, then sent with it', async () => {
  const f = fakeFetch([
    { status: 200, body: '<a/>' },
    { status: 200, headers: { ETag: '"v1"' }, body: '<a/>' },
    { status: 304, headers: { ETag: '"v2"' } },
    { status: 304 },
  ]);
  const c = DVBIHttp.createClient({ fetch: f });
  await c.get('https://sl.example/list.xml');
  assert.equal(f.calls[0].headers['If-None-Match'], undefined, 'none held: omitted');
  await c.get('https://sl.example/list.xml');
  assert.equal(f.calls[1].headers['If-None-Match'], undefined, 'the first response had no ETag');
  const third = await c.get('https://sl.example/list.xml');
  assert.equal(f.calls[2].headers['If-None-Match'], '"v1"');
  assert.equal(third.notModified, true);
  assert.equal(third.body, '<a/>');
  await c.get('https://sl.example/list.xml');
  assert.equal(f.calls[3].headers['If-None-Match'], '"v2"', 'an ETag on a 304 replaces the one held');
});

test('clause 4.3.2.1: no request while max-age has not passed, and the header is read on every response', async () => {
  const t = clock();
  const f = fakeFetch([
    { status: 200, headers: { 'Cache-Control': 'max-age=60' }, body: 'v1' },
    { status: 200, headers: { 'Cache-Control': 'max-age=10' }, body: 'v2' },
    { status: 200, body: 'v3' },
  ]);
  const c = DVBIHttp.createClient({ fetch: f, now: t.now });
  await c.get('https://cg.example/s');
  t.advance(59000);
  const cached = await c.get('https://cg.example/s');
  assert.equal(f.calls.length, 1, 'answered from the local cache while fresh');
  assert.equal(cached.fromCache, true);
  assert.equal(cached.body, 'v1');
  assert.equal(c.freshFor('https://cg.example/s'), 1000);
  t.advance(1000);
  assert.equal((await c.get('https://cg.example/s')).body, 'v2', 'requested once expired');
  t.advance(10000);
  assert.equal((await c.get('https://cg.example/s')).body, 'v3', 'the shorter max-age of the second response applies');
  assert.equal(f.calls.length, 3);
});

test('clause 4.3.3.2: after 400 or 406 the same request is not sent again', async () => {
  for (const status of [400, 406]) {
    const f = fakeFetch([{ status }]);
    const c = DVBIHttp.createClient({ fetch: f });
    const r = await c.get('https://cg.example/bad');
    assert.equal(r.final, true);
    const again = await c.get('https://cg.example/bad');
    assert.equal(again.ok, false);
    assert.equal(again.skipped, true);
    assert.equal(f.calls.length, 1, `nothing sent after ${status}`);
    assert.equal(c.nextAllowed('https://cg.example/bad'), Infinity);
  }
});

test('clause 4.3.3.3: after 401 or 403 the request waits for Retry-After', async () => {
  const t = clock();
  const f = fakeFetch([{ status: 401, headers: { 'Retry-After': '120' } }, { status: 200, body: 'ok' }]);
  const c = DVBIHttp.createClient({ fetch: f, now: t.now });
  const r = await c.get('https://sl.example/private.xml');
  assert.equal(r.status, 401);
  assert.equal(r.retryAt, t.now() + 120000);
  t.advance(119000);
  assert.equal((await c.get('https://sl.example/private.xml')).skipped, true);
  assert.equal(f.calls.length, 1, 'not sent before Retry-After');
  t.advance(1000);
  assert.equal((await c.get('https://sl.example/private.xml')).body, 'ok');

  const f403 = fakeFetch([{ status: 403 }, { status: 403 }]);
  const c403 = DVBIHttp.createClient({ fetch: f403, now: t.now });
  await c403.get('https://sl.example/x');
  await c403.get('https://sl.example/x');
  assert.equal(f403.calls.length, 2, 'without Retry-After nothing holds the request back');
});

test('clause 4.3.3.5: 500, 502, 504 and connection failure retry no faster than the back-off', async () => {
  for (const r of [{ status: 500 }, { status: 502 }, { status: 504 }, { throws: 'ECONNREFUSED' }]) {
    const t = clock();
    const f = fakeFetch([r, r, { status: 200, body: 'ok' }]);
    const c = DVBIHttp.createClient({ fetch: f, now: t.now, random: () => 1 });
    const first = await c.get('https://sl.example/list.xml');
    assert.equal(first.retryAt, t.now() + 400, 'first retry within 100 to 400 ms');
    t.advance(399);
    assert.equal((await c.get('https://sl.example/list.xml')).skipped, true);
    t.advance(1);
    const second = await c.get('https://sl.example/list.xml');
    assert.equal(second.retryAt, t.now() + 1600, 'second retry within 400 to 1 600 ms');
    t.advance(1600);
    assert.equal((await c.get('https://sl.example/list.xml')).body, 'ok');
    assert.equal(f.calls.length, 3);
  }
});

test('clause 4.3.3.7: back-off applied on request by the caller, counted per request key', async () => {
  const t = clock();
  const c = DVBIHttp.createClient({ fetch: fakeFetch([]), now: t.now, random: () => 0 });
  assert.equal(c.backOff('cg|svc'), t.now() + 100);
  assert.equal(c.backOff('cg|svc'), t.now() + 400);
  assert.equal(c.backOff('other'), t.now() + 100, 'another request has its own count');
  for (let i = 0; i < 20; i++) c.backOff('cg|svc');
  assert.equal(c.nextAllowed('cg|svc'), t.now() + 26214400, 'held at CurrentRetry 10');
});
