const NS     = 'urn:dvb:metadata:servicediscovery:2024';
const NS_TVA = 'urn:tva:metadata:2024';

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
const DEFAULT_URL   = 'https://localhost:4000/service-list.xml';
const DEFAULT_REGISTRY = 'https://slrdb.org/dvbi/provider-offerings';
const POLL_INTERVAL = 30000;

// ── State ─────────────────────────────────────────────────────────────────────

let services    = [];
let currentIdx  = -1;
let activeGenre = '';
let currentSession = 0;
let currentVersion = null;
// Migrate stale relative URL stored by earlier versions
(function migrateStoredUrl() {
  const stored = localStorage.getItem('dvbi-url');
  if (stored && (stored === '/service-list.xml' || stored.startsWith('/service-list'))) {
    localStorage.removeItem('dvbi-url');
  }
})();

let currentListUrl = localStorage.getItem('dvbi-url') || DEFAULT_URL;
let epgCache    = {};
let pollTimer   = null;
let epgTimer    = null;
let overlayTimer = null;
let lcnBuffer   = '';
let lcnTimer    = null;
let epgPanelOpen = false;
let epgGridOpen  = false;
let darkMode     = localStorage.getItem('dvbi-theme') !== 'light';

// Favourites (set of UIDs)
let favourites = new Set(JSON.parse(localStorage.getItem('dvbi-favs') || '[]'));

// Parental controls
let pgThreshold = parseInt(localStorage.getItem('dvbi-pg-threshold') || '0', 10) || 0;
let pgPin       = localStorage.getItem('dvbi-pg-pin') || '';
let pgUnlocked  = new Set(); // UIDs unlocked for this session

// EPG genre filter (inside full EPG panel)
let epgActiveGenre = '';

// Preferred audio language (BCP-47 prefix, e.g. 'en', 'fr')
let langPref = localStorage.getItem('dvbi-lang-pref') || '';

// Region filter
let regionFilter = localStorage.getItem('dvbi-region') || '';

// Catch-up state
let isCatchup = false;

// LCN tables stored for region-aware reassignment (A184r2 §4.8 Table 4.8-1)
let rawLCNTables = [];

// User-defined custom list — services saved from any loaded service list (A184r2 §4.7 Roaming)
let customList = JSON.parse(localStorage.getItem('dvbi-custom') || '[]');
let isCustomListActive = false;

// Services where the user has acknowledged the subscription gate for this session
let subGateAcked = new Set();

// Currently playing instance index (for subtitle carriage display)
let currentInstIdx = 0;

// CMCD session ID — generated once per client session (CTA-5004, A184r2 §4.1.6)
const CMCD_SESSION_ID = DVBIPlayer.generateSessionId();
DVBIPlayer.setCMCDSession(CMCD_SESSION_ID);

// ── DOM ───────────────────────────────────────────────────────────────────────

const $  = id => document.getElementById(id);
const videoEl          = $('video');
const listNameEl       = $('list-name');
const channelList      = $('channel-list');
const noService        = $('no-service');
const overlay          = $('player-overlay');
const overlayLcn       = $('overlay-lcn');
const overlayDlv       = $('overlay-delivery');
const overlayType      = $('overlay-type');
const overlayName      = $('overlay-name');
const overlayProv      = $('overlay-provider');
const overlayBitrate   = $('overlay-bitrate');
const epgStrip         = $('epg-strip');
const epgPanel         = $('epg-panel');
const epgPanelTitle    = $('epg-panel-title');
const epgSchedule      = $('epg-schedule');
const epgDetail        = $('epg-detail');
const lcnOverlay       = $('lcn-overlay');
const lcnOverlayNum    = $('lcn-overlay-num');
const settingsPanel    = $('settings-panel');
const settingsBtn      = $('settings-btn');
const urlInput         = $('url-input');
const versionRow       = $('version-row');
const clockEl          = $('clock');
const bufSpinner       = $('buf-spinner');
const playError        = $('play-error');
const playErrorMsg     = $('play-error-msg');
const playErrorRetry   = $('play-error-retry');
const muteBtn          = $('mute-btn');
const volBar           = $('vol-bar');
const volFill          = $('vol-fill');
const fsBtnEl          = $('fs-btn');
const shortcutsOverlay = $('shortcuts-overlay');
const searchInput  = $('search-input');
const genreBar     = $('genre-bar');
const tracksPanel  = $('tracks-panel');
const tracksAudio  = $('tracks-audio');
const tracksText   = $('tracks-text');
const tbName    = $('tb-name');
const tbLcn     = $('tb-lcn');
const tbMute    = $('tb-mute');
const tbVolBar  = $('tb-vol-bar');
const tbVolFill = $('tb-vol-fill');
const tbTracksBtn = $('tb-tracks-btn');
const tbAppBtn    = $('tb-app-btn');
const subGateEl   = $('sub-gate');
const seekLiveBadge = $('seek-live-badge');
const carriageNote  = $('tracks-carriage-note');
const tbEpgBtn  = $('tb-epg-btn');
const tbPipBtn  = $('tb-pip-btn');
const tbFsBtn   = $('tb-fs-btn');
const seekWrap  = $('seek-wrap');
const seekBar   = $('seek-bar');
const seekFill  = $('seek-fill');
const seekCurrent = $('seek-current');
const seekTotal = $('seek-total');
const epgGenreBar   = $('epg-genre-bar');
const pinModal      = $('pin-modal');
const tbNow         = $('tb-now');
const backToLiveBtn = $('back-to-live-btn');
const epgGridPanel  = $('epg-grid-panel');
const epgGridInner  = $('epg-grid-inner');
const epgGridInfo   = $('epg-grid-info');
const tbGridBtn     = $('tb-grid-btn');
const tbShareBtn    = $('tb-share-btn');
const themeBtn      = $('theme-btn');

// ── Theme ─────────────────────────────────────────────────────────────────────

if (!darkMode) document.body.classList.add('light');
themeBtn.textContent = darkMode ? '☀' : '☽';

function toggleTheme() {
  darkMode = !darkMode;
  document.body.classList.toggle('light', !darkMode);
  localStorage.setItem('dvbi-theme', darkMode ? 'dark' : 'light');
  themeBtn.textContent = darkMode ? '☀' : '☽';
}
themeBtn.addEventListener('click', toggleTheme);

// ── Clock ─────────────────────────────────────────────────────────────────────

function tickClock() {
  clockEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
tickClock();
setInterval(tickClock, 1000);

// ── Volume & mute ─────────────────────────────────────────────────────────────

function updateVolumeUI() {
  const muted = videoEl.muted || videoEl.volume === 0;
  const pct   = muted ? '0%' : `${Math.round(videoEl.volume * 100)}%`;
  volFill.style.width   = pct;
  tbVolFill.style.width = pct;
  muteBtn.classList.toggle('muted', videoEl.muted);
  tbMute.classList.toggle('muted', videoEl.muted);
}

// Restore persisted volume
const _savedVol   = localStorage.getItem('dvbi-vol');
const _savedMuted = localStorage.getItem('dvbi-muted');
if (_savedVol   !== null) videoEl.volume = parseFloat(_savedVol);
if (_savedMuted === 'true') videoEl.muted = true;

updateVolumeUI();
videoEl.addEventListener('volumechange', () => {
  updateVolumeUI();
  localStorage.setItem('dvbi-vol',   String(videoEl.volume));
  localStorage.setItem('dvbi-muted', String(videoEl.muted));
});

muteBtn.addEventListener('click', () => { videoEl.muted = !videoEl.muted; });
tbMute.addEventListener('click',  () => { videoEl.muted = !videoEl.muted; });

function setVolumeFromClick(bar, e) {
  const rect = bar.getBoundingClientRect();
  videoEl.volume = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  videoEl.muted = false;
}
volBar.addEventListener('click',   e => setVolumeFromClick(volBar,   e));
tbVolBar.addEventListener('click', e => setVolumeFromClick(tbVolBar, e));

$('player-wrap').addEventListener('wheel', e => {
  e.preventDefault();
  videoEl.volume = Math.max(0, Math.min(1, videoEl.volume + (e.deltaY < 0 ? 0.05 : -0.05)));
  videoEl.muted = false;
  showOverlayBriefly();
}, { passive: false });

function toggleFullscreen() {
  document.fullscreenElement
    ? document.exitFullscreen()
    : $('player-wrap').requestFullscreen();
}
fsBtnEl.addEventListener('click',  toggleFullscreen);
tbFsBtn.addEventListener('click',  toggleFullscreen);

async function togglePiP() {
  if (!document.pictureInPictureEnabled) {
    showVersionNotice('Picture-in-Picture is not available in this browser');
    return;
  }
  if (currentIdx < 0 || videoEl.readyState < 1) {
    showVersionNotice('Select a playing channel to use Picture-in-Picture');
    return;
  }
  try {
    document.pictureInPictureElement
      ? await document.exitPictureInPicture()
      : await videoEl.requestPictureInPicture();
  } catch (e) {
    console.warn('PiP error:', e);
    showVersionNotice('Picture-in-Picture unavailable for this stream');
  }
}
tbPipBtn.addEventListener('click', togglePiP);

document.addEventListener('enterpictureinpicture', () => tbPipBtn.classList.add('active'));
document.addEventListener('leavepictureinpicture', () => tbPipBtn.classList.remove('active'));

// ── Player click to toggle overlay ───────────────────────────────────────────

$('player-wrap').addEventListener('click', e => {
  if (e.target.closest('.ctrl-btn') || e.target.closest('#vol-bar')) return;
  if (currentIdx < 0) return;
  if (overlay.classList.contains('visible')) {
    overlay.classList.remove('visible');
    clearTimeout(overlayTimer);
  } else {
    showOverlayBriefly(4500);
  }
});

function showOverlayBriefly(ms = 2500) {
  overlay.classList.add('visible');
  clearTimeout(overlayTimer);
  overlayTimer = setTimeout(() => overlay.classList.remove('visible'), ms);
}

$('player-wrap').addEventListener('mousemove', () => {
  if (currentIdx < 0) return;
  showOverlayBriefly();
});

// ── Bitrate polling ───────────────────────────────────────────────────────────

function formatBitrate(bps) {
  if (!bps) return '';
  return bps > 1e6 ? `${(bps / 1e6).toFixed(1)} Mbps` : `${Math.round(bps / 1000)} kbps`;
}

setInterval(() => {
  if (currentIdx < 0) { overlayBitrate.textContent = ''; return; }
  overlayBitrate.textContent = formatBitrate(DVBIPlayer.getBitrate());
}, 2500);

// ── Seek bar (VOD) ────────────────────────────────────────────────────────────

function fmtTime(s) {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

videoEl.addEventListener('durationchange', () => {
  const live      = !isFinite(videoEl.duration);
  const timeshift = DVBIPlayer.isLiveTimeshift();
  // Show seek bar for VOD (finite duration) or live with DVR window (A184r2 §4.1.5)
  seekWrap.hidden = live && !timeshift;
  seekLiveBadge.hidden = !timeshift;
  seekTotal.textContent = (live || timeshift) ? '' : fmtTime(videoEl.duration);
});

videoEl.addEventListener('timeupdate', () => {
  const timeshift = DVBIPlayer.isLiveTimeshift();
  if (timeshift) {
    // For DVR streams show offset from current live point
    const seekable = videoEl.seekable;
    if (seekable.length) {
      const winEnd   = seekable.end(0);
      const winStart = seekable.start(0);
      const winSize  = winEnd - winStart;
      const pos      = videoEl.currentTime - winStart;
      seekFill.style.width = `${Math.min(100, (pos / winSize) * 100).toFixed(2)}%`;
      seekCurrent.textContent = `-${fmtTime(Math.max(0, winEnd - videoEl.currentTime))}`;
    }
    return;
  }
  if (!isFinite(videoEl.duration) || videoEl.duration === 0) return;
  const pct = (videoEl.currentTime / videoEl.duration) * 100;
  seekFill.style.width = `${pct.toFixed(2)}%`;
  seekCurrent.textContent = fmtTime(videoEl.currentTime);
});

seekBar.addEventListener('click', e => {
  const rect = seekBar.getBoundingClientRect();
  const frac = (e.clientX - rect.left) / rect.width;
  if (DVBIPlayer.isLiveTimeshift()) {
    const seekable = videoEl.seekable;
    if (seekable.length) {
      videoEl.currentTime = seekable.start(0) + frac * (seekable.end(0) - seekable.start(0));
    }
  } else {
    if (!isFinite(videoEl.duration)) return;
    videoEl.currentTime = frac * videoEl.duration;
  }
});

// ── XML helpers ───────────────────────────────────────────────────────────────

function getNS(node, localName, ns = NS) {
  const el = node.getElementsByTagNameNS(ns, localName)[0];
  return el ? el.textContent.trim() : '';
}

// URI is declared in the servicediscovery-types namespace (emitted as dvbisd-t:URI), but older
// lists put it in the main namespace. Match by localName in ANY namespace so both parse.
function uriText(node) {
  const el = node && node.getElementsByTagNameNS('*', 'URI')[0];
  return el ? el.textContent.trim() : '';
}

// Plain http:// always goes through the proxy, even on this page's own origin: TS 103 770 V1.2.1
// clause 7.3 permits HTTP without TLS only to an endpoint on the same private subnet, and only the
// server can see which subnet it is on (server.js, assertTlsOrSameSubnet).
function resolveUrl(url) {
  if (!url) return url;
  try {
    const u = new URL(url, window.location.href);
    if (u.origin === window.location.origin && u.protocol === 'https:') return url; // same-origin over TLS: no proxy needed
    // Forward the resolved ABSOLUTE url (u.href), not the raw string, so protocol-relative //host/x
    // and bare relative paths reach the proxy as an absolute http(s) URL its new URL() can parse.
    return `/proxy?url=${encodeURIComponent(u.href)}`;
  } catch { return url; }
}

// One HTTP client for every request to a DVB-I endpoint (service lists, the registry, the content
// guide), so caching, conditional requests and retry rules of clause 4.3 apply to all of them.
const dvbiHttp = DVBIHttp.createClient({ fetch: (...args) => fetch(...args), resolve: resolveUrl });

// The text of a failed response, for the message shown to the user: the proxy explains a refusal
// (for example an http:// endpoint outside the private subnet, clause 7.3) in a JSON body.
function failureText(r) {
  if (r.status === 0) return r.error || 'connection failed';
  let why = '';
  try { why = /json/.test(r.contentType || '') ? (JSON.parse(r.body).error || '') : ''; } catch (_) { /* not JSON */ }
  return `HTTP ${r.status}${why ? `: ${why}` : ''}`;
}

// ── LCN region-aware assignment (A184r2 §4.8, Table 4.8-1) ───────────────────

function buildLCNMap(tables, svcs, region) {
  const regionUpper = (region || '').toUpperCase();
  const OVERFLOW_BASE = 800;
  let overflowNext = OVERFLOW_BASE;
  const map = {};

  // Tables whose TargetRegion matches the selected region
  const matchingTables = regionUpper
    ? tables.filter(t => t.targetRegion && t.targetRegion.toUpperCase().startsWith(regionUpper))
    : [];
  // Tables with no TargetRegion (apply globally)
  const globalTables = tables.filter(t => !t.targetRegion);

  for (const svc of svcs) {
    const svcRegionUpper = (svc.targetRegion || '').toUpperCase();
    const svcMatchesRegion = !svc.targetRegion || !regionUpper
      || svcRegionUpper === regionUpper || svcRegionUpper.startsWith(regionUpper);

    // Look up service in region-matching tables first
    let found = null;
    for (const tbl of matchingTables) {
      if (tbl.entries[svc.uid] != null) { found = tbl.entries[svc.uid]; break; }
    }

    if (found !== null) {
      // LCNTable matches region: use its LCN regardless of Service.TargetRegion
      map[svc.uid] = found;
    } else if (matchingTables.length > 0 && !svcMatchesRegion) {
      // LCNTable matches region, no LCN for this service, Service.TargetRegion doesn't match:
      // assign overflow channel number (should-not-install case in Table 4.8-1)
      map[svc.uid] = overflowNext++;
    } else {
      // No region-matching table — fall back to global/unregioned tables
      for (const tbl of globalTables) {
        if (tbl.entries[svc.uid] != null) { found = tbl.entries[svc.uid]; break; }
      }
      if (found !== null) {
        map[svc.uid] = found;
      } else if (regionUpper && !svcMatchesRegion) {
        // No table at all, Service.TargetRegion doesn't match: overflow
        map[svc.uid] = overflowNext++;
      }
      // If svcMatchesRegion (or no region filter): no LCN available — stays null
    }
  }
  return map;
}

function rebuildLCNs() {
  const map = buildLCNMap(rawLCNTables, services, regionFilter);
  services.forEach(svc => { svc.lcn = map[svc.uid] ?? null; });
  services.sort((a, b) => (a.lcn ?? 9999) - (b.lcn ?? 9999));
}

// ── Service list parsing ──────────────────────────────────────────────────────

// Availability of a service instance (clause 5.5.15, table 26) as the model of instances.js, or null
// when there is none. Times of day are Zulu (clause 5.5.17), so they are read as UTC.
function parseAvailability(el) {
  if (!el) return null;
  const time = (v, dflt) => {
    const m = String(v || '').match(/^(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)Z$/);
    return m ? ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 : dflt;
  };
  const instant = v => { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };
  const periods = [];
  for (const p of el.getElementsByTagNameNS('*', 'Period')) {
    const intervals = [];
    for (const iv of p.getElementsByTagNameNS('*', 'Interval')) {
      const days = (iv.getAttribute('days') || '1 2 3 4 5 6 7').trim().split(/\s+/).map(Number).filter(d => d >= 1 && d <= 7);
      const rec = iv.getAttribute('recurrence');
      intervals.push({
        days,
        recurrence: Math.max(1, parseInt(rec || '1', 10) || 1),
        recurrenceGiven: rec != null,
        start: time(iv.getAttribute('startTime'), 0),
        end: time(iv.getAttribute('endTime'), 86399999),   // schema default 23:59:59.999Z
      });
    }
    // validFrom/validTo per clause 5.5.15; also accept the old start/end attributes
    periods.push({
      validFrom: instant(p.getAttribute('validFrom') || p.getAttribute('start')),
      validTo:   instant(p.getAttribute('validTo')   || p.getAttribute('end')),
      intervals,
    });
  }
  return { periods };
}

function parseServiceList(doc) {
  // Detect DVB-I namespace from root element — supports 2019, 2021, 2024 and future versions
  const _rootNs = doc.documentElement?.namespaceURI || '';
  const NS = _rootNs.startsWith('urn:dvb:metadata:servicediscovery:') ? _rootNs : 'urn:dvb:metadata:servicediscovery:2024';
  // Detect TVA namespace (2024, 2019, or 2010) from document content
  const _tvaCandidates = ['urn:tva:metadata:2024', 'urn:tva:metadata:2019', 'urn:tva:metadata:2010'];
  const NS_TVA = _tvaCandidates.find(v =>
    doc.getElementsByTagNameNS(v, 'HowRelated').length > 0 ||
    doc.getElementsByTagNameNS(v, 'AccessibilityAttributes').length > 0 ||
    doc.getElementsByTagNameNS(v, 'Name').length > 0
  ) || 'urn:tva:metadata:2024';

  const root    = doc.documentElement;
  const version = root?.getAttribute('version') || null;
  const name    = getNS(doc, 'Name', NS) || 'DVB-I Service List';

  // Parse LCNTables with optional TargetRegion (A184r2 §4.8 / Table 4.8-1)
  const lcnTables = [];
  for (const tbl of doc.getElementsByTagNameNS(NS, 'LCNTable')) {
    // TargetRegion is a child element (RegionIdRefType); tolerate the legacy attribute form too
    const trChild = tbl.getElementsByTagNameNS('*', 'TargetRegion')[0];
    const tableRegion = (trChild && trChild.textContent.trim())
      || tbl.getAttribute('TargetRegion') || tbl.getAttribute('targetRegion') || null;
    const entries = {};
    for (const lcn of tbl.getElementsByTagNameNS(NS, 'LCN')) {
      const ref = lcn.getAttribute('serviceRef');
      const ch  = parseInt(lcn.getAttribute('channelNumber'), 10);
      if (ref && !isNaN(ch)) entries[ref] = ch;
    }
    lcnTables.push({ targetRegion: tableRegion, entries });
  }
  // Backward compat: loose LCN elements (service lists without LCNTable wrapper)
  if (!lcnTables.length) {
    const entries = {};
    for (const lcn of doc.getElementsByTagNameNS(NS, 'LCN')) {
      const ref = lcn.getAttribute('serviceRef');
      const ch  = parseInt(lcn.getAttribute('channelNumber'), 10);
      if (ref && !isNaN(ch)) entries[ref] = ch;
    }
    if (Object.keys(entries).length) lcnTables.push({ targetRegion: null, entries });
  }

  // Build ContentGuideSource maps: CGSID → schedule URL and now/next URL (TS 103 770 §6.5.3)
  const cgsMap        = {};
  const cgsNowNextMap = {};
  for (const cgs of doc.getElementsByTagNameNS(NS, 'ContentGuideSource')) {
    const cgsid = cgs.getAttribute('CGSID');
    const siep  = cgs.getElementsByTagNameNS(NS, 'ScheduleInfoEndpoint')[0];
    // now/next endpoint: spec element is ProgramInfoEndpoint; accept legacy NowNextInfoEndpoint too
    const nnep  = cgs.getElementsByTagNameNS(NS, 'ProgramInfoEndpoint')[0]
               || cgs.getElementsByTagNameNS(NS, 'NowNextInfoEndpoint')[0];
    if (cgsid && siep) { const uri = uriText(siep); if (uri) cgsMap[cgsid] = uri; }
    if (cgsid && nnep) { const uri = uriText(nnep); if (uri) cgsNowNextMap[cgsid] = uri; }
  }
  const listEpgEndpoint        = Object.values(cgsMap)[0]        || null;
  const listNowNextEndpoint    = Object.values(cgsNowNextMap)[0] || null;

  const parsed = [];
  for (const svc of doc.getElementsByTagNameNS(NS, 'Service')) {
    const uid      = getNS(svc, 'UniqueIdentifier', NS);
    const name     = getNS(svc, 'ServiceName', NS);
    const provider = getNS(svc, 'ProviderName', NS);
    const typeEl   = svc.getElementsByTagNameNS(NS, 'ServiceType')[0];
    const svcType  = (typeEl?.getAttribute('href') || '').split(':').pop() || 'unknown';

    let logo = null;
    for (const rm of svc.getElementsByTagNameNS(NS, 'RelatedMaterial')) {
      // HowRelated is in TVA namespace (TS 103 770 §6.10); fall back to DVB-I namespace for old lists
      const hr = rm.getElementsByTagNameNS(NS_TVA, 'HowRelated')[0]
              || rm.getElementsByTagNameNS(NS, 'HowRelated')[0];
      if (hr && (hr.getAttribute('href') || '').includes('1001.2')) {
        const uri = rm.getElementsByTagNameNS(NS_TVA, 'MediaUri')[0]
                 || rm.getElementsByTagNameNS(NS, 'MediaUri')[0]
                 || Array.from(rm.getElementsByTagName('*')).find(el => el.localName === 'MediaUri');
        if (uri) { logo = uri.textContent.trim(); break; }
      }
    }

    // Linked application (TS 103 770 §5.2.3.1, A184r2 §5.2) — RelatedMaterial with LinkedApplicationCS HowRelated
    let linkedApp = null;
    for (const rm of svc.getElementsByTagNameNS(NS, 'RelatedMaterial')) {
      const hr = rm.getElementsByTagNameNS(NS_TVA, 'HowRelated')[0]
              || rm.getElementsByTagNameNS(NS, 'HowRelated')[0];
      if (hr) {
        const href = hr.getAttribute('href') || '';
        if (href.includes('LinkedApplicationCS') || href.includes(':2019:')) {
          const mu = rm.getElementsByTagNameNS(NS_TVA, 'MediaUri')[0]
                  || rm.getElementsByTagNameNS(NS, 'MediaUri')[0];
          if (mu) {
            const url = mu.textContent.trim();
            if (url) { linkedApp = { url, type: mu.getAttribute('contentType') || '' }; break; }
          }
        }
      }
    }

    // Multi-language name: prefer no-lang (universal), then first
    const nameEls = [...svc.getElementsByTagNameNS(NS, 'ServiceName')];
    let displayName = name;
    if (nameEls.length) {
      const noLang = nameEls.find(el => !el.getAttribute('xml:lang'));
      displayName = (noLang || nameEls[0]).textContent.trim();
    }

    // Genre — ServiceGenre (TS 103 770 §5.5.2); fall back to old Genre element name for backward compat
    const genreEl  = svc.getElementsByTagNameNS(NS, 'ServiceGenre')[0]
      || svc.getElementsByTagNameNS(NS, 'Genre')[0];
    let genre = null;
    if (genreEl) {
      const gName = genreEl.getElementsByTagNameNS(NS_TVA, 'Name')[0];
      if (gName) {
        genre = gName.textContent.trim().toLowerCase();
      } else {
        const href = genreEl.getAttribute('href') || '';
        const seg  = href.split(':').pop();
        if (seg) genre = seg.toLowerCase();
      }
    }

    // Parental rating — ParentalRating/MinimumAge at service level (TS 103 770 §5.5.28)
    // Also accept old ParentalGuidance element for backward compat
    let parentalRating = null;
    const prEl = svc.getElementsByTagNameNS(NS, 'ParentalRating')[0]
      || svc.getElementsByTagNameNS(NS, 'ParentalGuidance')[0];
    if (prEl) {
      const ma = prEl.getElementsByTagNameNS(NS, 'MinimumAge')[0]
        || prEl.getElementsByTagNameNS(NS_TVA, 'MinimumAge')[0]
        || prEl.getElementsByTagName('MinimumAge')[0];
      if (ma) parentalRating = ma.textContent.trim();
    }

    const instances = [];
    let hasBroadcastDelivery = false;
    // Set when an instance carries an mbms:// locator, so the service can be shown as offered over
    // 5G Broadcast and its signalling checked (see mbms-url.js).
    let mbms5g = null;
    for (const inst of svc.getElementsByTagNameNS(NS, 'ServiceInstance')) {
      // "<attribute name="priority" type="nonNegativeInteger" default="0"/>" (clause 5.5.4)
      const priority = parseInt(inst.getAttribute('priority') || '0', 10) || 0;
      // DisplayName names the service for this instance; "When not present, ServiceName is used."
      // (clause 5.5.4, table 16)
      const label    = getNS(inst, 'DisplayName', NS) || displayName;
      const availability = parseAvailability(inst.getElementsByTagNameNS(NS, 'Availability')[0]);

      // Broadcast-only delivery (DVB-T/S/C tuning triplet, TS 103 770 §5.5.18 Delivery Parameters) — a browser has no TV tuner,
      // so these never yield a playable instance. Tracked so the service can still be listed
      // (with an explanatory badge) instead of silently vanishing.
      if (!hasBroadcastDelivery) {
        hasBroadcastDelivery = !!(
          inst.getElementsByTagNameNS(NS, 'DVBTDeliveryParameters')[0] ||
          inst.getElementsByTagNameNS(NS, 'DVBSDeliveryParameters')[0] ||
          inst.getElementsByTagNameNS(NS, 'DVBCDeliveryParameters')[0]
        );
      }

      // Accessibility — ContentAttributes/AccessibilityAttributes. The AccessibilityAttributes
      // WRAPPER is a DVB-I element (its children SubtitleAttributes/AudioDescriptionAttributes are
      // tva:). Match the wrapper by localName in any namespace to tolerate both. (A184r2 §4.9)
      const caEl  = inst.getElementsByTagNameNS(NS, 'ContentAttributes')[0];
      const aaEl  = caEl?.getElementsByTagNameNS('*', 'AccessibilityAttributes')[0];
      const hasAudioDescription = !!(aaEl?.getElementsByTagNameNS(NS_TVA, 'AudioDescriptionAttributes')[0])
        || inst.getElementsByTagNameNS(NS, 'HasAudioDescription')[0]?.textContent.trim() === 'true';
      const hasHardOfHearing    = !!(aaEl?.getElementsByTagNameNS(NS_TVA, 'SubtitleAttributes')[0])
        || inst.getElementsByTagNameNS(NS, 'HasHardOfHearing')[0]?.textContent.trim() === 'true';

      // Subtitle carriage type (A184r2 §4.9) — last segment of SubtitleCarriageCS:2023 URI
      // 1=application subtitles, 2=in MPEG-2 TS, 3=in ISOBMFF/DASH, 4=standalone, 5=open/in-video, 99=other
      const subtitleCarriage = (aaEl
        ?.getElementsByTagNameNS(NS_TVA, 'SubtitleAttributes')[0]
        ?.getElementsByTagNameNS(NS_TVA, 'Carriage')[0]
        ?.getAttribute('href') || '').split(':').pop() || null;

      // ContentProtection (clause 5.5.20): every CASystemId and every DRMSystemId with its
      // @encryptionScheme, any number of each per element. Table 103 marks all three for IP-only
      // receivers, which identify "whether content is protected and whether the receiver supports
      // the content protection scheme used or not" (clause 8.5.1, NOTE 3).
      let protection = null;
      const allSystems = {};
      const schemes = {};
      const caSystems = [];
      for (const cp of inst.getElementsByTagNameNS(NS, 'ContentProtection')) {
        const licEl = cp.getElementsByTagNameNS(NS, 'LicenseServerURL')[0];
        for (const drmEl of cp.getElementsByTagNameNS(NS, 'DRMSystemId')) {
          const id = drmEl.textContent.trim();
          if (!id) continue;
          allSystems[id] = licEl?.textContent.trim() || '';
          schemes[id] = drmEl.getAttribute('encryptionScheme') || '';
        }
        for (const caEl of cp.getElementsByTagNameNS(NS, 'CASystemId')) {
          const id = caEl.textContent.trim();
          if (id) caSystems.push(id);
        }
      }
      const sysPairs = Object.entries(allSystems);
      if (sysPairs.length || caSystems.length) {
        protection = { system: sysPairs[0]?.[0] || null, licenseUrl: sysPairs[0]?.[1] || '', allSystems, schemes, caSystems };
      }

      const dash = inst.getElementsByTagNameNS(NS, 'DASHDeliveryParameters')[0];
      if (dash) {
        const url = uriText(dash); // URI may be dvbisd-t:URI (types ns) or legacy <URI>
        const origSource = dash.getElementsByTagNameNS('*', 'OriginalDeliverySource')[0]?.textContent.trim() || null;
        if (url) instances.push({ priority, label, url, type: 'application/dash+xml', hasAudioDescription, hasHardOfHearing, protection, origSource, subtitleCarriage, availability });
      }

      // 5G Broadcast: IdentifierBasedDeliveryParameters holding an mbms:// locator, which TS 103 770
      // V1.2.1 clause 9.3.3 has the client hand to an MBMS Client. A browser has none, so this yields
      // no playable instance; the locator is checked and shown, and another instance plays if listed.
      if (!mbms5g) {
        const idEl = inst.getElementsByTagNameNS(NS, 'IdentifierBasedDeliveryParameters')[0];
        const locator = idEl?.textContent.trim() || '';
        if (/^mbms:/i.test(locator)) {
          mbms5g = {
            locator, priority,
            problem:   DVBIMbmsUrl.problem(locator),
            serviceId: DVBIMbmsUrl.serviceId(locator),
          };
        }
      }

      // OtherDeliveryParameters — general extension framework (A184r2 §4.6/4.6.5)
      // Resolve MIME type from extensionName/xsi:type attributes, then from child contentType
      const other = inst.getElementsByTagNameNS(NS, 'OtherDeliveryParameters')[0];
      if (other) {
        const extAttr = (other.getAttribute('extensionName') || other.getAttribute('xsi:type') || '').toLowerCase();
        let mimeType = null;
        if (extAttr.includes('mpegurl') || extAttr.includes('m3u8') || extAttr.includes('apple')) {
          mimeType = 'application/vnd.apple.mpegurl';
        } else if (extAttr.includes('dash')) {
          mimeType = 'application/dash+xml';
        } else {
          // Scan child elements for a contentType attribute (schema-agnostic fallback)
          for (const el of other.getElementsByTagName('*')) {
            const ct = el.getAttribute('contentType');
            if (ct) { mimeType = ct; break; }
          }
        }
        const uriEl = other.getElementsByTagNameNS('*', 'URI')[0]
                   || [...other.getElementsByTagName('*')].find(el => /^https?:\/\//i.test(el.textContent.trim()));
        const extUrl = uriEl?.textContent.trim();
        if (extUrl && mimeType) {
          const knownType = ['application/vnd.apple.mpegurl', 'application/dash+xml'].includes(mimeType) ? mimeType : null;
          if (knownType) instances.push({ priority, label, url: extUrl, type: knownType, hasAudioDescription, hasHardOfHearing, protection, origSource: null, subtitleCarriage, extensionName: extAttr || null, availability });
        }
      }

      // MulticastTSDeliveryParameters/IPMulticastAddress (TS 103 770 §5.5.13)
      const mc = inst.getElementsByTagNameNS(NS, 'MulticastTSDeliveryParameters')[0]
        || inst.getElementsByTagNameNS(NS, 'MulticastDeliveryParameters')[0];
      if (mc) {
        const ipa = mc.getElementsByTagNameNS(NS, 'IPMulticastAddress')[0];
        let mcUrl = null;
        if (ipa) {
          // McastType attributes are Address/Port (capital-initial); tolerate legacy lowercase
          const addr = ipa.getAttribute('Address') || ipa.getAttribute('address');
          const port = ipa.getAttribute('Port')    || ipa.getAttribute('port');
          if (addr) mcUrl = port ? `udp://${addr}:${port}` : `udp://${addr}`;
        } else {
          const u = uriText(mc);
          if (u) mcUrl = u;
        }
        if (mcUrl) instances.push({ priority, label, url: mcUrl, type: 'multicast', hasAudioDescription, hasHardOfHearing, protection, origSource: null, subtitleCarriage, availability });
      }
    }

    // TargetRegion — regionID (lowercase per TS 103 770 §5.5.2); also accept uppercase for backward compat
    const trEl = svc.getElementsByTagNameNS(NS, 'TargetRegion')[0];
    const targetRegion = trEl
      ? (trEl.getAttribute('regionID') || trEl.getAttribute('RegionID') || trEl.textContent.trim() || null)
      : null;

    // ContentGuideServiceRef is at Service level (TS 103 770 §5.5.2); also check ServiceInstance for old XML
    let epgEndpoint     = listEpgEndpoint;
    let nowNextEndpoint = listNowNextEndpoint;
    const svcCgsRefEl = svc.getElementsByTagNameNS(NS, 'ContentGuideServiceRef')[0];
    if (svcCgsRefEl) {
      const ref = svcCgsRefEl.textContent.trim();
      if (ref && cgsMap[ref])        epgEndpoint     = cgsMap[ref];
      if (ref && cgsNowNextMap[ref]) nowNextEndpoint = cgsNowNextMap[ref];
    } else {
      for (const inst of svc.getElementsByTagNameNS(NS, 'ServiceInstance')) {
        const ref = getNS(inst, 'ContentGuideServiceRef', NS);
        if (ref && cgsMap[ref]) { epgEndpoint = cgsMap[ref]; if (cgsNowNextMap[ref]) nowNextEndpoint = cgsNowNextMap[ref]; break; }
      }
    }

    // Subscription package
    const subPkgEl = svc.getElementsByTagNameNS(NS, 'SubscriptionPackage')[0];
    const subscriptionPackage = subPkgEl ? subPkgEl.textContent.trim() : null;

    // Service restriction (subscription / conditional-access)
    const restrictEl = svc.getElementsByTagNameNS(NS, 'ServiceRestriction')[0];
    const serviceRestriction = restrictEl ? (restrictEl.getAttribute('href') || '').split(':').pop() || null : null;

    // AdditionalServiceParameters — store extension type/name for host integrations (A184r2 §4.6, e.g. HbbTV DVBTriplet)
    const aspEl = svc.getElementsByTagNameNS(NS, 'AdditionalServiceParameters')[0];
    const additionalServiceParams = aspEl ? {
      type: aspEl.getAttribute('xsi:type') || '',
      name: aspEl.getAttribute('extensionName') || '',
    } : null;

    // A service with a real ServiceInstance but zero playable (IP-deliverable) instances is kept
    // in the list — noIpDelivery lets the UI show it as broadcast-only rather than hiding it.
    const instanceCount = svc.getElementsByTagNameNS(NS, 'ServiceInstance').length;
    const noIpDelivery = instances.length === 0 && instanceCount > 0;
    if (displayName && (instances.length || noIpDelivery)) {
      parsed.push({ uid, name: displayName, provider, svcType, logo, instances, lcn: null, epgEndpoint, nowNextEndpoint, genre, parentalRating, targetRegion, subscriptionPackage, serviceRestriction, linkedApp, additionalServiceParams, noIpDelivery, hasBroadcastDelivery, mbms5g });
    }
  }

  return { name, version, services: parsed, lcnTables };
}

// ── Load service list ─────────────────────────────────────────────────────────

// Multi-URI fallback per TS 103 770 §4.3.3.3-6: accepts a single URL or array of fallback URLs.
// Resolves to 'installed' when a list was parsed and installed, 'kept' when the current list is
// unchanged (fresh in the cache or 304), or 'failed'.
async function loadServiceList(urlOrUrls) {
  const urls = Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls];
  const primaryUrl = urls[0];
  const previousUrl = currentListUrl;

  currentListUrl = primaryUrl;
  localStorage.setItem('dvbi-url', primaryUrl);
  urlInput.value = primaryUrl;

  // Do NOT tear down current services/playback up front: a conditional-GET 304 (e.g. the
  // nightly refresh of an unchanged list) must keep the running stream and visible channels.
  // Only show the "Loading…" empty state on a genuine first load (nothing to preserve).
  const hadServices = services.length > 0;
  if (!hadServices) {
    bufSpinner.hidden = true;
    services = []; currentIdx = -1; epgCache = {}; nowNextCache = {}; activeGenre = '';
    channelList.innerHTML = '';
    noService.style.display = 'flex';
    listNameEl.textContent = 'Loading…';
    tbName.textContent = 'Select a channel';
    tbLcn.hidden = true;
    tbNow.hidden = true;
  }

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      const r = await dvbiHttp.get(url);
      if (!r.ok) throw new Error(failureText(r));
      // Not modified, or still fresh by its max-age (clause 4.3.2): keep current services and playback.
      if (r.notModified && hadServices && !isCustomListActive && url === previousUrl) {
        currentListUrl = url;
        localStorage.setItem('dvbi-url', url);
        urlInput.value = url;
        return 'kept';
      }
      installServiceList(url, r.body, r.contentType);
      return 'installed';
    } catch (err) {
      if (i < urls.length - 1) {
        console.warn(`Service list URI ${i + 1}/${urls.length} failed (${url}), trying next:`, err.message);
        continue;
      }
      console.error('All service list URIs failed:', err);
      // Keep a working list (and playback) if we already had one; only show the error state on first load
      if (hadServices) {
        showVersionNotice('Could not refresh the service list — keeping the current one');
      } else {
        listNameEl.textContent = 'Load failed';
        channelList.innerHTML = `<li class="ch-error">Error: ${esc(err.message)}</li>`;
      }
    }
  }
  return 'failed';
}

// Parses a fetched service list and makes it the current one. Throws when the body is not a
// service list.
function installServiceList(url, body, contentType) {
  const ctype = (contentType || '').toLowerCase();
  const doc = new DOMParser().parseFromString(body, 'application/xml');
  if (doc.querySelector('parsererror')) {
    // Naming what actually arrived turns the commonest mistake into a self-explaining one:
    // a URL pointing at a portal's home page, or at an API, answers 200 with HTML or JSON,
    // and "not valid XML" alone gives no hint that the URL itself is the problem.
    const looksHtml = /html/.test(ctype) || /^\s*<!doctype html/i.test(body);
    const looksJson = /json/.test(ctype) || /^\s*[{[]/.test(body);
    const what = looksHtml ? 'an HTML page' : looksJson ? 'a JSON response' : `content of type ${ctype || 'unknown'}`;
    throw new Error(!body.trim()
      ? `${url} returned an empty response`
      : `${url} returned ${what}, not a DVB-I service list. Check the URL in settings: it should be the service list itself, for example ${DEFAULT_URL}`);
  }
  const parsed = parseServiceList(doc);

  // Committed to a new list now — tear down current state and rebuild.
  DVBIPlayer.stop();
  bufSpinner.hidden = true;
  playError.hidden  = true;
  epgCache = {}; nowNextCache = {}; activeGenre = '';
  currentIdx = -1;
  tbName.textContent = 'Select a channel';
  tbLcn.hidden = true;
  tbNow.hidden = true;

  // Update stored URL to the one that worked
  currentListUrl = url;
  localStorage.setItem('dvbi-url', url);
  urlInput.value = url;

  isCustomListActive = false;
  services = parsed.services;
  rawLCNTables = parsed.lcnTables;
  rebuildLCNs(); // assign LCNs and sort services using current regionFilter
  currentVersion = parsed.version;
  listNameEl.textContent = parsed.name;
  versionRow.textContent = parsed.version ? `Version ${parsed.version}` : '';

  renderChannelList();
  loadAllEPG();
  startVersionPolling(url);
}

// ── Channel list rendering ────────────────────────────────────────────────────

function buildGenreBar() {
  const genres = [...new Set(services.map(s => s.genre).filter(Boolean))];
  if (activeGenre && !genres.includes(activeGenre)) activeGenre = '';
  genreBar.innerHTML = `<button class="genre-pill${!activeGenre ? ' active' : ''}" aria-pressed="${!activeGenre}" data-genre="">All</button>` +
    genres.map(g => `<button class="genre-pill${activeGenre === g ? ' active' : ''}" aria-pressed="${activeGenre === g}" data-genre="${esc(g)}">${esc(g.charAt(0).toUpperCase() + g.slice(1))}</button>`).join('');
  genreBar.querySelectorAll('.genre-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      activeGenre = btn.dataset.genre;
      genreBar.querySelectorAll('.genre-pill').forEach(b => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-pressed', String(b === btn));
      });
      applyFilters();
    });
  });
}

function applyFilters() {
  const q = searchInput.value.trim().toLowerCase();
  let visible = 0;
  document.querySelectorAll('.ch-card').forEach(el => {
    const svc = services[parseInt(el.dataset.idx, 10)];
    if (!svc) return;
    const matchSearch  = !q || svc.name.toLowerCase().includes(q) || (svc.provider || '').toLowerCase().includes(q);
    const matchGenre   = !activeGenre || svc.genre === activeGenre;
    const matchRegion  = !regionFilter || !svc.targetRegion || svc.targetRegion.toUpperCase() === regionFilter.toUpperCase();
    const show = matchSearch && matchGenre && matchRegion;
    el.hidden = !show;
    if (show) visible++;
  });
  let emptyEl = channelList.querySelector('.ch-filter-empty');
  if (visible === 0 && services.length > 0) {
    if (!emptyEl) {
      emptyEl = document.createElement('li');
      emptyEl.className = 'ch-filter-empty';
      channelList.appendChild(emptyEl);
    }
    emptyEl.textContent = 'No channels match this filter.';
  } else if (emptyEl) {
    emptyEl.remove();
  }
  scrollActiveCard();
}

function renderChannelList() {
  channelList.innerHTML = '';

  // Favourites first, then rest
  const favIdxs   = services.map((s, i) => i).filter(i => favourites.has(services[i].uid));
  const otherIdxs = services.map((s, i) => i).filter(i => !favourites.has(services[i].uid));
  const ordered   = [...favIdxs, ...otherIdxs];

  let hasFavSep = false, hasMainSep = false;

  ordered.forEach(idx => {
    const svc = services[idx];
    const isFav = favourites.has(svc.uid);

    if (isFav && !hasFavSep && favIdxs.length) {
      const sep = document.createElement('li');
      sep.className = 'ch-sep';
      sep.textContent = 'Favourites';
      channelList.appendChild(sep);
      hasFavSep = true;
    }
    if (!isFav && !hasMainSep && favIdxs.length) {
      const sep = document.createElement('li');
      sep.className = 'ch-sep';
      sep.textContent = 'All Channels';
      channelList.appendChild(sep);
      hasMainSep = true;
    }

    const hasAD  = svc.instances?.some(i => i.hasAudioDescription);
    const hasHoH = svc.instances?.some(i => i.hasHardOfHearing);
    const isMCOnly = svc.instances?.length > 0 && svc.instances.every(i => i.type === 'multicast');
    const rating = svc.parentalRating;
    // Only show the lock when a PIN gate is actually in force — the playback gate (selectService)
    // requires pgPin, so without a PIN a threshold alone does not block playback.
    const locked = pgThreshold && pgPin && rating && parseInt(rating, 10) >= pgThreshold && !pgUnlocked.has(svc.uid);
    const regionTag = svc.targetRegion ? `<span class="ch-badge ch-badge-region" data-tooltip="Restricted to region: ${esc(svc.targetRegion)}">${esc(svc.targetRegion)}</span>` : '';
    const subTag = svc.subscriptionPackage
      ? `<span class="ch-badge ch-badge-sub" data-tooltip="Subscription required: ${esc(svc.subscriptionPackage)}">SUB</span>`
      : (!svc.subscriptionPackage && svc.serviceRestriction && svc.serviceRestriction !== 'none'
          ? `<span class="ch-badge ch-badge-sub" data-tooltip="${svc.serviceRestriction === 'subscription' ? 'Subscription required' : 'Conditional access required'}">${svc.serviceRestriction === 'subscription' ? 'SUB' : 'CA'}</span>` : '');
    const unavailableTag = serviceOffAir(svc) ? `<span class="ch-badge ch-badge-unavail" data-tooltip="Service currently off-air">Off-air</span>` : '';
    const broadcastTag = svc.noIpDelivery
      ? `<span class="ch-badge ch-badge-mc" data-tooltip="${svc.hasBroadcastDelivery ? 'Broadcast delivery only (DVB-T/S/C) — no broadband stream listed, cannot play in a browser' : svc.mbms5g ? '5G Broadcast only — a browser cannot reach an MBMS Client' : 'No playable delivery method listed for this service'}">${svc.hasBroadcastDelivery || !svc.mbms5g ? 'Broadcast only' : '5G only'}</span>`
      : '';
    // Shows the 5G Broadcast signalling and whether it is well formed, since this client can check it
    // but not receive it.
    const m5 = svc.mbms5g;
    const ext5gTag = m5
      ? `<span class="ch-badge ch-badge-5g${m5.problem ? ' ch-badge-5g-bad' : ''}" data-tooltip="${esc(m5.problem
          ? `5G Broadcast signalling is wrong: ${m5.locator} is ${m5.problem} (TS 26.347 clause 8.2.2).`
          : `5G Broadcast, priority ${m5.priority}: ${m5.locator}, MBMS User Service ${m5.serviceId}. ` +
            `This browser cannot reach an MBMS Client; ` +
            (svc.instances.length ? 'it plays another instance of this service.' : 'no other instance is listed.'))}">5G</span>`
      : '';
    const badges = [
      ext5gTag,
      hasAD    ? '<span class="ch-badge ch-badge-ad"  data-tooltip="Audio Description: narration for visually impaired viewers">AD</span>'  : '',
      hasHoH   ? '<span class="ch-badge ch-badge-hoh" data-tooltip="Hard of Hearing: subtitles with sound effects and speaker labels">HoH</span>' : '',
      isMCOnly ? '<span class="ch-badge ch-badge-mc"  data-tooltip="Multicast delivery only — not playable in a browser">MC</span>' : '',
      broadcastTag,
      rating && rating !== 'none' ? `<span class="ch-badge ch-badge-pg" data-tooltip="Minimum parental age rating">${rating}+</span>` : '',
      subTag,
      regionTag,
      unavailableTag,
    ].join('');

    const li = document.createElement('li');
    li.className = serviceOffAir(svc) ? 'ch-card unavailable'
      : svc.noIpDelivery ? 'ch-card no-delivery' : 'ch-card';
    li.dataset.idx = idx;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', 'false');
    li.setAttribute('aria-label', svc.name + (svc.lcn != null ? `, channel ${svc.lcn}` : ''));
    li.innerHTML = `
      <div class="ch-lcn">${svc.lcn ?? '?'}</div>
      ${svc.logo ? `<img class="ch-logo" src="${esc(svc.logo)}" alt="" onerror="this.style.display='none'"/>` : '<div class="ch-logo ch-logo-fallback"></div>'}
      <div class="ch-info">
        <div class="ch-name">${locked ? '🔒 ' : ''}${esc(svc.name)}</div>
        <div class="ch-provider">${esc(svc.provider)}</div>
        <div class="ch-now" id="ch-now-${idx}">
          <div class="ch-now-dot"></div>
          <span class="ch-now-title">Loading EPG…</span>
        </div>
        <div class="ch-prog" id="ch-prog-${idx}"><div class="ch-prog-fill"></div></div>
        ${badges ? `<div class="ch-badges">${badges}</div>` : ''}
      </div>
      <button class="ch-fav-btn${isFav ? ' fav' : ''}" title="${isFav ? 'Remove from favourites' : 'Add to favourites'}" onclick="event.stopPropagation();toggleFav(${esc(JSON.stringify(svc.uid))})">${isFav ? '★' : '☆'}</button>
      <button class="ch-custom-btn${isInCustomList(svc.uid) ? ' in-custom' : ''}" title="${isInCustomList(svc.uid) ? 'Remove from custom list' : 'Add to custom list'}" onclick="event.stopPropagation();toggleCustom(${esc(JSON.stringify(svc.uid))})">${isInCustomList(svc.uid) ? '✓' : '+'}</button>`;
    li.addEventListener('click', () => selectService(idx));
    channelList.appendChild(li);
  });
  buildGenreBar();
  applyFilters();
}

// ── Favourites ────────────────────────────────────────────────────────────────

function toggleFav(uid) {
  if (favourites.has(uid)) favourites.delete(uid);
  else favourites.add(uid);
  localStorage.setItem('dvbi-favs', JSON.stringify([...favourites]));
  renderChannelList();
  document.querySelectorAll('.ch-card').forEach(el => {
    const active = parseInt(el.dataset.idx, 10) === currentIdx;
    el.classList.toggle('active', active);
    el.setAttribute('aria-selected', String(active));
  });
  scrollActiveCard();
}

function updateSidebarNow(idx, events) {
  const nowEl  = $(`ch-now-${idx}`);
  const progEl = $(`ch-prog-${idx}`);
  if (!nowEl) return;
  const { current } = DVBIEpg.getNowNext(events);
  nowEl.querySelector('.ch-now-title').textContent = current ? current.title : '–';
  if (progEl && current) {
    const pct = Math.min(100, ((Date.now() - current.start) / current.durMs) * 100);
    progEl.querySelector('.ch-prog-fill').style.width = `${pct.toFixed(1)}%`;
  }
}

function scrollActiveCard() {
  const active = channelList.querySelector('.ch-card.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function nextVisibleIdx(dir) {
  const cards = [...channelList.querySelectorAll('.ch-card:not([hidden])')];
  if (!cards.length) return currentIdx < 0 ? 0 : currentIdx;
  const pos = cards.findIndex(el => parseInt(el.dataset.idx, 10) === currentIdx);
  const next = pos === -1
    ? (dir > 0 ? 0 : cards.length - 1)
    : (pos + dir + cards.length) % cards.length;
  return parseInt(cards[next].dataset.idx, 10);
}

// ── Service selection + delivery fallback ─────────────────────────────────────

// What this browser can play, so that instances known not to play are discarded before they are
// tried (clause 5.2.13). A DRM system counts only if the player maps it to an EME key system; whether
// the browser's CDM accepts that key system and @encryptionScheme is learnt from playback, since the
// EME capability query needs codecs, which the service list does not carry.
function playbackCaps() {
  const mse = !!(window.MediaSource || window.ManagedMediaSource);
  return {
    dash: typeof dashjs !== 'undefined' && mse,
    hls: (typeof Hls !== 'undefined' && Hls.isSupported()) || videoEl.canPlayType('application/vnd.apple.mpegurl') !== '',
    eme: typeof navigator.requestMediaKeySystemAccess === 'function',
    keySystem: DVBIPlayer.knownKeySystem,
  };
}

// Off air: every instance is outside its scheduled service hours (clause 5.2.5.3).
function serviceOffAir(svc, ms = Date.now()) {
  return svc.instances.length > 0 && !svc.instances.some(i => DVBIInstances.isAvailable(i.availability, ms));
}

function nextAvailabilityChange(svc, ms = Date.now()) {
  const times = svc.instances.map(i => DVBIInstances.nextChange(i.availability, ms)).filter(t => t != null);
  return times.length ? Math.min(...times) : null;
}

// Instances that failed during the current selection, skipped when precedence is re-evaluated.
let failedInstances = new Set();
let availabilityTimer = null;
let offAirShown = false;
const MAX_TIMEOUT_MS = 2147483647; // setTimeout fires at once for longer delays, so wait in steps

// "When one of the service instances of the currently selected service changes from being inside
// their scheduled service hours to being outside or vice-versa, the selected service instance shall
// be re-evaluated." (clause 5.2.13)
function scheduleReevaluation(svcIdx) {
  clearTimeout(availabilityTimer);
  const svc = services[svcIdx];
  const at = svc && nextAvailabilityChange(svc);
  if (at == null) return;
  availabilityTimer = setTimeout(() => {
    if (svcIdx !== currentIdx || isCatchup) return;
    if (Date.now() < at) { scheduleReevaluation(svcIdx); return; }
    reevaluateInstance(svcIdx);
  }, Math.min(Math.max(0, at - Date.now()), MAX_TIMEOUT_MS));
}

function reevaluateInstance(svcIdx) {
  const svc = services[svcIdx];
  if (!svc) return;
  if (offAirShown || serviceOffAir(svc)) { selectService(svcIdx); return; }
  const best = DVBIInstances.candidates(svc.instances, Date.now(), playbackCaps(), failedInstances)[0];
  if (best !== currentInstIdx) {
    currentSession++;
    tryInstance(svcIdx, currentSession);
  } else {
    scheduleReevaluation(svcIdx);
  }
}

function selectService(idx) {
  if (!services.length) return;
  idx = Math.max(0, Math.min(idx, services.length - 1));

  const svc = services[idx];

  failedInstances = new Set();
  offAirShown = false;
  clearTimeout(availabilityTimer);

  // Availability check first — no point prompting PIN for an off-air service
  if (serviceOffAir(svc)) {
    currentIdx = idx;
    offAirShown = true;
    document.querySelectorAll('.ch-card').forEach(el => {
      const active = parseInt(el.dataset.idx, 10) === idx;
      el.classList.toggle('active', active);
      el.setAttribute('aria-selected', String(active));
    });
    scrollActiveCard();
    noService.style.display = 'none';
    tbName.textContent = svc.name;
    if (svc.lcn != null) { tbLcn.textContent = `CH ${svc.lcn}`; tbLcn.hidden = false; }
    else tbLcn.hidden = true;
    tbNow.hidden = true;
    DVBIPlayer.stop();
    bufSpinner.hidden = true;
    isCatchup = false;
    backToLiveBtn.hidden = true;
    playError.hidden = false;
    const back = nextAvailabilityChange(svc);
    playErrorMsg.textContent = `Service off-air${back ? ` (back on air ${new Date(back).toLocaleString()})` : ''}`;
    loadServiceEPG(idx);
    scheduleReevaluation(idx);
    return;
  }

  // Broadcast-only service (DVB-T/S/C tuning triplet, no IP delivery) — a browser has no TV
  // tuner, so there is nothing to fetch. Show a clear explanation instead of attempting playback.
  if (svc.noIpDelivery) {
    currentIdx = idx;
    document.querySelectorAll('.ch-card').forEach(el => {
      const active = parseInt(el.dataset.idx, 10) === idx;
      el.classList.toggle('active', active);
      el.setAttribute('aria-selected', String(active));
    });
    scrollActiveCard();
    noService.style.display = 'none';
    tbName.textContent = svc.name;
    if (svc.lcn != null) { tbLcn.textContent = `CH ${svc.lcn}`; tbLcn.hidden = false; }
    else tbLcn.hidden = true;
    tbNow.hidden = true;
    DVBIPlayer.stop();
    bufSpinner.hidden = true;
    isCatchup = false;
    backToLiveBtn.hidden = true;
    playError.hidden = false;
    playErrorMsg.textContent = svc.hasBroadcastDelivery
      ? 'Broadcast-only service (DVB-T/S/C) — not available via broadband in this browser'
      : svc.mbms5g
        ? (svc.mbms5g.problem
            ? `5G Broadcast only, and its signalling is wrong: ${svc.mbms5g.locator} is ${svc.mbms5g.problem}`
            : '5G Broadcast only — a browser cannot reach an MBMS Client, and this service lists no other instance')
        : 'No playable delivery method listed for this service';
    loadServiceEPG(idx);
    return;
  }

  // Subscription gate — notify user before playing subscription/CA-only services (TS 103 770 §4.3)
  if (!subGateAcked.has(svc.uid) && (svc.subscriptionPackage || svc.serviceRestriction === 'subscription' || svc.serviceRestriction === 'conditionalAccess')) {
    showSubGate(svc.uid, () => selectService(idx));
    return;
  }

  // Parental PIN check
  if (pgThreshold && pgPin && svc.parentalRating && parseInt(svc.parentalRating, 10) >= pgThreshold && !pgUnlocked.has(svc.uid)) {
    openPinEntry(svc.uid, () => selectService(idx));
    return;
  }

  currentIdx = idx;
  currentSession++;
  const session = currentSession;

  isCatchup = false;
  backToLiveBtn.hidden = true;
  seekWrap.hidden = true;
  subGateEl.hidden = true;

  document.querySelectorAll('.ch-card').forEach(el => el.classList.toggle('active', parseInt(el.dataset.idx, 10) === idx));
  scrollActiveCard();
  noService.style.display = 'none';
  playError.hidden = true;
  tbName.textContent = svc.name;
  if (svc.lcn != null) { tbLcn.textContent = `CH ${svc.lcn}`; tbLcn.hidden = false; }
  else tbLcn.hidden = true;
  tbNow.hidden = true;
  showOverlay(svc, null);
  loadServiceEPG(idx);
  tryInstance(idx, session);
}

// Plays the instance that comes first by precedence (clause 5.2.13) among those not yet failed in
// this selection; on a non-recoverable error that instance is set aside and precedence is applied
// again.
function tryInstance(svcIdx, session) {
  if (svcIdx !== currentIdx || session !== currentSession) return;

  const svc = services[svcIdx];
  const caps = playbackCaps();
  const instIdx = DVBIInstances.candidates(svc.instances, Date.now(), caps, failedInstances)[0];
  scheduleReevaluation(svcIdx);
  if (instIdx === undefined) {
    DVBIPlayer.stop();
    bufSpinner.hidden = true;
    playError.hidden  = false;
    const reasons = svc.instances
      .filter((inst, i) => !failedInstances.has(i) && DVBIInstances.isAvailable(inst.availability, Date.now()))
      .map(inst => DVBIInstances.cannotPlay(inst, caps))
      .filter(Boolean);
    const hasProtected = svc.instances.some(i => i.protection != null);
    playErrorMsg.textContent = reasons.length
      ? `No instance of this service can play in this browser: ${[...new Set(reasons)].join('; ')}`
      : hasProtected
        ? 'DRM-protected stream — CDM not available in this browser'
        : `All ${svc.instances.length} stream${svc.instances.length > 1 ? 's' : ''} unavailable`;
    return;
  }

  const delivery = svc.instances[instIdx];
  currentInstIdx = instIdx;
  tbName.textContent = delivery.label;
  overlayName.textContent = delivery.label;
  updateDeliveryBadge(delivery, instIdx, svc.instances.length);
  bufSpinner.hidden = false;
  playError.hidden  = true;

  DVBIPlayer.play(
    videoEl, delivery.url, delivery.type,
    delivery.protection,
    // onError
    () => {
      if (svcIdx !== currentIdx || session !== currentSession) return;
      bufSpinner.hidden = true;
      console.warn(`Instance ${instIdx + 1}/${svc.instances.length} failed, applying precedence again…`);
      failedInstances.add(instIdx);
      tryInstance(svcIdx, session);
    },
    // onBuffer
    (isBuffering) => {
      if (svcIdx !== currentIdx || session !== currentSession) return;
      bufSpinner.hidden = !isBuffering;
    },
    // onTracks
    () => {
      autoSelectLang();
      if (tracksPanelOpen) refreshTracksPanel();
    }
  );
}

playErrorRetry.addEventListener('click', () => {
  if (currentIdx >= 0) selectService(currentIdx);
});

// ── Overlay ───────────────────────────────────────────────────────────────────

const TYPE_LABEL = { linear: 'Linear TV', radio: 'Radio', nonlinear: 'On Demand' };

function showOverlay(svc, delivery) {
  overlayLcn.textContent  = svc.lcn != null ? `CH ${svc.lcn}` : '';
  overlayName.textContent = svc.name;
  overlayProv.textContent = svc.provider;
  overlayType.textContent = TYPE_LABEL[svc.svcType] || svc.svcType;
  if (delivery) updateDeliveryBadge(delivery, 0, svc.instances.length);
  updateLinkedAppButton(svc);
  showOverlayBriefly(4500);
}

function updateLinkedAppButton(svc) {
  const appUrl = svc?.linkedApp?.url || null;
  tbAppBtn.hidden = !appUrl;
  tbAppBtn.dataset.url = appUrl || '';
}

function updateDeliveryBadge(delivery, instIdx, total) {
  const label = delivery.type === 'application/dash+xml' ? 'DASH' : 'HLS';
  overlayDlv.textContent = total > 1 ? `${label} ·${instIdx + 1}/${total}` : label;
}

// ── EPG loading ───────────────────────────────────────────────────────────────

// A guide request through the shared HTTP client. A 404 from a ContentGuideSource URL makes the
// client re-acquire the service list, to re-acquire the ContentGuideSource; a 404 again after
// that backs the request off (TS 103 770 V1.2.1 clause 4.3.3.4).
const guideReacquired = new Set(); // request keys that already caused a service list re-acquisition
let reacquiring = null;

async function guideLoad(endpoint, uid) {
  const { events, result } = await DVBIEpg.load(endpoint, uid, dvbiHttp);
  const key = DVBIEpg.requestKey(endpoint, uid);
  if (events) { guideReacquired.delete(key); return events; }
  if (result && result.status === 404 && !result.skipped) {
    if (guideReacquired.has(key)) {
      dvbiHttp.backOff(key);
    } else {
      guideReacquired.add(key);
      reacquireServiceList();
    }
  }
  return null;
}

function reacquireServiceList() {
  if (reacquiring || isCustomListActive || !currentListUrl) return;
  reacquiring = loadServiceList(currentListUrl)
    .then(outcome => { if (outcome === 'kept') loadAllEPG(); })
    .finally(() => { reacquiring = null; });
}

// nowNextCache: lightweight 1-2 event result from NowNextInfoEndpoint (TS 103 770 §6.5.3.2)
// epgCache: full schedule from ScheduleInfoEndpoint — only loaded when EPG panel opens
let nowNextCache = {};

async function loadServiceEPG(idx) {
  const svc = services[idx];
  if (!svc?.epgEndpoint) return;

  // If EPG panel is open and full schedule is not yet cached, fetch it now
  if (epgPanelOpen && !epgCache[svc.uid]) {
    try {
      const events = await guideLoad(svc.epgEndpoint, svc.uid);
      if (events) {
        epgCache[svc.uid] = events;
        nowNextCache[svc.uid] = events; // full schedule also serves as now/next
        if (idx === currentIdx) { DVBIEpg.render(epgStrip, svc.name, events); updateToolbarNow(); }
        updateSidebarNow(idx, events);
        if (epgPanelOpen && idx === currentIdx) refreshEPGPanel();
      }
    } catch (e) {
      if (idx === currentIdx) epgStrip.innerHTML = `<div class="epg-label">EPG · ${esc(svc.name)}</div><div class="epg-empty">EPG unavailable</div>`;
    }
    return;
  }

  // For channel list display, use nowNextCache or epgCache if already loaded
  const displayEvents = epgCache[svc.uid] || nowNextCache[svc.uid];
  if (displayEvents) {
    if (idx === currentIdx) { DVBIEpg.render(epgStrip, svc.name, displayEvents); updateToolbarNow(); }
    updateSidebarNow(idx, displayEvents);
    if (epgPanelOpen && idx === currentIdx) refreshEPGPanel();
    return;
  }

  // First load: fetch via NowNextInfoEndpoint if available (cheaper), else full schedule
  const quickEp = svc.nowNextEndpoint || svc.epgEndpoint;
  if (idx === currentIdx) epgStrip.innerHTML = `<div class="epg-label">EPG · ${esc(svc.name)}</div><div class="epg-empty">Loading…</div>`;
  try {
    const events = await guideLoad(quickEp, svc.uid);
    if (events) {
      nowNextCache[svc.uid] = events;
      if (!epgCache[svc.uid] && quickEp === svc.epgEndpoint) epgCache[svc.uid] = events;
      if (idx === currentIdx) { DVBIEpg.render(epgStrip, svc.name, events); updateToolbarNow(); }
      updateSidebarNow(idx, events);
      if (epgPanelOpen && idx === currentIdx) refreshEPGPanel();
    }
  } catch (e) {
    if (idx === currentIdx) epgStrip.innerHTML = `<div class="epg-label">EPG · ${esc(svc.name)}</div><div class="epg-empty">EPG unavailable</div>`;
  }
}

async function loadAllEPG() {
  // Use NowNextInfoEndpoint when available per TS 103 770 §6.5.3.2 (cheaper than full schedule for channel list)
  await Promise.allSettled(services.map((svc, i) => {
    const ep = svc.nowNextEndpoint || svc.epgEndpoint;
    if (!ep) return Promise.resolve();
    return guideLoad(ep, svc.uid).then(events => {
      if (events) {
        nowNextCache[svc.uid] = events;
        if (!epgCache[svc.uid] && ep === svc.epgEndpoint) epgCache[svc.uid] = events;
        updateSidebarNow(i, events);
        if (i === currentIdx) DVBIEpg.render(epgStrip, svc.name, events);
      }
    });
  }));
}

// Full schedules for the grid / panel (ScheduleInfoEndpoint). Loads only what is missing.
async function loadFullSchedules() {
  await Promise.allSettled(services.map(svc => {
    if (!svc.epgEndpoint || epgCache[svc.uid]) return Promise.resolve();
    return guideLoad(svc.epgEndpoint, svc.uid).then(events => {
      if (events) epgCache[svc.uid] = events;
    });
  }));
}

// Best available events per service: full schedule if loaded, else now/next.
function bestEpgMap() {
  const m = {};
  for (const s of services) {
    const e = epgCache[s.uid] || nowNextCache[s.uid];
    if (e) m[s.uid] = e;
  }
  return m;
}

function startEPGRefresh() {
  clearInterval(epgTimer);
  let tick = 0;
  epgTimer = setInterval(() => {
    tick++;
    if (tick % 5 === 0) { loadAllEPG(); return; }
    if (currentIdx < 0) return;
    const svc = services[currentIdx];
    const ev  = epgCache[svc?.uid] || nowNextCache[svc?.uid];
    if (ev) { DVBIEpg.render(epgStrip, svc.name, ev); updateToolbarNow(); }
    services.forEach((s, i) => { const e = epgCache[s.uid] || nowNextCache[s.uid]; if (e) updateSidebarNow(i, e); });
  }, 60000);
}

// ── Version polling (TS 103 770 V1.2.1 clauses 4.3.2 and 4.3.3) ────────────────────────────────
//
// The installed list is checked every POLL_INTERVAL, but never before its max-age has passed
// (clause 4.3.2.1); a failure is retried after the wait the HTTP client sets: the back-off of
// clause 4.3.3.7 after 5xx or a connection failure, Retry-After after 401 or 403. After 400 or
// 406 the request is not sent again (clause 4.3.3.2), so polling stops until a list is loaded anew.

function startVersionPolling(url) {
  if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }

  function schedule() {
    const now = Date.now();
    const allowed = dvbiHttp.nextAllowed(url);
    if (allowed === Infinity) { pollTimer = null; return; }
    const wait = allowed > now
      ? allowed - now
      : Math.max(POLL_INTERVAL, dvbiHttp.freshFor(url));
    pollTimer = setTimeout(doPoll, wait);
  }

  async function doPoll() {
    pollTimer = null;
    const r = await dvbiHttp.get(url, { timeoutMs: 15000 });
    if (r.ok && !r.notModified) {
      const doc = new DOMParser().parseFromString(r.body, 'application/xml');
      const v   = doc.documentElement?.getAttribute('version');
      if (v && v !== currentVersion) {
        const prevUid = currentIdx >= 0 ? services[currentIdx]?.uid : null;
        try {
          installServiceList(url, r.body, r.contentType); // restarts polling
        } catch (e) {
          console.warn('Updated service list could not be installed:', e.message);
          schedule();
          return;
        }
        if (prevUid) {
          const ni = services.findIndex(s => s.uid === prevUid);
          if (ni >= 0) selectService(ni);
        }
        showVersionNotice(`Service list updated (v${v})`);
        return;
      }
    } else if (!r.ok && !r.final && !r.retryAt) {
      // Other failures (404 and the like): no clause sets a wait, so the back-off is used.
      dvbiHttp.backOff(url);
    }
    schedule();
  }

  schedule();
}

function showVersionNotice(msg) {
  const el = document.createElement('div');
  el.className = 'version-notice';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ── Full EPG panel ────────────────────────────────────────────────────────────

function openEPGPanel() {
  if (currentIdx < 0) return;
  epgPanel.hidden  = false;
  epgPanelOpen     = true;
  tbEpgBtn.classList.add('active');
  const svc = services[currentIdx];
  if (svc && !epgCache[svc.uid]) {
    // Full schedule not yet loaded — show now/next while it fetches
    if (nowNextCache[svc.uid]) refreshEPGPanel();
    loadServiceEPG(currentIdx); // will populate epgCache and call refreshEPGPanel when done
  } else {
    refreshEPGPanel();
  }
}

function closeEPGPanel() {
  epgPanel.hidden = true;
  epgPanelOpen    = false;
  tbEpgBtn.classList.remove('active');
}

function refreshEPGPanel() {
  const svc    = services[currentIdx];
  const events = epgCache[svc?.uid] || nowNextCache[svc?.uid];
  if (!events) return;
  epgPanelTitle.textContent = `EPG · ${svc.name}`;
  epgActiveGenre = '';
  buildEPGGenreBar(events);
  const toShow = epgActiveGenre ? events.filter(e => e.genre === epgActiveGenre) : events;
  DVBIEpg.renderFull(epgSchedule, epgDetail, toShow.length ? toShow : events);
}

function navigateEPG(dir) {
  const items = [...epgSchedule.querySelectorAll('.epg-event')];
  if (!items.length) return;
  const selIdx = items.findIndex(el => el.classList.contains('selected'));
  const nextIdx = Math.max(0, Math.min(items.length - 1, selIdx + dir));
  if (nextIdx !== selIdx) items[nextIdx].click();
}

$('epg-panel-close').addEventListener('click', closeEPGPanel);
tbEpgBtn.addEventListener('click', () => epgPanelOpen ? closeEPGPanel() : openEPGPanel());

// ── EPG Grid panel ────────────────────────────────────────────────────────────

function renderEPGGrid() {
  DVBIEpg.renderGrid(
    epgGridInner, services, bestEpgMap(),
    uid => {
      const idx = services.findIndex(s => s.uid === uid);
      if (idx >= 0) { closeEPGGrid(); selectService(idx); }
    },
    ev => {
      epgGridInfo.hidden = false;
      epgGridInfo.innerHTML =
        `<strong>${esc(ev.title)}</strong> <span style="color:var(--text-2)">${esc(ev.time)}</span>` +
        (ev.catchupUrl
          ? ` <button class="catchup-btn" style="margin-left:0.5rem" onclick="closeEPGGrid();playCatchup(${esc(JSON.stringify(ev.catchupUrl))})">&#9654; Watch again</button>`
          : '');
    }
  );
}

async function openEPGGrid() {
  epgGridPanel.hidden = false;
  epgGridOpen = true;
  tbGridBtn.classList.add('active');
  epgGridInfo.hidden = true;
  // Render immediately with whatever is cached (now/next or full), then fill in full schedules
  renderEPGGrid();
  await loadFullSchedules();
  if (epgGridOpen) renderEPGGrid();
}

function closeEPGGrid() {
  epgGridPanel.hidden = true;
  epgGridOpen = false;
  tbGridBtn.classList.remove('active');
  epgGridInfo.hidden = true;
}

$('epg-grid-close').addEventListener('click', closeEPGGrid);
tbGridBtn.addEventListener('click', () => epgGridOpen ? closeEPGGrid() : openEPGGrid());

// ── Channel sharing ───────────────────────────────────────────────────────────

function shareChannel() {
  const params = new URLSearchParams();
  params.set('url', currentListUrl);
  if (currentIdx >= 0 && services[currentIdx]?.lcn != null) {
    params.set('ch', String(services[currentIdx].lcn));
  }
  const link = `${window.location.origin}${window.location.pathname}?${params.toString()}`;
  navigator.clipboard.writeText(link)
    .then(() => showVersionNotice('Share link copied to clipboard'))
    .catch(() => { showVersionNotice('Could not copy: ' + link); });
}

tbShareBtn.addEventListener('click', shareChannel);

// ── Settings panel ────────────────────────────────────────────────────────────

function toggleSettings() {
  const open = settingsPanel.classList.toggle('open');
  settingsBtn.classList.toggle('active', open);
}

settingsBtn.addEventListener('click', toggleSettings);

searchInput.addEventListener('input', applyFilters);

// ── Tracks panel ──────────────────────────────────────────────────────────────

let tracksPanelOpen = false;

function openTracksPanel() {
  refreshTracksPanel();
  tracksPanel.hidden = false;
  tracksPanelOpen = true;
  tbTracksBtn.classList.add('active');
}

function closeTracksPanel() {
  tracksPanel.hidden = true;
  tracksPanelOpen = false;
  tbTracksBtn.classList.remove('active');
}

function refreshTracksPanel() {
  const { audio, text } = DVBIPlayer.getTracks();

  tracksAudio.innerHTML = audio.length
    ? audio.map(t => `<button class="track-btn${t.current ? ' active' : ''}" aria-pressed="${t.current}" onclick="selectAudioTrack(${t.idx})">${esc(t.label)}</button>`).join('')
    : '<span class="tracks-empty">No audio tracks detected</span>';

  const offBtn = `<button class="track-btn${text.every(t => !t.current) ? ' active' : ''}" aria-pressed="${text.every(t => !t.current)}" onclick="selectSubTrack(-1)">Off</button>`;
  tracksText.innerHTML = text.length
    ? offBtn + text.map(t => `<button class="track-btn${t.current ? ' active' : ''}" aria-pressed="${t.current}" onclick="selectSubTrack(${t.idx})">${esc(t.label)}</button>`).join('')
    : '<span class="tracks-empty">No subtitle tracks detected</span>';

  // Subtitle carriage note (A184r2 §4.9) — shows how subtitles are delivered
  const inst = currentIdx >= 0 ? services[currentIdx]?.instances?.[currentInstIdx] : null;
  const carriage = inst?.subtitleCarriage;
  const CARRIAGE_LABELS = { '1': 'Application subtitles', '2': 'In MPEG-2 TS', '3': 'In-stream (ISOBMFF/DASH)', '4': 'Standalone resource', '5': 'Open / in-video', '99': 'Other' };
  if (carriage && CARRIAGE_LABELS[carriage]) {
    carriageNote.textContent = CARRIAGE_LABELS[carriage];
    carriageNote.hidden = false;
  } else {
    carriageNote.hidden = true;
  }
}

function selectAudioTrack(idx) {
  DVBIPlayer.setAudioTrack(idx);
  setTimeout(refreshTracksPanel, 120);
}

function selectSubTrack(idx) {
  DVBIPlayer.setSubtitleTrack(idx);
  setTimeout(refreshTracksPanel, 120);
}

tbTracksBtn.addEventListener('click', () => tracksPanelOpen ? closeTracksPanel() : openTracksPanel());

// A184r2 §5.3 — pass CMCD session ID to linked app as URL query parameter
function openLinkedApp(url) {
  if (!url) return;
  try {
    const u = new URL(url, location.href);
    // Only http(s): a linked-app URL comes from external XML; never open javascript:/data: etc.
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      console.warn('Refusing to open linked app with non-http(s) scheme:', u.protocol);
      return;
    }
    u.searchParams.set('sid', CMCD_SESSION_ID);
    window.open(u.toString(), '_blank', 'noopener,noreferrer');
  } catch (_) {
    // Unparseable URL — do not fall back to window.open(raw), which could be a javascript: URL
  }
}

tbAppBtn.addEventListener('click', () => openLinkedApp(tbAppBtn.dataset.url));

function autoSelectLang() {
  if (!langPref) return;
  const { audio } = DVBIPlayer.getTracks();
  if (!audio.length) return;
  const match = audio.find(t => t.lang && t.lang.toLowerCase().startsWith(langPref.toLowerCase()) && !t.current);
  if (match) {
    DVBIPlayer.setAudioTrack(match.idx);
    if (tracksPanelOpen) setTimeout(refreshTracksPanel, 120);
  }
}

// ── SLR lookup ────────────────────────────────────────────────────────────────

// Collect elements by local name in any namespace. A registry response spans three namespaces:
// ServiceListEntryPoints and ProviderOffering are in servicelistdiscovery, while the children of
// ServiceListOffering are in servicediscovery-types, because that element carries a type defined
// in the other schema. Matching on local name keeps this working across all of them, and across
// the namespace years a registry may still be publishing.
function byLocalName(node, name) {
  return Array.from(node.getElementsByTagNameNS('*', name));
}

// A conformant registry answers with ServiceListEntryPoints, as specified by TS 103 770 V1.2.1
// clause 5.1.3.2 and the schema shipped with it: ProviderOffering* each holding ServiceListOffering*
// with ServiceListName and ServiceListURI. Parsed here separately from the older shape below,
// which some deployed registries return instead.
function parseEntryPoints(doc) {
  const entries = [];
  for (const offering of byLocalName(doc, 'ServiceListOffering')) {
    const urls = [];
    const seen = new Set();
    for (const uriEl of byLocalName(offering, 'ServiceListURI')) {
      // ServiceListURI wraps the address in a URI child; older shapes put it in the text.
      const inner = byLocalName(uriEl, 'URI')[0];
      const url = (inner ? inner.textContent : uriEl.textContent).trim();
      if (url && !seen.has(url)) { seen.add(url); urls.push(url); }
    }
    if (!urls.length) continue;
    let name = (byLocalName(offering, 'ServiceListName')[0] || {}).textContent || '';
    name = name.trim();
    if (!name) {
      // Fall back to the provider's name, which sits alongside the offerings rather than inside one.
      let node = offering.parentElement;
      while (node && !name) {
        const provider = byLocalName(node, 'Provider')[0];
        if (provider) name = (byLocalName(provider, 'Name')[0] || {}).textContent?.trim() || '';
        node = node.parentElement;
      }
    }
    entries.push({ name: name || urls[0], urls });
  }
  return entries.length ? entries : null;
}

function parseSLRResponse(doc) {
  const root = doc.documentElement;
  if (!root) return null;
  const localName = (root.localName || root.tagName).split(':').pop();
  if (localName === 'ServiceListEntryPoints') return parseEntryPoints(doc);
  if (localName !== 'ProviderOffering') return null;

  // Detect the servicediscovery namespace from the root — registries may use 2019/2021, not just
  // 2024. Shadows the module-level NS so every lookup below resolves against the right version.
  const NS = (root.namespaceURI || '').startsWith('urn:dvb:metadata:servicediscovery:')
    ? root.namespaceURI : 'urn:dvb:metadata:servicediscovery:2024';

  // Group URIs by parent ServiceList element so multiple URIs = fallbacks for same list (TS 103 770 §4.3.3.3-6)
  const entries = [];
  const slEls = doc.getElementsByTagNameNS(NS, 'ServiceList');
  if (slEls.length) {
    for (const sl of slEls) {
      const urls = [];
      const seen = new Set();
      for (const uriEl of sl.getElementsByTagNameNS(NS, 'ServiceListURI')) {
        const url = uriEl.textContent.trim();
        if (url && !seen.has(url)) { seen.add(url); urls.push(url); }
      }
      if (!urls.length) continue;
      let name = '';
      const nameEl = sl.getElementsByTagNameNS(NS, 'ServiceListName')[0]
                  || sl.getElementsByTagNameNS(NS, 'ProviderName')[0];
      if (nameEl) name = nameEl.textContent.trim();
      if (!name) {
        let node = sl.parentElement;
        while (node && !name) {
          const ne = node.getElementsByTagNameNS(NS, 'ProviderName')[0];
          if (ne) name = ne.textContent.trim();
          node = node.parentElement;
        }
      }
      entries.push({ name: name || urls[0], urls });
    }
  } else {
    // Flat fallback: each ServiceListURI is its own entry
    const seen = new Set();
    for (const uriEl of doc.getElementsByTagNameNS(NS, 'ServiceListURI')) {
      const url = uriEl.textContent.trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      entries.push({ name: url, urls: [url] });
    }
  }
  return entries.length ? entries : null;
}

function showSLRPicker(entries) {
  const container = $('slr-results');
  container.innerHTML = '';
  const label = document.createElement('div');
  label.className = 'settings-label';
  label.style.marginTop = '0.2rem';
  label.textContent = `Found ${entries.length} service lists — select one:`;
  container.appendChild(label);
  for (const entry of entries) {
    const btn = document.createElement('button');
    btn.className = 'preset-btn';
    btn.textContent = entry.name;
    btn.title = entry.urls.join(' → ');
    btn.style.textAlign = 'left';
    btn.addEventListener('click', () => {
      container.hidden = true;
      container.innerHTML = '';
      settingsPanel.classList.remove('open');
      settingsBtn.classList.remove('active');
      loadServiceList(entry.urls); // pass all URLs for fallback
    });
    container.appendChild(btn);
  }
  container.hidden = false;
}

$('slr-load-btn').addEventListener('click', async () => {
  const cc = $('slr-input').value.trim().toUpperCase();
  if (!cc) return;
  // Which registry to ask is a deployment choice, not something to hard-code: a manufacturer, a
  // regulator, an operator and a central registry are all named as possible operators in
  // TS 103 770 V1.2.1 clause 5.1.3.2. The default keeps the public registry this shipped with.
  const endpoint = ($('slr-endpoint').value || '').trim() || DEFAULT_REGISTRY;
  localStorage.setItem('dvbi-slr-endpoint', endpoint);
  const sep = endpoint.includes('?') ? '&' : '?';
  const registryUrl = `${endpoint}${sep}TargetCountry=${encodeURIComponent(cc)}`;
  const resultsEl = $('slr-results');
  resultsEl.hidden = true;
  resultsEl.innerHTML = '';
  listNameEl.textContent = 'Looking up SLR…';
  try {
    const r = await dvbiHttp.get(registryUrl);
    if (!r.ok) throw new Error(failureText(r));
    const doc = new DOMParser().parseFromString(r.body, 'application/xml');
    const entries = parseSLRResponse(doc);
    if (entries) {
      if (entries.length === 1) {
        settingsPanel.classList.remove('open');
        settingsBtn.classList.remove('active');
        loadServiceList(entries[0].urls); // pass all fallback URLs
      } else {
        listNameEl.textContent = 'Select a service list';
        showSLRPicker(entries);
      }
    } else {
      // Might already be a direct service list
      settingsPanel.classList.remove('open');
      settingsBtn.classList.remove('active');
      loadServiceList(registryUrl);
    }
  } catch (err) {
    listNameEl.textContent = 'SLR lookup failed';
    console.error('SLR error:', err);
  }
});

$('url-load-btn').addEventListener('click', () => {
  const url = urlInput.value.trim();
  if (url) { settingsPanel.classList.remove('open'); settingsBtn.classList.remove('active'); loadServiceList(url); }
});

$('lang-pref').value = langPref;
$('lang-pref').addEventListener('change', () => {
  langPref = $('lang-pref').value;
  localStorage.setItem('dvbi-lang-pref', langPref);
  autoSelectLang();
});

$('region-filter').value = regionFilter;
$('region-apply-btn').addEventListener('click', () => {
  regionFilter = $('region-filter').value.trim().toUpperCase();
  localStorage.setItem('dvbi-region', regionFilter);
  // rebuildLCNs() re-sorts services in place, so remember the playing service and
  // recompute currentIdx by UID afterwards, else the UI desyncs from the active stream.
  const activeUid = currentIdx >= 0 ? services[currentIdx]?.uid : null;
  if (!isCustomListActive) rebuildLCNs(); // reassign LCNs from region-matching LCNTable (A184r2 §4.8)
  if (activeUid) currentIdx = services.findIndex(s => s.uid === activeUid);
  renderChannelList();
  applyFilters();
  // renderChannelList() rebuilds the cards without the active class — re-apply it
  document.querySelectorAll('.ch-card').forEach(el => el.classList.toggle('active', parseInt(el.dataset.idx, 10) === currentIdx));
});
$('region-filter').addEventListener('keydown', e => { if (e.key === 'Enter') $('region-apply-btn').click(); });

urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') $('url-load-btn').click(); });

document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    urlInput.value = btn.dataset.url;
    $('url-load-btn').click();
  });
});

// ── Shortcuts overlay ─────────────────────────────────────────────────────────

shortcutsOverlay.addEventListener('click', e => {
  if (e.target === shortcutsOverlay) shortcutsOverlay.hidden = true;
});

// ── LCN digit input ───────────────────────────────────────────────────────────

function handleLCNDigit(digit) {
  lcnBuffer += digit;
  clearTimeout(lcnTimer);
  lcnOverlayNum.textContent = lcnBuffer;
  lcnOverlay.hidden = false;
  lcnTimer = setTimeout(() => {
    const lcn = parseInt(lcnBuffer, 10);
    const idx = services.findIndex((s, i) => {
      if (s.lcn !== lcn) return false;
      const card = channelList.querySelector(`.ch-card[data-idx="${i}"]`);
      return card && !card.hidden;
    });
    if (idx >= 0) selectService(idx);
    lcnBuffer = '';
    lcnOverlay.hidden = true;
  }, 1500);
}

// ── Keyboard navigation ───────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  // PIN modal intercepts digit keys, Backspace, and Escape
  if (!pinModal.hidden) {
    if (/^[0-9]$/.test(e.key)) { e.preventDefault(); pinDigit(e.key); }
    else if (e.key === 'Backspace') { e.preventDefault(); pinDelete(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelPin(); }
    return;
  }

  // Shortcuts overlay takes priority
  if (!shortcutsOverlay.hidden) {
    if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); shortcutsOverlay.hidden = true; }
    return;
  }

  if (epgGridOpen) {
    if (e.key === 'Escape' || e.key === 'g' || e.key === 'G') { e.preventDefault(); closeEPGGrid(); }
    return;
  }

  if (epgPanelOpen) {
    if (e.key === 'Escape' || e.key === 'e' || e.key === 'E') { e.preventDefault(); closeEPGPanel(); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); navigateEPG(-1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); navigateEPG(1); }
    return;
  }

  switch (e.key) {
    case 'ArrowLeft':
      e.preventDefault();
      if (isCatchup) {
        videoEl.currentTime = Math.max(0, videoEl.currentTime - 10);
        showOverlayBriefly(1200);
      } else if (services.length) {
        selectService(nextVisibleIdx(-1));
      }
      break;
    case 'ArrowRight':
      e.preventDefault();
      if (isCatchup) {
        if (isFinite(videoEl.duration)) videoEl.currentTime = Math.min(videoEl.duration, videoEl.currentTime + 10);
        showOverlayBriefly(1200);
      } else if (services.length) {
        selectService(nextVisibleIdx(1));
      }
      break;
    case 'ArrowUp':
      e.preventDefault();
      if (services.length) selectService(nextVisibleIdx(-1));
      break;
    case 'ArrowDown':
      e.preventDefault();
      if (services.length) selectService(nextVisibleIdx(1));
      break;
    case 'e': case 'E':
      e.preventDefault();
      epgPanelOpen ? closeEPGPanel() : openEPGPanel();
      break;
    case 'g': case 'G':
      e.preventDefault();
      epgGridOpen ? closeEPGGrid() : openEPGGrid();
      break;
    case 'm': case 'M':
      e.preventDefault();
      videoEl.muted = !videoEl.muted;
      showOverlayBriefly(1500);
      break;
    case 's': case 'S':
      e.preventDefault();
      toggleSettings();
      break;
    case 'a': case 'A': {
      e.preventDefault();
      const url = tbAppBtn.dataset.url;
      openLinkedApp(url);
      break;
    }
    case 't': case 'T':
      e.preventDefault();
      tracksPanelOpen ? closeTracksPanel() : openTracksPanel();
      break;
    case 'v': case 'V':
      e.preventDefault();
      toggleCurrentFav();
      break;
    case 'p': case 'P':
      e.preventDefault();
      togglePiP();
      break;
    case 'l': case 'L':
      e.preventDefault();
      if (isCatchup) backToLive();
      break;
    case 'f': case 'F':
      e.preventDefault();
      document.fullscreenElement ? document.exitFullscreen() : $('player-wrap').requestFullscreen();
      break;
    case '?':
      e.preventDefault();
      shortcutsOverlay.hidden = false;
      break;
    case 'Escape':
      if (settingsPanel.classList.contains('open')) toggleSettings();
      else if (tracksPanelOpen) closeTracksPanel();
      break;
    default:
      if (/^[0-9]$/.test(e.key)) handleLCNDigit(parseInt(e.key, 10));
  }
});

// ── Custom list / Roaming (A184r2 §4.7) ──────────────────────────────────────

function isInCustomList(uid) { return customList.some(e => e.uid === uid); }

function toggleCustom(uid) {
  const idx = services.findIndex(s => s.uid === uid);
  if (idx < 0) return;
  const svc = services[idx];

  if (isInCustomList(uid)) {
    customList = customList.filter(e => e.uid !== uid);
    if (isCustomListActive) {
      services = customList.map(e => ({ ...e }));
      renderChannelList();
      versionRow.textContent = `${services.length} saved service${services.length !== 1 ? 's' : ''}`;
    }
    showVersionNotice(`Removed "${svc.name}" from custom list`);
  } else {
    // Snapshot the service so it is available independently of the source list
    customList.push({ ...svc, sourceUrl: currentListUrl });
    showVersionNotice(`Added "${svc.name}" to custom list`);
  }
  localStorage.setItem('dvbi-custom', JSON.stringify(customList));
  updateCustomListCount();
  // Refresh custom buttons without full re-render
  document.querySelectorAll('.ch-custom-btn').forEach(btn => {
    const i = parseInt(btn.closest('.ch-card')?.dataset.idx, 10);
    if (isNaN(i)) return;
    const u = services[i]?.uid;
    if (!u) return;
    const inList = isInCustomList(u);
    btn.textContent = inList ? '✓' : '+';
    btn.title = inList ? 'Remove from custom list' : 'Add to custom list';
    btn.classList.toggle('in-custom', inList);
  });
}

function updateCustomListCount() {
  const el = $('custom-list-count');
  if (el) el.textContent = customList.length ? `(${customList.length})` : '(empty)';
}

function clearCustomList() {
  customList = [];
  localStorage.setItem('dvbi-custom', '[]');
  updateCustomListCount();
  if (isCustomListActive) {
    services = [];
    renderChannelList();
    versionRow.textContent = '0 saved services';
  }
  showVersionNotice('Custom list cleared');
}

function loadCustomList() {
  if (!customList.length) {
    showVersionNotice('Custom list is empty — add services using the + button on any channel');
    return;
  }
  settingsPanel.classList.remove('open');
  settingsBtn.classList.remove('active');
  DVBIPlayer.stop();
  if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }
  isCustomListActive = true;
  services = customList.map(e => ({ ...e }));
  rawLCNTables = [];
  currentVersion = null;
  currentIdx = -1;
  epgCache = {}; nowNextCache = {};
  listNameEl.textContent = 'Custom List';
  versionRow.textContent = `${services.length} saved service${services.length !== 1 ? 's' : ''}`;
  renderChannelList();
  loadAllEPG();
  startEPGRefresh();
}

// ── Subscription gate (TS 103 770 §4.3) ──────────────────────────────────────────────────

function showSubGate(uid, onContinue) {
  const svc = services.find(s => s.uid === uid);
  const pkgName = svc?.subscriptionPackage || 'a subscription';
  $('sub-gate-msg').textContent = `This service may require ${pkgName}. It may not play without the appropriate subscription.`;
  $('sub-gate-continue').onclick = () => {
    subGateAcked.add(uid);
    subGateEl.hidden = true;
    onContinue();
  };
  $('sub-gate-cancel').onclick = () => { subGateEl.hidden = true; };
  playError.hidden = true;
  subGateEl.hidden = false;
}

// ── Parental PIN ──────────────────────────────────────────────────────────────

let _pinMode    = 'entry'; // 'entry' | 'setup1' | 'setup2'
let _pinBuffer  = '';
let _pinNew     = '';
let _pinCallback = null;
let _pinUid     = null;

function openPinEntry(uid, onSuccess) {
  if (!pgPin) { onSuccess(); return; }
  _pinMode = 'entry'; _pinBuffer = ''; _pinCallback = onSuccess; _pinUid = uid;
  $('pin-title').textContent = 'Parental Control';
  $('pin-subtitle').textContent = `This channel is rated ${services.find(s => s.uid === uid)?.parentalRating}+. Enter PIN.`;
  $('pin-error').textContent = '';
  updatePinDots();
  pinModal.hidden = false;
  setTimeout(() => pinModal.querySelector('.pin-key[data-d="1"]')?.focus(), 30);
}

function openPinSetup() {
  _pinBuffer = ''; _pinNew = ''; $('pin-error').textContent = '';
  // Changing an existing PIN must require the current one first, else the parental control is
  // trivially bypassable (overwrite PIN -> lower threshold -> unlock everything).
  if (pgPin) {
    _pinMode = 'verifyOld';
    $('pin-title').textContent = 'Change PIN';
    $('pin-subtitle').textContent = 'Enter your current PIN';
  } else {
    _pinMode = 'setup1';
    $('pin-title').textContent = 'Set PIN';
    $('pin-subtitle').textContent = 'Enter a new 4-digit PIN';
  }
  updatePinDots();
  pinModal.hidden = false;
  setTimeout(() => pinModal.querySelector('.pin-key[data-d="1"]')?.focus(), 30);
}

function updatePinDots() {
  const dots = pinModal.querySelectorAll('.pin-dot');
  dots.forEach((d, i) => d.classList.toggle('filled', i < _pinBuffer.length));
}

function pinDigit(d) {
  if (_pinBuffer.length >= 4) return;
  _pinBuffer += d;
  updatePinDots();
  if (_pinBuffer.length === 4) {
    setTimeout(() => {
      if (_pinMode === 'entry') {
        if (_pinBuffer === pgPin) {
          if (_pinUid) pgUnlocked.add(_pinUid);
          pinModal.hidden = true;
          if (_pinCallback) _pinCallback();
        } else {
          $('pin-error').textContent = 'Incorrect PIN. Try again.';
          _pinBuffer = '';
          updatePinDots();
        }
      } else if (_pinMode === 'verifyOld') {
        if (_pinBuffer === pgPin) {
          _pinBuffer = ''; _pinNew = ''; _pinMode = 'setup1';
          $('pin-error').textContent = '';
          $('pin-subtitle').textContent = 'Enter a new 4-digit PIN';
          updatePinDots();
        } else {
          $('pin-error').textContent = 'Incorrect PIN. Try again.';
          _pinBuffer = '';
          updatePinDots();
        }
      } else if (_pinMode === 'setup1') {
        _pinNew = _pinBuffer; _pinBuffer = '';
        _pinMode = 'setup2';
        $('pin-subtitle').textContent = 'Confirm your new PIN';
        $('pin-error').textContent = '';
        updatePinDots();
      } else if (_pinMode === 'setup2') {
        if (_pinBuffer === _pinNew) {
          pgPin = _pinNew;
          localStorage.setItem('dvbi-pg-pin', pgPin);
          $('pg-pin-btn').textContent = 'Change PIN';
          pinModal.hidden = true;
          updatePgWarn();
        } else {
          $('pin-error').textContent = 'PINs do not match. Try again.';
          _pinBuffer = ''; _pinNew = ''; _pinMode = 'setup1';
          $('pin-subtitle').textContent = 'Enter a new 4-digit PIN';
          updatePinDots();
        }
      }
    }, 120);
  }
}

function pinDelete() { if (_pinBuffer.length) { _pinBuffer = _pinBuffer.slice(0, -1); updatePinDots(); } }
function cancelPin() { pinModal.hidden = true; _pinCallback = null; }

pinModal.querySelectorAll('.pin-key[data-d]').forEach(btn => {
  btn.addEventListener('click', () => pinDigit(btn.dataset.d));
});

function updatePgWarn() {
  const w = $('pg-pin-warn');
  if (w) w.hidden = !(pgPin && !pgThreshold);
}

// Parental settings sync
$('pg-threshold').value = pgThreshold || '';
$('pg-threshold').addEventListener('change', () => {
  pgThreshold = parseInt($('pg-threshold').value, 10) || 0;
  localStorage.setItem('dvbi-pg-threshold', String(pgThreshold));
  pgUnlocked.clear();
  renderChannelList();
  document.querySelectorAll('.ch-card').forEach(el => el.classList.toggle('active', parseInt(el.dataset.idx, 10) === currentIdx));
  updatePgWarn();
});
if (pgPin) $('pg-pin-btn').textContent = 'Change PIN';
updatePgWarn();

// ── Favourites keyboard shortcut (V) ─────────────────────────────────────────

function toggleCurrentFav() {
  if (currentIdx < 0) return;
  toggleFav(services[currentIdx].uid);
}

// ── EPG genre filter (full EPG panel) ────────────────────────────────────────

function buildEPGGenreBar(events) {
  const genres = DVBIEpg.getGenres(events);
  if (!genres.length) { epgGenreBar.hidden = true; return; }
  epgGenreBar.hidden = false;
  epgGenreBar.innerHTML = '<button class="epg-genre-pill active" aria-pressed="true" data-genre="">All</button>' +
    genres.map(g => `<button class="epg-genre-pill" aria-pressed="false" data-genre="${esc(g)}">${esc(g.charAt(0).toUpperCase() + g.slice(1))}</button>`).join('');
  epgGenreBar.querySelectorAll('.epg-genre-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      epgActiveGenre = btn.dataset.genre;
      epgGenreBar.querySelectorAll('.epg-genre-pill').forEach(b => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-pressed', String(b === btn));
      });
      const svc    = services[currentIdx];
      const events = epgCache[svc?.uid] || nowNextCache[svc?.uid];
      if (events) {
        const filtered = epgActiveGenre ? events.filter(e => e.genre === epgActiveGenre) : events;
        DVBIEpg.renderFull(epgSchedule, epgDetail, filtered);
      }
    });
  });
}

// ── Now-playing in toolbar ───────────────────────────────────────────────────

function updateToolbarNow() {
  if (currentIdx < 0) { tbNow.hidden = true; return; }
  const svc    = services[currentIdx];
  const events = epgCache[svc?.uid] || nowNextCache[svc?.uid];
  if (!events) { tbNow.hidden = true; return; }
  const { current } = DVBIEpg.getNowNext(events);
  if (current) {
    tbNow.textContent = `· ${current.title}`;
    tbNow.hidden = false;
  } else {
    tbNow.hidden = true;
  }
}

// ── Catch-up playback ────────────────────────────────────────────────────────

function playCatchup(url) {
  if (currentIdx < 0) return;
  if (!/^https?:\/\//i.test(url)) {
    playError.hidden = false;
    playErrorMsg.textContent = 'Invalid catch-up URL';
    return;
  }
  currentSession++;
  const session = currentSession;
  closeEPGPanel();
  isCatchup = true;
  backToLiveBtn.hidden = false;
  const type = /\.mpd(\?|$)/i.test(url) || /[?&].*dash/i.test(url) ? 'application/dash+xml' : 'application/vnd.apple.mpegurl';
  bufSpinner.hidden = false;
  playError.hidden  = true;
  DVBIPlayer.play(videoEl, url, type, null,
    () => { if (session !== currentSession) return; bufSpinner.hidden = true; playError.hidden = false; playErrorMsg.textContent = 'Catch-up stream unavailable'; },
    (buf) => { if (session !== currentSession) return; bufSpinner.hidden = !buf; },
    () => { if (tracksPanelOpen) refreshTracksPanel(); }
  );
}

function backToLive() {
  if (currentIdx >= 0) selectService(currentIdx);
}

// ── Badge tooltips ────────────────────────────────────────────────────────────

const badgeTip = $('badge-tooltip');

document.addEventListener('mouseover', e => {
  const badge = e.target.closest('[data-tooltip]');
  if (!badge) return;
  const text = badge.getAttribute('data-tooltip');
  if (!text) return;
  badgeTip.textContent = text;
  badgeTip.hidden = false;
  positionBadgeTip(badge);
});

document.addEventListener('mouseout', e => {
  if (!e.target.closest('[data-tooltip]')) return;
  badgeTip.hidden = true;
});

document.addEventListener('mousemove', e => {
  if (badgeTip.hidden) return;
  const badge = e.target.closest('[data-tooltip]');
  if (badge) positionBadgeTip(badge);
  else badgeTip.hidden = true;
});

function positionBadgeTip(badge) {
  const r   = badge.getBoundingClientRect();
  const tw  = badgeTip.offsetWidth  || 200;
  const th  = badgeTip.offsetHeight || 30;
  const gap = 8;
  let top  = r.top - th - gap;
  let left = r.left + r.width / 2 - tw / 2;
  // Keep within viewport
  if (top < 4) top = r.bottom + gap;
  left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
  badgeTip.style.top  = `${top}px`;
  badgeTip.style.left = `${left}px`;
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

(function parseURLParams() {
  const params = new URLSearchParams(window.location.search);
  const pUrl = params.get('url');
  const pCh  = params.get('ch');
  if (pUrl) { currentListUrl = pUrl; localStorage.setItem('dvbi-url', pUrl); }
  if (pCh)  window._pendingCh = parseInt(pCh, 10) || null;
})();

// Fixed-time nightly service list update (A184r2 §4.11) — runs at 03:00 local time
function scheduleNightlyUpdate() {
  const now   = new Date();
  const next  = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 3, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(() => {
    if (currentListUrl) {
      epgCache = {}; nowNextCache = {};
      loadServiceList(currentListUrl).then(() => showVersionNotice('Scheduled service list refresh'));
    }
    scheduleNightlyUpdate();
  }, next - now);
}
scheduleNightlyUpdate();
updateCustomListCount();

{
  const saved = localStorage.getItem('dvbi-slr-endpoint');
  const el = $('slr-endpoint');
  if (el) el.value = saved || DEFAULT_REGISTRY;
}
urlInput.value = currentListUrl;
loadServiceList(currentListUrl).then(() => {
  startEPGRefresh();
  if (window._pendingCh) {
    const idx = services.findIndex(s => s.lcn === window._pendingCh);
    if (idx >= 0) selectService(idx);
    window._pendingCh = null;
  }
});
