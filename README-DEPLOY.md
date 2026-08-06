# Number Ninja — deploy to Cloudflare Pages with saved progress

Files that matter:

```
index.html                     the game
functions/api/player.js        the save server (a Cloudflare Pages Function)
characters.json                editable gear-shop config (add characters here)
images/                        character art shown in the shop
wrangler.toml                  Cloudflare config (KV id already filled in)
HANDOFF.md                     full project handoff / architecture
```

Deploy everything together (the whole folder). `characters.json` and `images/`
must ship so the shop works. Run `node wbtest.js` and `node e2e.js` first.

The `functions/` folder is special: Cloudflare automatically turns it into an API.
`functions/api/player.js` becomes the URL `/api/player`, which the game calls to
load and save. You do not run a separate server.

Progress is stored in Cloudflare KV (a key-value database). You create one KV
namespace and bind it to the project. That's the only setup step beyond uploading.

---

## Option A — drag-and-drop (no Git, fastest)

1. Zip the site folder so the zip contains `index.html` and the `functions` folder
   at its top level (not inside an extra folder).
2. Cloudflare dashboard -> **Workers & Pages** -> **Create** -> **Pages** ->
   **Upload assets**.
3. Name the project (e.g. `number-ninja`), drop in the zip, **Deploy**.
4. Create the database: **Storage & Databases** -> **KV** -> **Create a namespace**,
   name it `ninja-kv`.
5. Bind it to the project: your project -> **Settings** -> **Bindings** (or
   **Functions** -> **KV namespace bindings** on older dashboards) ->
   **Add binding**:
   - **Variable name:** `NINJA_KV`  ← must be exactly this
   - **KV namespace:** `ninja-kv`
6. Redeploy once (Deployments -> ... -> **Retry/Redeploy**) so the binding takes effect.

Done. Your site is at `https://number-ninja.pages.dev`, and you can attach your
own Cloudflare domain under **Custom domains**.

---

## Option B — Git + Wrangler (if you want version control)

1. Put these files in a repo.
2. `wrangler.toml` is already included with the binding. Create the namespace:
   ```
   npx wrangler kv namespace create ninja-kv
   ```
   Copy the returned `id` into `wrangler.toml` (replace `PUT_YOUR_KV_ID_HERE`).
3. Deploy:
   ```
   npx wrangler pages deploy .
   ```
   Or connect the repo in the Pages dashboard for auto-deploy on every push.

---

## How the saving works (plain version)

- First time a kid enters a name + 4-digit PIN, that name is claimed with that PIN.
- Coming back on any device: same name + PIN loads their coins, level, avatars, stats.
- The PIN is never stored as-is — only a one-way hash. If he forgets the PIN there
  is no recovery; he'd start a new name. (For a kid's game that's the right trade:
  no email, no personal data.)
- Names are case-insensitive ("Leo" == "leo"). Two kids wanting separate saves just
  need different names.

## Checking it works after deploy

Visit `https://your-site/api/player` in a browser. You should see:
`{"ok":true,"service":"number-ninja",...}`. If instead you get
`server_not_configured`, the `NINJA_KV` binding isn't attached yet — redo step 5/6.

## Cost

Cloudflare's free tier covers this easily: Pages is free, and KV free tier is
100k reads + 1k writes per day. One kid playing is a handful of writes per session.
