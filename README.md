# Zeiklijst Live

Zeiklijst Live is een gedeelde takenlijst voor intern gebruik op de afdeling. Er zijn twee installeerbare apps (PWA's) vanuit dezelfde site en hetzelfde Firebase-project:

- **Zeiklijst Live** (medewerkers): https://jordi-cyx.github.io/afdeling-takenlijst/
- **Zeiklijst Admin** (beheer): https://jordi-cyx.github.io/afdeling-takenlijst/admin/

De live versie op `main` blijft de oude lokale app tot deze Firebase-versie is samengevoegd én de beveiligingsregels in de Firebase-console zijn gepubliceerd.

## Voor medewerkers

- Openstaande en pending taken zien: titel, toegewezen aan, status en tijdstippen
- Tik op een taak voor de beschrijving en eventuele foto's
- Markeer een taak als **gedaan**. De status wordt **Pending**. Optioneel kun je je naam kiezen (Afgevinkt door)
- Een pending taak blijft in de lijst, maar wordt grijs/doorschijnend. Je kunt het afvinken ongedaan maken
- Herhalende taken herken je aan het badge **Herhalend**

Er is geen admin-login in de medewerkers-app.

## Voor admin

Open de Admin-app en log in met e-mail en wachtwoord (typ het e-mailadres zelf; er staat niets vooringevuld). De app gebruikt de HORNBACH-kleuren (`#3A3C3E`, accent `#F99D27`) en het lettertype **Rubik Distressed** (OFL) voor de kop in de menubanner.

- **Dashboard**: aanklikbare totalen voor open (naar Taken, gefilterd) en pending (naar Controle), de *actuele* open/pending-verdeling per medewerker (inclusief Allen en Niet toegewezen), en een korte lijst van de laatste pending taken. Afgerond blijft als kleiner cijfer staan.
- Taken **toevoegen** en **bewerken** (titel verplicht; locatie, beschrijving en foto's optioneel, max. 4 gecomprimeerde foto's). Het formulier "Nieuwe taak" staat standaard ingeklapt. Zoeken en filteren kan op status, medewerker, locatie en herhalend.
- Optionele **streefdatum** bij eenmalige taken. Op kaarten en in de details staat “Streefdatum dd-mm-jjjj”. Is die datum verstreken en de taak nog niet afgerond, dan verschijnt een rood/magenta badge, een dashboardkaart **Streefdatum verstreken** (aantal + lijst) en een filter in Taken.
- Een bestaande taak **opnieuw toewijzen**
- Taken **verwijderen**
- Een afgeronde taak **terugzetten naar open**
- Pending taken **goedkeuren** of **afwijzen**, altijd met een bevestigingsdialoog. Bij afwijzen kan een korte reden (sterk aangeraden). Die geschiedenis is zichtbaar in de taakmodal.
- **Workflow**: per persoon de huidige open/pending-last, plus afgerond en afgekeurd in de gekozen periode, en optioneel wie taken heeft afgevinkt (`pendingBy`)
- **Terugkerende taken** aanmaken, bewerken, pauzeren en verwijderen
- **Medewerkers** beheren (toevoegen, hernoemen, deactiveren). Bij hernoemen wordt `assigneeName` ook bijgewerkt op open/pending taken en herhaal-templates. De standaardlijst: Jane, Aart, Edwin, Daan, Reda, Akif, Finn, Tim, Guido, Renato, Alex. Toewijzen via een keuzelijst, plus **Allen** en niet-toegewezen
- **Startcodes en pincode**: per medewerker de knop **Startcode maken** (of **Pincode resetten (startcode)** als er al een pincode is). Je krijgt een eenmalige code van 10 tekens (getoond als `XXXXX-XXXXX`, 7 dagen geldig) met een kopieerknop en de vervaldatum. Geef die persoonlijk aan de medewerker. Bij elke medewerker zie je of er een open startcode is (met vervaldatum), je kunt de code opnieuw tonen of verwijderen. Inactieve medewerkers kunnen geen startcode krijgen. Medewerkers met een oude pincode (zonder startcode) staan gemarkeerd als **Nieuwe startcode nodig**. Met **Startcodes maken voor alle actieve medewerkers** maak je in één keer voor iedereen een nieuwe code; na bevestiging zie je een lijst met naam, code en kopieerknoppen. Een verzoek "Pincode vergeten" (badge in het menu, lijst op Dashboard en Medewerkers) geeft zelf geen toegang. Het bevat alleen een **opgegeven naam** (niet gecontroleerd) en eventueel een toelichting. Kies zelf de juiste medewerker (de app stelt er een voor als de naam precies overeenkomt) en tik **Startcode maken**, of tik **Verzoek wissen**. Maak alleen een code als de medewerker het persoonlijk vraagt. Onder Data kun je de oude **naamindex verwijderen**; die wordt niet meer gebruikt.
- Bij een nieuwe versie van de admin-app verschijnt de balk **Nieuwe versie beschikbaar, tik om te vernieuwen**.
- **Aangemaakte taken**: taken die een medewerker zelf heeft aangemaakt (`adminReview: nieuw`) verschijnen op het Dashboard, met knoppen **Gezien** en **Afgehandeld**. In Taken staan ze gemarkeerd als “Door &lt;naam&gt; aangemaakt”. Een badge in het menu toont het aantal nieuwe items.
- **Meldingen**: een eigen sectie in het menu met foutmeldingen uit de live-app (nieuw / in behandeling / opgelost), inclusief beschrijving, foto, naam, tijd, app-versie en toestel. Een menubadge toont het aantal nieuwe meldingen.
- **Exporteer** / **Importeer** als back-up, en optioneel **Opschonen** van afgeronde taken ouder dan 90 dagen (na export-prompt en bevestiging)
- Bij de eerste login: optioneel **Importeer lokale gegevens naar Firebase** als dit apparaat nog oude localStorage-data heeft

## Terugkerende taken

Opties: elke dag, om de dag (vanaf de startdatum), op specifieke weekdag(en), of op een specifieke datum (eenmalig of maandelijks).

Bij het openen van de app (medewerker of admin) wordt alleen de instance van **vandaag** aangemaakt, of hoogstens de laatst gemiste keer. Het document-id is `${recurringId}_${YYYY-MM-DD}`, zodat er geen dubbele instances ontstaan als meerdere telefoons tegelijk openstaan.

## Installeren op je telefoon

**Medewerkers-app** — open de Live-link.

**Admin-app** — open de Admin-link (apart te installeren).

**Android (Chrome of Edge):** menu → **Toevoegen aan startscherm** (of **App installeren**).

**iPhone (Safari):** **Deel** → **Zet op beginscherm**.

## Data

Taken, herhalingen en medewerkers staan in **Cloud Firestore** (project `zeiklijst-live`, regio europe-west4). Iedereen in het team ziet dezelfde live lijst. De app bewaart een lokale cache (`persistentLocalCache`) zodat hij bij matige wifiverbinding blijft werken.

Foto's worden verkleind (max. ca. 1000 px, JPEG-kwaliteit 0,6, maximaal 4 stuks) en in het taakdocument opgeslagen. Firebase Storage wordt niet gebruikt (Spark-plan).

Authenticatie:

- Admin logt in met e-mail/wachtwoord en is in de regels vastgezet op UID. Het admin-e-mailadres staat nergens in de code; je typt het zelf. Bij een afwijzing wordt "Beheerder" opgeslagen, niet het e-mailadres. Het alleen-lezen account van ZL Assistent (vaste UID) mag `tasks`, `taskMeta` en `employees` lezen.
- **Eerste pincode en na een reset** gaat alleen met een eenmalige **startcode** van de admin. Medewerkers zoeken hun naam niet meer op: de code zelf bepaalt wie ze zijn.
  - `startCodes/{CODE}` (doc-id = code, 10 tekens uit A-Z en 2-9 zonder 0, O, 1, I en L) = `{employeeId, name, pinVersion, createdAt, expiresAt (createdAt + 7 dagen), used:false}`. Alleen admin maakt, verwijdert en leest de lijst. Een ingelogde gebruiker mag één code `get`ten zolang die ongebruikt en niet verlopen is.
  - Code maken is één admin-batch: `employees.pinVersion + 1`, het resetverzoek en oudere codes van die medewerker worden verwijderd en de nieuwe code wordt aangemaakt.
  - De medewerker maakt een Firebase-account met e-mail `emp-{employeeId}-v{pinVersion}-{code in kleine letters}@zeiklijst.app` (helper `startCodeEmail` in `shared.js`) en wachtwoord `zl-{pin}-{employeeId}` (`staffPassword`).
  - Claim = één batch van twee writes: `staffAccounts/{uid} = {employeeId, pinVersion, startCode}` en `startCodes/{code}` krijgt `{used:true, usedBy: uid, usedAt: serverTimestamp()}`. De regels eisen dat de code bestaat, ongebruikt en niet verlopen is, bij deze medewerker en `pinVersion` hoort, dat de medewerker actief is en dat het auth-e-mailadres klopt.
- **Inloggen**: het toestel bewaart lokaal `{employeeId, pinVersion, loginKey, name}`; daarna is inloggen alleen de pincode. Nergens openbaar staat een `loginKey`.
- **nameIndex** is alleen nog voor admin (regels) en wordt door geen enkele app gebruikt.
- **Inactieve medewerkers** (`active:false`) worden door de regels geweigerd, ook met een bestaand account. Alleen hun eigen `employees/{id}` mogen ze nog `get`ten (met geldig staffAccount), zodat de app "Je account is niet actief" kan tonen. Medewerkers mogen de lijst `employees` niet lezen.
- **Oude accounts** (zonder geldige `startCode`/`pinVersion` in `staffAccounts`) worden voor alles geweigerd. In de admin-app staat zo'n medewerker als **Nieuwe startcode nodig**.
- **Pincode vergeten** maakt `pinResetRequests/{willekeurig id}` = `{name (1-60 tekens), requestedAt (servertijd), note (optioneel, max 200)}`. Alleen aanmaken; lezen en wissen alleen admin. Geen toegang. **Wachttijd in de regels:** het verzoek gaat in één batch samen met `pinResetLimits/{uid}` = `{lastAt, requestId}` (max. 1 per 10 minuten per gebruiker) en `pinResetLimits/_global` = `{lastAt, requestId, day, count}` (max. 1 per 60 seconden en 20 per dag voor iedereen samen). Een spammer kan zo de knop tijdelijk blokkeren, maar niet het schrijfquotum opmaken; App Check is later de echte rem.
- **Streefdatum** staat in `taskMeta/{taskId}` = `{dueDate}` (alleen admin schrijft, admin en ZL Assistent lezen). De admin-app verplaatst oude `tasks.dueDate`-velden automatisch.
- **Limieten in de regels**: titel 120, locatie 120, omschrijving 2000, foto max. 250.000 tekens (1 foto bij taken van medewerkers), meldingen idem. Afvinken (`pending`) gaat sinds build v2 in één batch met `taskCompletions/{taskId}` (eigen `employeeId`, naam, servertijd); er komt geen naam of tijd meer op de taak. Terugzetten mag alleen wie afvinkte (eigen completion-doc, of bij een oude taak zonder doc `pendingByEmployeeId` = jij). Medewerkers mogen alleen eigen of gedeelde taken (`ALLEN` of leeg) afvinken. Herhaalde taken: `occurrenceDate` binnen vandaag ±1 dag (oudere maakt de admin-app aan).
- **Daglimiet (regels)**: een eigen taak of melding van een medewerker gaat in één batch samen met `staffDailyCounters/{employeeId}` = `{day, tasks, reports, lastAt, lastType, lastId}`. Max. **10 eigen taken** en **5 meldingen** per dag per medewerker, minimaal **15 seconden** tussen twee verzendingen. `day` = `floor((ms + 3.600.000) / 86.400.000)`: kalenderdag in UTC+1 (Amsterdamse wintertijd; in de zomer wisselt de dag om 01:00). De admin is uitgezonderd en kan tellers wissen. Contract: `/workspace/outputs/zla-step4-status.md`.
- **Medewerkerpagina (admin v25, sinds v26 via *Overzicht Medewerkers*)**: tik in *Overzicht Medewerkers* op een medewerker (het menu-item *Per medewerker* is weg; terugknop gaat naar het overzicht). Daar staan inlogstatus, open startcode, **Startcode maken** / **Pincode resetten** (zelfde batch als bij Medewerkers: `pinVersion + 1`, oude codes en het bijbehorende resetverzoek weg, nieuwe code), de resetverzoeken waarvan de naam bij deze medewerker past, taken (open/pending, link naar Taken) en het dagverbruik (eigen taken/meldingen). Plus **extra gegevens** in `employeeDetails/{employeeId}` (alleen admin; niet in `employees`, want medewerkers lezen hun eigen doc en de reader leest alle employees): `role` (functie, 1–40 tekens), `department` (afdeling, 1–40 tekens; staat alleen hier, niet in `employees`), `workdays` (lijst van unieke dagnummers 0–6, 0 = zondag), `note` (admin-notitie, max. 500) en verplicht `updatedAt` (servertijd). Lege velden worden weggelaten; andere velden weigeren de regels. Geen gevoelige persoonsgegevens (geen telefoon, e-mail, adres, geboortedatum, BSN, gezondheid of salaris). Verwijderen van een medewerker wist ook diens extra gegevens; de export bevat ze, de import niet.
- **Admin-app (v23)**: Content-Security-Policy als meta-tag en de Firebase SDK uit `vendor/firebase/12.6.0` via een import map met integrity-hashes (geen gstatic meer). Wijzig je de import map in `admin/index.html`, werk dan ook de `sha256` in `script-src` bij.
- **Foto's** moeten `data:image/(jpeg|png|webp);base64,...` zijn (gecontroleerd in de regels en bij het tonen). De admin-app bouwt alle gebruikersinhoud op met `textContent`/`img.src`, nooit met `innerHTML`.
- Beveiligingsregels staan in `firestore.rules`. Een commit verandert de live regels niet: publiceer ze in de Firebase-console.
- **Tests van de regels** staan in `tests/` (Firestore-emulator, Java 21 nodig): `cd tests && npm install && npm test` (de tests lezen `../firestore.rules` zelf; `tests/firebase.json` bevat alleen de emulator-instellingen). Zie `tests/README.md`.

## Build v2 (admin v26)

- **Locaties** staan in `settings/locations` = `{items:[{id,label,order,active,staffSelectable}], labels:{id:label} (alleen actief én staffSelectable), updatedAt}`. "Overig" (`overig`) is alleen voor admin en audit (`staffSelectable:false`); vinkje *Medewerkers kunnen kiezen* per locatie. Beheer onder *Locaties & vragen*: volgorde, naam, (de)activeren, nooit verwijderen. De standaardlijst (16, met Overig als laatste) maak je met één knop. Oude taken met alleen tekst koppel je daar per schrijfwijze ("Pad 16" en "pad 16 " vallen samen) aan een locatie; de oude tekst blijft staan.
- **Taakvelden**: `locationId`, `urgent` (alleen admin, *Spoed*), `source` (`{type:"audit", auditId, auditDate, locationId, questionId, reasonId?}`). Een medewerker maakt een taak met precies 13 velden (met `locationId`, zonder `urgent`/`source`).
- **Afgevinkt door** staat niet meer op de taak maar in `taskCompletions/{taskId}` = `{employeeId, name, at}` (alleen admin leest alles; een medewerker alleen zijn eigen doc via `where("employeeId","==",ik)`; de reader niets). Afvinken en terugzetten gaan in één batch met de taak. *Data → Afvinkers verplaatsen* zet oude `pendingBy*`-velden eenmalig om (eerst automatisch een volledige back-up); *Noodknop* zet ze terug.
- **Audit lopen**: mobiel, grote Ja/Nee-knoppen, notitie per vraag, elk onderdeel verplicht, vervolgvraag (lege vakken → voorraad?), redenen (massaplein, meerdere tegelijk), controlescherm vóór het aanmaken van taken, concept wordt automatisch bewaard en is te hervatten (ook op een ander apparaat), maximaal één lopende audit. Taken krijgen id `audit-{auditId}-{locatie}-{vraag}[-{reden}]` en een `source`.
- **Vragenlijst/ronde** in `auditConfig/current` (alleen admin), te wijzigen onder *Locaties & vragen*. Instellingen (lege vakken zonder voorraad telt als goed, meerdere redenen, batchgrootte) staan in `admin/audit-defaults.js`.
- **Audits** (`audits/{id}`) met score per onderdeel, trendtabel en *PDF / afdrukken* (printweergave van de browser). De reader mag audits en meldingen lezen.
- **Herhalende taken** nemen `locationId` en `urgent` over naar elke dagtaak.
- **Volledige back-up (ruw)** onder *Data*: alle collecties zoals ze in de database staan (incl. `taskMeta`, meldingen, completions, locaties, vragenlijst, audits; zonder startcodes). Terugzetten gaat (nog) niet automatisch.
- **Navigatie**: hiërarchische terugknop op elke pagina (en de terugknop van telefoon/browser doet hetzelfde); logo → dashboard; op brede schermen (≥ 900 px) staan de menuknoppen onder de dashboardtegels en is het menu bovenaan verborgen. Op de Taken-pagina zijn *Zoeken*, *Terugkerende taken* en *Takenlijst* inklapbaar (bewaard in `localStorage`).
- **Streefdatum-tegel**: open + pending taken met een streefdatum vóór vandaag (verstreken) of vandaag t/m over 2 dagen (binnenkort), datum in Europe/Amsterdam (`DUE_SOON_DAYS` in `admin/admin.js`).
- **Regeltests**: `cd tests && npm test` (poort 8085) of `npm run test:alt` (poort 8086).

## Technisch

- Statische HTML, CSS en JavaScript, twee PWA's, live via GitHub Pages (repository blijft `afdeling-takenlijst`)
- Achtergrond lichtgrijs `#A7ABAE`, accent oranje `#FF7A00`, antraciet `#2B2B2B`
- Titellettertype **Rubik Dirt** (OFL, zelf gehost), met zwarte outline en harde slagschaduw
- Iconen: oranje ZL op antraciet (Live) en antraciet ZL op oranje met label ADMIN (Admin)
