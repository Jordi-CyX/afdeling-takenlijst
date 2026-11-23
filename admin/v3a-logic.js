// V3A (admin v28): pure logica (zonder DOM/Firebase), ook in Node te testen (tests/v3a-logic.test.mjs).
// Datamodel: /workspace/outputs/zla-v3a-data-afspraak.md

// Sorteren (ZL en ZLA, punt 4): padvolgorde (items[].order), binnen een pad eerst spoed, dan streefdatum
// (leeg achteraan); taken zonder (bekende) locatie achteraan; daarna nieuwste eerst.
export function makePathComparator(orderOf) {
  const ord = (task) => {
    const o = task && task.locationId ? orderOf(task.locationId) : null;
    return Number.isFinite(o) ? o : Number.POSITIVE_INFINITY;
  };
  const due = (task) => (task && typeof task.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(task.dueDate) ? task.dueDate : "");
  return (a, b) => {
    const oa = ord(a);
    const ob = ord(b);
    if (oa !== ob) return oa < ob ? -1 : 1;
    const ua = a.urgent ? 1 : 0;
    const ub = b.urgent ? 1 : 0;
    if (ua !== ub) return ub - ua;
    const da = due(a);
    const db = due(b);
    if (da !== db) {
      if (!da) return 1;
      if (!db) return -1;
      return da < db ? -1 : 1;
    }
    return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
  };
}

// B1: doorklikken begint altijd met de standaardfilters.
export function defaultTaskFilters() {
  return { q: "", status: "all", employee: "all", location: "all", recurring: "all", urgent: "all", audit: "all" };
}

export function activeFilterCount(filters) {
  const def = defaultTaskFilters();
  return Object.keys(def).filter((k) => String((filters || {})[k] ?? def[k]).trim() !== def[k]).length;
}

// Claim ("Ik pak deze op"): { employeeId, name } of null.
export function normalizeClaim(data) {
  const c = data && data.claimedBy;
  if (!c || typeof c !== "object" || typeof c.employeeId !== "string" || !c.employeeId) return null;
  const at = data.claimedAt && typeof data.claimedAt.toDate === "function" ? data.claimedAt.toDate().toISOString()
    : (typeof data.claimedAt === "string" ? data.claimedAt : "");
  return { employeeId: c.employeeId, name: typeof c.name === "string" ? c.name.slice(0, 60) : "", at };
}

// Naam voor weergave: huidige naam uit de medewerkerslijst, met de opgeslagen naam als fallback (B19).
export function displayName(employeeId, storedName, employees) {
  const emp = employeeId ? (employees || []).find((e) => e.id === employeeId) : null;
  return (emp && emp.name) || String(storedName || "").trim();
}

export const MAINTENANCE_MAX = 300;
export function cleanMaintenanceMessage(text) {
  return String(text || "").replace(/\r\n/g, "\n").trim().slice(0, MAINTENANCE_MAX);
}

// ---------- Punt 7: audit-varianten ----------
export const DEFAULT_VARIANT_ID = "standaard";
export const VARIANT_NAME_MAX = 60;
export const RANBY_MAX = 60;
export const CUSTOM_TASK_TEXT_MAX = 500;

// Een audit zonder variantId (v2) hoort bij de eerste variant "standaard".
export function variantIdOf(audit) {
  return (audit && typeof audit.variantId === "string" && audit.variantId) || DEFAULT_VARIANT_ID;
}

function normSections(sections) {
  return (Array.isArray(sections) ? sections : [])
    .filter((s) => s && typeof s.locationId === "string")
    .map((s, i) => ({ ...s, order: Number(s.order) || i + 1, active: s.active !== false, questions: Array.isArray(s.questions) ? s.questions : [] }))
    .sort((a, b) => a.order - b.order);
}

export function normalizeVariant(id, data) {
  const d = data || {};
  return {
    id,
    name: String(d.name || id).slice(0, VARIANT_NAME_MAX),
    compare: d.compare !== false,
    active: d.active !== false,
    order: Number(d.order) || 0,
    version: Number(d.version) || 1,
    sections: normSections(d.sections),
    virtual: false
  };
}

// Varianten uit auditVariants; zolang "standaard" daar nog niet staat, telt auditConfig/current als
// virtuele variant "Standaard" (migratie zonder script: de eerste keer opslaan schrijft auditVariants/standaard).
export function mergeVariants(variantDocs, legacyConfig) {
  const list = (variantDocs || []).map((v) => ({ ...v }));
  if (legacyConfig && !list.some((v) => v.id === DEFAULT_VARIANT_ID)) {
    list.push({ id: DEFAULT_VARIANT_ID, name: "Standaard", compare: true, active: true, order: 0, version: Number(legacyConfig.version) || 1, sections: normSections(legacyConfig.sections), virtual: true });
  }
  return list.sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name, "nl"));
}

// De n vorige afgeronde audits van dezelfde variant (nieuwste eerst), alleen eerder dan `audit`.
export function previousSameVariant(completedDesc, audit, n = 2) {
  const vid = variantIdOf(audit);
  const key = (a) => [String(a.auditDate || ""), Number(a.startedAtMs) || 0];
  const [d0, s0] = key(audit);
  return (completedDesc || [])
    .filter((a) => a.id !== audit.id && variantIdOf(a) === vid)
    .filter((a) => { const [d, s] = key(a); return d < d0 || (d === d0 && s < s0); })
    .slice(0, n);
}

// "Structureel dalend": twee keer achter elkaar lager (oudste → nieuwste, strikt dalend).
export function isStructuralDecline(pcts) {
  const v = (pcts || []).slice(-3);
  if (v.length < 3 || v.some((x) => typeof x !== "number")) return false;
  return v[0] > v[1] && v[1] > v[2];
}

export function pctOf(sc) {
  return sc && sc.total ? Math.round((sc.good / sc.total) * 100) : null;
}

// Vergelijkingsrijen: per onderdeel van de huidige audit de percentages van [oudste vorige, vorige, deze].
// scoreOf(section) → { good, total }.
export function compareRows(current, previous, scoreOf) {
  const prevs = (previous || []).slice(0, 2).reverse(); // oudste eerst
  const find = (a, id) => (a.sections || []).find((s) => s.locationId === id);
  const rows = (current.sections || []).map((s) => {
    const pcts = [...prevs.map((p) => { const ps = find(p, s.locationId); return ps ? pctOf(scoreOf(ps)) : null; }), pctOf(scoreOf(s))];
    while (pcts.length < 3) pcts.unshift(null);
    return { locationId: s.locationId, label: s.label || s.locationId, pcts, declining: isStructuralDecline(pcts) };
  });
  const tot = (a) => { let g = 0; let t = 0; for (const s of a.sections || []) { const sc = scoreOf(s); g += sc.good; t += sc.total; } return pctOf({ good: g, total: t }); };
  const totalPcts = [...prevs.map(tot), tot(current)];
  while (totalPcts.length < 3) totalPcts.unshift(null);
  return { rows, total: { pcts: totalPcts, declining: isStructuralDecline(totalPcts) } };
}

// Eigen audittaak ("Zelf aanmaken"): geen foto, wel omschrijving, persoon, spoed en streefdatum.
export function cleanCustomTask(input, employees) {
  const text = String((input && input.text) || "").replace(/\r\n/g, "\n").trim().slice(0, CUSTOM_TASK_TEXT_MAX);
  if (!text) return { error: "Vul de omschrijving in." };
  const dueDate = String((input && input.dueDate) || "").trim();
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return { error: "Ongeldige streefdatum." };
  const emp = (employees || []).find((e) => e.id === (input && input.assigneeId));
  const id = String((input && input.id) || "").replace(/[^a-z0-9]/gi, "").slice(0, 12) || Math.random().toString(36).slice(2, 10);
  return { task: { id, text, assigneeId: emp ? emp.id : "ALLEN", assigneeName: emp ? String(emp.name).slice(0, 60) : "Allen", urgent: Boolean(input && input.urgent), dueDate } };
}

export function customTaskTitle(label, text) {
  const first = String(text || "").split("\n")[0].trim();
  return `${label} - ${first}`.slice(0, 120);
}
