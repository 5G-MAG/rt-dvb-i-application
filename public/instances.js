// Service instance precedence, ETSI TS 103 770 V1.2.1 clause 5.2.13, and the scheduled service hours
// it depends on (clause 5.2.5.2, Availability as typed in clause 5.5.15, table 26).
//
// Availability model, as parseAvailability in app.js builds it from the XML:
//   null                     the instance carries no Availability element: always available
//   { periods: [ { validFrom, validTo,          ms since the epoch, or null when absent
//                  intervals: [ { days,          array of 1 (Monday) .. 7 (Sunday)
//                                 recurrence,    weekly cadence, 1 when absent
//                                 recurrenceGiven,  true when @recurrence was in the document
//                                 start, end } ] } ] }   ms after 00:00 UTC
const DVBIInstances = (() => {
  const DAY_MS  = 86400000;
  const WEEK_MS = 7 * DAY_MS;

  // 1 (Monday) .. 7 (Sunday) of the UTC day containing `ms`.
  function isoDay(ms) { const d = new Date(ms).getUTCDay(); return d === 0 ? 7 : d; }
  function utcMidnight(ms) { return Math.floor(ms / DAY_MS) * DAY_MS; }
  // Start (UTC Monday 00:00) of the week containing `ms`.
  function weekStart(ms) { return utcMidnight(ms) - (isoDay(ms) - 1) * DAY_MS; }

  // Does the interval occurrence that starts on the UTC day `dayStart` exist, and if so its bounds.
  function occurrence(iv, period, dayStart) {
    if (!iv.days.includes(isoDay(dayStart))) return null;
    if (iv.recurrence > 1) {
      // "The cadence starts in the week indicated by the @validFrom attribute" (clause 5.2.5.2).
      const weeks = Math.round((weekStart(dayStart) - weekStart(period.validFrom)) / WEEK_MS);
      if (weeks < 0 || weeks % iv.recurrence !== 0) return null;
    }
    const start = dayStart + iv.start;
    // "If this value is less than or equal to the value of @startTime the service ends on the
    // following day." (table 26, @endTime)
    const end = iv.end <= iv.start ? dayStart + DAY_MS + iv.end : dayStart + iv.end;
    return { start, end };
  }

  // "the Interval element shall be ignored if @recurrence is specified but no @validFrom is
  // specified in the containing Period element" (clause 5.2.5.2); a Period left with no Interval
  // covers the whole of its validity.
  function usableIntervals(period) {
    return period.intervals.filter(iv => !(iv.recurrenceGiven && period.validFrom == null));
  }

  function periodActive(period, ms) {
    if (period.validFrom != null && ms < period.validFrom) return false;
    if (period.validTo != null && ms >= period.validTo) return false;
    const intervals = usableIntervals(period);
    if (!intervals.length) return true;
    const today = utcMidnight(ms);
    return intervals.some(iv => [today, today - DAY_MS].some(d => {
      const o = occurrence(iv, period, d);
      return o && ms >= o.start && ms < o.end;
    }));
  }

  // "The union of these intervals cumulatively define the availability of the service instance."
  function isAvailable(av, ms) {
    if (!av) return true;
    return av.periods.some(p => periodActive(p, ms));
  }

  // The first instant after `ms` at which isAvailable(av, ·) changes, or null if it never does.
  // Changes happen only at a period bound or an interval bound, so those are the candidates; the
  // interval bounds repeat with the longest recurrence, so one cycle of it, plus a day for an
  // interval that runs past midnight, holds every distinct one.
  function nextChange(av, ms) {
    if (!av) return null;
    const now = isAvailable(av, ms);
    const candidates = [];
    for (const p of av.periods) {
      if (p.validFrom != null) candidates.push(p.validFrom);
      if (p.validTo != null) candidates.push(p.validTo);
      const intervals = usableIntervals(p);
      if (!intervals.length) continue;
      const from = Math.max(ms, p.validFrom ?? ms);
      const cycleDays = 7 * Math.max(1, ...intervals.map(iv => iv.recurrence)) + 1;
      for (let d = utcMidnight(from) - DAY_MS, n = 0; n <= cycleDays; d += DAY_MS, n++) {
        for (const iv of intervals) {
          const o = occurrence(iv, p, d);
          if (o) candidates.push(o.start, o.end);
        }
      }
    }
    candidates.sort((a, b) => a - b);
    for (const c of candidates) if (c > ms && isAvailable(av, c) !== now) return c;
    return null;
  }

  // Why an instance can be known in advance not to play in this browser, or null (clause 5.2.13:
  // "Service instances that contain video where the DVB-I client can determine in advance that it
  // would not be able to display any video shall be discarded"). `caps` describes the browser:
  //   { dash, hls, eme, keySystem(id), packages }  keySystem returns the EME key system for a
  //   DRMSystemId or null; packages are the subscription packages the client is associated with
  function cannotPlay(inst, caps) {
    // Table 16, SubscriptionPackage: "If present, this service instance is selectable only by a
    // DVB-I client that is associated to one of the SubscriptionPackage elements listed here."
    if (inst.packages && inst.packages.length && !inst.packages.some(p => (caps.packages || []).includes(p))) {
      return 'only in subscription packages this client is not associated with';
    }
    if (inst.type === 'multicast') return 'multicast delivery cannot be received in a browser';
    if (inst.type === 'application/dash+xml' && !caps.dash) return 'no DASH player is available';
    if (inst.type === 'application/vnd.apple.mpegurl' && !caps.hls) return 'no HLS player is available';
    const p = inst.protection;
    if (p) {
      const drm = Object.keys(p.allSystems || {});
      if (!drm.length && p.caSystems && p.caSystems.length) return 'protected by conditional access only, which a browser cannot descramble';
      if (drm.length) {
        if (!caps.eme) return 'protected by DRM, and this browser has no Encrypted Media Extensions';
        if (!drm.some(id => caps.keySystem(id))) return 'protected only by DRM systems this client does not know';
      }
    }
    return null;
  }

  // The instances to try, in order: available now, not known in advance to fail, not excluded,
  // then by ascending @priority ("Lower values of this attribute indicate a higher priority.",
  // table 16), keeping document order between equal priorities.
  function candidates(instances, ms, caps, excluded = new Set()) {
    return instances
      .map((inst, idx) => ({ inst, idx }))
      .filter(({ inst, idx }) => !excluded.has(idx) && isAvailable(inst.availability, ms) && !cannotPlay(inst, caps))
      .sort((a, b) => (a.inst.priority - b.inst.priority) || (a.idx - b.idx))
      .map(({ idx }) => idx);
  }

  return { isAvailable, nextChange, cannotPlay, candidates };
})();

// Exposed for Node-based unit tests (test/instances.test.js). `module` is undefined when loaded via a
// <script> tag in the browser, so this is a no-op there.
if (typeof module !== 'undefined' && module.exports) module.exports = DVBIInstances;
