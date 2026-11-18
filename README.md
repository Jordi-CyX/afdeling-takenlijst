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

Open de Admin-app en log in met e-mail en wachtwoord (standaard e-mail: `j.g_vdbos@outlook.com`). De app gebruikt de HORNBACH-kleuren (`#3A3C3E`, accent `#F99D27`) en het lettertype **Rubik Distressed** (OFL) voor de kop in de menubanner.

- **Dashboard**: aanklikbare totalen voor open (naar Taken, gefilterd) en pending (naar Controle), de *actuele* open/pending-verdeling per medewerker (inclusief Allen en Niet toegewezen), en een korte lijst van de laatste pending taken. Afgerond blijft als kleiner cijfer staan.
- Taken **toevoegen** en **bewerken** (titel verplicht; locatie, beschrijving en foto's optioneel, max. 4 gecomprimeerde foto's). Het formulier "Nieuwe taak" staat standaard ingeklapt. Zoeken en filteren kan op status, medewerker, locatie en herhalend.
- Een bestaande taak **opnieuw toewijzen**
- Taken **verwijderen**
- Een afgeronde taak **terugzetten naar open**
- Pending taken **goedkeuren** of **afwijzen**, altijd met een bevestigingsdialoog. Bij afwijzen kan een korte reden (sterk aangeraden). Die geschiedenis is zichtbaar in de taakmodal.
- **Workflow**: per persoon de huidige open/pending-last, plus afgerond en afgekeurd in de gekozen periode, en optioneel wie taken heeft afgevinkt (`pendingBy`)
- **Terugkerende taken** aanmaken, bewerken, pauzeren en verwijderen
- **Medewerkers** beheren (toevoegen, hernoemen, deactiveren). Bij hernoemen wordt `assigneeName` ook bijgewerkt op open/pending taken en herhaal-templates. De standaardlijst: Jane, Aart, Edwin, Daan, Reda, Akif, Finn, Tim, Guido, Renato, Alex. Toewijzen via een keuzelijst, plus **Allen** en niet-toegewezen
- **Pincode**: meldingen als een medewerker de pincode is vergeten (badge in het menu, lijst op Dashboard en Medewerkers) met de knop **Pincode resetten** en een bevestigingsstap. Per medewerker zie je of er een pincode is ingesteld, en kun je handmatig resetten. Er is ook **Naamindex opbouwen** onder Data; ontbrekende indexregels worden bij het openen van de admin-app automatisch aangevuld.
- Bij een nieuwe versie van de admin-app verschijnt de balk **Nieuwe versie beschikbaar, tik om te vernieuwen**.
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

- Medewerkers worden automatisch anoniem aangemeld
- Admin logt in met e-mail/wachtwoord
- Beveiligingsregels staan in `firestore.rules` (publiceer die in de Firebase-console voordat je deze versie naar `main` zet)

## Technisch

- Statische HTML, CSS en JavaScript, twee PWA's, live via GitHub Pages (repository blijft `afdeling-takenlijst`)
- Achtergrond lichtgrijs `#A7ABAE`, accent oranje `#FF7A00`, antraciet `#2B2B2B`
- Titellettertype **Rubik Dirt** (OFL, zelf gehost), met zwarte outline en harde slagschaduw
- Iconen: oranje ZL op antraciet (Live) en antraciet ZL op oranje met label ADMIN (Admin)
