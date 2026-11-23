// V3B (admin v29): pure logica voor afdelingen en de adminknop. Geen Firebase, geen DOM (unit-tests).
// Vlaggen: afdelingen en de schakelknop ZL <-> ZLA staan aan; sessies blijven uit.
export const FEATURES = Object.freeze({ departments: true, adminSwitch: true, sessions: false });

export const DEPARTMENTS = ["sanitair", "tegels", "beide"];
export const DEPARTMENT_LABELS = { sanitair: "Sanitair", tegels: "Tegels", beide: "Beide" };

export function normalizeDepartment(value) {
  const v = String(value || "").trim().toLowerCase();
  return DEPARTMENTS.includes(v) ? v : "";
}

// Afspraak uit de v3b-brief (23-11). Op id; onbekende paden blijven leeg (= iedereen ziet ze).
export const DEFAULT_LOCATION_DEPARTMENTS = Object.freeze({
  "pad-14": "sanitair", "pad-15": "sanitair", "pad-16": "sanitair", "pad-17": "sanitair", "pad-18": "sanitair",
  "kort-pad-13": "sanitair", "kort-pad-14": "sanitair", achterwand: "sanitair", "z-karren": "sanitair", "balie-sanitair": "sanitair",
  "pad-19": "tegels", "pad-20": "tegels", "pad-21": "tegels", "balie-tegels": "tegels",
  bkc: "beide", overig: "beide"
});

const labelKey = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// Voorstel voor één locatie: eerst op id, anders op de naam (een hernoemd of later toegevoegd "Pad 15").
export function suggestDepartment(item) {
  if (!item) return "";
  return DEFAULT_LOCATION_DEPARTMENTS[item.id] || DEFAULT_LOCATION_DEPARTMENTS[labelKey(item.label)] || "";
}

// Afdeling per locatie uit het doc: de map gaat voor, anders items[].department (zelfde volgorde als ZL).
export function departmentsFromDoc(data) {
  const out = {};
  const items = Array.isArray(data && data.items) ? data.items : [];
  for (const it of items) if (it && typeof it.id === "string" && normalizeDepartment(it.department)) out[it.id] = normalizeDepartment(it.department);
  const map = data && data.departments && typeof data.departments === "object" && !Array.isArray(data.departments) ? data.departments : {};
  for (const [id, v] of Object.entries(map)) if (normalizeDepartment(v)) out[id] = normalizeDepartment(v);
  return out;
}

// Plan voor "Afdelingen volgens afspraak": vult alleen lege locaties (overwrite = ook afwijkende).
export function planDepartments(items, { overwrite = false } = {}) {
  const changes = [];
  const unknown = [];
  const next = (items || []).map((it) => {
    const cur = normalizeDepartment(it.department);
    const want = suggestDepartment(it);
    if (!want) {
      if (!cur) unknown.push(it.label || it.id);
      return { ...it };
    }
    if (cur === want || (cur && !overwrite)) return { ...it };
    changes.push({ id: it.id, label: it.label, from: cur, to: want });
    return { ...it, department: want };
  });
  return { items: next, changes, unknown };
}

// Te schrijven velden voor settings/locations: items met department (alleen als gezet) + de map.
export function locationDepartmentFields(items) {
  const departments = {};
  const out = (items || []).map((it) => {
    const d = normalizeDepartment(it.department);
    const { department, ...rest } = it;
    if (d) departments[it.id] = d;
    return d ? { ...rest, department: d } : rest;
  });
  return { items: out, departments };
}

// staffProfiles/{employeeId}: { department?, canAdmin? (alleen true) }. null = doc verwijderen.
export function profilePayload({ department, canAdmin } = {}) {
  const d = normalizeDepartment(department);
  const out = {};
  if (d) out.department = d;
  if (canAdmin === true) out.canAdmin = true;
  return Object.keys(out).length ? out : null;
}

export function normalizeProfile(data) {
  return { department: normalizeDepartment(data && data.department), canAdmin: Boolean(data && data.canAdmin === true) };
}

export function profileSummary(p) {
  const bits = [];
  if (p && p.department) bits.push(DEPARTMENT_LABELS[p.department]);
  if (p && p.canAdmin) bits.push("Adminknop");
  return bits.join(" · ");
}
