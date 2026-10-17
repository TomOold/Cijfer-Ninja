# Report: geluid (RR.Sound)

## Summary
RR.Sound is implemented as a WebAudio synth with no audio files, and the harness passes all 351 checks in headless Chromium (exit code 0). Nothing is created or played before unlock(), which lazily creates and resumes the AudioContext. Effects and music run through one graph: gain buses, a gentle 4.8 kHz low-pass and a master gain of 0.18 (default). The music also has a soft convolution reverb. All 9 effects (tap, key, del, ok, almost, go, glide, finish, stamp) have smooth attack and release and peak at 0.045-0.13 after the master. Music is a 16-bar loop at 76 bpm (50.5 s) in C major pentatonic. It has a bell/music-box melody with rests between phrases, a very quiet sine pad and a soft root/fifth bass, and no drums. It is scheduled by a 100 ms setInterval about 0.5 s ahead on the audio clock. configure() and unlock() can be called repeatedly without stacking loops. Music pauses with ctx.suspend() and timer stop when the tab is hidden, and fades in and out. The module also exposes debugRender(name, offlineCtx, t0, opts), which builds the same graph for a real device-free render (opts.stopAt fades the music out). It returns {error} instead of throwing. The harness (sound-check.cjs) renders everything offline at 44.1 and 48 kHz and measures peak, duration, DC, onset, release, clipping, pitches and loop periodicity. It also runs the live API in real time, runs failure-mode trials, and checked 6 deliberately broken variants of the module, which all failed. It writes a waveform/spectrogram PNG and a JSON report to the preview folder.

## Deviations from BRIEF
- glide has a slow swell envelope (about 0.17 s to half level, shaped like a smooth window) instead of the 5-10 ms attack, because a whoosh has to swell. It starts and ends at exactly 0, so there is no click. The pad layers (music pad 0.9 s attack, finish pad 0.4 s attack) are slow on purpose. All pitched notes and ticks use a 5-12 ms attack.
- Extra public functions beyond the contract, all additive: isUnlocked(), isMusicPlaying(), debugInfo() and debugRender(). The contract functions unlock, configure and play are unchanged.
- debugRender and debugInfo never throw. debugRender returns {error: ...} on failure, so a broken render shows up in the harness as a failed check.
- 'Duration' in the harness is the time until |sample| falls below 1e-4 (about -62 dB re peak). The scheduled end time is also checked against the same limit.

## Limitations
- Only Chromium was available, so Safari/iPad and Firefox are unverified. The code follows the standard WebAudio API (resume() inside the gesture, a silent-buffer kick for iOS, the 'interrupted' state handled by retrying resume on unlock()/play()) but has not been run on those browsers. The iOS silent switch still mutes WebAudio.
- Nobody has listened to the sounds. Pitches, envelopes and levels are verified by measurement and spectrogram only, not by ear. Levels are relative to the device volume.
- There is no volume control. Master is the fixed constant 0.18, and only mute (sound) and music on/off exist, as in the contract.
- Touch devices only count the context as user-activated at touchend/pointerup/click. The integrator should call RR.Sound.unlock() from click/pointerup/keydown handlers, and calling it on every early gesture is safe and cheap. A pointerdown-only unlock on touch can leave the context suspended until the next gesture. play() retries resume() on its own.
- The music loop is 50.526 s, which is not a whole number of samples. The seam is click-free and the two passes have the same 10 ms envelope, but the audio is not sample-identical between loops.
- At 48 kHz the stamp peak is 0.125 versus 0.103 at 44.1 kHz, because the noise burst is resampled differently. Still well under 0.25.
- Tick effects (tap/key/del) use a tiny deterministic pitch variation of up to +-3 %. debugRender always renders the unvaried version.
- The same effect is throttled: ticks at least 30 ms apart, others at least 100 ms. go, stamp, glide and finish never overlap themselves. At most 8 effects sound at once (2 before the context reports running). Rapid repeats are therefore dropped on purpose.

## Extra
HOW TO RUN (about 60 s; exit code 0 means all checks passed): cd preview, then NODE_PATH=$(npm root -g) node sound-check.cjs [optional path to a different geluid.js]. SKIP_LIVE=1 skips the 40 s real-time part. Outputs next to it: sound-check.png (waveform and 0-6 kHz spectrogram per effect, orange line = duration limit), sound-check.json, sound-check.log.

MEASURED, offline render at 44.1 kHz (post master and low-pass; peak limits: effects <= 0.25, music <= 0.12):
effect | peak | rms | measured dur (s) | scheduled end (s) | limit (s) | DC
tap | 0.130 | 0.021 | 0.076 | 0.090 | 0.12 | 0.00001
key | 0.079 | 0.015 | 0.047 | 0.060 | 0.12 | 0.00004
del | 0.096 | 0.021 | 0.061 | 0.075 | 0.12 | -0.00013
ok | 0.128 | 0.025 | 0.592 | 0.610 | 0.9 | 0.00000
almost | 0.108 | 0.020 | 0.528 | 0.550 | 0.9 | 0.00000
go | 0.125 | 0.026 | 0.758 | 0.780 | 0.9 | -0.00001
stamp | 0.103 | 0.017 | 0.670 | 0.690 | 0.9 | 0.00001
glide | 0.045 | 0.009 | 1.123 | 1.150 | 1.3 | 0.00000
finish | 0.112 | 0.023 | 2.294 | 2.300 | 2.5 | 0.00000
music, 20 s (stopped at 18 s) | 0.099 (48 kHz: 0.088) | rms 0.0141 | loop 50.526 s | 16 bars at 76 bpm
music, 2 loops + 6 s | 0.101 | rms 0.0146 | DC 0.00000
48 kHz effect peaks: tap 0.121, key 0.080, del 0.096, ok 0.130, almost 0.108, go 0.126, stamp 0.125, glide 0.045, finish 0.113.
All effects start at about 1e-5 or less, end below 1e-4, have no clipping and no NaN, and nothing sounds before t0.
Music plus ok, almost, tap, key, stamp, finish, glide and go stacked at the same moment: peak 0.164 (limit for the stack: 0.3).
Live real-time AudioContext (analyser tap on the master): tap 0.135, key 0.077, del 0.096, ok 0.136, almost 0.108, go 0.124, stamp 0.126, glide 0.050, finish 0.114, music 0.091. These match the offline renders and every effect is silent again afterwards.

PITCHES, measured by FFT: ok = E5 then A5 (a fourth up, marimba timbre, 0.11 s apart); almost = E4 gliding down to D4 over 0.2 s (warm timbre); go = C4 then G4 (a fifth up, 0.18 s apart); finish = D5, G5, C6 (0.34 s apart, bell timbre, plus a quiet C4+G4 pad underneath); stamp = thud of 170 down to 70 Hz plus a C6 bell at +0.07 s. Music uses only C D E G A (verified from debugInfo().musicNotes). Chords I-vi-V-I as dyads: pad C4+G4, A3+E4, G3+D4; bass root on beat 1 and fifth on beat 3.

INTEGRATION NOTES:
1. Call RR.Sound.unlock() from user gestures (click, pointerup, keydown), and call RR.Sound.configure(RR.Store.settings()) on start and whenever a setting changes. configure({music:true}) before unlock is remembered and starts once unlocked.
2. The glide sound lasts 1.15 s, so the glide animation should not be much shorter. Nothing in the module depends on that length.
3. Load order: the part has no dependencies (no RR.Rng) and does not declare const RR. It can sit anywhere after const RR = {} and outside the PURE fence.
4. The harness declares const RR = {} in a separate script tag first, as the final index.html does.

HARNESS COVERAGE (351 checks): the harness checks the points below in headless Chromium.
- Peaks, durations, DC and first/last samples (also at t0=0).
- Soft onset and release, clipping/NaN, pitches, loop identity (10 ms RMS envelope) and the loop seam.
- Rests between phrases and the pentatonic note set.
- Nothing before unlock, one context, one 100 ms timer, no stacked loops, and no extra scheduling during a 40-call configure/unlock burst.
- Look-ahead at most 0.62 s and never scheduling in the past.
- Music off fades to silence, mute cuts a ringing effect, and a hidden tab suspends the context and stops the timer.
- Resume continues the music.
- The failure-mode trials: no AudioContext, constructor throwing, createOscillator throwing, createConvolver throwing, resume() rejecting, webkit-only AudioContext, and loading under plain Node. None of them throws or raises a page error.
Variants made to be wrong and run through the harness were all caught: no attack ramp, master 0.32, 1.3 s stamp bell, stacked music loops, unlock inside play(), no visibilitychange handling, 3 s look-ahead, loud glide, a DC offset, an abrupt cut-off, and a safe() wrapper that stopped catching.