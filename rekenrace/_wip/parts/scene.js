// Scene renderer for Rekenrace: the side-view race, drawn on one small canvas
// (320x144 logical pixels; CSS scales it up with image-rendering: pixelated).
//
// API (RR.Scene.create(canvas, { reducedMotion }) -> scene):
//   scene.setTrack(theme, length)   scenery + finish line at `length` units (unknown theme -> 'tulips')
//   scene.setRacers(racers, playerId)   racers as from RR.Race.racers (id, lane); the player is drawn in front
//   scene.place(positions)          jump instantly; a racer missing from `positions` is at 0
//   scene.advanceTo(positions, { boost })  eased glide of 0.9-1.4 s (boost: +15 % and soft speed lines);
//                                   returns a Promise that always resolves (also when destroyed / tab hidden)
//   scene.setIdle(on)               very slow ambient drift (clouds, sails, water) at <= 15 fps; nothing runs otherwise
//   scene.setReducedMotion(on)      instant moves, no wheel animation, no idle drift
//   scene.resize(), scene.destroy(), scene.positions(), scene.width / height / theme / length
//   RR.Scene.THEMES, RR.Scene.SIZE, RR.Scene.PX_PER_UNIT
// Public methods never throw. RR.Scene.onError (optional function) is a development hook that
// receives drawing errors, which are otherwise swallowed.
//
// Everything is baked once per theme into cached offscreen canvases (sky, parallax layers, road
// tile) and then only blitted, so a frame costs a few dozen drawImage calls. Nothing runs unless
// something is animating: a glide (requestAnimationFrame), or - only after setIdle(true) - the
// ambient drift. Time is used for animation only, never for game state.
//
// World model: positions are track units (0 = start line, `length` = finish line); one unit is
// PPU pixels. The camera follows the player; the player's reference point (front wheel) sits at
// REF_X on screen and rivals are drawn at their own distance from it. Depth is a slight oblique
// projection: each lane further back is drawn SHEAR px to the right, and the start and finish
// lines are slanted to match. Parallax layers repeat with a period just larger than the distance
// they scroll in one race, so every landmark is seen once and the tile seam stays out of sight.
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
  const SHEAR = 4;                 // oblique depth: each lane further back sits this many px to the right
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

  const badColours = {};
  function col(n) {
    if (PAL[n]) return PAL[n];
    if (typeof n === 'string' && n.charAt(0) === '#') return n;
    // a typo in a colour name must be loud during development, never a silent wrong colour
    if (!badColours[n]) {
      badColours[n] = 1;
      if (typeof RR !== 'undefined' && RR.Scene && typeof RR.Scene.onError === 'function') RR.Scene.onError(new Error('unknown colour ' + n));
    }
    return '#ff00ff';
  }

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

  // Horizontal slant of a world point at screen row y (0 at the front lane). Everything that
  // lies across the road (start line, finish line) is slanted by this, karts per lane.
  function shearOf(y) { return Math.round(SHEAR * (LANE_Y[0] - y) / (LANE_Y[0] - LANE_Y[1])); }

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

  // Gull: 9x3, wings up (0) or down (1); the outer two columns are the dark wing tips.
  const GULL = [
    ['xx.....xx', '.xxx.xxx.', '...xxx...'],
    ['...xxx...', '.xxx.xxx.', 'xx.....xx']
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
  function pine(g, x, base, h, body, hi, lo, trunk, bare, snow) {
    const th = Math.max(2, Math.round(h * (bare || 0.1)));
    g.f(trunk, x - 1, base - th, 2, th);
    const n = Math.max(3, Math.round(h / 8));
    const hw = Math.max(3, Math.round(h * 0.26));
    const F = h - th;
    const ht = Math.ceil(F / n * 1.8);
    for (let i = 0; i < n; i++) {
      const y0 = Math.round(base - h + i * (F - ht) / (n - 1));
      const half = Math.round(hw * (0.4 + 0.6 * i / (n - 1)));
      g.tri(body, x, y0, ht, half);
      if (snow) {
        g.tri(snow, x, y0, Math.max(2, Math.round(ht * 0.55)), Math.max(1, Math.round(half * 0.62)));
        g.f(mix(snow, 'sky', 0.35), x + 1, y0 + 1, 1, Math.max(1, Math.round(ht * 0.4)));
      }
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

  // Windmill tower with gallery and cap; registers its hub in S.mills so the
  // sails can be drawn (and turned) every frame. x = centre of the tower.
  function windmill(g, S, x, base, w, h, o) {
    const topW = Math.max(3, Math.round(w * 0.56));
    for (let r = 0; r < h; r++) {
      const ww = Math.round(topW + (w - topW) * r / Math.max(1, h - 1));
      const lx = x - Math.floor(ww / 2);
      const sh = Math.max(1, Math.round(ww * 0.3));
      g.f(o.wall, lx, base - h + r, ww, 1);
      g.f(o.hi, lx, base - h + r, 1, 1);
      g.f(o.shade, lx + ww - sh, base - h + r, sh, 1);
      if (h > 14 && r > 3 && r % 7 === 0) g.dith(null, o.shade, lx + 1, base - h + r, ww - 2, 1, 0.5);
    }
    if (w >= 8) {
      const gy = base - Math.round(h * 0.42);
      g.f(o.cap, x - Math.round(w * 0.5), gy, w + 1, 1);
      g.f(o.shade, x - Math.round(w * 0.5), gy + 1, w + 1, 1);
      g.dith(null, o.cap, x - Math.round(w * 0.5), gy - 2, w + 1, 2, 0.25);
      g.f(o.door, x - 1, base - 5, 3, 5);
      g.f('sky', x - 1, base - h + 5, 2, 3);
    }
    const capW = Math.round(topW / 2) + 1;
    g.ell(o.cap, x, base - h, capW, Math.max(1.5, w * 0.17));
    g.f(o.capHi, x - capW + 1, base - h - 1, Math.max(1, capW - 1), 1);
    if (w >= 8) g.f(o.cap, x - capW - 3, base - h + 1, 4, 1);          // tail pole
    g.f(o.brick, x - Math.round(w / 2) - 1, base - 2, w + 3, 2);
    S.mills.push({ x: x, y: base - h + 1, R: o.R, a0: o.a0 || 0, speed: o.speed || 1 });
  }

  // One windmill sail wheel: 4 arms with a lattice cloth. ang in radians.
  function drawSails(ctx, hx, hy, R, ang, cloth, frame, hazeMix) {
    const wd = Math.max(1, Math.round(R * 0.17));
    const c1 = hazeMix ? mix(cloth, hazeMix, 0.45) : col(cloth);
    const c2 = hazeMix ? mix(frame, hazeMix, 0.45) : col(frame);
    for (let k = 0; k < 4; k++) {
      const th = ang + k * Math.PI / 2;
      const cx = Math.cos(th);
      const cy = Math.sin(th);
      const s0 = Math.max(2, R * 0.22);
      for (let s = s0; s <= R; s += 0.5) {
        const px = hx + cx * s;
        const py = hy + cy * s;
        // arm
        ctx.fillStyle = c2;
        ctx.fillRect(Math.round(px), Math.round(py), 1, 1);
        if (R < 9) continue;
        // lattice cloth to one side of the arm
        for (let j = 1; j <= wd; j++) {
          const qx = Math.round(px - cy * j);
          const qy = Math.round(py + cx * j);
          const edge = j === wd || s > R - 0.6;
          const rung = (Math.round(s) % 4) === 0;
          ctx.fillStyle = (edge || rung) ? c2 : c1;
          if (!edge && !rung && ((Math.round(s) + j) & 1)) ctx.fillStyle = c1;
          ctx.fillRect(qx, qy, 1, 1);
        }
      }
    }
    ctx.fillStyle = c2;
    ctx.fillRect(Math.round(hx) - 1, Math.round(hy) - 1, 2, 2);
  }

  // Black-and-white cow in side view (16x10), facing right, or left with flip. x = left edge.
  function cow(g, x, base, flip) {
    const put = function (c, lx, ly, w, hgt) { g.f(c, flip ? x + 15 - lx - w + 1 : x + lx, base - ly - hgt, w, hgt); };
    [1, 3, 9, 11].forEach(function (lx) { put('white', lx, 0, 1, 3); put('navy', lx, 0, 1, 1); });
    put(mix('white', 'silver', 0.6), 3, 0, 1, 3);
    put(mix('white', 'silver', 0.6), 11, 0, 1, 3);
    put('white', 0, 3, 13, 5);                       // body
    put(mix('white', 'silver', 0.55), 0, 3, 13, 1);  // belly shade
    put('navy', 2, 5, 4, 2); put('navy', 3, 7, 2, 1);
    put('navy', 8, 4, 3, 3); put('navy', 9, 7, 2, 1);
    put('white', 12, 5, 4, 4);                       // head
    put('pink', 15, 5, 1, 2);
    put('navy', 13, 8, 1, 1);                        // eye
    put('navy', 12, 9, 1, 1); put('navy', 14, 9, 1, 1);   // ears
    put('white', 11, 6, 2, 1);                       // neck
    put('navy', -1, 4, 1, 4);                        // tail
  }

  // Gulls gliding across the sky. list items: { x0, y0, sp (px/s), ph, par (camera parallax) }.
  function drawGulls(ctx, env, list) {
    list.forEach(function (b) {
      const x = Math.round(mod(b.x0 + env.t * b.sp - env.left * b.par + 40, W + 100) - 60);
      const y = Math.round(b.y0 + 3 * Math.sin(env.t * 0.45 + b.ph));
      const rows = GULL[Math.floor(env.t * 1.8 + b.ph) & 1];
      for (let j = 0; j < rows.length; j++) {
        for (let i = 0; i < rows[j].length; i++) {
          if (rows[j].charAt(i) !== 'x') continue;
          const tip = (i <= 1 || i >= 7) && j !== 1;
          ctx.fillStyle = col(tip ? 'slate' : (j === 2 && rows[2].charAt(0) === '.' ? 'silver' : 'white'));
          ctx.fillRect(x + i, y + j, 1, 1);
        }
      }
    });
  }

  // Kites drifting slowly across the sky. list items: { x0, y0, sp, ph, a, b } (two kite colours).
  const KITE = ['...x...', '..xxx..', '.xxxxx.', 'xxxxxxx', '.xxxxx.', '..xxx..', '...x...'];
  function drawKites(ctx, env, list) {
    list.forEach(function (k) {
      const x = Math.round(mod(k.x0 + env.t * k.sp - env.left * 0.06 + 40, W + 100) - 60);
      const y = Math.round(k.y0 + 4 * Math.sin(env.t * 0.4 + k.ph));
      for (let j = 0; j < KITE.length; j++) {
        for (let i = 0; i < 7; i++) {
          if (KITE[j].charAt(i) !== 'x') continue;
          ctx.fillStyle = col(i < 3 || (i === 3 && j % 2) ? k.a : k.b);
          ctx.fillRect(x + i, y + j, 1, 1);
        }
      }
      ctx.fillStyle = col('slate');
      for (let s = 0; s < 8; s++) ctx.fillRect(x + 3 + Math.round(Math.sin(env.t * 1.3 + s * 0.8 + k.ph) * 1.2), y + 7 + s, 1, 1);
      ctx.fillStyle = col(k.a);
      ctx.fillRect(x + 2 + (Math.sin(env.t * 1.3 + 2.4 + k.ph) > 0 ? 1 : 0), y + 10, 2, 1);
      ctx.fillStyle = col(k.b);
      ctx.fillRect(x + 3 + (Math.sin(env.t * 1.3 + 5 + k.ph) > 0 ? 1 : 0), y + 13, 2, 1);
    });
  }

  // Butterfly, 3x2: wings open / closed, flapping at 4 frames per second at most.
  function drawButterfly(ctx, x, y, t, wing, ph) {
    const open = Math.floor(t * 4 + ph) & 1;
    ctx.fillStyle = col(wing);
    if (open) { ctx.fillRect(x, y, 1, 2); ctx.fillRect(x + 2, y, 1, 2); }
    else { ctx.fillRect(x + 1, y - 1, 1, 1); }
    ctx.fillStyle = col('navy');
    ctx.fillRect(x + 1, y, 1, 2);
  }

  // Butterflies wandering in loops around their home spot, in layer space (see dyn()).
  function butterfliesDyn(d, list) {
    list.forEach(function (b) {
      const x = d.sx(b.x + 14 * Math.sin(d.t * 0.37 + b.ph), 20);
      if (x < -4 || x > W + 4) return;
      const y = Math.round(b.y + 5 * Math.sin(d.t * 0.83 + b.ph * 1.7));
      drawButterfly(d.ctx, Math.round(x), y, d.t, b.c, b.ph);
    });
  }

  // Dune grass tuft: a few angled blades. x = centre, y = ground row.
  function tuft(g, x, y, h) {
    g.f('green', x, y - h, 1, h);
    g.f('lime', x - 1, y - h + 1, 1, h - 1);
    g.f(mix('lime', 'sand', 0.4), x + 1, y - h + 2, 1, h - 2);
    g.p('lime', x - 2, y - h + 3);
    g.p('green', x + 2, y - h + 3);
  }

  // Beach hut: striped walls and a pitched roof. x = left edge, base = ground row.
  function hut(g, x, base, c1, c2) {
    const w = 14;
    const h = 11;
    for (let i = 0; i < w; i++) g.f(i % 4 < 2 ? c1 : c2, x + i, base - h, 1, h);
    g.f(mix(c1, 'navy', 0.25), x + w - 2, base - h, 2, h);
    for (let r = 0; r < 6; r++) {
      const inset = Math.round(r * 1.2);
      g.f(c1, x - 1 + inset, base - h - 6 + r, w + 2 - inset * 2, 1);
    }
    g.f(mix(c1, 'navy', 0.3), x - 1, base - h - 1, w + 2, 1);
    g.f('bark', x + 5, base - 7, 4, 7);
    g.p('gold', x + 8, base - 4);
    g.f('sky', x + 1, base - 9, 2, 2);
  }

  // Fly agaric: red cap with white dots on a pale stem. x = centre, base = ground row.
  function mushroom(g, x, base, r) {
    g.f('cream', x, base - r, Math.max(1, Math.round(r / 2)), r);
    g.p('tan', x + Math.max(0, Math.round(r / 2) - 1), base - 1);
    g.ell('red', x, base - r - 1, r, Math.max(1.5, r * 0.6));
    g.f('brick', x - r, base - r, r * 2 + 1, 1);
    g.p('white', x - 1, base - r - 2);
    if (r > 2) g.p('white', x + r - 1, base - r - 1);
    if (r > 3) g.p('white', x - r + 1, base - r);
  }

  // Fern: a few arching fronds. x = root, base = ground row, r = reach.
  function fern(g, x, base, r, c1, c2) {
    for (let k = -2; k <= 2; k++) {
      const ex = x + k * Math.round(r * 0.45);
      const ey = base - Math.round(r * (1 - Math.abs(k) * 0.2));
      g.ln(k % 2 ? c1 : c2, x, base, ex, ey);
      g.p(c2, ex + (k < 0 ? 1 : -1), ey + 1);
      g.p(c1, Math.round((x + ex) / 2) + (k < 0 ? 1 : -1), Math.round((base + ey) / 2));
    }
  }

  // Gabled canal house. x = left edge, base = ground row, o = { wall, trim, shade, gable, haze, lit }.
  // gable: 'step' | 'bell' | 'neck' | 'spout'. haze (colour) blends it towards the distance.
  function canalHouse(g, x, base, w, h, o) {
    const hz = function (c) { return o.haze ? mix(c, o.haze, o.hazeT === undefined ? 0.45 : o.hazeT) : col(c); };
    const wall = hz(o.wall);
    const trim = hz(o.trim || 'white');
    const shade = hz(mix(o.wall, 'navy', 0.28));
    const top = base - h;
    g.f(wall, x, top, w, h);
    g.f(shade, x + w - 2, top, 2, h);
    const cx = x + Math.floor(w / 2);
    if (o.gable === 'step') {
      let ww = w;
      let yy = top;
      for (let i = 0; ww > 5; i++) {
        ww -= 4;
        yy -= 3;
        g.f(wall, x + (w - ww) / 2, yy, ww, 3);
        g.f(trim, x + (w - ww) / 2 - 1, yy, ww + 2, 1);
      }
      g.f(trim, x - 1, top, w + 2, 1);
    } else if (o.gable === 'bell') {
      g.ell(wall, cx, top, Math.floor(w / 2), 5);
      g.f(wall, x, top - 1, w, 2);
      g.f(trim, x - 1, top, w + 2, 1);
      g.ell(trim, cx, top - 5, 1, 1);
    } else if (o.gable === 'neck') {
      const nw = Math.max(5, w - 8);
      g.f(wall, cx - nw / 2, top - 8, nw, 8);
      g.tri(trim, cx, top - 12, 4, 2);
      g.f(trim, cx - nw / 2 - 1, top - 8, nw + 2, 1);
      g.f(trim, x - 1, top, w + 2, 1);
    } else {
      g.f(trim, x - 1, top, w + 2, 2);
      g.tri(wall, cx, top - 6, 6, Math.floor(w / 2));
      g.f(trim, cx - 1, top - 4, 3, 2);
      g.f(hz('navy'), cx, top - 3, 1, 1);
    }
    // hoisting beam with a hook
    if (o.beam !== false && w >= 12) { g.f(hz('bark'), cx, top - (o.gable === 'step' ? 9 : 5), 1, 2); }
    // windows: columns x rows, white frames
    const small = h < 36;
    const cols = w >= 20 ? 3 : 2;
    const ww = small ? 2 : 3;
    const wh = small ? 3 : 5;
    const rows = Math.max(1, Math.floor((h - (small ? 5 : 11)) / (small ? 6 : 9)));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const wx = x + Math.round((c + 0.5) * w / cols) - Math.floor(ww / 2);
        const wy = top + 4 + r * (small ? 6 : 9);
        const lit = o.lit && ((r * 7 + c * 3 + x) % 5 === 0);
        if (!small) g.f(trim, wx - 1, wy - 1, ww + 2, wh + 2);
        g.f(lit ? hz('yellow') : hz(r % 2 ? 'deepblue' : 'blue'), wx, wy, ww, wh);
        if (!small && !lit) g.f(hz(mix('sky', 'blue', 0.4)), wx, wy, 1, 2);
        if (!small) g.f(trim, wx + 1, wy, 1, wh);
        if (o.arch && !small) { g.p(wall, wx - 1, wy - 1); g.p(wall, wx + ww, wy - 1); }
        if (o.boxes && !small && r === rows - 1 && c % 2 === 0) { g.f(hz('fir'), wx - 1, wy + wh + 1, ww + 2, 1); g.p(hz('red'), wx, wy + wh); g.p(hz('pink'), wx + 2, wy + wh); }
      }
    }
    // ground floor: a shopfront with a striped awning, or a plain door with a step
    if (!small) {
      if (o.shop && w >= 16) {
        const sx0 = x + 2;
        const sw = w - 9;
        g.f(hz('brown'), sx0, base - 9, sw, 9);
        g.f(hz(mix('yellow', 'cream', 0.55)), sx0 + 1, base - 7, sw - 2, 5);
        g.f(hz('bark'), sx0 + 1, base - 3, sw - 2, 1);
        g.f(hz('red'), sx0 + 2, base - 6, 2, 2); g.f(hz('blue'), sx0 + 5, base - 6, 2, 2);
        for (let i = -1; i <= sw; i++) g.f(hz(Math.floor((i + 1) / 2) % 2 ? 'white' : o.shop), sx0 + i, base - 11, 1, 3);
        g.f(hz('bark'), x + w - 6, base - 7, 3, 7);
        g.f(trim, x + w - 7, base - 8, 5, 1);
      } else {
        g.f(hz(o.door || 'bark'), cx - 1, base - 7, 3, 7);
        g.f(trim, cx - 2, base - 8, 5, 1);
        g.f(hz('grey'), cx - 2, base - 1, 5, 1);
      }
    }
  }

  // Parked bicycle, 15x9, facing right. x = left edge, base = ground row.
  const WHEEL5 = ['.nnn.', 'n...n', 'n...n', 'n...n', '.nnn.'];
  function bike(g, x, base, frame) {
    g.m(x, base - 5, WHEEL5, { n: 'navy' });
    g.m(x + 8, base - 5, WHEEL5, { n: 'navy' });
    g.ln(frame, x + 2, base - 3, x + 4, base - 7);        // seat tube
    g.ln(frame, x + 4, base - 7, x + 10, base - 7);       // top tube
    g.ln(frame, x + 10, base - 7, x + 10, base - 3);      // fork
    g.ln(frame, x + 2, base - 3, x + 6, base - 3);        // chain stay
    g.ln(frame, x + 6, base - 3, x + 4, base - 7);
    g.f('bark', x + 2, base - 8, 3, 1);                   // saddle
    g.f('slate', x + 9, base - 9, 3, 1);                  // handlebar
    g.p('slate', x + 10, base - 8);
    g.f('tan', x + 11, base - 8, 3, 2);                   // basket
    g.f('bark', x + 11, base - 6, 3, 1);
  }

  // Wind turbine blades (three), drawn every frame so they can turn. x, y = hub.
  function drawTurbine(ctx, x, y, L, ang, color) {
    ctx.fillStyle = col(color);
    for (let k = 0; k < 3; k++) {
      const th = ang + k * 2.0944;
      for (let s = 1; s <= L; s += 0.5) ctx.fillRect(Math.round(x + Math.cos(th) * s), Math.round(y + Math.sin(th) * s), 1, 1);
    }
    ctx.fillRect(Math.round(x) - 1, Math.round(y) - 1, 2, 2);
  }

  // Container: body colour with corrugation lines and a darker end. x = left, base = bottom row.
  function container(g, x, base, w, c) {
    g.f(c, x, base - 7, w, 7);
    for (let i = 1; i < w - 1; i += 2) g.f(mix(c, 'navy', 0.16), x + i, base - 6, 1, 5);
    g.f(mix(c, 'white', 0.25), x, base - 7, w, 1);
    g.f(mix(c, 'navy', 0.3), x, base - 1, w, 1);
    g.f(mix(c, 'navy', 0.35), x + w - 1, base - 7, 1, 7);
  }

  // Gantry crane: two legs, a long boom, a cab and a container hanging from the trolley.
  function gantry(g, x, base, h, w, c1, c2, hang) {
    const top = base - h;
    g.f(c1, x, top, w, 3);                         // boom girder
    g.f(c2, x, top, w, 1);
    for (let i = 0; i < w - 4; i += 4) { g.ln(c2, x + i, top + 3, x + i + 2, top + 6); g.ln(c2, x + i + 2, top + 6, x + i + 4, top + 3); }
    g.f(c1, x + Math.round(w * 0.15), top + 3, 3, h - 3);        // legs
    g.f(mix(c1, 'navy', 0.25), x + Math.round(w * 0.15) + 2, top + 3, 1, h - 3);
    g.f(c1, x + Math.round(w * 0.45), top + 3, 3, h - 3);
    g.f(mix(c1, 'navy', 0.25), x + Math.round(w * 0.45) + 2, top + 3, 1, h - 3);
    g.f(c2, x + Math.round(w * 0.15), top + Math.round(h * 0.45), Math.round(w * 0.3) + 3, 2);   // cross beam
    g.f('white', x + Math.round(w * 0.58), top + 4, 7, 5);         // cab
    g.f('sky', x + Math.round(w * 0.58) + 1, top + 5, 5, 2);
    g.f('slate', x + Math.round(w * 0.58) + 2, top + 9, 1, hang);  // cables
    g.f('slate', x + Math.round(w * 0.58) + 5, top + 9, 1, hang);
    container(g, x + Math.round(w * 0.58) - 1, top + 9 + hang + 7, 9, 'orange');
  }

  // Castle on a hill: curtain wall, a keep and two round towers with conical roofs.
  // x = left edge, base = ground row, hz blends it a bit into the distance.
  function castle(g, x, base, hzT) {
    const hz = function (c) { return hzT ? mix(c, 'sky', hzT) : col(c); };
    const stone = hz(mix('silver', 'tan', 0.15));
    const shade = hz(mix('grey', 'slate', 0.3));
    const lit = hz('white');
    // curtain wall with battlements
    g.f(stone, x + 3, base - 12, 40, 12);
    g.f(shade, x + 3, base - 4, 40, 4);
    for (let i = 0; i < 40; i += 4) g.f(stone, x + 3 + i, base - 15, 3, 3);
    // keep
    g.f(stone, x + 16, base - 30, 14, 30);
    g.f(shade, x + 26, base - 30, 4, 30);
    g.f(lit, x + 16, base - 30, 1, 30);
    for (let i = 0; i < 14; i += 4) g.f(stone, x + 16 + i, base - 33, 3, 3);
    g.f(hz('navy'), x + 21, base - 24, 1, 4); g.f(hz('navy'), x + 26, base - 24, 1, 4);
    g.f(hz('navy'), x + 21, base - 16, 1, 4); g.f(hz('navy'), x + 26, base - 16, 1, 4);
    // flag
    g.f(hz('slate'), x + 22, base - 43, 1, 10);
    g.f(hz('red'), x + 23, base - 43, 5, 3);
    // round towers with roofs
    [0, 36].forEach(function (tx, i) {
      g.f(stone, x + tx, base - 24, 10, 24);
      g.f(shade, x + tx + 7, base - 24, 3, 24);
      g.f(lit, x + tx, base - 24, 1, 24);
      g.f(hz('navy'), x + tx + 4, base - 17, 1, 4);
      g.f(shade, x + tx - 1, base - 25, 12, 2);
      g.tri(hz(i ? 'brick' : 'deepblue'), x + tx + 5, base - 38, 13, 6);
      g.f(hz(i ? 'rust' : 'navy'), x + tx + 5, base - 38, 1, 13);
    });
    g.f(hz('navy'), x + 21, base - 8, 5, 8);             // gate
    g.ell(hz('navy'), x + 23, base - 8, 2, 2);
  }

  // Half-timbered farmhouse: white plaster, dark beams, red tile roof.
  function vakwerk(g, x, base, w, h) {
    g.f('white', x, base - h, w, h);
    g.f(mix('white', 'silver', 0.7), x + w - 3, base - h, 3, h);
    g.f('brown', x, base - 2, w, 2);                      // plinth beam
    g.f('brown', x, base - h, w, 1);
    g.f('brown', x, base - Math.round(h / 2), w, 1);      // storey beam
    for (let i = 0; i <= w - 1; i += 6) g.f('brown', x + i, base - h, 1, h);
    for (let i = 0; i < w - 6; i += 12) { g.ln('brown', x + i, base - 3, x + i + 5, base - Math.round(h / 2) - 1); g.ln('brown', x + i + 6, base - h + 1, x + i + 11, base - Math.round(h / 2) - 1); }
    roof(g, x - 2, base - h - 11, w + 4, 11, 'red', 'brick', true);
    for (let r = 2; r < 11; r += 3) g.dith(null, mix('red', 'white', 0.25), x + 2, base - h - 11 + r, w - 2, 1, 0.5);
    g.f('brick', x + 4, base - h - 15, 3, 6);
    g.f(mix('brick', 'navy', 0.3), x + 6, base - h - 15, 1, 6);
    // windows with green shutters and a door
    [Math.round(w * 0.2), Math.round(w * 0.62)].forEach(function (wx) {
      g.f('fir', x + wx - 1, base - h + 3, 1, 5); g.f('fir', x + wx + 4, base - h + 3, 1, 5);
      g.f('deepblue', x + wx, base - h + 3, 4, 5); g.f('white', x + wx + 1, base - h + 3, 1, 5);
    });
    g.f('bark', x + Math.round(w * 0.42), base - 8, 4, 8);
    g.p('gold', x + Math.round(w * 0.42) + 3, base - 4);
  }

  // Apple tree: round crown with a few red apples.
  function appleTree(g, x, base, r) {
    roundTree(g, x, base, r, 'green', 'lime', 'fir', 'bark');
    for (let i = 0; i < r; i++) g.p('red', x - r + 2 + ((i * 5) % (r * 2 - 2)), base - r * 1.5 - 3 + ((i * 3) % (r + 1)));
  }

  // Sheep: fluffy body, dark face and legs. x = left edge.
  function sheep(g, x, base) {
    g.ell('white', x + 4, base - 4, 4, 3);
    g.ell('cream', x + 3, base - 6, 2, 1);
    g.f('navy', x + 9, base - 5, 2, 2);
    g.p('navy', x + 2, base - 1); g.p('navy', x + 6, base - 1); g.p('navy', x + 2, base); g.p('navy', x + 6, base);
    g.f(mix('white', 'silver', 0.6), x + 1, base - 2, 7, 1);
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
    clouds: { n: 8, wmin: 24, wmax: 60, ymin: 34, ymax: 74, top: 14, body: 'white', shade: 'silver' },
    road: roadDef(mix('slate', 'grey', 0.5), { verge: 'green' }),
    layers: [
      // far: hazy tree line, church tower, tiny farms and one small mill on the flat horizon
      { f: 0.06, P: 352, top: 56, bake: function (g, S) {
        S.mills = [];
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
        g.rep(250, 12, function (q) {
          g.f(wall, q + 3, hz - 17, 6, 17);
          g.tri(rf, q + 6, hz - 29, 12, 3);
          g.f(mix('slate', 'sky', 0.5), q + 5, hz - 13, 2, 3);
        });
        [50, 150, 300].forEach(function (fx) {
          g.rep(fx, 12, function (q) {
            g.f(wall, q, hz - 5, 10, 5);
            roof(g, q - 1, hz - 9, 12, 4, rf, mix(rf, 'navy', 0.2), true);
          });
        });
        windmill(g, S, 100, hz, 4, 11, { a0: 0.6, R: 6, wall: wall, hi: mix('white', 'sky', 0.4), shade: mix('tan', 'sky', 0.5), cap: mix('bark', 'sky', 0.5), capHi: mix('tan', 'sky', 0.5), door: rf, brick: rf });
      }, dyn: function (d, S) {
        S.mills.forEach(function (m) {
          const x = d.sx(m.x, m.R + 8);
          if (x < -m.R - 4 || x > W + m.R + 4) return;
          drawSails(d.ctx, x, m.y, m.R, m.a0 + d.t * 0.17, 'cream', mix('bark', 'slate', 0.4), mix('sky', 'ice', 0.25));
        });
      } },
      // mid-far: patchwork of striped bulb fields, with a farm among them
      { f: 0.22, P: 440, top: 60, bake: function (g) {
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
        [210, 232, 285, 360, 380].forEach(function (tx, i) {
          g.rep(tx, 6, function (q) { poplar(g, q + 3, 85, g.r(15, 22), mix('fir', 'green', 0.4), 'lime', 'bark'); });
        });
        g.rep(110, 16, function (q) { roundTree(g, q + 8, 85, 6, mix('green', 'fir', 0.3), 'lime', 'fir', 'bark'); });
        g.rep(400, 16, function (q) { roundTree(g, q + 8, 85, 5, mix('green', 'fir', 0.3), 'lime', 'fir', 'bark'); });
      } },
      // mid: bulb rows close up with poplars and a proper farmstead behind them
      { f: 0.55, P: 608, top: 44, bake: function (g) {
        const P = g.P;
        const gb = 91;                                     // where the bulb rows start
        g.f(mix('green', 'lime', 0.3), 0, gb - 3, P, ROAD_TOP - gb + 3);
        g.rep(380, 76, function (q) {
          house(g, q, gb, 30, 12, { wall: 'white', shade: mix('white', 'silver', 0.7), roof: 'red', roofShade: 'brick', roofH: 9, frame: 'bark', win: 'sky', door: 'blue', chim: 'brick' });
          house(g, q + 34, gb, 24, 9, { wall: mix('cream', 'tan', 0.3), shade: mix('tan', 'bark', 0.4), roof: 'brick', roofShade: mix('brick', 'navy', 0.3), roofH: 9, gable: true, frame: 'cream', win: 'bark', door: 'bark' });
          roundTree(g, q + 66, gb, 7, 'green', 'lime', 'fir', 'bark');
          roundTree(g, q - 8, gb, 6, 'green', 'lime', 'fir', 'bark');
        });
        [20, 38, 56, 74, 92, 500, 518, 536, 554, 572].forEach(function (px, i) {
          g.rep(px, 7, function (q) { poplar(g, q + 3, gb, 26 + (i * 7) % 9, 'fir', 'green', 'bark'); });
        });
        // striped bulb rows between the farm and the road: leaf row, then two-tone flower rows, nearer rows taller
        const pairs = [['red', 'yellow'], ['pink', 'white'], ['yellow', 'orange'], ['lilac', 'pink'], ['orange', 'red'], ['white', 'pink'], ['purple', 'lilac'], ['red', 'pink']];
        const leaf = mix('fir', 'green', 0.4);
        const stripes = [1, 2, 1, 2, 1, 2, 1, 3];
        let x = 0;
        while (x < P) {
          const w = Math.min(g.r(100, 190), P - x);
          const pair = g.pick(pairs);
          let y = gb;
          stripes.forEach(function (sh, i) {
            for (let xx = 0; xx < w; xx++) {
              if (i % 2 === 0) { g.f(leaf, x + xx, y, 1, sh); continue; }
              const c = pair[(i >> 1) % 2];
              const light = mix(c, 'white', 0.34);
              const dark = mix(c, 'navy', 0.16);
              if (sh === 2) { g.p(xx % 4 < 2 ? light : c, x + xx, y); g.p(xx % 4 < 2 ? c : dark, x + xx, y + 1); }
              else { g.p(light, x + xx, y + (xx % 4 < 2 ? 0 : 1)); g.p(c, x + xx, y + (xx % 4 < 2 ? 1 : 0)); g.p(dark, x + xx, y + 2); }
            }
            y += sh;
          });
          g.f('sand', x, gb - 1, 2, 14);
          x += w;
        }
      } },
      // near: grass shoulder, white fence pieces and tulips along the road
      { f: 1, P: 832, top: 86, bake: function (g, S) {
        const P = g.P;
        S.bf = [];
        ['yellow', 'white', 'orange', 'white', 'pink'].forEach(function (c, i) { S.bf.push({ x: 80 + i * 170, y: 92 + (i % 3) * 2, c: c, ph: i * 1.9 }); });
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
      }, dyn: function (d, S) { butterfliesDyn(d, S.bf); } }
    ]
  };

  // 2. Molenpolder: flat polder, ditches, cows, a dike and windmills with turning sails.
  THEMES.windmill = {
    sky: [mix('sky', 'blue', 0.14), 'sky', mix('sky', 'ice', 0.5), 'ice', mix('ice', 'apricot', 0.2)],
    clouds: { n: 7, wmin: 34, wmax: 72, ymin: 32, ymax: 76, top: 14, body: 'white', shade: mix('silver', 'sky', 0.3) },
    road: roadDef(mix('slate', 'tan', 0.35), { verge: 'lime' }),
    layers: [
      // far: haze, tiny mills, a church spire
      { f: 0.06, P: 352, top: 56, bake: function (g, S) {
        S.mills = [];
        const hz = 88;
        const haze = mix('green', 'sky', 0.58);
        const dark = mix('fir', 'sky', 0.66);
        g.f(haze, 0, hz, g.P, ROAD_TOP - hz);
        let x = 0;
        while (x < g.P) {
          const w = g.r(8, 18);
          const h = g.r(2, 6);
          g.rep(x, w, function (q) { g.ell(dark, q + w / 2, hz - h / 2 + 1, w / 2, h / 2 + 1); });
          x += g.r(6, 18);
        }
        g.f(dark, 0, hz, g.P, 2);
        const o = { wall: mix('cream', 'sky', 0.5), hi: mix('white', 'sky', 0.4), shade: mix('tan', 'sky', 0.5), cap: mix('bark', 'sky', 0.5), capHi: mix('tan', 'sky', 0.5), door: dark, brick: dark, R: 6 };
        windmill(g, S, 110, hz, 4, 11, Object.assign({ a0: 0.3 }, o));
        windmill(g, S, 250, hz, 4, 10, Object.assign({ a0: 1.1, speed: 0.8 }, o));
        windmill(g, S, 320, hz, 4, 12, Object.assign({ a0: 0.7, speed: 1.2 }, o));
        g.rep(190, 10, function (q) {
          g.f(mix('cream', 'sky', 0.45), q + 3, hz - 10, 4, 10);
          g.tri(mix('slate', 'sky', 0.5), q + 5, hz - 19, 9, 2);
        });
      }, dyn: function (d, S) {
        S.mills.forEach(function (m) {
          const x = d.sx(m.x, m.R + 8);
          if (x < -m.R - 4 || x > W + m.R + 4) return;
          drawSails(d.ctx, x, m.y, m.R, m.a0 + d.t * 0.17 * m.speed, 'cream', mix('bark', 'slate', 0.4), mix('sky', 'ice', 0.25));
        });
      } },
      // mid-far: patchwork polder with ditches, cows, poplars and a pair of mills
      { f: 0.2, P: 432, top: 46, bake: function (g, S) {
        S.mills = [];
        const P = g.P;
        const hz = 85;
        const greens = [mix('green', 'sky', 0.2), mix('lime', 'sky', 0.15), mix('green', 'lime', 0.5), mix('lime', 'sand', 0.3), mix('green', 'sky', 0.1)];
        g.f(greens[0], 0, hz, P, ROAD_TOP - hz);
        let x = 0;
        while (x < P) {
          const w = Math.min(g.r(40, 110), P - x);
          const c = g.pick(greens);
          g.f(c, x, hz, w, 6);
          g.f(mix(c, 'green', 0.4), x, hz + 6, w, 13);
          // mowing stripes
          for (let i = 0; i < w; i += 6) g.f(mix(c, 'lime', 0.35), x + i, hz + 2, 3, 4);
          x += w;
        }
        // ditches
        g.f(mix('sky', 'blue', 0.35), 0, hz + 7, P, 1);
        g.f(mix('sky', 'blue', 0.45), 0, hz + 13, P, 1);
        const o = { wall: 'cream', hi: 'white', shade: 'tan', cap: 'bark', capHi: 'tan', door: 'bark', brick: 'brick', R: 12 };
        windmill(g, S, 150, hz + 1, 8, 21, Object.assign({ a0: 0.2 }, o));
        windmill(g, S, 350, hz + 1, 7, 18, Object.assign({ a0: 0.9, speed: 0.85, R: 10 }, o));
        [60, 78, 96, 270, 286, 410].forEach(function (px, i) {
          g.rep(px, 7, function (q) { poplar(g, q + 3, hz + 1, 14 + (i * 5) % 8, mix('fir', 'green', 0.4), 'lime', 'bark'); });
        });
        g.rep(215, 20, function (q) {
          house(g, q, hz + 1, 14, 6, { wall: 'cream', shade: mix('tan', 'cream', 0.4), roof: 'brick', roofShade: mix('brick', 'navy', 0.25), roofH: 5, frame: 'white', win: 'deepblue', door: 'bark' });
        });
        // far cows: three-pixel dots
        [20, 200, 290, 320, 400, 420].forEach(function (cx, i) {
          g.rep(cx, 5, function (q) { g.f('white', q, hz + 10, 4, 2); g.p('navy', q + 1, hz + 10); g.p('navy', q + 3, hz + 11); });
        });
      }, dyn: function (d, S) {
        S.mills.forEach(function (m) {
          const x = d.sx(m.x, m.R + 8);
          if (x < -m.R - 4 || x > W + m.R + 4) return;
          drawSails(d.ctx, x, m.y, m.R, m.a0 + d.t * 0.17 * m.speed, 'cream', 'bark', mix('sky', 'ice', 0.15));
        });
      } },
      // mid: big mills behind the dike, willows, a farm, cows in the meadow
      { f: 0.5, P: 576, top: 28, bake: function (g, S) {
        S.mills = [];
        const P = g.P;
        const dike = function (x) { return 92 + Math.round(1.5 * Math.sin(x / P * Math.PI * 6) + 1.1 * Math.sin(x / P * Math.PI * 14 + 1)); };
        // meadow behind the dike
        g.f(mix('green', 'lime', 0.4), 0, 88, P, 12);
        const o = { wall: 'cream', hi: 'white', shade: 'tan', cap: 'bark', capHi: 'tan', door: 'bark', brick: 'brick' };
        windmill(g, S, 250, 95, 18, 37, Object.assign({ a0: 0.5, R: 23 }, o));
        windmill(g, S, 470, 95, 14, 28, Object.assign({ a0: 1.4, R: 18, speed: 0.9 }, o));
        g.rep(350, 40, function (q) {
          house(g, q, 94, 24, 11, { wall: 'white', shade: mix('white', 'silver', 0.7), roof: 'red', roofShade: 'brick', roofH: 9, frame: 'bark', win: 'sky', door: 'blue', chim: 'brick' });
          roundTree(g, q + 30, 94, 6, 'green', 'lime', 'fir', 'bark');
          roundTree(g, q - 7, 94, 5, 'green', 'lime', 'fir', 'bark');
        });
        // willows along the dike
        [60, 130, 300, 420, 520, 556].forEach(function (wx, i) {
          g.rep(wx - 9, 20, function (q) {
            const bx = q + 9;
            const by = dike(wx) + 3;
            g.f('bark', bx - 1, by - 8, 3, 8); g.p('brown', bx + 1, by - 6);
            g.ell(mix('green', 'fir', 0.25), bx, by - 11, 7, 4);
            g.ell('green', bx - 1, by - 13, 5, 3);
            g.dith(null, 'lime', bx - 6, by - 14, 8, 3, 0.4);
            for (let k = -6; k <= 6; k += 3) g.f(mix('green', 'lime', 0.3), bx + k, by - 8, 1, 3 + (k % 2 ? 1 : 0));
          });
        });
        // the dike itself: shaded bank, sunlit top with a footpath
        for (let x = 0; x < P; x++) {
          const y = dike(x);
          g.f(mix('green', 'fir', 0.2), x, y + 1, 1, 98 - y);
          g.p('sand', x, y); g.p(mix('lime', 'sand', 0.5), x, y - 1 + (x % 5 === 0 ? 0 : 1));
          if (x % 2 === 0) g.p('fir', x, 96);
          g.p('lime', x, y + 1);
        }
        g.f(mix('lime', 'green', 0.5), 0, 98, P, 2);
        // fence posts with wire along the foot
        for (let x = 0; x < P; x += 11) { g.f('bark', x, 93, 1, 7); g.p('tan', x, 93); }
        g.f(mix('grey', 'tan', 0.4), 0, 95, P, 1);
        // cows in the meadow, facing both ways
        [315, 360, 520, 100, 200, 440].forEach(function (cx, i) {
          g.rep(cx, 18, function (q) { cow(g, q, 100, i % 2 === 1); });
        });
      }, dyn: function (d, S) {
        S.mills.forEach(function (m) {
          const x = d.sx(m.x, m.R + 8);
          if (x < -m.R - 4 || x > W + m.R + 4) return;
          drawSails(d.ctx, x, m.y, m.R, m.a0 + d.t * 0.17 * m.speed, 'cream', 'bark', null);
        });
      } },
      // near: ditch with reeds, ducks and a bank
      { f: 1, P: 832, top: 84, bake: function (g, S) {
        const P = g.P;
        S.sparks = [];
        S.ducks = [];
        g.f('green', 0, 98, P, 3);
        g.f(mix('green', 'lime', 0.5), 0, 98, P, 1);
        for (let i = 0; i < 200; i++) g.p(g.pick(['lime', 'fir', mix('lime', 'sand', 0.3)]), g.r(0, P - 1), g.r(98, 100));
        // water lilies
        g.spread(10, 0.9).forEach(function (lx) { g.rep(lx, 5, function (q) { g.f('green', q, 102, 4, 1); g.p('pink', q + 1, 101); g.p('white', q + 2, 101); }); });
        const water = mix('sky', 'blue', 0.45);
        g.f(water, 0, 101, P, 3);
        g.f(mix(water, 'white', 0.3), 0, 101, P, 1);
        for (let i = 0; i < 90; i++) { const wx = g.r(0, P - 6); g.f(mix(water, 'white', 0.22), wx, g.r(102, 103), g.r(2, 5), 1); }
        g.f(mix(water, 'navy', 0.25), 0, 103, P, 1);
        for (let i = 0; i < 14; i++) S.sparks.push({ x: g.r(0, P - 1), y: g.r(101, 103), ph: g.rnd() * 6 });
        for (let i = 0; i < 3; i++) S.ducks.push({ x: g.r(0, P - 1), ph: g.rnd() * 6 });
        // reeds and cattails
        g.spread(26, 0.9).forEach(function (rx, i) {
          const hgt = g.r(8, 15);
          const tip = g.chance(0.6);
          g.rep(rx, 6, function (q) {
            g.f('green', q + 2, 100 - hgt, 1, hgt);
            g.p('lime', q + 1, 100 - hgt + 2);
            g.p('green', q + 3, 100 - hgt + 4);
            if (tip) g.f('bark', q + 2, 100 - hgt - 1, 1, 3);
            g.p('green', q + 1, 98); g.p('green', q + 3, 97);
          });
        });
        // posts
        g.spread(5, 0.6).forEach(function (px) {
          g.rep(px, 3, function (q) { g.f('bark', q, 93, 2, 9); g.f('tan', q, 93, 1, 9); g.f('grey', q - 1, 93, 4, 1); });
        });
      }, dyn: function (d, S) {
        const ctx = d.ctx;
        S.sparks.forEach(function (s) {
          if (Math.sin(d.t * 1.2 + s.ph * 2.3) < 0.55) return;
          const x = d.sx(s.x, 4);
          if (x < -2 || x > W + 2) return;
          ctx.fillStyle = col('white');
          ctx.fillRect(x, s.y, 2, 1);
        });
        S.ducks.forEach(function (du) {
          const x = d.sx(du.x, 12);
          if (x < -8 || x > W + 8) return;
          const bob = Math.sin(d.t * 1.4 + du.ph) > 0.4 ? 1 : 0;
          const y = 100 + bob;
          ctx.fillStyle = col('white'); ctx.fillRect(x, y, 5, 2); ctx.fillRect(x + 3, y - 1, 2, 1);
          ctx.fillStyle = col('green'); ctx.fillRect(x + 4, y - 2, 2, 2);
          ctx.fillStyle = col('orange'); ctx.fillRect(x + 6, y - 1, 1, 1);
          ctx.fillStyle = col('silver'); ctx.fillRect(x, y + 1, 5, 1);
        });
      } }
    ]
  };

  // 3. Strand en duinen: dunes with marram grass, beach huts, a pavilion, sea and gulls.
  THEMES.beach = {
    sky: [mix('sky', 'blue', 0.14), 'sky', mix('sky', 'ice', 0.4), 'ice', mix('ice', 'cream', 0.45)],
    clouds: { n: 4, wmin: 24, wmax: 46, ymin: 36, ymax: 66, top: 14, body: 'white', shade: mix('silver', 'sky', 0.3) },
    skyDyn2: function (ctx, env) {
      drawGulls(ctx, env, [
        { x0: 40, y0: 38, sp: 6, ph: 0.4, par: 0.1 },
        { x0: 150, y0: 52, sp: 5, ph: 2.1, par: 0.12 },
        { x0: 250, y0: 30, sp: 7, ph: 4.0, par: 0.08 }
      ]);
      drawKites(ctx, env, [
        { x0: 90, y0: 30, sp: 2.5, ph: 0.8, a: 'red', b: 'yellow' },
        { x0: 230, y0: 40, sp: 2, ph: 3.1, a: 'blue', b: 'white' }
      ]);
    },
    road: roadDef(mix('grey', 'sand', 0.45), { verge: 'sand' }),
    layers: [
      // far: the sea with a ship and a sailing boat, then a strip of beach
      { f: 0.04, P: 352, top: 56, bake: function (g, S) {
        const P = g.P;
        const hz = 72;
        const rows = [mix('blue', 'sky', 0.35), mix('blue', 'sky', 0.2), mix('blue', 'aqua', 0.15), mix('teal', 'aqua', 0.35), mix('aqua', 'teal', 0.45), mix('aqua', 'sky', 0.2)];
        rows.forEach(function (c, i) { g.f(c, 0, hz + i * 2, P, 2); });
        g.f(mix('aqua', 'sky', 0.2), 0, hz + 12, P, 3);
        g.f(mix('blue', 'white', 0.25), 0, hz, P, 1);
        // foam line and wet sand
        g.dith('white', mix('aqua', 'white', 0.3), 0, hz + 15, P, 1, 0.5);
        g.f(mix('sand', 'tan', 0.35), 0, hz + 16, P, 2);
        g.f('sand', 0, hz + 18, P, 20);
        for (let i = 0; i < 120; i++) g.p(g.chance(0.5) ? 'cream' : 'tan', g.r(0, P - 1), g.r(hz + 17, hz + 24));
        // ship on the horizon
        g.rep(120, 22, function (q) {
          g.f(mix('slate', 'sky', 0.2), q, hz - 3, 18, 3);
          g.f(mix('red', 'sky', 0.2), q + 1, hz - 4, 16, 1);
          g.f('white', q + 12, hz - 7, 4, 4);
          g.f(mix('slate', 'sky', 0.3), q + 13, hz - 9, 2, 2);
          g.f(mix('brick', 'sky', 0.3), q + 3, hz - 6, 3, 2); g.f(mix('blue', 'sky', 0.3), q + 6, hz - 6, 3, 2);
        });
        g.rep(250, 10, function (q) {
          g.tri('white', q + 4, hz - 10, 9, 3); g.f('silver', q + 5, hz - 5, 1, 3);
          g.f('bark', q, hz - 1, 10, 1); g.f('navy', q + 1, hz, 8, 1);
          g.f(mix('slate', 'sky', 0.2), q + 4, hz - 11, 1, 10);
        });
        S.sparks = [];
        for (let i = 0; i < 26; i++) S.sparks.push({ x: g.r(0, P - 1), y: g.r(hz + 2, hz + 13), ph: g.rnd() * 6 });
        S.dashes = [];
        for (let r = 0; r < 4; r++) for (let i = 0; i < 8; i++) S.dashes.push({ x: g.r(0, P - 1), y: hz + 3 + r * 3, sp: 1.5 + r * 0.9, w: 3 + r });
      }, dyn: function (d, S) {
        const ctx = d.ctx;
        S.dashes.forEach(function (ds) {
          const x = d.sx(mod(ds.x + d.t * ds.sp, d.P), 8);
          if (x < -8 || x > W + 8) return;
          ctx.fillStyle = col(mix('aqua', 'white', 0.45));
          ctx.fillRect(x, ds.y, ds.w, 1);
        });
        S.sparks.forEach(function (s) {
          if (Math.sin(d.t * 1.1 + s.ph * 2.9) < 0.6) return;
          const x = d.sx(s.x, 4);
          if (x < -2 || x > W + 2) return;
          ctx.fillStyle = col('white');
          ctx.fillRect(x, s.y, 2, 1);
        });
      } },
      // mid-far: rolling dunes with marram grass; the sea shows in the gaps
      { f: 0.18, P: 416, top: 60, bake: function (g) {
        const P = g.P;
        const dune = function (x) {
          return Math.round(85 + 7 * Math.sin(x / P * Math.PI * 6 + 0.5) + 3 * Math.sin(x / P * Math.PI * 14 + 2) + 4 * Math.sin(x / P * Math.PI * 4 + 4));
        };
        const sand = mix('sand', 'sky', 0.1);
        for (let x = 0; x < P; x++) {
          const y = dune(x);
          const slope = dune((x + 2) % P) - dune((x + P - 2) % P);
          g.f(sand, x, y, 1, ROAD_TOP - y);
          g.p(mix('cream', 'white', 0.3), x, y);
          if (slope > 1) g.dith(null, mix('tan', 'sand', 0.3), x, y + 1, 1, Math.min(6, 2 + slope), 0.55);
          if (slope < -1) g.p('cream', x, y + 1);
        }
        for (let i = 0; i < 40; i++) {
          const tx = g.r(0, P - 1);
          const ty = dune(tx);
          const th = g.r(3, 5);
          g.rep(tx - 2, 5, function (q) { tuft(g, q + 2, ty + 1, th); });
        }
      } },
      // mid: huts, the pavilion, parasols on the beach
      { f: 0.5, P: 576, top: 62, bake: function (g) {
        const P = g.P;
        g.f('sand', 0, 99, P, 5);
        g.f(mix('sand', 'tan', 0.35), 0, 99, P, 1);
        for (let i = 0; i < 220; i++) g.p(g.chance(0.5) ? 'cream' : 'tan', g.r(0, P - 1), g.r(100, 103));
        const palette = [['red', 'white'], ['blue', 'white'], ['yellow', 'white'], ['teal', 'white'], ['pink', 'white']];
        const huts = [[20, 0], [38, 2], [56, 1], [440, 3], [458, 4], [476, 0], [510, 1]];
        huts.forEach(function (h) {
          g.rep(h[0] - 2, 18, function (q) { hut(g, q + 2, 101, palette[h[1]][0], palette[h[1]][1]); });
        });
        // pavilion on stilts
        g.rep(250, 56, function (q) {
          for (let i = 0; i < 52; i += 6) g.f('bark', q + 2 + i, 95, 2, 6);
          g.f('tan', q, 93, 56, 2);
          g.f('bark', q, 95, 56, 1);
          g.f('white', q + 3, 79, 50, 14);
          g.f(mix('white', 'silver', 0.7), q + 46, 79, 7, 14);
          g.f('red', q, 74, 56, 5);
          g.f('brick', q, 78, 56, 1);
          for (let i = 0; i < 56; i += 4) g.f(i % 8 < 4 ? 'red' : 'white', q + i, 74, 4, 2);
          for (let i = 0; i < 5; i++) { g.f('sky', q + 6 + i * 9, 83, 6, 7); g.f('white', q + 9 + i * 9, 83, 1, 7); g.f('navy', q + 6 + i * 9, 83, 6, 1); }
          g.f('bark', q + 24, 85, 8, 8);
          g.f('navy', q + 28, 66, 1, 8);
          g.f('yellow', q + 29, 66, 6, 3); g.f('red', q + 29, 69, 6, 2);
          g.f('tan', q, 91, 56, 1); for (let i = 0; i < 56; i += 4) g.f('bark', q + i, 89, 1, 3);
        });
        // parasols
        [150, 190, 360, 395, 540].forEach(function (px, i) {
          const c = ['red', 'blue', 'yellow', 'orange', 'pink'][i];
          g.rep(px - 7, 16, function (q) {
            g.f('bark', q + 7, 90, 1, 11);
            for (let r = 0; r < 4; r++) { const half = 3 + r * 2; g.f(r % 2 ? 'white' : c, q + 7 - half, 85 + r, half * 2 + 1, 1); }
            g.f('white', q + 1, 89, 14, 1);
          });
        });
      } },
      // near: sand shoulder, rope fence, grass tufts, shells, a beach flag
      { f: 1, P: 832, top: 70, bake: function (g) {
        const P = g.P;
        g.f('sand', 0, 100, P, 4);
        g.f(mix('sand', 'cream', 0.5), 0, 100, P, 1);
        for (let i = 0; i < 200; i++) g.p(g.chance(0.5) ? 'cream' : 'tan', g.r(0, P - 1), g.r(100, 103));
        g.spread(22, 0.9).forEach(function (x) { const th = g.r(4, 8); g.rep(x - 2, 5, function (q) { tuft(g, q + 2, 103, th); }); });
        g.spread(8, 0.9).forEach(function (x) {
          g.rep(x, 4, function (q) { g.f('white', q, 102, 2, 1); g.p('blush', q + 2, 103); });
        });
        // rope fence on wooden posts
        [[100, 150], [420, 480], [640, 700]].forEach(function (seg) {
          const a = seg[0];
          const b = seg[1];
          g.rep(a - 2, b - a + 6, function (q) {
            for (let x = 0; x <= b - a; x += 10) { g.f('bark', q + x + 2, 94, 2, 9); g.f('tan', q + x + 2, 94, 1, 9); }
            for (let x = 0; x <= b - a - 10; x += 10) for (let k = 0; k <= 10; k++) {
              g.p('cream', q + x + 4 + k, 96 + Math.round(1.8 * Math.sin(k / 10 * Math.PI)));
            }
          });
        });
        // beach flag
        g.rep(260, 12, function (q) {
          g.f('silver', q + 1, 78, 1, 25);
          g.f('red', q + 2, 79, 9, 3); g.f('yellow', q + 2, 82, 9, 3);
          g.p('brick', q + 10, 80);
        });
      } }
    ]
  };

  // 4. Dennenbos: tall pines, birches, ferns, mushrooms and dapples of sunlight on the path.
  THEMES.forest = {
    sky: [mix('sky', 'lime', 0.2), mix('sky', 'ice', 0.45), mix('ice', 'lime', 0.3), mix('ice', 'cream', 0.35), mix('cream', 'lime', 0.25)],
    clouds: null,
    road: roadDef(mix('bark', 'tan', 0.4), {
      verge: 'fir',
      paint: function (g, rh) {
        // dapples of light: solid soft centres with a dithered rim
        const base = mix('bark', 'tan', 0.4);
        const lit = mix(base, 'cream', 0.42);
        const rim = mix(base, 'cream', 0.22);
        for (let i = 0; i < 8; i++) {
          const cx = g.r(0, 127);
          const cy = g.r(8, rh - 8);
          const rx = g.r(6, 13);
          const ry = g.r(2, 5);
          [0, -128, 128].forEach(function (k) {
            for (let y = -ry; y <= ry; y++) for (let x = -rx; x <= rx; x++) {
              const q = (x * x) / (rx * rx) + (y * y) / (ry * ry);
              if (q > 1) continue;
              if (q < 0.5) g.p(lit, cx + x + k, cy + y);
              else if (bay(cx + x + k, cy + y) < 0.5) g.p(rim, cx + x + k, cy + y);
            }
          });
        }
      }
    }),
    layers: [
      // far: hazy pines, soft shafts of light
      { f: 0.05, P: 352, top: 14, bake: function (g) {
        const P = g.P;
        const hz = 92;
        const haze = mix('fir', 'sky', 0.62);
        const hazeLo = mix('green', 'sky', 0.55);
        g.f(hazeLo, 0, hz, P, ROAD_TOP - hz);
        for (let x = 0; x < P; x += g.r(7, 14)) {
          const h = g.r(36, 62);
          g.rep(x - 8, 17, function (q) { pine(g, q + 8, hz + 2, h, haze, mix(haze, 'white', 0.18), mix(haze, 'navy', 0.12), haze, 0.05); });
        }
        // light shafts: diagonal, dithered
        [40, 150, 260].forEach(function (sx) {
          for (let y = 20; y < hz; y++) {
            const x0 = sx + Math.round((y - 20) * 0.5);
            const w = 16 + Math.round((y - 20) * 0.1);
            const fade = 0.26 * Math.min(1, (y - 20) / 20) * (1 - (y - 20) / (hz - 20) * 0.6);
            for (let x = 0; x < w; x++) {
              const edge = Math.sin(Math.PI * (x + 0.5) / w);
              if (bay(x0 + x, y) < fade * edge) g.rep(x0 + x, 1, function (q) { g.p(mix('cream', 'white', 0.5), q, y); });
            }
          }
        });
      } },
      // mid-far: darker pines, wall of trunks
      { f: 0.2, P: 432, top: 6, bake: function (g) {
        const P = g.P;
        const hz = 97;
        const body = mix('fir', 'sky', 0.28);
        const hi = mix('green', 'sky', 0.25);
        const lo = mix('deepteal', 'fir', 0.5);
        g.f(mix('fir', 'sky', 0.35), 0, hz - 2, P, ROAD_TOP - hz + 2);
        for (let x = 0; x < P; x += g.r(15, 26)) {
          const h = g.r(52, 84);
          g.rep(x - 11, 23, function (q) { pine(g, q + 11, hz, h, body, hi, lo, 'bark', 0.2); });
        }
        // a few birches
        [90, 220, 360].forEach(function (bx) {
          g.rep(bx - 8, 16, function (q) {
            const x = q + 8;
            g.f(mix('white', 'sky', 0.25), x, 56, 2, hz - 56);
            for (let y = 60; y < hz; y += 5) g.p('slate', x + (y % 2), y);
            g.ell(mix('lime', 'green', 0.3), x, 52, 7, 6);
            g.ell(mix('lime', 'sky', 0.2), x - 2, 49, 4, 3);
          });
        });
      } },
      // mid: big pines with bare trunks, ferns, mushrooms, a log
      { f: 0.5, P: 576, top: 0, bake: function (g) {
        const P = g.P;
        const hz = 99;
        g.f(mix('green', 'fir', 0.5), 0, 96, P, ROAD_TOP - 96);
        const xs = g.spread(7, 0.5);
        xs.forEach(function (x, i) {
          const h = g.r(70, 98);
          g.rep(x - 18, 37, function (q) { pine(g, q + 18, hz, h, 'fir', 'green', mix('fir', 'navy', 0.3), 'bark', 0.24); });
        });
        // moss floor
        g.f(mix('green', 'fir', 0.35), 0, 97, P, 7);
        for (let i = 0; i < 260; i++) g.p(g.pick(['lime', 'fir', 'green', 'bark']), g.r(0, P - 1), g.r(97, 103));
        // log
        g.rep(380, 28, function (q) {
          g.f('brown', q, 95, 26, 6);
          g.f('bark', q + 1, 95, 24, 4);
          g.f('tan', q + 2, 95, 20, 1);
          g.ell('tan', q + 25, 98, 2, 2); g.p('bark', q + 25, 98);
          g.f('green', q + 4, 94, 12, 1); g.p('lime', q + 6, 93); g.p('lime', q + 10, 93);
          mushroom(g, q + 14, 94, 2);
        });
        g.spread(12, 0.8).forEach(function (x, i) {
          g.rep(x - 6, 13, function (q) { fern(g, q + 6, 102, g.r(7, 10), 'green', 'lime'); });
        });
        [70, 230, 330, 470, 540].forEach(function (mx, i) {
          g.rep(mx - 6, 12, function (q) { mushroom(g, q + 5, 102, 3 + (i % 3)); mushroom(g, q + 9, 102, 2); });
        });
        [150, 440].forEach(function (rx) {
          g.rep(rx - 8, 18, function (q) {
            g.ell('grey', q + 8, 100, 7, 4);
            g.ell('silver', q + 6, 98, 4, 2);
            g.f('slate', q + 3, 103, 11, 1);
            g.dith(null, 'green', q + 3, 96, 8, 2, 0.4);
          });
        });
      } },
      // near: thick trunks in the foreground, roots and tall ferns at the verge
      { f: 1, P: 832, top: 0, bake: function (g, S) {
        const P = g.P;
        S.bf = [];
        ['yellow', 'white', 'orange'].forEach(function (c, i) { S.bf.push({ x: 90 + i * 260, y: 88 + (i % 2) * 4, c: c, ph: i * 2.1 }); });
        g.f(mix('green', 'fir', 0.3), 0, 101, P, 3);
        for (let i = 0; i < 180; i++) g.p(g.pick(['lime', 'fir', 'green', 'bark']), g.r(0, P - 1), g.r(101, 103));
        [210, 640].forEach(function (tx, i) {
          const w = 9 + i * 2;
          g.rep(tx - w, w * 2 + 6, function (q) {
            const x = q + w;
            // branches with dark needles at the top, so the trunk does not simply stop
            g.ell(mix('fir', 'navy', 0.2), x - w / 2 - 6, 24, 11, 7);
            g.ell('fir', x + w / 2 + 5, 30, 10, 6);
            g.ell(mix('fir', 'navy', 0.2), x + 2, 14, 12, 8);
            g.dith(null, 'green', x - w / 2 - 14, 20, 12, 4, 0.3);
            g.dith(null, 'green', x + 2, 26, 12, 4, 0.3);
            g.f('brown', x - w / 2 - 1, 0, w + 2, 104);
            g.f('bark', x - w / 2, 0, w, 104);
            g.f('rust', x - w / 2 + 1, 0, 2, 104);
            g.f(mix('bark', 'brown', 0.5), x + w / 2 - 3, 0, 3, 104);
            for (let y = 4; y < 100; y += g.r(5, 9)) g.f('brown', x - w / 2 + g.r(1, w - 3), y, g.r(1, 2), g.r(3, 5));
            // roots
            g.f('bark', x - w / 2 - 3, 99, 3, 5); g.f('bark', x + w / 2 + 1, 99, 3, 5);
            g.f('brown', x - w / 2 - 4, 102, 2, 2); g.f('brown', x + w / 2 + 3, 102, 2, 2);
            g.f(mix('green', 'fir', 0.3), x - w / 2 - 5, 100, w + 10, 2);
            g.f('green', x - w / 2 - 2, 98, 3, 2); g.f('lime', x - w / 2 - 1, 97, 2, 1);
          });
        });
        g.spread(14, 0.9).forEach(function (x, i) {
          g.rep(x - 7, 15, function (q) { fern(g, q + 7, 103, g.r(7, 12), i % 2 ? 'green' : 'lime', 'fir'); });
        });
        g.spread(6, 0.8).forEach(function (x) { g.rep(x - 6, 12, function (q) { mushroom(g, q + 5, 103, 3); mushroom(g, q + 9, 103, 2); }); });
      }, dyn: function (d, S) { butterfliesDyn(d, S.bf); } }
    ]
  };

  // 5. Grachtenstad: gabled canal houses on the far bank, reflections, a bridge, bikes at the railing.
  THEMES.canal = {
    sky: [mix('sky', 'lilac', 0.14), 'sky', mix('sky', 'ice', 0.55), mix('ice', 'blush', 0.3), mix('blush', 'cream', 0.5)],
    clouds: { n: 5, wmin: 28, wmax: 54, ymin: 34, ymax: 60, top: 14, body: mix('white', 'blush', 0.25), shade: mix('lilac', 'silver', 0.5) },
    road: roadDef(mix('brick', 'silver', 0.42), {
      verge: 'slate',
      speckN: 0,
      dash: null,
      paint: function (g, rh) {
        // clinker bricks in a running bond; each brick a touch different
        const base = mix('brick', 'silver', 0.42);
        for (let y = 3; y < rh - 3; y += 3) {
          const off = (y / 3) % 2 ? 0 : 4;
          for (let x = -off; x < 128; x += 8) {
            const c = g.pick([mix(base, 'white', 0.1), base, mix(base, 'brick', 0.2), mix(base, 'sand', 0.22), mix(base, 'white', 0.04), mix(base, 'slate', 0.12)]);
            g.f(c, x, y, 7, 2);
            g.f(mix(base, 'navy', 0.18), x + 7, y, 1, 3);
          }
          g.f(mix(base, 'navy', 0.14), 0, y + 2, 128, 1);
        }
      }
    }),
    layers: [
      // far: skyline of rooftops and spires, hazy
      { f: 0.05, P: 352, top: 40, bake: function (g) {
        const hz = 91;
        const haze = mix('lilac', 'sky', 0.55);
        const roof = mix('slate', 'sky', 0.62);
        const wall = mix('cream', 'sky', 0.55);
        g.f(mix(haze, 'ice', 0.4), 0, hz - 4, g.P, ROAD_TOP - hz + 4);
        let x = 0;
        while (x < g.P) {
          const w = g.r(9, 15);
          const h = g.r(14, 26);
          const kind = g.r(0, 3);
          g.rep(x, w + 2, function (q) {
            g.f(mix(wall, kind % 2 ? 'blush' : 'sand', 0.3), q, hz - h, w, h);
            if (kind === 0) g.tri(roof, q + w / 2, hz - h - 7, 7, Math.floor(w / 2) + 1);
            else if (kind === 1) { g.f(roof, q - 1, hz - h - 1, w + 2, 1); g.f(roof, q + 2, hz - h - 4, w - 4, 3); }
            else g.tri(roof, q + w / 2, hz - h - 5, 5, Math.floor(w / 2) + 1);
          });
          x += w + g.r(0, 2);
        }
        // church towers with spires
        [70, 190, 290].forEach(function (tx, i) {
          g.rep(tx, 10, function (q) {
            g.f(mix('brick', 'sky', 0.55), q + 2, hz - 40 - i * 3, 6, 40 + i * 3);
            g.f(mix('white', 'sky', 0.4), q + 3, hz - 33 - i * 3, 4, 4);
            g.tri(mix('slate', 'sky', 0.5), q + 5, hz - 56 - i * 3, 16, 3);
            g.f(mix('gold', 'sky', 0.5), q + 5, hz - 60 - i * 3, 1, 4);
          });
        });
      } },
      // mid-far: the second row of houses and elms, hazy
      { f: 0.2, P: 432, top: 30, bake: function (g) {
        const hz = 93;
        const walls = ['brick', 'cream', 'sand', mix('brick', 'bark', 0.4), mix('red', 'brick', 0.5), mix('tan', 'cream', 0.4)];
        const gables = ['step', 'bell', 'neck', 'spout'];
        g.f(mix('cream', 'sky', 0.5), 0, hz - 3, g.P, ROAD_TOP - hz + 3);
        let x = 0;
        while (x < g.P) {
          const w = g.r(11, 16);
          const h = g.r(24, 38);
          const spec = { wall: g.pick(walls), gable: g.pick(gables), haze: mix('sky', 'lilac', 0.3), hazeT: 0.45, beam: false };
          g.rep(x, w + 2, function (q) { canalHouse(g, q, hz, w, h, spec); });
          x += w + 1;
        }
        [150, 290, 390].forEach(function (tx) {
          g.rep(tx, 18, function (q) { roundTree(g, q + 9, hz, 8, mix('green', 'sky', 0.4), mix('lime', 'sky', 0.4), mix('fir', 'sky', 0.4), mix('bark', 'sky', 0.4)); });
        });
      } },
      // mid: the canal houses on the far bank, a bridge, water with reflections
      { f: 0.5, P: 576, top: 4, bake: function (g, S) {
        const P = g.P;
        const q0 = 88;                                   // far quay line
        const walls = ['brick', mix('red', 'brick', 0.5), mix('brick', 'bark', 0.45), 'cream', 'sand', mix('tan', 'cream', 0.3), mix('orange', 'sand', 0.55), mix('deepteal', 'slate', 0.4)];
        const gables = ['step', 'bell', 'neck', 'spout', 'step', 'bell'];
        // sky/haze behind the houses is whatever the lower layers draw; fill the quay and water
        const water = mix('blue', 'sky', 0.25);
        g.f(mix('slate', 'grey', 0.3), 0, q0, P, 2);
        g.f(water, 0, q0 + 2, P, ROAD_TOP - q0 - 2);
        // houses: a row with a gap for the bridge
        const bridgeX = 330;
        const bridgeW = 44;
        let x = 6;
        const placed = [];
        while (x < P - 18) {
          if (x > bridgeX - 18 && x < bridgeX + bridgeW) { x = bridgeX + bridgeW + 2; continue; }
          const w = g.r(15, 23);
          if (x + w > P - 2) break;
          const h = g.r(38, 58);
          placed.push({ x: x, w: w, h: h, spec: { wall: g.pick(walls), gable: g.pick(gables), lit: g.chance(0.5), haze: null, door: g.pick(['bark', 'brown', 'deepteal', 'fir']), shop: g.chance(0.35) ? g.pick(['red', 'blue', 'fir', 'orange', 'teal']) : null, arch: g.chance(0.4), boxes: g.chance(0.4) } });
          x += w + g.r(0, 1);
        }
        placed.forEach(function (hs) { canalHouse(g, hs.x, q0, hs.w, hs.h, hs.spec); });
        // the bridge in the gap
        g.rep(bridgeX, bridgeW, function (q) {
          const dk = q0 - 11;
          g.f('brick', q, dk, bridgeW, q0 - dk + 2);
          g.f(mix('brick', 'white', 0.18), q, dk, bridgeW, 1);
          g.f(mix('brick', 'navy', 0.3), q, dk + 2, bridgeW, 1);
          for (let r = 0; r < 4; r++) for (let c = 0; c < bridgeW; c += 5) g.p(mix('brick', 'bark', 0.3), q + c + (r % 2) * 2, dk + 3 + r * 2);
          // arch opening with a glimpse of the side canal
          g.ell(mix('deepblue', 'navy', 0.3), q + bridgeW / 2, q0 + 2, 15, 9);
          g.ell(mix('blue', 'sky', 0.3), q + bridgeW / 2, q0 + 2, 11, 6);
          g.f(water, q + 4, q0, bridgeW - 8, 4);
          g.f(mix('sky', 'ice', 0.3), q + bridgeW / 2 - 3, q0 - 4, 6, 4);
          g.f('cream', q + bridgeW / 2 - 2, q0 - 3, 4, 2);
          g.f('white', q - 1, dk - 2, bridgeW + 2, 2);
          for (let c = 0; c < bridgeW; c += 4) g.f('navy', q + c, dk - 6, 1, 4);
          g.f('navy', q, dk - 6, bridgeW, 1);
          // lamp posts
          [3, bridgeW - 4].forEach(function (lx) { g.f('fir', q + lx, dk - 24, 1, 22); g.f('fir', q + lx - 1, dk - 24, 3, 1); g.f('yellow', q + lx - 1, dk - 22, 3, 4); g.f('fir', q + lx - 1, dk - 23, 3, 1); g.f('fir', q + lx - 1, dk - 18, 3, 1); });
        });
        // elm trees in front of some houses
        [150, 440, 510].forEach(function (tx) {
          g.rep(tx - 12, 26, function (q) { roundTree(g, q + 12, q0 + 1, 11, 'green', 'lime', 'fir', 'brown'); });
        });
        // reflections: mirror the houses into the water, darker and rippled
        const rh = ROAD_TOP - q0 - 2;
        const tmp = newCanvas(P, rh);
        tmp.getContext('2d').drawImage(g.ctx.canvas, 0, q0 - rh - g.top, P, rh, 0, 0, P, rh);
        g.ctx.globalAlpha = 0.5;
        for (let i = 0; i < rh; i++) {
          const dx = i % 3 === 1 ? 1 : (i % 3 === 2 ? -1 : 0);
          g.ctx.drawImage(tmp, 0, rh - 1 - i, P, 1, dx, q0 + 2 + i, P, 1);
        }
        g.ctx.globalAlpha = 1;
        g.ctx.globalAlpha = 0.16;
        g.f(mix('deepblue', 'navy', 0.2), 0, q0 + 2, P, rh);
        g.ctx.globalAlpha = 1;
        for (let i = 0; i < 70; i++) g.f(mix(water, 'white', 0.3), g.r(0, P - 6), q0 + 2 + g.r(0, rh - 1), g.r(2, 6), 1);
        // a moored boat
        g.rep(200, 36, function (q) {
          g.f('deepteal', q, q0 + 2, 34, 4);
          g.f('navy', q + 1, q0 + 5, 32, 1);
          g.f('white', q + 3, q0 - 2, 14, 4);
          g.f('sky', q + 5, q0 - 1, 2, 2); g.f('sky', q + 9, q0 - 1, 2, 2); g.f('sky', q + 13, q0 - 1, 2, 2);
          g.f('brick', q + 2, q0 - 3, 16, 1);
          g.f('red', q + 28, q0 - 1, 1, 3);
        });
        S.sparks = [];
        for (let i = 0; i < 22; i++) S.sparks.push({ x: g.r(0, P - 1), y: g.r(q0 + 3, ROAD_TOP - 1), ph: g.rnd() * 6 });
      }, dyn: function (d, S) {
        S.sparks.forEach(function (s) {
          if (Math.sin(d.t * 1.1 + s.ph * 2.9) < 0.6) return;
          const x = d.sx(s.x, 4);
          if (x < -2 || x > W + 2) return;
          d.ctx.fillStyle = col('white');
          d.ctx.fillRect(x, s.y, 2, 1);
        });
      } },
      // near: pavement, railing, bikes, lamp posts and one big elm
      { f: 1, P: 832, top: 6, bake: function (g) {
        const P = g.P;
        // elm canopy (high up) and trunk
        [560].forEach(function (tx) {
          g.rep(tx - 40, 80, function (q) {
            const x = q + 40;
            g.f('brown', x - 3, 40, 7, 64);
            g.f('bark', x - 2, 40, 5, 64);
            g.f('rust', x - 2, 40, 1, 64);
            g.f('brown', x - 6, 98, 13, 6);
            g.ell(mix('green', 'fir', 0.35), x, 24, 36, 17);
            g.ell('green', x - 4, 21, 31, 13);
            g.ell('lime', x - 12, 14, 14, 6);
            g.dith(null, 'fir', x - 30, 24, 60, 14, 0.2);
            for (let i = 0; i < 40; i++) g.p('lime', x + g.r(-30, 28), g.r(8, 30));
          });
        });
        // pavement
        g.f(mix('silver', 'grey', 0.4), 0, 101, P, 3);
        for (let x = 0; x < P; x += 8) g.f(mix('grey', 'slate', 0.2), x, 101, 1, 3);
        g.f('silver', 0, 101, P, 1);
        g.f(mix('slate', 'grey', 0.5), 0, 103, P, 1);
        // railing
        for (let x = 0; x < P; x += 10) g.f('navy', x, 96, 1, 5);
        g.f('slate', 0, 96, P, 1);
        // bikes in little groups
        const frames = ['red', 'teal', 'yellow', 'blue', 'green', 'orange', 'purple'];
        [[60, 2], [210, 3], [320, 1], [430, 2], [650, 3], [740, 1]].forEach(function (b, bi) {
          g.rep(b[0] - 4, b[1] * 12 + 6, function (q) {
            for (let k = 0; k < b[1]; k++) bike(g, q + 3 + k * 12, 103, frames[(bi * 3 + k) % frames.length]);
          });
        });
        // lamp posts
        [150, 500].forEach(function (lx) {
          g.rep(lx - 4, 9, function (q) {
            g.f('fir', q + 4, 70, 1, 33); g.f('fir', q + 3, 101, 3, 3);
            g.f('fir', q + 2, 66, 5, 1); g.f('yellow', q + 3, 67, 3, 3); g.f('fir', q + 2, 70, 5, 1); g.f('fir', q + 4, 64, 1, 2);
            g.p('white', q + 3, 67);
          });
        });
      } }
    ]
  };

  // 6. Haven: cranes, containers, boats, a lighthouse, wind turbines on the horizon.
  THEMES.harbour = {
    sky: [mix('sky', 'blue', 0.12), 'sky', mix('sky', 'ice', 0.5), mix('ice', 'cream', 0.25), mix('cream', 'apricot', 0.12)],
    clouds: { n: 5, wmin: 36, wmax: 78, ymin: 34, ymax: 62, top: 14, body: 'white', shade: mix('silver', 'sky', 0.35) },
    skyDyn2: function (ctx, env) {
      drawGulls(ctx, env, [
        { x0: 20, y0: 36, sp: 7, ph: 1.2, par: 0.1 },
        { x0: 120, y0: 50, sp: 6, ph: 3.3, par: 0.12 },
        { x0: 230, y0: 32, sp: 8, ph: 5.0, par: 0.08 }
      ]);
    },
    road: roadDef(mix('silver', 'grey', 0.4), {
      verge: 'slate',
      frontPaint: function (g) {
        // hazard stripes along the quay edge (back kerb)
        for (let x = 0; x < 128; x++) {
          const c = Math.floor(x / 4) % 2 ? 'navy' : 'yellow';
          g.p(c, x, 0); g.p(c, x, 1);
        }
      }
    }),
    layers: [
      // far: grey sea, turbines, a container ship, a smudge of port skyline
      { f: 0.04, P: 352, top: 50, bake: function (g, S) {
        const P = g.P;
        const hz = 80;
        const sea = [mix('slate', 'sky', 0.55), mix('slate', 'sky', 0.4), mix('blue', 'slate', 0.45), mix('blue', 'slate', 0.55), mix('blue', 'slate', 0.4)];
        sea.forEach(function (c, i) { g.f(c, 0, hz + i * 4, P, 4); });
        g.f(mix('grey', 'sky', 0.5), 0, hz, P, 1);
        g.f(mix('blue', 'slate', 0.4), 0, hz + 20, P, ROAD_TOP - hz - 20);
        for (let i = 0; i < 130; i++) g.f(mix('blue', 'sky', 0.4), g.r(0, P - 5), g.r(hz + 2, hz + 20), g.r(2, 5), 1);
        // port skyline smudge
        let x = 0;
        while (x < P) {
          const w = g.r(6, 14);
          const h = g.r(3, 9);
          g.rep(x, w, function (q) { g.f(mix('slate', 'sky', 0.62), q, hz - h, w, h); });
          x += w + g.r(2, 10);
        }
        [60, 170, 250, 320].forEach(function (cx, i) {
          g.rep(cx, 3, function (q) { g.f(mix('slate', 'sky', 0.62), q, hz - 18, 2, 17); g.f(mix('white', 'sky', 0.4), q, hz - 18, 2, 3); });
        });
        // container ship
        g.rep(90, 40, function (q) {
          g.f(mix('slate', 'sky', 0.35), q, hz + 1, 38, 4);
          g.f(mix('red', 'sky', 0.4), q, hz + 1, 38, 1);
          const cs = [mix('brick', 'sky', 0.4), mix('blue', 'sky', 0.4), mix('teal', 'sky', 0.4), mix('orange', 'sky', 0.4)];
          for (let i = 0; i < 6; i++) g.f(cs[i % 4], q + 2 + i * 4, hz - 4, 4, 5);
          g.f(mix('white', 'sky', 0.3), q + 28, hz - 8, 8, 9);
          g.f(mix('slate', 'sky', 0.4), q + 30, hz - 5, 4, 1);
        });
        S.turbines = [];
        [40, 130, 215, 300].forEach(function (tx, i) {
          g.f(mix('white', 'sky', 0.2), tx, hz - 24 + (i % 2) * 3, 1, 23 - (i % 2) * 3);
          S.turbines.push({ x: tx, y: hz - 24 + (i % 2) * 3, L: 8 + (i % 2), a0: i * 1.3, sp: 0.4 + i * 0.06 });
        });
        S.sparks = [];
        for (let i = 0; i < 22; i++) S.sparks.push({ x: g.r(0, P - 1), y: g.r(hz + 3, hz + 20), ph: g.rnd() * 6 });
      }, dyn: function (d, S) {
        S.turbines.forEach(function (tb) {
          const x = d.sx(tb.x, 14);
          if (x < -12 || x > W + 12) return;
          drawTurbine(d.ctx, x, tb.y, tb.L, tb.a0 + d.t * tb.sp, mix('white', 'sky', 0.1));
        });
        S.sparks.forEach(function (s) {
          if (Math.sin(d.t * 1.2 + s.ph * 2.7) < 0.62) return;
          const x = d.sx(s.x, 4);
          if (x < -2 || x > W + 2) return;
          d.ctx.fillStyle = col(mix('white', 'sky', 0.3));
          d.ctx.fillRect(x, s.y, 2, 1);
        });
      } },
      // mid-far: the basin with boats, the far quay with warehouses and cranes
      { f: 0.18, P: 416, top: 34, bake: function (g) {
        const P = g.P;
        const q0 = 90;
        const water = mix('blue', 'slate', 0.3);
        g.f(water, 0, q0 + 2, P, ROAD_TOP - q0 - 2);
        for (let i = 0; i < 100; i++) g.f(mix(water, 'sky', 0.35), g.r(0, P - 6), g.r(q0 + 3, ROAD_TOP - 1), g.r(2, 6), 1);
        // far quay with low sheds
        g.f(mix('slate', 'sky', 0.25), 0, q0, P, 2);
        let x = 0;
        while (x < P) {
          const w = g.r(20, 36);
          const h = g.r(8, 14);
          const wall = g.pick([mix('cream', 'sky', 0.3), mix('tan', 'sky', 0.3), mix('grey', 'sky', 0.2), mix('brick', 'sky', 0.4)]);
          g.rep(x, w + 2, function (q) {
            g.f(wall, q, q0 - h, w, h);
            g.f(mix(wall, 'navy', 0.2), q + w - 3, q0 - h, 3, h);
            for (let sx = 0; sx < w; sx += 6) g.tri(mix('slate', 'sky', 0.2), q + sx + 3, q0 - h - 4, 4, 3);
            g.f(mix('navy', 'sky', 0.3), q + 3, q0 - 6, 5, 6);
          });
          x += w + g.r(1, 8);
        }
        // far cranes
        [40, 200, 340].forEach(function (cx, i) { g.rep(cx, 34, function (q) { gantry(g, q, q0, 44 + (i % 2) * 5, 30, mix('blue', 'sky', 0.4), mix('slate', 'sky', 0.4), 4 + i); }); });
        // boats on the water
        const hull = mix('navy', 'slate', 0.3);
        [[100, 'yacht'], [290, 'tug'], [370, 'yacht'], [200, 'cutter'], [20, 'cutter']].forEach(function (b, i) {
          g.rep(b[0], 34, function (q) {
            const wy = q0 + 3 + (i % 3);
            if (b[1] === 'yacht') {
              g.f('white', q, wy, 20, 3); g.f('navy', q + 1, wy + 3, 18, 1); g.f('red', q + 1, wy, 18, 1);
              g.f('slate', q + 9, wy - 22, 1, 22);
              g.tri('white', q + 8, wy - 21, 18, 7); g.tri('cream', q + 11, wy - 15, 12, 3);
            } else if (b[1] === 'tug') {
              g.f('red', q, wy, 22, 4); g.f('navy', q, wy + 3, 22, 1); g.f('white', q + 5, wy - 5, 10, 5); g.f('sky', q + 6, wy - 4, 8, 2);
              g.f('navy', q + 16, wy - 6, 3, 6); g.f('red', q + 16, wy - 4, 3, 1);
            } else {
              g.f('blue', q, wy, 18, 3); g.f('navy', q, wy + 3, 18, 1); g.f('white', q + 10, wy - 4, 6, 4);
              g.f('bark', q + 3, wy - 8, 1, 8); g.ln('slate', q + 3, wy - 8, q + 14, wy - 2);
            }
          });
        });
      } },
      // mid: lighthouse, container stacks, a big crane, warehouse
      { f: 0.5, P: 576, top: 30, bake: function (g) {
        const P = g.P;
        const gnd = 100;
        g.f(mix('grey', 'slate', 0.2), 0, gnd - 2, P, ROAD_TOP - gnd + 2);
        g.f(mix('silver', 'grey', 0.5), 0, gnd - 2, P, 1);
        // lighthouse
        g.rep(410, 14, function (q) {
          const x = q + 7;
          for (let r = 0; r < 38; r++) {
            const w = Math.round(8 - r * 0.04 - (r > 30 ? 0 : 0));
            const c = Math.floor(r / 5) % 2 ? 'red' : 'white';
            g.f(c, x - 4, gnd - 2 - r, 9, 1);
            g.p(mix(c, 'navy', 0.3), x + 4, gnd - 2 - r);
            g.p(mix(c, 'white', 0.3), x - 4, gnd - 2 - r);
          }
          g.f('navy', x - 6, gnd - 41, 13, 2);
          g.f('slate', x - 5, gnd - 43, 11, 1);
          g.f('sky', x - 3, gnd - 48, 7, 5);
          g.f('yellow', x - 1, gnd - 47, 3, 3);
          g.f('slate', x - 3, gnd - 48, 1, 5); g.f('slate', x + 3, gnd - 48, 1, 5);
          g.tri('red', x, gnd - 55, 7, 5);
          g.f('navy', x, gnd - 58, 1, 3);
          g.f('bark', x - 1, gnd - 8, 3, 6);
        });
        // big crane
        g.rep(200, 80, function (q) { gantry(g, q, gnd - 2, 66, 70, 'blue', 'deepblue', 8); });
        // container stacks
        const cols = ['red', 'blue', 'teal', 'orange', 'yellow', mix('green', 'fir', 0.3), 'brick', mix('white', 'silver', 0.5), 'deepblue', 'pink'];
        [[10, 3, 2], [55, 2, 3], [88, 3, 2], [300, 2, 2], [335, 3, 3], [380, 2, 2], [520, 3, 2], [560, 1, 3]].forEach(function (st, si) {
          g.rep(st[0], st[1] * 14 + 2, function (q) {
            for (let k = 0; k < st[1]; k++) for (let h = 0; h < st[2]; h++) {
              container(g, q + k * 14, gnd - 2 - h * 7, 14, cols[(si * 3 + k * 2 + h * 5) % cols.length]);
            }
          });
        });
        // warehouse
        g.rep(440, 56, function (q) {
          g.f(mix('cream', 'tan', 0.3), q, gnd - 22, 50, 20);
          g.f(mix('tan', 'bark', 0.3), q + 46, gnd - 22, 4, 20);
          for (let sx = 0; sx < 50; sx += 10) { g.tri(mix('slate', 'grey', 0.3), q + sx + 5, gnd - 29, 7, 5); }
          g.f('bark', q + 6, gnd - 12, 12, 10); g.f('brown', q + 8, gnd - 12, 1, 10);
          g.f('slate', q + 30, gnd - 16, 14, 5); g.f('sky', q + 31, gnd - 15, 12, 3);
        });
      } },
      // near: bollards with a chain, crates, life ring, buoys
      { f: 1, P: 832, top: 88, bake: function (g) {
        const P = g.P;
        g.f(mix('silver', 'grey', 0.5), 0, 100, P, 4);
        g.f(mix('grey', 'slate', 0.4), 0, 103, P, 1);
        for (let x = 0; x < P; x += 13) g.f(mix('grey', 'slate', 0.3), x, 101, 1, 3);
        // chain fence
        for (let x = 0; x < P; x += 52) {
          g.f('navy', x, 92, 2, 9); g.f('yellow', x, 92, 2, 2); g.f('slate', x - 1, 91, 4, 1);
          for (let k = 0; k <= 48; k++) if (k % 2 === 0) g.p('slate', x + 2 + k, 94 + Math.round(3.6 * Math.sin(k / 48 * Math.PI)));
        }
        // life rings, crates, buoys
        [100, 380, 620].forEach(function (rx, i) {
          g.rep(rx, 8, function (q) { g.ell('white', q + 3, 96, 3, 3); g.ell(mix('grey', 'slate', 0.3), q + 3, 96, 1, 1); g.f('red', q, 95, 7, 1); g.f('red', q + 2, 98, 3, 1); });
        });
        [210, 520, 730].forEach(function (cx, i) {
          g.rep(cx, 12, function (q) {
            g.f('tan', q, 96, 10, 8); g.f('bark', q, 96, 10, 1); g.f('bark', q, 103, 10, 1); g.f('bark', q, 96, 1, 8); g.f('bark', q + 9, 96, 1, 8); g.f('bark', q + 4, 96, 1, 8);
            g.f('bark', q + 10, 99, 4, 5); g.f('tan', q + 10, 99, 4, 1);
          });
        });
        [50, 300, 450, 700].forEach(function (bx, i) {
          g.rep(bx, 6, function (q) {
            g.ell(i % 2 ? 'red' : 'orange', q + 3, 100, 3, 3); g.f('white', q, 99, 7, 1); g.f('navy', q + 3, 94, 1, 3);
          });
        });
      } }
    ]
  };

  // 7. IJsbaan: the frozen canal, a koek-en-zopie stall, snowy trees, a pale low sun.
  THEMES.ice = {
    sky: [mix('lilac', 'sky', 0.55), mix('sky', 'lilac', 0.3), mix('ice', 'blush', 0.35), mix('blush', 'apricot', 0.25), mix('apricot', 'cream', 0.65)],
    clouds: { n: 5, wmin: 40, wmax: 84, ymin: 34, ymax: 58, top: 14, body: mix('white', 'blush', 0.35), shade: mix('lilac', 'blush', 0.5) },
    skyFx: function (g) {
      // the low pale sun: a disc inside a smooth, dithered falloff
      const sx = 214;
      const sy = 78;
      const R = 30;
      for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) {
        const r = Math.sqrt(x * x + y * y);
        if (r > R || r < 6) continue;
        const p = 0.42 * Math.pow(1 - r / R, 1.6);
        if (bay(sx + x, sy + y) < p) g.p('white', sx + x, sy + y);
      }
      g.ell(mix('white', 'yellow', 0.16), sx, sy, 7, 7);
      g.ell('white', sx - 1, sy - 1, 5, 5);
    },
    road: roadDef(mix('sky', 'blue', 0.42), {
      verge: 'white',
      speckN: 0,
      dash: null,
      kerb: ['white', 'ice', mix('sky', 'blue', 0.3)],
      paint: function (g, rh) {
        const base = mix('sky', 'blue', 0.42);
        // skate trails: long faint strokes, and a few cracks
        for (let i = 0; i < 22; i++) {
          const y = g.r(5, rh - 6);
          const x = g.r(0, 127);
          const len = g.r(14, 44);
          const c = g.chance(0.5) ? mix(base, 'white', 0.35) : mix(base, 'blue', 0.22);
          [0, -128].forEach(function (k) { g.f(c, x + k, y, len, 1); });
        }
        for (let i = 0; i < 5; i++) {
          const x = g.r(10, 110);
          const y = g.r(8, rh - 14);
          let cx = x; let cy = y;
          for (let k = 0; k < 9; k++) { g.p(mix(base, 'white', 0.5), cx, cy); cx += g.r(0, 2); cy += g.r(-1, 1); }
        }
        for (let i = 0; i < 40; i++) g.p(mix(base, 'white', 0.22), g.r(0, 127), g.r(4, rh - 5));
      }
    }),
    layers: [
      // far: pale hills, a snowy village
      { f: 0.05, P: 352, top: 60, bake: function (g) {
        const P = g.P;
        const hz = 88;
        const snow = mix('ice', 'lilac', 0.3);
        const dark = mix('slate', 'lilac', 0.5);
        g.f(snow, 0, hz, P, ROAD_TOP - hz);
        for (let x = 0; x < P; x++) g.f(mix(snow, 'lilac', 0.18), x, hz - Math.round(2 + 2 * Math.sin(x / P * Math.PI * 4) + 1.5 * Math.sin(x / P * Math.PI * 10 + 1)), 1, 6);
        for (let x = 0; x < P; x += g.r(5, 12)) {
          const h = g.r(3, 8);
          g.rep(x, 7, function (q) { g.tri(dark, q + 3, hz - h - 1, h, 3); });
        }
        [80, 250].forEach(function (vx) {
          g.rep(vx, 40, function (q) {
            for (let i = 0; i < 4; i++) {
              const w = 8 + (i % 2) * 3;
              g.f(mix('brick', 'lilac', 0.5), q + i * 9, hz - 6, w, 6);
              roof(g, q + i * 9 - 1, hz - 10, w + 2, 4, mix('white', 'lilac', 0.1), mix('ice', 'lilac', 0.4), true);
            }
            g.f(mix('cream', 'lilac', 0.45), q + 30, hz - 18, 5, 18);
            g.tri(mix('white', 'lilac', 0.1), q + 32, hz - 28, 10, 3);
          });
        });
      } },
      // mid-far: the far ice with skaters, bare pollard willows, reeds
      { f: 0.2, P: 432, top: 60, bake: function (g, S) {
        const P = g.P;
        const hz = 91;
        g.f(mix('white', 'ice', 0.5), 0, hz - 2, P, 4);
        // bank with reeds
        g.f(mix('tan', 'white', 0.5), 0, hz - 3, P, 2);
        for (let x = 0; x < P; x += g.r(3, 6)) g.f(mix('tan', 'slate', 0.3), x, hz - g.r(5, 9), 1, 6);
        // the far ice
        g.f(mix('sky', 'blue', 0.28), 0, hz, P, ROAD_TOP - hz);
        for (let i = 0; i < 40; i++) g.f(mix('sky', 'white', 0.5), g.r(0, P - 30), g.r(hz + 1, ROAD_TOP - 2), g.r(10, 30), 1);
        // pollard willows
        [60, 170, 290, 390].forEach(function (wx, i) {
          g.rep(wx - 10, 22, function (q) {
            const x = q + 10;
            g.f('bark', x - 2, hz - 12, 4, 12);
            g.f('brown', x + 1, hz - 12, 1, 12);
            g.f('white', x - 3, hz - 14, 6, 2);
            for (let k = -5; k <= 5; k += 2) { g.f('bark', x + k, hz - 22 + Math.abs(k), 1, 9 - Math.abs(k)); g.p('white', x + k, hz - 22 + Math.abs(k)); }
          });
        });
        S.skaters = [];
        const cl = ['red', 'blue', 'yellow', 'teal', 'pink', 'orange', 'purple'];
        for (let i = 0; i < 9; i++) S.skaters.push({ x: g.r(0, P - 1), y: hz + g.r(5, 10), sp: (g.chance(0.5) ? 1 : -1) * (2 + g.r(0, 3)), c: cl[i % cl.length], h: cl[(i * 3 + 1) % cl.length], ph: i * 0.9 });
      }, dyn: function (d, S) {
        const ctx = d.ctx;
        S.skaters.forEach(function (s) {
          const x = d.sx(mod(s.x + d.t * s.sp, d.P), 10);
          if (x < -6 || x > W + 6) return;
          const y = s.y;
          const stride = Math.floor(d.t * 1.6 + s.ph) & 1;
          ctx.fillStyle = col('apricot'); ctx.fillRect(x + 1, y - 7, 2, 2);
          ctx.fillStyle = col(s.h); ctx.fillRect(x + 1, y - 8, 2, 1);
          ctx.fillStyle = col(s.c); ctx.fillRect(x, y - 5, 4, 3);
          ctx.fillStyle = col(s.h); ctx.fillRect(s.sp > 0 ? x - 1 : x + 4, y - 5, 1, 2);
          ctx.fillStyle = col('navy'); ctx.fillRect(x + (stride ? 0 : 1), y - 2, 1, 2); ctx.fillRect(x + (stride ? 3 : 2), y - 2, 1, 2);
        });
      } },
      // mid: snowy firs, the koek-en-zopie stall, a snowman, a bench
      { f: 0.5, P: 576, top: 36, bake: function (g, S) {
        const P = g.P;
        const gnd = 99;
        g.f('white', 0, gnd - 1, P, ROAD_TOP - gnd + 1);
        for (let x = 0; x < P; x++) g.f('white', x, gnd - 2 - Math.round(1.2 * Math.sin(x / P * Math.PI * 12) + Math.sin(x / P * Math.PI * 22 + 1)), 1, 3);
        g.f(mix('white', 'ice', 0.6), 0, gnd + 1, P, 3);
        [50, 120, 175, 375, 430, 480, 545].forEach(function (fx, i) {
          const h = 36 + (i * 11) % 22;
          g.rep(fx - 12, 25, function (q) { pine(g, q + 12, gnd, h, 'fir', 'green', mix('fir', 'navy', 0.3), 'bark', 0.1, 'white'); });
        });
        // stall
        S.steam = [];
        g.rep(285, 40, function (q) {
          g.f('bark', q + 2, gnd - 22, 28, 22);
          g.f('brown', q + 2, gnd - 22, 28, 1);
          for (let i = 0; i < 28; i += 4) g.f(mix('bark', 'brown', 0.35), q + 2 + i, gnd - 21, 1, 21);
          g.f('cream', q + 5, gnd - 17, 22, 10);                           // inside
          g.f('tan', q + 3, gnd - 8, 26, 3); g.f('bark', q + 3, gnd - 5, 26, 5);   // counter
          g.f('white', q + 3, gnd - 9, 26, 1);
          for (let i = 0; i < 4; i++) { g.f('white', q + 7 + i * 6, gnd - 12, 3, 3); g.f('red', q + 7 + i * 6, gnd - 12, 3, 1); }
          g.f('slate', q + 24, gnd - 14, 4, 5); g.f('navy', q + 24, gnd - 14, 4, 1);
          // awning
          for (let i = 0; i < 32; i++) { g.f(Math.floor(i / 3) % 2 ? 'white' : 'blue', q + i, gnd - 26, 1, 6); }
          for (let i = 0; i < 32; i += 3) g.f(Math.floor(i / 3) % 2 ? 'white' : 'blue', q + i, gnd - 20, 3, 1);
          g.f('white', q - 1, gnd - 28, 34, 3);
          g.f(mix('ice', 'sky', 0.4), q, gnd - 26, 32, 1);
          g.f('red', q + 1, gnd - 31, 30, 3);
          g.f('white', q + 1, gnd - 33, 30, 2);
          for (let i = 1; i < 32; i += 5) g.p(['yellow', 'red', 'aqua', 'orange'][(i / 5) % 4 | 0], q + i, gnd - 19);
          g.f('cream', q + 12, gnd - 35, 10, 3); g.f('red', q + 15, gnd - 34, 4, 1); g.f('navy', q + 11, gnd - 36, 12, 1);   // sign
          g.f('bark', q + 3, gnd - 22, 2, 22); g.f('bark', q + 28, gnd - 22, 2, 22);
        });
        S.steam = [{ x: 285 + 26, y: gnd - 15, ph: 0 }, { x: 285 + 10, y: gnd - 12, ph: 2 }];
        // snowman
        g.rep(500, 12, function (q) {
          g.ell('white', q + 5, gnd - 3, 5, 3); g.ell('white', q + 5, gnd - 9, 4, 3); g.ell('white', q + 5, gnd - 14, 3, 2);
          g.dith(null, mix('ice', 'sky', 0.5), q + 6, gnd - 12, 4, 8, 0.4);
          g.f('navy', q + 3, gnd - 18, 5, 2); g.f('navy', q + 2, gnd - 16, 7, 1);
          g.p('navy', q + 4, gnd - 15); g.p('navy', q + 6, gnd - 15);
          g.f('orange', q + 7, gnd - 14, 3, 1);
          g.f('red', q + 2, gnd - 12, 7, 1); g.f('red', q + 7, gnd - 11, 2, 3);
          g.ln('bark', q + 1, gnd - 9, q - 3, gnd - 12); g.ln('bark', q + 9, gnd - 9, q + 13, gnd - 12);
        });
        // bench
        g.rep(345, 18, function (q) {
          g.f('bark', q, gnd - 7, 16, 2); g.f('bark', q, gnd - 4, 16, 2); g.f('brown', q + 1, gnd - 2, 2, 3); g.f('brown', q + 13, gnd - 2, 2, 3);
          g.f('white', q, gnd - 8, 16, 1); g.f('white', q, gnd - 5, 16, 1);
        });
      }, dyn: function (d, S) {
        const ctx = d.ctx;
        S.steam.forEach(function (sm) {
          for (let k = 0; k < 4; k++) {
            const ph = (d.t * 0.5 + sm.ph + k * 0.25) % 1;
            const x = d.sx(sm.x, 6) + Math.round(Math.sin(ph * 6 + k) * 1.5);
            const y = Math.round(sm.y - 3 - ph * 12);
            ctx.globalAlpha = 0.65 * (1 - ph);
            ctx.fillStyle = col('white');
            ctx.fillRect(x, y, 2, 1);
            ctx.fillRect(x - 1, y + 1, 2, 1);
          }
          ctx.globalAlpha = 1;
        });
      } },
      // near: snow bank, red-and-white marker poles, dry reeds, stones
      { f: 1, P: 832, top: 84, bake: function (g) {
        const P = g.P;
        g.f('white', 0, 100, P, 4);
        for (let x = 0; x < P; x++) {
          const y = 98 - Math.round(1.6 * Math.sin(x / P * Math.PI * 16) + 1.4 * Math.sin(x / P * Math.PI * 34 + 2) + 1);
          g.f('white', x, y, 1, 100 - y);
          if (x % 2 === 0) g.p(mix('ice', 'sky', 0.6), x, y + 2);
        }
        g.f(mix('ice', 'sky', 0.5), 0, 101, P, 1);
        g.f(mix('white', 'ice', 0.4), 0, 102, P, 1);
        for (let i = 0; i < 90; i++) g.p(mix('sky', 'ice', 0.4), g.r(0, P - 1), g.r(99, 103));
        // marker poles with a rope
        [[60, 140], [380, 470], [610, 700]].forEach(function (seg) {
          g.rep(seg[0], seg[1] - seg[0] + 4, function (q) {
            for (let x = 0; x <= seg[1] - seg[0]; x += 20) {
              g.f('brown', q + x, 90, 2, 12);
              for (let k = 0; k < 6; k += 2) g.f('red', q + x, 90 + k, 2, 1);
              g.f('white', q + x, 91, 2, 1);
              g.p('white', q + x, 89);
            }
            for (let x = 0; x < seg[1] - seg[0]; x += 20) for (let k = 0; k <= 20; k++) g.p(k % 4 < 2 ? 'red' : 'white', q + x + 2 + k, 92 + Math.round(2 * Math.sin(k / 20 * Math.PI)));
          });
        });
        // dry reeds poking out of the snow
        g.spread(22, 0.9).forEach(function (x) {
          g.rep(x - 3, 8, function (q) {
            const h = g.r(5, 11);
            g.f(mix('tan', 'sand', 0.3), q + 3, 100 - h, 1, h);
            g.f(mix('tan', 'bark', 0.3), q + 5, 100 - h + 2, 1, h - 2);
            g.p('bark', q + 3, 100 - h - 1); g.p('bark', q + 3, 100 - h);
          });
        });
        g.spread(8, 0.9).forEach(function (x) { g.rep(x - 4, 9, function (q) { g.ell('grey', q + 4, 101, 3, 2); g.f('white', q + 2, 99, 5, 1); g.p('silver', q + 3, 100); }); });
      } }
    ]
  };

  // 8. Heuvelland: rolling hills, vineyards, half-timbered farms and a castle on a hill.
  THEMES.hills = {
    sky: [mix('sky', 'blue', 0.2), 'sky', mix('sky', 'ice', 0.4), 'ice', mix('ice', 'lime', 0.15)],
    clouds: { n: 6, wmin: 32, wmax: 66, ymin: 34, ymax: 72, top: 14, body: 'white', shade: mix('silver', 'sky', 0.3) },
    road: roadDef(mix('grey', 'sand', 0.3), { verge: 'lime' }),
    layers: [
      // far: pale blue ridges
      { f: 0.04, P: 352, top: 40, bake: function (g) {
        const P = g.P;
        const r1 = mix('green', 'sky', 0.7);
        const r2 = mix('green', 'sky', 0.58);
        const prof1 = function (x) { return Math.round(66 + 7 * Math.sin(x / P * Math.PI * 4 + 1) + 4 * Math.sin(x / P * Math.PI * 10)); };
        const prof2 = function (x) { return Math.round(76 + 6 * Math.sin(x / P * Math.PI * 6 + 3) + 3 * Math.sin(x / P * Math.PI * 14 + 1)); };
        for (let x = 0; x < P; x++) {
          g.f(r1, x, prof1(x), 1, ROAD_TOP - prof1(x));
          g.f(r2, x, prof2(x), 1, ROAD_TOP - prof2(x));
        }
        // tiny village on the far ridge
        g.rep(250, 20, function (q) {
          for (let i = 0; i < 3; i++) { g.f(mix('cream', 'sky', 0.55), q + i * 6, 77 - (i % 2), 5, 4); g.f(mix('brick', 'sky', 0.55), q + i * 6, 75 - (i % 2), 5, 2); }
        });
      } },
      // mid-far: hills with vineyard terraces and the castle on the highest one
      { f: 0.18, P: 414, top: 6, bake: function (g) {
        const P = g.P;
        const bump = function (x, c, w, a) { const d = Math.min(Math.abs(x - c), P - Math.abs(x - c)); return a * Math.exp(-(d * d) / (2 * w * w)); };
        const ridge = function (x) { return Math.round(84 - bump(x, 200, 38, 32) - bump(x, 360, 50, 12) + 4 * Math.sin(x / P * Math.PI * 8 + 1) + 2 * Math.sin(x / P * Math.PI * 22)); };
        const body = mix('green', 'sky', 0.3);
        const light = mix('lime', 'sky', 0.25);
        for (let x = 0; x < P; x++) {
          const y = ridge(x);
          g.f(body, x, y, 1, ROAD_TOP - y);
          g.p(light, x, y); g.p(light, x, y + 1);
        }
        // vineyard terraces following the contour on the slopes
        for (let k = 3; k < 22; k += 3) {
          for (let x = 0; x < P; x++) {
            const y = ridge(x) + k;
            if (y > ROAD_TOP - 1) continue;
            const slope = Math.abs(ridge((x + 3) % P) - ridge((x + P - 3) % P));
            if (slope < 2 && (x < 140 || x > 260)) continue;                 // only on the sloping parts
            if (x % 6 < 4) g.p(mix('fir', 'green', 0.45), x, y);
            else if (k % 6 === 0) g.p(mix('lime', 'sand', 0.3), x, y);
          }
        }
        // castle on the highest hill
        const cx = 177;
        const cb = ridge(200) + 2;
        // a rocky plateau under the castle so its walls never hover over the slope
        for (let x = cx - 3; x < cx + 50; x++) {
          for (let y = cb; y < ridge(x) + 1; y++) g.p(mix(y % 2 ? 'tan' : 'sand', 'green', 0.55), x, y);
        }
        castle(g, cx, cb, 0.18);
        for (let i = 0; i < 9; i++) g.p(mix('fir', 'sky', 0.2), cx - 2 + i * 6 + (i % 2), cb + 1 + (i % 3));
        g.rep(60, 10, function (q) { roundTree(g, q + 5, ridge(65) + 1, 5, mix('green', 'sky', 0.2), mix('lime', 'sky', 0.2), mix('fir', 'sky', 0.2), 'bark'); });
        g.rep(300, 10, function (q) { poplar(g, q + 5, ridge(305) + 1, 16, mix('fir', 'sky', 0.2), 'green', 'bark'); });
        g.rep(370, 10, function (q) { poplar(g, q + 5, ridge(375) + 1, 18, mix('fir', 'sky', 0.2), 'green', 'bark'); });
      } },
      // mid: meadow slope, orchard, half-timbered farm, sheep, a stone wall
      { f: 0.5, P: 576, top: 44, bake: function (g) {
        const P = g.P;
        const prof = function (x) { return Math.round(92 + 3 * Math.sin(x / P * Math.PI * 4 + 0.5) + 2 * Math.sin(x / P * Math.PI * 10 + 2)); };
        for (let x = 0; x < P; x++) {
          const y = prof(x);
          g.f('lime', x, y, 1, ROAD_TOP - y);
          g.p(mix('lime', 'white', 0.25), x, y);
        }
        g.f(mix('lime', 'green', 0.35), 0, 98, P, ROAD_TOP - 98);
        for (let i = 0; i < 160; i++) g.p(g.pick(['green', 'lime', mix('lime', 'sand', 0.4)]), g.r(0, P - 1), g.r(93, 103));
        // buildings and trees (drawn on top of the slope line)
        g.rep(250, 44, function (q) { vakwerk(g, q, 97, 32, 16); roundTree(g, q + 40, 97, 6, 'green', 'lime', 'fir', 'bark'); });
        g.rep(470, 40, function (q) {
          g.f('tan', q, 83, 26, 14); g.f(mix('tan', 'bark', 0.4), q + 22, 83, 4, 14);
          roof(g, q - 2, 72, 30, 11, 'slate', 'navy', true);
          g.f('bark', q + 9, 87, 8, 10); g.f('brown', q + 13, 87, 1, 10);
        });
        [40, 70, 95, 380, 405, 430].forEach(function (tx, i) { g.rep(tx - 8, 17, function (q) { appleTree(g, q + 8, prof(tx) + 4, 6 + (i % 2)); }); });
        [150, 190, 500, 530].forEach(function (sx, i) { g.rep(sx, 12, function (q) { sheep(g, q, prof(sx) + 6 + (i % 2)); }); });
        // low stone wall
        [[310, 90], [520, 50]].forEach(function (w) {
          g.rep(w[0], w[1], function (q) {
            g.f('grey', q, 98, w[1], 4);
            for (let i = 0; i < w[1]; i += 4) { g.f(mix('grey', 'slate', 0.35), q + i, 98 + (i % 8 ? 0 : 2), 4, 1); g.p('silver', q + i + 1, 98); }
            g.f(mix('grey', 'silver', 0.5), q, 98, w[1], 1);
          });
        });
      } },
      // near: hedge, flowers, a fence and a signpost
      { f: 1, P: 832, top: 80, bake: function (g, S) {
        const P = g.P;
        S.bf = [];
        ['white', 'yellow', 'orange', 'white'].forEach(function (c, i) { S.bf.push({ x: 120 + i * 200, y: 90 + (i % 2) * 3, c: c, ph: i * 2.3 }); });
        g.f(mix('lime', 'green', 0.4), 0, 101, P, 3);
        for (let i = 0; i < 220; i++) g.p(g.pick(['green', 'lime', 'fir']), g.r(0, P - 1), g.r(101, 103));
        // hedges
        g.spread(8, 0.5).forEach(function (hx, i) {
          const w = g.r(40, 70);
          g.rep(hx - w / 2, w, function (q) {
            for (let x = 0; x < w; x++) {
              const hh = 7 + Math.round(2 * Math.sin(x * 0.45 + i) + 1.5 * Math.sin(x * 1.1));
              g.f(mix('fir', 'green', 0.25), q + x, 101 - hh, 1, hh);
              g.p('green', q + x, 101 - hh); g.p('green', q + x, 101 - hh + 1);
              if (x % 5 === 2) g.p('lime', q + x, 101 - hh + 3);
            }
            for (let k = 0; k < 6; k++) g.p(g.pick(['white', 'yellow', 'pink']), q + g.r(2, w - 3), 101 - g.r(1, 7));
          });
        });
        // wild flowers
        g.spread(30, 0.9).forEach(function (fx, i) {
          const c = ['yellow', 'white', 'red', 'pink', 'lilac'][i % 5];
          const hh = g.r(3, 6);
          g.rep(fx, 3, function (q) { g.f('green', q + 1, 103 - hh, 1, hh); g.f(c, q, 102 - hh, 3, 1); g.p(c, q + 1, 101 - hh); g.p(i % 2 ? 'gold' : 'yellow', q + 1, 102 - hh); });
        });
        // fence
        [[200, 250], [560, 640]].forEach(function (seg) {
          g.rep(seg[0], seg[1] - seg[0] + 4, function (q) {
            for (let x = 0; x <= seg[1] - seg[0]; x += 10) { g.f('bark', q + x, 93, 2, 11); g.f('tan', q + x, 93, 1, 11); }
            g.f('tan', q, 95, seg[1] - seg[0] + 2, 2); g.f('bark', q, 97, seg[1] - seg[0] + 2, 1);
            g.f('tan', q, 99, seg[1] - seg[0] + 2, 2);
          });
        });
        // signpost
        g.rep(420, 20, function (q) {
          g.f('bark', q + 8, 82, 3, 22); g.f('tan', q + 8, 82, 1, 22);
          g.f('cream', q + 1, 84, 14, 5); g.f('bark', q + 1, 84, 14, 1); g.f('bark', q + 1, 88, 14, 1);
          g.tri('cream', q + 16, 84, 5, 2);
          g.f('cream', q + 5, 91, 14, 5); g.f('bark', q + 5, 91, 14, 1); g.f('bark', q + 5, 95, 14, 1);
          g.f('red', q + 3, 86, 1, 2); g.f('blue', q + 7, 93, 1, 2);
        });
      }, dyn: function (d, S) { butterfliesDyn(d, S.bf); } }
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
    g.top = top;
    const S = {};
    def.bake(g, S);
    return { f: def.f, P: def.P, top: top, canvas: canvas, dyn: def.dyn || null, S: S };
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

  // Each piece is baked on its own, so one bad layer can never blank the whole scene.
  function bakeTheme(id) {
    const def = THEMES[id];
    const guard = function (fn) {
      try { return fn(); } catch (e) {
        if (typeof RR.Scene.onError === 'function') RR.Scene.onError(e);
        return null;
      }
    };
    // dust and speed lines must read on this road: pale on a dark one, a shade darker on a light one
    const rb = rgb(def.road.base);
    const roadLum = (rb[0] * 0.3 + rb[1] * 0.59 + rb[2] * 0.11);
    const B = {
      id: id,
      def: def,
      fx: roadLum > 150 ? mix(def.road.base, 'slate', 0.5) : mix(def.road.base, 'white', 0.78),
      sky: guard(function () { return bakeSky(def, id); }),
      clouds: guard(function () { return bakeClouds(def, id); }),
      layers: [],
      road: guard(function () { return bakeRoad(def, id); })
    };
    def.layers.forEach(function (ld, i) {
      const L = guard(function () { return bakeLayer(ld, id, i); });
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

    // road bands, slanted like the lanes: start line and checkered finish line
    function band(w, cellFn) {
      let lo = 99;
      let hi = -99;
      for (let y = 0; y < ROAD_H; y++) { const s = shearOf(ROAD_TOP + y); lo = Math.min(lo, s); hi = Math.max(hi, s); }
      const cv = newCanvas(w + hi - lo, ROAD_H);
      const gg = makeBrush(cv.getContext('2d'), w + hi - lo, 3);
      for (let y = 1; y < ROAD_H - 3; y++) {
        const s = shearOf(ROAD_TOP + y) - lo;
        for (let x = 0; x < w; x++) {
          const c = cellFn(x, y);
          if (c) gg.f(c, x + s, y, 1, 1);
        }
      }
      return { canvas: cv, dx: lo };
    }
    out.finishLine = band(8, function (x, y) { return (Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? 'white' : 'navy'; });
    out.startLine = band(4, function (x) { return x === 0 ? 'silver' : (x === 3 ? 'grey' : 'white'); });
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
      } catch (e) {
        // a drawing problem must never break the game; the hook is for development only
        if (typeof RR.Scene.onError === 'function') RR.Scene.onError(e);
      }
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
      if (B.clouds) {
        const off = Math.round(left * 0.04 + t * 2.2);
        drawTile(ctx, B.clouds.canvas, B.clouds.P, off, B.clouds.top);
      }
      if (B.def.skyDyn2) B.def.skyDyn2(ctx, env);

      B.layers.forEach(function (L) {
        const off = Math.round(left * L.f);
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
        const sx = 0 - left;
        const fxp = Math.round(st.length * PPU) - left;
        // lines on the road surface, then the gates standing at the back edge of the road
        if (sx > -30 && sx < W + 30) ctx.drawImage(G.startLine.canvas, sx + G.startLine.dx - 2, ROAD_TOP);
        if (fxp > -30 && fxp < W + 30) ctx.drawImage(G.finishLine.canvas, fxp + G.finishLine.dx - 4, ROAD_TOP);
        const gs = shearOf(ROAD_TOP + 2);
        if (sx + gs > -50 && sx + gs < W + 50) ctx.drawImage(G.start, sx + gs - 36, ROAD_TOP + 2 - 64);
        if (fxp + gs > -50 && fxp + gs < W + 50) ctx.drawImage(G.finish, fxp + gs - 36, ROAD_TOP + 2 - 64);
      }

      drawKarts(B, left, fx);
      drawStrip();
    }

    function drawKarts(B, left, fx) {
      const S = RR.Sprites;
      if (!S || !S.draw) return;
      const order = st.racers.slice().sort(function (a, b) { return b.lane - a.lane; });
      order.forEach(function (r) {
        const refX = num0(st.pos[r.id]) * PPU - left;
        const x = Math.round(refX - KART_REF) + SHEAR * r.lane;
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
        if (fx && fx.boostLines && r.id === (playerRacer() || {}).id) drawSpeedLines(x, y, fx, B.fx);
      });
    }

    function drawPuffs(B, left, fx, r) {
      const list = fx.puffs[r.id];
      if (!list) return;
      const dust = B.fx;
      list.forEach(function (p) {
        const age = p.age;
        if (age < 0 || age > 1) return;
        const sx = Math.round(p.wx - left) + SHEAR * r.lane;
        const sy = Math.round(LANE_Y[r.lane] - 2 - age * 5);
        const rad = 1.4 + age * 2;
        ctx.globalAlpha = 0.75 * (1 - age);
        ctx.fillStyle = col(dust);
        const n = Math.max(1, Math.round(rad));
        // a blob with cut corners, so it never looks like a square
        ctx.fillRect(sx - n, sy - n + 1, n * 2 + 1, n * 2 - 1);
        ctx.fillRect(sx - n + 1, sy - n, n * 2 - 1, n * 2 + 1);
        ctx.globalAlpha = 1;
      });
    }

    function drawSpeedLines(x, y, fx, color) {
      const env = Math.sin(Math.PI * fx.u);
      if (env <= 0.02) return;
      const lines = [[-17, 4, 26], [-19, 9, 20], [-16, 14, 24]];
      ctx.fillStyle = col(color);
      lines.forEach(function (ln, i) {
        const len = Math.round(ln[2] * (0.6 + 0.4 * env));
        const y0 = y - ln[1];
        ctx.globalAlpha = 0.7 * env;
        ctx.fillRect(x + ln[0] - len, y0, len, 1);
        ctx.globalAlpha = 0.3 * env;
        ctx.fillRect(x + ln[0] - len - 3, y0, 3, 1);
        ctx.fillRect(x + ln[0], y0, 2, 1);
      });
      ctx.globalAlpha = 1;
    }

    // ---- progress strip -----------------------------------------------------
    function drawStrip() {
      const S = RR.Sprites;
      ctx.fillStyle = col('white');
      ctx.fillRect(0, 0, W, STRIP_H - 1);
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
      const player = playerRacer();
      // honest x per head, then nudge apart so heads in a tie (the start!) all stay visible
      const heads = st.racers.map(function (r) {
        return { r: r, x: x0 + (x1 - x0) * clamp(num0(st.pos[r.id]) / len, 0, 1) };
      });
      heads.sort(function (a, b) { return (a.x - b.x) || (b.r.lane - a.r.lane); });
      const GAP = 9;
      for (let i = 1; i < heads.length; i++) if (heads[i].x < heads[i - 1].x + GAP) heads[i].x = heads[i - 1].x + GAP;
      for (let i = heads.length - 1; i >= 0; i--) {
        const limit = i === heads.length - 1 ? x1 : heads[i + 1].x - GAP;
        if (heads[i].x > limit) heads[i].x = limit;
      }
      heads.sort(function (a, b) { return b.r.lane - a.r.lane; });      // back lanes first, player on top
      heads.forEach(function (hd) {
        const r = hd.r;
        const x = Math.round(hd.x);
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
      if (a.guard) clearTimeout(a.guard);
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
          const animate = !st.destroyed && ctx && !st.reduced && !hidden() && hasRaf() && maxd > 0.001;
          if (!animate) {
            st.racers.forEach(function (r) { st.pos[r.id] = to[r.id]; });
            syncCam();
            render(null);
            resolve();
            return;
          }
          const boost = !!(opts2 && opts2.boost);
          const a = {
            from: from, to: to, racers: st.racers.slice(), D: glideTime(maxd, boost) - CAM_LAG * 1000, boost: boost,
            t0: null, last: 0, wheel: {}, resolve: resolve, guard: 0
          };
          st.anim = a;
          // if frames never arrive (throttled iframe, odd browser) the promise must still resolve
          a.guard = setTimeout(function () {
            if (st.anim === a) { finishAnim(); render(null); wake(); }
          }, a.D + CAM_LAG * 1000 + 2000);
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
    onError: null,
    THEMES: THEME_IDS.slice(),
    SIZE: { width: W, height: H },
    PX_PER_UNIT: PPU,
    LANE_Y: LANE_Y.slice()
  };
})();
