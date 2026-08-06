# Nummers Ninja — productie

De live app draait op Vercel en bewaart voortgang in een apart Supabase-project.

- Productie: https://number-ninja-nl.vercel.app
- Beheer: https://number-ninja-nl.vercel.app/admin
- Supabase-project: `zehybmpivmnpwtnctape` (`eu-central-1`)
- Vercel Function-regio: Frankfurt (`fra1`)

## Opbouw

```text
index.html                  de game
admin.html                  het afgeschermde beheerscherm
api/player.mjs              aanmelden, laden en opslaan
api/admin.mjs               alleen-lezen statistieken
lib/backend.mjs             Supabase- en beveiligingslogica
supabase/migrations/        databaseschema
characters.json + images/   winkelpersonages
```

De oude map `functions/` en `wrangler.toml` zijn alleen nog aanwezig als
historische Cloudflare-versie. Vercel gebruikt uitsluitend de bestanden in
`api/`.

## Productiegeheimen

De volgende variabelen staan als secrets in Vercel en horen nooit in Git:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `PIN_PEPPER`
- `ADMIN_TOKEN`

De Supabase-tabel heeft Row Level Security aanstaan. Browsers hebben geen directe
toegang; alleen de serverroutes gebruiken de service-role-sleutel. Pincodes worden
als een gepepperde HMAC-SHA256-hash opgeslagen en nooit als leesbare tekst.

## Controleren en opnieuw uitrollen

Het Vercel-project is gekoppeld aan `TomOold/Cijfer-Ninja` op GitHub:

- pushes naar een andere branch maken automatisch een Preview Deployment;
- een merge naar `main` maakt automatisch een Production Deployment;
- `main` is de enige productiebranch.

Handmatig uitrollen blijft mogelijk als noodroute:

```bash
npm test
npx vercel deploy --prod --yes
```

Een gezonde API geeft op `/api/player` onder andere
`{"ok":true,"storage":"supabase"}` terug. Het beheerscherm vraagt om de waarde
van `ADMIN_TOKEN`.
