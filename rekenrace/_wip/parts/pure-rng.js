// Seedable RNG shared by the pure modules. No DOM, no globals except RR.
RR.Rng = (function () {
  'use strict';

  // mulberry32: small, fast, good enough for question generation
  function make(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Unseeded generator for real play; tests pass make(seed) instead.
  function random() {
    return make((Math.random() * 4294967296) >>> 0);
  }

  // Inclusive integer in [min, max]
  function int(rng, min, max) {
    return min + Math.floor(rng() * (max - min + 1));
  }

  function pick(rng, list) {
    return list[Math.floor(rng() * list.length)];
  }

  // Returns a shuffled copy (Fisher-Yates); the input is left untouched.
  function shuffle(rng, list) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = out[i]; out[i] = out[j]; out[j] = t;
    }
    return out;
  }

  return { make, random, int, pick, shuffle };
})();
