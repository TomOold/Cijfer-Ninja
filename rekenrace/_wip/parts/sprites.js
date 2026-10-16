// Pixel-art sprites for Rekenrace: four kart heroes, head portraits and icons.
// Everything is generated in code from tiny string maps (one character = one
// palette colour, '.' = transparent) and baked once to cached canvases.
// Browser-only, but loading it under Node (no document) is harmless: every
// call then returns nothing / a transparent 1px URL.
//
// Sizes: kart 32x22, head 12x12, icon 20x20 (logical pixels, scale it by whole
// numbers). Karts face right; flip mirrors them. draw() anchors a kart at its
// bottom-centre: x is the vertical line between pixel columns 15 and 16 and y
// is the ground line just under the wheels (the wheels' last row is y-1).
RR.Sprites = (function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Palette: the one shared, soft VGA-ish colour set of the whole game (32).
  // No neon, no pure black: outlines are deep navy or dark brown.
  // ---------------------------------------------------------------------------
  const PALETTE = {
    navy: '#232c4a', brown: '#4b3028', slate: '#5d6a86', grey: '#98a3b6',
    silver: '#cdd5e0', white: '#fbf6e9',
    cream: '#f2dfb8', sand: '#e5c487', tan: '#c4955a', bark: '#8b5a38',
    orange: '#e57f36', rust: '#ab4e22', apricot: '#f4b268',
    red: '#c2493d', brick: '#8f3b34', pink: '#e58aa3', blush: '#f6c3cf',
    yellow: '#efcc52', gold: '#bf8e26',
    teal: '#1f7a82', deepteal: '#174f5c', aqua: '#86d1c6',
    blue: '#4678bd', deepblue: '#2b4a84', sky: '#a8d5ee', ice: '#def0f7',
    purple: '#573b8a', plum: '#3f2d68', lilac: '#b7a0d8',
    green: '#5a9e48', fir: '#2c6338', lime: '#a6cc70'
  };

  // One letter per palette colour, used in the string maps below.
  const GLYPHS = {
    n: 'navy', d: 'brown', s: 'slate', g: 'grey', v: 'silver', w: 'white',
    c: 'cream', a: 'sand', t: 'tan', k: 'bark',
    o: 'orange', r: 'rust', p: 'apricot', e: 'red', m: 'brick', i: 'pink', h: 'blush',
    y: 'yellow', u: 'gold',
    q: 'teal', z: 'deepteal', x: 'aqua', b: 'blue', f: 'deepblue', j: 'sky', l: 'ice',
    P: 'purple', M: 'plum', L: 'lilac', G: 'green', F: 'fir', J: 'lime'
  };

  // kart.ax / kart.ay: where the draw() anchor sits inside the sprite (from its top-left).
  const SIZES = {
    kart: { w: 32, h: 22, ax: 16, ay: 22 },
    head: { w: 12, h: 12 },
    icon: { w: 20, h: 20 }
  };

  const HERO_IDS = ['egel', 'eekhoorn', 'pad', 'uil'];
  const ICON_NAMES = [
    'stamp-tulips', 'stamp-windmill', 'stamp-beach', 'stamp-forest',
    'stamp-canal', 'stamp-harbour', 'stamp-ice', 'stamp-hills',
    'flag', 'trophy', 'lock', 'licence', 'empty-stamp'
  ];

  const MAX_SCALE = 16;

  // ---------------------------------------------------------------------------
  // Art: karts. A kart is three layers, painted back to front:
  //   driver  (bobs 1px down on frame 1)  ->  chassis  ->  wheels
  // The chassis may use the digits 1-5 as "kart colour slots" (see `slots`),
  // so every hero keeps its own colours with a shared structure.
  // Layers are { x, y, rows } boxes placed on the 32x22 canvas.
  // ---------------------------------------------------------------------------

  // Wheels: n tyre, v rim, s spoke, @ hub (kart colour). Two spin frames.
  const WHEEL_REAR = [[
    '..nnnnn..',
    '.nnnnnnn.',
    'nnnvsvnnn',
    'nnvvsvvnn',
    'nnss@ssnn',
    'nnvvsvvnn',
    'nnnvsvnnn',
    '.nnnnnnn.',
    '..nnnnn..'
  ], [
    '..nnnnn..',
    '.nnnnnnn.',
    'nnnvvvnnn',
    'nnvsvsvnn',
    'nnvv@vvnn',
    'nnvsvsvnn',
    'nnnvvvnnn',
    '.nnnnnnn.',
    '..nnnnn..'
  ]];
  const WHEEL_FRONT = [[
    '..nnn..',
    '.nnnnn.',
    'nnvsvnn',
    'nns@snn',
    'nnvsvnn',
    '.nnnnn.',
    '..nnn..'
  ], [
    '..nnn..',
    '.nnnnn.',
    'nnsvsnn',
    'nnv@vnn',
    'nnsvsnn',
    '.nnnnn.',
    '..nnn..'
  ]];
  const REAR_AT = { x: 0, y: 13 };
  const FRONT_AT = { x: 21, y: 15 };

  const KARTS = {
    egel: {
      // colour slots used in the maps: 1 body, 2 shade, 3 light, 4 stripe, 5 nose tip, 6 outline
      slots: { 1: 'o', 2: 'r', 3: 'p', 4: 'w', 5: 'e', 6: 'd' },
      hub: 'p',
      driver: [
        // spines
        { x: 5, y: 0, rows: [
          '....d..d..d.....',
          '...dkd.dkddkd...',
          '.d.dkkdkkdkkkd..',
          '..dkktdkktdkktd.',
          '.dkktdkktdkktdkd',
          'dkktdkktdkktdkkd',
          'dktdkktdkktdkktd',
          'dtdkktdkktdkktdd',
          'dkdkktdkktdkktd.',
          '.dkdkktdkktdkkd.',
          '..ddkdkktdkktdd.',
          '...ddkktdkktdd..',
          '....dddddddddd..'
        ] },
        // face
        { x: 16, y: 3, rows: [
          '..dddd.....',
          '.dccccdd...',
          'dccwnccccdd',
          'dccnncccccd',
          'dccciccccnn',
          '.dcccccdddd',
          '..ddddd....'
        ] },
        // ear
        { x: 17, y: 2, rows: [
          '.dd.',
          'dhhd',
          'dhd.'
        ] },
        // scarf
        { x: 16, y: 9, rows: [
          '.1111111.',
          '.1222221.',
          '..11111..'
        ] },
        // glove and steering wheel
        { x: 24, y: 10, rows: [
          'ww..',
          'wwn.',
          '.sn.',
          '.sn.'
        ] }
      ],
      chassis: [
        { x: 0, y: 13, rows: [
          '.........666666666666...........',
          '.........63333333333366666666666',
          '.........6111111111113333333333v',
          '.........6444444444444444444444g',
          '.........6111111111111111111111g',
          '.........6222222222222222222222s',
          '..........6666666666666666666666'
        ] }
      ]
    },
    eekhoorn: {
      slots: { 1: 'q', 2: 'z', 3: 'x', 4: 'w', 5: 'y', 6: 'z' },
      hub: 'x',
      driver: [
        // tail: a big curled C behind the seat
        { x: 2, y: 0, rows: [
          '......dddd...',
          '....ddppppdd.',
          '...dppooopppd',
          '..dppoorroopd',
          '..dpoorrdddod',
          '.dpporrd..ddd',
          '.dpoord......',
          '.dpoord......',
          '.dpoorrd.....',
          '.dppoorrd....',
          '..dpoorrrd...',
          '..dpporrrrdd.',
          '...dppoorrrrd',
          '....ddddddddd'
        ] },
        // body
        { x: 10, y: 7, rows: [
          '.dddddd...',
          'drrrrrrdd.',
          'drrrrrrrrd',
          'drrrrrrccd',
          'drrrrrcccd',
          '.drrrrccd.',
          '..dddddd..'
        ] },
        // head
        { x: 15, y: 0, rows: [
          '..d....d...',
          '.dpd..dpd..',
          '.drrdddrrd.',
          '.drrrrrrrdd',
          'drrrwnrrccd',
          'drrrnnrcccn',
          'dcccccccccd',
          '.dcccccccd.',
          '..ddddddd..'
        ] },
        // scarf
        { x: 16, y: 9, rows: [
          '.1111111.',
          '.1222221.',
          '..11111..'
        ] },
        // glove and steering wheel
        { x: 24, y: 10, rows: [
          'ww..',
          'wwn.',
          '.sn.',
          '.sn.'
        ] }
      ],
      chassis: [
        { x: 0, y: 13, rows: [
          '.........666666666666...........',
          '.........63333333333366666......',
          '.........61111111111133333666...',
          '.........6441441441441441441466.',
          '.........61111111111111111111156',
          '.........6222222222222222222222.',
          '..........6666666666666666666666'
        ] }
      ]
    },
    pad: {
      slots: { 1: 'y', 2: 'u', 3: 'c', 4: 'G', 5: 'F', 6: 'd' },
      hub: 'G',
      driver: [
        // body
        { x: 8, y: 6, rows: [
          '...dddddd...',
          '..dGGGGGGd..',
          '.dGGFGGGGGd.',
          'dGGGGGGGGGGd',
          'dGGGGGFGGJJd',
          'dGGFGGGGJJJd',
          'dGGGGGGJJJJd',
          '.dGGGGGJJJd.'
        ] },
        // head with the two eyes on top
        { x: 13, y: 1, rows: [
          '..ddd...ddd...',
          '.dwwwd.dwwwd..',
          '.dwnnd.dwnnd..',
          '.dwnnd.dwnnd..',
          'dGGGGGGGGGGGGd',
          'dFGGGGJGGGGGFd',
          'dGFFFFFFFFFFFd',
          'dJJJJJJJJJJJJd',
          '.dJJJJJJJJJJd.',
          '..dddddddddd..'
        ] },
        // glove and steering wheel
        { x: 24, y: 11, rows: [
          'ww..',
          'wwn.',
          '.sn.'
        ] }
      ],
      chassis: [
        { x: 0, y: 13, rows: [
          '.........666666666666...........',
          '.........63333333333366666666666',
          '.........6111111111113333333333J',
          '.........6444444444444444444444G',
          '.........6111111111111111111111G',
          '.........6222222222222222222222F',
          '..........6666666666666666666666'
        ] }
      ]
    },
    uil: {
      slots: { 1: 'P', 2: 'M', 3: 'L', 4: 'i', 5: 'i', 6: 'M' },
      hub: 'i',
      driver: [
        // tail feathers and body
        { x: 3, y: 7, rows: [
          '..........dddddddd......',
          '.....ddddddtttttttdd....',
          '..dddkkkkkkttttttttdd...',
          '.dkkkttttttttttcccctd...',
          '..dkkkttttttttccccccd...',
          '...ddkkkttttcccccccd....',
          '.....ddddkkktccccdd.....'
        ] },
        // head
        { x: 12, y: 0, rows: [
          '..d........d..',
          '.dkd......dkd.',
          '.dkkddddddkkd.',
          'dtcccccccccctd',
          'dtcccccccccctd',
          'dtcccccccccctd',
          'dtcccccccccctd',
          'dtcccccccccctd',
          '.dtcccccccctd.',
          '..dddddddddd..'
        ] },
        // eyes and beak
        { x: 14, y: 3, rows: [
          '.yy....yy.',
          'yyyy..yyyy',
          'ywny..ywny',
          'ynny..ynny',
          '.yy.oo.yy.',
          '....oo....',
          '.....o....'
        ] },
        // scarf
        { x: 15, y: 10, rows: [
          '.1111111.',
          '.1222221.',
          '..11111..'
        ] },
        // glove and steering wheel
        { x: 24, y: 11, rows: [
          'ww..',
          'wwn.',
          '.sn.'
        ] }
      ],
      chassis: [
        { x: 0, y: 13, rows: [
          '.........666666666666...........',
          '.........63333333333366666......',
          '.........61111111111133333666...',
          '.........6444444444444444444466.',
          '.........61111111111111111111156',
          '.........6222222222222222222222.',
          '..........6666666666666666666666'
        ] }
      ]
    }
  };

  // ---------------------------------------------------------------------------
  // Art: heads (12x12) and icons (20x20)
  // ---------------------------------------------------------------------------
  // Heads are layer lists too (same slots as the kart, so the collar matches it).
  const HEADS = {
    egel: [
      { x: 0, y: 0, rows: [
        '...d..d...',
        '..dkdkkdkd',
        '.dkkdkktdk',
        'dkktdkkdkk',
        'dkdkkdkkdk',
        'dkkdkktdkk',
        'dkdkkdkkd.',
        '.dkdkkdd..',
        '..dddd....'
      ] },
      { x: 2, y: 9, rows: [
        '.1111111.',
        '..12221..',
        '...111...'
      ] },
      { x: 5, y: 3, rows: [
        '..ddd..',
        '.dcccdd',
        'dcwnccd',
        'dcnncnn',
        'dciccnn',
        '.dcccdd',
        '..ddd..'
      ] }
    ],
    eekhoorn: [
      { x: 1, y: 0, rows: [
        '..d....d...',
        '.dpd..dpd..',
        '.drrdddrrd.',
        '.drrrrrrrdd',
        'drrrwnrrccd',
        'drrrnnrcccn',
        'dcccccccccd',
        '.dcccccccd.',
        '..ddddddd..'
      ] },
      { x: 3, y: 9, rows: [
        '.1111111.',
        '..12221..',
        '...111...'
      ] }
    ],
    pad: [
      { x: 0, y: 0, rows: [
        '.dddd..dddd.',
        'dwwwd.dwwwd.',
        'dwnnd.dwnnd.',
        'dwnnd.dwnnd.',
        'dGGGGGGGGGGd',
        'dGGGGJGGGGFd',
        'dGFFFFFFFFGd',
        'dJJJJJJJJJJd',
        '.dJJJJJJJJd.',
        '..dddddddd..',
        '..11111111..',
        '...222222...'
      ] }
    ],
    uil: [
      { x: 0, y: 0, rows: [
        '.d........d.',
        'dkd......dkd',
        'dkkddddddkkd',
        'dtcccccccctd',
        'dtcccccccctd',
        'dtcccccccctd',
        'dtcccccccctd',
        'dtcccccccctd',
        '.dtcccccctd.',
        '..dddddddd..'
      ] },
      { x: 1, y: 3, rows: [
        '.yy....yy.',
        'yyyy..yyyy',
        'ywny..ywny',
        'ynny..ynny',
        '.yy.oo.yy.',
        '....oo....',
        '.....o....'
      ] },
      { x: 2, y: 10, rows: [
        '11111111',
        '.222222.'
      ] }
    ]
  };

  // Icons. A stamp is a round "postmark": coloured ring + paper disc + a
  // 14x14 pictogram. The other icons are plain layer lists on the 20x20 canvas.
  const PICTOS = {
    tulips: [
      '..............',
      '...e..ee..e...',
      '...ee.ee.ee...',
      '...eeeeeeee...',
      '...eiieeeem...',
      '...eieeeeem...',
      '....eeeeem....',
      '.....eemm.....',
      '......GG......',
      '..G...GG...G..',
      '..GG..GG..GG..',
      '...GG.GG.GG...',
      '....GGGGGG....',
      '......GG......'
    ],
    windmill: [
      '.ka.........k.',
      '..ka.......ka.',
      '...ka.....ka..',
      '....ka...ka...',
      '.....kddka....',
      '.....dddd.....',
      '......aa......',
      '....akeek.....',
      '...akeeeak....',
      '..ak.eeemak...',
      '.ak.eeeeemak..',
      '.k..eeddem.ak.',
      '...eeeddeem...',
      '...eeeddeem...'
    ],
    beach: [
      '..............',
      '......rr......',
      '...rrrpprrr...',
      'rrrppoppopprrr',
      'rpoopoppopoopr',
      '.rpopoppopopr.',
      '.rpoooooooopr.',
      '..rpopoopopr..',
      '...ropoopor...',
      '....roooor....',
      '.....rppr.....',
      '.....rppr.....',
      '......rr......',
      '..............'
    ],
    forest: [
      '......FF......',
      '.....FJGF.....',
      '....FJGGGF....',
      '...FJGGGGGF...',
      '....FJGGGF....',
      '...FJGGGGGF...',
      '..FJGGGGGGGF..',
      '.FJGGGGGGGGGF.',
      '...FJGGGGGF...',
      '..FJGGGGGGGF..',
      '.FJGGGGGGGGGF.',
      'FJGGGGGGGGGGGF',
      '......kd......',
      '......kd......'
    ],
    canal: [
      '.....kkkk.....',
      '.....eeem.....',
      '.....ejjm.....',
      '....aaaaaa....',
      '....eeeeem....',
      '....eejjem....',
      '...aaaaaaaa...',
      '...eeeeeeem...',
      '...ejjeejjm...',
      '..aaaaaaaaaa..',
      '..eeeeeeeeem..',
      '..ejjeeeejjm..',
      '..eeeeddeeem..',
      '..mmmmddmmmm..'
    ],
    harbour: [
      '.....ffff.....',
      '.....f..f.....',
      '.....ffff.....',
      '......ff......',
      '...ffffffff...',
      '......ff......',
      '......ff......',
      '......ff......',
      'f.....ff.....f',
      'ff....ff....ff',
      '.ff...ff...ff.',
      '..fff.ff.fff..',
      '....ffffff....',
      '..............'
    ],
    ice: [
      '..............',
      '.b....jj....b.',
      '..b...bb...b..',
      '...b.bbbb.b...',
      '....b.bb.b....',
      '...b.bbbb.b...',
      '.jbbbbffbbbbj.',
      '.jbbbbffbbbbj.',
      '...b.bbbb.b...',
      '....b.bb.b....',
      '...b.bbbb.b...',
      '..b...bb...b..',
      '.b....jj....b.',
      '..............'
    ],
    hills: [
      '......dee.....',
      '......d.......',
      '..g.g.d.g.g...',
      '..ggggggggg...',
      '..gvvgvvgvg...',
      '..gvvgvvgvg...',
      '..gggddgggg...',
      '..gggddgggg...',
      '.GGGGddGGGGG..',
      'GGGJGGGGGGJGG.',
      'GGGGGGGGGGGGGG',
      'GGGGGGGGGGGGGG',
      'FGGGGGGGGGGGGF',
      'FFFFFFFFFFFFFF'
    ]
  };
  const STAMP_RING = {
    tulips: 'i', windmill: 'k', beach: 'u', forest: 'G',
    canal: 'm', harbour: 'f', ice: 'q', hills: 'P'
  };

  const ICONS = {
    flag: [
      { x: 3, y: 2, rows: Array(16).fill('d') },
      { x: 2, y: 1, rows: ['uuu', 'u..'] },
      { x: 1, y: 17, rows: ['dddddd', '.dddd.'] },
      { x: 4, y: 2, rows: [
        'ssssssssssss.',
        'nnnwwwnnnwwws',
        'nnnwwwnnnwwws',
        'nnnwwwnnnwwws',
        'wwwnnnwwwnnns',
        'wwwnnnwwwnnns',
        'wwwnnnwwwnnns',
        'nnnwwwnnnwwws',
        'nnnwwwnnnwwws',
        'nnnwwwnnnwwws',
        'ssssssssssss.'
      ] }
    ],
    trophy: [
      { x: 4, y: 2, rows: [
        'dddddddddddd',
        'dwyyyyyyyyud',
        'dwyyyyyyyyud',
        'dwyyyyyyyyud',
        '.dwyyyyyyud.',
        '.dwyyyyyyud.',
        '..dwyyyyud..',
        '..dwyyyyud..',
        '...dyyyud...',
        '....dddd....'
      ] },
      { x: 1, y: 4, rows: [
        '.ddd',
        'duud',
        'du.d',
        'du.d',
        'duud',
        '.dd.'
      ] },
      { x: 15, y: 4, rows: [
        'ddd.',
        'duud',
        'd.ud',
        'd.ud',
        'duud',
        '.dd.'
      ] },
      { x: 8, y: 12, rows: [
        'duud',
        'duud'
      ] },
      { x: 5, y: 14, rows: [
        'dddddddddd',
        'duuuuuuuud',
        'duuuuuuuud',
        'dddddddddd'
      ] }
    ],
    lock: [
      { x: 5, y: 2, rows: [
        '..nnnnnn..',
        '.nvvvvvvn.',
        'nvvnnnnvvn',
        'nvvn..nvvn',
        'nvvn..nvvn',
        'nvvn..nvvn',
        'nvvn..nvvn',
        'nvvn..nvvn'
      ] },
      { x: 4, y: 10, rows: [
        'dddddddddddd',
        'dwyyyyyyyyud',
        'dyyyyyyyyyud',
        'dyyyynnyyyud',
        'dyyyynnyyyud',
        'dyyyynnyyyud',
        'dyyyyyyyyyud',
        'duuuuuuuuuud',
        'dddddddddddd'
      ] }
    ],
    licence: [
      { x: 1, y: 5, rows: [
        'MMMMMMMMMMMMMMMMMM',
        'MPPPPPPPPPPPPPPPPM',
        'MPwwPwwwwPPPPPPPPM',
        'MhhhhhhhhhhhhhhhhM',
        'MhjjjjjjhhsssssshM',
        'MhjjccjjhhhhhhhhhM',
        'MhjjccjjhhsssssshM',
        'MhjoooojhhhhhuuuhM',
        'MhjoooojhhhhhuyuhM',
        'MhhhhhhhhhhhhuuuhM',
        'MMMMMMMMMMMMMMMMMM'
      ] }
    ]
  };

  // ---------------------------------------------------------------------------
  // Baking
  // ---------------------------------------------------------------------------
  function has(obj, key) {
    return typeof key === 'string' && Object.prototype.hasOwnProperty.call(obj, key);
  }

  const COLOR = {};
  Object.keys(GLYPHS).forEach(function (g) { COLOR[g] = PALETTE[GLYPHS[g]]; });

  function grid(w, h) {
    const g = [];
    for (let y = 0; y < h; y++) g.push(new Array(w).fill(''));
    return g;
  }

  // Paint a { x, y, rows } layer onto a glyph grid; slots maps digit -> glyph.
  function stamp(g, layer, dx, dy, slots) {
    const rows = layer.rows;
    for (let y = 0; y < rows.length; y++) {
      const gy = layer.y + y + dy;
      if (gy < 0 || gy >= g.length) continue;
      const row = rows[y];
      for (let x = 0; x < row.length; x++) {
        let ch = row.charAt(x);
        if (ch === '.' || ch === ' ') continue;
        if (slots && slots[ch]) ch = slots[ch];
        const gx = layer.x + x;
        if (gx < 0 || gx >= g[0].length) continue;
        g[gy][gx] = ch;
      }
    }
  }

  function wheelLayer(rows, at, hub) {
    return {
      x: at.x, y: at.y,
      rows: rows.map(function (r) { return r.replace(/@/g, hub); })
    };
  }

  function kartGrid(id, frame) {
    const def = KARTS[id];
    const g = grid(SIZES.kart.w, SIZES.kart.h);
    def.driver.forEach(function (l) { stamp(g, l, 0, frame ? 1 : 0, def.slots); });
    def.chassis.forEach(function (l) { stamp(g, l, 0, 0, def.slots); });
    stamp(g, wheelLayer(WHEEL_REAR[frame], REAR_AT, def.hub), 0, 0);
    stamp(g, wheelLayer(WHEEL_FRONT[frame], FRONT_AT, def.hub), 0, 0);
    return g;
  }

  function newCanvas(w, h) {
    if (typeof document === 'undefined') return null;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  // Glyph grid -> canvas at 1:1 (optionally mirrored left/right).
  function paint(g, flip) {
    const h = g.length;
    const w = g[0].length;
    const c = newCanvas(w, h);
    if (!c) return null;
    const ctx = c.getContext('2d');
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const color = COLOR[g[y][flip ? w - 1 - x : x]];
        if (!color) continue;
        ctx.fillStyle = color;
        ctx.fillRect(x, y, 1, 1);
      }
    }
    return c;
  }

  const kartCache = Object.create(null);
  function kartCanvas(id, frame, flip) {
    if (!has(KARTS, id)) return null;
    const key = id + '|' + frame + '|' + (flip ? 1 : 0);
    if (!kartCache[key]) kartCache[key] = paint(kartGrid(id, frame), flip);
    return kartCache[key];
  }

  const headCache = Object.create(null);
  function headCanvas(id) {
    if (!has(HEADS, id)) return null;
    if (!headCache[id]) {
      const g = grid(SIZES.head.w, SIZES.head.h);
      HEADS[id].forEach(function (l) { stamp(g, l, 0, 0, KARTS[id].slots); });
      headCache[id] = paint(g, false);
    }
    return headCache[id];
  }

  // Round postmark: ring + paper disc, centred on the 20x20 canvas. The dashed
  // variant (an unearned slot) is a 1px circle cut into twelve short dashes.
  function stampGrid(ring, picto, dashed) {
    const g = grid(SIZES.icon.w, SIZES.icon.h);
    const mid = SIZES.icon.w / 2;
    const rim = [];
    for (let y = 0; y < g.length; y++) {
      for (let x = 0; x < g[y].length; x++) {
        const dx = x + 0.5 - mid;
        const dy = y + 0.5 - mid;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (dashed) {
          // a clean 1px circle, walked clockwise from the top
          if (d > 9 && d <= 10) rim.push({ x: x, y: y, a: (Math.atan2(dy, dx) + Math.PI * 2.5) % (Math.PI * 2) });
        } else if (d <= 9.9) {
          g[y][x] = d > 7.9 ? ring : 'w';
        }
      }
    }
    rim.sort(function (p, q) { return p.a - q.a; });
    rim.forEach(function (p, i) {
      if (i % 5 < 3) g[p.y][p.x] = ring;   // 3 inked, 2 skipped: twelve dashes
    });
    if (picto) stamp(g, { x: 3, y: 3, rows: picto }, 0, 0);
    return g;
  }

  function iconGrid(name) {
    if (typeof name !== 'string') return null;
    if (name === 'empty-stamp') return stampGrid('s', null, true);
    if (name.indexOf('stamp-') === 0) {
      const theme = name.slice(6);
      return has(PICTOS, theme) ? stampGrid(STAMP_RING[theme], PICTOS[theme], false) : null;
    }
    if (!has(ICONS, name)) return null;
    const g = grid(SIZES.icon.w, SIZES.icon.h);
    ICONS[name].forEach(function (l) { stamp(g, l, 0, 0); });
    return g;
  }

  const iconCache = Object.create(null);
  function iconCanvas(name) {
    if (!iconCache[name]) {
      const g = iconGrid(name);
      if (!g) return null;
      iconCache[name] = paint(g, false);
    }
    return iconCache[name];
  }

  function intScale(scale) {
    const s = Math.round(Number(scale));
    if (!(s >= 1)) return 1;
    return s > MAX_SCALE ? MAX_SCALE : s;
  }

  // What unknown ids give back: a real 1x1 transparent PNG, made at runtime so no
  // image data is checked in ('data:,' only when there is no canvas, i.e. in Node).
  let blankURL = '';
  function transparentURL() {
    if (!blankURL) {
      try { blankURL = newCanvas(1, 1).toDataURL('image/png'); } catch (e) { blankURL = 'data:,'; }
    }
    return blankURL;
  }

  const urlCache = Object.create(null);
  function toURL(kind, id, scale, getCanvas) {
    const s = intScale(scale);
    const key = kind + '|' + (typeof id === 'string' ? id : '') + '|' + s;
    if (urlCache[key]) return urlCache[key];
    let url = '';
    try {
      const src = getCanvas(id);
      if (src) {
        const c = newCanvas(src.width * s, src.height * s);
        const ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(src, 0, 0, c.width, c.height);
        url = c.toDataURL('image/png');
      }
    } catch (e) { url = ''; }
    return (urlCache[key] = url || transparentURL());
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  // Nearest-neighbour blit at an integer scale; never throws.
  function blit(ctx, spr, x, y, scale) {
    try {
      if (!ctx || !spr) return;
      const was = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(spr, x, y, spr.width * scale, spr.height * scale);
      ctx.imageSmoothingEnabled = was;
    } catch (e) { /* drawing must never break the game loop */ }
  }

  // x, y = bottom-centre of the kart: the sprite covers columns x-16 .. x+15
  // (times scale) and rows y-22 .. y-1, i.e. y is the ground line just under
  // the wheels. Flipping mirrors around that same centre.
  function draw(ctx, heroId, x, y, opts) {
    try {
      const o = opts || {};
      const frame = Math.abs(Math.round(Number(o.frame)) || 0) % 2;
      const spr = kartCanvas(heroId, frame, !!o.flip);
      if (!spr) return;
      const s = intScale(o.scale);
      blit(ctx, spr, Math.round(x) - (spr.width * s >> 1), Math.round(y) - spr.height * s, s);
    } catch (e) { /* never break the game loop */ }
  }

  // Extras for canvas code (e.g. the minimap strip): x, y = centre of the head / icon.
  function drawHead(ctx, heroId, x, y, opts) {
    try {
      const spr = headCanvas(heroId);
      if (!spr) return;
      const s = intScale(opts && opts.scale);
      blit(ctx, spr, Math.round(x) - (spr.width * s >> 1), Math.round(y) - (spr.height * s >> 1), s);
    } catch (e) { /* never break the game loop */ }
  }

  function drawIcon(ctx, name, x, y, opts) {
    try {
      const spr = iconCanvas(name);
      if (!spr) return;
      const s = intScale(opts && opts.scale);
      blit(ctx, spr, Math.round(x) - (spr.width * s >> 1), Math.round(y) - (spr.height * s >> 1), s);
    } catch (e) { /* never break the game loop */ }
  }

  function heroURL(heroId, scale) {
    return toURL('hero', heroId, scale, function (id) { return kartCanvas(id, 0, false); });
  }

  function headURL(heroId, scale) {
    return toURL('head', heroId, scale, headCanvas);
  }

  function iconURL(name, scale) {
    return toURL('icon', name, scale, iconCanvas);
  }

  // Problems with the art data (wrong row widths, unknown glyphs); [] when clean.
  function validate() {
    const bad = [];
    function checkLayer(label, l, box) {
      const w = l.rows[0].length;
      const size = box || SIZES.kart;
      if (l.x < 0 || l.y < 0 || l.x + w > size.w || l.y + l.rows.length > size.h) {
        bad.push(label + ' sticks out of the canvas');
      }
      l.rows.forEach(function (r, i) {
        if (r.length !== w) bad.push(label + ' row ' + i + ' has width ' + r.length + ', expected ' + w);
        r.split('').forEach(function (ch) {
          if (ch !== '.' && ch !== ' ' && !GLYPHS[ch] && !/[1-6]/.test(ch)) bad.push(label + ' row ' + i + ' unknown glyph ' + ch);
        });
      });
    }
    HERO_IDS.forEach(function (id) {
      const k = KARTS[id];
      k.driver.forEach(function (l, i) { checkLayer(id + '.driver[' + i + ']', l); });
      k.chassis.forEach(function (l, i) { checkLayer(id + '.chassis[' + i + ']', l); });
      [k.driver, k.chassis, HEADS[id]].forEach(function (layers) {
        layers.forEach(function (l) {
          l.rows.join('').split('').forEach(function (ch) {
            if (/[1-6]/.test(ch) && !k.slots[ch]) bad.push(id + ' uses colour slot ' + ch + ' but does not define it');
          });
        });
      });
    });
    [[WHEEL_REAR, 9], [WHEEL_FRONT, 7]].forEach(function (pair) {
      pair[0].forEach(function (rows, f) {
        if (rows.length !== pair[1] || rows.some(function (r) { return r.length !== pair[1]; })) {
          bad.push('wheel ' + pair[1] + ' frame ' + f + ' is not ' + pair[1] + 'x' + pair[1]);
        }
      });
    });
    function checkMap(label, rows, w, h) {
      if (rows.length !== h) bad.push(label + ' has ' + rows.length + ' rows, expected ' + h);
      rows.forEach(function (r, i) {
        if (r.length !== w) bad.push(label + ' row ' + i + ' has width ' + r.length + ', expected ' + w);
        r.split('').forEach(function (ch) {
          if (ch !== '.' && !GLYPHS[ch]) bad.push(label + ' row ' + i + ' unknown glyph ' + ch);
        });
      });
    }
    Object.keys(PICTOS).forEach(function (t) {
      checkMap('picto ' + t, PICTOS[t], 14, 14);
      if (!STAMP_RING[t]) bad.push('picto ' + t + ' has no ring colour');
    });
    Object.keys(ICONS).forEach(function (n) {
      ICONS[n].forEach(function (l, i) { checkLayer('icon ' + n + '[' + i + ']', l, SIZES.icon); });
    });
    ICON_NAMES.forEach(function (n) { if (!iconGrid(n)) bad.push('icon ' + n + ' has no art'); });
    HERO_IDS.forEach(function (id) {
      HEADS[id].forEach(function (l, i) { checkLayer('head ' + id + '[' + i + ']', l, SIZES.head); });
    });
    return bad;
  }

  Object.freeze(PALETTE);
  Object.freeze(GLYPHS);
  Object.freeze(SIZES.kart);
  Object.freeze(SIZES.head);
  Object.freeze(SIZES.icon);
  Object.freeze(SIZES);
  Object.freeze(HERO_IDS);
  Object.freeze(ICON_NAMES);

  return {
    PALETTE: PALETTE,
    GLYPHS: GLYPHS,
    SIZES: SIZES,
    HERO_IDS: HERO_IDS,
    ICON_NAMES: ICON_NAMES,
    draw: draw,
    drawHead: drawHead,
    drawIcon: drawIcon,
    heroURL: heroURL,
    headURL: headURL,
    iconURL: iconURL,
    validate: validate
  };
})();
