/*
License: 5G-MAG Public License (v1.0)
Authors: Jordi J. Gimenez (5G-MAG)
Copyright: (C) 2026 5G-MAG Association

For full license terms please see the LICENSE file distributed with this
program. If this file is missing then the license can be retrieved from
https://www.5g-mag.com/license
*/
// Service list handling rules of ETSI TS 103 770 V1.2.1 that this client applies after parsing:
// channel numbers (clauses 5.5.10 to 5.5.12 and 5.5.29), service regions (table 15), subscription
// packages (clause 5.1.5, table 16), service parental rating (clause 5.5.28), linked application
// precedence (clause 5.2.3) and XML AIT application selection (clause 5.2.4.2), and the daily
// update time (clause 5.1.7). Pure functions; app.js builds their inputs from the XML.
const DVBIServiceList = (() => {
  const DAY_MS = 86400000;

  // ── Regions and packages ──────────────────────────────────────────────────────────────────

  // Table 15, TargetRegion: "If not specified, no regional constraints exist and the service can be
  // received anywhere." A service may name several regions; any one of them matches.
  function inRegion(targetRegions, region) {
    return !region || !targetRegions || !targetRegions.length || targetRegions.includes(region);
  }

  // Table 16, SubscriptionPackage: "If present, this service instance is selectable only by a DVB-I
  // client that is associated to one of the SubscriptionPackage elements listed here."
  function packageAllows(instancePackages, clientPackages) {
    if (!instancePackages || !instancePackages.length) return true;
    return instancePackages.some(p => clientPackages.includes(p));
  }

  // ── Channel numbers ───────────────────────────────────────────────────────────────────────

  // Clause 5.5.12: "a single LCNTable shall be selected. Different LCN tables are not intended to be
  // combined by the DVB-I client." The table for the selected region (table 25, TargetRegion) and
  // subscription packages (deprecated at table level, still honoured), else the table without
  // either constraint. Returns the table or null.
  function selectLcnTable(tables, region, clientPackages = []) {
    const regionOk = t => (!t.targetRegions.length ? 'any' : (region && t.targetRegions.includes(region) ? 'match' : null));
    const pkgOk = t => (!t.packages.length ? 'any' : (t.packages.some(p => clientPackages.includes(p)) ? 'match' : null));
    const usable = tables.filter(t => regionOk(t) && pkgOk(t));
    const score = t => (regionOk(t) === 'match' ? 2 : 0) + (pkgOk(t) === 'match' ? 1 : 0);
    let best = null;
    for (const t of usable) if (!best || score(t) > score(best)) best = t;
    return best;
  }

  // Termreference match for LCNRange @serviceType and @serviceGenre.
  const sameTerm = (a, b) => String(a || '') === String(b || '');

  // Channel numbers from one LCN table. `services` are in service list document order, each
  // { uid, serviceType, genres }. Returns uid -> { lcn, visible, selectable } for the services the
  // table numbers, explicitly (LCN, table 23) or through LCNRange (table 37g); services left over
  // get no number ("the client may choose the LCN mapping strategy to use for any remaining
  // services", clause 5.5.29).
  function assignChannelNumbers(table, services) {
    const out = {};
    if (!table) return out;
    const known = new Set(services.map(s => s.uid));
    const used = new Set();
    for (const e of table.entries) {
      if (!known.has(e.serviceRef) || out[e.serviceRef]) continue;
      out[e.serviceRef] = { lcn: e.channelNumber, visible: e.visible, selectable: e.selectable };
      used.add(e.channelNumber);
    }
    // "Lower values of this attribute indicate a higher priority. Higher priority LCN ranges shall
    // be used first, until all their LCNs are assigned. When LCN ranges have the same priority, the
    // range with the lowest @start value shall be used first."
    const ranges = [...table.ranges].sort((a, b) => (a.priority - b.priority) || (a.start - b.start));
    // "Clients should apply LCNRange mapping rules to DVB-I services in the order they are defined in
    // the service list XML."
    let remaining = services.filter(s => !out[s.uid]);
    for (const r of ranges) {
      // dvbi and any map DVB-I services; targetBroadcast and otherBroadcast concern non-DVB-I
      // broadcast services, which a browser has none of.
      if (r.serviceOrigin !== 'dvbi' && r.serviceOrigin !== 'any') continue;
      const step = r.end != null && r.end < r.start ? -1 : 1;
      // "When undefined, the range shall be ascending. A client shall map channel numbers to
      // services in sequence until reaching the client's maximum supported channel number". This
      // client has no maximum below what a channel number can hold, so the range is open.
      const last = r.end != null ? r.end : Number.MAX_SAFE_INTEGER;
      const inRange = n => (step > 0 ? n >= r.start && n <= last : n <= r.start && n >= last);
      let next = r.start;
      if (r.fillMethod === 'startFromHighest' && step > 0) {
        // "map any unassigned LCNs in ascending order, starting from the highest LCN already
        // assigned in the range"
        const assigned = [...used].filter(inRange);
        if (assigned.length) next = Math.max(...assigned) + 1;
      }
      const left = [];
      for (const s of remaining) {
        if (r.serviceType && !sameTerm(r.serviceType, s.serviceType)) { left.push(s); continue; }
        if (r.serviceGenre && !(s.genres || []).some(g => sameTerm(g, r.serviceGenre))) { left.push(s); continue; }
        while (inRange(next) && used.has(next)) next += step;
        if (!inRange(next)) { left.push(s); continue; }
        out[s.uid] = { lcn: next, visible: true, selectable: true };
        used.add(next);
        next += step;
      }
      remaining = left;
    }
    return out;
  }

  // Table 23: a service with @visible false is left out of normal navigation; it stays reachable by
  // direct entry of its channel number unless @selectable is false ("This flag is only interpreted
  // when the visible flag is set to false.").
  function directlySelectable(numbering) {
    return !numbering || numbering.visible !== false || numbering.selectable !== false;
  }

  // ── Parental rating ───────────────────────────────────────────────────────────────────────

  // The MinimumAge that applies in `country` (ISO 3166 alpha-3), clause 5.5.28, table 37f:
  // "When no country is defined, the minimum age rating shall apply irrespective of the country."
  // `ratings` is [{ age, countries: [] }]. With no country known to the client, a country-specific
  // rating cannot be ruled out, so the most restrictive one is taken. Returns a number or null.
  function minimumAgeFor(ratings, country) {
    if (!ratings || !ratings.length) return null;
    const general = ratings.filter(r => !r.countries.length);
    if (country) {
      const own = ratings.find(r => r.countries.includes(country));
      if (own) return own.age;
      return general.length ? Math.max(...general.map(r => r.age)) : null;
    }
    return Math.max(...ratings.map(r => r.age));
  }

  // The client's parental criterion: `threshold` 0 means none; otherwise content rated at or above
  // it is restricted. Clause 5.5.28: the guide's rating of the programme being shown, where there
  // is one, takes precedence over Service.ParentalRating.
  function restricted(threshold, serviceAge, programmeAge) {
    if (!threshold) return false;
    const age = programmeAge != null ? programmeAge : serviceAge;
    return age != null && age >= threshold;
  }

  // ── Linked applications ───────────────────────────────────────────────────────────────────

  const LINKED_APP_CS = 'urn:dvb:metadata:cs:LinkedApplicationCS:2019:';
  // Table 7 types this client can start: HTML pages directly, and an XML AIT that leads to one.
  const STARTABLE_TYPES = ['text/html', 'application/xhtml+xml', 'application/vnd.dvb.ait+xml'];

  // The LinkedApplicationCS term of a HowRelated@href ("1.1", "1.2", "2", "3"), or null.
  function linkedAppTerm(href) {
    const h = String(href || '');
    return h.startsWith(LINKED_APP_CS) ? h.slice(LINKED_APP_CS.length) : null;
  }

  // The applications that apply to a service instance, clause 5.2.3.4: an instance-level 1.1 or 1.2
  // overrides service-level 1.1 and 1.2 with the same MediaUri@contentType, an instance-level 2
  // overrides a service-level 2 with the same type; 3 is used only at service level.
  // Each app is { term, url, contentType }. Applications of a type this client cannot start are
  // ignored ("The DVB-I client may ignore any signalled application that has a MediaUri@contentType
  // attribute that they do not understand.", clause 5.2.3.1), except an application controlling
  // media presentation (1.2): it is kept, marked { unstartable: true }, because its instance is then
  // to be discarded (clause 5.2.13, NOTE 1 i)) rather than played from its delivery parameters,
  // which clause 5.2.3.2 has the client ignore.
  function effectiveApps(serviceApps, instanceApps) {
    const ok = a => STARTABLE_TYPES.includes(String(a.contentType || '').toLowerCase());
    const kept = a => ok(a) || a.term === '1.2';
    const live = t => t === '1.1' || t === '1.2';
    const inst = (instanceApps || []).filter(a => kept(a) && a.term !== '3');
    const svc = (serviceApps || []).filter(kept).filter(s => !inst.some(i =>
      i.contentType === s.contentType && ((live(i.term) && live(s.term)) || (i.term === '2' && s.term === '2'))));
    return [...inst, ...svc].map(a => (ok(a) ? a : { ...a, unstartable: true }));
  }

  // ── XML AIT ───────────────────────────────────────────────────────────────────────────────

  // Clause 5.2.4.2 application types; of them, this browser client can start an HTML5 webpage and
  // has no HbbTV engine.
  const AIT_TYPES_STARTABLE = ['text/html', 'application/xhtml+xml'];

  // `apps` as parsed from an XML AIT: [{ type, priority, url }]. Clause 5.2.4.2: "select the
  // application with the highest mhp:priority value that meets all of the following criteria". The
  // platform profile criterion refers to table 5 of ETSI TS 102 796, which is not held, so it is not
  // applied. Returns the app or null.
  function selectAitApplication(apps) {
    let best = null;
    for (const a of apps) {
      if (!AIT_TYPES_STARTABLE.includes(String(a.type || '').toLowerCase()) || !a.url) continue;
      if (!best || a.priority > best.priority) best = a;
    }
    return best;
  }

  // ── Daily update ──────────────────────────────────────────────────────────────────────────

  // Clause 5.1.7: "A DVB-I client should check for an update of an installed Service List once
  // every 24 hours." and "If updates are performed around a predetermined timeframe (e.g. 6am), a
  // DVB-I client should randomize the exact update time". The daily check runs at a time of day
  // drawn uniformly over the 24 hours, so no fixed time is shared between clients.
  function dailyUpdateDelay(random = Math.random) {
    return Math.floor(random() * DAY_MS);
  }

  return {
    inRegion, packageAllows, selectLcnTable, assignChannelNumbers, directlySelectable,
    minimumAgeFor, restricted, linkedAppTerm, effectiveApps, selectAitApplication, dailyUpdateDelay,
    DAY_MS,
  };
})();

// Exposed for Node-based unit tests (test/servicelist.test.js). `module` is undefined when loaded via
// a <script> tag in the browser, so this is a no-op there.
if (typeof module !== 'undefined' && module.exports) module.exports = DVBIServiceList;
