// Local storage for Rekenrace: profiles, per-player answer statistics, stamps and
// settings, all in ONE localStorage entry ('rekenrace:v1'). DOM-free: the storage
// object and the clock are injected (see create()), nothing here reads window,
// Date.now() or Math.random().
//
// Stored document (JSON):
//   { v: 1, counter: 3, current: 'p2' | null,
//     settings: { sound: true, music: false, restAfter: 3 },
//     players: [ { id: 'p1', name: 'Eva', hero: 'egel', grade: 4,
//                  answers: { [key]: { kind, ok, miss, last, t } },   // oldest first
//                  kinds:   { [kind]: { ok, total } },                // all 6 kinds
//                  stamps:  { [trackId]: { place, date } } } ] }      // date 'YYYY-MM-DD'
//
// Counting convention: "ok" = the sum ended right (first or second try), "miss" =
// it ended wrong after two tries; total = ok + miss. The finer first/second
// distinction lives in answers[key].last only.
//
// Policies:
//  - Nothing ever throws to the caller. Without a usable storage the store keeps
//    working in memory (status().persistent === false).
//  - Unusable stored data (corrupt JSON, wrong shape, absurd size) is replaced by a
//    fresh document in memory; the bad blob stays in storage until the first real
//    change overwrites it. Parts that are merely off (a bad grade, a negative
//    count) are repaired in place instead, so one glitch never wipes a profile.
//  - A document from a NEWER schema version is never destroyed: we start fresh in
//    memory, and before our first write the blob is copied to
//    'rekenrace:v1:future-v<N>'. If that copy fails we do not write at all.
//  - If the very first read throws we cannot tell what is stored, so we never
//    write for the rest of this instance (memory only).
//  - Before every mutation the storage is re-read: if another tab saved in the
//    meantime its data is adopted first, so a stale tab cannot lose updates. The
//    "current player" stays tab-local across that merge.
//  - "Newest" is decided by position in `answers` (re-recorded keys move to the
//    end) and `t` never runs backwards, so a clock that jumps back cannot reorder
//    history or get fresh answers pruned first.
RR.Store = (function () {
  'use strict';

  const STORAGE_KEY = 'rekenrace:v1';
  const BACKUP_KEY_PREFIX = 'rekenrace:v1:future-v';
  const PROBE_KEY = 'rekenrace:probe';
  const SCHEMA_VERSION = 1;

  // Hard-coded on purpose: the store must work without RR.Heroes / RR.Tracks / RR.Questions.
  const HERO_IDS = ['egel', 'eekhoorn', 'pad', 'uil'];
  const KIND_IDS = ['add', 'sub', 'times', 'div', 'gap', 'story'];
  const OUTCOMES = ['first', 'second', 'miss'];
  const TRACK_COUNT = 8;
  const MAX_PLACE = 4;
  const MIN_GRADE = 3;
  const MAX_GRADE = 6;
  const DEFAULT_GRADE = 4;
  const DEFAULT_NAME = 'Speler';
  const NAME_MAX = 12;                // code points
  const MAX_PLAYERS = 8;
  const MAX_ANSWERS = 400;            // per player; the oldest are pruned
  const MAX_COUNT = 999999;
  const MAX_KEY_LENGTH = 80;
  const MAX_RAW_LENGTH = 2000000;     // a full document is well under 1 MB
  const MAX_SCANNED_PLAYERS = 64;     // entries looked at when loading a bloated array
  const MAX_REST_AFTER = 10;
  const T_MAX = Date.UTC(9999, 11, 30);  // keeps years four digits whatever the timezone
  const DEFAULT_SETTINGS = Object.freeze({ sound: true, music: false, restAfter: 3 });
  const ID_PATTERN = /^p[0-9a-z]{1,10}$/;
  const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
  // Controls (tab/newline already became spaces), lone surrogates, zero-width and
  // bidi override characters. ZWJ is kept so emoji sequences stay whole.
  const INVISIBLE = /[\p{Cc}\p{Cs}\u200b\u2060\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

  // ---------------------------------------------------------------- small helpers

  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  // Strict integer: a whole number, or a string of digits (form fields give strings).
  function toInt(v) {
    if (typeof v === 'number') return Number.isInteger(v) ? v + 0 : null;   // + 0 turns -0 into 0
    if (typeof v === 'string' && /^\s*\d{1,9}\s*$/.test(v)) return parseInt(v, 10);
    return null;
  }

  // Lenient count for stored data: junk becomes 0, fractions are cut, big values clamp.
  function toCount(v) {
    let n = 0;
    if (typeof v === 'number' && Number.isFinite(v)) n = Math.trunc(v);
    else if (typeof v === 'string' && /^\s*\d{1,9}\s*$/.test(v)) n = parseInt(v, 10);
    return Math.min(Math.max(n, 0), MAX_COUNT);
  }

  function toTime(v) {
    return typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(Math.floor(v), 0), T_MAX) : 0;
  }

  function pad(n, len) { return ('0000' + n).slice(-len); }

  // Local calendar date (a licence should show the day the family saw).
  function isoDate(ms) {
    const d = new Date(ms);
    return pad(d.getFullYear(), 4) + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2);
  }

  function validDate(s) {
    const m = typeof s === 'string' ? DATE_PATTERN.exec(s) : null;
    return !!m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31;
  }

  // Trim, collapse spaces, drop control/invisible characters, cap at 12 code points.
  function cleanName(raw) {
    if (typeof raw !== 'string') return '';
    const s = raw.normalize('NFC').replace(/\s/g, ' ').replace(INVISIBLE, '')
      .replace(/ {2,}/g, ' ').trim();
    return Array.from(s).slice(0, NAME_MAX).join('').trim();
  }

  function nameKey(name) { return name.toLowerCase(); }

  // Used when repairing loaded data: 'Eva' -> 'Eva 2', still within 12 code points.
  function uniqueName(name, taken) {
    if (!taken.has(nameKey(name))) return name;
    for (let n = 2; ; n++) {
      const suffix = ' ' + n;
      const cand = Array.from(name).slice(0, NAME_MAX - suffix.length).join('').trim() + suffix;
      if (!taken.has(nameKey(cand))) return cand;
    }
  }

  // Keys come from RR.Questions ('times:7x8', ...). Digit-only keys are refused
  // because JS would reorder them, and '__proto__' because it is not a normal property.
  // Control characters and lone surrogates (which JSON would blow up to \udXXX) are out too.
  function validKey(key) {
    return typeof key === 'string' && key.length > 0 && key.length <= MAX_KEY_LENGTH &&
      !/^\d+$/.test(key) && key !== '__proto__' && !/[\p{Cc}\p{Cs}]/u.test(key);
  }

  function idNumber(id) { return parseInt(id.slice(1), 36); }
  function findPlayer(d, id) {
    if (typeof id !== 'string') return null;
    for (let i = 0; i < d.players.length; i++) if (d.players[i].id === id) return d.players[i];
    return null;
  }

  function publicPlayer(p) { return { id: p.id, name: p.name, hero: p.hero, grade: p.grade }; }
  function failure(error) { return { ok: false, error: error }; }

  // ---------------------------------------------------------------- document model

  function freshKinds() {
    const kinds = {};
    KIND_IDS.forEach(function (k) { kinds[k] = { ok: 0, total: 0 }; });
    return kinds;
  }

  function freshDoc() {
    return {
      v: SCHEMA_VERSION,
      counter: 0,
      current: null,
      settings: Object.assign({}, DEFAULT_SETTINGS),
      players: []
    };
  }

  function sanitizeSettings(s) {
    const out = Object.assign({}, DEFAULT_SETTINGS);
    if (!isObj(s)) return out;
    if (typeof s.sound === 'boolean') out.sound = s.sound;
    if (typeof s.music === 'boolean') out.music = s.music;
    const r = toInt(s.restAfter);
    if (r !== null && r >= 0 && r <= MAX_REST_AFTER) out.restAfter = r;
    return out;
  }

  function sanitizeAnswers(src) {
    const list = [];
    if (isObj(src)) {
      Object.keys(src).forEach(function (key, index) {
        const rec = src[key];
        if (!validKey(key) || !isObj(rec)) return;
        let kind = rec.kind;
        if (KIND_IDS.indexOf(kind) < 0) kind = key.split(':')[0];
        if (KIND_IDS.indexOf(kind) < 0) return;
        let ok = toCount(rec.ok);
        let miss = toCount(rec.miss);
        let last = OUTCOMES.indexOf(rec.last) >= 0 ? rec.last : null;
        if (!last) {
          if (ok + miss === 0) return;   // an empty record says nothing; do not invent one
          last = miss > 0 ? 'miss' : 'first';
        }
        // the latest outcome must be reflected in the counters
        if (last === 'miss') miss = Math.max(miss, 1); else ok = Math.max(ok, 1);
        list.push({ key: key, index: index, rec: { kind: kind, ok: ok, miss: miss, last: last, t: toTime(rec.t) } });
      });
    }
    list.sort(function (a, b) { return a.rec.t - b.rec.t || a.index - b.index; });
    const out = {};
    list.slice(-MAX_ANSWERS).forEach(function (e) { out[e.key] = e.rec; });
    return out;
  }

  function sanitizeKinds(src) {
    const out = freshKinds();
    if (!isObj(src)) return out;
    KIND_IDS.forEach(function (k) {
      const rec = src[k];
      if (!isObj(rec)) return;
      const ok = toCount(rec.ok);
      out[k] = { ok: ok, total: Math.max(toCount(rec.total), ok) };
    });
    return out;
  }

  function sanitizeStamps(src, fallbackDate) {
    const out = {};
    if (!isObj(src)) return out;
    for (let t = 1; t <= TRACK_COUNT; t++) {
      const rec = src[String(t)];
      if (!isObj(rec)) continue;
      const place = toInt(rec.place);
      if (place === null || place < 1 || place > MAX_PLACE) continue;
      out[String(t)] = { place: place, date: validDate(rec.date) ? rec.date : fallbackDate };
    }
    return out;
  }

  // Turns any parsed JSON object into a valid document. Never throws on odd input
  // (the caller still wraps it, belt and braces).
  function sanitizeDoc(src, fallbackDate) {
    const doc = freshDoc();
    doc.settings = sanitizeSettings(src.settings);
    let counter = toCount(src.counter);

    const found = [];
    const list = Array.isArray(src.players) ? src.players : [];
    for (let i = 0; i < list.length && i < MAX_SCANNED_PLAYERS && found.length < MAX_PLAYERS; i++) {
      if (isObj(list[i])) found.push(list[i]);
    }

    // First pass: valid ids keep their identity (and raise the counter) ...
    const ids = new Set();
    const slots = found.map(function (p) {
      const id = typeof p.id === 'string' && ID_PATTERN.test(p.id) && !ids.has(p.id) ? p.id : null;
      if (id) { ids.add(id); counter = Math.max(counter, idNumber(id)); }
      return { src: p, id: id };
    });
    // ... second pass: everything else gets repaired.
    const taken = new Set();
    slots.forEach(function (slot) {
      const p = slot.src;
      let id = slot.id;
      while (!id) {
        counter += 1;
        const cand = 'p' + counter.toString(36);
        if (!ids.has(cand)) { id = cand; ids.add(id); }
      }
      const rawName = typeof p.name === 'number' ? String(p.name) : p.name;
      const name = uniqueName(cleanName(rawName) || DEFAULT_NAME, taken);
      taken.add(nameKey(name));
      const grade = toInt(p.grade);
      doc.players.push({
        id: id,
        name: name,
        hero: HERO_IDS.indexOf(p.hero) >= 0 ? p.hero : HERO_IDS[0],
        grade: grade !== null && grade >= MIN_GRADE && grade <= MAX_GRADE ? grade : DEFAULT_GRADE,
        answers: sanitizeAnswers(p.answers),
        kinds: sanitizeKinds(p.kinds),
        stamps: sanitizeStamps(p.stamps, fallbackDate)
      });
    });

    doc.counter = counter;
    doc.current = typeof src.current === 'string' && findPlayer(doc, src.current) ? src.current : null;
    return doc;
  }

  function copyStamps(stamps) {
    const out = {};
    Object.keys(stamps).forEach(function (k) { out[k] = { place: stamps[k].place, date: stamps[k].date }; });
    return out;
  }

  // ---------------------------------------------------------------- browser storage

  // localStorage that never throws. When it is missing, blocked, or refuses a write
  // (private mode, quota) the value is kept in a memory map so the game carries on.
  function browserStorage() {
    const shadow = new Map();   // values the real localStorage could not take
    let ls = null;
    try {
      const candidate = globalThis.localStorage;
      if (candidate && typeof candidate.getItem === 'function') {
        candidate.setItem(PROBE_KEY, '1');
        candidate.removeItem(PROBE_KEY);
        ls = candidate;
      }
    } catch (e) {
      ls = null;
    }
    return {
      getItem: function (key) {
        key = String(key);
        if (shadow.has(key)) return shadow.get(key);
        if (ls) { try { return ls.getItem(key); } catch (e) { /* fall through */ } }
        return null;
      },
      setItem: function (key, value) {
        key = String(key);
        value = String(value);
        if (ls) {
          try { ls.setItem(key, value); shadow.delete(key); return; } catch (e) { /* use the shadow */ }
        }
        shadow.set(key, value);
      },
      removeItem: function (key) {
        key = String(key);
        shadow.delete(key);
        if (ls) { try { ls.removeItem(key); } catch (e) { /* nothing to do */ } }
      },
      // true while everything written so far really reached localStorage
      persistent: function () { return ls !== null && shadow.size === 0; }
    };
  }

  // ---------------------------------------------------------------- the store

  function create(storage, now) {
    const clockFn = typeof now === 'function' ? now : function () { return 0; };
    let usable = false;
    try {
      usable = !!storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function';
    } catch (e) {
      usable = false;   // e.g. a proxy whose property access throws
    }

    let doc = freshDoc();
    let mode = 'memory';          // 'live' once the first read succeeded
    let lastRaw = null;           // what the storage held when we last looked or wrote
    let savedJson = '';           // canonical form of the document as of the last sync/save
    let foreign = null;           // { raw, version } of a newer-schema blob awaiting backup
    let saveOk = true;
    let recovered = null;         // why stored data was not used: 'corrupt' | 'future' | 'unreadable'

    function clock() {
      let v = 0;
      try { v = Number(clockFn()); } catch (e) { v = 0; }
      return Number.isFinite(v) ? Math.min(Math.max(Math.floor(v), 0), T_MAX) : 0;
    }

    function fetchRaw() {
      try { return { raw: storage.getItem(STORAGE_KEY) }; } catch (e) { return null; }
    }

    // Validates what the storage returned. Never throws.
    function interpret(raw) {
      if (raw === null || raw === undefined) return { kind: 'none', raw: null };
      if (typeof raw !== 'string') return { kind: 'corrupt', raw: null };
      if (raw.length > MAX_RAW_LENGTH) return { kind: 'corrupt', raw: raw };
      try {
        const parsed = JSON.parse(raw);
        if (!isObj(parsed)) return { kind: 'corrupt', raw: raw };
        const v = toInt(parsed.v);
        if (v !== null && v > SCHEMA_VERSION) return { kind: 'future', raw: raw, version: v };
        if (v !== SCHEMA_VERSION) return { kind: 'corrupt', raw: raw };
        return { kind: 'ok', raw: raw, doc: sanitizeDoc(parsed, isoDate(clock())) };
      } catch (e) {
        return { kind: 'corrupt', raw: raw };
      }
    }

    if (usable) {
      const fetched = fetchRaw();
      if (!fetched) {
        recovered = 'unreadable';
      } else {
        const r = interpret(fetched.raw);
        mode = 'live';
        lastRaw = r.raw;
        if (r.kind === 'ok') doc = r.doc;
        else if (r.kind === 'corrupt' || r.kind === 'future') recovered = r.kind;
        if (r.kind === 'future') foreign = { raw: r.raw, version: r.version };
      }
    }
    savedJson = JSON.stringify(doc);

    // Picks up what another tab saved since we last looked. False = storage unreadable.
    function sync() {
      if (mode !== 'live') return true;
      const fetched = fetchRaw();
      if (!fetched) return false;
      if (fetched.raw === lastRaw) return true;
      const r = interpret(fetched.raw);
      lastRaw = r.raw;
      foreign = r.kind === 'future' ? { raw: r.raw, version: r.version } : null;
      if (r.kind === 'ok') {
        const keep = doc.current;   // the selected player is per tab
        r.doc.current = findPlayer(r.doc, keep) ? keep : null;
        doc = r.doc;
        savedJson = JSON.stringify(doc);
      }
      // anything else (emptied or broken elsewhere): our memory copy wins and is rewritten
      return true;
    }

    function persist(readable) {
      if (mode !== 'live') return;
      if (!readable) { saveOk = false; return; }
      let json;
      try { json = JSON.stringify(doc); } catch (e) { saveOk = false; return; }
      if (json === savedJson) return;   // nothing changed: no write
      try {
        if (foreign) {
          storage.setItem(BACKUP_KEY_PREFIX + foreign.version, foreign.raw);
          foreign = null;
        }
        storage.setItem(STORAGE_KEY, json);
        lastRaw = savedJson = json;
        saveOk = true;
      } catch (e) {
        saveOk = false;
      }
    }

    // Every change goes through here: sync, apply to memory, save if different.
    function mutate(fn) {
      const readable = sync();
      const result = fn();
      persist(readable);
      return result;
    }

    function currentPlayer() { return findPlayer(doc, doc.current); }
    // Read helpers take an optional player id so a parents screen can look at any
    // profile without switching the selected one.
    function subject(id) { return id === undefined || id === null ? currentPlayer() : findPlayer(doc, id); }

    // How many rows a caller asked for: undefined = all, junk = none.
    function limitOf(n) {
      if (n === undefined) return MAX_ANSWERS;
      if (typeof n === 'string') n = toInt(n);
      return typeof n === 'number' && n > 0 ? Math.min(Math.floor(n), MAX_ANSWERS) : 0;
    }

    function nextId() {
      let id;
      do { doc.counter += 1; id = 'p' + doc.counter.toString(36); } while (findPlayer(doc, id));
      return id;
    }

    function nameTaken(name, exceptId) {
      const key = nameKey(name);
      return doc.players.some(function (p) { return p.id !== exceptId && nameKey(p.name) === key; });
    }

    // ---- players

    function players() { return doc.players.map(publicPlayer); }

    function current() {
      const p = currentPlayer();
      return p ? publicPlayer(p) : null;
    }

    function addPlayer(input) {
      const src = isObj(input) ? input : {};
      const name = cleanName(src.name);
      if (!name) return failure('name_empty');
      const grade = toInt(src.grade);
      return mutate(function () {
        if (nameTaken(name, null)) return failure('name_taken');
        if (doc.players.length >= MAX_PLAYERS) return failure('too_many');
        if (HERO_IDS.indexOf(src.hero) < 0) return failure('bad_hero');
        if (grade === null || grade < MIN_GRADE || grade > MAX_GRADE) return failure('bad_grade');
        const p = {
          id: nextId(), name: name, hero: src.hero, grade: grade,
          answers: {}, kinds: freshKinds(), stamps: {}
        };
        doc.players.push(p);
        return { ok: true, player: publicPlayer(p) };
      });
    }

    function removePlayer(id) {
      if (typeof id !== 'string') return false;
      return mutate(function () {
        if (!findPlayer(doc, id)) return false;
        doc.players = doc.players.filter(function (p) { return p.id !== id; });
        if (doc.current === id) doc.current = null;
        return true;
      });
    }

    // select(null) clears the selection ("andere speler").
    function select(id) {
      if (id !== null && id !== undefined && typeof id !== 'string') return false;
      return mutate(function () {
        if (id === null || id === undefined) { doc.current = null; return true; }
        if (!findPlayer(doc, id)) return false;
        doc.current = id;
        return true;
      });
    }

    function setGrade(id, grade) {
      const g = toInt(grade);
      if (typeof id !== 'string' || g === null || g < MIN_GRADE || g > MAX_GRADE) return false;
      return mutate(function () {
        const p = findPlayer(doc, id);
        if (!p) return false;
        p.grade = g;
        return true;
      });
    }

    function setHero(id, hero) {
      if (typeof id !== 'string' || HERO_IDS.indexOf(hero) < 0) return false;
      return mutate(function () {
        const p = findPlayer(doc, id);
        if (!p) return false;
        p.hero = hero;
        return true;
      });
    }

    // Errors: name_empty, name_taken (by ANOTHER player), unknown_player.
    function rename(id, name) {
      const clean = cleanName(name);
      if (!clean) return failure('name_empty');
      if (typeof id !== 'string') return failure('unknown_player');
      return mutate(function () {
        const p = findPlayer(doc, id);
        if (!p) return failure('unknown_player');
        if (nameTaken(clean, id)) return failure('name_taken');
        p.name = clean;
        return { ok: true, player: publicPlayer(p) };
      });
    }

    function resetProgress(id) {
      if (typeof id !== 'string') return false;
      return mutate(function () {
        const p = findPlayer(doc, id);
        if (!p) return false;
        p.answers = {};
        p.kinds = freshKinds();
        p.stamps = {};
        return true;
      });
    }

    // ---- answers

    function recordAnswer(key, kind, outcome) {
      if (!validKey(key) || KIND_IDS.indexOf(kind) < 0 || OUTCOMES.indexOf(outcome) < 0) return false;
      if (!currentPlayer()) return false;
      return mutate(function () {
        const p = currentPlayer();
        if (!p) return false;
        const answers = p.answers;
        const prev = has(answers, key) ? answers[key] : null;
        let t = clock();
        Object.keys(answers).forEach(function (k) { if (answers[k].t > t) t = answers[k].t; });
        const good = outcome !== 'miss';
        const rec = { kind: kind, ok: prev ? prev.ok : 0, miss: prev ? prev.miss : 0, last: outcome, t: t };
        if (good) rec.ok = Math.min(rec.ok + 1, MAX_COUNT); else rec.miss = Math.min(rec.miss + 1, MAX_COUNT);
        delete answers[key];
        answers[key] = rec;   // re-insert: object order is recency order
        const keys = Object.keys(answers);
        for (let i = 0; i < keys.length - MAX_ANSWERS; i++) delete answers[keys[i]];

        const ks = p.kinds[kind];
        ks.total = Math.min(ks.total + 1, MAX_COUNT);
        if (good) ks.ok = Math.min(ks.ok + 1, ks.total);
        return true;
      });
    }

    // Keys whose latest outcome was second/miss, newest first. A later 'first' closes one.
    function openKeys(n, id) {
      const p = subject(id);
      if (!p) return [];
      const keys = Object.keys(p.answers);
      const max = limitOf(n);
      const out = [];
      for (let i = keys.length - 1; i >= 0 && out.length < max; i--) {
        if (p.answers[keys[i]].last !== 'first') out.push(keys[i]);
      }
      return out;
    }

    // Sums that were missed at least once: most misses first, then most recent.
    function trickyKeys(n, id) {
      const p = subject(id);
      if (!p) return [];
      const keys = Object.keys(p.answers);
      const rows = [];
      keys.forEach(function (key, position) {
        const rec = p.answers[key];
        if (rec.miss > 0) rows.push({ key: key, kind: rec.kind, miss: rec.miss, ok: rec.ok, position: position });
      });
      rows.sort(function (a, b) { return b.miss - a.miss || b.position - a.position; });
      return rows.slice(0, limitOf(n)).map(function (r) {
        return { key: r.key, kind: r.kind, miss: r.miss, ok: r.ok };
      });
    }

    function kindStats(id) {
      const p = subject(id);
      return KIND_IDS.map(function (kind) {
        const k = p ? p.kinds[kind] : null;
        return { kind: kind, ok: k ? k.ok : 0, total: k ? k.total : 0 };
      });
    }

    // ---- stamps

    function stamp(trackId, place) {
      const tr = toInt(trackId);
      const pl = toInt(place);
      if (tr === null || tr < 1 || tr > TRACK_COUNT || pl === null || pl < 1 || pl > MAX_PLACE) return false;
      if (!currentPlayer()) return false;
      return mutate(function () {
        const p = currentPlayer();
        if (!p) return false;
        const k = String(tr);
        if (!has(p.stamps, k)) p.stamps[k] = { place: pl, date: isoDate(clock()) };
        else if (pl < p.stamps[k].place) p.stamps[k].place = pl;   // best place, first date
        return true;
      });
    }

    function stamps(id) {
      const p = subject(id);
      return p ? copyStamps(p.stamps) : {};
    }

    function nextTrack(id) {
      const p = subject(id);
      for (let t = 1; t <= TRACK_COUNT; t++) {
        if (!p || !has(p.stamps, String(t))) return t;
      }
      return TRACK_COUNT + 1;
    }

    // ---- settings (global, not per player)

    function settings() { return Object.assign({}, doc.settings); }

    function setSetting(name, value) {
      let v;
      if (name === 'sound' || name === 'music') {
        if (typeof value !== 'boolean') return false;
        v = value;
      } else if (name === 'restAfter') {
        v = toInt(value);
        if (v === null || v < 0 || v > MAX_REST_AFTER) return false;
      } else {
        return false;
      }
      return mutate(function () {
        doc.settings[name] = v;
        return true;
      });
    }

    // persistent: data really reaches the storage (browserStorage() reports it when it
    // had to fall back to memory). recovered: why stored data was not used, if so.
    function status() {
      let backend = usable;
      try {
        if (usable && typeof storage.persistent === 'function') backend = !!storage.persistent();
      } catch (e) {
        backend = false;
      }
      return { persistent: mode === 'live' && saveOk && backend, recovered: recovered };
    }

    return {
      players: players, addPlayer: addPlayer, removePlayer: removePlayer,
      select: select, current: current,
      setGrade: setGrade, setHero: setHero, rename: rename, resetProgress: resetProgress,
      recordAnswer: recordAnswer, openKeys: openKeys, trickyKeys: trickyKeys, kindStats: kindStats,
      stamp: stamp, stamps: stamps, nextTrack: nextTrack,
      settings: settings, setSetting: setSetting,
      status: status
    };
  }

  return {
    create: create,
    browserStorage: browserStorage,
    KEY: STORAGE_KEY,
    LIMITS: Object.freeze({ nameLength: NAME_MAX, players: MAX_PLAYERS, answers: MAX_ANSWERS, restAfter: MAX_REST_AFTER })
  };
})();
