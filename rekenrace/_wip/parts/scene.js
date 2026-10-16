// Scene renderer for Rekenrace: the side-view race, drawn on one small canvas
// (320x144 logical pixels, scaled up by CSS with image-rendering: pixelated).
//
// Everything is baked once per theme into cached offscreen canvases (sky,
// parallax layers, road tile) and then only blitted, so a frame costs a few
// dozen drawImage calls. Nothing runs unless something is animating: a glide
// (requestAnimationFrame), or - only when setIdle(true) - a slow ambient drift
// rendered at ~15 fps. The scene never touches the clock for game state; time
// is used for animation only.
//
// World model: positions are track units (0 = start line, `length` = finish
// line). One unit is PPU pixels. The camera follows the player; the player's
// "reference point" (front wheel) sits at REF_X on screen, rivals are drawn at
// their own distance from it. Karts are drawn in 4 depth lanes (lane 0, the
// player, in front).
RR.Scene = (function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Geometry and timing
  // ---------------------------------------------------------------------------
  const W = 320;
  const H = 144;
  const PPU = 48;                  // pixels per track unit (320 / 48 = 6.7 units on screen)
  const REF_X = 112;               // screen x of the player's front wheel (kart centre 104 = 32%)
  const KART_REF = 8;              // kart centre sits this far behind its reference point
  const STRIP_H = 20;              // progress strip along the top
  const ROAD_TOP = 104;
  const ROAD_H = H - ROAD_TOP;
  const LANE_Y = [139, 130, 121, 112];   // ground line per lane, lane 0 (player) in front
  const MAX_RACERS = 4;
  const MAX_POS = 1000;            // sanity clamp for positions

  const GLIDE_MIN = 900;           // ms, for a short hop
  const GLIDE_MAX = 1400;          // ms, for a long one
  const BOOST_STRETCH = 1.15;
  const CAM_LAG = 0.14;            // s: the camera trails the player a little, then settles
  const IDLE_MS = 66;              // ~15 fps for the ambient drift
  const WHEEL_HZ = 5.5;            // wheel frame toggles per second at most (stays under 6)
  const WHEEL_PX = 12;             // distance per wheel frame toggle at a gentle speed

  const THEME_IDS = ['tulips', 'windmill', 'beach', 'forest', 'canal', 'harbour', 'ice', 'hills'];

  // ---------------------------------------------------------------------------
  // Colour helpers: palette names or hex strings, plus mixing for hazy distances
  // ---------------------------------------------------------------------------
  const PAL = (typeof RR !== 'undefined' && RR.Sprites && RR.Sprites.PALETTE) || {};

  function col(n) { return PAL[n] || n; }

  function rgb(h) {
    const s = col(h);
    return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
  }

  function hex(r, g, b) {
    const t = function (v) { return ('0' + Math.max(0, Math.min(255, Math.round(v))).toString(16)).slice(-2); };
    return '#' + t(r) + t(g) + t(b);
  }

  // t = 0 -> a, t = 1 -> b
  function mix(a, b, t) {
    const x = rgb(a);
    const y = rgb(b);
    return hex(x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t);
  }

  // 4x4 ordered-dither thresholds in (0,1), for banded gradients
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  function bay(x, y) { return (BAYER[((y & 3) << 2) | (x & 3)] + 0.5) / 16; }

  function seedOf(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  function makeRng(seed) {
    if (typeof RR !== 'undefined' && RR.Rng && RR.Rng.make) return RR.Rng.make(seed);
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function mod(a, n) { return ((a % n) + n) % n; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function num0(v) { return (typeof v === 'number' && isFinite(v)) ? clamp(v, 0, MAX_POS) : 0; }

  // ---------------------------------------------------------------------------
  // Canvas and brush: tiny pixel-art toolbox used while baking
  // ---------------------------------------------------------------------------
  function newCanvas(w, h) {
    if (typeof document === 'undefined') return null;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  // A brush paints in absolute screen y coordinates onto a layer canvas of
  // period P (x wraps around: use rep() for anything that may cross the seam).
  function makeBrush(ctx, P, seed) {
    const rnd = makeRng(seed);
    const g = { ctx: ctx, P: P, rnd: rnd };

    g.r = function (a, b) { return a + Math.floor(rnd() * (b - a + 1)); };
    g.pick = function (list) { return list[Math.floor(rnd() * list.length)]; };
    g.chance = function (p) { return rnd() < p; };

    g.f = function (c, x, y, w, h) {
      if (w <= 0 || h <= 0) return;
      ctx.fillStyle = col(c);
      ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
    };
    g.p = function (c, x, y) {
      ctx.fillStyle = col(c);
      ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
    };
    g.ell = function (c, cx, cy, rx, ry) {
      ctx.fillStyle = col(c);
      const iy = Math.ceil(ry);
      for (let dy = -iy; dy <= iy; dy++) {
        const q = dy / (ry + 0.5);
        if (q * q > 1) continue;
        const half = Math.round(rx * Math.sqrt(1 - q * q));
        ctx.fillRect(Math.round(cx) - half, Math.round(cy) + dy, half * 2 + 1, 1);
      }
    };
    // Upward triangle: apex at (cx, y0), h rows tall, half-width hw at the base.
    g.tri = function (c, cx, y0, h, hw) {
      ctx.fillStyle = col(c);
      for (let r = 0; r < h; r++) {
        const half = Math.round(hw * r / Math.max(1, h - 1));
        ctx.fillRect(Math.round(cx) - half, Math.round(y0) + r, half * 2 + 1, 1);
      }
    };
    g.ln = function (c, x0, y0, x1, y1) {
      ctx.fillStyle = col(c);
      x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
      const dx = Math.abs(x1 - x0);
      const dy = -Math.abs(y1 - y0);
      const sx = x0 < x1 ? 1 : -1;
      const sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      for (let i = 0; i < 4000; i++) {
        ctx.fillRect(x0, y0, 1, 1);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
    };
    // Ordered dither of colour b over colour a (a may be null = leave as is).
    // t is a probability for b: a number, or a function (row index) -> number.
    g.dith = function (a, b, x, y, w, h, t) {
      for (let j = 0; j < h; j++) {
        const p = typeof t === 'function' ? t(j) : t;
        for (let i = 0; i < w; i++) {
          const useB = bay(x + i, y + j) < p;
          const c = useB ? b : a;
          if (c) { ctx.fillStyle = col(c); ctx.fillRect(x + i, y + j, 1, 1); }
        }
      }
    };
    // Hand-made motif: rows of characters, legend maps a character to a colour.
    g.m = function (x, y, rows, legend, flip) {
      for (let j = 0; j < rows.length; j++) {
        const row = rows[j];
        for (let i = 0; i < row.length; i++) {
          const k = row.charAt(flip ? row.length - 1 - i : i);
          const c = legend[k];
          if (!c) continue;
          ctx.fillStyle = col(c);
          ctx.fillRect(Math.round(x) + i, Math.round(y) + j, 1, 1);
        }
      }
    };
    // n x positions spread over the period with jitter (0..1 of the spacing).
    g.spread = function (n, jit) {
      const out = [];
      for (let i = 0; i < n; i++) out.push(Math.floor(P * (i + 0.5 + (rnd() - 0.5) * jit) / n));
      return out;
    };
    // Run fn(x) for every copy of an item (left edge x, width w) that touches the tile,
    // so things crossing the seam wrap around without a visible join.
    g.rep = function (x, w, fn) {
      [0, -P, P].forEach(function (k) {
        if (x + k + w > 0 && x + k < P) fn(x + k);
      });
    };
    return g;
  }

  // ---------------------------------------------------------------------------
  // Shared motifs
  // ---------------------------------------------------------------------------

  // Banded sky: solid bands whose last third is an ordered dither into the next.
  function paintSky(ctx, colors, h) {
    const n = colors.length;
    for (let y = 0; y < h; y++) {
      const pos = y / h * n;
      const k = Math.min(n - 1, Math.floor(pos));
      const f = pos - k;
      let runC = null;
      let runX = 0;
      for (let x = 0; x <= W; x++) {
        let c = null;
        if (x < W) {
          c = colors[k];
          if (k < n - 1 && f > 0.5 && bay(x, y) < (f - 0.5) / 0.5) c = colors[k + 1];
        }
        if (c !== runC) {
          if (runC) { ctx.fillStyle = col(runC); ctx.fillRect(runX, y, x - runX, 1); }
          runC = c;
          runX = x;
        }
      }
    }
  }

  // Flat-bottomed cumulus. (x, y) = left end of the baseline.
  function cloud(g, x, y, w, body, shade) {
    const hh = Math.max(4, Math.round(w * 0.2));
    g.f(body, x + 3, y - 3, w - 6, 3);
    g.ell(body, x + w * 0.28, y - 3 - hh * 0.35, w * 0.2, hh * 0.55);
    g.ell(body, x + w * 0.52, y - 3 - hh * 0.65, w * 0.25, hh * 0.85);
    g.ell(body, x + w * 0.76, y - 3 - hh * 0.3, w * 0.18, hh * 0.5);
    g.f(shade, x + 3, y - 1, w - 6, 1);
    g.dith(null, shade, x + 3, y - 2, w - 6, 1, 0.4);
  }

  // Gull: 7x3, wings up (0) or down (1).
  const GULL = [
    ['x.....x', '.x...x.', '..xxx..'],
    ['..xxx..', '.x...x.', 'x.....x']
  ];


  // Slender poplar: tall narrow ellipse, lighter on the left.
  function poplar(g, x, base, h, body, hi, trunk) {
    const rx = Math.max(2, Math.round(h * 0.12));
    g.f(trunk, x, base - 3, 1, 3);
    g.ell(body, x, base - 3 - (h - 3) / 2, rx, (h - 3) / 2);
    g.dith(null, hi, x - rx, base - h + 2, rx, h - 6, 0.5);
  }

  // Round-topped tree: trunk plus a canopy of two lumps and a highlight.
  function roundTree(g, x, base, r, body, hi, lo, trunk) {
    g.f(trunk, x - 1, base - r - 1, 2, r + 1);
    g.ell(body, x, base - r * 1.5 - 1, r, r);
    g.ell(body, x - r * 0.4, base - r * 1.9, r * 0.7, r * 0.7);
    g.dith(null, lo, x - r + 1, base - r * 1.5, r * 2 - 1, Math.round(r * 0.9), 0.25);
    g.ell(hi, x - r * 0.35, base - r * 2.0 - 1, r * 0.4, r * 0.35);
  }

  // Layered pine: tiers of triangles, lit from the left.
  function pine(g, x, base, h, body, hi, lo, trunk) {
    const th = Math.max(2, Math.round(h * 0.1));
    g.f(trunk, x - 1, base - th, 2, th);
    const n = Math.max(3, Math.round(h / 8));
    const hw = Math.max(3, Math.round(h * 0.26));
    const F = h - th;
    const ht = Math.ceil(F / n * 1.8);
    for (let i = 0; i < n; i++) {
      const y0 = Math.round(base - h + i * (F - ht) / (n - 1));
      const half = Math.round(hw * (0.4 + 0.6 * i / (n - 1)));
      g.tri(body, x, y0, ht, half);
      for (let r = 1; r < ht; r++) {
        const hr = Math.round(half * r / Math.max(1, ht - 1));
        g.p(hi, x - hr + 1, y0 + r);
        g.p(lo, x + hr - 1, y0 + r);
      }
    }
  }

  // Hipped or gabled roof sitting on a wall: x, y = left/top of the roof box.
  function roof(g, x, y, w, h, c, shade, gable) {
    for (let r = 0; r < h; r++) {
      const inset = gable ? Math.round((h - 1 - r) * (w / 2 - 1) / Math.max(1, h - 1)) : Math.round((h - 1 - r) * 1.3);
      g.f(c, x + inset, y + r, w - inset * 2, 1);
      if (w - inset * 2 > 3) g.f(shade, x + w - inset - Math.max(2, Math.round((w - inset * 2) / 3)), y + r, Math.max(2, Math.round((w - inset * 2) / 3)), 1);
    }
    g.f(shade, x, y + h - 1, w, 1);
  }

  // Plain little house: wall box, roof, windows in a row, a door.
  function house(g, x, base, w, h, o) {
    g.f(o.wall, x, base - h, w, h);
    g.f(o.shade, x + w - 3, base - h, 3, h);
    roof(g, x - 1, base - h - o.roofH, w + 2, o.roofH, o.roof, o.roofShade, !!o.gable);
    const n = Math.max(1, Math.round(w / 9));
    for (let i = 0; i < n; i++) {
      const wx = x + Math.round((i + 0.5) * w / n) - 1;
      g.f(o.frame, wx - 1, base - h + 3, 4, 5);
      g.f(o.win, wx, base - h + 4, 2, 3);
    }
    if (o.door) { g.f(o.door, x + Math.round(w / 2) - 1, base - 6, 3, 6); g.p(o.frame, x + Math.round(w / 2) + 1, base - 3); }
    if (o.chim) { g.f(o.chim, x + 3, base - h - o.roofH - 3, 3, 4); g.f(mix(o.chim, 'navy', 0.3), x + 5, base - h - o.roofH - 3, 1, 4); }
  }

  // Tulip: cup with two tips, stem, leaf. x = stem column, base = ground row.
  function tulip(g, x, base, h, c) {
    const light = mix(c, 'white', 0.4);
    const dark = mix(c, 'navy', 0.2);
    g.f('green', x, base - h + 3, 1, h - 3);
    g.p('green', x - 1, base - 2); g.p('lime', x + 1, base - 3);
    g.p('green', x - 1, base - 3);
    g.f(c, x - 1, base - h + 1, 3, 3);
    g.p(c, x - 1, base - h); g.p(c, x + 1, base - h);
    g.p(light, x - 1, base - h + 1);
    g.p(dark, x + 1, base - h + 3);
  }

  // ---------------------------------------------------------------------------
  // Themes. Each theme gives a sky, clouds, a road and 3-4 parallax layers.
  // Layer bake(g, S) paints in absolute screen y (the layer canvas starts at
  // `top`); S is a state object handed to the optional dyn(d, S) which draws
  // the animated bits every frame (d = { ctx, off, t, P, sx(x) }).
  // ---------------------------------------------------------------------------
  const THEMES = {};

  // Road surface recipe shared by all themes (see bakeRoad).
  function roadDef(base, o) {
    const x = o || {};
    return {
      base: base,
      speck: [mix(base, 'white', 0.13), mix(base, 'navy', 0.13)],
      speckN: x.speckN,
      dash: x.dash === undefined ? mix(base, 'white', 0.26) : x.dash,
      kerb: x.kerb || [mix(base, 'white', 0.5), mix(base, 'white', 0.22), mix(base, 'navy', 0.22)],
      front: [mix(base, 'navy', 0.4), x.verge || 'green'],
      paint: x.paint,
      frontPaint: x.frontPaint
    };
  }

  // @@THEMES-START
  // 1. Tulpenveld: striped bulb fields, a farm, poplars, big soft clouds, flat horizon.
  THEMES.tulips = {
    sky: [mix('sky', 'blue', 0.22), 'sky', mix('sky', 'ice', 0.45), 'ice', mix('ice', 'cream', 0.55)],
    clouds: { n: 6, wmin: 30, wmax: 58, ymin: 36, ymax: 72, top: 14, body: 'white', shade: 'silver' },
    dust: 'cream',
    road: roadDef(mix('grey', 'slate', 0.25), { verge: 'green' }),
    layers: [
      // far: hazy tree line, church tower, tiny farms on the flat horizon
      { f: 0.06, P: 480, top: 56, bake: function (g) {
        const hz = 88;
        const haze = mix('green', 'sky', 0.6);
        const dark = mix('fir', 'sky', 0.66);
        g.f(haze, 0, hz, g.P, ROAD_TOP - hz);
        let x = 0;
        while (x < g.P) {
          const w = g.r(9, 20);
          const h = g.r(3, 8);
          g.rep(x, w, function (q) { g.ell(dark, q + w / 2, hz - h / 2 + 1, w / 2, h / 2 + 1); });
          x += g.r(6, 18);
        }
        g.f(dark, 0, hz, g.P, 2);
        const wall = mix('cream', 'sky', 0.45);
        const rf = mix('brick', 'sky', 0.55);
        g.rep(300, 12, function (q) {
          g.f(wall, q + 3, hz - 17, 6, 17);
          g.tri(rf, q + 6, hz - 29, 12, 3);
          g.f(mix('slate', 'sky', 0.5), q + 5, hz - 13, 2, 3);
        });
        [60, 190, 400].forEach(function (fx) {
          g.rep(fx, 12, function (q) {
            g.f(wall, q, hz - 5, 10, 5);
            roof(g, q - 1, hz - 9, 12, 4, rf, mix(rf, 'navy', 0.2), true);
          });
        });
      } },
      // mid-far: patchwork of striped bulb fields, with a farm among them
      { f: 0.22, P: 640, top: 60, bake: function (g) {
        const P = g.P;
        const leaf = mix('fir', 'green', 0.45);
        g.f(mix('green', 'sky', 0.2), 0, 85, P, ROAD_TOP - 85);
        const pairs = [['red', 'yellow'], ['pink', 'white'], ['yellow', 'orange'], ['lilac', 'pink'], ['orange', 'red'], ['white', 'yellow'], ['purple', 'pink']];
        const stripes = [1, 1, 1, 2, 1, 2, 1, 3];     // row heights, nearer rows get taller
        let x = 0;
        while (x < P) {
          const w = Math.min(g.r(70, 130), P - x);
          const pair = g.pick(pairs);
          let y = 85;
          stripes.forEach(function (sh, i) {
            const leafRow = i % 2 === 0;
            for (let xx = 0; xx < w; xx++) {
              let c;
              if (leafRow) c = leaf;
              else {
                c = pair[(i >> 1) % 2];
                if ((xx + i * 2) % 4 === 0) c = mix(c, 'white', 0.35);
                else if ((xx + i) % 4 === 2) c = mix(c, 'navy', 0.12);
              }
              g.f(c, x + xx, y, 1, sh);
            }
            y += sh;
          });
          g.f(mix('sand', 'green', 0.5), x, 85, 1, 13);
          x += w;
        }
        // farm, hazy
        const wall = mix('cream', 'sky', 0.2);
        g.rep(250, 34, function (q) {
          house(g, q, 85, 18, 7, { wall: wall, shade: mix(wall, 'tan', 0.4), roof: 'brick', roofShade: mix('brick', 'navy', 0.25), roofH: 6, frame: 'white', win: 'deepblue', door: 'bark', chim: 'brick' });
          house(g, q + 21, 85, 12, 6, { wall: mix('tan', 'sky', 0.2), shade: mix('tan', 'bark', 0.4), roof: 'slate', roofShade: 'navy', roofH: 5, gable: true, frame: 'cream', win: 'bark' });
        });
        [210, 232, 285, 520, 560].forEach(function (tx, i) {
          g.rep(tx, 6, function (q) { poplar(g, q + 3, 85, g.r(15, 22), mix('fir', 'green', 0.4), 'lime', 'bark'); });
        });
        g.rep(110, 16, function (q) { roundTree(g, q + 8, 85, 6, mix('green', 'fir', 0.3), 'lime', 'fir', 'bark'); });
        g.rep(430, 16, function (q) { roundTree(g, q + 8, 85, 5, mix('green', 'fir', 0.3), 'lime', 'fir', 'bark'); });
      } },
      // mid: bulb rows close up with poplars and a proper farmstead behind them
      { f: 0.55, P: 800, top: 44, bake: function (g) {
        const P = g.P;
        g.f(mix('green', 'lime', 0.3), 0, 91, P, ROAD_TOP - 91);
        const wall = 'white';
        g.rep(380, 70, function (q) {
          house(g, q, 94, 30, 12, { wall: wall, shade: mix('white', 'silver', 0.7), roof: 'red', roofShade: 'brick', roofH: 9, frame: 'bark', win: 'sky', door: 'blue', chim: 'brick' });
          house(g, q + 34, 94, 24, 9, { wall: mix('cream', 'tan', 0.3), shade: mix('tan', 'bark', 0.4), roof: 'brick', roofShade: mix('brick', 'navy', 0.3), roofH: 9, gable: true, frame: 'cream', win: 'bark', door: 'bark' });
          roundTree(g, q + 66, 94, 7, 'green', 'lime', 'fir', 'bark');
          roundTree(g, q - 8, 94, 6, 'green', 'lime', 'fir', 'bark');
        });
        [20, 38, 56, 74, 92, 600, 618, 636, 654, 700, 740].forEach(function (px, i) {
          g.rep(px, 7, function (q) { poplar(g, q + 3, 94, 26 + (i * 7) % 9, 'fir', 'green', 'bark'); });
        });
        // bulb rows between the farm and the road
        const pairs = [['red', 'yellow'], ['pink', 'white'], ['yellow', 'orange'], ['lilac', 'pink'], ['orange', 'red'], ['white', 'pink'], ['purple', 'lilac']];
        const leaf = mix('fir', 'green', 0.4);
        const stripes = [1, 3, 1, 3];
        let x = 0;
        while (x < P) {
          const w = Math.min(g.r(100, 190), P - x);
          const pair = g.pick(pairs);
          let y = 96;
          stripes.forEach(function (sh, i) {
            for (let xx = 0; xx < w; xx++) {
              if (i % 2 === 0) { g.f(leaf, x + xx, y, 1, sh); continue; }
              const c = pair[(i >> 1) % 2];
              g.p(mix(c, 'white', 0.38), x + xx, y + (xx % 4 < 2 ? 0 : 1));
              g.p(c, x + xx, y + (xx % 4 < 2 ? 1 : 0));
              g.p(mix(c, 'navy', 0.18), x + xx, y + 2);
            }
            y += sh;
          });
          g.f('sand', x, 95, 2, 9);
          x += w;
        }
      } },
      // near: grass shoulder, white fence pieces and tulips along the road
      { f: 1, P: 800, top: 86, bake: function (g) {
        const P = g.P;
        g.f('lime', 0, 101, P, 3);
        g.f(mix('lime', 'green', 0.5), 0, 103, P, 1);
        for (let i = 0; i < 260; i++) g.p(g.chance(0.5) ? 'green' : 'lime', g.r(0, P - 1), g.r(100, 103));
        const cols = ['red', 'yellow', 'pink', 'white', 'orange', 'purple', 'red', 'yellow'];
        g.spread(16, 0.7).forEach(function (x, gi) {
          if (gi % 5 === 2) {
            // short white fence
            const len = 30;
            g.rep(x, len, function (q) {
              g.f('silver', q, 96, len, 1);
              g.f('white', q, 99, len, 1);
              for (let k = 0; k <= len; k += 8) { g.f('white', q + k, 95, 2, 8); g.f('grey', q + k + 1, 95, 1, 8); }
            });
            return;
          }
          const c = cols[gi % cols.length];
          const n = g.r(3, 5);
          const items = [];
          for (let k = 0; k < n; k++) items.push({ dx: k * 4 + g.r(0, 2), h: g.r(6, 10), c: g.chance(0.7) ? c : g.pick(cols) });
          g.rep(x, 24, function (q) {
            items.forEach(function (it) { tulip(g, q + it.dx, 103, it.h, it.c); });
          });
        });
      } }
    ]
  };

  // @@THEMES-END

  // ---------------------------------------------------------------------------
  // Baking
  // ---------------------------------------------------------------------------
  const bakeCache = {};
  const bakeOrder = [];

  function bakeLayer(def, themeId, idx) {
    const top = def.top;
    const h = ROAD_TOP - top;
    const canvas = newCanvas(def.P, h);
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    ctx.translate(0, -top);
    const g = makeBrush(ctx, def.P, seedOf(themeId + ':' + idx));
    const S = {};
    def.bake(g, S);
    return { f: def.f, P: def.P, top: top, canvas: canvas, dyn: def.dyn || null, S: S, drift: def.drift || 0 };
  }

  function bakeSky(def, themeId) {
    const canvas = newCanvas(W, ROAD_TOP);
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    paintSky(ctx, def.sky.map(col), ROAD_TOP - 8);
    // below the horizon the last colour just continues
    ctx.fillStyle = col(def.sky[def.sky.length - 1]);
    ctx.fillRect(0, ROAD_TOP - 8, W, 8);
    if (def.skyFx) def.skyFx(makeBrush(ctx, W, seedOf(themeId + ':skyfx')));
    return canvas;
  }

  function bakeClouds(def, themeId) {
    const cd = def.clouds;
    if (!cd) return null;
    const P = 960;
    const h = 64;
    const canvas = newCanvas(P, h);
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    const g = makeBrush(ctx, P, seedOf(themeId + ':clouds'));
    const xs = g.spread(cd.n, 0.6);
    xs.forEach(function (x, i) {
      const w = g.r(cd.wmin, cd.wmax);
      const y = g.r(cd.ymin, cd.ymax) - (cd.top || 0);
      g.rep(x, w, function (xx) { cloud(g, xx, y, w, cd.body, cd.shade); });
    });
    return { canvas: canvas, P: P, top: cd.top || 0 };
  }

  // One tile of road: surface, back kerb, lane dashes, front verge.
  function bakeRoad(def, themeId) {
    const r = def.road;
    const P = 128;
    const canvas = newCanvas(P, ROAD_H);
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    const g = makeBrush(ctx, P, seedOf(themeId + ':road'));
    g.f(r.base, 0, 0, P, ROAD_H);
    if (r.paint) r.paint(g, ROAD_H);
    // speckles
    const n = r.speckN === undefined ? 70 : r.speckN;
    for (let i = 0; i < n; i++) {
      g.p(g.chance(0.5) ? r.speck[0] : r.speck[1], g.r(0, P - 1), g.r(3, ROAD_H - 4));
    }
    // lane dashes between the 4 lanes (faint)
    if (r.dash) {
      [LANE_Y[3] + 4, LANE_Y[2] + 4, LANE_Y[1] + 4].forEach(function (yy) {
        const y = yy - ROAD_TOP;
        for (let x0 = 0; x0 < P; x0 += 64) g.f(r.dash, x0 + 8, y, 12, 1);
      });
    }
    // back kerb and front verge
    g.f(r.kerb[0], 0, 0, P, 1);
    g.f(r.kerb[1], 0, 1, P, 1);
    g.f(r.kerb[2], 0, 2, P, 1);
    g.f(r.front[0], 0, ROAD_H - 3, P, 1);
    g.f(r.front[1], 0, ROAD_H - 2, P, 2);
    if (r.frontPaint) r.frontPaint(g, ROAD_H);
    return { canvas: canvas, P: P };
  }

  function bakeTheme(id) {
    const def = THEMES[id];
    const B = { id: id, def: def, sky: bakeSky(def, id), clouds: bakeClouds(def, id), layers: [], road: bakeRoad(def, id) };
    def.layers.forEach(function (ld, i) {
      const L = bakeLayer(ld, id, i);
      if (L) B.layers.push(L);
    });
    return B;
  }

  function getBaked(id) {
    if (bakeCache[id]) return bakeCache[id];
    const B = bakeTheme(id);
    bakeCache[id] = B;
    bakeOrder.push(id);
    while (bakeOrder.length > 3) delete bakeCache[bakeOrder.shift()];
    return B;
  }

  // ---------------------------------------------------------------------------
  // Start and finish gates (theme independent, baked once)
  // ---------------------------------------------------------------------------
  let gateCache = null;

  function bakeGates() {
    const out = {};
    // finish banner: 64 wide, poles at the back edge of the road
    let c = newCanvas(72, 66);
    if (!c) return null;
    let g = makeBrush(c.getContext('2d'), 72, 1);
    const pole = function (x) {
      g.f('navy', x, 6, 1, 58);
      g.f('white', x + 1, 6, 1, 58);
      g.f('grey', x + 2, 6, 1, 58);
      g.f('navy', x + 3, 6, 1, 58);
      g.f('slate', x - 2, 62, 8, 2);
      g.f('navy', x - 2, 64, 8, 1);
      g.f('gold', x, 3, 4, 3);
      g.f('navy', x, 2, 4, 1);
    };
    pole(4);
    pole(64);
    // checkered banner between the poles
    g.f('navy', 8, 6, 56, 14);
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 11; i++) {
        g.f((i + j) % 2 ? 'navy' : 'white', 9 + i * 5, 8 + j * 5, 5, 5);
      }
    }
    g.f('slate', 8, 18, 56, 2);
    g.f('navy', 8, 20, 56, 1);
    // little hanging pennants under the banner
    for (let i = 0; i < 5; i++) {
      const px = 14 + i * 11;
      const cc = ['red', 'yellow', 'white', 'blue', 'orange'][i];
      g.tri(cc, px, 22, 5, 2);
    }
    out.finish = c;

    // start gate: bunting between two poles
    c = newCanvas(72, 66);
    g = makeBrush(c.getContext('2d'), 72, 2);
    pole(4);
    pole(64);
    g.f('bark', 8, 8, 56, 2);
    g.f('tan', 8, 8, 56, 1);
    // bunting string with flags hanging in a gentle curve
    for (let i = 0; i < 6; i++) {
      const px = 11 + i * 9;
      const sag = Math.round(3 * Math.sin((i + 0.5) / 6 * Math.PI));
      const cc = ['red', 'white', 'blue', 'orange', 'yellow', 'pink'][i];
      g.tri(cc, px + 2, 10 + sag, 6, 3);
    }
    out.start = c;

    // road bands: start line and checkered finish line
    c = newCanvas(8, ROAD_H);
    g = makeBrush(c.getContext('2d'), 8, 3);
    for (let j = 0; j < ROAD_H - 3; j++) {
      g.f(Math.floor(j / 4) % 2 ? 'navy' : 'white', 0, j + 1, 4, 1);
      g.f(Math.floor(j / 4) % 2 ? 'white' : 'navy', 4, j + 1, 4, 1);
    }
    out.finishLine = c;
    c = newCanvas(4, ROAD_H);
    g = makeBrush(c.getContext('2d'), 4, 4);
    g.f('white', 1, 1, 2, ROAD_H - 3);
    g.f('silver', 0, 1, 1, ROAD_H - 3);
    g.f('grey', 3, 1, 1, ROAD_H - 3);
    out.startLine = c;
    return out;
  }

  // ---------------------------------------------------------------------------
  // Small drawing helpers used at render time
  // ---------------------------------------------------------------------------
  function drawTile(ctx, canvas, P, off, y) {
    const x = -mod(off, P);
    ctx.drawImage(canvas, x, y);
    if (x + P < W) ctx.drawImage(canvas, x + P, y);
  }

  function easeInOutSine(u) { return 0.5 - 0.5 * Math.cos(Math.PI * u); }
  function easeSlope(u) { return 0.5 * Math.PI * Math.sin(Math.PI * u); }

  // Per-lane time windows of a glide (fractions of the glide time). The player
  // always uses the full window, rivals start/stop a hair apart so the field
  // does not move in lockstep.
  const WINDOWS = [[0, 1], [0.06, 1], [0.02, 0.95], [0.1, 1]];

  function kartU(el, D, lane) {
    const w = WINDOWS[lane] || WINDOWS[0];
    const a = w[0] * D;
    const b = w[1] * D;
    return clamp((el - a) / (b - a), 0, 1);
  }

  // ---------------------------------------------------------------------------
  // The scene
  // ---------------------------------------------------------------------------
  function create(canvas, opts) {
    const o = opts || {};
    const hasDoc = typeof document !== 'undefined';
    let ctx = null;
    try {
      if (canvas && typeof canvas.getContext === 'function') {
        canvas.width = W;
        canvas.height = H;
        ctx = canvas.getContext('2d', { alpha: false });
      }
    } catch (e) { ctx = null; }

    const st = {
      theme: 'tulips',
      length: 10,
      racers: [],            // [{ id, lane }]
      playerId: null,
      pos: {},               // displayed positions (units) by id
      cam: 0,                // camera reference in world px (the player's front wheel)
      ambient: 0,            // seconds of ambient time, for idle drift
      idle: false,
      reduced: o.reducedMotion === undefined ? detectReduced() : !!o.reducedMotion,
      anim: null,
      destroyed: false,
      wheel: {}
    };
    let raf = 0;
    let timer = 0;
    let lastTs = 0;
    let mql = null;
    let baked = null;

    function detectReduced() {
      try {
        return !!(typeof window !== 'undefined' && window.matchMedia &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      } catch (e) { return false; }
    }

    function hidden() { return hasDoc && !!document.hidden; }
    function hasRaf() { return typeof requestAnimationFrame === 'function'; }
    function idleOn() { return st.idle && !st.reduced && !st.destroyed && !hidden() && !!ctx; }

    function playerRacer() {
      for (let i = 0; i < st.racers.length; i++) if (st.racers[i].id === st.playerId) return st.racers[i];
      return st.racers[0] || null;
    }

    function syncCam() {
      const p = playerRacer();
      st.cam = (p ? num0(st.pos[p.id]) : 0) * PPU;
    }

    // ---- rendering --------------------------------------------------------
    // `fx` carries the live glide state (puffs, speed lines, wheel frames).
    function render(fx) {
      if (!ctx || st.destroyed) return;
      try {
        paint(fx);
      } catch (e) { /* a drawing problem must never break the game */ }
    }

    function ensureBaked() {
      if (!baked || baked.id !== st.theme) baked = getBaked(st.theme);
      return baked;
    }

    function paint(fx) {
      const B = ensureBaked();
      ctx.imageSmoothingEnabled = false;
      ctx.globalAlpha = 1;
      const left = Math.round(st.cam) - REF_X;
      const t = st.ambient;
      const env = { ctx: ctx, t: t, left: left };

      if (B.sky) ctx.drawImage(B.sky, 0, 0);
      if (B.def.skyDyn) B.def.skyDyn(ctx, env);
      if (B.clouds) {
        const off = Math.round(left * 0.04 + t * 2.2);
        drawTile(ctx, B.clouds.canvas, B.clouds.P, off, B.clouds.top);
      }
      if (B.def.skyDyn2) B.def.skyDyn2(ctx, env);

      B.layers.forEach(function (L) {
        const off = Math.round(left * L.f + t * L.drift);
        drawTile(ctx, L.canvas, L.P, off, L.top);
        if (L.dyn) {
          L.dyn({
            ctx: ctx, t: t, off: off, P: L.P, left: left,
            // screen x of layer-space x, wrapped so that items near the seam stay continuous
            sx: function (x, margin) {
              const m = margin === undefined ? 40 : margin;
              return mod(x - off + m, L.P) - m;
            }
          }, L.S);
        }
      });

      // road tile, scrolling 1:1 with the ground
      if (B.road) {
        const off = left;
        const x0 = -mod(off, B.road.P);
        for (let x = x0; x < W; x += B.road.P) ctx.drawImage(B.road.canvas, x, ROAD_TOP);
      }

      const G = gateCache;
      if (G) {
        // start line + finish line on the road surface
        const sx = 0 - left;
        const fxp = Math.round(st.length * PPU) - left;
        if (sx > -8 && sx < W + 8) ctx.drawImage(G.startLine, sx - 2, ROAD_TOP);
        if (fxp > -12 && fxp < W + 12) ctx.drawImage(G.finishLine, fxp - 4, ROAD_TOP);
        // gates standing at the back edge of the road
        if (sx > -50 && sx < W + 50) ctx.drawImage(G.start, sx - 36, ROAD_TOP + 2 - 64);
        if (fxp > -50 && fxp < W + 50) ctx.drawImage(G.finish, fxp - 36, ROAD_TOP + 2 - 64);
      }

      drawKarts(B, left, fx);
      if (B.def.front) B.def.front(env);
      drawStrip();
    }

    function drawKarts(B, left, fx) {
      const S = RR.Sprites;
      if (!S || !S.draw) return;
      const order = st.racers.slice().sort(function (a, b) { return b.lane - a.lane; });
      order.forEach(function (r) {
        const refX = num0(st.pos[r.id]) * PPU - left;
        const x = Math.round(refX - KART_REF);
        const y = LANE_Y[r.lane];
        if (x < -24 || x > W + 24) return;
        // soft ground shadow (the sprites have none)
        ctx.globalAlpha = 0.22;
        ctx.fillStyle = col('navy');
        ctx.fillRect(x - 13, y, 27, 1);
        ctx.globalAlpha = 0.12;
        ctx.fillRect(x - 10, y + 1, 21, 1);
        ctx.globalAlpha = 1;
        if (fx && fx.puffs) drawPuffs(B, left, fx, r);
        const frame = fx && fx.frames ? (fx.frames[r.id] || 0) : 0;
        S.draw(ctx, r.id, x, y, { scale: 1, frame: frame, flip: false });
        if (fx && fx.boostLines && r.id === (playerRacer() || {}).id) drawSpeedLines(x, y, fx);
      });
    }

    function drawPuffs(B, left, fx, r) {
      const list = fx.puffs[r.id];
      if (!list) return;
      const dust = B.def.dust || 'cream';
      list.forEach(function (p) {
        const age = p.age;
        if (age < 0 || age > 1) return;
        const sx = Math.round(p.wx - left);
        const sy = Math.round(LANE_Y[r.lane] - 2 - age * 5);
        const rad = 1 + age * 1.6;
        ctx.globalAlpha = 0.5 * (1 - age);
        ctx.fillStyle = col(dust);
        const n = Math.round(rad);
        ctx.fillRect(sx - n, sy - n + 1, n * 2, n * 2 - 1);
        ctx.fillRect(sx - n - 1, sy - Math.floor(n / 2), n * 2 + 2, Math.max(1, n));
        ctx.globalAlpha = 1;
      });
    }

    function drawSpeedLines(x, y, fx) {
      const env = Math.sin(Math.PI * fx.u);
      if (env <= 0.02) return;
      const lines = [[-17, 5, 20], [-19, 11, 15], [-16, 16, 18]];
      ctx.fillStyle = col('white');
      lines.forEach(function (ln, i) {
        const len = Math.round(ln[2] * (0.6 + 0.4 * env));
        const y0 = y - ln[1];
        ctx.globalAlpha = 0.5 * env;
        ctx.fillRect(x + ln[0] - len, y0, len, 1);
        ctx.globalAlpha = 0.22 * env;
        ctx.fillRect(x + ln[0] - len - 3, y0, 3, 1);
        ctx.fillRect(x + ln[0], y0, 2, 1);
      });
      ctx.globalAlpha = 1;
    }

    // ---- progress strip -----------------------------------------------------
    function drawStrip() {
      const S = RR.Sprites;
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = col('white');
      ctx.fillRect(0, 0, W, STRIP_H - 1);
      ctx.globalAlpha = 1;
      ctx.fillStyle = col('slate');
      ctx.fillRect(0, STRIP_H - 1, W, 1);
      ctx.fillStyle = col('silver');
      ctx.fillRect(0, STRIP_H - 2, W, 1);
      const x0 = 14;
      const x1 = W - 28;
      // track line with a tick per unit
      ctx.fillStyle = col('grey');
      ctx.fillRect(x0 - 6, 16, x1 - x0 + 12, 1);
      const len = Math.max(1, st.length);
      ctx.fillStyle = col('slate');
      for (let u = 0; u <= len; u++) {
        const x = Math.round(x0 + (x1 - x0) * u / len);
        ctx.fillRect(x, 16, 1, u === 0 || u === len ? 3 : 2);
      }
      // finish flag at the end of the line
      const fx0 = x1 + 10;
      ctx.fillStyle = col('navy');
      ctx.fillRect(fx0, 3, 1, 15);
      for (let j = 0; j < 3; j++) {
        for (let i = 0; i < 4; i++) {
          ctx.fillStyle = col((i + j) % 2 ? 'white' : 'navy');
          ctx.fillRect(fx0 + 1 + i * 2, 3 + j * 2, 2, 2);
        }
      }
      ctx.fillStyle = col('navy');
      ctx.fillRect(fx0 + 1, 3, 8, 1);
      ctx.fillRect(fx0 + 1, 9, 8, 1);
      if (!S || !S.drawHead) return;
      const order = st.racers.slice().sort(function (a, b) { return b.lane - a.lane; });
      const player = playerRacer();
      order.forEach(function (r) {
        const x = Math.round(x0 + (x1 - x0) * clamp(num0(st.pos[r.id]) / len, 0, 1));
        const y = 8 + [2, 1, 0, -1][r.lane];
        if (player && r.id === player.id) {
          // soft highlight pad behind the player's head, plus a pointer onto the track
          ctx.fillStyle = col('navy');
          ctx.fillRect(x - 7, 1, 14, 14);
          ctx.fillRect(x - 1, 15, 3, 1);
          ctx.fillStyle = col('cream');
          ctx.fillRect(x - 6, 2, 12, 12);
          ctx.fillStyle = col('navy');
          ctx.fillRect(x - 7, 1, 1, 1); ctx.fillRect(x + 6, 1, 1, 1);
          ctx.fillRect(x - 7, 14, 1, 1); ctx.fillRect(x + 6, 14, 1, 1);
        }
        S.drawHead(ctx, r.id, x, y, { scale: 1 });
      });
    }

    // ---- loops ---------------------------------------------------------------
    function cancelLoops() {
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
      raf = 0;
      timer = 0;
    }

    function wake() {
      if (st.destroyed || raf || timer || !hasRaf()) return;
      if (st.anim) raf = requestAnimationFrame(animFrame);
      else if (idleOn()) timer = setTimeout(idleKick, IDLE_MS);
    }

    function idleKick() {
      timer = 0;
      if (st.destroyed) return;
      if (st.anim || !idleOn()) { wake(); return; }
      raf = requestAnimationFrame(idleFrame);
    }

    function idleFrame(ts) {
      raf = 0;
      if (!idleOn() || st.anim) { wake(); return; }
      const dt = lastTs ? clamp((ts - lastTs) / 1000, 0, 0.25) : IDLE_MS / 1000;
      lastTs = ts;
      st.ambient += dt;
      render(null);
      wake();
    }

    // ---- glides --------------------------------------------------------------
    function glideTime(maxd, boost) {
      const f = clamp((maxd - 0.5) / 2.5, 0, 1);
      return (GLIDE_MIN + (GLIDE_MAX - GLIDE_MIN) * f) * (boost ? BOOST_STRETCH : 1);
    }

    function evalAnim(a, el) {
      const D = a.D / 1000;
      const player = playerRacer();
      a.racers.forEach(function (r) {
        const u = kartU(el, D, r.lane);
        st.pos[r.id] = a.from[r.id] + (a.to[r.id] - a.from[r.id]) * easeInOutSine(u);
      });
      // camera: the player's own path, delayed a little
      if (player) {
        const uc = kartU(el - CAM_LAG, D, player.lane);
        st.cam = (a.from[player.id] + (a.to[player.id] - a.from[player.id]) * easeInOutSine(uc)) * PPU;
      }
    }

    function buildFx(a, el, dt) {
      const D = a.D / 1000;
      const fx = { frames: {}, puffs: {}, boostLines: a.boost, u: clamp(el / (D + CAM_LAG), 0, 1) };
      a.racers.forEach(function (r) {
        const dist = a.to[r.id] - a.from[r.id];
        const u = kartU(el, D, r.lane);
        const w = WINDOWS[r.lane] || WINDOWS[0];
        const span = D * (w[1] - w[0]);
        if (dist > 0.01 && u > 0 && u < 1) {
          const speed = dist * PPU * easeSlope(u) / span;            // px per second
          const rate = Math.min(WHEEL_HZ, speed / WHEEL_PX);
          a.wheel[r.id] = (a.wheel[r.id] || 0) + rate * dt;
        }
        fx.frames[r.id] = Math.floor(a.wheel[r.id] || 0) % 2;
        // dust puffs: one every 0.2 s while rolling, each lives 0.6 s, fixed in the world
        if (dist > 0.01) {
          const list = [];
          for (let k = 0; k < 8; k++) {
            const born = w[0] * D + 0.05 + k * 0.2;
            const bu = (born - w[0] * D) / span;
            if (bu >= 0.92 || born > el) break;
            if (easeSlope(bu) < 0.5) continue;
            const age = (el - born) / 0.6;
            if (age > 1) continue;
            const pos = a.from[r.id] + dist * easeInOutSine(bu);
            list.push({ age: age, wx: pos * PPU - KART_REF - 17 - (k % 2) * 2 });
          }
          fx.puffs[r.id] = list;
        }
      });
      return fx;
    }

    function animFrame(ts) {
      raf = 0;
      const a = st.anim;
      if (!a) { wake(); return; }
      if (a.t0 === null) { a.t0 = ts; a.last = ts; }
      const el = (ts - a.t0) / 1000;
      const dt = clamp((ts - a.last) / 1000, 0, 0.1);
      a.last = ts;
      st.ambient += dt;
      if (el >= (a.D / 1000) + CAM_LAG) { finishAnim(); render(null); wake(); return; }
      evalAnim(a, el);
      render(buildFx(a, el, dt));
      wake();
    }

    // Jump a running glide to its end and resolve its promise.
    function finishAnim() {
      const a = st.anim;
      if (!a) return;
      st.anim = null;
      a.racers.forEach(function (r) { st.pos[r.id] = a.to[r.id]; });
      syncCam();
      try { a.resolve(); } catch (e) { /* ignore */ }
    }

    function normalise(positions) {
      const out = {};
      st.racers.forEach(function (r) {
        out[r.id] = num0(positions && typeof positions === 'object' ? positions[r.id] : 0);
      });
      return out;
    }

    // ---- public API ------------------------------------------------------------
    const scene = {
      width: W,
      height: H,
      get theme() { return st.theme; },
      get length() { return st.length; },
      get reducedMotion() { return st.reduced; }
    };

    scene.setTrack = function (theme, length) {
      try {
        if (st.destroyed) return;
        finishAnim();
        st.theme = THEMES[theme] && typeof theme === 'string' && Object.prototype.hasOwnProperty.call(THEMES, theme) ? theme : 'tulips';
        const len = Number(length);
        st.length = isFinite(len) && len > 0 ? Math.min(len, 200) : 10;
        if (!gateCache) gateCache = bakeGates();
        render(null);
      } catch (e) { /* never throw */ }
    };

    scene.setRacers = function (racers, playerId) {
      try {
        if (st.destroyed) return;
        finishAnim();
        const list = Array.isArray(racers) ? racers.filter(function (r) { return r && typeof r.id === 'string'; }) : [];
        let pid = typeof playerId === 'string' ? playerId : null;
        if (pid === null) {
          const flagged = list.filter(function (r) { return r.isPlayer; })[0];
          const lane0 = list.filter(function (r) { return r.lane === 0; })[0];
          pid = flagged ? flagged.id : (lane0 ? lane0.id : (list[0] ? list[0].id : null));
        }
        // lanes: the player always in front, the others in the order given
        const others = list.map(function (r, i) { return { r: r, i: i }; })
          .filter(function (x) { return x.r.id !== pid; })
          .sort(function (a, b) { return ((typeof a.r.lane === 'number' ? a.r.lane : 9) - (typeof b.r.lane === 'number' ? b.r.lane : 9)) || (a.i - b.i); })
          .map(function (x) { return x.r.id; });
        const seen = {};
        const ids = (list.some(function (r) { return r.id === pid; }) ? [pid] : []).concat(others)
          .filter(function (id) { if (seen[id]) return false; seen[id] = 1; return true; })
          .slice(0, MAX_RACERS);
        const prev = st.pos;
        st.pos = {};
        st.racers = ids.map(function (id, lane) { st.pos[id] = num0(prev[id]); return { id: id, lane: lane }; });
        st.playerId = pid;
        st.wheel = {};
        syncCam();
        render(null);
      } catch (e) { /* never throw */ }
    };

    scene.place = function (positions) {
      try {
        if (st.destroyed) return;
        finishAnim();
        const n = normalise(positions);
        st.racers.forEach(function (r) { st.pos[r.id] = n[r.id]; });
        syncCam();
        render(null);
      } catch (e) { /* never throw */ }
    };

    scene.advanceTo = function (positions, opts2) {
      return new Promise(function (resolve) {
        try {
          finishAnim();
          const to = normalise(positions);
          const from = {};
          let maxd = 0;
          st.racers.forEach(function (r) {
            from[r.id] = st.pos[r.id] || 0;
            maxd = Math.max(maxd, Math.abs(to[r.id] - from[r.id]));
          });
          const animate = !st.destroyed && ctx && !st.reduced && !hidden() && hasRaf() && maxd > 0.001 && baked !== undefined;
          if (!animate) {
            st.racers.forEach(function (r) { st.pos[r.id] = to[r.id]; });
            syncCam();
            render(null);
            resolve();
            return;
          }
          const boost = !!(opts2 && opts2.boost);
          st.anim = {
            from: from, to: to, racers: st.racers.slice(), D: glideTime(maxd, boost), boost: boost,
            t0: null, last: 0, wheel: {}, resolve: resolve
          };
          cancelLoops();
          wake();
        } catch (e) { resolve(); }
      });
    };

    scene.setIdle = function (on) {
      try {
        st.idle = !!on;
        if (!st.idle) { cancelLoops(); lastTs = 0; if (st.anim) wake(); return; }
        lastTs = 0;
        if (!st.anim) { cancelLoops(); render(null); }
        wake();
      } catch (e) { /* never throw */ }
    };

    scene.setReducedMotion = function (on) {
      try {
        st.reduced = !!on;
        if (st.reduced) { finishAnim(); cancelLoops(); render(null); }
        else wake();
      } catch (e) { /* never throw */ }
    };

    scene.resize = function () {
      try {
        if (st.destroyed || !ctx) return;
        if (canvas.width !== W) canvas.width = W;
        if (canvas.height !== H) canvas.height = H;
        render(null);
      } catch (e) { /* never throw */ }
    };

    scene.positions = function () {
      const out = {};
      st.racers.forEach(function (r) { out[r.id] = st.pos[r.id]; });
      return out;
    };

    scene.destroy = function () {
      try {
        if (st.destroyed) return;
        finishAnim();
        st.destroyed = true;
        cancelLoops();
        if (hasDoc) document.removeEventListener('visibilitychange', onVisibility);
        if (mql && mql.removeEventListener) mql.removeEventListener('change', onMotionPref);
        baked = null;
      } catch (e) { /* never throw */ }
    };

    function onVisibility() {
      try {
        if (st.destroyed) return;
        if (hidden()) { finishAnim(); cancelLoops(); lastTs = 0; }
        else { lastTs = 0; render(null); wake(); }
      } catch (e) { /* never throw */ }
    }

    function onMotionPref(ev) { scene.setReducedMotion(!!ev.matches); }

    if (hasDoc) document.addEventListener('visibilitychange', onVisibility);
    if (o.reducedMotion === undefined) {
      try {
        mql = window.matchMedia('(prefers-reduced-motion: reduce)');
        if (mql.addEventListener) mql.addEventListener('change', onMotionPref);
      } catch (e) { mql = null; }
    }

    if (ctx) {
      gateCache = bakeGates();
      render(null);
    }
    return scene;
  }

  return {
    create: create,
    THEMES: THEME_IDS.slice(),
    SIZE: { width: W, height: H },
    PX_PER_UNIT: PPU,
    LANE_Y: LANE_Y.slice()
  };
})();
