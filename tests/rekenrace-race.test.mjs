// Tests for RR.Heroes, RR.Tracks and RR.Race (the pure race state machine).
// During development: RR_PARTS_DIR=<scratchpad>/parts node --test tests/rekenrace-race.test.mjs
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { laadRR } from "./helpers/rekenrace-laden.mjs";

const RR = laadRR();
const { Race, Heroes, Tracks } = RR;

const HERO_IDS = ["egel", "eekhoorn", "pad", "uil"];
// Written out by hand (not read from the module) so the tests do not just echo it.
const PLAYER_GAIN = { first: 1, second: 0.8, miss: 0.5 };
const OUTCOMES = ["first", "second", "miss"];
const MAX_U = (2 ** 32 - 1) / 2 ** 32; // largest value any rng() can return

// Spread-out seeds, like the ones real play draws from Rng.random().
const seedFor = (i) => Math.imul(i + 1, 2654435761) >>> 0;

// A kid answers first/second/miss with these probabilities (rest = miss).
const KIDS = {
  perfect: [1, 0],
  good: [0.9, 0.05],
  typical: [0.8, 0.1],
  okay: [0.65, 0.15],
  struggling: [0.5, 0.2],
  weak: [0.3, 0.2],
};

function answer(rng, [pFirst, pSecond]) {
  const u = rng();
  return u < pFirst ? "first" : u < pFirst + pSecond ? "second" : "miss";
}

// Plays a whole race for a kid of the given skill; returns the finished state.
function playRace(rr, track, hero, seed, skill) {
  const state = rr.Race.create({ track, hero, seed });
  const rng = rr.Rng.make((seed ^ 0x9e3779b9) >>> 0);
  while (!state.done) rr.Race.advance(state, answer(rng, skill));
  return state;
}

// A copy of RR whose rng always returns `u`: u = 0.5 gives every rival exactly its
// tempo; u = 0 / MAX_U give the most extreme jitter possible.
function rrWithFixedRng(u) {
  const rr = laadRR();
  rr.Rng.make = () => () => u;
  return rr;
}

function placeCounts(rr, track, skill, n) {
  const counts = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const state = playRace(rr, track, HERO_IDS[i % 4], seedFor(i), skill);
    counts[rr.Race.summary(state).place - 1]++;
  }
  return counts;
}

describe("RR.Heroes", () => {
  test("the four heroes, in order, with the agreed names", () => {
    assert.deepEqual(Heroes.map((h) => h.id), HERO_IDS);
    assert.deepEqual(Heroes.map((h) => h.name), ["Eef de Egel", "Sien de Eekhoorn", "Bram de Pad", "Oeke de Uil"]);
    assert.deepEqual(Heroes.map((h) => h.animal), ["egel", "eekhoorn", "pad", "uil"]);
    for (const h of Heroes) {
      assert.deepEqual(Object.keys(h).sort(), ["animal", "id", "name", "tagline"]);
      assert.equal(typeof h.tagline, "string");
    }
  });

  test("heroes are deeply frozen", () => {
    assert.ok(Object.isFrozen(Heroes));
    for (const h of Heroes) assert.ok(Object.isFrozen(h));
    assert.throws(() => { Heroes[0].name = "Anders"; }, TypeError);
    assert.throws(() => { Heroes.push({}); }, TypeError);
    assert.throws(() => { Heroes[0] = null; }, TypeError);
  });
});

describe("RR.Tracks", () => {
  test("eight tracks in a fixed order with the agreed names and themes", () => {
    assert.equal(Tracks.length, 8);
    assert.deepEqual(Tracks.map((t) => t.id), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(Tracks.map((t) => t.theme), ["tulips", "windmill", "beach", "forest", "canal", "harbour", "ice", "hills"]);
    assert.deepEqual(Tracks.map((t) => t.name), [
      "Tulpenveld", "Molenpolder", "Strand en duinen", "Dennenbos",
      "Grachtenstad", "Haven", "IJsbaan", "Heuvelland",
    ]);
    for (const t of Tracks) {
      assert.deepEqual(Object.keys(t).sort(), ["blurb", "id", "length", "name", "theme"]);
      assert.equal(t.length, 10);
    }
  });

  test("tracks are deeply frozen", () => {
    assert.ok(Object.isFrozen(Tracks));
    for (const t of Tracks) assert.ok(Object.isFrozen(t));
    assert.throws(() => { Tracks[0].length = 99; }, TypeError);
    assert.throws(() => { Tracks.pop(); }, TypeError);
  });
});

describe("Dutch copy of heroes and tracks", () => {
  const texts = [
    ...Heroes.map((h) => ["tagline " + h.id, h.tagline]),
    ...Tracks.map((t) => ["blurb " + t.id, t.blurb]),
  ];

  test("every tagline and blurb is one calm, friendly sentence", () => {
    for (const [what, text] of texts) {
      assert.equal(text, text.trim(), what);
      assert.ok(text.length >= 30 && text.length <= 120, what + " length " + text.length);
      assert.ok(/^[A-Z]/.test(text), what + " starts with a capital");
      assert.ok(text.endsWith("."), what + " ends with a full stop");
      assert.ok(!/[.!?]/.test(text.slice(0, -1)), what + " must be a single sentence");
      assert.ok((text.match(/!/g) || []).length <= 1, what);
      assert.ok(!/\b[A-ZÀ-Ü]{3,}\b/.test(text), what + " has an ALL CAPS word");
      assert.ok(!/[€$]|\d/.test(text), what + " has no digits");
    }
    assert.equal(new Set(texts.map(([, t]) => t)).size, texts.length, "all texts are different");
  });

  test("none of the original game's names or terms appear (IP rule)", () => {
    const all = [...texts.map(([, t]) => t), ...Heroes.map((h) => h.name), ...Tracks.map((t) => t.name)].join(" ");
    assert.ok(!/red\s?cat|davilex|brutus|max de muis|bulldog/i.test(all));
  });
});

describe("Race.rivalTempos", () => {
  test("starts and ends at the agreed ranges", () => {
    assert.deepEqual(Race.rivalTempos(1), [0.7, 0.8, 0.9]);
    assert.deepEqual(Race.rivalTempos(8), [0.76, 0.86, 0.94]);
  });

  test("slow < middle < fast, rising gently with the track, never near 1.0", () => {
    let previous = Race.rivalTempos(1);
    for (const track of Tracks) {
      const tempos = Race.rivalTempos(track.id);
      assert.equal(tempos.length, 3);
      assert.ok(tempos[0] < tempos[1] && tempos[1] < tempos[2]);
      tempos.forEach((tempo, slot) => {
        assert.ok(tempo >= previous[slot], "tempo never drops from one track to the next");
        assert.ok(tempo - previous[slot] <= 0.02, "and rises only gently");
        // even the best case wobble stays under the ceiling
        const amp = Math.min(Race.RIVAL_JITTER, Race.RIVAL_MAX_GAIN - tempo);
        assert.ok(tempo + amp <= Race.RIVAL_MAX_GAIN + 1e-12);
        assert.ok(tempo - amp >= 0.5, "a rival's slowest possible sum is still no slower than a miss");
      });
      previous = tempos;
    }
  });

  test("accepts a Tracks entry, returns a fresh array, rejects garbage", () => {
    assert.deepEqual(Race.rivalTempos(Tracks[4]), Race.rivalTempos(5));
    const t = Race.rivalTempos(2);
    t[0] = 99;
    assert.notEqual(Race.rivalTempos(2)[0], 99);
    assert.throws(() => Race.rivalTempos(0), TypeError);
    assert.throws(() => Race.rivalTempos("1"), TypeError);
  });
});

describe("Race constants", () => {
  test("the player's gains per sum are 1.0 / 0.8 / 0.5 and cannot be changed", () => {
    assert.deepEqual(Race.PLAYER_GAIN, PLAYER_GAIN);
    assert.deepEqual(Race.OUTCOMES, OUTCOMES);
    assert.ok(Object.isFrozen(Race.PLAYER_GAIN) && Object.isFrozen(Race.OUTCOMES));
    assert.throws(() => { Race.PLAYER_GAIN.miss = 1; }, TypeError);
  });
});

describe("Race.create", () => {
  test("rejects garbage options with a clear TypeError", () => {
    for (const bad of [undefined, null, 5, "x", true]) {
      assert.throws(() => Race.create(bad), (e) => e instanceof TypeError && /expected \{ track, hero, seed \}/.test(e.message));
    }
    const ok = { track: 1, hero: "egel", seed: 1 };
    for (const track of [undefined, null, 0, 9, -1, 1.5, NaN, "3", "tulips", {}, { id: 99 }, { id: "1" }, true, []]) {
      assert.throws(() => Race.create({ ...ok, track }), (e) => e instanceof TypeError && /track/.test(e.message), "track " + String(track));
    }
    for (const hero of [undefined, null, "", "Egel", "konijn", 7, {}, { id: "x" }, true, [], ["egel"]]) {
      assert.throws(() => Race.create({ ...ok, hero }), (e) => e instanceof TypeError && /hero/.test(e.message) && /egel, eekhoorn, pad, uil/.test(e.message), "hero " + String(hero));
    }
    for (const seed of [undefined, null, NaN, Infinity, -Infinity, "12", {}, true, []]) {
      assert.throws(() => Race.create({ ...ok, seed }), (e) => e instanceof TypeError && /seed/.test(e.message), "seed " + String(seed));
    }
    assert.throws(() => Race.create({ track: 1, hero: "egel" }), TypeError, "a missing seed is an error, never silently 0");
    assert.throws(() => Race.create({ track: Object.create(null), hero: "egel", seed: 1 }), TypeError);
    assert.throws(() => Race.create({ track: 1, hero: Symbol("x"), seed: 1 }), TypeError);
  });

  test("a Tracks entry and a hero entry work the same as their ids; copies are not trusted", () => {
    const byId = Race.create({ track: 3, hero: "pad", seed: 77 });
    assert.deepEqual(Race.create({ track: Tracks[2], hero: Heroes[2], seed: 77 }), byId);
    const fake = Race.create({ track: { id: 3, length: 99, theme: "x" }, hero: "pad", seed: 77 });
    assert.deepEqual(fake, byId);
    assert.equal(fake.track.length, 10);
  });

  test("seeds are normalised like Rng.make does (unsigned 32 bit)", () => {
    const a = Race.create({ track: 1, hero: "uil", seed: 7 });
    assert.deepEqual(Race.create({ track: 1, hero: "uil", seed: 2 ** 32 + 7 }), a);
    assert.deepEqual(Race.create({ track: 1, hero: "uil", seed: 7.9 }), a);
    assert.deepEqual(Race.create({ track: 1, hero: "uil", seed: -1 }), Race.create({ track: 1, hero: "uil", seed: 2 ** 32 - 1 }));
    for (const seed of [0, 1, -5, 2 ** 40, 1e300]) {
      const state = Race.create({ track: 2, hero: "egel", seed });
      assert.equal(state.done, false);
    }
  });

  test("a fresh race: nobody has moved, nothing is done, the player leads by the tie rule", () => {
    const state = Race.create({ track: 5, hero: "eekhoorn", seed: 123 });
    assert.deepEqual(Race.positions(state), { egel: 0, eekhoorn: 0, pad: 0, uil: 0 });
    assert.deepEqual(Race.summary(state), { place: 1, first: 0, second: 0, miss: 0, total: 0, done: false });
    const table = Race.standings(state);
    assert.equal(table[0].id, "eekhoorn");
    assert.ok(table[0].isPlayer);
  });

  test("state is plain data: it survives a JSON round trip and keeps playing identically", () => {
    const a = Race.create({ track: 6, hero: "pad", seed: 4242 });
    const outcomes = ["first", "miss", "second", "first", "first"];
    outcomes.forEach((o) => Race.advance(a, o));
    const b = JSON.parse(JSON.stringify(a));
    const rest = ["second", "first", "miss", "first", "first"];
    const ra = rest.map((o) => Race.advance(a, o));
    const rb = rest.map((o) => Race.advance(b, o));
    assert.deepEqual(rb, ra);
    assert.deepEqual(Race.standings(b), Race.standings(a));
    assert.ok(a.done && b.done);
  });

  test("works without Math.random, Date or any other clock", () => {
    const realRandom = Math.random;
    const RealDate = globalThis.Date;
    const boom = () => { throw new Error("impure call"); };
    try {
      Math.random = boom;
      globalThis.Date = class extends RealDate {
        constructor() { boom(); }
        static now() { boom(); }
      };
      const state = Race.create({ track: 8, hero: "uil", seed: 9 });
      for (let i = 0; i < 10; i++) {
        Race.advance(state, OUTCOMES[i % 3]);
        Race.positions(state); Race.standings(state); Race.summary(state); Race.racers(state);
      }
      Race.rollout(state);
    } finally {
      Math.random = realRandom;
      globalThis.Date = RealDate;
    }
  });
});

describe("Race.racers and lanes", () => {
  test("player in lane 0, the three other heroes in lanes 1..3, each exactly once", () => {
    for (const hero of HERO_IDS) {
      const state = Race.create({ track: 2, hero, seed: 31 });
      const list = Race.racers(state);
      assert.equal(list.length, 4);
      assert.deepEqual(list.map((r) => r.lane), [0, 1, 2, 3]);
      assert.equal(list[0].id, hero);
      assert.ok(list[0].isPlayer);
      assert.ok(list.slice(1).every((r) => !r.isPlayer));
      assert.deepEqual(list.map((r) => r.id).sort(), HERO_IDS.slice().sort());
      for (const r of list) {
        assert.equal(r.name, Heroes.find((h) => h.id === r.id).name);
        assert.deepEqual(Object.keys(r).sort(), ["id", "isPlayer", "lane", "name"]);
      }
    }
  });

  test("lane order is fixed for a seed and does not change while the race runs", () => {
    const state = Race.create({ track: 4, hero: "egel", seed: 555 });
    const before = Race.racers(state);
    assert.deepEqual(Race.racers(Race.create({ track: 4, hero: "egel", seed: 555 })), before);
    ["first", "second", "miss", "first"].forEach((o) => Race.advance(state, o));
    assert.deepEqual(Race.racers(state), before);
  });

  test("racers() returns copies, so callers cannot disturb the race", () => {
    const state = Race.create({ track: 1, hero: "pad", seed: 8 });
    const list = Race.racers(state);
    list[0].lane = 3; list.reverse(); list.pop();
    assert.deepEqual(Race.racers(state).map((r) => r.lane), [0, 1, 2, 3]);
    assert.equal(Race.racers(state)[0].id, "pad");
    const pos = Race.positions(state);
    pos.pad = 99;
    assert.equal(Race.positions(state).pad, 0);
  });

  test("the fastest rival is not always in the same lane (spread over seeds)", () => {
    // Rivals in Heroes order (without the player) are slow, middle, fast.
    const n = 6000;
    const fastestLane = [0, 0, 0, 0];
    const arrangements = new Map(); // player hero -> Set of lane orders seen
    for (let i = 0; i < n; i++) {
      const hero = HERO_IDS[i % 4];
      const fast = HERO_IDS.filter((id) => id !== hero)[2];
      const list = Race.racers(Race.create({ track: 1, hero, seed: seedFor(i) }));
      fastestLane[list.find((r) => r.id === fast).lane]++;
      if (!arrangements.has(hero)) arrangements.set(hero, new Map());
      const key = list.map((r) => r.id).join(",");
      const seen = arrangements.get(hero);
      seen.set(key, (seen.get(key) || 0) + 1);
    }
    assert.equal(fastestLane[0], 0);
    for (const lane of [1, 2, 3]) {
      const share = fastestLane[lane] / n;
      assert.ok(share > 0.28 && share < 0.39, "lane " + lane + " share " + share);
    }
    for (const [hero, seen] of arrangements) {
      assert.equal(seen.size, 6, hero + ": all 6 arrangements of the rivals occur");
      for (const count of seen.values()) assert.ok(count / (n / 4) > 0.12, hero + " arrangement too rare");
    }
  });
});

describe("determinism", () => {
  test("same seed and same answers: identical race", () => {
    for (const track of Tracks) {
      for (const hero of HERO_IDS) {
        const seed = seedFor(track.id * 10 + HERO_IDS.indexOf(hero));
        const a = playRace(RR, track, hero, seed, KIDS.typical);
        const b = playRace(RR, track, hero, seed, KIDS.typical);
        assert.deepEqual(a, b);
        assert.deepEqual(Race.standings(a), Race.standings(b));
      }
    }
  });

  test("a fresh copy of the module gives the same race (no hidden global state)", () => {
    const other = laadRR();
    const a = playRace(RR, 3, "egel", 2024, KIDS.okay);
    const b = playRace(other, 3, "egel", 2024, KIDS.okay);
    assert.deepEqual(a, b);
  });

  test("different seeds give different rival races", () => {
    const seen = new Set();
    for (let i = 0; i < 300; i++) {
      const s = playRace(RR, 4, "pad", seedFor(i), KIDS.perfect);
      seen.add(JSON.stringify(Race.positions(s)));
    }
    assert.ok(seen.size > 285, "only " + seen.size + " distinct races in 300 seeds");
  });

  test("the rivals' race does not depend on what the player answers", () => {
    for (let i = 0; i < 200; i++) {
      const seed = seedFor(i);
      const hero = HERO_IDS[i % 4];
      const track = Tracks[i % 8];
      const a = Race.create({ track, hero, seed });
      const b = Race.create({ track, hero, seed });
      const rng = RR.Rng.make(seed + 1);
      for (let s = 0; s < 10; s++) {
        const ra = Race.advance(a, "first");
        const rb = Race.advance(b, answer(rng, KIDS.weak));
        for (const id of HERO_IDS.filter((x) => x !== hero)) assert.equal(ra.gains[id], rb.gains[id]);
      }
    }
  });
});

describe("invariants over many seeded races", () => {
  test("gains, positions, standings and summary stay consistent at every step", () => {
    for (const track of Tracks) {
      for (let i = 0; i < 400; i++) {
        const hero = HERO_IDS[(i + track.id) % 4];
        const seed = seedFor(i * 8 + track.id);
        const rng = RR.Rng.make(seed ^ 0x5bd1e995);
        const kid = [rng(), rng() * 0.3];
        const state = Race.create({ track, hero, seed });
        const lane = Object.fromEntries(Race.racers(state).map((r) => [r.id, r.lane]));
        const cumulative = { egel: 0, eekhoorn: 0, pad: 0, uil: 0 }; // thousandths, recomputed here
        const counts = { first: 0, second: 0, miss: 0 };
        let previous = Race.positions(state);

        for (let step = 1; step <= 10; step++) {
          const outcome = answer(rng, kid);
          counts[outcome]++;
          const result = Race.advance(state, outcome);
          assert.deepEqual(Object.keys(result).sort(), ["done", "gains"]);
          assert.equal(result.done, step === 10);
          assert.deepEqual(Object.keys(result.gains).sort(), HERO_IDS.slice().sort());

          for (const id of HERO_IDS) {
            const g = result.gains[id];
            assert.ok(g >= 0 && g <= 1, "gain within 0..1");
            assert.ok(Math.abs(g * 1000 - Math.round(g * 1000)) < 1e-9, "gain is a multiple of 0.001");
            if (id === hero) assert.equal(g, PLAYER_GAIN[outcome]);
            else assert.ok(g <= 0.98 + 1e-12, "a rival never gains more than 0.98 per sum");
            cumulative[id] += Math.round(g * 1000);
          }

          const pos = Race.positions(state);
          for (const id of HERO_IDS) {
            assert.equal(Math.round(pos[id] * 1000), cumulative[id], "position = sum of gains");
            assert.ok(pos[id] >= previous[id], "positions never go backwards");
            assert.ok(pos[id] <= track.length, "nobody passes the finish line during the sums");
          }
          previous = pos;

          const table = Race.standings(state);
          assert.equal(table.length, 4);
          assert.deepEqual(table.map((r) => r.place), [1, 2, 3, 4]);
          assert.deepEqual(table.map((r) => r.id).sort(), HERO_IDS.slice().sort());
          assert.equal(table.filter((r) => r.isPlayer).length, 1);
          for (let k = 0; k < 4; k++) {
            const r = table[k];
            assert.equal(r.pos, pos[r.id]);
            assert.equal(r.isPlayer, r.id === hero);
            assert.equal(r.name, Heroes.find((h) => h.id === r.id).name);
            if (k > 0) {
              const above = table[k - 1];
              assert.ok(above.pos >= r.pos, "best first");
              if (above.pos === r.pos) {
                assert.ok(above.isPlayer || (!r.isPlayer && lane[above.id] < lane[r.id]), "tie: player first, then lane order");
              }
            }
          }

          const sum = Race.summary(state);
          assert.deepEqual(Object.keys(sum).sort(), ["done", "first", "miss", "place", "second", "total"]);
          assert.deepEqual({ first: sum.first, second: sum.second, miss: sum.miss }, counts);
          assert.equal(sum.total, step);
          assert.equal(sum.done, step === 10);
          assert.equal(sum.place, table.find((r) => r.isPlayer).place);
        }
      }
    }
  });

  test("the race ends after exactly track.length sums, whatever the answers", () => {
    for (const kind of OUTCOMES) {
      const state = Race.create({ track: 7, hero: "uil", seed: 3 });
      for (let i = 0; i < 9; i++) assert.equal(Race.advance(state, kind).done, false);
      assert.equal(Race.advance(state, kind).done, true);
      assert.equal(Race.summary(state).done, true);
    }
  });

  test("the player's finishing position is exactly the sum of the agreed gains", () => {
    const state = Race.create({ track: 2, hero: "egel", seed: 99 });
    // five firsts, three seconds, two misses: 5 + 2.4 + 1.0 = 8.4 (worked out by hand)
    "first,first,second,miss,second,first,miss,second,first,first".split(",").forEach((o) => Race.advance(state, o));
    assert.equal(Race.positions(state).egel, 8.4);
    const sum = Race.summary(state);
    assert.deepEqual({ ...sum, place: 0 }, { place: 0, first: 5, second: 3, miss: 2, total: 10, done: true });
    assert.equal(sum.place, Race.standings(state).find((r) => r.isPlayer).place);
  });
});

describe("a perfect player always wins (proof and simulation)", () => {
  test("proof: a rival gains at most 0.98 per sum, so after k sums it trails by >= 0.02 k", () => {
    assert.ok(Race.RIVAL_MAX_GAIN < 1);
    for (const track of Tracks) {
      for (const tempo of Race.rivalTempos(track.id)) {
        const amp = Math.min(Race.RIVAL_JITTER, Race.RIVAL_MAX_GAIN - tempo);
        assert.ok(tempo + amp <= Race.RIVAL_MAX_GAIN + 1e-12, "largest possible gain is below the ceiling");
      }
    }
    assert.ok(10 * Race.RIVAL_MAX_GAIN < 10, "so no rival can reach the 10.0 of a perfect player");
  });

  test("worst case: every rival draws the maximum jitter on every sum", () => {
    const rr = rrWithFixedRng(MAX_U);
    for (const track of rr.Tracks) {
      for (const hero of HERO_IDS) {
        const state = rr.Race.create({ track, hero, seed: 1 });
        for (let step = 1; step <= 10; step++) {
          rr.Race.advance(state, "first");
          const table = rr.Race.standings(state);
          assert.equal(table[0].id, hero, "perfect player leads after every sum");
          assert.ok(table[0].pos > table[1].pos, "strictly ahead, not a tie");
          assert.ok(table[0].pos - table[1].pos >= 0.02 * step - 1e-9, "by at least 0.02 per sum so far");
        }
        const finalTable = rr.Race.standings(state);
        assert.equal(finalTable[0].pos, 10);
        assert.ok(finalTable[1].pos <= 9.8 + 1e-9);
        assert.equal(rr.Race.summary(state).place, 1);
      }
    }
  });

  test("minimum jitter on every sum: rivals still never move backwards", () => {
    const rr = rrWithFixedRng(0);
    for (const track of rr.Tracks) {
      const state = rr.Race.create({ track, hero: "egel", seed: 1 });
      let before = rr.Race.positions(state);
      for (let step = 0; step < 10; step++) {
        const { gains } = rr.Race.advance(state, "miss");
        const now = rr.Race.positions(state);
        for (const id of HERO_IDS) {
          assert.ok(gains[id] >= 0 && now[id] >= before[id]);
        }
        before = now;
      }
    }
  });

  test("simulation: 8 tracks x 4 heroes x 1500 seeds, perfect player always strictly first", () => {
    let worstLead = Infinity;
    for (const track of Tracks) {
      for (const hero of HERO_IDS) {
        for (let i = 0; i < 1500; i++) {
          const state = playRace(RR, track, hero, seedFor(i), KIDS.perfect);
          const table = Race.standings(state);
          assert.equal(table[0].id, hero);
          assert.equal(Race.summary(state).place, 1);
          worstLead = Math.min(worstLead, table[0].pos - table[1].pos);
        }
      }
    }
    assert.ok(worstLead >= 0.2 - 1e-9, "worst lead over the best rival was " + worstLead);
  });

  test("stubbed middle-of-the-road rng: every rival moves at exactly its tempo, pace order follows Heroes order", () => {
    const rr = rrWithFixedRng(0.5);
    for (const track of rr.Tracks) {
      const tempos = rr.Race.rivalTempos(track.id);
      for (const hero of HERO_IDS) {
        const state = rr.Race.create({ track, hero, seed: 1 });
        for (let i = 0; i < 10; i++) rr.Race.advance(state, "first");
        const pos = rr.Race.positions(state);
        const rivals = HERO_IDS.filter((id) => id !== hero); // slow, middle, fast
        rivals.forEach((id, slot) => assert.ok(Math.abs(pos[id] - 10 * tempos[slot]) < 1e-9, hero + " " + id));
      }
    }
  });
});

describe("rival pace", () => {
  test("each rival's average gain per sum is its tempo (jitter is symmetric, never squashed by a clamp)", () => {
    const seeds = 2500;
    for (const track of Tracks) {
      const tempos = Race.rivalTempos(track.id);
      const rivals = ["eekhoorn", "pad", "uil"]; // slow, middle, fast when the player is egel
      const total = [0, 0, 0];
      let samples = 0;
      for (let i = 0; i < seeds; i++) {
        const state = Race.create({ track, hero: "egel", seed: seedFor(i) });
        for (let s = 0; s < 10; s++) {
          const { gains } = Race.advance(state, "first");
          rivals.forEach((id, slot) => { total[slot] += gains[id]; });
          samples++;
        }
      }
      total.forEach((sum, slot) => {
        assert.ok(Math.abs(sum / samples - tempos[slot]) < 0.002, "track " + track.id + " slot " + slot + ": " + sum / samples + " vs " + tempos[slot]);
      });
    }
  });

  test("rivals really wobble from sum to sum (they are not clockwork), but only within their limits", () => {
    for (const track of [Tracks[0], Tracks[7]]) {
      const tempos = Race.rivalTempos(track.id);
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < 300; i++) {
        const state = Race.create({ track, hero: "egel", seed: seedFor(i) });
        for (let s = 0; s < 10; s++) {
          const { gains } = Race.advance(state, "first");
          ["eekhoorn", "pad", "uil"].forEach((id, slot) => {
            lo[slot] = Math.min(lo[slot], gains[id]);
            hi[slot] = Math.max(hi[slot], gains[id]);
          });
        }
      }
      tempos.forEach((tempo, slot) => {
        const amp = Math.min(Race.RIVAL_JITTER, Race.RIVAL_MAX_GAIN - tempo);
        assert.ok(hi[slot] - lo[slot] > 1.8 * amp, "slot " + slot + " should use most of its wobble range");
        assert.ok(hi[slot] <= tempo + amp + 0.0006 && lo[slot] >= tempo - amp - 0.0006, "slot " + slot + " stays within tempo +/- jitter");
      });
    }
  });
});

describe("calibration by simulation (5000 seeds per track)", () => {
  const N = 5000;
  let cache = null;
  // Computed on first use so a filtered run does not pay for it.
  const getTable = () => {
    if (!cache) {
      cache = {};
      for (const track of Tracks) {
        cache[track.id] = {};
        for (const kid of ["perfect", "typical", "struggling"]) {
          cache[track.id][kid] = placeCounts(RR, track, KIDS[kid], N);
        }
      }
    }
    return cache;
  };

  test("a perfect kid wins 100% of the races on every track", () => {
    const table = getTable();
    for (const track of Tracks) assert.deepEqual(table[track.id].perfect, [N, 0, 0, 0], "track " + track.id);
  });

  test("a typical kid (80% first, 10% second, 10% miss): top two >= 70%, last <= 5%", () => {
    const table = getTable();
    for (const track of Tracks) {
      const [p1, p2, , p4] = table[track.id].typical;
      assert.ok((p1 + p2) / N >= 0.7, "track " + track.id + " top 2: " + (p1 + p2) / N);
      assert.ok(p4 / N <= 0.05, "track " + track.id + " last: " + p4 / N);
      // design intent: neither a foregone conclusion nor a struggle
      assert.ok(p1 / N > 0.25 && p1 / N < 0.9, "track " + track.id + " wins: " + p1 / N);
    }
  });

  test("a struggling kid (50/20/30): last <= 60%, and every race still finishes", () => {
    const table = getTable();
    for (const track of Tracks) {
      assert.ok(table[track.id].struggling[3] / N <= 0.6, "track " + track.id);
    }
    for (const track of Tracks) {
      for (let i = 0; i < 300; i++) {
        const state = playRace(RR, track, HERO_IDS[i % 4], seedFor(i), KIDS.struggling);
        const sum = Race.summary(state);
        assert.ok(sum.done && sum.total === 10 && sum.place >= 1 && sum.place <= 4);
      }
    }
  });

  test("it gets a little harder with every track, and better answers always help", () => {
    const table = getTable();
    let previous = 1;
    for (const track of Tracks) {
      const wins = table[track.id].typical[0] / N;
      assert.ok(wins <= previous + 0.01, "typical win rate should fall gently, track " + track.id);
      previous = wins;
    }
    const n = 2000;
    const meanPlace = (counts) => counts.reduce((sum, c, i) => sum + c * (i + 1), 0) / n;
    for (const track of [Tracks[0], Tracks[7]]) {
      const means = ["perfect", "good", "typical", "okay", "struggling", "weak"]
        .map((k) => meanPlace(placeCounts(RR, track, KIDS[k], n)));
      for (let k = 1; k < means.length; k++) {
        assert.ok(means[k] > means[k - 1], "track " + track.id + ": " + means.join(" < "));
      }
    }
  });
});

describe("Race.advance", () => {
  function finished() {
    const state = Race.create({ track: 3, hero: "pad", seed: 12 });
    for (let i = 0; i < 10; i++) Race.advance(state, "second");
    return state;
  }

  test("after the last sum it throws Error('race_done') and changes nothing", () => {
    const state = finished();
    const snapshot = JSON.stringify(state);
    for (const o of OUTCOMES) {
      assert.throws(() => Race.advance(state, o), (e) => e instanceof Error && !(e instanceof TypeError) && e.message === "race_done");
    }
    assert.throws(() => Race.advance(state, "garbage"), (e) => e.message === "race_done", "done is reported first");
    assert.equal(JSON.stringify(state), snapshot);
    assert.equal(Race.summary(state).total, 10);
  });

  test("an unknown outcome is a TypeError and leaves the race untouched", () => {
    const state = Race.create({ track: 1, hero: "egel", seed: 5 });
    Race.advance(state, "first");
    const snapshot = JSON.stringify(state);
    const bad = [undefined, null, "", "First", "FIRST", "right", "wrong", 1, 0, true, {}, [], ["first"], "constructor", "__proto__", "toString", "hasOwnProperty", "first "];
    for (const outcome of bad) {
      assert.throws(() => Race.advance(state, outcome), (e) => e instanceof TypeError && /outcome/.test(e.message), String(outcome));
    }
    assert.equal(JSON.stringify(state), snapshot);
    assert.equal(Race.advance(state, "second").done, false);
  });

  test("not a race state: TypeError from every function", () => {
    for (const bad of [undefined, null, {}, [], "x", 5, { v: 1 }, { v: 1, lanes: [], units: null }, { lanes: [], units: {} }]) {
      for (const fn of ["positions", "standings", "summary", "racers", "rollout"]) {
        assert.throws(() => Race[fn](bad), TypeError, fn);
      }
      assert.throws(() => Race.advance(bad, "first"), TypeError);
    }
  });
});

describe("Race.standings tie rule", () => {
  test("a real tie: the player ranks ahead of a rival on the same position", () => {
    // u = 0.5 makes every rival gain exactly its tempo; on track 1 that is 0.7 / 0.8 / 0.9.
    const rr = rrWithFixedRng(0.5);
    const state = rr.Race.create({ track: 1, hero: "egel", seed: 1 });
    for (let i = 0; i < 4; i++) {
      rr.Race.advance(state, "second"); // 0.8 a sum = exactly the middle rival (pad)
      const table = rr.Race.standings(state);
      assert.deepEqual(table.map((r) => r.id), ["uil", "egel", "pad", "eekhoorn"]);
      assert.equal(table[1].pos, table[2].pos);
      assert.deepEqual(table.map((r) => r.place), [1, 2, 3, 4]);
      assert.deepEqual(table.map((r) => r.isPlayer), [false, true, false, false]);
    }
  });

  test("tied rivals are ordered by lane, the player first among equals", () => {
    const state = Race.create({ track: 1, hero: "pad", seed: 2 });
    const lanes = Race.racers(state).map((r) => r.id); // [player, lane 1, lane 2, lane 3]
    const [player, l1, l2, l3] = lanes;

    for (const id of lanes) state.units[id] = 4000; // everyone level
    assert.deepEqual(Race.standings(state).map((r) => r.id), [player, l1, l2, l3]);

    state.units[player] = 3000; state.units[l1] = 5000; state.units[l2] = 5000; state.units[l3] = 1000;
    assert.deepEqual(Race.standings(state).map((r) => r.id), [l1, l2, player, l3]);

    state.units[player] = 5000; state.units[l1] = 5000; state.units[l2] = 5000; state.units[l3] = 6000;
    assert.deepEqual(Race.standings(state).map((r) => r.id), [l3, player, l1, l2]);

    state.units[player] = 2000; state.units[l1] = 2000; state.units[l2] = 3000; state.units[l3] = 2000;
    assert.deepEqual(Race.standings(state).map((r) => r.id), [l2, player, l1, l3]);
    assert.deepEqual(Race.standings(state).map((r) => r.place), [1, 2, 3, 4]);
  });

  test("positions are exact thousandths, so equal sums really are equal", () => {
    // 0.8 + 0.5 + 0.5 ... would drift in floating point; thousandths do not.
    const rr = rrWithFixedRng(0.5);
    const state = rr.Race.create({ track: 1, hero: "egel", seed: 1 });
    "second,second,second,second,second".split(",").forEach((o) => rr.Race.advance(state, o));
    assert.equal(rr.Race.positions(state).egel, 4);
    assert.equal(rr.Race.positions(state).pad, 4); // middle rival: 5 x 0.8
    assert.equal(rr.Race.standings(state).findIndex((r) => r.isPlayer), 1);
  });
});

describe("Race.summary", () => {
  test("place is the player's current place while racing and final when done", () => {
    const state = Race.create({ track: 8, hero: "uil", seed: 321 });
    const seq = ["miss", "miss", "first", "second", "miss"];
    seq.forEach((o, i) => {
      Race.advance(state, o);
      const sum = Race.summary(state);
      assert.equal(sum.total, i + 1);
      assert.equal(sum.done, false);
      assert.equal(sum.place, Race.standings(state).find((r) => r.isPlayer).place);
      assert.ok(Number.isInteger(sum.place) && sum.place >= 1 && sum.place <= 4);
    });
    assert.deepEqual(
      (({ first, second, miss }) => ({ first, second, miss }))(Race.summary(state)),
      { first: 1, second: 1, miss: 3 },
    );
    ["first", "first", "first", "second", "first"].forEach((o) => Race.advance(state, o));
    const last = Race.summary(state);
    assert.ok(last.done);
    assert.equal(last.total, 10);
    assert.equal(last.first + last.second + last.miss, 10);
    assert.equal(last.place, Race.standings(state).find((r) => r.isPlayer).place);
  });
});

describe("Race.rollout (calm drive on over the line)", () => {
  test("only available once the race is done", () => {
    const state = Race.create({ track: 1, hero: "egel", seed: 1 });
    assert.throws(() => Race.rollout(state), (e) => e.message === "race_not_done");
    for (let i = 0; i < 9; i++) Race.advance(state, "first");
    assert.throws(() => Race.rollout(state), (e) => e.message === "race_not_done");
  });

  test("everyone crosses the line, gaps and order are kept, the race itself is untouched", () => {
    for (const kid of ["perfect", "typical", "weak"]) {
      for (let i = 0; i < 100; i++) {
        const track = Tracks[i % 8];
        const state = playRace(RR, track, HERO_IDS[i % 4], seedFor(i), KIDS[kid]);
        const snapshot = JSON.stringify(state);
        const end = Race.positions(state);
        const out = Race.rollout(state);
        assert.equal(JSON.stringify(state), snapshot);
        assert.deepEqual(Object.keys(out).sort(), HERO_IDS.slice().sort());
        const shift = out[HERO_IDS[0]] - end[HERO_IDS[0]];
        for (const id of HERO_IDS) {
          assert.ok(out[id] > track.length, "over the line");
          assert.ok(Math.abs(out[id] - end[id] - shift) < 1e-9, "same extra distance for everybody");
        }
        assert.ok(Math.abs(Math.min(...Object.values(out)) - (track.length + 0.5)) < 1e-9, "the last kart ends 0.5 past the line");
      }
    }
  });
});
