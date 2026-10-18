# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Nummers Ninja (a Dutch-language fork of [febbhav/number-ninja](https://github.com/febbhav/number-ninja)) — a browser math game for Dutch primary-school kids (groep 4). Zero build step, zero npm dependencies (`package.json` declares none). The game is one self-contained `index.html` file; a small Vercel serverless backend persists player progress in Supabase.

A second, separate game lives in `rekenrace/` (a calm 1990s-style math racing game, no backend) — see "Rekenrace" below.

## Commands

```bash
npm test                  # wbtest.js + backend tests + the three Rekenrace suites (race, opslag, sommen) — run before every deploy
npm run test:legacy-admin # node admintest.js — legacy Cloudflare KV admin test, see "Legacy Cloudflare path" below
node e2e.js                # Playwright end-to-end run (not wired into npm test — see caveat below)
npx vercel deploy --prod --yes   # manual production deploy fallback (normally CI/CD via git push, see Deployment)
```

There is no lint/format command and no bundler — edit `index.html` directly and reload it in a browser.

Running a single test:
- `tests/backend.test.mjs` uses Node's built-in test runner: `node --test --test-name-pattern="<substring>" tests/backend.test.mjs`.
- `wbtest.js` is a flat assertion script (no test runner, no framework) — it always runs end to end; there's no way to isolate one check without editing the file.

## Architecture

### The game is one file

All markup, CSS, and JavaScript for the game live in `index.html` (~3300 lines). There is no client framework and no build. Runtime state lives in a single `S` object in memory.

The question generators (`genOps`, `genMachine`, `genEquation`, `genFraction`, `genFactor`, `genShape`, `genMultiply`, `genAngle`, `genCompare`, `genMix`, plus the workbook builder `wbBuild`) are pure functions with no DOM dependency, fenced inside `index.html` between the literal markers `// ===PURE===` and `// ===ENDPURE===`. `wbtest.js` regex-extracts exactly that block and `eval`s it in Node to test the generators headlessly — if you add a new generator or data table that needs testing this way, it must live inside that fence.

For the full breakdown of game systems (belts/mastery, battle system, journey map, tutorials, shop, Free Play minigame, save/sync flow) read `docs/ARCHITECTURE.md` — it's accurate for everything client-side. **It is stale about the backend**: it documents the original Cloudflare Pages Functions + KV design (`functions/api/*.js`). Production has since moved to Vercel + Supabase — see below.

### Current backend: Vercel + Supabase

This is the live, production path (wired up by `vercel.json`):

```
api/player.mjs      POST login / save / report  (default-exported Vercel function)
api/admin.mjs       GET  token-gated stats for admin.html
lib/backend.mjs     shared Supabase REST calls + PIN hashing + credential validation
supabase/migrations/  single `players` table (name_key, display_name, pin_hash, data jsonb)
```

- PINs are never stored: `hashPin` derives an HMAC-SHA256 digest keyed by a server-only `PIN_PEPPER` secret over `numberNinja:v2:{lowercased name}:{pin}`. Comparisons go through `sameSecret`, a constant-time-ish comparator — always use it instead of `===` when comparing hashes/tokens.
- Supabase RLS is on; the `players` table grants `select/insert/update` only to `service_role`. Server routes talk to Supabase via the REST API using `SUPABASE_SERVICE_ROLE_KEY` — browsers never touch Supabase directly.
- `api/admin.mjs` fails closed: if `ADMIN_TOKEN` isn't set in the environment it returns 503, never falls open. Token can be supplied via the `x-admin-token` header or a `?token=` query param.
- Player data is size-capped (`MAX_DATA_BYTES` in `lib/backend.mjs`) — oversized saves return `data_too_big` (413).
- Required env vars (see `.env.example`): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PIN_PEPPER`, `ADMIN_TOKEN`. Never commit real values — `.gitignore` already excludes `.env*` except `.env.example`.

### Legacy Cloudflare path (do not extend)

`functions/api/*.js`, `wrangler.toml`, `e2e.js`, and `admintest.js` are the original Cloudflare Pages + KV implementation, kept only for history per `README-DEPLOY.md`. They are **not** deployed — Vercel only builds `api/*.mjs`. `e2e.js` and `admintest.js` still exercise this legacy KV-backed code path (via a mocked KV store), not the current Supabase backend, so a green run of either does not verify the production API. When changing player-data behavior (login/save/report/admin stats), change `api/*.mjs` + `lib/backend.mjs` + `tests/backend.test.mjs`; only touch `functions/api/*.js` if explicitly asked to keep the historical Cloudflare version in sync.

### Deployment

Vercel project is linked to `TomOold/Cijfer-Ninja`: pushes to any branch other than `main` create a Preview Deployment automatically; merging to `main` deploys to production (`main` is the only production branch). Region is pinned to `fra1` (Frankfurt) in both `vercel.json` and `README-DEPLOY.md` to stay close to the Supabase project (`eu-central-1`). A healthy `/api/player` GET returns `{"ok":true,"storage":"supabase"}`.

### Rekenrace (separate sub-game in `rekenrace/`)

An independent game: a calm 1990s-style Dutch math racing game for groep 3-6. It is deliberately the opposite of Nummers Ninja's gamification — no timers, scores, coins, streaks or reward loops. The calm-design rules (D1-D12) in `rekenrace/README.md` are binding when changing it; do not copy mechanics from the main game into it.

- One self-contained file, `rekenrace/index.html`: zero build, zero dependencies, no network (a CSP `<meta>` enforces `connect-src 'none'`), no backend, no Supabase. It is served at `/rekenrace`; because Vercel runs with `cleanUrls` and no trailing slash, the page must not rely on relative sub-resources — keep everything inline.
- Script layout: a single `const RR = {}` namespace. The DOM-free modules (`RR.Rng`, `RR.Questions`, `RR.Heroes`/`Tracks`/`Race`, `RR.Store`) sit between the `// ===PURE===` / `// ===ENDPURE===` fences, followed by the browser-only modules (`RR.Sprites`, `RR.Scene`, then the optional behind-the-kart pseudo-3D view: `RR.SpritesRear` (rear-view karts), `RR.Scene3D` (road-projection engine, same public API as `RR.Scene`) and eight theme blocks, one per track, each registering via `RR.Scene3D.registerTheme(id, def)` inside the same file, then `RR.Sound`) and the UI. The global setting `view` (`'side'` default | `'behind'`, validated in `RR.Store`, edited in the Ouders screen as "Aanzicht") picks which scene the UI creates; the swap happens only in `ensureScene()` when the garage or a new race opens (never mid-race). The calm rules apply to the 3D view too (no strobing bands, no rush, no shake; tall near props carry `fade: [zOut, zFull]` so nothing big sweeps fast past the screen edge). All UI copy is in the `TXT` constant; DOM is built with a small helper and user-supplied text (player names) only ever goes through `textContent`.
- Tests: `tests/rekenrace-race|opslag|sommen.test.mjs` (Node's test runner, part of `npm test`) load the fenced block via `tests/helpers/rekenrace-laden.mjs`. The sums engine tests recompute every answer independently from the question text — keep that property when adding sum types. Browser behaviour is covered by a Playwright suite that is not part of `npm test` (Playwright is not a dependency); see `rekenrace/README.md`.
- Persistence is `localStorage` only (key `rekenrace:v1`); storage may be blocked, in which case the game keeps working in memory.

### Rekenrace V2 (independent adventure in `rekenracev2/`)

The self-driven illustrated adventure is served at `/rekenracev2`. The original `/rekenrace` and all its files remain unchanged from main. Never replace one game with the other.

- V2 is a standalone HTML page without runtime dependencies or network calls. Source artwork lives in `rekenracev2/art/`; `npm run rekenrace:art` updates the embedded atlas block in `rekenracev2/index.html` only.
- V2 keeps the calm rules in `rekenracev2/README.md`: no timers, ranks, damage, currencies or reward loops. Three resident stops with three sums each, then return to the square. Pause or calculating freezes all motion. Keyboard, D-pad, tap routes and the map all work.
- Pure modules: retained question/legacy modules, `RR.World`, `RR.Chapters`, `RR.Lesson`, `RR.Journey`, `RR.AdventureStore`. Browser modules: `RR.Sound`, `RR.Assets`, `RR.Scene`, `RR.UI`. User names always use `textContent`.
- V2 writes only `rekenrace:v2`. On first use it copies profiles from `rekenrace:v1` without modifying V1. Subsequent progress is independent. Save each answer and journey phase atomically; refuse to overwrite corrupt/future V2 data or newer data saved by another tab.
- `tests/helpers/rekenrace-laden.mjs` loads the original by default. Adventure tests use `laadRR("rekenracev2")`. Browser tests: `npm run test:rekenrace:browser`, default route `/rekenracev2`; `RR_URL` can target the preview. The original browser scripts still target `/rekenrace`.

### Content data

- `characters.json` is meant to be hand-edited to add shop avatars: drop an image into `images/`, add its filename (in-game name is the filename without extension). Optional per-character price override via `{"file": ..., "cost": ...}`.
- Workbook problems live in the `WB`/`BOOKS` tables inside `index.html`; every problem has a stable id (`W{book}L{lesson}Q{q}`) used to track what a kid has solved — `wbtest.js` recomputes every answer from its check expression, so a workbook edit that breaks an answer is caught by `npm test`.
