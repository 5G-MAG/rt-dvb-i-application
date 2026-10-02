// MBMS URL check, 3GPP TS 26.347 V18.1.0 clause 8.2.2:
//   mbms-URI = "mbms:" "//" authority path-abempty *( "&" mid-label "=" mid-value ) [ "&label=" resourceURI ]
// "There are no currently defined mid-part pairs; they shall not be present in URLs", except the
// Receive-only Mode form of clause 8.2.4 on mbms://rom.3gpp.org, whose pairs are not checked here.
// The prefix "is the serviceId of the service", which only the MBMS Client can confirm.
//
// A service list carries the URL in IdentifierBasedDeliveryParameters (TS 103 770 V1.2.1 clause
// 5.5.4, table 16). This client cannot reach an MBMS Client, so it checks the signalling and shows
// it; it does not try to receive the service.
const DVBIMbmsUrl = (() => {
  const ROM_AUTHORITY = 'rom.3gpp.org';

  // Returns null for a valid MBMS URL, otherwise a sentence saying what is wrong.
  function problem(url) {
    const u = String(url || '');
    if (!u.startsWith('mbms://')) return 'not an MBMS URL: it must start with mbms://';
    const at = u.indexOf('&label=');
    const head = at < 0 ? u : u.slice(0, at);
    const label = at < 0 ? null : u.slice(at + '&label='.length);
    const [prefix, ...mid] = head.split('&');
    let parsed;
    try { parsed = new URL('http' + prefix.slice('mbms'.length)); } catch (_) { parsed = null; }
    if (!parsed || !parsed.host || parsed.search || parsed.hash) {
      return 'not an MBMS URL: after mbms:// it needs an authority and an optional path, with no query or fragment';
    }
    if (mid.length && parsed.host !== ROM_AUTHORITY) {
      return `carries &name=value pairs, which are not allowed outside the Receive-only Mode form on mbms://${ROM_AUTHORITY}`;
    }
    if (mid.some(p => !/^[A-Za-z][A-Za-z0-9]*=.+$/.test(p))) return 'has a mid-part that is not &name=value';
    if (label !== null) {
      try { new URL(label); } catch (_) { return 'the &label= suffix is not a URI'; }
    }
    return null;
  }

  // The serviceId is the prefix: "the substring of the URI before the first "&"" (clause 8.2.2).
  function serviceId(url) { return String(url || '').split('&')[0]; }

  return { problem, serviceId };
})();

// Exposed for Node-based unit tests (test/mbms-url.test.js). `module` is undefined when loaded via a
// <script> tag in the browser, so this is a no-op there.
if (typeof module !== 'undefined' && module.exports) module.exports = DVBIMbmsUrl;
