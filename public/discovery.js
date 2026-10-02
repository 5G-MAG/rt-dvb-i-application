// Service List Registry responses, ETSI TS 103 770 V1.2.1 clause 5.3 and clause 8.5.3.2 (tables 81,
// 83 and 83a): which offerings this client can install and which it offers first.
//
// An offering, as parseEntryPoints in app.js builds it:
//   { name, urls, serviceListId, regulatorListFlag, languages: [], targetCountries: [], logo,
//     provider: { name, regulatorFlag },
//     delivery: { dash, dvbt: [], dvbc: [], dvbs: [], rtsp, multicast, application, other: [] } }
// where each delivery entry is { required, ... } and application also has types: [{ contentType,
// xmlAitApplicationType }], other has extensionName.
const DVBIDiscovery = (() => {
  // What this browser client can receive: DVB-DASH over its IP connection, HTML5 applications
  // (directly or through an XML AIT), and HLS through OtherDeliveryParameters as annex G.2.2 shows
  // it. No broadcast tuner, no RTSP, no multicast.
  const HTML_TYPES = ['text/html', 'application/xhtml+xml'];
  const isHls = name => /mpegurl|m3u8|apple/i.test(String(name || ''));

  function applicationUsable(app) {
    return (app.types || []).some(t => {
      const ct = String(t.contentType || '').toLowerCase();
      if (HTML_TYPES.includes(ct)) return true;
      return ct === 'application/vnd.dvb.ait+xml' && HTML_TYPES.includes(String(t.xmlAitApplicationType || '').toLowerCase());
    });
  }

  // Why the offering should not be installed, or null. Table 12c, @required: "When set to true, the
  // DVB-I client should only install the service list offering if the broadcast signal, IP network or
  // application related to the delivery type can be used by the client to retrieve DVB services."
  // Table 12a: several required DVBTDelivery (likewise DVBC, DVBS) are alternatives, any one will do;
  // none of them can be used here.
  function deliveryProblem(delivery) {
    if (!delivery) return null;
    const missing = [];
    for (const [key, label] of [['dvbt', 'DVB-T'], ['dvbc', 'DVB-C'], ['dvbs', 'DVB-S']]) {
      if ((delivery[key] || []).some(d => d.required)) missing.push(label);
    }
    if (delivery.rtsp && delivery.rtsp.required) missing.push('RTSP');
    if (delivery.multicast && delivery.multicast.required) missing.push('multicast');
    if (delivery.application && delivery.application.required && !applicationUsable(delivery.application)) {
      missing.push('an application type this client cannot run');
    }
    for (const o of delivery.other || []) {
      if (o.required && !isHls(o.extensionName)) missing.push(`delivery extension ${o.extensionName || '(unnamed)'}`);
    }
    return missing.length ? `requires ${missing.join(', ')}, which this client cannot receive` : null;
  }

  // Table 12, TargetCountry: "If not specified, no regional constraints exist and the service can be
  // received anywhere."
  function targetsCountry(offering, country) {
    const tc = offering.targetCountries || [];
    return !country || !tc.length || tc.includes(country);
  }

  // Table 12, Language: the audio languages of the list's services; a match on the preferred one.
  function speaks(offering, lang) {
    return !!lang && (offering.languages || []).some(l => String(l).toLowerCase().split('-')[0] === lang.toLowerCase());
  }

  // The offerings in the order offered to the user, each with { problem, isDefault }.
  // Table 83, NOTE 2: "If a Service List Registry response includes any lists with
  // @regulatorListFlag set to true then DVB-I clients shall either i) select a Service List with
  // @regulatorListFlag set to true or ii) offer the user a choice of Service Lists where the default
  // option is a Service List with @regulatorListFlag set to true." This client takes ii): regulator
  // lists first, and whenever there is one the default is a regulator list, the first installable
  // one or, when none can be installed here, the first one with its problem; then installable
  // lists before the rest, lists in the preferred audio language, otherwise registry order.
  // Offerings for another country are given a problem.
  function arrange(offerings, { country = null, lang = '' } = {}) {
    const rated = offerings.map((o, i) => {
      let problem = deliveryProblem(o.delivery);
      if (!problem && !targetsCountry(o, country)) problem = `intended for ${(o.targetCountries || []).join(', ')}, not ${country}`;
      return { ...o, problem, order: i };
    });
    rated.sort((a, b) =>
      (!!b.regulatorListFlag - !!a.regulatorListFlag)
      || (!!a.problem - !!b.problem)
      || (speaks(b, lang) - speaks(a, lang))
      || (a.order - b.order));
    const regulatorDefault = rated.find(o => o.regulatorListFlag);
    const theDefault = regulatorDefault || rated.find(o => !o.problem);
    return rated.map(o => ({ ...o, isDefault: o === theDefault }));
  }

  // Table 12, ServiceListId: "If the ServiceList@id does not match the
  // ServiceListOffering.ServiceListId it should be considered an error". Null when they match or no
  // id was expected.
  function idProblem(expectedId, listId) {
    if (!expectedId || expectedId === listId) return null;
    return `the service list id ${listId || '(none)'} does not match the registry's ServiceListId ${expectedId}`;
  }

  return { deliveryProblem, targetsCountry, arrange, idProblem };
})();

// Exposed for Node-based unit tests (test/discovery.test.js). `module` is undefined when loaded via a
// <script> tag in the browser, so this is a no-op there.
if (typeof module !== 'undefined' && module.exports) module.exports = DVBIDiscovery;
