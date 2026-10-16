// Heroes, tracks and the race state machine for Rekenrace.
// DOM-free and deterministic per seed. Only RR.Rng supplies randomness.

// The four heroes. The ORDER matters: it is also the (hidden) pace order of the
// rivals, slowest to fastest, so a hero keeps the same relative pace whoever the
// child picks. The taglines are about character, never about speed.
RR.Heroes = (function () {
  'use strict';

  const list = [
    {
      id: 'egel',
      name: 'Eef de Egel',
      animal: 'egel',
      tagline: 'Eef de Egel telt onderweg appels en krult zich bij een bocht soms een beetje op.'
    },
    {
      id: 'eekhoorn',
      name: 'Sien de Eekhoorn',
      animal: 'eekhoorn',
      tagline: 'Sien de Eekhoorn verstopt overal eikels en weet de weg naar de finish gelukkig wel te vinden.'
    },
    {
      id: 'pad',
      name: 'Bram de Pad',
      animal: 'pad',
      tagline: 'Bram de Pad woont naast de sloot en rijdt het liefst dwars door de plassen.'
    },
    {
      id: 'uil',
      name: 'Oeke de Uil',
      animal: 'uil',
      tagline: 'Oeke de Uil blijft graag lang op en kijkt voor elke bocht eerst rustig om zich heen.'
    }
  ];

  return Object.freeze(list.map(function (h) { return Object.freeze(h); }));
})();

// The eight tracks of the championship, fixed order. `length` is both the finish
// line (in track units) and the number of sums in one race.
RR.Tracks = (function () {
  'use strict';

  const list = [
    {
      id: 1, theme: 'tulips', name: 'Tulpenveld', length: 10,
      blurb: 'Je rijdt langs lange rijen tulpen in rode, gele en roze strepen, met een boerderij in de verte.'
    },
    {
      id: 2, theme: 'windmill', name: 'Molenpolder', length: 10,
      blurb: 'Langs de dijk draaien de molens langzaam hun wieken en de koeien kijken rustig toe.'
    },
    {
      id: 3, theme: 'beach', name: 'Strand en duinen', length: 10,
      blurb: 'Je rijdt over de duinen en langs het strand, met strandhuisjes, kleine golfjes en meeuwen.'
    },
    {
      id: 4, theme: 'forest', name: 'Dennenbos', length: 10,
      blurb: 'Tussen de hoge dennen staan paddenstoelen en varens, en het zonlicht danst in vlekjes over de weg.'
    },
    {
      id: 5, theme: 'canal', name: 'Grachtenstad', length: 10,
      blurb: 'Je rijdt door een stad met smalle grachtenhuizen, een bruggetje en veel geparkeerde fietsen.'
    },
    {
      id: 6, theme: 'harbour', name: 'Haven', length: 10,
      blurb: 'Langs de haven staan hoge kranen, grote schepen, stapels containers en een vuurtoren.'
    },
    {
      id: 7, theme: 'ice', name: 'IJsbaan', length: 10,
      blurb: 'Je rijdt over het ijs van de gracht, langs een kraam met koek en zopie en besneeuwde bomen.'
    },
    {
      id: 8, theme: 'hills', name: 'Heuvelland', length: 10,
      blurb: 'Je rijdt over zachte, groene heuvels, langs wijngaarden en een kasteel bovenop de heuvel.'
    }
  ];

  return Object.freeze(list.map(function (t) { return Object.freeze(t); }));
})();

// Pure race state machine. One race = one kid vs the 3 other heroes over
// `track.length` sums. Turn-based: nothing moves unless advance() is called.
//
// Rules (calibrated by simulation, see tests/rekenrace-race.test.mjs):
//  - Player gain per sum: first 1.0, second 0.8, miss 0.5 track units.
//  - Rivals gain tempo +/- jitter per sum, whatever the player did. Rival tempos
//    (slow / middle / fast rival) rise linearly with the track id:
//        track 1: 0.70 / 0.80 / 0.90      track 8: 0.76 / 0.86 / 0.94
//    Jitter is uniform with amplitude min(0.12, 0.98 - tempo); the 0.98 ceiling
//    means a rival gains < 1.0 per sum, so a perfect player (1.0 per sum) is
//    strictly ahead of every rival after every single sum, however the dice fall.
//  - The rivals' whole race (lane order and every gain) is drawn from one seeded rng
//    at create() time, so it is fixed per seed and independent of the player's answers.
//  - Measured over 5000 seeds per track: a typical kid (80% first / 10% second /
//    10% miss) wins 74% of the races on track 1 falling to 46% on track 8, is in the
//    top 2 in 98% falling to 89%, and is last in < 0.5%. A struggling kid (50/20/30)
//    is last in 7% (track 1) up to 24% (track 8). A perfect kid wins 100%. Nobody is
//    ever blocked: a race always ends after the last sum.
//  - Ties: the player ranks ahead, then rivals by lane.
//
// Positions are tracked as integer thousandths of a unit so ties are exact (no
// floating point drift); the public API converts back to plain numbers.
// Only a perfect player reaches the finish line (length) exactly; everyone else
// stops short of it. rollout() gives positions for a calm "drive on over the line".
RR.Race = (function () {
  'use strict';

  const Rng = RR.Rng;

  const OUTCOMES = Object.freeze(['first', 'second', 'miss']);
  const PLAYER_GAIN = Object.freeze({ first: 1, second: 0.8, miss: 0.5 });
  const RIVAL_MAX_GAIN = 0.98;   // hard ceiling per sum, strictly below the perfect 1.0
  const RIVAL_JITTER = 0.12;     // maximum +/- wobble around a rival's tempo
  const TEMPO_TRACK_1 = [0.70, 0.80, 0.90];  // slow, middle, fast rival
  const TEMPO_TRACK_8 = [0.76, 0.86, 0.94];
  const ROLLOUT_MARGIN = 0.5;    // the last kart ends this far past the line

  const UNIT = 1000;
  const STATE_VERSION = 1;
  const PLAYER_UNITS = {
    first: Math.round(PLAYER_GAIN.first * UNIT),
    second: Math.round(PLAYER_GAIN.second * UNIT),
    miss: Math.round(PLAYER_GAIN.miss * UNIT)
  };
  const MAX_RIVAL_UNITS = Math.round(RIVAL_MAX_GAIN * UNIT);

  function describe(v) {
    try {
      return typeof v === 'string' ? '"' + v + '"' : String(v);
    } catch (e) {
      return typeof v;
    }
  }

  function resolveTrack(t) {
    const id = t !== null && typeof t === 'object' ? t.id : t;
    const found = typeof id === 'number' ? RR.Tracks.find(function (x) { return x.id === id; }) : undefined;
    if (!found) {
      throw new TypeError('Race.create: unknown track ' + describe(id) + ' (use a Tracks entry or an id 1..' + RR.Tracks.length + ')');
    }
    return found;
  }

  function resolveHero(h) {
    const id = h !== null && typeof h === 'object' ? h.id : h;
    const found = typeof id === 'string' ? RR.Heroes.find(function (x) { return x.id === id; }) : undefined;
    if (!found) {
      const ids = RR.Heroes.map(function (x) { return x.id; }).join(', ');
      throw new TypeError('Race.create: unknown hero ' + describe(id) + ' (use one of: ' + ids + ')');
    }
    return found;
  }

  function resolveSeed(seed) {
    if (typeof seed !== 'number' || !isFinite(seed)) {
      throw new TypeError('Race.create: seed must be a finite number, got ' + describe(seed));
    }
    return seed >>> 0;
  }

  function need(state, fn) {
    if (!state || typeof state !== 'object' || state.v !== STATE_VERSION || !Array.isArray(state.lanes) || !state.units) {
      throw new TypeError('Race.' + fn + ': expected a state made by Race.create');
    }
  }

  function heroName(id) {
    return RR.Heroes.find(function (h) { return h.id === id; }).name;
  }

  // Tempo of the slow / middle / fast rival on a track, rounded to thousandths.
  function rivalTempos(trackId) {
    const track = resolveTrack(trackId);
    const f = (track.id - 1) / (RR.Tracks.length - 1);
    return TEMPO_TRACK_1.map(function (a, i) {
      return Math.round((a + (TEMPO_TRACK_8[i] - a) * f) * UNIT) / UNIT;
    });
  }

  function create(opts) {
    if (opts === null || typeof opts !== 'object') {
      throw new TypeError('Race.create: expected { track, hero, seed }');
    }
    const track = resolveTrack(opts.track);
    const hero = resolveHero(opts.hero);
    const seed = resolveSeed(opts.seed);
    const rng = Rng.make(seed);
    const sums = track.length;

    // Rivals in pace order (Heroes order without the player) get the slow /
    // middle / fast tempo; the seed then shuffles which lane each one drives in.
    const tempos = rivalTempos(track.id);
    const rivals = RR.Heroes.filter(function (h) { return h.id !== hero.id; })
      .map(function (h, i) { return { id: h.id, tempo: tempos[i] }; });
    const order = Rng.shuffle(rng, rivals);

    const units = {};
    const plan = {};
    units[hero.id] = 0;
    order.forEach(function (r) {
      const amp = Math.max(0, Math.min(RIVAL_JITTER, RIVAL_MAX_GAIN - r.tempo));
      const gains = [];
      for (let s = 0; s < sums; s++) {
        const g = Math.round((r.tempo + (rng() * 2 - 1) * amp) * UNIT);
        gains.push(Math.max(0, Math.min(MAX_RIVAL_UNITS, g)));
      }
      units[r.id] = 0;
      plan[r.id] = gains;
    });

    return {
      v: STATE_VERSION,
      track: track,
      hero: hero,
      seed: seed,
      sums: sums,
      lanes: [hero.id].concat(order.map(function (r) { return r.id; })),
      outcomes: [],
      units: units,
      plan: plan,
      done: false
    };
  }

  function advance(state, outcome) {
    need(state, 'advance');
    if (state.done) throw new Error('race_done');
    if (typeof outcome !== 'string' || OUTCOMES.indexOf(outcome) < 0) {
      throw new TypeError('Race.advance: outcome must be one of ' + OUTCOMES.join(', ') + ', got ' + describe(outcome));
    }

    const step = state.outcomes.length;
    const cap = state.track.length * UNIT;
    const gains = {};
    state.lanes.forEach(function (id, lane) {
      const g = lane === 0 ? PLAYER_UNITS[outcome] : state.plan[id][step];
      state.units[id] = Math.min(cap, state.units[id] + g);
      gains[id] = g / UNIT;
    });
    state.outcomes.push(outcome);
    state.done = state.outcomes.length >= state.sums;
    return { gains: gains, done: state.done };
  }

  function positions(state) {
    need(state, 'positions');
    const out = {};
    state.lanes.forEach(function (id) { out[id] = state.units[id] / UNIT; });
    return out;
  }

  // Best first. Equal positions: the player first, then rivals by lane.
  function standings(state) {
    need(state, 'standings');
    const rows = state.lanes.map(function (id, lane) { return { id: id, lane: lane, u: state.units[id] }; });
    rows.sort(function (a, b) { return (b.u - a.u) || (a.lane - b.lane); });
    return rows.map(function (r, i) {
      return { id: r.id, name: heroName(r.id), pos: r.u / UNIT, place: i + 1, isPlayer: r.lane === 0 };
    });
  }

  // `place` is the player's CURRENT place (1..4) while the race runs and the final
  // place once `done` is true. It is never null.
  function summary(state) {
    need(state, 'summary');
    const count = { first: 0, second: 0, miss: 0 };
    state.outcomes.forEach(function (o) { count[o]++; });
    const me = standings(state).find(function (r) { return r.isPlayer; });
    return {
      place: me.place,
      first: count.first,
      second: count.second,
      miss: count.miss,
      total: state.outcomes.length,
      done: state.done
    };
  }

  function racers(state) {
    need(state, 'racers');
    return state.lanes.map(function (id, lane) {
      return { id: id, name: heroName(id), isPlayer: lane === 0, lane: lane };
    });
  }

  // Positions for the calm drive on after the last sum, so that every kart
  // crosses the line: all karts are carried the same extra distance (gaps and
  // order stay exactly as they were) until the last one is ROLLOUT_MARGIN past it.
  function rollout(state) {
    need(state, 'rollout');
    if (!state.done) throw new Error('race_not_done');
    const cap = state.track.length * UNIT;
    const last = Math.min.apply(null, state.lanes.map(function (id) { return state.units[id]; }));
    const shift = Math.max(0, cap - last) + Math.round(ROLLOUT_MARGIN * UNIT);
    const out = {};
    state.lanes.forEach(function (id) { out[id] = (state.units[id] + shift) / UNIT; });
    return out;
  }

  return {
    create, advance, positions, standings, summary, racers, rollout, rivalTempos,
    OUTCOMES, PLAYER_GAIN, RIVAL_MAX_GAIN, RIVAL_JITTER
  };
})();
