# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Nummers Ninja (a Dutch-language fork of [febbhav/number-ninja](https://github.com/febbhav/number-ninja)) — a browser math game for Dutch primary-school kids (groep 4). Zero build step, zero npm dependencies (`package.json` declares none). The game is one self-contained `index.html` file; a small Vercel serverless backend persists player progress in Supabase.

## Commands

```bash
npm test                  # node wbtest.js && node tests/backend.test.mjs — run before every deploy
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

### Content data

- `characters.json` is meant to be hand-edited to add shop avatars: drop an image into `images/`, add its filename (in-game name is the filename without extension). Optional per-character price override via `{"file": ..., "cost": ...}`.
- Workbook problems live in the `WB`/`BOOKS` tables inside `index.html`; every problem has a stable id (`W{book}L{lesson}Q{q}`) used to track what a kid has solved — `wbtest.js` recomputes every answer from its check expression, so a workbook edit that breaks an answer is caught by `npm test`.
