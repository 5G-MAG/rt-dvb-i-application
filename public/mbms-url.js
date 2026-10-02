/*
License: 5G-MAG Public License (v1.0)
Authors: Jordi J. Gimenez (5G-MAG)
Copyright: (C) 2026 5G-MAG Association

For full license terms please see the LICENSE file distributed with this
program. If this file is missing then the license can be retrieved from
https://www.5g-mag.com/license
*/
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

  // RFC 3986 character classes for the parts of the MBMS URL (clauses 2.1 to 2.3, 3.2 and 3.3). The
  // prefix "shall not contain the character "&"" (TS 26.347 clause 8.2.2), so "&" is taken out of
  // sub-delims there; mid-value is TS 26.347's own uchar set.
  const MBMS_URI = (() => {
    const U = "A-Za-z0-9\\-._~";                 // unreserved
    const PCT = "%[0-9A-Fa-f]{2}";               // pct-encoded
    const SUB = "!$'()*+,;=";                    // sub-delims without "&"
    const userinfo = `(?:[${U}${SUB}:]|${PCT})*`;
    const regName = `(?:[${U}${SUB}]|${PCT})+`;
    const ipv4 = "(?:\\d{1,3}\\.){3}\\d{1,3}";
    const ipLiteral = "\\[[0-9A-Fa-f:.]+\\]";     // IPv6address; IPvFuture is not accepted
    const host = `(?:${ipLiteral}|${ipv4}|${regName})`;
    const authority = `(?:${userinfo}@)?${host}(?::\\d*)?`;
    const pathAbempty = `(?:/(?:[${U}${SUB}:@]|${PCT})*)*`;
    const midValue = `(?:[${U};?:@=+$,/]|${PCT})+`;
    const resourceURI = `[A-Za-z][A-Za-z0-9+.\\-]*:(?:[${U}:/?#\\[\\]@!$&'()*+,;=]|${PCT})*`;
    return {
      prefix: new RegExp(`^mbms://(${authority})${pathAbempty}$`),
      mid: new RegExp(`^[A-Za-z][A-Za-z0-9]*=${midValue}$`),
      label: new RegExp(`^${resourceURI}$`),
    };
  })();

  // Returns null for a valid MBMS URL, otherwise a sentence saying what is wrong.
  function problem(url) {
    const u = String(url || '');
    if (!u.startsWith('mbms://')) return 'not an MBMS URL: it must start with mbms://';
    const at = u.indexOf('&label=');
    const head = at < 0 ? u : u.slice(0, at);
    const label = at < 0 ? null : u.slice(at + '&label='.length);
    const [prefix, ...mid] = head.split('&');
    const m = MBMS_URI.prefix.exec(prefix);
    if (!m) return 'not an MBMS URL: after mbms:// it needs an RFC 3986 authority and an optional path, with no "&", query or fragment';
    const authorityHost = m[1].replace(/^[^@]*@/, '').replace(/:\d*$/, '');
    if (mid.length && authorityHost !== ROM_AUTHORITY) return `carries &name=value pairs, which are not allowed outside the Receive-only Mode form on mbms://${ROM_AUTHORITY}`;
    if (mid.some(p => !MBMS_URI.mid.test(p))) return 'has a mid-part that is not &name=value';
    if (label !== null && !MBMS_URI.label.test(label)) return 'the &label= suffix is not a URI';
    return null;
  }

  // The serviceId is the prefix: "the substring of the URI before the first "&"" (clause 8.2.2).
  function serviceId(url) { return String(url || '').split('&')[0]; }

  return { problem, serviceId };
})();

// Exposed for Node-based unit tests (test/mbms-url.test.js). `module` is undefined when loaded via a
// <script> tag in the browser, so this is a no-op there.
if (typeof module !== 'undefined' && module.exports) module.exports = DVBIMbmsUrl;
