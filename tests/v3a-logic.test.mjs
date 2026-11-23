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

// Punt 7: varianten
t("variantIdOf zonder id = standaard", L.variantIdOf({}), "standaard");
t("variantIdOf met id", L.variantIdOf({ variantId: "netheid" }), "netheid");
t("mergeVariants: legacy wordt virtuele standaard", L.mergeVariants([], { version: 3, sections: [{ locationId: "a" }] }).map((v) => [v.id, v.virtual, v.version, v.compare]), [["standaard", true, 3, true]]);
t("mergeVariants: echte standaard wint van legacy", L.mergeVariants([{ id: "standaard", name: "Standaard", order: 1, virtual: false }], { version: 3, sections: [] }).map((v) => [v.id, v.virtual]), [["standaard", false]]);
t("mergeVariants: sorteren op order", L.mergeVariants([{ id: "b", name: "B", order: 2 }, { id: "a", name: "A", order: 1 }], null).map((v) => v.id), ["a", "b"]);
const hist = [
  { id: "h4", variantId: "netheid", auditDate: "2026-11-20" },
  { id: "h3", auditDate: "2026-11-15" },
  { id: "h2", variantId: "standaard", auditDate: "2026-11-10" },
  { id: "h1", auditDate: "2026-11-01" }
];
t("previousSameVariant: zelfde variant, eerder, max 2", L.previousSameVariant(hist, { id: "cur", auditDate: "2026-11-23" }).map((a) => a.id), ["h3", "h2"]);
t("previousSameVariant: andere variant niet", L.previousSameVariant(hist, { id: "cur", variantId: "netheid", auditDate: "2026-11-23" }).map((a) => a.id), ["h4"]);
t("previousSameVariant: oudere audit vergelijkt niet met nieuwere", L.previousSameVariant(hist, { id: "h2", variantId: "standaard", auditDate: "2026-11-10" }).map((a) => a.id), ["h1"]);
t("structureel dalend: 90 > 80 > 70", L.isStructuralDecline([90, 80, 70]), true);
t("niet dalend bij gelijk", L.isStructuralDecline([90, 80, 80]), false);
t("niet dalend bij ontbrekend", L.isStructuralDecline([null, 80, 70]), false);
const sc = (s) => s.sc;
const cr = L.compareRows({ sections: [{ locationId: "a", label: "A", sc: { good: 7, total: 10 } }, { locationId: "b", label: "B", sc: { good: 5, total: 5 } }] },
  [{ sections: [{ locationId: "a", sc: { good: 8, total: 10 } }] }, { sections: [{ locationId: "a", sc: { good: 9, total: 10 } }, { locationId: "b", sc: { good: 4, total: 5 } }] }], sc);
t("compareRows: percentages oudste→nieuwste", cr.rows.map((r) => r.pcts), [[90, 80, 70], [80, null, 100]]);
t("compareRows: dalend gemarkeerd", cr.rows.map((r) => r.declining), [true, false]);
t("compareRows: totaal", cr.total.pcts, [87, 80, 80]);
t("compareRows: één vorige → null aangevuld", L.compareRows({ sections: [{ locationId: "a", sc: { good: 1, total: 2 } }] }, [{ sections: [{ locationId: "a", sc: { good: 2, total: 2 } }] }], sc).rows[0].pcts, [null, 100, 50]);
const emps = [{ id: "e1", name: "Anna" }];
t("cleanCustomTask: persoon en spoed", (({ id, ...r }) => r)(L.cleanCustomTask({ text: " Lamp ", assigneeId: "e1", urgent: 1, dueDate: "2026-11-30" }, emps).task), { text: "Lamp", assigneeId: "e1", assigneeName: "Anna", urgent: true, dueDate: "2026-11-30" });
t("cleanCustomTask: onbekende persoon → Allen", L.cleanCustomTask({ text: "x", assigneeId: "zz" }, emps).task.assigneeId, "ALLEN");
t("cleanCustomTask: lege tekst faalt", L.cleanCustomTask({ text: " " }, emps).error, "Vul de omschrijving in.");
t("cleanCustomTask: foute datum faalt", L.cleanCustomTask({ text: "x", dueDate: "30-11" }, emps).error, "Ongeldige streefdatum.");
t("customTaskTitle: label + eerste regel, max 120", L.customTaskTitle("Pad 16", "Lamp\nmeer") + "|" + L.customTaskTitle("P", "x".repeat(200)).length, "Pad 16 - Lamp|120");

for (const x of results) console.log(x.join(" | "));
const pass = results.filter((x) => x[0] === "PASS").length;
console.log(`${pass}/${results.length} PASS`);
process.exit(pass === results.length ? 0 : 1);
