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

Open de Admin-app en log in met e-mail en wachtwoord (standaard e-mail: `j.g_vdbos@outlook.com`).

- **Dashboard** met aantallen openstaand, pending en afgerond, plus een verdeling per medewerker
- Taken **toevoegen** en **toewijzen** (titel en beschrijving verplicht; medewerker en foto's optioneel)
- Een bestaande taak **opnieuw toewijzen**
- Taken **verwijderen**
- Pending taken **goedkeuren** (status **Afgerond**, met keuringsdatum) of **afwijzen** (terug naar Open)
- **Terugkerende taken** aanmaken, bewerken, pauzeren en verwijderen
- **Medewerkers** beheren (toevoegen, hernoemen, deactiveren). De standaardlijst: Jane, Aart, Edwin, Daan, Reda, Akif, Finn, Tim, Guido, Renato, Alex. Toewijzen via een keuzelijst, plus **Allen** en niet-toegewezen
- **Exporteer** / **Importeer** als back-up
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
