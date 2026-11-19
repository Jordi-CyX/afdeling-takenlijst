# Regeltests (Firestore-emulator)

Deze tests controleren `../firestore.rules` tegen een lokale Firestore-emulator. Ze gebruiken het
demo-project `demo-zeiklijst`: er wordt **niets** naar het echte project `zeiklijst-live` gestuurd en
er zijn geen wachtwoorden, sleutels of echte gegevens nodig.

## Draaien

Vereist: Node.js 20+ en Java 17+ (voor de emulator).

```bash
cd tests
npm install
npm test
```

`npm test` start de emulator, draait `rules.test.mjs` en stopt de emulator weer. Elke test begint met
een lege database en eigen testgegevens. De uitvoer eindigt met `N/N PASS`; bij een fout is de exitcode 1.

Let op: tests draaien verandert de live regels niet. Publiceren gebeurt alleen in de Firebase-console.

## Tweede poort (tegelijk testen)

`npm test` gebruikt poort **8085**. Wil een tweede agent tegelijk testen, gebruik dan
`npm run test:alt`: die draait dezelfde tests op poort **8086** (`firebase.alt.json`). De testcode leest de
poort uit `FIRESTORE_EMULATOR_HOST` (gezet door `emulators:exec`) en print `Emulator-poort: …` aan het eind.
