// Unit-tests voor admin/v3b-logic.js (V3B). Draai: node tests/v3b-logic.test.mjs
import * as L from "../admin/v3b-logic.js";
import { DEFAULT_LOCATIONS } from "../admin/audit-defaults.js";
const results = [];
const t = (name, got, want) => { const g = JSON.stringify(got); const w = JSON.stringify(want); results.push([g === w ? "PASS" : "FAIL", name, g === w ? "" : `${g} != ${w}`]); };

t("vlaggen: afdelingen + schakelknop aan, sessies uit", [L.FEATURES.departments, L.FEATURES.adminSwitch, L.FEATURES.sessions], [true, true, false]);
t("normalizeDepartment: hoofdletters/spaties", L.normalizeDepartment(" Sanitair "), "sanitair");
t("normalizeDepartment: onbekend = leeg", L.normalizeDepartment("tuin"), "");
const plan = L.planDepartments(DEFAULT_LOCATIONS);
const by = Object.fromEntries(plan.items.map((i) => [i.id, i.department || ""]));
t("afspraak: sanitair-paden", ["pad-14", "pad-15", "pad-16", "pad-17", "pad-18", "kort-pad-13", "kort-pad-14", "achterwand", "z-karren", "balie-sanitair"].map((id) => by[id]), Array(10).fill("sanitair"));
t("afspraak: tegels-paden", ["pad-19", "pad-20", "pad-21", "balie-tegels"].map((id) => by[id]), Array(4).fill("tegels"));
t("afspraak: beide", [by.bkc, by.overig], ["beide", "beide"]);
t("afspraak: alle standaardlocaties ingedeeld", plan.unknown, []);
t("afspraak: aantal wijzigingen = alle locaties", plan.changes.length, DEFAULT_LOCATIONS.length);
const kept = L.planDepartments([{ id: "bkc", label: "BKC", department: "sanitair" }, { id: "pad-30", label: "Pad 30" }]);
t("plan: bestaande keuze blijft (geen overwrite)", kept.items[0].department, "sanitair");
t("plan: onbekend pad blijft leeg en wordt gemeld", [kept.items[1].department, kept.unknown], [undefined, ["Pad 30"]]);
t("plan: overwrite zet afspraak terug", L.planDepartments([{ id: "bkc", label: "BKC", department: "sanitair" }], { overwrite: true }).items[0].department, "beide");
t("plan: op naam als id anders is", L.planDepartments([{ id: "x1", label: "Pad 20" }]).items[0].department, "tegels");
t("departmentsFromDoc: map gaat voor items", L.departmentsFromDoc({ items: [{ id: "a", department: "tegels" }, { id: "b", department: "sanitair" }], departments: { a: "beide" } }), { a: "beide", b: "sanitair" });
t("departmentsFromDoc: zonder afdelingen leeg", L.departmentsFromDoc({ items: [{ id: "a" }] }), {});
const f = L.locationDepartmentFields([{ id: "a", label: "A", department: "tegels" }, { id: "b", label: "B", department: "" }]);
t("locationDepartmentFields: map + items, leeg veld weg", [f.departments, f.items.map((i) => "department" in i)], [{ a: "tegels" }, [true, false]]);
t("profilePayload: afdeling + admin", L.profilePayload({ department: "Tegels", canAdmin: true }), { department: "tegels", canAdmin: true });
t("profilePayload: admin uit = veld weg", L.profilePayload({ department: "beide", canAdmin: false }), { department: "beide" });
t("profilePayload: niets = doc verwijderen", L.profilePayload({ department: "", canAdmin: false }), null);
t("normalizeProfile: alleen true telt", L.normalizeProfile({ canAdmin: "true", department: "x" }), { department: "", canAdmin: false });
t("profileSummary", L.profileSummary({ department: "sanitair", canAdmin: true }), "Sanitair · Adminknop");

for (const x of results) console.log(x.join(" | "));
const pass = results.filter((x) => x[0] === "PASS").length;
console.log(`${pass}/${results.length} PASS`);
process.exit(pass === results.length ? 0 : 1);
