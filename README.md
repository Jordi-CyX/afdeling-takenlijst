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

Open de Admin-app en log in met e-mail en wachtwoord (het e-mailadres staat standaard ingevuld vanuit `admin/admin-config.js`). De app gebruikt de HORNBACH-kleuren (`#3A3C3E`, accent `#F99D27`) en het lettertype **Rubik Distressed** (OFL) voor de kop in de menubanner.

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
- **Startcodes en pincode**: per medewerker de knop **Startcode maken** (of **Pincode resetten (startcode)** als er al een pincode is). Je krijgt een eenmalige code van 10 tekens (getoond als `XXXXX-XXXXX`, 7 dagen geldig) met een kopieerknop en de vervaldatum. Geef die persoonlijk aan de medewerker. Bij elke medewerker zie je of er een open startcode is (met vervaldatum), je kunt de code opnieuw tonen of verwijderen. Inactieve medewerkers kunnen geen startcode krijgen. Medewerkers met een oude pincode (zonder startcode) staan gemarkeerd als **Nieuwe startcode nodig**. Met **Startcodes maken voor alle actieve medewerkers** maak je in één keer voor iedereen een nieuwe code; na bevestiging zie je een lijst met naam, code en kopieerknoppen. Een verzoek "Pincode vergeten" (badge in het menu, lijst op Dashboard en Medewerkers) geeft zelf geen toegang: je maakt er een startcode bij of wist het verzoek. Er is ook **Naamindex opbouwen** onder Data.
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

- Admin logt in met e-mail/wachtwoord en is in de regels vastgezet op UID. Het admin-e-mailadres staat alleen in `admin/admin-config.js` (niet in `firebase-init.js`, dat ook de medewerkers-app laadt). Bij een afwijzing wordt "Beheerder" opgeslagen, niet het e-mailadres. Het alleen-lezen account van ZL Assistent (vaste UID) mag alleen `tasks` en `employees` lezen.
- Medewerkers worden eerst anoniem aangemeld (voor het opzoeken van hun naam in `nameIndex`).
- **Eerste pincode en na een reset** gaat alleen met een eenmalige **startcode** van de admin:
  - `startCodes/{CODE}` (doc-id = code, 10 tekens uit A-Z en 2-9 zonder 0, O, 1, I en L) = `{employeeId, pinVersion, createdAt, expiresAt (createdAt + 7 dagen), used:false}`. Admin maakt en verwijdert; iedere ingelogde gebruiker mag één code `get`ten, alleen admin mag de lijst lezen.
  - Code maken is één batch: `employees.pinVersion + 1`, `nameIndex` krijgt `hasPin:false` en de nieuwe `pinVersion` (en `loginKey` wordt gewist), het resetverzoek en oudere codes van die medewerker worden verwijderd, en de nieuwe code wordt aangemaakt.
  - De medewerker maakt een Firebase-account met e-mail `emp-{employeeId}-v{pinVersion}-{code in kleine letters}@zeiklijst.app` (helper `startCodeEmail` in `shared.js`) en wachtwoord `zl-{pin}-{employeeId}` (`staffPassword`).
  - Claim = één batch van drie writes: `staffAccounts/{uid} = {employeeId, pinVersion, startCode}`, `startCodes/{code}` krijgt `{used:true, usedBy: uid, usedAt: serverTimestamp()}`, en `nameIndex/{naam}` krijgt `{hasPin:true, loginKey: code in kleine letters}`. De regels eisen dat de code bestaat, ongebruikt en niet verlopen is, bij deze medewerker en `pinVersion` hoort, dat de medewerker actief is en dat het auth-e-mailadres klopt.
- **Inloggen**: naam → `nameIndex` (`employeeId`, `hasPin`, `pinVersion`, `loginKey`) → e-mail opbouwen → inloggen met pincode.
- **Inactieve medewerkers** (`active:false`) worden door de regels geweigerd, ook met een bestaand account. Alleen hun eigen `employees/{id}` mogen ze nog `get`ten (met geldig staffAccount: startCode en pinVersion kloppen), zodat de app "Je account is niet actief" kan tonen.
- **Oude accounts** (aangemaakt vóór de startcodes, dus zonder `startCode` in `staffAccounts`) worden door de regels voor alles geweigerd. Zo'n medewerker staat in de admin-app als **Nieuwe startcode nodig**. De oude login zonder `loginKey` (`staffEmail`) werkt niet meer.
- **Pincode vergeten** maakt alleen een verzoek in `pinResetRequests`; dat geeft geen toegang.
- **Foto's** moeten `data:image/(jpeg|png|webp);base64,...` zijn (gecontroleerd in de regels en bij het tonen). De admin-app bouwt alle gebruikersinhoud op met `textContent`/`img.src`, nooit met `innerHTML`.
- Beveiligingsregels staan in `firestore.rules`. Een commit verandert de live regels niet: publiceer ze in de Firebase-console.

## Technisch

- Statische HTML, CSS en JavaScript, twee PWA's, live via GitHub Pages (repository blijft `afdeling-takenlijst`)
- Achtergrond lichtgrijs `#A7ABAE`, accent oranje `#FF7A00`, antraciet `#2B2B2B`
- Titellettertype **Rubik Dirt** (OFL, zelf gehost), met zwarte outline en harde slagschaduw
- Iconen: oranje ZL op antraciet (Live) en antraciet ZL op oranje met label ADMIN (Admin)
