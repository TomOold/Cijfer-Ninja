# Rekenrace — work in progress (temporary folder, delete when integrated)

This folder exists so the work survives a reclaimed container. It is NOT part of the shipped game.
Read `BRIEF.md` first: it is the complete design brief, contracts and rules.

## State (2026-10-17): v1 IS INTEGRATED AND FROZEN
`rekenrace/index.html` (one file, ~380 KB) is now the ONLY source of truth. The old part files and the assemble script were
removed on purpose: edit `rekenrace/index.html` directly. (Do not resurrect `assemble.mjs`: it would overwrite your edits.)
- Tests green against index.html: `node --test tests/rekenrace-race.test.mjs tests/rekenrace-opslag.test.mjs tests/rekenrace-sommen.test.mjs`
  (47 + 140 + 40). Browser/behaviour suite: `rekenrace/_wip/e2e/play.cjs` (+ lib.cjs, shots.cjs, stress.cjs, monkey.cjs), 284 checks, run with
  `NODE_PATH=$(npm root -g) node play.cjs` (needs the e2e scripts' relative paths adjusted if run from the repo; they load file:///home/user/Cijfer-Ninja/rekenrace/index.html).
- Agent reports (API details, limitations): `reports/*.md`. Design brief: `BRIEF.md`.
- 8 themes, 4 heroes, 12 screens, calm-design rules D1-D12 implemented; CSP meta enforces no network.
- Already sent to the user: screenshots of the real game.

## Next steps (remaining)
1. Review round on the frozen file (play-test, dopamine audit D1-D12, Dutch copy in TXT, a11y/visual, code+security), verify findings, ONE fixer applies them.
2. Wire the three test files into `npm test` (package.json), decide about shipping the e2e scripts (tests/rekenrace-e2e/), write `rekenrace/README.md` (Dutch), mention in root README.md + CLAUDE.md.
3. Phase 2 (user decision, below): pseudo-3D "behind the kart" view as an extra option. Then delete `rekenrace/_wip/`.

## Decision by the user (2026-10-16): perspective
The user remembers the original RedCat game as 3D (unconfirmed; MyAbandonware lists 1st-person + 2D scrolling).
Chosen: **finish the 2D side-view version first (v1), THEN add a pseudo-3D "behind the kart" view as an extra option.**
- v1 = what is described above (RR.Scene side view). Ship it playable first.
- Phase 2 (after v1 is playable, tested and pushed): `RR.Scene3D` with the same public API as `RR.Scene`
  (setTrack, setRacers, place, advanceTo, setIdle, resize, destroy) — OutRun-style pseudo-3D road on canvas,
  gentle curves/hills, themed roadside sprites scaled by depth, rear-view hero karts (new sprites), rivals behind the
  camera not drawn (progress strip still shows everyone). Same calm rules D1-D12: slow gentle glides, no speed streaks.
  Add a setting "Aanzicht: zijkant / vanachter" in the Ouders screen + menu; default stays side view. Tests/screens as v1.

## Phone report (2026-10-17, user): blank screen in the iPhone file viewer
Symptom: only the static title bar (empty icon square, sound + music buttons) and an empty cream body; no title text, no screens.
Diagnosis (reproduced in scratchpad/review/phone/repro.cjs): identical picture when the HOST blocks inline scripts (CSP script-src nonce) while scripting is enabled
(so the <noscript> message does not show either). The game boots fine in: normal load, sandboxed opaque-origin iframe, blocked localStorage, blank canvas.toDataURL,
no structuredClone. Real iOS Safari could not be tested here (only Chromium installed). Most likely the in-app file viewer does not run scripts.
Workaround given: private claude.ai artifact copy (title changed to "Rekenrace voor kinderen"): https://claude.ai/artifact/W2WgP78fb1pfbNJ18jMm1m
TODO after the review round (apply to rekenrace/index.html AFTER the fixer finishes to avoid edit conflicts):
 1. Visible boot fallback: a static, always-visible note in <main> ("Het spel wordt gestart... Lukt dit niet? Open het bestand in Safari of Chrome") that the script hides as its first action,
    plus a tiny separate early <script> that shows window.onerror / unhandledrejection messages in that note. Today a blocked or crashing script gives a silent blank page.
 2. CODE-4/CODE-5 from the review: canvas toDataURL read-back (privacy browsers blank it) and swallowed draw/audio errors.
