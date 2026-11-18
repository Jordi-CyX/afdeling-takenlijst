# Takenlijst Afdeling

Eenvoudige live takenlijst voor retail afdeling.

## Functionaliteit

- **Admin** (wachtwoord): taken toevoegen, toewijzen, foto's uploaden, goedkeuren
- **Gebruikers**: taken bekijken en markeren als "gedaan"
- Bij markeren als gedaan → status wordt **Completion pending**
- Alleen admin kan de taak goedkeuren → daarna verdwijnt hij uit de lijst
- Lijst toont titels + toegewezen aan
- Klikken opent volledige beschrijving + foto's

## Gebruik

1. Open `index.html` in de browser
2. Klik op "Admin login" (standaard wachtwoord: `admin123`)
3. Voeg taken toe
4. Deel de link (GitHub Pages) met je team

### Data

De app gebruikt **localStorage**. Data blijft per browser.

Voor teamgebruik:
- Gebruik **Exporteer** / **Importeer** om data te delen
- Of voeg later Firebase toe voor echte live synchronisatie (gratis)

## Aanpassen

In `app.js`:
- `ADMIN_PASSWORD` → verander het wachtwoord

## Op GitHub Pages

1. Upload de bestanden naar een repository
2. Zet GitHub Pages aan (Settings → Pages)
3. Deel de link

## Foto's

Foto's worden als base64 opgeslagen in de browser. Grote foto's kunnen de localStorage limiet raken. Voor productiegebruik is Firebase Storage aanbevolen.