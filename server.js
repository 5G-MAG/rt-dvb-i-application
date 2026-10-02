const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const http    = require('http');
const https   = require('https');
const dns     = require('dns').promises;
const net     = require('net');
const os      = require('os');

const app  = express();
const PORT = process.env.PORT || 5000;

// ── Structured logging ───────────────────────────────────────────────────────
// Minimal JSON-lines logger (no dependency): one object per line with time/level/msg/meta,
// suitable for ingestion by any log collector. LOG_LEVEL defaults to 'info'.
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const LOG_LEVEL  = LOG_LEVELS[process.env.LOG_LEVEL] !== undefined ? process.env.LOG_LEVEL : 'info';
function _log(level, msg, meta) {
  if (LOG_LEVELS[level] > LOG_LEVELS[LOG_LEVEL]) return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...(meta || {}) });
  (level === 'error' ? console.error : console.log)(line);
}
const logger = {
  error: (msg, meta) => _log('error', msg, meta),
  warn:  (msg, meta) => _log('warn', msg, meta),
  info:  (msg, meta) => _log('info', msg, meta),
  debug: (msg, meta) => _log('debug', msg, meta),
};

app.use(cors());
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => logger.info('request', {
    method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start, ip: req.ip,
  }));
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Small in-memory fixed-window limiter per (ip, bucket). The /proxy endpoint fans out to
// arbitrary hosts (SSRF-guarded, but still a fetch amplifier), so it gets its own bucket.
const _rateBuckets = new Map();
function rateLimit(bucket, max, windowMs) {
  return (req, res, next) => {
    const key = `${bucket}:${req.ip}`;
    const now = Date.now();
    let b = _rateBuckets.get(key);
    if (!b || now >= b.resetAt) { b = { count: 0, resetAt: now + windowMs }; _rateBuckets.set(key, b); }
    b.count++;
    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(Math.max(0, max - b.count)));
    if (b.count > max) {
      res.set('Retry-After', String(Math.ceil((b.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests' });
    }
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, b] of _rateBuckets) if (now >= b.resetAt) _rateBuckets.delete(k); }, 60000).unref();

// SSRF guard: reject URLs that resolve to private/loopback/link-local ranges so the proxy
// cannot be used to reach internal services or cloud metadata (169.254.169.254).
function isPrivateIp(ip) {
  if (ip.startsWith('::ffff:')) ip = ip.slice(7); // IPv4-mapped IPv6
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;            // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT
    return false;
  }
  const l = ip.toLowerCase();
  if (l === '::1' || l === '::') return true;
  if (l.startsWith('fe80')) return true;                // link-local
  if (l.startsWith('fc') || l.startsWith('fd')) return true; // unique-local fc00::/7
  return false;
}

// When the service list is published on the same machine (the normal local testing setup) the
// SSRF guard correctly refuses to proxy to a loopback or private address. PROXY_ALLOW_ORIGINS
// names the specific origins that may be proxied anyway, comma separated and matched exactly on
// scheme, host and port:
//
//   PROXY_ALLOW_ORIGINS="http://localhost:4000,http://127.0.0.1:4000"
//
// Everything not named stays guarded, so this permits one known service list rather than turning
// the protection off. Note that an allowlisted origin skips the address check by design, so a
// hostname that later resolves elsewhere would be followed: name origins you control.
const PROXY_ALLOW_ORIGINS = new Set(
  (process.env.PROXY_ALLOW_ORIGINS || '')
    .split(',')
    .map(o => o.trim().replace(/\/+$/, ''))
    .filter(Boolean)
    .map(o => { try { return new URL(o).origin; } catch { return o; } })
);

async function resolveHost(u) {
  const host = u.hostname.replace(/^\[|\]$/g, '');
  return net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map(a => a.address);
}

async function assertSafeUrl(rawUrl) {
  const u = new URL(rawUrl); // throws on invalid
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http/https URLs are allowed');
  if (PROXY_ALLOW_ORIGINS.has(u.origin)) return u;
  const addrs = await resolveHost(u);
  if (!addrs.length || addrs.some(isPrivateIp)) throw new Error('URL resolves to a disallowed (private/loopback) address');
  return u;
}

// ── HTTP over TLS (ETSI TS 103 770 V1.2.1 clause 7.3) ─────────────────────────────────────────
// "All HTTP transactions and connections between the DVB-I client and DVB-I metadata endpoints
// [...] shall be performed using HTTP over TLS", except PRIVATE_SUBNET_EXCEPTION below. This server
// makes those connections for the browser. An http:// endpoint is fetched, and every plain HTTP hop
// is logged as a warning that quotes the exception and says whether every address the endpoint
// resolves to lies in one of the three RFC 1918 clause 3 blocks and in the subnet of one of this
// host's own interfaces. Loopback (127.0.0.0/8) is not one of those blocks. The browser shows the
// same warning beside the service list (public/app.js, showTlsWarning).
const PRIVATE_SUBNET_EXCEPTION = 'For the specific case that a DVB-I client connects to a DVB-I metadata ' +
  'endpoint located on the same private subnet (see clause 3 of IETF RFC 1918 [27]), HTTP may be used without TLS.';
const RFC1918_BLOCKS = [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16]];

function ipv4ToInt(ip) {
  return ip.split('.').reduce((n, part) => (n * 256) + Number(part), 0);
}

function inPrefix(ip, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((ipv4ToInt(ip) & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0);
}

function isRfc1918(ip) {
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return net.isIPv4(ip) && RFC1918_BLOCKS.some(([base, bits]) => inPrefix(ip, base, bits));
}

// True when `ip` is an RFC 1918 address in the subnet of one of the given interfaces
// (the shape of os.networkInterfaces()).
function onSamePrivateSubnet(ip, interfaces = os.networkInterfaces()) {
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (!isRfc1918(ip)) return false;
  for (const list of Object.values(interfaces)) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (!isRfc1918(a.address)) continue;
      const bits = Number(String(a.cidr || '').split('/')[1]);
      if (Number.isInteger(bits) && inPrefix(ip, a.address, bits)) return true;
    }
  }
  return false;
}

// For an http:// URL, the warning logged before it is fetched: the request is not over TLS, with
// whether the clause 7.3 exception covers the endpoint. null for any other scheme.
async function plainHttpWarning(rawUrl, interfaces) {
  const u = new URL(rawUrl);
  if (u.protocol !== 'http:') return null;
  let addrs = [];
  try { addrs = await resolveHost(u); } catch { /* reported by the fetch itself */ }
  const samePrivateSubnet = addrs.length > 0 && addrs.every(a => onSamePrivateSubnet(a, interfaces));
  return {
    msg: `${u.origin} is fetched with plain HTTP, not over TLS. ETSI TS 103 770 V1.2.1 clause 7.3 ` +
         `requires HTTP over TLS except: "${PRIVATE_SUBNET_EXCEPTION}" ` +
         (samePrivateSubnet ? 'Every address of this endpoint is on this host\'s private subnet.'
                            : 'This endpoint is not on this host\'s private subnet, so the exception does not apply.'),
    url: u.href,
    samePrivateSubnet,
  };
}

async function warnIfPlainHttp(rawUrl) {
  const w = await plainHttpWarning(rawUrl);
  if (w) logger.warn(w.msg, { url: w.url, samePrivateSubnet: w.samePrivateSubnet });
}

// Read a response body with a ceiling on it. Without one, this endpoint reads whatever the
// upstream sends fully into memory before answering, so a single request naming a large or endless
// resource exhausts the process. A service list is metadata: PROXY_MAX_BYTES bounds it generously
// rather than tightly, and a body that exceeds it is refused instead of truncated, because a
// truncated service list is invalid XML and would be reported as a parse error rather than as the
// size limit it is.
const PROXY_MAX_BYTES = Number(process.env.PROXY_MAX_BYTES || 10 * 1024 * 1024);

async function readCapped(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > PROXY_MAX_BYTES) {
    throw new Error(`Response is ${declared} bytes, over the ${PROXY_MAX_BYTES} byte limit`);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > PROXY_MAX_BYTES) {
      throw new Error(`Response exceeded the ${PROXY_MAX_BYTES} byte limit`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Request and response headers the proxy passes through, for the caching and retry rules of
// TS 103 770 V1.2.1 clause 4.3: If-Modified-Since upstream (4.3.2.2); Last-Modified,
// Cache-Control (4.3.2.1) and Retry-After (4.3.3.3) back to the browser, and Expires, which sets
// when a Template XML AIT is refreshed (clause 5.2.4.4.5). If-None-Match upstream and ETag back,
// for clause 7.3.2.6 of ETSI TS 102 796, which clause 4.3.2.1 has the client follow.
const FORWARD_REQUEST_HEADERS  = ['if-modified-since', 'if-none-match'];
const FORWARD_RESPONSE_HEADERS = ['last-modified', 'etag', 'cache-control', 'retry-after', 'expires'];

// Redirects are followed here rather than by fetch, so that every hop passes the same address
// check as the first, and a hop to plain HTTP is logged. The limit is the one fetch applies itself (WHATWG Fetch, HTTP-redirect
// fetch: "If request's redirect count is 20, then return a network error.").
const REDIRECT_LIMIT = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function fetchChecked(url, headers) {
  let current = url;
  for (let hop = 0; ; hop++) {
    await assertSafeUrl(current);
    await warnIfPlainHttp(current);
    const upstream = await fetch(current, { headers, redirect: 'manual' });
    const location = upstream.headers.get('location');
    if (!REDIRECT_STATUSES.has(upstream.status) || !location) return upstream;
    if (hop + 1 >= REDIRECT_LIMIT) throw new Error(`more than ${REDIRECT_LIMIT} redirects`);
    current = new URL(location, current).href;
  }
}

// CORS proxy — lets the browser load any DVB-I service list URL
app.get('/proxy', rateLimit('proxy', 60, 60000), async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });
  try {
    await assertSafeUrl(url);
  } catch (e) { return res.status(400).json({ error: String(e.message || e) }); }
  const headers = { 'User-Agent': 'DVBIReceiver/1.0', Accept: 'application/xml,*/*' };
  for (const h of FORWARD_REQUEST_HEADERS) if (req.get(h)) headers[h] = req.get(h);
  try {
    const upstream = await fetchChecked(url, headers);
    // Relay the upstream status rather than always answering 200. Flattening it hid the real
    // failure: a 404 from the origin arrived as a 200 whose body was an error page, and the
    // caller reported it as unparseable content instead of as the missing document it was.
    res.status(upstream.status);
    for (const h of FORWARD_RESPONSE_HEADERS) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (upstream.status === 304) return res.end();
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/xml');
    // end() rather than send(): send() would answer 304 by itself from the forwarded
    // Last-Modified, which is the origin's decision to make, not this proxy's.
    res.end(await readCapped(upstream));
  } catch (e) {
    logger.warn('proxy fetch failed', { url, error: String(e.message || e) });
    res.status(502).json({ error: String(e) });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── Server startup ────────────────────────────────────────────────────────────
// Optional native HTTPS via HTTPS_KEY_PATH/HTTPS_CERT_PATH (PEM file paths). Falls back to plain
// HTTP if unset — the recommended production pattern is TLS termination at a reverse proxy
// (see DEPLOYMENT.md), but native HTTPS is supported for standalone deployments.
function startServer() {
  if (PROXY_ALLOW_ORIGINS.size) {
    logger.warn('/proxy will follow these origins without the private-address check', {
      origins: [...PROXY_ALLOW_ORIGINS],
    });
  }
  if (process.env.ALLOW_LOOPBACK_PROXY === '1') {
    // Previously this disabled the guard outright. Ignoring it silently would leave a deployment
    // believing it still had the exemption it asked for, so say what to use instead.
    logger.error('ALLOW_LOOPBACK_PROXY is no longer supported and has been ignored. ' +
                 'Use PROXY_ALLOW_ORIGINS to name the origins that may be proxied, ' +
                 'e.g. PROXY_ALLOW_ORIGINS="http://localhost:4000".');
  }
  const keyPath = process.env.HTTPS_KEY_PATH, certPath = process.env.HTTPS_CERT_PATH;
  if (keyPath && certPath) {
    try {
      const key = fs.readFileSync(keyPath), cert = fs.readFileSync(certPath);
      return https.createServer({ key, cert }, app).listen(PORT, () =>
        logger.info('DVB-I Client listening (https)', { port: PORT }));
    } catch (e) {
      logger.error('Failed to load HTTPS cert/key, falling back to HTTP', { error: String(e.message || e) });
    }
  }
  return http.createServer(app).listen(PORT, () => {
    logger.info('DVB-I Client listening (http)', { port: PORT });
    console.log(`DVB-I Client      →  http://localhost:${PORT}`);
  });
}

if (require.main === module) startServer();

module.exports = { app, startServer, isPrivateIp, assertSafeUrl, isRfc1918, onSamePrivateSubnet, plainHttpWarning };
