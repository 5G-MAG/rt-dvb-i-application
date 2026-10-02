/*
License: 5G-MAG Public License (v1.0)
Authors: Jordi J. Gimenez (5G-MAG)
Copyright: (C) 2026 5G-MAG Association

For full license terms please see the LICENSE file distributed with this
program. If this file is missing then the license can be retrieved from
https://www.5g-mag.com/license
*/
// Content guide requests of ETSI TS 103 770 V1.2.1 clause 6: which source a service uses (clause
// 6.1), the request URLs (clauses 6.5 to 6.8, encoded as clause 6.2.2 says), and the contextual
// parameters of an XML AIT request (clause 5.2.4.4.6). Pure functions.
const DVBIGuide = (() => {
  const THREE_HOURS_S = 10800;   // clause 6.5.2.1: "the Unix timestamp shall be a whole multiple of 10 800"
  const WINDOW_S      = 43200;   // clause 6.5.2.1: end is start plus 21 600 or 43 200 seconds

  // Clause 6.1, "In descending order of precedence": the service's own ContentGuideSource, the
  // ContentGuideSourceList entry whose @CGSID its ContentGuideSourceRef names, the service list's
  // ContentGuideSource. Each source is { cgsid, schedule, program, group, moreEpisodes } or null.
  function resolveSource({ own = null, ref = '', list = {}, listLevel = null } = {}) {
    if (own) return own;
    if (ref && list[ref]) return list[ref];
    return listLevel || null;
  }

  // Clause 6.5.2.2: "ContentGuideServiceRef, when specified, takes precedence over UniqueIdentifier"
  function serviceId(uniqueIdentifier, contentGuideServiceRef) {
    return contentGuideServiceRef || uniqueIdentifier;
  }

  // One key or value of a query string. Clauses 5.1.3.2 and 6.2.2: any "reserved" characters of
  // IETF RFC 3986 clause 2.2 within key/value pairs "shall be percent-encoded as defined in clause
  // 2.1 of IETF RFC 3986". RFC 3986 clause 2.2: reserved = gen-delims / sub-delims, gen-delims
  // ":" / "/" / "?" / "#" / "[" / "]" / "@", sub-delims "!" / "$" / "&" / "'" / "(" / ")" / "*" /
  // "+" / "," / ";" / "=". encodeURIComponent encodes all of them except ! ' ( ) *, which are
  // encoded here as well, with the uppercase hexadecimal digits clause 2.1 recommends.
  function encodeQueryComponent(v) {
    return encodeURIComponent(String(v))
      .replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  }

  // Query string of [name, value] pairs, each encoded as above, so "The square brackets "[" and
  // "]" shall be percent-encoded" (clause 6.2.2) holds for the array keys too.
  function query(pairs) {
    return pairs.filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `${encodeQueryComponent(k)}=${encodeQueryComponent(v)}`).join('&');
  }

  function withQuery(base, pairs) {
    const q = query(pairs);
    return q ? `${base}${base.includes('?') ? '&' : '?'}${q}` : base;
  }

  // The 12-hour windows, each starting on a 3-hour boundary, that together cover [fromMs, toMs]
  // (clause 6.5.2.1). "Combining the results of multiple calls is the responsibility of the DVB-I
  // client." (clause 6.5.2.2). Returns [{ start, end }] in Unix seconds.
  function scheduleWindows(fromMs, toMs) {
    const out = [];
    let start = Math.floor(fromMs / 1000 / THREE_HOURS_S) * THREE_HOURS_S;
    const last = toMs / 1000;
    do { out.push({ start, end: start + WINDOW_S }); start += WINDOW_S; } while (start < last);
    return out;
  }

  // Clause 6.5.2.2: <ScheduleInfoEndpoint>?start=<start_unixtime>&end=<end_unixtime>&sid=<service_id>
  function scheduleUrl(endpoint, sid, win) {
    return withQuery(endpoint, [['start', win.start], ['end', win.end], ['sid', sid]]);
  }

  // Clause 6.5.3.1: <ScheduleInfoEndpoint>?sid=<service_id>&now_next=<window_type>, true or window.
  function nowNextUrl(endpoint, sid, windowType = 'true') {
    return withQuery(endpoint, [['sid', sid], ['now_next', windowType]]);
  }

  // Clause 6.6.2: <ProgramInfoEndpoint>?pid=<program_id>
  function programUrl(endpoint, pid) {
    return withQuery(endpoint, [['pid', pid]]);
  }

  const regionPairs = regions => (regions || []).map(r => ['regionID[]', r]);
  const sidPairs = sids => (sids || []).map(s => ['sid[]', s]);

  // Clause 6.7.2: <MoreEpisodesEndpoint>?pid=<program_id>&type=ondemand&regionID[]=...
  function moreEpisodesUrl(endpoint, pid, regions) {
    return withQuery(endpoint, [['pid', pid], ['type', 'ondemand'], ...regionPairs(regions)]);
  }

  // Clause 6.8.2.2: <GroupInfoEndpoint>categories?sid[]=...&regionID[]=...
  function boxSetCategoriesUrl(groupEndpoint, sids, regions) {
    return withQuery(`${groupEndpoint}categories`, [...sidPairs(sids), ...regionPairs(regions)]);
  }

  // Clause 6.8.3.2: <GroupInfoEndpoint>?groupId=<group_id>&sid[]=...&regionID[]=...
  function boxSetListsUrl(groupEndpoint, groupId, sids, regions) {
    return withQuery(groupEndpoint, [['groupId', groupId], ...sidPairs(sids), ...regionPairs(regions)]);
  }

  // Clause 6.8.4.2: <GroupInfoEndpoint>contents?groupId=<group_id>&type=...&format=...&regionID[]=...
  // The paginated format is the default and is the one asked for, since this client pages.
  function boxSetContentsUrl(groupEndpoint, groupId, regions) {
    return withQuery(`${groupEndpoint}contents`, [['groupId', groupId], ['format', 'paginated'], ...regionPairs(regions)]);
  }

  // Clause 5.2.4.4.6: "Client devices shall append all of the following parameters to the XML AIT
  // URL provided in the metadata before attempting to retrieve the document: All regionID values
  // specific to the device. The UI location from which the application is being launched."
  function aitUrl(url, regions, launchLocation) {
    return withQuery(url, [...regionPairs(regions), ['lloc', launchLocation]]);
  }

  // On-demand availability window (table 52, StartOfAvailability and EndOfAvailability).
  function onDemandAvailable(od, ms) {
    if (!od) return false;
    const from = od.start ? Date.parse(od.start) : NaN;
    const to = od.end ? Date.parse(od.end) : NaN;
    return (!Number.isFinite(from) || ms >= from) && (!Number.isFinite(to) || ms < to);
  }

  // When a Template XML AIT result may be used until, clause 5.2.4.4.5: "If no Expires or max-age
  // header is provided the client device shall assume an expiry of 24 hours from retrieval. If both an
  // Expires and max-age header are present the client device shall use the Cache-Control: max-age".
  function templateAitExpiry(nowMs, maxAgeMs, expiresHeader) {
    if (maxAgeMs != null) return nowMs + maxAgeMs;
    const exp = expiresHeader ? Date.parse(expiresHeader) : NaN;
    if (Number.isFinite(exp)) return exp;
    return nowMs + 24 * 3600 * 1000;
  }

  // Results in display order: "A DVB-I client shall display results in ascending order using the
  // values from the MemberOf@index attribute." (clause 6.7.3), duplicates by programId dropped
  // (clause 6.9, NOTE).
  function orderResults(items) {
    const seen = new Set();
    return [...items]
      .sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity))
      .filter(i => (i.programId && seen.has(i.programId)) ? false : (seen.add(i.programId), true));
  }

  return {
    resolveSource, serviceId, scheduleWindows, scheduleUrl, nowNextUrl, programUrl, moreEpisodesUrl,
    boxSetCategoriesUrl, boxSetListsUrl, boxSetContentsUrl, aitUrl, onDemandAvailable,
    templateAitExpiry, orderResults, encodeQueryComponent,
  };
})();

// Exposed for Node-based unit tests (test/guide.test.js). `module` is undefined when loaded via a
// <script> tag in the browser, so this is a no-op there.
if (typeof module !== 'undefined' && module.exports) module.exports = DVBIGuide;
