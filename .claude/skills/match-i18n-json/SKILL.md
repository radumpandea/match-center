---
name: match-i18n-json
description: Traduce conținutul editorial deja cercetat al unui pachet de meci Match Center (docs/data/matches/<slug>.json) în engleză, franceză, germană și italiană, scriind rezultatul într-un fișier separat docs/data/matches/<slug>.i18n.json. NU face research nou — traduce fidel ce e deja verificat în română. Folosește acest skill când rulează workflow-ul translate-match-data, sau la cerere pentru „tradu meciul X în EN/FR/DE/IT".
---

# Match Center — traducerea conținutului editorial (EN/FR/DE/IT)

Acest skill traduce conținutul editorial deja cercetat al unui pachet de meci
(`docs/data/matches/<slug>.json`, cu `partial` absent — un pachet "pregătit"
sau "premium") în engleză, franceză, germană și italiană. Rezultatul se scrie
într-un fișier NOU, `docs/data/matches/<slug>.i18n.json` — fișierul sursă nu
se modifică niciodată, rămâne varianta canonică în română.

## De ce un fișier separat

Site-ul e static, fără build step. `docs/app/i18n.js` traduce deja interfața
(butoane, etichete) în RO/EN/FR/DE/IT. `docs/app/match.js`
(`applyI18nOverlay`) suprapune ACEST fișier peste conținutul cercetat al
meciului, în funcție de limba aleasă — dacă limba e română, sau dacă fișierul
nu există încă, ecranul arată exact ce arăta înainte (conținutul românesc).

## Ce se traduce — și ce NU

Doar textul liber, redactat editorial. NU se traduc: nume de echipe/jucători/
antrenori/arbitri/stadioane/competiții, scoruri, date, formații (`4-2-3-1`),
cifre, coduri de poziție, `pronunciation` (transcriere fonetică pentru citire
în română — nu are sens re-derivată pentru alt cititor; se omite din
traducere).

Câmpuri de tradus, EXACT aceste chei din fișierul sursă:
- `storyOfTheMatch[]`
- `h2h.summary`
- `referee.history`
- `venue.notes`, `venue.stories[]`
- `commentatorResearch[].topic`, `commentatorResearch[].fact`
- `teams.<home|away>.coach.career[].note`
- `teams.<home|away>.news[].text`
- `teams.<home|away>.stories[].title`, `teams.<home|away>.stories[].bullets[]`
- `teams.<home|away>.squad[].funfact`, `.linkLine`, `.career`, `.lastSeason`,
  `.statusNote`

Orice altă cheie din sursă (nume, scoruri, formații, statistici, id-uri) nu
apare deloc în fișierul de traducere.

### Cazul special `squad[].career`

Un istoric de cluburi compact, ex.:
`"Inter (2016) · Renate (2017) · Monza (2020–2023) · Bournemouth (2026–prezent)"`.
NU traduce nume de cluburi sau ani — schimbă DOAR cuvântul „prezent" în
echivalentul din limba țintă, restul rămâne identic (paranteze, `·`, `–`):

| Limbă | Cuvânt |
|---|---|
| en | present |
| fr | présent |
| de | heute |
| it | presente |

Dacă string-ul sursă nu conține „prezent" (jucătorul a plecat de la echipă),
lasă string-ul identic — nimic de tradus.

## Regula de aur: pozițiile din array corespund exact, prin index

`applyI18nOverlay` din `match.js` citește STRICT după poziție, niciodată după
conținut. Fiecare array din traducere trebuie să aibă **exact aceeași
lungime, în aceeași ordine**, ca array-ul corespunzător din fișierul sursă.
Dacă sursa are 14 propoziții în `storyOfTheMatch`, traducerea trebuie să aibă
tot 14 — propoziția tradusă de pe poziția 5 trebuie să fie traducerea EXACTĂ
a propoziției 5 din sursă, nicio inserare, omisiune sau reordonare.

- Pentru un câmp scalar (string) `null` în sursă (ex. `referee.history` sau
  `funfact`-ul unui jucător): pune `null` — nu inventezi ce nu există în
  sursa română.
- Pentru un element dintr-un array de obiecte (`coach.career[]`, `squad[]`,
  `stories[]`, `commentatorResearch[]`) unde câmpul de interes e `null` sau
  absent în sursă: pune `null` PE ACEEAȘI POZIȚIE în array-ul de traducere —
  nu scurtezi array-ul.
- `teams.<side>.squad` din traducere trebuie să aibă EXACT câte elemente are
  `teams.<side>.squad` din sursă (chiar dacă majoritatea au toate cele 5
  câmpuri `null`) — poziția N din traducere = jucătorul N din sursă.

## Formatul fișierului de ieșire

Un obiect cu până la 4 chei (`en`, `fr`, `de`, `it`) — scrie doar limbile
cerute de acest run. Fiecare valoare are aceeași formă (căi + lungimi de
array) ca subsetul de mai sus din sursă. `additionalProperties` nu e impus
strict, dar nu adăuga chei în afara listei — validatorul verifică lungimile,
nu ignoră tăcut o cheie greșit denumită.

Exemplu (trunchiat, doar `en`):

```json
{
  "en": {
    "storyOfTheMatch": ["...", "...", null, "..."],
    "h2h": { "summary": "..." },
    "referee": { "history": null },
    "venue": { "notes": null, "stories": ["...", "..."] },
    "commentatorResearch": [ { "topic": "...", "fact": "..." } ],
    "teams": {
      "home": {
        "coach": { "career": [ null, "..." ] },
        "news": ["...", "..."],
        "stories": [ { "title": "...", "bullets": ["...", "..."] } ],
        "squad": [
          { "funfact": null, "linkLine": null, "career": "Inter (2016) · ... (2026–present)", "lastSeason": null, "statusNote": null },
          null
        ]
      },
      "away": { "...": "..." }
    }
  }
}
```

Un element `squad[]`/`coach.career[]` cu toate câmpurile `null` poate fi
scris fie ca obiectul complet cu valorile `null`, fie direct `null` — ambele
au aceeași lungime de array la citire, deci sunt echivalente pentru
validator și pentru `match.js`.

## Pas cu pas

1. Citește `docs/data/matches/<slug>.json`. Dacă are `"partial": true`, STOP
   — nu există încă pachet editorial de tradus (asta e treaba altui skill,
   `match-data-json`).
2. Pentru fiecare limbă cerută de acest run, parcurge câmpurile din lista de
   mai sus și scrie traducerea, respectând regula de poziții.
3. Scrie totul într-un singur fișier, `docs/data/matches/<slug>.i18n.json`.
   Dacă fișierul deja există (rulare anterioară) și acest run adaugă o limbă
   nouă, păstrează limbile existente neschimbate și adaugă doar cea nouă —
   nu retraduci ce e deja acolo.
4. Validează:
   ```
   node scripts/validate-i18n.mjs docs/data/matches/<slug>.i18n.json
   ```
   Trebuie să treacă fără eroare. Orice `✗` de lungime greșită se repară
   înainte să încheii — de obicei înseamnă că ai omis sau ai adăugat un
   element în array.

## Ton și acuratețe

Traducere fidelă, naturală, ton de comentator sportiv profesionist — nu
traducere cuvânt cu cuvânt. Terminologie de fotbal idiomatică în limba țintă
(engleză britanică pentru fotbal, nu americană; „but contre son camp" în
franceză pentru autogol, nu un calc). Nu adaugi, nu omiți și nu „îmbunătățești"
fapte față de sursa română — asta e strict o traducere, nu o nouă redactare;
orice afirmație factuală trebuie să însemne EXACT ce însemna în română.
