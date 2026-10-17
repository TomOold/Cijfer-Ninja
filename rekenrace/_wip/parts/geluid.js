// Quiet synthesized sound for Rekenrace: a few short, soft effects and a slow
// pentatonic music-box loop. Everything is made with WebAudio (sine/triangle and
// softly filtered noise), there are no audio files, and nothing is created or
// played before unlock() is called from a user gesture.
//
// Every public function is a safe no-op without AudioContext and never throws.
// Call unlock() from every early gesture (it is cheap and idempotent): that is
// what creates and resumes the context.
RR.Sound = (function () {
  'use strict';

  const MASTER_GAIN = 0.18;   // all sound passes through this, so peaks stay far below 0.3
  const LOWPASS_HZ = 4800;    // gentle: takes the edge off partials and noise
  const FLOOR = 0.0005;       // exponential decays end here (about -66 dB) ...
  const FALL = 0.012;         // ... followed by a short linear ramp to exactly 0 (no clicks)

  // ---------------------------------------------------------------------------
  // Notes
  // ---------------------------------------------------------------------------
  const SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  function hz(name) {
    const midi = 12 * (Number(name.charAt(1)) + 1) + SEMITONE[name.charAt(0)];
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  // Each timbre is a list of partials: [frequency ratio, oscillator type, relative
  // gain, relative length]. Gains are normalised, so `peak` of a note is the
  // worst-case amplitude before the master gain.
  const TIMBRES = {
    marimba: [[1, 'sine', 1, 1], [1, 'triangle', 0.35, 0.7], [4, 'sine', 0.12, 0.22]],
    bell: [[1, 'sine', 1, 1], [1, 'triangle', 0.3, 0.75], [2, 'sine', 0.2, 0.5], [2.76, 'sine', 0.07, 0.15]],
    warm: [[1, 'sine', 1, 1], [1, 'triangle', 0.5, 0.9], [2, 'sine', 0.12, 0.5]],
    bass: [[1, 'sine', 1, 1], [1, 'triangle', 0.4, 0.6]]
  };
  const TIMBRE_SUM = {};
  Object.keys(TIMBRES).forEach(function (k) {
    TIMBRE_SUM[k] = TIMBRES[k].reduce(function (s, p) { return s + p[2]; }, 0);
  });

  // ---------------------------------------------------------------------------
  // Building blocks. All of them take an explicit context and output node, so
  // the same code runs live and in an OfflineAudioContext (debugRender).
  // ---------------------------------------------------------------------------

  // Smooth window used for whoosh-like sounds: starts and ends at exactly 0.
  const SWELL = (function () {
    const n = 64;
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const s = Math.sin(Math.PI * Math.pow(i / (n - 1), 0.7));
      v[i] = s * s;
    }
    return v;
  })();

  function scaled(curve, k) {
    const out = new Float32Array(curve.length);
    for (let i = 0; i < curve.length; i++) out[i] = curve[i] * k;
    return out;
  }

  // Gain envelope: attack, then either an exponential decay (plucked sounds), a
  // held plateau (pads) or a smooth swell (whoosh). Always starts and ends at 0.
  function envelope(param, t, dur, o) {
    const end = t + dur;
    if (o.swell) {
      param.value = 0;
      param.setValueCurveAtTime(scaled(SWELL, o.peak), t, dur);
      return;
    }
    const a = Math.min(o.attack == null ? 0.006 : o.attack, dur * 0.4);
    param.setValueAtTime(0, t);
    param.linearRampToValueAtTime(o.peak, t + a);
    if (o.sustain) {
      const rel = Math.min(o.release || 0.4, dur - a);
      param.setValueAtTime(o.peak, end - rel);
      param.linearRampToValueAtTime(0, end);
    } else {
      param.exponentialRampToValueAtTime(FLOOR, end - FALL);
      param.linearRampToValueAtTime(0, end);
    }
  }

  // One oscillator with an envelope. Returns the time its sound ends.
  function tone(c, out, o) {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.freq, o.t);
    if (o.freqTo) osc.frequency.exponentialRampToValueAtTime(o.freqTo, o.t + (o.glide || o.dur * 0.5));
    envelope(g.gain, o.t, o.dur, o);
    osc.connect(g);
    g.connect(out);
    osc.start(o.t);
    osc.stop(o.t + o.dur + 0.02);
    return o.t + o.dur;
  }

  // A pitched note built from a timbre's partials. Optional glide to `freqTo`.
  function note(c, out, t, freq, o) {
    const parts = TIMBRES[o.timbre];
    const sum = TIMBRE_SUM[o.timbre];
    let end = t;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      end = Math.max(end, tone(c, out, {
        t: t,
        type: p[1],
        freq: freq * p[0],
        freqTo: o.freqTo ? o.freqTo * p[0] : 0,
        glide: o.glide,
        peak: o.peak * p[2] / sum,
        dur: Math.max(o.dur * p[3], 0.03),
        attack: o.attack
      }));
    }
    return end;
  }

  // Deterministic white noise (same on every run, so renders are repeatable).
  const noiseCache = new WeakMap();
  function noiseBuffer(c) {
    let b = noiseCache.get(c);
    if (!b) {
      b = c.createBuffer(1, Math.floor(c.sampleRate), c.sampleRate);
      const d = b.getChannelData(0);
      let s = 12345;
      for (let i = 0; i < d.length; i++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        d[i] = s / 2147483648 - 1;
      }
      noiseCache.set(c, b);
    }
    return b;
  }

  // Band-filtered noise with an envelope (ticks, whoosh). `peak` scales unit noise.
  function noise(c, out, o) {
    const src = c.createBufferSource();
    const f = c.createBiquadFilter();
    const g = c.createGain();
    src.buffer = noiseBuffer(c);
    src.loop = true;
    f.type = o.filter || 'bandpass';
    f.frequency.setValueAtTime(o.freq, o.t);
    if (o.freqTo) f.frequency.exponentialRampToValueAtTime(o.freqTo, o.t + o.dur);
    f.Q.value = o.q || 1;
    envelope(g.gain, o.t, o.dur, o);
    src.connect(f);
    if (o.lowpass) {   // optional second filter to keep the noise dark and soft
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = o.lowpass;
      lp.Q.value = 0.5;
      f.connect(lp);
      lp.connect(g);
    } else {
      f.connect(g);
    }
    g.connect(out);
    src.start(o.t, o.offset || 0);
    src.stop(o.t + o.dur + 0.02);
    return o.t + o.dur;
  }

  // ---------------------------------------------------------------------------
  // Sound effects. build(c, out, t, v) schedules the effect at time t on output
  // node `out` and returns the time it ends. v (about 0.97..1.03) is a tiny pitch
  // variation so repeated ticks do not sound machine-made. `limit` is the longest
  // allowed total length in seconds.
  // ---------------------------------------------------------------------------
  const EFFECTS = {
    // soft wooden tick
    tap: {
      limit: 0.12,
      build: function (c, out, t, v) {
        return Math.max(
          tone(c, out, { t: t, freq: 520 * v, freqTo: 330 * v, glide: 0.05, dur: 0.09, peak: 0.5 }),
          noise(c, out, { t: t, dur: 0.05, freq: 1500 * v, q: 1.4, peak: 1.2, attack: 0.005 })
        );
      }
    },
    // tiny, higher tick for keypad digits
    key: {
      limit: 0.12,
      build: function (c, out, t, v) {
        return Math.max(
          tone(c, out, { t: t, freq: 1320 * v, freqTo: 1100 * v, glide: 0.04, dur: 0.06, peak: 0.34 }),
          noise(c, out, { t: t, dur: 0.03, freq: 3000 * v, q: 1.5, peak: 0.5, attack: 0.005 })
        );
      }
    },
    // tiny, lower tick for delete
    del: {
      limit: 0.12,
      build: function (c, out, t, v) {
        return Math.max(
          tone(c, out, { t: t, freq: 300 * v, freqTo: 220 * v, glide: 0.05, dur: 0.075, peak: 0.5 }),
          noise(c, out, { t: t, dur: 0.035, freq: 800 * v, q: 1.2, peak: 0.5, attack: 0.005 })
        );
      }
    },
    // right answer: two soft rising marimba notes
    ok: {
      limit: 0.9,
      build: function (c, out, t) {
        return Math.max(
          note(c, out, t, hz('E5'), { timbre: 'marimba', peak: 0.7, dur: 0.34 }),
          note(c, out, t + 0.11, hz('A5'), { timbre: 'marimba', peak: 0.7, dur: 0.5 })
        );
      }
    },
    // not yet: one soft, low, friendly note that sinks a little (a whole tone)
    almost: {
      limit: 0.9,
      build: function (c, out, t) {
        return note(c, out, t, hz('E4'), {
          timbre: 'warm', peak: 0.62, dur: 0.55, attack: 0.01, freqTo: hz('D4'), glide: 0.2
        });
      }
    },
    // start of a race: two warm notes (a fifth up)
    go: {
      limit: 0.9,
      build: function (c, out, t) {
        return Math.max(
          note(c, out, t, hz('C4'), { timbre: 'warm', peak: 0.7, dur: 0.46, attack: 0.01 }),
          note(c, out, t + 0.18, hz('G4'), { timbre: 'warm', peak: 0.7, dur: 0.6, attack: 0.01 })
        );
      }
    },
    // soft thud and one small bell
    stamp: {
      limit: 0.9,
      build: function (c, out, t) {
        return Math.max(
          tone(c, out, { t: t, freq: 170, freqTo: 70, glide: 0.12, dur: 0.24, peak: 0.6, attack: 0.007 }),
          noise(c, out, { t: t, dur: 0.06, freq: 500, q: 0.8, peak: 0.8, attack: 0.006 }),
          note(c, out, t + 0.07, hz('C6'), { timbre: 'bell', peak: 0.4, dur: 0.62 })
        );
      }
    },
    // a soft whoosh with a little kart purr underneath, very quiet
    glide: {
      limit: 1.3,
      build: function (c, out, t) {
        const dur = 1.15;
        const end = noise(c, out, { t: t, dur: dur, freq: 260, freqTo: 600, q: 1, lowpass: 1400, peak: 0.75, swell: true });

        const osc = c.createOscillator();
        const lp = c.createBiquadFilter();
        const mod = c.createGain();
        const lfo = c.createOscillator();
        const depth = c.createGain();
        const env = c.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(82, t);
        osc.frequency.linearRampToValueAtTime(104, t + dur);
        lp.type = 'lowpass';
        lp.frequency.value = 520;
        mod.gain.value = 0.5;            // tremolo between 0 and 1: a soft "brrr"
        lfo.type = 'sine';
        lfo.frequency.value = 18;
        depth.gain.value = 0.5;
        envelope(env.gain, t, dur, { peak: 0.1, swell: true });
        lfo.connect(depth);
        depth.connect(mod.gain);
        osc.connect(lp);
        lp.connect(mod);
        mod.connect(env);
        env.connect(out);
        osc.start(t);
        lfo.start(t);
        osc.stop(t + dur + 0.02);
        lfo.stop(t + dur + 0.02);
        return end;
      }
    },
    // a gentle rising three-note motif that settles on the tonic; not a fanfare
    finish: {
      limit: 2.5,
      build: function (c, out, t) {
        const pad = [hz('C4'), hz('G4')].map(function (f) {
          return tone(c, out, { t: t + 0.55, freq: f, dur: 1.75, peak: 0.07, attack: 0.4, sustain: true, release: 1.0 });
        });
        return Math.max(
          note(c, out, t, hz('D5'), { timbre: 'bell', peak: 0.62, dur: 1.0 }),
          note(c, out, t + 0.34, hz('G5'), { timbre: 'bell', peak: 0.62, dur: 1.1 }),
          note(c, out, t + 0.68, hz('C6'), { timbre: 'bell', peak: 0.62, dur: 1.55 }),
          pad[0], pad[1]
        );
      }
    }
  };

  const GAP = { tap: 0.03, key: 0.03, del: 0.03 };   // minimum seconds between the same effect
  const LONG = { go: 1, stamp: 1, glide: 1, finish: 1 };   // never stacked on themselves

  // ---------------------------------------------------------------------------
  // Music: ~76 bpm, 16 bars of 4/4, C major pentatonic (C D E G A), a music-box
  // melody with rests between the phrases over a very quiet pad and a soft bass.
  // No drums. One step = one eighth note.
  // ---------------------------------------------------------------------------
  const BPM = 76;
  const STEP = 60 / BPM / 2;
  const BAR_STEPS = 8;
  const FADE_IN = 1.0;
  const FADE_OUT = 0.35;
  const AHEAD = 0.5;       // schedule this far ahead of the audio clock ...
  const TICK_MS = 100;     // ... checked this often

  // Only pentatonic dyads: root + fifth for the bass, a fifth or fourth up for the pad.
  const CHORDS = {
    C: { pad: ['C4', 'G4'], bass: ['C3', 'G3'] },
    Am: { pad: ['A3', 'E4'], bass: ['A2', 'E3'] },
    G: { pad: ['G3', 'D4'], bass: ['G2', 'D3'] }
  };

  // melody notes per bar: [start step, note, length in steps]
  const BARS = [
    // phrase 1: asks
    { chord: 'C', mel: [[0, 'E5', 2], [2, 'G5', 2], [4, 'A5', 4]] },
    { chord: 'Am', mel: [[0, 'G5', 2], [2, 'E5', 2], [4, 'C5', 4]] },
    { chord: 'G', mel: [[0, 'D5', 2], [2, 'E5', 2], [4, 'D5', 4]] },
    { chord: 'C', mel: [[0, 'E5', 5]] },
    // phrase 2: answers
    { chord: 'Am', mel: [[0, 'A4', 2], [2, 'C5', 2], [4, 'E5', 4]] },
    { chord: 'G', mel: [[0, 'D5', 2], [2, 'G5', 2], [4, 'E5', 2], [6, 'D5', 2]] },
    { chord: 'C', mel: [[0, 'C5', 2], [2, 'D5', 2], [4, 'E5', 4]] },
    { chord: 'C', mel: [[0, 'C5', 5]] },
    // phrase 3: the first one a little higher
    { chord: 'C', mel: [[0, 'E5', 2], [2, 'G5', 2], [4, 'C6', 4]] },
    { chord: 'Am', mel: [[0, 'A5', 2], [2, 'G5', 2], [4, 'E5', 4]] },
    { chord: 'G', mel: [[0, 'D5', 2], [2, 'E5', 2], [4, 'G5', 2], [6, 'E5', 2]] },
    { chord: 'C', mel: [[0, 'D5', 5]] },
    // phrase 4: settles, and the last bar is only pad and bass (the breath before the loop)
    { chord: 'Am', mel: [[0, 'E5', 2], [2, 'C5', 2], [4, 'A4', 4]] },
    { chord: 'G', mel: [[0, 'G4', 2], [2, 'A4', 2], [4, 'D5', 4]] },
    { chord: 'C', mel: [[0, 'E5', 2], [2, 'D5', 2], [4, 'C5', 4]] },
    { chord: 'C', mel: [] }
  ];
  const TOTAL_STEPS = BARS.length * BAR_STEPS;
  const BAR_SEC = BAR_STEPS * STEP;
  const LOOP_SECONDS = TOTAL_STEPS * STEP;

  // Flatten to a list of events per step so the scheduler only walks an array.
  const STEPS = (function () {
    const s = [];
    for (let i = 0; i < TOTAL_STEPS; i++) s.push([]);
    BARS.forEach(function (bar, b) {
      const base = b * BAR_STEPS;
      const ch = CHORDS[bar.chord];
      s[base].push({ k: 'pad', f: ch.pad.map(hz) });
      s[base].push({ k: 'bass', f: hz(ch.bass[0]) });
      s[base + 4].push({ k: 'bass', f: hz(ch.bass[1]) });
      bar.mel.forEach(function (m) {
        s[base + m[0]].push({ k: 'mel', f: hz(m[1]), len: m[2] });
      });
    });
    return s;
  })();

  function scheduleStep(c, bus, idx, t) {
    const evs = STEPS[idx];
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (e.k === 'mel') {
        note(c, bus, t, e.f, { timbre: 'bell', peak: 0.3, dur: Math.min(0.6 + e.len * STEP * 1.4, 2.2), attack: 0.008 });
      } else if (e.k === 'bass') {
        note(c, bus, t, e.f, { timbre: 'bass', peak: 0.17, dur: 1.2, attack: 0.012 });
      } else {
        for (let j = 0; j < e.f.length; j++) {
          tone(c, bus, { t: t, freq: e.f[j], dur: BAR_SEC + 1.2, peak: 0.045, attack: 0.9, sustain: true, release: 1.2 });
        }
      }
    }
  }

  function makePlayer(startTime) { return { step: 0, time: startTime }; }

  // Schedule every step that starts before `until`.
  function schedule(c, bus, p, until) {
    while (p.time < until) {
      scheduleStep(c, bus, p.step, p.time);
      p.step = (p.step + 1) % TOTAL_STEPS;
      p.time += STEP;
    }
  }

  // ---------------------------------------------------------------------------
  // Audio graph, shared by the live context and offline renders:
  //   sfx bus ------------------------------------+
  //   music bus (one per start) --+---------------+--> lowpass --> master --> out
  //                               +--> reverb ----+
  // ---------------------------------------------------------------------------
  function impulse(c) {
    const n = Math.floor(c.sampleRate * 0.9);
    const b = c.createBuffer(2, n, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      let s = 777 + ch * 31;
      let lo = 0;
      for (let i = 0; i < n; i++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        lo += (((s / 2147483648) - 1) - lo) * 0.35;      // one-pole low-pass: a dark, soft room
        d[i] = lo * Math.exp(-i / (c.sampleRate * 0.2));
      }
    }
    return b;
  }

  function buildGraph(c) {
    const lp = c.createBiquadFilter();
    const master = c.createGain();
    const sfx = c.createGain();
    const reverbIn = c.createGain();
    lp.type = 'lowpass';
    lp.frequency.value = LOWPASS_HZ;
    lp.Q.value = 0.5;
    master.gain.value = MASTER_GAIN;
    lp.connect(master);
    master.connect(c.destination);
    sfx.connect(lp);
    reverbIn.gain.value = 0.3;
    try {
      const conv = c.createConvolver();
      conv.buffer = impulse(c);
      reverbIn.connect(conv);
      conv.connect(lp);
    } catch (e) { /* no reverb: the music is still fine without it */ }
    return { lp: lp, master: master, sfx: sfx, reverbIn: reverbIn };
  }

  function musicBus(c, g, t) {
    const bus = c.createGain();
    bus.gain.setValueAtTime(0, t);
    bus.gain.linearRampToValueAtTime(1, t + FADE_IN);
    bus.connect(g.lp);
    bus.connect(g.reverbIn);
    return bus;
  }

  function fadeOut(param, t, secs) {
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
    param.linearRampToValueAtTime(0, t + secs);
  }

  // ---------------------------------------------------------------------------
  // Live state
  // ---------------------------------------------------------------------------
  const cfg = { sound: true, music: false };
  let ctx = null;                // created lazily by unlock()
  let graph = null;
  let music = null;              // { bus, player, timer } while music is playing
  let unlockedAt = -1e9;
  let suspendedByHide = false;
  let variant = 0;
  let voices = [];               // end times of effects still sounding
  const lastPlayed = {};         // effect name -> context time it was started
  const busyUntil = {};          // long effects -> context time they end
  const VARIANTS = [1, 1.03, 0.97, 1.015, 0.985];

  function safe(fn) {
    try { return fn(); } catch (e) { return undefined; }
  }
  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
  }
  function hidden() {
    return typeof document !== 'undefined' && !!document.hidden;
  }
  function quiet(p) {
    if (p && typeof p.catch === 'function') p.catch(function () {});
  }

  function resumeContext() {
    if (ctx && ctx.state !== 'running' && !hidden()) quiet(ctx.resume());
  }

  function applySound() {
    if (!ctx || !graph) return;
    const t = ctx.currentTime;
    const p = graph.sfx.gain;
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
    p.linearRampToValueAtTime(cfg.sound ? 1 : 0, t + 0.04);   // muting also cuts a sound that is still ringing
  }

  function pump(m) {
    const now = ctx.currentTime;
    if (m.player.time < now) m.player.time = now + 0.05;   // we stalled: do not burst out the missed notes
    schedule(ctx, m.bus, m.player, now + AHEAD);
  }

  function startTimer(m) {
    pump(m);
    if (!m.timer) {
      m.timer = setInterval(function () {
        safe(function () {
          if (music !== m) { clearInterval(m.timer); m.timer = null; return; }
          pump(m);
        });
      }, TICK_MS);
    }
  }

  function startMusic() {
    const now = ctx.currentTime;
    const bus = musicBus(ctx, graph, now);
    music = { bus: bus, player: makePlayer(now + 0.1), timer: null };
    startTimer(music);
  }

  function stopMusic() {
    const m = music;
    if (!m) return;
    music = null;
    if (m.timer) { clearInterval(m.timer); m.timer = null; }
    safe(function () { fadeOut(m.bus.gain, ctx.currentTime, FADE_OUT); });
    setTimeout(function () { safe(function () { m.bus.disconnect(); }); }, FADE_OUT * 1000 + 250);
  }

  // Bring the music in line with cfg.music, the context state and tab visibility.
  function syncMusic() {
    if (!ctx || !graph) return;
    if (!cfg.music) {
      if (music) stopMusic();
    } else if (ctx.state === 'running' && !hidden()) {
      if (!music) startMusic();
      else if (!music.timer) startTimer(music);
    }
  }

  function onVisibility() {
    safe(function () {
      if (!ctx) return;
      if (hidden()) {
        if (music && music.timer) { clearInterval(music.timer); music.timer = null; }
        if (ctx.state === 'running') { suspendedByHide = true; quiet(ctx.suspend()); }
      } else {
        if (suspendedByHide) { suspendedByHide = false; quiet(ctx.resume()); }
        syncMusic();
      }
    });
  }

  function onState() {
    safe(syncMusic);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  function unlock() {
    safe(function () {
      if (!ctx) {
        const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
        if (!AC) return;
        const c = new AC();
        const g = buildGraph(c);
        g.sfx.gain.value = cfg.sound ? 1 : 0;
        ctx = c;
        graph = g;
        try {   // iOS only really starts after a (silent) sound has been played in a gesture
          const s = c.createBufferSource();
          s.buffer = c.createBuffer(1, 1, 22050);
          s.connect(c.destination);
          s.start(0);
        } catch (e) { /* not needed elsewhere */ }
        c.onstatechange = onState;
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
      }
      unlockedAt = nowMs();
      resumeContext();
      syncMusic();
    });
  }

  function configure(opts) {
    safe(function () {
      if (!opts || typeof opts !== 'object') return;
      if ('sound' in opts) { cfg.sound = !!opts.sound; applySound(); }
      if ('music' in opts) cfg.music = !!opts.music;
      syncMusic();
    });
  }

  function play(name) {
    safe(function () {
      const fx = Object.prototype.hasOwnProperty.call(EFFECTS, name) ? EFFECTS[name] : null;
      if (!fx || !cfg.sound || !ctx || !graph || hidden()) return;
      if (ctx.state !== 'running') {
        resumeContext();
        // right after unlock() the context may need a few ms to report 'running'
        if (!(ctx.state === 'suspended' && nowMs() - unlockedAt < 500)) return;
      }
      const now = ctx.currentTime;
      if (lastPlayed[name] != null && now - lastPlayed[name] < (GAP[name] || 0.1)) return;
      if (LONG[name] && busyUntil[name] > now) return;
      voices = voices.filter(function (e) { return e > now; });
      // while the context is still waking up its clock stands still, so queue at most two sounds
      if (voices.length >= (ctx.state === 'running' ? 8 : 2)) return;
      variant = (variant + 1) % VARIANTS.length;
      const t = now + 0.012;   // a hair ahead so the attack ramp is never cut off
      const end = fx.build(ctx, graph.sfx, t, GAP[name] ? VARIANTS[variant] : 1);
      lastPlayed[name] = now;
      busyUntil[name] = end;
      voices.push(end);
    });
  }

  // Render an effect (or 'music') into an OfflineAudioContext through the very
  // same graph as the live one. For 'music' the whole length of the offline
  // context is filled; opts.stopAt (absolute seconds) fades it out like music(off).
  // Returns a description, or { error } instead of throwing.
  function debugRender(name, c, t0, opts) {
    try {
      t0 = t0 || 0;
      opts = opts || {};
      const g = buildGraph(c);
      if (name === 'music') {
        const bus = musicBus(c, g, t0);
        schedule(c, bus, makePlayer(t0), c.length / c.sampleRate);
        if (opts.stopAt != null) fadeOut(bus.gain, opts.stopAt, FADE_OUT);
        return { name: name, start: t0, loopSeconds: LOOP_SECONDS };
      }
      const fx = Object.prototype.hasOwnProperty.call(EFFECTS, name) ? EFFECTS[name] : null;
      if (!fx) return { error: 'unknown effect ' + name };
      const end = fx.build(c, g.sfx, t0, 1);
      return { name: name, start: t0, end: end, duration: end - t0, limit: fx.limit };
    } catch (e) {
      return { error: String(e && e.message || e) };
    }
  }

  function debugInfo() {
    const limits = {};
    Object.keys(EFFECTS).forEach(function (k) { limits[k] = EFFECTS[k].limit; });
    const used = {};
    BARS.forEach(function (b) {
      b.mel.forEach(function (m) { used[m[1]] = 1; });
      CHORDS[b.chord].pad.concat(CHORDS[b.chord].bass).forEach(function (n) { used[n] = 1; });
    });
    return {
      master: MASTER_GAIN, lowpassHz: LOWPASS_HZ, bpm: BPM, bars: BARS.length, musicNotes: Object.keys(used),
      loopSeconds: LOOP_SECONDS, fadeIn: FADE_IN, fadeOut: FADE_OUT,
      aheadSeconds: AHEAD, tickMs: TICK_MS, limits: limits
    };
  }

  function isUnlocked() { return !!ctx; }
  function isMusicPlaying() { return !!music; }

  return {
    unlock: unlock,
    configure: configure,
    play: play,
    isUnlocked: isUnlocked,
    isMusicPlaying: isMusicPlaying,
    debugRender: debugRender,
    debugInfo: debugInfo
  };
})();
