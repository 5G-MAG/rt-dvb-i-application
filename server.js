const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const http    = require('http');
const https   = require('https');
const dns     = require('dns').promises;
const net     = require('net');

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

// Dev-only escape hatch: when both the admin tool and the receiver run on localhost/LAN (the
// normal local testing setup), the SSRF guard correctly refuses to proxy to a loopback/private
// address. Setting ALLOW_LOOPBACK_PROXY=1 disables that check so local testing works. Never set
// this in a deployment reachable from untrusted networks — it defeats the SSRF protection.
const ALLOW_LOOPBACK_PROXY = process.env.ALLOW_LOOPBACK_PROXY === '1';

async function assertSafeUrl(rawUrl) {
  const u = new URL(rawUrl); // throws on invalid
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http/https URLs are allowed');
  if (ALLOW_LOOPBACK_PROXY) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map(a => a.address);
  if (!addrs.length || addrs.some(isPrivateIp)) throw new Error('URL resolves to a disallowed (private/loopback) address');
  return u;
}

// CORS proxy — lets the browser load any DVB-I service list URL
app.get('/proxy', rateLimit('proxy', 60, 60000), async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });
  try {
    await assertSafeUrl(url);
  } catch (e) { return res.status(400).json({ error: String(e.message || e) }); }
  try {
    const upstream = await fetch(url, {
      headers: { 'User-Agent': 'DVBIReceiver/1.0', Accept: 'application/xml,*/*' },
    });
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/xml');
    res.send(await upstream.text());
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
  if (ALLOW_LOOPBACK_PROXY) {
    logger.warn('ALLOW_LOOPBACK_PROXY=1 — /proxy SSRF guard is DISABLED. Dev/local-testing only; never set this in a deployment reachable from untrusted networks.');
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

module.exports = { app, startServer, isPrivateIp, assertSafeUrl };
