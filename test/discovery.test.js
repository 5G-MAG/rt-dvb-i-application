// Service List Registry responses, ETSI TS 103 770 V1.2.1 clauses 5.3 and 8.5.3.2 (public/discovery.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../public/discovery.js');

const offering = (name, o = {}) => ({
  name, urls: [`https://sl.example/${name}`], serviceListId: `tag:x,2026:${name}`, regulatorListFlag: false,
  languages: [], targetCountries: [], logo: null, provider: null,
  delivery: { dash: { required: false }, dvbt: [], dvbc: [], dvbs: [], rtsp: null, multicast: null, application: null, other: [] },
  ...o,
});
const withDelivery = (d) => ({ dash: null, dvbt: [], dvbc: [], dvbs: [], rtsp: null, multicast: null, application: null, other: [], ...d });

test('table 12c @required: an offering is not installed when a required delivery cannot be used', () => {
  assert.equal(D.deliveryProblem(withDelivery({ dash: { required: true } })), null);
  assert.equal(D.deliveryProblem(withDelivery({ dash: { required: true }, dvbt: [{ required: false }] })), null,
    'a delivery type that is not required does not stop installation');
  assert.match(D.deliveryProblem(withDelivery({ dvbt: [{ required: true }, { required: true }] })), /DVB-T/);
  assert.match(D.deliveryProblem(withDelivery({ multicast: { required: true } })), /multicast/);
  assert.equal(D.deliveryProblem(withDelivery({ application: { required: true, types: [{ contentType: 'text/html' }] } })), null);
  assert.equal(D.deliveryProblem(withDelivery({ application: { required: true,
    types: [{ contentType: 'application/vnd.dvb.ait+xml', xmlAitApplicationType: 'application/xhtml+xml' }] } })), null);
  assert.match(D.deliveryProblem(withDelivery({ application: { required: true,
    types: [{ contentType: 'application/vnd.dvb.ait+xml', xmlAitApplicationType: 'application/vnd.hbbtv.xhtml+xml' }] } })), /application type/);
});

test('table 83 NOTE 2: a regulator list is the default choice', () => {
  const list = D.arrange([offering('a'), offering('reg', { regulatorListFlag: true }), offering('b')]);
  assert.deepEqual(list.map(o => o.name), ['reg', 'a', 'b']);
  assert.deepEqual(list.map(o => o.isDefault), [true, false, false]);
});

test('an offering that cannot be installed is never the default, even a regulator\'s', () => {
  const list = D.arrange([
    offering('reg', { regulatorListFlag: true, delivery: withDelivery({ dvbs: [{ required: true }] }) }),
    offering('ok'),
  ]);
  assert.equal(list[0].name, 'ok');
  assert.equal(list[0].isDefault, true);
  assert.match(list[1].problem, /DVB-S/);
});

test('table 83 TargetCountry and Language are acted on', () => {
  const list = D.arrange([
    offering('fr', { targetCountries: ['FRA'], languages: ['fr'] }),
    offering('any-de', { languages: ['de'] }),
    offering('es', { targetCountries: ['ESP'], languages: ['es'] }),
  ], { country: 'ESP', lang: 'de' });
  assert.deepEqual(list.map(o => o.name), ['any-de', 'es', 'fr'], 'preferred language first; another country last');
  assert.match(list[2].problem, /intended for FRA, not ESP/);
  assert.equal(D.targetsCountry(offering('x'), 'ESP'), true, 'no TargetCountry: anywhere');
});

test('table 12 ServiceListId: a list whose @id differs is an error', () => {
  assert.equal(D.idProblem('tag:x,2026:a', 'tag:x,2026:a'), null);
  assert.equal(D.idProblem('', 'anything'), null, 'nothing expected when the list did not come from a registry');
  assert.match(D.idProblem('tag:x,2026:a', 'tag:x,2026:b'), /does not match/);
});
