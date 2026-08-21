# Guide: Mapping af konti og leverandører mellem Corpay One og NetSuite

Denne guide beskriver, hvordan integrationen finder den rigtige **udgiftskonto** og den
rigtige **leverandør** for hvert bilag — hvad der sker automatisk, hvad du skal gøre,
når noget ikke matcher, og hvordan auto-oprettelse af leverandører fungerer.

Alle beslutninger kan følges i loggen. De fire linjetyper, du skal kende:

| Log-linje | Betydning | Handling |
|---|---|---|
| `MATCH vendor "…" -> NetSuite 742 (cvr)` | Leverandør auto-matchet | Ingen — stemples automatisk |
| `CREATED vendor "…" in NetSuite (ns id 900)` | Leverandør auto-oprettet | Gennemgå evt. den nye leverandør i NetSuite |
| `SKIP … is ambiguous (2 NetSuite vendors share the name)` | Flertydigt match | Ryd op i dubletterne (se nedenfor) |
| `NOTE category "…" (4020) not matched…` | Kategori uden konto-match | Ret kontonummeret (se nedenfor) |

---

## 1. Udgiftskonti (Corpay-kategorier → NetSuite-kontoplan)

### Sådan afgøres kontoen pr. linje — i denne rækkefølge

1. **Stemplet externalId**: Kategoriens `externalId` i Corpay indeholder NetSuite-kontoens
   interne id → bruges direkte.
2. **Kontonummer-match (den normale vej)**: Kategoriens **nummer** i Corpay (fx `2201`)
   slås op mod NetSuite-kontoplanens **kontonummer** (`acctnumber`). Findes præcis den
   konto, bruges den. Corpay-kategorier bærer normalt kontonumrene fra det tilsluttede
   regnskabssystem, så dette virker out-of-the-box, når numrene er ens i begge systemer.
3. **Standardkonto**: Ellers bogføres linjen på `NS_DEFAULT_EXPENSE_ACCOUNT_ID`, og der
   logges én `NOTE`-linje pr. kategori pr. kørsel.

### Opsætning og fejlretning

- **Tjek numrene stemmer**: Åbn Corpay → Indstillinger → Kategorier og sammenlign numrene
  med NetSuites kontoplan (*Lists → Accounting → Accounts*). Ens numre = automatisk mapping.
- **Nummer findes ikke i NetSuite**: Ret enten kategorinummeret i Corpay eller kontonummeret
  i NetSuite, så de matcher. (Corpays offentlige API har ikke et endpoint til at stemple
  `externalId` på kategorier — nummer-match er den understøttede mekanisme.)
- **Følg op på NOTE-linjer**: Efter hver kørsel viser `NOTE category "…" (…) not matched…`
  præcis, hvilke kategorier der landede på standardkontoen. Målet er nul NOTE-linjer.
- **Standardkontoen er dit sikkerhedsnet**, ikke din mapping: vælg en tydelig
  "ufordelte omkostninger"-konto, så bogholderen let kan ompostere.

---

## 2. Leverandører (Corpay-leverandør → NetSuite-vendor)

### Sådan afgøres leverandøren pr. bilag — i denne rækkefølge

1. **Stemplet externalId**: Corpay-leverandørens `externalId` indeholder NetSuite-leverandørens
   interne id → bruges direkte. (Integrationen stempler selv efter et match, så dette er
   normaltilstanden efter første kørsel.)
2. **CVR-match**: Corpay-leverandørens CVR/momsnummer (`identification`) sammenlignes —
   kun cifre, så `DK 12 34 56 78` matcher `12345678` — med NetSuite-leverandørens
   **Tax Reg. Number** (`vatregnumber`). Ét entydigt match vinder.
3. **Navne-match**: Eksakt firmanavn (uafhængigt af store/små bogstaver og mellemrum).
   Ét entydigt match vinder. **To NetSuite-leverandører med samme navn = spring over**
   (flertydighed må aldrig gættes).
4. **Auto-oprettelse**: Findes der slet ingen kandidat, **oprettes leverandøren automatisk
   i NetSuite** (se afsnit 3).

Et match/en oprettelse stemples tilbage på Corpay-leverandøren, så næste kørsel rammer
direkte i trin 1. (Kræver vendor-skrive-scope i Corpay-API-klienten; uden det matches der
blot igen ved hver kørsel — det virker, men er langsommere.)

### Når en leverandør IKKE matcher — gør ét af følgende

| Situation | Løsning |
|---|---|
| Leverandøren findes i NetSuite, men uden CVR | **Bedste løsning:** udfyld *Tax Reg. Number* (CVR) på NetSuite-leverandøren — så matcher CVR-trinnet næste kørsel |
| Findes i NetSuite under et andet navn | Enten udfyld CVR (anbefalet), ret navnet, eller stempl manuelt: Corpay UI → leverandøren → external id = NetSuite-internt id (eller `PATCH /external/v2/teams/{teamId}/vendors/{id}/external-id` med `{"source":"netsuite","externalId":"742"}`) |
| `SKIP … is ambiguous` — flere med samme navn | Ryd op: gør dubletten inaktiv i NetSuite eller omdøb den — eller stempl manuelt, hvilken der er den rigtige |
| Vil du slå automatikken fra? | `CORPAY_VENDOR_AUTOMATCH=false` (så synkroniseres kun manuelt stemplede leverandører) |

---

## 3. Auto-oprettelse af leverandører

**Er et bilag bogført i Corpay, og leverandøren slet ikke findes i NetSuite, oprettes den
automatisk** — bilaget bogføres i samme kørsel. Slås fra med `CORPAY_VENDOR_AUTOCREATE=false`
(NetSuite-varianten: `custscript_cp_vendor_autocreate`).

**Hvad den oprettede leverandør får:**
- Firmanavn, CVR (*Tax Reg. Number*), e-mail — fra Corpay
- Subsidiary (integrationens faste valg) og evt. valuta
- `externalId = corpay-vendor-{id}` — gør oprettelsen **idempotent**: gentagne kørsler/
  netværksfejl kan aldrig oprette den samme leverandør to gange

**Hvad den IKKE får:** bankoplysninger og betalingsbetingelser. Det er bevidst — betalinger
sker i Corpay, ikke fra NetSuite, så de er ikke nødvendige for flowet. Gennemgå de
`CREATED`-loggede leverandører, hvis I vil berige dem.

**Dublet-risikoen, du skal kende:** Findes leverandøren allerede i NetSuite, men under et
andet navn **og uden CVR**, kan integrationen ikke se det — og opretter en dublet.
Forsvaret er simpelt: **hold CVR-numre udfyldt på jeres NetSuite-leverandører.** Så fanger
CVR-trinnet dem altid, uanset stavemåde. Flertydige navne-match opretter aldrig noget.

---

## 4. Anbefalet onboarding-rutine (pr. kunde)

1. Sammenlign kategorinumre (Corpay) med kontonumre (NetSuite); ret afvigelser
2. Udfyld CVR på NetSuite-leverandørerne (engangs-datavask — vigtigste enkelttrin)
3. Kør synkroniseringen manuelt én gang mod sandbox
4. Gennemgå loggen: `NOTE` = kategorier der skal rettes · `SKIP` = leverandører der skal
   afklares · `CREATED` = nye leverandører der bør gennemgås
5. Gentag til loggen er ren — slå derefter automatikken til
