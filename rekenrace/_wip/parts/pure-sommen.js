// Question engine for Rekenrace. Pure and DOM-free; only uses RR.Rng.
//
// Layout of this module:
//   1. helpers            small text/number utilities
//   2. method text        hint + explanation builders per operation (Dutch rekenmethode style)
//   3. builders           key -> Question, plus the matching difficulty score
//   4. stories            table-driven story templates (add one line to add a story)
//   5. profiles           per (grade, level) table that drives the whole ramp
//   6. samplers + plan    turn a profile row into concrete sums
//   7. make / series / fromKey / check
//
// Keys are the single source of truth: fromKey(key) rebuilds a question
// (hint and explanation included) from nothing but its key, so hints and
// explanations are chosen from the numbers (via a hash), never from the rng.
//   add:47+36  sub:83-47  times:7x8  div:56:8  gap:sub:?-8=15  story:eieren:6:8
//
// Decisions the contract leaves open:
//  - focus add / sub / story give only that kind. focus times / div give that
//    kind plus gap sums of the same operation (about one in three sums).
//  - table (1..10) restricts times, div and their gap sums; for division the
//    table is the divisor. With focus 'mix' a table turns the series into
//    times + div + gap(x, :) on that table. add/sub ignore it; stories use it
//    (table >= 2) as the "per group" number of a x or : story.
//  - repeat: at most two valid keys are woven in at places 2..5 (never first or
//    last). Keys that do not parse, fit the focus/table, or repeat a key or an
//    answer are skipped silently.
//  - series: each place takes a higher difficulty quantile from a small pool of
//    candidates (warm-up first, no gap/story at the start), never three equal
//    kinds in a row, never a repeated key or answer unless the space of sums
//    is too small to give `count` different answers.
RR.Questions = (function () {
  'use strict';

  const KINDS = { add: 'Optellen', sub: 'Aftrekken', times: 'Tafels', div: 'Delen', gap: 'Gaatjessommen', story: 'Verhaalsommen' };
  const FOCI = ['mix', 'add', 'sub', 'times', 'div', 'story'];
  const MINUS = '\u2212';
  const TIMES = '\u00d7';
  const OPSYM = { add: '+', sub: MINUS, times: TIMES, div: ':' };
  const OPKEY = { add: '+', sub: '-', times: 'x', div: ':' };
  const MAXV = 9999;

  // ---------------------------------------------------------------- helpers

  function rint(rng, lo, hi) { return RR.Rng.int(rng, lo, hi); }
  function seq(lo, hi) { const out = []; for (let i = lo; i <= hi; i++) out.push(i); return out; }

  // FNV-1a: deterministic variation without touching the rng
  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function hasNum(text, n) {
    return new RegExp('(^|[^0-9])' + n + '([^0-9]|$)').test(text);
  }

  // Method text + closing line ("Dus 4 + 6 = 10."). The closing line is left out
  // when the method already contains that very equation. Sentences are packed
  // into short lines (at most three, so a child never meets a wall of text).
  function wrap(how, concl) {
    const eq = concl.slice(4, -1);
    const sents = splitSentences(how);
    const seen = how.indexOf(eq) >= 0 && new RegExp('(^|[^0-9])' + eq.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![0-9])').test(how);
    if (!seen) sents.push(concl);
    let lines = [];
    for (let width = 60; width <= 240; width += 15) {
      lines = [];
      for (const s of sents) {
        if (lines.length && lines[lines.length - 1].length + 1 + s.length <= width) lines[lines.length - 1] += ' ' + s;
        else lines.push(s);
      }
      if (lines.length <= 3) break;
    }
    return lines.join('\n');
  }

  // split after ". " and after "? " when a capital follows (no regex lookbehind: older Safari)
  function splitSentences(text) {
    const out = [];
    let from = 0;
    for (let i = 1; i < text.length - 1; i++) {
      if (text[i] === ' ' && (text[i - 1] === '.' || (text[i - 1] === '?' && /[A-Z]/.test(text[i + 1])))) {
        out.push(text.slice(from, i));
        from = i + 1;
      }
    }
    out.push(text.slice(from));
    return out;
  }

  function lijst(items) {
    if (items.length < 2) return items.join('');
    return items.slice(0, -1).join(', ') + ' en ' + items[items.length - 1];
  }

  // non-zero decimal parts, biggest first: 236 -> [200, 30, 6]
  function parts(n) {
    const out = [];
    for (let p = 1000; p >= 1; p /= 10) {
      const d = Math.floor(n / p) % 10;
      if (d) out.push(d * p);
    }
    return out;
  }

  // lowest non-zero place value of n (1, 10, 100 or 1000)
  function lowPlace(n) {
    let p = 1;
    while (p < 1000 && n % (p * 10) === 0) p *= 10;
    return p;
  }

  const PLACE = {
    1: ['eenheid', 'eenheden'], 10: ['tiental', 'tientallen'],
    100: ['honderdtal', 'honderdtallen'], 1000: ['duizendtal', 'duizendtallen']
  };
  function cnt(n, p) { return n + ' ' + PLACE[p][n === 1 ? 0 : 1]; }

  // biggest of 10/100/1000 that divides every given number (0 when there is none)
  function commonPlace(list) {
    for (const p of [1000, 100, 10]) {
      if (list.every((n) => n > 0 && n % p === 0)) return p;
    }
    return 0;
  }

  function carryAdd(a, b) {
    if (a < 10 && b < 10) return a + b > 10;
    const p = Math.min(lowPlace(a), lowPlace(b));
    return (Math.floor(a / p) % 10) + (Math.floor(b / p) % 10) >= 10;
  }
  function borrowSub(a, b) {
    const p = Math.min(lowPlace(a), lowPlace(b));
    return (Math.floor(a / p) % 10) < (Math.floor(b / p) % 10);
  }

  const ZERO_WORDS = { 1: 'Er komt een nul achter', 2: 'Er komen twee nullen achter', 3: 'Er komen drie nullen achter' };
  function stripZeros(n) {
    let z = 0;
    while (n > 0 && n % 10 === 0) { n /= 10; z++; }
    return { base: n, zeros: z };
  }

  // ------------------------------------------- method text: optellen / aftrekken
  // A *Methods function lists every method that fits the numbers as
  // { how, hint, plain }: `how` is the explanation (no closing "Dus ..." line),
  // `hint` may use the numbers, `plain` is a fallback without the numbers.
  // One method is picked per sum from a hash of its key, so hint and
  // explanation always talk about the same method.

  function firstSafe(list, answer, fallback) {
    for (let i = 0; i < list.length; i++) {
      if (list[i] && !hasNum(list[i], answer)) return list[i];
    }
    return fallback;
  }
  function rotate(list, key) {
    const s = hash(key + '|rot') % list.length;
    return list.slice(s).concat(list.slice(0, s));
  }
  function choose(methods, key, salt) {
    return methods[hash(key + '|' + salt) % methods.length];
  }

  function addInfo(a, b) {
    const s = a + b, lg = Math.max(a, b), sm = Math.min(a, b);
    const i = { a, b, s, lg, sm, dbl: a === b && a <= 500, ten: lg < 10 && s > 10 };
    i.carry = carryAdd(a, b);
    i.round = commonPlace([a, b]);
    // "over het tiental": walk to the next ten first
    i.bridge = null;
    if (i.carry && lg >= 10) {
      const x = lg % 10 !== 0 ? lg : sm, y = x === lg ? sm : lg;
      const t = 10 - (x % 10), r = y - t;
      if (x % 10 !== 0 && y < 100 && r > 0) i.bridge = { x, y, t, r };
    }
    // "compenseren": second number is just below a round ten
    i.comp = null;
    for (const [x, y] of [[a, b], [b, a]]) {
      if (y >= 18 && y % 10 >= 8 && s + (10 - (y % 10)) <= MAXV) { i.comp = { x, y, k: 10 - (y % 10) }; break; }
    }
    // splitsen on the biggest place both numbers reach
    i.split = null;
    const P = sm >= 1000 ? 1000 : sm >= 100 ? 100 : sm >= 10 ? 10 : 0;
    if (P && a % P && b % P) i.split = { P, hiA: a - (a % P), hiB: b - (b % P), loA: a % P, loB: b % P };
    return i;
  }

  function addMethods(a, b) {
    const i = addInfo(a, b), s = i.s, c = [];
    const M = (how, hint, plain) => c.push({ how, hint, plain: plain || hint });
    if (i.dbl) {
      M('Dit is een dubbelsom: dubbel ' + a + ' is ' + s + '.', 'Dit is een dubbelsom: ' + a + ' en nog eens ' + a + '.', 'Dit is een dubbelsom: verdubbel het getal.');
    }
    if (i.ten) {
      const t = 10 - i.lg, r = i.sm - t;
      M('Maak eerst 10 vol: ' + i.lg + ' + ' + t + ' = 10. Er moet nog ' + r + ' bij: 10 + ' + r + ' = ' + s + '.',
        'Hoeveel heeft ' + i.lg + ' nog nodig om tien te worden?', 'Maak eerst tien vol en tel dan de rest erbij.');
    }
    if (i.bridge) {
      const g = i.bridge, m = g.x + g.t;
      M('Eerst naar het volgende tiental: ' + g.x + ' + ' + g.t + ' = ' + m + '. Er moet nog ' + g.r + ' bij: ' + m + ' + ' + g.r + ' = ' + s + '.',
        'Maak van ' + g.x + ' eerst een rond getal.', 'Tel eerst bij tot het volgende tiental.');
    }
    if (i.round) {
      const p = i.round, h = 'Tel eerst de ' + PLACE[p][1] + ' bij elkaar op.';
      M(cnt(a / p, p) + ' + ' + cnt(b / p, p) + ' = ' + cnt(s / p, p) + '.', h);
    }
    if (i.split) {
      const g = i.split, h = 'Splits in ' + PLACE[g.P][1] + ' en de rest en tel die apart op.';
      M('Splits: ' + g.hiA + ' + ' + g.hiB + ' = ' + (g.hiA + g.hiB) + ' en ' + g.loA + ' + ' + g.loB + ' = ' + (g.loA + g.loB) +
        '. Samen ' + (g.hiA + g.hiB) + ' + ' + (g.loA + g.loB) + ' = ' + s + '.', h);
    }
    if (i.comp) {
      const g = i.comp;
      M(g.y + ' ligt dicht bij ' + (g.y + g.k) + '. ' + g.x + ' + ' + (g.y + g.k) + ' = ' + (s + g.k) + ', en dan ' + g.k + ' terug: ' + s + '.',
        g.y + ' ligt dicht bij ' + (g.y + g.k) + '. Rond af en haal het verschil er daarna weer af.',
        'Rond een getal af op een tiental en corrigeer daarna.');
    }
    if (i.sm >= 10) {
      const ps = parts(i.sm);
      if (ps.length >= 2) {
        let cur = i.lg;
        const steps = ps.map((p) => { const t = cur + ' + ' + p + ' = ' + (cur + p); cur += p; return t; });
        M('Stap voor stap: ' + lijst(steps) + '.', 'Splits ' + i.sm + ' in ' + lijst(ps) + ' en tel die stap voor stap erbij.',
          'Splits het kleinste getal in stukken en tel die stap voor stap erbij.');
      } else {
        const p = lowPlace(i.sm), h = 'Alleen de ' + PLACE[p][1] + ' veranderen: tel ze erbij.';
        M('Je telt alleen ' + cnt(i.sm / p, p) + ' bij ' + i.lg + ' op.', h);
      }
    } else if (i.lg >= 10 && !i.carry && i.lg % 10 !== 0) {
      const u = i.lg % 10, h = 'Alleen de eenheden veranderen. Kijk naar de laatste cijfers.';
      M(i.lg + ' is ' + (i.lg - u) + ' en ' + u + '. ' + u + ' + ' + i.sm + ' = ' + (u + i.sm) + ' en ' + (i.lg - u) + ' + ' + (u + i.sm) + ' = ' + s + '.', h);
    }
    if (!c.length) {
      if (i.sm <= 5 && s <= 20) {
        M('Begin bij ' + i.lg + ' en tel ' + i.sm + ' verder: ' + seq(i.lg + 1, s).join(', ') + '.', 'Tel verder vanaf ' + i.lg + '.',
          'Tel verder, stap voor stap.');
      }
      M('Begin bij ' + i.lg + ' en tel er ' + i.sm + ' bij.', 'Begin bij ' + i.lg + ' en tel er ' + i.sm + ' bij.', 'Zie het als een sprong op de getallenlijn.');
    }
    return c;
  }

  function subInfo(a, b) {
    const r = a - b;
    const i = { a, b, r, borrow: borrowSub(a, b), u: a % 10 };
    i.round = commonPlace([a, b]);
    // aanvullen via the next ten
    i.fill = null;
    if (b >= 10 && b % 10 !== 0) {
      const t = b + 10 - (b % 10), f = a - (a % 10);
      if (t <= a && f >= t && (r <= 60 || a === 100)) {
        const stops = [b, t, f, a], pairs = [];
        for (let j = 0; j < 3; j++) if (stops[j + 1] > stops[j]) pairs.push([stops[j], stops[j + 1]]);
        if (pairs.length >= 2) i.fill = pairs;
      }
    }
    // aanvullen via the next hundred, towards a round hundred
    if (!i.fill && a % 100 === 0 && b >= 100 && b % 100 !== 0) {
      const h = b + 100 - (b % 100);
      if (h < a) i.fill = [[b, h], [h, a]];
    }
    i.comp = b >= 18 && b % 10 >= 8 && a >= b + (10 - (b % 10)) ? 10 - (b % 10) : 0;
    return i;
  }

  function subMethods(a, b) {
    const i = subInfo(a, b), r = i.r, c = [], u = i.u;
    const M = (how, hint, plain) => c.push({ how, hint, plain: plain || hint });
    if (a <= 20 && !i.borrow) {
      if (b <= 5) {
        M('Begin bij ' + a + ' en tel ' + b + ' terug: ' + seq(r, a - 1).reverse().join(', ') + '.', 'Begin bij ' + a + ' en tel ' + b + ' terug.',
          'Tel terug, stap voor stap.');
      }
      M('Begin bij ' + a + ' en haal er ' + b + ' af.', 'Hoeveel blijft er over als je ' + b + ' weghaalt?', 'Zie het als een sprong terug op de getallenlijn.');
    }
    if (b < 10 && a >= 11 && u > 0 && u < b) {
      M('Eerst terug naar het hele tiental: ' + a + ' ' + MINUS + ' ' + u + ' = ' + (a - u) + '. Er moet nog ' + (b - u) +
        ' af: ' + (a - u) + ' ' + MINUS + ' ' + (b - u) + ' = ' + r + '.', 'Ga eerst terug naar het hele tiental en haal dan de rest weg.');
    }
    if (b < 10 && b >= 6 && a >= 20 && u === 0) {
      M('Haal eerst 10 weg: ' + a + ' ' + MINUS + ' 10 = ' + (a - 10) + '. Dat is ' + (10 - b) + ' te veel, dus ' + (10 - b) +
        ' er weer bij: ' + (a - 10) + ' + ' + (10 - b) + ' = ' + r + '.', 'Haal eerst tien weg en doe er daarna een stukje bij.');
    }
    if (b < 10 && a >= 10 && u > b) {
      M(a + ' is ' + (a - u) + ' en ' + u + '. ' + u + ' ' + MINUS + ' ' + b + ' = ' + (u - b) + ' en ' + (a - u) + ' + ' + (u - b) + ' = ' + r + '.',
        'Alleen de eenheden veranderen. Kijk naar de laatste cijfers.');
    }
    if (i.round) {
      const p = i.round;
      M(cnt(a / p, p) + ' ' + MINUS + ' ' + cnt(b / p, p) + ' = ' + cnt(r / p, p) + '.', 'Haal de ' + PLACE[p][1] + ' van elkaar af.');
    }
    if (i.fill) {
      const names = i.fill.map((p) => 'van ' + p[0] + ' naar ' + p[1] + ' is ' + (p[1] - p[0]));
      M('Aanvullen: ' + lijst(names) + '. Samen ' + i.fill.map((p) => p[1] - p[0]).join(' + ') + ' = ' + r + '.',
        'Je kunt ook aanvullen: hoeveel moet er bij ' + b + ' om ' + a + ' te krijgen?',
        'Je kunt ook aanvullen: hoeveel moet er bij het kleine getal om het grote te krijgen?');
    }
    if (i.comp) {
      M(b + ' ligt dicht bij ' + (b + i.comp) + '. ' + a + ' ' + MINUS + ' ' + (b + i.comp) + ' = ' + (r - i.comp) + ', en dan ' + i.comp + ' erbij: ' + r + '.',
        b + ' ligt dicht bij ' + (b + i.comp) + '. Haal eerst dat af en corrigeer daarna.',
        'Rond het getal dat je aftrekt af op een rond getal en corrigeer daarna.');
    }
    if (b >= 10) {
      const ps = parts(b);
      if (ps.length >= 2) {
        let cur = a;
        const steps = ps.map((p) => { const t = cur + ' ' + MINUS + ' ' + p + ' = ' + (cur - p); cur -= p; return t; });
        M('Stap voor stap: ' + lijst(steps) + '.', 'Haal ' + b + ' er in stukjes af: ' + lijst(ps) + '.',
          'Haal het getal er in stukjes af: eerst de grote stukken, dan de rest.');
      } else {
        const p = lowPlace(b);
        M('Je haalt alleen ' + cnt(b / p, p) + ' van ' + a + ' af.', 'Alleen de ' + PLACE[p][1] + ' veranderen: haal ze eraf.');
      }
    }
    if (!c.length) {
      M('Begin bij ' + a + ' en haal er ' + b + ' af.', 'Begin bij ' + a + ' en haal er ' + b + ' af.', 'Zie het als een sprong terug op de getallenlijn.');
    }
    return c;
  }

  function addHow(a, b, k) { return choose(addMethods(a, b), k, 'add').how; }
  function subHow(a, b, k) { return choose(subMethods(a, b), k, 'sub').how; }

  // ------------------------------------------------ method text: tafels / delen

  // which factor carries the method; the other one is the number being multiplied
  const PIVOT_ORDER = [10, 1, 2, 9, 6, 8, 4, 3, 5, 7];
  function pivotOf(a, b) {
    return PIVOT_ORDER.indexOf(a) <= PIVOT_ORDER.indexOf(b) ? [a, b] : [b, a];
  }

  function timesMethods(a, b) {
    const p = a * b, c = [];
    const M = (how, hint, plain) => c.push({ how, hint, plain: plain || hint });
    if (a <= 10 && b <= 10) {
      const pv = pivotOf(a, b), t = pv[0], q = pv[1];
      switch (t) {
        case 1: M('E\u00e9n keer ' + q + ' is gewoon ' + q + '.', 'E\u00e9n keer iets is gewoon dat getal zelf.'); break;
        case 10: M('Keer 10: zet een nul achter ' + q + '. Dat wordt ' + p + '.', 'Bij keer tien zet je een nul achter het getal.'); break;
        case 2:
          M('Verdubbel ' + q + ': ' + q + ' + ' + q + ' = ' + p + '.', 'Verdubbel het getal.', 'Twee keer hetzelfde getal: dat is dubbel zoveel.');
          break;
        case 3:
          M('Tafel van 3 is tafel van 2 en dan 1 keer erbij: 2 ' + TIMES + ' ' + q + ' = ' + 2 * q + ' en ' + 2 * q + ' + ' + q + ' = ' + p + '.',
            'Tafel van 3 is tafel van 2 en dan 1 keer erbij.');
          break;
        case 4:
          M('Verdubbel twee keer: dubbel ' + q + ' is ' + 2 * q + ', dubbel ' + 2 * q + ' is ' + p + '.',
            'Verdubbel het getal en verdubbel het dan nog een keer.');
          break;
        case 5:
          M('Tafel van 5 is de helft van tafel van 10: 10 ' + TIMES + ' ' + q + ' = ' + 10 * q + ', de helft is ' + p + '.',
            'Tel in vijven, of neem de helft van de tafel van tien.');
          if (q <= 10) {
            M('Tel in vijven: ' + seq(1, q).map((j) => 5 * j).join(', ') + '. Dat is ' + q + ' keer.', 'Tel in vijven.', 'Tel in vijven, of neem de helft van de tafel van tien.');
          }
          break;
        case 6:
          M('Tafel van 6 is tafel van 5 en dan 1 keer erbij: 5 ' + TIMES + ' ' + q + ' = ' + 5 * q + ' en ' + 5 * q + ' + ' + q + ' = ' + p + '.',
            'Tafel van 6 is tafel van 5 en dan 1 keer erbij.');
          break;
        case 7:
          M('Tafel van 7 is tafel van 5 en 2 keer erbij: 5 ' + TIMES + ' ' + q + ' = ' + 5 * q + ' en 2 ' + TIMES + ' ' + q + ' = ' + 2 * q +
            '. Samen ' + 5 * q + ' + ' + 2 * q + ' = ' + p + '.', 'Tafel van 7 is tafel van 5 en 2 keer erbij.');
          break;
        case 8:
          M('Tafel van 8 is het dubbele van tafel van 4: 4 ' + TIMES + ' ' + q + ' = ' + 4 * q + ' en dubbel ' + 4 * q + ' is ' + p + '.',
            'Tafel van 8 is het dubbele van tafel van 4.');
          M('Verdubbel drie keer: dubbel ' + q + ' is ' + 2 * q + ', dubbel ' + 2 * q + ' is ' + 4 * q + ', dubbel ' + 4 * q + ' is ' + p + '.',
            'Verdubbel het getal drie keer.');
          break;
        default:
          M('Tafel van 9 is tafel van 10 min 1 keer: 10 ' + TIMES + ' ' + q + ' = ' + 10 * q + ' en ' + 10 * q + ' ' + MINUS + ' ' + q + ' = ' + p + '.',
            'Tafel van 9 is tafel van 10 min 1 keer: reken 10 ' + TIMES + ' ' + q + ' en haal er ' + q + ' af.', 'Tafel van 9 is tafel van 10 min 1 keer.');
      }
      if (a !== b && Math.min(a, b) >= 2) c.forEach((m) => { m.alt = 'Je mag de som ook omdraaien: ' + b + ' ' + TIMES + ' ' + a + '.'; });
      return c;
    }
    const big = Math.max(a, b), small = Math.min(a, b);
    const zs = stripZeros(big), zt = stripZeros(small), z = zs.zeros + zt.zeros;
    if (z >= 1 && z <= 3) {
      M(zs.base + ' ' + TIMES + ' ' + zt.base + ' = ' + zs.base * zt.base + '. ' + ZERO_WORDS[z] + ': ' + p + '.',
        'Reken eerst zonder de nullen en zet ze er daarna weer achter.');
      return c;
    }
    const splitNum = small <= 10 ? big : small, other = small <= 10 ? small : big;
    const ps = parts(splitNum);
    const items = ps.map((x) => (small <= 10 ? x + ' ' + TIMES + ' ' + other : other + ' ' + TIMES + ' ' + x) + ' = ' + x * other);
    M('Splits ' + splitNum + ' in ' + lijst(ps) + ': ' + lijst(items) + '. Samen ' + ps.map((x) => x * other).join(' + ') + ' = ' + p + '.',
      'Splits ' + splitNum + ' in ' + lijst(ps) + ' en reken elk deel apart uit.', 'Splits het grote getal in stukken en reken elk deel apart uit.');
    return c;
  }

  function divMethods(n, d) {
    const q = n / d, c = [];
    const M = (how, hint, plain) => c.push({ how, hint, plain: plain || hint });
    if (d === 1) {
      M('Delen door 1 verandert niets: ' + n + ' : 1 = ' + n + '.', 'Delen door 1 verandert niets.');
      return c;
    }
    const inverse = 'Delen is het omgekeerde van keer. Zoek de tafel erbij.';
    if (d <= 10 && q <= 10) {
      M('Delen is het omgekeerde van keer: welk getal keer ' + d + ' is ' + n + '? ' + q + ' ' + TIMES + ' ' + d + ' = ' + n + '.',
        'Delen is het omgekeerde van keer. Welk getal keer ' + d + ' is ' + n + '?', inverse);
      M('Zoek in de tafel van ' + d + ': ' + q + ' ' + TIMES + ' ' + d + ' = ' + n + '.',
        'Zeg de tafel van ' + d + ' op en kijk wanneer je bij ' + n + ' komt.', inverse);
    }
    if (d === 2) M('Delen door 2 is halveren: de helft van ' + n + ' is ' + q + '.', 'Delen door twee is halveren.');
    if (d === 4) M('Halveer twee keer: de helft van ' + n + ' is ' + n / 2 + ', de helft daarvan is ' + q + '.', 'Halveer, en halveer dan nog een keer.');
    if (d === 8) M('Halveer drie keer: ' + n + ' wordt ' + n / 2 + ', dan ' + n / 4 + ' en dan ' + q + '.', 'Halveer drie keer.');
    if (d === 5 && 2 * n <= MAXV) {
      M('Delen door 5 is verdubbelen en dan delen door 10: ' + 2 * n + ' : 10 = ' + q + '.', 'Delen door vijf: verdubbel eerst en deel dan door tien.');
    }
    if (d === 10) M('Delen door 10: haal een nul weg. ' + n + ' wordt ' + q + '.', 'Delen door tien: haal een nul weg.');
    if (q > 10 || d > 10) {
      const ps = parts(q);
      if (ps.length >= 2) {
        const pieces = ps.map((x) => x * d);
        M('Splits ' + n + ' in ' + lijst(pieces) + ': ' + lijst(pieces.map((v, j) => v + ' : ' + d + ' = ' + ps[j])) + '. Samen ' + ps.join(' + ') + ' = ' + q + '.',
          'Splits ' + n + ' in stukken die je makkelijk door ' + d + ' kunt delen.', 'Splits het getal in stukken die je makkelijk kunt delen.');
      } else if (q >= 10 && d <= 10) {
        const p = lowPlace(q);
        M(cnt(n / p, p) + ' : ' + d + ' = ' + cnt(q / p, p) + '.', 'Deel eerst de ' + PLACE[p][1] + '.');
      }
    }
    if (!c.length) M('Delen is het omgekeerde van keer: ' + q + ' ' + TIMES + ' ' + d + ' = ' + n + '.', 'Welk getal keer ' + d + ' is ' + n + '?', inverse);
    return c;
  }

  function timesHow(a, b, k) { return choose(timesMethods(a, b), k, 'times').how; }
  function divHow(n, d, k) { return choose(divMethods(n, d), k, 'div').how; }

  // --------------------------------------------------------------- builders
  // A descriptor is a cheap handle { key, kind, ans, d, make }: samplers create
  // many of them, only the chosen ones pay for make() (hint + explanation).

  const FB = {
    add: 'Reken stap voor stap.',
    sub: 'Reken stap voor stap.',
    times: 'Denk aan de tafel die erbij hoort.',
    div: 'Denk aan de keersom die erbij hoort.',
    gap: 'Welk getal hoort er op de plek van het vraagteken?',
    story: 'Lees de som nog eens rustig en bedenk wat je moet doen.'
  };

  function mk(key, kind, text, answer, hint, explain, formula) {
    return { key, kind, text, answer, hint, explain, formula };
  }

  // relative difficulty, only used to order sums inside one series
  const TBL = [0, 0, 0.1, 0.5, 0.6, 0.2, 0.9, 1, 1, 0.9, 0.1];
  function factorHard(n) { return n <= 10 ? TBL[n] : 1 + 0.8 * Math.log10(n); }
  function dAdd(a, b) { return 0.75 * Math.log2(1 + Math.max(a, b)) + (carryAdd(a, b) ? 1 : 0) + (Math.min(a, b) >= 10 ? 0.5 : 0); }
  function dSub(a, b) { return 0.75 * Math.log2(1 + a) + (borrowSub(a, b) ? 1.2 : 0) + (b >= 10 ? 0.5 : 0); }
  function dTimes(a, b) { return 0.5 * Math.log2(1 + a * b) + Math.max(factorHard(a), factorHard(b)); }
  function dDiv(n, d) { return dTimes(d, n / d) + 0.4; }

  function arith(kind, key, text, ans, methods, eq, formula) {
    const m = choose(methods, key, kind);
    return mk(key, kind, text, ans, firstSafe([m.hint, m.alt, m.plain], ans, FB[kind]), wrap(m.how, 'Dus ' + eq + '.'), formula);
  }

  function descAdd(a, b) {
    const key = 'add:' + a + '+' + b, s = a + b;
    return { key, kind: 'add', ans: s, d: dAdd(a, b),
      make: () => arith('add', key, a + ' + ' + b + ' = ?', s, addMethods(a, b), a + ' + ' + b + ' = ' + s, a + '+' + b) };
  }

  function descSub(a, b) {
    const key = 'sub:' + a + '-' + b, r = a - b;
    return { key, kind: 'sub', ans: r, d: dSub(a, b),
      make: () => arith('sub', key, a + ' ' + MINUS + ' ' + b + ' = ?', r, subMethods(a, b), a + ' ' + MINUS + ' ' + b + ' = ' + r, a + '-' + b) };
  }

  function descTimes(a, b) {
    const key = 'times:' + a + 'x' + b, p = a * b;
    return { key, kind: 'times', ans: p, d: dTimes(a, b),
      make: () => arith('times', key, a + ' ' + TIMES + ' ' + b + ' = ?', p, timesMethods(a, b), a + ' ' + TIMES + ' ' + b + ' = ' + p, a + '*' + b) };
  }

  function descDiv(n, d) {
    const key = 'div:' + n + ':' + d, q = n / d;
    return { key, kind: 'div', ans: q, d: dDiv(n, d),
      make: () => arith('div', key, n + ' : ' + d + ' = ?', q, divMethods(n, d), n + ' : ' + d + ' = ' + q, n + '/' + d) };
  }

  // Gap sum from the complete equation a OP b = c; `unk` ('a' | 'b') is hidden.
  function gapParts(op, a, b, c, unk, key) {
    const ans = unk === 'a' ? a : b;
    const sym = OPSYM[op], full = a + ' ' + sym + ' ' + b + ' = ' + c;
    const text = (unk === 'a' ? '?' : a) + ' ' + sym + ' ' + (unk === 'b' ? '?' : b) + ' = ' + c;
    let hints, how, lead, formula;
    if (op === 'add') {
      const k = unk === 'a' ? b : a;                      // the known addend
      formula = c + '-' + k;
      lead = text + ' betekent ' + c + ' ' + MINUS + ' ' + k + '.';
      how = subHow(c, k, key);
      hints = ['Wat moet er bij ' + k + ' om ' + c + ' te krijgen?', 'Maak er een minsom van: ' + c + ' ' + MINUS + ' ' + k + '.',
        'Tel op vanaf ' + k + ' tot je bij ' + c + ' komt.'];
    } else if (op === 'sub' && unk === 'a') {
      formula = c + '+' + b;
      lead = text + ' betekent ' + c + ' + ' + b + '.';
      how = addHow(c, b, key);
      hints = ['Je haalt ' + b + ' weg en houdt ' + c + ' over. Hoeveel was het eerst?', 'Maak er een plussom van: ' + c + ' + ' + b + '.',
        'Rekenen in de omgekeerde richting: wat moet je bij ' + c + ' doen?'];
    } else if (op === 'sub') {
      formula = a + '-' + c;
      lead = text + ' betekent ' + a + ' ' + MINUS + ' ' + c + '.';
      how = subHow(a, c, key);
      hints = ['Hoeveel haal je weg van ' + a + ' om ' + c + ' over te houden?', 'Maak er een minsom van: ' + a + ' ' + MINUS + ' ' + c + '.',
        'Tel op vanaf ' + c + ' tot je bij ' + a + ' komt.'];
    } else if (op === 'times') {
      const k = unk === 'a' ? b : a;                      // the known factor
      formula = c + '/' + k;
      lead = text + ' betekent ' + c + ' : ' + k + '.';
      how = divHow(c, k, key);
      hints = ['Welk getal keer ' + k + ' is ' + c + '?', 'Delen is het omgekeerde van keer: ' + c + ' : ' + k + '.'];
      if (k <= 10) hints.push('Zeg de tafel van ' + k + ' op tot je bij ' + c + ' komt.');
    } else if (unk === 'a') {
      formula = c + '*' + b;
      lead = text + ' betekent ' + c + ' ' + TIMES + ' ' + b + '.';
      how = timesHow(c, b, key);
      hints = ['Maak er een keersom van: ' + c + ' ' + TIMES + ' ' + b + '.', 'Welk getal gedeeld door ' + b + ' geeft ' + c + '? Denk aan de keersom.'];
    } else {
      formula = a + '/' + c;
      lead = text + ': hoe vaak past ' + c + ' in ' + a + '?';
      how = divHow(a, c, key);
      hints = ['Hoe vaak past ' + c + ' in ' + a + '?', 'Welk getal keer ' + c + ' is ' + a + '?', 'Maak er een deelsom van: ' + a + ' : ' + c + '.'];
    }
    return {
      text, ans, formula,
      hint: firstSafe(rotate(hints, key), ans, FB.gap),
      explain: wrap(lead + ' ' + how, 'Dus ' + full + '.')
    };
  }

  function descGap(op, a, b, c, unk) {
    const key = 'gap:' + op + ':' + (unk === 'a' ? '?' : a) + OPKEY[op] + (unk === 'b' ? '?' : b) + '=' + c;
    const base = op === 'add' ? dAdd(a, b) + 0.8 : op === 'sub' ? dSub(a, b) + 0.8 : op === 'times' ? dTimes(a, b) + 0.5 : dDiv(a, b) + 0.5;
    return {
      key, kind: 'gap', ans: unk === 'a' ? a : b, d: base,
      make: () => { const g = gapParts(op, a, b, c, unk, key); return mk(key, 'gap', g.text, g.ans, g.hint, g.explain, g.formula); }
    };
  }

  // ----------------------------------------------------------------- fromKey

  const NUM = '([1-9]\\d{0,3})';
  const RE_ADD = new RegExp('^add:' + NUM + '\\+' + NUM + '$');
  const RE_SUB = new RegExp('^sub:' + NUM + '-' + NUM + '$');
  const RE_TIMES = new RegExp('^times:' + NUM + 'x' + NUM + '$');
  const RE_DIV = new RegExp('^div:' + NUM + ':' + NUM + '$');
  const RE_GAP = /^gap:(add|sub|times|div):([1-9]\d{0,3}|\?)([-+x:])([1-9]\d{0,3}|\?)=(0|[1-9]\d{0,3})$/;
  const RE_STORY = /^story:([a-z]+):([1-9]\d{0,3}(?::[1-9]\d{0,3}){1,2})$/;

  // Solve the hidden number of a gap sum; null when the key describes something impossible.
  function solveGap(op, A, B, c) {
    if ((A === '?') === (B === '?')) return null;
    const unk = A === '?' ? 'a' : 'b';
    const k = unk === 'a' ? Number(B) : Number(A);       // known operand
    let x;                                              // the hidden operand
    if (op === 'add') x = c - k;
    else if (op === 'sub') x = unk === 'a' ? c + k : k - c;
    else if (op === 'times') { if (c % k) return null; x = c / k; }
    else if (unk === 'a') x = c * k;                      // ? : k = c
    else { if (c === 0 || k % c) return null; x = k / c; } // k : ? = c
    if (!Number.isInteger(x) || x < 1 || x > MAXV) return null;
    const a = unk === 'a' ? x : k, b = unk === 'a' ? k : x;
    const ok = op === 'add' ? a + b === c : op === 'sub' ? a - b === c : op === 'times' ? a * b === c : b > 0 && a % b === 0 && a / b === c;
    return ok ? { a, b, unk } : null;
  }

  function descFromKey(key) {
    if (typeof key !== 'string' || key.length > 60) return null;
    let m;
    if ((m = RE_ADD.exec(key))) { const a = +m[1], b = +m[2]; return a + b <= MAXV ? descAdd(a, b) : null; }
    if ((m = RE_SUB.exec(key))) { const a = +m[1], b = +m[2]; return a >= b ? descSub(a, b) : null; }
    if ((m = RE_TIMES.exec(key))) { const a = +m[1], b = +m[2]; return a * b <= MAXV ? descTimes(a, b) : null; }
    if ((m = RE_DIV.exec(key))) { const n = +m[1], d = +m[2]; return n % d === 0 ? descDiv(n, d) : null; }
    if ((m = RE_GAP.exec(key))) {
      if (m[3] !== OPKEY[m[1]]) return null;
      const c = +m[5], s = solveGap(m[1], m[2], m[4], c);
      if (!s || c < 1) return null;
      return descGap(m[1], s.a, s.b, c, s.unk);
    }
    if ((m = RE_STORY.exec(key))) return storyDescFromKey(m[1], m[2].split(':').map(Number));
    return null;
  }

  function fromKey(key) {
    try {
      const d = descFromKey(key);
      return d ? d.make() : null;
    } catch (e) {
      return null;
    }
  }

  // ----------------------------------------------------------------- stories
  // A story = template (id + shape + text with {0} {1} {2}) and 2-3 numbers.
  // The shape says how the numbers combine; its `r` lists number ranges per
  // tier (0 = within 20 ... 5/6 = thousands). To add a story: append one line
  // to STORIES; to add a shape: add an entry to SHAPES.

  const S = MINUS;
  const LEAD = { '+': 'Samen of erbij: dat is optellen.', '\u2212': 'Wat weggaat, haal je eraf.', '\u00d7': 'Steeds evenveel: dat is keer.', ':': 'Verdelen in groepjes is delen.' };

  // `tab` is the index of the number that a table restriction applies to
  const SHAPES = {
    '+': {
      n: 2, tab: -1, calc: (n) => n[0] + n[1], fx: (n) => n[0] + '+' + n[1],
      r: [[[3, 12], [2, 8]], [[10, 60], [5, 39]], [[30, 80], [20, 70]], [[100, 600], [20, 380]], [[200, 900], [100, 700]], [[1000, 6000], [500, 3500]]],
      hints: () => ['Samenvoegen of erbij: dat is optellen.', 'Denk aan optellen: hoeveel is het samen?'],
      meth: (n, k) => choose(addMethods(n[0], n[1]), k, 'add'),
      explain: (n, r, k) => wrap(LEAD['+'] + ' ' + SHAPES['+'].meth(n, k).how, 'Dus ' + n[0] + ' + ' + n[1] + ' = ' + r + '.')
    },
    '\u2212': {
      n: 2, tab: -1, calc: (n) => (n[0] > n[1] ? n[0] - n[1] : -1), fx: (n) => n[0] + '-' + n[1],
      r: [[[8, 20], [2, 9]], [[20, 100], [5, 60]], [[50, 150], [15, 90]], [[200, 1000], [30, 600]], [[500, 2000], [100, 1200]], [[2000, 9999], [300, 5000]]],
      hints: () => ['Wat weggaat of overblijft: dat is aftrekken.', 'Denk aan aftrekken: hoeveel blijft er over?'],
      meth: (n, k) => choose(subMethods(n[0], n[1]), k, 'sub'),
      explain: (n, r, k) => wrap(LEAD['\u2212'] + ' ' + SHAPES['\u2212'].meth(n, k).how, 'Dus ' + n[0] + ' ' + S + ' ' + n[1] + ' = ' + r + '.')
    },
    '\u00d7': {
      n: 2, tab: 1, calc: (n) => (n[0] * n[1] <= MAXV ? n[0] * n[1] : -1), fx: (n) => n[0] + '*' + n[1],
      r: [[[2, 6], [2, 5]], [[2, 10], [2, 10]], [[5, 15], [2, 10]], [[11, 30], [2, 9]], [[12, 60], [3, 9]], [[101, 400], [2, 9]], [[11, 40], [11, 25]]],
      hints: () => ['Steeds evenveel erbij: dat is keer.', 'Maak er een keersom van: aantal groepjes keer wat erin zit.'],
      meth: (n, k) => choose(timesMethods(n[0], n[1]), k, 'times'),
      explain: (n, r, k) => wrap(LEAD['\u00d7'] + ' ' + SHAPES['\u00d7'].meth(n, k).how, 'Dus ' + n[0] + ' ' + TIMES + ' ' + n[1] + ' = ' + r + '.')
    },
    ':': {
      n: 2, tab: 1, calc: (n) => (n[0] % n[1] === 0 ? n[0] / n[1] : -1), fx: (n) => n[0] + '/' + n[1],
      draw: (rng, rs, tab) => { const d = tab ? RR.Rng.pick(rng, tab) : rint(rng, rs[0][0], rs[0][1]); return [d * rint(rng, rs[1][0], rs[1][1]), d]; },
      r: [[[2, 5], [2, 5]], [[2, 10], [2, 10]], [[2, 10], [6, 20]], [[2, 9], [12, 40]], [[2, 9], [20, 120]], [[2, 9], [40, 300]]],
      hints: () => ['Eerlijk verdelen of groepjes maken: dat is delen.', 'Denk aan delen. Welk getal keer het ene getal is het andere?'],
      meth: (n, k) => choose(divMethods(n[0], n[1]), k, 'div'),
      explain: (n, r, k) => wrap(LEAD[':'] + ' ' + SHAPES[':'].meth(n, k).how, 'Dus ' + n[0] + ' : ' + n[1] + ' = ' + r + '.')
    },
    '\u00d7+': {
      n: 3, tab: -1, steps: 2,
      calc: (n) => { const x = n[0] * n[1], r = x + n[2]; return r <= MAXV ? r : -1; }, fx: (n) => n[0] + '*' + n[1] + '+' + n[2],
      r: [[[2, 5], [2, 5], [2, 9]], [[2, 9], [2, 9], [3, 30]], [[3, 9], [3, 12], [5, 60]], [[5, 12], [6, 25], [10, 150]], [[10, 40], [6, 25], [50, 400]]],
      hints: () => ['Los het in twee stappen op: eerst keer, dan erbij.', 'Reken eerst uit hoeveel er in de groepjes zitten. Daarna komt er nog wat bij.'],
      explain: (n, r) => 'Eerst de groepjes: ' + n[0] + ' ' + TIMES + ' ' + n[1] + ' = ' + n[0] * n[1] + '.\nDan erbij: ' + n[0] * n[1] + ' + ' + n[2] + ' = ' + r + '.'
    },
    '\u00d7\u2212': {
      n: 3, tab: -1, steps: 2,
      calc: (n) => (n[0] * n[1] > n[2] && n[0] * n[1] <= MAXV ? n[0] * n[1] - n[2] : -1), fx: (n) => n[0] + '*' + n[1] + '-' + n[2],
      r: [[[3, 6], [2, 6], [2, 9]], [[3, 9], [3, 9], [4, 25]], [[4, 12], [4, 12], [6, 60]], [[6, 15], [8, 25], [10, 200]], [[12, 40], [6, 25], [20, 400]]],
      hints: () => ['Los het in twee stappen op: eerst keer, dan eraf.', 'Reken eerst uit hoeveel er in totaal zijn. Daarna gaat er wat af.'],
      explain: (n, r) => 'Eerst: ' + n[0] + ' ' + TIMES + ' ' + n[1] + ' = ' + n[0] * n[1] + '.\nDaarna eraf: ' + n[0] * n[1] + ' ' + S + ' ' + n[2] + ' = ' + r + '.'
    },
    '+\u2212': {
      n: 3, tab: -1, steps: 2,
      calc: (n) => (n[0] + n[1] > n[2] ? n[0] + n[1] - n[2] : -1), fx: (n) => n[0] + '+' + n[1] + '-' + n[2],
      r: [[[8, 15], [2, 8], [2, 9]], [[20, 60], [5, 40], [5, 50]], [[30, 90], [10, 60], [8, 70]], [[100, 500], [50, 400], [20, 300]], [[500, 3000], [200, 2000], [100, 1500]]],
      hints: () => ['Los het in twee stappen op: eerst erbij, dan eraf.', 'Tel eerst op wat erbij komt. Haal daarna weg wat eraf gaat.'],
      explain: (n, r) => 'Eerst erbij: ' + n[0] + ' + ' + n[1] + ' = ' + (n[0] + n[1]) + '.\nDaarna eraf: ' + (n[0] + n[1]) + ' ' + S + ' ' + n[2] + ' = ' + r + '.'
    },
    '++': {
      n: 3, tab: -1, steps: 2,
      calc: (n) => { const r = n[0] + n[1] + n[2]; return r <= MAXV ? r : -1; }, fx: (n) => n[0] + '+' + n[1] + '+' + n[2],
      r: [[[2, 7], [2, 7], [2, 7]], [[10, 40], [5, 30], [5, 30]], [[20, 60], [15, 50], [10, 40]], [[100, 400], [50, 300], [20, 200]], [[500, 3000], [300, 2500], [100, 2000]]],
      hints: () => ['Los het in twee stappen op: tel eerst twee getallen op.', 'Tel de aantallen na elkaar op.'],
      explain: (n, r) => 'Eerst: ' + n[0] + ' + ' + n[1] + ' = ' + (n[0] + n[1]) + '.\nDan nog erbij: ' + (n[0] + n[1]) + ' + ' + n[2] + ' = ' + r + '.'
    },
    '\u2212\u2212': {
      n: 3, tab: -1, steps: 2,
      calc: (n) => (n[0] - n[1] - n[2] >= 1 ? n[0] - n[1] - n[2] : -1), fx: (n) => n[0] + '-' + n[1] + '-' + n[2],
      r: [[[12, 20], [2, 6], [2, 6]], [[50, 100], [5, 30], [5, 30]], [[100, 200], [10, 60], [10, 60]], [[300, 1000], [50, 300], [20, 300]], [[1000, 5000], [200, 2000], [100, 1500]]],
      hints: () => ['Los het in twee stappen op: haal eerst het eerste weg.', 'Haal de aantallen na elkaar weg.'],
      explain: (n, r) => 'Eerst: ' + n[0] + ' ' + S + ' ' + n[1] + ' = ' + (n[0] - n[1]) + '.\nDan nog eraf: ' + (n[0] - n[1]) + ' ' + S + ' ' + n[2] + ' = ' + r + '.'
    },
    ':+': {
      n: 3, tab: -1, steps: 2,
      calc: (n) => { if (n[0] % n[1]) return -1; const r = n[0] / n[1] + n[2]; return r <= MAXV ? r : -1; }, fx: (n) => n[0] + '/' + n[1] + '+' + n[2],
      draw: (rng, rs) => { const d = rint(rng, rs[0][0], rs[0][1]); return [d * rint(rng, rs[1][0], rs[1][1]), d, rint(rng, rs[2][0], rs[2][1])]; },
      r: [[[2, 5], [2, 5], [2, 9]], [[2, 10], [2, 10], [2, 20]], [[2, 9], [5, 20], [3, 30]], [[2, 9], [10, 60], [5, 90]], [[3, 9], [20, 150], [10, 200]]],
      hints: () => ['Los het in twee stappen op: eerst delen, dan erbij.', 'Verdeel eerst eerlijk. Daarna komt er voor ieder nog wat bij.'],
      explain: (n, r) => 'Eerst verdelen: ' + n[0] + ' : ' + n[1] + ' = ' + n[0] / n[1] + '.\nDan erbij: ' + n[0] / n[1] + ' + ' + n[2] + ' = ' + r + '.'
    },
    '\u00d7:': {
      n: 3, tab: -1, steps: 2,
      calc: (n) => { const x = n[0] * n[1]; return x <= MAXV && x % n[2] === 0 && n[2] !== n[0] && n[2] !== n[1] ? x / n[2] : -1; }, fx: (n) => '(' + n[0] + '*' + n[1] + ')/' + n[2],
      r: [[[2, 10], [2, 10], [2, 6]], [[3, 12], [3, 12], [2, 9]], [[5, 20], [5, 20], [2, 9]], [[10, 40], [5, 25], [2, 12]]],
      hints: () => ['Los het in twee stappen op: eerst keer, dan delen.', 'Reken eerst uit hoeveel er in totaal zijn. Verdeel ze daarna eerlijk.'],
      explain: (n, r) => 'Eerst samen: ' + n[0] + ' ' + TIMES + ' ' + n[1] + ' = ' + n[0] * n[1] + '.\nDan verdelen: ' + n[0] * n[1] + ' : ' + n[2] + ' = ' + r + '.'
    }
  };

  const STORIES = [
    { id: 'tulpen', sh: '+', t: 'Eef plukt {0} rode en {1} gele tulpen.\nHoeveel tulpen zijn dat samen?' },
    { id: 'schelpen', sh: '+', t: 'Sien vindt {0} schelpen op het strand. Bram vindt er {1}.\nHoeveel schelpen hebben ze samen?' },
    { id: 'fietsen', cap: 300, sh: '+', t: 'Voor de molen staan {0} fietsen. Er komen nog {1} fietsen bij.\nHoeveel fietsen staan er nu?' },
    { id: 'rondvaart', cap: 60, sh: '+', t: 'In de rondvaartboot zitten {0} kinderen. Bij de brug stappen er {1} in.\nHoeveel kinderen zitten er nu in de boot?' },
    { id: 'koeien', cap: 120, sh: '+', t: 'In de polder grazen {0} koeien. Er komen er nog {1} bij.\nHoeveel koeien grazen er nu in de polder?' },
    { id: 'bollen', sh: '+', t: 'In de schuur liggen {0} tulpenbollen. De kar brengt er nog {1} bij.\nHoeveel tulpenbollen liggen er nu in de schuur?' },
    { id: 'schelpweg', sh: '\u2212', t: 'Sien heeft {0} schelpen verzameld. Ze geeft er {1} aan Bram.\nHoeveel schelpen heeft Sien nu nog?' },
    { id: 'zakken', cap: 500, sh: '\u2212', t: 'De molenaar heeft {0} zakken meel. Hij verkoopt er {1}.\nHoeveel zakken meel heeft hij nog?' },
    { id: 'boten', cap: 200, sh: '\u2212', t: 'In de haven liggen {0} boten. Er varen er {1} weg.\nHoeveel boten liggen er nog in de haven?' },
    { id: 'bekers', cap: 500, sh: '\u2212', t: 'Op de ijsbaan staan {0} bekers warme chocolademelk klaar. Er worden {1} bekers uitgedeeld.\nHoeveel bekers staan er nog klaar?' },
    { id: 'appels', sh: '\u2212', t: 'In de boomgaard hangen {0} appels aan de bomen. De boerin plukt er {1}.\nHoeveel appels hangen er nog aan de bomen?' },
    { id: 'eieren', sh: '\u00d7', t: 'Op de boerderij staan {0} dozen. In elke doos zitten {1} eieren.\nHoeveel eieren zijn dat samen?' },
    { id: 'rijen', sh: '\u00d7', t: 'In het tulpenveld zijn {0} rijen. In elke rij staan {1} tulpen.\nHoeveel tulpen zijn dat samen?' },
    { id: 'mensen', cap: 40, sh: '\u00d7', t: 'Er varen {0} rondvaartboten over de gracht. Op elke boot zitten {1} mensen.\nHoeveel mensen zijn dat samen?' },
    { id: 'emmers', cap: 100, sh: '\u00d7', t: 'Bram vult {0} emmers met schelpen. In elke emmer zitten {1} schelpen.\nHoeveel schelpen zijn dat samen?' },
    { id: 'fietsrijen', cap: 30, sh: '\u00d7', t: 'Bij de school staan {0} rijen fietsen. In elke rij staan {1} fietsen.\nHoeveel fietsen zijn dat samen?' },
    { id: 'meel', sh: '\u00d7', t: 'De molenaar vult {0} zakken. In elke zak zit {1} kilo meel.\nHoeveel kilo meel is dat samen?' },
    { id: 'verdeel', sh: ':', t: 'Sien heeft {0} schelpen. Ze verdeelt ze eerlijk over {1} emmers.\nHoeveel schelpen komen er in elke emmer?' },
    { id: 'dozen', sh: ':', t: 'Op de boerderij zijn {0} eieren. In elke doos passen er {1}.\nHoeveel dozen heb je nodig?' },
    { id: 'tochtje', cap: 300, sh: ':', t: 'Er gaan {0} kinderen op rondvaart. In elke boot is plek voor {1} kinderen.\nHoeveel boten zijn er nodig?' },
    { id: 'plantrijen', sh: ':', t: 'De tulpenboer plant {0} tulpen in {1} gelijke rijen.\nHoeveel tulpen staan er in elke rij?' },
    { id: 'koekjes', cap: 500, sh: ':', t: 'Oeke verdeelt {0} koekjes eerlijk over {1} kinderen.\nHoeveel koekjes krijgt elk kind?' },
    { id: 'bakken', sh: '\u00d7+', t: 'Eef heeft {0} bakken met elk {1} tulpen. Ze vindt er nog {2} in de schuur.\nHoeveel tulpen heeft ze nu in totaal?' },
    { id: 'kratten', sh: '\u00d7\u2212', t: 'Op de markt liggen {0} kratten met elk {1} appels. Er worden {2} appels verkocht.\nHoeveel appels liggen er nog?' },
    { id: 'haven', cap: 400, sh: '+\u2212', t: 'In de haven liggen {0} boten. Er komen {1} boten bij en er varen {2} boten weg.\nHoeveel boten liggen er dan in de haven?' },
    { id: 'weekschelpen', sh: '++', t: 'Bram verzamelt {0} schelpen op maandag, {1} op dinsdag en {2} op woensdag.\nHoeveel schelpen zijn dat samen?' },
    { id: 'broodjes', cap: 2000, sh: '\u2212\u2212', t: "De bakker heeft {0} broodjes. 's Ochtends verkoopt hij er {1} en 's middags nog {2}.\nHoeveel broodjes heeft hij dan nog?" },
    { id: 'kisten', sh: '\u00d7:', t: 'De boerin vult {0} manden met elk {1} appels. Ze verdeelt alle appels eerlijk over {2} kisten.\nHoeveel appels komen er in elke kist?' },
    { id: 'knikkers', sh: ':+', t: 'Sien verdeelt {0} knikkers eerlijk over {1} vriendjes. Daarna krijgt elk vriendje er nog {2} bij.\nHoeveel knikkers heeft elk vriendje nu?' }
  ];

  const STORY_BY_ID = Object.create(null);
  STORIES.forEach((t) => { STORY_BY_ID[t.id] = t; });

  function descStory(tpl, n) {
    const sh = SHAPES[tpl.sh], r = sh.calc(n), key = 'story:' + tpl.id + ':' + n.join(':');
    let d = 2 + (sh.steps ? 1.5 : 0);
    n.forEach((v) => { d += 0.4 * Math.log2(1 + v); });
    return {
      key, kind: 'story', ans: r, d, tpl: tpl.id,
      make: () => {
        // one-step stories hint at the same method the explanation shows
        const base = sh.hints(), mine = base[hash(key + '|shape') % base.length];
        const m = sh.meth ? sh.meth(n, key) : null;
        const list = !m ? [mine] : hash(key + '|order') % 2 ? [mine, m.hint, m.alt, m.plain] : [m.hint, m.alt, mine, m.plain];
        return mk(key, 'story', tpl.t.replace(/\{(\d)\}/g, (x, i) => n[i]), r,
          firstSafe(list.concat(base), r, FB.story), sh.explain(n, r, key), sh.fx(n));
      }
    };
  }

  function storyDescFromKey(id, nums) {
    const tpl = STORY_BY_ID[id];
    if (!tpl) return null;
    const sh = SHAPES[tpl.sh];
    if (nums.length !== sh.n || nums.some((v) => !(v >= 2 && v <= MAXV))) return null;
    const r = sh.calc(nums);
    return r >= 1 && r <= MAXV ? descStory(tpl, nums) : null;
  }

  // Templates that can carry the numbers of a shape/tier (their `cap` is the
  // biggest number that still sounds believable), with the ranges clipped to it.
  const USABLE = {};
  function usableTemplates(shape, tier) {
    const ck = shape + '|' + tier;
    if (USABLE[ck]) return USABLE[ck];
    const sh = SHAPES[shape], rs0 = sh.r[Math.min(tier, sh.r.length - 1)], out = [];
    STORIES.forEach((tpl) => {
      if (tpl.sh !== shape) return;
      const cap = tpl.cap || MAXV;
      const rs = rs0.map((r) => (r[0] <= cap ? [r[0], Math.min(r[1], cap)] : null));
      if (rs.every(Boolean)) out.push({ tpl, rs });
    });
    // a tier no template can carry falls back to the unclipped ranges
    return (USABLE[ck] = out.length ? out : STORIES.filter((t) => t.sh === shape).map((tpl) => ({ tpl, rs: rs0 })));
  }

  // Draw numbers; `tab` (list of numbers >= 2) pins the table slot of the shape.
  function drawStory(rng, shape, rs, tab, cap) {
    for (let t = 0; t < 60; t++) {
      const n = shape.draw ? shape.draw(rng, rs, tab) : rs.map((r, i) => (tab && i === shape.tab ? RR.Rng.pick(rng, tab) : rint(rng, r[0], r[1])));
      const v = shape.calc(n);
      if (v >= 1 && v <= MAXV && n.every((x) => x <= cap)) return n;
    }
    return null;
  }

  // spec = { sh: [shapes], tier, tab? }; usedTpl discourages repeats inside a series
  function sampleStory(rng, spec, tab, usedTpl) {
    for (let t = 0; t < 12; t++) {
      const shape = RR.Rng.pick(rng, spec.sh);
      const e = RR.Rng.pick(rng, usableTemplates(shape, spec.tier));
      if (usedTpl && usedTpl.has(e.tpl.id) && t < 8) continue;
      const n = drawStory(rng, SHAPES[shape], e.rs, SHAPES[shape].tab >= 0 ? tab : null, e.tpl.cap || MAXV);
      if (n) return descStory(e.tpl, n);
    }
    return null;
  }

  // ---------------------------------------------------------------- profiles
  // The whole difficulty ramp lives in this section. Banks are named number
  // shapes; a profile row picks banks (with weights) per kind of sum.
  //
  //   A(a, b, opts)  add/sub shape: a and b are [lo, hi] ranges, multiplied by
  //                  opts.as / opts.bs (10 = tens, 100 = hundreds); opts.max caps
  //                  the sum, opts.br forces (true) or forbids (false) a carry
  //                  / borrow, opts.dbl makes a + a.
  //   T(t, m, opts)  tables: t = list of table numbers, m = [lo, hi] for the
  //                  other factor; opts.ts / opts.ms multiply (30 x 40).
  //   V(d, q, opts)  division: d = list of divisors, q = [lo, hi] quotient;
  //                  opts.min / opts.max bound the dividend.
  //   story banks    { sh: shapes, tier, tab? } (see SHAPES for the tiers).

  const A = (a, b, o) => Object.assign({ a, b }, o);
  const T = (t, m, o) => Object.assign({ t, m }, o);
  const V = (d, q, o) => Object.assign({ d, q }, o);

  const AD = {
    w4: A([1, 3], [1, 3]), w7: A([1, 5], [1, 5], { max: 7 }), w10: A([1, 9], [1, 9], { max: 10 }), w13: A([3, 9], [3, 9], { max: 13 }),
    dbl5: A([1, 5], null, { dbl: true }), dbl: A([2, 10], null, { dbl: true }),
    n20: A([2, 15], [1, 9], { max: 20, br: false }), b20: A([3, 18], [2, 9], { max: 20, br: true }), m20: A([2, 18], [2, 9], { max: 20 }),
    t10: A([1, 9], [1, 9], { as: 10, bs: 10, max: 100 }),
    tu_u: A([11, 90], [1, 9], { max: 100, br: false }), tu_ub: A([11, 95], [2, 9], { max: 100, br: true }),
    tu_t: A([11, 89], [1, 9], { bs: 10, max: 100 }),
    tu_tu: A([11, 80], [11, 80], { max: 100 }), tu_tub: A([11, 80], [11, 80], { max: 100, br: true }),
    tu_tubL: A([31, 89], [11, 69], { max: 100, br: true }),
    h_h: A([1, 9], [1, 9], { as: 100, bs: 100, max: 1000 }), h_x: A([101, 899], [1, 8], { bs: 100, max: 1000 }),
    h_t: A([101, 899], [1, 9], { bs: 10, max: 1000 }), h_tu: A([101, 900], [11, 99], { max: 1000 }),
    h_3: A([101, 800], [101, 600], { max: 1000 }), h_3b: A([101, 800], [101, 600], { max: 1000, br: true }),
    h_3x: A([101, 900], [101, 900], { max: 1800 }),
    r: A([10, 70], [10, 50], { as: 100, bs: 100 }), r1k: A([1, 6], [1, 3], { as: 1000, bs: 1000 }),
    k_h: A([1000, 8000], [100, 2000]), k_k: A([1000, 6000], [1000, 5000])
  };

  const SB = {
    w4: A([2, 5], [1, 3]), w7: A([3, 7], [1, 5]), w10: A([3, 10], [1, 9]), w13: A([8, 14], [2, 6]),
    n20: A([11, 20], [1, 9], { br: false }), b20: A([11, 19], [2, 9], { br: true }), m20: A([11, 20], [2, 9]),
    t10: A([2, 10], [1, 9], { as: 10, bs: 10 }),
    tu_u: A([21, 99], [1, 9], { br: false }), tu_ub: A([21, 99], [2, 9], { br: true }), tu_t: A([21, 99], [1, 9], { bs: 10 }),
    tu_tu: A([30, 99], [11, 80]), tu_tub: A([30, 99], [11, 80], { br: true }), tu_tubL: A([51, 99], [11, 80], { br: true }),
    h100: A([100, 100], [11, 99]),
    h_h: A([2, 10], [1, 9], { as: 100, bs: 100 }), h_x: A([201, 999], [1, 8], { bs: 100 }),
    h_t: A([201, 999], [1, 9], { bs: 10 }), h_tu: A([201, 999], [11, 99]),
    h_3: A([201, 999], [101, 800]), h_3b: A([201, 999], [101, 800], { br: true }), h_3x: A([401, 999], [101, 899]),
    r: A([20, 99], [10, 70], { as: 100, bs: 100 }), r1k: A([2, 9], [1, 3], { as: 1000, bs: 1000 }),
    k_h: A([1000, 9999], [100, 3000]), k_k: A([2000, 9999], [1000, 6000])
  };

  const TM = {
    e2: T([2], [1, 5]), e10: T([2, 10], [1, 5]), g3: T([2, 5, 10], [1, 10]), g1: T([1, 2, 2, 5, 5, 10, 10], [1, 10]),
    t34: T([3, 4], [1, 10]), t69: T([6, 9], [2, 10]), t78: T([7, 8], [2, 10]), tall: T(seq(2, 10), [2, 10]),
    tens: T(seq(2, 9), [1, 9], { ms: 10 }), tt: T(seq(2, 9), [2, 9], { ts: 10, ms: 10 }),
    d21: T(seq(2, 9), [11, 40]), d21b: T(seq(2, 9), [11, 99]), d2t: T(seq(2, 9), [11, 50], { ts: 10 }),
    d31: T(seq(2, 9), [101, 999]), d22: T(seq(11, 25), [11, 40]), d22b: T(seq(12, 49), [12, 99]), d22c: T(seq(21, 49), [21, 99])
  };

  const DV = {
    v2: V([2, 5, 10], [2, 5]), vg3: V([2, 5, 10], [2, 10]), v34: V([3, 4], [2, 10]), v69: V([6, 9], [2, 10]),
    v78: V([7, 8], [2, 10]), vall: V(seq(2, 10), [2, 10]),
    v21: V(seq(2, 9), [11, 49], { max: 99 }), v31: V(seq(2, 9), [12, 150], { min: 100, max: 999 })
  };

  const TWO = ['\u00d7+', '\u00d7\u2212', '+\u2212', '++', '\u2212\u2212'];
  const ST = {
    pm0: { sh: ['+', '\u2212'], tier: 0 }, pm1: { sh: ['+', '\u2212'], tier: 1 }, pm2: { sh: ['+', '\u2212'], tier: 2 },
    pm3: { sh: ['+', '\u2212'], tier: 3 }, pm4: { sh: ['+', '\u2212'], tier: 4 }, pm5: { sh: ['+', '\u2212'], tier: 5 },
    x0: { sh: ['\u00d7'], tier: 0, tab: [2, 5, 10] }, x6: { sh: ['\u00d7'], tier: 6 },
    xd1: { sh: ['\u00d7', ':'], tier: 1, tab: [2, 5, 10] }, xd1b: { sh: ['\u00d7', ':'], tier: 1, tab: [2, 3, 4, 5, 10] },
    xd2: { sh: ['\u00d7', ':'], tier: 2 }, xd3: { sh: ['\u00d7', ':'], tier: 3 }, xd4: { sh: ['\u00d7', ':'], tier: 4 }, xd5: { sh: ['\u00d7', ':'], tier: 5 },
    two0: { sh: TWO, tier: 0 }, two1: { sh: TWO, tier: 1 }, two2: { sh: TWO, tier: 2 }, two3: { sh: TWO, tier: 3 }, two4: { sh: TWO, tier: 4 },
    twod2: { sh: [':+', '\u00d7:'], tier: 2 }, twod3: { sh: [':+', '\u00d7:'], tier: 3 }
  };

  // 'name:weight name' -> [{ spec, w }]
  function bank(table, text) {
    return text.split(' ').map((tok) => {
      const p = tok.split(':'), spec = table[p[0]];
      if (!spec) throw new Error('unknown bank entry ' + tok);
      return { spec, w: p.length > 1 ? Number(p[1]) : 1 };
    });
  }
  // 'add:4 sub:3' -> { add: 4, sub: 3 }
  function weights(text) {
    const out = {};
    text.split(' ').forEach((tok) => { const p = tok.split(':'); out[p[0]] = Number(p[1]); });
    return out;
  }

  // mix = weights of the kinds in a 'mix' series; add/sub/times/div/story = banks
  // per kind (also used by single-kind focus); gap = which operations may hide
  // a number, gp = where ('b' = the second number only, 'any' = either one).
  function row(mix, add, sub, times, div, story, gap, gp) {
    return {
      mix: weights(mix), gw: weights(gap), gp,
      add: bank(AD, add), sub: bank(SB, sub), times: bank(TM, times), div: bank(DV, div), story: bank(ST, story)
    };
  }

  const GAP_AS = 'add:1 sub:1';
  const GAP_ASM = 'add:1 sub:1 times:1';
  const GAP_ALL = 'add:1 sub:1 times:1 div:1';

  const PROFILE = {
    // groep 3: counting up to 20, whole tens, then to 100; tables 2/5/10 near the end
    3: [null,
      row('add:5 sub:4', 'w4:2 w7:3 w10:3 w13:.4', 'w4:2 w7:3 w10:3 w13:.4', 'e2 e10 g3', 'v2 vg3', 'pm0', GAP_AS, 'b'),
      row('add:4 sub:4 gap:1', 'w7 w10:3 dbl5 dbl n20:2 w13:.5', 'w7 w10:3 n20:2 w13:.5', 'e2 e10 g3', 'v2 vg3', 'pm0', GAP_AS, 'b'),
      row('add:4 sub:4 gap:1.5', 'n20:2 b20:3 t10:2 dbl', 'w10 n20 b20:3 t10:2', 'e2 e10 g3', 'v2 vg3', 'pm0', GAP_AS, 'b'),
      row('add:4 sub:4 gap:1.5', 'b20:3 t10:2 dbl m20:2', 'b20:3 t10:2 m20:2', 'e10 g3', 'v2 vg3', 'pm0', GAP_AS, 'b'),
      row('add:4 sub:4 gap:1.5', 'tu_u:2 tu_t:2 t10 b20', 'tu_u:2 tu_t:2 t10 b20', 'e10 g3', 'v2 vg3', 'pm0', GAP_AS, 'b'),
      row('add:4 sub:4 times:1 gap:1.5', 'tu_u tu_t:2 tu_ub:2 t10', 'tu_u tu_t:2 tu_ub:2', 'e10:2 g3', 'vg3', 'pm0', GAP_AS, 'b'),
      row('add:4 sub:4 times:2 gap:1.5 story:1', 'tu_tubL:3 tu_ub:2 tu_t tu_tu', 'tu_tubL:3 tu_ub:2 tu_t', 'g3', 'vg3', 'pm1 pm0 x0', GAP_AS, 'b'),
      row('add:4 sub:4 times:3.5 gap:2 story:2.5', 'tu_tubL:3 tu_tu:2', 'tu_tubL:3 tu_tu:2', 'g3', 'vg3', 'pm1:2 x0', GAP_ASM, 'b')
    ],
    // groep 4: to 100 with bridging, all tables one by one, to 1000
    4: [null,
      row('add:3 sub:3 times:2 gap:1', 'tu_tu:2 tu_tub:2 tu_ub tu_t', 'tu_tu:2 tu_tub:2 tu_ub tu_t', 'g1', 'vg3', 'pm1', GAP_ASM, 'b'),
      row('add:3 sub:3 times:2 gap:1 story:1', 'tu_tu:2 tu_tubL:3 tu_ub', 'tu_tu:2 tu_tubL:2 h100:2 tu_ub', 'g3:2 g1', 'vg3', 'pm1:2 xd1', GAP_ASM, 'b'),
      row('add:2 sub:2 times:3 div:1.5 gap:1 story:.5', 'tu_tubL:2 h_h:3 tu_tu', 'tu_tubL:2 h_h:3 h100', 't34:3 g1', 'v34:3 vg3', 'pm1 xd1', GAP_ASM, 'any'),
      row('add:2 sub:2 times:3 div:2 gap:1.5 story:1', 'h_h:2 tu_tub:2 h_t', 'h_h:2 tu_tub:2 h_t', 't34:3 g3', 'v34:3 vg3', 'pm1 xd1b:1.5 pm2', GAP_ASM, 'any'),
      row('add:2 sub:2 times:3 div:1.5 gap:2 story:1', 'h_x:2 h_t h_tu:2 tu_tub', 'h_x:2 h_t h_tu:2 tu_tub', 't69:3 t34 g3', 'v69 v34 vg3', 'pm2:2 xd1b', GAP_ALL, 'any'),
      row('add:2 sub:2 times:3 div:1.5 gap:2 story:1', 'h_tu:2 h_x h_t h_3', 'h_tu:2 h_x h_t h_3', 't78:3 t69:1.5 t34:.5 g3:.5', 'v78:2 v69 v34:.5', 'pm2:2 xd2:1.5', GAP_ALL, 'any'),
      row('add:2 sub:2 times:3 div:2 gap:2 story:2', 'h_3b:3 h_tu h_3', 'h_3b:3 h_tu h_3', 'tall:3 tens:1.5', 'vall:3', 'pm3:2 xd2:2 two0', GAP_ALL, 'any'),
      row('add:2 sub:2 times:3 div:2 gap:2 story:2', 'h_3b:3 h_3:2 h_3x', 'h_3b:3 h_3:2 h_3x', 'tall:3 tens:2', 'vall:3', 'pm3:2 xd3:2 two1:1.5', GAP_ALL, 'any')
    ],
    // groep 5: big tables + division, 2-digit x 1-digit, round thousands, 2-step stories
    5: [null,
      row('add:2 sub:2 times:3 div:2 gap:2 story:1', 'h_3b:2 h_tu h_3', 'h_3b:2 h_tu h_3', 'tall:3 tens', 'vall:2', 'pm3:2 xd2:2', GAP_ALL, 'any'),
      row('add:2 sub:2 times:3 div:2 gap:2 story:1', 'h_3b:2 h_3:2 h_3x', 'h_3b:2 h_3:2 h_3x', 'tall:3 tens:2', 'vall:2', 'pm3:2 xd3:2 two1', GAP_ALL, 'any'),
      row('add:2 sub:2 times:3 div:1 gap:1.5 story:1.5', 'h_3:2 h_3b:2 h_3x', 'h_3:2 h_3b:2 h_3x', 'd21:3 tall', 'vall', 'pm3 xd3:2 two1', GAP_ALL, 'any'),
      row('add:2 sub:2 times:3 div:1 gap:1.5 story:1.5', 'h_3x:2 h_3b:2 h_3', 'h_3x:2 h_3b:2 h_3', 'd21b:3 tall tens', 'vall v21:.5', 'pm4 xd3:2 two2:1.5', GAP_ALL, 'any'),
      row('add:2 sub:2 times:2 div:2.5 gap:1.5 story:1.5', 'r:2 h_3x h_3b', 'r:2 h_3x h_3b', 'tt:2 tens d21 tall', 'v21:3 vall', 'pm4 xd4:2 two2:1.5', GAP_ALL, 'any'),
      row('add:2 sub:2 times:2 div:2.5 gap:1.5 story:1.5', 'r:2 r1k k_h', 'r:2 r1k k_h', 'tt:2 d21b:2 tens', 'v21:2 v31 vall:.5', 'pm4 xd4:2 two2:2 twod2', GAP_ALL, 'any'),
      row('add:1.5 sub:1.5 times:2.5 div:2.5 gap:2 story:2.5', 'k_h:2 r h_3x', 'k_h:2 r h_3x', 'd31:3 d21b tt', 'v31:3 v21', 'pm4 xd4 two3:3', GAP_ALL, 'any'),
      row('add:1.5 sub:1.5 times:2.5 div:2.5 gap:2 story:2.5', 'k_h:2 k_k r', 'k_h:2 k_k r', 'd31:3 d21b tt', 'v31:3 v21', 'two3:3 twod3 xd4', GAP_ALL, 'any')
    ],
    // groep 6: fluent tables, 3-digit x 1-digit, up to 9999, 2-digit x 2-digit
    6: [null,
      row('add:1.5 sub:1.5 times:3 div:2.5 gap:2 story:1.5', 'h_3x:2 r k_h', 'h_3x:2 r k_h', 'tall:2 d21b:2', 'vall:2 v21', 'pm4 xd4:2 two2:2', GAP_ALL, 'any'),
      row('add:1.5 sub:1.5 times:3 div:2.5 gap:2 story:1.5', 'h_3x:2 r k_h:1.5', 'h_3x:2 r k_h:1.5', 'd21b:3 tall', 'v21:2 vall v31', 'pm4 xd4:2 two3:2', GAP_ALL, 'any'),
      row('add:1.5 sub:1.5 times:3 div:2.5 gap:2 story:1.5', 'k_h:2 r h_3x', 'k_h:2 r h_3x', 'd31:2 d2t:2 d21b', 'v21:2 v31', 'pm5 xd5:2 two3:2', GAP_ALL, 'any'),
      row('add:1.5 sub:1.5 times:3 div:2.5 gap:2 story:1.5', 'k_h:2 k_k r', 'k_h:2 k_k r', 'd31:3 d2t:2', 'v31:2 v21', 'pm5 x6 two3:2', GAP_ALL, 'any'),
      row('add:2 sub:2 times:2.5 div:2 gap:2 story:2', 'k_h:2 r:2 h_3x k_k', 'k_h:2 r:2 h_3x k_k', 'd31:2 d2t d22', 'v31:2 v21', 'pm5:2 xd5 two4:2', GAP_ALL, 'any'),
      row('add:2 sub:2 times:2.5 div:2 gap:2.5 story:2', 'k_k:2 k_h:2 r:2', 'k_k:2 k_h:2 r:2', 'd31:2 d22:1.5 d2t', 'v31:2 v21', 'pm5:2 two4:3', GAP_ALL, 'any'),
      row('add:2 sub:2 times:3.5 div:2 gap:2.5 story:3', 'k_k:3 k_h', 'k_k:3 k_h', 'd22b:3 d31', 'v31:3', 'two4:3 twod3 pm5 x6', GAP_ALL, 'any'),
      row('add:2 sub:2 times:4 div:2 gap:2.5 story:3', 'k_k:4 k_h', 'k_k:4 k_h', 'd22c:4 d22b d31', 'v31:3', 'two4:3 twod3:2 pm5 x6', GAP_ALL, 'any')
    ]
  };

  // ---------------------------------------------------------------- samplers

  function wpick(rng, list) {
    let total = 0;
    for (let i = 0; i < list.length; i++) total += list[i].w;
    let x = rng() * total;
    for (let i = 0; i < list.length; i++) {
      x -= list[i].w;
      if (x < 0) return list[i];
    }
    return list[list.length - 1];
  }

  function sampAdd(rng, sp) {
    const as = sp.as || 1, bs = sp.bs || 1, max = sp.max || MAXV;
    for (let t = 0; t < 80; t++) {
      const a = rint(rng, sp.a[0], sp.a[1]) * as;
      const b = sp.dbl ? a : rint(rng, sp.b[0], sp.b[1]) * bs;
      if (a + b > max) continue;
      if (sp.br !== undefined && carryAdd(a, b) !== sp.br) continue;
      return [a, b];
    }
    const a0 = sp.a[0] * as;
    return [a0, sp.dbl ? a0 : sp.b[0] * bs];
  }

  function sampSub(rng, sp) {
    const as = sp.as || 1, bs = sp.bs || 1;
    for (let t = 0; t < 80; t++) {
      const a = rint(rng, sp.a[0], sp.a[1]) * as, b = rint(rng, sp.b[0], sp.b[1]) * bs;
      if (b >= a) continue;
      if (sp.br !== undefined && borrowSub(a, b) !== sp.br) continue;
      return [a, b];
    }
    return [sp.a[1] * as, sp.b[0] * bs];
  }

  // both factors <= 10: either order; otherwise the bigger factor first (23 x 4)
  function orderFactors(rng, x, y) {
    if (x <= 10 && y <= 10) return rng() < 0.5 ? [x, y] : [y, x];
    return x >= y ? [x, y] : [y, x];
  }

  function sampTimes(rng, sp, table) {
    if (table) return orderFactors(rng, table, rint(rng, 1, 10));
    const ts = sp.ts || 1, ms = sp.ms || 1;
    for (let t = 0; t < 80; t++) {
      const x = RR.Rng.pick(rng, sp.t) * ts, y = rint(rng, sp.m[0], sp.m[1]) * ms;
      if (x * y <= MAXV) return orderFactors(rng, x, y);
    }
    return [sp.t[0] * ts, sp.m[0] * ms];
  }

  function sampDiv(rng, sp, table) {
    if (table) { const q = rint(rng, 1, 10); return [table * q, table]; }
    for (let t = 0; t < 80; t++) {
      const d = RR.Rng.pick(rng, sp.d), n = d * rint(rng, sp.q[0], sp.q[1]);
      if (n <= (sp.max || MAXV) && n >= (sp.min || 0)) return [n, d];
    }
    return [sp.d[0] * sp.q[0], sp.d[0]];
  }

  // ---------------------------------------------------------------- the plan
  // What a series is made of for one opts object: kind weights, which
  // operations may hide a number, and the table restriction.

  function clampInt(v, lo, hi, dflt) {
    v = Math.round(Number(v));
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
  }
  function entries(obj, field) {
    return Object.keys(obj).filter((k) => obj[k] > 0).map((k) => { const e = { w: obj[k] }; e[field] = k; return e; });
  }

  function makePlan(opts) {
    opts = opts || {};
    const grade = clampInt(opts.grade, 3, 6, 3), level = clampInt(opts.level, 1, 8, 1);
    const focus = FOCI.indexOf(opts.focus) >= 0 ? opts.focus : 'mix';
    const t = Number(opts.table);
    const table = Number.isInteger(t) && t >= 1 && t <= 10 ? t : 0;
    const rw = PROFILE[grade][level];
    const plan = { grade, level, focus, row: rw, pos: rw.gp, table: 0, gapOps: entries(rw.gw, 'op') };
    const one = (name) => [{ name, w: 1 }];
    if (focus === 'mix' && table) {
      plan.table = table;
      plan.groups = [{ name: 'times', w: 3 }, { name: 'div', w: 2 }, { name: 'gap', w: 1.5 }];
      plan.gapOps = [{ op: 'times', w: 1 }, { op: 'div', w: 1 }];
      plan.pos = 'any';
    } else if (focus === 'mix') {
      plan.groups = entries(rw.mix, 'name');
    } else if (focus === 'times' || focus === 'div') {
      plan.table = table;
      plan.groups = [{ name: focus, w: 2 }, { name: 'gap', w: 1 }];
      plan.gapOps = [{ op: focus, w: 1 }];
      plan.pos = 'any';
    } else if (focus === 'story') {
      plan.table = table >= 2 ? table : 0;
      plan.groups = one('story');
    } else {
      plan.groups = one(focus);
    }
    return plan;
  }

  function drawGap(plan, rng) {
    const rw = plan.row, op = wpick(rng, plan.gapOps).op;
    let a, b, c, ab;
    if (op === 'add') { ab = sampAdd(rng, wpick(rng, rw.add).spec); a = ab[0]; b = ab[1]; c = a + b; }
    else if (op === 'sub') { ab = sampSub(rng, wpick(rng, rw.sub).spec); a = ab[0]; b = ab[1]; c = a - b; }
    else if (op === 'times') { ab = sampTimes(rng, wpick(rng, rw.times).spec, plan.table); a = ab[0]; b = ab[1]; c = a * b; }
    else { ab = sampDiv(rng, wpick(rng, rw.div).spec, plan.table); a = ab[0]; b = ab[1]; c = a / b; }
    const unk = plan.pos === 'b' || rng() < 0.5 ? 'b' : 'a';
    return descGap(op, a, b, c, unk);
  }

  function drawDesc(plan, name, rng, usedTpl) {
    const rw = plan.row;
    let ab;
    switch (name) {
      case 'add': ab = sampAdd(rng, wpick(rng, rw.add).spec); return descAdd(ab[0], ab[1]);
      case 'sub': ab = sampSub(rng, wpick(rng, rw.sub).spec); return descSub(ab[0], ab[1]);
      case 'times': ab = sampTimes(rng, wpick(rng, rw.times).spec, plan.table); return descTimes(ab[0], ab[1]);
      case 'div': ab = sampDiv(rng, wpick(rng, rw.div).spec, plan.table); return descDiv(ab[0], ab[1]);
      case 'gap': return drawGap(plan, rng);
      default: {
        let spec = wpick(rng, rw.story).spec, tab = spec.tab;
        if (plan.table) { spec = { sh: ['\u00d7', ':'], tier: spec.tier }; tab = [plan.table]; }
        return sampleStory(rng, spec, tab, usedTpl) || descStory(STORIES[0], [5, 3]);
      }
    }
  }

  // ---------------------------------------------------------- make / series

  function make(opts, rng) {
    rng = rng || RR.Rng.random();
    const plan = makePlan(opts);
    return drawDesc(plan, wpick(rng, plan.groups).name, rng, null).make();
  }

  // 'gap:times', 'add', ... : the family a key belongs to
  function familyOf(key) {
    const p = key.split(':');
    return p[0] === 'gap' ? 'gap:' + p[1] : p[0];
  }

  // A repeat key only joins when it fits the chosen focus (and table).
  function repeatAllowed(desc, plan) {
    const fam = familyOf(desc.key);
    const allowed = {
      add: ['add'], sub: ['sub'], times: ['times', 'gap:times'], div: ['div', 'gap:div'], story: ['story'],
      mix: plan.table ? ['times', 'div', 'gap:times', 'gap:div'] : null
    }[plan.focus];
    if (allowed && allowed.indexOf(fam) < 0) return false;
    if (plan.table && plan.focus !== 'add' && plan.focus !== 'sub') {
      const nums = (desc.key.match(/\d+/g) || []).map(Number);
      return nums.indexOf(plan.table) >= 0 || desc.ans === plan.table;
    }
    return true;
  }

  function pickRepeats(list, plan) {
    const reps = [], keys = new Set(), answers = new Set();
    if (!Array.isArray(list)) return reps;
    for (let i = 0; i < list.length && reps.length < 2; i++) {
      let d = null;
      try { d = descFromKey(list[i]); } catch (e) { d = null; }
      if (!d || keys.has(d.key) || answers.has(d.ans) || !repeatAllowed(d, plan)) continue;
      keys.add(d.key);
      answers.add(d.ans);
      reps.push(d);
    }
    return reps;
  }

  // Gather a few candidates for one slot (strict first: fresh key, fresh answer,
  // fresh story template), then pick by the slot's difficulty quantile.
  function pickCandidate(plan, name, quantile, easiest, rng, used, modes) {
    const want = easiest ? 9 : 6;
    const pool = [];
    const fits = (d, mode) => {
      if (mode <= 2 && used.key.has(d.key)) return false;
      if (mode <= 1 && used.ans.has(d.ans)) return false;
      if (mode === 0 && d.tpl && used.tpl.has(d.tpl)) return false;
      return !pool.some((p) => p.key === d.key || (mode <= 1 && p.ans === d.ans));
    };
    for (let m = 0; m < modes.length && !pool.length; m++) {
      const mode = modes[m], tries = mode === 0 ? want * 4 : mode === 1 ? 600 : 100;
      for (let t = 0; t < tries && pool.length < want; t++) {
        const d = drawDesc(plan, name, rng, used.tpl);
        if (d && fits(d, mode)) pool.push(d);
      }
    }
    if (!pool.length) return null;
    pool.sort((x, y) => x.d - y.d);
    return pool[easiest ? 0 : Math.round(quantile * (pool.length - 1))];
  }

  const STRICT = [0, 1];
  const RELAXED = [2, 3];

  function series(opts, count, rng) {
    rng = rng || RR.Rng.random();
    let n = count === undefined ? 10 : Math.floor(Number(count));
    if (!(n > 0)) return [];
    if (n > 200) n = 200;
    const plan = makePlan(opts);
    const reps = pickRepeats(opts && opts.repeat, plan);

    // repeats go to early, easy-ish places: never first, never last
    const slots = seq(1, Math.min(n - 2, 4));
    const fixed = {};
    RR.Rng.shuffle(rng, slots).slice(0, reps.length).sort((x, y) => x - y).forEach((p, i) => { fixed[p] = reps[i]; });

    const used = { key: new Set(), ans: new Set(), tpl: new Set() };
    Object.keys(fixed).forEach((p) => { used.key.add(fixed[p].key); used.ans.add(fixed[p].ans); });

    const out = [];
    let k1 = '', k2 = '';
    for (let i = 0; i < n; i++) {
      let desc = fixed[i];
      if (!desc) {
        // no three identical kinds in a row when another kind is available
        let groups = plan.groups;
        // a calm start: no gap sum first, no story in the first two places
        const calm = groups.filter((g) => (i === 0 ? g.name !== 'gap' && g.name !== 'story' : i === 1 ? g.name !== 'story' : true));
        if (calm.length) groups = calm;
        if (k1 && k1 === k2) {
          const mixed = groups.filter((g) => g.name !== k1);
          if (mixed.length) groups = mixed;
        }
        const quantile = n > 2 ? 0.12 + 0.76 * ((i - 1) / (n - 2)) : 0.12;
        const name = wpick(rng, groups).name;
        // strict first (fresh key + answer, also from the other kinds of this plan); only a
        // space too small for ten different answers falls back to repeating one
        const order = [name].concat(groups.map((g) => g.name).filter((x) => x !== name),
          plan.groups.map((g) => g.name).filter((x) => groups.every((g) => g.name !== x)));
        for (let g = 0; !desc && g < order.length; g++) desc = pickCandidate(plan, order[g], quantile, i === 0, rng, used, STRICT);
        if (!desc) desc = pickCandidate(plan, name, quantile, i === 0, rng, used, RELAXED);
        used.key.add(desc.key);
        used.ans.add(desc.ans);
        if (desc.tpl) used.tpl.add(desc.tpl);
      }
      out.push(desc.make());
      k2 = k1;
      k1 = desc.kind;
    }
    return out;
  }

  // ------------------------------------------------------------------ check

  function check(question, input) {
    if (!question || !Number.isInteger(question.answer)) return false;
    let s;
    if (typeof input === 'number') {
      if (!Number.isInteger(input) || input < 0) return false;
      s = String(input);
    } else if (typeof input === 'string') {
      s = input.trim();
    } else {
      return false;
    }
    return /^[0-9]+$/.test(s) && Number(s) === question.answer;
  }

  return { KINDS: Object.freeze(KINDS), FOCI: Object.freeze(FOCI), make, series, fromKey, check };
})();
