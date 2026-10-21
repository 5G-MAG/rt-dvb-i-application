// The /proxy endpoint fetches a URL on the browser's behalf, so its address guard is the thing
// standing between this receiver and being used to reach whatever the host can reach. These cases
// pin the guard's behaviour, including the allowlist that makes local testing possible without
// switching it off.
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
// A fixed port so it can be named in the allowlist, which is read when server.js is required.
const UPSTREAM_PORT = 45997;
process.env.PROXY_ALLOW_ORIGINS =
  `http://localhost:4000, http://127.0.0.1:4000/, http://127.0.0.1:${UPSTREAM_PORT}`;
process.env.PROXY_MAX_BYTES = String(64 * 1024);

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { app, assertSafeUrl, isPrivateIp } = require('../server.js');

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
  const upstream = http.createServer((req, res) => {
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
                         encodeURIComponent(`http://127.0.0.1:${UPSTREAM_PORT}${p}`));

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
  const upstream = http.createServer((req, res) => {
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
                         encodeURIComponent(`http://127.0.0.1:${UPSTREAM_PORT}${p}`));
  try {
    assert.equal((await via('/ok')).status, 200, 'a normal body still passes');
    assert.equal((await via('/big')).status, 502, 'an oversized body must be refused');
    assert.equal((await via('/lying')).status, 502, 'a declared oversize must be refused too');
  } finally {
    server.close();
    upstream.close();
  }
});

// A plain `npm start` has no PROXY_ALLOW_ORIGINS, and the client's default list is
// http://localhost:4000/service-list.xml, so the default must allow that origin and no other.
// The allowlist is read when server.js is loaded, so each case runs in its own process.
const { execFileSync } = require('node:child_process');
function guardIn(env, urls) {
  const code = `const { assertSafeUrl } = require('./server.js');
    Promise.all(${JSON.stringify(urls)}.map(u => assertSafeUrl(u).then(() => true, () => false)))
      .then(r => console.log(JSON.stringify(r)));`;
  const e = { ...process.env, LOG_LEVEL: 'error', ...env };
  if (env.PROXY_ALLOW_ORIGINS === undefined) delete e.PROXY_ALLOW_ORIGINS;
  return JSON.parse(execFileSync(process.execPath, ['-e', code], { cwd: require('node:path').join(__dirname, '..'), env: e }).toString());
}

test('with PROXY_ALLOW_ORIGINS unset, the default local list origin is allowed and nothing else local', () => {
  assert.deepEqual(
    guardIn({}, ['http://localhost:4000/service-list.xml', 'http://127.0.0.1:4000/epg', 'http://localhost:4001/x', 'http://192.168.1.1/']),
    [true, true, false, false]);
});

test('an empty PROXY_ALLOW_ORIGINS turns the default exemption off', () => {
  assert.deepEqual(guardIn({ PROXY_ALLOW_ORIGINS: '' }, ['http://localhost:4000/service-list.xml']), [false]);
});

test('a refused local address is answered with the setting to change', async () => {
  const srv = app.listen(0);
  await new Promise(r => srv.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/proxy?url=${encodeURIComponent('http://192.168.1.1/list.xml')}`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.hint, /PROXY_ALLOW_ORIGINS="http:\/\/localhost:4000" npm start/);
  } finally { srv.close(); }
});
