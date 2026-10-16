# Rekenrace — work in progress (temporary folder, delete when integrated)

This folder exists so the work survives a reclaimed container. It is NOT part of the shipped game.
Read `BRIEF.md` first: it is the complete design brief, contracts and rules.

## State (snapshot)
- `parts/pure-rng.js`, `pure-race.js`, `pure-opslag.js`: done, tests green (`tests/rekenrace-race.test.mjs`, `tests/rekenrace-opslag.test.mjs`).
- `parts/pure-sommen.js`: written; test suite `tests/rekenrace-sommen.test.mjs` being finished.
- `parts/sprites.js`: done (4 heroes, 8 stamp icons, flag/trophy/lock/licence).
- `parts/scene.js`: IN PROGRESS. Only the `tulips` theme exists so far; other themes fall back to it.
- `parts/geluid.js`: IN PROGRESS (WebAudio synth + music).

Run part tests: `RR_PARTS_DIR=rekenrace/_wip/parts node --test tests/rekenrace-<name>.test.mjs`.

## Next steps
1. Finish scene (7 more themes) and sound; re-check all parts.
2. Integrate into ONE `rekenrace/index.html` (inline CSS + one script: `const RR = {}`, pure parts between
   `// ===PURE===` / `// ===ENDPURE===`, then sprites, scene, sound, UI). Screens: see BRIEF section 7.
3. Playtest with Playwright (all viewports in BRIEF section 6), review against the calm-design rules D1-D12,
   Dutch language/maths proofreading, security review (names via textContent only).
4. Wire tests into `npm test`, add `rekenrace/README.md`, mention in root README + CLAUDE.md, delete `_wip/`.
