/*
License: 5G-MAG Public License (v1.0)
Authors: Jordi J. Gimenez (5G-MAG)
Copyright: (C) 2026 5G-MAG Association

For full license terms please see the LICENSE file distributed with this
program. If this file is missing then the license can be retrieved from
https://www.5g-mag.com/license
*/
const { test } = require('node:test');
const assert = require('node:assert/strict');
const DVBIMbmsUrl = require('../public/mbms-url.js');

test('MBMS URL: the forms of TS 26.347 clauses 8.2.3 and 8.2.4 are valid', () => {
  for (const u of [
    'mbms://example.com/userservice/1',
    'mbms://www.example.com/',
    'mbms://service1000.mbms.operator.com&label=http://www.example.com/videos/sample.mp4',
    'mbms://rom.3gpp.org&tmgi=901056&serviceArea=40201&frequency=68616&subCarrierSpacing=1.25&bandwidth=8',
    'mbms://rom.3gpp.org&serviceArea=40201&frequency=68616&subCarrierSpacing=1.25&bandwidth=8&serviceId=%22television-service%22',
  ]) assert.equal(DVBIMbmsUrl.problem(u), null, u);
});

test('MBMS URL: what clause 8.2.2 does not allow is reported', () => {
  for (const u of [
    'urn:3gpp:mbms:service:hybrid',
    'https://example.com/manifest.mpd',
    'mbms://',
    'mbms://example.com/a?x=1',
    'mbms://example.com&foo=1',
    'mbms://example.com&label=not a uri',
    'mbms://example.com/a b',
    'mbms://exa mple.com',
    'mbms://example.com#f',
  ]) assert.ok(DVBIMbmsUrl.problem(u), u);
});

test('MBMS URL: the serviceId is the part before the first &', () => {
  assert.equal(DVBIMbmsUrl.serviceId('mbms://service1000.mbms.operator.com&label=http://www.example.com/v.mp4'),
    'mbms://service1000.mbms.operator.com');
  assert.equal(DVBIMbmsUrl.serviceId('mbms://example.com/userservice/1'), 'mbms://example.com/userservice/1');
});
