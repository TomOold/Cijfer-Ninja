# Rekenrace V2 — kleine tochten, grote ontdekkingen

Een zelfstandig, rustig rijavontuur in de sfeer van een getekende jarennegentig-cd-rom. Voor kinderen van groep 4–5, op laptop en tablet. Het kind rijdt zelf, helpt drie bewoners met elk drie sommen en keert terug naar het plein. Er is geen wedstrijdpositie.

De oorspronkelijke race blijft ongewijzigd beschikbaar op `/rekenrace`. Dit avontuur heeft een eigen route `/rekenracev2` en eigen voortgang (`rekenrace:v2`). Bij het eerste gebruik worden oude spelers gekopieerd; daarna bewaren beide games hun voortgang onafhankelijk.

## Spelen

Open `/rekenracev2` op de site, of download `rekenracev2/index.html` en open dat bestand in een gewone browser. Alles zit in de pagina: tekeningen, sommen, rekenhulp en geluid. Na het laden is geen netwerk nodig. Een bestandsvoorbeeld in een andere app voert soms geen JavaScript uit; open dan het bestand in Safari, Firefox, Chrome of Edge.

1. Maak of kies een lokale speler. Alle vier de dieren en drie autokleuren zijn direct beschikbaar.
2. Kies **Dorpsronde**, **Molenpolder** of **Havenrit**. De Dorpsronde is de eerste beoordelingsversie; de andere gebieden gebruiken dezelfde besturing en rekenregels.
3. Rijd met de pijltjestoetsen of de richtingstoetsen in beeld. Op de tablet en met de muis kun je ook op de weg tikken. Het autootje volgt een veilige route. Via **Bekijk de kaart** kun je naar de volgende stop rijden, ook zonder precieze stuurbewegingen.
4. Bij de volgende bewoner stopt de wereld. Kies **Samen rekenen**. Vul je antwoord in en kies **Nakijken**; cijfers, Backspace en Enter werken ook op het toetsenbord. Met Tab en Enter blijven de knoppen bedienbaar.
5. Een fout antwoord geeft een hint en een tweede poging. Daarna volgt zo nodig uitleg met het antwoord. Na iedere som kies je zelf de volgende stap; na drie sommen kies je **Doorrijden**.
6. Na drie stops rijd je terug naar het plein. Daarna staat **Stoppen** vooraan. Er begint niets vanzelf.

**Pauze**, Escape, een verborgen tab of een venster dat de focus verliest zet het spel stil. Bij hervatten van een opgeslagen tocht begint het rijden bij het laatst bereikte controlepunt. Een lopende som, invoer en tweede poging blijven bewaard. Er wordt nooit dubbel een antwoord geregistreerd door herladen.

De wereld heeft geen schade, brandstoftekort of gevaar. Aan de wegrand glijdt de auto mee met de weg. **Terug naar de weg** zet hem bij het laatst bereikte controlepunt.

## Rekenen en instellingen

Ouders kunnen per speler het rekenniveau en het onderwerp kiezen: door elkaar, optellen, aftrekken, tafels of delen. Wijzigingen gelden vanaf een nieuwe tocht. Bestaande profielen uit groep 3 of 6 blijven bewaard; voor een nieuw avontuur kiest de ouder expliciet groep 4 of 5.

- Groep 4: plus en min tot 100, tafels tot en met 10 en bijpassende deelsommen.
- Groep 5: plus en min tot 1.000, tafels tot en met 10 en bijpassende deelsommen.
- Geen negatieve antwoorden, breuken, komma's of resten.
- Een landschap verandert het rekenniveau nooit. Per tocht zijn er precies negen gewone sommen, geen memory of andere minigames.
- Hooguit twee passende eerdere oefensommen komen terug in een nieuwe tocht. Een som uit een hoger niveau komt niet in een lagere reeks terecht.
- Het ouderscherm laat het aantal geoefende sommen per onderwerp zien, hoeveel antwoorden zelfstandig of na een tip lukten en welke sommen nog oefening vragen. Dit is geen toetsuitslag of beheersingsmeting.

Muziek staat standaard uit. Geluid en muziek kunnen uit. Minder beweging volgt de systeeminstelling en schakelt de vloeiende camera uit. De illustraties bewegen niet tijdens het rekenen.

## Rustafspraken

Deze afspraken gelden ook bij verdere ontwikkeling:

| | Afspraak |
|---|---|
| D1 | Geen timers, aftellers, snelheidsbonussen of tijdsdruk. |
| D2 | Geen punten, munten, XP, combo's of reeksen. Alleen feitelijke oefenvoortgang. |
| D3 | Geen winkel, lootboxen of willekeurige beloningen. Alle dieren, auto's en gebieden zijn beschikbaar. |
| D4 | Geen flitsen, confetti, cameratrilling of plotselinge effecten. Minder beweging respecteren. |
| D5 | Korte, vriendelijke en feitelijke tekst; fouten leiden tot hulp. |
| D6 | Zacht geluid, pas na een handeling; muziek standaard uit en alles uit te zetten. |
| D7 | Natuurlijke stop na negen sommen. Niets start automatisch. Na het ingestelde aantal tochten een pauze voorstellen. |
| D8 | Geen schade, levens, game over of voortgang die door een fout wordt geblokkeerd. |
| D9 | Lokale spelers zonder account, advertenties, analytics, externe lettertypen of netwerkverkeer vanuit het spel. |
| D10 | Voortgang is zichtbaar en voorspelbaar: geholpen bewoners en bezochte gebieden. |
| D11 | Geen ranglijst, wedstrijdpositie of verliesgeluid. |
| D12 | Het kind kiest na iedere uitleg de volgende stap. De hele wereld staat stil tijdens rekenen en pauze. |

Een korte invoerbewaking na een schermwisseling voorkomt dat een dubbele tik onbedoeld het volgende scherm bedient. Dat is geen tijdsdruk: er loopt niets af en niets gaat verloren.

## Opslag en compatibiliteit

De nieuwe sleutel is `rekenrace:v2`. Daarin staan de door de bestaande `RR.Store` opgeschoonde spelersprofielen, rekenhistorie, oude stempels, globale instellingen, voorkeuren per speler, één lopende tocht per speler en afgeronde gebieden.

Bij eerste gebruik zonder V2-opslag worden bestaande V1-profielen ingelezen. De oorspronkelijke sleutel `rekenrace:v1` wordt **nooit gewijzigd**. Oude stempels blijven zichtbaar in het ouderscherm; ze worden geen dorpsopdrachten. Antwoordregistratie en de fase van de tocht gaan in één lokale opslaghandeling weg. Bij herladen wordt de som uit zijn vaste sleutel gereconstrueerd en de opgeslagen voortgang gecontroleerd.

Bij onbeschikbare opslag kan het spel in geheugen verder. Een zichtbare melding waarschuwt dat sluiten gegevens kan verliezen. Beschadigde of onbekende V2-data wordt niet overschreven. Als een tweede tab nieuwere gegevens opslaat, stopt deze tab en vraagt hij de pagina opnieuw te laden.

Voortgang reist niet mee naar een ander apparaat of van een Preview-domein naar het productiedomein. Wissen in het ouderscherm betreft het nieuwe avontuur; het oorspronkelijke V1-bestand blijft als migratiebron intact.

## Techniek en illustraties

De runtime blijft één zelfstandige `rekenracev2/index.html`, zonder framework, server of bouwstap. CSP blokkeert verbindingen (`connect-src 'none'`); beeld komt uit ingebedde data-URL's. Alleen gewone HTML-knoppen en velden bedienen het spel; de wereld wordt op canvas getekend.

De pure modules staan binnen de bestaande `// ===PURE===`-markeringen:

- `RR.Rng`, `RR.Questions`, `RR.Heroes` en de historische `RR.Tracks`/`RR.Race`/`RR.Store` blijven voor compatibiliteit en de onafhankelijke tests behouden. Het avontuur gebruikt de oude raceberekening niet.
- `RR.World`: wegennetwerk, projectie op wegranden, genormaliseerde beweging en kortste tikroutes.
- `RR.Chapters`, `RR.Lesson`, `RR.Journey`: ontmoetingen, passende rekenreeksen en expliciete toestanden `intro`, `driving`, `conversation`, `question`, `explanation`, `stopDone`, `complete`.
- `RR.AdventureStore`: V2-migratie, lokale voorkeuren, hervatten en atomair vastleggen van antwoorden.

Daarna volgen de bestaande geluidsmodule, `RR.Assets`, de nieuwe `RR.Scene` en `RR.UI`. Gebruik voor namen altijd `textContent`; voeg nooit spelersnamen aan HTML-templates toe.

De originele illustraties zijn voor dit project gegenereerd. Geen beeld, geluid, personage of tekst uit Redcat is overgenomen. De bewerkbare atlasbestanden staan onder `art/`:

- `dieren-autootjes.webp`: 8 kolommen × 4 rijen van 224 × 224 pixels, per dier acht rijrichtingen; rechts, rechtsonder, onder, linksonder, links, linksboven, boven, rechtsboven.
- `dorpsdecor.webp`: decoratlas; uitsnedes staan in `RR.Assets`.

Na een wijziging aan een atlas: `npm run rekenrace:art`. Dat vernieuwt alleen het ingebedde beeldblok. Kleuren van de auto worden lokaal op de zeegroene carrosserie toegepast; het dier behoudt zijn eigen kleur.

## Controleren

```sh
npm test
# Met Playwright beschikbaar en een lokale server op poort 8765:
npm run test:rekenrace:browser
# Andere oorsprong (bijvoorbeeld een toegankelijke branch-preview):
RR_URL=https://voorbeeld.vercel.app/rekenracev2 npm run test:rekenrace:browser
```

`npm test` bevat de bestaande Nummers Ninja- en backendtests, de historische pure Rekenrace-tests en `tests/rekenrace-avontuur.test.mjs`. De nieuwe tests controleren antwoorden onafhankelijk van de generator, weggrenzen, routes, alle negen vragen, foutafhandeling, migratie, hervatten, opslagfalen en meerdere tabs.

`tests/rekenrace-e2e/avontuur.cjs` is de actuele browsersuite. Ze speelt een volledige tocht in Chromium, Firefox en WebKit, met verschillende dieren, groep 4/5, toetsenbediening, tikken, herladen en stilliggend beeld tijdens rekenen. Schermafbeeldingen gaan naar een tijdelijke map. Oudere bestanden in die testmap horen bij de historische race-interface en zijn geen acceptatietests voor het avontuur.

Een WebKit-test met een tabletformaat vervangt geen speeltest op een echte iPad. Voor productie beoordelen een ouder en kind de besturing, leesbaarheid en het rustige tempo op hun eigen apparaten. Publicatie gaat via een featurebranch en Preview; samenvoegen naar `main` is een aparte productiestap.
