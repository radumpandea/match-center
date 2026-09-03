---
name: match-data-json
description: Cercetează un meci de fotbal și produce un fișier JSON structurat (docs/data/matches/<slug>.json) conform docs/data/schema.json, care alimentează ecranul interactiv Match Center. Aceeași metodologie de research ca pachetul de comentator (formă, cap la cap, loturi complete, absențe, brigadă, antrenori, mercato, fire narative), dar output-ul este JSON pentru un UI, nu un PDF. Folosește acest skill pentru „construiește datele pentru meciul X vs Y", „match data JSON pentru meciul de azi/mâine", sau când rulează workflow-ul build-match-data.
---

# Match Center — date structurate per meci (JSON)

Acest skill face **exact aceeași cercetare** ca skill-ul `pachet-comentator-fotbal` din
`radumpandea/comentarii`, dar în loc de un PDF stil Opta Facts produce **un singur fișier
JSON** care respectă `docs/data/schema.json`. Fișierul este citit de `docs/match.html`
(ecranul interactiv Match Center): teren cu primul 11 probabil, carduri de jucător/antrenor/
arbitru, panouri de informații, strat de notițe.

Contractul de date (`docs/data/schema.json`) e obligatoriu — rulează
`node scripts/validate-match.mjs <fișier>` înainte să închei, și nu preda nimic dacă nu trece.

---

## Pasul 0 — Loturile complete și detaliile complete per jucător sunt implicite, întotdeauna

**Implicit, inclusiv fără să fie cerut explicit: lotul complet, pentru ambele echipe, cu
nivelul maxim de detaliu per jucător (înălțime, carieră, statistici, plus orice fapt
interesant găsit), la fiecare meci.** Nu întreba dacă „doar titularii" sau „tot lotul", nici
cât de detaliat — presupune maximul în ambele privințe. Excepție: dacă utilizatorul cere
explicit un scop redus.

Pentru meciuri europene (UEFA), sursa cea mai autoritară e **lista oficială UEFA înregistrată
pentru acea dublă** (`uefa.com/{competiție}/match/{id}--{a}-vs-{b}/lineups/`, secțiunea
„Squad lists") — nu lotul general de club. Lotul general de club include des jucători care NU
sunt înregistrați pentru competiția europeană — aceștia nu intră ca disponibili.

### Verificare sistematică, obligatorie — nu doar reactivă

După ce ai compilat lotul, **verifică-l post cu post, jucător cu jucător**, contra sursei
oficiale (UEFA squad list pentru cupe europene; site-ul oficial de club sau
`superliga.ro` / `footmercato.net/club/{club}/effectif/` pentru campionate interne). Dacă
utilizatorul semnalează o lipsă, tratează asta ca semnal că verificarea a fost incompletă și
**re-verifică integral toate posturile**. Numără explicit: dacă sursa oficială arată 3
portari și tu ai listat 1, e un eșec de verificare. Marchează în JSON `status` corect
(`available` / `doubt` / `out` / `suspended`) pentru fiecare jucător, cu `statusNote`.

### Detaliile per jucător (înălțime, carieră, statistici) — pentru tot lotul

Nivelul de detaliu cere volum mare de research — pentru 20+ jucători per echipă poate ajunge
la 40-90+ căutări/fetch-uri suplimentare doar pentru înălțime + carieră. E volumul normal,
așteptat. Ca să lucrezi eficient:
- Transfermarkt (cea mai bună sursă pentru înălțime) blochează fetch direct — doar căutare +
  citit din fragmente.
- Pentru academici tineri, înălțimea/cariera detaliată adesea nu există public — pune `null`,
  nu inventa.
- Wikipedia (pagina individuală) e adesea cea mai eficientă sursă unică: infobox cu înălțime
  + carieră de cluburi + națională dintr-un singur fetch — verific-o prima.

Marchează onest `null` / `"n/d"` acolo unde nu găsești, în loc să inventezi.

### Fapte interesante per jucător (`funfact`) și legături directe (`linkLine`)

Pe măsură ce cercetezi cariera fiecărui jucător, fii atent la ce dă culoare comentariului —
nu ca o căutare separată per jucător, ci ca atenție la ce apare deja în sursele consultate:
- **Legătură cu adversarul** (`linkLine`): a jucat pentru echipa adversă, s-a format în
  academia ei, a marcat împotriva ei recent, joacă prima dată contra fostului club. Include
  DOAR cu istoric direct verificabil dintr-o sursă (goluri/meciuri/roșu/gol decisiv).
- **Poveste personală** (`funfact`): relații de familie cu alt jucător/antrenor din meci,
  revenire pe orașul natal, revenire după accidentare lungă, o bornă de carieră.
- **Fapt de carieră notabil** (`funfact`): golgheter al ligii, cel mai tânăr/în vârstă din
  lot, record de club, parcurs neobișnuit.

Adaugă un fapt DOAR dacă există și e confirmat. Majoritatea rezervelor și tinerilor n-au
nimic relevant — `funfact` / `linkLine` rămân `null`, e normal.

## Pasul 1 — Cercetare (web_search / web_fetch)

Adună, în această ordine, cât mai multe (nu toate sunt mereu disponibile — nu inventa):

1. **Meci de bază**: dată, oră, competiție, etapă → `kickoff`, `competition`.
2. **Stadion** → `venue`: nume oficial + nume de sponsorizare, capacitate, oraș, orice
   sancțiune specială (porți închise etc. — verifică știri disciplinare recente).
3. **Arbitri** → `referee`: principal (+ asistenți/al 4-lea/VAR în `history` dacă vrei),
   vârstă, aparițiile în carieră, medii de galbene/roșii pe meci dacă se găsesc, istoricul cu
   fiecare echipă.
4. **Antrenori** → `teams.<side>.coach`: cariera COMPLETĂ de antrenor ca listă cronologică
   (`career[]`: club, perioadă, realizare/motiv plecare). Cea mai bună sursă: Wikipedia
   (infobox „Managerial career") sau profilul de manager Transfermarkt (doar via search).
   **Nu descrie mandatul curent ca „revenire" fără o sursă care confirmă un mandat anterior
   la același club.**
5. **Cap la cap** → `h2h`: ultimele 2-3 întâlniri directe (`recent[]`: dată, competiție,
   scor ca text „Echipa A x-y Echipa B") + `summary` cu statistica agregată (cu sursă).
   SoccerStats.com are pagină H2H structurată.
6. **Formă / sezonul trecut** → `teams.<side>.form`: ultimele 5 rezultate (`last5`: W/D/L),
   PPG, split acasă/deplasare. SoccerStats.com e cea mai rapidă sursă structurată.
7. **Absenți** → `teams.<side>.absences[]`: accidentări, suspendări, incertitudini — știri de
   team news din preziua/ziua meciului. `reason` ∈ injury/suspension/doubt/other.
8. **Primul 11 probabil** → `teams.<side>.predictedXI` + `formation`. Surse: maxifoot, VAVEL,
   Sports Mole, footmercato. Dacă meciul s-a jucat deja, caută alinierea reală și pune-o și
   în `confirmedXI`.
9. **Mercato vara curentă** → `mercatoIn[]` / `mercatoOut[]`: sosiri/plecări cu sume,
   footmercato.net/tableau sau echivalent.
10. **Pregătirea de vară** → `preseason[]`: toate amicalele cu scoruri.
11. **Loturi complete** → `squad[]`: vezi Pasul 0 și „Loturi complete" mai jos.
12. **Top știri recente** → `news[]`: **nimic mai vechi de 2-3 zile** față de data curentă
    (verifică data articolului). Agregatoare per țară care afișează ora/data: pentru Franța
    `footmercato.net/actualite`, pentru România `superliga.ro`, etc. Prioritizează relevanța
    directă pentru meci (accidentări de ultimă oră, transferuri din lot, conferințe pre-meci).
13. **Subiecte de discuție** → `storyOfTheMatch[]` (6-10 propoziții) + `teams.<side>.stories[]`
    (bare de poveste dedicată, cu titlu punchy stil presă sportivă și 2-5 bullet-uri pe un
    singur unghi). Multe fapte bune se **calculează** din date brute (procent din goluri din
    faze fixe, secvență de meciuri fără înfrângere, rang în ligă la un stat) — fă tu calculul
    și **verifică-l de două ori**. The Analyst (theanalyst.com) e sursa cea mai apropiată de
    tonul Opta pentru ligile mari.

### Surse preferate (în ordine)
Site-uri oficiale ligă/club → footmercato.net (efectiv + tablou transferuri + fișe jucători)
→ FBref (verificare lot efectiv folosit; fetch direct blochează des) → Transfermarkt (doar
via search) → Soccerway → The Analyst → agregatoare de cote → presă specializată (doar
parafrazat).

Pentru **clasament, formă, cap la cap, statistici de goluri**: adaugă **SoccerStats.com**
indiferent de ligă — e fetch-abil direct.
- Pagina de ligă: `soccerstats.com/latest.asp?league={liga}` (ex. `england`).
- Pagina H2H: `soccerstats.com/h2h.asp?league={liga}&t1id={id1}&t2id={id2}` (pornește de la
  `h2h_selection.asp?league={liga}` dacă nu știi ID-urile).

**Excepție — SuperLiga România**: `superliga.ro` e de departe cea mai bună sursă și se
folosește prioritar. Un fetch pe `superliga.ro/cluburi/{club}` dă stadion, antrenor, lot
complet pe posturi cu numere și meciuri; paginile de jucător dau înălțime, greutate, picior
preferat și statistici stil Opta.

### Loturi complete — sfaturi practice
- **UEFA**: lista oficială a meciului (`uefa.com/.../match/{id}--.../lineups/`) — lot complet
  înregistrat, pe posturi. Jucătorii cu „*" sunt de obicei „List B" (sub 21).
- **Campionate interne**: `footmercato.net/club/{club}/effectif/` — numărul de tricou, vârsta,
  naționalitatea, mini-tabel de statistici, într-un singur fetch. NU are înălțime.
- **A doua verificare** pentru campionate interne: pagina FBref „Standard Stats — All
  Competitions" a clubului pe sezonul curent — listează fiecare jucător care a prins un minut
  oficial, util ca să scoți jucători care apar „pe hârtie" dar nu mai joacă. FBref blochează
  des fetch direct — citește din fragmente.
- **Înălțime**, în ordinea șansei: Wikipedia (pagina individuală) → Sofascore (profil
  individual, des vizibil din fragmentul de căutare) → footmercato.net/joueur/{nume} →
  Transfermarkt (din fragmente). Academici tineri: `null`.
- Nu presupune că un jucător dintr-un articol vechi mai e la club — verifică în efectivul
  curent.

## Pasul 2 — Producerea fișierului JSON

Scrie **un singur fișier** la `docs/data/matches/<slug>.json`, unde `<slug>` e câmpul `slug`
al fixtureului din `docs/data/fixtures.json` (ex. `l1-e4-toulouse-lille`).

Reguli de mapare:
- Respectă **exact** `docs/data/schema.json` (`additionalProperties: false` peste tot — nu
  adăuga câmpuri).
- Valori necunoscute: `null` pentru câmpuri tipizate ca nullable, `"n/d"` pentru string-uri
  obligatorii (`venue.name`, `formation` etc.). **Niciodată inventate.**
- `slug` = slug-ul din fixtures. `generatedAt` = timestamp ISO acum.
- `sources[]` = fiecare sursă folosită, cu `name`, `url`, `accessed` (data). Minim câteva.
- `kickoff` = ISO 8601 cu offset (ex. `2026-09-03T21:45:00+03:00`).
- `predictedXI` = 11 intrări, ordonate GK → apărare → mijloc → atac. `pos` = etichetă de
  poziție din lista din schemă (GK, LB, LCB, CB, RCB, RB, LWB, RWB, DM, LCM, CM, RCM, LM, RM,
  CAM, LW, RW, LF, RF, ST, LST, RST). Ecranul așază jucătorii pe teren din `pos` + `formation`.
- `confirmedXI` = `null` dacă alinierea oficială nu era publică la momentul build-ului.
- `squad[]` = tot lotul. `role` ∈ GK/DEF/MID/ATT (obligatoriu). `foot` ∈ L/R/B/null.
  Coduri de țară cu 3 litere (DNK, FRA, ITA...).
- `colors` = culorile principale ale echipei (hex), pentru tricourile de pe teren. Dacă nu
  ești sigur, `null` — ecranul are un fallback.
- `absences[].reason` ∈ injury/suspension/doubt/other.

După ce scrii fișierul:
```
node scripts/validate-match.mjs docs/data/matches/<slug>.json
```
Trebuie să treacă fără eroare. Rezolvă orice `✗`. Avertismentele `!` (ex. „doar 1 portar")
sunt semnale de re-verificat, nu neapărat blocante — dar tratează-le serios.

## Pasul 3 — Limbă și ton

Textul liber din JSON (`storyOfTheMatch`, `stories[].bullets`, `news[].text`, `funfact`,
`linkLine`, `coach.career[].note`, `h2h.summary`) — implicit română, ton de comentator
sportiv profesionist: concis, orientat spre fapte, propoziții complete, fără umplutură.
Nu pune diacritice „stricate" — folosește UTF-8 corect (ș, ț, ă, â, î).

## Reguli de acuratețe (importante)

- **Nu inventa date.** Info negăsită → `null` / `"n/d"` explicit, nu o presupunere.
- **Afirmațiile „premieră" / „revenire" / „record" cer o sursă care spune exact asta**, nu o
  inferență. Sunt cele mai memorabile dintr-un pachet, dar și cele mai ușor de inventat din
  greșeală. Fără o sursă explicită, prezintă faptul simplu, fără înflorire narativă.
- **Verifică din nou** dacă utilizatorul semnalează o eroare sau o lipsă — de obicei are
  dreptate (transferuri recente, antrenori schimbați, jucători omiși). Caută țintit și
  corectează, nu te apăra reflex.
- **Copyright**: parafrazează faptele din presă; niciun citat de peste 15 cuvinte; maxim un
  citat per sursă.
- **Actualitate**: fotbalul se schimbă rapid — prioritizează sursele cele mai recente
  (verifică datele articolelor).
