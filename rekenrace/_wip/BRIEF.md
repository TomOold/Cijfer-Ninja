# BRIEF — "Rekenrace" (calm 90s-style math racing game)

Read this whole document before touching anything. Every agent on this project works
from it. Where it says MUST, it is a hard requirement that a reviewer will check.

## 1. What we are building

The user (a Dutch parent) wrote, verbatim:

> "Kan jij deze game vibe coden voor mij voor in de browser? Ik mis een fatsoenlijke game voor mijn
> kids zonder al te veel dopamine hits. Dus eigenlijk gewoon weer de rustige jaren 90 spellen waar
> ik ook mee ben opgegeten. Graag aparte sub iets maken op de repository."

The reference is *RedCat: De Razende Rekenrace* (Davilex, ~1997, Dutch edutainment for primary
school kids, Windows 3.x/95). What we could establish about it: you play a hero who uses
arithmetic skill to beat two villains over a series of race tracks; there are several modes.
We could NOT access the original, so this is a **new game in the same spirit, not a clone**.

**IP rule (MUST):** do not use the names RedCat/Redcat, Davilex, Brutus, Max de Muis, Bulldog, or
any original art/music/layout. All characters, names, art, text and music are our own.

Deliverable: a new, separate sub-project in the existing repo, folder `rekenrace/`, served at
`/rekenrace` on Vercel. Target players: Dutch primary school kids, groep 3–6 (≈ 6–10 years).
All user-facing text is **Dutch (nl-NL)**, "je/jij" form, simple words.

The repo is `Cijfer-Ninja` ("Nummers Ninja", a different, flashier game with coins/XP/shop —
do NOT copy its gamification). Read `/home/user/Cijfer-Ninja/CLAUDE.md` for repo conventions:
zero build step, zero npm dependencies, one self-contained HTML file, pure logic fenced between
`// ===PURE===` and `// ===ENDPURE===` so Node tests can load it. Do not modify any existing file
outside `rekenrace/`, `tests/` (new files only) unless your assignment says so.

## 2. Product vision: "a quiet afternoon with a good educational game"

Feel: 1990s Dutch edutainment CD-ROM. Friendly cartoon animals, chunky pixel art with a limited
VGA-ish palette (but tasteful, softer than neon), bevelled Windows-95-style buttons, a gentle
tune, a slow pace. Nothing grabs the child by the collar. A kid should be able to finish a race,
feel calmly pleased, and put the device down.

### Core loop
A **race** is exactly **10 sums** ("poortjes"). Four animal karts race side-on across a Dutch
landscape (tulip fields, windmill polder, dunes and beach, woods, canal town, harbour, ice rink,
hill country). Each sum: the question is shown big, the child types the answer on a number keypad
(or keyboard) and confirms. Right → their kart glides forward. The race is **turn-based, never
clock-based**: nothing moves while the child thinks; there is no timer anywhere.
After 10 sums the race ends, standings are shown calmly, the child gets a stamp.

### Players
Local profiles only (several kids share one device): name (max 12 chars) + choice of 1 of 4
heroes + grade (groep 3/4/5/6). The 3 heroes the child did NOT pick are the rival karts.
No accounts, no backend, no network requests of any kind. Data lives in `localStorage` only
(wrapped in try/catch with in-memory fallback; the game must still work with storage blocked).

### Modes
1. **Kampioenschap** (championship): 8 tracks in a fixed order, each a bit harder. Finishing a
   race in ANY place earns that track's stamp; the next track unlocks. After all 8 stamps the
   child may print a "Rekenrijbewijs" (driver's licence) — a pretty printable page.
2. **Vrije race**: pick any unlocked track and a focus (door elkaar / optellen / aftrekken /
   tafels / delen / verhaalsommen, and optionally one specific table 1–10). No stamp; for
   practice. Parents love this one.
3. **Ouders** screen (parents): per-player accuracy per kind of sum, the trickiest sums,
   settings (sound, music, "rustmoment na X races", grade), reset progress. Simple, plain, no jargon.

### Heroes (original) — `RR.Heroes`
| id | name | animal | note |
|---|---|---|---|
| `egel` | Eef de Egel | hedgehog | warm orange kart |
| `eekhoorn` | Sien de Eekhoorn | squirrel | teal kart |
| `pad` | Bram de Pad | toad | green/yellow kart |
| `uil` | Oeke de Uil | owl | purple/pink kart |
Silhouettes and colours must be distinguishable from each other even for colour-blind kids.

### Tracks (original, Dutch flavour) — `RR.Tracks`, always 8, fixed order
| id | theme | name | sceneryy ideas |
|---|---|---|---|
| 1 | `tulips` | Tulpenveld | striped tulip rows, a farm, clouds, flat horizon |
| 2 | `windmill` | Molenpolder | windmills with slowly turning sails, ditches, cows, dike |
| 3 | `beach` | Strand en duinen | dunes, beach huts, sea with small waves, gulls, strandpaviljoen |
| 4 | `forest` | Dennenbos | pines, mushrooms, ferns, squirrel-ish dapples of light |
| 5 | `canal` | Grachtenstad | narrow gabled canal houses, bridge, bikes, canal reflection |
| 6 | `harbour` | Haven | cranes, boats, containers, lighthouse |
| 7 | `ice` | IJsbaan | frozen canal, koek-en-zopie stall, snowy trees, pale low sun |
| 8 | `hills` | Heuvelland | rolling green hills, vineyards, half-timbered farms, castle on a hill |
Each track has a one-sentence friendly Dutch `blurb`.

## 3. The calm-design contract (anti-dopamine rules) — MUST

A dedicated reviewer will audit the finished game against every line below.

- **D1 No time pressure.** No timers, countdowns, speed bonuses, "hurry" bars. Game state never
  depends on wall-clock time. (Only *animations* use time.)
- **D2 No score inflation.** No points, coins, XP, multipliers, combos, streak counters,
  "perfect!" counters, levels with growing numbers. The only numbers shown are plain facts:
  "Som 4 van 10", "7 van 10 goed".
- **D3 No variable rewards.** No random drops, mystery boxes, loot, unlockable cosmetics shop.
  Every reward is deterministic and modest: one stamp per finished track, one licence at the end.
- **D4 No sensory spikes.** No flashing, screen shake, confetti, fireworks, particle bursts,
  full-screen colour flashes, zooms or sudden movement. All animation eases gently. Large-area
  changes never alternate faster than ~2 Hz; small sprite-frame animation (wheels, windmill
  sails) is fine up to ~6 Hz and only while something is actually moving. `prefers-reduced-motion:
  reduce` MUST turn motion down to short fades/instant moves and stop all idle drift.
- **D5 Calm copy.** Short, warm, factual Dutch. At most one "!" per message, no ALL CAPS, no
  hype words ("GEWELDIG!!", "AMAZING"). A wrong answer is never "FOUT!": use "Nog niet helemaal."
  / "Bijna." and give a tip. Never red flashing, never a buzzer.
- **D6 Quiet sound.** Soft synthesized sounds, master volume low (peak well under 0.3), no
  fanfares, no buzzers. Sound has an always-reachable mute button. Music exists (a slow, gentle
  pentatonic loop) but is **off by default**; sound effects on by default but quiet. Nothing
  plays before the first user gesture.
- **D7 Natural stopping points.** A race has a fixed end. After the finish nothing auto-starts;
  the primary button returns to the "garage" (menu), "Nog een keer" is secondary and plain.
  After N races in one sitting (default 3; parents can set 1–10 or off) a friendly
  "rustmoment" screen suggests a break ("Mooi gedaan. Tijd voor een pauze?") with the
  default button being "Stoppen"; "Toch nog een race" is available but visually quieter.
  No daily streaks, no "come back tomorrow", no notifications, no leaderboards, no comparison
  between kids/siblings anywhere.
- **D8 Failure never blocks.** No lives, no game over. A race always completes. Any finishing
  place earns the stamp. Finishing last is shown with the same calm tone as finishing first.
- **D9 Private & offline.** No network requests, no trackers, no accounts, no ads, no external
  fonts/CDNs. Works from `file://` and from Vercel. Everything is inline in one HTML file.
- **D10 Honest progress.** Linear, visible. No hidden systems.
- **D11 Standings tone.** "Je bent als tweede over de finish gekomen." — no loser jingle,
  no "you lost", no red.
- **D12 Pace is the child's.** After a right answer the kart glides and the next sum appears when
  the glide ends (animation-driven, not a countdown). After a wrong answer the explanation stays
  until the child presses "Volgende" — no auto-advance.

### Answer handling (per sum)
1st attempt right → outcome `first`. 1st wrong → show the sum's `hint` (never contains the
answer), child may try once more. 2nd attempt right → `second`. 2nd wrong → show `explain`
(which contains the answer and *how to get there*), outcome `miss`, child presses "Volgende".
Typed input is a non-negative integer; the answer field accepts only digits (max 5), ignores
leading zeros when checking.

## 4. Curriculum: what the sums are (Dutch rekenmethode conventions)

Notation (MUST be consistent everywhere): `×` for keer, **`:` for delen** (Dutch schools write
`56 : 8 = 7`, NOT ÷), `+`, `−` (U+2212). Unknown is `?` (e.g. `24 + ? = 51`, `7 × ? = 56`).
No thousands separators: **every number in the game is < 10 000** (answers 0–9999).
No decimals, no fractions, no remainders, no negatives (including intermediate results).
Money, if used, in whole euros or whole cents ("65 cent"), never "€ 2,50".

Sum kinds (`kind`): `add` Optellen, `sub` Aftrekken, `times` Tafels, `div` Delen,
`gap` Gaatjessommen (missing number in +, −, ×, :), `story` Verhaalsommen (1–2 sentences,
1 or 2 steps at higher levels). `level` = track number 1..8, `grade` = 3..6. Guidance (the
Questions author may refine, but keep the spirit and gentle ramp; early levels of each grade
must feel easy and confidence-building):

- **Groep 3**: L1–2 + and − within 10/20 (incl. doubling), L3–4 within 20 with bridging and
  whole tens (30 + 20, 50 − 20), L5–6 within 100 (34 + 5, 47 + 20, 63 − 8), L7–8 within 100
  with bridging (47 + 36), tables 2, 5, 10 (3 × 5), short stories.
- **Groep 4**: L1–2 + and − to 100 with bridging, tables 1, 2, 5, 10; L3–4 tables 3 and 4 plus
  the matching division (`24 : 4`), whole hundreds (300 + 400); L5–6 add tables 6, 9 (L5) then
  7, 8 (L6), + and − to 1000 (347 + 200, 472 − 35), gap sums; L7–8 all tables 1–10 mixed with
  division, 3-digit + and − with bridging (458 + 267), tens × single digit (30 × 4), stories.
- **Groep 5**: L1–2 all tables mixed + division + gaps, + and − to 1000 with bridging; L3–4
  2-digit × 1-digit (23 × 4), 3-digit ± 3-digit; L5–6 exact division 2-digit : 1-digit (84 : 4),
  tens × tens (30 × 40), + and − to 10 000 with round numbers (4500 + 3200 — keep answers
  < 10 000); L7–8 3-digit × 1-digit (136 × 5 — keep < 10 000), exact 3-digit : 1-digit, 2-step stories.
- **Groep 6**: L1–2 fluent tables/division and 2-digit × 1-digit; L3–4 3-digit × 1-digit,
  2-digit × tens; L5–6 ± up to 9999; L7–8 2-digit × 2-digit (23 × 12), exact 3-digit : 1-digit,
  2-step stories.

Within a series of 10 the sums rise gently in difficulty ("warm up" first), kinds are varied
(no 3 identical kinds in a row where avoidable), all answers distinct, and 0–2 earlier-missed
sums (from `repeat`, rebuilt through `fromKey`) are woven in at easy positions — spaced
repetition without ever calling it that.

Hints/explanations teach the Dutch way of thinking: splitsen / rijgen / aanvullen tot 10, 100,
verdubbelen, "tafel van 6 = tafel van 5 + 1 keer erbij", delen als omgekeerde keersom
("56 : 8 → welke keer 8 is 56?"). Never reveal the answer in `hint`; always show answer + method
in `explain`.

Story problems: every number in a story must be ≥ 2 so plurals are always correct; use
natural child-friendly Dutch with correct "de/het", plural forms and spelling. No violence,
no brand names, no food-shaming, no gendered stereotypes. 15+ different templates, themed on
the game's world (tulpen plukken, molenwieken, schelpen verzamelen, fietsen, boten, ...).

## 5. Architecture — ONE self-contained file

Final deliverable: `rekenrace/index.html` — inline `<style>` and one inline `<script>`, no
external requests, no build step, works from `file://`. (Because Vercel runs with
`cleanUrls` + `trailingSlash:false`, a page at `/rekenrace` cannot safely use relative URLs
for sub-resources — so single file, no asset files, all art generated in code.)

While building in parallel, each author writes their module as a plain JS **part file** in the
scratchpad folder `parts/` (path given in your assignment); a later integration step inlines
them into `index.html` in this order:

```js
const RR = {};                       // the only global namespace
// ===PURE===                        // everything between the fences must be DOM-free
RR.Rng ...        (parts/pure-rng.js    — already written, read it)
RR.Questions ...  (parts/pure-sommen.js)
RR.Heroes, RR.Tracks, RR.Race ... (parts/pure-race.js)
RR.Store ...      (parts/pure-opslag.js)
// ===ENDPURE===
RR.Sprites ...    (parts/sprites.js)   canvas pixel art (browser only)
RR.Scene ...      (parts/scene.js)     scene renderer + animation (browser only)
RR.Sound ...      (parts/geluid.js)    WebAudio (browser only)
...UI code (integration step)
```

Module pattern (MUST): `RR.Name = (function () { 'use strict'; ...; return { ... }; })();`
Part files must NOT declare `const RR` themselves (it's declared once at the top of the final
script). English identifiers, English code comments, Dutch user-facing strings — same as the
rest of the repo. Comment density: light (explain *why*, not *what*). 2-space indent, `const`/`let`,
no frameworks, no ES modules, no optional chaining required but allowed (modern evergreen
browsers only: Chrome/Safari/Firefox of the last ~3 years, iPad Safari included).

Pure modules (Rng, Questions, Heroes/Tracks/Race, Store) MUST NOT touch `window`, `document`,
`localStorage`, `Math.random` (except inside `Rng.random()`), `Date.now()` (take a `now`
parameter or an injectable clock instead). They must run under plain Node.

### 5.1 Contracts (do not deviate; if you believe a change is essential, say so in your report)

```text
RR.Rng:   make(seed) -> rng()      random() -> rng()      int(rng,min,max)   pick(rng,list)   shuffle(rng,list)

RR.Questions
  KINDS      { add:'Optellen', sub:'Aftrekken', times:'Tafels', div:'Delen', gap:'Gaatjessommen', story:'Verhaalsommen' }
  FOCI       ['mix','add','sub','times','div','story']   // 'mix' = everything for grade/level
  make(opts, rng)           -> Question
  series(opts, count, rng)  -> Question[]    // count normally 10
  fromKey(key)              -> Question|null // rebuilds the exact question from its key (stories too)
  check(question, input)    -> boolean       // input: string or number; digits only; leading zeros OK
  opts = { grade: 3|4|5|6, level: 1..8, focus?: 'mix'|..., table?: 1..10, repeat?: string[] }
      // `table` restricts times/div (and gap-times/div) to that table
  Question = {
    key,      // stable, parseable, unique per exact question, e.g. 'times:7x8', 'gap:add:24+?=51', 'story:eieren:6:8'
    kind,     // one of KINDS keys
    text,     // Dutch display text; '?' marks the unknown; stories may contain '\n'
    answer,   // integer 0..9999
    hint,     // one gentle line, never contains the answer
    explain,  // shows the method AND the answer
    formula   // JS arithmetic expression string that evaluates to `answer` (independent check used by tests)
  }

RR.Heroes: [{ id, name, animal }]  (4, see table)       RR.Tracks: [{ id, theme, name, blurb, length: 10 }]  (8)

RR.Race  (pure race state machine; positions are in "track units", finish line at `length`)
  create({ track, hero, seed })            -> state     // track = Tracks entry or id; hero = hero id
  advance(state, outcome)                  -> { gains: { [heroId]: number }, done: boolean }
      // outcome 'first'|'second'|'miss'; mutates state; throws if already done
  positions(state)                         -> { [heroId]: number }
  standings(state)                         -> [{ id, name, pos, place, isPlayer }]  // place 1..4, best first
  summary(state)                           -> { place, first, second, miss, total, done }
  racers(state)                            -> [{ id, name, isPlayer, lane }]        // lane 0..3, player always lane 0
  // Rules: player gain first=1.0, second=0.8, miss=0.5 per sum (so a race always finishes and
  // a perfect race always wins). Rivals gain tempo±jitter per sum from a seeded rng; rival tempos
  // rise gently with track id (≈0.70/0.80/0.90 on track 1 → ≈0.76/0.86/0.94 on track 8) and
  // can never overtake a perfect player. Ties: player ranks ahead. Deterministic per seed.

RR.Store  (localStorage-backed, storage injected)
  create(storage, now)  // storage: { getItem, setItem, removeItem } or null → memory; now: () => ms epoch
  RR.Store.browserStorage() -> localStorage wrapper that never throws (falls back to memory)
  players() -> [{id,name,hero,grade}]    removePlayer(id)
  addPlayer({name,hero,grade}) -> { ok:true, player } | { ok:false, error:'name_empty'|'name_taken'|'too_many'|'bad_hero'|'bad_grade' }
      // name: trimmed, spaces collapsed, control chars removed, max 12 chars (by code point), unique case-insensitively, max 8 players
  select(id)   current() -> player|null  setGrade(id,grade)   setHero(id,hero)   rename(id,name) -> same ok/error shape
  // recordAnswer & co. are no-ops (return false) when no player is selected
  recordAnswer(key, kind, outcome)       // current player; updates per-key + per-kind stats
  openKeys(n) -> string[]                // up to n keys whose latest outcome was second/miss (newest first)
  trickyKeys(n) -> [{key, kind, miss, ok}]   kindStats() -> [{kind, ok, total}]
  stamp(trackId, place) / stamps() -> { [trackId]: { place, date } }   nextTrack() -> 1..8, or 9 when all done
  settings() -> { sound:true, music:false, restAfter:3 }   setSetting(name, value)   // restAfter 0 = off
  resetProgress(id)                       // wipes stats + stamps, keeps the profile
  // Robust: corrupted JSON, quota errors, missing storage, unknown schema version, absurd data
  // (prune per-key stats to the newest ~400 keys). Stored under ONE key, e.g. 'rekenrace:v1'.

RR.Sprites  (browser; canvas pixel art generated from string maps, NO image files)
  draw(ctx, heroId, x, y, { scale, frame, flip })   // kart + driver, x,y = bottom-centre; frame 0|1 spins wheels
  heroURL(heroId, scale)    -> dataURL (kart portrait for <img>, cached)
  headURL(heroId, scale)    -> dataURL (head only, for lists/minimap)
  iconURL(name, scale)      -> dataURL; names: 'stamp-tulips' … one per theme, 'flag', 'trophy', 'lock', 'licence'

RR.Scene   (browser)
  create(canvas, { reducedMotion }) -> scene       // canvas internal size is the logical pixel size (~320x144); CSS scales it with image-rendering:pixelated
  scene.setTrack(theme, length)                    // scenery + finish line at `length` units
  scene.setRacers(racers, playerId)                // racers from RR.Race.racers
  scene.place(positions)                           // jump instantly
  scene.advanceTo(positions, { boost })            // animate glide, returns Promise resolved when finished (never rejects)
  scene.setIdle(on)                                // gentle ambient drift (clouds etc); off when tab hidden
  scene.resize()   scene.destroy()
  // Camera follows the player; parallax layers; a thin progress strip with the 4 little heads
  // (start → finish flag) so the child always sees where everyone is, even when off-screen.

RR.Sound   (browser; WebAudio synth, no files)
  unlock()                       // call from first user gesture
  configure({ sound, music })    // booleans
  play(name)                     // 'tap' 'key' 'del' 'ok' 'almost' 'go' 'glide' 'finish' 'stamp'
  every function is a safe no-op without AudioContext; master gain low; nothing before unlock()
```

## 6. Look & feel

- Window-in-a-desktop nostalgia, tastefully: a centred 4:3-ish "game window" (max ~960×720),
  soft background (pale teal / sky blue with a subtle dither pattern), a slim title bar
  ("Rekenrace") optional. Bevelled buttons (light top/left edge, dark bottom/right), pressed
  state inverts the bevel. Chunky friendly font stack with system fonts only:
  `"Comic Sans MS","Chalkboard SE","Trebuchet MS",Verdana,sans-serif`.
- Limited palette defined as CSS custom properties; text contrast ≥ 4.5:1; never pure black
  (deep navy) or neon. Red is not used for wrong answers (use a warm amber/orange note).
- Pixel art: crisp, integer scaled (`image-rendering: pixelated`), no anti-aliased blur.
- Layout MUST work at: phone portrait 390×844, phone landscape 844×390, tablet 1024×768,
  desktop 1366×768 and 1920×1080. Tap targets ≥ 48 px. Number keypad big enough for small
  fingers. The keypad must not cover the question or the scene. No horizontal scroll.
- Keyboard: digits, Backspace, Enter = check/Volgende, Esc = pause menu. Visible focus rings.
  Screen-reader friendly: real `<button>`s, `aria-live="polite"` for feedback, `lang="nl"`.
- Respect `prefers-reduced-motion` and `prefers-color-scheme` is NOT used (single calm palette).

## 7. Screens (integration step)

`kiesspeler` (profiles + new player) → `menu` ("de garage": Kampioenschap, Vrije race,
Stempelkaart, Ouders, andere speler, geluid/muziek toggles) → `baankeuze` (the 8 tracks as a
winding path/list with stamps and locks) / `vrij` (free race setup) → `race` → `finish`
(standings, "7 van 10 goed", sums to practise, stamp, buttons) → optional `rust`
(rustmoment) → back to `menu`. Plus `stempelkaart` (8 stamps; licence button when complete),
`rijbewijs` (printable licence via `window.print()`, print CSS), `ouders` (stats/settings/reset;
destructive actions need an explicit confirm step).

## 8. Quality bars every author must meet

- Tests: pure modules ship with `node:test` suites in `tests/rekenrace-<name>.test.mjs`, using
  `import { laadRR } from "./helpers/rekenrace-laden.mjs"` (already written; read it). During
  development run with `RR_PARTS_DIR=<scratchpad>/parts node --test tests/rekenrace-<name>.test.mjs`.
  Cover correctness by *independent recomputation* (do not just re-run your own generator's
  logic), invariants over thousands of seeded iterations, edge cases, determinism per seed.
- Never commit or push; never run `git` write commands; never touch files outside your
  assignment. Do not run `npm install` or add dependencies.
- Screenshots / browser checks: Chromium + Playwright are installed. Recipe:
  `NODE_PATH=$(npm root -g) node <script>.cjs` with `const { chromium } = require('playwright');`
  (default `chromium.launch()` works). A tiny screenshot helper exists at
  `<scratchpad>/tools/shot.cjs <url> <out.png> [w] [h]`. Use the Read tool on a PNG to LOOK at it.
  Look at your own visual work and iterate until it is genuinely good — don't ship what you
  haven't looked at.
- Output discipline: when you finish, reply with the requested JSON report only.
