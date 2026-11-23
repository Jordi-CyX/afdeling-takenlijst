// Unit-tests voor admin/v3a-logic.js (V3A deel 1). Draai: node tests/v3a-logic.test.mjs (geen emulator nodig).
import * as L from "../admin/v3a-logic.js";
const results = [];
const t = (name, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  results.push([g === w ? "PASS" : "FAIL", name, g === w ? "" : `${g} != ${w}`]);
};

// Sorteren (punt 4)
const order = { "pad-14": 5, "pad-16": 7, bkc: 1 };
const cmp = L.makePathComparator((id) => order[id] ?? null);
const list = [
  { id: "geen-loc", createdAt: "2026-11-23T08:00:00Z" },
  { id: "p16-normaal-later", locationId: "pad-16", dueDate: "2026-11-30" },
  { id: "p16-normaal-leeg", locationId: "pad-16" },
  { id: "p16-normaal-eerder", locationId: "pad-16", dueDate: "2026-11-24" },
  { id: "p16-spoed", locationId: "pad-16", urgent: true },
  { id: "bkc", locationId: "bkc" },
  { id: "p14", locationId: "pad-14", dueDate: "2026-12-01" },
  { id: "onbekende-loc", locationId: "weg" }
];
t("sorteren: padvolgorde, dan spoed, dan streefdatum (leeg achteraan), zonder locatie achteraan",
  [...list].sort(cmp).map((x) => x.id).slice(0, 6),
  ["bkc", "p14", "p16-spoed", "p16-normaal-eerder", "p16-normaal-later", "p16-normaal-leeg"]);
t("sorteren: zonder/onbekende locatie als laatste", [...list].sort(cmp).slice(6).map((x) => x.id).sort(), ["geen-loc", "onbekende-loc"]);
t("sorteren: gelijke taken -> nieuwste eerst", [{ id: "a", createdAt: "2026-11-01" }, { id: "b", createdAt: "2026-11-02" }].sort(cmp).map((x) => x.id), ["b", "a"]);

// B1 filters
t("standaardfilters: 0 actief", L.activeFilterCount(L.defaultTaskFilters()), 0);
t("doorklik zet alleen het doelfilter", L.activeFilterCount({ ...L.defaultTaskFilters(), audit: "any" }), 1);
t("oude filters + zoekterm tellen", L.activeFilterCount({ q: "lamp", employee: "emp-1", status: "open" }), 3);
t("lege zoekterm met spaties telt niet", L.activeFilterCount({ q: "  " }), 0);

// Claim + naam (B19)
t("claim: geldig", L.normalizeClaim({ claimedBy: { employeeId: "e1", name: "Anna" }, claimedAt: "2026-11-23T07:00:00Z" }), { employeeId: "e1", name: "Anna", at: "2026-11-23T07:00:00Z" });
t("claim: Timestamp", L.normalizeClaim({ claimedBy: { employeeId: "e1", name: "A" }, claimedAt: { toDate: () => new Date("2026-11-23T07:00:00Z") } }).at, "2026-11-23T07:00:00.000Z");
t("claim: leeg/null/kapot = null", [L.normalizeClaim({}), L.normalizeClaim({ claimedBy: null }), L.normalizeClaim({ claimedBy: "Anna" })], [null, null, null]);
t("naam: huidige naam wint (hernoemd)", L.displayName("e1", "Anna", [{ id: "e1", name: "Annabel" }]), "Annabel");
t("naam: verwijderde medewerker -> opgeslagen naam", L.displayName("e9", "Bram", [{ id: "e1", name: "Annabel" }]), "Bram");

// Onderhoud
t("onderhoudstekst: max 300 en getrimd", L.cleanMaintenanceMessage("  " + "x".repeat(400)).length, 300);

for (const x of results) console.log(x.join(" | "));
const pass = results.filter((x) => x[0] === "PASS").length;
console.log(`${pass}/${results.length} PASS`);
process.exit(pass === results.length ? 0 : 1);
