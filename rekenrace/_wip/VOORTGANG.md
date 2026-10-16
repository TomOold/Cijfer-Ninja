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

## Decision by the user (2026-10-16): perspective
The user remembers the original RedCat game as 3D (unconfirmed; MyAbandonware lists 1st-person + 2D scrolling).
Chosen: **finish the 2D side-view version first (v1), THEN add a pseudo-3D "behind the kart" view as an extra option.**
- v1 = what is described above (RR.Scene side view). Ship it playable first.
- Phase 2 (after v1 is playable, tested and pushed): `RR.Scene3D` with the same public API as `RR.Scene`
  (setTrack, setRacers, place, advanceTo, setIdle, resize, destroy) — OutRun-style pseudo-3D road on canvas,
  gentle curves/hills, themed roadside sprites scaled by depth, rear-view hero karts (new sprites), rivals behind the
  camera not drawn (progress strip still shows everyone). Same calm rules D1-D12: slow gentle glides, no speed streaks.
  Add a setting "Aanzicht: zijkant / vanachter" in the Ouders screen + menu; default stays side view. Tests/screens as v1.
