// HTTP behaviour towards DVB-I endpoints, ETSI TS 103 770 V1.2.1 clause 4.3 (and clause 6.2.3 and
// 6.2.4, which refer to it for content guide requests).
//
//   4.3.2.1  Cache-Control: max-age is honoured per response: a repeated request is answered from the
//            local cache while the response is fresh, and no update is requested before it expires.
//   4.3.2.2  If-Modified-Since carries the Last-Modified time held for that document, and is omitted
//            when none is held; a 304 keeps the cached body.
//   4.3.3.2  After 400 or 406 the same request is not sent again.
//   4.3.3.3  After 401 or 403 the request is not sent again before the Retry-After period. How to
//            re-authenticate is outside the scope of the clause, and this client has no credentials.
//   4.3.3.5  After 500, 502, 504 or a connection failure the request is not sent again before the
//            back-off wait of clause 4.3.3.7.
//   4.3.3.7  minwait = 4^(CurrentRetry-1) x 100 ms, maxwait = 4^CurrentRetry x 100 ms, a random wait
//            between the two, CurrentRetry 1 after the first failure and capped at 10.
//
// The state is per request and held in memory, so it starts empty when the page is loaded, which
// is how this client is restarted (clause 4.3.3.7: "The retry count shall be reset when the device
// is powered off or restarted and does not need to be persisted.").
const DVBIHttp = (() => {
  const BACKOFF_UNIT_MS   = 100; // clause 4.3.3.7
  const BACKOFF_MAX_RETRY = 10;  // clause 4.3.3.7

  // Bounds of the random wait before a retry, clause 4.3.3.7. `retry` is CurrentRetry.
  function backoffRange(retry) {
    const r = Math.min(Math.max(1, Math.floor(retry) || 1), BACKOFF_MAX_RETRY);
    return { min: Math.pow(4, r - 1) * BACKOFF_UNIT_MS, max: Math.pow(4, r) * BACKOFF_UNIT_MS };
  }

  function backoffDelay(retry, random = Math.random) {
    const { min, max } = backoffRange(retry);
    return min + random() * (max - min);
  }

  // max-age of a Cache-Control response header in milliseconds, or null when absent. RFC 9111
  // clause 5.2.2.1 gives the argument as delta-seconds in token form; any other form is ignored.
  function maxAgeMs(cacheControl) {
    if (!cacheControl) return null;
    for (const part of String(cacheControl).split(',')) {
      const m = part.trim().match(/^max-age=(\d+)$/i);
      if (m) return Number(m[1]) * 1000;
    }
    return null;
  }

  // Retry-After in milliseconds from `nowMs`, or null. RFC 9110 clause 10.2.3:
  // Retry-After = HTTP-date / delay-seconds.
  function retryAfterMs(value, nowMs) {
    if (value == null) return null;
    const v = String(value).trim();
    if (/^\d+$/.test(v)) return Number(v) * 1000;
    const t = Date.parse(v);
    return Number.isFinite(t) ? Math.max(0, t - nowMs) : null;
  }

  // A client holds the cache and the retry state for every request it makes.
  //   fetch    the fetch function to use
  //   resolve  maps the endpoint URL to the URL actually requested (for example through a proxy)
  //   now, random  injectable for tests
  function createClient({ fetch, resolve = u => u, now = () => Date.now(), random = Math.random }) {
    const cache = new Map(); // url -> { body, contentType, lastModified, expiresAt }
    const state = new Map(); // key -> { final, notBefore, retry, status }

    function failure(key, status, extra) {
      const s = state.get(key) || { final: false, notBefore: 0, retry: 0, status: 0 };
      s.status = status;
      state.set(key, s);
      return { ok: false, status, ...extra };
    }

    // Applies the back-off of clause 4.3.3.7 to `key`: the next request waits a random period
    // between minwait and maxwait for the current retry count.
    function backOff(key) {
      const s = state.get(key) || { final: false, notBefore: 0, retry: 0, status: 0 };
      s.retry = Math.min(s.retry + 1, BACKOFF_MAX_RETRY);
      s.notBefore = now() + backoffDelay(s.retry, random);
      state.set(key, s);
      return s.notBefore;
    }

    // GET `url`. `key` names the request for the retry state (default: the URL).
    // Resolves to { ok, status, body, contentType, fromCache, notModified, final, retryAt, error,
    // maxAgeMs, expires }.
    async function get(url, { key = url, timeoutMs } = {}) {
      const s = state.get(key);
      if (s && s.final) return { ok: false, status: s.status, final: true, skipped: true };
      if (s && s.notBefore > now()) return { ok: false, status: s.status, retryAt: s.notBefore, skipped: true };

      const cached = cache.get(url);
      if (cached && cached.expiresAt > now()) {
        return { ok: true, status: 200, body: cached.body, contentType: cached.contentType, fromCache: true, notModified: true,
          maxAgeMs: cached.expiresAt - now(), expires: cached.expires };
      }

      const headers = {};
      if (cached && cached.lastModified) headers['If-Modified-Since'] = cached.lastModified;
      const init = { headers, cache: 'no-store' };
      if (timeoutMs) init.signal = AbortSignal.timeout(timeoutMs);

      let res;
      try {
        res = await fetch(resolve(url), init);
      } catch (e) {
        // Connection failure, clause 4.3.3.5.
        failure(key, 0);
        return { ok: false, status: 0, error: String(e && e.message || e), retryAt: backOff(key) };
      }

      const maxAge = maxAgeMs(res.headers.get('Cache-Control'));
      const expiresAt = maxAge != null ? now() + maxAge : 0;

      const expires = res.headers.get('Expires') || null;
      if (res.status === 304 && cached) {
        cached.expiresAt = expiresAt;
        cached.expires = expires;
        const lm = res.headers.get('Last-Modified');
        if (lm) cached.lastModified = lm;
        state.delete(key);
        return { ok: true, status: 304, body: cached.body, contentType: cached.contentType, notModified: true, maxAgeMs: maxAge, expires };
      }

      if (res.ok) {
        const body = await res.text();
        const contentType = res.headers.get('Content-Type') || '';
        cache.set(url, { body, contentType, lastModified: res.headers.get('Last-Modified') || null, expiresAt, expires });
        state.delete(key);
        // maxAgeMs and expires are passed on for callers with their own expiry rule (clause 5.2.4.4.5).
        return { ok: true, status: res.status, body, contentType, maxAgeMs: maxAge, expires };
      }

      const errorBody = await res.text().catch(() => '');
      const extra = { body: errorBody, contentType: res.headers.get('Content-Type') || '' };
      switch (res.status) {
        case 400: case 406: {
          const r = failure(key, res.status, { ...extra, final: true });
          state.get(key).final = true;
          return r;
        }
        case 401: case 403: {
          const wait = retryAfterMs(res.headers.get('Retry-After'), now());
          const r = failure(key, res.status, extra);
          if (wait != null) { state.get(key).notBefore = now() + wait; r.retryAt = now() + wait; }
          return r;
        }
        case 500: case 502: case 504: {
          const r = failure(key, res.status, extra);
          r.retryAt = backOff(key);
          return r;
        }
        default:
          return failure(key, res.status, extra);
      }
    }

    // Milliseconds until the cached response for `url` expires; 0 when it has no max-age or is stale.
    function freshFor(url) {
      const c = cache.get(url);
      return c ? Math.max(0, c.expiresAt - now()) : 0;
    }

    // When the request named `key` may next be sent (0 when it may be sent now), or Infinity
    // after a 400 or 406.
    function nextAllowed(key) {
      const s = state.get(key);
      if (!s) return 0;
      return s.final ? Infinity : s.notBefore;
    }

    return { get, backOff, freshFor, nextAllowed };
  }

  return { backoffRange, backoffDelay, maxAgeMs, retryAfterMs, createClient };
})();

// Exposed for Node-based unit tests (test/dvbi-http.test.js). `module` is undefined when loaded via
// a <script> tag in the browser, so this is a no-op there.
if (typeof module !== 'undefined' && module.exports) module.exports = DVBIHttp;
