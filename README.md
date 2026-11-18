# Zeiklijst Live

Zeiklijst Live is een mobiele takenlijst voor intern gebruik op de afdeling. Werkt in de browser en is te installeren als app op je telefoon. Admin ziet extra functies; voor gewone gebruikers is de weergave op telefoon en in de browser hetzelfde.

Live versie: https://jordi-cyx.github.io/afdeling-takenlijst/

## Voor iedereen

- Openstaande taken zien: titel, toegewezen aan en status
- Tik of klik op een taak voor de beschrijving en eventuele foto's
- Markeer een taak als **gedaan**. De status wordt dan **Pending** (wacht op goedkeuring van admin)
- Herhalende taken herken je aan het badge **Herhalend**

## Voor admin

Na inloggen via **Admin login**:

- **Dashboard** bovenaan met het aantal openstaande, pending en afgeronde taken
- Taken **toevoegen** en **toewijzen** (het formulier staat in het dashboard)
- Een bestaande taak **opnieuw toewijzen** in het taakdetail
- Taken **verwijderen**
- Pending taken **goedkeuren**. Goedgekeurde taken verdwijnen uit de open lijst, maar blijven bewaard als **Afgerond** (met afrondingsdatum) en tellen mee in het dashboard
- Een uitklapbare sectie **Afgerond** (alleen zichtbaar voor admin)
- **Terugkerende taken** aanmaken, bekijken, bewerken, pauzeren en verwijderen
- **Exporteer** / **Importeer** om data te delen of te back-uppen

## Terugkerende taken

Admin kan een taak als herhalend instellen met één van deze opties:

- **Elke dag**
- **Om de dag** (gerekend vanaf de startdatum)
- **Op specifieke weekdag(en)** (bijvoorbeeld elke maandag en donderdag)
- **Op een specifieke datum** (eenmalig op die datum, of optioneel maandelijks op die dag van de maand)

De herhalingen zelf worden apart opgeslagen. Bij het openen van de app (en als de datum wijzigt terwijl de app openstaat) wordt alleen de instance van **vandaag** aangemaakt, of hoogstens de laatst gemiste keer. Oudere gemiste dagen vullen de lijst niet.

Elke aangemaakte instance gedraagt zich als een gewone taak (open → pending → afgerond). Bestaande instances blijven staan als je een herhaling bewerkt of verwijdert.

## Installeren op je telefoon

De app is een PWA en werkt ook offline (eerdere taken blijven zichtbaar).

**Android (Chrome of Edge)**

1. Open de live link in de browser
2. Kies in het menu **Toevoegen aan startscherm** (of **App installeren**)
3. Bevestig. De app verschijnt op je beginscherm

**iPhone (Safari)**

1. Open de live link in Safari
2. Tik op **Deel**
3. Kies **Zet op beginscherm**
4. Bevestig met **Zet erop**

## Data

De app gebruikt **localStorage**. Data blijft **per browser** (en per apparaat) bewaard. Teamleden zien elkaars lijst dus niet automatisch.

Voor teamgebruik:

- Gebruik **Exporteer** / **Importeer** om taken én terugkerende sjablonen te delen
- Oude exportbestanden (alleen een lijst taken) kunnen nog worden geïmporteerd
- Later kan Firebase worden toegevoegd voor echte live synchronisatie

Foto's worden als base64 in de browser opgeslagen. Grote foto's kunnen de localStorage-limiet raken.

## Technisch

- Statische HTML, CSS en JavaScript, live via GitHub Pages (repository blijft `afdeling-takenlijst`)
- De titel in de header gebruikt het lettertype **Black Ops One**
- Kleuren: oranje accent (`#FF7A00`) en donkergrijs (`#2B2B2B` / `#3A3A3A`)
- Het admin-wachtwoord staat niet in deze README of als platte tekst in de code, alleen als PBKDF2-hash (`ADMIN_SALT` en `ADMIN_HASH` in `app.js`)
