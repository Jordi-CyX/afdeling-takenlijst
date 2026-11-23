// V3C (admin v30): pure logica voor inklapbare onderdelen en de vragenbank (Standaardvragen).
// Geen Firebase, geen DOM (unit-tests in tests/v3c-logic.test.mjs).

export const FOLD_STORE_KEY = "zeiklijst-admin-folds-v3c";
export const BANK_MAX = 200; // max. aantal standaardvragen dat de admin-app toont/bewaart
export const BANK_TEXT_MAX = 200;
export const BANK_TASK_MAX = 120;
export const BANK_REASONS_MAX = 20;
export const BANK_REASON_LABEL_MAX = 60;

// Stabiele sleutel per pagina + kopje: tellers, cijfers en "· variantnaam" tellen niet mee,
// zodat de stand niet verspringt als er een vraag of taak bijkomt.
export function foldKey(section, heading) {
  const s = String(section || "app").toLowerCase().replace(/[^a-z0-9-]/g, "");
  const h = String(heading || "")
    .split("·")[0]
    .replace(/\([^)]*\)/g, " ")
    .replace(/[0-9]+/g, " ")
    .toLowerCase()
    .replace(/[^a-z\u00c0-\u024f ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return `${s || "app"}:${h || "onderdeel"}`;
}

// Opgeslagen stand: { [key]: false } = ingeklapt. Alleen booleans; rommel wordt genegeerd.
export function parseFoldState(raw) {
  let obj = null;
  try { obj = JSON.parse(raw || "{}"); } catch { return {}; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (typeof v === "boolean" && k.length <= 80) out[k] = v;
  return out;
}

export function isFoldOpen(state, key) {
  return !(state && state[key] === false);
}

// Alleen ingeklapte onderdelen bewaren (open = standaard), zodat de opslag klein blijft.
export function setFoldState(state, key, open) {
  const next = { ...(state || {}) };
  if (open) delete next[key];
  else next[key] = false;
  return next;
}

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const trig = (v) => (v === "ja" ? "ja" : "nee");

// Eén vraag (zelfde vorm als in een vragenlijst, zonder id) uit een doc of formulier.
// Geeft null als er geen geldige vraag van te maken is.
export function normalizeBankQuestion(data) {
  if (!data || typeof data !== "object") return null;
  const text = str(data.text, BANK_TEXT_MAX);
  if (!text) return null;
  const q = { text, trigger: trig(data.trigger) };
  if (data.followUp && typeof data.followUp === "object") {
    const fu = { text: str(data.followUp.text, BANK_TEXT_MAX), trigger: trig(data.followUp.trigger), taskText: str(data.followUp.taskText, BANK_TASK_MAX) };
    if (!fu.text || !fu.taskText) return null;
    q.followUp = fu;
  } else if (Array.isArray(data.reasons) && data.reasons.length) {
    const reasons = data.reasons.slice(0, BANK_REASONS_MAX)
      .map((r) => ({ id: str(r && r.id, 40), label: str(r && r.label, BANK_REASON_LABEL_MAX), taskText: str(r && r.taskText, BANK_TASK_MAX) }))
      .filter((r) => r.label && r.taskText);
    if (!reasons.length) return null;
    q.reasons = reasons.map((r, i) => ({ ...r, id: r.id && /^[a-z0-9-]{1,40}$/.test(r.id) ? r.id : `keuze-${i + 1}` }));
  } else {
    const taskText = str(data.taskText, BANK_TASK_MAX);
    if (!taskText) return null;
    q.taskText = taskText;
  }
  return q;
}

// Een vraag uit een vragenlijst als standaardvraag (id/note/antwoorden weg).
export function bankFromQuestion(q) {
  return normalizeBankQuestion(q);
}

// Standaardvraag in een onderdeel zetten: kopie met een nieuw, uniek id binnen dat onderdeel.
export function questionFromBank(bankQ, takenIds = [], makeId = defaultId) {
  const q = normalizeBankQuestion(bankQ);
  if (!q) return null;
  const taken = new Set(takenIds);
  return { id: makeId(q.text, taken), ...JSON.parse(JSON.stringify(q)) };
}

function defaultId(text, taken) {
  const base = String(text).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "vraag";
  let id = base;
  let n = 2;
  while (taken.has(id)) {
    const suffix = `-${n}`;
    id = `${base.slice(0, 40 - suffix.length)}${suffix}`;
    n += 1;
  }
  return id;
}

// Staat dezelfde vraag (tekst, hoofdletterongevoelig) al in de bank of in een onderdeel?
export function sameQuestionText(a, b) {
  return String((a && a.text) || "").trim().toLowerCase() === String((b && b.text) || "").trim().toLowerCase();
}

// Firestore-payload (zonder tijden): alleen de toegestane velden.
export function bankPayload(q) {
  const n = normalizeBankQuestion(q);
  if (!n) return null;
  const out = { text: n.text, trigger: n.trigger };
  if (n.followUp) out.followUp = n.followUp;
  else if (n.reasons) out.reasons = n.reasons;
  else out.taskText = n.taskText;
  return out;
}

// Gesorteerd op tekst (nl), zodat Jordi snel kan zoeken in de keuzelijst.
export function sortBank(list) {
  return [...list].sort((a, b) => a.text.localeCompare(b.text, "nl", { sensitivity: "base" }));
}
