/*
License: 5G-MAG Public License (v1.0)
Authors: Jordi J. Gimenez (5G-MAG)
Copyright: (C) 2026 5G-MAG Association

For full license terms please see the LICENSE file distributed with this
program. If this file is missing then the license can be retrieved from
https://www.5g-mag.com/license
*/
const DVBIEpg = (() => {
  const NS = 'urn:tva:metadata:2024';

  function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function getText(node, localName, ns) {
    const el = node.getElementsByTagNameNS(ns || NS, localName)[0];
    return el ? el.textContent.trim() : '';
  }

  function parseISODuration(s) {
    if (!s) return 0;
    // Anchored; supports the day component and (leniently) either case. Weeks/months/years omitted
    // as they are not used for programme durations.
    const m = String(s).match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
    if (!m) return 0;
    return ((+m[1]||0) * 86400 + (+m[2]||0) * 3600 + (+m[3]||0) * 60 + (+m[4]||0)) * 1000;
  }

  function parseImage(pi, ns) {
    const _ns = ns || NS;
    for (const rm of pi.getElementsByTagNameNS(_ns, 'RelatedMaterial')) {
      const hr = rm.getElementsByTagNameNS(_ns, 'HowRelated')[0];
      if (hr) {
        const href = hr.getAttribute('href') || '';
        // Match spec promotional still (:19) or legacy (:1001), not service logo (:1001.2)
        if (/:19$/.test(href) || href.endsWith('/19') || /:1001$/.test(href) || href.endsWith('/1001')) {
          const mu = rm.getElementsByTagNameNS(_ns, 'MediaUri')[0];
          if (mu) return mu.textContent.trim();
        }
      }
    }
    return null;
  }

  // Every ParentalGuidance with an mpeg7:MinimumAge, with its CountryCodes (clause 6.10.15, table
  // 61), as [{ age, countries }]. A MinimumAge of 255 "signals that a Content Rating classification
  // scheme is required", which this client does not interpret; 255 then restricts at any threshold.
  function parseParentalRatings(pi) {
    const out = [];
    for (const pg of pi.getElementsByTagNameNS('*', 'ParentalGuidance')) {
      const age = pg.getElementsByTagNameNS('*', 'MinimumAge')[0];
      if (!age) continue;
      const n = parseInt(age.textContent.trim(), 10);
      if (isNaN(n)) continue;
      const cc = pg.getElementsByTagNameNS('*', 'CountryCodes')[0];
      out.push({ age: n, countries: cc ? cc.textContent.split(',').map(c => c.trim()).filter(Boolean) : [] });
    }
    return out;
  }

  // Structural groups of a now/next response (clause 6.5.4.4).
  const STRUCTURAL = {
    'crid://dvb.org/metadata/schedules/now-next/now': 'now',
    'crid://dvb.org/metadata/schedules/now-next/later': 'later',
    'crid://dvb.org/metadata/schedules/now-next/earlier': 'earlier',
  };

  function parseParentalAge(pi, ns) {
    const _ns = ns || NS;
    const pg  = pi.getElementsByTagNameNS(_ns, 'ParentalGuidance')[0];
    if (!pg) return null;
    // mpeg7:MinimumAge per TS 103 770 §6.10.15; namespace-agnostic via getElementsByTagName
    const age = pg.getElementsByTagName('MinimumAge')[0];
    if (age) return parseInt(age.textContent.trim(), 10) || null;
    const pr  = pg.getElementsByTagNameNS(_ns, 'ParentalRating')[0];
    if (pr) return pr.textContent.trim() || null;
    return null;
  }

  function parseTVA(doc) {
    // Detect TVA namespace from document root — supports 2010, 2019, 2024
    const _rootNs = doc.documentElement?.namespaceURI || '';
    const ns = _rootNs.startsWith('urn:tva:metadata:') ? _rootNs : NS;

    // Build series title map from GroupInformationTable (TS 103 770 §6.10.17)
    const seriesMap = {};
    for (const gi of doc.getElementsByTagNameNS(ns, 'GroupInformation')) {
      const gid   = gi.getAttribute('groupId');
      const title = getText(gi, 'Title', ns);
      if (gid) seriesMap[gid] = title;
    }

    const info = {};
    for (const pi of doc.getElementsByTagNameNS(ns, 'ProgramInformation')) {
      const bd = pi.getElementsByTagNameNS(ns, 'BasicDescription')[0] || pi;
      const genreEl = bd.getElementsByTagNameNS(ns, 'Genre')[0];
      let genre = null;
      if (genreEl) {
        const gn = genreEl.getElementsByTagNameNS(ns, 'Name')[0];
        genre = gn ? gn.textContent.trim().toLowerCase() : (genreEl.getAttribute('href') || '').split(':').pop().toLowerCase() || null;
      }

      // MemberOf is a child of ProgramInformation (clause 6.10.4); older lists put it in
      // BasicDescription. A structural now/next group gives the position (clause 6.5.4.4); any other
      // group is the series (clause 6.10.17); fall back to flat elements for old XML.
      let seriesNumber = null, episodeNumber = null, seriesTitle = null, structural = null, structuralIndex = null;
      const memberOfs = [...pi.children].filter(c => c.localName === 'MemberOf');
      if (!memberOfs.length) memberOfs.push(...bd.getElementsByTagNameNS(ns, 'MemberOf'));
      const posEl = memberOfs.find(m => STRUCTURAL[m.getAttribute('crid')]);
      if (posEl) {
        structural = STRUCTURAL[posEl.getAttribute('crid')];
        structuralIndex = parseInt(posEl.getAttribute('index') || '1', 10) || 1;
      }
      const memberOf = memberOfs.find(m => !STRUCTURAL[m.getAttribute('crid')]);
      if (memberOf) {
        const crid   = memberOf.getAttribute('crid') || '';
        episodeNumber = memberOf.getAttribute('index') || null;
        const rawTitle = crid ? (seriesMap[crid] || null) : null;
        if (rawTitle) {
          const seasonMatch = rawTitle.match(/^(.*?) \(Season (\d+)\)$/);
          if (seasonMatch) { seriesTitle = seasonMatch[1]; seriesNumber = seasonMatch[2]; }
          else { seriesTitle = rawTitle; }
        }
      } else {
        seriesNumber  = getText(bd, 'SeriesNumber', ns)  || null;
        episodeNumber = getText(bd, 'EpisodeNumber', ns) || null;
        seriesTitle   = getText(bd, 'SeriesTitle', ns)   || null;
      }

      info[pi.getAttribute('programId')] = {
        title:         getText(pi, 'Title', ns),
        synopsis:      getText(pi, 'Synopsis', ns),
        image:         parseImage(bd, ns),
        parentalAge:   parseParentalAge(bd, ns),
        parentalRatings: parseParentalRatings(bd),
        structural, structuralIndex,
        seriesNumber,
        episodeNumber,
        seriesTitle,
        genre,
      };
    }

    // OnDemandProgram (clause 6.10.8.2, table 52): ProgramURL is "A URL location of a content
    // deep-linked XML AIT for the on-demand programme. The XML AIT shall be used to launch the
    // on-demand player."; AuxiliaryURL the Template XML AIT; and the availability window.
    const onDemand = {};
    for (const od of doc.getElementsByTagNameNS(ns, 'OnDemandProgram')) {
      const crid = od.getElementsByTagNameNS(ns, 'Program')[0]?.getAttribute('crid') || '';
      const pu = od.getElementsByTagNameNS(ns, 'ProgramURL')[0];
      if (!crid || !pu) continue;
      const aux = od.getElementsByTagNameNS(ns, 'AuxiliaryURL')[0];
      onDemand[crid] = {
        crid,
        programUrl: pu.textContent.trim(),
        programUrlType: pu.getAttribute('contentType') || '',
        auxiliaryUrl: aux ? aux.textContent.trim() : '',
        start: getText(od, 'StartOfAvailability', ns),
        end: getText(od, 'EndOfAvailability', ns),
        serviceIDRef: od.getAttribute('serviceIDRef') || '',
      };
    }

    const events = [];

    function parseEvent(ev) {
      const crid   = ev.getElementsByTagNameNS(ns, 'Program')[0]?.getAttribute('crid') || '';
      // Prefer ActualStartTime/ActualEndTime when present (A184r2 §4.5); fall back to Published values
      const actualStart = getText(ev, 'ActualStartTime', ns);
      const actualEnd   = getText(ev, 'ActualEndTime', ns);
      const start = new Date(actualStart || getText(ev, 'PublishedStartTime', ns));
      let durMs = (actualStart && actualEnd)
        ? new Date(actualEnd).getTime() - start.getTime()
        : parseISODuration(getText(ev, 'PublishedDuration', ns));
      // Reversed actual times (end before start) yield a negative duration; fall back to
      // PublishedDuration before giving up so the invariant end > start always holds.
      if (!Number.isFinite(durMs) || durMs <= 0) durMs = parseISODuration(getText(ev, 'PublishedDuration', ns));
      if (isNaN(start.getTime()) || !durMs || durMs <= 0) return;
      const base = info[crid] || {};
      // Inline InstanceDescription fallback for BroadcastEvent
      const instDesc = ev.getElementsByTagNameNS(ns, 'InstanceDescription')[0];
      const title    = base.title    || (instDesc ? getText(instDesc, 'Title',    ns) : '') || 'Unknown';
      const synopsis = base.synopsis || (instDesc ? getText(instDesc, 'Synopsis', ns) : '');
      events.push({ ...base, crid, title, synopsis, start, end: new Date(start.getTime() + durMs), durMs, onDemand: onDemand[crid] || null });
    }

    for (const ev of doc.getElementsByTagNameNS(ns, 'ScheduleEvent'))   parseEvent(ev);
    for (const ev of doc.getElementsByTagNameNS(ns, 'BroadcastEvent'))  parseEvent(ev);

    // "When the GroupInformationTable is provided in a response, the order of previous, present and
    // future programs shall be determined by the structural CRIDs" (clause 6.5.4.1): earlier events
    // count back from the current one, later ones forward. Otherwise by start time.
    const rank = e => e.structural === 'earlier' ? -e.structuralIndex : e.structural === 'now' ? 0
      : e.structural === 'later' ? e.structuralIndex : null;
    const structured = events.some(e => e.structural);
    events.sort((a, b) => structured && rank(a) != null && rank(b) != null ? rank(a) - rank(b) : a.start - b.start);
    // Deduplicate by start time (BroadcastEvent may overlap ScheduleEvent)
    const seen = new Set();
    return events.filter(e => { const k = e.start.getTime(); return seen.has(k) ? false : (seen.add(k), true); });
  }

  // Results of More Episodes and Box Set requests (clauses 6.7.3, 6.8.2.3, 6.8.3.3, 6.8.4.3):
  // programmes with their MemberOf@index and on-demand entry, groups with their Template XML AIT,
  // and the pagination links of table 40 ("the presence of these links shall be used to determine
  // whether there are further pages of results available").
  const PAGINATION = 'urn:fvc:metadata:cs:HowRelatedCS:2015-12:pagination:';
  const TEMPLATE_AIT = 'urn:fvc:metadata:cs:HowRelatedCS:2018:templateAIT';
  function parseResults(doc) {
    const rootNs = doc.documentElement?.namespaceURI || '';
    const ns = rootNs.startsWith('urn:tva:metadata:') ? rootNs : NS;
    const onDemand = {};
    for (const od of doc.getElementsByTagNameNS(ns, 'OnDemandProgram')) {
      const crid = od.getElementsByTagNameNS(ns, 'Program')[0]?.getAttribute('crid') || '';
      const pu = od.getElementsByTagNameNS(ns, 'ProgramURL')[0];
      const aux = od.getElementsByTagNameNS(ns, 'AuxiliaryURL')[0];
      if (crid && pu) onDemand[crid] = { crid, programUrl: pu.textContent.trim(), programUrlType: pu.getAttribute('contentType') || '',
        auxiliaryUrl: aux ? aux.textContent.trim() : '', start: getText(od, 'StartOfAvailability', ns), end: getText(od, 'EndOfAvailability', ns),
        serviceIDRef: od.getAttribute('serviceIDRef') || '' };
    }
    const items = [...doc.getElementsByTagNameNS(ns, 'ProgramInformation')].map(pi => {
      const id = pi.getAttribute('programId') || '';
      const bd = pi.getElementsByTagNameNS(ns, 'BasicDescription')[0] || pi;
      const titles = [...bd.getElementsByTagNameNS(ns, 'Title')];
      const memberOf = [...pi.children].find(c => c.localName === 'MemberOf');
      return {
        programId: id,
        title: (titles.find(t => (t.getAttribute('type') || 'main') === 'main') || titles[0])?.textContent.trim() || id,
        subtitle: titles.find(t => t.getAttribute('type') === 'secondary')?.textContent.trim() || '',
        synopsis: getText(bd, 'Synopsis', ns),
        image: parseImage(bd, ns),
        parentalRatings: parseParentalRatings(bd),
        index: memberOf ? parseInt(memberOf.getAttribute('index') || '', 10) : null,
        onDemand: onDemand[id] || null,
      };
    });
    const links = {};
    const groups = [];
    for (const gi of doc.getElementsByTagNameNS(ns, 'GroupInformation')) {
      let templateAit = '';
      for (const rm of gi.getElementsByTagNameNS(ns, 'RelatedMaterial')) {
        const href = rm.getElementsByTagNameNS(ns, 'HowRelated')[0]?.getAttribute('href') || '';
        const uri = (rm.getElementsByTagNameNS(ns, 'MediaUri')[0]?.textContent || '').trim().replace(/\s+/g, '');
        if (href.startsWith(PAGINATION) && uri) links[href.slice(PAGINATION.length)] = uri;
        if (href === TEMPLATE_AIT) templateAit = (rm.getElementsByTagNameNS(ns, 'AuxiliaryURI')[0]?.textContent || '').trim();
      }
      const bd = gi.getElementsByTagNameNS(ns, 'BasicDescription')[0] || gi;
      groups.push({ groupId: gi.getAttribute('groupId') || '', title: getText(bd, 'Title', ns), image: parseImage(bd, ns), templateAit,
        numOfItems: gi.getAttribute('numOfItems') });
    }
    return { items, groups, links };
  }

  // Requests go through `client`, a DVBIHttp client (dvbi-http.js), which applies the caching and
  // retry rules of TS 103 770 V1.2.1 clause 4.3 that clauses 6.2.3 and 6.2.4 refer to. URLs are
  // built by DVBIGuide (guide.js) from the raw endpoint of the service list; the client resolves
  // them (same origin or proxy) afterwards. Each loader resolves to { events | info | results,
  // result, url } with the client's answer for the failing (or last) request.
  async function fetchDoc(url, client) {
    const result = await client.get(url, { timeoutMs: 10000 });
    if (!result.ok) return { doc: null, result, url };
    const doc = new DOMParser().parseFromString(result.body, 'application/xml');
    return { doc: doc.querySelector('parsererror') ? null : doc, result, url };
  }

  // Schedule for [fromMs, toMs], as 12-hour windows on 3-hour boundaries (clause 6.5.2.1), combined.
  async function loadSchedule(endpoint, sid, client, fromMs, toMs) {
    if (!endpoint) return { events: null, result: null, url: null };
    const all = [];
    let last = { result: null, url: null };
    for (const win of DVBIGuide.scheduleWindows(fromMs, toMs)) {
      const r = await fetchDoc(DVBIGuide.scheduleUrl(endpoint, sid, win), client);
      last = r;
      if (!r.doc) return { events: null, result: r.result, url: r.url };
      all.push(...parseTVA(r.doc));
    }
    const seen = new Set();
    const events = all.sort((a, b) => a.start - b.start)
      .filter(e => { const k = e.start.getTime(); return seen.has(k) ? false : (seen.add(k), true); });
    return { events, result: last.result, url: last.url };
  }

  // Now/next (clause 6.5.3.1), now_next=true or window.
  async function loadNowNext(endpoint, sid, client, windowType = 'true') {
    if (!endpoint) return { events: null, result: null, url: null };
    const r = await fetchDoc(DVBIGuide.nowNextUrl(endpoint, sid, windowType), client);
    return { events: r.doc ? parseTVA(r.doc) : null, result: r.result, url: r.url };
  }

  // Programme information by CRID (clause 6.6.2): the ProgramInformation of that programme.
  async function loadProgram(endpoint, pid, client) {
    if (!endpoint || !pid) return { info: null, result: null, url: null };
    const r = await fetchDoc(DVBIGuide.programUrl(endpoint, pid), client);
    if (!r.doc) return { info: null, result: r.result, url: r.url };
    const { items } = parseResults(r.doc);
    const pi = items.find(i => i.programId === pid) || null;
    if (pi) {
      const long = [...r.doc.getElementsByTagNameNS('*', 'Synopsis')].find(s => s.getAttribute('length') === 'long');
      if (long) pi.synopsis = long.textContent.trim();
    }
    return { info: pi, result: r.result, url: r.url };
  }

  // A page of More Episodes or Box Set results, from a URL built by DVBIGuide or a pagination link
  // used "without modification" (clause 6.9).
  async function loadResults(url, client) {
    const r = await fetchDoc(url, client);
    return { results: r.doc ? parseResults(r.doc) : null, result: r.result, url };
  }

  function getNowNext(events) {
    // A now/next response says which event is on air (clause 6.5.4.4).
    const onAir = events.find(e => e.structural === 'now');
    if (onAir) return { current: onAir, next: events.find(e => e.structural === 'later' && e.structuralIndex === 1) || null };
    const now = new Date();
    for (let i = 0; i < events.length; i++) {
      if (events[i].start <= now && events[i].end > now) return { current: events[i], next: events[i+1] || null };
    }
    // No programme on air (a gap, or all events past/future): "next" is the first UPCOMING
    // event, not events[0] (which would be a stale finished programme during a gap).
    return { current: null, next: events.find(e => e.start > now) || null };
  }

  function fmt(d) { return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

  // ── Now / Next strip ────────────────────────────────────────────

  function render(stripEl, serviceName, events) {
    if (!events || !events.length) {
      stripEl.innerHTML = `<div class="epg-label">EPG · ${esc(serviceName)} <span class="epg-hint">· Press E for full schedule</span></div><div class="epg-empty">No EPG data available</div>`;
      return;
    }
    const { current, next } = getNowNext(events);
    const now = Date.now();

    function card(item, cls, badge) {
      if (!item) return `<div class="epg-card ${cls}"><div class="epg-badge">${badge}</div><div class="epg-empty" style="flex:1">No data</div></div>`;
      const progress = cls === 'epg-now' ? Math.min(100, ((now - item.start) / item.durMs) * 100) : 0;
      const totalMin = Math.round(item.durMs / 60000);
      const remMin   = cls === 'epg-now' ? Math.max(0, Math.round((item.end - now) / 60000)) : null;
      const meta     = cls === 'epg-now'
        ? `${fmt(item.start)} · ${totalMin} min · <strong>${remMin} min remaining</strong>`
        : `${fmt(item.start)} · ${totalMin} min`;
      return `
      <div class="epg-card ${cls}">
        <div class="epg-badge">${badge}</div>
        <div class="epg-title">${esc(item.title)}</div>
        <div class="epg-meta">${meta}</div>
        <div class="epg-bar"><div class="epg-fill" style="width:${progress.toFixed(1)}%"></div></div>
        ${item.synopsis ? `<div class="epg-synopsis">${esc(item.synopsis)}</div>` : ''}
      </div>`;
    }

    stripEl.innerHTML = `
      <div class="epg-label">EPG · ${esc(serviceName)} <span class="epg-hint">· Click or press E for full schedule</span></div>
      <div class="epg-cards">
        ${card(current, 'epg-now', 'NOW')}
        ${card(next,    'epg-next', 'NEXT')}
      </div>`;

    stripEl.querySelectorAll('.epg-card').forEach(el => {
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => { if (typeof openEPGPanel === 'function') openEPGPanel(); });
    });
  }

  // ── Full schedule panel ─────────────────────────────────────────

  function renderFull(scheduleEl, detailEl, events) {
    const now = new Date();
    scheduleEl.innerHTML = '';
    if (!events.length) {
      scheduleEl.innerHTML = '<div class="epg-no-match">No programmes match this genre.</div>';
      detailEl.innerHTML = '<div class="epg-detail-empty">Select a programme</div>';
      return;
    }
    let nowIdx = -1;

    events.forEach((ev, i) => {
      const isNow  = ev.start <= now && ev.end > now;
      const isPast = ev.end <= now;
      if (isNow) nowIdx = i;

      const progress = isNow ? Math.min(100, ((now - ev.start) / ev.durMs) * 100) : (isPast ? 100 : 0);
      const totalMin = Math.round(ev.durMs / 60000);

      const el = document.createElement('div');
      el.className = `epg-event${isNow ? ' now' : ''}${isPast ? ' past' : ''}`;
      el.dataset.idx = i;
      el.setAttribute('role', 'option');
      el.setAttribute('aria-selected', 'false');
      el.setAttribute('tabindex', '0');
      el.setAttribute('aria-label', `${fmt(ev.start)} ${esc(ev.title)}, ${totalMin} min${isNow ? ', live now' : ''}`);
      el.innerHTML = `
        <span class="epg-event-time">${fmt(ev.start)}</span>
        <div class="epg-event-bar"><div class="epg-event-bar-fill" style="width:${progress.toFixed(0)}%"></div></div>
        <div class="epg-event-info">
          <div class="epg-event-title">${esc(ev.title)}</div>
          <div class="epg-event-dur">${totalMin} min</div>
        </div>
        ${isNow ? '<span class="epg-event-now-badge">NOW</span>' : ''}`;

      el.addEventListener('click', () => selectEvent(i, events, scheduleEl, detailEl));
      el.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectEvent(i, events, scheduleEl, detailEl); } });
      scheduleEl.appendChild(el);
    });

    const startIdx = nowIdx >= 0 ? nowIdx : 0;
    selectEvent(startIdx, events, scheduleEl, detailEl);
    setTimeout(() => scheduleEl.children[startIdx]?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 40);
  }

  function selectEvent(idx, events, scheduleEl, detailEl) {
    scheduleEl.querySelectorAll('.epg-event').forEach(el => {
      el.classList.remove('selected');
      el.setAttribute('aria-selected', 'false');
    });
    const sel = scheduleEl.children[idx];
    if (sel) { sel.classList.add('selected'); sel.setAttribute('aria-selected', 'true'); }

    const ev = events[idx];
    if (!ev) return;
    const now      = new Date();
    const totalMin = Math.round(ev.durMs / 60000);
    const isNow    = ev.start <= now && ev.end > now;
    const remMin   = isNow ? Math.max(0, Math.round((ev.end - now) / 60000)) : null;

    let episodeStr = '';
    if (ev.seriesNumber || ev.episodeNumber) {
      const s = ev.seriesNumber ? `S${ev.seriesNumber}` : '';
      const e = ev.episodeNumber ? `E${ev.episodeNumber}` : '';
      episodeStr = `<span class="epg-episode-tag">${s}${e}</span>`;
    }
    if (ev.seriesTitle) {
      episodeStr += ` <span class="epg-series-title">${esc(ev.seriesTitle)}</span>`;
    }

    const pgBadge = ev.parentalAge
      ? `<span class="epg-pg-badge">${esc(String(ev.parentalAge))}${typeof ev.parentalAge === 'number' ? '+' : ''}</span>`
      : '';

    detailEl.innerHTML = `
      ${ev.image ? `<div class="epg-detail-img-wrap"><img class="epg-detail-img" src="${esc(ev.image)}" alt="" onerror="this.parentElement.style.display='none'"/></div>` : ''}
      <div class="epg-detail-title">${esc(ev.title)}</div>
      ${episodeStr ? `<div class="epg-detail-episode">${episodeStr}</div>` : ''}
      <div class="epg-detail-time">${fmt(ev.start)} – ${fmt(ev.end)}</div>
      <div class="epg-detail-meta">
        ${isNow ? '<span class="epg-now-badge">LIVE NOW</span>' : ''}
        ${pgBadge}
        ${totalMin} min${isNow ? ` &nbsp;·&nbsp; ${remMin} min left` : ''}
      </div>
      ${ev.synopsis ? `<div class="epg-detail-synopsis">${esc(ev.synopsis)}</div>` : ''}
      ${ev.onDemandOk && ev.end <= new Date() ? `<button class="catchup-btn" onclick="playOnDemand(${esc(JSON.stringify(ev.crid))})">▶ Watch again</button>` : ''}
      ${typeof moreEpisodesAvailable === 'function' && moreEpisodesAvailable() && ev.crid ? `<button class="catchup-btn" onclick="openMoreEpisodes(${esc(JSON.stringify(ev.crid))})">More episodes</button>` : ''}`;
    // Detailed programme information on request (clause 6.6.2), where the app provides it.
    if (typeof onEventSelected === 'function') onEventSelected(ev, detailEl);
  }

  function getGenres(events) {
    return [...new Set(events.map(e => e.genre).filter(Boolean))];
  }

  // ── EPG Grid (multi-channel timeline) ───────────────────────────

  function renderGrid(containerEl, services, epgCache, onSelectService, onSelectEvent) {
    const now      = new Date();
    const WIN_MINS = 180;
    const PRE_MINS = 30;
    const PX_MIN   = 3;
    const totalW   = WIN_MINS * PX_MIN;
    const winStart = new Date(now.getTime() - PRE_MINS * 60000);
    const winEnd   = new Date(winStart.getTime() + WIN_MINS * 60000);

    function toX(d) { return (d.getTime() - winStart.getTime()) / 60000 * PX_MIN; }

    let ticksHtml = '';
    const t0 = new Date(winStart);
    t0.setMinutes(Math.ceil(t0.getMinutes() / 30) * 30, 0, 0);
    for (let t = new Date(t0); t <= winEnd; t = new Date(t.getTime() + 30 * 60000)) {
      ticksHtml += `<div class="epg-grid-tick" style="left:${toX(t).toFixed(0)}px">${fmt(t)}</div>`;
    }

    const nowX = toX(now);

    const rowsHtml = services.map(svc => {
      const events = epgCache[svc.uid] || [];
      const progsHtml = events.filter(ev => ev.end > winStart && ev.start < winEnd).map(ev => {
        const x = Math.max(0, toX(ev.start));
        const w = Math.min(totalW, toX(ev.end)) - x;
        if (w < 2) return '';
        const isNow = ev.start <= now && ev.end > now;
        return `<div class="epg-grid-prog${isNow ? ' now' : ''}" style="left:${x.toFixed(0)}px;width:${(w - 1).toFixed(0)}px" ` +
          `data-title="${esc(ev.title)}" data-time="${fmt(ev.start)}–${fmt(ev.end)}" data-crid="${esc(ev.onDemandOk && ev.end <= now ? ev.crid : '')}">` +
          `<span class="epg-grid-prog-label">${esc(ev.title)}</span></div>`;
      }).join('');

      const logo = svc.logo
        ? `<img class="epg-grid-logo" src="${esc(svc.logo)}" alt="" loading="lazy" onerror="this.style.display='none'"/>`
        : '';
      const noData = !progsHtml
        ? `<span class="epg-grid-nodata">No EPG data</span>` : '';
      return `<div class="epg-grid-row">` +
        `<div class="epg-grid-ch" data-uid="${esc(svc.uid)}">${logo}` +
        `<span class="epg-grid-chname">${esc(svc.name)}</span></div>` +
        `<div class="epg-grid-progs" style="width:${totalW}px">${progsHtml}${noData}` +
        (nowX > 0 && nowX < totalW ? `<div class="epg-grid-nowline" style="left:${nowX.toFixed(0)}px"></div>` : '') +
        `</div></div>`;
    }).join('');

    containerEl.innerHTML =
      `<div class="epg-grid-timebar">` +
      `<div class="epg-grid-ch epg-grid-ch-head"></div>` +
      `<div class="epg-grid-ticks" style="width:${totalW}px">${ticksHtml}</div></div>` +
      rowsHtml;

    containerEl.querySelectorAll('.epg-grid-ch[data-uid]').forEach(el => {
      el.addEventListener('click', () => onSelectService && onSelectService(el.dataset.uid));
    });
    containerEl.querySelectorAll('.epg-grid-prog').forEach(el => {
      el.addEventListener('click', ev => {
        ev.stopPropagation();
        containerEl.querySelectorAll('.epg-grid-prog.sel').forEach(s => s.classList.remove('sel'));
        el.classList.add('sel');
        if (onSelectEvent) onSelectEvent({ title: el.dataset.title, time: el.dataset.time, onDemandCrid: el.dataset.crid || '' });
      });
    });

    if (nowX > 0) {
      setTimeout(() => {
        const scroll = containerEl.parentElement;
        if (scroll) scroll.scrollLeft = Math.max(0, nowX - 80);
      }, 30);
    }
  }

  return { loadSchedule, loadNowNext, loadProgram, loadResults, parseTVA, parseResults, getNowNext, render, renderFull, getGenres, renderGrid, parseISODuration };
})();

// Exposed for Node-based unit tests (test/epg.test.js). `module` is undefined when loaded via a
// <script> tag in the browser, so this is a no-op there.
if (typeof module !== 'undefined' && module.exports) module.exports = DVBIEpg;
