// Tests for RR.Store (local storage of profiles, answer statistics, stamps, settings).
// During development: RR_PARTS_DIR=<scratchpad>/parts node --test tests/rekenrace-opslag.test.mjs
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { laadRR } from "./helpers/rekenrace-laden.mjs";

const RR = laadRR();
const { Store, Rng } = RR;

// Written out by hand (not read from the module) so the tests do not just echo it.
const KEY = "rekenrace:v1";
const HEROES = ["egel", "eekhoorn", "pad", "uil"];
const KINDS = ["add", "sub", "times", "div", "gap", "story"];
const OUTCOMES = ["first", "second", "miss"];
const GOOD = { first: true, second: true, miss: false };

// ----------------------------------------------------------------------- helpers

// Map-backed storage that records its writes.
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  const log = { gets: 0, sets: [], removes: 0 };
  return {
    map,
    log,
    getItem(k) { log.gets++; return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { log.sets.push(k); map.set(k, String(v)); },
    removeItem(k) { log.removes++; map.delete(k); },
  };
}

// Storage whose reads/writes can be switched to throw at any moment.
function flakyStorage(initial = {}) {
  const base = fakeStorage(initial);
  const ctl = { failGet: false, failSet: false, failSetKeys: [], attempts: 0 };
  return Object.assign({}, base, {
    ctl,
    getItem(k) {
      if (ctl.failGet) throw new Error("SecurityError: storage is blocked");
      return base.getItem(k);
    },
    setItem(k, v) {
      ctl.attempts++;
      if (ctl.failSet || ctl.failSetKeys.includes(k)) {
        const e = new Error("The quota has been exceeded.");
        e.name = "QuotaExceededError";
        throw e;
      }
      return base.setItem(k, v);
    },
  });
}

// Local noon: the local calendar date is then the same in every timezone.
const noon = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0).getTime();

function fresh(initial, now) {
  const storage = fakeStorage(initial);
  return { storage, store: Store.create(storage, now) };
}

// A store with one selected player ("Eva", groep 4).
function withEva(initial, now) {
  const ctx = fresh(initial, now);
  const r = ctx.store.addPlayer({ name: "Eva", hero: "egel", grade: 4 });
  assert.equal(r.ok, true);
  assert.equal(ctx.store.select(r.player.id), true);
  return Object.assign(ctx, { eva: r.player });
}

const stored = (storage) => JSON.parse(storage.map.get(KEY));
const cps = (s) => Array.from(s).length;

// What a fresh settings object must look like.
const DEFAULT_SETTINGS = { sound: true, music: false, restAfter: 3 };

// Structural invariants every stored document must satisfy, however it came to be.
function checkDoc(doc) {
  assert.equal(doc.v, 1);
  assert.ok(Array.isArray(doc.players), "players is an array");
  assert.ok(doc.players.length <= 8, "at most 8 players");
  const ids = new Set();
  const names = new Set();
  let maxId = 0;
  for (const p of doc.players) {
    assert.match(p.id, /^p[0-9a-z]{1,10}$/);
    assert.ok(!ids.has(p.id), "unique id " + p.id);
    ids.add(p.id);
    maxId = Math.max(maxId, parseInt(p.id.slice(1), 36));
    assert.ok(cps(p.name) >= 1 && cps(p.name) <= 12, "name length: " + JSON.stringify(p.name));
    assert.equal(p.name, p.name.trim());
    assert.ok(!/ {2}/.test(p.name), "collapsed spaces");
    assert.ok(!/[\u0000-\u001f\u007f]/.test(p.name), "no control characters");
    assert.ok(!names.has(p.name.toLowerCase()), "unique name " + p.name);
    names.add(p.name.toLowerCase());
    assert.ok(HEROES.includes(p.hero), "hero " + p.hero);
    assert.ok([3, 4, 5, 6].includes(p.grade), "grade " + p.grade);

    const keys = Object.keys(p.answers);
    assert.ok(keys.length <= 400, "answers pruned");
    let prevT = -1;
    for (const k of keys) {
      const r = p.answers[k];
      assert.ok(k.length > 0 && k.length <= 80 && !/^\d+$/.test(k) && k !== "__proto__");
      assert.ok(KINDS.includes(r.kind), "answer kind");
      assert.ok(Number.isInteger(r.ok) && r.ok >= 0 && r.ok <= 999999);
      assert.ok(Number.isInteger(r.miss) && r.miss >= 0 && r.miss <= 999999);
      assert.ok(OUTCOMES.includes(r.last));
      assert.ok(r.last === "miss" ? r.miss >= 1 : r.ok >= 1, "latest outcome is counted");
      assert.ok(Number.isInteger(r.t) && r.t >= 0 && r.t >= prevT, "t never decreases along the order");
      prevT = r.t;
    }
    assert.deepEqual(Object.keys(p.kinds), KINDS);
    for (const k of KINDS) {
      const s = p.kinds[k];
      assert.ok(Number.isInteger(s.ok) && Number.isInteger(s.total));
      assert.ok(s.ok >= 0 && s.ok <= s.total && s.total <= 999999);
    }
    for (const [t, s] of Object.entries(p.stamps)) {
      assert.ok(/^[1-8]$/.test(t), "stamp track " + t);
      assert.ok([1, 2, 3, 4].includes(s.place));
      assert.match(s.date, /^\d{4}-\d{2}-\d{2}$/);
    }
  }
  assert.ok(doc.current === null || ids.has(doc.current), "current points at a player");
  assert.ok(Number.isInteger(doc.counter) && doc.counter >= maxId, "counter is ahead of every id");
  assert.equal(typeof doc.settings.sound, "boolean");
  assert.equal(typeof doc.settings.music, "boolean");
  assert.ok(Number.isInteger(doc.settings.restAfter) && doc.settings.restAfter >= 0 && doc.settings.restAfter <= 10);
}

// A rich stored document built through the real API (used as base for corruption).
function richStorage() {
  const storage = fakeStorage();
  const store = Store.create(storage, () => noon(2026, 3, 5));
  for (const [name, hero, grade] of [["Eva", "egel", 4], ["Bo", "uil", 3], ["Cas", "pad", 6]]) {
    const r = store.addPlayer({ name, hero, grade });
    store.select(r.player.id);
    store.recordAnswer("times:7x8", "times", "miss");
    store.recordAnswer("add:3+4", "add", "first");
    store.recordAnswer("gap:add:24+?=51", "gap", "second");
    store.stamp(1, 2);
    store.stamp(2, 1);
  }
  store.setSetting("restAfter", 5);
  return storage;
}

// ----------------------------------------------------------------------- players

describe("players", () => {
  test("a new store is empty and uses the documented defaults", () => {
    const { store } = fresh();
    assert.deepEqual(store.players(), []);
    assert.equal(store.current(), null);
    assert.deepEqual(store.settings(), DEFAULT_SETTINGS);
    assert.deepEqual(store.stamps(), {});
    assert.equal(store.nextTrack(), 1);
    assert.deepEqual(store.openKeys(5), []);
    assert.deepEqual(store.trickyKeys(5), []);
    assert.deepEqual(store.kindStats(), KINDS.map((kind) => ({ kind, ok: 0, total: 0 })));
  });

  test("addPlayer returns { ok, player } without selecting the player", () => {
    const { store } = fresh();
    const r = store.addPlayer({ name: "Eva", hero: "egel", grade: 4 });
    assert.deepEqual(Object.keys(r).sort(), ["ok", "player"]);
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(r.player).sort(), ["grade", "hero", "id", "name"]);
    assert.equal(r.player.name, "Eva");
    assert.equal(r.player.hero, "egel");
    assert.equal(r.player.grade, 4);
    assert.deepEqual(store.players(), [r.player]);
    assert.equal(store.current(), null, "adding does not select");
  });

  test("all four heroes and groep 3 to 6 are accepted; digit strings from a form too", () => {
    const { store } = fresh();
    HEROES.forEach((hero, i) => {
      const r = store.addPlayer({ name: "K" + i, hero, grade: 3 + i });
      assert.equal(r.ok, true, hero);
      assert.equal(r.player.grade, 3 + i);
    });
    const s = store.addPlayer({ name: "Vorm", hero: "pad", grade: "5" });
    assert.equal(s.ok, true);
    assert.equal(s.player.grade, 5);
  });

  test("returned objects are copies: changing them does not touch the store", () => {
    const { store } = withEva();
    const list = store.players();
    list[0].name = "Hacked";
    list.push({ id: "p99" });
    store.current().grade = 6;
    assert.equal(store.players().length, 1);
    assert.equal(store.players()[0].name, "Eva");
    assert.equal(store.current().grade, 4);
  });

  test("ids are short, unique, stable across a reload and never reused", () => {
    const { storage, store } = fresh();
    const a = store.addPlayer({ name: "A", hero: "egel", grade: 3 }).player;
    const b = store.addPlayer({ name: "B", hero: "egel", grade: 3 }).player;
    assert.notEqual(a.id, b.id);
    assert.match(a.id, /^p[0-9a-z]{1,4}$/);
    assert.equal(store.removePlayer(b.id), true);
    const c = store.addPlayer({ name: "C", hero: "egel", grade: 3 }).player;
    assert.notEqual(c.id, b.id, "a removed id is not handed out again");
    assert.notEqual(c.id, a.id);
    const again = Store.create(storage);
    assert.deepEqual(again.players().map((p) => p.id), [a.id, c.id]);
    const d = again.addPlayer({ name: "D", hero: "egel", grade: 3 }).player;
    assert.ok(![a.id, b.id, c.id].includes(d.id));
  });

  test("ids stay unique over many adds and removals", () => {
    const { store } = fresh();
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      const r = store.addPlayer({ name: "N" + (i % 7), hero: "pad", grade: 5 });
      if (r.ok) {
        assert.ok(!seen.has(r.player.id), "duplicate id " + r.player.id);
        seen.add(r.player.id);
      }
      if (i % 3 === 0 && store.players().length) store.removePlayer(store.players()[0].id);
    }
  });

  describe("name rules", () => {
    const cases = [
      ["trims", "  Eva  ", "Eva"],
      ["collapses inner spaces", "Eva    Jansen", "Eva Jansen"],
      ["treats tab and newline as spaces", "Eva\tJan\nsen", "Eva Jan sen"],
      ["treats a non-breaking space as a space", "Eva  Jan", "Eva Jan"],
      ["removes control characters", "E\u0000v\u0007a\u007f", "Eva"],
      ["removes zero-width and bidi override characters", "E​v‮a⁦", "Eva"],
      ["re-collapses spaces left behind by removed characters", "A ​ B", "A B"],
      ["composes accents (NFC)", "José", "José"],
      ["truncates to 12 characters", "Abcdefghijklmnop", "Abcdefghijkl"],
      ["does not leave a trailing space after truncating", "Abcdefghijk lm", "Abcdefghijk"],
      ["counts by code point, not UTF-16 unit", "\u{1F431}".repeat(15), "\u{1F431}".repeat(12)],
      ["keeps lone code points intact when truncating emoji", "Kat\u{1F431}\u{1F431}\u{1F431}\u{1F431}\u{1F431}\u{1F431}\u{1F431}\u{1F431}\u{1F431}\u{1F431}", "Kat" + "\u{1F431}".repeat(9)],
      ["removes lone surrogates", "Ev\ud800a", "Eva"],
    ];
    for (const [label, input, expected] of cases) {
      test(label, () => {
        const { store } = fresh();
        const r = store.addPlayer({ name: input, hero: "egel", grade: 4 });
        assert.equal(r.ok, true);
        assert.equal(r.player.name, expected);
      });
    }

    test("empty-ish names are name_empty", () => {
      const { store } = fresh();
      for (const name of ["", "   ", "\t\n", "\u0000\u0001", "​​", undefined, null, 5, {}, [], true]) {
        assert.deepEqual(store.addPlayer({ name, hero: "egel", grade: 4 }), { ok: false, error: "name_empty" }, String(name));
      }
      assert.deepEqual(store.addPlayer(), { ok: false, error: "name_empty" });
      assert.deepEqual(store.addPlayer(null), { ok: false, error: "name_empty" });
      assert.deepEqual(store.addPlayer("Eva"), { ok: false, error: "name_empty" });
      assert.deepEqual(store.players(), []);
    });

    test("names are unique case-insensitively (also after cleaning and truncating)", () => {
      const { store } = fresh();
      assert.equal(store.addPlayer({ name: "Eva", hero: "egel", grade: 4 }).ok, true);
      for (const dup of ["eva", "EVA", " eVa ", "E​va"]) {
        assert.deepEqual(store.addPlayer({ name: dup, hero: "pad", grade: 3 }), { ok: false, error: "name_taken" }, dup);
      }
      assert.equal(store.addPlayer({ name: "Émilie", hero: "egel", grade: 4 }).ok, true);
      assert.equal(store.addPlayer({ name: "éMILIE", hero: "egel", grade: 4 }).error, "name_taken");
      assert.equal(store.addPlayer({ name: "Abcdefghijklmnop", hero: "egel", grade: 4 }).ok, true);
      assert.equal(store.addPlayer({ name: "abcdefghijklXYZ", hero: "egel", grade: 4 }).error, "name_taken");
      assert.equal(store.players().length, 3);
    });

    test("a very long name is cut, not rejected, and does not choke", () => {
      const { store } = fresh();
      const r = store.addPlayer({ name: "x".repeat(2000000), hero: "egel", grade: 4 });
      assert.equal(r.player.name, "xxxxxxxxxxxx");
    });
  });

  test("at most 8 players; removing one makes room", () => {
    const { store } = fresh();
    for (let i = 0; i < 8; i++) assert.equal(store.addPlayer({ name: "K" + i, hero: "egel", grade: 4 }).ok, true);
    assert.deepEqual(store.addPlayer({ name: "Negen", hero: "egel", grade: 4 }), { ok: false, error: "too_many" });
    assert.equal(store.players().length, 8);
    store.removePlayer(store.players()[3].id);
    assert.equal(store.addPlayer({ name: "Negen", hero: "egel", grade: 4 }).ok, true);
    assert.equal(store.players().length, 8);
  });

  test("error codes: bad_hero, bad_grade, and their precedence", () => {
    const { store } = fresh();
    for (const hero of ["leeuw", "Egel", "", undefined, null, 1, ["egel"]]) {
      assert.deepEqual(store.addPlayer({ name: "Eva", hero, grade: 4 }), { ok: false, error: "bad_hero" }, String(hero));
    }
    for (const grade of [2, 7, 0, -4, 4.5, "x", "", "4.5", undefined, null, NaN, Infinity, [4]]) {
      assert.deepEqual(store.addPlayer({ name: "Eva", hero: "egel", grade }), { ok: false, error: "bad_grade" }, String(grade));
    }
    // documented order: name_empty, name_taken, too_many, bad_hero, bad_grade
    assert.equal(store.addPlayer({ name: "", hero: "x", grade: 1 }).error, "name_empty");
    assert.equal(store.addPlayer({ name: "Eva", hero: "x", grade: 1 }).error, "bad_hero");
    store.addPlayer({ name: "Eva", hero: "egel", grade: 4 });
    assert.equal(store.addPlayer({ name: "eva", hero: "x", grade: 1 }).error, "name_taken");
    for (let i = 0; i < 7; i++) store.addPlayer({ name: "K" + i, hero: "egel", grade: 4 });
    assert.equal(store.addPlayer({ name: "Nieuw", hero: "x", grade: 1 }).error, "too_many");
    assert.equal(store.players().length, 8);
  });

  test("a rejected addPlayer changes nothing and writes nothing", () => {
    const { storage, store } = fresh();
    store.addPlayer({ name: "Eva", hero: "egel", grade: 4 });
    const before = storage.map.get(KEY);
    const writes = storage.log.sets.length;
    store.addPlayer({ name: "Eva", hero: "egel", grade: 4 });
    store.addPlayer({ name: "Bo", hero: "nope", grade: 4 });
    store.addPlayer({ name: "Bo", hero: "egel", grade: 9 });
    assert.equal(storage.map.get(KEY), before);
    assert.equal(storage.log.sets.length, writes);
  });
});

describe("select, current, remove, edit", () => {
  test("select / current / select(null)", () => {
    const { store } = fresh();
    const a = store.addPlayer({ name: "A", hero: "egel", grade: 3 }).player;
    const b = store.addPlayer({ name: "B", hero: "pad", grade: 5 }).player;
    assert.equal(store.select(b.id), true);
    assert.deepEqual(store.current(), b);
    assert.equal(store.select(a.id), true);
    assert.deepEqual(store.current(), a);
    assert.equal(store.select("p-unknown"), false);
    assert.equal(store.select(42), false);
    assert.equal(store.select({}), false);
    assert.deepEqual(store.current(), a, "a failed select keeps the selection");
    assert.equal(store.select(null), true);
    assert.equal(store.current(), null);
  });

  test("removePlayer of the current player clears the selection, of another one does not", () => {
    const { storage, store } = fresh();
    const a = store.addPlayer({ name: "A", hero: "egel", grade: 3 }).player;
    const b = store.addPlayer({ name: "B", hero: "pad", grade: 5 }).player;
    store.select(a.id);
    assert.equal(store.removePlayer(b.id), true);
    assert.deepEqual(store.current(), a);
    assert.equal(store.removePlayer(a.id), true);
    assert.equal(store.current(), null);
    assert.equal(stored(storage).current, null);
    assert.deepEqual(store.players(), []);
    assert.equal(store.removePlayer(a.id), false, "already gone");
    assert.equal(store.removePlayer("nope"), false);
    assert.equal(store.removePlayer(undefined), false);
  });

  test("removePlayer takes the stats and stamps with it", () => {
    const { store, eva } = withEva();
    store.recordAnswer("add:1+1", "add", "miss");
    store.stamp(1, 1);
    store.removePlayer(eva.id);
    const again = store.addPlayer({ name: "Eva", hero: "egel", grade: 4 }).player;
    store.select(again.id);
    assert.deepEqual(store.openKeys(10), []);
    assert.deepEqual(store.stamps(), {});
  });

  test("setGrade / setHero validate and apply", () => {
    const { store, eva } = withEva();
    assert.equal(store.setGrade(eva.id, 6), true);
    assert.equal(store.current().grade, 6);
    assert.equal(store.setGrade(eva.id, "3"), true);
    assert.equal(store.current().grade, 3);
    for (const g of [2, 7, 4.5, "x", null, undefined, NaN]) assert.equal(store.setGrade(eva.id, g), false, String(g));
    assert.equal(store.setGrade("nope", 4), false);
    assert.equal(store.setGrade(undefined, 4), false);
    assert.equal(store.current().grade, 3);

    assert.equal(store.setHero(eva.id, "uil"), true);
    assert.equal(store.current().hero, "uil");
    for (const h of ["draak", "", null, undefined, 3]) assert.equal(store.setHero(eva.id, h), false, String(h));
    assert.equal(store.setHero("nope", "pad"), false);
    assert.equal(store.current().hero, "uil");
  });

  test("setGrade / setHero work for a player that is not selected", () => {
    const { store } = withEva();
    const bo = store.addPlayer({ name: "Bo", hero: "pad", grade: 5 }).player;
    assert.equal(store.setGrade(bo.id, 3), true);
    assert.equal(store.setHero(bo.id, "egel"), true);
    assert.deepEqual(store.players().find((p) => p.id === bo.id), { id: bo.id, name: "Bo", hero: "egel", grade: 3 });
  });

  test("rename: same ok/error shape, cleaning, uniqueness against OTHER players only", () => {
    const { store, eva } = withEva();
    const bo = store.addPlayer({ name: "Bo", hero: "pad", grade: 5 }).player;
    assert.deepEqual(store.rename(eva.id, "  Eefje  "), { ok: true, player: { id: eva.id, name: "Eefje", hero: "egel", grade: 4 } });
    assert.deepEqual(store.rename(eva.id, ""), { ok: false, error: "name_empty" });
    assert.deepEqual(store.rename(eva.id, "\u0000 "), { ok: false, error: "name_empty" });
    assert.deepEqual(store.rename(eva.id, "BO"), { ok: false, error: "name_taken" });
    assert.equal(store.rename(eva.id, "EEFJE").ok, true, "own name in other case is allowed");
    assert.equal(store.current().name, "EEFJE");
    assert.equal(store.rename(bo.id, "x".repeat(40)).player.name, "xxxxxxxxxxxx");
    assert.deepEqual(store.rename("nope", "Zed"), { ok: false, error: "unknown_player" });
    assert.deepEqual(store.rename(undefined, "Zed"), { ok: false, error: "unknown_player" });
    assert.equal(store.current().name, "EEFJE", "failed renames change nothing");
  });
});

// ----------------------------------------------------------------------- answers

describe("recordAnswer and statistics", () => {
  test("is a no-op returning false without a selected player", () => {
    const { storage, store } = fresh();
    store.addPlayer({ name: "Eva", hero: "egel", grade: 4 });
    const before = storage.map.get(KEY);
    assert.equal(store.recordAnswer("add:1+1", "add", "first"), false);
    assert.equal(store.stamp(1, 1), false);
    assert.equal(storage.map.get(KEY), before);
    assert.deepEqual(store.kindStats(), KINDS.map((kind) => ({ kind, ok: 0, total: 0 })));
    assert.deepEqual(store.stamps(), {});
    assert.equal(store.nextTrack(), 1);
  });

  test("rejects unknown kinds, unknown outcomes and unusable keys", () => {
    const { storage, store } = withEva();
    const before = storage.map.get(KEY);
    const bad = [
      ["add:1+1", "plus", "first"], ["add:1+1", "ADD", "first"], ["add:1+1", undefined, "first"],
      ["add:1+1", "add", "good"], ["add:1+1", "add", "FIRST"], ["add:1+1", "add", undefined], ["add:1+1", "add", 1],
      ["", "add", "first"], [undefined, "add", "first"], [null, "add", "first"], [12, "add", "first"],
      ["12345", "add", "first"], ["__proto__", "add", "first"], ["add:1\n+1", "add", "first"],
      ["add:" + "9".repeat(80), "add", "first"], [["add:1+1"], "add", "first"], [{}, "add", "first"],
    ];
    for (const [k, kind, o] of bad) assert.equal(store.recordAnswer(k, kind, o), false, JSON.stringify([k, kind, o]));
    assert.equal(storage.map.get(KEY), before);
    assert.deepEqual(store.openKeys(10), []);
  });

  test("accepts all six kinds and three outcomes; keys of normal length", () => {
    const { store } = withEva();
    for (const kind of KINDS) for (const o of OUTCOMES) {
      assert.equal(store.recordAnswer(kind + ":" + o, kind, o), true, kind + o);
    }
    assert.equal(store.recordAnswer("story:" + "x".repeat(74), "story", "first"), true, "80 characters is fine");
    assert.equal(store.recordAnswer("gap:sub:30-?=12", "gap", "second"), true);
  });

  test("per-kind counts: ok = first or second try, total = every recorded sum", () => {
    const { store } = withEva();
    store.recordAnswer("times:2x3", "times", "first");
    store.recordAnswer("times:2x4", "times", "second");
    store.recordAnswer("times:2x5", "times", "miss");
    store.recordAnswer("times:2x5", "times", "miss");
    store.recordAnswer("div:12:4", "div", "first");
    assert.deepEqual(store.kindStats(), [
      { kind: "add", ok: 0, total: 0 },
      { kind: "sub", ok: 0, total: 0 },
      { kind: "times", ok: 2, total: 4 },
      { kind: "div", ok: 1, total: 1 },
      { kind: "gap", ok: 0, total: 0 },
      { kind: "story", ok: 0, total: 0 },
    ]);
  });

  test("kindStats always lists all six kinds in the same order", () => {
    const { store } = withEva();
    const order = () => store.kindStats().map((k) => k.kind);
    assert.deepEqual(order(), KINDS);
    store.recordAnswer("story:x", "story", "first");
    store.recordAnswer("add:x", "add", "miss");
    assert.deepEqual(order(), KINDS);
    assert.deepEqual(Object.keys(store.kindStats()[0]).sort(), ["kind", "ok", "total"]);
  });

  test("statistics are per player and optional id lets you read another profile", () => {
    const { store, eva } = withEva();
    const bo = store.addPlayer({ name: "Bo", hero: "pad", grade: 5 }).player;
    store.recordAnswer("add:1+2", "add", "miss");
    store.stamp(1, 3);
    store.select(bo.id);
    assert.deepEqual(store.openKeys(5), []);
    assert.deepEqual(store.stamps(), {});
    store.recordAnswer("sub:5-1", "sub", "first");
    assert.deepEqual(store.openKeys(5, eva.id), ["add:1+2"]);
    assert.deepEqual(store.trickyKeys(5, eva.id), [{ key: "add:1+2", kind: "add", miss: 1, ok: 0 }]);
    assert.equal(store.kindStats(eva.id)[0].total, 1);
    assert.equal(store.kindStats()[0].total, 0, "no id means the selected player");
    assert.equal(store.stamps(eva.id)["1"].place, 3);
    assert.equal(store.nextTrack(eva.id), 2);
    assert.equal(store.nextTrack(), 1);
    assert.equal(store.current().id, bo.id, "reading another profile does not switch to it");
    assert.deepEqual(store.openKeys(5, "nope"), []);
    assert.deepEqual(store.kindStats("nope"), KINDS.map((kind) => ({ kind, ok: 0, total: 0 })));
  });

  test("openKeys: second and miss open a sum, a later first closes it, newest first", () => {
    const { store } = withEva();
    const rec = (key, o) => store.recordAnswer(key, "add", o);
    rec("add:a", "first");   // never open
    rec("add:b", "second");  // open
    rec("add:c", "miss");    // open
    rec("add:d", "miss");    // open, then closed
    rec("add:d", "first");
    rec("add:e", "second");  // open
    assert.deepEqual(store.openKeys(10), ["add:e", "add:c", "add:b"]);
    rec("add:b", "first");   // closes b
    assert.deepEqual(store.openKeys(10), ["add:e", "add:c"]);
    rec("add:c", "second");  // c stays open, but is now the newest
    assert.deepEqual(store.openKeys(10), ["add:c", "add:e"]);
    rec("add:b", "miss");    // reopened, newest
    assert.deepEqual(store.openKeys(10), ["add:b", "add:c", "add:e"]);
  });

  test("openKeys limits: n, 0, negative, NaN, fractions, undefined, huge", () => {
    const { store } = withEva();
    for (let i = 0; i < 6; i++) store.recordAnswer("add:" + i, "add", "miss");
    const all = ["add:5", "add:4", "add:3", "add:2", "add:1", "add:0"];
    assert.deepEqual(store.openKeys(2), all.slice(0, 2));
    assert.deepEqual(store.openKeys(1), all.slice(0, 1));
    assert.deepEqual(store.openKeys(2.9), all.slice(0, 2));
    assert.deepEqual(store.openKeys(0), []);
    assert.deepEqual(store.openKeys(-3), []);
    assert.deepEqual(store.openKeys(NaN), []);
    assert.deepEqual(store.openKeys("3"), []);
    assert.deepEqual(store.openKeys(Infinity), all);
    assert.deepEqual(store.openKeys(1e9), all);
    assert.deepEqual(store.openKeys(), all);
  });

  test("openKeys output is a fresh array every call", () => {
    const { store } = withEva();
    store.recordAnswer("add:1", "add", "miss");
    const a = store.openKeys(5);
    a.push("add:evil");
    assert.deepEqual(store.openKeys(5), ["add:1"]);
  });

  test("trickyKeys: most misses first, then most recent; only sums that were missed", () => {
    const { store } = withEva();
    const rec = (key, kind, o) => store.recordAnswer(key, kind, o);
    rec("times:6x7", "times", "miss");
    rec("times:6x7", "times", "miss");
    rec("times:6x7", "times", "first");   // 2 misses, 1 ok
    rec("div:42:7", "div", "miss");        // 1 miss
    rec("add:1+1", "add", "second");       // no misses: not tricky
    rec("sub:9-3", "sub", "miss");         // 1 miss, more recent than div
    rec("story:x", "story", "miss");
    rec("story:x", "story", "miss");
    rec("story:x", "story", "miss");       // 3 misses
    assert.deepEqual(store.trickyKeys(10), [
      { key: "story:x", kind: "story", miss: 3, ok: 0 },
      { key: "times:6x7", kind: "times", miss: 2, ok: 1 },
      { key: "sub:9-3", kind: "sub", miss: 1, ok: 0 },
      { key: "div:42:7", kind: "div", miss: 1, ok: 0 },
    ]);
    assert.deepEqual(store.trickyKeys(2).map((r) => r.key), ["story:x", "times:6x7"]);
    assert.deepEqual(store.trickyKeys(0), []);
    assert.deepEqual(store.trickyKeys(-1), []);
    assert.equal(store.trickyKeys().length, 4);
  });

  test("a sum that was missed and later solved stays in trickyKeys (history) but not in openKeys", () => {
    const { store } = withEva();
    store.recordAnswer("times:6x7", "times", "miss");
    store.recordAnswer("times:6x7", "times", "first");
    assert.deepEqual(store.openKeys(5), []);
    assert.deepEqual(store.trickyKeys(5), [{ key: "times:6x7", kind: "times", miss: 1, ok: 1 }]);
  });

  test("order follows the order of recording even when the clock stands still or runs backwards", () => {
    const times = [5000, 5000, 5000, 100, 0, 9000, 8999, 8999];
    let i = 0;
    const { store } = withEva({}, () => times[Math.min(i++, times.length - 1)]);
    i = 0;
    const keys = ["add:a", "add:b", "add:c", "add:d", "add:e", "add:f", "add:g", "add:h"];
    keys.forEach((k) => store.recordAnswer(k, "add", "miss"));
    assert.deepEqual(store.openKeys(20), keys.slice().reverse());
    assert.deepEqual(store.trickyKeys(20).map((r) => r.key), keys.slice().reverse());
  });

  test("t is stored monotonic: a clock that jumps back cannot produce a decreasing t", () => {
    let now = 9000;
    const { storage, store } = withEva({}, () => now);
    store.recordAnswer("add:a", "add", "first");
    now = 100;
    store.recordAnswer("add:b", "add", "first");
    const answers = Object.values(stored(storage).players[0].answers);
    assert.deepEqual(answers.map((r) => r.t), [9000, 9000]);
  });

  test("model check: random sessions agree with an independent recomputation", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const rng = Rng.make(seed * 7919);
      let tick = 0;
      const { storage, store } = fresh({}, () => (rng() < 0.3 ? Rng.int(rng, 0, 5) : (tick += Rng.int(rng, 0, 40))));
      const ids = ["Eva", "Bo", "Cas"].map((name, i) => store.addPlayer({ name, hero: HEROES[i], grade: 3 + i }).player.id);
      const pool = [];
      KINDS.forEach((kind) => { for (let i = 0; i < 7; i++) pool.push({ key: kind + ":" + i, kind }); });
      const events = { [ids[0]]: [], [ids[1]]: [], [ids[2]]: [] };
      let sel = null;

      const lastIdx = (list) => {
        const m = new Map();
        list.forEach((e, i) => m.set(e.key, i));
        return m;
      };
      const expectOpen = (list, n) => {
        const idx = lastIdx(list);
        const out = new Map();
        list.forEach((e) => out.set(e.key, e.outcome));
        return [...idx.keys()].filter((k) => out.get(k) !== "first").sort((a, b) => idx.get(b) - idx.get(a)).slice(0, n);
      };
      const expectTricky = (list, n) => {
        const st = new Map();
        list.forEach((e, i) => {
          const s = st.get(e.key) || { key: e.key, kind: e.kind, ok: 0, miss: 0, idx: 0 };
          if (e.outcome === "miss") s.miss++; else s.ok++;
          s.idx = i;
          st.set(e.key, s);
        });
        return [...st.values()].filter((s) => s.miss > 0)
          .sort((a, b) => b.miss - a.miss || b.idx - a.idx).slice(0, n)
          .map(({ key, kind, miss, ok }) => ({ key, kind, miss, ok }));
      };
      const expectKinds = (list) => KINDS.map((kind) => ({
        kind,
        ok: list.filter((e) => e.kind === kind && e.outcome !== "miss").length,
        total: list.filter((e) => e.kind === kind).length,
      }));
      const compareAll = (id) => {
        const list = events[id];
        assert.deepEqual(store.openKeys(1000, id), expectOpen(list, 1000), "openKeys seed " + seed);
        assert.deepEqual(store.openKeys(3, id), expectOpen(list, 3));
        assert.deepEqual(store.trickyKeys(1000, id), expectTricky(list, 1000), "trickyKeys seed " + seed);
        assert.deepEqual(store.kindStats(id), expectKinds(list), "kindStats seed " + seed);
      };

      for (let step = 0; step < 220; step++) {
        if (rng() < 0.1) { sel = ids[Rng.int(rng, 0, 2)]; assert.equal(store.select(sel), true); }
        if (!sel) continue;
        const q = Rng.pick(rng, pool);
        const o = rng() < 0.55 ? "first" : rng() < 0.5 ? "second" : "miss";
        assert.equal(store.recordAnswer(q.key, q.kind, o), true);
        events[sel].push({ key: q.key, kind: q.kind, outcome: o });
        if (step % 11 === 0) compareAll(sel);
      }
      ids.forEach(compareAll);
      // and the same numbers come back from a reload
      const again = Store.create(storage);
      ids.forEach((id) => {
        assert.deepEqual(again.openKeys(1000, id), expectOpen(events[id], 1000));
        assert.deepEqual(again.trickyKeys(1000, id), expectTricky(events[id], 1000));
        assert.deepEqual(again.kindStats(id), expectKinds(events[id]));
      });
      checkDoc(stored(storage));
    }
  });
});

describe("pruning and clamping", () => {
  const keyOf = (i) => "add:k" + i;

  test("per-player answers are pruned to the newest 400 keys; aggregates keep counting", () => {
    let t = 1000;
    const { storage, store } = withEva({}, () => (t += 10));
    for (let i = 1; i <= 450; i++) assert.equal(store.recordAnswer(keyOf(i), "add", "miss"), true);
    const answers = stored(storage).players[0].answers;
    assert.equal(Object.keys(answers).length, 400);
    assert.ok(!(keyOf(1) in answers) && !(keyOf(50) in answers), "the 50 oldest are gone");
    assert.ok(keyOf(51) in answers && keyOf(450) in answers);
    assert.equal(store.openKeys(1000).length, 400);
    assert.equal(store.openKeys(1)[0], keyOf(450));
    assert.equal(store.openKeys(1000).at(-1), keyOf(51));
    assert.deepEqual(store.kindStats()[0], { kind: "add", ok: 0, total: 450 });
    checkDoc(stored(storage));
  });

  test("re-recording an old sum makes it new again, so it survives the pruning", () => {
    const { storage, store } = withEva();
    for (let i = 1; i <= 400; i++) store.recordAnswer(keyOf(i), "add", "miss");
    store.recordAnswer(keyOf(1), "add", "miss");     // k1 is now the newest
    store.recordAnswer(keyOf(401), "add", "miss");   // pushes out the oldest, which is k2
    const answers = stored(storage).players[0].answers;
    assert.equal(Object.keys(answers).length, 400);
    assert.ok(keyOf(1) in answers);
    assert.ok(!(keyOf(2) in answers));
    assert.deepEqual(store.openKeys(2), [keyOf(401), keyOf(1)]);
  });

  test("pruning is per player", () => {
    const { storage, store } = withEva();
    const bo = store.addPlayer({ name: "Bo", hero: "pad", grade: 5 }).player;
    store.recordAnswer("add:eva", "add", "miss");
    store.select(bo.id);
    for (let i = 1; i <= 500; i++) store.recordAnswer(keyOf(i), "add", "first");
    const doc = stored(storage);
    assert.equal(Object.keys(doc.players[0].answers).length, 1);
    assert.equal(Object.keys(doc.players[1].answers).length, 400);
  });

  test("a loaded document with thousands of answers is pruned to the newest 400 by t", () => {
    const answers = {};
    const order = [];
    for (let i = 0; i < 2500; i++) order.push(i);
    // scramble the insertion order so "newest by t" is not "last in file"
    const rng = Rng.make(99);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    order.forEach((i) => { answers["add:" + i] = { kind: "add", ok: 1, miss: 0, last: "first", t: 1000 + i }; });
    const doc = { v: 1, counter: 1, current: "p1", settings: DEFAULT_SETTINGS, players: [{ id: "p1", name: "Eva", hero: "egel", grade: 4, answers, kinds: {}, stamps: {} }] };
    const { storage, store } = fresh({ [KEY]: JSON.stringify(doc) });
    store.setSetting("restAfter", 4);   // force a write of the repaired document
    const out = stored(storage).players[0].answers;
    const keys = Object.keys(out);
    assert.equal(keys.length, 400);
    assert.deepEqual(keys, Array.from({ length: 400 }, (_, i) => "add:" + (2100 + i)), "newest 400 by t, oldest first");
    checkDoc(stored(storage));
  });

  test("counts are clamped, negative and fractional counts repaired", () => {
    const doc = {
      v: 1, counter: 1, current: "p1", settings: DEFAULT_SETTINGS,
      players: [{
        id: "p1", name: "Eva", hero: "egel", grade: 4,
        answers: {
          "add:big": { kind: "add", ok: 1e15, miss: 5e9, last: "miss", t: 5 },
          "add:neg": { kind: "add", ok: -4, miss: -1, last: "second", t: 6 },
          "add:frac": { kind: "add", ok: 2.9, miss: 1.5, last: "miss", t: 7 },
          "add:str": { kind: "add", ok: "3", miss: "x", last: "first", t: 8 },
        },
        kinds: { add: { ok: 1e12, total: 3 }, sub: { ok: -5, total: -9 }, times: { ok: 9, total: 2 } },
        stamps: {},
      }],
    };
    const { storage, store } = fresh({ [KEY]: JSON.stringify(doc) });
    store.setSetting("restAfter", 4);
    const p = stored(storage).players[0];
    assert.deepEqual(p.answers["add:big"], { kind: "add", ok: 999999, miss: 999999, last: "miss", t: 5 });
    assert.deepEqual(p.answers["add:neg"], { kind: "add", ok: 1, miss: 0, last: "second", t: 6 });
    assert.deepEqual(p.answers["add:frac"], { kind: "add", ok: 2, miss: 1, last: "miss", t: 7 });
    assert.deepEqual(p.answers["add:str"], { kind: "add", ok: 3, miss: 0, last: "first", t: 8 });
    assert.deepEqual(p.kinds.add, { ok: 999999, total: 999999 });
    assert.deepEqual(p.kinds.sub, { ok: 0, total: 0 });
    assert.deepEqual(p.kinds.times, { ok: 9, total: 9 }, "total is never below ok");
    checkDoc(stored(storage));
  });

  test("counters stop at the clamp instead of growing without bound", () => {
    const doc = {
      v: 1, counter: 1, current: "p1", settings: DEFAULT_SETTINGS,
      players: [{
        id: "p1", name: "Eva", hero: "egel", grade: 4,
        answers: { "add:x": { kind: "add", ok: 999999, miss: 999999, last: "first", t: 1 } },
        kinds: { add: { ok: 999999, total: 999999 } }, stamps: {},
      }],
    };
    const { storage, store } = fresh({ [KEY]: JSON.stringify(doc) });
    assert.equal(store.recordAnswer("add:x", "add", "first"), true);
    assert.equal(store.recordAnswer("add:x", "add", "miss"), true);
    const p = stored(storage).players[0];
    assert.equal(p.answers["add:x"].ok, 999999);
    assert.equal(p.answers["add:x"].miss, 999999);
    assert.deepEqual(p.kinds.add, { ok: 999999, total: 999999 });
  });

  test("a stored answer with an unknown kind is repaired from its key or dropped", () => {
    const doc = {
      v: 1, counter: 1, current: "p1", settings: DEFAULT_SETTINGS,
      players: [{
        id: "p1", name: "Eva", hero: "egel", grade: 4,
        answers: {
          "times:7x8": { kind: "tafels", ok: 0, miss: 2, last: "miss", t: 1 },
          "zzz:1": { kind: "zzz", ok: 1, miss: 0, last: "first", t: 2 },
          "add:nolast": { kind: "add", ok: 0, miss: 0, t: 3 },
          "add:lastonly": { kind: "add", ok: 0, miss: 2, t: 4 },
          "__proto__": { kind: "add", ok: 1, miss: 0, last: "first", t: 5 },
          "123": { kind: "add", ok: 1, miss: 0, last: "first", t: 6 },
          "add:array": [1, 2, 3],
        },
        kinds: {}, stamps: {},
      }],
    };
    const { storage, store } = fresh({ [KEY]: JSON.stringify(doc) });
    store.setSetting("restAfter", 4);
    const answers = stored(storage).players[0].answers;
    assert.deepEqual(Object.keys(answers).sort(), ["add:lastonly", "times:7x8"]);
    assert.equal(answers["times:7x8"].kind, "times");
    assert.equal(answers["add:lastonly"].last, "miss");
  });
});

// ----------------------------------------------------------------------- stamps

describe("stamps and nextTrack", () => {
  test("stamp stores the place and the local date from the injected clock", () => {
    const { store } = withEva({}, () => noon(2026, 3, 5));
    assert.equal(store.stamp(3, 2), true);
    assert.deepEqual(store.stamps(), { 3: { place: 2, date: "2026-03-05" } });
  });

  test("a better place replaces the place, the first date stays; a worse place changes nothing", () => {
    let now = noon(2026, 3, 5);
    const { storage, store } = withEva({}, () => now);
    store.stamp(3, 3);
    now = noon(2026, 4, 9);
    store.stamp(3, 1);
    assert.deepEqual(store.stamps()["3"], { place: 1, date: "2026-03-05" });
    now = noon(2026, 5, 1);
    const writes = storage.log.sets.length;
    assert.equal(store.stamp(3, 4), true, "valid input is accepted ...");
    assert.equal(store.stamp(3, 1), true);
    assert.deepEqual(store.stamps()["3"], { place: 1, date: "2026-03-05" }, "... but the best place stays");
    assert.equal(storage.log.sets.length, writes, "and nothing is written");
  });

  test("stamps() returns a copy", () => {
    const { store } = withEva();
    store.stamp(1, 2);
    const s = store.stamps();
    s["1"].place = 4;
    s["7"] = { place: 1, date: "2020-01-01" };
    assert.deepEqual(Object.keys(store.stamps()), ["1"]);
    assert.equal(store.stamps()["1"].place, 2);
  });

  test("track ids outside 1..8 and places outside 1..4 are refused", () => {
    const { storage, store } = withEva();
    const before = storage.map.get(KEY);
    for (const t of [0, 9, -1, 1.5, "x", "", NaN, null, undefined, [], {}, 8.0001, Infinity]) {
      assert.equal(store.stamp(t, 1), false, "track " + String(t));
    }
    for (const p of [0, 5, -1, 1.5, "x", "", NaN, null, undefined, 4.5, Infinity]) {
      assert.equal(store.stamp(1, p), false, "place " + String(p));
    }
    assert.equal(storage.map.get(KEY), before);
    assert.deepEqual(store.stamps(), {});
    for (let t = 1; t <= 8; t++) for (let p = 1; p <= 4; p++) assert.equal(store.stamp(t, p), true, t + "/" + p);
    assert.equal(store.stamp("3", "2"), true, "digit strings are fine");
  });

  test("nextTrack: first track without a stamp, 9 when all eight are stamped", () => {
    const { store } = withEva();
    assert.equal(store.nextTrack(), 1);
    store.stamp(1, 4);
    assert.equal(store.nextTrack(), 2);
    store.stamp(3, 1);
    assert.equal(store.nextTrack(), 2, "the first gap, even if a later track has a stamp");
    store.stamp(2, 2);
    assert.equal(store.nextTrack(), 4);
    for (let t = 4; t <= 7; t++) store.stamp(t, 3);
    assert.equal(store.nextTrack(), 8);
    store.stamp(8, 4);
    assert.equal(store.nextTrack(), 9);
    store.stamp(8, 1);
    assert.equal(store.nextTrack(), 9);
  });

  test("stamps are per player and survive grade/hero/name changes", () => {
    const { store, eva } = withEva();
    store.stamp(1, 1);
    const bo = store.addPlayer({ name: "Bo", hero: "pad", grade: 3 }).player;
    store.select(bo.id);
    assert.deepEqual(store.stamps(), {});
    assert.equal(store.nextTrack(), 1);
    store.select(eva.id);
    store.setGrade(eva.id, 5);
    store.setHero(eva.id, "uil");
    store.rename(eva.id, "Eefje");
    assert.equal(store.stamps()["1"].place, 1);
  });

  test("odd clocks never break stamping: dates stay well-formed", () => {
    const clocks = [() => NaN, () => { throw new Error("clock broke"); }, () => undefined, () => -5e12, () => Infinity, () => "soon", () => 1e30, () => null];
    for (const clock of clocks) {
      const { storage, store } = withEva({}, clock);
      assert.equal(store.stamp(1, 1), true);
      assert.match(store.stamps()["1"].date, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(store.recordAnswer("add:1", "add", "first"), true);
      checkDoc(stored(storage));
    }
  });

  test("create(storage) without a clock works", () => {
    const storage = fakeStorage();
    const store = Store.create(storage);
    const eva = store.addPlayer({ name: "Eva", hero: "egel", grade: 4 }).player;
    store.select(eva.id);
    assert.equal(store.stamp(1, 1), true);
    assert.equal(store.recordAnswer("add:1", "add", "first"), true);
    const s2 = Store.create(storage, "not a function");
    assert.equal(s2.stamp(2, 1), false, "nobody is selected in a store restored from a fresh load? (no: current is stored)");
  });
});

// ----------------------------------------------------------------------- settings

describe("settings", () => {
  test("defaults and validation", () => {
    const { store } = fresh();
    assert.deepEqual(store.settings(), { sound: true, music: false, restAfter: 3 });
    assert.equal(store.setSetting("sound", false), true);
    assert.equal(store.setSetting("music", true), true);
    assert.equal(store.setSetting("restAfter", 0), true, "0 = off");
    assert.deepEqual(store.settings(), { sound: false, music: true, restAfter: 0 });
    assert.equal(store.setSetting("restAfter", 10), true);
    assert.equal(store.setSetting("restAfter", "7"), true, "digit strings from a form are fine");
    assert.equal(store.settings().restAfter, 7);

    for (const v of [11, -1, 2.5, "x", "", "2.5", null, undefined, NaN, Infinity, true, [3]]) {
      assert.equal(store.setSetting("restAfter", v), false, "restAfter " + String(v));
    }
    for (const v of [1, 0, "true", "false", null, undefined, "yes", [], {}]) {
      assert.equal(store.setSetting("sound", v), false, "sound " + String(v));
      assert.equal(store.setSetting("music", v), false, "music " + String(v));
    }
    for (const name of ["volume", "", undefined, null, "Sound", "__proto__", "constructor"]) {
      assert.equal(store.setSetting(name, true), false, String(name));
    }
    assert.deepEqual(store.settings(), { sound: false, music: true, restAfter: 7 }, "refused values change nothing");
  });

  test("settings() returns a copy", () => {
    const { store } = fresh();
    const s = store.settings();
    s.sound = false;
    s.extra = 1;
    assert.deepEqual(store.settings(), DEFAULT_SETTINGS);
  });

  test("settings are global: they need no player and do not change with the selected player", () => {
    const { store, eva } = fresh();
    assert.equal(store.setSetting("music", true), true, "works with nobody selected");
    const a = store.addPlayer({ name: "A", hero: "egel", grade: 3 }).player;
    const b = store.addPlayer({ name: "B", hero: "pad", grade: 3 }).player;
    store.select(a.id);
    store.setSetting("restAfter", 6);
    store.select(b.id);
    assert.deepEqual(store.settings(), { sound: true, music: true, restAfter: 6 });
    store.removePlayer(a.id);
    store.removePlayer(b.id);
    assert.deepEqual(store.settings(), { sound: true, music: true, restAfter: 6 }, "removing profiles keeps settings");
  });
});

describe("resetProgress", () => {
  test("wipes stats and stamps of that player only, keeps the profile", () => {
    const { store, eva } = withEva();
    const bo = store.addPlayer({ name: "Bo", hero: "pad", grade: 5 }).player;
    store.recordAnswer("add:1", "add", "miss");
    store.stamp(1, 1);
    store.select(bo.id);
    store.recordAnswer("sub:1", "sub", "miss");
    store.stamp(2, 2);
    store.setSetting("music", true);

    assert.equal(store.resetProgress(eva.id), true);
    assert.deepEqual(store.players().find((p) => p.id === eva.id), eva, "profile untouched");
    assert.deepEqual(store.openKeys(9, eva.id), []);
    assert.deepEqual(store.trickyKeys(9, eva.id), []);
    assert.deepEqual(store.stamps(eva.id), {});
    assert.equal(store.nextTrack(eva.id), 1);
    assert.deepEqual(store.kindStats(eva.id), KINDS.map((kind) => ({ kind, ok: 0, total: 0 })));

    assert.deepEqual(store.openKeys(9, bo.id), ["sub:1"], "other player untouched");
    assert.equal(store.stamps(bo.id)["2"].place, 2);
    assert.equal(store.settings().music, true, "settings untouched");
    assert.equal(store.current().id, bo.id, "selection untouched");
  });

  test("unknown id is false; an already-empty profile writes nothing", () => {
    const { storage, store, eva } = withEva();
    assert.equal(store.resetProgress("nope"), false);
    assert.equal(store.resetProgress(undefined), false);
    const writes = storage.log.sets.length;
    assert.equal(store.resetProgress(eva.id), true);
    assert.equal(storage.log.sets.length, writes);
  });

  test("the profile can be played again after a reset", () => {
    const { store, eva } = withEva();
    store.recordAnswer("add:1", "add", "miss");
    store.resetProgress(eva.id);
    store.recordAnswer("add:2", "add", "second");
    store.stamp(1, 2);
    assert.deepEqual(store.openKeys(9), ["add:2"]);
    assert.equal(store.nextTrack(), 2);
  });
});

// ----------------------------------------------------------------------- persistence

describe("persistence", () => {
  test("round trip: a second store on the same storage sees exactly the same data", () => {
    let t = noon(2026, 3, 5);
    const { storage, store } = fresh({}, () => (t += 1000));
    const eva = store.addPlayer({ name: "Eva", hero: "egel", grade: 4 }).player;
    const bo = store.addPlayer({ name: "Bo", hero: "uil", grade: 6 }).player;
    store.select(eva.id);
    store.recordAnswer("times:7x8", "times", "miss");
    store.recordAnswer("times:7x8", "times", "second");
    store.recordAnswer("add:3+4", "add", "first");
    store.recordAnswer("story:eieren:6:8", "story", "miss");
    store.stamp(1, 2);
    store.stamp(2, 1);
    store.select(bo.id);
    store.recordAnswer("div:56:8", "div", "miss");
    store.stamp(1, 4);
    store.setSetting("sound", false);
    store.setSetting("music", true);
    store.setSetting("restAfter", 5);
    store.setGrade(bo.id, 5);

    const again = Store.create(storage);
    assert.deepEqual(again.players(), store.players());
    assert.deepEqual(again.current(), store.current());
    assert.deepEqual(again.settings(), { sound: false, music: true, restAfter: 5 });
    for (const id of [eva.id, bo.id]) {
      assert.deepEqual(again.stamps(id), store.stamps(id));
      assert.deepEqual(again.openKeys(99, id), store.openKeys(99, id));
      assert.deepEqual(again.trickyKeys(99, id), store.trickyKeys(99, id));
      assert.deepEqual(again.kindStats(id), store.kindStats(id));
      assert.equal(again.nextTrack(id), store.nextTrack(id));
    }
    assert.deepEqual(again.openKeys(9, eva.id), ["story:eieren:6:8", "times:7x8"]);
    // the restored store keeps working and keeps persisting
    assert.equal(again.recordAnswer("div:12:3", "div", "first"), true);
    assert.deepEqual(Store.create(storage).kindStats().find((k) => k.kind === "div"), { kind: "div", ok: 1, total: 2 });
    checkDoc(stored(storage));
  });

  test("everything lives under ONE key, 'rekenrace:v1'", () => {
    const { storage } = withEva();
    const store = Store.create(storage);
    store.recordAnswer("add:1", "add", "miss");
    store.stamp(1, 1);
    store.setSetting("music", true);
    store.removePlayer(store.players()[0].id);
    assert.deepEqual([...storage.map.keys()], [KEY]);
    assert.equal(Store.KEY, KEY);
    assert.ok(new Set(storage.log.sets).size === 1 && storage.log.sets[0] === KEY);
    assert.equal(storage.log.removes, 0);
  });

  test("the stored JSON has the documented shape", () => {
    let now = noon(2026, 3, 5);
    const { storage, store } = fresh({}, () => now);
    const eva = store.addPlayer({ name: "Eva", hero: "egel", grade: 4 }).player;
    store.addPlayer({ name: "Bo", hero: "uil", grade: 6 });
    store.select(eva.id);
    store.recordAnswer("times:7x8", "times", "miss");
    now = noon(2026, 3, 6);
    store.recordAnswer("add:3+4", "add", "first");
    store.recordAnswer("times:7x8", "times", "second");
    store.stamp(2, 3);
    store.setSetting("restAfter", 4);
    const zero = Object.fromEntries(KINDS.map((k) => [k, { ok: 0, total: 0 }]));
    assert.deepEqual(stored(storage), {
      v: 1,
      counter: 2,
      current: eva.id,
      settings: { sound: true, music: false, restAfter: 4 },
      players: [
        {
          id: eva.id, name: "Eva", hero: "egel", grade: 4,
          answers: {
            "add:3+4": { kind: "add", ok: 1, miss: 0, last: "first", t: noon(2026, 3, 6) },
            "times:7x8": { kind: "times", ok: 1, miss: 1, last: "second", t: noon(2026, 3, 6) },
          },
          kinds: { ...zero, add: { ok: 1, total: 1 }, times: { ok: 1, total: 2 } },
          stamps: { 2: { place: 3, date: "2026-03-06" } },
        },
        {
          id: stored(storage).players[1].id, name: "Bo", hero: "uil", grade: 6,
          answers: {}, kinds: zero, stamps: {},
        },
      ],
    });
  });

  test("saves after every mutation and never when nothing changed", () => {
    const { storage, store, eva } = withEva();
    let writes = storage.log.sets.length;
    const expectWrite = (label, fn) => {
      fn();
      assert.equal(storage.log.sets.length, ++writes, label + " should save once");
    };
    const expectNoWrite = (label, fn) => {
      fn();
      assert.equal(storage.log.sets.length, writes, label + " should not save");
    };
    expectWrite("recordAnswer", () => store.recordAnswer("add:1", "add", "miss"));
    expectWrite("same answer again", () => store.recordAnswer("add:1", "add", "miss"));
    expectWrite("stamp", () => store.stamp(1, 3));
    expectWrite("better place", () => store.stamp(1, 2));
    expectWrite("setSetting", () => store.setSetting("sound", false));
    expectWrite("setGrade", () => store.setGrade(eva.id, 5));
    expectWrite("setHero", () => store.setHero(eva.id, "pad"));
    expectWrite("rename", () => store.rename(eva.id, "Eefje"));
    expectWrite("addPlayer", () => store.addPlayer({ name: "Bo", hero: "uil", grade: 3 }));
    expectWrite("select", () => store.select(store.players()[1].id));
    expectWrite("removePlayer", () => store.removePlayer(store.players()[1].id));
    expectWrite("resetProgress", () => store.resetProgress(eva.id));

    expectNoWrite("worse place", () => store.stamp(1, 4));
    expectNoWrite("setSetting same value", () => store.setSetting("sound", false));
    expectNoWrite("setGrade same value", () => store.setGrade(eva.id, 5));
    expectNoWrite("setHero same value", () => store.setHero(eva.id, "pad"));
    expectNoWrite("rename same name", () => store.rename(eva.id, "Eefje"));
    expectNoWrite("select same player", () => store.select(eva.id));
    expectNoWrite("resetProgress on empty profile", () => store.resetProgress(eva.id));
    expectNoWrite("invalid answer", () => store.recordAnswer("add:1", "add", "great"));
    expectNoWrite("invalid stamp", () => store.stamp(9, 1));
    expectNoWrite("invalid setting", () => store.setSetting("restAfter", 99));
    expectNoWrite("duplicate player", () => store.addPlayer({ name: "EEFJE", hero: "uil", grade: 3 }));
    expectNoWrite("unknown remove", () => store.removePlayer("nope"));
    expectNoWrite("reads", () => {
      store.players(); store.current(); store.settings(); store.stamps(); store.nextTrack();
      store.openKeys(3); store.trickyKeys(3); store.kindStats(); store.status();
    });
  });

  test("a fresh store with no stored data writes nothing until something changes", () => {
    const { storage, store } = fresh();
    store.setSetting("sound", true);
    store.select(null);
    store.recordAnswer("add:1", "add", "first");
    assert.equal(storage.log.sets.length, 0);
    assert.equal(storage.map.size, 0);
    store.setSetting("sound", false);
    assert.equal(storage.log.sets.length, 1);
  });

  test("the saved selection is restored on reload", () => {
    const { storage, store, eva } = withEva();
    const again = Store.create(storage);
    assert.deepEqual(again.current(), eva);
    assert.equal(again.recordAnswer("add:1", "add", "first"), true, "recording continues for the restored player");
  });
});

// ----------------------------------------------------------------------- failure modes

describe("failure modes", () => {
  const brokenStorages = [
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["an empty object", {}],
    ["no setItem", { getItem: () => null }],
    ["getItem returns undefined", { getItem: () => undefined, setItem() {}, removeItem() {} }],
  ];

  for (const [label, storage] of brokenStorages) {
    test("storage " + label + ": the store works in memory and says it is not persistent", () => {
      const store = Store.create(storage, () => noon(2026, 3, 5));
      const eva = store.addPlayer({ name: "Eva", hero: "egel", grade: 4 }).player;
      assert.equal(store.select(eva.id), true);
      assert.equal(store.recordAnswer("times:2x3", "times", "miss"), true);
      assert.equal(store.stamp(1, 2), true);
      assert.equal(store.setSetting("music", true), true);
      assert.deepEqual(store.openKeys(5), ["times:2x3"]);
      assert.equal(store.stamps()["1"].date, "2026-03-05");
      assert.equal(store.status().persistent, false);
      assert.equal(store.resetProgress(eva.id), true);
      assert.equal(store.removePlayer(eva.id), true);
    });
  }

  test("two memory-only stores do not share anything", () => {
    const a = Store.create(null);
    const b = Store.create(null);
    a.addPlayer({ name: "Eva", hero: "egel", grade: 4 });
    assert.deepEqual(b.players(), []);
  });

  test("getItem that always throws: works in memory and never writes", () => {
    const storage = flakyStorage({ [KEY]: JSON.stringify({ v: 1, counter: 0, current: null, settings: DEFAULT_SETTINGS, players: [] }) });
    storage.ctl.failGet = true;
    const store = Store.create(storage);
    assert.deepEqual(store.status(), { persistent: false, recovered: "unreadable" });
    const eva = store.addPlayer({ name: "Eva", hero: "egel", grade: 4 }).player;
    store.select(eva.id);
    store.recordAnswer("add:1", "add", "miss");
    assert.deepEqual(store.openKeys(3), ["add:1"]);
    assert.equal(storage.ctl.attempts, 0, "we could not read what is there, so we do not overwrite it");
    storage.ctl.failGet = false;
    assert.equal(stored(storage).players.length, 0);
    assert.equal(store.addPlayer({ name: "Bo", hero: "pad", grade: 3 }).ok, true);
    assert.equal(storage.ctl.attempts, 0, "still memory only for this instance");
  });

  test("getItem throwing later: the change is kept in memory and saved on the next good read", () => {
    const storage = flakyStorage();
    const store = Store.create(storage);
    store.addPlayer({ name: "Eva", hero: "egel", grade: 4 });
    storage.ctl.failGet = true;
    assert.equal(store.addPlayer({ name: "Bo", hero: "pad", grade: 3 }).ok, true);
    assert.equal(stored(storage).players.length, 1, "nothing written while unreadable");
    assert.equal(store.status().persistent, false);
    storage.ctl.failGet = false;
    store.setSetting("music", true);
    assert.deepEqual(stored(storage).players.map((p) => p.name), ["Eva", "Bo"]);
    assert.equal(store.status().persistent, true);
  });

  test("setItem that always throws: no exception, everything keeps working", () => {
    const storage = flakyStorage();
    storage.ctl.failSet = true;
    const store = Store.create(storage, () => noon(2026, 3, 5));
    const eva = store.addPlayer({ name: "Eva", hero: "egel", grade: 4 });
    assert.equal(eva.ok, true);
    store.select(eva.player.id);
    assert.equal(store.recordAnswer("add:1", "add", "second"), true);
    assert.equal(store.stamp(1, 2), true);
    assert.equal(store.setSetting("sound", false), true);
    assert.equal(store.setGrade(eva.player.id, 5), true);
    assert.deepEqual(store.openKeys(5), ["add:1"]);
    assert.equal(store.settings().sound, false);
    assert.equal(store.current().grade, 5);
    assert.deepEqual(store.status(), { persistent: false, recovered: null });
    assert.equal(storage.map.size, 0, "nothing reached the storage");
    assert.deepEqual(Store.create(storage).players(), []);
  });

  test("setItem failing and then recovering: the next save carries the whole document", () => {
    const storage = flakyStorage();
    const store = Store.create(storage);
    storage.ctl.failSet = true;
    const eva = store.addPlayer({ name: "Eva", hero: "egel", grade: 4 }).player;
    store.select(eva.id);
    store.recordAnswer("add:1", "add", "miss");
    assert.equal(store.status().persistent, false);
    storage.ctl.failSet = false;
    store.recordAnswer("add:2", "add", "first");
    assert.equal(store.status().persistent, true);
    const again = Store.create(storage);
    assert.deepEqual(again.players(), [eva]);
    assert.deepEqual(again.openKeys(9), ["add:1"]);
    assert.equal(again.kindStats()[0].total, 2);
  });

  test("a no-op after a failed save retries the save", () => {
    const storage = flakyStorage();
    const store = Store.create(storage);
    storage.ctl.failSet = true;
    store.addPlayer({ name: "Eva", hero: "egel", grade: 4 });
    storage.ctl.failSet = false;
    store.setSetting("sound", true);   // no change in the value, but the document is still unsaved
    assert.equal(storage.map.has(KEY), true, "the earlier change is saved now");
  });

  describe("unusable stored data starts fresh in memory", () => {
    const junk = [
      ["truncated JSON", '{"v":1,"counter":2,"players":[{"id":"p1","na'],
      ["not JSON at all", "hello world"],
      ["an empty string", ""],
      ["a JSON array", "[]"],
      ["a JSON string", '"v1"'],
      ["a JSON number", "7"],
      ["JSON null", "null"],
      ["JSON true", "true"],
      ["an object without a version", '{"players":[{"id":"p1","name":"Eva","hero":"egel","grade":4}]}'],
      ["a version of the wrong type", '{"v":"one","players":[]}'],
      ["version 0", '{"v":0,"players":[]}'],
      ["a negative version", '{"v":-1,"players":[]}'],
      ["a fractional version", '{"v":1.5,"players":[]}'],
      ["version null", '{"v":null,"players":[]}'],
      ["an absurdly large blob", '{"v":1,"players":[],"pad":"' + "x".repeat(2100000) + '"}'],
    ];
    for (const [label, raw] of junk) {
      test(label, () => {
        const { storage, store } = fresh({ [KEY]: raw });
        assert.deepEqual(store.players(), []);
        assert.equal(store.current(), null);
        assert.deepEqual(store.settings(), DEFAULT_SETTINGS);
        assert.equal(store.status().recovered, "corrupt");
        assert.equal(storage.map.get(KEY), raw, "reading alone never overwrites");
        store.setSetting("sound", true);
        assert.equal(storage.map.get(KEY), raw, "a no-op change does not overwrite either");
        const eva = store.addPlayer({ name: "Eva", hero: "egel", grade: 4 });
        assert.equal(eva.ok, true);
        assert.equal(store.select(eva.player.id), true);
        assert.equal(store.recordAnswer("add:1", "add", "miss"), true);
        checkDoc(stored(storage));
        assert.equal(Store.create(storage).players().length, 1, "the repaired document is what is stored now");
        assert.equal(store.status().persistent, true);
      });
    }

    test("a non-string value from getItem", () => {
      for (const value of [123, {}, [], true, NaN]) {
        const storage = { getItem: () => value, setItem(k, v) { this.last = v; }, removeItem() {} };
        const store = Store.create(storage);
        assert.deepEqual(store.players(), []);
        assert.equal(store.addPlayer({ name: "Eva", hero: "egel", grade: 4 }).ok, true);
        assert.equal(JSON.parse(storage.last).players.length, 1);
      }
    });
  });

  describe("a newer schema version is never destroyed", () => {
    const future = JSON.stringify({ v: 2, players: [{ id: "x1", name: "Toekomst", skills: { a: 1 } }], shiny: true });

    test("starts fresh in memory, leaves the blob alone until the user changes something", () => {
      const { storage, store } = fresh({ [KEY]: future });
      assert.deepEqual(store.players(), []);
      assert.equal(store.status().recovered, "future");
      store.setSetting("sound", true);
      store.select(null);
      assert.equal(storage.map.get(KEY), future);
      assert.equal(storage.log.sets.length, 0);
    });

    test("before overwriting, the blob is copied to a backup key", () => {
      const { storage, store } = fresh({ [KEY]: future });
      store.addPlayer({ name: "Eva", hero: "egel", grade: 4 });
      assert.equal(storage.map.get("rekenrace:v1:future-v2"), future);
      assert.equal(stored(storage).v, 1);
      assert.equal(stored(storage).players[0].name, "Eva");
      // later saves do not touch the backup again
      store.setSetting("music", true);
      assert.equal(storage.map.get("rekenrace:v1:future-v2"), future);
      assert.deepEqual(storage.log.sets, ["rekenrace:v1:future-v2", KEY, KEY]);
    });

    test("other version numbers (also as a string) count as newer", () => {
      for (const v of [2, 3, 99, "2", 1000000]) {
        const raw = JSON.stringify({ v, players: [] });
        const { storage, store } = fresh({ [KEY]: raw });
        assert.equal(store.status().recovered, "future", String(v));
        store.setSetting("music", true);
        assert.equal(storage.map.get("rekenrace:v1:future-v" + v), raw);
      }
    });

    test("if the backup cannot be written the blob is NOT overwritten (we stay in memory)", () => {
      const storage = flakyStorage({ [KEY]: future });
      storage.ctl.failSetKeys = ["rekenrace:v1:future-v2"];
      const store = Store.create(storage);
      const eva = store.addPlayer({ name: "Eva", hero: "egel", grade: 4 });
      assert.equal(eva.ok, true);
      assert.deepEqual(store.players().map((p) => p.name), ["Eva"], "still usable in memory");
      assert.equal(storage.map.get(KEY), future, "the newer data is intact");
      assert.equal(store.status().persistent, false);
      // when the backup works again the write goes through
      storage.ctl.failSetKeys = [];
      store.setSetting("music", true);
      assert.equal(storage.map.get("rekenrace:v1:future-v2"), future);
      assert.deepEqual(stored(storage).players.map((p) => p.name), ["Eva"]);
    });
  });

  test("storage cleared by someone else: our memory copy is written back on the next change", () => {
    const { storage, store } = withEva();
    storage.map.delete(KEY);
    store.setSetting("music", true);
    assert.equal(stored(storage).players[0].name, "Eva");
    assert.equal(stored(storage).settings.music, true);
  });

  test("storage replaced by garbage meanwhile: our memory copy wins and repairs it", () => {
    const { storage, store } = withEva();
    storage.map.set(KEY, "{{{{");
    store.setSetting("music", true);
    checkDoc(stored(storage));
    assert.equal(stored(storage).players[0].name, "Eva");
  });
});

// ----------------------------------------------------------------------- two tabs

describe("two tabs on one storage", () => {
  test("a stale tab does not overwrite what the other tab saved", () => {
    const storage = fakeStorage();
    const a = Store.create(storage);
    const b = Store.create(storage);
    const eva = a.addPlayer({ name: "Eva", hero: "egel", grade: 4 }).player;
    const bo = b.addPlayer({ name: "Bo", hero: "pad", grade: 3 }).player;   // b was stale
    assert.notEqual(eva.id, bo.id, "ids stay unique across tabs");
    assert.deepEqual(stored(storage).players.map((p) => p.name), ["Eva", "Bo"]);
    assert.deepEqual(b.players().map((p) => p.name), ["Eva", "Bo"]);
    // a is stale now, but its next change adopts b's data first
    a.setSetting("music", true);
    assert.deepEqual(a.players().map((p) => p.name), ["Eva", "Bo"]);
    assert.deepEqual(stored(storage).players.map((p) => p.name), ["Eva", "Bo"]);
    assert.equal(stored(storage).settings.music, true);
  });

  test("the selected player is per tab: answers always go to the player that tab selected", () => {
    const storage = fakeStorage();
    const a = Store.create(storage);
    const eva = a.addPlayer({ name: "Eva", hero: "egel", grade: 4 }).player;
    const bo = a.addPlayer({ name: "Bo", hero: "pad", grade: 3 }).player;
    const b = Store.create(storage);
    a.select(eva.id);
    b.select(bo.id);
    assert.equal(a.recordAnswer("add:1", "add", "miss"), true);
    assert.equal(b.recordAnswer("sub:1", "sub", "miss"), true);
    assert.equal(a.recordAnswer("add:2", "add", "miss"), true);
    assert.equal(a.current().id, eva.id);
    assert.equal(b.current().id, bo.id);
    const check = Store.create(storage);
    assert.deepEqual(check.openKeys(9, eva.id), ["add:2", "add:1"]);
    assert.deepEqual(check.openKeys(9, bo.id), ["sub:1"]);
    checkDoc(stored(storage));
  });

  test("a player removed in another tab: this tab's selection is cleared, recording fails cleanly", () => {
    const storage = fakeStorage();
    const a = Store.create(storage);
    const eva = a.addPlayer({ name: "Eva", hero: "egel", grade: 4 }).player;
    a.select(eva.id);
    const b = Store.create(storage);
    b.removePlayer(eva.id);
    assert.equal(a.recordAnswer("add:1", "add", "miss"), false);
    assert.equal(a.stamp(1, 1), false);
    assert.deepEqual(a.players(), []);
    assert.equal(a.current(), null);
    checkDoc(stored(storage));
  });

  test("both tabs add answers for the same player: neither loses the other's", () => {
    const storage = fakeStorage();
    const a = Store.create(storage);
    const eva = a.addPlayer({ name: "Eva", hero: "egel", grade: 4 }).player;
    a.select(eva.id);
    const b = Store.create(storage);
    b.select(eva.id);
    a.recordAnswer("add:1", "add", "miss");
    b.recordAnswer("add:2", "add", "miss");
    a.recordAnswer("add:3", "add", "miss");
    const check = Store.create(storage);
    assert.deepEqual(check.openKeys(9, eva.id), ["add:3", "add:2", "add:1"]);
    assert.equal(check.kindStats(eva.id)[0].total, 3);
  });
});

// ----------------------------------------------------------------------- loading odd documents

describe("repairing stored documents", () => {
  // Corrupts a valid document in one specific way, loads it, forces a save and checks the result.
  function load(mutate) {
    const base = JSON.parse(richStorage().map.get(KEY));
    const doc = mutate(base) || base;
    const storage = fakeStorage({ [KEY]: JSON.stringify(doc) });
    const store = Store.create(storage, () => noon(2026, 3, 5));
    // a real change so that the repaired document is written out
    store.setSetting("restAfter", store.settings().restAfter === 9 ? 8 : 9);
    const out = stored(storage);
    checkDoc(out);
    return { store, out, storage };
  }

  test("an intact document survives a load/save cycle unchanged", () => {
    const { out } = load(() => undefined);
    const orig = JSON.parse(richStorage().map.get(KEY));
    orig.settings.restAfter = 9;
    assert.deepEqual(out, orig);
  });

  test("players that are not an array / not objects", () => {
    assert.deepEqual(load((d) => { d.players = {}; }).out.players, []);
    assert.deepEqual(load((d) => { d.players = "Eva"; }).out.players, []);
    assert.deepEqual(load((d) => { d.players = null; }).out.players, []);
    assert.deepEqual(load((d) => { delete d.players; }).out.players, []);
    const r = load((d) => { d.players = [null, 5, "x", [], d.players[0], true]; });
    assert.deepEqual(r.out.players.map((p) => p.name), ["Eva"]);
  });

  test("more than 8 players: the first 8 are kept", () => {
    const r = load((d) => {
      d.players = Array.from({ length: 20 }, (_, i) => ({ id: "p" + (i + 1), name: "Kind " + i, hero: "pad", grade: 4 }));
    });
    assert.equal(r.out.players.length, 8);
    assert.equal(r.out.players[7].name, "Kind 7");
  });

  test("grade: digit strings are accepted, junk falls back to groep 4", () => {
    const grades = [["5", 5], [5.0, 5], ["abc", 4], [99, 4], [2, 4], [4.5, 4], [null, 4], [[5], 4], [{}, 4], [-3, 4], ["", 4]];
    for (const [input, expected] of grades) {
      const r = load((d) => { d.players[0].grade = input; });
      assert.equal(r.out.players[0].grade, expected, JSON.stringify(input));
    }
  });

  test("hero: unknown values fall back to the first hero", () => {
    for (const hero of ["draak", 5, null, "EGEL", ["pad"]]) {
      assert.equal(load((d) => { d.players[0].hero = hero; }).out.players[0].hero, "egel", JSON.stringify(hero));
    }
    assert.equal(load((d) => { d.players[0].hero = "uil"; }).out.players[0].hero, "uil");
  });

  test("names are cleaned again; empty ones become 'Speler'; duplicates get a number", () => {
    assert.equal(load((d) => { d.players[0].name = "  Eva   Lang  "; }).out.players[0].name, "Eva Lang");
    assert.equal(load((d) => { d.players[0].name = 123; }).out.players[0].name, "123");
    for (const bad of [undefined, null, "", "   ", [], {}, true, "\u0000"]) {
      assert.equal(load((d) => { d.players[0].name = bad; }).out.players[0].name, "Speler", JSON.stringify(bad));
    }
    assert.equal(load((d) => { d.players[0].name = "x".repeat(40); }).out.players[0].name, "xxxxxxxxxxxx");
    const dup = load((d) => { d.players[1].name = "EVA"; d.players[2].name = "eva"; });
    assert.deepEqual(dup.out.players.map((p) => p.name), ["Eva", "EVA 2", "eva 3"]);
    const long = load((d) => { d.players[0].name = "Abcdefghijkl"; d.players[1].name = "ABCDEFGHIJKL"; });
    assert.equal(long.out.players[1].name, "ABCDEFGHIJ 2");
    assert.ok(cps(long.out.players[1].name) <= 12);
  });

  test("ids: invalid and duplicate ids are replaced, valid ones keep their identity", () => {
    const r = load((d) => {
      d.players[0].id = "p1";
      d.players[1].id = "p1";            // duplicate
      d.players[2].id = "../x";          // invalid
      d.current = "p1";
    });
    const ids = r.out.players.map((p) => p.id);
    assert.equal(ids[0], "p1");
    assert.equal(new Set(ids).size, 3);
    assert.equal(r.out.current, "p1");
    for (const bad of [5, null, "", "__proto__", "P1", "p", "p1 ", "pÃ©", {}, "p" + "z".repeat(30)]) {
      const q = load((d) => { d.players[0].id = bad; });
      assert.match(q.out.players[0].id, /^p[0-9a-z]+$/, JSON.stringify(bad));
    }
  });

  test("the id counter is repaired and ahead of every id (no id reuse after load)", () => {
    for (const counter of [undefined, null, "x", -5, 0, "2", 1e30, [], {}]) {
      const r = load((d) => { d.counter = counter; d.players[0].id = "p9"; });
      const maxId = Math.max(...r.out.players.map((p) => parseInt(p.id.slice(1), 36)));
      assert.ok(r.out.counter >= maxId, JSON.stringify(counter));
      const added = r.store.addPlayer({ name: "Nieuw", hero: "pad", grade: 3 }).player;
      assert.ok(!r.out.players.some((p) => p.id === added.id), "fresh id after load " + JSON.stringify(counter));
    }
  });

  test("current pointing at nothing is cleared; a valid one is kept", () => {
    for (const cur of ["p404", 5, null, {}, [], undefined, ""]) {
      assert.equal(load((d) => { d.current = cur; }).out.current, null, JSON.stringify(cur));
    }
    const first = JSON.parse(richStorage().map.get(KEY)).players[0].id;
    assert.equal(load((d) => { d.current = first; }).out.current, first);
  });

  test("answers / kinds / stamps of the wrong shape are replaced by empty ones", () => {
    for (const bad of [[], "x", 5, null, true]) {
      const r = load((d) => { d.players[0].answers = bad; d.players[0].kinds = bad; d.players[0].stamps = bad; });
      assert.deepEqual(r.out.players[0].answers, {});
      assert.deepEqual(r.out.players[0].stamps, {});
      assert.deepEqual(r.out.players[0].kinds, Object.fromEntries(KINDS.map((k) => [k, { ok: 0, total: 0 }])));
    }
  });

  test("kinds: unknown kinds dropped, missing ones filled in, order restored", () => {
    const r = load((d) => {
      d.players[0].kinds = { story: { ok: 2, total: 5 }, bogus: { ok: 9, total: 9 }, add: "many", times: [1] };
    });
    const k = r.out.players[0].kinds;
    assert.deepEqual(Object.keys(k), KINDS);
    assert.deepEqual(k.story, { ok: 2, total: 5 });
    assert.deepEqual(k.add, { ok: 0, total: 0 });
    assert.ok(!("bogus" in k));
  });

  test("stamps: only tracks 1..8 and places 1..4; bad dates are repaired", () => {
    const r = load((d) => {
      d.players[0].stamps = {
        0: { place: 1, date: "2026-01-01" },
        1: { place: 2, date: "2026-01-01" },
        2: { place: 5, date: "2026-01-01" },
        3: { place: "2", date: "2026-02-30" },
        4: { place: 0, date: "2026-01-01" },
        5: { place: 3, date: "gisteren" },
        6: "stamp",
        7: { place: 4, date: 20260101 },
        8: { place: 1, date: "2026-13-01" },
        9: { place: 1, date: "2026-01-01" },
        x: { place: 1, date: "2026-01-01" },
      };
    });
    const s = r.out.players[0].stamps;
    assert.deepEqual(Object.keys(s), ["1", "3", "5", "7", "8"]);
    assert.deepEqual(s["1"], { place: 2, date: "2026-01-01" });
    assert.deepEqual(s["3"], { place: 2, date: "2026-02-30" }, "a shape-valid date is kept (only the format is checked)");
    assert.deepEqual(s["5"], { place: 3, date: "2026-03-05" }, "unusable dates become the load date");
    assert.deepEqual(s["7"], { place: 4, date: "2026-03-05" });
    assert.deepEqual(s["8"], { place: 1, date: "2026-03-05" });
  });

  test("settings: each bad value falls back to its own default", () => {
    const r = load((d) => { d.settings = { sound: "yes", music: 1, restAfter: 99 }; });
    assert.deepEqual(r.out.settings, { sound: true, music: false, restAfter: 9 });
    assert.deepEqual(load((d) => { d.settings = { sound: false, music: true, restAfter: "4" }; }).out.settings.sound, false);
    assert.equal(load((d) => { d.settings = { sound: false, music: true, restAfter: "4" }; }).out.settings.music, true);
    for (const bad of [null, [], "x", 5, undefined]) {
      const s = load((d) => { d.settings = bad; }).out.settings;
      assert.deepEqual(s, { sound: true, music: false, restAfter: 9 });
    }
    assert.equal(load((d) => { d.settings = { restAfter: -1 }; }).store.settings().restAfter, 9);
  });

  test("version given as a digit string is accepted; extra top-level fields are dropped", () => {
    const r = load((d) => { d.v = "1"; d.mystery = { a: 1 }; });
    assert.equal(r.out.v, 1);
    assert.ok(!("mystery" in r.out));
    assert.equal(r.out.players.length, 3);
  });

  test("a weird but valid-JSON key such as 'constructor' or 'toString' is just a normal key", () => {
    const { store } = withEva();
    assert.equal(store.recordAnswer("constructor", "add", "miss"), true);
    assert.equal(store.recordAnswer("toString", "add", "miss"), true);
    assert.equal(store.recordAnswer("hasOwnProperty", "add", "second"), true);
    assert.deepEqual(store.openKeys(9), ["hasOwnProperty", "toString", "constructor"]);
    assert.equal(store.trickyKeys(9).length, 2);
  });
});

describe("fuzzing stored documents", () => {
  function junk(rng, depth = 0) {
    const choices = [
      () => null, () => true, () => false, () => -1, () => 0, () => 1, () => 1e15, () => 0.5, () => -0.5,
      () => "", () => "abc", () => "5", () => "  7  ", () => "\u0000​", () => "x".repeat(300), () => "p1",
      () => [], () => {}, () => [1, 2, 3], () => ({ a: 1 }), () => "__proto__", () => "2026-01-01", () => "\ud800",
      () => (depth < 3 ? [junk(rng, depth + 1), junk(rng, depth + 1)] : []),
      () => (depth < 3 ? { place: junk(rng, depth + 1), ok: junk(rng, depth + 1) } : {}),
    ];
    return choices[Math.floor(rng() * choices.length)]();
  }
  function mangle(rng, v, depth = 0) {
    if (rng() < 0.07) return junk(rng);
    if (Array.isArray(v)) {
      let out = v.map((x) => mangle(rng, x, depth + 1));
      if (rng() < 0.15) out = out.concat(out);
      if (rng() < 0.15) out = out.slice(Math.floor(rng() * out.length));
      return out;
    }
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        if (rng() < 0.05) continue;
        const key = rng() < 0.05 ? junk(rng) + "" : k;
        out[key] = mangle(rng, x, depth + 1);
      }
      if (rng() < 0.05) out["extra" + Math.floor(rng() * 9)] = junk(rng);
      return out;
    }
    return v;
  }

  test("400 randomly damaged documents: no exception, a usable store, a valid document afterwards", () => {
    const base = JSON.parse(richStorage().map.get(KEY));
    // make the base bigger so there is more to damage
    base.players.forEach((p, i) => {
      for (let n = 0; n < 30; n++) p.answers["add:" + i + "-" + n] = { kind: "add", ok: 1, miss: n % 3, last: "second", t: 100 + n };
    });
    for (let seed = 1; seed <= 400; seed++) {
      const rng = Rng.make(seed * 31337);
      const damaged = mangle(rng, base);
      const storage = fakeStorage({ [KEY]: JSON.stringify(damaged) });
      let store;
      assert.doesNotThrow(() => { store = Store.create(storage, () => noon(2026, 3, 5)); }, "seed " + seed);
      assert.doesNotThrow(() => {
        store.players(); store.current(); store.settings(); store.stamps(); store.nextTrack();
        store.openKeys(5); store.trickyKeys(5); store.kindStats(); store.status();
        const added = store.addPlayer({ name: "Nieuw" + (seed % 5), hero: "pad", grade: 3 });
        const target = added.ok ? added.player.id : (store.players()[0] || {}).id;
        if (target) store.select(target);
        store.recordAnswer("times:" + seed, "times", OUTCOMES[seed % 3]);
        store.stamp(1 + (seed % 8), 1 + (seed % 4));
        store.setGrade(target, 3 + (seed % 4));
        store.rename(target, "Naam " + seed);
        store.resetProgress(seed % 7 === 0 ? target : "nope");
        store.recordAnswer("div:" + seed, "div", "miss");
      }, "seed " + seed);
      store.setSetting("restAfter", (store.settings().restAfter + 1) % 11);
      if (storage.map.has(KEY) && storage.log.sets.length) {
        const doc = JSON.parse(storage.map.get(KEY));
        if (doc.v === 1) checkDoc(doc);
      }
      // what the store holds in memory must be exactly what a reload sees
      const again = Store.create(storage);
      assert.deepEqual(again.players(), store.players(), "seed " + seed);
      assert.deepEqual(again.settings(), store.settings());
    }
  });
});

// ----------------------------------------------------------------------- browserStorage

describe("browserStorage", () => {
  // Installs (or removes) a fake global localStorage for the duration of fn.
  function withGlobalLocalStorage(descriptor, fn) {
    const had = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    if (descriptor) Object.defineProperty(globalThis, "localStorage", { configurable: true, ...descriptor });
    else delete globalThis.localStorage;
    try { return fn(); } finally {
      if (had) Object.defineProperty(globalThis, "localStorage", had); else delete globalThis.localStorage;
    }
  }

  function stubLocalStorage(overrides = {}) {
    const map = new Map();
    return Object.assign({
      map,
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => { map.set(k, String(v)); },
      removeItem: (k) => { map.delete(k); },
    }, overrides);
  }

  test("under plain Node (no window, no localStorage) it returns a working memory fallback", () => {
    withGlobalLocalStorage(null, () => {
      assert.equal(typeof window, "undefined");
      const s = Store.browserStorage();
      assert.equal(typeof s.getItem, "function");
      assert.equal(typeof s.setItem, "function");
      assert.equal(typeof s.removeItem, "function");
      assert.equal(s.getItem("a"), null);
      s.setItem("a", "1");
      assert.equal(s.getItem("a"), "1");
      s.setItem("a", 2);
      assert.equal(s.getItem("a"), "2", "values are stored as strings, like localStorage");
      s.removeItem("a");
      assert.equal(s.getItem("a"), null);
      s.removeItem("never-set");
      assert.equal(s.persistent(), false);
      assert.notEqual(Store.browserStorage().getItem("x"), "1", "separate instances do not share memory");
    });
  });

  test("a Store on the memory fallback works and reloads from it", () => {
    withGlobalLocalStorage(null, () => {
      const s = Store.browserStorage();
      const store = Store.create(s);
      store.addPlayer({ name: "Eva", hero: "egel", grade: 4 });
      assert.deepEqual(Store.create(s).players().map((p) => p.name), ["Eva"]);
      assert.equal(store.status().persistent, false);
    });
  });

  test("it wraps a real localStorage when there is one", () => {
    const ls = stubLocalStorage();
    withGlobalLocalStorage({ value: ls }, () => {
      const s = Store.browserStorage();
      assert.equal(s.persistent(), true);
      s.setItem("k", "v");
      assert.equal(ls.map.get("k"), "v");
      assert.equal(s.getItem("k"), "v");
      ls.map.set("other", "tab");
      assert.equal(s.getItem("other"), "tab", "reads go to the real storage");
      s.removeItem("k");
      assert.equal(ls.map.has("k"), false);
      assert.equal(ls.map.has("rekenrace:probe"), false, "the availability probe cleans up after itself");
      const store = Store.create(s);
      store.addPlayer({ name: "Eva", hero: "egel", grade: 4 });
      assert.equal(JSON.parse(ls.map.get(KEY)).players[0].name, "Eva");
      assert.equal(store.status().persistent, true);
    });
  });

  test("a throwing localStorage getter (blocked storage) falls back to memory without throwing", () => {
    withGlobalLocalStorage({ get() { throw new Error("SecurityError: the operation is insecure"); } }, () => {
      let s;
      assert.doesNotThrow(() => { s = Store.browserStorage(); });
      s.setItem("k", "v");
      assert.equal(s.getItem("k"), "v");
      assert.equal(s.persistent(), false);
    });
  });

  test("localStorage that refuses writes at the start (private mode) uses memory", () => {
    const ls = stubLocalStorage({ setItem() { throw new Error("QuotaExceededError"); } });
    withGlobalLocalStorage({ value: ls }, () => {
      const s = Store.browserStorage();
      s.setItem("k", "v");
      assert.equal(s.getItem("k"), "v");
      assert.equal(ls.map.size, 0);
      assert.equal(s.persistent(), false);
    });
  });

  test("a write that fails later is kept in memory and shadows the older real value", () => {
    const ls = stubLocalStorage();
    withGlobalLocalStorage({ value: ls }, () => {
      const s = Store.browserStorage();
      s.setItem("k", "old");
      ls.setItem = () => { throw new Error("QuotaExceededError"); };
      s.setItem("k", "new");
      assert.equal(s.getItem("k"), "new");
      assert.equal(ls.map.get("k"), "old");
      assert.equal(s.persistent(), false);
      // once writes work again the real storage catches up and the shadow is dropped
      ls.setItem = (k, v) => { ls.map.set(k, String(v)); };
      s.setItem("k", "newer");
      assert.equal(ls.map.get("k"), "newer");
      assert.equal(s.getItem("k"), "newer");
      assert.equal(s.persistent(), true);
    });
  });

  test("getItem/removeItem failures never throw", () => {
    const ls = stubLocalStorage();
    withGlobalLocalStorage({ value: ls }, () => {
      const s = Store.browserStorage();
      ls.getItem = () => { throw new Error("boom"); };
      ls.removeItem = () => { throw new Error("boom"); };
      assert.equal(s.getItem("anything"), null);
      assert.doesNotThrow(() => s.removeItem("anything"));
    });
  });

  test("an object that merely looks like localStorage but has no getItem is ignored", () => {
    withGlobalLocalStorage({ value: {} }, () => {
      const s = Store.browserStorage();
      s.setItem("k", "v");
      assert.equal(s.getItem("k"), "v");
      assert.equal(s.persistent(), false);
    });
  });
});

// ----------------------------------------------------------------------- purity

describe("purity", () => {
  test("never reads the wall clock, Math.random, window, document or localStorage", () => {
    const RealDate = Date;
    class GuardedDate extends RealDate {
      constructor(...args) {
        if (args.length === 0) throw new Error("new Date() reads the wall clock");
        super(...args);
      }
      static now() { throw new Error("Date.now() reads the wall clock"); }
    }
    const realRandom = Math.random;
    const trap = (name) => ({ configurable: true, get() { throw new Error(name + " touched by a pure module"); } });
    const had = {};
    for (const n of ["window", "document", "localStorage", "sessionStorage"]) {
      had[n] = Object.getOwnPropertyDescriptor(globalThis, n);
      Object.defineProperty(globalThis, n, trap(n));
    }
    globalThis.Date = GuardedDate;
    Math.random = () => { throw new Error("Math.random() used"); };
    try {
      const storage = fakeStorage();
      const store = Store.create(storage, () => 1760000000000);
      const eva = store.addPlayer({ name: "Eva", hero: "egel", grade: 4 }).player;
      store.select(eva.id);
      for (let i = 0; i < 30; i++) store.recordAnswer("times:" + i, "times", OUTCOMES[i % 3]);
      store.stamp(1, 2);
      store.setSetting("music", true);
      store.rename(eva.id, "Eefje");
      store.resetProgress(eva.id);
      Store.create(storage, () => 5).openKeys(3);
      Store.create(storage, () => { throw new Error("clock"); }).stamp(2, 1);
    } finally {
      globalThis.Date = RealDate;
      Math.random = realRandom;
      for (const n of Object.keys(had)) {
        if (had[n]) Object.defineProperty(globalThis, n, had[n]); else delete globalThis[n];
      }
    }
  });

  test("two stores fed the same inputs end up with byte-identical documents", () => {
    const run = () => {
      const { storage, store } = fresh({}, () => noon(2026, 3, 5));
      const a = store.addPlayer({ name: "Eva", hero: "egel", grade: 4 }).player;
      store.select(a.id);
      store.recordAnswer("add:1", "add", "miss");
      store.stamp(2, 1);
      return storage.map.get(KEY);
    };
    assert.equal(run(), run());
  });

  test("the store exposes its limits for the UI", () => {
    assert.deepEqual({ ...Store.LIMITS }, { nameLength: 12, players: 8, answers: 400, restAfter: 10 });
    assert.ok(Object.isFrozen(Store.LIMITS));
  });
});
