/*
License: 5G-MAG Public License (v1.0)
Authors: Jordi J. Gimenez (5G-MAG)
Copyright: (C) 2026 5G-MAG Association

For full license terms please see the LICENSE file distributed with this
program. If this file is missing then the license can be retrieved from
https://www.5g-mag.com/license
*/
// The TLS profile of the proxy's connections to DVB-I metadata endpoints (server.js UPSTREAM_TLS):
// TS 103 770 V1.2.1 clause 7.3, which takes cipher suites, signature algorithms, key sizes, curves
// and root certificates from ETSI TS 102 796 V1.8.1 clause 11.2. Each case connects with those
// options to a local TLS server configured to offer one thing, and checks what is negotiated or
// that the connection is refused. Certificates come from the openssl command line, made per run.
process.env.LOG_LEVEL = 'error';
const UPSTREAM_PORT = 45994;
process.env.PROXY_ALLOW_ORIGINS = `https://127.0.0.1:${UPSTREAM_PORT}`;
// The proxy-level case below trusts its throwaway certificate this way; the certificate cases
// connect with the options directly and name their own CA.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const tls = require('node:tls');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { app, UPSTREAM_TLS } = require('../server.js');

let dir;
const certs = {};
// A weak server is only possible with its own security level lowered; this is the server's side.
const WEAK = ':@SECLEVEL=0';

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvbi-tlsprofile-'));
  const sh = (...a) => execFileSync('openssl', a, { cwd: dir, stdio: 'ignore' });
  const read = f => fs.readFileSync(path.join(dir, f));
  fs.writeFileSync(path.join(dir, 'ext.cnf'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
  const ca = (name, key) => sh('req', '-x509', '-newkey', ...key, '-nodes', '-days', '1', '-subj', `/CN=${name}`,
    '-keyout', `${name}.key`, '-out', `${name}.pem`, '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign');
  const leaf = (name, caName, key, md = '-sha256') => {
    sh('req', '-new', '-newkey', ...key, '-nodes', '-subj', '/CN=localhost', '-keyout', `${name}.key`, '-out', `${name}.csr`);
    sh('x509', '-req', '-in', `${name}.csr`, '-CA', `${caName}.pem`, '-CAkey', `${caName}.key`, '-CAcreateserial',
      '-days', '1', md, '-extfile', 'ext.cnf', '-out', `${name}.pem`);
    certs[name] = { key: read(`${name}.key`), cert: read(`${name}.pem`), ca: read(`${caName}.pem`) };
  };
  ca('ca', ['rsa:2048']);
  ca('ca1024', ['rsa:1024']);
  leaf('rsa2048', 'ca', ['rsa:2048']);
  leaf('rsa4096', 'ca', ['rsa:4096']);
  leaf('rsa1024', 'ca', ['rsa:1024']);
  leaf('smallroot', 'ca1024', ['rsa:2048']);
  leaf('sha1', 'ca', ['rsa:2048'], '-sha1');
  leaf('p256', 'ca', ['ec', '-pkeyopt', 'ec_paramgen_curve:P-256']);
  leaf('p384', 'ca', ['ec', '-pkeyopt', 'ec_paramgen_curve:P-384']);
});

after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

// Connects with UPSTREAM_TLS to a server with `server` options and the certificate `name`.
// Resolves { protocol, cipher, group } or { error }.
function connect(name, server = {}) {
  const { key, cert, ca } = certs[name];
  return new Promise((resolve, reject) => {
    const srv = tls.createServer({ key, cert, ...server }, s => s.end());
    srv.on('tlsClientError', () => {});
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      // rejectUnauthorized is the default; it is named because this file sets NODE_TLS_REJECT_UNAUTHORIZED.
      const c = tls.connect({ ...UPSTREAM_TLS, host: '127.0.0.1', port: srv.address().port, servername: 'localhost', ca, rejectUnauthorized: true });
      c.on('secureConnect', () => {
        const r = { protocol: c.getProtocol(), cipher: c.getCipher().standardName, group: c.getEphemeralKeyInfo().name };
        c.destroy(); srv.close(); resolve(r);
      });
      c.on('error', e => { srv.close(); resolve({ error: e.message }); });
    });
  });
}

test('the profile: TLS 1.2 to 1.3, table 15a suites, table 15b algorithms, table 15c curves, 112-bit level', () => {
  assert.equal(UPSTREAM_TLS.minVersion, 'TLSv1.2');
  assert.equal(UPSTREAM_TLS.maxVersion, 'TLSv1.3');
  assert.deepEqual(UPSTREAM_TLS.ciphers.split(':'), [
    'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256', 'TLS_AES_128_GCM_SHA256',
    'ECDHE-ECDSA-AES128-GCM-SHA256', 'ECDHE-RSA-AES128-GCM-SHA256', 'ECDHE-ECDSA-AES256-GCM-SHA384',
    'ECDHE-RSA-AES256-GCM-SHA384', 'AES128-SHA', '@SECLEVEL=2']);
  const sigalgs = UPSTREAM_TLS.sigalgs.split(':');
  for (const forbidden of ['rsa_pkcs1_sha1', 'ecdsa_sha1', 'RSA+SHA1', 'RSA+MD5']) assert.ok(!sigalgs.includes(forbidden), forbidden);
  for (const mandatory of ['rsa_pkcs1_sha256', 'rsa_pkcs1_sha384', 'ecdsa_secp256r1_sha256', 'ecdsa_secp384r1_sha384',
    'rsa_pss_rsae_sha256', 'rsa_pss_rsae_sha384']) assert.ok(sigalgs.includes(mandatory), mandatory);
  assert.deepEqual(UPSTREAM_TLS.ecdhCurve.split(':'), ['X25519', 'P-256', 'P-384', 'P-521']);
  assert.doesNotThrow(() => tls.createSecureContext(UPSTREAM_TLS), 'the runtime accepts every option');
});

test('table 15a: each mandatory and recommended TLS 1.2 suite is negotiated', async () => {
  for (const [suite, standard, cert] of [
    ['ECDHE-ECDSA-AES128-GCM-SHA256', 'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256', 'p256'],
    ['ECDHE-RSA-AES128-GCM-SHA256', 'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256', 'rsa2048'],
    ['ECDHE-ECDSA-AES256-GCM-SHA384', 'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384', 'p384'],
    ['ECDHE-RSA-AES256-GCM-SHA384', 'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384', 'rsa2048'],
    ['AES128-SHA', 'TLS_RSA_WITH_AES_128_CBC_SHA', 'rsa2048'],
  ]) {
    const r = await connect(cert, { maxVersion: 'TLSv1.2', ciphers: suite });
    assert.deepEqual([r.protocol, r.cipher], ['TLSv1.2', standard], `${suite}: ${r.error || ''}`);
  }
});

test('RFC 8446 clause 9.1: TLS_AES_128_GCM_SHA256 is negotiated over TLS 1.3', async () => {
  const r = await connect('rsa2048', { ciphers: 'TLS_AES_128_GCM_SHA256' });
  assert.deepEqual([r.protocol, r.cipher], ['TLSv1.3', 'TLS_AES_128_GCM_SHA256'], r.error);
});

test('table 15a: anonymous, NULL and unlisted suites, and TLS 1.1, are refused', async () => {
  for (const [what, server] of [
    ['anonymous key exchange', { maxVersion: 'TLSv1.2', ciphers: 'ADH-AES128-GCM-SHA256' + WEAK }],
    ['NULL encryption', { maxVersion: 'TLSv1.2', ciphers: 'NULL-SHA256' + WEAK }],
    ['a suite outside table 15a', { maxVersion: 'TLSv1.2', ciphers: 'ECDHE-RSA-AES128-SHA256' }],
    ['a DHE suite outside table 15a', { maxVersion: 'TLSv1.2', ciphers: 'DHE-RSA-AES128-GCM-SHA256', dhparam: 'auto' }],
    ['TLS 1.1', { minVersion: 'TLSv1', maxVersion: 'TLSv1.1', ciphers: 'DEFAULT' + WEAK }],
  ]) {
    const r = await connect('rsa2048', server);
    assert.ok(r.error, `${what} must not be negotiated, got ${r.protocol} ${r.cipher}`);
  }
});

test('table 15c: P-256 and P-384 for key exchange in TLS 1.2 and 1.3, and for signatures', async () => {
  for (const [curve, group] of [['P-256', 'prime256v1'], ['P-384', 'secp384r1'], ['P-521', 'secp521r1']]) {
    for (const maxVersion of ['TLSv1.2', 'TLSv1.3']) {
      const r = await connect('rsa2048', { maxVersion, ecdhCurve: curve });
      assert.deepEqual([r.protocol, r.group], [maxVersion, group], `${curve} over ${maxVersion}: ${r.error || ''}`);
    }
  }
  for (const cert of ['p256', 'p384']) {
    for (const maxVersion of ['TLSv1.2', 'TLSv1.3']) {
      const r = await connect(cert, { maxVersion });
      assert.equal(r.protocol, maxVersion, `an ECDSA ${cert} certificate over ${maxVersion}: ${r.error || ''}`);
    }
  }
});

test('clause 11.2.5: RSA keys of 2 048 and 4 096 bits are accepted, 1 024 bits refused', async () => {
  assert.equal((await connect('rsa2048')).protocol, 'TLSv1.3');
  assert.equal((await connect('rsa4096')).protocol, 'TLSv1.3');
  for (const maxVersion of ['TLSv1.2', 'TLSv1.3']) {
    const r = await connect('rsa1024', { maxVersion, ciphers: 'DEFAULT' + WEAK });
    assert.ok(r.error, `a 1 024-bit server key over ${maxVersion} must be refused`);
  }
});

test('clause 11.2.3: a root certificate with a 1 024-bit RSA key is not trusted', async () => {
  const r = await connect('smallroot', { ciphers: 'DEFAULT' + WEAK });
  assert.ok(r.error, 'a chain to a 1 024-bit root must be refused');
});

test('table 15b: a SHA-1 signature is not trusted, in the chain or in the handshake', async () => {
  assert.ok((await connect('sha1', { ciphers: 'DEFAULT' + WEAK })).error, 'a certificate signed with sha1WithRSAEncryption');
  const r = await connect('rsa2048', { maxVersion: 'TLSv1.2', sigalgs: 'RSA+SHA1', ciphers: 'ECDHE-RSA-AES128-GCM-SHA256' + WEAK });
  assert.ok(r.error, 'a TLS 1.2 handshake signed with rsa_pkcs1_sha1');
});

// The proxy's requests use the profile: an upstream offering only a suite outside table 15a fails
// with 502; one offering TLS_RSA_WITH_AES_128_CBC_SHA, which the runtime offers too, answers.
test('the proxy connects upstream with the profile', async (t) => {
  let suite = 'ECDHE-RSA-AES128-SHA256';
  const upstream = https.createServer({ key: certs.rsa2048.key, cert: certs.rsa2048.cert, maxVersion: 'TLSv1.2', ciphers: suite }, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end('<?xml version="1.0"?><ServiceList/>');
  });
  try {
    await new Promise((ok, err) => { upstream.once('error', err); upstream.listen(UPSTREAM_PORT, '127.0.0.1', ok); });
  } catch {
    t.skip(`port ${UPSTREAM_PORT} is in use`);
    return;
  }
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const via = () => fetch(`http://127.0.0.1:${server.address().port}/proxy?url=` +
    encodeURIComponent(`https://127.0.0.1:${UPSTREAM_PORT}/list.xml`));
  try {
    assert.equal((await via()).status, 502, 'TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA256 is not offered');
    suite = 'AES128-SHA';
    upstream.setSecureContext({ key: certs.rsa2048.key, cert: certs.rsa2048.cert, maxVersion: 'TLSv1.2', ciphers: suite });
    const ok = await via();
    assert.equal(ok.status, 200, 'TLS_RSA_WITH_AES_128_CBC_SHA is');
    assert.match(await ok.text(), /<ServiceList\/>/);
  } finally {
    server.close();
    upstream.close();
  }
});
