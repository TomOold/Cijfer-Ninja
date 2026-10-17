# Report: opslag (RR.Store)

## Summary
RR.Store is done as the part file pure-opslag.js (about 680 lines, ASCII only, an IIFE that assigns RR.Store, no `const RR`) with a 140-test node:test suite. All 140 tests pass in about 4 seconds, also under TZ=Europe/Amsterdam and TZ=America/Los_Angeles, and next to rekenrace-race.test.mjs. I also ran 40 deliberate bugs against the suite (no pruning, no cross-tab sync, UTC dates, reusable ids and so on) and every one made it fail.

The store implements the BRIEF 5.1 contract in full:
- **Storage layout:** one key, 'rekenrace:v1', holding one JSON document.
- **Dependencies:** it hard-codes the hero ids, the 6 kinds and the 8 tracks, so it needs neither RR.Heroes nor RR.Tracks nor RR.Questions. There is no Date.now(), Math.random, window, document or localStorage access outside browserStorage(); a test traps all of them.
- **Saving:** it saves after every mutation and writes nothing when the serialised document is unchanged.
- **Robustness:**
  - Missing, hostile or throwing storage, corrupt JSON, wrong shapes and oversized blobs never throw. The store keeps working in memory or repairs the data field by field.
  - Counts are clamped to 999999, answers are pruned to the newest 400 per player, and kinds, outcomes, track ids 1..8 and places 1..4 are validated.
  - A stamp keeps the best place and the first date.

**Policy decisions:**
- **Newer-schema document:** it is never destroyed. We start fresh in memory and copy the blob to 'rekenrace:v1:future-v<N>' before our first write. If that copy fails we do not write at all.
- **First read throws:** the instance stays memory-only, because we cannot tell what is stored.
- **Two tabs:** storage is re-read before every mutation, so a stale tab adopts the other tab's data first and cannot overwrite it. The selected player stays per tab.
- **Recency:** it is the order of recording, not the raw clock, so a clock that jumps back cannot reorder history.

**Additions beyond the contract** (optional extras, nothing renamed):
- **`id` parameter:** `openKeys(n, id?)`, `trickyKeys(n, id?)`, `kindStats(id?)`, `stamps(id?)` and `nextTrack(id?)` accept a player id, so the Ouders screen can show every child without switching `current`.
- **`status()`:** returns `{ persistent, recovered }`, so the UI can warn that progress will not survive a closed tab.
- **`select(null)`:** clears the selection.
- **Exports:** `RR.Store.KEY` and `RR.Store.LIMITS`.

## Deviations from BRIEF
- Each answers[key] record also stores `kind` ({kind, ok, miss, last, t}); the assignment listed {ok, miss, last, t}. It makes trickyKeys independent of the key format. On load a missing or invalid kind is derived from the key prefix, or the record is dropped.
- rename() has one extra error code, 'unknown_player', for an unknown id; the BRIEF lists only name_empty and name_taken.
- addPlayer error precedence follows the BRIEF's listed order: name_empty, name_taken, too_many, bad_hero, bad_grade.

## Limitations
- Counting convention: ok = answered right on the first OR second try, miss = wrong after two tries, total = ok + miss. Per-kind accuracy is therefore generous; only answers[key].last keeps the first/second distinction, and trickyKeys only counts real misses. Say so in the Ouders UI copy.
- create(storage, now): if `now` is omitted the clock is () => 0, so stamp dates read '1970-01-01'. The integration code must pass () => Date.now() (or similar). Stamp dates are LOCAL calendar days (YYYY-MM-DD), not UTC.
- addPlayer does NOT select the new player; the UI must call select(id). The selection is persisted, so a reload restores `current`. The kiesspeler screen should call select(null) or ignore current() if it always wants the chooser.
- stamp() returns true for any valid input when a player is selected, even if a worse place changed nothing. To detect a NEW stamp, check stamps()[trackId] before calling it.
- Reads (players(), openKeys() and so on) use the in-memory copy and can be stale relative to another tab; only mutations re-sync from storage. After a failed save in one tab, another tab's newer write wins on the next sync.
- If the first getItem throws, that Store instance never writes (it cannot know what is stored). If the app is reopened while storage works, normal persistence resumes.
- Player names are raw user text: control and zero-width characters are removed, but '<', '&' and quotes are kept. The UI must render names with textContent, never innerHTML.
- Pruning is by recency, so a sum that was missed more than 400 other distinct sums ago is forgotten, including from openKeys. kinds counters are never pruned.
- A 'rekenrace:v1:future-v<N>' backup key is left behind in localStorage after a downgrade overwrite; nothing cleans it up. Stored documents over 2,000,000 characters are treated as corrupt; the real maximum is about 0.3 MB (8 players x 400 answers).
- A stored document with a missing or garbage version field is treated as corrupt and replaced on the first change, without a backup. Only newer integer versions get a backup.
- Digit strings ('5') are accepted for grade, track id, place, restAfter and the n limit, because they come from form fields; booleans for sound and music are strict.
- Not wired into `npm test`, and the test file needs either RR_PARTS_DIR or the finished rekenrace/index.html; that is the integrator's job. The date test sets process.env.TZ at runtime to prove local-day behaviour.

## Extra
RUN TESTS: cd /home/user/Cijfer-Ninja && RR_PARTS_DIR=/tmp/claude-0/-home-user-Cijfer-Ninja/00d1ad9b-1373-5505-a589-45c7888ab89a/scratchpad/parts node --test --test-reporter=spec tests/rekenrace-opslag.test.mjs   (140 tests, 17 suites, about 4 s; the slowest is the worst-case-size test, about 2.5 s). Scratch helpers, not deliverables: scratchpad/opslag-dev/{smoke.mjs,perf.mjs,mutate.py}; mutate.py applies 40 deliberate bugs to the part and shows the suite kills all of them.

PUBLIC API: RR.Store.create(storage, now) -> { players, addPlayer, removePlayer, select, current, setGrade, setHero, rename, resetProgress, recordAnswer, openKeys, trickyKeys, kindStats, stamp, stamps, nextTrack, settings, setSetting, status }; RR.Store.browserStorage() -> { getItem, setItem, removeItem, persistent() }; RR.Store.KEY === 'rekenrace:v1'; RR.Store.LIMITS === { nameLength: 12, players: 8, answers: 400, restAfter: 10 } (frozen; use for maxlength and the select range).
Return values: addPlayer and rename -> { ok:true, player:{id,name,hero,grade} } | { ok:false, error }. removePlayer, select, setGrade, setHero, resetProgress, recordAnswer, stamp and setSetting -> boolean. players()/current() return copies. stamps() -> { '3': { place, date } } as a copy, and nextTrack() -> 1..8, or 9 when all eight are stamped.
status() -> { persistent: boolean, recovered: null | 'corrupt' | 'future' | 'unreadable' }. persistent is false for no storage, an unreadable first read, a failed last save, or a browserStorage() that fell back to memory.
Ids: 'p' + base36 of a counter stored in the document (p1, p2, ... pa ...); never reused, even after removal and reload.
Performance: about 1.7 ms per recordAnswer with the largest possible document (8 players x 400 answers, about 266 KB), including the re-read of the storage.
browserStorage(): probes localStorage with a set/remove of 'rekenrace:probe'. On failure, or when a later write fails, values live in an in-memory shadow map that wins over the older real value; persistent() is true only while nothing is held only in the shadow. It reads globalThis.localStorage inside try/catch, so it is safe under plain Node and with a throwing getter.

EXACT STORED JSON (localStorage key 'rekenrace:v1'; this is what the tests assert, shown for 2 players, with the time as local noon on 2026-03-06):
{"v":1,"counter":2,"current":"p1","settings":{"sound":true,"music":false,"restAfter":4},"players":[{"id":"p1","name":"Eva","hero":"egel","grade":4,"answers":{"add:3+4":{"kind":"add","ok":1,"miss":0,"last":"first","t":1772794800000},"times:7x8":{"kind":"times","ok":1,"miss":1,"last":"second","t":1772794800000}},"kinds":{"add":{"ok":1,"total":1},"sub":{"ok":0,"total":0},"times":{"ok":1,"total":2},"div":{"ok":0,"total":0},"gap":{"ok":0,"total":0},"story":{"ok":0,"total":0}},"stamps":{"2":{"place":3,"date":"2026-03-06"}}},{"id":"p2","name":"Bo","hero":"uil","grade":6,"answers":{},"kinds":{"add":{"ok":0,"total":0},"sub":{"ok":0,"total":0},"times":{"ok":0,"total":0},"div":{"ok":0,"total":0},"gap":{"ok":0,"total":0},"story":{"ok":0,"total":0}},"stamps":{}}]}
Field rules:
- `current` is a player id or null.
- `answers` is ordered oldest to newest by position, and `t` never decreases along that order. The key is the Question.key. `last` is one of 'first', 'second', 'miss'. ok and miss are integers 0..999999.
- `kinds` always holds all 6 kinds in the order add, sub, times, div, gap, story, with 0 <= ok <= total <= 999999.
- `stamps` keys are '1'..'8', place is 1..4, and date is 'YYYY-MM-DD'.
- Sizes: name at most 12 code points and unique case-insensitively; at most 8 players; at most 400 answer keys per player, each key 1..80 characters with no control characters and not digits-only.
Newer-version blob backup key: 'rekenrace:v1:future-v<N>'.

INTEGRATION NOTES: pass now = () => Date.now() at the composition root (the Store itself never reads the clock). Show the 4 error codes name_empty / name_taken / too_many / bad_hero / bad_grade (+ unknown_player from rename) as friendly Dutch messages in the new-player form. Call RR.Store.browserStorage() once and pass the result to create(). No other part file is needed to load RR.Store (it only needs the `RR` object to exist), and the fence order in the BRIEF is respected.