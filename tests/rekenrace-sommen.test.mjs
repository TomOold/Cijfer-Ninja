// Tests for RR.Questions (the Rekenrace question engine).
//
// Everything is verified by independent recomputation: the tests parse the
// displayed text with their own regexes, solve the unknown themselves and
// compare with `answer` and `formula`; they never call the engine's helpers.
//
// Run during development with the part files:
//   RR_PARTS_DIR=<scratchpad>/parts node --test tests/rekenrace-sommen.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { laadRR } from "./helpers/rekenrace-laden.mjs";

const RR = laadRR();
const Q = RR.Questions;

const MIN = "−";
const KEER = "×";
const GRADES = [3, 4, 5, 6];
const LEVELS = [1, 2, 3, 4, 5, 6, 7, 8];
const FOCI = ["mix", "add", "sub", "times", "div", "story"];
const SEEDS = 300;

// ------------------------------------------------------------------ helpers

const numsIn = (text) => (text.match(/\d+/g) || []).map(Number);
const hasNum = (text, n) => new RegExp(`(^|[^0-9])${n}([^0-9]|$)`).test(text);
const rng = (seed) => RR.Rng.make(seed);

const OPS = {
  "+": (a, b) => a + b,
  [MIN]: (a, b) => a - b,
  [KEER]: (a, b) => a * b,
  ":": (a, b) => a / b,
};
const OP_NAME = { "+": "add", [MIN]: "sub", [KEER]: "times", ":": "div" };
const OP_KEY = { "+": "+", [MIN]: "-", [KEER]: "x", ":": ":" };

const PLAIN_RE = new RegExp(`^(\\d+) ([+${MIN}${KEER}:]) (\\d+) = \\?$`);
const GAP_RE = new RegExp(`^(\\?|\\d+) ([+${MIN}${KEER}:]) (\\?|\\d+) = (\\d+)$`);

// Solve an arithmetic question from its display text alone.
function solveText(text) {
  let m = PLAIN_RE.exec(text);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[3]);
    return { gap: false, op: m[2], a, b, value: OPS[m[2]](a, b) };
  }
  m = GAP_RE.exec(text);
  if (!m) return null;
  const op = m[2];
  const c = Number(m[4]);
  let a;
  let b;
  if (m[1] === "?") {
    b = Number(m[3]);
    a = op === "+" ? c - b : op === MIN ? c + b : op === KEER ? c / b : c * b;
    return { gap: true, op, unknown: "a", a, b, c, value: a };
  }
  a = Number(m[1]);
  b = op === "+" ? c - a : op === MIN ? a - c : op === KEER ? c / a : a / c;
  return { gap: true, op, unknown: "b", a, b, c, value: b };
}

// Tiny arithmetic evaluator for `formula` (numbers, + - * / and brackets).
function evalFormula(f) {
  assert.match(f, /^[0-9+\-*/() ]+$/, `formula has odd characters: ${f}`);
  return Function(`"use strict"; return (${f});`)();
}

// What every story template means, written down independently of the engine.
const STORY_RULES = {
  tulpen: (a, b) => a + b,
  schelpen: (a, b) => a + b,
  fietsen: (a, b) => a + b,
  rondvaart: (a, b) => a + b,
  koeien: (a, b) => a + b,
  bollen: (a, b) => a + b,
  zakken: (a, b) => a - b,
  boten: (a, b) => a - b,
  bekers: (a, b) => a - b,
  appels: (a, b) => a - b,
  schelpweg: (a, b) => a - b,
  eieren: (a, b) => a * b,
  rijen: (a, b) => a * b,
  mensen: (a, b) => a * b,
  emmers: (a, b) => a * b,
  fietsrijen: (a, b) => a * b,
  meel: (a, b) => a * b,
  verdeel: (a, b) => a / b,
  dozen: (a, b) => a / b,
  tochtje: (a, b) => a / b,
  plantrijen: (a, b) => a / b,
  koekjes: (a, b) => a / b,
  bakken: (a, b, c) => a * b + c,
  kratten: (a, b, c) => a * b - c,
  haven: (a, b, c) => a + b - c,
  weekschelpen: (a, b, c) => a + b + c,
  broodjes: (a, b, c) => a - b - c,
  kisten: (a, b, c) => (a * b) / c,
  knikkers: (a, b, c) => a / b + c,
  // thousands-level stories (review: tulips, shells and boats must not reach absurd numbers)
  feestmensen: (a, b) => a + b,
  kaartjes: (a, b) => a - b,
  bezoekers: (a, b, c) => a + b + c,
  feestdrukte: (a, b, c) => a + b - c,
};

const ENGLISH = /\b(the|and|minus|plus|times|divided|what|how|answer|correct|wrong|score)\b/i;

// Every invariant that holds for one question. `light` skips the slower lint;
// 'cheap' also skips the formula evaluation and the fromKey round trip.
function checkQuestion(q, light = false) {
  const ctx = `${q.key} | ${q.text}`;
  assert.deepEqual(Object.keys(q), ["key", "kind", "text", "answer", "hint", "explain", "formula"], ctx);
  assert.ok(q.kind in Q.KINDS, `kind ${q.kind}`);
  assert.equal(typeof q.key, "string");
  assert.ok(Number.isInteger(q.answer) && q.answer >= 0 && q.answer <= 9999, `answer ${q.answer} (${ctx})`);
  assert.ok(q.hint.length > 0 && q.explain.length > 0, ctx);

  // texts: no negatives, no division sign, every number below 10000
  for (const field of [q.text, q.hint, q.explain]) {
    assert.ok(!field.includes("÷"), `no division sign: ${ctx}`);
    assert.ok(!/(^|[\s(])-\s?\d/.test(field), `no ascii minus: ${field}`);
    assert.ok(!/=\s*−/.test(field), `no negative result: ${field}`);
    assert.ok(!/\d[.,]\d{3}/.test(field), `no thousands separator: ${field}`);
    for (const n of numsIn(field)) assert.ok(n < 10000, `number ${n} >= 10000 in: ${field}`);
  }
  assert.ok(!q.hint.includes("\n"), "hint is one line");
  assert.ok(q.explain.split("\n").length <= 3, `explain has at most 3 lines: ${q.explain}`);
  assert.ok(!hasNum(q.hint, q.answer), `hint leaks the answer ${q.answer}: ${q.hint} (${ctx})`);
  assert.ok(hasNum(q.explain, q.answer), `explain lacks the answer ${q.answer}: ${q.explain} (${ctx})`);

  // formula evaluates to the answer
  if (light !== "cheap") assert.equal(evalFormula(q.formula), q.answer, `formula ${q.formula} (${ctx})`);

  if (q.kind === "story") {
    assert.ok(q.text.endsWith("?") && q.text.split("?").length === 2, `story ends in one question: ${q.text}`);
    assert.ok(!q.text.includes("{"), q.text);
    const [, id, ...keyNums] = q.key.split(":");
    const nums = numsIn(q.text);
    assert.deepEqual(nums, keyNums.map(Number), `numbers in text follow the key: ${ctx}`);
    assert.ok(nums.every((n) => n >= 2), `every story number >= 2: ${q.text}`);
    assert.ok(id in STORY_RULES, `known story template ${id}`);
    assert.equal(STORY_RULES[id](...nums), q.answer, `story meaning ${q.key}`);
    assert.deepEqual(numsIn(q.formula), nums, `formula uses the numbers of the text: ${q.formula} vs ${q.text}`);
    assert.ok(nums.length === 2 || nums.length === 3);
  } else {
    assert.equal(q.text.split("?").length, 2, `exactly one ? in: ${q.text}`);
    assert.match(q.text, /^[0-9 +−×:=?]+$/, `plain text: ${q.text}`);
    const s = solveText(q.text);
    assert.ok(s, `parsable text: ${q.text}`);
    assert.ok(Number.isInteger(s.value) && s.value >= 0, `integer solution of ${q.text}: ${s.value}`);
    assert.equal(s.value, q.answer, `answer of ${q.text}`);
    if (s.gap) {
      assert.equal(q.kind, "gap");
      assert.equal(OPS[s.op](s.a, s.b), s.c, `gap equation holds: ${q.text}`);
      assert.ok(s.a >= 1 && s.b >= 1, q.text);
      const A = s.unknown === "a" ? "?" : s.a;
      const B = s.unknown === "b" ? "?" : s.b;
      assert.equal(q.key, `gap:${OP_NAME[s.op]}:${A}${OP_KEY[s.op]}${B}=${s.c}`);
    } else {
      assert.equal(q.kind, OP_NAME[s.op]);
      assert.equal(q.key, s.op === ":" ? `div:${s.a}:${s.b}` : `${q.kind}:${s.a}${OP_KEY[s.op]}${s.b}`);
      if (s.op === ":") assert.ok(s.a % s.b === 0, `division is exact: ${q.text}`);
      if (light !== "cheap") assert.equal(evalFormula(`${s.a}${s.op === MIN ? "-" : s.op === KEER ? "*" : s.op === ":" ? "/" : "+"}${s.b}`), q.answer);
    }
    if (s.op === ":" || q.text.includes(":")) {
      // a division sum is always exact, also when the gap hides a factor
      assert.ok(Number.isInteger(s.gap ? s.value : s.a / s.b));
    }
  }

  // rebuilding from the key gives exactly the same question
  if (light !== "cheap") assert.deepEqual(Q.fromKey(q.key), q, `fromKey round trip: ${q.key}`);

  if (!light) {
    for (const field of [q.hint, q.explain]) {
      assert.ok(!/undefined|NaN|\[object|\bnull\b/.test(field), field);
      assert.ok(!/ {2}| [.,;!]/.test(field), `spacing: ${field}`);
      assert.ok(!ENGLISH.test(field), `english word in: ${field}`);
      assert.ok(!/!/.test(field), `calm tone, no exclamation mark: ${field}`);
      assert.ok(!/\b[A-Z]{3,}\b/.test(field), `no ALL CAPS: ${field}`);
      for (const line of field.split("\n")) {
        assert.match(line, /^[A-Z0-9É?]/, `line starts with a capital: ${line}`);
        assert.match(line, /[.?]$/, `line ends with a full stop: ${line}`);
      }
    }
    assert.ok(!ENGLISH.test(q.text), q.text);
  }
}

// ------------------------------------------------------------ the contract

test("exports the documented API", () => {
  assert.deepEqual(Q.KINDS, {
    add: "Optellen",
    sub: "Aftrekken",
    times: "Tafels",
    div: "Delen",
    gap: "Gaatjessommen",
    story: "Verhaalsommen",
  });
  assert.deepEqual([...Q.FOCI], ["mix", "add", "sub", "times", "div", "story"]);
  for (const fn of ["make", "series", "fromKey", "check"]) assert.equal(typeof Q[fn], "function", fn);
});

test("make: every grade x level x focus gives valid, independently recomputed questions", () => {
  for (const grade of GRADES) {
    for (const level of LEVELS) {
      for (const focus of FOCI) {
        for (let seed = 1; seed <= SEEDS; seed++) {
          const q = Q.make({ grade, level, focus }, rng(seed * 7919 + level));
          checkQuestion(q);
          if (focus === "add") assert.equal(q.kind, "add");
          if (focus === "sub") assert.equal(q.kind, "sub");
          if (focus === "story") assert.equal(q.kind, "story");
          if (focus === "times") assert.ok(q.kind === "times" || (q.kind === "gap" && q.text.includes(KEER)), q.text);
          if (focus === "div") assert.ok(q.kind === "div" || (q.kind === "gap" && q.text.includes(":")), q.text);
        }
      }
    }
  }
});

test("make: defaults and odd options never throw", () => {
  const q = Q.make();
  checkQuestion(q);
  checkQuestion(Q.make({}));
  checkQuestion(Q.make({ grade: "4", level: "3" }, rng(1)));
  checkQuestion(Q.make({ grade: 99, level: -4, focus: "nonsense", table: 77 }, rng(2)));
  checkQuestion(Q.make({ grade: 5, level: 5, table: "7", focus: "times" }, rng(3)));
  assert.equal(Q.series({ grade: 3, level: 1 }, 0, rng(1)).length, 0);
  assert.equal(Q.series({ grade: 3, level: 1 }, 1, rng(1)).length, 1);
  assert.equal(Q.series({ grade: 3, level: 1 }, 2, rng(1)).length, 2);
  assert.equal(Q.series({ grade: 4, level: 3 }).length, 10, "count defaults to 10");
  assert.equal(Q.series().length, 10, "everything optional");
});

test("series: structure, distinctness and fromKey over every grade x level x focus", () => {
  for (const grade of GRADES) {
    for (const level of LEVELS) {
      for (const focus of FOCI) {
        for (let seed = 1; seed <= SEEDS; seed++) {
          const list = Q.series({ grade, level, focus }, 10, rng(seed * 104729 + grade * 8 + level));
          const ctx = `${grade}/${level}/${focus}/${seed}`;
          assert.equal(list.length, 10, ctx);
          assert.equal(new Set(list.map((q) => q.key)).size, 10, `distinct keys ${ctx}`);
          assert.equal(new Set(list.map((q) => q.answer)).size, 10, `distinct answers ${ctx}: ${list.map((q) => q.answer)}`);
          list.forEach((q, i) => checkQuestion(q, i % 4 === 0 ? true : "cheap"));

          const kinds = list.map((q) => q.kind);
          if (focus === "add" || focus === "sub" || focus === "story") assert.ok(kinds.every((k) => k === focus), ctx);
          if (focus === "times") assert.ok(kinds.every((k) => k === "times" || k === "gap"), ctx);
          if (focus === "div") assert.ok(kinds.every((k) => k === "div" || k === "gap"), ctx);
          if (focus === "times") list.filter((q) => q.kind === "gap").forEach((q) => assert.ok(q.text.includes(KEER), q.text));
          if (focus === "div") list.filter((q) => q.kind === "gap").forEach((q) => assert.ok(q.text.includes(":"), q.text));
          if (focus === "times" || focus === "div" || focus === "mix") {
            for (let i = 2; i < kinds.length; i++) {
              assert.ok(!(kinds[i] === kinds[i - 1] && kinds[i] === kinds[i - 2]), `three equal kinds in a row ${ctx}: ${kinds}`);
            }
          }
          if (focus === "mix") {
            assert.ok(kinds[0] !== "gap" && kinds[0] !== "story", `calm first sum ${ctx}: ${kinds}`);
            assert.ok(kinds[1] !== "story", `calm second sum ${ctx}`);
          }
        }
      }
    }
  }
});

test("determinism: equal seeds give equal series, different seeds differ", () => {
  for (const opts of [{ grade: 3, level: 1 }, { grade: 4, level: 5 }, { grade: 6, level: 8, focus: "story" }, { grade: 5, level: 2, focus: "div", table: 7 }]) {
    for (let seed = 1; seed <= 40; seed++) {
      assert.deepEqual(Q.series(opts, 10, rng(seed)), Q.series(opts, 10, rng(seed)));
      assert.deepEqual(Q.make(opts, rng(seed)), Q.make(opts, rng(seed)));
    }
    let different = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const a = Q.series(opts, 10, rng(seed)).map((q) => q.key).join();
      const b = Q.series(opts, 10, rng(seed + 1000)).map((q) => q.key).join();
      if (a !== b) different++;
    }
    assert.ok(different >= 95, `different seeds give different series (${different}/100) for ${JSON.stringify(opts)}`);
  }
});

test("series and make only use the supplied rng, never Math.random", () => {
  const original = Math.random;
  Math.random = () => {
    throw new Error("Math.random must not be used when an rng is given");
  };
  try {
    for (const grade of GRADES) {
      for (const focus of FOCI) {
        Q.series({ grade, level: 6, focus, repeat: ["add:12+9", "bogus"] }, 10, rng(grade));
        Q.make({ grade, level: 3, focus }, rng(grade + 50));
      }
    }
    Q.fromKey("times:7x8");
    Q.check(Q.fromKey("times:7x8"), "56");
  } finally {
    Math.random = original;
  }
  // without an rng the unseeded generator takes over
  const free = Q.series({ grade: 4, level: 4 }, 10);
  assert.equal(free.length, 10);
  free.forEach((q) => checkQuestion(q));
});

test("series: repeat keys are woven in early, never first or last", () => {
  const reps = ["times:7x8", "add:47+36"];
  for (const grade of GRADES) {
    for (const level of [1, 4, 8]) {
      for (let seed = 1; seed <= 100; seed++) {
        const list = Q.series({ grade, level, repeat: reps }, 10, rng(seed));
        const keys = list.map((q) => q.key);
        assert.equal(list.length, 10);
        assert.equal(new Set(keys).size, 10);
        assert.equal(new Set(list.map((q) => q.answer)).size, 10, "answers stay distinct");
        for (const k of reps) {
          assert.equal(keys.filter((x) => x === k).length, 1, `${k} appears once`);
          const at = keys.indexOf(k);
          assert.ok(at >= 1 && at <= 4, `${k} at easy position, got ${at}`);
          assert.deepEqual(list[at], Q.fromKey(k));
        }
        list.forEach((q) => checkQuestion(q, true));
      }
    }
  }
});

test("series: at most two repeats, answers must stay distinct, tiny series stay sane", () => {
  const many = ["times:7x8", "times:9x9", "times:6x7", "times:8x8"];
  for (let seed = 1; seed <= 100; seed++) {
    const keys = Q.series({ grade: 3, level: 1, repeat: many }, 10, rng(seed)).map((q) => q.key);
    assert.deepEqual(keys.filter((k) => many.includes(k)), ["times:7x8", "times:9x9"].filter((k) => keys.includes(k)));
    assert.equal(keys.filter((k) => many.includes(k)).length, 2);
    assert.ok(!keys.includes("times:6x7") && !keys.includes("times:8x8"));
    // 3 x 4 and 5 + 7 both equal 12: only the first one is kept
    const same = Q.series({ grade: 6, level: 8, repeat: ["times:3x4", "add:5+7"] }, 10, rng(seed)).map((q) => q.key);
    assert.ok(same.includes("times:3x4") && !same.includes("add:5+7"));
    // the same key twice counts once
    const twice = Q.series({ grade: 6, level: 8, repeat: ["times:3x4", "times:3x4"] }, 10, rng(seed));
    assert.equal(twice.filter((q) => q.key === "times:3x4").length, 1);
    // three sums: one repeat fits (the middle one), two sums: none
    const three = Q.series({ grade: 4, level: 2, repeat: ["times:7x8", "times:9x9"] }, 3, rng(seed));
    assert.equal(three.length, 3);
    assert.equal(three.filter((q) => q.key.startsWith("times:") && ["times:7x8", "times:9x9"].includes(q.key)).length, 1);
    assert.ok(["times:7x8", "times:9x9"].includes(three[1].key));
    const two = Q.series({ grade: 4, level: 2, repeat: ["times:7x8"] }, 2, rng(seed));
    assert.equal(two.length, 2);
    assert.ok(!two.some((q) => q.key === "times:7x8"));
  }
});

test("series: invalid or unparseable repeat keys are skipped silently", () => {
  const bad = ["", "foo", "add:1+", "add:+1", "times:7x", "div:7:0", "div:7:2", "sub:3-5", "add:007+5", "add:5000+5000", "story:nope:3:4",
    "story:tulpen:1:5", "story:tulpen:3", "story:tulpen:3:4:5", "story:kisten:3:4:5", "gap:add:?+?=5", "gap:add:5+?=3", "gap:add:24-?=51",
    "gap:div:7:?=2", "gap:times:0x?=0", "ADD:1+2", " add:1+2", "add:1+2 ", "times:0x5", "div:5:1x", "add:1+2+3", "times:7x8x9", "story:tulpen:3:4;", null,
    undefined, 42, {}, ["add:1+1"], true];
  for (let seed = 1; seed <= 100; seed++) {
    const plain = Q.series({ grade: 4, level: 3 }, 10, rng(seed));
    const list = Q.series({ grade: 4, level: 3, repeat: bad }, 10, rng(seed));
    assert.deepEqual(list, plain, "bad keys change nothing");
    const mixed = Q.series({ grade: 4, level: 3, repeat: [...bad, "times:6x7"] }, 10, rng(seed));
    assert.equal(mixed.length, 10);
    assert.ok(mixed.some((q) => q.key === "times:6x7"));
  }
  assert.equal(Q.series({ grade: 4, level: 3, repeat: "add:3+4" }, 10, rng(1)).length, 10);
  assert.equal(Q.series({ grade: 4, level: 3, repeat: null }, 10, rng(1)).length, 10);
  for (const k of bad) assert.equal(Q.fromKey(k), null, `fromKey(${JSON.stringify(k)})`);
});

test("series: repeats outside the chosen focus or table are not woven in", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const onlyAdd = Q.series({ grade: 4, level: 3, focus: "add", repeat: ["times:7x8", "gap:add:24+?=51", "add:47+36"] }, 10, rng(seed));
    assert.ok(onlyAdd.every((q) => q.kind === "add"));
    assert.ok(onlyAdd.some((q) => q.key === "add:47+36"));
    const times = Q.series({ grade: 4, level: 3, focus: "times", repeat: ["add:3+4", "gap:times:7x?=56"] }, 10, rng(seed));
    assert.ok(times.some((q) => q.key === "gap:times:7x?=56"));
    assert.ok(!times.some((q) => q.key === "add:3+4"));
    const table = Q.series({ grade: 4, level: 3, focus: "times", table: 7, repeat: ["times:6x8", "times:7x8"] }, 10, rng(seed));
    assert.ok(table.some((q) => q.key === "times:7x8"));
    assert.ok(!table.some((q) => q.key === "times:6x8"));
  }
});

test("table restriction: only that table, over grades, levels and kinds", () => {
  const touches = (q, t) => {
    if (q.kind === "story") return numsIn(q.text).includes(t);
    const s = solveText(q.text);
    if (q.kind === "times") return s.a === t || s.b === t;
    if (q.kind === "div") return s.b === t;
    if (q.kind === "gap" && s.op === KEER) return s.a === t || s.b === t;
    if (q.kind === "gap" && s.op === ":") return s.b === t;
    return false;
  };
  for (let table = 1; table <= 10; table++) {
    for (const grade of GRADES) {
      for (const level of [1, 3, 5, 8]) {
        for (const focus of ["mix", "times", "div"]) {
          for (let seed = 1; seed <= SEEDS; seed++) {
            const q = Q.make({ grade, level, focus, table }, rng(seed * 31 + table));
            assert.ok(touches(q, table), `table ${table} (${focus}): ${q.key}`);
            assert.ok(["times", "div", "gap"].includes(q.kind));
            if (focus === "times") assert.ok(q.kind !== "div");
            if (focus === "div") assert.ok(q.kind !== "times");
            checkQuestion(q, true);
          }
        }
      }
    }
  }
});

test("table restriction in a series: all sums on the table, answers still distinct", () => {
  for (let table = 1; table <= 10; table++) {
    for (const grade of [3, 4, 6]) {
      for (const level of [1, 8]) {
        for (const focus of ["mix", "times", "div"]) {
          for (let seed = 1; seed <= SEEDS; seed++) {
            const list = Q.series({ grade, level, focus, table }, 10, rng(seed + table * 1000));
            const ctx = `table ${table} ${grade}/${level}/${focus}/${seed}`;
            assert.equal(list.length, 10, ctx);
            assert.equal(new Set(list.map((q) => q.key)).size, 10, ctx);
            assert.equal(new Set(list.map((q) => q.answer)).size, 10, `${ctx}: ${list.map((q) => q.answer)}`);
            for (const q of list) {
              const s = solveText(q.text);
              const ok = q.kind === "times" ? s.a === table || s.b === table : q.kind === "div" ? s.b === table
                : q.kind === "gap" && s.op === KEER ? s.a === table || s.b === table : q.kind === "gap" && s.op === ":" && s.b === table;
              assert.ok(ok, `${ctx}: ${q.text}`);
            }
          }
        }
      }
    }
  }
  // a table with the story or the add/sub focus
  for (let table = 2; table <= 10; table++) {
    for (let seed = 1; seed <= 100; seed++) {
      const list = Q.series({ grade: 5, level: 6, focus: "story", table }, 10, rng(seed));
      for (const q of list) assert.ok(numsIn(q.text).includes(table), `${q.text} should use ${table}`);
      assert.equal(new Set(list.map((q) => q.answer)).size, 10);
    }
  }
  const add = Q.series({ grade: 5, level: 6, focus: "add", table: 7 }, 10, rng(1));
  assert.ok(add.every((q) => q.kind === "add"), "a table does not change add/sub");
  const one = Q.series({ grade: 5, level: 6, focus: "story", table: 1 }, 10, rng(1));
  assert.ok(one.every((q) => q.kind === "story"));
});

test("check: digits only, trimmed, leading zeros fine, nothing else", () => {
  const q = Q.fromKey("times:7x8");
  for (const ok of [56, "56", " 56 ", "\t56\n", "056", "0056", "00056", 56.0, 5.6e1]) assert.equal(Q.check(q, ok), true, JSON.stringify(ok));
  for (const no of ["", " ", "abc", "5.5", "56.0", "56,0", "-56", -56, 55, "55", "57", "5 6", "56a", "a56", "+56", "5e1", "0x38", "0b111000", NaN,
    Infinity, null, undefined, {}, [], [56], true, false, 56.5, "٥٦", "５６", "56\u0000", "٥٦", "1e2", "9".repeat(400)]) {
    assert.equal(Q.check(q, no), false, JSON.stringify(no));
  }
  const zero = Q.fromKey("sub:5-5");
  assert.equal(zero.answer, 0);
  for (const ok of [0, "0", "00", "000", " 0 "]) assert.equal(Q.check(zero, ok), true);
  assert.equal(Q.check(zero, ""), false);
  assert.equal(Q.check(zero, "-0"), false);
  assert.equal(Q.check(null, 5), false);
  assert.equal(Q.check(undefined, "5"), false);
  assert.equal(Q.check({}, "5"), false);
  assert.equal(typeof Q.check(q, "56"), "boolean");
  for (let seed = 1; seed <= 200; seed++) {
    const x = Q.make({ grade: 5, level: 6 }, rng(seed));
    assert.equal(Q.check(x, String(x.answer)), true);
    assert.equal(Q.check(x, x.answer), true);
    assert.equal(Q.check(x, "0" + x.answer), true);
    assert.equal(Q.check(x, String(x.answer + 1)), false);
    assert.equal(Q.check(x, `${x.answer}.0`), false);
  }
});

test("fromKey: every key shape round-trips, malformed keys give null", () => {
  const cases = [
    ["add:47+36", "47 + 36 = ?", 83],
    ["sub:83-47", `83 ${MIN} 47 = ?`, 36],
    ["times:7x8", `7 ${KEER} 8 = ?`, 56],
    ["div:56:8", "56 : 8 = ?", 7],
    ["gap:add:24+?=51", "24 + ? = 51", 27],
    ["gap:add:?+27=51", "? + 27 = 51", 24],
    ["gap:sub:?-8=15", `? ${MIN} 8 = 15`, 23],
    ["gap:sub:30-?=12", `30 ${MIN} ? = 12`, 18],
    ["gap:times:7x?=56", `7 ${KEER} ? = 56`, 8],
    ["gap:times:?x7=56", `? ${KEER} 7 = 56`, 8],
    ["gap:div:48:?=6", "48 : ? = 6", 8],
    ["gap:div:?:8=7", "? : 8 = 7", 56],
    ["story:eieren:6:8", null, 48],
  ];
  for (const [key, text, answer] of cases) {
    const q = Q.fromKey(key);
    assert.ok(q, key);
    assert.equal(q.key, key);
    assert.equal(q.answer, answer);
    if (text) assert.equal(q.text, text);
    checkQuestion(q);
  }
  const eggs = Q.fromKey("story:eieren:6:8");
  assert.ok(numsIn(eggs.text).join() === "6,8" && /eieren/.test(eggs.text));
  for (const bad of ["gap:add:24+?=20", "gap:sub:?-8=-1", "gap:times:7x?=55", "gap:div:48:?=7", "gap:div:?:0=7", "add:9999+1", "times:100x100", "div:9:2",
    "sub:1-2", "story:eieren:1:8", "story:eieren:6", "story:eieren:6:8:9", "story:verdeel:7:2", "story:kratten:2:2:99", "story:kisten:3:4:5", "story:knikkers:5:2:3",
    "story:haven:5:5:10", "story:broodjes:10:5:5", "story:Eieren:6:8", "story:eieren:06:8", "gap:add:24+?=051"]) {
    assert.equal(Q.fromKey(bad), null, bad);
  }
});

test("exhaustive small grids: hints never leak, explanations always carry the answer", () => {
  const keys = [];
  for (let a = 1; a <= 60; a++) {
    for (let b = 1; b <= 60; b++) {
      keys.push(`add:${a}+${b}`);
      if (a >= b) keys.push(`sub:${a}-${b}`);
    }
  }
  for (let a = 1; a <= 12; a++) for (let b = 1; b <= 12; b++) keys.push(`times:${a}x${b}`);
  for (let d = 1; d <= 12; d++) for (let q = 1; q <= 25; q++) keys.push(`div:${d * q}:${d}`);
  for (let a = 1; a <= 30; a++) {
    for (let c = a + 1; c <= 60; c += 3) keys.push(`gap:add:${a}+?=${c}`, `gap:add:?+${a}=${c}`, `gap:sub:?-${a}=${c}`);
    for (let c = 0; c < a; c += 2) keys.push(`gap:sub:${a}-?=${c}`);
  }
  for (let a = 1; a <= 12; a++) {
    for (let b = 1; b <= 12; b++) keys.push(`gap:times:${a}x?=${a * b}`, `gap:times:?x${a}=${a * b}`, `gap:div:${a * b}:?=${b}`, `gap:div:?:${a}=${b}`);
  }
  let built = 0;
  for (const key of keys) {
    const q = Q.fromKey(key);
    if (!q) continue;
    built++;
    checkQuestion(q);
  }
  assert.ok(built > 7000, `built ${built}`);
});

test("random big numbers: same invariants for 3- and 4-digit sums", () => {
  const r = rng(99);
  for (let i = 0; i < 4000; i++) {
    const a = 1 + Math.floor(r() * 9000);
    const b = 1 + Math.floor(r() * 9000);
    const d = 2 + Math.floor(r() * 9);
    const keys = [`add:${a}+${Math.min(b, 9999 - a) || 1}`, `sub:${Math.max(a, b)}-${Math.min(a, b)}`, `times:${1 + (a % 99)}x${d}`,
      `times:${10 * (1 + (a % 99))}x${10 * d}`, `div:${d * (1 + (a % 999))}:${d}`];
    for (const key of keys) {
      const q = Q.fromKey(key);
      if (q) checkQuestion(q, i % 4 !== 0);
    }
  }
});

// ------------------------------------------------------------------ stories

test("stories: all templates are reachable, plurals safe, Dutch looks tidy", () => {
  const examples = new Map();
  for (const grade of GRADES) {
    for (const level of LEVELS) {
      for (let seed = 1; seed <= 150; seed++) {
        for (const q of Q.series({ grade, level, focus: "story" }, 10, rng(seed * 13 + level))) {
          const id = q.key.split(":")[1];
          if (!examples.has(id)) examples.set(id, q);
        }
      }
    }
  }
  assert.ok(examples.size >= 18, `at least 18 templates, found ${examples.size}`);
  assert.deepEqual([...examples.keys()].sort(), Object.keys(STORY_RULES).sort(), "every template can be drawn");
  const heDeWords = { elk: ["kind", "vriendje"], elke: ["doos", "rij", "boot", "emmer", "zak", "kist", "mand"] };
  for (const q of examples.values()) {
    const lines = q.text.split("\n");
    assert.equal(lines.length, 2, `a story has a statement and a question: ${q.text}`);
    assert.match(lines[0], /^[A-Z'][^?]*\.$/, lines[0]);
    assert.match(lines[1], /^Hoeveel [^?]*\?$/, lines[1]);
    assert.ok(!/ {2}/.test(q.text) && !/\s[.,?]/.test(q.text), q.text);
    assert.ok(!ENGLISH.test(q.text), q.text);
    for (const [word, nouns] of Object.entries(heDeWords)) {
      for (const m of q.text.matchAll(new RegExp(`\\b${word} (?!\\d)([a-z]+)`, "g"))) {
        assert.ok(nouns.includes(m[1]), `"${word} ${m[1]}" has the wrong article in: ${q.text}`);
      }
    }
    assert.ok(!/\b(1|0) [a-z]+/.test(q.text), "no singular or zero amounts in a story");
  }
});

test("stories: one step in groep 3, two steps and bigger numbers later", () => {
  const stats = {};
  for (const grade of GRADES) {
    for (const level of LEVELS) {
      let one = 0;
      let two = 0;
      let biggest = 0;
      for (let seed = 1; seed <= 150; seed++) {
        for (const q of Q.series({ grade, level, focus: "story" }, 10, rng(seed * 5 + level))) {
          const n = numsIn(q.text);
          if (n.length === 2) one++;
          else two++;
          biggest = Math.max(biggest, ...n, q.answer);
        }
      }
      stats[`${grade}/${level}`] = { one, two, biggest };
    }
  }
  for (const level of LEVELS) {
    assert.equal(stats[`3/${level}`].two, 0, `no two-step stories in groep 3 (level ${level})`);
    assert.ok(stats[`3/${level}`].biggest <= 100, `groep 3 stories stay within 100 (level ${level})`);
    assert.ok(stats[`4/${level}`].biggest <= 1000, `groep 4 stories stay within 1000 (level ${level})`);
  }
  assert.ok(stats["5/8"].two > stats["5/8"].one, "groep 5 level 8 is mostly two-step");
  assert.ok(stats["6/8"].two > stats["6/8"].one * 1.2, "groep 6 level 8 is mostly two-step");
  assert.ok(stats["6/8"].biggest > 1000 && stats["6/8"].biggest <= 9999);
  assert.ok(stats["3/1"].biggest <= 20, "the first stories stay within 20");
});

test("stories: a series of stories uses many different templates", () => {
  for (const grade of GRADES) {
    for (const level of LEVELS) {
      let total = 0;
      for (let seed = 1; seed <= 50; seed++) {
        const ids = new Set(Q.series({ grade, level, focus: "story" }, 10, rng(seed)).map((q) => q.key.split(":")[1]));
        assert.ok(ids.size >= 5, `${grade}/${level}: only ${ids.size} templates in one series`);
        total += ids.size;
      }
      assert.ok(total / 50 >= 7, `${grade}/${level}: average template variety ${total / 50}`);
    }
  }
});

// --------------------------------------------------------- hints & methods

test("methods: bridging explanations only appear when the sum really bridges", () => {
  let bridging = 0;
  let plain = 0;
  for (const grade of GRADES) {
    for (const level of LEVELS) {
      for (const focus of ["add", "sub"]) {
        for (let seed = 1; seed <= 120; seed++) {
          for (const q of Q.series({ grade, level, focus }, 10, rng(seed * 3 + level))) {
            const s = solveText(q.text);
            const text = `${q.hint} ${q.explain}`;
            if (focus === "add") {
              const carry = s.a % 10 + s.b % 10 >= 10;
              if (/volgende tiental|Maak eerst 10 vol|Maak eerst tien vol|rond getal/.test(text)) {
                assert.ok(carry, `bridging text without a carry: ${q.text}: ${text}`);
                bridging++;
              } else plain++;
              if (/dubbelsom/.test(text)) assert.equal(s.a, s.b, q.text);
            } else {
              const borrow = s.a % 10 < s.b % 10;
              if (/hele tiental/.test(text)) {
                assert.ok(borrow, `borrowing text without a borrow: ${q.text}: ${text}`);
                bridging++;
              } else plain++;
              if (/Haal eerst (10|tien) weg/.test(text)) assert.equal(s.a % 10, 0, q.text);
            }
          }
        }
      }
    }
  }
  assert.ok(bridging > 500 && plain > 500, `both kinds occur (${bridging}/${plain})`);
});

test("methods: the tables get their Dutch method (6 = 5 + 1 keer erbij, 9 = 10 min 1 keer, ...)", () => {
  for (let a = 1; a <= 10; a++) {
    for (let b = 1; b <= 10; b++) {
      const q = Q.fromKey(`times:${a}x${b}`);
      const has = (n) => a === n || b === n;
      const none = (...list) => list.every((n) => !has(n));
      if (has(10)) assert.match(q.explain, /nul achter/, q.key);
      else if (has(1)) assert.match(q.explain, /gewoon/, q.key);
      else if (has(2)) assert.match(q.explain, /Verdubbel/, q.key);
      else if (has(9)) assert.match(q.explain, /tafel van 10 min 1 keer/, q.key);
      else if (has(6)) assert.match(q.explain, /tafel van 5 en dan 1 keer erbij/, q.key);
      else if (has(8)) assert.match(q.explain, /dubbele van tafel van 4|Verdubbel drie keer/, q.key);
      else if (has(4)) assert.match(q.explain, /Verdubbel twee keer/, q.key);
      else if (has(3)) assert.match(q.explain, /tafel van 2/, q.key);
      else assert.ok(none(1, 2, 3, 4, 6, 8, 9, 10));
      if (has(9) && none(1, 2, 10)) assert.match(q.hint, /tafel van 10 min 1 keer/, q.key);
      if (has(6) && none(1, 2, 9, 10)) assert.match(q.hint, /tafel van 6 is tafel van 5|5 ×/i, q.key);
    }
  }
  for (let d = 2; d <= 10; d++) {
    for (let q = 2; q <= 10; q++) {
      const x = Q.fromKey(`div:${d * q}:${d}`);
      assert.match(x.explain, new RegExp(`${q} \\u00d7 ${d} = ${d * q}|helft|Halveer|nul weg|verdubbelen`), x.key);
      if (d === 3 || d === 6 || d === 7 || d === 9) assert.match(`${x.hint} ${x.explain}`, /omgekeerde van keer|tafel van/, x.key);
    }
  }
  assert.match(Q.fromKey("div:84:4").explain, /Halveer|Splits/);
  assert.match(Q.fromKey("times:23x4").explain, /Splits 23 in 20 en 3/);
  assert.match(Q.fromKey("times:30x40").explain, /twee nullen/);
  assert.match(Q.fromKey("add:47+36").explain, /volgende tiental|Splits|Stap voor stap/);
  assert.match(Q.fromKey("sub:100-37").explain, /Aanvullen|Stap voor stap|dicht bij/);
});

test("methods: hints and explanations are varied, not one fixed sentence", () => {
  const norm = (s) => s.replace(/\d+/g, "#");
  const hints = {};
  const explains = {};
  for (const grade of GRADES) {
    for (const level of LEVELS) {
      for (let seed = 1; seed <= 60; seed++) {
        for (const q of Q.series({ grade, level }, 10, rng(seed * 17 + level))) {
          (hints[q.kind] ||= new Set()).add(norm(q.hint));
          (explains[q.kind] ||= new Set()).add(norm(q.explain));
        }
      }
    }
  }
  const minHints = { add: 12, sub: 12, times: 9, div: 7, gap: 10, story: 20 };
  const minExplains = { add: 20, sub: 20, times: 9, div: 8, gap: 40, story: 20 };
  for (const kind of Object.keys(Q.KINDS)) {
    assert.ok(hints[kind].size >= minHints[kind], `${kind}: only ${hints[kind].size} hint styles`);
    assert.ok(explains[kind].size >= minExplains[kind], `${kind}: only ${explains[kind].size} explanation styles`);
  }
});

test("gap sums: all four operations, the unknown in any position", () => {
  const seen = new Set();
  for (let seed = 1; seed <= 600; seed++) {
    for (const q of Q.series({ grade: 5, level: 6 }, 10, rng(seed))) {
      if (q.kind !== "gap") continue;
      const s = solveText(q.text);
      seen.add(`${s.op}/${s.unknown}`);
    }
  }
  for (const op of ["+", MIN, KEER, ":"]) for (const pos of ["a", "b"]) assert.ok(seen.has(`${op}/${pos}`), `gap ${op} with the unknown at ${pos}`);
  // the first groep 3 gap sums only hide the second number: 3 + ? = 8
  for (let seed = 1; seed <= 200; seed++) {
    for (const q of Q.series({ grade: 3, level: 3 }, 10, rng(seed)).filter((x) => x.kind === "gap")) {
      assert.equal(solveText(q.text).unknown, "b", q.text);
    }
  }
});

// --------------------------------------------------------- difficulty ramp

const KIND_EXTRA = { add: 0, sub: 0.05, times: 0.2, div: 0.25, gap: 0.2, story: 0.3 };
// An explicit rank: size of the biggest number + a bonus per kind + a bonus for a carry/borrow.
function rank(q) {
  const nums = numsIn(q.text);
  let value = Math.log10(1 + Math.max(q.answer, ...nums)) + KIND_EXTRA[q.kind];
  if (q.kind === "story" && nums.length === 3) value += 0.2;
  const s = PLAIN_RE.exec(q.text);
  if (s) {
    const a = Number(s[1]);
    const b = Number(s[3]);
    if (s[2] === "+" && (a < 10 && b < 10 ? a + b > 10 : (a % 10) + (b % 10) >= 10)) value += 0.15;
    if (s[2] === MIN && a % 10 < b % 10) value += 0.15;
  }
  return value;
}

test("difficulty ramp: gentle and non-decreasing per level, sane across grades", () => {
  const mean = {};
  const early = {};
  const late = {};
  const first = {};
  for (const grade of GRADES) {
    for (const level of LEVELS) {
      let sum = 0;
      let n = 0;
      let e = 0;
      let l = 0;
      let f = 0;
      for (let seed = 1; seed <= 400; seed++) {
        const list = Q.series({ grade, level }, 10, rng(seed * 13 + level));
        list.forEach((q, i) => {
          const r = rank(q);
          sum += r;
          n++;
          if (i < 5) e += r;
          else l += r;
          if (i === 0) f += r;
        });
      }
      mean[`${grade}/${level}`] = sum / n;
      early[`${grade}/${level}`] = e / 2000;
      late[`${grade}/${level}`] = l / 2000;
      first[`${grade}/${level}`] = f / 400;
    }
  }
  for (const grade of GRADES) {
    for (let level = 2; level <= 8; level++) {
      assert.ok(mean[`${grade}/${level}`] >= mean[`${grade}/${level - 1}`] - 0.03,
        `groep ${grade}: level ${level} (${mean[`${grade}/${level}`].toFixed(3)}) is easier than level ${level - 1} (${mean[`${grade}/${level - 1}`].toFixed(3)})`);
    }
    assert.ok(mean[`${grade}/8`] >= mean[`${grade}/1`] + 0.45, `groep ${grade}: level 8 clearly harder than level 1`);
    const lo = (mean[`${grade}/1`] + mean[`${grade}/2`] + mean[`${grade}/3`] + mean[`${grade}/4`]) / 4;
    const hi = (mean[`${grade}/5`] + mean[`${grade}/6`] + mean[`${grade}/7`] + mean[`${grade}/8`]) / 4;
    assert.ok(hi > lo + 0.25, `groep ${grade}: second half of the track is harder`);
  }
  for (let grade = 3; grade < 6; grade++) {
    assert.ok(mean[`${grade}/1`] < mean[`${grade + 1}/8`], `groep ${grade} level 1 is easier than groep ${grade + 1} level 8`);
    assert.ok(mean[`${grade + 1}/1`] <= mean[`${grade}/8`] + 0.15, `groep ${grade + 1} level 1 does not jump above groep ${grade} level 8`);
  }
  // inside one series the sums rise gently and start with a warm-up
  for (const key of Object.keys(mean)) {
    assert.ok(late[key] > early[key] + 0.1, `${key}: later sums are harder than the first five`);
    assert.ok(first[key] < mean[key], `${key}: the first sum is easier than average`);
  }
});

test("warm-up: groep 3 level 1 starts with trivially easy sums", () => {
  let total = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const list = Q.series({ grade: 3, level: 1 }, 10, rng(seed));
    const first = list[0];
    assert.ok(first.kind === "add" || first.kind === "sub", first.key);
    assert.ok(first.answer <= 8, `first answer ${first.answer}: ${first.text}`);
    assert.ok(Math.max(...numsIn(first.text)) <= 8, first.text);
    total += first.answer;
    for (const q of list) assert.ok(Math.max(...numsIn(q.text), q.answer) <= 14, `groep 3 level 1 stays tiny: ${q.text}`);
  }
  assert.ok(total / 300 <= 5, `mean first answer ${total / 300}`);
  // groep 4 level 1 is a continuation of groep 3, not a cliff
  for (let seed = 1; seed <= 200; seed++) {
    const first = Q.series({ grade: 4, level: 1 }, 10, rng(seed))[0];
    assert.ok(Math.max(...numsIn(first.text), first.answer) <= 100, first.text);
  }
});

test("curriculum spot checks per grade and level", () => {
  const sample = (opts, n = 120) => {
    const out = [];
    for (let seed = 1; seed <= n; seed++) out.push(...Q.series(opts, 10, rng(seed)));
    return out;
  };
  const has = (list, f) => list.some(f);
  const factors = (q) => {
    const s = PLAIN_RE.exec(q.text);
    return s ? [Number(s[1]), Number(s[3])] : [];
  };
  const uses = (q, ...tables) => factors(q).some((n) => tables.includes(n));
  const g3 = sample({ grade: 3, level: 8 });
  assert.ok(has(g3, (q) => q.kind === "times"), "groep 3 level 8 has tables");
  assert.ok(!has(g3, (q) => q.kind === "times" && !uses(q, 2, 5, 10)), "groep 3 tables are 2, 5 and 10");
  assert.ok(!has(sample({ grade: 3, level: 4 }), (q) => q.kind === "times" || q.kind === "div" || q.kind === "story"), "no tables or stories before level 6");
  assert.ok(!has(sample({ grade: 3, level: 5 }), (q) => Math.max(...numsIn(q.text), q.answer) > 100), "groep 3 level 5 stays within 100");
  assert.ok(has(sample({ grade: 3, level: 3 }), (q) => q.kind === "add" && /^\d0 \+ \d0 =/.test(q.text)), "whole tens like 30 + 20");
  const g4 = sample({ grade: 4, level: 4 });
  assert.ok(has(g4, (q) => q.kind === "div"), "groep 4 level 4 divides");
  assert.ok(has(g4, (q) => q.kind === "times" && uses(q, 3, 4)), "tables 3 and 4");
  assert.ok(has(sample({ grade: 4, level: 3 }), (q) => q.kind === "add" && /^[1-9]00 \+ [1-9]00 =/.test(q.text)), "whole hundreds like 300 + 400");
  assert.ok(has(sample({ grade: 4, level: 6 }), (q) => q.kind === "times" && uses(q, 7, 8)), "tables 7 and 8 at level 6");
  const share7 = (level) => {
    const times = sample({ grade: 4, level }, 150).filter((q) => q.kind === "times");
    return times.filter((q) => uses(q, 7)).length / times.length;
  };
  assert.ok(share7(5) < share7(6) / 2, `the 7 table arrives at level 6 (${share7(5).toFixed(2)} vs ${share7(6).toFixed(2)})`);
  assert.ok(has(sample({ grade: 4, level: 5 }), (q) => q.kind === "times" && uses(q, 6, 9)), "tables 6 and 9 at level 5");
  const g5 = sample({ grade: 5, level: 3 });
  assert.ok(has(g5, (q) => q.kind === "times" && /^\d\d × \d =/.test(q.text)), "23 x 4 style at groep 5 level 3");
  assert.ok(has(sample({ grade: 5, level: 6 }), (q) => q.kind === "times" && /^\d0 × \d0 =/.test(q.text)), "30 x 40");
  assert.ok(has(sample({ grade: 5, level: 6 }), (q) => q.kind === "div" && /^\d\d : \d =/.test(q.text)), "84 : 4");
  assert.ok(has(sample({ grade: 5, level: 6 }), (q) => q.kind === "add" && /^\d\d00 \+ \d\d00 =/.test(q.text)), "4500 + 3200");
  assert.ok(has(sample({ grade: 5, level: 8 }), (q) => q.kind === "times" && /^\d\d\d × \d =/.test(q.text)), "136 x 5");
  assert.ok(has(sample({ grade: 5, level: 8 }), (q) => q.kind === "div" && /^\d\d\d : \d =/.test(q.text)), "3-digit : 1-digit");
  assert.ok(has(sample({ grade: 6, level: 8 }), (q) => q.kind === "times" && /^\d\d × \d\d =/.test(q.text)), "23 x 12");
  assert.ok(has(sample({ grade: 6, level: 6 }), (q) => q.kind === "add" && /^\d\d\d\d \+ \d\d\d\d =/.test(q.text)), "4-digit sums in groep 6");
});

test("performance: series(10) takes well under 5 ms on average for every configuration", () => {
  let worst = 0;
  let worstCfg = "";
  for (const grade of GRADES) {
    for (const level of LEVELS) {
      for (const focus of FOCI) {
        const t0 = process.hrtime.bigint();
        const runs = 60;
        for (let seed = 1; seed <= runs; seed++) Q.series({ grade, level, focus, repeat: ["times:7x8", "add:47+36"] }, 10, rng(seed));
        const ms = Number(process.hrtime.bigint() - t0) / 1e6 / runs;
        if (ms > worst) {
          worst = ms;
          worstCfg = `${grade}/${level}/${focus}`;
        }
      }
    }
  }
  for (const table of [1, 5, 10]) {
    const t0 = process.hrtime.bigint();
    for (let seed = 1; seed <= 60; seed++) Q.series({ grade: 4, level: 5, focus: "mix", table }, 10, rng(seed));
    worst = Math.max(worst, Number(process.hrtime.bigint() - t0) / 1e6 / 60);
  }
  assert.ok(worst < 5, `slowest configuration ${worstCfg} needs ${worst.toFixed(2)} ms per series`);
});

test("keys are unique per exact question and stable", () => {
  const seen = new Map();
  for (const grade of GRADES) {
    for (const level of LEVELS) {
      for (let seed = 1; seed <= 60; seed++) {
        for (const q of Q.series({ grade, level }, 10, rng(seed * 11))) {
          assert.match(q.key, /^(add|sub|times|div|gap|story):/, q.key);
          assert.equal(q.key.split(":")[0], q.kind);
          assert.ok(!/\s/.test(q.key), q.key);
          const prev = seen.get(q.key);
          if (prev) assert.deepEqual(prev, q, `same key, same question: ${q.key}`);
          else seen.set(q.key, q);
        }
      }
    }
  }
  assert.ok(seen.size > 3000, `variety of keys: ${seen.size}`);
});

test("gap sums have exactly one solution (brute force over 0..9999)", () => {
  let checked = 0;
  for (let seed = 1; seed <= 400; seed++) {
    for (const grade of GRADES) {
      const list = Q.series({ grade, level: 1 + (seed % 8) }, 10, rng(seed * 3 + grade)).filter((q) => q.kind === "gap");
      for (const q of list) {
        const s = solveText(q.text);
        const solutions = [];
        for (let x = 0; x <= 9999; x++) {
          const a = s.unknown === "a" ? x : s.a;
          const b = s.unknown === "b" ? x : s.b;
          if (b === 0 && s.op === ":") continue;
          const value = s.op === "+" ? a + b : s.op === MIN ? a - b : s.op === KEER ? a * b : a / b;
          if (value === s.c) solutions.push(x);
        }
        assert.deepEqual(solutions, [q.answer], `${q.text} must have the single solution ${q.answer}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 800, `checked ${checked} gap sums`);
});

test("fromKey: fuzzed keys either fail cleanly or give a canonical, valid question", () => {
  const r = rng(2024);
  const base = [];
  for (let seed = 1; seed <= 80; seed++) base.push(...Q.series({ grade: 3 + (seed % 4), level: 1 + (seed % 8) }, 10, rng(seed)).map((q) => q.key));
  const alphabet = "0123456789+-x:?=abcdefghijklmnopqrstuvwxyz .−×";
  let accepted = 0;
  for (let i = 0; i < 20000; i++) {
    let key = base[Math.floor(r() * base.length)];
    const edits = 1 + Math.floor(r() * 3);
    for (let e = 0; e < edits; e++) {
      const at = Math.floor(r() * (key.length + 1));
      const c = alphabet[Math.floor(r() * alphabet.length)];
      const mode = r();
      key = mode < 0.4 ? key.slice(0, at) + c + key.slice(at) : mode < 0.7 ? key.slice(0, at) + key.slice(at + 1) : key.slice(0, at) + c + key.slice(at + 1);
    }
    const q = Q.fromKey(key);
    if (q === null) continue;
    accepted++;
    assert.equal(q.key, key, "only canonical keys are accepted");
    checkQuestion(q, "cheap");
  }
  assert.ok(accepted > 100, `some fuzzed keys stay valid (${accepted})`);
  for (const junk of ["story:constructor:3:4", "story:__proto__:3:4", "story:tostring:3:4", "gap:constructor:1+?=2", `add:${"9".repeat(500)}+1`,
    "add:1+" + "1".repeat(5), "times:99999x1", "\u0000", "add:١+٢", "add:1\n+2"]) {
    assert.equal(Q.fromKey(junk), null, junk);
  }
});

// ======================================================================
// Review regressions (independent math + Dutch-language review).
// Each test below pins one class of defect that the first version had.
// ======================================================================

const UNIT_VALUE = { eenheden: 1, eenheid: 1, tientallen: 10, tiental: 10, honderdtallen: 100, honderdtal: 100, duizendtallen: 1000, duizendtal: 1000 };
const UNIT_RE = "eenheden|eenheid|tientallen|tiental|honderdtallen|honderdtal|duizendtallen|duizendtal";
const OPC = `[+${MIN}${KEER}:]`;

function evalChain(expr) {
  const js = expr.replaceAll(MIN, "-").replaceAll(KEER, "*").replaceAll(" : ", " / ");
  assert.match(js, /^[0-9+\-*/ ]+$/, expr);
  return Function(`"use strict"; return (${js});`)();
}

// Every arithmetic statement in a hint or explanation, parsed with its own
// tolerant regexes. Returns the statements that are false or inconsistent.
function falseClaims(text) {
  const bad = [];
  const note = (claim, why) => bad.push(`${why}: "${claim}"`);
  let m;
  const each = (re, f) => {
    re.lastIndex = 0;
    while ((m = re.exec(text))) f(m);
  };
  each(new RegExp(`(\\d+) (${UNIT_RE}) ([+${MIN}]) (\\d+) (${UNIT_RE}) = (\\d+) (${UNIT_RE})`, "g"), (x) => {
    const [all, a, ua, op, b, ub, r, ur] = x;
    if (UNIT_VALUE[ua] !== UNIT_VALUE[ub] || UNIT_VALUE[ua] !== UNIT_VALUE[ur]) note(all, "unit mismatch");
    if ((op === "+" ? +a + +b : +a - +b) !== +r) note(all, "unit arithmetic");
    for (const [n, u] of [[a, ua], [b, ub], [r, ur]]) if ((Number(n) === 1) !== /(tal|heid)$/.test(u)) note(all, `plural of ${n} ${u}`);
  });
  each(new RegExp(`(\\d+) (${UNIT_RE}) : (\\d+) = (\\d+) (${UNIT_RE})`, "g"), (x) => {
    if (+x[1] / +x[3] !== +x[4] || UNIT_VALUE[x[2]] !== UNIT_VALUE[x[5]]) note(x[0], "unit division");
    for (const [n, u] of [[x[1], x[2]], [x[4], x[5]]]) if ((Number(n) === 1) !== /(tal|heid)$/.test(u)) note(x[0], `plural of ${n} ${u}`);
  });
  each(new RegExp(`(\\d+(?: ${OPC} \\d+)+) = (\\d+)`, "g"), (x) => {
    if (evalChain(x[1]) !== +x[2]) note(x[0], "equation");
  });
  each(/dubbel (\d+) is (\d+)/g, (x) => { if (2 * +x[1] !== +x[2]) note(x[0], "dubbel"); });
  each(/de helft van (\d+) is (\d+)(?:, de helft daarvan is (\d+))?/g, (x) => {
    if (+x[1] !== 2 * +x[2]) note(x[0], "helft");
    if (x[3] !== undefined && +x[2] !== 2 * +x[3]) note(x[0], "helft daarvan");
  });
  each(/(\d+) wordt (\d+), dan (\d+) en dan (\d+)/g, (x) => {
    if (+x[1] !== 2 * +x[2] || +x[2] !== 2 * +x[3] || +x[3] !== 2 * +x[4]) note(x[0], "halveren");
  });
  each(/zet een nul achter (\d+)\. Dat wordt (\d+)/g, (x) => { if (+x[2] !== 10 * +x[1]) note(x[0], "nul achter"); });
  each(/Delen door 10: haal een nul weg\. (\d+) wordt (\d+)/g, (x) => { if (+x[1] !== 10 * +x[2]) note(x[0], "nul weg"); });
  each(/van (\d+) naar (\d+) is (\d+)/g, (x) => { if (+x[2] - +x[1] !== +x[3]) note(x[0], "aanvullen"); });
  each(/(\d+) ligt dicht bij (\d+)/g, (x) => {
    const d = Math.abs(+x[2] - +x[1]);
    if (d < 1 || d > 2 || +x[2] % 10) note(x[0], "dicht bij");
  });
  each(/Splits (\d+) in ((?:\d+(?:, | en )?)+)/g, (x) => {
    if (x[2].match(/\d+/g).reduce((s, v) => s + Number(v), 0) !== +x[1]) note(x[0], "splits");
  });
  each(/(\d+) is (\d+) en (\d+)\./g, (x) => { if (+x[2] + +x[3] !== +x[1]) note(x[0], "ontbinding"); });
  each(/Tel in vijven: ((?:\d+(?:, )?)+)\. Dat is (\d+) keer/g, (x) => {
    const l = x[1].match(/\d+/g).map(Number);
    if (l.length !== +x[2] || l.some((v, i) => v !== 5 * (i + 1))) note(x[0], "tel in vijven");
  });
  each(/Begin bij (\d+) en tel (\d+) (verder|terug): ((?:\d+(?:, )?)+)\./g, (x) => {
    const l = x[4].match(/\d+/g).map(Number);
    const dir = x[3] === "verder" ? 1 : -1;
    if (l.length !== +x[2] || l.some((v, i) => v !== +x[1] + dir * (i + 1))) note(x[0], "telrij");
  });
  each(/Er moet nog (\d+) (bij|af): (\d+) ([+−]) (\d+) = (\d+)/g, (x) => {
    if (+x[1] !== +x[5] || (x[2] === "bij") !== (x[4] === "+")) note(x[0], "er moet nog");
  });
  each(/Dat is (\d+) te veel, dus (\d+) er weer bij: (\d+) \+ (\d+) = (\d+)/g, (x) => {
    if (x[1] !== x[2] || x[2] !== x[4]) note(x[0], "te veel");
  });
  // aanvullen: the steps join up and "Samen" lists exactly those steps
  const flat = text.replace(/\n/g, " ");
  each(/Aanvullen: ((?:van \d+ naar \d+ is \d+(?:, | en )?)+)\. Samen ([\d + ]+) = (\d+)/g, (x) => {
    const steps = [...x[1].matchAll(/van (\d+) naar (\d+) is (\d+)/g)].map((s) => s.slice(1).map(Number));
    if (steps.some((s, i) => i && s[0] !== steps[i - 1][1])) note(x[0], "aanvullen loopt niet door");
    if (numsIn(x[2]).join() !== steps.map((s) => s[2]).join()) note(x[0], "aanvullen: Samen telt andere stappen");
    if (+x[3] !== steps[steps.length - 1][1] - steps[0][0]) note(x[0], "aanvullen: totaal");
  });
  // rounding up/down for compensating: the correction is the difference, in the right direction
  for (const x of flat.matchAll(/(\d+) ligt dicht bij (\d+)\. (\d+) ([+−]) (\d+) = (\d+), en dan (\d+) (terug|erbij): (\d+)/g)) {
    if (+x[5] !== +x[2] || +x[7] !== Math.abs(+x[2] - +x[1])) note(x[0], "compenseren");
    if ((x[4] === "+") !== (x[8] === "terug")) note(x[0], "compenseren: richting");
  }
  return bad;
}

test("review: every equation, count and unit in a hint or explanation is true", () => {
  let texts = 0;
  const seen = new Set();
  const examine = (q) => {
    if (seen.has(q.key)) return;
    seen.add(q.key);
    for (const field of [q.hint, q.explain]) {
      texts++;
      assert.deepEqual(falseClaims(field), [], `${q.key}: ${field.replace(/\n/g, " / ")}`);
    }
  };
  for (const grade of GRADES) {
    for (const level of LEVELS) {
      for (const focus of FOCI) {
        for (let seed = 1; seed <= 40; seed++) Q.series({ grade, level, focus }, 10, rng(seed * 29 + level)).forEach(examine);
      }
    }
  }
  // every small sum, in every shape (the unit and tens/hundreds methods included)
  for (let a = 1; a <= 60; a++) {
    for (let b = 1; b <= 60; b++) {
      for (const key of [`add:${a}+${b}`, a >= b ? `sub:${a}-${b}` : null, `times:${a}x${b}`, a % b === 0 ? `div:${a}:${b}` : null,
        `gap:add:${a}+?=${a + b}`, `gap:add:?+${b}=${a + b}`, a > b ? `gap:sub:${a}-?=${a - b}` : null, a > b ? `gap:sub:?-${b}=${a - b}` : null,
        `gap:times:${a}x?=${a * b}`, `gap:times:?x${b}=${a * b}`, `gap:div:?:${b}=${a}`, a % b === 0 ? `gap:div:${a}:?=${a / b}` : null]) {
        if (key) examine(Q.fromKey(key));
      }
    }
  }
  for (const key of ["add:300+400", "add:1000+2000", "sub:1000-300", "sub:9000-4000", "div:600:3", "div:2400:6", "times:100x50", "times:30x40", "add:1996+1998", "sub:5000-4999"]) examine(Q.fromKey(key));
  assert.ok(texts > 100000, `examined ${texts} texts`);
});

test("review: the closing line states the completed equation, also when a step looks the same", () => {
  // the first step of this explanation reads "412 - 200 = 212", the same as the closing equation
  assert.ok(Q.fromKey("gap:sub:412-?=212").explain.endsWith(`Dus 412 ${MIN} 200 = 212.`));
  for (const grade of GRADES) {
    for (const level of LEVELS) {
      for (const focus of FOCI) {
        for (let seed = 1; seed <= 40; seed++) {
          for (const q of Q.series({ grade, level, focus }, 10, rng(seed * 31 + level))) {
            if (q.kind === "story") continue;
            const full = q.text.replace("?", q.answer);
            assert.ok(q.explain.endsWith(`${full}.`), `explanation of ${q.text} must end with ${full}: ${q.explain}`);
          }
        }
      }
    }
  }
});

test("review: hints never say that only one place changes when a carry or borrow changes the next one too", () => {
  assert.ok(!/veranderen/.test(Q.fromKey("sub:100-20").hint), "100 - 20 changes the hundreds as well");
  assert.ok(!/veranderen/.test(Q.fromKey("add:47+60").hint), "47 + 60 changes the hundreds as well");
  for (const grade of GRADES) {
    for (const level of LEVELS) {
      for (const focus of ["add", "sub"]) {
        for (let seed = 1; seed <= 60; seed++) {
          for (const q of Q.series({ grade, level, focus }, 10, rng(seed * 7 + level))) {
            assert.ok(!/^Alleen de (tientallen|honderdtallen|duizendtallen) veranderen/.test(q.hint), `${q.text}: ${q.hint}`);
            if (/Alleen de eenheden veranderen/.test(q.hint)) {
              const s = solveText(q.text);
              const big = s.op === "+" ? Math.max(s.a, s.b) : s.a;
              const result = s.op === "+" ? s.a + s.b : s.a - s.b;
              assert.equal(Math.floor(big / 10), Math.floor(result / 10), `only the units may change: ${q.text}`);
            }
          }
        }
      }
    }
  }
});

test("review: groep 3 level 1 (within 10) has no tiental crossing, level 2 only doubles", () => {
  const crossing = (op, a, b) => (op === "+" ? a + b > 10 && Math.floor(a / 10) + Math.floor(b / 10) !== Math.floor((a + b) / 10) : a > 10 && a % 10 < b);
  for (let seed = 1; seed <= 400; seed++) {
    for (const q of Q.series({ grade: 3, level: 1 }, 10, rng(seed))) {
      const s = solveText(q.text);
      assert.ok(!crossing(s.op, s.a, s.b), `groep 3 level 1 must not cross the ten: ${q.text}`);
    }
    for (const q of Q.series({ grade: 3, level: 2 }, 10, rng(seed + 5000))) {
      const s = solveText(q.text);
      assert.ok(!crossing(s.op, s.a, s.b) || (s.op === "+" && s.a === s.b), `groep 3 level 2 only crosses the ten with a double: ${q.text}`);
    }
  }
  // ... and level 3 is where crossing the ten is practised
  let crossings = 0;
  for (let seed = 1; seed <= 100; seed++) {
    for (const q of Q.series({ grade: 3, level: 3 }, 10, rng(seed))) {
      const s = solveText(q.text);
      if (crossing(s.op, s.a, s.b)) crossings++;
    }
  }
  assert.ok(crossings > 100, `crossing the ten is practised in level 3 (${crossings})`);
});

test("review: gap sums are fair (known factor, tables of the level, small quotient)", () => {
  const tables = (grade, level) => (grade === 3 ? [2, 5, 10] : grade === 4 && level <= 2 ? [1, 2, 5, 10] : grade === 4 && level <= 4 ? [1, 2, 3, 4, 5, 10]
    : grade === 4 && level === 5 ? [1, 2, 3, 4, 5, 6, 9, 10] : null);
  let gaps = 0;
  for (const grade of GRADES) {
    for (const level of LEVELS) {
      for (const focus of ["mix", "times", "div"]) {
        for (let seed = 1; seed <= 150; seed++) {
          for (const q of Q.series({ grade, level, focus }, 10, rng(seed * 3 + grade))) {
            if (q.kind !== "gap") continue;
            const s = solveText(q.text);
            if (s.op === KEER) {
              const known = s.unknown === "a" ? s.b : s.a;
              assert.ok(known <= 10 || known % 10 === 0, `dividing by ${known} is no fair gap sum: ${q.text}`);
              const list = tables(grade, level);
              if (list && s.a <= 10 && s.b <= 10) assert.ok(list.includes(known), `known factor ${known} of ${q.text} is no table of groep ${grade} level ${level}`);
              gaps++;
            }
            if (s.op === ":" && s.unknown === "b") assert.ok(s.c <= 12, `how often does ${s.c} fit: ${q.text}`);
          }
        }
      }
    }
  }
  assert.ok(gaps > 1000, `${gaps} gap multiplications checked`);
  // with a chosen table every order is fine: ? x 8 = 56 practises the table of 7
  const seenHidden = new Set();
  for (let seed = 1; seed <= 100; seed++) {
    for (const q of Q.series({ grade: 4, level: 8, focus: "times", table: 7 }, 10, rng(seed))) {
      if (q.kind === "gap") seenHidden.add(solveText(q.text).unknown);
    }
  }
  assert.deepEqual([...seenHidden].sort(), ["a", "b"]);
});

// What a believable maximum per slot of every story is, written down independently of the engine.
const STORY_MAX = {
  tulpen: [250, 250], schelpen: [400, 400], fietsen: [300, 300], rondvaart: [60, 60], koeien: [120, 120], schelpweg: [500, 500],
  zakken: [500, 500], boten: [200, 200], bekers: [500, 500], appels: [6000, 6000], eieren: [400, 12], rijen: [400, 25], mensen: [10, 40],
  emmers: [10, 25], fietsrijen: [30, 30], meel: [400, 25], koekjes: [100, 100], tochtje: [300, 300], haven: [400, 400, 400],
  weekschelpen: [300, 300, 300], broodjes: [2000, 2000, 2000], knikkers: [600, 600, 600], verdeel: [600, 10], dozen: [3000, 10],
  bollen: [6000, 6000], plantrijen: [3000, 10],
};

test("review: story numbers stay believable (no 4957 shells on one beach, no 40 boats of 40 people)", () => {
  const seen = new Set();
  for (const grade of GRADES) {
    for (const level of LEVELS) {
      for (let seed = 1; seed <= 120; seed++) {
        for (const q of Q.series({ grade, level, focus: "story" }, 10, rng(seed * 11 + level + grade))) {
          const [, id, ...ns] = q.key.split(":");
          seen.add(id);
          const max = STORY_MAX[id];
          if (!max) continue;
          ns.map(Number).forEach((n, i) => assert.ok(n <= max[Math.min(i, max.length - 1)], `${id}: number ${n} in slot ${i} is not believable: ${q.text}`));
        }
      }
    }
  }
  for (const id of ["tulpen", "schelpen", "schelpweg", "weekschelpen", "emmers", "mensen", "eieren"]) assert.ok(seen.has(id), `${id} still occurs`);
  // thousands are carried by templates that can hold them: a festival, tickets, a bulb shed
  const big = new Set();
  for (let seed = 1; seed <= 200; seed++) {
    for (const q of Q.series({ grade: 6, level: 8, focus: "story" }, 10, rng(seed))) if (Math.max(...numsIn(q.text)) >= 1000) big.add(q.key.split(":")[1]);
  }
  assert.ok(big.size >= 5, `several templates carry thousands: ${[...big]}`);
  for (const id of big) assert.ok(["bollen", "appels", "feestmensen", "kaartjes", "bezoekers", "feestdrukte", "broodjes", "meel", "rijen", "eieren", "dozen", "plantrijen"].includes(id), `${id} should not hold thousands`);
});

test("review: gap hints are never empty phrases, also not when the answer equals a number in the sum", () => {
  const generic = new Set(["Welk getal hoort er op de plek van het vraagteken?", "Reken stap voor stap.", "Denk aan de tafel die erbij hoort.", "Denk aan de keersom die erbij hoort."]);
  for (let a = 1; a <= 40; a++) {
    for (let b = 1; b <= 40; b++) {
      for (const key of [`gap:add:${a}+?=${a + b}`, `gap:add:?+${b}=${a + b}`, a > b ? `gap:sub:${a}-?=${a - b}` : null, a > b ? `gap:sub:?-${b}=${a - b}` : null,
        `gap:times:${a}x?=${a * b}`, `gap:times:?x${b}=${a * b}`, `gap:div:?:${b}=${a}`, a % b === 0 ? `gap:div:${a}:?=${a / b}` : null]) {
        if (!key) continue;
        const q = Q.fromKey(key);
        assert.ok(!generic.has(q.hint), `${key}: ${q.hint}`);
        assert.ok(!hasNum(q.hint, q.answer), `${key} leaks: ${q.hint}`);
      }
    }
  }
  // squares: ? x 6 = 36 has the answer 6 in the sum itself, so the hint has to work without digits
  const sq = Q.fromKey("gap:times:?x6=36");
  assert.ok(!/\d/.test(sq.hint) && sq.hint.length > 20, sq.hint);
  assert.ok(!/Zeg de tafel van 4 op/.test(Q.fromKey("gap:times:?x4=200").hint), "no reciting the table up to 200");
});

test("review: wording a Dutch teacher would change stays out of hints and explanations", () => {
  const old = [/Je kunt ook aanvullen/, /corrigeer/, /Wat weggaat, haal je eraf/, /dat is keer\./, /en tel die stap voor stap erbij/, /en reken elk deel apart uit/,
    /Haal de (tientallen|honderdtallen|duizendtallen) van elkaar af/, /omgekeerde richting/, /tafel van 7 is tafel van 5 en 2 keer/i, /Welk getal keer het ene getal/];
  for (const grade of GRADES) {
    for (const level of LEVELS) {
      for (const focus of FOCI) {
        for (let seed = 1; seed <= 40; seed++) {
          for (const q of Q.series({ grade, level, focus }, 10, rng(seed * 37 + level))) {
            for (const re of old) assert.ok(!re.test(q.hint) && !re.test(q.explain), `${q.key}: ${re} in ${q.hint} | ${q.explain}`);
          }
        }
      }
    }
  }
  for (let a = 1; a <= 10; a++) for (let b = 1; b <= 10; b++) for (const re of old) assert.ok(!re.test(Q.fromKey(`times:${a}x${b}`).hint) && !re.test(Q.fromKey(`times:${a}x${b}`).explain));
});

test("review: methods follow the order of the sum and show every step", () => {
  assert.match(Q.fromKey("times:30x40").explain, /^3 × 4 = 12\. Er komen twee nullen achter: 1200\./);
  assert.match(Q.fromKey("times:40x30").explain, /^4 × 3 = 12\./);
  // dividing by 5 by doubling shows the doubled number
  let doubled = 0;
  for (let q = 2; q <= 60; q++) {
    const x = Q.fromKey(`div:${5 * q}:5`);
    if (/verdubbelen/.test(x.explain)) {
      assert.ok(x.explain.includes(`dubbel ${5 * q} is ${10 * q} en ${10 * q} : 10 = ${q}`), x.explain);
      doubled++;
    }
  }
  assert.ok(doubled > 5, `the doubling method occurs (${doubled})`);
  // 1 tiental is singular, 10 tientallen plural
  assert.ok(Q.fromKey("sub:100-90").explain.includes("10 tientallen − 9 tientallen = 1 tiental"));
  assert.ok(Q.fromKey("add:10+10").explain.length > 0);
});

test("review: odd rng arguments never throw (a number is a seed, anything else means unseeded)", () => {
  for (const bad of ["x", null, undefined, {}, [], NaN, Infinity, true]) {
    assert.doesNotThrow(() => Q.make({ grade: 4, level: 3 }, bad), String(bad));
    assert.equal(Q.series({ grade: 4, level: 3 }, 4, bad).length, 4);
  }
  const a = Q.series({ grade: 5, level: 4 }, 10, 42).map((q) => q.key);
  assert.deepEqual(a, Q.series({ grade: 5, level: 4 }, 10, 42).map((q) => q.key), "a number seeds the generator");
  assert.deepEqual(a, Q.series({ grade: 5, level: 4 }, 10, rng(42)).map((q) => q.key));
  assert.equal(Q.make({}, 7).key, Q.make({}, rng(7)).key);
  // reusing one rng object gives a new series each time, not the same one
  const r = rng(9);
  assert.notDeepEqual(Q.series({ grade: 4, level: 4 }, 10, r).map((q) => q.key), Q.series({ grade: 4, level: 4 }, 10, r).map((q) => q.key));
});
