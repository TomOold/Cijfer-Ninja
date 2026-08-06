# Nummers Ninja

Een volledig Nederlandstalig en speels rekenavontuur voor kinderen vanaf groep 4. Deze versie gebruikt de bestaande vormgeving en spelopzet van [febbhav/number-ninja](https://github.com/febbhav/number-ninja) als basis.

## Wat zit erin?

- **Groep 4 Basis:** optellen en aftrekken tot 1000, tafels, delen en verhaalsommen.
- **Werkboekmissie:** drie niveaus met vaste rekenopgaven.
- **Oefenarena:** eindeloos oefenen op onder andere breuken, rekenvolgorde, vormen, hoeken en vermenigvuldigen.
- **Ninjabanden:** per onderwerp groeien van witte naar zwarte band.
- **Monstergevechten:** goede antwoorden doen schade aan monsters en eindbazen.
- **Ninjawinkel:** personages, krachten en speciale gloed vrijspelen met verdiende munten.
- **Hulpknop:** een kind kan een lastige som markeren en zonder straf doorgaan.
- **Voortgangsrapport:** ouders of leerkrachten zien sterke punten, oefenpunten en gemarkeerde sommen.

## Lokaal openen

Je kunt `index.html` direct openen om de interface te bekijken. De productieversie
draait op Vercel; online opslaan gebruikt Supabase via server-side API-routes.

## Techniek

- Eén zelfstandig `index.html`-bestand met HTML, CSS en JavaScript
- Vercel Functions voor opslaan en rapportages
- Supabase Postgres voor voortgang per speler
- Geen apart framework of bouwstap nodig

De live versie staat op [number-ninja-nl.vercel.app](https://number-ninja-nl.vercel.app).
Zie [README-DEPLOY.md](README-DEPLOY.md) voor productiebeheer.

## Privacy

Een speler gebruikt alleen een zelfgekozen ninjanaam en viercijferige pincode. De pincode wordt alleen als gezouten hash opgeslagen. Er is geen e-mailadres of andere persoonlijke informatie nodig.

## Herkomst en licentie

Gebaseerd op het MIT-gelicentieerde project [Number Ninja van febbhav](https://github.com/febbhav/number-ninja). De Nederlandse vertaling en nieuwe groep-4-basiswereld zijn aanvullingen op die broncode. Zie [LICENSE](LICENSE).

Gebruik voor openbare of commerciële publicatie alleen beeldmateriaal waarvoor je de rechten hebt. Het spel werkt ook met de ingebouwde emoji-personages.
