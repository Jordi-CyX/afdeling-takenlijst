// Build v2 (ZLA, admin v26): locaties, audit lopen, vragenlijst/ronde, auditgeschiedenis + score,
// PDF (afdrukweergave), afgerond-door (taskCompletions), oude taken koppelen, ruwe back-up.
// Contract: /workspace/outputs/zla-build-v2-datamodel.md. Renderen alleen via ctx.dom (geen HTML uit data).
import {
  onSnapshot,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  getDoc,
  collection,
  doc,
  setDoc,
  writeBatch,
  deleteDoc,
  Timestamp,
  serverTimestamp,
  deleteField
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";
import { db, localDateKey, formatDate, formatDateTime } from "../shared.js";
import { AUDIT_SETTINGS, LOCATION_PLACEHOLDER, DEFAULT_LOCATIONS, defaultAuditSections } from "./audit-defaults.js";

let ctx = null;
let locationsDoc = null; // { items } of null (nog niet aangemaakt)
let locationsReady = false;
let auditConfig = null; // { version, sections } of null
let auditConfigReady = false;
let audits = []; // laatste N (alle statussen)
let activeAuditDoc = null; // { id, data } van de audit met status "bezig"
let completions = new Map(); // taskId -> { employeeId, name, at (ISO), legacy }
let completionsReady = false;
let draft = null; // werkkopie van de lopende audit { id, ...data }
let draftSaveTimer = null;
let auditMode = "start"; // "start" | "run" | "review"
let auditPos = 0;
let historyOpen = new Set();
let editingQuestion = null; // { sectionIndex, questionIndex | -1 }
let finishing = false;
let linkIncludeDone = false;
const AUDIT_POS_KEY = "zeiklijst-admin-audit-pos";
const noop = () => {};

// ---------- Init en listeners ----------
export function initV2(context) {
  ctx = context;
  window.addEventListener("afterprint", () => document.body.classList.remove("print-mode"));
}

export function startV2Listeners() {
  onSnapshot(doc(db, "settings", "locations"), (snap) => {
    locationsDoc = snap.exists() ? normalizeLocationsDoc(snap.data()) : null;
    locationsReady = true;
    ctx.renderAll();
  }, noop);
  onSnapshot(doc(db, "auditConfig", "current"), (snap) => {
    auditConfig = snap.exists() ? normalizeConfig(snap.data()) : null;
    auditConfigReady = true;
    renderV2();
  }, noop);
  onSnapshot(query(collection(db, "audits"), orderBy("startedAt", "desc"), limit(AUDIT_SETTINGS.historyLimit)), (snap) => {
    audits = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderV2();
  }, noop);
  onSnapshot(query(collection(db, "audits"), where("status", "==", "bezig"), limit(1)), (snap) => {
    activeAuditDoc = snap.empty ? null : { id: snap.docs[0].id, data: snap.docs[0].data() };
    if (!activeAuditDoc && draft && !finishing) {
      draft = null;
      auditMode = "start";
    }
    renderV2();
  }, noop);
  onSnapshot(collection(db, "taskCompletions"), (snap) => {
    completions = new Map(snap.docs.map((d) => {
      const x = d.data() || {};
      return [d.id, {
        employeeId: typeof x.employeeId === "string" ? x.employeeId : "",
        name: typeof x.name === "string" ? x.name : "",
        at: x.at && typeof x.at.toDate === "function" ? x.at.toDate().toISOString() : "",
        legacy: x.legacy === true
      }];
    }));
    completionsReady = true;
    ctx.applyTaskMeta();
  }, noop);
}

function normalizeLocationsDoc(data) {
  const items = (Array.isArray(data.items) ? data.items : [])
    .filter((it) => it && typeof it.id === "string" && typeof it.label === "string")
    .map((it, i) => ({ id: it.id, label: it.label, order: Number(it.order) || i + 1, active: it.active !== false, staffSelectable: it.staffSelectable !== false }))
    .sort((a, b) => a.order - b.order);
  return { items };
}

function normalizeConfig(data) {
  return {
    version: Number(data.version) || 1,
    sections: (Array.isArray(data.sections) ? data.sections : [])
      .filter((s) => s && typeof s.locationId === "string")
      .map((s, i) => ({ ...s, order: Number(s.order) || i + 1, active: s.active !== false, questions: Array.isArray(s.questions) ? s.questions : [] }))
      .sort((a, b) => a.order - b.order)
  };
}

// ---------- Locaties (ook gebruikt door admin.js) ----------
export function locationsAvailable() {
  return Boolean(locationsDoc);
}

export function allLocations() {
  return locationsDoc ? locationsDoc.items : [];
}

export function activeLocations() {
  return allLocations().filter((l) => l.active);
}

export function locationLabelById(id) {
  const loc = allLocations().find((l) => l.id === id);
  return loc ? loc.label : "";
}

// Weergavetekst: label uit de lijst (gekoppeld) of de oude vrije tekst.
export function taskLocationText(task) {
  if (task.locationId) return locationLabelById(task.locationId) || task.location || task.locationId;
  return (task.location || "").trim();
}

export function completionFor(taskId) {
  return completions.get(taskId) || null;
}

function slugify(text, max = 30) {
  const s = String(text || "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "");
  return s || "x";
}

function uniqueId(base, taken, max = 30) {
  let id = base.slice(0, max);
  let n = 2;
  while (taken.has(id)) {
    const suffix = `-${n++}`;
    id = base.slice(0, max - suffix.length) + suffix;
  }
  return id;
}

async function saveLocations(items) {
  const sorted = items.map((it, i) => ({ id: it.id, label: it.label, order: i + 1, active: it.active !== false, staffSelectable: it.staffSelectable !== false }));
  // labels = wat medewerkers mogen kiezen (de regels controleren een nieuwe medewerkerstaak hiertegen):
  // alleen actief én staffSelectable. De admin (en audit-taken) mag elke locatie gebruiken.
  const labels = {};
  for (const it of sorted) if (it.active && it.staffSelectable) labels[it.id] = it.label;
  return ctx.safeWrite(() => setDoc(doc(db, "settings", "locations"), { items: sorted, labels, updatedAt: serverTimestamp() }));
}

export async function seedLocations() {
  if (locationsDoc) return;
  const ok = await ctx.confirmAction(`De standaard locatielijst (${DEFAULT_LOCATIONS.length} locaties) aanmaken?`, { title: "Locatielijst", confirmText: "Aanmaken" });
  if (!ok) return;
  const snap = await getDoc(doc(db, "settings", "locations"));
  if (snap.exists()) return; // nooit overschrijven
  if (await saveLocations(DEFAULT_LOCATIONS)) ctx.showToast("Locatielijst aangemaakt.", "ok");
}

export async function seedAuditConfig() {
  if (auditConfig) return;
  const ok = await ctx.confirmAction("De standaard vragenlijst en ronde aanmaken (volgens de afspraken van 19-11)?", { title: "Vragenlijst", confirmText: "Aanmaken" });
  if (!ok) return;
  const snap = await getDoc(doc(db, "auditConfig", "current"));
  if (snap.exists()) return;
  if (await saveConfig(defaultAuditSections(), 0)) ctx.showToast("Vragenlijst aangemaakt.", "ok");
}

function saveConfig(sections, prevVersion) {
  const clean = JSON.parse(JSON.stringify(sections.map((s, i) => ({ ...s, order: i + 1 }))));
  return ctx.safeWrite(() => setDoc(doc(db, "auditConfig", "current"), { version: (prevVersion || 0) + 1, updatedAt: serverTimestamp(), sections: clean }));
}

// Vult een <select> met actieve locaties (+ "Geen locatie" voor de admin).
export function fillLocationSelect(select, currentId = "", { includeNone = true, noneLabel = "Geen locatie" } = {}) {
  if (!select) return;
  const opts = [];
  if (includeNone) opts.push(["", noneLabel]);
  for (const loc of activeLocations()) opts.push([loc.id, loc.label]);
  if (currentId && !opts.some(([v]) => v === currentId)) {
    const label = locationLabelById(currentId) || currentId;
    opts.push([currentId, `${label} (inactief)`]);
  }
  select.replaceChildren(...opts.map(([v, l]) => {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = l;
    return o;
  }));
  select.value = currentId || "";
}

// ---------- Afgerond door (admin-acties) ----------
export function addCompletionDelete(batch, taskId) {
  batch.delete(doc(db, "taskCompletions", taskId));
}

export function addAdminCompletion(batch, taskId) {
  batch.set(doc(db, "taskCompletions", taskId), { employeeId: "", name: "Beheerder", at: serverTimestamp() });
}

function legacyPendingTasks() {
  return ctx.getRawTasks().filter((t) => t.pendingBy || t.pendingAt || t.pendingByEmployeeId);
}

// Eenmalig: oude pendingBy/pendingAt/pendingByEmployeeId van taken naar taskCompletions (met back-up eerst).
export async function migratePendingBy() {
  const list = legacyPendingTasks();
  if (!list.length) {
    ctx.showToast("Er staan geen oude afvinkers meer op taken.", "ok");
    return;
  }
  const first = await ctx.showDialog({
    title: "Afvinkers verplaatsen",
    message: `${list.length} taken hebben nog een naam of tijd van afvinken op de taak zelf (zichtbaar voor medewerkers). Eerst wordt een volledige back-up gedownload; daarna verplaats je die gegevens naar de lijst die alleen de admin ziet.`,
    confirmText: "Back-up downloaden",
    cancelText: "Annuleren"
  });
  if (!first.ok) return;
  if (!(await exportRawBackup())) return;
  const ok = await ctx.confirmAction(`Back-up gedownload? Dan nu ${list.length} afvinkers verplaatsen.`, { title: "Verplaatsen", confirmText: "Verplaatsen" });
  if (!ok) return;
  const done = await ctx.safeWrite(async () => {
    let batch = writeBatch(db);
    let n = 0;
    for (const t of list) {
      if (!completions.has(t.id)) {
        const at = t.pendingAt ? new Date(t.pendingAt) : null;
        batch.set(doc(db, "taskCompletions", t.id), {
          employeeId: t.pendingByEmployeeId || "",
          name: t.pendingBy || "",
          at: at && !Number.isNaN(at.getTime()) ? Timestamp.fromDate(at) : null,
          legacy: true
        });
        n += 1;
      }
      batch.update(doc(db, "tasks", t.id), { pendingAt: deleteField(), pendingBy: deleteField(), pendingByEmployeeId: deleteField() });
      n += 1;
      if (n >= AUDIT_SETTINGS.batchSize - 1) {
        await batch.commit();
        batch = writeBatch(db);
        n = 0;
      }
    }
    if (n) await batch.commit();
  });
  if (done) ctx.showToast(`${list.length} afvinkers verplaatst.`, "ok");
}

// Noodknop (terugval): legacy-afvinkers weer op de taak zetten.
export async function restorePendingBy() {
  const legacy = [...completions.entries()].filter(([, c]) => c.legacy);
  if (!legacy.length) {
    ctx.showToast("Geen verplaatste afvinkers gevonden.", "ok");
    return;
  }
  const ok = await ctx.confirmAction(`Noodknop: ${legacy.length} verplaatste afvinkers terugzetten op de taken? Alleen gebruiken als je teruggaat naar de oude app en regels.`, { title: "Terugzetten", confirmText: "Terugzetten", danger: true });
  if (!ok) return;
  const taskIds = new Set(ctx.getRawTasks().map((t) => t.id));
  const done = await ctx.safeWrite(async () => {
    let batch = writeBatch(db);
    let n = 0;
    for (const [id, c] of legacy) {
      if (!taskIds.has(id)) continue;
      batch.update(doc(db, "tasks", id), { pendingBy: c.name || null, pendingByEmployeeId: c.employeeId || null, pendingAt: c.at || null });
      batch.delete(doc(db, "taskCompletions", id));
      n += 2;
      if (n >= AUDIT_SETTINGS.batchSize) {
        await batch.commit();
        batch = writeBatch(db);
        n = 0;
      }
    }
    if (n) await batch.commit();
  });
  if (done) ctx.showToast("Afvinkers teruggezet.", "ok");
}

// ---------- Ruwe back-up ----------
const BACKUP_COLLECTIONS = [
  "tasks", "taskMeta", "taskCompletions", "recurring", "employees", "employeeDetails", "reports",
  "staffAccounts", "pinResetRequests", "staffDailyCounters", "settings", "auditConfig", "audits"
];

function toPlain(value) {
  if (value == null) return value;
  if (typeof value === "object" && typeof value.toDate === "function" && typeof value.seconds === "number") {
    return { __timestamp: value.toDate().toISOString() };
  }
  if (Array.isArray(value)) return value.map(toPlain);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = toPlain(v);
    return out;
  }
  return value;
}

export async function exportRawBackup() {
  try {
    const out = { version: 4, kind: "zeiklijst-raw-backup", exportedAt: new Date().toISOString(), collections: {} };
    for (const name of BACKUP_COLLECTIONS) {
      try {
        const snap = await getDocs(collection(db, name));
        out.collections[name] = snap.docs.map((d) => {
          const data = toPlain(d.data());
          if (name === "staffAccounts") delete data.startCode; // geen (gebruikte) codes in de back-up
          return { id: d.id, data };
        });
      } catch {
        out.collections[name] = { error: "niet leesbaar (regels nog niet gepubliceerd?)" };
      }
    }
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    a.download = `zeiklijst-backup-${stamp}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    ctx.showToast("Back-up gedownload.", "ok");
    return true;
  } catch {
    ctx.showToast("Back-up maken is mislukt.");
    return false;
  }
}

// ---------- Audit: logica ----------
function sectionLabel(locationId) {
  return locationLabelById(locationId) || locationId;
}

function fillPlaceholder(text, label) {
  return String(text || "").split(LOCATION_PLACEHOLDER).join(label).slice(0, 120);
}

function questionComplete(q) {
  if (q.answer !== "ja" && q.answer !== "nee") return false;
  if (q.answer !== q.trigger) return true;
  if (q.followUp) return q.followUpAnswer === "ja" || q.followUpAnswer === "nee";
  if (Array.isArray(q.reasons) && q.reasons.length) return Array.isArray(q.reasonIds) && q.reasonIds.length > 0;
  return true;
}

function sectionComplete(s) {
  return (s.questions || []).every(questionComplete);
}

function questionGood(q) {
  if (q.answer !== q.trigger) return true;
  if (q.followUp && q.followUpAnswer !== q.followUp.trigger) return AUDIT_SETTINGS.emptyWithoutStockCountsAsGood;
  return false;
}

function sectionScore(s) {
  const qs = s.questions || [];
  return { good: qs.filter(questionGood).length, total: qs.length };
}

function scoreClass(good, total) {
  if (!total) return "score-none";
  const p = good / total;
  if (p >= 0.9) return "score-good";
  if (p >= 0.6) return "score-mid";
  return "score-bad";
}

function pct(good, total) {
  return total ? Math.round((good / total) * 100) : 0;
}

function questionTasks(q, s, auditId, auditDate) {
  if (!questionComplete(q) || q.answer !== q.trigger) return [];
  const label = s.label || sectionLabel(s.locationId);
  const base = { questionId: q.id, locationId: s.locationId, label, question: q };
  const list = [];
  if (q.followUp) {
    if (q.followUpAnswer === q.followUp.trigger) list.push({ ...base, title: fillPlaceholder(q.followUp.taskText, label) });
  } else if (Array.isArray(q.reasons) && q.reasons.length) {
    for (const r of q.reasons) {
      if ((q.reasonIds || []).includes(r.id)) list.push({ ...base, reasonId: r.id, title: fillPlaceholder(r.taskText, label) });
    }
  } else if (q.taskText) {
    list.push({ ...base, title: fillPlaceholder(q.taskText, label) });
  }
  return list.map((t) => ({
    ...t,
    id: `audit-${auditId}-${t.locationId}-${t.questionId}${t.reasonId ? `-${t.reasonId}` : ""}`,
    auditId,
    auditDate
  }));
}

function auditTasks(a) {
  return a.sections.flatMap((s) => (s.questions || []).flatMap((q) => questionTasks(q, s, a.id, a.auditDate)));
}

function yn(v) {
  return v === "ja" ? "Ja" : v === "nee" ? "Nee" : "-";
}

function describeAnswer(q) {
  const parts = [`${q.text} ${yn(q.answer)}`];
  if (q.followUp && q.answer === q.trigger) parts.push(`${q.followUp.text} ${yn(q.followUpAnswer)}`);
  if (Array.isArray(q.reasons) && q.answer === q.trigger) {
    const labels = q.reasons.filter((r) => (q.reasonIds || []).includes(r.id)).map((r) => r.label);
    if (labels.length) parts.push(`Waarom: ${labels.join(", ")}`);
  }
  return parts.join(" · ");
}

function taskPayload(t) {
  const q = t.question;
  const lines = [`Audit ${formatDate(t.auditDate)} · ${t.label}`, describeAnswer(q)];
  if (q.note) lines.push(`Notitie: ${q.note}`);
  const source = { type: "audit", auditId: t.auditId, auditDate: t.auditDate, locationId: t.locationId, questionId: t.questionId };
  if (t.reasonId) source.reasonId = t.reasonId;
  return {
    title: t.title,
    description: lines.join("\n").slice(0, 2000),
    assigneeId: "ALLEN",
    assigneeName: "Allen",
    status: "open",
    createdAt: new Date().toISOString(),
    pendingAt: null,
    pendingBy: null,
    completedAt: null,
    recurringId: null,
    occurrenceDate: null,
    photos: [],
    location: t.label,
    locationId: t.locationId,
    urgent: false,
    source
  };
}

function buildSnapshot() {
  const sections = (auditConfig ? auditConfig.sections : [])
    .filter((s) => s.active && s.questions.length)
    .map((s) => ({
      locationId: s.locationId,
      label: sectionLabel(s.locationId),
      questions: s.questions.map((q) => {
        const out = { id: q.id, text: q.text, trigger: q.trigger === "ja" ? "ja" : "nee", answer: null, note: "" };
        if (q.followUp) {
          out.followUp = { text: q.followUp.text, trigger: q.followUp.trigger === "nee" ? "nee" : "ja", taskText: q.followUp.taskText };
          out.followUpAnswer = null;
        } else if (Array.isArray(q.reasons) && q.reasons.length) {
          out.reasons = q.reasons.map((r) => ({ id: r.id, label: r.label, taskText: r.taskText }));
          out.reasonIds = [];
        } else {
          out.taskText = q.taskText || "";
        }
        return out;
      })
    }));
  return JSON.parse(JSON.stringify(sections));
}

function draftFromDoc(id, data) {
  return {
    id,
    status: data.status,
    auditDate: data.auditDate,
    startedAt: data.startedAt,
    configVersion: data.configVersion || 0,
    sections: JSON.parse(JSON.stringify(data.sections || []))
  };
}

function scheduleSave(immediate = false) {
  if (!draft) return;
  clearTimeout(draftSaveTimer);
  const run = () => saveDraft().catch(() => ctx.showToast("Bewaren van de audit is mislukt. Probeer het opnieuw."));
  if (immediate) run();
  else draftSaveTimer = setTimeout(run, 800);
}

async function saveDraft() {
  if (!draft || finishing) return;
  const { id, ...rest } = draft;
  await setDoc(doc(db, "audits", id), { ...rest, status: "bezig", updatedAt: serverTimestamp() });
}

function storePos() {
  if (draft) localStorage.setItem(AUDIT_POS_KEY, JSON.stringify({ id: draft.id, pos: auditPos }));
}

function restorePos() {
  try {
    const p = JSON.parse(localStorage.getItem(AUDIT_POS_KEY) || "null");
    if (p && draft && p.id === draft.id) {
      auditPos = Math.min(Math.max(0, Number(p.pos) || 0), draft.sections.length - 1);
      return;
    }
  } catch {
    // ongeldige opslag: negeren
  }
  auditPos = Math.max(0, draft.sections.findIndex((s) => !sectionComplete(s)));
}

// dom`` staat geen dynamische attribuutnamen toe; booleans gaan via data-vlaggen.
function applyFlags(root) {
  root.querySelectorAll('[data-disabled="1"]').forEach((el) => { el.disabled = true; });
  root.querySelectorAll('[data-open="1"]').forEach((el) => { el.open = true; });
  root.querySelectorAll('[data-checked="1"]').forEach((el) => { el.checked = true; });
  root.querySelectorAll('[data-selected="1"]').forEach((el) => { el.selected = true; });
}
const flag = (b) => (b ? "1" : "");

async function startAudit() {
  if (activeAuditDoc) {
    resumeAudit();
    return;
  }
  if (!locationsDoc || !auditConfig) {
    ctx.showToast("Maak eerst de locatielijst en de vragenlijst aan (Locaties & vragen).");
    return;
  }
  const sections = buildSnapshot();
  if (!sections.length) {
    ctx.showToast("De ronde heeft geen actieve onderdelen met vragen.");
    return;
  }
  const ref = doc(collection(db, "audits"));
  draft = { id: ref.id, status: "bezig", auditDate: localDateKey(new Date()), startedAt: Timestamp.now(), configVersion: auditConfig.version, sections };
  auditPos = 0;
  auditMode = "run";
  storePos();
  const ok = await ctx.safeWrite(() => saveDraft());
  if (!ok) {
    draft = null;
    auditMode = "start";
  }
  renderAudit();
  window.scrollTo(0, 0);
}

function resumeAudit() {
  if (!activeAuditDoc) return;
  if (!draft || draft.id !== activeAuditDoc.id) draft = draftFromDoc(activeAuditDoc.id, activeAuditDoc.data);
  restorePos();
  auditMode = "run";
  storePos();
  renderAudit();
  window.scrollTo(0, 0);
}

async function discardAudit() {
  const id = draft ? draft.id : (activeAuditDoc && activeAuditDoc.id);
  if (!id) return;
  const ok = await ctx.confirmAction("Deze lopende audit verwijderen? De antwoorden gaan verloren; er zijn nog geen taken gemaakt.", { title: "Audit verwijderen", confirmText: "Verwijderen", danger: true });
  if (!ok) return;
  clearTimeout(draftSaveTimer);
  const prev = draft;
  draft = null;
  auditMode = "start";
  if (!(await ctx.safeWrite(() => deleteDoc(doc(db, "audits", id))))) draft = prev;
  renderAudit();
}

async function finishAudit() {
  if (!draft || finishing) return;
  if (draft.sections.some((s) => !sectionComplete(s))) {
    ctx.showToast("Niet alle onderdelen zijn ingevuld.");
    return;
  }
  const list = auditTasks(draft);
  const ok = await ctx.confirmAction(`Audit afronden en ${list.length} ${list.length === 1 ? "taak" : "taken"} aanmaken?`, { title: "Taken aanmaken", confirmText: "Taken aanmaken" });
  if (!ok) return;
  finishing = true;
  clearTimeout(draftSaveTimer);
  const existing = new Set(ctx.getRawTasks().map((t) => t.id));
  const score = {};
  for (const s of draft.sections) score[s.locationId] = sectionScore(s);
  const notesCount = draft.sections.reduce((n, s) => n + s.questions.filter((q) => (q.note || "").trim()).length, 0);
  const { id, ...rest } = draft;
  const finalDoc = {
    ...rest,
    sections: JSON.parse(JSON.stringify(draft.sections.map((s) => ({ ...s, score: sectionScore(s) })))),
    status: "afgerond",
    completedAt: Timestamp.now(),
    updatedAt: serverTimestamp(),
    taskIds: list.map((t) => t.id),
    taskCount: list.length,
    notesCount,
    score
  };
  const done = await ctx.safeWrite(async () => {
    const todo = list.filter((t) => !existing.has(t.id)); // herhaalpoging: geen dubbele taken
    let batch = writeBatch(db);
    let n = 0;
    for (const t of todo) {
      batch.set(doc(db, "tasks", t.id), taskPayload(t));
      n += 1;
      if (n >= AUDIT_SETTINGS.batchSize) {
        await batch.commit();
        batch = writeBatch(db);
        n = 0;
      }
    }
    batch.set(doc(db, "audits", id), finalDoc); // laatste batch: audit pas daarna "afgerond"
    await batch.commit();
  });
  finishing = false;
  if (!done) return;
  localStorage.removeItem(AUDIT_POS_KEY);
  draft = null;
  auditMode = "start";
  historyOpen = new Set([id]);
  ctx.showToast(`Audit afgerond: ${list.length} ${list.length === 1 ? "taak" : "taken"} aangemaakt.`, "ok");
  ctx.showSection("audits");
  renderV2();
}

// ---------- Audit: weergave ----------
// Hiërarchische terug-functie: subweergaven binnen de v2-pagina's (eigenaar 12:04).
// Geeft { label, up } terug als er een subweergave open is, anders null.
export function v2SubView(section) {
  if (!ctx) return null;
  if (section === "audit" && draft) {
    if (auditMode === "review") return { label: "Vragen", up: () => { auditMode = "run"; auditPos = draft.sections.length - 1; storePos(); renderAudit(); } };
    if (auditMode === "run") return { label: "Audit lopen", up: () => { scheduleSave(true); auditMode = "start"; renderAudit(); ctx.showToast("Audit gepauzeerd en bewaard.", "ok"); } };
  }
  if (section === "audits" && historyOpen.size) return { label: "Audits", up: () => { historyOpen.clear(); renderHistory(); } };
  if (section === "beheer" && editingQuestion) return { label: "Locaties & vragen", up: () => { editingQuestion = null; renderBeheer(); } };
  return null;
}

export function renderV2() {
  if (!ctx) return;
  renderAudit();
  renderHistory();
  renderBeheer();
  renderDashboardV2();
  renderDataV2();
}

function renderAudit() {
  const root = document.getElementById("audit-root");
  if (!root) return;
  // Niet opnieuw tekenen terwijl de admin een notitie typt.
  if (auditMode === "run" && root.contains(document.activeElement) && document.activeElement.tagName === "TEXTAREA") return;
  const { dom } = ctx;
  if (activeAuditDoc && draft && draft.id !== activeAuditDoc.id && !finishing) draft = null;
  if (auditMode !== "start" && !draft) auditMode = "start";
  if (auditMode === "start") {
    const missing = [];
    if (locationsReady && !locationsDoc) missing.push("locatielijst");
    if (auditConfigReady && !auditConfig) missing.push("vragenlijst");
    const a = activeAuditDoc;
    const secs = a ? (a.data.sections || []) : [];
    const answered = secs.filter(sectionComplete).length;
    root.replaceChildren(dom`
      <div class="audit-start">
        ${missing.length ? dom`<div class="v2-setup"><p>Nog niet ingesteld: ${missing.join(" en ")}. Ga naar <strong>Locaties &amp; vragen</strong> om de standaardlijst aan te maken.</p><button type="button" data-goto-beheer>Naar Locaties &amp; vragen</button></div>` : ""}
        ${a ? dom`
          <div class="audit-resume">
            <p><strong>Er loopt een audit</strong> van ${formatDate(a.data.auditDate)}: ${answered} van ${secs.length} onderdelen ingevuld.</p>
            <button type="button" class="audit-big" data-resume>Audit hervatten</button>
            <button type="button" class="secondary" data-discard>Lopende audit verwijderen</button>
          </div>` : dom`
          <div>
            <p class="section-intro">Loop de ronde langs alle onderdelen. Elk onderdeel is verplicht. Bij een afwijking maakt de app na de controle automatisch een taak voor iedereen.</p>
            <button type="button" class="audit-big" data-start data-disabled="${flag(missing.length)}">Audit starten</button>
            ${auditConfig ? dom`<p class="pin-meta">Ronde: ${auditConfig.sections.filter((s) => s.active).map((s) => sectionLabel(s.locationId)).join(" → ")}</p>` : ""}
          </div>`}
      </div>`);
    applyFlags(root);
    const b = (sel, fn) => { const el = root.querySelector(sel); if (el) el.onclick = fn; };
    b("[data-start]", startAudit);
    b("[data-resume]", resumeAudit);
    b("[data-discard]", discardAudit);
    b("[data-goto-beheer]", () => ctx.showSection("beheer"));
    return;
  }
  if (auditMode === "review") {
    renderReview(root);
    return;
  }
  const s = draft.sections[auditPos];
  const total = draft.sections.length;
  const complete = sectionComplete(s);
  const isLast = auditPos === total - 1;
  const firstOpen = draft.sections.findIndex((x) => !sectionComplete(x));
  root.replaceChildren(dom`
    <div class="audit-run">
      <div class="audit-head">
        <span class="audit-step">Onderdeel ${auditPos + 1} van ${total}</span>
        <h3 class="audit-section-title">${s.label}</h3>
        <progress max="${total}" value="${draft.sections.filter(sectionComplete).length}" aria-label="Voortgang"></progress>
      </div>
      <div class="audit-jump" role="group" aria-label="Onderdelen">
        ${draft.sections.map((x, i) => {
          const done = sectionComplete(x);
          const reachable = done || i === firstOpen || i <= auditPos;
          return dom`<button type="button" class="audit-chip${done ? " done" : ""}${i === auditPos ? " current" : ""}" data-jump="${i}" data-disabled="${flag(!reachable)}" aria-current="${i === auditPos ? "step" : "false"}">${done ? "✓ " : ""}${x.label}</button>`;
        })}
      </div>
      <div class="audit-questions">
        ${s.questions.map((q, qi) => questionCard(q, qi, s))}
      </div>
      ${complete ? "" : dom`<p class="pin-meta audit-required">Beantwoord alle vragen van dit onderdeel om verder te gaan.</p>`}
      <div class="audit-nav">
        <button type="button" class="secondary audit-nav-btn" data-prev data-disabled="${flag(auditPos === 0)}">Vorige</button>
        <button type="button" class="audit-nav-btn" data-next data-disabled="${flag(!complete)}">${isLast ? "Naar controle" : "Volgende"}</button>
      </div>
      <p class="pin-meta">Wordt automatisch bewaard. Je kunt later hervatten, ook op een ander apparaat.</p>
      <button type="button" class="secondary audit-small" data-pause>Pauzeren</button>
    </div>`);
  applyFlags(root);
  bindRun(root, s);
}

function questionCard(q, qi, s) {
  const { dom } = ctx;
  const showExtra = q.answer && q.answer === q.trigger;
  const tasks = questionTasks(q, s, draft.id, draft.auditDate);
  const pressed = (v, cur) => (v === cur ? "true" : "false");
  return dom`
    <div class="audit-q${questionComplete(q) ? " complete" : ""}" data-qi="${qi}">
      <p class="audit-q-text">${q.text}</p>
      <div class="audit-answers">
        <button type="button" class="audit-ans ja" data-ans="ja" aria-pressed="${pressed("ja", q.answer)}">Ja</button>
        <button type="button" class="audit-ans nee" data-ans="nee" aria-pressed="${pressed("nee", q.answer)}">Nee</button>
      </div>
      ${showExtra && q.followUp ? dom`
        <div class="audit-follow">
          <p class="audit-q-text">${q.followUp.text}</p>
          <div class="audit-answers">
            <button type="button" class="audit-ans ja" data-fans="ja" aria-pressed="${pressed("ja", q.followUpAnswer)}">Ja</button>
            <button type="button" class="audit-ans nee" data-fans="nee" aria-pressed="${pressed("nee", q.followUpAnswer)}">Nee</button>
          </div>
        </div>` : ""}
      ${showExtra && Array.isArray(q.reasons) ? dom`
        <div class="audit-follow">
          <p class="audit-q-text">Waarom?${AUDIT_SETTINGS.multipleReasons ? " (meerdere mogelijk)" : ""}</p>
          <div class="audit-reasons">
            ${q.reasons.map((r) => dom`<button type="button" class="audit-reason" data-reason="${r.id}" aria-pressed="${(q.reasonIds || []).includes(r.id) ? "true" : "false"}">${r.label}</button>`)}
          </div>
        </div>` : ""}
      ${tasks.length ? dom`<ul class="audit-task-preview">${tasks.map((t) => dom`<li>Taak: ${t.title}</li>`)}</ul>` : ""}
      <details class="audit-note" data-open="${flag(q.note)}">
        <summary>${q.note ? "Notitie" : "Notitie toevoegen"}</summary>
        <textarea rows="2" maxlength="${AUDIT_SETTINGS.noteMax}" data-note aria-label="Notitie bij deze vraag">${q.note || ""}</textarea>
      </details>
    </div>`;
}

function bindRun(root, s) {
  root.querySelectorAll(".audit-q").forEach((card) => {
    const q = s.questions[Number(card.dataset.qi)];
    card.querySelectorAll("[data-ans]").forEach((btn) => {
      btn.onclick = () => {
        q.answer = btn.dataset.ans;
        if (q.answer !== q.trigger) {
          if (q.followUp) q.followUpAnswer = null;
          if (q.reasons) q.reasonIds = [];
        }
        scheduleSave();
        renderAudit();
      };
    });
    card.querySelectorAll("[data-fans]").forEach((btn) => {
      btn.onclick = () => {
        q.followUpAnswer = btn.dataset.fans;
        scheduleSave();
        renderAudit();
      };
    });
    card.querySelectorAll("[data-reason]").forEach((btn) => {
      btn.onclick = () => {
        const id = btn.dataset.reason;
        const cur = new Set(q.reasonIds || []);
        if (cur.has(id)) cur.delete(id);
        else {
          if (!AUDIT_SETTINGS.multipleReasons) cur.clear();
          cur.add(id);
        }
        q.reasonIds = q.reasons.map((r) => r.id).filter((x) => cur.has(x));
        scheduleSave();
        renderAudit();
      };
    });
    const note = card.querySelector("[data-note]");
    if (note) {
      note.oninput = () => {
        q.note = note.value.slice(0, AUDIT_SETTINGS.noteMax);
        scheduleSave();
      };
      note.onblur = () => setTimeout(renderAudit, 0);
    }
  });
  const go = (pos, mode = "run") => {
    auditPos = pos;
    auditMode = mode;
    storePos();
    scheduleSave(true);
    renderAudit();
    const r = document.getElementById("audit-root");
    if (r && r.scrollIntoView) r.scrollIntoView({ block: "start" });
  };
  root.querySelectorAll("[data-jump]").forEach((btn) => {
    btn.onclick = () => go(Number(btn.dataset.jump));
  });
  const prev = root.querySelector("[data-prev]");
  if (prev) prev.onclick = () => go(Math.max(0, auditPos - 1));
  const next = root.querySelector("[data-next]");
  if (next) next.onclick = () => {
    if (!sectionComplete(draft.sections[auditPos])) return;
    if (auditPos === draft.sections.length - 1) go(auditPos, "review");
    else go(auditPos + 1);
  };
  const pause = root.querySelector("[data-pause]");
  if (pause) pause.onclick = () => {
    scheduleSave(true);
    auditMode = "start";
    renderAudit();
    ctx.showToast("Audit gepauzeerd en bewaard.", "ok");
  };
}

function renderReview(root) {
  const { dom } = ctx;
  const list = auditTasks(draft);
  const incomplete = draft.sections.map((s, i) => ({ s, i })).filter(({ s }) => !sectionComplete(s));
  root.replaceChildren(dom`
    <div class="audit-review">
      <h3>Controle voor het aanmaken</h3>
      <p class="section-intro">Audit van ${formatDate(draft.auditDate)}. Controleer de taken en notities. Pas daarna worden de taken aangemaakt (voor iedereen, zonder streefdatum).</p>
      ${incomplete.length ? dom`<div class="v2-setup"><p>Nog niet ingevuld:</p>${incomplete.map(({ s, i }) => dom`<button type="button" class="secondary" data-jump="${i}">${s.label}</button>`)}</div>` : ""}
      <p class="review-total"><strong>${list.length}</strong> ${list.length === 1 ? "taak" : "taken"} · ${draft.sections.reduce((n, s) => n + s.questions.filter((q) => (q.note || "").trim()).length, 0)} notities</p>
      ${draft.sections.map((s, i) => {
        const sc = sectionScore(s);
        const tasks = s.questions.flatMap((q) => questionTasks(q, s, draft.id, draft.auditDate));
        const notes = s.questions.filter((q) => (q.note || "").trim());
        return dom`
          <div class="review-section">
            <div class="review-head">
              <h4>${s.label}</h4>
              <span class="score-pill ${scoreClass(sc.good, sc.total)}">${sc.good}/${sc.total}</span>
              <button type="button" class="secondary audit-small" data-jump="${i}">Wijzigen</button>
            </div>
            ${tasks.length ? dom`<ul class="review-tasks">${tasks.map((t) => dom`<li>${t.title}</li>`)}</ul>` : dom`<p class="pin-meta">Geen taken.</p>`}
            ${notes.map((q) => dom`<p class="review-note"><strong>Notitie</strong> (${q.text}): ${q.note}</p>`)}
          </div>`;
      })}
      <div class="audit-nav">
        <button type="button" class="secondary audit-nav-btn" data-back>Terug</button>
        <button type="button" class="success audit-nav-btn" data-finish data-disabled="${flag(incomplete.length || finishing)}">Taken aanmaken (${list.length})</button>
      </div>
    </div>`);
  applyFlags(root);
  root.querySelectorAll("[data-jump]").forEach((btn) => {
    btn.onclick = () => {
      auditPos = Number(btn.dataset.jump);
      auditMode = "run";
      storePos();
      renderAudit();
    };
  });
  root.querySelector("[data-back]").onclick = () => {
    auditMode = "run";
    auditPos = draft.sections.length - 1;
    storePos();
    renderAudit();
  };
  root.querySelector("[data-finish]").onclick = finishAudit;
}

// ---------- Geschiedenis, score, trend, PDF ----------
function completedAudits() {
  return audits.filter((a) => a.status === "afgerond");
}

function auditTotal(a) {
  let good = 0;
  let total = 0;
  for (const s of a.sections || []) {
    const sc = s.score || sectionScore(s);
    good += sc.good;
    total += sc.total;
  }
  return { good, total };
}

function auditTaskStatus(a) {
  const ids = new Set(a.taskIds || []);
  const counts = { open: 0, pending: 0, afgerond: 0, weg: 0 };
  const found = new Set();
  for (const t of ctx.getTasks()) {
    if (ids.has(t.id) || (t.source && t.source.auditId === a.id)) {
      found.add(t.id);
      if (t.status === "pending") counts.pending += 1;
      else if (t.status === "afgerond") counts.afgerond += 1;
      else counts.open += 1;
    }
  }
  for (const id of ids) if (!found.has(id)) counts.weg += 1;
  return counts;
}

function renderHistory() {
  const root = document.getElementById("audits-root");
  if (!root) return;
  const { dom } = ctx;
  const list = completedAudits();
  if (!list.length) {
    root.replaceChildren(dom`<p class="empty-state">Nog geen afgeronde audits.</p>`);
    return;
  }
  const trendAudits = list.slice(0, 6).reverse();
  const sectionIds = [];
  for (const a of list.slice(0, 6)) for (const s of a.sections || []) if (!sectionIds.includes(s.locationId)) sectionIds.push(s.locationId);
  const cell = (a, id) => {
    const s = (a.sections || []).find((x) => x.locationId === id);
    if (!s) return dom`<td class="score-none">–</td>`;
    const sc = s.score || sectionScore(s);
    return dom`<td class="${scoreClass(sc.good, sc.total)}">${pct(sc.good, sc.total)}%</td>`;
  };
  root.replaceChildren(dom`
    <h3>Trend per onderdeel</h3>
    <p class="pin-meta">Score = aantal vragen zonder afwijking. Laatste ${trendAudits.length} audits, oudste links.</p>
    <div class="trend-wrap">
      <table class="trend-table">
        <thead><tr><th scope="col">Onderdeel</th>${trendAudits.map((a) => dom`<th scope="col">${formatDate(a.auditDate)}</th>`)}</tr></thead>
        <tbody>
          ${sectionIds.map((id) => dom`<tr><th scope="row">${sectionLabel(id)}</th>${trendAudits.map((a) => cell(a, id))}</tr>`)}
          <tr class="trend-total"><th scope="row">Totaal</th>${trendAudits.map((a) => { const t = auditTotal(a); return dom`<td class="${scoreClass(t.good, t.total)}">${pct(t.good, t.total)}%</td>`; })}</tr>
        </tbody>
      </table>
    </div>
    <h3>Eerdere audits</h3>
    ${list.map((a) => auditCard(a))}`);
  root.querySelectorAll("[data-toggle-audit]").forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.toggleAudit;
      if (historyOpen.has(id)) historyOpen.delete(id);
      else historyOpen.add(id);
      renderHistory();
    };
  });
  root.querySelectorAll("[data-print-audit]").forEach((btn) => {
    btn.onclick = () => printAudit(btn.dataset.printAudit);
  });
  root.querySelectorAll("[data-audit-tasks]").forEach((btn) => {
    btn.onclick = () => ctx.showSection("taken", true, { filters: { status: "all", q: "", audit: btn.dataset.auditTasks } });
  });
}

function auditCard(a) {
  const { dom } = ctx;
  const t = auditTotal(a);
  const st = auditTaskStatus(a);
  const open = historyOpen.has(a.id);
  return dom`
    <article class="audit-card">
      <div class="audit-card-head">
        <div>
          <h4>Audit ${formatDate(a.auditDate)}</h4>
          <p class="pin-meta">${a.taskCount || 0} taken · ${a.notesCount || 0} notities</p>
          <p class="pin-meta">Status taken: ${st.open} open · ${st.pending} ter controle · ${st.afgerond} afgerond${st.weg ? ` · ${st.weg} verwijderd` : ""}</p>
        </div>
        <span class="score-pill big ${scoreClass(t.good, t.total)}">${pct(t.good, t.total)}%</span>
      </div>
      <div class="score-bars">
        ${(a.sections || []).map((s) => { const sc = s.score || sectionScore(s); return dom`<div class="score-bar-row"><span>${s.label}</span><meter min="0" max="${sc.total || 1}" low="${(sc.total || 1) * 0.6}" high="${(sc.total || 1) * 0.9}" optimum="${sc.total || 1}" value="${sc.good}"></meter><span class="score-num">${sc.good}/${sc.total}</span></div>`; })}
      </div>
      <div class="form-actions">
        <button type="button" class="secondary" data-toggle-audit="${a.id}" aria-expanded="${open ? "true" : "false"}">${open ? "Details verbergen" : "Details en notities"}</button>
        <button type="button" class="secondary" data-audit-tasks="${a.id}">Taken bekijken</button>
        <button type="button" data-print-audit="${a.id}">PDF / afdrukken</button>
      </div>
      ${open ? auditDetails(a) : ""}
    </article>`;
}

function auditDetails(a) {
  const { dom } = ctx;
  return dom`<div class="audit-details">
    ${(a.sections || []).map((s) => dom`
      <div class="review-section">
        <h4>${s.label}</h4>
        <ul class="answer-list">
          ${(s.questions || []).map((q) => dom`<li class="${questionGood(q) ? "ok" : "dev"}">${questionGood(q) ? "✓ " : "✗ "}${describeAnswer(q)}${q.note ? dom`<div class="review-note">Notitie: ${q.note}</div>` : ""}</li>`)}
        </ul>
      </div>`)}
  </div>`;
}

export function renderPrintView(id) {
  const a = audits.find((x) => x.id === id);
  const view = document.getElementById("print-view");
  if (!a || !view) return false;
  const { dom } = ctx;
  const t = auditTotal(a);
  const tasks = (a.taskIds || []).map((tid) => ctx.getTasks().find((x) => x.id === tid)).filter(Boolean);
  const completed = a.completedAt && a.completedAt.toDate ? formatDateTime(a.completedAt.toDate().toISOString()) : "";
  view.replaceChildren(dom`
    <div class="print-doc">
      <header class="print-head">
        <h1>Audit ${formatDate(a.auditDate)}</h1>
        <p>Zeiklijst · afgerond ${completed} · totaalscore ${t.good}/${t.total} (${pct(t.good, t.total)}%) · ${a.taskCount || 0} taken · ${a.notesCount || 0} notities</p>
      </header>
      <table class="print-table">
        <thead><tr><th>Onderdeel</th><th>Score</th><th>Vragen en antwoorden</th></tr></thead>
        <tbody>
          ${(a.sections || []).map((s) => { const sc = s.score || sectionScore(s); return dom`<tr>
            <td><strong>${s.label}</strong></td>
            <td>${sc.good}/${sc.total}</td>
            <td><ul>${(s.questions || []).map((q) => dom`<li class="${questionGood(q) ? "ok" : "dev"}">${questionGood(q) ? "✓ " : "✗ "}${describeAnswer(q)}${q.note ? dom`<br><em>Notitie: ${q.note}</em>` : ""}</li>`)}</ul></td>
          </tr>`; })}
        </tbody>
      </table>
      <h2>Aangemaakte taken</h2>
      ${tasks.length ? dom`<table class="print-table"><thead><tr><th>Taak</th><th>Status nu</th></tr></thead><tbody>${tasks.map((x) => dom`<tr><td>${x.title}</td><td>${x.status === "afgerond" ? "Afgerond" : x.status === "pending" ? "Ter controle" : "Open"}</td></tr>`)}</tbody></table>` : dom`<p>Geen taken.</p>`}
      <p class="print-foot">Made by Jordi-CyX</p>
    </div>`);
  return true;
}

export function printAudit(id) {
  if (!renderPrintView(id)) return;
  document.body.classList.add("print-mode");
  setTimeout(() => window.print(), 50);
}

// ---------- Beheer: locaties, vragenlijst, koppelen ----------
function renderBeheer() {
  const root = document.getElementById("beheer-root");
  if (!root) return;
  const { dom } = ctx;
  // Niet overschrijven terwijl iemand in een invoerveld typt.
  const active = document.activeElement;
  if (active && root.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;
  root.replaceChildren(dom`
    <div class="emp-dash-card">
      <h3>Locatielijst</h3>
      <p class="pin-meta">Medewerkers kiezen bij een nieuwe taak alleen uit de actieve locaties. Een locatie wordt nooit verwijderd, alleen gedeactiveerd (oude taken houden hun naam).</p>
      ${renderLocationsAdmin()}
    </div>
    <div class="emp-dash-card">
      <h3>Oude taken koppelen aan een locatie</h3>
      <p class="pin-meta">Taken zonder vaste locatie, gegroepeerd op hun oude vrije tekst. Koppelen zet alleen de vaste locatie; de oude tekst blijft bewaard.</p>
      ${renderLinkLegacy()}
    </div>
    <div class="emp-dash-card">
      <h3>Vragenlijst en ronde</h3>
      <p class="pin-meta">De volgorde hieronder is de volgorde van de ronde. Een lopende audit houdt de vragen van het moment van starten. In een taaktekst wordt <code>{locatie}</code> vervangen door de naam van het onderdeel.</p>
      ${renderConfigAdmin()}
    </div>`);
  applyFlags(root);
  bindBeheer(root);
}

function renderLocationsAdmin() {
  const { dom } = ctx;
  if (!locationsReady) return dom`<p class="pin-meta">Laden…</p>`;
  if (!locationsDoc) return dom`<button type="button" data-seed-locations>Standaard locatielijst aanmaken (${DEFAULT_LOCATIONS.length})</button>`;
  const items = allLocations();
  return dom`
    <ol class="v2-list">
      ${items.map((l, i) => dom`
        <li class="v2-row${l.active ? "" : " inactive"}">
          <span class="v2-row-main"><strong>${l.label}</strong> <span class="pin-meta">${l.id}</span>${l.active ? "" : dom` <span class="badge paused">Inactief</span>`}${l.staffSelectable ? "" : dom` <span class="badge paused">Alleen admin</span>`}</span>
          <span class="v2-row-actions">
            <button type="button" class="secondary icon-btn" data-loc-up="${i}" aria-label="${`${l.label} omhoog`}" data-disabled="${flag(i === 0)}">↑</button>
            <button type="button" class="secondary icon-btn" data-loc-down="${i}" aria-label="${`${l.label} omlaag`}" data-disabled="${flag(i === items.length - 1)}">↓</button>
            <button type="button" class="secondary" data-loc-rename="${i}">Naam</button>
            <label class="check-row loc-staff"><input type="checkbox" data-loc-staff="${i}" data-checked="${flag(l.staffSelectable)}"> Medewerkers kunnen kiezen</label>
            <button type="button" class="secondary" data-loc-toggle="${i}">${l.active ? "Deactiveren" : "Activeren"}</button>
          </span>
        </li>`)}
    </ol>
    <form class="v2-inline-form" data-loc-add>
      <label>Nieuwe locatie <input type="text" maxlength="40" data-loc-name placeholder="bijv. Pad 22" autocomplete="off"></label>
      <button type="submit">Toevoegen</button>
    </form>`;
}

// Groepeert ongekoppelde taken op hun oude locatietekst; "Pad 16" en "pad 16 " vallen samen.
const legacyKey = (text) => String(text || "").trim().replace(/\s+/g, " ").toLowerCase();

function legacyGroups(includeDone) {
  const groups = new Map();
  for (const t of ctx.getTasks()) {
    if (t.locationId) continue;
    if (!includeDone && t.status === "afgerond") continue;
    const key = legacyKey(t.location);
    if (!groups.has(key)) groups.set(key, { key, texts: new Map(), list: [] });
    const g = groups.get(key);
    const text = String(t.location || "").trim().replace(/\s+/g, " ");
    g.texts.set(text, (g.texts.get(text) || 0) + 1);
    g.list.push(t);
  }
  return [...groups.values()].map((g) => ({
    key: g.key,
    text: [...g.texts.entries()].sort((a, b) => b[1] - a[1])[0][0],
    variants: g.texts.size,
    list: g.list
  })).sort((a, b) => b.list.length - a.list.length || a.key.localeCompare(b.key, "nl"));
}

// Voorstel: een actieve locatie met (bijna) dezelfde naam.
function suggestLocation(key) {
  if (!key) return "";
  const hit = activeLocations().find((l) => legacyKey(l.label) === key || l.id === key.replace(/\s+/g, "-"));
  return hit ? hit.id : "";
}

function renderLinkLegacy() {
  const { dom } = ctx;
  if (!locationsDoc) return dom`<p class="pin-meta">Maak eerst de locatielijst aan.</p>`;
  const groups = legacyGroups(linkIncludeDone);
  return dom`
    <label class="check-row"><input type="checkbox" data-link-done data-checked="${flag(linkIncludeDone)}"> Ook afgeronde taken tonen</label>
    ${groups.length ? dom`<ul class="v2-list">${groups.map(({ key, text, variants, list }) => { const sug = suggestLocation(key); return dom`
      <li class="v2-row link-row" data-link-key="${key}">
        <span class="v2-row-main"><strong>${text || "(geen locatie)"}</strong> <span class="pin-meta">${list.length} ${list.length === 1 ? "taak" : "taken"}${variants > 1 ? ` · ${variants} schrijfwijzen` : ""}</span>
          <span class="pin-meta link-titles">${list.slice(0, 3).map((t) => t.title).join(" · ")}${list.length > 3 ? " …" : ""}</span></span>
        <span class="v2-row-actions">
          <select data-link-select aria-label="${`Locatie voor ${text || "taken zonder locatie"}`}">
            <option value="">Kies locatie…</option>
            ${activeLocations().map((l) => dom`<option value="${l.id}" data-selected="${flag(l.id === sug)}">${l.label}</option>`)}
          </select>
          <button type="button" data-link-go>Koppelen</button>
        </span>
      </li>`; })}</ul>` : dom`<p class="empty-state">Alle taken zijn gekoppeld.</p>`}`;
}

function renderConfigAdmin() {
  const { dom } = ctx;
  if (!auditConfigReady) return dom`<p class="pin-meta">Laden…</p>`;
  if (!auditConfig) return dom`<button type="button" data-seed-config data-disabled="${flag(!locationsDoc)}">Standaard vragenlijst aanmaken</button>${locationsDoc ? "" : dom`<p class="pin-meta">Maak eerst de locatielijst aan.</p>`}`;
  const secs = auditConfig.sections;
  const inRound = new Set(secs.map((s) => s.locationId));
  const addable = activeLocations().filter((l) => !inRound.has(l.id));
  const editing = (si, qi) => editingQuestion && editingQuestion.sectionIndex === si && editingQuestion.questionIndex === qi;
  return dom`
    <p class="pin-meta">Versie ${auditConfig.version} · ${secs.filter((s) => s.active).length} onderdelen in de ronde</p>
    <ol class="v2-list config-list">
      ${secs.map((s, si) => dom`
        <li class="config-section${s.active ? "" : " inactive"}">
          <div class="v2-row">
            <span class="v2-row-main"><strong>${si + 1}. ${sectionLabel(s.locationId)}</strong> <span class="pin-meta">${s.questions.length} vragen</span>${s.active ? "" : dom` <span class="badge paused">Niet in ronde</span>`}</span>
            <span class="v2-row-actions">
              <button type="button" class="secondary icon-btn" data-sec-up="${si}" aria-label="${`${sectionLabel(s.locationId)} eerder in de ronde`}" data-disabled="${flag(si === 0)}">↑</button>
              <button type="button" class="secondary icon-btn" data-sec-down="${si}" aria-label="${`${sectionLabel(s.locationId)} later in de ronde`}" data-disabled="${flag(si === secs.length - 1)}">↓</button>
              <button type="button" class="secondary" data-sec-toggle="${si}">${s.active ? "Uit ronde" : "In ronde"}</button>
            </span>
          </div>
          <details class="config-questions" data-open="${flag(editingQuestion && editingQuestion.sectionIndex === si)}">
            <summary>Vragen (${s.questions.length})</summary>
            <ol class="question-list">
              ${s.questions.map((q, qi) => (editing(si, qi) ? questionEditor(q, si, qi) : dom`<li class="question-row">
                    <div class="question-main">
                      <span>${q.text}</span>
                      <span class="pin-meta">Taak bij ${q.trigger === "ja" ? "Ja" : "Nee"} → ${questionSummary(q)}</span>
                    </div>
                    <span class="v2-row-actions">
                      <button type="button" class="secondary" data-q-edit="${si}:${qi}">Bewerken</button>
                      <button type="button" class="secondary icon-btn" data-q-up="${si}:${qi}" aria-label="Vraag omhoog" data-disabled="${flag(qi === 0)}">↑</button>
                      <button type="button" class="secondary icon-btn" data-q-down="${si}:${qi}" aria-label="Vraag omlaag" data-disabled="${flag(qi === s.questions.length - 1)}">↓</button>
                      <button type="button" class="danger" data-q-del="${si}:${qi}">Verwijderen</button>
                    </span>
                  </li>`))}
              ${editing(si, -1) ? questionEditor({ text: "", trigger: "nee", taskText: `${LOCATION_PLACEHOLDER} - ` }, si, -1) : ""}
            </ol>
            <button type="button" class="secondary" data-q-add="${si}">Vraag toevoegen</button>
          </details>
        </li>`)}
    </ol>
    ${addable.length ? dom`<form class="v2-inline-form" data-sec-add>
      <label>Onderdeel toevoegen aan de ronde
        <select data-sec-new>${addable.map((l) => dom`<option value="${l.id}">${l.label}</option>`)}</select>
      </label>
      <button type="submit">Toevoegen</button>
    </form>` : ""}`;
}

function questionSummary(q) {
  if (q.followUp) return `controlevraag "${q.followUp.text}" (${q.followUp.trigger === "ja" ? "Ja" : "Nee"} → ${q.followUp.taskText})`;
  if (Array.isArray(q.reasons) && q.reasons.length) return `Waarom: ${q.reasons.map((r) => `${r.label} → ${r.taskText}`).join("; ")}`;
  return q.taskText || "(geen taak)";
}

function questionEditor(q, si, qi) {
  const { dom } = ctx;
  const kind = q.followUp ? "follow" : (Array.isArray(q.reasons) && q.reasons.length ? "reasons" : "task");
  const reasonsText = (q.reasons || []).map((r) => `${r.label} | ${r.taskText}`).join("\n");
  const fuTrigger = q.followUp && q.followUp.trigger === "nee" ? "nee" : "ja";
  return dom`<li class="question-editor">
    <form data-q-form="${si}:${qi}" novalidate>
      <label>Vraag <input type="text" name="text" maxlength="200" value="${q.text || ""}"></label>
      <label>Taak bij antwoord
        <select name="trigger"><option value="nee" data-selected="${flag(q.trigger !== "ja")}">Nee</option><option value="ja" data-selected="${flag(q.trigger === "ja")}">Ja</option></select>
      </label>
      <label>Soort
        <select name="kind">
          <option value="task" data-selected="${flag(kind === "task")}">Direct een taak</option>
          <option value="follow" data-selected="${flag(kind === "follow")}">Eerst een controlevraag</option>
          <option value="reasons" data-selected="${flag(kind === "reasons")}">Waarom? (keuzes, taak per keuze)</option>
        </select>
      </label>
      <label data-kind="task">Taaktekst <input type="text" name="taskText" maxlength="120" value="${q.taskText || ""}"></label>
      <fieldset data-kind="follow">
        <legend>Controlevraag</legend>
        <label>Vraag <input type="text" name="fuText" maxlength="200" value="${(q.followUp && q.followUp.text) || "Is er voorraad?"}"></label>
        <label>Taak bij antwoord
          <select name="fuTrigger"><option value="ja" data-selected="${flag(fuTrigger === "ja")}">Ja</option><option value="nee" data-selected="${flag(fuTrigger === "nee")}">Nee</option></select>
        </label>
        <label>Taaktekst <input type="text" name="fuTask" maxlength="120" value="${(q.followUp && q.followUp.taskText) || ""}"></label>
      </fieldset>
      <label data-kind="reasons">Keuzes (één per regel: Keuze | taaktekst)
        <textarea name="reasons" rows="4">${reasonsText}</textarea>
      </label>
      <p class="form-error hidden" data-q-error></p>
      <div class="form-actions">
        <button type="submit">Vraag opslaan</button>
        <button type="button" class="secondary" data-q-cancel>Annuleren</button>
      </div>
    </form>
  </li>`;
}

function syncEditorKind(form) {
  const kind = form.elements.kind.value;
  form.querySelectorAll("[data-kind]").forEach((el) => el.classList.toggle("hidden", el.dataset.kind !== kind));
}

function readQuestionForm(form, section, qi) {
  const f = form.elements;
  const text = f.text.value.trim();
  if (!text) return { error: "Vul de vraag in." };
  const trigger = f.trigger.value === "ja" ? "ja" : "nee";
  const kind = f.kind.value;
  const taken = new Set(section.questions.filter((_, i) => i !== qi).map((q) => q.id));
  const id = qi >= 0 ? section.questions[qi].id : uniqueId(slugify(text, 40), taken, 40);
  const q = { id, text: text.slice(0, 200), trigger };
  if (kind === "task") {
    const t = f.taskText.value.trim();
    if (!t) return { error: "Vul de taaktekst in." };
    q.taskText = t.slice(0, 120);
  } else if (kind === "follow") {
    const fu = f.fuText.value.trim();
    const ft = f.fuTask.value.trim();
    if (!fu || !ft) return { error: "Vul de controlevraag en de taaktekst in." };
    q.followUp = { text: fu.slice(0, 200), trigger: f.fuTrigger.value === "nee" ? "nee" : "ja", taskText: ft.slice(0, 120) };
  } else {
    const lines = f.reasons.value.split("\n").map((l) => l.trim()).filter(Boolean);
    const rTaken = new Set();
    const reasons = [];
    for (const line of lines) {
      const [label, task] = line.split("|").map((x) => (x || "").trim());
      if (!label || !task) return { error: "Elke keuze op een eigen regel: Keuze | taaktekst." };
      const rid = uniqueId(slugify(label, 40), rTaken, 40);
      rTaken.add(rid);
      reasons.push({ id: rid, label: label.slice(0, 60), taskText: task.slice(0, 120) });
    }
    if (!reasons.length) return { error: "Voeg minstens één keuze toe." };
    q.reasons = reasons;
  }
  return { q };
}

function configCopy() {
  return JSON.parse(JSON.stringify(auditConfig.sections));
}

function move(arr, i, d) {
  const j = i + d;
  if (j < 0 || j >= arr.length) return arr;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  return arr;
}

function bindBeheer(root) {
  const on = (sel, fn) => root.querySelectorAll(sel).forEach((el) => { el.onclick = (e) => fn(el, e); });
  on("[data-seed-locations]", () => seedLocations());
  on("[data-seed-config]", () => seedAuditConfig());
  const items = () => allLocations().map((l) => ({ ...l }));
  on("[data-loc-up]", (el) => saveLocations(move(items(), Number(el.dataset.locUp), -1)));
  on("[data-loc-down]", (el) => saveLocations(move(items(), Number(el.dataset.locDown), 1)));
  on("[data-loc-toggle]", async (el) => {
    const list = items();
    const it = list[Number(el.dataset.locToggle)];
    if (it.active) {
      const ok = await ctx.confirmAction(`"${it.label}" deactiveren? Medewerkers kunnen deze locatie dan niet meer kiezen; bestaande taken blijven.`, { title: "Deactiveren", confirmText: "Deactiveren" });
      if (!ok) return;
    }
    it.active = !it.active;
    saveLocations(list);
  });
  root.querySelectorAll("[data-loc-staff]").forEach((box) => {
    box.onchange = () => {
      const list = items();
      const it = list[Number(box.dataset.locStaff)];
      it.staffSelectable = box.checked;
      box.blur();
      saveLocations(list);
    };
  });
  on("[data-loc-rename]", async (el) => {
    const list = items();
    const it = list[Number(el.dataset.locRename)];
    const res = await ctx.showDialog({ title: "Naam wijzigen", message: `Nieuwe naam voor "${it.label}". Het id (${it.id}) blijft gelijk.`, input: true, inputLabel: "Naam", inputValue: it.label, confirmText: "Opslaan" });
    if (!res.ok) return;
    const label = (res.value || "").trim().slice(0, 40);
    if (!label) return;
    if (list.some((x) => x !== it && x.label.toLowerCase() === label.toLowerCase())) {
      ctx.showToast("Die naam bestaat al.");
      return;
    }
    it.label = label;
    saveLocations(list);
  });
  const addForm = root.querySelector("[data-loc-add]");
  if (addForm) addForm.onsubmit = (e) => {
    e.preventDefault();
    const input = addForm.querySelector("[data-loc-name]");
    const label = input.value.trim().slice(0, 40);
    if (!label) return;
    const list = items();
    if (list.some((x) => x.label.toLowerCase() === label.toLowerCase())) {
      ctx.showToast("Die locatie bestaat al.");
      return;
    }
    if (list.length >= 50) {
      ctx.showToast("Maximaal 50 locaties.");
      return;
    }
    list.push({ id: uniqueId(slugify(label), new Set(list.map((x) => x.id))), label, active: true, staffSelectable: true });
    input.value = "";
    input.blur();
    saveLocations(list);
  };
  const linkDone = root.querySelector("[data-link-done]");
  if (linkDone) linkDone.onchange = () => {
    linkIncludeDone = linkDone.checked;
    linkDone.blur();
    renderBeheer();
  };
  on("[data-link-go]", async (el) => {
    const row = el.closest("[data-link-key]");
    const key = row ? row.dataset.linkKey : null;
    const group = legacyGroups(linkIncludeDone).find((g) => g.key === key);
    const select = row && row.querySelector("[data-link-select]");
    const locId = select && select.value;
    if (select) select.blur();
    if (!group || !locId) {
      ctx.showToast(group ? "Kies eerst een locatie." : "Deze groep is net gewijzigd; probeer opnieuw.");
      return;
    }
    const { text, list } = group;
    const ok = await ctx.confirmAction(`${list.length} ${list.length === 1 ? "taak" : "taken"} met "${text || "geen locatie"}" koppelen aan ${locationLabelById(locId)}? De oude tekst blijft bewaard.`, { title: "Koppelen", confirmText: "Koppelen" });
    if (!ok) return;
    const done = await ctx.safeWrite(async () => {
      for (let i = 0; i < list.length; i += AUDIT_SETTINGS.batchSize) {
        const batch = writeBatch(db);
        for (const t of list.slice(i, i + AUDIT_SETTINGS.batchSize)) batch.update(doc(db, "tasks", t.id), { locationId: locId });
        await batch.commit();
      }
    });
    if (done) ctx.showToast(`${list.length} gekoppeld aan ${locationLabelById(locId)}.`, "ok");
  });
  // Vragenlijst
  const saveSecs = (secs) => saveConfig(secs, auditConfig.version);
  on("[data-sec-up]", (el) => saveSecs(move(configCopy(), Number(el.dataset.secUp), -1)));
  on("[data-sec-down]", (el) => saveSecs(move(configCopy(), Number(el.dataset.secDown), 1)));
  on("[data-sec-toggle]", (el) => {
    const secs = configCopy();
    const s = secs[Number(el.dataset.secToggle)];
    s.active = !s.active;
    saveSecs(secs);
  });
  const secAdd = root.querySelector("[data-sec-add]");
  if (secAdd) secAdd.onsubmit = (e) => {
    e.preventDefault();
    const sel = secAdd.querySelector("[data-sec-new]");
    const id = sel.value;
    sel.blur();
    if (!id) return;
    const secs = configCopy();
    secs.push({ locationId: id, active: true, questions: [] });
    editingQuestion = { sectionIndex: secs.length - 1, questionIndex: -1 };
    saveSecs(secs);
  };
  const pair = (v) => v.split(":").map(Number);
  on("[data-q-edit]", (el) => {
    const [si, qi] = pair(el.dataset.qEdit);
    editingQuestion = { sectionIndex: si, questionIndex: qi };
    renderBeheer();
  });
  on("[data-q-add]", (el) => {
    editingQuestion = { sectionIndex: Number(el.dataset.qAdd), questionIndex: -1 };
    renderBeheer();
  });
  on("[data-q-up]", (el) => {
    const [si, qi] = pair(el.dataset.qUp);
    const secs = configCopy();
    move(secs[si].questions, qi, -1);
    saveSecs(secs);
  });
  on("[data-q-down]", (el) => {
    const [si, qi] = pair(el.dataset.qDown);
    const secs = configCopy();
    move(secs[si].questions, qi, 1);
    saveSecs(secs);
  });
  on("[data-q-del]", async (el) => {
    const [si, qi] = pair(el.dataset.qDel);
    const secs = configCopy();
    const q = secs[si].questions[qi];
    const ok = await ctx.confirmAction(`Vraag "${q.text}" verwijderen uit ${sectionLabel(secs[si].locationId)}?`, { title: "Vraag verwijderen", confirmText: "Verwijderen", danger: true });
    if (!ok) return;
    secs[si].questions.splice(qi, 1);
    saveSecs(secs);
  });
  root.querySelectorAll("[data-q-form]").forEach((form) => {
    const [si, qi] = pair(form.dataset.qForm);
    syncEditorKind(form);
    form.elements.kind.onchange = () => syncEditorKind(form);
    form.querySelector("[data-q-cancel]").onclick = () => {
      editingQuestion = null;
      renderBeheer();
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const secs = configCopy();
      const res = readQuestionForm(form, secs[si], qi);
      const err = form.querySelector("[data-q-error]");
      if (res.error) {
        err.textContent = res.error;
        err.classList.remove("hidden");
        return;
      }
      if (qi >= 0) secs[si].questions[qi] = res.q;
      else secs[si].questions.push(res.q);
      editingQuestion = null;
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      await saveSecs(secs);
    };
  });
}

// ---------- Dashboard en Data ----------
function renderDashboardV2() {
  const root = document.getElementById("dashboard-v2");
  if (!root) return;
  const { dom } = ctx;
  const tasks = ctx.getTasks();
  const urgent = tasks.filter((t) => t.urgent && t.status !== "afgerond");
  const auditOpen = tasks.filter((t) => t.source && t.source.type === "audit" && t.status !== "afgerond");
  const setup = [];
  if (locationsReady && !locationsDoc) setup.push(dom`<button type="button" data-seed-locations>Locatielijst aanmaken</button>`);
  if (auditConfigReady && !auditConfig && locationsDoc) setup.push(dom`<button type="button" data-seed-config>Vragenlijst aanmaken</button>`);
  const legacy = legacyPendingTasks().length;
  if (legacy) setup.push(dom`<button type="button" class="secondary" data-goto-data>${legacy} oude afvinkers verplaatsen (Data)</button>`);
  const a = activeAuditDoc;
  const last = completedAudits()[0];
  const lt = last ? auditTotal(last) : null;
  root.replaceChildren(dom`
    ${setup.length ? dom`<div class="v2-setup"><p><strong>Nieuwe functies instellen:</strong></p><div class="form-actions">${setup}</div></div>` : ""}
    <div class="stat-cards dashboard-stats v2-stats">
      <button type="button" class="stat-card stat-urgent" data-dash-urgent>
        <span class="stat-value">${urgent.length}</span>
        <span class="stat-label">Spoed open</span>
      </button>
      <button type="button" class="stat-card stat-audit" data-dash-audit-tasks>
        <span class="stat-value">${auditOpen.length}</span>
        <span class="stat-label">Open audit-taken</span>
      </button>
      <button type="button" class="stat-card stat-audit-run" data-dash-audit>
        <span class="stat-value">${a ? "▶" : (lt ? `${pct(lt.good, lt.total)}%` : "–")}</span>
        <span class="stat-label">${a ? "Audit hervatten" : (last ? `Laatste audit ${formatDate(last.auditDate)}` : "Audit lopen")}</span>
      </button>
    </div>`);
  const on = (sel, fn) => { const el = root.querySelector(sel); if (el) el.onclick = fn; };
  on("[data-seed-locations]", () => seedLocations());
  on("[data-seed-config]", () => seedAuditConfig());
  on("[data-goto-data]", () => ctx.showSection("data"));
  on("[data-dash-urgent]", () => ctx.showSection("taken", true, { filters: { status: "all", urgent: "yes" } }));
  on("[data-dash-audit-tasks]", () => ctx.showSection("taken", true, { filters: { status: "all", audit: "any" } }));
  on("[data-dash-audit]", () => ctx.showSection(a || !last ? "audit" : "audits"));
}

function renderDataV2() {
  const root = document.getElementById("data-v2");
  if (!root) return;
  const { dom } = ctx;
  const legacy = legacyPendingTasks().length;
  const moved = [...completions.values()].filter((c) => c.legacy).length;
  root.replaceChildren(dom`
    <h3>Volledige back-up (ruw)</h3>
    <p class="section-intro">Download alle gegevens zoals ze in de database staan: taken, streefdatums, afgerond-door, herhalingen, medewerkers, extra gegevens, meldingen, locaties, vragenlijst en audits. Bewaar dit bestand vóór elke grote wijziging. Startcodes zitten er niet in.</p>
    <div class="form-actions"><button type="button" data-raw-backup>Volledige back-up downloaden</button></div>
    <h3>Afvinkers verplaatsen (eenmalig)</h3>
    <p class="section-intro">Wie een taak afvinkte, stond tot nu toe op de taak zelf (zichtbaar voor medewerkers). Vanaf deze versie staat dat in een lijst die alleen de admin ziet. ${legacy ? `Nog ${legacy} taken met een oude afvinker.` : "Er staan geen oude afvinkers meer op taken."}</p>
    <div class="form-actions">
      <button type="button" data-migrate-pending data-disabled="${flag(!legacy)}">Back-up + afvinkers verplaatsen</button>
      <button type="button" class="secondary" data-restore-pending data-disabled="${flag(!moved)}">Noodknop: terugzetten (${moved})</button>
    </div>`);
  applyFlags(root);
  root.querySelector("[data-raw-backup]").onclick = () => exportRawBackup();
  root.querySelector("[data-migrate-pending]").onclick = () => migratePendingBy();
  root.querySelector("[data-restore-pending]").onclick = () => restorePendingBy();
}

// Voor de takenlijst: hoort de taak bij een audit?
export function taskMatchesAudit(task, auditFilter) {
  if (!auditFilter || auditFilter === "all") return true;
  if (!task.source || task.source.type !== "audit") return false;
  return auditFilter === "any" || task.source.auditId === auditFilter;
}

export function sourceText(task) {
  if (!task.source || task.source.type !== "audit") return "";
  const label = locationLabelById(task.source.locationId) || task.location || "";
  return `Audit · ${task.source.auditDate ? formatDate(task.source.auditDate) : ""}${label ? ` · ${label}` : ""}`;
}
