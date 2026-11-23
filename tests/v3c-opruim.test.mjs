// V3C opruimronde: controleert dat de overbodige onderdelen van het kopje Data weg zijn en dat de ruwe back-up
// pinResetLimits, staffProfiles en questionBank meeneemt. Statische controle, geen Firebase. Draai: node tests/v3c-opruim.test.mjs
import { readFileSync } from "node:fs";
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const html = read("admin/index.html"), admin = read("admin/admin.js"), v2 = read("admin/v2.js");
const results = [];
const t = (name, ok) => results.push([ok ? "PASS" : "FAIL", name]);
t("banner 'Lokale gegevens importeren' weg (HTML + code)", !/migration-banner|migrate-btn|migrate-dismiss/.test(html) && !/migrateLocalToFirebase|offerMigrationIfNeeded|loadLocalLegacy|STORAGE_MIGRATED/.test(admin));
t("'Afvinkers verplaatsen (eenmalig)' weg", !/Afvinkers verplaatsen|data-migrate-pending/.test(v2) && !/migratePendingBy|legacyPendingTasks/.test(v2 + admin));
t("'Noodknop: terugzetten' weg", !/Noodknop|data-restore-pending|restorePendingBy|restorableCompletions/.test(v2 + admin + html));
t("'Export / import (oud formaat)' weg", !/oud formaat|export-btn|import-btn|import-file/.test(html) && !/function exportData|function importData|function writeAll/.test(admin));
t("'Oude naamindex' weg (knop + functie; data blijft)", !/purge-name-index|Naamindex verwijderen/.test(html) && !/purgeNameIndex|collection\(db, "nameIndex"\)/.test(admin));
t("ruwe back-up en Excel-export blijven", /data-raw-backup/.test(v2) && /data-excel-export/.test(v2) && /export async function exportRawBackup/.test(v2));
t("Opschonen en onderhoudskaart blijven", /cleanup-btn/.test(html) && /maintenance-card/.test(html));
const cols = (v2.match(/BACKUP_COLLECTIONS = \[([\s\S]*?)\];/) || ["", ""])[1];
t("ruwe back-up bevat pinResetLimits, staffProfiles en questionBank", ["pinResetLimits", "staffProfiles", "questionBank"].every((c) => cols.includes(`"${c}"`)));
t("ruwe back-up leest geen startCodes of nameIndex", !/"startCodes"|"nameIndex"/.test(cols));
for (const r of results) console.log(r.join(" | "));
const pass = results.filter((r) => r[0] === "PASS").length;
console.log(`${pass}/${results.length} PASS`);
process.exit(pass === results.length ? 0 : 1);
