/* TaigiSpeech local recorder - MediaRecorder compatibility shim.
 *
 * Replaces the browser's native MediaRecorder with a Web Audio API
 * PCM-to-WAV implementation so that:
 *   1. macOS 10.13 / Safari 11-12 can record even without MediaRecorder.
 *   2. Output is uncompressed PCM WAV at the browser's actual sample rate,
 *      with a preferred upper target of 96 kHz.
 *   3. The backend can process uploads without ffmpeg.
 *
 * The behavior matches the native MediaRecorder API used by script.js:
 *   - new MediaRecorder(stream, { mimeType })
 *   - mr.start()
 *   - mr.stop() triggers ondataavailable with one complete Blob, then onstop.
 *   - mr.state ('inactive' | 'recording')
 *   - MediaRecorder.isTypeSupported(mime)
 *
 * Note: ondataavailable provides an audio/wav Blob. script.js may wrap it with
 * new Blob([...], { type: micInfo.mimeType }) and label it audio/webm, which is
 * fine because the server detects the real format from the RIFF/WAVE header.
 */
(function () {
  'use strict';

  function ShimMediaRecorder(stream, opts) {
    this._stream = stream;
    this._requestedMime = (opts && opts.mimeType) || 'audio/wav';
    this.mimeType = this._requestedMime;
    this.state = 'inactive';
    this.ondataavailable = null;
    this.onstop = null;
    this.onerror = null;
    this._buffer = [];
    this._sampleRate = 0;
  }

  ShimMediaRecorder.prototype.start = function () {
    if (this.state === 'recording') return;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      var e = new Error('Web Audio API not supported');
      if (typeof this.onerror === 'function') this.onerror(e);
      else throw e;
      return;
    }
    var preferredSampleRate = getStreamSampleRate(this._stream);
    var ctx = createAudioContext(Ctx, preferredSampleRate);
    var source = ctx.createMediaStreamSource(this._stream);
    var processor = ctx.createScriptProcessor(4096, 1, 1);
    var gain = ctx.createGain();
    gain.gain.value = 0;

    var samples = [];
    processor.onaudioprocess = function (e) {
      var ch = e.inputBuffer.getChannelData(0);
      samples.push(new Float32Array(ch));
    };

    source.connect(processor);
    processor.connect(gain);
    gain.connect(ctx.destination);

    this._ctx = ctx;
    this._source = source;
    this._processor = processor;
    this._gain = gain;
    this._buffer = samples;
    this._sampleRate = ctx.sampleRate;
    this.state = 'recording';
  };

  ShimMediaRecorder.prototype.stop = function () {
    if (this.state !== 'recording') return;
    var self = this;
    try { self._processor.disconnect(); } catch (e) {}
    try { self._gain.disconnect(); } catch (e) {}
    try { self._source.disconnect(); } catch (e) {}
    try { self._ctx && self._ctx.close && self._ctx.close(); } catch (e) {}

    var samples = self._buffer || [];
    var sampleRate = self._sampleRate || 44100;

    setTimeout(function () {
      try {
        var merged = mergeFloat32(samples);
        var blob = encodeWav(merged, sampleRate);
        if (typeof self.ondataavailable === 'function') {
          self.ondataavailable({ data: blob });
        }
      } catch (err) {
        if (typeof self.onerror === 'function') self.onerror(err);
      }
      self.state = 'inactive';
      if (typeof self.onstop === 'function') self.onstop();
    }, 30);
  };

  ShimMediaRecorder.isTypeSupported = function (mime) {
    // This shim only emits audio/wav. Other MIME types return false so script.js uses its fallback naming.
    return /audio\/wav/i.test(mime || '');
  };

  // ----- helpers ----------------------------------------------------
  function mergeFloat32(chunks) {
    var len = 0, i;
    for (i = 0; i < chunks.length; i++) len += chunks[i].length;
    var out = new Float32Array(len);
    var off = 0;
    for (i = 0; i < chunks.length; i++) {
      out.set(chunks[i], off);
      off += chunks[i].length;
    }
    return out;
  }

  function getStreamSampleRate(stream) {
    try {
      var tracks = stream && stream.getAudioTracks ? stream.getAudioTracks() : [];
      var track = tracks && tracks[0];
      if (track && track.getSettings) {
        var settings = track.getSettings() || {};
        var sampleRate = Number(settings.sampleRate);
        if (sampleRate > 0) return sampleRate;
      }
    } catch (e) {}
    return 0;
  }

  function createAudioContext(Ctx, preferredSampleRate) {
    if (preferredSampleRate > 0) {
      try {
        return new Ctx({ sampleRate: preferredSampleRate });
      } catch (e) {}
    }
    return new Ctx();
  }

  function encodeWav(float32, sampleRate) {
    var nCh = 1, bps = 2;
    var dataLen = float32.length * bps;
    var buf = new ArrayBuffer(44 + dataLen);
    var v = new DataView(buf);
    function ws(off, s) { for (var i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); }
    ws(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); ws(8, 'WAVE');
    ws(12, 'fmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, nCh, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * nCh * bps, true);
    v.setUint16(32, nCh * bps, true);
    v.setUint16(34, 16, true);
    ws(36, 'data'); v.setUint32(40, dataLen, true);
    var off = 44;
    for (var i = 0; i < float32.length; i++) {
      var s = float32[i];
      if (s > 1) s = 1; else if (s < -1) s = -1;
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  window.__TAIGI_LOCAL_WAV_RECORDER__ = true;

  // Force the WAV path even on browsers with native MediaRecorder.
  window.MediaRecorder = ShimMediaRecorder;

  // Expose legacy-prefixed getUserMedia as a fallback for environments without mediaDevices.
  if (!navigator.mediaDevices) {
    navigator.mediaDevices = {};
  }
  if (!navigator.mediaDevices.getUserMedia) {
    var legacy = navigator.getUserMedia || navigator.webkitGetUserMedia ||
                 navigator.mozGetUserMedia || navigator.msGetUserMedia;
    if (legacy) {
      navigator.mediaDevices.getUserMedia = function (constraints) {
        return new Promise(function (resolve, reject) {
          legacy.call(navigator, constraints, resolve, reject);
        });
      };
    }
  }
})();
