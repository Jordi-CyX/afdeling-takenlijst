// v3a: sorteren op padvolgorde en afdelingsfilter (data-afspraak punt 1, 3 en 4).
// Pure functies zonder Firebase, zodat ze los te testen zijn (zl-tests/task-order.test.mjs).

export const DEPARTMENTS = ["sanitair", "tegels", "beide"];

export function normalizeDepartment(value) {
  const v = String(value || "").trim().toLowerCase();
  return DEPARTMENTS.includes(v) ? v : "";
}

function items(settings) {
  return settings && Array.isArray(settings.items) ? settings.items.filter((i) => i && i.id) : [];
}

// Afdeling van een pad: map `departments` gaat voor, anders items[].department.
export function locationDepartment(locationId, settings) {
  if (!locationId) return "";
  const map = settings && settings.departments && typeof settings.departments === "object" ? settings.departments : null;
  if (map && map[locationId]) return normalizeDepartment(map[locationId]);
  const hit = items(settings).find((i) => i.id === locationId);
  return hit ? normalizeDepartment(hit.department) : "";
}

// Punt 3: persoonlijk toegewezen altijd; geen afdeling of "beide" ziet alles;
// taken zonder locatie ziet iedereen; pad zonder afdeling of "beide" ziet iedereen.
export function isVisibleForDepartment(task, staffDepartment, employeeId, settings) {
  const dept = normalizeDepartment(staffDepartment);
  if (!dept || dept === "beide") return true;
  if (!task) return false;
  if (employeeId && String(task.assigneeId || "") === String(employeeId)) return true;
  if (!task.locationId) return true;
  const taskDept = locationDepartment(task.locationId, settings);
  if (!taskDept || taskDept === "beide") return true;
  return taskDept === dept;
}

export function locationOrderMap(settings) {
  const map = new Map();
  items(settings).forEach((i, index) => {
    const n = Number(i.order);
    map.set(i.id, Number.isFinite(n) ? n : 1000 + index);
  });
  return map;
}

// Punt 4 (ZL): padvolgorde (items[].order), binnen pad spoed eerst, dan tiebreak (aanmaakdatum).
// Geen streefdatum: die staat in taskMeta en is voor medewerkers niet leesbaar (data-afspraak ZLA §5).
// Zonder locatie/onbekend pad achteraan.
export function sortTasks(list, settings, tiebreak = () => "") {
  const order = locationOrderMap(settings);
  const rank = (t) => (t && t.locationId && order.has(t.locationId) ? order.get(t.locationId) : Number.MAX_SAFE_INTEGER);
  return list.slice().sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r) return r < 0 ? -1 : 1;
    const u = Number(b.urgent === true) - Number(a.urgent === true);
    if (u) return u;
    return String(tiebreak(a)).localeCompare(String(tiebreak(b)));
  });
}
