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

Je kunt `index.html` direct openen. Voor opslaan en de API gebruik je de Cloudflare Pages-omgeving uit het oorspronkelijke project.

## Techniek

- Eén zelfstandig `index.html`-bestand met HTML, CSS en JavaScript
- Cloudflare Pages Functions voor opslaan en rapportages
- Cloudflare KV voor voortgang per speler
- Geen apart framework of bouwstap nodig

## Privacy

Een speler gebruikt alleen een zelfgekozen ninjanaam en viercijferige pincode. De pincode wordt alleen als gezouten hash opgeslagen. Er is geen e-mailadres of andere persoonlijke informatie nodig.

## Herkomst en licentie

Gebaseerd op het MIT-gelicentieerde project [Number Ninja van febbhav](https://github.com/febbhav/number-ninja). De Nederlandse vertaling en nieuwe groep-4-basiswereld zijn aanvullingen op die broncode. Zie [LICENSE](LICENSE).

Gebruik voor openbare of commerciële publicatie alleen beeldmateriaal waarvoor je de rechten hebt. Het spel werkt ook met de ingebouwde emoji-personages.
