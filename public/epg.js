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

      // Series/episode from MemberOf (TS 103 770 §6.10.17); fall back to flat elements for old XML
      let seriesNumber = null, episodeNumber = null, seriesTitle = null;
      const memberOf = bd.getElementsByTagNameNS(ns, 'MemberOf')[0];
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
        seriesNumber,
        episodeNumber,
        seriesTitle,
        genre,
      };
    }

    // Catch-up: OnDemandProgram — check ProgramURL (TS 103 770 §6.10.8.2) with locationURL as fallback
    const catchup = {};
    for (const od of doc.getElementsByTagNameNS(ns, 'OnDemandProgram')) {
      const crid = od.getElementsByTagNameNS(ns, 'Program')[0]?.getAttribute('crid') || '';
      const url  = getText(od, 'ProgramURL', ns) || od.getAttribute('locationURL') || getText(od, 'locationURL', ns);
      if (crid && url) catchup[crid] = url;
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
      const catchupUrl = catchup[crid] || null;
      const base = info[crid] || {};
      // Inline InstanceDescription fallback for BroadcastEvent
      const instDesc = ev.getElementsByTagNameNS(ns, 'InstanceDescription')[0];
      const title    = base.title    || (instDesc ? getText(instDesc, 'Title',    ns) : '') || 'Unknown';
      const synopsis = base.synopsis || (instDesc ? getText(instDesc, 'Synopsis', ns) : '');
      events.push({ ...base, title, synopsis, start, end: new Date(start.getTime() + durMs), durMs, catchupUrl });
    }

    for (const ev of doc.getElementsByTagNameNS(ns, 'ScheduleEvent'))   parseEvent(ev);
    for (const ev of doc.getElementsByTagNameNS(ns, 'BroadcastEvent'))  parseEvent(ev);

    events.sort((a, b) => a.start - b.start);
    // Deduplicate by start time (BroadcastEvent may overlap ScheduleEvent)
    const seen = new Set();
    return events.filter(e => { const k = e.start.getTime(); return seen.has(k) ? false : (seen.add(k), true); });
  }

  // `endpoint` must be the RAW absolute URL straight from the service list XML (no proxy-wrapping
  // yet). Query params are appended to that absolute URL first, and only the FULLY-QUALIFIED
  // target URL is passed through resolveUrl() (app.js) for the same-origin/proxy decision.
  // Resolving first and appending params after (the old order) breaks the proxy case: resolveUrl()
  // returns a relative "/proxy?url=..." string for cross-origin endpoints, which (a) fails the old
  // http(s)-only guard below outright, and (b) even if allowed through, appending "?sid=..." to an
  // already-`?url=`-bearing string puts those params on the /proxy request itself, not on the
  // target URL — the receiver's own /proxy handler only forwards its `url` param, so sid/start/end
  // would be silently dropped even if the guard let the request through.
  async function load(endpoint, serviceId) {
    if (!endpoint) return null;
    // sid is the spec-compliant parameter (TS 103 770 §6.5.2.2); serviceId kept for backward compat
    const now = Math.floor(Date.now() / 1000);
    const params = new URLSearchParams({ sid: serviceId, serviceId, start: String(now - 3600), end: String(now + 12 * 3600) });
    const fullUrl = `${endpoint}${endpoint.includes('?') ? '&' : '?'}${params.toString()}`;
    const target = typeof resolveUrl === 'function' ? resolveUrl(fullUrl) : fullUrl;
    const res = await fetch(target, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const doc = new DOMParser().parseFromString(await res.text(), 'application/xml');
    if (doc.querySelector('parsererror')) return null;
    return parseTVA(doc);
  }

  function getNowNext(events) {
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
      ${ev.catchupUrl && ev.end <= new Date() ? `<button class="catchup-btn" onclick="playCatchup(${esc(JSON.stringify(ev.catchupUrl))})">▶ Watch again</button>` : ''}`;
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
          `data-title="${esc(ev.title)}" data-time="${fmt(ev.start)}–${fmt(ev.end)}" data-catchup="${esc(ev.catchupUrl || '')}">` +
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
        if (onSelectEvent) onSelectEvent({ title: el.dataset.title, time: el.dataset.time, catchupUrl: el.dataset.catchup || '' });
      });
    });

    if (nowX > 0) {
      setTimeout(() => {
        const scroll = containerEl.parentElement;
        if (scroll) scroll.scrollLeft = Math.max(0, nowX - 80);
      }, 30);
    }
  }

  return { load, getNowNext, render, renderFull, getGenres, renderGrid, parseISODuration };
})();

// Exposed for Node-based unit tests (test/epg.test.js). `module` is undefined when loaded via a
// <script> tag in the browser, so this is a no-op there.
if (typeof module !== 'undefined' && module.exports) module.exports = DVBIEpg;
