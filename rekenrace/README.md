# Rekenrace

Een rustig rekenspel in jaren-90-stijl voor kinderen van groep 3 tot en met 6. Vier dieren racen in hun
kartje door een Nederlands landschap; elk goed antwoord brengt je kart een stukje vooruit. Zoals de
rekenspellen op cd-rom van vroeger: een vriendelijk venster, pixelart, een zacht deuntje, en geen enkele
haast.

Het is een **eigen spel**, los van Nummers Ninja in de hoofdmap van deze repo. Alle dieren, namen, tekeningen,
teksten en muziek zijn nieuw gemaakt; er is niets overgenomen van een bestaand spel.

## Spelen

- **Online:** open `/rekenrace` op de Vercel-site van dit project.
- **Zelf openen:** het hele spel is één bestand, `rekenrace/index.html`. Download het en open het in je
  browser (Safari, Chrome, Firefox, Edge). Er is geen server, account of internet nodig.
- **Op een telefoon of tablet:** open het via een gewone browser. Een bestandsvoorbeeld in een app voert
  vaak geen scripts uit; je ziet dan een lege titelbalk. Het spel laat in dat geval een melding zien
  ("Lukt dit niet? Open het bestand in Safari of Chrome").

### Wat je kunt doen

1. **Speler kiezen of maken:** naam (maximaal 12 tekens), een dier en de groep (3 t/m 6). Er kunnen tot
   8 spelers op één apparaat; de drie dieren die je niet kiest, racen tegen je.
2. **Kampioenschap:** acht banen in vaste volgorde (Tulpenveld, Molenpolder, Strand en duinen, Dennenbos,
   Grachtenstad, Haven, IJsbaan, Heuvelland), elk iets moeilijker. Elke baan die je afmaakt geeft een
   stempel, ongeacht je plaats. Met alle acht stempels is er een printbaar **Rekenrijbewijs**.
3. **Vrije race:** kies zelf een baan en een soort som (door elkaar, optellen, aftrekken, tafels, delen,
   verhaalsommen), eventueel één tafel. Hier is geen stempel te halen; het is om te oefenen.
4. **Ouders:** per speler zie je hoe het per soort som ging en welke sommen lastig waren. Je kunt de groep
   aanpassen, geluid en muziek aan- of uitzetten, het rustmoment instellen en voortgang wissen of een speler
   verwijderen (altijd met een tweede bevestiging).

### Een race

Een race is altijd **precies 10 sommen**. Je tikt het antwoord met het cijferpaneel (of je toetsenbord) en
drukt op *Klaar*. Er is geen klok: er beweegt niets terwijl je nadenkt.

- Goed in één keer: je kart glijdt vooruit.
- Fout: je krijgt een **hint** en mag nog één keer proberen.
- Nog een keer fout: je ziet het antwoord met **uitleg hoe je erop komt**, en gaat verder wanneer jij wilt.

Een race kun je nooit verliezen en elke plaats telt als afgemaakt. Sommen die lastig waren komen later
vanzelf een paar keer terug.

## Rustregels (de afspraken waar dit spel zich aan houdt)

Dit spel is bewust het tegenovergestelde van een spel dat je vast wil houden. De regels hieronder zijn
bindend bij elke wijziging.

| | Regel |
|---|---|
| D1 | Geen tijdsdruk: geen timers, aftellers of snelheidsbonussen. Alleen animaties gebruiken tijd. |
| D2 | Geen puntentelling: geen punten, munten, ervaring, combo's of reeksen. Alleen feiten als "Som 4 van 10" en "7 van 10 goed in één keer". |
| D3 | Geen willekeurige beloningen: één stempel per baan, één rijbewijs aan het eind. Geen winkel of loot. |
| D4 | Geen flitsen, schudden, confetti of plotselinge beweging. Bij "minder beweging" in het besturingssysteem staat alle beweging stil of springt kort. |
| D5 | Rustige teksten: kort, warm en feitelijk. Een fout antwoord is "Nog niet helemaal." met een tip, nooit "FOUT!" of rood. |
| D6 | Zacht geluid, nooit voor de eerste klik, altijd uit te zetten. Muziek staat standaard uit. |
| D7 | Natuurlijke stopmomenten: een race heeft een einde, daarna start er niets vanzelf. Na een aantal races (standaard 3, in te stellen van 1 tot 10 of uit) stelt het spel een pauze voor, met "Stoppen" als hoofdknop. Geen dagelijkse reeksen, meldingen of ranglijsten. |
| D8 | Falen blokkeert nooit: geen levens, geen game over; elke plaats geeft een stempel. |
| D9 | Privé en offline: geen netwerkverkeer, geen account, geen advertenties, geen externe lettertypen. |
| D10 | Eerlijke voortgang: lineair en zichtbaar, geen verborgen systemen. |
| D11 | Rustige uitslag: "Je bent als tweede over de finish gekomen." Geen verliezersgeluid of rood. |
| D12 | Het tempo is van het kind: na een goed antwoord verschijnt de volgende som als de kart is aangekomen; na een fout antwoord blijft de uitleg staan tot het kind op *Volgende* drukt. |

Wat bewust wél mag, zodat een latere controle het niet als overtreding ziet: een korte invoerpauze van
ongeveer een halve seconde na het starten of na een uitleg (tegen per ongeluk dubbel tikken), en een vaste
pauze van 0,6 seconde in plaats van de glijbeweging als "minder beweging" aanstaat. Dat is geen tijdsdruk:
er gaat niets verloren en niets loopt af.

Het spel past de sommen wel aan: sommen die niet lukten komen later nog een paar keer terug, en de
moeilijkheid hangt af van de groep en de baan. Dat staat ook op het ouderscherm onder "Over dit spel".

## Wat wordt er opgeslagen

Alleen in de browser van het apparaat (`localStorage`, sleutel `rekenrace:v1`): de gekozen naam, dier en
groep, de antwoordgeschiedenis per som, de stempels en de instellingen. Er is geen e-mailadres en er gaat
niets over het netwerk: een beveiligingsregel in de pagina (CSP) laat de browser zelf elke verbinding
blokkeren. Als opslaan niet kan (bijvoorbeeld in een privévenster) blijft het spel gewoon werken, maar
verdwijnt de voortgang zodra het venster dicht gaat; het spel zegt dat dan.

## De sommen

De sommen volgen de Nederlandse rekenmethode. Een delen-som schrijf je met een dubbele punt (`56 : 8`),
alle getallen blijven onder 10.000, er zijn geen komma's, breuken, resten of negatieve uitkomsten.

| Soort | Voorbeeld |
|---|---|
| Optellen / Aftrekken | `47 + 36 = ?`, `83 − 47 = ?` |
| Tafels / Delen | `7 × 8 = ?`, `56 : 8 = ?` |
| Gaatjessommen | `24 + ? = 51`, `7 × ? = 56` |
| Verhaalsommen | korte opgaven over tulpen, schelpen, fietsen en boten, soms met twee stappen |

De moeilijkheid per groep (3 t/m 6) en baan (1 t/m 8) staat in de tabel `PROFILE` in `RR.Questions`.
Elke som heeft een hint (verklapt het antwoord nooit) en een uitleg (laat de methode en het antwoord zien,
bijvoorbeeld splitsen, aanvullen tot een tiental of "tafel van 6 is tafel van 5 en nog 1 keer erbij").

## Voor wie eraan werkt

- **Eén bestand, geen bouwstap.** `rekenrace/index.html` bevat alle HTML, CSS en JavaScript. De rekenmodules
  zonder scherm (`RR.Rng`, `RR.Questions`, `RR.Heroes`/`Tracks`/`Race`, `RR.Store`) staan tussen
  `// ===PURE===` en `// ===ENDPURE===`, zodat Node ze kan testen; daarna volgen de schermmodules
  (`RR.Sprites`, `RR.Scene`, `RR.Sound`) en de gebruikersinterface. Alle teksten staan in de constante `TXT`.
  Namen van spelers komen alleen via `textContent` op het scherm.
- **Alles inline.** Omdat Vercel met `cleanUrls` zonder slash aan het eind werkt, mag de pagina geen
  relatieve bestanden laden. Pixelart wordt in code getekend, geluid in code gemaakt.
- **Tests** (onderdeel van `npm test`): `tests/rekenrace-race.test.mjs`, `tests/rekenrace-opslag.test.mjs`
  en `tests/rekenrace-sommen.test.mjs`. De sommentest rekent elk antwoord onafhankelijk na uit de tekst
  van de som; houd dat zo bij nieuwe soorten sommen.
- **Browsertests** (niet in `npm test`, want Playwright is geen afhankelijkheid): zie `tests/rekenrace-e2e/`.
  Ze spelen het spel echt door in Chromium: spelers, een race met goede en foute antwoorden, rustmoment,
  rijbewijs, ouderscherm, opstartmelding, en de lay-out op telefoon, tablet en laptop.
  Starten: `NODE_PATH=$(npm root -g) node tests/rekenrace-e2e/play.cjs` (ongeveer 2 minuten).

## Bekende beperkingen

- Getest in Chromium. Safari (iPhone, iPad) en Firefox zijn nog niet echt uitgeprobeerd.
- Het geluid is gemeten (niveau, lengte, geen klikken) maar nog niet door een mens beluisterd.
- Een lopende glijbeweging kan niet worden gepauzeerd; de pauze wacht tot de kart is aangekomen.
- De terugknop van de browser verlaat de pagina; de voortgang blijft bewaard, een lopende race niet.
- Op zeer kleine schermen (320 px breed) kan een lange verhaalsom net uit beeld scrollen.
