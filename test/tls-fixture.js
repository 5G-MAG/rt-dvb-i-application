/*
License: 5G-MAG Public License (v1.0)
Authors: Jordi J. Gimenez (5G-MAG)
Copyright: (C) 2026 5G-MAG Association

For full license terms please see the LICENSE file distributed with this
program. If this file is missing then the license can be retrieved from
https://www.5g-mag.com/license
*/
// A throwaway self-signed certificate for 127.0.0.1 and localhost, made with the openssl command
// line when a test starts, so that test servers can speak HTTPS: TS 103 770 V1.2.1 clause 7.3 has
// the client refuse plain HTTP to a metadata endpoint outside its private subnet, and loopback is
// not such a subnet. Nothing is stored in the repository.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function makeCertificate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvbi-tls-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-keyout', keyPath, '-out', certPath,
  ], { stdio: 'ignore' });
  const pair = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  fs.rmSync(dir, { recursive: true, force: true });
  return pair;
}

module.exports = { makeCertificate };
