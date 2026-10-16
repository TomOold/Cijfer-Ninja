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
};

const ENGLISH = /\b(the|and|minus|plus|times|divided|what|how|answer|correct|wrong|score)\b/i;

// Every invariant that holds for one question. `light` skips the slower lint.
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
  assert.equal(evalFormula(q.formula), q.answer, `formula ${q.formula} (${ctx})`);

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
      assert.equal(evalFormula(`${s.a}${s.op === MIN ? "-" : s.op === KEER ? "*" : s.op === ":" ? "/" : "+"}${s.b}`), q.answer);
    }
    if (s.op === ":" || q.text.includes(":")) {
      // a division sum is always exact, also when the gap hides a factor
      assert.ok(Number.isInteger(s.gap ? s.value : s.a / s.b));
    }
  }

  // rebuilding from the key gives exactly the same question
  assert.deepEqual(Q.fromKey(q.key), q, `fromKey round trip: ${q.key}`);

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
          list.forEach((q) => checkQuestion(q, true));

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
  assert.ok(built > 9000, `built ${built}`);
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
