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
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";
import { db, localDateKey, amsterdamDateKey, formatDate, formatDateTime } from "../shared.js";
import { buildExportSheets, buildXlsx, XLSX_MIME } from "./xlsx-export.js?v=30";
import { AUDIT_SETTINGS, LOCATION_PLACEHOLDER, DEFAULT_LOCATIONS, defaultAuditSections } from "./audit-defaults.js?v=30";
import {
  DEFAULT_VARIANT_ID, VARIANT_NAME_MAX, RANBY_MAX, CUSTOM_TASK_TEXT_MAX,
  variantIdOf, normalizeVariant, mergeVariants, previousSameVariant, compareRows, cleanCustomTask, customTaskTitle
} from "./v3a-logic.js?v=30";
import { FEATURES, DEPARTMENTS, DEPARTMENT_LABELS, normalizeDepartment, departmentsFromDoc, planDepartments, locationDepartmentFields } from "./v3b-logic.js?v=30";
import { BANK_MAX, normalizeBankQuestion, bankPayload, bankFromQuestion, questionFromBank, sameQuestionText, sortBank } from "./v3c-logic.js?v=30";
import { applyFolds } from "./v3c.js?v=30";

let ctx = null;
let locationsDoc = null; // { items } of null (nog niet aangemaakt)
let locationsReady = false;
let auditConfig = null; // { version, sections } of null
let auditConfigReady = false;
// V3A punt 7: audit-varianten (auditVariants/{id}); auditConfig/current telt als virtuele variant "standaard".
let variantDocs = [];
let variantsReady = false;
let editVariantId = localStorage.getItem("zeiklijst-admin-edit-variant") || "";
let startVariantId = localStorage.getItem("zeiklijst-admin-start-variant") || "";
let historyVariant = null; // null = automatisch (variant van de laatste audit), "all" = alle
let ctDraft = null; // open formulier "Zelf aanmaken": { si, qi, text, assigneeId, urgent, dueDate, focus }
let deletingAudit = false;
const RANBY_KEY = "zeiklijst-admin-audit-ranby";
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
// V3C punt 5: welke "Vragen (n)"-blokken open staan (per variant + onderdeel), zodat ze na opslaan/verwijderen open blijven.
const openQuestionBlocks = new Set();
// V3C punt 6: vragenbank (questionBank/{id}), alleen admin.
let bankDocs = [];
let bankReady = false;
let bankError = false;
let bankEditing = null; // null | { id: "" (nieuw) of doc-id }
const AUDIT_POS_KEY = "zeiklijst-admin-audit-pos";
const noop = () => {};

// ---------- Init en listeners ----------
export function initV2(context) {
  ctx = context;
  window.addEventListener("afterprint", () => document.body.classList.remove("print-mode"));
}

export function startV2Listeners() {
  // K3: niet-bewaarde audit-antwoorden direct wegschrijven als de app naar de achtergrond gaat.
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushDraft(); });
  window.addEventListener("pagehide", flushDraft);
  window.addEventListener("offline", () => {
    if (draft) ctx.showToast("Geen verbinding: je antwoorden blijven op dit toestel en worden verstuurd zodra je weer online bent.");
  });
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
  // Zonder nieuwe regels (nog niet live) faalt dit met permission-denied: dan blijft auditConfig/current de enige variant.
  onSnapshot(collection(db, "auditVariants"), (snap) => {
    variantDocs = snap.docs.map((d) => normalizeVariant(d.id, d.data()));
    variantsReady = true;
    renderV2();
  }, () => {
    variantsReady = true;
    renderV2();
  });
  // V3C: zonder nieuwe regels (nog niet live) faalt dit met permission-denied; de kaart toont dan een melding.
  onSnapshot(query(collection(db, "questionBank"), limit(BANK_MAX)), (snap) => {
    bankDocs = sortBank(snap.docs.map((d) => ({ id: d.id, createdAt: (d.data() || {}).createdAt || null, ...normalizeBankQuestion(d.data()) })).filter((q) => q.text));
    bankReady = true;
    bankError = false;
    renderBeheer();
  }, () => {
    bankReady = true;
    bankError = true;
    renderBeheer();
  });
  onSnapshot(query(collection(db, "audits"), orderBy("startedAt", "desc"), limit(AUDIT_SETTINGS.historyLimit)), (snap) => {
    audits = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderV2();
  }, noop);
  onSnapshot(query(collection(db, "audits"), where("status", "==", "bezig"), limit(1)), (snap) => {
    activeAuditDoc = snap.empty ? null : { id: snap.docs[0].id, data: snap.docs[0].data() };
    if (!snap.empty) checkRemoteDraft(snap.docs[0]);
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
  // V3B: afdeling per pad (map gaat voor items[].department, net als in ZL).
  const depts = departmentsFromDoc(data);
  const items = (Array.isArray(data.items) ? data.items : [])
    .filter((it) => it && typeof it.id === "string" && typeof it.label === "string")
    .map((it, i) => ({ id: it.id, label: it.label, order: Number(it.order) || i + 1, active: it.active !== false, staffSelectable: it.staffSelectable !== false, department: depts[it.id] || "" }))
    .sort((a, b) => a.order - b.order);
  return { items, hasDepartments: Boolean(data.departments && typeof data.departments === "object") };
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
  const base = items.map((it, i) => ({ id: it.id, label: it.label, order: i + 1, active: it.active !== false, staffSelectable: it.staffSelectable !== false, department: normalizeDepartment(it.department) }));
  // V3B: items[].department en de map departments gelijk houden. Zonder afdelingen (en zonder eerdere map)
  // blijft het doc precies zoals in v28 (geen departments-veld).
  const { items: sorted, departments } = locationDepartmentFields(base);
  const withMap = FEATURES.departments && (Object.keys(departments).length > 0 || (locationsDoc && locationsDoc.hasDepartments));
  // labels = wat medewerkers mogen kiezen (de regels controleren een nieuwe medewerkerstaak hiertegen):
  // alleen actief én staffSelectable. De admin (en audit-taken) mag elke locatie gebruiken.
  const labels = {};
  for (const it of sorted) if (it.active && it.staffSelectable) labels[it.id] = it.label;
  const data = { items: sorted, labels, updatedAt: serverTimestamp() };
  if (withMap) data.departments = departments;
  return ctx.safeWrite(() => setDoc(doc(db, "settings", "locations"), data));
}

export function locationDepartment(id) {
  const loc = allLocations().find((l) => l.id === id);
  return loc ? loc.department || "" : "";
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
  if (variants().length) return;
  const ok = await ctx.confirmAction("De standaard vragenlijst en ronde aanmaken (volgens de afspraken van 19-11)? Dit wordt de variant \"Standaard\".", { title: "Vragenlijst", confirmText: "Aanmaken" });
  if (!ok) return;
  const [a, b] = await Promise.all([getDoc(doc(db, "auditConfig", "current")), getDoc(doc(db, "auditVariants", DEFAULT_VARIANT_ID))]);
  if (a.exists() || b.exists()) return; // nooit overschrijven
  const v = { id: DEFAULT_VARIANT_ID, name: "Standaard", compare: true, active: true, order: 1, version: 0, sections: [], virtual: true };
  if (await saveVariant(v, { sections: defaultAuditSections() })) ctx.showToast("Vragenlijst aangemaakt.", "ok");
}

// ---------- V3A punt 7: varianten ----------
function variants() {
  return mergeVariants(variantDocs, auditConfig);
}

function variantById(id) {
  return variants().find((v) => v.id === id) || null;
}

function configReady() {
  return auditConfigReady && variantsReady;
}

function editVariant() {
  const list = variants();
  return list.find((v) => v.id === editVariantId) || list[0] || null;
}

function startVariant() {
  const list = variants().filter((v) => v.active);
  return list.find((v) => v.id === startVariantId) || list[0] || null;
}

function auditVariantName(a) {
  const v = variantById(variantIdOf(a));
  return (v && v.name) || a.variantName || "Standaard";
}

// Vergelijken volgt de huidige instelling van de variant; bestaat die niet meer, dan de stand bij het lopen.
function auditCompares(a) {
  const v = variantById(variantIdOf(a));
  return v ? v.compare : a.compare !== false;
}

// Schrijft de hele variant (ook de eerste keer voor de virtuele "standaard": zo wordt auditConfig/current
// zonder script de eerste variant). version gaat alleen omhoog als de vragenlijst verandert.
function saveVariant(v, patch = {}) {
  const sections = patch.sections || v.sections;
  const clean = JSON.parse(JSON.stringify(sections.map((s, i) => ({ ...s, order: i + 1 }))));
  const data = {
    name: String(patch.name ?? v.name).trim().slice(0, VARIANT_NAME_MAX),
    compare: Boolean(patch.compare ?? v.compare),
    active: Boolean(patch.active ?? v.active),
    order: Number(patch.order ?? v.order) || 1,
    version: Math.max(1, (Number(v.version) || 0) + (patch.sections ? 1 : 0)),
    sections: clean,
    updatedAt: serverTimestamp()
  };
  const isNew = v.virtual || patch.create;
  if (isNew) data.createdAt = Timestamp.now();
  return ctx.safeWrite(() => setDoc(doc(db, "auditVariants", v.id), data, { merge: !isNew }));
}

// Vult een <select> met actieve locaties. Eigenaar 13:01: de admin kiest altijd een locatie, dus standaard
// een niet-kiesbare placeholder "Kies een locatie" in plaats van "Geen locatie".
export function fillLocationSelect(select, currentId = "", { placeholder = "Kies een locatie", noneLabel = "" } = {}) {
  if (!select) return;
  const opts = [];
  if (noneLabel) opts.push(["", noneLabel, false]);
  else if (placeholder) opts.push(["", placeholder, true]);
  for (const loc of activeLocations()) opts.push([loc.id, loc.label]);
  if (currentId && !opts.some(([v]) => v === currentId)) {
    const label = locationLabelById(currentId) || currentId;
    opts.push([currentId, `${label} (inactief)`]);
  }
  select.replaceChildren(...opts.map(([v, l, disabled]) => {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = l;
    if (disabled) o.disabled = true;
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

// ---------- Ruwe back-up ----------
const BACKUP_COLLECTIONS = [
  "tasks", "taskMeta", "taskCompletions", "recurring", "employees", "employeeDetails", "staffProfiles", "reports",
  "staffAccounts", "pinResetRequests", "pinResetLimits", "staffDailyCounters", "settings", "auditConfig", "audits",
  "auditVariants", // V3A: audit-varianten
  "questionBank" // V3C: standaardvragen
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
  exportBusy += 1;
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
    a.download = `zeiklijst-backup-${amsterdamStamp()}.json`; // B14: Amsterdamse tijd, niet UTC
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    ctx.showToast("Back-up gedownload.", "ok");
    return true;
  } catch {
    ctx.showToast("Back-up maken is mislukt.");
    return false;
  } finally {
    exportBusy -= 1;
  }
}

// B14: "2026-11-23-07-44" in Europe/Amsterdam.
export function amsterdamStamp(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}-${parts.hour}-${parts.minute}`;
}

// ---------- Excel-export (alleen-lezen, eigenaar 13:16) ----------
// Alleen collecties met een vaste kolomlijst; geheimen (staffAccounts, startCodes, nameIndex, pins) worden niet eens gelezen.
const EXCEL_COLLECTIONS = ["tasks", "taskMeta", "taskCompletions", "recurring", "employees", "employeeDetails", "reports", "audits"];
export async function exportExcel() {
  exportBusy += 1;
  try {
    const data = {};
    for (const name of EXCEL_COLLECTIONS) {
      try {
        const snap = await getDocs(collection(db, name));
        data[name] = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
      } catch {
        data[name] = [];
      }
    }
    const sheets = buildExportSheets(data, { locationLabel: (id) => locationLabelById(id), auditTotal });
    const blob = new Blob([buildXlsx(sheets)], { type: XLSX_MIME });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `zeiklijst-export-${amsterdamDateKey()}.xlsx`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    ctx.showToast("Excel-export gedownload.", "ok");
    return true;
  } catch {
    ctx.showToast("Excel-export maken is mislukt.");
    return false;
  } finally {
    exportBusy -= 1;
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
  if (q.mode === "zelf") return Array.isArray(q.customTasks) && q.customTasks.length > 0;
  if (q.followUp) return q.followUpAnswer === "ja" || q.followUpAnswer === "nee";
  if (Array.isArray(q.reasons) && q.reasons.length) return Array.isArray(q.reasonIds) && q.reasonIds.length > 0;
  return true;
}

function sectionComplete(s) {
  return (s.questions || []).every(questionComplete);
}

function questionGood(q) {
  if (q.answer !== q.trigger) return true;
  if (q.mode === "zelf") return false;
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
  if (q.mode === "zelf") {
    // "Zelf aanmaken": alleen de eigen taken, geen standaardtaak (ideeëndoc punt 7).
    return (q.customTasks || []).map((c) => ({
      ...base,
      custom: c,
      title: customTaskTitle(label, c.text),
      id: `audit-${auditId}-${s.locationId}-${q.id}-c${c.id}`,
      auditId,
      auditDate
    }));
  }
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
  if (q.mode === "zelf" && q.answer === q.trigger) {
    const n = (q.customTasks || []).length;
    parts.push(`Zelf aangemaakt: ${n} ${n === 1 ? "taak" : "taken"}`);
  }
  return parts.join(" · ");
}

function taskPayload(t) {
  const q = t.question;
  // Eigenaar 13:01: audit-notities alleen in de audit en de PDF, niet in de taak (die lezen alle medewerkers).
  const lines = [`Audit ${formatDate(t.auditDate)} · ${t.label}`, describeAnswer(q)];
  if (t.custom) lines.push("", t.custom.text);
  const source = { type: "audit", auditId: t.auditId, auditDate: t.auditDate, locationId: t.locationId, questionId: t.questionId };
  if (t.reasonId) source.reasonId = t.reasonId;
  return {
    title: t.title,
    description: lines.join("\n").slice(0, 2000),
    assigneeId: t.custom ? t.custom.assigneeId : "ALLEN",
    assigneeName: t.custom ? t.custom.assigneeName : "Allen",
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
    urgent: Boolean(t.custom && t.custom.urgent),
    source
  };
}

function buildSnapshot(variant) {
  const sections = (variant ? variant.sections : [])
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
    ...(data.variantId ? { variantId: data.variantId } : {}),
    ...(typeof data.variantName === "string" ? { variantName: data.variantName } : {}),
    ...(typeof data.compare === "boolean" ? { compare: data.compare } : {}),
    ...(typeof data.ranBy === "string" ? { ranBy: data.ranBy } : {}),
    sections: JSON.parse(JSON.stringify(data.sections || []))
  };
}

// Stabiele JSON (gesorteerde sleutels), om de eigen versie met die uit Firestore te vergelijken.
function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(",")}}`;
  return JSON.stringify(v === undefined ? null : v);
}
let lastSavedJson = null; // secties zoals dit toestel ze het laatst bewaarde of laadde
let savePending = false;

function scheduleSave(immediate = false) {
  if (!draft) return;
  clearTimeout(draftSaveTimer);
  savePending = true;
  const run = () => {
    savePending = false;
    saveDraft().catch(() => ctx.showToast("Bewaren van de audit is mislukt. Probeer het opnieuw."));
  };
  if (immediate) run();
  else draftSaveTimer = setTimeout(run, 600);
}

function flushDraft() {
  if (savePending) scheduleSave(true);
}

// Auto-verversen: vóór herladen het concept bewaren (max. 3 s wachten op de server).
export async function saveDraftNow() {
  clearTimeout(draftSaveTimer);
  savePending = false;
  if (!draft || finishing) return;
  try {
    await Promise.race([saveDraft(), new Promise((res) => setTimeout(res, 3000))]);
  } catch {
    // offline of mislukt: de Firestore-wachtrij bewaart de write lokaal
  }
}

let exportBusy = 0;
// Auto-verversen: niet herladen tijdens Audit lopen, vraag-editor, export of print.
export function isV2Busy() {
  const auditVisible = !document.getElementById("section-audit")?.classList.contains("hidden");
  if (draft && auditMode !== "start" && auditVisible) return true;
  if (savePending || finishing || exportBusy > 0) return true;
  if (document.body.classList.contains("print-mode")) return true;
  if (deletingAudit || (ctDraft && String(ctDraft.text || "").trim())) return true;
  return Boolean(document.querySelector("[data-q-form], [data-variant-add] input:not(:placeholder-shown)"));
}

async function saveDraft() {
  if (!draft || finishing) return;
  const { id, ...rest } = draft;
  lastSavedJson = stableJson(draft.sections);
  // Zonder verbinding komt de write in de wachtrij van Firestore; niet wachten op de server.
  const p = setDoc(doc(db, "audits", id), { ...rest, status: "bezig", updatedAt: serverTimestamp() });
  if (!navigator.onLine) return;
  await p;
}

// K3: is de lopende audit op een ander apparaat gewijzigd? Dan de nieuwste versie laden en waarschuwen.
function checkRemoteDraft(snapDoc) {
  if (!draft || finishing || !snapDoc || draft.id !== snapDoc.id) return;
  if (snapDoc.metadata && snapDoc.metadata.hasPendingWrites) return;
  const remote = snapDoc.data();
  const remoteJson = stableJson(remote.sections || []);
  if (lastSavedJson === null || remoteJson === lastSavedJson) return;
  if (savePending) {
    ctx.showToast("Let op: deze audit is ook op een ander apparaat gewijzigd. Jouw laatste antwoorden worden bewaard.");
    return;
  }
  draft.sections = JSON.parse(JSON.stringify(remote.sections || []));
  lastSavedJson = remoteJson;
  auditPos = Math.min(auditPos, Math.max(0, draft.sections.length - 1));
  ctx.showToast("Deze audit is op een ander apparaat bijgewerkt; de nieuwste versie staat nu hier.");
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
  // B1: tekst in een <textarea> nooit via de template (raw text), maar via .value.
  root.querySelectorAll("textarea[data-initial]").forEach((el) => {
    el.value = el.getAttribute("data-initial");
    el.removeAttribute("data-initial");
  });
}
const flag = (b) => (b ? "1" : "");

async function startAudit() {
  if (activeAuditDoc) {
    resumeAudit();
    return;
  }
  const variant = startVariant();
  if (!locationsDoc || !variant) {
    ctx.showToast("Maak eerst de locatielijst (Locaties) en de vragenlijst (Audits) aan.");
    return;
  }
  const sections = buildSnapshot(variant);
  if (!sections.length) {
    ctx.showToast(`De ronde van "${variant.name}" heeft geen actieve onderdelen met vragen.`);
    return;
  }
  // Punt 7: wie de audit loopt (komt op pagina 1 van de PDF); dit toestel onthoudt de laatste naam.
  const res = await ctx.showDialog({
    title: "Audit starten",
    message: `Variant: ${variant.name}${variant.compare ? " (wordt vergeleken met eerdere audits van deze variant)" : ""}. Wie loopt de audit?`,
    input: true,
    inputLabel: "Gelopen door",
    inputValue: localStorage.getItem(RANBY_KEY) || "",
    confirmText: "Starten"
  });
  if (!res || !res.ok) return;
  const ranBy = String(res.value || "").trim().slice(0, RANBY_MAX);
  if (!ranBy) {
    ctx.showToast("Vul in wie de audit loopt.");
    return;
  }
  localStorage.setItem(RANBY_KEY, ranBy);
  if (activeAuditDoc) {
    resumeAudit();
    return;
  }
  const ref = doc(collection(db, "audits"));
  draft = {
    id: ref.id, status: "bezig", auditDate: amsterdamDateKey(), startedAt: Timestamp.now(), configVersion: variant.version,
    variantId: variant.id, variantName: variant.name, compare: variant.compare, ranBy, sections
  };
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
  if (!draft || draft.id !== activeAuditDoc.id) {
    draft = draftFromDoc(activeAuditDoc.id, activeAuditDoc.data);
    lastSavedJson = stableJson(draft.sections);
  }
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
  // K4: zonder verbinding wacht Firestore met bevestigen tot het weer online is.
  if (!navigator.onLine) ctx.showToast("Geen verbinding: de audit en de taken worden verstuurd zodra je weer online bent. Laat de app open.");
  const slowTimer = setTimeout(() => ctx.showToast("Nog niet verstuurd: wacht op verbinding. Laat de app open; het gaat vanzelf verder."), 6000);
  const done = await ctx.safeWrite(async () => {
    const todo = list.filter((t) => !existing.has(t.id)); // herhaalpoging: geen dubbele taken
    let batch = writeBatch(db);
    let n = 0;
    for (const t of todo) {
      batch.set(doc(db, "tasks", t.id), taskPayload(t));
      n += 1;
      // Streefdatum van een zelf aangemaakte taak staat (zoals bij gewone taken) in taskMeta.
      if (t.custom && t.custom.dueDate) {
        batch.set(doc(db, "taskMeta", t.id), { dueDate: t.custom.dueDate });
        n += 1;
      }
      if (n >= AUDIT_SETTINGS.batchSize) {
        await batch.commit();
        batch = writeBatch(db);
        n = 0;
      }
    }
    batch.set(doc(db, "audits", id), finalDoc); // laatste batch: audit pas daarna "afgerond"
    await batch.commit();
  });
  clearTimeout(slowTimer);
  finishing = false;
  if (!done) return;
  localStorage.removeItem(AUDIT_POS_KEY);
  draft = null;
  auditMode = "start";
  historyOpen = new Set([id]);
  ctx.showToast(`Audit afgerond: ${list.length} ${list.length === 1 ? "taak" : "taken"} aangemaakt.`, "ok");
  ctx.showSection("audits");
  renderV2();
  // B15 (v3a): samenvatting met doorklik naar de taken van deze audit (PDF staat in de historie).
  const tot = auditTotal({ ...finalDoc, id });
  const pctText = tot && tot.total ? `${pct(tot.good, tot.total)}%` : "–";
  const view = await ctx.confirmAction(
    `Audit opgeslagen. Score ${pctText}, ${list.length} ${list.length === 1 ? "taak" : "taken"} aangemaakt, ${notesCount} ${notesCount === 1 ? "notitie" : "notities"}. De PDF staat bij deze audit in de historie.`,
    { title: "Audit afgerond", confirmText: "Taken bekijken", cancelText: "Sluiten" }
  );
  if (view && list.length) ctx.showSection("taken", true, { filters: { status: "all", audit: id } });
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
  if (section === "audits" && historyOpen.size && !editingQuestion && !bankEditing) return { label: "Audits", up: () => { historyOpen.clear(); renderHistory(); } };
  if (section === "audits" && (editingQuestion || bankEditing)) return { label: "Audits", up: () => { editingQuestion = null; bankEditing = null; renderBeheer(); } };
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
  const ae = document.activeElement;
  if (auditMode === "run" && root.contains(ae) && (ae.tagName === "TEXTAREA" || (ae.closest && ae.closest("[data-ct-form]")))) return;
  const { dom } = ctx;
  if (activeAuditDoc && draft && draft.id !== activeAuditDoc.id && !finishing) draft = null;
  if (auditMode !== "start" && !draft) auditMode = "start";
  if (auditMode === "start") {
    const missing = [];
    if (locationsReady && !locationsDoc) missing.push("locatielijst");
    if (configReady() && !variants().length) missing.push("vragenlijst");
    const startable = variants().filter((v) => v.active);
    const sv = startVariant();
    const a = activeAuditDoc;
    const secs = a ? (a.data.sections || []) : [];
    const answered = secs.filter(sectionComplete).length;
    root.replaceChildren(dom`
      <div class="audit-start">
        ${missing.length ? dom`<div class="v2-setup"><p>Nog niet ingesteld: ${missing.join(" en ")}. Ga naar <strong>${missing.includes("locatielijst") ? "Locaties" : "Audits"}</strong> om de standaardlijst aan te maken.</p><button type="button" data-goto-beheer data-goto="${missing.includes("locatielijst") ? "beheer" : "audits"}">Naar ${missing.includes("locatielijst") ? "Locaties" : "Audits"}</button></div>` : ""}
        ${a ? dom`
          <div class="audit-resume">
            <p><strong>Er loopt een audit</strong> (${auditVariantName(a.data)}) van ${formatDate(a.data.auditDate)}${a.data.ranBy ? `, gelopen door ${a.data.ranBy}` : ""}: ${answered} van ${secs.length} onderdelen ingevuld.</p>
            <button type="button" class="audit-big" data-resume>Audit hervatten</button>
            <button type="button" class="secondary" data-discard>Lopende audit verwijderen</button>
          </div>` : dom`
          <div>
            <p class="section-intro">Kies de variant en loop de ronde langs alle onderdelen. Elk onderdeel is verplicht. Bij een afwijking maakt de app na de controle een standaardtaak voor iedereen, of je maakt zelf één of meer taken aan.</p>
            ${startable.length > 1 ? dom`<label class="audit-variant-pick">Variant
              <select data-start-variant>${startable.map((v) => dom`<option value="${v.id}" data-selected="${flag(sv && v.id === sv.id)}">${v.name}</option>`)}</select>
            </label>` : ""}
            <button type="button" class="audit-big" data-start data-disabled="${flag(missing.length || !sv)}">Audit starten${sv && startable.length > 1 ? ` (${sv.name})` : ""}</button>
            ${sv ? dom`<p class="pin-meta">Ronde: ${sv.sections.filter((s) => s.active).map((s) => sectionLabel(s.locationId)).join(" → ")}</p>
            <p class="pin-meta">Vergelijken: ${sv.compare ? "aan (de PDF vergelijkt met de vorige 2 audits van deze variant)" : "uit"}</p>` : ""}
          </div>`}
      </div>`);
    applyFlags(root);
    const b = (sel, fn) => { const el = root.querySelector(sel); if (el) el.onclick = fn; };
    b("[data-start]", startAudit);
    b("[data-resume]", resumeAudit);
    b("[data-discard]", discardAudit);
    b("[data-goto-beheer]", (e) => ctx.showSection((e.currentTarget && e.currentTarget.dataset.goto) || "beheer"));
    const pick = root.querySelector("[data-start-variant]");
    if (pick) pick.onchange = () => {
      startVariantId = pick.value;
      localStorage.setItem("zeiklijst-admin-start-variant", startVariantId);
      pick.blur();
      renderAudit();
    };
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
        <span class="audit-step">${draft.variantName || "Standaard"} · onderdeel ${auditPos + 1} van ${total}</span>
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
  if (ctDraft && ctDraft.focus) {
    ctDraft.focus = false;
    const f = root.querySelector("[data-ct-form] [data-ct-text]");
    if (f) f.focus();
  }
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
      ${showExtra ? dom`
        <div class="audit-mode" role="group" aria-label="Welke taak?">
          <button type="button" class="audit-reason" data-mode="standaard" aria-pressed="${q.mode === "zelf" ? "false" : "true"}">Standaard taak</button>
          <button type="button" class="audit-reason" data-mode="zelf" aria-pressed="${q.mode === "zelf" ? "true" : "false"}">Zelf aanmaken</button>
        </div>` : ""}
      ${showExtra && q.mode === "zelf" ? customTasksBlock(q, qi, s) : ""}
      ${showExtra && q.mode !== "zelf" && q.followUp ? dom`
        <div class="audit-follow">
          <p class="audit-q-text">${q.followUp.text}</p>
          <div class="audit-answers">
            <button type="button" class="audit-ans ja" data-fans="ja" aria-pressed="${pressed("ja", q.followUpAnswer)}">Ja</button>
            <button type="button" class="audit-ans nee" data-fans="nee" aria-pressed="${pressed("nee", q.followUpAnswer)}">Nee</button>
          </div>
        </div>` : ""}
      ${showExtra && q.mode !== "zelf" && Array.isArray(q.reasons) ? dom`
        <div class="audit-follow">
          <p class="audit-q-text">Waarom?${AUDIT_SETTINGS.multipleReasons ? " (meerdere mogelijk)" : ""}</p>
          <div class="audit-reasons">
            ${q.reasons.map((r) => dom`<button type="button" class="audit-reason" data-reason="${r.id}" aria-pressed="${(q.reasonIds || []).includes(r.id) ? "true" : "false"}">${r.label}</button>`)}
          </div>
        </div>` : ""}
      ${tasks.length && q.mode !== "zelf" ? dom`<ul class="audit-task-preview">${tasks.map((t) => dom`<li>Taak: ${t.title}</li>`)}</ul>` : ""}
      <details class="audit-note" data-open="${flag(q.note)}">
        <summary>${q.note ? "Notitie" : "Notitie toevoegen"}</summary>
        <textarea rows="2" maxlength="${AUDIT_SETTINGS.noteMax}" data-note aria-label="Notitie bij deze vraag" data-initial="${q.note || ""}"></textarea>
      </details>
    </div>`;
}

function customTaskMeta(c) {
  const bits = [c.assigneeName || "Allen"];
  if (c.urgent) bits.push("spoed");
  if (c.dueDate) bits.push(`streefdatum ${formatDate(c.dueDate)}`);
  return bits.join(" · ");
}

// Punt 7 / ideeëndoc: eigen taken bij een afwijking (geen foto). Meerdere taken per vraag mogelijk.
function customTasksBlock(q, qi, s) {
  const { dom } = ctx;
  const list = q.customTasks || [];
  const label = s.label || sectionLabel(s.locationId);
  const si = draft.sections.indexOf(s);
  const open = !list.length || (ctDraft && ctDraft.si === si && ctDraft.qi === qi);
  const d = open && ctDraft && ctDraft.si === si && ctDraft.qi === qi ? ctDraft : { text: "", assigneeId: "ALLEN", urgent: false, dueDate: "" };
  const emps = (ctx.getEmployees ? ctx.getEmployees() : []);
  return dom`
    <div class="audit-follow audit-custom">
      ${list.length ? dom`<ul class="audit-task-preview">${list.map((c) => dom`<li>
        <span>Taak: ${customTaskTitle(label, c.text)} <span class="pin-meta">(${customTaskMeta(c)})</span></span>
        <button type="button" class="secondary audit-small" data-ct-del="${c.id}">Weghalen</button>
      </li>`)}</ul>` : dom`<p class="pin-meta">Nog geen eigen taak. Voeg er minstens één toe (of kies Standaard taak).</p>`}
      ${open ? dom`<div class="audit-ct-form" data-ct-form>
        <label>Omschrijving <textarea rows="2" maxlength="${CUSTOM_TASK_TEXT_MAX}" data-ct-text data-initial="${d.text || ""}"></textarea></label>
        <label>Persoon
          <select data-ct-emp>
            <option value="ALLEN" data-selected="${flag(!d.assigneeId || d.assigneeId === "ALLEN")}">Allen</option>
            ${emps.map((e) => dom`<option value="${e.id}" data-selected="${flag(d.assigneeId === e.id)}">${e.name}</option>`)}
          </select>
        </label>
        <label class="check-row"><input type="checkbox" data-ct-urgent data-checked="${flag(d.urgent)}"> Spoed</label>
        <label>Streefdatum (optioneel) <input type="date" data-ct-due value="${d.dueDate || ""}"></label>
        <p class="form-error hidden" data-ct-error></p>
        <div class="form-actions">
          <button type="button" data-ct-add="next">Toevoegen en verdergaan</button>
          <button type="button" class="secondary" data-ct-add="new">Toevoegen en nieuwe taak aanmaken</button>
          ${list.length ? dom`<button type="button" class="secondary" data-ct-cancel>Annuleren</button>` : ""}
        </div>
      </div>` : dom`<button type="button" class="secondary audit-small" data-ct-open>Nog een taak toevoegen</button>`}
    </div>`;
}

function bindCustomTasks(card, q, qi) {
  const si = auditPos;
  const form = card.querySelector("[data-ct-form]");
  const read = () => ({
    si, qi,
    text: form.querySelector("[data-ct-text]").value,
    assigneeId: form.querySelector("[data-ct-emp]").value,
    urgent: form.querySelector("[data-ct-urgent]").checked,
    dueDate: form.querySelector("[data-ct-due]").value
  });
  if (form) {
    // Ingevulde waarden bewaren, zodat een hertekening (bijv. door een sync) niets wist.
    form.oninput = () => { ctDraft = read(); };
    form.onchange = () => { ctDraft = read(); };
    form.querySelectorAll("[data-ct-add]").forEach((btn) => {
      btn.onclick = () => {
        const res = cleanCustomTask(read(), ctx.getEmployees ? ctx.getEmployees() : []);
        const err = form.querySelector("[data-ct-error]");
        if (res.error) {
          err.textContent = res.error;
          err.classList.remove("hidden");
          return;
        }
        const taken = new Set((q.customTasks || []).map((c) => c.id));
        let n = (q.customTasks || []).length + 1;
        while (taken.has(String(n))) n += 1;
        res.task.id = String(n);
        q.customTasks = [...(q.customTasks || []), res.task];
        ctDraft = btn.dataset.ctAdd === "new" ? { si, qi, text: "", assigneeId: "ALLEN", urgent: false, dueDate: "", focus: true } : null;
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        scheduleSave(true);
        renderAudit();
        ctx.showToast("Taak toegevoegd (wordt aangemaakt bij afronden).", "ok");
      };
    });
    const cancel = form.querySelector("[data-ct-cancel]");
    if (cancel) cancel.onclick = () => { ctDraft = null; cancel.blur(); renderAudit(); };
  }
  const openBtn = card.querySelector("[data-ct-open]");
  if (openBtn) openBtn.onclick = () => {
    ctDraft = { si, qi, text: "", assigneeId: "ALLEN", urgent: false, dueDate: "", focus: true };
    renderAudit();
  };
  card.querySelectorAll("[data-ct-del]").forEach((btn) => {
    btn.onclick = () => {
      q.customTasks = (q.customTasks || []).filter((c) => c.id !== btn.dataset.ctDel);
      scheduleSave(true);
      renderAudit();
    };
  });
}

function bindRun(root, s) {
  root.querySelectorAll(".audit-q").forEach((card) => {
    const q = s.questions[Number(card.dataset.qi)];
    card.querySelectorAll("[data-mode]").forEach((btn) => {
      btn.onclick = () => {
        q.mode = btn.dataset.mode === "zelf" ? "zelf" : "standaard";
        if (q.mode === "zelf" && !Array.isArray(q.customTasks)) q.customTasks = [];
        scheduleSave(true);
        renderAudit();
      };
    });
    bindCustomTasks(card, q, Number(card.dataset.qi));
    card.querySelectorAll("[data-ans]").forEach((btn) => {
      btn.onclick = () => {
        q.answer = btn.dataset.ans;
        if (q.answer !== q.trigger) {
          if (q.followUp) q.followUpAnswer = null;
          if (q.reasons) q.reasonIds = [];
        }
        scheduleSave(true);
        renderAudit();
      };
    });
    card.querySelectorAll("[data-fans]").forEach((btn) => {
      btn.onclick = () => {
        q.followUpAnswer = btn.dataset.fans;
        scheduleSave(true);
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
        scheduleSave(true);
        renderAudit();
      };
    });
    const note = card.querySelector("[data-note]");
    if (note) {
      note.oninput = () => {
        q.note = note.value.slice(0, AUDIT_SETTINGS.noteMax);
        scheduleSave();
      };
      note.onblur = () => {
        scheduleSave(true);
        setTimeout(renderAudit, 0);
      };
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
      <p class="section-intro">Audit van ${formatDate(draft.auditDate)}. Controleer de taken en notities. Pas daarna worden de taken aangemaakt. Standaardtaken zijn voor iedereen, zonder streefdatum; zelf aangemaakte taken krijgen de gekozen persoon, spoed en streefdatum.</p>
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
            ${tasks.length ? dom`<ul class="review-tasks">${tasks.map((t) => dom`<li>${t.title}${t.custom ? dom` <span class="pin-meta">(${customTaskMeta(t.custom)})</span>` : ""}</li>`)}</ul>` : dom`<p class="pin-meta">Geen taken.</p>`}
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
  const all = completedAudits();
  if (!all.length) {
    root.replaceChildren(dom`<p class="empty-state">Nog geen afgeronde audits.</p>`);
    return;
  }
  // Punt 7: geschiedenis en trend per variant (alleen binnen dezelfde variant vergelijken).
  const ids = [];
  for (const a of all) if (!ids.includes(variantIdOf(a))) ids.push(variantIdOf(a));
  for (const v of variants()) if (!ids.includes(v.id)) ids.push(v.id);
  const nameOf = (id) => { const v = variantById(id); if (v) return v.name; const a = all.find((x) => variantIdOf(x) === id); return a ? auditVariantName(a) : id; };
  const sel = historyVariant === "all" ? "all" : (ids.includes(historyVariant) ? historyVariant : variantIdOf(all[0]));
  const list = sel === "all" ? all : all.filter((a) => variantIdOf(a) === sel);
  const selVariant = sel === "all" ? null : variantById(sel);
  const compareOn = sel !== "all" && (selVariant ? selVariant.compare : list.some((a) => a.compare !== false));
  const trendAudits = list.slice(0, 6).reverse();
  const sectionIds = [];
  for (const a of list.slice(0, 6)) for (const s of a.sections || []) if (!sectionIds.includes(s.locationId)) sectionIds.push(s.locationId);
  const cell = (a, id) => {
    const s = (a.sections || []).find((x) => x.locationId === id);
    if (!s) return dom`<td class="score-none">–</td>`;
    const sc = s.score || sectionScore(s);
    return dom`<td class="${scoreClass(sc.good, sc.total)}">${pct(sc.good, sc.total)}%</td>`;
  };
  const picker = ids.length > 1 ? dom`<label class="audit-variant-pick">Variant
      <select data-history-variant>
        ${ids.map((id) => dom`<option value="${id}" data-selected="${flag(sel === id)}">${nameOf(id)}</option>`)}
        <option value="all" data-selected="${flag(sel === "all")}">Alle varianten</option>
      </select>
    </label>` : "";
  root.replaceChildren(dom`
    ${picker}
    ${!list.length ? dom`<p class="empty-state">Nog geen afgeronde audits van deze variant.</p>` : ""}
    ${list.length && compareOn ? dom`
    <h3>Trend per onderdeel</h3>
    <p class="pin-meta">Score = aantal vragen zonder afwijking. Laatste ${trendAudits.length} audits van ${nameOf(sel)}, oudste links.</p>
    <div class="trend-wrap">
      <table class="trend-table">
        <thead><tr><th scope="col">Onderdeel</th>${trendAudits.map((a) => dom`<th scope="col">${formatDate(a.auditDate)}</th>`)}</tr></thead>
        <tbody>
          ${sectionIds.map((id) => dom`<tr><th scope="row">${sectionLabel(id)}</th>${trendAudits.map((a) => cell(a, id))}</tr>`)}
          <tr class="trend-total"><th scope="row">Totaal</th>${trendAudits.map((a) => { const t = auditTotal(a); return dom`<td class="${scoreClass(t.good, t.total)}">${pct(t.good, t.total)}%</td>`; })}</tr>
        </tbody>
      </table>
    </div>` : ""}
    ${list.length && !compareOn ? dom`<p class="pin-meta">${sel === "all" ? "Kies één variant om de trend te zien; varianten worden niet met elkaar vergeleken." : `Vergelijken staat uit voor ${nameOf(sel)}: geen trend.`}</p>` : ""}
    ${list.length ? dom`<h3>Eerdere audits</h3>` : ""}
    ${list.map((a) => auditCard(a))}`);
  applyFlags(root);
  const hv = root.querySelector("[data-history-variant]");
  if (hv) hv.onchange = () => { historyVariant = hv.value; hv.blur(); renderHistory(); };
  root.querySelectorAll("[data-delete-audit]").forEach((btn) => {
    btn.onclick = () => deleteCompletedAudit(btn.dataset.deleteAudit);
  });
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
          <h4>Audit ${formatDate(a.auditDate)} · ${auditVariantName(a)}</h4>
          <p class="pin-meta">${a.ranBy ? `Gelopen door ${a.ranBy} · ` : ""}${a.taskCount || 0} taken · ${a.notesCount || 0} notities</p>
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
        <button type="button" class="danger" data-delete-audit="${a.id}" data-disabled="${flag(deletingAudit)}">Audit verwijderen</button>
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

// Punt 7: afgeronde audit verwijderen. Eerst de audit bevestigen, daarna per gekoppelde taak apart
// (taak + taskMeta + taskCompletions). Bewaarde taken blijven bestaan (met hun herkomst).
async function deleteCompletedAudit(id) {
  const a = audits.find((x) => x.id === id);
  if (!a || deletingAudit) return;
  const linked = ctx.getRawTasks().filter((t) => (a.taskIds || []).includes(t.id) || (t.source && t.source.auditId === id));
  const ok = await ctx.confirmAction(
    `Audit van ${formatDate(a.auditDate)} (${auditVariantName(a)}) verwijderen? ${linked.length ? `Daarna vraag ik per taak (${linked.length}) of die ook weg mag.` : "Er zijn geen gekoppelde taken meer."} Dit kan niet ongedaan worden gemaakt.`,
    { title: "Audit verwijderen", confirmText: "Verder", danger: true }
  );
  if (!ok) return;
  deletingAudit = true;
  try {
    const remove = [];
    for (let i = 0; i < linked.length; i += 1) {
      const t = linked[i];
      const st = t.status === "afgerond" ? "afgerond" : t.status === "pending" ? "ter controle" : "open";
      const yes = await ctx.confirmAction(`"${t.title}" (${st}) ook verwijderen?`, {
        title: `Taak ${i + 1} van ${linked.length}`, confirmText: "Taak verwijderen", cancelText: "Taak bewaren", danger: true
      });
      if (yes) remove.push(t.id);
    }
    const last = await ctx.confirmAction(
      `Audit verwijderen${remove.length ? ` met ${remove.length} ${remove.length === 1 ? "taak" : "taken"}` : ""}${linked.length - remove.length ? `; ${linked.length - remove.length} ${linked.length - remove.length === 1 ? "taak blijft" : "taken blijven"} bestaan` : ""}.`,
      { title: "Bevestigen", confirmText: "Definitief verwijderen", danger: true }
    );
    if (!last) return;
    const done = await ctx.safeWrite(async () => {
      let batch = writeBatch(db);
      let n = 0;
      for (const tid of remove) {
        for (const col of ["tasks", "taskMeta", "taskCompletions"]) batch.delete(doc(db, col, tid));
        n += 3;
        if (n >= AUDIT_SETTINGS.batchSize) {
          await batch.commit();
          batch = writeBatch(db);
          n = 0;
        }
      }
      batch.delete(doc(db, "audits", id));
      await batch.commit();
    });
    if (done) {
      historyOpen.delete(id);
      ctx.showToast(`Audit verwijderd${remove.length ? ` (${remove.length} ${remove.length === 1 ? "taak" : "taken"})` : ""}.`, "ok");
    }
  } finally {
    deletingAudit = false;
    renderHistory();
  }
}

function startedMs(a) {
  return a.startedAt && typeof a.startedAt.toMillis === "function" ? a.startedAt.toMillis() : 0;
}

// Punt 7 PDF: pagina 1 titel + wie liep, daarna één pagina per onderdeel/pad, laatste pagina de
// vergelijking met de vorige 2 audits van dezelfde variant (alleen als Vergelijken aan staat).
export function renderPrintView(id) {
  const a = audits.find((x) => x.id === id);
  const view = document.getElementById("print-view");
  if (!a || !view) return false;
  const { dom } = ctx;
  const t = auditTotal(a);
  const allTasks = ctx.getTasks();
  const tasks = (a.taskIds || []).map((tid) => allTasks.find((x) => x.id === tid)).filter(Boolean);
  const completed = a.completedAt && a.completedAt.toDate ? formatDateTime(a.completedAt.toDate().toISOString()) : "";
  const vName = auditVariantName(a);
  const compare = auditCompares(a);
  const withMs = (x) => ({ ...x, startedAtMs: startedMs(x) });
  const prev = compare ? previousSameVariant(completedAudits().map(withMs), withMs(a), 2) : [];
  const cmp = compare ? compareRows(a, prev, (s) => s.score || sectionScore(s)) : null;
  const scoreOf = (s) => s.score || sectionScore(s);
  const statusText = (x) => (x.status === "afgerond" ? "Afgerond" : x.status === "pending" ? "Ter controle" : "Open");
  const p = (v) => (typeof v === "number" ? `${v}%` : "–");
  const prevHead = [...prev].reverse();
  while (prevHead.length < 2) prevHead.unshift(null);
  view.replaceChildren(dom`
    <div class="print-doc">
      <section class="print-page">
        <header class="print-head">
          <h1>Audit ${vName}</h1>
          <p>Zeiklijst · ${formatDate(a.auditDate)}</p>
        </header>
        <table class="print-table print-meta">
          <tbody>
            <tr><th>Variant</th><td>${vName}</td></tr>
            <tr><th>Gelopen door</th><td>${a.ranBy || "–"}</td></tr>
            <tr><th>Datum</th><td>${formatDate(a.auditDate)}</td></tr>
            <tr><th>Afgerond</th><td>${completed || "–"}</td></tr>
            <tr><th>Totaalscore</th><td>${t.good}/${t.total} (${pct(t.good, t.total)}%)</td></tr>
            <tr><th>Taken / notities</th><td>${a.taskCount || 0} taken · ${a.notesCount || 0} notities</td></tr>
          </tbody>
        </table>
        <h2>Onderdelen</h2>
        <table class="print-table">
          <thead><tr><th>Onderdeel</th><th>Score</th></tr></thead>
          <tbody>${(a.sections || []).map((s) => { const sc = scoreOf(s); return dom`<tr><td>${s.label}</td><td>${sc.good}/${sc.total} (${pct(sc.good, sc.total)}%)</td></tr>`; })}</tbody>
        </table>
      </section>
      ${(a.sections || []).map((s) => {
        const sc = scoreOf(s);
        const st = tasks.filter((x) => x.source && x.source.locationId === s.locationId);
        return dom`<section class="print-page">
          <h2>${s.label} · ${sc.good}/${sc.total} (${pct(sc.good, sc.total)}%)</h2>
          <table class="print-table">
            <thead><tr><th>Vraag en antwoord</th><th>Notitie</th></tr></thead>
            <tbody>${(s.questions || []).map((q) => dom`<tr class="${questionGood(q) ? "ok" : "dev"}"><td>${questionGood(q) ? "✓ " : "✗ "}${describeAnswer(q)}</td><td>${q.note || ""}</td></tr>`)}</tbody>
          </table>
          <h3>Taken</h3>
          ${st.length ? dom`<table class="print-table"><thead><tr><th>Taak</th><th>Voor</th><th>Status nu</th></tr></thead><tbody>${st.map((x) => dom`<tr><td>${x.urgent ? "SPOED · " : ""}${x.title}</td><td>${x.assigneeName || "Allen"}</td><td>${statusText(x)}</td></tr>`)}</tbody></table>` : dom`<p>Geen taken.</p>`}
        </section>`;
      })}
      ${cmp ? dom`<section class="print-page">
        <h2>Vergelijking met de vorige audits (${vName})</h2>
        ${prev.length ? dom`<table class="print-table print-compare">
          <thead><tr><th>Onderdeel</th>${prevHead.map((x) => dom`<th>${x ? formatDate(x.auditDate) : "–"}</th>`)}<th>Deze audit</th><th>Trend</th></tr></thead>
          <tbody>
            ${cmp.rows.map((r) => dom`<tr class="${r.declining ? "declining" : ""}"><td>${r.label}</td>${r.pcts.map((v) => dom`<td>${p(v)}</td>`)}<td>${r.declining ? dom`<strong>Structureel dalend</strong>` : ""}</td></tr>`)}
            <tr class="trend-total ${cmp.total.declining ? "declining" : ""}"><td><strong>Totaal</strong></td>${cmp.total.pcts.map((v) => dom`<td><strong>${p(v)}</strong></td>`)}<td>${cmp.total.declining ? dom`<strong>Structureel dalend</strong>` : ""}</td></tr>
          </tbody>
        </table>
        <p>"Structureel dalend" = twee keer achter elkaar lager dan de audit ervoor.</p>` : dom`<p>Nog geen eerdere audit van deze variant om mee te vergelijken.</p>`}
      </section>` : ""}
      <p class="print-foot">Made by Jordi-CyX</p>
    </div>`);
  return true;
}

export function printAudit(id) {
  if (!renderPrintView(id)) return;
  document.body.classList.add("print-mode");
  setTimeout(() => window.print(), 50);
}

// ---------- Beheer: locaties (menukopje Locaties) en varianten/vragenlijst/standaardvragen (menukopje Audits) ----------
// V3C punt 1-3: de locatielijst staat onder "Locaties"; varianten, vragenlijsten en standaardvragen onder "Audits".
// renderBeheer tekent beide pagina's (alle bestaande aanroepen blijven werken).
function typingIn(root) {
  const active = document.activeElement;
  return !!(active && root.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
}

// V3C punt 5: na opnieuw tekenen dezelfde scrollpositie houden (alleen als de pagina zichtbaar is).
function keepScroll(root, draw) {
  const visible = root.offsetParent !== null;
  const y = window.scrollY;
  draw();
  applyFlags(root); // open blokken eerst openzetten, dan pas de scrollpositie terugzetten
  applyFolds(root);
  if (visible && Math.abs(window.scrollY - y) > 1) window.scrollTo(0, y);
}

function renderBeheer() {
  renderLocationsPage();
  renderAuditsAdmin();
}

function renderLocationsPage() {
  const root = document.getElementById("beheer-root");
  if (!root || typingIn(root)) return;
  const { dom } = ctx;
  keepScroll(root, () => root.replaceChildren(dom`
    <div class="emp-dash-card">
      <h3>Locatielijst</h3>
      <p class="pin-meta">Medewerkers kiezen bij een nieuwe taak alleen uit de actieve locaties. Een locatie wordt nooit verwijderd, alleen gedeactiveerd (oude taken houden hun naam).</p>
      ${renderLocationsAdmin()}
    </div>
    <div class="emp-dash-card">
      <h3>Oude taken koppelen aan een locatie</h3>
      <p class="pin-meta">Taken zonder vaste locatie, gegroepeerd op hun oude vrije tekst. Koppelen zet alleen de vaste locatie; de oude tekst blijft bewaard.</p>
      ${renderLinkLegacy()}
    </div>`));
  applyFlags(root);
  bindBeheer(root);
}

function renderAuditsAdmin() {
  const root = document.getElementById("audits-admin-root");
  if (!root || typingIn(root)) return;
  const { dom } = ctx;
  keepScroll(root, () => root.replaceChildren(dom`
    <div class="emp-dash-card" id="variants-card">
      <h3>Audit-varianten</h3>
      <p class="pin-meta">Elke variant heeft een eigen vragenlijst en ronde. Bij Audit lopen kies je de variant. Met Vergelijken aan vergelijkt de PDF met de vorige 2 audits van dezelfde variant; varianten worden nooit met elkaar vergeleken.</p>
      ${renderVariantsAdmin()}
    </div>
    <div class="emp-dash-card">
      <h3 data-fold-label="Vragenlijst en ronde">Vragenlijst en ronde${editVariant() ? ` · ${editVariant().name}` : ""}</h3>
      <p class="pin-meta">De volgorde hieronder is de volgorde van de ronde. Een lopende audit houdt de vragen van het moment van starten. In een taaktekst wordt <code>{locatie}</code> vervangen door de naam van het onderdeel. Bij elk onderdeel kun je een standaardvraag kiezen.</p>
      ${renderConfigAdmin()}
    </div>
    <div class="emp-dash-card" id="bank-card">
      <h3>Standaardvragen</h3>
      <p class="pin-meta">Vaste vragen die je vaak gebruikt. Bewaar ze hier één keer en kies ze daarna bij een onderdeel van een vragenlijst (elke variant), in plaats van ze opnieuw te typen. Een gekozen vraag wordt gekopieerd: later wijzigen in de standaardvragen verandert bestaande vragenlijsten niet.</p>
      ${renderBankAdmin()}
    </div>`));
  applyFlags(root);
  bindBeheer(root);
  bindBank(root);
}

function renderLocationsAdmin() {
  const { dom } = ctx;
  if (!locationsReady) return dom`<p class="pin-meta">Laden…</p>`;
  if (!locationsDoc) return dom`<button type="button" data-seed-locations>Standaard locatielijst aanmaken (${DEFAULT_LOCATIONS.length})</button>`;
  const items = allLocations();
  const plan = FEATURES.departments ? planDepartments(items) : null;
  return dom`
    ${plan ? dom`<div class="loc-dept-bar">
      <p class="pin-meta">Afdeling per pad bepaalt wat medewerkers met een afdeling in de app zien. Een pad zonder afdeling of met "Beide" ziet iedereen; persoonlijk toegewezen taken altijd.</p>
      <button type="button" class="secondary" data-loc-dept-seed data-disabled="${flag(!plan.changes.length)}">Afdelingen volgens afspraak invullen${plan.changes.length ? ` (${plan.changes.length})` : " (alles ingevuld)"}</button>
    </div>` : ""}
    <ol class="v2-list">
      ${items.map((l, i) => dom`
        <li class="v2-row${l.active ? "" : " inactive"}">
          <span class="v2-row-main"><strong>${l.label}</strong> <span class="pin-meta">${l.id}</span>${l.active ? "" : dom` <span class="badge paused">Inactief</span>`}${l.staffSelectable ? "" : dom` <span class="badge paused">Alleen admin</span>`}</span>
          <span class="v2-row-actions">
            <button type="button" class="secondary icon-btn" data-loc-up="${i}" aria-label="${`${l.label} omhoog`}" data-disabled="${flag(i === 0)}">↑</button>
            <button type="button" class="secondary icon-btn" data-loc-down="${i}" aria-label="${`${l.label} omlaag`}" data-disabled="${flag(i === items.length - 1)}">↓</button>
            <button type="button" class="secondary" data-loc-rename="${i}">Naam</button>
            <label class="check-row loc-staff"><input type="checkbox" data-loc-staff="${i}" data-checked="${flag(l.staffSelectable)}"> Medewerkers kunnen kiezen</label>
            ${FEATURES.departments ? dom`<label class="loc-dept">Afdeling
              <select data-loc-dept="${i}" aria-label="${`Afdeling ${l.label}`}">
                <option value="" data-selected="${flag(!l.department)}">Geen (iedereen)</option>
                ${DEPARTMENTS.map((d) => dom`<option value="${d}" data-selected="${flag(l.department === d)}">${DEPARTMENT_LABELS[d]}</option>`)}
              </select>
            </label>` : ""}
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

function renderVariantsAdmin() {
  const { dom } = ctx;
  if (!configReady()) return dom`<p class="pin-meta">Laden…</p>`;
  const list = variants();
  const ev = editVariant();
  const running = activeAuditDoc ? variantIdOf(activeAuditDoc.data) : null;
  return dom`
    ${list.length ? dom`<ul class="v2-list variant-list">${list.map((v, i) => dom`<li class="v2-row${v.active ? "" : " inactive"}">
      <span class="v2-row-main">
        <strong>${v.name}</strong>
        <span class="pin-meta">${v.sections.filter((x) => x.active).length} onderdelen · versie ${v.version}</span>
        <span class="badge ${v.compare ? "" : "paused"}">${v.compare ? "Vergelijken aan" : "Vergelijken uit"}</span>
        ${v.active ? "" : dom` <span class="badge paused">Niet actief</span>`}
        ${ev && ev.id === v.id ? dom` <span class="badge">Wordt bewerkt</span>` : ""}
      </span>
      <span class="v2-row-actions">
        <button type="button" class="secondary" data-v-edit="${v.id}" data-disabled="${flag(ev && ev.id === v.id)}">Vragen bewerken</button>
        <button type="button" class="secondary" data-v-rename="${v.id}">Naam</button>
        <button type="button" class="secondary" data-v-compare="${v.id}">${v.compare ? "Vergelijken uit" : "Vergelijken aan"}</button>
        <button type="button" class="secondary" data-v-active="${v.id}">${v.active ? "Deactiveren" : "Activeren"}</button>
        <button type="button" class="secondary icon-btn" data-v-up="${v.id}" aria-label="${`${v.name} hoger`}" data-disabled="${flag(i === 0)}">↑</button>
        <button type="button" class="secondary icon-btn" data-v-down="${v.id}" aria-label="${`${v.name} lager`}" data-disabled="${flag(i === list.length - 1)}">↓</button>
        <button type="button" class="danger" data-v-del="${v.id}" data-disabled="${flag(v.id === DEFAULT_VARIANT_ID || v.virtual || running === v.id)}">Verwijderen</button>
      </span>
    </li>`)}</ul>` : ""}
    <form class="v2-inline-form" data-variant-add novalidate>
      <label>Nieuwe variant <input type="text" name="name" maxlength="${VARIANT_NAME_MAX}" placeholder="Naam, bijv. Netheid"></label>
      <label>Begin met
        <select name="from">
          <option value="">Lege vragenlijst</option>
          ${list.map((v) => dom`<option value="${v.id}">Kopie van ${v.name}</option>`)}
        </select>
      </label>
      <label class="check-row"><input type="checkbox" name="compare" data-checked="1"> Vergelijken</label>
      <button type="submit" data-disabled="${flag(!locationsDoc)}">Variant toevoegen</button>
    </form>`;
}

async function addVariant(form) {
  const f = form.elements;
  const name = f.name.value.trim().slice(0, VARIANT_NAME_MAX);
  if (!name) {
    ctx.showToast("Vul een naam in voor de variant.");
    return;
  }
  const list = variants();
  if (list.some((v) => v.name.toLowerCase() === name.toLowerCase())) {
    ctx.showToast("Er is al een variant met die naam.");
    return;
  }
  const from = list.find((v) => v.id === f.from.value);
  const id = uniqueId(slugify(name, 30), new Set(list.map((v) => v.id)), 30);
  const order = list.reduce((m, v) => Math.max(m, v.order || 0), 0) + 1;
  const v = { id, name, compare: f.compare.checked, active: true, order, version: 0, sections: [], virtual: false };
  const sections = from ? JSON.parse(JSON.stringify(from.sections)) : [];
  if (await saveVariant(v, { sections, create: true })) {
    editVariantId = id;
    localStorage.setItem("zeiklijst-admin-edit-variant", id);
    form.reset();
    ctx.showToast(`Variant "${name}" toegevoegd.`, "ok");
  }
}

function bindVariants(root) {
  const on = (sel, key, fn) => root.querySelectorAll(sel).forEach((el) => { el.onclick = () => { const v = variantById(el.dataset[key]); if (v) fn(v, el); }; });
  const form = root.querySelector("[data-variant-add]");
  if (form) form.onsubmit = (e) => {
    e.preventDefault();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    addVariant(form);
  };
  on("[data-v-edit]", "vEdit", (v) => {
    editVariantId = v.id;
    editingQuestion = null;
    localStorage.setItem("zeiklijst-admin-edit-variant", v.id);
    renderBeheer();
  });
  on("[data-v-rename]", "vRename", async (v) => {
    const res = await ctx.showDialog({ title: "Variant hernoemen", message: "Bestaande audits van deze variant tonen de nieuwe naam.", input: true, inputLabel: "Naam", inputValue: v.name, confirmText: "Opslaan" });
    if (!res || !res.ok) return;
    const name = String(res.value || "").trim().slice(0, VARIANT_NAME_MAX);
    if (!name || name === v.name) return;
    if (variants().some((x) => x.id !== v.id && x.name.toLowerCase() === name.toLowerCase())) {
      ctx.showToast("Er is al een variant met die naam.");
      return;
    }
    if (await saveVariant(v, { name })) ctx.showToast("Naam opgeslagen.", "ok");
  });
  on("[data-v-compare]", "vCompare", async (v) => {
    if (await saveVariant(v, { compare: !v.compare })) ctx.showToast(`Vergelijken ${v.compare ? "uit" : "aan"} voor ${v.name}.`, "ok");
  });
  on("[data-v-active]", "vActive", async (v) => {
    if (v.active && variants().filter((x) => x.active).length <= 1) {
      ctx.showToast("Er moet minstens één actieve variant zijn.");
      return;
    }
    if (await saveVariant(v, { active: !v.active })) ctx.showToast(`${v.name} ${v.active ? "gedeactiveerd" : "geactiveerd"}.`, "ok");
  });
  const reorder = async (v, d) => {
    const list = variants();
    const i = list.findIndex((x) => x.id === v.id);
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    move(list, i, d);
    // Volgorde opnieuw nummeren; alleen varianten waarvan de volgorde verandert, worden geschreven.
    for (let k = 0; k < list.length; k += 1) {
      if (list[k].order !== k + 1 || list[k].virtual) await saveVariant(list[k], { order: k + 1 });
    }
  };
  on("[data-v-up]", "vUp", (v) => reorder(v, -1));
  on("[data-v-down]", "vDown", (v) => reorder(v, 1));
  on("[data-v-del]", "vDel", async (v) => {
    const n = audits.filter((a) => variantIdOf(a) === v.id).length;
    const ok = await ctx.confirmAction(`Variant "${v.name}" verwijderen?${n ? ` De ${n} bestaande audits blijven bewaard (met hun eigen vragen).` : ""}`, { title: "Variant verwijderen", confirmText: "Verwijderen", danger: true });
    if (!ok) return;
    if (await ctx.safeWrite(() => deleteDoc(doc(db, "auditVariants", v.id)))) {
      if (editVariantId === v.id) editVariantId = "";
      ctx.showToast("Variant verwijderd.", "ok");
    }
  });
}

function renderConfigAdmin() {
  const { dom } = ctx;
  if (!configReady()) return dom`<p class="pin-meta">Laden…</p>`;
  const ev = editVariant();
  if (!ev) return dom`<button type="button" data-seed-config data-disabled="${flag(!locationsDoc)}">Standaard vragenlijst aanmaken</button>${locationsDoc ? "" : dom`<p class="pin-meta">Maak eerst de locatielijst aan.</p>`}`;
  const secs = ev.sections;
  const inRound = new Set(secs.map((s) => s.locationId));
  const addable = activeLocations().filter((l) => !inRound.has(l.id));
  const editing = (si, qi) => editingQuestion && editingQuestion.sectionIndex === si && editingQuestion.questionIndex === qi;
  return dom`
    <p class="pin-meta">${ev.name} · versie ${ev.version} · ${secs.filter((s) => s.active).length} onderdelen in de ronde</p>
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
          <details class="config-questions" data-q-block="${blockKey(ev, s)}" data-open="${flag(openQuestionBlocks.has(blockKey(ev, s)) || (editingQuestion && editingQuestion.sectionIndex === si))}">
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
                      <button type="button" class="secondary" data-q-tobank="${si}:${qi}" data-disabled="${flag(!bankReady || bankError || bankDocs.some((b) => sameQuestionText(b, q)))}">${bankDocs.some((b) => sameQuestionText(b, q)) ? "Is standaardvraag" : "Bewaar als standaardvraag"}</button>
                      <button type="button" class="danger" data-q-del="${si}:${qi}">Verwijderen</button>
                    </span>
                  </li>`))}
              ${editing(si, -1) ? questionEditor({ text: "", trigger: "nee", taskText: `${LOCATION_PLACEHOLDER} - ` }, si, -1) : ""}
            </ol>
            <div class="form-actions q-block-actions">
              <button type="button" class="secondary" data-q-add="${si}">Vraag toevoegen</button>
              ${bankPicker(s, si)}
            </div>
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

function blockKey(v, s) {
  return `${v ? v.id : "x"}|${s ? s.locationId : "x"}`;
}

// V3C punt 6: keuzelijst "Standaardvraag kiezen" in een onderdeel van de vragenlijst.
function bankPicker(s, si) {
  const { dom } = ctx;
  if (!bankReady || bankError || !bankDocs.length) return "";
  const free = bankDocs.filter((b) => !s.questions.some((x) => sameQuestionText(x, b)));
  if (!free.length) return dom`<span class="pin-meta">Alle standaardvragen staan al in dit onderdeel.</span>`;
  return dom`<form class="v2-inline-form bank-pick" data-q-bank-pick="${si}" novalidate>
    <label>Standaardvraag kiezen
      <select>${free.map((b) => dom`<option value="${b.id}">${b.text}</option>`)}</select>
    </label>
    <button type="submit" class="secondary">Toevoegen</button>
  </form>`;
}

function renderBankAdmin() {
  const { dom } = ctx;
  if (!bankReady) return dom`<p class="pin-meta">Laden…</p>`;
  if (bankError) return dom`<p class="form-error">Kan de standaardvragen niet lezen (regels nog niet gepubliceerd?). Bewaren lukt pas na de nieuwe regels.</p>`;
  const editing = (id) => bankEditing && bankEditing.id === id;
  return dom`
    ${bankDocs.length ? dom`<ol class="question-list bank-list">
      ${bankDocs.map((b) => (editing(b.id) ? questionEditor(b, -1, -1, "bank") : dom`<li class="question-row">
        <div class="question-main">
          <span>${b.text}</span>
          <span class="pin-meta">Taak bij ${b.trigger === "ja" ? "Ja" : "Nee"} → ${questionSummary(b)}</span>
        </div>
        <span class="v2-row-actions">
          <button type="button" class="secondary" data-bank-edit="${b.id}">Bewerken</button>
          <button type="button" class="danger" data-bank-del="${b.id}">Verwijderen</button>
        </span>
      </li>`))}
    </ol>` : dom`<p class="empty-state">Nog geen standaardvragen. Voeg er hieronder een toe, of tik bij een vraag in de vragenlijst op "Bewaar als standaardvraag".</p>`}
    ${editing("") ? dom`<ol class="question-list">${questionEditor({ text: "", trigger: "nee", taskText: `${LOCATION_PLACEHOLDER} - ` }, -1, -1, "bank")}</ol>` : dom`<button type="button" class="secondary" data-bank-add data-disabled="${flag(bankDocs.length >= BANK_MAX)}">Standaardvraag toevoegen</button>`}`;
}

async function saveBankQuestion(id, q) {
  const payload = bankPayload(q);
  if (!payload) { ctx.showToast("Deze vraag is niet compleet."); return false; }
  if (bankDocs.some((b) => b.id !== id && sameQuestionText(b, payload))) { ctx.showToast("Deze standaardvraag bestaat al."); return false; }
  if (!id && bankDocs.length >= BANK_MAX) { ctx.showToast(`Maximaal ${BANK_MAX} standaardvragen.`); return false; }
  const newId = id || uniqueId(slugify(payload.text, 40), new Set(bankDocs.map((b) => b.id)), 40);
  const data = { ...payload, updatedAt: serverTimestamp() };
  if (!id) data.createdAt = serverTimestamp();
  // set zonder merge: oude velden (bijv. taskText na wisselen naar keuzes) verdwijnen; createdAt blijft bij bewerken.
  const prev = id ? bankDocs.find((b) => b.id === id) : null;
  if (prev && prev.createdAt) data.createdAt = prev.createdAt;
  return ctx.safeWrite(() => setDoc(doc(db, "questionBank", newId), data));
}

function bindBank(root) {
  const on = (sel, fn) => root.querySelectorAll(sel).forEach((el) => { el.onclick = (e) => fn(el, e); });
  on("[data-bank-add]", () => { bankEditing = { id: "" }; editingQuestion = null; renderBeheer(); });
  on("[data-bank-edit]", (el) => { bankEditing = { id: el.dataset.bankEdit }; editingQuestion = null; renderBeheer(); });
  on("[data-bank-del]", async (el) => {
    const b = bankDocs.find((x) => x.id === el.dataset.bankDel);
    if (!b) return;
    const ok = await ctx.confirmAction(`Standaardvraag "${b.text}" verwijderen? Vragenlijsten waarin deze vraag al staat, blijven zoals ze zijn.`, { title: "Standaardvraag verwijderen", confirmText: "Verwijderen", danger: true });
    if (!ok) return;
    if (await ctx.safeWrite(() => deleteDoc(doc(db, "questionBank", b.id)))) ctx.showToast("Standaardvraag verwijderd.", "ok");
  });
  const form = root.querySelector('[data-q-form="bank"]');
  if (!form) return;
  syncEditorKind(form);
  form.elements.kind.onchange = () => syncEditorKind(form);
  form.querySelector("[data-q-cancel]").onclick = () => { bankEditing = null; renderBeheer(); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const res = readQuestionForm(form, { questions: [] }, -1);
    const err = form.querySelector("[data-q-error]");
    if (res.error) {
      err.textContent = res.error;
      err.classList.remove("hidden");
      return;
    }
    const id = bankEditing ? bankEditing.id : "";
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    if (await saveBankQuestion(id, res.q)) {
      bankEditing = null;
      ctx.showToast("Standaardvraag opgeslagen.", "ok");
      renderBeheer();
    }
  };
}

function questionSummary(q) {
  if (q.followUp) return `controlevraag "${q.followUp.text}" (${q.followUp.trigger === "ja" ? "Ja" : "Nee"} → ${q.followUp.taskText})`;
  if (Array.isArray(q.reasons) && q.reasons.length) return `Waarom: ${q.reasons.map((r) => `${r.label} → ${r.taskText}`).join("; ")}`;
  return q.taskText || "(geen taak)";
}

function questionEditor(q, si, qi, formKey = `${si}:${qi}`) {
  const { dom } = ctx;
  const kind = q.followUp ? "follow" : (Array.isArray(q.reasons) && q.reasons.length ? "reasons" : "task");
  const reasonsText = (q.reasons || []).map((r) => `${r.label} | ${r.taskText}`).join("\n");
  const fuTrigger = q.followUp && q.followUp.trigger === "nee" ? "nee" : "ja";
  return dom`<li class="question-editor">
    <form data-q-form="${formKey}" novalidate>
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
        <textarea name="reasons" rows="4" data-initial="${reasonsText}"></textarea>
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
  return JSON.parse(JSON.stringify(editVariant().sections));
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
  root.querySelectorAll("[data-loc-dept]").forEach((sel) => {
    sel.onchange = () => {
      const list = items();
      list[Number(sel.dataset.locDept)].department = normalizeDepartment(sel.value);
      sel.blur();
      saveLocations(list);
    };
  });
  on("[data-loc-dept-seed]", async () => {
    const plan = planDepartments(items());
    if (!plan.changes.length) return;
    const count = (d) => plan.changes.filter((c) => c.to === d).length;
    const ok = await ctx.confirmAction(
      `${plan.changes.length} lege paden invullen volgens de afspraak: ${count("sanitair")} Sanitair, ${count("tegels")} Tegels, ${count("beide")} Beide. Al ingevulde paden blijven zoals ze zijn.${plan.unknown.length ? ` Niet in de afspraak (blijft leeg): ${plan.unknown.join(", ")}.` : ""}`,
      { title: "Afdelingen per pad", confirmText: "Invullen" }
    );
    if (!ok) return;
    if (await saveLocations(plan.items)) ctx.showToast("Afdelingen per pad ingevuld.", "ok");
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
  const saveSecs = (secs) => saveVariant(editVariant(), { sections: secs });
  bindVariants(root);
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
    openQuestionBlocks.add(blockKey(editVariant(), secs[si]));
    secs[si].questions.splice(qi, 1);
    saveSecs(secs);
  });
  // V3C punt 5: open/dicht van elk "Vragen"-blok onthouden, zodat het na opslaan of verwijderen open blijft.
  root.querySelectorAll("details[data-q-block]").forEach((d) => {
    d.addEventListener("toggle", () => {
      if (d.open) openQuestionBlocks.add(d.dataset.qBlock);
      else openQuestionBlocks.delete(d.dataset.qBlock);
    });
  });
  on("[data-q-tobank]", async (el) => {
    const [si, qi] = pair(el.dataset.qTobank);
    const ev = editVariant();
    const q = ev && ev.sections[si] && ev.sections[si].questions[qi];
    if (!q) return;
    if (await saveBankQuestion("", bankFromQuestion(q))) ctx.showToast("Bewaard als standaardvraag.", "ok");
  });
  root.querySelectorAll("[data-q-bank-pick]").forEach((form) => {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const si = Number(form.dataset.qBankPick);
      const sel = form.querySelector("select");
      const b = bankDocs.find((x) => x.id === sel.value);
      sel.blur();
      if (!b) { ctx.showToast("Kies eerst een standaardvraag."); return; }
      const secs = configCopy();
      const s = secs[si];
      if (!s) return;
      if (s.questions.some((x) => sameQuestionText(x, b))) { ctx.showToast("Deze vraag staat al in dit onderdeel."); return; }
      const nq = questionFromBank(b, s.questions.map((x) => x.id), (text, taken) => uniqueId(slugify(text, 40), taken, 40));
      if (!nq) return;
      s.questions.push(nq);
      openQuestionBlocks.add(blockKey(editVariant(), s));
      if (await saveSecs(secs)) ctx.showToast("Standaardvraag toegevoegd.", "ok");
    };
  });
  root.querySelectorAll("[data-q-form]").forEach((form) => {
    if (form.dataset.qForm === "bank") return; // vragenbank: zie bindBank
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
  // B9 (v3a): alleen echt open taken tellen; afgevinkt (ter controle) telt niet meer mee.
  const urgent = tasks.filter((t) => t.urgent && t.status === "open");
  const auditOpen = tasks.filter((t) => t.source && t.source.type === "audit" && t.status === "open");
  const setup = [];
  if (locationsReady && !locationsDoc) setup.push(dom`<button type="button" data-seed-locations>Locatielijst aanmaken</button>`);
  if (configReady() && !variants().length && locationsDoc) setup.push(dom`<button type="button" data-seed-config>Vragenlijst aanmaken</button>`);
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
  on("[data-dash-urgent]", () => ctx.showSection("taken", true, { filters: { status: "open", urgent: "yes" } }));
  on("[data-dash-audit-tasks]", () => ctx.showSection("taken", true, { filters: { status: "open", audit: "any" } }));
  on("[data-dash-audit]", () => ctx.showSection(a || !last ? "audit" : "audits"));
}

function renderDataV2() {
  const root = document.getElementById("data-v2");
  if (!root) return;
  const { dom } = ctx;
  root.replaceChildren(dom`
    <h3>Volledige back-up (ruw)</h3>
    <p class="section-intro">Download alle gegevens zoals ze in de database staan: taken, streefdatums, afgerond-door, herhalingen, medewerkers, extra gegevens, afdelingen, meldingen, locaties, vragenlijsten, standaardvragen, audits en de limieten van pincode-verzoeken. Bewaar dit bestand vóór elke grote wijziging. Startcodes zitten er niet in.</p>
    <div class="form-actions"><button type="button" data-raw-backup>Volledige back-up downloaden</button></div>
    <h3>Excel-export</h3>
    <p class="section-intro">Overzicht om te lezen of te delen (niet om terug te zetten): tabbladen Taken, Audits, Medewerkers (met extra gegevens), Meldingen en Terugkerende taken. Zonder pincodes, startcodes of andere inloggegevens, en zonder foto's.</p>
    <div class="form-actions"><button type="button" class="secondary" data-excel-export>Excel-export (.xlsx)</button></div>`);
  applyFlags(root);
  root.querySelector("[data-raw-backup]").onclick = () => exportRawBackup();
  root.querySelector("[data-excel-export]").onclick = () => exportExcel();
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
