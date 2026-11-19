import {
  auth,
  ADMIN_UID,
  onAuthStateChanged,
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut
} from "../firebase-init.js";
import { increment, arrayUnion, deleteField, Timestamp, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";
import {
  db,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  writeBatch,
  getDocs,
  listenCollection,
  generateDueInstances,
  normalizeTask,
  normalizeTemplate,
  normalizeEmployee,
  serializeTask,
  serializeTemplate,
  readCompressedPhotos,
  assertDocSize,
  generateStartCode,
  isValidStartCode,
  formatStartCode,
  isSafeImageDataUrl,
  START_CODE_VALID_DAYS,
  formatDate,
  formatDateTime,
  assigneeLabel,
  localDateKey,
  WEEKDAYS,
  SEED_EMPLOYEES,
  employeeSlug,
  normalizeName,
  STORAGE_TASKS,
  STORAGE_TEMPLATES,
  STORAGE_MIGRATED,
  safeParse
} from "../shared.js";
import {
  initV2,
  startV2Listeners,
  renderV2,
  fillLocationSelect,
  activeLocations,
  locationLabelById,
  locationsAvailable,
  taskLocationText,
  completionFor,
  addCompletionDelete,
  addAdminCompletion,
  exportRawBackup,
  taskMatchesAudit,
  sourceText,
  v2SubView
} from "./v2.js";

let isAdmin = false;
let tasks = [];
let templates = [];
let employees = [];
let currentTaskId = null;
let editingTemplateId = null;
let editingTaskId = null;
let knownDate = amsterdamDateKey(0);
let listenersStarted = false;
let generating = false;
let seededOnce = false;
let pinResetRequests = [];
let staffAccounts = [];
let rawTasks = [];
let taskMeta = new Map();
let taskMetaReady = false;
let migratingDueDates = false;
let startCodes = [];
let employeesReady = false;
let swUpdateHandlerBound = false;
let employeeDetails = new Map();
let staffCounters = new Map();
let empDashId = "";
let empDashFormFor = "";
let empDashDirty = false;
const EMP_DASH_KEY = "zeiklijst-admin-employee";


// ---- Veilig renderen ------------------------------------------------------
// dom`...` bouwt DOM uit een vaste, eigen HTML-template. Ingevoegde waarden worden nooit
// als HTML geparsed: in tekst worden ze tekstnodes (of geneste nodes uit dom``),
// in attributen gaan ze via setAttribute. Dynamische on*-, style-, src- en href-attributen
// zijn verboden; foto's gaan via safePhotoImg (img.src na isSafeImageDataUrl).
const DOM_SLOT = `zlslot${Math.random().toString(36).slice(2, 10)}x`;
const DOM_SLOT_RE = new RegExp(`${DOM_SLOT}(\\d+)_`, "g");
const DOM_BLOCKED_ATTRS = new Set(["style", "src", "href", "srcdoc", "srcset", "action", "formaction", "xlink:href"]);

function toNodes(value) {
  if (value == null || value === false || value === "") return document.createTextNode("");
  if (value instanceof Node) return value;
  if (Array.isArray(value)) {
    const frag = document.createDocumentFragment();
    for (const item of value) frag.append(toNodes(item));
    return frag;
  }
  return document.createTextNode(String(value));
}

function dom(strings, ...values) {
  let src = "";
  let inTag = false;
  strings.forEach((part, i) => {
    src += part;
    for (const ch of part) {
      if (ch === "<") inTag = true;
      else if (ch === ">") inTag = false;
    }
    if (i < values.length) src += inTag ? `${DOM_SLOT}${i}_` : `<!--${DOM_SLOT}${i}-->`;
  });
  const tpl = document.createElement("template");
  tpl.innerHTML = src; // alleen eigen markup + placeholders, nooit gebruikersdata
  const frag = tpl.content;
  const slots = [];
  const walker = document.createTreeWalker(frag, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.nodeType === Node.COMMENT_NODE) {
      if (node.data.startsWith(DOM_SLOT)) slots.push(node);
      continue;
    }
    for (const attr of [...node.attributes]) {
      if (attr.name.includes(DOM_SLOT)) throw new Error("dom: dynamische attribuutnaam niet toegestaan");
      if (!attr.value.includes(DOM_SLOT)) continue;
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || DOM_BLOCKED_ATTRS.has(name)) throw new Error(`dom: dynamisch ${name} niet toegestaan`);
      node.setAttribute(attr.name, attr.value.replace(DOM_SLOT_RE, (_, idx) => {
        const v = values[Number(idx)];
        return v == null || v === false ? "" : String(v);
      }));
    }
  }
  // Raw-text-elementen (textarea, title, ...) kennen geen commentaar: een slot zou letterlijke tekst worden.
  for (const el of frag.querySelectorAll("textarea, title, style, script, noscript")) {
    if (el.textContent.includes(DOM_SLOT)) throw new Error(`dom: geen dynamische inhoud in <${el.localName}>; zet .value na het renderen`);
  }
  for (const slot of slots) slot.replaceWith(toNodes(values[Number(slot.data.slice(DOM_SLOT.length))]));
  return frag;
}

function safePhotoImg(src, { className = "", alt = "Foto", enlarge = true } = {}) {
  if (!isSafeImageDataUrl(src)) return null;
  const img = document.createElement("img");
  if (className) img.className = className;
  img.alt = alt;
  img.src = src;
  if (enlarge) img.addEventListener("click", () => openLightbox(src, alt));
  return img;
}

function setOptions(select, items) {
  select.replaceChildren(...items.map(([value, label]) => new Option(label, value)));
}

function safeStatus(status) {
  return ["open", "pending", "afgerond"].includes(status) ? status : "open";
}

const SECTION_KEY = "zeiklijst-admin-section";
const SECTIONS = ["dashboard", "audit", "audits", "medewerkers", "medewerker", "taken", "controle", "workflow", "meldingen", "beheer", "data"];
const SECTION_LABELS = {
  dashboard: "Dashboard",
  audit: "Audit lopen",
  audits: "Audits",
  beheer: "Locaties & vragen",
  medewerkers: "Overzicht Medewerkers",
  medewerker: "Medewerker",
  taken: "Taken",
  controle: "Controle",
  workflow: "Workflow",
  meldingen: "Meldingen",
  data: "Data"
};
let currentSection = "dashboard";
let taskFilters = { q: "", status: "all", employee: "all", location: "all", recurring: "all", urgent: "all", audit: "all" };
let reports = [];
let reportFilter = "all";
let dialogResolve = null;
let toastTimer = null;

function writeErrorMessage(err) {
  const code = String((err && (err.code || err.message)) || "").toLowerCase();
  if (!navigator.onLine || code.includes("unavailable") || code.includes("network") || code.includes("offline")) {
    return "Geen verbinding. Probeer het later opnieuw.";
  }
  if (code.includes("permission-denied") || code.includes("permission") || code.includes("insufficient")) {
    return "Geen toestemming om dit te wijzigen.";
  }
  return (err && err.message) || "Opslaan mislukt.";
}

async function safeWrite(fn) {
  try {
    await fn();
    return true;
  } catch (err) {
    showToast(writeErrorMessage(err), "error");
    return false;
  }
}

// Inklapbare blokken op de Taken-pagina; ingeklapte staat blijft bewaard (eigenaar 12:01).
const FOLD_KEY = "zeiklijst-admin-folds";
function readFolds() {
  try { return JSON.parse(localStorage.getItem(FOLD_KEY) || "{}") || {}; } catch { return {}; }
}
function setupFolds() {
  const saved = readFolds();
  document.querySelectorAll("details.fold[data-fold]").forEach((el) => {
    const key = el.dataset.fold;
    if (saved[key] === false) el.open = false;
    el.addEventListener("toggle", () => {
      const now = readFolds();
      now[key] = el.open;
      try { localStorage.setItem(FOLD_KEY, JSON.stringify(now)); } catch { /* privé-modus */ }
    });
  });
}
function openFold(key) {
  const el = document.querySelector(`details.fold[data-fold="${key}"]`);
  if (el && !el.open) el.open = true;
}

// Brede schermen (eigenaar 12:03): de menuknoppen staan onder de tegels op het dashboard;
// het menu bovenaan is daar verborgen (CSS). Op de telefoon blijft het uitklapmenu.
function setupDashboardNav() {
  renderDashboardNav();
}
function renderDashboardNav() {
  const box = document.getElementById("dashboard-nav");
  if (!box) return;
  const items = [...document.querySelectorAll("#nav-menu [role=menuitem]")].filter((el) => !(el.dataset.section === "dashboard"));
  box.replaceChildren(...items.map((orig) => {
    const el = orig.cloneNode(true);
    el.removeAttribute("role");
    el.removeAttribute("aria-current");
    el.removeAttribute("id");
    el.querySelectorAll("[id]").forEach((c) => c.removeAttribute("id"));
    el.classList.add("dash-nav-btn");
    if (el.tagName === "BUTTON") {
      el.onclick = () => (orig.dataset.section ? showSection(orig.dataset.section) : orig.click());
      if (orig.id === "logout-btn") el.classList.add("secondary");
    }
    return el;
  }));
}

// Hiërarchische terug-functie (eigenaar 12:04): elke weergave heeft een ouder.
// Hoofdpagina's -> dashboard; medewerkerpagina -> Overzicht Medewerkers;
// subweergaven (audit-vragen/controle, audit-details, vraag-editor, taakdetail) -> hun pagina.
// De terugknop van de telefoon/browser doet hetzelfde via één "wacht"-item in de geschiedenis.
const SECTION_PARENT = {
  audit: "dashboard",
  audits: "dashboard",
  beheer: "dashboard",
  medewerkers: "dashboard",
  medewerker: "medewerkers",
  taken: "dashboard",
  controle: "dashboard",
  workflow: "dashboard",
  meldingen: "dashboard",
  data: "dashboard"
};
let historyGuard = false;
let skipNextPop = false;

function overlayOpen() {
  if (dialogResolve) return "dialog";
  const lb = document.getElementById("image-lightbox");
  if (lb && !lb.classList.contains("hidden")) return "lightbox";
  if (!document.getElementById("modal").classList.contains("hidden")) return "modal";
  return "";
}

function atRootView() {
  return currentSection === "dashboard" && !overlayOpen();
}

function upTarget(section = currentSection) {
  const sub = v2SubView(section);
  if (sub) return { label: sub.label, go: sub.up };
  const parent = SECTION_PARENT[section];
  if (!parent) return null;
  return { label: SECTION_LABELS[parent], go: () => showSection(parent) };
}

function goUp() {
  const overlay = overlayOpen();
  if (overlay === "dialog") closeDialog({ ok: false });
  else if (overlay === "lightbox") closeLightbox();
  else if (overlay === "modal") closeModal();
  else {
    const t = upTarget();
    if (t) t.go();
  }
  updateBackLabels();
}

// Knop in de app: één niveau omhoog. Staan we daarna op het dashboard, dan het wacht-item opruimen.
function goUpFromButton() {
  goUp();
  if (atRootView() && historyGuard) {
    historyGuard = false;
    skipNextPop = true;
    history.back();
  }
}

function ensureHistoryGuard() {
  if (atRootView() || historyGuard) return;
  history.pushState({ zeiklijstGuard: true }, "");
  historyGuard = true;
}

function setupHistory() {
  window.addEventListener("popstate", () => {
    if (skipNextPop) { skipNextPop = false; return; }
    historyGuard = false;
    if (document.getElementById("admin-app").classList.contains("hidden")) return;
    goUp();
    ensureHistoryGuard();
  });
  // Na elke klik/toets: labels bijwerken en zo nodig een wacht-item zetten.
  const after = () => setTimeout(() => { updateBackLabels(); if (!document.getElementById("admin-app").classList.contains("hidden")) ensureHistoryGuard(); }, 0);
  document.addEventListener("click", after);
  document.addEventListener("keyup", (e) => { if (e.key === "Enter" || e.key === " ") after(); });
}

function setupBackButtons() {
  document.querySelectorAll(".admin-section[data-section]").forEach((sec) => {
    const name = sec.dataset.section;
    if (name === "dashboard") return;
    let btn = sec.querySelector(":scope > .back-up");
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "secondary back-btn back-up";
      sec.prepend(btn);
    }
    btn.dataset.backFor = name;
    btn.onclick = goUpFromButton;
  });
  updateBackLabels();
}

function updateBackLabels() {
  document.querySelectorAll(".back-up[data-back-for]").forEach((btn) => {
    const t = upTarget(btn.dataset.backFor);
    const text = `← ${t ? t.label : "Dashboard"}`;
    if (btn.textContent !== text) btn.textContent = text;
    btn.setAttribute("aria-label", `Terug naar ${t ? t.label : "Dashboard"}`);
  });
}

function showToast(message, type = "error") {
  const el = document.getElementById("app-toast");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("error", type === "error");
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 4500);
}

function hideToast() {
  const el = document.getElementById("app-toast");
  if (el) el.classList.add("hidden");
  clearTimeout(toastTimer);
}

function closeDialog(result) {
  const dialog = document.getElementById("app-dialog");
  if (dialog) dialog.classList.add("hidden");
  const resolve = dialogResolve;
  dialogResolve = null;
  if (resolve) resolve(result || { ok: false });
}

function showDialog({ title, message, input = false, inputLabel = "Reden", inputPlaceholder = "", inputValue = "", confirmText = "Bevestigen", cancelText = "Annuleren", danger = false } = {}) {
  if (dialogResolve) closeDialog({ ok: false });
  hideToast(); // v24: de melding mag de knoppen van de dialoog niet afdekken (mobiel)
  return new Promise((resolve) => {
    dialogResolve = resolve;
    document.getElementById("app-dialog-title").textContent = title || "Bevestigen";
    document.getElementById("app-dialog-message").textContent = message || "";
    const wrap = document.getElementById("app-dialog-input-wrap");
    const field = document.getElementById("app-dialog-input");
    wrap.classList.toggle("hidden", !input);
    document.getElementById("app-dialog-input-label").textContent = inputLabel;
    field.value = inputValue || "";
    field.placeholder = inputPlaceholder;
    const confirmBtn = document.getElementById("app-dialog-confirm");
    confirmBtn.textContent = confirmText;
    confirmBtn.classList.toggle("danger", Boolean(danger));
    document.getElementById("app-dialog-cancel").textContent = cancelText;
    document.getElementById("app-dialog").classList.remove("hidden");
    setTimeout(() => (input ? field : confirmBtn).focus(), 30);
  });
}

async function confirmAction(message, { title = "Bevestigen", confirmText = "Bevestigen", danger = false } = {}) {
  const result = await showDialog({ title, message, confirmText, danger });
  return Boolean(result.ok);
}

function weekdayNames(values) {
  const map = new Map(WEEKDAYS.map((day) => [day.value, day.long]));
  return (values || []).map((value) => map.get(Number(value))).filter(Boolean);
}

async function maybeGenerate() {
  if (generating) return;
  generating = true;
  try {
    await generateDueInstances(templates, tasks);
  } finally {
    generating = false;
  }
}

function startListeners() {
  if (listenersStarted) return;
  listenersStarted = true;
  listenCollection("tasks", normalizeTask, (list) => {
    rawTasks = list;
    applyTaskMeta();
  });
  // L1: streefdatum staat in taskMeta/{taskId} (alleen admin + reader).
  listenCollection("taskMeta", (id, d) => ({ id, dueDate: d && typeof d.dueDate === "string" ? d.dueDate : "" }), (list) => {
    taskMeta = new Map(list.map((m) => [m.id, m]));
    taskMetaReady = true;
    applyTaskMeta();
  }, ignoreListenerError);
  listenCollection("recurring", normalizeTemplate, async (list) => {
    templates = list;
    await maybeGenerate();
    renderAll();
  });
  listenCollection("employees", normalizeEmployee, (list) => {
    employees = list.sort((a, b) => a.name.localeCompare(b.name, "nl"));
    employeesReady = true;
    renderAll();
    if (currentTaskId) openTask(currentTaskId);
    if (isAdmin && !seededOnce && employees.length === 0) {
      seededOnce = true;
      seedEmployees().catch(() => {});
    }
  }, ignoreListenerError);
  listenCollection("staffAccounts", (id, d) => ({
    id,
    employeeId: (d && d.employeeId) || "",
    pinVersion: Number.isFinite(Number(d && d.pinVersion)) ? Number(d.pinVersion) : 0,
    startCode: d && typeof d.startCode === "string" ? d.startCode : ""
  }), (list) => {
    staffAccounts = list;
    renderEmployees();
    renderEmployeeDashboard();
  }, ignoreListenerError);
  listenCollection("startCodes", normalizeStartCodeDoc, (list) => {
    startCodes = list;
    renderEmployees();
    renderEmployeeDashboard();
    renderPinResets();
  }, ignoreListenerError);
  listenCollection("pinResetRequests", normalizePinResetRequest, (list) => {
    pinResetRequests = list.slice().sort((a, b) => String(b.requestedAt || "").localeCompare(String(a.requestedAt || "")));
    renderPinResets();
    renderEmployeeDashboard();
    updateNavBadge();
  }, ignoreListenerError);
  // v24: extra gegevens per medewerker (alleen admin).
  listenCollection("employeeDetails", normalizeEmployeeDetails, (list) => {
    employeeDetails = new Map(list.map((d) => [d.id, d]));
    renderEmployeeDashboard();
  }, ignoreListenerError);
  listenCollection("staffDailyCounters", (id, d) => ({
    id,
    day: Number.isInteger(d && d.day) ? d.day : -1,
    tasks: Number(d && d.tasks) || 0,
    reports: Number(d && d.reports) || 0
  }), (list) => {
    staffCounters = new Map(list.map((c) => [c.id, c]));
    renderEmployeeDashboard();
  }, ignoreListenerError);
  listenCollection("reports", normalizeReport, (list) => {
    reports = list.slice().sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    renderReports();
    updateNavBadge();
  }, ignoreListenerError);
  // Build v2: locaties, vragenlijst, audits, afgerond-door.
  startV2Listeners();
}

function ignoreListenerError() {
  // New collections are denied until the latest rules are published.
}

function applyTaskMeta() {
  tasks = rawTasks.map((task) => {
    const meta = taskMeta.get(task.id);
    const dueDate = (meta && isValidDueDate(meta.dueDate)) ? meta.dueDate : (task.dueDate || "");
    // Build v2: afgerond door + tijdstip uit taskCompletions (alleen admin); oude velden als terugval.
    const done = completionFor(task.id);
    const doneBy = done ? done.name : (task.pendingBy || "");
    const doneAt = done ? done.at : (task.pendingAt || "");
    return { ...task, dueDate, doneBy, doneAt };
  });
  renderAll();
  if (currentTaskId) openTask(currentTaskId);
  migrateDueDates().catch(() => {});
}

// Verplaats oude tasks.dueDate naar taskMeta (eenmalig, werkt pas met de stap-3-regels).
async function migrateDueDates() {
  if (!isAdmin || !taskMetaReady || migratingDueDates) return;
  const legacy = rawTasks.filter((task) => isValidDueDate(task.dueDate));
  if (!legacy.length) return;
  migratingDueDates = true;
  try {
    let batch = writeBatch(db);
    let count = 0;
    for (const task of legacy) {
      if (!taskMeta.has(task.id)) {
        batch.set(doc(db, "taskMeta", task.id), { dueDate: task.dueDate.trim() });
        count += 1;
      }
      batch.update(doc(db, "tasks", task.id), { dueDate: deleteField() });
      count += 1;
      if (count >= 400) {
        await batch.commit();
        batch = writeBatch(db);
        count = 0;
      }
    }
    if (count) await batch.commit();
  } catch {
    // Regels nog niet gepubliceerd of offline: later opnieuw.
  } finally {
    migratingDueDates = false;
  }
}

// Status van de inlog van een medewerker, op basis van staffAccounts (admin-only).
function accountStatus(emp) {
  const version = Number(emp.pinVersion) || 0;
  const accounts = staffAccounts.filter((a) => a.employeeId === emp.id);
  const valid = accounts.find((a) => a.pinVersion === version && isValidStartCode(a.startCode));
  return { valid: Boolean(valid), stale: !valid && accounts.length > 0 };
}

function normalizeReport(id, data) {
  const d = data || {};
  const createdAt = d.createdAt && typeof d.createdAt.toDate === "function"
    ? d.createdAt.toDate().toISOString()
    : (d.createdAt || "");
  const status = ["nieuw", "in_behandeling", "opgelost"].includes(d.status) ? d.status : "nieuw";
  return {
    id,
    description: typeof d.description === "string" ? d.description : "",
    photo: typeof d.photo === "string" ? d.photo : "",
    employeeId: d.employeeId || "",
    employeeName: d.employeeName || "",
    createdAt,
    appVersion: typeof d.appVersion === "string" ? d.appVersion : "",
    device: typeof d.device === "string" ? d.device : "",
    status,
    adminNote: typeof d.adminNote === "string" ? d.adminNote : ""
  };
}

function isStaffCreatedTask(task) {
  return Boolean(task && task.createdByRole === "staff");
}

function isValidDueDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function readDueDateInput() {
  const value = (document.getElementById("due-date") && document.getElementById("due-date").value || "").trim();
  return isValidDueDate(value) ? value : "";
}

function formatDueDate(value) {
  if (!isValidDueDate(value)) return "";
  const [year, month, day] = value.trim().split("-");
  return `${day}-${month}-${year}`;
}

function isOverdue(task) {
  if (!task || task.status === "afgerond" || !isValidDueDate(task.dueDate)) return false;
  return task.dueDate.trim() < amsterdamDateKey(0);
}

// Streefdatum-tegel (eigenaar 12:03): telt taken met status open of pending (niet afgerond)
// en een geldige streefdatum die verstreken is (vóór vandaag) of binnenkort valt
// (vandaag t/m vandaag + DUE_SOON_DAYS). "Vandaag" = kalenderdatum in Europe/Amsterdam.
const DUE_SOON_DAYS = 2;
// Ook gebruikt voor audit-/herhaaldatums (K2). Geen const in de functie: wordt al bij module-start aangeroepen.
function amsterdamDateKey(offsetDays = 0) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const d = new Date(Date.UTC(get("year"), get("month") - 1, get("day") + offsetDays));
  return d.toISOString().slice(0, 10);
}
function isDueSoon(task) {
  if (!task || task.status === "afgerond" || !isValidDueDate(task.dueDate)) return false;
  const due = task.dueDate.trim();
  return due >= amsterdamDateKey(0) && due <= amsterdamDateKey(DUE_SOON_DAYS);
}
function isDueAttention(task) {
  return isOverdue(task) || isDueSoon(task);
}

function overdueTasks() {
  return tasks.filter(isOverdue).sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
}

function dueDateLabel(task) {
  if (!isValidDueDate(task && task.dueDate)) return "";
  const overdue = isOverdue(task);
  return dom`<div class="${overdue ? "task-due-date overdue" : "task-due-date"}">Streefdatum ${formatDueDate(task.dueDate)}</div>`;
}

function newStaffCreatedTasks() {
  return tasks.filter((task) => isStaffCreatedTask(task) && task.adminReview === "nieuw")
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

function newReportCount() {
  return reports.filter((r) => r.status === "nieuw").length;
}



function timestampToIso(value) {
  if (!value) return "";
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  return typeof value === "string" ? value : "";
}

function normalizeStartCodeDoc(id, data) {
  const d = data || {};
  const expiresAt = timestampToIso(d.expiresAt);
  return {
    id,
    employeeId: d.employeeId || "",
    pinVersion: Number.isFinite(Number(d.pinVersion)) ? Number(d.pinVersion) : 0,
    used: d.used === true,
    createdAt: timestampToIso(d.createdAt),
    usedAt: timestampToIso(d.usedAt),
    expiresAt,
    expiresAtMs: expiresAt ? Date.parse(expiresAt) : 0
  };
}

function openStartCodeFor(emp) {
  if (!emp) return null;
  const now = Date.now();
  const version = Number(emp.pinVersion) || 0;
  return startCodes
    .filter((c) => c.employeeId === emp.id && !c.used && c.expiresAtMs > now && c.pinVersion === version)
    .sort((a, b) => b.expiresAtMs - a.expiresAtMs)[0] || null;
}

function normalizePinResetRequest(id, data) {
  const d = data || {};
  return {
    id,
    legacyEmployeeId: typeof d.employeeId === "string" ? d.employeeId : "",
    name: typeof d.name === "string" ? d.name.slice(0, 60) : "",
    note: typeof d.note === "string" ? d.note.slice(0, 200) : "",
    requestedAt: d.requestedAt && typeof d.requestedAt.toDate === "function"
      ? d.requestedAt.toDate().toISOString()
      : (typeof d.requestedAt === "string" ? d.requestedAt : "")
  };
}

function nameIndexKey(name) {
  return normalizeName(name);
}



function employeeHasPin(emp) {
  return accountStatus(emp).valid;
}

function resetRequestName(req) {
  return req.name || "(geen naam)";
}

// M2: het verzoek bevat alleen een opgegeven naam; de admin kiest zelf de medewerker.
function guessEmployeeForRequest(req) {
  const active = activeEmployees();
  if (req.legacyEmployeeId) {
    const byId = active.find((e) => e.id === req.legacyEmployeeId);
    if (byId) return byId;
  }
  const key = nameIndexKey(req.name);
  const matches = active.filter((e) => nameIndexKey(e.name) === key);
  return matches.length === 1 ? matches[0] : null;
}



function findNameConflict(name, employeeId) {
  const key = nameIndexKey(name);
  if (!key) return "Ongeldige naam.";
  const taken = employees.find((e) => e.id !== employeeId && nameIndexKey(e.name) === key);
  if (taken) return `De naam ${taken.name} is al in gebruik.`;
  return "";
}





function renderPinResets() {
  const targets = ["dashboard-pin-resets", "medewerkers-pin-resets"];
  for (const id of targets) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.classList.toggle("hidden", !pinResetRequests.length);
    if (!pinResetRequests.length) {
      el.replaceChildren();
      continue;
    }
    el.replaceChildren(dom`<h3>Pincode vergeten</h3>`, ...pinResetRequests.map(pinResetItem));
  }
}

function pinResetItem(req) {
  const when = req.requestedAt ? formatDateTime(req.requestedAt) : "";
  const guess = guessEmployeeForRequest(req);
  const frag = dom`
    <div class="pin-reset-item">
      <p><strong>Opgegeven naam: ${resetRequestName(req)}</strong>${when ? " · " + when : ""}
        ${req.note ? dom`<span class="pin-meta pre-line">Toelichting: ${req.note}</span>` : ""}
        <span class="pin-meta">Niet gecontroleerd. Maak alleen een startcode als de medewerker het persoonlijk aan je vraagt.</span></p>
      <label class="pin-reset-pick">Medewerker
        <select data-pick-employee></select>
      </label>
      <div class="pin-reset-actions">
        <button type="button" data-issue-code>Startcode maken</button>
        <button type="button" class="secondary" data-dismiss-reset>Verzoek wissen</button>
      </div>
    </div>`;
  const select = frag.querySelector("[data-pick-employee]");
  setOptions(select, [["", "Kies medewerker…"], ...activeEmployees().map((e) => [e.id, e.name])]);
  select.value = guess ? guess.id : "";
  frag.querySelector("[data-issue-code]").onclick = () => {
    if (!select.value) {
      showToast("Kies eerst de medewerker die dit verzoek deed.");
      return;
    }
    issueStartCode(select.value, { requestId: req.id });
  };
  frag.querySelector("[data-dismiss-reset]").onclick = () => dismissResetRequest(req.id);
  return frag;
}

async function dismissResetRequest(id) {
  const req = pinResetRequests.find((r) => r.id === id);
  const name = req ? resetRequestName(req) : id;
  const confirmed = await confirmAction(`Verzoek "${name}" wissen zonder startcode te maken?`, { title: "Verzoek wissen", confirmText: "Wissen" });
  if (!confirmed) return;
  await safeWrite(() => deleteDoc(doc(db, "pinResetRequests", id)));
}

// Pincode resetten = nieuwe startcode maken (zelfde batch).
async function resetEmployeePin(id) {
  return issueStartCode(id);
}

// Eén admin-batch: pinVersion+1, resetverzoek weg,
// oudere codes van deze medewerker weg, nieuwe code met de nieuwe pinVersion.
async function issueStartCode(employeeId, { requestId = "" } = {}) {
  const emp = employees.find((e) => e.id === employeeId);
  if (!emp) {
    showToast("Medewerker niet gevonden.");
    return;
  }
  if (emp.active === false) {
    showToast(`${emp.name} is inactief. Activeer de medewerker eerst.`);
    return;
  }
  const hasPin = employeeHasPin(emp);
  const parts = [];
  if (hasPin) parts.push(`De huidige pincode van ${emp.name} werkt daarna niet meer.`);
  if (openStartCodeFor(emp)) parts.push("De vorige open startcode vervalt.");
  parts.push("Geef de code alleen persoonlijk aan de medewerker.");
  const confirmed = await confirmAction(`Startcode maken voor ${emp.name}? ${parts.join(" ")}`, {
    title: hasPin ? "Pincode resetten" : "Startcode maken",
    confirmText: "Startcode maken",
    danger: hasPin
  });
  if (!confirmed) return;
  const code = generateStartCode();
  const createdAt = Timestamp.now();
  const expiresAt = Timestamp.fromMillis(createdAt.toMillis() + START_CODE_VALID_DAYS * 86400000);
  const ok = await safeWrite(async () => {
    const batch = writeBatch(db);
    addStartCodeOps(batch, emp, code, createdAt, expiresAt, requestId);
    await batch.commit();
  });
  if (ok) showStartCode({ name: emp.name, code, expiresAt: expiresAt.toDate().toISOString() });
}

// Voegt de uitgifte-writes voor één medewerker toe aan een batch; geeft het aantal writes terug.
// Voegt de uitgifte-writes voor één medewerker toe aan een batch; geeft het aantal writes terug.
// De code bevat de weergavenaam (name), zodat de medewerkers-app geen nameIndex nodig heeft.
function addStartCodeOps(batch, emp, code, createdAt, expiresAt, requestId = "") {
  const pinVersion = (Number(emp.pinVersion) || 0) + 1;
  let writes = 0;
  batch.update(doc(db, "employees", emp.id), { pinVersion });
  writes += 1;
  for (const req of pinResetRequests.filter((r) => r.id === requestId || r.id === emp.id || r.legacyEmployeeId === emp.id)) {
    batch.delete(doc(db, "pinResetRequests", req.id));
    writes += 1;
  }
  for (const old of startCodes.filter((c) => c.employeeId === emp.id && c.id !== code)) {
    batch.delete(doc(db, "startCodes", old.id));
    writes += 1;
  }
  batch.set(doc(db, "startCodes", code), { employeeId: emp.id, name: emp.name, pinVersion, createdAt, expiresAt, used: false });
  return writes + 1;
}

async function issueStartCodesForAllActive() {
  const list = activeEmployees();
  if (!list.length) {
    showToast("Er zijn geen actieve medewerkers.");
    return;
  }
  const confirmed = await confirmAction(
    `Voor ${list.length} actieve ${list.length === 1 ? "medewerker" : "medewerkers"} een nieuwe startcode maken? Alle huidige pincodes en open startcodes vervallen. Iedereen moet daarna met de nieuwe code opnieuw een pincode instellen. Inactieve medewerkers krijgen geen code.`,
    { title: "Startcodes voor iedereen", confirmText: "Startcodes maken", danger: true }
  );
  if (!confirmed) return;
  const createdAt = Timestamp.now();
  const expiresAt = Timestamp.fromMillis(createdAt.toMillis() + START_CODE_VALID_DAYS * 86400000);
  const issued = [];
  const ok = await safeWrite(async () => {
    let batch = writeBatch(db);
    let count = 0;
    let pending = [];
    for (const emp of list) {
      const code = generateStartCode();
      count += addStartCodeOps(batch, emp, code, createdAt, expiresAt);
      pending.push({ name: emp.name, code });
      if (count >= 400) {
        await batch.commit();
        issued.push(...pending);
        pending = [];
        batch = writeBatch(db);
        count = 0;
      }
    }
    if (count) await batch.commit();
    issued.push(...pending);
  });
  if (issued.length) showBulkStartCodes(issued, expiresAt.toDate().toISOString());
  if (!ok && issued.length) showToast(`Niet alle codes zijn gemaakt (${issued.length} van ${list.length}).`);
}

function showBulkStartCodes(items, expiresAt) {
  const dialog = document.getElementById("bulk-code-dialog");
  if (!dialog) return;
  document.getElementById("bulk-code-expiry").textContent = `Geldig tot ${formatDateTime(expiresAt)} · eenmalig per medewerker`;
  const copy = async (text, btn) => {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Gekopieerd";
    } catch {
      showToast("Kopiëren lukte niet. Selecteer de code handmatig.");
    }
  };
  const rows = items.map((item) => {
    const formatted = formatStartCode(item.code);
    const frag = dom`
      <li class="bulk-code-row">
        <span class="bulk-code-name">${item.name}</span>
        <span class="bulk-code-code">${formatted}</span>
        <button type="button" class="secondary">Kopiëren</button>
      </li>`;
    const btn = frag.querySelector("button");
    btn.onclick = () => copy(`${item.name}: ${formatted}`, btn);
    return frag;
  });
  document.getElementById("bulk-code-list").replaceChildren(...rows);
  const allBtn = document.getElementById("bulk-code-copy-all");
  allBtn.textContent = "Alles kopiëren";
  allBtn.onclick = () => copy(items.map((i) => `${i.name}: ${formatStartCode(i.code)}`).join("\n"), allBtn);
  document.getElementById("bulk-code-close").onclick = () => dialog.classList.add("hidden");
  dialog.classList.remove("hidden");
}

function showStartCode({ name, code, expiresAt }) {
  const dialog = document.getElementById("code-dialog");
  if (!dialog) return;
  hideToast();
  const formatted = formatStartCode(code);
  document.getElementById("code-dialog-name").textContent = name ? `Voor ${name}` : "";
  document.getElementById("code-dialog-code").textContent = formatted;
  document.getElementById("code-dialog-expiry").textContent = expiresAt ? `Geldig tot ${formatDateTime(expiresAt)}` : "";
  const copyBtn = document.getElementById("code-dialog-copy");
  copyBtn.textContent = "Kopiëren";
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(formatted);
      copyBtn.textContent = "Gekopieerd";
    } catch {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById("code-dialog-code"));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      showToast("Kopiëren lukte niet. De code is geselecteerd.");
    }
  };
  document.getElementById("code-dialog-close").onclick = () => dialog.classList.add("hidden");
  dialog.classList.remove("hidden");
}

async function deleteStartCode(codeId) {
  const code = startCodes.find((c) => c.id === codeId);
  if (!code) return;
  const emp = employees.find((e) => e.id === code.employeeId);
  const confirmed = await confirmAction(
    `Startcode van ${emp ? emp.name : "deze medewerker"} verwijderen? Met deze code kan dan geen pincode meer worden ingesteld.`,
    { title: "Startcode verwijderen", confirmText: "Verwijderen", danger: true }
  );
  if (!confirmed) return;
  const ok = await safeWrite(() => deleteDoc(doc(db, "startCodes", codeId)));
  if (ok) showToast("Startcode verwijderd.", "ok");
}


function applyAuthUi() {
  document.getElementById("login-screen").classList.toggle("hidden", isAdmin);
  document.getElementById("admin-app").classList.toggle("hidden", !isAdmin);
  document.getElementById("admin-controls").classList.toggle("hidden", !isAdmin);
  if (isAdmin) {
    offerMigrationIfNeeded();
    startListeners();
    showSection(readStoredSection(), false);
  } else {
    closeNav();
  }
}

function setupUi() {
  document.getElementById("login-form").onsubmit = submitLogin;
  document.getElementById("logout-btn").onclick = logout;
  document.getElementById("nav-toggle").onclick = (event) => {
    event.stopPropagation();
    toggleNav();
  };
  document.getElementById("nav-menu").querySelectorAll("[data-section]").forEach((btn) => {
    btn.onclick = () => showSection(btn.dataset.section);
  });
  document.addEventListener("click", (event) => {
    const nav = document.getElementById("admin-nav");
    if (nav && !nav.contains(event.target)) closeNav();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (dialogResolve) {
      closeDialog({ ok: false });
      return;
    }
    const lightbox = document.getElementById("image-lightbox");
    if (lightbox && !lightbox.classList.contains("hidden")) {
      closeLightbox();
      return;
    }
    if (!document.getElementById("modal").classList.contains("hidden")) {
      closeModal();
      return;
    }
    closeNav();
  });
  document.getElementById("stat-open-card").onclick = () => showSection("taken", true, { filters: { status: "open" } });
  document.getElementById("stat-pending-card").onclick = () => showSection("controle");
  const overdueCard = document.getElementById("stat-overdue-card");
  if (overdueCard) overdueCard.onclick = () => showSection("taken", true, { filters: { status: "due" } });
  document.getElementById("task-search").oninput = (event) => {
    taskFilters.q = event.target.value;
    renderTasks();
    renderCompleted();
  };
  document.querySelectorAll("#filter-status [data-filter]").forEach((btn) => {
    btn.onclick = () => {
      taskFilters.status = btn.dataset.filter;
      syncFilterUi();
      renderTasks();
    };
  });
  document.querySelectorAll("#filter-recurring [data-filter]").forEach((btn) => {
    btn.onclick = () => {
      taskFilters.recurring = btn.dataset.filter;
      syncFilterUi();
      renderTasks();
      renderCompleted();
    };
  });
  document.querySelectorAll("#filter-urgent [data-filter]").forEach((btn) => {
    btn.onclick = () => {
      taskFilters.urgent = btn.dataset.filter;
      syncFilterUi();
      renderTasks();
      renderCompleted();
    };
  });
  const auditClear = document.getElementById("filter-audit-clear");
  if (auditClear) auditClear.onclick = () => {
    taskFilters.audit = "all";
    syncFilterUi();
    renderTasks();
    renderCompleted();
  };
  // Owner 11:44: logo -> dashboard; terugknop op de medewerkerpagina.
  const logoBtn = document.getElementById("logo-home");
  if (logoBtn) logoBtn.onclick = () => showSection("dashboard");
  setupFolds();
  setupBackButtons();
  setupDashboardNav();
  const logoTitle = document.getElementById("logo-home-title");
  if (logoTitle) logoTitle.onclick = () => showSection("dashboard");
  setupHistory();
  document.getElementById("filter-employee").onchange = (event) => {
    taskFilters.employee = event.target.value;
    renderTasks();
    renderCompleted();
  };
  document.getElementById("filter-location").onchange = (event) => {
    taskFilters.location = event.target.value;
    renderTasks();
    renderCompleted();
  };
  document.getElementById("app-dialog-cancel").onclick = () => closeDialog({ ok: false });
  document.getElementById("app-dialog-confirm").onclick = () => {
    closeDialog({ ok: true, value: document.getElementById("app-dialog-input").value });
  };
  document.getElementById("app-dialog").onclick = (event) => {
    if (event.target.id === "app-dialog") closeDialog({ ok: false });
  };
  document.querySelectorAll("#report-filter-status [data-report-filter]").forEach((btn) => {
    btn.onclick = () => {
      reportFilter = btn.dataset.reportFilter;
      renderReports();
    };
  });
  const lightbox = document.getElementById("image-lightbox");
  const lightboxClose = document.getElementById("lightbox-close");
  if (lightboxClose) lightboxClose.onclick = closeLightbox;
  if (lightbox) lightbox.onclick = (event) => {
    if (event.target.id === "image-lightbox") closeLightbox();
  };
  document.getElementById("cleanup-btn").onclick = cleanupOldCompleted;
  const purgeBtn = document.getElementById("purge-name-index-btn");
  if (purgeBtn) purgeBtn.onclick = purgeNameIndex;
  document.getElementById("workflow-period").onchange = renderWorkflow;
  document.getElementById("export-btn").onclick = exportData;
  document.getElementById("import-btn").onclick = () => document.getElementById("import-file").click();
  document.getElementById("import-file").onchange = importData;
  document.getElementById("migrate-btn").onclick = migrateLocalToFirebase;
  document.getElementById("migrate-dismiss").onclick = () => {
    localStorage.setItem(STORAGE_MIGRATED, "1");
    document.getElementById("migration-banner").classList.add("hidden");
  };
  showAdminVersion();
  document.getElementById("add-task-form").onsubmit = submitTaskForm;
  document.getElementById("photos").onchange = updatePhotosChosen;
  document.getElementById("task-cancel-edit").onclick = resetTaskForm;
  document.getElementById("is-recurring").onchange = updateRecurrenceVisibility;
  document.getElementById("recurrence-type").onchange = updateRecurrenceVisibility;
  document.getElementById("modal-close").onclick = closeModal;
  document.getElementById("modal").onclick = (event) => {
    if (event.target.id === "modal") closeModal();
  };
  document.getElementById("reassign-btn").onclick = reassignCurrentTask;
  const relocateBtn = document.getElementById("relocate-btn");
  if (relocateBtn) relocateBtn.onclick = relocateCurrentTask;
  document.getElementById("add-employee-form").onsubmit = addEmployee;
  document.getElementById("seed-employees-btn").onclick = () => seedEmployees();
  const bulkBtn = document.getElementById("bulk-startcodes-btn");
  if (bulkBtn) bulkBtn.onclick = () => issueStartCodesForAllActive();
  buildWeekdayPicker();
  setupEmployeeDashboard();
  initV2({
    dom,
    showToast,
    showDialog,
    confirmAction,
    safeWrite,
    showSection,
    renderAll,
    applyTaskMeta,
    getTasks: () => tasks,
    getRawTasks: () => rawTasks
  });
  document.getElementById("recurrence-start").value = amsterdamDateKey(0);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) checkDateChange();
  });
  setInterval(checkDateChange, 60000);
  setupServiceWorkerUpdates();
}

function setupServiceWorkerUpdates() {
  if (!("serviceWorker" in navigator)) return;
  const bar = document.getElementById("update-bar");
  const offer = (worker) => {
    if (!bar || !worker) return;
    bar.classList.remove("hidden");
    bar.onclick = () => worker.postMessage({ type: "SKIP_WAITING" });
  };
  navigator.serviceWorker.register("./sw.js").then((reg) => {
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener("updatefound", () => {
      const worker = reg.installing;
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) offer(worker);
      });
    });
  }).catch(() => {});
  if (swUpdateHandlerBound) return;
  swUpdateHandlerBound = true;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}

function checkDateChange() {
  const today = amsterdamDateKey(0);
  if (today !== knownDate) {
    knownDate = today;
    maybeGenerate();
  }
}

function buildWeekdayPicker() {
  document.getElementById("weekday-picker").innerHTML = WEEKDAYS.map((day) => `
    <label>
      <input type="checkbox" value="${day.value}">
      <span>${day.short}</span>
    </label>
  `).join("");
}

function updateRecurrenceVisibility() {
  const recurring = document.getElementById("is-recurring").checked || Boolean(editingTemplateId);
  document.getElementById("recurrence-fields").classList.toggle("hidden", !recurring);
  const type = document.getElementById("recurrence-type").value;
  document.getElementById("weekday-picker").classList.toggle("hidden", !recurring || type !== "weekdays");
  document.getElementById("date-picker-fields").classList.toggle("hidden", !recurring || type !== "date");
  const dueWrap = document.getElementById("due-date-wrap");
  if (dueWrap) dueWrap.classList.toggle("hidden", recurring);
}

async function submitLogin(event) {
  event.preventDefault();
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const error = document.getElementById("login-error");
  document.getElementById("login-password").value = "";
  try {
    await signInWithEmailAndPassword(auth, email, password);
    error.classList.add("hidden");
  } catch {
    error.classList.remove("hidden");
    document.getElementById("login-password").focus();
  }
}

async function logout() {
  await signOut(auth);
}

function activeEmployees() {
  return employees.filter((e) => e.active);
}

// Toewijzing (eigenaar 12:20): één persoon of "Allen". Opslag voor Allen = assigneeId "ALLEN" + assigneeName "Allen".
// Oude taken zonder persoon (assigneeId leeg/null/ontbreekt en geen naam) tonen en filteren we als Allen; geen migratie.
function isAllenTask(task) {
  if (!task) return false;
  const name = String(task.assigneeName || "").trim();
  if (task.assigneeId === "ALLEN" || name.toLowerCase() === "allen") return true;
  return !task.assigneeId && !name;
}
function adminAssigneeLabel(task) {
  return isAllenTask(task) ? "Allen" : assigneeLabel(task);
}
// Waarde voor de keuzelijsten: zonder persoon = Allen.
function assigneeSelectValue(item) {
  return isAllenTask(item) ? "ALLEN" : (item.assigneeId || "ALLEN");
}

function fillAssigneeSelects() {
  const options = [
    ["ALLEN", "Allen"],
    ...activeEmployees().map((e) => [e.id, e.name])
  ];
  const formSelect = document.getElementById("assignee-select");
  const current = formSelect.value;
  setOptions(formSelect, options);
  if ([...formSelect.options].some((o) => o.value === current)) formSelect.value = current;
  const reassign = document.getElementById("reassign-select");
  if (reassign) {
    const rec = reassign.value;
    setOptions(reassign, options);
    if ([...reassign.options].some((o) => o.value === rec)) reassign.value = rec;
  }
}

function assigneeFromSelect(select) {
  const id = select.value;
  if (!id || id === "ALLEN") return { assigneeId: "ALLEN", assigneeName: "Allen" };
  const emp = employees.find((e) => e.id === id);
  return { assigneeId: id, assigneeName: emp ? emp.name : "" };
}

function selectedWeekdays() {
  return [...document.querySelectorAll("#weekday-picker input:checked")].map((input) => Number(input.value));
}

function setSelectedWeekdays(days) {
  const set = new Set((days || []).map(Number));
  document.querySelectorAll("#weekday-picker input").forEach((input) => {
    input.checked = set.has(Number(input.value));
  });
}

function readRecurrenceFromForm() {
  const type = document.getElementById("recurrence-type").value;
  const startDate = document.getElementById("recurrence-start").value || amsterdamDateKey(0);
  const recurrence = { type, startDate };
  if (type === "weekdays") {
    recurrence.weekdays = selectedWeekdays();
    if (!recurrence.weekdays.length) {
      showToast("Kies minstens één weekdag.");
      return null;
    }
  }
  if (type === "date") {
    recurrence.date = document.getElementById("recurrence-date").value;
    recurrence.monthly = document.getElementById("recurrence-monthly").checked;
    if (!recurrence.date) {
      showToast("Kies een datum voor de herhaling.");
      return null;
    }
  }
  return recurrence;
}

async function submitTaskForm(event) {
  event.preventDefault();
  const title = document.getElementById("title").value.trim();
  const description = document.getElementById("description").value.trim();
  // Build v2: locatie alleen uit de vaste lijst; spoed alleen door de admin.
  const locationId = document.getElementById("location-select").value || "";
  const urgent = document.getElementById("is-urgent").checked;
  const editingItem = editingTaskId ? tasks.find((t) => t.id === editingTaskId) : (editingTemplateId ? templates.find((t) => t.id === editingTemplateId) : null);
  if (!title) {
    showToast("Vul een titel in.");
    document.getElementById("title").focus();
    return;
  }
  // Eigenaar 13:01: de admin kiest altijd een locatie (ook bij bewerken van een oude taak zonder locatie).
  if (!locationId) {
    showToast("Kies een locatie.");
    document.getElementById("location-select").focus();
    return;
  }
  // K5: de locatietekst alleen aanpassen als de locatiekeuze verandert. Een oude tekst ("koppelen")
  // blijft staan bij een eerste koppeling; bij wisselen tussen vaste locaties wordt het label gezet.
  const prevId = editingItem ? (editingItem.locationId || "") : "";
  const prevText = editingItem ? (editingItem.location || "") : "";
  const location = editingItem && locationId === prevId
    ? prevText
    : (editingItem && !prevId && prevText ? prevText : locationLabelById(locationId));
  const locFields = editingItem && locationId === prevId ? {} : { location, locationId };
  const assignee = assigneeFromSelect(document.getElementById("assignee-select"));
  let photos = [];
  try {
    photos = await readCompressedPhotos(document.getElementById("photos").files);
  } catch (err) {
    showToast(err.message || "Foto's konden niet worden verwerkt.");
    return;
  }

  try {
    if (editingTaskId) {
      const task = tasks.find((item) => item.id === editingTaskId);
      if (!task) return;
      const nextPhotos = photos.length ? photos : (task.photos || []);
      const payload = {
        title,
        description,
        ...assignee,
        photos: nextPhotos,
        urgent
      };
      assertDocSize({ ...serializeTask({ ...task, ...payload, location, locationId }), ...payload });
      const dueDate = readDueDateInput();
      const ok = await safeWrite(async () => {
        const batch = writeBatch(db);
        batch.update(doc(db, "tasks", editingTaskId), { ...payload, ...locFields, dueDate: deleteField() });
        if (dueDate) batch.set(doc(db, "taskMeta", editingTaskId), { dueDate });
        else batch.delete(doc(db, "taskMeta", editingTaskId));
        await batch.commit();
      });
      if (ok) resetTaskForm();
      return;
    }

    if (editingTemplateId) {
      const template = templates.find((item) => item.id === editingTemplateId);
      if (!template) return;
      const recurrence = readRecurrenceFromForm();
      if (!recurrence) return;
      const payload = serializeTemplate({
        ...template,
        title,
        description,
        location,
        locationId,
        urgent,
        ...assignee,
        photos: photos.length ? photos : template.photos,
        recurrence
      });
      assertDocSize(payload);
      const ok = await safeWrite(() => updateDoc(doc(db, "recurring", editingTemplateId), payload));
      if (ok) resetTaskForm();
      return;
    }

    if (document.getElementById("is-recurring").checked) {
      const recurrence = readRecurrenceFromForm();
      if (!recurrence) return;
      const payload = serializeTemplate({
        title,
        description,
        location,
        locationId,
        urgent,
        ...assignee,
        photos,
        recurrence,
        paused: false,
        createdAt: new Date().toISOString()
      });
      assertDocSize(payload);
      const ok = await safeWrite(() => addDoc(collection(db, "recurring"), payload));
      if (ok) resetTaskForm();
      return;
    }

    const payload = serializeTask({
      title,
      description,
      location,
      locationId,
      urgent,
      ...assignee,
      photos,
      status: "open",
      createdAt: new Date().toISOString()
    });
    delete payload.dueDate; // L1: streefdatum alleen in taskMeta
    assertDocSize(payload);
    const dueDate = readDueDateInput();
    const ok = await safeWrite(async () => {
      const ref = doc(collection(db, "tasks"));
      const batch = writeBatch(db);
      batch.set(ref, payload);
      if (dueDate) batch.set(doc(db, "taskMeta", ref.id), { dueDate });
      await batch.commit();
    });
    if (ok) resetTaskForm();
  } catch (err) {
    showToast(err.message || "Opslaan mislukt.");
  }
}

// Versielabel uit admin/version.js (dezelfde bron als de SW-cachenaam).
function showAdminVersion() {
  const el = document.getElementById("app-version");
  const v = Number(globalThis.ZEIKLIJST_ADMIN_VERSION);
  if (el) el.textContent = Number.isInteger(v) && v > 0 ? `admin v${v}` : "admin";
}

function updatePhotosChosen() {
  const input = document.getElementById("photos");
  const out = document.getElementById("photos-chosen");
  if (!input || !out) return;
  const n = input.files ? input.files.length : 0;
  out.textContent = n ? `${n} ${n === 1 ? "foto" : "foto's"} gekozen` : "Geen foto gekozen";
}

function resetTaskForm() {
  editingTemplateId = null;
  editingTaskId = null;
  document.getElementById("add-task-form").reset();
  updatePhotosChosen();
  document.getElementById("recurrence-start").value = amsterdamDateKey(0);
  setSelectedWeekdays([]);
  fillLocationSelect(document.getElementById("location-select"), "");
  setLegacyLocationNote("");
  document.getElementById("task-form-heading").textContent = "Nieuwe taak";
  document.getElementById("task-submit-btn").textContent = "Taak toevoegen";
  document.getElementById("task-cancel-edit").classList.add("hidden");
  document.getElementById("is-recurring").disabled = false;
  document.getElementById("photo-note").classList.add("hidden");
  updateRecurrenceVisibility();
}

function setLegacyLocationNote(text) {
  const note = document.getElementById("location-legacy");
  if (!note) return;
  note.textContent = text ? `Oude locatie: “${text}”. Kies hierboven een vaste locatie om op te slaan; de oude tekst blijft bewaard.` : "";
  note.classList.toggle("hidden", !text);
}

function openTaskForm() {
  document.getElementById("task-form-panel").open = true;
}

function startEditTask(id) {
  const task = tasks.find((item) => item.id === id);
  if (!task) return;
  editingTaskId = id;
  editingTemplateId = null;
  closeModal();
  showSection("taken");
  document.getElementById("title").value = task.title || "";
  fillLocationSelect(document.getElementById("location-select"), task.locationId || "");
  setLegacyLocationNote(task.locationId ? "" : (task.location || ""));
  document.getElementById("is-urgent").checked = Boolean(task.urgent);
  document.getElementById("description").value = task.description || "";
  document.getElementById("assignee-select").value = assigneeSelectValue(task);
  document.getElementById("due-date").value = isValidDueDate(task.dueDate) ? task.dueDate : "";
  document.getElementById("is-recurring").checked = false;
  document.getElementById("is-recurring").disabled = true;
  document.getElementById("photos").value = "";
  updatePhotosChosen();
  const count = (task.photos || []).length;
  const note = document.getElementById("photo-note");
  note.textContent = count
    ? `${count} foto('s) aanwezig. Een nieuwe keuze vervangt ze (max. 4).`
    : "Nog geen foto's. Je kunt er nu maximaal 4 toevoegen.";
  note.classList.remove("hidden");
  document.getElementById("task-form-heading").textContent = "Taak bewerken";
  document.getElementById("task-submit-btn").textContent = "Opslaan";
  document.getElementById("task-cancel-edit").classList.remove("hidden");
  updateRecurrenceVisibility();
  openTaskForm();
  document.getElementById("title").focus();
}

function startEditTemplate(id) {
  const template = templates.find((item) => item.id === id);
  if (!template) return;
  editingTemplateId = id;
  document.getElementById("title").value = template.title || "";
  fillLocationSelect(document.getElementById("location-select"), template.locationId || "");
  setLegacyLocationNote(template.locationId ? "" : (template.location || ""));
  document.getElementById("is-urgent").checked = Boolean(template.urgent);
  document.getElementById("description").value = template.description || "";
  document.getElementById("assignee-select").value = assigneeSelectValue(template);
  document.getElementById("is-recurring").checked = true;
  document.getElementById("is-recurring").disabled = true;
  const recurrence = template.recurrence || {};
  document.getElementById("recurrence-type").value = recurrence.type || "daily";
  document.getElementById("recurrence-start").value = recurrence.startDate || amsterdamDateKey(0);
  document.getElementById("recurrence-date").value = recurrence.date || "";
  document.getElementById("recurrence-monthly").checked = Boolean(recurrence.monthly);
  setSelectedWeekdays(recurrence.weekdays || []);
  editingTaskId = null;
  document.getElementById("photos").value = "";
  updatePhotosChosen();
  const count = (template.photos || []).length;
  const note = document.getElementById("photo-note");
  note.textContent = count
    ? `${count} foto('s) aanwezig. Een nieuwe keuze vervangt ze (max. 4).`
    : "Nog geen foto's. Je kunt er nu maximaal 4 toevoegen.";
  note.classList.remove("hidden");
  document.getElementById("task-form-heading").textContent = "Terugkerende taak bewerken";
  document.getElementById("task-submit-btn").textContent = "Opslaan";
  document.getElementById("task-cancel-edit").classList.remove("hidden");
  updateRecurrenceVisibility();
  openTaskForm();
  document.getElementById("title").focus();
}

async function pauseTemplate(id) {
  const template = templates.find((item) => item.id === id);
  if (!template) return;
  await safeWrite(() => updateDoc(doc(db, "recurring", id), { paused: !template.paused }));
}

async function deleteTemplate(id) {
  const ok = await confirmAction("Deze terugkerende taak verwijderen? Bestaande taken blijven bewaard.", { title: "Verwijderen", confirmText: "Verwijderen", danger: true });
  if (!ok) return;
  if (await safeWrite(() => deleteDoc(doc(db, "recurring", id)))) {
    if (editingTemplateId === id) resetTaskForm();
  }
}

function describeRecurrence(template) {
  const recurrence = template.recurrence || {};
  const from = recurrence.startDate ? `, vanaf ${formatDate(recurrence.startDate)}` : "";
  if (recurrence.type === "daily") return `Elke dag${from}`;
  if (recurrence.type === "every_other_day") return `Om de dag${from}`;
  if (recurrence.type === "weekdays") {
    const names = weekdayNames(recurrence.weekdays);
    if (!names.length) return `Op gekozen weekdagen${from}`;
    if (names.length === 1) return `Elke ${names[0]}${from}`;
    return `Elke ${names.slice(0, -1).join(", ")} en ${names[names.length - 1]}${from}`;
  }
  if (recurrence.type === "date") {
    if (recurrence.monthly && recurrence.date) {
      const day = Number(String(recurrence.date).split("-")[2]);
      return `Maandelijks op de ${day}e${from}`;
    }
    return recurrence.date ? `Op ${formatDate(recurrence.date)}` : "Op een specifieke datum";
  }
  return "Herhalend";
}

function readStoredSection() {
  const stored = localStorage.getItem(SECTION_KEY);
  return SECTIONS.includes(stored) ? stored : "dashboard";
}

function toggleNav() {
  const open = document.getElementById("nav-menu").classList.contains("hidden");
  if (open) openNav();
  else closeNav();
}

function openNav() {
  document.getElementById("nav-menu").classList.remove("hidden");
  document.getElementById("nav-toggle").setAttribute("aria-expanded", "true");
}

function closeNav() {
  const menu = document.getElementById("nav-menu");
  if (!menu) return;
  menu.classList.add("hidden");
  document.getElementById("nav-toggle").setAttribute("aria-expanded", "false");
}

function showSection(name, persist = true, options = {}) {
  const section = SECTIONS.includes(name) ? name : "dashboard";
  currentSection = section;
  if (persist) localStorage.setItem(SECTION_KEY, section);
  if (options.filters) {
    taskFilters = { ...taskFilters, ...options.filters };
    syncFilterUi();
  }
  document.querySelectorAll(".admin-section").forEach((el) => {
    el.classList.toggle("hidden", el.dataset.section !== section);
  });
  document.getElementById("nav-current").textContent = SECTION_LABELS[section];
  document.querySelectorAll("#nav-menu [data-section]").forEach((btn) => {
    if (btn.dataset.section === section || (section === "medewerker" && btn.dataset.section === "medewerkers")) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  });
  closeNav();
  if (section === "taken" && options.filters) {
    openFold("takenlijst");
    renderTasks();
  }
  if (section === "medewerker") {
    if (options.employeeId) selectEmployeeDashboard(options.employeeId);
    else renderEmployeeDashboard();
  }
}

function pendingCount() {
  return tasks.filter((task) => task.status === "pending").length;
}

function updateNavBadge() {
  const count = pendingCount();
  ["nav-badge", "nav-controle-badge"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = String(count);
    el.classList.toggle("hidden", count < 1);
  });
  const pinCount = pinResetRequests.length;
  ["nav-pin-badge", "nav-medewerkers-badge"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = String(pinCount);
    el.classList.toggle("hidden", pinCount < 1);
  });
  const staffCount = newStaffCreatedTasks().length;
  ["nav-staff-badge", "nav-taken-badge"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = String(staffCount);
    el.classList.toggle("hidden", staffCount < 1);
  });
  const reportCount = newReportCount();
  ["nav-reports-badge", "nav-reports-toggle-badge"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = String(reportCount);
    el.classList.toggle("hidden", reportCount < 1);
  });
  const overdueCount = overdueTasks().length;
  ["nav-overdue-badge", "nav-taken-overdue-badge"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = String(overdueCount);
    el.classList.toggle("hidden", overdueCount < 1);
  });
}

function renderAll() {
  fillAssigneeSelects();
  const locSel = document.getElementById("location-select");
  if (locSel && document.activeElement !== locSel) fillLocationSelect(locSel, locSel.value);
  fillTaskFilters();
  renderDashboard();
  renderTasks();
  renderCompleted();
  renderTemplates();
  renderEmployees();
  renderEmployeeDashboard();
  renderControle();
  renderWorkflow();
  renderPinResets();
  renderStaffCreated();
  renderReports();
  renderV2();
  updateNavBadge();
  renderDashboardNav();
  updateBackLabels();
}

function currentWorkloadGroups() {
  const groups = new Map();
  const ensure = (key, label) => {
    if (!groups.has(key)) groups.set(key, { key, label, open: 0, pending: 0 });
    return groups.get(key);
  };
  ensure("ALLEN", "Allen");
  for (const emp of employees.filter((e) => e.active)) {
    ensure(emp.id || emp.name, emp.name || emp.id);
  }
  for (const task of tasks) {
    if (task.status !== "open" && task.status !== "pending") continue;
    let group;
    if (isAllenTask(task)) group = ensure("ALLEN", "Allen");
    else if (task.assigneeId && employees.some((e) => e.id === task.assigneeId)) {
      const emp = employees.find((e) => e.id === task.assigneeId);
      group = ensure(emp.id, emp.name || emp.id);
    } else {
      const ident = workflowGroup(task);
      group = ensure(ident.key, ident.label);
    }
    if (task.status === "pending") group.pending += 1;
    else group.open += 1;
  }
  return [...groups.values()].sort((a, b) => {
    if (a.key === "ALLEN") return -1;
    if (b.key === "ALLEN") return 1;
    return a.label.localeCompare(b.label, "nl");
  });
}

function renderDashboard() {
  renderStaffCreated();
  document.getElementById("stat-open").textContent = tasks.filter((t) => t.status === "open").length;
  document.getElementById("stat-pending").textContent = tasks.filter((t) => t.status === "pending").length;
  document.getElementById("stat-done").textContent = tasks.filter((t) => t.status === "afgerond").length;
  const overdue = overdueTasks();
  const soon = tasks.filter(isDueSoon);
  const overdueStat = document.getElementById("stat-overdue");
  if (overdueStat) overdueStat.textContent = String(overdue.length + soon.length);
  const dueSub = document.getElementById("stat-due-sub");
  if (dueSub) dueSub.textContent = `${overdue.length} verstreken · ${soon.length} binnenkort`;
  const overdueBox = document.getElementById("dashboard-overdue");
  if (overdueBox) {
    if (!overdue.length) {
      overdueBox.replaceChildren();
      overdueBox.classList.add("hidden");
    } else {
      overdueBox.classList.remove("hidden");
      overdueBox.replaceChildren(dom`<h3>Streefdatum verstreken</h3>`, ...overdue.map(taskItem));
      bindTaskItems(overdueBox);
    }
  }
  const pendingBox = document.getElementById("dashboard-pending");
  const latest = tasks
    .filter((task) => task.status === "pending")
    .sort((a, b) => String(b.doneAt || b.createdAt || "").localeCompare(String(a.doneAt || a.createdAt || "")))
    .slice(0, 5);
  if (!latest.length) {
    pendingBox.innerHTML = '<p class="empty-state">Geen pending taken.</p>';
    return;
  }
  pendingBox.replaceChildren(...latest.map(taskItem));
  bindTaskItems(pendingBox);
}

function staffCreatorLabel(task) {
  return (task.createdByName || "").trim() || "medewerker";
}

function renderStaffCreated() {
  const box = document.getElementById("dashboard-staff-tasks");
  if (!box) return;
  const items = newStaffCreatedTasks();
  if (!items.length) {
    box.replaceChildren();
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  box.replaceChildren(dom`<h3>Aangemaakte taken</h3>`, ...items.map((task) => {
    const location = (task.location || "").trim();
    const when = task.createdAt ? formatDateTime(task.createdAt) : "";
    const frag = dom`
      <div class="staff-created-item">
        <h4>${task.title}</h4>
        ${location ? dom`<p class="staff-created-meta">${location}</p>` : ""}
        <p class="staff-created-meta">Door ${staffCreatorLabel(task)} aangemaakt${when ? " · " + when : ""}</p>
        <div class="staff-created-actions">
          <button type="button" class="secondary" data-review="gezien">Gezien</button>
          <button type="button" data-review="afgehandeld">Afgehandeld</button>
        </div>
      </div>`;
    frag.querySelectorAll("[data-review]").forEach((btn) => {
      btn.onclick = (event) => {
        event.stopPropagation();
        setAdminReview(task.id, btn.dataset.review);
      };
    });
    return frag;
  }));
}

async function setAdminReview(id, review) {
  if (!id || (review !== "gezien" && review !== "afgehandeld" && review !== "nieuw")) return;
  await safeWrite(() => updateDoc(doc(db, "tasks", id), { adminReview: review }));
}

function reportStatusLabel(status) {
  if (status === "in_behandeling") return "In behandeling";
  if (status === "opgelost") return "Opgelost";
  return "Nieuw";
}

function renderReports() {
  const list = document.getElementById("report-list");
  if (!list) return;
  const filtered = reports.filter((r) => reportFilter === "all" || r.status === reportFilter);
  document.querySelectorAll("#report-filter-status [data-report-filter]").forEach((btn) => {
    btn.setAttribute("aria-pressed", btn.dataset.reportFilter === reportFilter ? "true" : "false");
  });
  if (!filtered.length) {
    list.innerHTML = '<p class="empty-state">Geen meldingen in deze filter.</p>';
    return;
  }
  list.replaceChildren(...filtered.map((report) => {
    const when = report.createdAt ? formatDateTime(report.createdAt) : "";
    const status = ["nieuw", "in_behandeling", "opgelost"].includes(report.status) ? report.status : "nieuw";
    const frag = dom`
      <article class="report-item ${status}">
        <p class="pre-line">${report.description}</p>
        ${safePhotoImg(report.photo, { className: "report-photo", alt: "Foto bij melding" })}
        <p class="report-meta">${report.employeeName || "Medewerker"}${when ? " · " + when : ""}</p>
        <p class="report-meta">App ${report.appVersion || "onbekend"}${report.device ? " · " + report.device : ""}</p>
        <label class="report-status">Status
          <select>
            <option value="nieuw">Nieuw</option>
            <option value="in_behandeling">In behandeling</option>
            <option value="opgelost">Opgelost</option>
          </select>
        </label>
        <div class="report-actions">
          <button type="button" class="danger secondary" data-delete-report>Verwijderen</button>
        </div>
      </article>`;
    const sel = frag.querySelector("select");
    sel.value = status;
    sel.onchange = () => updateReportStatus(report.id, sel.value);
    frag.querySelector("[data-delete-report]").onclick = () => deleteReport(report.id);
    return frag;
  }));
}

async function updateReportStatus(id, status) {
  if (!["nieuw", "in_behandeling", "opgelost"].includes(status)) return;
  await safeWrite(() => updateDoc(doc(db, "reports", id), { status }));
}

async function deleteReport(id) {
  const report = reports.find((r) => r.id === id);
  const confirmed = await confirmAction(
    `Melding van ${report && report.employeeName ? report.employeeName : "medewerker"} verwijderen?`,
    { title: "Melding verwijderen", confirmText: "Verwijderen", danger: true }
  );
  if (!confirmed) return;
  await safeWrite(() => deleteDoc(doc(db, "reports", id)));
}

function openLightbox(src, alt) {
  const box = document.getElementById("image-lightbox");
  const img = document.getElementById("lightbox-image");
  if (!box || !img || !isSafeImageDataUrl(src)) return;
  img.src = src;
  img.alt = alt || "";
  box.classList.remove("hidden");
}

function closeLightbox() {
  const box = document.getElementById("image-lightbox");
  const img = document.getElementById("lightbox-image");
  if (img) img.removeAttribute("src");
  if (box) box.classList.add("hidden");
}

function workflowGroup(task) {
  if (isAllenTask(task)) return { key: "ALLEN", label: "Allen" };
  const name = (task.assigneeName || "").trim();
  return { key: name || task.assigneeId, label: name || task.assigneeId };
}

function periodStart(period) {
  const now = new Date();
  if (period === "week") {
    const mondayOffset = (now.getDay() + 6) % 7;
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - mondayOffset);
  }
  if (period === "month") return new Date(now.getFullYear(), now.getMonth(), 1);
  return null;
}

function inPeriod(value, start) {
  if (!start) return true;
  if (!value) return false;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return date >= start;
}

function rejectionTimes(task) {
  const times = [];
  if (Array.isArray(task.rejections)) {
    for (const item of task.rejections) {
      const at = item && (item.at || item);
      if (at) times.push(at);
    }
  }
  if (!times.length && task.lastRejectedAt) times.push(task.lastRejectedAt);
  return times;
}

function renderWorkflow() {
  const list = document.getElementById("workflow-list");
  if (!list) return;
  const period = document.getElementById("workflow-period").value || "all";
  const start = periodStart(period);
  const groups = new Map();
  const ensure = (key, label) => {
    if (!groups.has(key)) groups.set(key, { key, label, completed: 0, rejected: 0, open: 0, pending: 0 });
    return groups.get(key);
  };
  ensure("ALLEN", "Allen");
  for (const emp of employees.filter((e) => e.active)) {
    ensure(emp.name || emp.id, emp.name || emp.id);
  }
  const tickers = new Map();
  const ensureTicker = (name) => {
    if (!tickers.has(name)) tickers.set(name, { name, pending: 0, completed: 0 });
    return tickers.get(name);
  };
  for (const task of tasks) {
    const group = ensure(workflowGroup(task).key, workflowGroup(task).label);
    if (task.status === "open") group.open += 1;
    if (task.status === "pending") group.pending += 1;
    if (task.status === "afgerond" && inPeriod(task.completedAt, start)) group.completed += 1;
    for (const at of rejectionTimes(task)) {
      if (inPeriod(at, start)) group.rejected += 1;
    }
    const ticker = (task.doneBy || "").trim();
    if (ticker) {
      const entry = ensureTicker(ticker);
      if (task.status === "pending") entry.pending += 1;
      if (task.status === "afgerond" && inPeriod(task.completedAt, start)) entry.completed += 1;
    }
  }
  const items = [...groups.values()].sort((a, b) => {
    if (a.key === "ALLEN") return -1;
    if (b.key === "ALLEN") return 1;
    return a.label.localeCompare(b.label, "nl");
  });
  if (!items.length) {
    list.innerHTML = '<p class="empty-state">Nog geen workflowgegevens.</p>';
    return;
  }
  const tickerItems = [...tickers.values()].sort((a, b) => a.name.localeCompare(b.name, "nl"));
  list.replaceChildren(...items.map((g) => dom`
    <article class="workflow-card">
      <h3>${g.label}</h3>
      <div class="workflow-metrics wide">
        <div class="workflow-metric">
          <span class="value">${g.open}</span>
          <span class="label">Open</span>
        </div>
        <div class="workflow-metric">
          <span class="value">${g.pending}</span>
          <span class="label">Pending</span>
        </div>
        <div class="workflow-metric">
          <span class="value">${g.completed}</span>
          <span class="label">Afgerond</span>
        </div>
        <div class="workflow-metric">
          <span class="value">${g.rejected}</span>
          <span class="label">Afgekeurd</span>
        </div>
      </div>
    </article>`), tickerItems.length ? dom`
    <h3 class="workflow-tickers">Afgevinkt door</h3>
    ${tickerItems.map((g) => dom`
      <article class="workflow-card">
        <h3>${g.name}</h3>
        <div class="workflow-metrics">
          <div class="workflow-metric">
            <span class="value">${g.pending}</span>
            <span class="label">Nu pending</span>
          </div>
          <div class="workflow-metric">
            <span class="value">${g.completed}</span>
            <span class="label">Afgerond in periode</span>
          </div>
        </div>
      </article>`)}` : "");
}

function renderControle() {
  const list = document.getElementById("controle-list");
  if (!list) return;
  const pending = tasks
    .filter((task) => task.status === "pending")
    .sort((a, b) => String(b.doneAt || b.createdAt || "").localeCompare(String(a.doneAt || a.createdAt || "")));
  if (!pending.length) {
    list.innerHTML = '<p class="empty-state">Geen pending taken. Alles is bij.</p>';
    return;
  }
  list.replaceChildren(...pending.map((task) => dom`
    <div class="controle-item">
      ${taskItem(task)}
      <div class="controle-actions">
        <button type="button" class="success" data-approve="${task.id}">Goedkeuren</button>
        <button type="button" class="secondary" data-reject="${task.id}">Afwijzen</button>
      </div>
    </div>`));
  bindTaskItems(list);
  list.querySelectorAll("[data-approve]").forEach((btn) => {
    btn.onclick = (event) => {
      event.stopPropagation();
      approveTask(btn.dataset.approve);
    };
  });
  list.querySelectorAll("[data-reject]").forEach((btn) => {
    btn.onclick = (event) => {
      event.stopPropagation();
      rejectTask(btn.dataset.reject);
    };
  });
}

function isRecurring(task) {
  return Boolean(task.recurringId);
}

function locationLabel(item) {
  const location = item ? taskLocationText(item) : "";
  if (!location) return "";
  const unlinked = !item.locationId;
  return dom`<div class="task-location">${location}${unlinked ? dom` <span class="loc-unlinked">(niet gekoppeld)</span>` : ""}</div>`;
}

function assigneeBanner(task) {
  const name = (task.assigneeName || "").trim();
  // Eigenaar 12:20: zonder persoon = Allen (geen "Niet toegewezen" meer).
  return dom`<div class="task-assignee">${isAllenTask(task) ? "Allen" : name}</div>`;
}

function taskItem(task) {
  const status = safeStatus(task.status);
  const label = status === "open" ? "Open" : status === "pending" ? "Pending" : "Afgerond";
  return dom`
    <div class="task-item ${status}${task.urgent ? " is-urgent" : ""}" role="button" tabindex="0" data-task-id="${task.id}">
      <div class="task-item-main">
        <div>
          <div class="task-title">${task.title}</div>
          ${locationLabel(task)}
          ${dueDateLabel(task)}
          ${task.source ? dom`<div class="task-source">${sourceText(task)}</div>` : ""}
          ${isStaffCreatedTask(task) ? dom`<div class="task-created-by">Door ${staffCreatorLabel(task)} aangemaakt</div>` : ""}
          ${task.status !== "open" && task.doneBy ? dom`<div class="task-done-by">Afgevinkt door ${task.doneBy}${task.doneAt ? `, ${formatDateTime(task.doneAt)}` : ""}</div>` : ""}
        </div>
        <div class="badge-row">${task.urgent ? dom`<span class="badge urgent">Spoed</span>` : ""}${isRecurring(task) ? dom`<span class="badge recurring">Herhalend</span>` : ""}<span class="badge ${status}">${label}</span>${isOverdue(task) ? dom`<span class="badge overdue">Verstreken</span>` : ""}</div>
      </div>
      ${assigneeBanner(task)}
    </div>`;
}

function bindTaskItems(container) {
  container.querySelectorAll(".task-item").forEach((el) => {
    const open = () => openTask(el.dataset.taskId);
    el.addEventListener("click", open);
    el.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
  });
}

function taskMatchesFilters(task, includeCompleted = false) {
  if (!includeCompleted && task.status === "afgerond") return false;
  if (includeCompleted && task.status !== "afgerond") return false;
  const status = taskFilters.status || "all";
  if (!includeCompleted && status === "overdue") {
    if (!isOverdue(task)) return false;
  } else if (!includeCompleted && status === "due") {
    if (!isDueAttention(task)) return false;
  } else if (!includeCompleted && status !== "all" && task.status !== status) return false;
  const q = (taskFilters.q || "").trim().toLowerCase();
  if (q) {
    const hay = `${task.title || ""} ${task.location || ""} ${task.description || ""} ${task.assigneeName || ""}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  const employee = taskFilters.employee || "all";
  if (employee !== "all") {
    if (employee === "ALLEN" || employee === "UNASSIGNED" || employee === "") {
      if (!isAllenTask(task)) return false;
    } else if (task.assigneeId !== employee && (task.assigneeName || "") !== employee) {
      return false;
    }
  }
  const location = taskFilters.location || "all";
  if (location !== "all") {
    // Build v2: filter op vaste locatie; "Zonder locatie" = niet gekoppeld (oude vrije tekst of geen locatie).
    if (location === "__unlinked__") {
      if (task.locationId) return false;
    } else if (task.locationId !== location) return false;
  }
  if ((taskFilters.urgent || "all") === "yes" && !task.urgent) return false;
  if (!taskMatchesAudit(task, taskFilters.audit || "all")) return false;
  const recurring = taskFilters.recurring || "all";
  if (recurring === "yes" && !isRecurring(task)) return false;
  if (recurring === "no" && isRecurring(task)) return false;
  return true;
}

function fillTaskFilters() {
  const empSelect = document.getElementById("filter-employee");
  if (!empSelect) return;
  const previous = taskFilters.employee || "all";
  setOptions(empSelect, [
    ["all", "Iedereen"],
    ["ALLEN", "Allen"],
    ...employees.filter((e) => e.active).map((e) => [e.id, e.name])
  ]);
  if ([...empSelect.options].some((o) => o.value === previous)) empSelect.value = previous;
  else empSelect.value = "all";
  taskFilters.employee = empSelect.value;

  const locSelect = document.getElementById("filter-location");
  const prevLoc = taskFilters.location || "all";
  const usedInactive = [...new Set(tasks.map((t) => t.locationId).filter((id) => id && !activeLocations().some((l) => l.id === id)))];
  setOptions(locSelect, [
    ["all", "Alle locaties"],
    ...activeLocations().map((loc) => [loc.id, loc.label]),
    ...usedInactive.map((id) => [id, `${locationLabelById(id) || id} (inactief)`]),
    ["__unlinked__", "Zonder locatie"]
  ]);
  if ([...locSelect.options].some((o) => o.value === prevLoc)) locSelect.value = prevLoc;
  else locSelect.value = "all";
  taskFilters.location = locSelect.value;
  syncFilterUi();
}

function syncFilterUi() {
  const search = document.getElementById("task-search");
  if (search && search.value !== (taskFilters.q || "")) search.value = taskFilters.q || "";
  document.querySelectorAll("#filter-status [data-filter]").forEach((btn) => {
    btn.setAttribute("aria-pressed", btn.dataset.filter === (taskFilters.status || "all") ? "true" : "false");
  });
  document.querySelectorAll("#filter-recurring [data-filter]").forEach((btn) => {
    btn.setAttribute("aria-pressed", btn.dataset.filter === (taskFilters.recurring || "all") ? "true" : "false");
  });
  document.querySelectorAll("#filter-urgent [data-filter]").forEach((btn) => {
    btn.setAttribute("aria-pressed", btn.dataset.filter === (taskFilters.urgent || "all") ? "true" : "false");
  });
  const auditNote = document.getElementById("filter-audit-note");
  if (auditNote) {
    const a = taskFilters.audit || "all";
    auditNote.classList.toggle("hidden", a === "all");
    document.getElementById("filter-audit-text").textContent = a === "any" ? "Alleen audit-taken" : "Alleen taken uit één audit";
  }
  const empSelect = document.getElementById("filter-employee");
  if (empSelect && [...empSelect.options].some((o) => o.value === taskFilters.employee)) empSelect.value = taskFilters.employee;
  const locSelect = document.getElementById("filter-location");
  if (locSelect && [...locSelect.options].some((o) => o.value === taskFilters.location)) locSelect.value = taskFilters.location;
}

function renderTasks() {
  const list = document.getElementById("task-list");
  // Build v2: spoed altijd bovenaan.
  const active = tasks
    .filter((task) => taskMatchesFilters(task, false))
    .sort((a, b) => (Number(b.urgent) - Number(a.urgent)) || String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  if (!active.length) {
    list.innerHTML = '<p class="empty-state">Geen taken die aan de filters voldoen.</p>';
    return;
  }
  list.replaceChildren(...active.map(taskItem));
  bindTaskItems(list);
}

function renderCompleted() {
  const list = document.getElementById("completed-list");
  const done = tasks
    .filter((task) => taskMatchesFilters(task, true))
    .sort((a, b) => String(b.completedAt || b.createdAt || "").localeCompare(String(a.completedAt || a.createdAt || "")));
  document.getElementById("completed-count").textContent = String(done.length);
  if (!done.length) {
    list.innerHTML = '<p class="empty-state">Nog geen afgeronde taken.</p>';
    return;
  }
  list.replaceChildren(...done.map(taskItem));
  bindTaskItems(list);
}

function renderTemplates() {
  const list = document.getElementById("template-list");
  if (!templates.length) {
    list.innerHTML = '<p class="empty-state">Nog geen terugkerende taken. Vink bij een nieuwe taak "Herhalende taak" aan.</p>';
    return;
  }
  list.replaceChildren(...templates.map((template) => dom`
    <div class="template-item">
      <div class="template-top">
        <div>
          <div class="task-title">${template.title}</div>
          ${locationLabel(template)}
          <div class="task-meta">
            ${adminAssigneeLabel(template)}
            · ${describeRecurrence(template)}
          </div>
        </div>
        <div class="badge-row">
          ${template.urgent ? dom`<span class="badge urgent">Spoed</span>` : ""}
          ${template.paused ? dom`<span class="badge paused">Gepauzeerd</span>` : dom`<span class="badge recurring">Actief</span>`}
        </div>
      </div>
      <div class="template-actions">
        <button type="button" class="secondary" data-edit-template="${template.id}">Bewerken</button>
        <button type="button" class="secondary" data-pause-template="${template.id}">${template.paused ? "Hervatten" : "Pauzeren"}</button>
        <button type="button" class="danger" data-delete-template="${template.id}">Verwijderen</button>
      </div>
    </div>`));
  list.querySelectorAll("[data-edit-template]").forEach((btn) => {
    btn.onclick = () => startEditTemplate(btn.dataset.editTemplate);
  });
  list.querySelectorAll("[data-pause-template]").forEach((btn) => {
    btn.onclick = () => pauseTemplate(btn.dataset.pauseTemplate);
  });
  list.querySelectorAll("[data-delete-template]").forEach((btn) => {
    btn.onclick = () => deleteTemplate(btn.dataset.deleteTemplate);
  });
}

function renderEmployees() {
  const list = document.getElementById("employee-list");
  if (!list) return;
  if (!employees.length) {
    list.innerHTML = '<p class="empty-state">Nog geen medewerkers. Vul de standaardlijst of voeg zelf namen toe.</p>';
    return;
  }
  list.replaceChildren(...employees.map(employeeItem));
}

function employeeItem(emp) {
  const status = accountStatus(emp);
  const hasPin = status.valid;
  const open = openStartCodeFor(emp);
  const legacy = status.stale && !open;
  let pinText = "Nog geen pincode";
  if (hasPin) pinText = "Pincode ingesteld met startcode";
  else if (open) pinText = "Wacht op pincode met startcode";
  else if (status.stale) pinText = "Oude of verlopen inlog: werkt niet meer";
  const frag = dom`
    <div class="${legacy && emp.active ? "employee-item employee-item--needs-code" : "employee-item"}">
      <div class="employee-top">
        <div>
          <div class="task-title">${emp.name}</div>
          <p class="${hasPin ? "employee-pin set" : "employee-pin"}">${pinText}</p>
          ${legacy && emp.active ? dom`<p class="needs-code">Nieuwe startcode nodig</p>` : ""}
          ${open ? dom`<p class="employee-code">Open startcode · geldig tot ${formatDateTime(open.expiresAt)}</p>` : ""}
          ${!emp.active ? dom`<p class="employee-code muted">Inactief: inloggen geblokkeerd, geen startcode mogelijk</p>` : ""}
        </div>
        <span class="badge ${emp.active ? "open" : "paused"}">${emp.active ? "Actief" : "Inactief"}</span>
      </div>
      <div class="employee-actions">
        ${emp.active ? dom`<button type="button" data-act="code" title="Startcode (7 dagen geldig, eenmalig)">${hasPin ? "Pincode resetten (startcode)" : "Startcode maken"}</button>` : ""}
        ${open ? dom`<button type="button" class="secondary" data-act="show-code">Code tonen</button>` : ""}
        ${open ? dom`<button type="button" class="secondary" data-act="delete-code">Code verwijderen</button>` : ""}
        <button type="button" class="secondary" data-act="dash">Openen (startcode, pincode, gegevens)</button>
        <button type="button" class="secondary" data-act="rename">Hernoemen</button>
        <button type="button" class="secondary" data-act="toggle">${emp.active ? "Deactiveren" : "Activeren"}</button>
        <button type="button" class="danger" data-act="delete">Verwijderen</button>
      </div>
    </div>`;
  const on = (act, fn) => {
    const btn = frag.querySelector(`[data-act="${act}"]`);
    if (btn) btn.onclick = fn;
  };
  on("code", () => issueStartCode(emp.id));
  on("show-code", () => open && showStartCode({ name: emp.name, code: open.id, expiresAt: open.expiresAt }));
  on("delete-code", () => open && deleteStartCode(open.id));
  on("dash", () => showSection("medewerker", true, { employeeId: emp.id }));
  // Owner 11:44: klik op een medewerker in het overzicht opent diens pagina.
  const top = frag.querySelector(".employee-top");
  if (top) {
    top.setAttribute("role", "button");
    top.tabIndex = 0;
    top.setAttribute("aria-label", `${emp.name}: pagina openen`);
    const openPage = () => showSection("medewerker", true, { employeeId: emp.id });
    top.addEventListener("click", openPage);
    top.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openPage();
      }
    });
  }
  on("rename", () => renameEmployee(emp.id));
  on("toggle", () => toggleEmployee(emp.id));
  on("delete", () => removeEmployee(emp.id));
  return frag;
}

async function addEmployee(event) {
  event.preventDefault();
  const name = document.getElementById("employee-name").value.trim();
  if (!name) return;
  const conflict = findNameConflict(name);
  if (conflict) {
    showToast(conflict);
    return;
  }
  const id = employeeSlug(name);
  if (employees.some((e) => e.id === id)) {
    showToast("Deze medewerker bestaat al.");
    return;
  }
  const emp = { id, name, active: true, createdAt: new Date().toISOString(), pinVersion: 0 };
  const ok = await safeWrite(async () => {
    const batch = writeBatch(db);
    batch.set(doc(db, "employees", id), { name: emp.name, active: true, createdAt: emp.createdAt, pinVersion: 0 }, { merge: true });
    await batch.commit();
  });
  if (ok) document.getElementById("employee-name").value = "";
}

async function seedEmployees() {
  const now = new Date().toISOString();
  const batch = writeBatch(db);
  let writes = 0;
  for (const name of SEED_EMPLOYEES) {
    const id = employeeSlug(name);
    const existing = employees.find((e) => e.id === id);
    if (existing) continue;
    if (findNameConflict(name, id)) continue;
    batch.set(doc(db, "employees", id), { name, active: true, createdAt: now, pinVersion: 0 }, { merge: true });
    writes += 1;
  }
  if (!writes) {
    showToast("Standaardlijst stond er al in.", "ok");
    return;
  }
  await safeWrite(() => batch.commit());
}

async function renameEmployee(id) {
  const emp = employees.find((e) => e.id === id);
  if (!emp) return;
  const result = await showDialog({
    title: "Medewerker hernoemen",
    message: `Huidige naam: ${emp.name}`,
    input: true,
    inputLabel: "Nieuwe naam",
    inputPlaceholder: emp.name,
    inputValue: emp.name,
    confirmText: "Opslaan"
  });
  const name = (result.ok ? result.value : "").trim();
  if (!name || name === emp.name) {
    if (result.ok && !name) showToast("Vul een naam in.");
    return;
  }
  const conflict = findNameConflict(name, id);
  if (conflict) {
    showToast(conflict);
    return;
  }
  const ok = await safeWrite(async () => {
    let batch = writeBatch(db);
    let count = 0;
    const add = async (ref, data, mode = "update") => {
      if (mode === "set") batch.set(ref, data, { merge: true });
      else if (mode === "delete") batch.delete(ref);
      else batch.update(ref, data);
      count += 1;
      if (count >= 400) {
        await batch.commit();
        batch = writeBatch(db);
        count = 0;
      }
    };
    await add(doc(db, "employees", id), { name });
    for (const code of startCodes.filter((c) => c.employeeId === id && !c.used)) {
      await add(doc(db, "startCodes", code.id), { name });
    }
    for (const task of tasks) {
      if (task.assigneeId !== id) continue;
      if (task.status !== "open" && task.status !== "pending") continue;
      await add(doc(db, "tasks", task.id), { assigneeName: name });
    }
    for (const template of templates) {
      if (template.assigneeId !== id) continue;
      await add(doc(db, "recurring", template.id), { assigneeName: name });
    }
    if (count) await batch.commit();
  });
  if (ok) showToast("Naam bijgewerkt op medewerker, open taken en herhalingen.", "ok");
}

async function toggleEmployee(id) {
  const emp = employees.find((e) => e.id === id);
  if (!emp) return;
  if (emp.active) {
    const confirmed = await confirmAction(
      `${emp.name} deactiveren? Inloggen in de medewerkers-app wordt geblokkeerd en open startcodes vervallen.`,
      { title: "Deactiveren", confirmText: "Deactiveren", danger: true }
    );
    if (!confirmed) return;
  }
  await safeWrite(async () => {
    const batch = writeBatch(db);
    batch.update(doc(db, "employees", id), { active: !emp.active });
    if (emp.active) {
      for (const code of startCodes.filter((c) => c.employeeId === id && !c.used)) {
        batch.delete(doc(db, "startCodes", code.id));
      }
    }
    await batch.commit();
  });
}

async function removeEmployee(id) {
  const emp = employees.find((e) => e.id === id);
  if (!emp) return;
  const ok = await confirmAction(`Medewerker ${emp.name} verwijderen? Bestaande taken blijven bewaard.`, { title: "Verwijderen", confirmText: "Verwijderen", danger: true });
  if (!ok) return;
  await safeWrite(async () => {
    const batch = writeBatch(db);
    batch.delete(doc(db, "employees", id));
    if (employeeDetails.has(id)) batch.delete(doc(db, "employeeDetails", id));
    for (const code of startCodes.filter((c) => c.employeeId === id)) {
      batch.delete(doc(db, "startCodes", code.id));
    }
    await batch.commit();
  });
}

function openTask(id) {
  const task = tasks.find((item) => item.id === id);
  if (!task) return;
  currentTaskId = id;
  document.getElementById("modal-title").textContent = task.title;
  const locationEl = document.getElementById("modal-location");
  const location = taskLocationText(task);
  locationEl.textContent = location ? `${location}${task.locationId ? "" : " (niet gekoppeld)"}` : "";
  locationEl.classList.toggle("hidden", !location);
  const relocate = document.getElementById("relocate-select");
  if (relocate) fillLocationSelect(relocate, task.locationId || "", { placeholder: task.location && !task.locationId ? `Niet gekoppeld (${task.location})` : "Kies een locatie" });
  document.getElementById("modal-assignee").textContent = "Toegewezen aan: " + adminAssigneeLabel(task);
  const status = safeStatus(task.status);
  const statusBadges = [dom`<span class="badge ${status}">${status === "open" ? "Open" : status === "pending" ? "Pending" : "Afgerond"}</span>`];
  if (task.urgent) statusBadges.unshift(dom`<span class="badge urgent">Spoed</span>`);
  if (isRecurring(task)) statusBadges.push(dom`<span class="badge recurring">Herhalend</span>`);
  if (isOverdue(task)) statusBadges.push(dom`<span class="badge overdue">Verstreken</span>`);
  if (task.rejectedCount || task.lastRejectedAt || (Array.isArray(task.rejections) && task.rejections.length)) {
    statusBadges.push(dom`<span class="badge paused">Afgewezen</span>`);
  }
  document.getElementById("modal-status").replaceChildren(...statusBadges);
  const extra = [];
  if (isValidDueDate(task.dueDate)) {
    extra.push(`Streefdatum ${formatDueDate(task.dueDate)}${isOverdue(task) ? " (verstreken)" : ""}`);
  }
  if (task.createdAt) extra.push(`Aangemaakt op ${formatDateTime(task.createdAt)}`);
  if (task.source) extra.push(`Herkomst: ${sourceText(task)}`);
  if (isStaffCreatedTask(task)) {
    extra.push(`Door ${staffCreatorLabel(task)} aangemaakt`);
    if (task.adminReview) extra.push(`Admin-review: ${task.adminReview}`);
  }
  // Build v2: afgerond door + tijdstip (alleen zichtbaar voor de admin).
  if (task.doneBy || task.doneAt) {
    extra.push(`Afgevinkt${task.doneBy ? " door " + task.doneBy : ""}${task.doneAt ? " op " + formatDateTime(task.doneAt) : ""}`);
  }
  if (task.completedAt) extra.push(`Goedgekeurd op ${formatDateTime(task.completedAt)}`);
  document.getElementById("modal-description").replaceChildren(dom`
    <p class="pre-line">${task.description || ""}</p>
    ${extra.length ? dom`<div class="task-meta pre-line">${extra.join("\n")}</div>` : ""}`);
  const historyEl = document.getElementById("modal-rejections");
  historyEl.replaceChildren(rejectionHistory(task));
  const photos = (Array.isArray(task.photos) ? task.photos : [])
    .map((src) => safePhotoImg(src, { alt: "Foto bij taak" }))
    .filter(Boolean);
  document.getElementById("modal-photos").replaceChildren(...photos);
  fillAssigneeSelects();
  document.getElementById("reassign-select").value = assigneeSelectValue(task);

  const actions = document.getElementById("modal-actions");
  actions.innerHTML = "";
  if (isStaffCreatedTask(task) && task.adminReview === "nieuw") {
    actions.innerHTML += `<button type="button" class="secondary" data-action="gezien">Gezien</button>`;
    actions.innerHTML += `<button type="button" data-action="afgehandeld">Afgehandeld</button>`;
  }
  if (task.status === "open" || task.status === "pending") {
    actions.innerHTML += `<button type="button" class="secondary" data-action="edit">Bewerken</button>`;
  }
  if (task.status === "open") {
    actions.innerHTML += `<button type="button" class="success" data-action="pending">Markeer als gedaan</button>`;
  }
  if (task.status !== "afgerond") {
    actions.innerHTML += task.urgent
      ? `<button type="button" class="secondary" data-action="urgent">Spoed uitzetten</button>`
      : `<button type="button" class="urgent-btn" data-action="urgent">Spoed</button>`;
  }
  if (task.status === "pending") {
    actions.innerHTML += `<button type="button" class="success" data-action="approve">Goedkeuren</button>`;
    actions.innerHTML += `<button type="button" class="secondary" data-action="reject">Afwijzen</button>`;
  }
  if (task.status === "afgerond") {
    actions.innerHTML += `<button type="button" class="secondary" data-action="reopen">Terugzetten naar open</button>`;
  }
  actions.innerHTML += `<button type="button" class="danger" data-action="delete">Verwijderen</button>`;
  const editBtn = actions.querySelector('[data-action="edit"]');
  const pendingBtn = actions.querySelector('[data-action="pending"]');
  const approveBtn = actions.querySelector('[data-action="approve"]');
  const rejectBtn = actions.querySelector('[data-action="reject"]');
  const reopenBtn = actions.querySelector('[data-action="reopen"]');
  const deleteBtn = actions.querySelector('[data-action="delete"]');
  const gezienBtn = actions.querySelector('[data-action="gezien"]');
  const afgehandeldBtn = actions.querySelector('[data-action="afgehandeld"]');
  if (gezienBtn) gezienBtn.onclick = () => setAdminReview(task.id, "gezien");
  if (afgehandeldBtn) afgehandeldBtn.onclick = () => setAdminReview(task.id, "afgehandeld");
  if (editBtn) editBtn.onclick = () => startEditTask(task.id);
  if (pendingBtn) pendingBtn.onclick = () => markPending(task.id);
  if (approveBtn) approveBtn.onclick = () => approveTask(task.id);
  if (rejectBtn) rejectBtn.onclick = () => rejectTask(task.id);
  if (reopenBtn) reopenBtn.onclick = () => reopenTask(task.id);
  if (deleteBtn) deleteBtn.onclick = () => deleteTask(task.id);
  const urgentBtn = actions.querySelector('[data-action="urgent"]');
  if (urgentBtn) urgentBtn.onclick = () => safeWrite(() => updateDoc(doc(db, "tasks", task.id), { urgent: !task.urgent }));
  document.getElementById("modal").classList.remove("hidden");
}

function rejectionHistory(task) {
  const items = Array.isArray(task.rejections) ? task.rejections.filter(Boolean).map((item) => ({
    at: item.at || "",
    by: item.by || "",
    reason: typeof item.reason === "string" ? item.reason : ""
  })) : [];
  if (!items.length && (task.lastRejectedAt || task.lastRejectionReason)) {
    items.push({ at: task.lastRejectedAt || "", by: "", reason: task.lastRejectionReason || "" });
  }
  if (!items.length) return "";
  items.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  return dom`<div class="rejection-history">
    <h3>Afwijzingen</h3>
    <ul>${items.map((item) => {
      const reason = String(item.reason || "").trim();
      const meta = [item.at ? formatDateTime(item.at) : "", String(item.by || "")].filter(Boolean).join(" · ");
      return dom`<li>
        ${meta ? dom`<div class="task-meta">${meta}</div>` : ""}
        <p class="pre-line">${reason || "Geen reden opgegeven"}</p>
      </li>`;
    })}</ul>
  </div>`;
}

function closeModal() {
  document.getElementById("modal").classList.add("hidden");
  currentTaskId = null;
}

async function markPending(id) {
  const task = tasks.find((item) => item.id === id);
  if (!task || task.status !== "open") return;
  // Build v2: geen naam/tijd op de taak; de admin staat als "Beheerder" in taskCompletions.
  await safeWrite(async () => {
    const batch = writeBatch(db);
    batch.update(doc(db, "tasks", id), { status: "pending", pendingAt: deleteField(), pendingBy: deleteField(), pendingByEmployeeId: deleteField() });
    addAdminCompletion(batch, id);
    await batch.commit();
  });
}

async function approveTask(id) {
  const task = tasks.find((item) => item.id === id);
  if (!task || task.status !== "pending") return;
  const confirmed = await confirmAction(`Taak “${task.title}” goedkeuren en als afgerond markeren?`, { title: "Goedkeuren", confirmText: "Goedkeuren" });
  if (!confirmed) return;
  const ok = await safeWrite(() => updateDoc(doc(db, "tasks", id), {
    status: "afgerond",
    completedAt: new Date().toISOString()
  }));
  if (ok) closeModal();
}

async function rejectTask(id) {
  const task = tasks.find((item) => item.id === id);
  if (!task || task.status !== "pending") return;
  const result = await showDialog({
    title: "Afwijzen",
    message: `Taak “${task.title}” afwijzen? De taak gaat terug naar open. Een korte reden is sterk aangeraden.`,
    input: true,
    inputLabel: "Reden (optioneel, sterk aangeraden)",
    inputPlaceholder: "Bijvoorbeeld: nog niet klaar, foto ontbreekt…",
    confirmText: "Afwijzen",
    danger: true
  });
  if (!result.ok) return;
  const reason = (result.value || "").trim();
  const at = new Date().toISOString();
  const by = "Beheerder"; // V8: geen admin-e-mailadres in taakdata die medewerkers lezen
  // Build v2: afwijzen wist ook het afgerond-door-doc (zelfde batch).
  const ok = await safeWrite(async () => {
    const batch = writeBatch(db);
    batch.update(doc(db, "tasks", id), {
      status: "open",
      pendingAt: deleteField(),
      pendingBy: deleteField(),
      pendingByEmployeeId: deleteField(),
      rejectedCount: increment(1),
      lastRejectedAt: at,
      lastRejectionReason: reason,
      rejections: arrayUnion({ at, by, reason })
    });
    addCompletionDelete(batch, id);
    await batch.commit();
  });
  if (ok) closeModal();
}

async function reopenTask(id) {
  const task = tasks.find((item) => item.id === id);
  if (!task || task.status !== "afgerond") return;
  const confirmed = await confirmAction(`Taak “${task.title}” terugzetten naar open?`, { title: "Terugzetten", confirmText: "Terugzetten naar open" });
  if (!confirmed) return;
  const ok = await safeWrite(async () => {
    const batch = writeBatch(db);
    batch.update(doc(db, "tasks", id), {
      status: "open",
      completedAt: null,
      pendingAt: deleteField(),
      pendingBy: deleteField(),
      pendingByEmployeeId: deleteField()
    });
    addCompletionDelete(batch, id);
    await batch.commit();
  });
  if (ok) closeModal();
}

async function deleteTask(id) {
  const task = tasks.find((item) => item.id === id);
  const confirmed = await confirmAction(`Taak${task ? ` "${task.title}"` : ""} definitief verwijderen?`, { title: "Verwijderen", confirmText: "Verwijderen", danger: true });
  if (!confirmed) return;
  const ok = await safeWrite(async () => {
    const batch = writeBatch(db);
    batch.delete(doc(db, "tasks", id));
    batch.delete(doc(db, "taskMeta", id));
    addCompletionDelete(batch, id);
    await batch.commit();
  });
  if (ok) closeModal();
}

// Build v2: oude taak (of taak) aan een vaste locatie koppelen; de oude vrije tekst blijft staan.
async function relocateCurrentTask() {
  if (!currentTaskId) return;
  const task = tasks.find((item) => item.id === currentTaskId);
  if (!task) return;
  const id = document.getElementById("relocate-select").value || "";
  if (!id) {
    showToast("Kies een locatie.");
    return;
  }
  if (id === (task.locationId || "")) return;
  const update = { locationId: id, ...(task.locationId || !task.location ? { location: locationLabelById(id) } : {}) };
  if (await safeWrite(() => updateDoc(doc(db, "tasks", currentTaskId), update))) showToast("Locatie opgeslagen.", "ok");
}

async function reassignCurrentTask() {
  if (!currentTaskId) return;
  const task = tasks.find((item) => item.id === currentTaskId);
  if (!task) return;
  const assignee = assigneeFromSelect(document.getElementById("reassign-select"));
  await safeWrite(() => updateDoc(doc(db, "tasks", currentTaskId), assignee));
}

function oldCompletedTasks() {
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  return tasks.filter((task) => {
    if (task.status !== "afgerond" || !task.completedAt) return false;
    const at = new Date(task.completedAt).getTime();
    return !Number.isNaN(at) && at < cutoff;
  });
}

async function cleanupOldCompleted() {
  const old = oldCompletedTasks();
  if (!old.length) {
    showToast("Geen afgeronde taken ouder dan 90 dagen.", "ok");
    return;
  }
  const first = await showDialog({
    title: "Opschonen",
    message: `Er staan ${old.length} afgeronde taken ouder dan 90 dagen. Exporteer eerst een back-up voordat je ze verwijdert.`,
    confirmText: "Exporteer back-up",
    cancelText: "Annuleren"
  });
  if (!first.ok) return;
  if (!(await exportRawBackup())) return;
  const confirmed = await confirmAction(
    `${old.length} afgeronde taken ouder dan 90 dagen definitief verwijderen? Dit kan niet ongedaan worden gemaakt.`,
    { title: "Definitief opschonen", confirmText: "Opschonen", danger: true }
  );
  if (!confirmed) return;
  const ok = await safeWrite(async () => {
    let batch = writeBatch(db);
    let count = 0;
    for (const task of old) {
      batch.delete(doc(db, "tasks", task.id));
      batch.delete(doc(db, "taskMeta", task.id));
      addCompletionDelete(batch, task.id);
      count += 3;
      if (count >= 400) {
        await batch.commit();
        batch = writeBatch(db);
        count = 0;
      }
    }
    if (count) await batch.commit();
  });
  if (ok) showToast(`${old.length} oude taken verwijderd.`, "ok");
}

function loadLocalLegacy() {
  const rawTasks = safeParse(localStorage.getItem(STORAGE_TASKS), []);
  const rawTemplates = safeParse(localStorage.getItem(STORAGE_TEMPLATES), []);
  const localTasks = Array.isArray(rawTasks) ? rawTasks.map((t) => normalizeTask(t.id || String(Date.now()), t)) : [];
  const localTemplates = Array.isArray(rawTemplates) ? rawTemplates.map((t) => normalizeTemplate(t.id || `tpl-${Date.now()}`, t)) : [];
  return { localTasks, localTemplates };
}

function offerMigrationIfNeeded() {
  if (localStorage.getItem(STORAGE_MIGRATED) === "1") {
    document.getElementById("migration-banner").classList.add("hidden");
    return;
  }
  const { localTasks, localTemplates } = loadLocalLegacy();
  document.getElementById("migration-banner").classList.toggle("hidden", !localTasks.length && !localTemplates.length);
}

async function migrateLocalToFirebase() {
  const { localTasks, localTemplates } = loadLocalLegacy();
  const ok = await safeWrite(() => writeAll(localTemplates, localTasks));
  if (!ok) return;
  localStorage.setItem(STORAGE_MIGRATED, "1");
  document.getElementById("migration-banner").classList.add("hidden");
  showToast("Lokale gegevens zijn geïmporteerd naar Firebase.", "ok");
}

async function writeAll(tpls, taskList) {
  const chunks = [];
  let batch = writeBatch(db);
  let count = 0;
  const flush = async () => {
    if (!count) return;
    await batch.commit();
    batch = writeBatch(db);
    count = 0;
  };
  const add = async (ref, data) => {
    batch.set(ref, data, { merge: true });
    count += 1;
    if (count >= 400) await flush();
  };
  for (const tpl of tpls) {
    await add(doc(db, "recurring", tpl.id), serializeTemplate(tpl));
  }
  for (const task of taskList) {
    const id = task.recurringId && task.occurrenceDate
      ? `${task.recurringId}_${task.occurrenceDate}`
      : (task.id || doc(collection(db, "tasks")).id);
    const payload = serializeTask(task);
    if (task.rejectedCount || (Array.isArray(task.rejections) && task.rejections.length) || task.lastRejectedAt || task.lastRejectionReason) {
      payload.rejectedCount = task.rejectedCount || 0;
      payload.rejections = Array.isArray(task.rejections) ? task.rejections : [];
      payload.lastRejectedAt = task.lastRejectedAt || null;
      payload.lastRejectionReason = task.lastRejectionReason || "";
    }
    if (task.pendingByEmployeeId) payload.pendingByEmployeeId = task.pendingByEmployeeId;
    if (task.createdByRole || task.createdByEmployeeId || task.createdByName || task.adminReview) {
      payload.createdByRole = task.createdByRole || "";
      payload.createdByEmployeeId = task.createdByEmployeeId || "";
      payload.createdByName = task.createdByName || "";
      payload.adminReview = task.adminReview || "";
    }
    await add(doc(db, "tasks", id), payload);
  }
  await flush();
}

function exportData() {
  const payload = {
    version: 3,
    source: "firebase",
    exportedAt: new Date().toISOString(),
    tasks,
    templates,
    employees,
    employeeDetails: [...employeeDetails.values()]
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "zeiklijst-live.json";
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importData(event) {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(reader.result);
      let taskList = [];
      let tpls = [];
      let emps = [];
      if (Array.isArray(data)) {
        taskList = data.map((t) => normalizeTask(t.id || String(Date.now()), t));
      } else if (data && typeof data === "object") {
        if (Array.isArray(data.tasks)) taskList = data.tasks.map((t) => normalizeTask(t.id || String(Date.now()), t));
        if (Array.isArray(data.templates)) tpls = data.templates.map((t) => normalizeTemplate(t.id || `tpl-${Date.now()}`, t));
        if (Array.isArray(data.employees)) emps = data.employees;
      } else {
        throw new Error("Ongeldig bestand");
      }
      await writeAll(tpls, taskList);
      if (emps.length) {
        const batch = writeBatch(db);
        for (const emp of emps) {
          const id = emp.id || employeeSlug(emp.name);
          const pinVersion = Number.isFinite(Number(emp.pinVersion)) ? Number(emp.pinVersion) : 0;
          const record = { id, name: emp.name || "", pinVersion };
          batch.set(doc(db, "employees", id), {
            name: record.name,
            active: emp.active !== false,
            createdAt: emp.createdAt || new Date().toISOString(),
            pinVersion
          }, { merge: true });
        }
        await batch.commit();
      }
      showToast("Data geïmporteerd.", "ok");
    } catch (err) {
      showToast(err.message || "Ongeldig bestand");
    }
  };
  reader.readAsText(file);
}

// H1/M1: de medewerkers-app gebruikt nameIndex niet meer. Oude documenten kunnen weg.
async function purgeNameIndex() {
  const confirmed = await confirmAction("Alle documenten in de oude naamindex verwijderen? De medewerkers-app gebruikt die niet meer.", { title: "Naamindex verwijderen", confirmText: "Verwijderen", danger: true });
  if (!confirmed) return;
  const ok = await safeWrite(async () => {
    const snap = await getDocs(collection(db, "nameIndex"));
    let batch = writeBatch(db);
    let count = 0;
    for (const d of snap.docs) {
      batch.delete(d.ref);
      count += 1;
      if (count >= 400) {
        await batch.commit();
        batch = writeBatch(db);
        count = 0;
      }
    }
    if (count) await batch.commit();
  });
  if (ok) showToast("Naamindex verwijderd.", "ok");
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    isAdmin = false;
    applyAuthUi();
    try {
      await signInAnonymously(auth);
    } catch {
      // login screen remains
    }
    return;
  }
  isAdmin = user.uid === ADMIN_UID;
  applyAuthUi();
});

setupUi();


// ---- v24: Per medewerker ----------------------------------------------------
// Eén medewerker kiezen (dropdown) en daar alles voor doen: startcode, pincode resetten,
// resetverzoeken en extra gegevens (employeeDetails/{id}, alleen admin).
const DETAIL_LIMITS = { role: 40, department: 40, note: 500 };

function normalizeEmployeeDetails(id, data) {
  const d = data || {};
  return {
    id,
    role: typeof d.role === "string" ? d.role.slice(0, DETAIL_LIMITS.role) : "",
    department: typeof d.department === "string" ? d.department.slice(0, DETAIL_LIMITS.department) : "",
    workdays: Array.isArray(d.workdays) ? d.workdays.filter((n) => Number.isInteger(n) && n >= 0 && n <= 6) : [],
    note: typeof d.note === "string" ? d.note.slice(0, DETAIL_LIMITS.note) : "",
    updatedAt: timestampToIso(d.updatedAt)
  };
}

function setupEmployeeDashboard() {
  const select = document.getElementById("emp-dash-select");
  if (!select) return;
  empDashId = localStorage.getItem(EMP_DASH_KEY) || "";
  document.getElementById("det-workdays").replaceChildren(...WEEKDAYS.map((day) => dom`
    <label>
      <input type="checkbox" value="${day.value}" aria-label="${day.long}">
      <span>${day.short}</span>
    </label>`));
  select.onchange = () => selectEmployeeDashboard(select.value);
  const form = document.getElementById("emp-details-form");
  form.onsubmit = saveEmployeeDetails;
  form.addEventListener("input", () => {
    empDashDirty = true;
    updateNoteCount();
  });
  document.getElementById("det-revert").onclick = () => {
    empDashDirty = false;
    fillDetailsForm(true);
  };
}

async function selectEmployeeDashboard(id) {
  if (id !== empDashId && empDashDirty) {
    const ok = await confirmAction("Je hebt niet-opgeslagen wijzigingen. Toch een andere medewerker kiezen?", { title: "Niet opgeslagen", confirmText: "Doorgaan" });
    if (!ok) {
      document.getElementById("emp-dash-select").value = empDashId;
      return;
    }
  }
  empDashId = id || "";
  empDashDirty = false;
  if (empDashId) localStorage.setItem(EMP_DASH_KEY, empDashId);
  else localStorage.removeItem(EMP_DASH_KEY);
  renderEmployeeDashboard();
}

function fillEmployeeDashSelect() {
  const select = document.getElementById("emp-dash-select");
  const active = employees.filter((e) => e.active);
  const inactive = employees.filter((e) => !e.active);
  const groups = [new Option("Kies medewerker…", "")];
  const group = (label, list) => {
    if (!list.length) return null;
    const g = document.createElement("optgroup");
    g.label = label;
    g.append(...list.map((e) => new Option(e.name + (resetRequestsFor(e).length ? " • verzoek" : ""), e.id)));
    return g;
  };
  const signature = JSON.stringify(employees.map((e) => [e.id, e.name, e.active, resetRequestsFor(e).length]));
  if (select.dataset.signature !== signature) {
    const a = group("Actief", active);
    const i = group("Inactief", inactive);
    select.replaceChildren(...groups, ...[a, i].filter(Boolean));
    select.dataset.signature = signature;
  }
  select.value = employees.some((e) => e.id === empDashId) ? empDashId : "";
}

function resetRequestsFor(emp) {
  return pinResetRequests.filter((req) => {
    const guess = guessEmployeeForRequest(req);
    return guess && guess.id === emp.id;
  });
}

function renderEmployeeDashboard() {
  const select = document.getElementById("emp-dash-select");
  if (!select) return;
  fillEmployeeDashSelect();
  const emp = employees.find((e) => e.id === empDashId) || null;
  document.getElementById("emp-dash-empty").classList.toggle("hidden", Boolean(emp));
  document.getElementById("emp-dash-body").classList.toggle("hidden", !emp);
  if (!emp) {
    empDashFormFor = "";
    return;
  }
  renderEmpDashStatus(emp);
  renderEmpDashResets(emp);
  fillDetailsForm(empDashFormFor !== emp.id);
}

function renderEmpDashStatus(emp) {
  const status = accountStatus(emp);
  const open = openStartCodeFor(emp);
  let pinText = "Nog geen pincode";
  if (status.valid) pinText = "Pincode ingesteld met startcode";
  else if (open) pinText = "Wacht op pincode met startcode";
  else if (status.stale) pinText = "Oude of verlopen inlog: werkt niet meer, nieuwe startcode nodig";
  const assigned = tasks.filter((t) => t.assigneeId === emp.id);
  const openCount = assigned.filter((t) => t.status === "open").length;
  const pendingCountEmp = assigned.filter((t) => t.status === "pending").length;
  const today = Math.floor((Date.now() + 3600000) / 86400000);
  const counter = staffCounters.get(emp.id);
  const usedToday = counter && counter.day === today ? counter : { tasks: 0, reports: 0 };
  const frag = dom`
    <div class="emp-dash-head">
      <p class="emp-dash-name">${emp.name}</p>
      <span class="badge ${emp.active ? "open" : "paused"}">${emp.active ? "Actief" : "Inactief"}</span>
    </div>
    <ul class="emp-dash-facts">
      <li><strong>Inloggen:</strong> ${pinText}</li>
      ${open ? dom`<li><strong>Open startcode:</strong> geldig tot ${formatDateTime(open.expiresAt)}</li>` : ""}
      <li><strong>Taken:</strong> ${openCount} open · ${pendingCountEmp} pending</li>
      <li><strong>Vandaag verstuurd:</strong> ${usedToday.tasks}/10 eigen taken · ${usedToday.reports}/5 meldingen</li>
    </ul>
    ${emp.active ? "" : dom`<p class="employee-code muted">Inactief: inloggen geblokkeerd, geen startcode mogelijk. Activeer eerst.</p>`}
    <div class="emp-dash-actions">
      ${emp.active && !status.valid ? dom`<button type="button" data-act="code">Startcode maken</button>` : ""}
      ${emp.active && status.valid ? dom`<button type="button" class="danger" data-act="code">Pincode resetten (nieuwe startcode)</button>` : ""}
      ${open ? dom`<button type="button" class="secondary" data-act="show-code">Code tonen</button>` : ""}
      ${open ? dom`<button type="button" class="secondary" data-act="delete-code">Code verwijderen</button>` : ""}
      <button type="button" class="secondary" data-act="tasks">Taken bekijken</button>
      <button type="button" class="secondary" data-act="rename">Hernoemen</button>
      <button type="button" class="secondary" data-act="toggle">${emp.active ? "Deactiveren" : "Activeren"}</button>
    </div>
    <p class="pin-meta">Pincode resetten maakt de huidige pincode en open codes direct ongeldig. Geef de nieuwe code alleen persoonlijk.</p>`;
  const el = document.getElementById("emp-dash-status");
  el.replaceChildren(frag);
  const on = (act, fn) => {
    const btn = el.querySelector(`[data-act="${act}"]`);
    if (btn) btn.onclick = fn;
  };
  on("code", () => issueStartCode(emp.id));
  on("show-code", () => open && showStartCode({ name: emp.name, code: open.id, expiresAt: open.expiresAt }));
  on("delete-code", () => open && deleteStartCode(open.id));
  on("tasks", () => showSection("taken", true, { filters: { employee: emp.id, status: "all" } }));
  on("rename", () => renameEmployee(emp.id));
  on("toggle", () => toggleEmployee(emp.id));
}

function renderEmpDashResets(emp) {
  const el = document.getElementById("emp-dash-resets");
  const mine = resetRequestsFor(emp);
  const unmatched = pinResetRequests.filter((req) => !guessEmployeeForRequest(req));
  if (!mine.length && !unmatched.length) {
    el.classList.add("hidden");
    el.replaceChildren();
    return;
  }
  el.classList.remove("hidden");
  const items = mine.map((req) => {
    const when = req.requestedAt ? formatDateTime(req.requestedAt) : "";
    const frag = dom`
      <div class="pin-reset-item">
        <p><strong>Opgegeven naam: ${resetRequestName(req)}</strong>${when ? " · " + when : ""}
          ${req.note ? dom`<span class="pin-meta pre-line">Toelichting: ${req.note}</span>` : ""}
          <span class="pin-meta">Niet gecontroleerd. Praat eerst persoonlijk met ${emp.name} voordat je een code maakt.</span></p>
        <div class="pin-reset-actions">
          ${emp.active ? dom`<button type="button" data-issue>Startcode maken voor dit verzoek</button>` : ""}
          <button type="button" class="secondary" data-dismiss>Verzoek wissen</button>
        </div>
      </div>`;
    const issue = frag.querySelector("[data-issue]");
    if (issue) issue.onclick = () => issueStartCode(emp.id, { requestId: req.id });
    frag.querySelector("[data-dismiss]").onclick = () => dismissResetRequest(req.id);
    return frag;
  });
  const extra = unmatched.length ? dom`
    <p class="pin-meta">${unmatched.length} ${unmatched.length === 1 ? "verzoek heeft" : "verzoeken hebben"} een naam die niet duidelijk bij één medewerker hoort.
      <button type="button" class="secondary" data-goto-list>Bekijk bij Medewerkers</button></p>` : "";
  el.replaceChildren(dom`<h3>Pincode vergeten</h3>`, ...items, extra);
  const go = el.querySelector("[data-goto-list]");
  if (go) go.onclick = () => showSection("medewerkers");
}

function fillDetailsForm(force = false) {
  const emp = employees.find((e) => e.id === empDashId);
  if (!emp) return;
  if (!force && empDashDirty) return; // niet over invoer heen schrijven
  const d = employeeDetails.get(emp.id) || normalizeEmployeeDetails(emp.id, {});
  document.getElementById("det-role").value = d.role;
  document.getElementById("det-department").value = d.department;
  document.getElementById("det-note").value = d.note;
  document.querySelectorAll("#det-workdays input").forEach((input) => {
    input.checked = d.workdays.includes(Number(input.value));
  });
  document.getElementById("det-updated").textContent = d.updatedAt ? `Laatst opgeslagen: ${formatDateTime(d.updatedAt)}` : "Nog geen gegevens opgeslagen.";
  setDetailsError("");
  updateNoteCount();
  empDashFormFor = emp.id;
  empDashDirty = false;
}

function updateNoteCount() {
  const note = document.getElementById("det-note");
  const count = document.getElementById("det-note-count");
  if (note && count) count.textContent = `${note.value.length}/${DETAIL_LIMITS.note}`;
}

function setDetailsError(message) {
  const el = document.getElementById("det-error");
  el.textContent = message;
  el.classList.toggle("hidden", !message);
}

// Leest het formulier en controleert dezelfde regels als firestore.rules. Leeg = weglaten.
function readDetailsForm() {
  const payload = {};
  const role = document.getElementById("det-role").value.trim();
  if (role) {
    if (role.length > DETAIL_LIMITS.role) return { error: `Functie mag maximaal ${DETAIL_LIMITS.role} tekens zijn.` };
    payload.role = role;
  }
  const department = document.getElementById("det-department").value.trim();
  if (department) {
    if (department.length > DETAIL_LIMITS.department) return { error: `Afdeling mag maximaal ${DETAIL_LIMITS.department} tekens zijn.` };
    payload.department = department;
  }
  const days = [...document.querySelectorAll("#det-workdays input:checked")].map((i) => Number(i.value));
  if (days.length) payload.workdays = [...new Set(days)].sort((a, b) => a - b);
  const note = document.getElementById("det-note").value.trim();
  if (note) {
    if (note.length > DETAIL_LIMITS.note) return { error: `Notitie mag maximaal ${DETAIL_LIMITS.note} tekens zijn.` };
    payload.note = note;
  }
  return { payload };
}

async function saveEmployeeDetails(event) {
  event.preventDefault();
  const emp = employees.find((e) => e.id === empDashId);
  if (!emp) return;
  const { payload, error } = readDetailsForm();
  if (error) {
    setDetailsError(error);
    return;
  }
  setDetailsError("");
  const btn = document.getElementById("det-save");
  btn.disabled = true;
  // set zonder merge: lege velden verdwijnen, de regels staan alleen deze velden toe.
  const ok = await safeWrite(() => setDoc(doc(db, "employeeDetails", emp.id), { ...payload, updatedAt: serverTimestamp() }));
  btn.disabled = false;
  if (ok) {
    empDashDirty = false;
    showToast(`Gegevens van ${emp.name} opgeslagen.`, "ok");
  }
}
