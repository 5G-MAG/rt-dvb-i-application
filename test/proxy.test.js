// The /proxy endpoint fetches a URL on the browser's behalf, so its address guard is the thing
// standing between this receiver and being used to reach whatever the host can reach. These cases
// pin the guard's behaviour, including the allowlist that makes local testing possible without
// switching it off.
// Warnings are logged so that the clause 7.3 warning can be checked; log lines are captured below
// rather than printed.
process.env.LOG_LEVEL = 'warn';
const logLines = [];
console.log = (...args) => { logLines.push(args.join(' ')); };
// Fixed ports so they can be named in the allowlist, which is read when server.js is required.
const UPSTREAM_PORT = 45997;
const PLAIN_PORT = 45996;
process.env.PROXY_ALLOW_ORIGINS =
  `http://localhost:4000, http://127.0.0.1:4000/, https://127.0.0.1:${UPSTREAM_PORT}, http://127.0.0.1:${UPSTREAM_PORT}, ` +
  `http://127.0.0.1:${PLAIN_PORT}`;
// The upstreams below use a throwaway self-signed certificate (tls-fixture.js); the proxy's fetch
// in this test process accepts it. Certificate checking itself is not what these tests are about.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env.PROXY_MAX_BYTES = String(64 * 1024);

const { test } = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const http = require('node:http');
const { makeCertificate } = require('./tls-fixture.js');
const TLS = makeCertificate();
const { app, assertSafeUrl, isPrivateIp, isRfc1918, onSamePrivateSubnet, plainHttpWarning } = require('../server.js');

async function allowed(url) {
  try { await assertSafeUrl(url); return true; } catch { return false; }
}

test('allowlisted origins are proxied, and nothing else on those hosts is', async () => {
  assert.ok(await allowed('http://localhost:4000/service-list.xml'));
  // Configured with a trailing slash, which must not change the origin it matches.
  assert.ok(await allowed('http://127.0.0.1:4000/epg/schedule?sid=x'));

  // An allowlist entry is an origin, not a host: the same host on another port is still guarded.
  assert.equal(await allowed('http://localhost:5000/anything'), false);
  assert.equal(await allowed('http://127.0.0.1:22/'), false);
});

test('private, loopback and link-local addresses stay blocked', async () => {
  for (const url of [
    'http://169.254.169.254/latest/meta-data/',  // cloud metadata
    'http://192.168.1.1/admin',
    'http://10.0.0.1/',
    'http://172.16.0.1/',
    'http://[::1]:8080/',
  ]) {
    assert.equal(await allowed(url), false, `${url} should be blocked`);
  }
});

test('only http and https are proxied', async () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com/']) {
    assert.equal(await allowed(url), false, `${url} should be blocked`);
  }
});

test('a public address is still proxied', async () => {
  assert.ok(await allowed('https://example.com/service-list.xml'));
});

test('isPrivateIp covers the ranges the guard relies on', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.0.5', '169.254.169.254',
                    '100.64.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1']) {
    assert.ok(isPrivateIp(ip), `${ip} should be private`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111']) {
    assert.equal(isPrivateIp(ip), false, `${ip} should be public`);
  }
});

// The proxy used to answer 200 whatever the origin said, so a 404 arrived as a 200 carrying an
// error page and the caller reported it as unparseable content rather than a missing document.
test('the upstream status is relayed, not flattened to 200', async (t) => {
  const upstream = https.createServer(TLS, (req, res) => {
    if (req.url === '/list.xml') {
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end('<?xml version="1.0"?><ServiceList/>');
    } else if (req.url === '/gone') {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><p>not here</p>');
    } else {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('boom');
    }
  });
  try {
    await new Promise((ok, err) => {
      upstream.once('error', err);
      upstream.listen(UPSTREAM_PORT, '127.0.0.1', ok);
    });
  } catch {
    t.skip(`port ${UPSTREAM_PORT} is in use`);
    return;
  }

  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const port = server.address().port;
  const via = p => fetch(`http://127.0.0.1:${port}/proxy?url=` +
                         encodeURIComponent(`https://127.0.0.1:${UPSTREAM_PORT}${p}`));

  try {
    assert.equal((await via('/list.xml')).status, 200);
    assert.equal((await via('/gone')).status, 404, 'a 404 upstream must not arrive as 200');
    assert.equal((await via('/broken')).status, 500, 'a 500 upstream must not arrive as 200');
  } finally {
    server.close();
    upstream.close();
  }
});

// Without a ceiling this endpoint reads whatever the upstream sends fully into memory before
// answering, so one request naming a large or endless resource exhausts the process.
test('an oversized upstream response is refused, not buffered', async (t) => {
  const cap = Number(process.env.PROXY_MAX_BYTES);
  const upstream = https.createServer(TLS, (req, res) => {
    if (req.url === '/big') {
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end('x'.repeat(cap * 2));                       // no content-length trick: just too big
    } else if (req.url === '/lying') {
      res.writeHead(200, { 'Content-Type': 'application/xml', 'Content-Length': String(cap * 2) });
      res.end('x'.repeat(cap * 2));                       // declares its size up front
    } else {
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end('<?xml version="1.0"?><ServiceList/>');
    }
  });
  try {
    await new Promise((ok, err) => {
      upstream.once('error', err);
      upstream.listen(UPSTREAM_PORT, '127.0.0.1', ok);
    });
  } catch {
    t.skip(`port ${UPSTREAM_PORT} is in use`);
    return;
  }

  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const port = server.address().port;
  const via = p => fetch(`http://127.0.0.1:${port}/proxy?url=` +
                         encodeURIComponent(`https://127.0.0.1:${UPSTREAM_PORT}${p}`));
  try {
    assert.equal((await via('/ok')).status, 200, 'a normal body still passes');
    assert.equal((await via('/big')).status, 502, 'an oversized body must be refused');
    assert.equal((await via('/lying')).status, 502, 'a declared oversize must be refused too');
  } finally {
    server.close();
    upstream.close();
  }
});

// ── TS 103 770 V1.2.1 clause 7.3: HTTP over TLS, except on the same private subnet ──────────────

test('RFC 1918 clause 3 blocks are the private subnets, loopback is not one', () => {
  for (const ip of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.10', '::ffff:192.168.1.10']) {
    assert.ok(isRfc1918(ip), `${ip} is in an RFC 1918 block`);
  }
  for (const ip of ['127.0.0.1', '172.32.0.1', '169.254.1.1', '100.64.0.1', '8.8.8.8', 'fd00::1']) {
    assert.equal(isRfc1918(ip), false, `${ip} is not in an RFC 1918 block`);
  }
});

test('plain HTTP is warned about, saying whether the endpoint is on this host\'s private subnet', async () => {
  const ifaces = {
    lo:   [{ family: 'IPv4', address: '127.0.0.1', cidr: '127.0.0.1/8' }],
    eth0: [{ family: 'IPv4', address: '192.168.1.20', cidr: '192.168.1.20/24' }],
  };
  assert.ok(onSamePrivateSubnet('192.168.1.99', ifaces), 'same /24 as eth0');
  assert.equal(onSamePrivateSubnet('192.168.2.99', ifaces), false, 'private, but another subnet');
  assert.equal(onSamePrivateSubnet('127.0.0.1', ifaces), false, 'loopback is not an RFC 1918 subnet');
  assert.equal(onSamePrivateSubnet('10.0.0.5', ifaces), false, 'no interface on 10/8');

  const exception = 'For the specific case that a DVB-I client connects to a DVB-I metadata endpoint located ' +
                    'on the same private subnet (see clause 3 of IETF RFC 1918 [27]), HTTP may be used without TLS.';
  const same = await plainHttpWarning('http://192.168.1.99:4000/list.xml', ifaces);
  assert.equal(same.samePrivateSubnet, true);
  assert.ok(same.msg.includes('not over TLS') && same.msg.includes('clause 7.3') && same.msg.includes(exception));
  const loop = await plainHttpWarning('http://127.0.0.1:4000/list.xml', ifaces);
  assert.equal(loop.samePrivateSubnet, false);
  assert.match(loop.msg, /exception does not apply/);
  assert.equal((await plainHttpWarning('http://192.168.2.99:4000/list.xml', ifaces)).samePrivateSubnet, false);
  assert.equal(await plainHttpWarning('https://127.0.0.1:4000/list.xml', ifaces), null, 'https is not warned about');
});

// Owner decision: an http:// endpoint is fetched, with a logged warning, and every other proxy check
// still applies (here the allowlist, without which loopback stays refused).
test('the proxy fetches an http:// endpoint and logs that it is not over TLS, redirect hops included', async (t) => {
  const plain = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end('<?xml version="1.0"?><ServiceList/>');
  });
  const secure = https.createServer(TLS, (req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${PLAIN_PORT}/list.xml` });
    res.end();
  });
  try {
    await new Promise((ok, err) => { plain.once('error', err); plain.listen(PLAIN_PORT, '127.0.0.1', ok); });
    await new Promise((ok, err) => { secure.once('error', err); secure.listen(UPSTREAM_PORT, '127.0.0.1', ok); });
  } catch {
    plain.close(); secure.close();
    t.skip(`port ${PLAIN_PORT} or ${UPSTREAM_PORT} is in use`);
    return;
  }
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const via = u => fetch(`http://127.0.0.1:${server.address().port}/proxy?url=${encodeURIComponent(u)}`);
  const warnings = () => logLines.map(l => { try { return JSON.parse(l); } catch { return {}; } })
    .filter(l => l.level === 'warn' && /not over TLS/.test(l.msg || ''));
  try {
    logLines.length = 0;
    const direct = await via(`http://127.0.0.1:${PLAIN_PORT}/list.xml`);
    assert.equal(direct.status, 200, 'plain HTTP is fetched');
    assert.match(await direct.text(), /<ServiceList\/>/);
    assert.equal(warnings().length, 1, 'one warning for the one plain HTTP hop');
    assert.match(warnings()[0].msg, /clause 7\.3/);
    assert.equal(warnings()[0].samePrivateSubnet, false, 'loopback is not on an RFC 1918 subnet');

    logLines.length = 0;
    const redirected = await via(`https://127.0.0.1:${UPSTREAM_PORT}/to-http`);
    assert.equal(redirected.status, 200, 'a redirect to plain HTTP is followed');
    assert.equal(warnings().length, 1, 'the https hop is not warned about, the http hop is');

    const refused = await via('http://127.0.0.1:22/');
    assert.equal(refused.status, 400, 'the address guard still refuses a loopback origin not allowlisted');
  } finally {
    server.close(); plain.close(); secure.close();
  }
});

// Clause 4.3.2: If-Modified-Since goes upstream, and Last-Modified, Cache-Control and Retry-After
// come back, so the browser can make conditional requests and honour max-age through the proxy.
test('the proxy forwards conditional request headers and caching and retry headers', async (t) => {
  const LM = 'Wed, 19 Jun 2019 19:43:31 GMT';
  const ETAG = '"list-v1"';
  let seenIms = null, seenInm = null;
  const upstream = https.createServer(TLS, (req, res) => {
    if (req.url === '/list.xml') {
      seenIms = req.headers['if-modified-since'] || null;
      seenInm = req.headers['if-none-match'] || null;
      if (seenIms === LM) { res.writeHead(304, { 'Cache-Control': 'max-age=60' }); res.end(); return; }
      if (seenInm === ETAG) { res.writeHead(304, { ETag: ETAG }); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/xml', 'Last-Modified': LM, 'Cache-Control': 'max-age=3600', ETag: ETAG });
      res.end('<?xml version="1.0"?><ServiceList/>');
    } else if (req.url === '/auth') {
      res.writeHead(401, { 'Retry-After': '120' });
      res.end();
    } else {
      res.writeHead(404); res.end();
    }
  });
  try {
    await new Promise((ok, err) => { upstream.once('error', err); upstream.listen(UPSTREAM_PORT, '127.0.0.1', ok); });
  } catch {
    t.skip(`port ${UPSTREAM_PORT} is in use`);
    return;
  }
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const via = (p, headers) => fetch(`http://127.0.0.1:${server.address().port}/proxy?url=` +
                                    encodeURIComponent(`https://127.0.0.1:${UPSTREAM_PORT}${p}`), { headers });
  try {
    const first = await via('/list.xml');
    assert.equal(first.status, 200);
    assert.equal(seenIms, null, 'no If-Modified-Since when the browser sent none');
    assert.equal(first.headers.get('last-modified'), LM);
    assert.equal(first.headers.get('cache-control'), 'max-age=3600');
    assert.equal(first.headers.get('etag'), ETAG, 'ETag comes back (TS 102 796 clause 7.3.2.6)');
    assert.equal(seenInm, null, 'no If-None-Match when the browser sent none');

    const byTag = await via('/list.xml', { 'If-None-Match': ETAG });
    assert.equal(seenInm, ETAG, 'If-None-Match reaches the origin');
    assert.equal(byTag.status, 304);
    assert.equal(byTag.headers.get('etag'), ETAG);

    const again = await via('/list.xml', { 'If-Modified-Since': LM });
    assert.equal(seenIms, LM, 'If-Modified-Since reaches the origin');
    assert.equal(again.status, 304, 'the origin\'s 304 is relayed');
    assert.equal(again.headers.get('cache-control'), 'max-age=60');

    const auth = await via('/auth');
    assert.equal(auth.status, 401);
    assert.equal(auth.headers.get('retry-after'), '120');
  } finally {
    server.close();
    upstream.close();
  }
});
