// The /proxy endpoint fetches a URL on the browser's behalf, so its address guard is the thing
// standing between this receiver and being used to reach whatever the host can reach. These cases
// pin the guard's behaviour, including the allowlist that makes local testing possible without
// switching it off.
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
process.env.PROXY_ALLOW_ORIGINS = 'http://localhost:4000, http://127.0.0.1:4000/';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertSafeUrl, isPrivateIp } = require('../server.js');

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
