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
