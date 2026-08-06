# Architecture

The whole game is one file, `index.html`. It holds the markup, all CSS, and all
JavaScript. This document maps the pieces so a new reader can find things fast.

## Big picture

    browser (index.html)  ──POST /api/player──▶  Pages Function ──▶  KV (per-player record)
            │
            └── /api/admin (token-gated stats) ──▶  same KV, read-only

There is no client framework and no build. State lives in a single `S` object in
memory, is serialized to KV on save, and is restored on login.

## Question generators

Everything a kid answers is produced by pure functions, so it is testable in Node
with no DOM. They live inside a block marked `// ===PURE===` ... `// ===ENDPURE===`
in `index.html`. `wbtest.js` evaluates exactly that block.

- `genOps`, `genMachine`, `genEquation`, `genFraction`, `genFactor`, `genShape`,
  `genMultiply`, `genAngle`, `genCompare`, `genMix` each take a tier (1 to 4) and
  return `{ qHTML, choices:[{h, ok}], topic, tip }`.
- Exactly one choice has `ok:true`. `tip` is the gamified hint (find the easy road,
  not the brute-force road).
- Tier 4 is the expert tier used when a kid has mastered a topic.

## Workbook data

The "Workbook Quest" problems are a compact data table (`WB`) plus a builder
(`wbBuild`) that turns each row into a live multiple-choice question with fresh
distractors. `BOOKS` groups lessons into three levels. Every problem has a stable id
(`W{book}L{lesson}Q{q}`) used to remember what a kid has solved. `wbtest.js` recomputes
every answer from its check expression to guarantee correctness.

## State and saving

- `S` is the single runtime state object: coins, xp, level, skin, inventory,
  effects, and `S.progress` (topics, mastery, solved ids, story stars, need-help
  list, arena resume point).
- `packSave()` serializes the durable parts; `applySave()` restores them and
  migrates older shapes.
- `SYNC` debounces writes to `/api/player`. `navigator.sendBeacon` flushes on unload.
- "Remember me" keeps the name and PIN in localStorage so a refresh does not log out.

## Belts (mastery)

`BELTS` is the ladder White to Black with thresholds. `bumpMastery` moves a topic's
value, `beltPanelHTML` renders the shared strengths view used on both the kid's home
and the parent report. Mastery also drives arena difficulty (`tierNow`).

## Battle system

A cosmetic layer over the normal answer loop.

- `MONSTERS` and `BOSSES` are rosters. `spawnMonster` / `spawnBoss` set the current
  foe; `renderFoe` draws HP, rage state, the shield, and the charge telegraph.
- `foeStrike` (correct answer) damages the foe and interrupts its wind-up.
  `foeDie` plays the death spectacle and restores a shield heart.
- Foes "charge" over `FOE_CHARGE_MAX` questions (`foeChargeTick`) and telegraph it.
  On a miss while charged, `foeAttack` cracks a cosmetic shield heart. It never
  touches score, streak, belts, or mastery.
- Bosses have a taunt, an arena color wash (`#arenaTint`), a named strike, and a
  victory line. A wrong answer heals the boss (`foeHealUp`).

## Journey map

`buildJourney` draws a winding trail with a node per stop and the avatar as the
piece. At the start of a level it opens and waits; the kid taps the glowing current
step to begin. `MAPTHEMES` tints each book. It is an overlay, not a screen.

## Tutorials

`TUTOR` holds two teaching approaches per topic. `CHECKS` holds a comprehension
question per topic. A kid must answer the check correctly to leave the tutorial and
return to a fresh practice problem, so tutorials cannot be dismissed unread.

## Shop

`renderShop` has three tabs: avatars (emoji built-ins plus images from
`characters.json`), power-ups (each purchase grants a bundle of charges), and auras
(cosmetic effects). `characters.json` is meant to be hand-edited: add an image to
`images/`, list its filename, and it becomes a buyable avatar.

## Free Play minigame

A self-contained Canvas 2D dot-muncher (`FP` object, `fp*` functions) bought as a
power-up. Pure arcade, no math. Lattice maze with guaranteed connectivity, greedy
ghosts, lives, score, D-pad and arrow keys.

## Save server (functions/api/player.js)

POST actions:

- `login`: loads or first-time-claims a player (name + PIN).
- `save`: writes progress (size-capped).
- `report`: read-only load for the parent view, never creates an account.

PINs are salted and SHA-256 hashed; compares are constant-time-ish.

## Admin (functions/api/admin.js + admin.html)

`GET /api/admin` walks every `player:` key, reads each record, and returns totals
(claimed, active, active in 7/30 days, new in 7/30 days, problems solved, max level)
plus a recent-player roster. Gated by the `ADMIN_TOKEN` env var; fails closed if it
is not set. `admin.html` is the dashboard that calls it.

## Tests

- `wbtest.js`: evaluates the PURE block, checks generator structure across tiers,
  recomputes tier-4 and workbook answers, and validates BOOKS coverage.
- `admintest.js`: mock KV, asserts the stats math and the auth (fails closed, 401 on
  wrong token, works via header or query).
- `e2e.js`: Playwright against a mock KV save server. Covers login, save/resume,
  shop, power-up charges, tutorials, need-help capture, the parent report, the
  battle mechanics (shield, charge, rage, boss arena), and the Free Play minigame.
