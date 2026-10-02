const DVBIPlayer = (() => {
  let _hls  = null;
  let _dash = null;
  let _vel  = null;
  let _bufHandlers = null;
  let _nativeHandlers = null;
  let _cmcdSid = null;

  const _DRM_SYSTEMS = {
    'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed': 'com.widevine.alpha',
    'urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95': 'com.microsoft.playready',
    'urn:uuid:94ce86fb-07ff-4f43-adb8-93d2fa968ca2': 'com.apple.fps.1_0',
    'urn:uuid:1077efec-c0b2-4d02-ace3-3c1e52e2fb4b': 'org.w3.clearkey',
  };
  // The EME key system this player maps a DRMSystemId to, or null when it knows none.
  function knownKeySystem(id) { return _DRM_SYSTEMS[String(id || '').toLowerCase()] || null; }

  function _keySystem(id) {
    if (!id || id === 'none') return null;
    return _DRM_SYSTEMS[id.toLowerCase()] || id;
  }

  // UUID v7 — 48-bit ms timestamp prefix + version 7 + random variant (CTA-5004 TS 103 770 §3.1)
  function _uuidv7() {
    const ms  = Date.now();
    const buf = crypto.getRandomValues(new Uint8Array(16));
    buf[0] = (ms / 0x10000000000) & 0xff;
    buf[1] = (ms / 0x100000000)   & 0xff;
    buf[2] = (ms / 0x1000000)     & 0xff;
    buf[3] = (ms / 0x10000)       & 0xff;
    buf[4] = (ms / 0x100)         & 0xff;
    buf[5] =  ms                  & 0xff;
    buf[6] = (buf[6] & 0x0f) | 0x70;
    buf[8] = (buf[8] & 0x3f) | 0x80;
    const h = [...buf].map(b => b.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
  }

  function generateSessionId() { return _uuidv7(); }
  function setCMCDSession(sid) { _cmcdSid = sid; }

  function _bindBuffer(vel, onBuffer) {
    if (!onBuffer) return;
    _bufHandlers = {
      waiting: () => onBuffer(true),
      stalled: () => onBuffer(true),
      playing: () => onBuffer(false),
      canplay: () => onBuffer(false),
    };
    vel.addEventListener('waiting', _bufHandlers.waiting);
    vel.addEventListener('stalled', _bufHandlers.stalled);
    vel.addEventListener('playing', _bufHandlers.playing);
    vel.addEventListener('canplay', _bufHandlers.canplay);
  }

  function _unbindBuffer() {
    if (_bufHandlers && _vel) {
      _vel.removeEventListener('waiting', _bufHandlers.waiting);
      _vel.removeEventListener('stalled', _bufHandlers.stalled);
      _vel.removeEventListener('playing', _bufHandlers.playing);
      _vel.removeEventListener('canplay', _bufHandlers.canplay);
    }
    _bufHandlers = null;
  }

  function stop() {
    _unbindBuffer();
    // Remove native-HLS listeners explicitly: with {once:true} they only self-remove if they
    // fired, so a rapid channel switch could otherwise leave a stale handler from the prior
    // play() that invokes the previous channel's (un-session-guarded) onError/onTracks.
    if (_nativeHandlers && _vel) {
      _vel.removeEventListener('error', _nativeHandlers.error);
      _vel.removeEventListener('loadedmetadata', _nativeHandlers.loadedmetadata);
    }
    _nativeHandlers = null;
    if (_hls)  { _hls.destroy();  _hls  = null; }
    if (_dash) { _dash.reset();   _dash = null; }
    if (_vel)  { _vel.removeAttribute('src'); _vel.load(); _vel = null; }
  }

  function play(videoEl, url, type, protection, onError, onBuffer, onTracks) {
    stop();
    _vel = videoEl;
    _bindBuffer(videoEl, onBuffer);

    if (type === 'application/dash+xml') {
      try {
        const dp = dashjs.MediaPlayer().create();
        // Multi-DRM: configure all available system/license pairs (A184r2 §4.10)
        if (protection) {
          const protData = {};
          if (protection.allSystems) {
            for (const [sysId, licUrl] of Object.entries(protection.allSystems)) {
              const ks = _keySystem(sysId);
              if (ks && licUrl) protData[ks] = { serverURL: licUrl };
            }
          } else {
            const ks = _keySystem(protection.system);
            if (ks && protection.licenseUrl) protData[ks] = { serverURL: protection.licenseUrl };
          }
          if (Object.keys(protData).length) dp.setProtectionData(protData);
        }
        // CMCD session tracking (CTA-5004, A184r2 §4.1.6)
        if (_cmcdSid) {
          try { dp.updateSettings({ streaming: { cmcd: { enabled: true, sid: _cmcdSid } } }); } catch (_) {}
        }
        dp.initialize(videoEl, url, true);
        // Only fail over on non-recoverable errors. dash.js fires ERROR for transient download/
        // fragment failures it can self-heal; treat a known-recoverable allowlist as non-fatal and
        // fail over for everything else (incl. unclassifiable) so genuine failures are not masked.
        dp.on(dashjs.MediaPlayer.events.ERROR, (e) => {
          const err  = e && e.error;
          const code = err && (typeof err === 'object' ? err.code : err);
          const E    = (dashjs.MediaPlayer.errors) || {};
          const RECOVERABLE = new Set([
            E.FRAGMENT_LOADER_LOADING_FAILURE_ERROR_CODE,
            E.SEGMENT_BASE_LOADER_ERROR_CODE,
            E.DOWNLOAD_ERROR_ID_CONTENT_CODE,
            E.DOWNLOAD_ERROR_ID_INITIALIZATION_CODE,
          ].filter(c => c !== undefined));
          if (typeof code === 'number' && RECOVERABLE.has(code)) {
            console.warn('dash.js recoverable error, not failing over:', code, err && err.message);
            return;
          }
          onError && onError();
        });
        dp.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => {
          videoEl.play().catch(() => {});
          if (onTracks) onTracks(getTracks());
        });
        _dash = dp;
      } catch (_) { onError && onError(); }
      return;
    }

    // HLS
    if (window.Hls && Hls.isSupported()) {
      const hlsCfg = { enableWorker: true, lowLatencyMode: false };
      // Multi-DRM: seed drmSystems from ALL systems. Do NOT gate on the primary's license
      // URL — the first-listed system may lack one while another carries the usable license
      // (A184r2 §4.10). Mirrors the DASH path above, which iterates allSystems directly.
      const drmSystems = {};
      if (protection?.allSystems) {
        for (const [sysId, licUrl] of Object.entries(protection.allSystems)) {
          const altKs = _keySystem(sysId);
          if (altKs && licUrl) drmSystems[altKs] = { licenseUrl: licUrl };
        }
      } else if (protection) {
        const ks = _keySystem(protection.system);
        if (ks && protection.licenseUrl) drmSystems[ks] = { licenseUrl: protection.licenseUrl };
      }
      if (Object.keys(drmSystems).length) {
        hlsCfg.emeEnabled = true;
        hlsCfg.drmSystems = drmSystems;
      }
      // FairPlay needs an Application Server Certificate (serverCertificateUrl); DVB-I service lists
      // before v8.0 cannot carry one (@certificateURL). If FairPlay is the only key system and no
      // certificate is available, surface a clear error rather than failing opaquely later.
      const ksList = Object.keys(drmSystems);
      if (ksList.length === 1 && ksList[0] === 'com.apple.fps.1_0' && !drmSystems['com.apple.fps.1_0'].serverCertificateUrl) {
        console.error('FairPlay requires a server certificate URL not present in this service list — cannot play this DRM-protected stream.');
        onError && onError();
        return;
      }
      // CMCD
      if (_cmcdSid) {
        try { hlsCfg.cmcd = { sessionId: _cmcdSid }; } catch (_) {}
      }
      const hls = new Hls(hlsCfg);
      hls.loadSource(url);
      hls.attachMedia(videoEl);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        videoEl.play().catch(() => {});
        if (onTracks) onTracks(getTracks());
      });
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED,    () => { if (onTracks) onTracks(getTracks()); });
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => { if (onTracks) onTracks(getTracks()); });
      hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) onError && onError(); });
      _hls = hls;
    } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      videoEl.src = url;
      videoEl.play().catch(() => {});
      // Native HLS — keep refs so stop() can detach them on channel switch (see stop())
      _nativeHandlers = {
        error: () => onError && onError(),
        loadedmetadata: () => { if (onTracks) onTracks(getTracks()); },
      };
      videoEl.addEventListener('error', _nativeHandlers.error, { once: true });
      videoEl.addEventListener('loadedmetadata', _nativeHandlers.loadedmetadata, { once: true });
    } else {
      onError && onError();
    }
  }

  function getTracks() {
    const audio = [];
    const text  = [];

    if (_hls) {
      (_hls.audioTracks || []).forEach((t, i) => {
        audio.push({ idx: i, label: t.name || t.lang || `Audio ${i + 1}`, lang: t.lang || '', current: _hls.audioTrack === i });
      });
      (_hls.subtitleTracks || []).forEach((t, i) => {
        text.push({ idx: i, label: t.name || t.lang || `Sub ${i + 1}`, lang: t.lang || '', current: _hls.subtitleTrack === i });
      });
    } else if (_dash) {
      try {
        const cur = _dash.getCurrentTrackFor('audio');
        (_dash.getTracksFor('audio') || []).forEach((t, i) => {
          audio.push({ idx: i, label: t.labels?.[0]?.text || t.lang || `Audio ${i + 1}`, lang: t.lang || '', current: t === cur });
        });
        // Match the current text track by OBJECT identity (like audio above), not by array index:
        // getCurrentTextTrackIndex()'s index space is not guaranteed to equal getTracksFor('text') order.
        const curT = _dash.getCurrentTrackFor?.('text');
        (_dash.getTracksFor('text') || []).forEach((t, i) => {
          text.push({ idx: i, label: t.labels?.[0]?.text || t.lang || `Sub ${i + 1}`, lang: t.lang || '', current: !!curT && (t === curT || t.id === curT.id) });
        });
      } catch (_) {}
    } else if (_vel) {
      Array.from(_vel.audioTracks || []).forEach((t, i) => {
        audio.push({ idx: i, label: t.label || t.language || `Audio ${i + 1}`, lang: t.language || '', current: t.enabled });
      });
      Array.from(_vel.textTracks || []).forEach((t, i) => {
        if (t.kind === 'subtitles' || t.kind === 'captions') {
          text.push({ idx: i, label: t.label || t.language || `Sub ${i + 1}`, lang: t.language || '', current: t.mode === 'showing' });
        }
      });
    }

    return { audio, text };
  }

  function setAudioTrack(idx) {
    if (_hls) { _hls.audioTrack = idx; return; }
    if (_dash) {
      try { const t = _dash.getTracksFor('audio'); if (t[idx]) _dash.setCurrentTrack(t[idx]); } catch (_) {}
      return;
    }
    if (_vel) {
      Array.from(_vel.audioTracks || []).forEach((t, i) => { t.enabled = i === idx; });
    }
  }

  function setSubtitleTrack(idx) {
    if (_hls) { _hls.subtitleTrack = idx; return; }
    if (_dash) {
      try {
        if (idx < 0) { _dash.enableText(false); }
        else {
          // Select by the track object at array position idx (single source of truth with getTracks),
          // avoiding the index-space mismatch between getTracksFor('text') and setTextTrack().
          const t = _dash.getTracksFor('text');
          if (t && t[idx]) { _dash.enableText(true); _dash.setCurrentTrack(t[idx]); }
        }
      } catch (_) {}
      return;
    }
    if (_vel) {
      Array.from(_vel.textTracks || []).forEach((t, i) => {
        if (t.kind === 'subtitles' || t.kind === 'captions') t.mode = i === idx ? 'showing' : 'hidden';
      });
    }
  }

  function getBitrate() {
    if (_hls && _hls.currentLevel >= 0) {
      const level = _hls.levels?.[_hls.currentLevel];
      if (level?.bitrate) return level.bitrate;
    }
    if (_dash) {
      try {
        const bi = _dash.getBitrateInfoListFor('video');
        const qi = _dash.getQualityFor('video');
        if (bi?.[qi]?.bitrate) return bi[qi].bitrate;
      } catch (_) {}
    }
    return null;
  }

  // Network timeshift (A184r2 §4.1.5) — true when live stream has a seekable DVR window
  function isLiveTimeshift() {
    if (_dash) {
      try {
        if (!_dash.isDynamic()) return false;
        // duration() is Infinity for live, so use the DVR window: prefer the seekable range the
        // timeshift UI itself reads, then fall back to dash.js getDVRInfo().
        if (_vel && _vel.seekable && _vel.seekable.length > 0) {
          return (_vel.seekable.end(0) - _vel.seekable.start(0)) > 60;
        }
        const info = (typeof _dash.getDVRInfo === 'function') ? _dash.getDVRInfo() : null;
        const w = info ? (info.range != null ? info.range : info.manifestInfo?.DVRWindowSize) : 0;
        return isFinite(w) && w > 60;
      } catch (_) { return false; }
    }
    if (_hls) {
      try {
        const details = _hls.levels[_hls.currentLevel]?.details;
        return !!(details?.live && details.totalduration > 60);
      } catch (_) { return false; }
    }
    if (_vel && _vel.seekable.length > 0 && !isFinite(_vel.duration)) {
      return (_vel.seekable.end(0) - _vel.seekable.start(0)) > 60;
    }
    return false;
  }

  return {
    play, stop, getBitrate, getTracks, setAudioTrack, setSubtitleTrack,
    isLiveTimeshift, generateSessionId, setCMCDSession, knownKeySystem,
  };
})();
