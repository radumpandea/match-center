---
name: match-data-json
description: Cercetează un meci de fotbal și produce un fișier JSON structurat (docs/data/matches/<slug>.json) conform docs/data/schema.json, care alimentează ecranul interactiv Match Center. Aceeași metodologie de research ca pachetul de comentator (formă, cap la cap, loturi complete, absențe, brigadă, antrenori, mercato, fire narative), dar output-ul este JSON pentru un UI, nu un PDF. Folosește acest skill pentru „construiește datele pentru meciul X vs Y", „match data JSON pentru meciul de azi/mâine", sau când rulează workflow-ul build-match-data.
---

# Match Center — date structurate per meci (JSON)

Acest skill produce **un singur fișier JSON** per meci (`docs/data/matches/<slug>.json`) care
respectă `docs/data/schema.json`. Fișierul e citit de `docs/match.html` (ecranul interactiv
Match Center): teren cu primul 11, carduri de jucător/antrenor/arbitru, panouri de
informații, strat de notițe.

## Pipeline în două niveluri — tu ești Nivelul 2

**Nivelul 1** (`scripts/prefetch-preview.mjs`, determinist, fără AI) rulează zilnic și
preîncarcă factualul din feedul RapidAPI: `squad[]` complet pe ambele echipe (număr, vârstă,
`nat`, înălțime, `pos`, plus `stats` pe sezonul curent — goluri, pase, cartonașe, rating),
`coach.name`, `absences[]` din accidentări, `referee.name`, `venue`, `confirmedXI` +
`formation` dacă alinierea era publică, și `teams.<side>.newsCandidates[]` — titluri brute
din RSS, datate. Fișierul e marcat `"partial": true`.

**Nivelul 2 (acest skill)** = stratul editorial + completarea golurilor: pornești de la
fișierul parțial, **nu de la zero**. Verifici ce a pus Nivelul 1, completezi ce lipsește
(formă, cap la cap, primul 11 probabil, antrenori, mercato, fire narative, funfacts) și
triezi `newsCandidates` în `news[]`. La final ștergi `partial` (și `newsCandidates`).

Dacă fișierul NU există sau NU are `"partial": true`, construiește tot de la zero — dar
metodologia de mai jos e aceeași în ambele cazuri.

Contractul de date (`docs/data/schema.json`) e obligatoriu — rulează
`node scripts/validate-match.mjs <fișier>` înainte să închei, și nu preda nimic dacă nu trece.

---

## Pasul 0 — Lotul: verifică ce a pus Nivelul 1, adâncește primul 11

Nivelul 1 a pus deja **lotul complet pentru ambele echipe** cu număr, vârstă, `nat`, `pos`,
înălțime (din feed, unde există) și `stats` pe sezon. Sarcina ta pe lot NU e să-l reconstrui
de la zero, ci:

1. **Verificare de completitudine** — compară `squad[]` din fișier cu sursa oficială (site
   de club / `footmercato.net/club/{club}/effectif/` / `superliga.ro` pentru RO; pentru
   meciuri UEFA, lista oficială înregistrată pentru dublă: `uefa.com/.../match/{id}--.../lineups/`,
   „Squad lists"). Adaugă jucătorii lipsă, scoate-i pe cei plecați, corectează numerele.
   Numără explicit portarii — dacă oficial sunt 3 și în fișier e 1, mai caută.
2. **`status` per jucător** — `available` / `doubt` / `out` / `suspended` + `statusNote`,
   din team news din preziua/ziua meciului. Feedul a marcat unele accidentări; suspendările
   (cumul de galbene, roșu) le pui tu.
3. **Adâncire — doar unde contează.** Detaliile grele (înălțime lipsă, `career`,
   `pronunciation`, `foot`, `funfact`, `linkLine`) se cercetează pentru: **primul 11 probabil
   al fiecărei echipe + orice jucător pe care îl atinge o poveste** (linkLine cu adversarul,
   revenire, bornă). Pentru restul lotului lasă câmpurile pe `null` — e normal, nu un eșec.
   Wikipedia (pagina individuală) e sursa unică cea mai eficientă: infobox cu înălțime +
   carieră + națională dintr-un fetch. Transfermarkt doar din fragmente de căutare.
   Academici tineri: `null`, nu inventa.

Dacă utilizatorul semnalează o lipsă, tratează asta ca semnal că verificarea a fost
incompletă și re-verifică integral posturile.

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

Ordinea de mai jos merge de la structurat (rapid, o pagină) spre editorial. Nu tot e mereu
disponibil — nu inventa. Ce a pus deja Nivelul 1 (stadion, arbitru nume, lot, accidentări,
`confirmedXI`) doar verifici, nu re-cauți.

1. **Cap la cap + clasament + formă — verifică ce a pus Nivelul 1, apoi SoccerStats pentru rest.**
   Nivelul 1 pune deja `h2h.recent[]` + `h2h.summary` (istoric all-time), `form.position` +
   `form.note`, `form.table` (rând de clasament: `played/win/draw/loss/gf/ga/points`) și
   `form.recent[]` — ghidul de formă stil OneFootball: ultimele ~5 meciuri (competitive +
   amicale), cel mai recent primul, din perspectiva echipei (`{date, opp, homeAway, comp,
   score, result}`). Verifică-le și **completează**: `form.last5` (W/D/L), `.ppg`, `.homeAway`
   (split acasă/deplasare în text), și `broadcast` (postul TV, ex. „DAZN"). Sursa rapidă:
   `soccerstats.com/latest.asp?league={liga}` (clasament la zi + statistici de goluri);
   `soccerstats.com/h2h.asp?...` pentru confirmarea capului la cap.
2. **Primul 11 probabil** → `predictedXI` (11, ordonat GK→ATT) + `formation`. Surse: maxifoot,
   VAVEL, Sports Mole, footmercato. Dacă `confirmedXI` e deja pus de Nivelul 1, folosește-l
   ca `predictedXI` și lasă `confirmedXI` cum e. Dacă meciul s-a jucat, caută alinierea reală.
3. **Verifică stadion + arbitru** (deja în fișier de la Nivelul 1). Completează: capacitate,
   oraș, sancțiuni (porți închise — știri disciplinare); pentru arbitru vârstă, aparății,
   medii galbene/roșii pe meci, istoric cu echipele. Dacă Nivelul 1 le-a lăsat `n/d`, caută-le
   tu de la zero.
4. **Antrenori** → `coach`: `country`, `age`, `tenureFrom`, și cariera COMPLETĂ cronologică
   (`career[]`: club, perioadă, realizare/motiv plecare). Sursă: Wikipedia (infobox
   „Managerial career") sau Transfermarkt (via search). **Nu numi mandatul curent „revenire"
   fără o sursă care confirmă un mandat anterior la același club.**
5. **`newsCandidates` → `news[]`.** Nivelul 1 a pus în `teams.<side>.newsCandidates[]` titluri
   brute din RSS (title, url, source, published). Triază: păstrează doar ce e **relevant
   direct pentru meci** (accidentare de ultimă oră, transfer din lot, conferință pre-meci,
   suspendare) și **datat în ultimele 2-3 zile**. Rescrie-le ca `news[]` (`{date, text}`) în
   română, parafrazat (fără citate lungi). Verifică rapid titlul la sursă dacă e ambiguu.
   Poți adăuga știri găsite separat (footmercato.net/actualite, superliga.ro). La final
   `newsCandidates` **nu apare în fișierul complet** — îl ștergi cu `partial`.
6. **Mercato vara curentă** → `mercatoIn[]` / `mercatoOut[]`: sosiri/plecări cu sume
   (footmercato.net/tableau sau echivalent).
7. **Pregătirea de vară** → `preseason[]`: amicalele cu scoruri (dacă mai e relevant).
8. **Absenți** → verifică `absences[]` (Nivelul 1 a pus accidentările din feed); adaugă
   suspendările și incertitudinile. `reason` ∈ injury/suspension/doubt/other.
9. **Fire narative** → `storyOfTheMatch[]` (6-10 propoziții) + `teams.<side>.stories[]` (bare
   cu titlu punchy stil presă sportivă + 2-5 bullet-uri pe un unghi). **Calculează** din ce e
   deja în fișier: `squad[].stats` îți dă golgheterii, disciplina, minutajul; SoccerStats îți
   dă rangul și seria de formă. Combină-le (ex. „X a marcat 5 din cele 9 goluri ale echipei",
   „Y — 4 meciuri fără înfrângere, dar 0 clean sheet-uri"). Fă aritmetica și **verific-o de
   două ori**. The Analyst (theanalyst.com) pentru unghi stil Opta la ligile mari.

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

### Pornire de la fișierul `"partial": true`

Vezi „Pipeline în două niveluri" la început. Pe scurt, când construiești peste fișierul parțial:
- **Păstrează** `squad[]`, `coach.name`, `absences[]`, `venue`, `referee.name`, `confirmedXI`.
  Verifică-le (Pasul 0 / Pasul 1) dar nu le rescrie fără motiv concret.
- **Completează golurile**: `form`, `h2h`, `predictedXI`, `storyOfTheMatch`,
  `teams.<side>.stories`, `mercatoIn/Out`, `preseason`, `coach.career/country/age/tenureFrom`,
  `colors`, `shortName`, plus câmpurile per-jucător pentru primul 11 (înălțime lipsă, `foot`,
  `funfact`, `linkLine`, `career`, `pronunciation`).
- **`newsCandidates` → `news[]`** (Pasul 1.5), apoi **șterge `newsCandidates`**.
- **Șterge câmpul `partial`** — pachetul devine complet.
- Adaugă sursele tale în `sources[]` pe lângă cea a feedului.

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
- `squad[].stats` (opțional) = agregate pe sezonul curent: `goals`, `assists`, `minutes`,
  `apps`, `yellow`, `red`, `rating` — toate nullable. Pune-le doar dacă le găsești la o
  sursă (FBref / SoccerStats / Transfermarkt); altfel omite tot obiectul. Ecranul le
  completează oricum din feedul live acolo unde lipsesc.
- `colors` = culorile principale ale echipei (hex), pentru tricourile de pe teren. Dacă nu
  ești sigur, `null` — ecranul are un fallback.
- `absences[].reason` ∈ injury/suspension/doubt/other.
- `news[]` = `{date, text}`, text în română, parafrazat. `newsCandidates` (dacă exista de la
  Nivelul 1) **nu apare** în fișierul final — l-ai triat în `news[]` și l-ai șters.
- `form.recent[].score` = din perspectiva echipei (golurile ei primele, ex. „3-1").
  `homeAway` ∈ H/A/N. `comp` = numele competiției (amicalele se afișează ca „amical").
- `broadcast` (opțional, la nivel de meci) = postul TV / streaming, text liber.
- La final, fișierul complet **nu conține** `partial` și **nu conține** `newsCandidates`.

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
