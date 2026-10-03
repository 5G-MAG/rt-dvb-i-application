/*
License: 5G-MAG Public License (v1.0)
Authors: Jordi J. Gimenez (5G-MAG)
Copyright: (C) 2026 5G-MAG Association

For full license terms please see the LICENSE file distributed with this
program. If this file is missing then the license can be retrieved from
https://www.5g-mag.com/license
*/
// HTTP behaviour towards DVB-I endpoints, ETSI TS 103 770 V1.2.1 clause 4.3 (and clause 6.2.3 and
// 6.2.4, which refer to it for content guide requests).
//
//   4.3.2.1  Cache-Control: max-age is honoured per response: a repeated request is answered from the
//            local cache while the response is fresh, and no update is requested before it expires.
//   4.3.2.1  also has the client follow clause 7.3.2.6 of ETSI TS 102 796: "the caching rules defined
//            in HTTP/1.1 [6]", where [6] is IETF RFC 7230, which places them in RFC 7234 ("HTTP
//            requirements for cache behavior and cacheable responses are defined in Section 2 of
//            [RFC7234]", RFC 7230 clause 2.4). Of them: a response is stored only as RFC 7234
//            clause 3 allows (never under no-store), and max-age counts from the response's age
//            (clause 4.2.3, with the Age and Date headers), so a response that aged in a cache on
//            the way is not reused for longer than it was meant to be.
//   4.3.2.2  If-Modified-Since carries the Last-Modified time held for that document, and is omitted
//            when none is held; a 304 keeps the cached body.
//   4.3.2.1  also has the client follow clause 7.3.2.6 of ETSI TS 102 796, which adds the
//            If-None-Match header "where a server provides an ETag header": the ETag held for that
//            document is sent as If-None-Match, and omitted when none is held.
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

  // The directive names of a Cache-Control header, lower case, each with its argument or null.
  function directives(cacheControl) {
    return String(cacheControl || '').split(',').map(p => p.trim()).filter(Boolean).map(p => {
      const eq = p.indexOf('=');
      return eq < 0 ? [p.toLowerCase(), null] : [p.slice(0, eq).trim().toLowerCase(), p.slice(eq + 1).trim()];
    });
  }

  // max-age of a Cache-Control response header in milliseconds, or null when absent or invalid.
  // RFC 7234 clause 5.2.2.8 gives the argument as delta-seconds in token form ("'max-age=5' not
  // 'max-age="5"'"); any other form is ignored. Clause 4.2.1: "When there is more than one value
  // present for a given directive (e.g., two Expires header fields, multiple Cache-Control: max-age
  // directives), the directive's value is considered invalid." Such a response is then stale, as
  // the same clause encourages.
  function maxAgeMs(cacheControl) {
    const values = directives(cacheControl).filter(([name]) => name === 'max-age');
    if (values.length !== 1 || !/^\d+$/.test(values[0][1] || '')) return null;
    return Number(values[0][1]) * 1000;
  }

  // RFC 7234 clause 5.2.2.3: "The "no-store" response directive indicates that a cache MUST NOT
  // store any part of either the immediate request or response."
  function noStore(cacheControl) {
    return directives(cacheControl).some(([name]) => name === 'no-store');
  }

  // RFC 7234 clause 3: a response is stored only if it "contains an Expires header field", "contains
  // a max-age response directive", "has a status code that is defined as cacheable by default", or
  // "contains a public response directive". RFC 7231 clause 6.1: "200, 203, 204, 206, 300, 301, 404,
  // 405, 410, 414, and 501" are cacheable by default; of them, only the 2xx ones are stored here.
  const CACHEABLE_BY_DEFAULT = [200, 203, 204, 206];
  function storable(status, cacheControl, expires) {
    if (noStore(cacheControl)) return false;
    return CACHEABLE_BY_DEFAULT.includes(status) || expires != null || maxAgeMs(cacheControl) != null ||
      directives(cacheControl).some(([name]) => name === 'public');
  }

  // corrected_initial_age of RFC 7234 clause 4.2.3, in milliseconds:
  //   apparent_age = max(0, response_time - date_value);
  //   response_delay = response_time - request_time;
  //   corrected_age_value = age_value + response_delay;
  //   corrected_initial_age = max(apparent_age, corrected_age_value);
  // age_value is the Age header "or 0, if not available"; a Date that cannot be parsed gives no
  // apparent age.
  function initialAgeMs({ age, date, requestTime, responseTime }) {
    const ageValue = /^\d+$/.test(String(age ?? '').trim()) ? Number(String(age).trim()) * 1000 : 0;
    const dateValue = date ? Date.parse(date) : NaN;
    const apparentAge = Number.isFinite(dateValue) ? Math.max(0, responseTime - dateValue) : 0;
    return Math.max(apparentAge, ageValue + (responseTime - requestTime));
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
    const cache = new Map(); // url -> { body, contentType, lastModified, etag, expiresAt }
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
      if (cached && cached.etag) headers['If-None-Match'] = cached.etag;
      const init = { headers, cache: 'no-store' };
      if (timeoutMs) init.signal = AbortSignal.timeout(timeoutMs);

      let res;
      const requestTime = now();
      try {
        res = await fetch(resolve(url), init);
      } catch (e) {
        // Connection failure, clause 4.3.3.5.
        failure(key, 0);
        return { ok: false, status: 0, error: String(e && e.message || e), retryAt: backOff(key) };
      }

      // RFC 7234 clause 4.2: "response_is_fresh = (freshness_lifetime > current_age)", with
      // max-age as the lifetime ("considered stale after its age is greater than the specified
      // number of seconds", clause 5.2.2.8). maxAge below is what is left of it on arrival.
      const responseTime = now();
      const cacheControl = res.headers.get('Cache-Control');
      const lifetime = maxAgeMs(cacheControl);
      const maxAge = lifetime == null ? null : Math.max(0, lifetime - initialAgeMs({
        age: res.headers.get('Age'), date: res.headers.get('Date'), requestTime, responseTime }));
      const expiresAt = maxAge != null ? responseTime + maxAge : 0;

      const expires = res.headers.get('Expires') || null;
      if (res.status === 304 && cached) {
        // The validated response answers this request; under no-store it is not kept for the next
        // one ("MUST make a best-effort attempt to remove the information from volatile storage as
        // promptly as possible after forwarding it", RFC 7234 clause 5.2.2.3).
        if (noStore(cacheControl)) cache.delete(url);
        cached.expiresAt = expiresAt;
        cached.expires = expires;
        const lm = res.headers.get('Last-Modified');
        if (lm) cached.lastModified = lm;
        const etag = res.headers.get('ETag');
        if (etag) cached.etag = etag;
        state.delete(key);
        return { ok: true, status: 304, body: cached.body, contentType: cached.contentType, notModified: true, maxAgeMs: maxAge, expires };
      }

      if (res.ok) {
        const body = await res.text();
        const contentType = res.headers.get('Content-Type') || '';
        if (storable(res.status, cacheControl, expires)) {
          cache.set(url, { body, contentType, lastModified: res.headers.get('Last-Modified') || null,
            etag: res.headers.get('ETag') || null, expiresAt, expires });
        } else {
          cache.delete(url);
        }
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

  return { backoffRange, backoffDelay, maxAgeMs, noStore, storable, initialAgeMs, retryAfterMs, createClient };
})();

// Exposed for Node-based unit tests (test/dvbi-http.test.js). `module` is undefined when loaded via
// a <script> tag in the browser, so this is a no-op there.
if (typeof module !== 'undefined' && module.exports) module.exports = DVBIHttp;
