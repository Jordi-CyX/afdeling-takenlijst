import {
  db,
  doc,
  collection,
  writeBatch,
  listenCollection,
  generateDueInstances,
  normalizeTask,
  normalizeTemplate,
  normalizeEmployee,
  formatDateTime,
  amsterdamDateKey,
  normalizeName,
  compressImage,
  isSafeImageDataUrl
} from "./shared.js?v=21";
import { serverTimestamp, onSnapshot, deleteField, query, where, getDoc, setDoc, updateDoc } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";
import { auth } from "./firebase-init.js";
import {
  getCurrentStaff,
  initStaffAuth,
  logoutStaff,
  setStaffDisplayName
} from "./staff-auth.js?v=21";
import { sendWithStaffCounter } from "./limits.js?v=21";
import { sortTasks, isVisibleForDepartment, locationDepartment, normalizeDepartment } from "./task-order.js?v=21";

// v3a herziene scope (23-11 08:01): afdelingen, sessies en schakelknop NIET in v3a.
// De code blijft staan voor later; met false gebeurt er niets van (geen UI, geen reads/writes/listeners).
const FEATURES = Object.freeze({ departments: false, sessions: false, adminSwitch: false });

let tasks = [];
let templates = [];
// L3: only the signed-in employee's own employees/{id} doc is read, never the list.
let ownEmployee = null;
// v3a: eigen afdeling en adminrecht (nooit in beeld voor de medewerker).
let ownProfile = { department: "", canAdmin: false };
let locationsLoaded = false;
let locationSettings = null;
let ownCompletions = {};
let currentTaskId = null;
let knownDate = amsterdamDateKey();
let listenersStarted = false;
let generating = false;
let toastTimer = 0;

const VIEW_KEY = "zeiklijst-view";
const FILTER_KEY = "zeiklijst-filter";
const LOCATION_FILTER_KEY = "zeiklijst-location-filter";
const LOCATION_NONE_FILTER = "__none__";
const LOCATION_NONE_FILTER_LEGACY = "other";
const FILTERS = new Set(["all", "mine", "allen", "pending"]);
const LOCATION_UNSET_MSG = "Locatielijst nog niet ingesteld, vraag de beheerder";

const TITLE_MAX = 120;
const LOCATION_MAX = 120;
const DESCRIPTION_MAX = 2000;
const REPORT_DESC_MAX = 1000;
const DEVICE_MAX_CHARS = 300;
const APP_VERSION_MAX = 40;
// M3: client-side limits. ZLA's rules enforce the same values (zl-audit-rules-needs.md).
const PHOTO_MAX_CHARS = 250000;          // data-URL length, ~180 KB of JPEG
const PHOTO_FILE_MAX_BYTES = 25 * 1024 * 1024; // refuse huge files before decoding
const PHOTO_ACCEPT = /^image\/(jpeg|png|webp|heic|heif|gif|bmp)$/i;
const TOGGLE_COOLDOWN_MS = 1500;
// Daily limits + 15 s cooldown are enforced by the server counters (limits.js, contract step 4).
const LEGACY_LIMIT_KEYS = ["zeiklijst-report-count", "zeiklijst-last-submit"];

// Field names for staff-created tasks and reports. Must match ZLA's rules exactly.
const STAFF_TASK = {
  title: "title",
  description: "description",
  location: "location",
  locationId: "locationId",
  assigneeId: "assigneeId",
  assigneeName: "assigneeName",
  status: "status",
  createdAt: "createdAt",
  photos: "photos",
  createdByRole: "createdByRole",
  createdByEmployeeId: "createdByEmployeeId",
  createdByName: "createdByName",
  adminReview: "adminReview"
};

const REPORT = {
  description: "description",
  photo: "photo",
  employeeId: "employeeId",
  employeeName: "employeeName",
  createdAt: "createdAt",
  appVersion: "appVersion",
  device: "device",
  status: "status"
};

function appVersion() {
  return (typeof self !== "undefined" && self.APP_CACHE_NAME) || "zeiklijst-v21";
}

// Visible label from the cache name, e.g. "zeiklijst-v20" -> "v20".
function displayAppVersion() {
  const cache = String(appVersion());
  const match = cache.match(/v(\d+)\s*$/i);
  return match ? "v" + match[1] : cache;
}

function paintAppVersionLabel() {
  const el = document.getElementById("app-version-label");
  if (!el) return;
  el.textContent = displayAppVersion();
  el.removeAttribute("hidden");
}

// Copy v2 fields that the current shared.js normalizeTask may still omit.
// When ZLA's shared.js starts returning them, this stays harmless.
function enrichTask(id, data) {
  const task = normalizeTask(id, data);
  const d = data || {};
  task.locationId = typeof d.locationId === "string" ? d.locationId : (typeof task.locationId === "string" ? task.locationId : "");
  task.urgent = d.urgent === true || task.urgent === true;
  const source = (d.source && typeof d.source === "object")
    ? d.source
    : (task.source && typeof task.source === "object" ? task.source : null);
  task.source = source;
  // v3a "Ik pak deze op": claimedBy {employeeId, name} + claimedAt.
  const cb = d.claimedBy && typeof d.claimedBy === "object" ? d.claimedBy : null;
  task.claimedBy = cb && typeof cb.employeeId === "string" && cb.employeeId
    ? { employeeId: cb.employeeId, name: String(cb.name || "").trim().slice(0, 60) }
    : null;
  task.claimedAt = d.claimedAt || null;
  return task;
}

function isClaimedByMe(task) {
  const staff = getCurrentStaff();
  return Boolean(staff && task && task.claimedBy && task.claimedBy.employeeId === staff.employeeId);
}

function claimLabel(task) {
  if (!task || !task.claimedBy) return "";
  if (isClaimedByMe(task)) return "Opgepakt door jou";
  return `Opgepakt door ${task.claimedBy.name || "een collega"}`;
}

function visibleForMe(task) {
  if (!FEATURES.departments) return true;
  const staff = getCurrentStaff();
  return isVisibleForDepartment(task, ownProfile.department, staff && staff.employeeId, locationSettings);
}

function locationItems() {
  const items = locationSettings && Array.isArray(locationSettings.items) ? locationSettings.items : [];
  return items
    .filter((item) => item && typeof item.id === "string" && item.id)
    .slice()
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
}

function locationLabelsMap() {
  const labels = locationSettings && locationSettings.labels && typeof locationSettings.labels === "object"
    ? locationSettings.labels
    : {};
  return labels;
}

function activeLocationItems() {
  return locationItems().filter((item) => item.active !== false);
}

function isStaffSelectableItem(item) {
  return Boolean(item && item.id && item.active !== false && item.staffSelectable !== false);
}

// Add-task choices: active + staffSelectable (missing staffSelectable = true),
// or an id that appears in settings.locations.labels.
function staffSelectableLocationItems() {
  const items = locationItems().filter(isStaffSelectableItem);
  const seen = new Set(items.map((item) => item.id));
  Object.keys(locationLabelsMap()).forEach((id) => {
    if (!id || seen.has(id)) return;
    const existing = locationItems().find((item) => item.id === id);
    if (existing && (existing.active === false || existing.staffSelectable === false)) return;
    items.push(existing || { id, label: String(locationLabelsMap()[id]), order: Number.MAX_SAFE_INTEGER });
    seen.add(id);
  });
  return items.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
}

function locationsReady() {
  return staffSelectableLocationItems().length > 0;
}

function locationLabelById(id) {
  if (!id) return "";
  const hit = locationItems().find((item) => item.id === id);
  if (hit && hit.label) return String(hit.label);
  const labels = locationLabelsMap();
  if (labels[id]) return String(labels[id]);
  return id === "overig" ? "Overig" : "";
}

function taskLocationText(task) {
  return locationLabelById(task && task.locationId) || String((task && task.location) || "").trim();
}

function isUrgent(task) {
  return Boolean(task && task.urgent === true);
}

function formatAuditDate(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : "";
}

function auditOriginText(task) {
  const source = task && task.source;
  if (!source || typeof source !== "object" || source.type !== "audit") return "";
  const date = formatAuditDate(source.auditDate);
  const loc = locationLabelById(source.locationId);
  return ["Audit", date, loc].filter(Boolean).join(" · ");
}

function migrateLocationFilterValue(value) {
  return value === LOCATION_NONE_FILTER_LEGACY ? LOCATION_NONE_FILTER : (value || "all");
}

function currentLocationFilter() {
  const raw = localStorage.getItem(LOCATION_FILTER_KEY) || "all";
  const value = migrateLocationFilterValue(raw);
  if (value !== raw) {
    try { localStorage.setItem(LOCATION_FILTER_KEY, value); } catch { /* ignore */ }
  }
  return value || "all";
}

function setLocationFilter(value) {
  localStorage.setItem(LOCATION_FILTER_KEY, value || "all");
  renderTasks();
}

let lastFilterKey = "";
function refreshLocationFilterIfNeeded() {
  const key = tasks.filter((t) => t.status !== "afgerond").map((t) => t.locationId || "").sort().join("|");
  if (key === lastFilterKey) return;
  lastFilterKey = key;
  fillLocationFilter();
}

function matchesLocationFilter(task, locFilter) {
  if (!locFilter || locFilter === "all") return true;
  if (locFilter === LOCATION_NONE_FILTER) return !task.locationId;
  return task.locationId === locFilter;
}

function isStaffCreated(task) {
  return Boolean(task && task.createdByRole === "staff");
}

function officialStaffName() {
  const staff = getCurrentStaff();
  if (!staff) return "";
  if (ownEmployee && ownEmployee.id === staff.employeeId && ownEmployee.name) return ownEmployee.name;
  return staff.name || "";
}

function isRecurring(task) {
  return Boolean(task.recurringId);
}

function currentFilter() {
  let value = localStorage.getItem(FILTER_KEY) || "mine";
  if (value === "unassigned") value = "allen";
  return FILTERS.has(value) ? value : "mine";
}

function setFilter(value) {
  const next = FILTERS.has(value) ? value : "mine";
  localStorage.setItem(FILTER_KEY, next);
  renderTasks();
}

// Staff display/filter: empty, null, missing or ALLEN is shown as Allen.
function isAllen(task) {
  if (!task) return true;
  const id = task.assigneeId == null ? "" : String(task.assigneeId).trim();
  if (!id || id === "ALLEN") return true;
  return (task.assigneeName || "").trim().toLowerCase() === "allen";
}

function staffAssigneeLabel(task) {
  if (isAllen(task)) return "Allen";
  const name = (task && task.assigneeName || "").trim();
  return name || "Allen";
}

function isMine(task) {
  if (isAllen(task)) return true;
  const staff = getCurrentStaff();
  if (!staff) return false;
  const me = normalizeName(staff.name);
  if (me && (normalizeName(task.assigneeName) === me || normalizeName(task.pendingBy) === me)) {
    return true;
  }
  return Boolean(staff.employeeId) && task.assigneeId === staff.employeeId;
}

function matchesFilter(task, filter) {
  if (filter === "all") return true;
  if (filter === "pending") return task.status === "pending";
  if (filter === "allen") return isAllen(task);
  if (filter === "mine") return isMine(task);
  return true;
}

function wasRejected(task) {
  return Boolean(
    (Number(task.rejectedCount) || 0) > 0
    || task.lastRejectedAt
    || (Array.isArray(task.rejections) && task.rejections.length)
  );
}

function lastRejection(task) {
  const list = Array.isArray(task.rejections) ? task.rejections : [];
  return list.length ? list[list.length - 1] : null;
}

function rejectionReason(task) {
  const direct = String(task.lastRejectionReason || task.rejectionReason || "").trim();
  if (direct) return direct;
  const last = lastRejection(task);
  if (!last || typeof last !== "object") return "";
  return String(last.reason || last.rejectionReason || "").trim();
}

function rejectionAt(task) {
  return task.lastRejectedAt || (lastRejection(task) && lastRejection(task).at) || "";
}

function rejectionBy(task) {
  const last = lastRejection(task);
  return last && last.by ? String(last.by) : "";
}

function formatRelativeAge(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "";
  const sec = Math.round((Date.now() - date.getTime()) / 1000);
  if (sec < 0) return "zojuist";
  if (sec < 45) return "zojuist";
  const min = Math.round(sec / 60);
  if (min < 60) return min === 1 ? "1 minuut geleden" : `${min} minuten geleden`;
  const hr = Math.round(min / 60);
  if (hr < 24) return hr === 1 ? "1 uur geleden" : `${hr} uur geleden`;
  const day = Math.round(hr / 24);
  if (day < 14) return day === 1 ? "1 dag geleden" : `${day} dagen geleden`;
  const week = Math.round(day / 7);
  if (week < 8) return week === 1 ? "1 week geleden" : `${week} weken geleden`;
  const month = Math.round(day / 30);
  if (month < 12) return month === 1 ? "1 maand geleden" : `${month} maanden geleden`;
  const year = Math.round(day / 365);
  return year === 1 ? "1 jaar geleden" : `${year} jaar geleden`;
}

function createdStamp(task) {
  return String(task.createdAt || "");
}

function pendingStamp(task) {
  return String(task.pendingAt || task.createdAt || "");
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

let unsubscribers = [];
let accessLostHandled = false;

// A listener that is refused (pin reset, account deactivated or removed)
// sends the employee back to the login screen instead of an empty list.
function onListenerError(err, message) {
  if (!isPermissionDenied(err) || accessLostHandled) return;
  accessLostHandled = true;
  if (message) {
    logoutStaff(message);
    return;
  }
  // B7: na een pincode-reset helpt opnieuw inloggen niet; direct naar Registreren.
  logoutStaff("Je pincode is gereset of je toegang is veranderd. Vraag je leidinggevende om een nieuwe startcode.", { step: "code" });
}

function startListeners() {
  if (listenersStarted) return;
  listenersStarted = true;
  accessLostHandled = false;
  unsubscribers.push(listenCollection("tasks", enrichTask, (list) => {
    tasks = list;
    refreshLocationFilterIfNeeded();
    renderTasks();
    if (currentTaskId) openTask(currentTaskId);
  }, onListenerError));
  unsubscribers.push(listenCollection("recurring", normalizeTemplate, async (list) => {
    templates = list;
    await maybeGenerate();
    renderTasks();
  }, onListenerError));
  const staff = getCurrentStaff();
  if (staff && staff.employeeId) {
    unsubscribers.push(onSnapshot(doc(db, "settings", "locations"), (snap) => {
      locationSettings = snap.exists() ? (snap.data() || {}) : null;
      locationsLoaded = true;
      fillLocationSelect();
      restoreDraftLocation();
      fillLocationFilter();
      renderTasks();
      if (currentTaskId) openTask(currentTaskId);
    }, (err) => {
      locationSettings = null;
      locationsLoaded = true;
      fillLocationSelect();
      fillLocationFilter();
      renderTasks();
      if (currentTaskId) openTask(currentTaskId);
      if (isPermissionDenied(err)) {
        console.warn("settings/locations-listener geweigerd; lijst niet beschikbaar, app blijft ingelogd.", err);
        return;
      }
      onListenerError(err);
    }));
    const completionsQuery = query(
      collection(db, "taskCompletions"),
      where("employeeId", "==", staff.employeeId)
    );
    unsubscribers.push(onSnapshot(completionsQuery, (snap) => {
      const next = {};
      (snap.docs || []).forEach((item) => { next[item.id] = item.data() || {}; });
      ownCompletions = next;
      if (currentTaskId) openTask(currentTaskId);
    }, (err) => {
      ownCompletions = {};
      if (currentTaskId) openTask(currentTaskId);
      if (isPermissionDenied(err)) {
        console.warn("taskCompletions-listener geweigerd; app blijft ingelogd.", err);
        return;
      }
      onListenerError(err);
    }));
    unsubscribers.push(onSnapshot(doc(db, "employees", staff.employeeId), (snap) => {
      if (!snap.exists()) {
        onListenerError({ code: "permission-denied" });
        return;
      }
      const mine = normalizeEmployee(snap.id, snap.data());
      ownEmployee = mine;
      if (FEATURES.departments || FEATURES.adminSwitch) applyProfile(snap.data() || {});
      if (mine.active === false) {
        onListenerError(
          { code: "permission-denied" },
          "Je account is niet actief. Neem contact op met je leidinggevende."
        );
        return;
      }
      if (mine.name) setStaffDisplayName(mine.name);
      if (currentTaskId) openTask(currentTaskId);
    }, onListenerError));
  }
}

function stopListeners() {
  ownCompletions = {};
  locationSettings = null;
  locationsLoaded = false;
  ownProfile = { department: "", canAdmin: false };
  profileFallbackTried = false;
  renderAdminSwitch();
  unsubscribers.forEach((stop) => {
    try {
      if (typeof stop === "function") stop();
    } catch {
      // Already torn down.
    }
  });
  unsubscribers = [];
  listenersStarted = false;
  tasks = [];
  templates = [];
  ownEmployee = null;
}

// --- v3a: profiel (afdeling, canAdmin) -------------------------------------
// Plek volgens afstemming met ZLA: employees/{id}.department/canAdmin; fallback eigen staffAccounts/{uid}.
let profileFallbackTried = false;

function applyProfile(data) {
  const hasDept = data && Object.prototype.hasOwnProperty.call(data, "department");
  const hasAdmin = data && Object.prototype.hasOwnProperty.call(data, "canAdmin");
  ownProfile = {
    department: hasDept ? normalizeDepartment(data.department) : ownProfile.department,
    canAdmin: hasAdmin ? data.canAdmin === true : ownProfile.canAdmin
  };
  renderAdminSwitch();
  fillLocationFilter();
  renderTasks();
  if ((!hasDept || !hasAdmin) && !profileFallbackTried) {
    profileFallbackTried = true;
    const uid = auth.currentUser && auth.currentUser.uid;
    if (!uid) return;
    getDoc(doc(db, "staffAccounts", uid)).then((snap) => {
      const acc = snap.exists() ? (snap.data() || {}) : {};
      if (!hasDept && "department" in acc) ownProfile.department = normalizeDepartment(acc.department);
      if (!hasAdmin && "canAdmin" in acc) ownProfile.canAdmin = acc.canAdmin === true;
      renderAdminSwitch();
      fillLocationFilter();
      renderTasks();
    }).catch(() => {});
  }
}

function renderAdminSwitch() {
  const link = document.getElementById("admin-switch-btn");
  if (!link) return;
  const show = FEATURES.adminSwitch && Boolean(getCurrentStaff()) && ownProfile.canAdmin === true;
  link.classList.toggle("hidden", !show);
  link.hidden = !show;
}

// --- v3a: sessies (staffSessions/{sessionId}) ---------------------------------
const SESSION_KEY = "zeiklijst-staff-sessions"; // {uid: sessionId} op dit toestel
const SESSION_TOUCH_MS = 5 * 60 * 1000;
let sessionId = "";
let sessionUnsub = null;
let sessionLastTouch = 0;
let sessionTimer = 0;
let sessionSeen = false;

function randomId(n = 20) {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => abc[b % abc.length]).join("");
}

function readSessionMap() {
  try {
    const m = JSON.parse(localStorage.getItem(SESSION_KEY) || "{}");
    return m && typeof m === "object" && !Array.isArray(m) ? m : {};
  } catch { return {}; }
}

function writeSessionId(uid, id) {
  const m = readSessionMap();
  if (id) m[uid] = id; else delete m[uid];
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(m)); } catch { /* ignore */ }
}

// Korte omschrijving, geen volledige user-agent.
function shortDevice() {
  const ua = String((typeof navigator !== "undefined" && navigator.userAgent) || "");
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android"
    : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "Onbekend";
  const browser = /Edg\//.test(ua) ? "Edge" : /SamsungBrowser/.test(ua) ? "Samsung Internet" : /Firefox|FxiOS/.test(ua) ? "Firefox"
    : /CriOS|Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const standalone = typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches;
  return `${os} · ${browser}${standalone ? " · app" : ""}`.slice(0, 80);
}

async function startSession(staff) {
  if (!FEATURES.sessions) return;
  const uid = auth.currentUser && auth.currentUser.uid;
  if (!uid || !staff || !staff.employeeId) return;
  stopSession();
  const known = readSessionMap()[uid];
  let id = "";
  if (known) {
    try {
      await updateDoc(doc(db, "staffSessions", known), { lastActive: serverTimestamp() });
      id = known;
    } catch {
      id = ""; // weg, beëindigd of geen rechten: nieuwe sessie
    }
  }
  if (!id) {
    id = randomId();
    try {
      await setDoc(doc(db, "staffSessions", id), {
        employeeId: staff.employeeId,
        uid,
        device: shortDevice(),
        createdAt: serverTimestamp(),
        lastActive: serverTimestamp(),
        revoked: false
      });
    } catch (err) {
      // Regels nog niet gepubliceerd: app werkt gewoon zonder sessie-doc.
      console.warn("staffSessions niet beschikbaar; app blijft ingelogd.", err && err.code);
      return;
    }
  }
  if (!getCurrentStaff()) return;
  sessionId = id;
  sessionSeen = false;
  writeSessionId(uid, id);
  sessionLastTouch = Date.now();
  sessionUnsub = onSnapshot(doc(db, "staffSessions", id), (snap) => {
    if (!snap.exists()) {
      if (sessionSeen && !snap.metadata.fromCache) endSessionByAdmin(uid);
      return;
    }
    sessionSeen = true;
    if ((snap.data() || {}).revoked === true) endSessionByAdmin(uid);
  }, () => { /* geweigerd: niets doen */ });
  sessionTimer = window.setInterval(touchSession, 60 * 1000);
}

function touchSession() {
  if (!sessionId || document.hidden) return;
  if (Date.now() - sessionLastTouch < SESSION_TOUCH_MS) return;
  sessionLastTouch = Date.now();
  updateDoc(doc(db, "staffSessions", sessionId), { lastActive: serverTimestamp() }).catch(() => {});
}

function stopSession() {
  if (sessionUnsub) { try { sessionUnsub(); } catch { /* ignore */ } }
  sessionUnsub = null;
  clearInterval(sessionTimer);
  sessionTimer = 0;
  sessionId = "";
}

function endSessionByAdmin(uid) {
  if (!sessionId) return;
  writeSessionId(uid, "");
  stopSession();
  logoutStaff("Je sessie op dit toestel is beëindigd. Log opnieuw in.");
}

// --- v3a: onderhoudsscherm via settings/maintenance -------------------------
// Vervangt het oude onderhoudsscherm (aparte deploy met maintenance.js, 7364ff1).
// Leesbaar vóór inloggen; geweigerd of ontbrekend doc = app gewoon bruikbaar.
let maintenanceUnsub = null;
let maintenanceRetry = 0;

function applyMaintenance(data) {
  const on = Boolean(data && data.enabled === true);
  const screen = document.getElementById("maintenance-screen");
  const msg = document.getElementById("maintenance-message");
  if (msg) {
    const text = on ? String(data.message || "").trim().slice(0, 300) : "";
    msg.textContent = text || "Probeer het straks opnieuw.";
  }
  if (screen) {
    screen.classList.toggle("hidden", !on);
    screen.hidden = !on;
  }
  document.body.classList.toggle("is-maintenance", on);
}

function watchMaintenance() {
  if (maintenanceUnsub) { try { maintenanceUnsub(); } catch { /* ignore */ } }
  clearTimeout(maintenanceRetry);
  maintenanceUnsub = onSnapshot(doc(db, "settings", "maintenance"), (snap) => {
    applyMaintenance(snap.exists() ? snap.data() : null);
  }, () => {
    // Geweigerd/offline: laatst bekende stand houden en later opnieuw proberen.
    maintenanceUnsub = null;
    maintenanceRetry = window.setTimeout(watchMaintenance, 60 * 1000);
  });
}

function currentView() {
  return localStorage.getItem(VIEW_KEY) === "tiles" ? "tiles" : "list";
}

function applyView(view) {
  const mode = view === "tiles" ? "tiles" : "list";
  localStorage.setItem(VIEW_KEY, mode);
  document.querySelectorAll(".guest-app .task-list").forEach((list) => {
    list.classList.toggle("view-tiles", mode === "tiles");
    list.classList.toggle("view-list", mode === "list");
  });
  const listBtn = document.getElementById("view-list");
  const tilesBtn = document.getElementById("view-tiles");
  if (listBtn) listBtn.setAttribute("aria-pressed", String(mode === "list"));
  if (tilesBtn) tilesBtn.setAttribute("aria-pressed", String(mode === "tiles"));
}

function setupUi() {
  document.getElementById("modal-close").onclick = closeModal;
  document.getElementById("modal").onclick = (event) => {
    if (event.target.id === "modal") closeModal();
  };
  document.getElementById("view-list").onclick = () => applyView("list");
  document.getElementById("view-tiles").onclick = () => applyView("tiles");
  document.getElementById("filter-chips").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-filter]");
    if (!btn) return;
    setFilter(btn.dataset.filter);
  });
  const locationFilter = document.getElementById("location-filter");
  if (locationFilter) {
    fillLocationFilter();
    locationFilter.addEventListener("change", (event) => {
      setLocationFilter(event.target.value);
    });
  }
  setupHeaderMenu();
  setupLightbox();
  setupStaffPages();
  setupUpdateBanner();
  applyView(currentView());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) checkDateChange();
  });
  setInterval(checkDateChange, 60000);
}

function setupHeaderMenu() {
  const btn = document.getElementById("header-more-btn");
  const menu = document.getElementById("header-more-menu");
  const close = () => {
    menu.classList.add("hidden");
    btn.setAttribute("aria-expanded", "false");
  };
  const toggle = (event) => {
    event.stopPropagation();
    const open = menu.classList.contains("hidden");
    menu.classList.toggle("hidden", !open);
    btn.setAttribute("aria-expanded", String(open));
  };
  btn.addEventListener("click", toggle);
  menu.addEventListener("click", (event) => {
    if (event.target.closest(".menu-action")) close(); // B2
  });
  document.addEventListener("click", (event) => {
    if (!menu.classList.contains("hidden") && !event.target.closest(".header-more")) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
}

function setupLightbox() {
  const box = document.getElementById("lightbox");
  const img = document.getElementById("lightbox-img");
  const close = () => {
    box.classList.add("hidden");
    img.removeAttribute("src");
  };
  document.getElementById("lightbox-close").onclick = close;
  box.addEventListener("click", (event) => {
    if (event.target === box || event.target === img) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
  document.getElementById("modal-photos").addEventListener("click", (event) => {
    const photo = event.target.closest("img");
    if (!photo) return;
    event.preventDefault();
    event.stopPropagation();
    img.src = photo.src;
    box.classList.remove("hidden");
  });
}

function checkDateChange() {
  const today = amsterdamDateKey();
  if (today !== knownDate) {
    knownDate = today;
    maybeGenerate();
  }
}

function renderFilterHint() {
  const hint = document.getElementById("filter-hint");
  hint.textContent = "";
  hint.classList.add("hidden");
}

function renderChips() {
  const active = currentFilter();
  document.querySelectorAll("#filter-chips .chip").forEach((btn) => {
    const on = btn.dataset.filter === active;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-pressed", String(on));
  });
  renderFilterHint();
}

function fillLocationFilter() {
  const sel = document.getElementById("location-filter");
  if (!sel) return;
  const current = currentLocationFilter();
  sel.replaceChildren();
  const add = (value, label) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    sel.append(option);
  };
  add("all", "Alle");
  const dept = FEATURES.departments ? ownProfile.department : "";
  const deptOk = (id) => !dept || dept === "beide" || !locationDepartment(id, locationSettings)
    || locationDepartment(id, locationSettings) === "beide" || locationDepartment(id, locationSettings) === dept;
  const openIds = new Set(tasks.filter((t) => t.status !== "afgerond" && t.locationId && visibleForMe(t)).map((t) => t.locationId));
  locationItems().forEach((item) => {
    if (item.active !== false) {
      if (deptOk(item.id) || openIds.has(item.id)) add(item.id, item.label || item.id);
    } else if (openIds.has(item.id)) {
      // B21: inactief pad met open taken blijft filterbaar.
      add(item.id, `${item.label || item.id} (inactief)`);
    }
  });
  add(LOCATION_NONE_FILTER, "Zonder locatie");
  const allowed = new Set([...sel.options].map((option) => option.value));
  const next = allowed.has(current) ? current : "all";
  sel.value = next;
  // B3: de opgeslagen keuze pas overschrijven als de locaties echt geladen zijn.
  if (next !== current && locationsLoaded && tasks.length) {
    try { localStorage.setItem(LOCATION_FILTER_KEY, next); } catch { /* ignore */ }
  }
}

function fillLocationSelect(resetChoice = false) {
  const sel = document.getElementById("add-task-location-input");
  if (!sel) return;
  const current = sel.value;
  const ready = locationsReady();
  sel.replaceChildren();
  const first = document.createElement("option");
  first.value = "";
  first.textContent = ready ? "Kies een locatie" : "Niet beschikbaar";
  first.disabled = true;
  first.selected = true;
  first.defaultSelected = true;
  sel.append(first);
  staffSelectableLocationItems().forEach((item) => {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.label || item.id;
    sel.append(option);
  });
  if (!resetChoice && current && staffSelectableLocationItems().some((item) => item.id === current)) {
    sel.value = current;
  } else {
    sel.selectedIndex = 0;
    first.selected = true;
  }
  sel.disabled = !ready;
  const form = document.getElementById("staff-add-task-form");
  const submit = form && form.querySelector("button[type=submit]");
  if (submit && form && form.dataset.busy !== "1") submit.disabled = !ready;
}

function bindList(list) {
  list.querySelectorAll(".task-item").forEach((el) => {
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

function renderTasks() {
  const filter = currentFilter();
  const locFilter = currentLocationFilter();
  const visible = tasks.filter((task) => (
    task.status !== "afgerond"
    && visibleForMe(task)
    && matchesFilter(task, filter)
    && matchesLocationFilter(task, locFilter)
  ));
  // v3a punt 4: padvolgorde, binnen pad spoed (streefdatum zit in taskMeta, niet leesbaar voor medewerkers).
  const openTasks = sortTasks(visible.filter((task) => task.status === "open"), locationSettings, createdStamp);
  const pendingTasks = sortTasks(visible.filter((task) => task.status === "pending"), locationSettings, pendingStamp);

  const openList = document.getElementById("task-list");
  const pendingList = document.getElementById("pending-list");
  const openSection = document.getElementById("section-open");
  const pendingSection = document.getElementById("section-pending");
  const boardEmpty = document.getElementById("board-empty");

  const showOpen = filter !== "pending" && openTasks.length > 0;
  const showPending = pendingTasks.length > 0;
  // "Ter controle" chip: always show the pending section (even if empty)
  const forcePending = filter === "pending";

  document.getElementById("heading-open").textContent = openTasks.length
    ? `Openstaande taken (${openTasks.length})`
    : "Openstaande taken";
  document.getElementById("heading-pending").textContent = pendingTasks.length
    ? `Ter controle (${pendingTasks.length})`
    : "Ter controle";

  openSection.hidden = !showOpen;
  pendingSection.hidden = !(showPending || forcePending);

  if (showOpen) {
    openList.replaceChildren(...openTasks.map(taskItemElement));
    bindList(openList);
  } else {
    openList.replaceChildren();
  }

  if (showPending) {
    pendingList.replaceChildren(...pendingTasks.map(taskItemElement));
    bindList(pendingList);
  } else if (forcePending) {
    pendingList.replaceChildren(el("p", "empty-state", "Geen taken ter controle."));
  } else {
    pendingList.replaceChildren();
  }

  const empty = !showOpen && !showPending && !forcePending;
  boardEmpty.classList.toggle("hidden", !empty);
  if (empty) {
    boardEmpty.textContent = tasks.some((task) => task.status !== "afgerond" && visibleForMe(task))
      ? "Geen taken in dit filter."
      : "Geen openstaande taken.";
  }

  renderChips();
  applyView(currentView());
}

// --- Safe DOM helpers: user data only ever goes through textContent / img.src.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null && text !== "") node.textContent = String(text);
  return node;
}

const KNOWN_STATUSES = new Set(["open", "pending", "afgerond"]);

function badgeElements(task) {
  const badges = [];
  if (isUrgent(task)) badges.push(el("span", "badge urgent", "Spoed"));
  if (task.status === "open" && wasRejected(task)) badges.push(el("span", "badge rejected", "Afgewezen"));
  if (task.status === "pending") badges.push(el("span", "badge pending", "Ter controle"));
  if (isRecurring(task)) badges.push(el("span", "badge recurring", "Herhalend"));
  if (isStaffCreated(task)) badges.push(el("span", "badge staff-created", "Zelf aangemaakt"));
  return badges;
}

function safePhotos(task) {
  return (Array.isArray(task.photos) ? task.photos : []).filter(isSafeImageDataUrl);
}

function rejectionByLabel(by) {
  const value = String(by || "").trim();
  if (!value) return "";
  // Never show an e-mail address (the admin account) to staff.
  return value.includes("@") ? "de beheerder" : value;
}

function taskItemElement(task) {
  const location = taskLocationText(task);
  const origin = auditOriginText(task);
  const assignee = staffAssigneeLabel(task);
  const age = formatRelativeAge(task.createdAt);

  const item = el("div", "task-item");
  if (KNOWN_STATUSES.has(task.status)) item.classList.add(task.status);
  if (isUrgent(task)) item.classList.add("is-urgent");
  item.setAttribute("role", "button");
  item.tabIndex = 0;
  item.dataset.taskId = String(task.id);

  const main = el("div", "task-item-main");
  const textCol = el("div");
  textCol.append(
    el("div", "task-title", task.title || ""),
    el("div", "task-location" + (location ? "" : " hidden"), location),
    el("div", "task-origin" + (origin ? "" : " hidden"), origin),
    el("div", "task-claim" + (task.claimedBy ? "" : " hidden"), claimLabel(task)),
    el("div", "task-age" + (age ? "" : " hidden"), age)
  );
  main.append(textCol);
  const badges = badgeElements(task);
  if (badges.length) {
    const row = el("div", "badge-row");
    row.append(...badges);
    main.append(row);
  }
  item.append(main, el("div", "task-assignee", assignee));
  return item;
}

function openTask(id) {
  const task = tasks.find((item) => item.id === id);
  if (!task) {
    if (currentTaskId === id) closeModal();
    return;
  }
  currentTaskId = id;
  document.getElementById("modal-title").textContent = task.title;
  const location = taskLocationText(task);
  const locEl = document.getElementById("modal-location");
  locEl.textContent = location;
  locEl.hidden = !location;
  const origin = auditOriginText(task);
  const originEl = document.getElementById("modal-origin");
  if (originEl) {
    originEl.textContent = origin;
    originEl.classList.toggle("hidden", !origin);
  }
  document.getElementById("modal-assignee").textContent = "Toegewezen aan: " + staffAssigneeLabel(task);
  document.getElementById("modal-status").replaceChildren(...badgeElements(task));

  const rejectionEl = document.getElementById("modal-rejection");
  if (wasRejected(task) && task.status === "open") {
    const when = rejectionAt(task);
    const by = rejectionByLabel(rejectionBy(task));
    const reason = rejectionReason(task);
    const parts = [el("p", "", "Deze taak staat weer open.")];
    if (when) {
      parts.push(el("p", "", `Afgewezen op ${formatDateTime(when)}${by ? ` door ${by}` : ""}.`));
    }
    if (reason) parts.push(el("p", "", `Reden: ${reason}`));
    rejectionEl.replaceChildren(...parts);
    rejectionEl.classList.remove("hidden");
  } else {
    rejectionEl.replaceChildren();
    rejectionEl.classList.add("hidden");
  }

  const extra = [];
  if (task.createdAt) {
    const age = formatRelativeAge(task.createdAt);
    extra.push(`Aangemaakt op ${formatDateTime(task.createdAt)}${age ? ` (${age})` : ""}`);
  }
  const descEl = document.getElementById("modal-description");
  const descP = el("p", "modal-description-text", task.description || "");
  descP.style.whiteSpace = "pre-line";
  const descChildren = [descP];
  if (extra.length) {
    const meta = el("div", "task-meta");
    meta.style.whiteSpace = "pre-line";
    meta.textContent = extra.join("\n");
    descChildren.push(meta);
  }
  descEl.replaceChildren(...descChildren);

  const photoEls = safePhotos(task).map((src) => {
    const img = document.createElement("img");
    img.alt = "Foto bij taak";
    img.tabIndex = 0;
    img.src = src;
    return img;
  });
  document.getElementById("modal-photos").replaceChildren(...photoEls);

  const allowed = canToggle(task);

  const actions = document.getElementById("modal-actions");
  actions.replaceChildren();
  if (task.claimedBy) actions.append(el("p", "task-claim", claimLabel(task)));
  if (!allowed) {
    // B6: uitleg i.p.v. een ontbrekende knop.
    actions.append(el("p", "form-notice", `Toegewezen aan ${staffAssigneeLabel(task)}: alleen die persoon kan afvinken.`));
  } else if (task.status === "open") {
    const btn = el("button", "success", "Markeer als gedaan");
    btn.type = "button";
    btn.id = "tick-btn";
    btn.onclick = () => guardedToggle(() => markPending(task.id));
    actions.append(btn);
    if (!task.claimedBy) {
      const claim = el("button", "secondary", "Ik pak deze op");
      claim.type = "button";
      claim.id = "claim-btn";
      claim.onclick = () => guardedToggle(() => setClaim(task.id, true));
      actions.append(claim);
    } else if (isClaimedByMe(task)) {
      const release = el("button", "secondary", "Loslaten");
      release.type = "button";
      release.id = "release-btn";
      release.onclick = () => guardedToggle(() => setClaim(task.id, false));
      actions.append(release);
    }
  } else if (task.status === "pending" && canUntick(task)) {
    const btn = el("button", "secondary", "Ongedaan maken");
    btn.type = "button";
    btn.id = "untick-btn";
    btn.onclick = () => guardedToggle(() => unmarkPending(task.id));
    actions.append(btn);
  }
  document.getElementById("modal").classList.remove("hidden");
}

function closeModal() {
  document.getElementById("modal").classList.add("hidden");
  currentTaskId = null;
}

function writeErrorMessage(err) {
  const code = String((err && err.code) || "");
  const message = String((err && err.message) || err || "");
  const offline = (typeof navigator !== "undefined" && navigator.onLine === false)
    || code === "unavailable"
    || code === "firestore/unavailable"
    || /unavailable|offline|Failed to get document|network/i.test(`${code} ${message}`);
  if (offline) return "Geen verbinding. Probeer het opnieuw als je weer online bent.";
  if (code === "permission-denied" || code === "firestore/permission-denied" || /permission-denied/i.test(`${code} ${message}`)) {
    return "Geen toestemming om deze taak te wijzigen.";
  }
  return "Opslaan is mislukt. Probeer het opnieuw.";
}

function showToast(text, type) {
  const el = document.getElementById("toast");
  el.textContent = text;
  el.classList.remove("hidden", "is-success", "is-error");
  el.classList.add(type === "error" ? "is-error" : "is-success");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.classList.add("hidden");
  }, 4000);
}

// L2: staff may only tick/untick their own or Allen tasks
// (same condition ZLA's isStatusToggle enforces; empty assigneeId counts as Allen).
function canToggle(task) {
  const staff = getCurrentStaff();
  if (!staff || !task) return false;
  const assigneeId = task.assigneeId == null ? "" : String(task.assigneeId);
  return assigneeId === staff.employeeId || assigneeId === "ALLEN" || assigneeId === "";
}

// Untick only with an own taskCompletions doc, or (if that doc is missing)
// a legacy pending task whose pendingByEmployeeId is exactly the signed-in
// employee. An empty/null pendingByEmployeeId is not enough.
function canUntick(task) {
  const staff = getCurrentStaff();
  if (!staff || !staff.employeeId || !task || task.status !== "pending") return false;
  if (Object.prototype.hasOwnProperty.call(ownCompletions, task.id)) {
    return ownCompletions[task.id].employeeId === staff.employeeId;
  }
  return String(task.pendingByEmployeeId || "") === staff.employeeId;
}

let toggleBusy = false;
let lastToggleAt = 0;

// Double-submit / rate guard for tick and untick (M3).
async function guardedToggle(fn) {
  const now = Date.now();
  if (toggleBusy || now - lastToggleAt < TOGGLE_COOLDOWN_MS) {
    showToast("Even wachten…", "success"); // B5: geen stille tik meer
    return;
  }
  toggleBusy = true;
  lastToggleAt = now;
  const sel = "#tick-btn, #untick-btn, #claim-btn, #release-btn";
  document.querySelectorAll(sel).forEach((b) => { b.disabled = true; });
  try {
    await fn();
  } finally {
    toggleBusy = false;
    document.querySelectorAll(sel).forEach((b) => { b.disabled = false; });
  }
}

// v3a "Ik pak deze op" (data-afspraak punt 8): alleen zichzelf zetten of de eigen claim weghalen.
async function setClaim(id, claim) {
  const task = tasks.find((item) => item.id === id);
  const staff = getCurrentStaff();
  if (!task || !staff || task.status !== "open" || !canToggle(task)) return;
  try {
    if (claim) {
      if (task.claimedBy) {
        showToast(claimLabel(task) + ".", "error");
        return;
      }
      const name = officialStaffName().slice(0, 60);
      await updateDoc(doc(db, "tasks", id), {
        claimedBy: { employeeId: staff.employeeId, name },
        claimedAt: serverTimestamp()
      });
      showToast("Je hebt deze taak opgepakt.", "success");
    } else {
      if (!isClaimedByMe(task)) return;
      await updateDoc(doc(db, "tasks", id), { claimedBy: deleteField(), claimedAt: deleteField() });
      showToast("Taak losgelaten.", "success");
    }
  } catch (err) {
    showToast(isPermissionDenied(err) ? "Oppakken is nog niet beschikbaar." : writeErrorMessage(err), "error");
  }
}

async function markPending(id) {
  const task = tasks.find((item) => item.id === id);
  if (!task || task.status !== "open") return;
  if (!canToggle(task)) {
    showToast("Je kunt alleen je eigen taken of taken voor Allen afvinken.", "error");
    return;
  }
  const staff = getCurrentStaff();
  const name = staff ? officialStaffName().slice(0, 60) : "";
  if (!staff || !staff.employeeId || !name) {
    showToast("Je bent niet ingelogd.", "error");
    return;
  }
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, "tasks", id), {
      status: "pending",
      pendingAt: deleteField(),
      pendingBy: deleteField(),
      pendingByEmployeeId: deleteField()
    });
    batch.set(doc(db, "taskCompletions", id), {
      employeeId: staff.employeeId,
      name,
      at: serverTimestamp()
    });
    await batch.commit();
    closeModal();
    showToast("Taak is ter controle gezet.", "success");
  } catch (err) {
    showToast(writeErrorMessage(err), "error");
  }
}

async function unmarkPending(id) {
  const task = tasks.find((item) => item.id === id);
  if (!task || task.status !== "pending") return;
  if (!canToggle(task) || !canUntick(task)) {
    showToast("Alleen wie de taak afvinkte kan dit terugzetten.", "error");
    return;
  }
  try {
    const batch = writeBatch(db);
    const hasOwnCompletion = Object.prototype.hasOwnProperty.call(ownCompletions, id);
    if (hasOwnCompletion) {
      batch.update(doc(db, "tasks", id), { status: "open" });
      batch.delete(doc(db, "taskCompletions", id));
    } else {
      batch.update(doc(db, "tasks", id), {
        status: "open",
        pendingAt: deleteField(),
        pendingBy: deleteField(),
        pendingByEmployeeId: deleteField()
      });
    }
    await batch.commit();
    closeModal();
    showToast("Afvinken ongedaan gemaakt.", "success");
  } catch (err) {
    showToast(
      isPermissionDenied(err)
        ? "Alleen wie de taak afvinkte kan dit terugzetten."
        : writeErrorMessage(err),
      "error"
    );
  }
}


function isPermissionDenied(err) {
  const code = String((err && err.code) || "");
  const message = String((err && err.message) || err || "");
  return /permission-denied/i.test(`${code} ${message}`);
}

function setFormError(id, message) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = message || "";
  el.classList.toggle("hidden", !message);
}

function deviceInfo() {
  const ua = String((typeof navigator !== "undefined" && navigator.userAgent) || "");
  const uaData = typeof navigator !== "undefined" ? navigator.userAgentData : null;
  const platform = String((uaData && uaData.platform) || (typeof navigator !== "undefined" && navigator.platform) || "");
  const screenSize = (typeof screen !== "undefined" && screen.width && screen.height)
    ? `${screen.width}x${screen.height}`
    : "";
  return `${ua} | ${platform} | ${screenSize}`.slice(0, DEVICE_MAX_CHARS);
}

// M3: photo type/size checks before and after compression.
function checkPhotoFile(file) {
  if (!file) return;
  // Output is always re-encoded to JPEG via canvas; the type check is for clear feedback.
  if (file.type && !PHOTO_ACCEPT.test(file.type)) {
    throw new Error("Kies een geldige foto (JPG, PNG of WebP).");
  }
  if (file.size > PHOTO_FILE_MAX_BYTES) {
    throw new Error("De foto is te groot. Kies een kleinere foto.");
  }
}

function checkPhotoDataUrl(dataUrl) {
  if (!isSafeImageDataUrl(dataUrl) || !/^data:image\/(jpeg|png|webp);base64,/.test(dataUrl)) {
    throw new Error("Kies een geldige foto.");
  }
  if (dataUrl.length > PHOTO_MAX_CHARS) {
    throw new Error("De foto is te groot. Kies een kleinere foto.");
  }
  return dataUrl;
}

// Double-submit guard (in-flight). Daily limits and the 15 s cooldown come from
// the server counter staffDailyCounters/{employeeId} (limits.js).
let submitBusy = false;
LEGACY_LIMIT_KEYS.forEach((k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } });

async function compressPhoto(file, maxChars = PHOTO_MAX_CHARS) {
  checkPhotoFile(file);
  let edge = 1000;
  let quality = 0.6;
  let dataUrl = "";
  for (let i = 0; i < 7; i++) {
    dataUrl = await compressImage(file, edge, quality);
    if (dataUrl && !isSafeImageDataUrl(dataUrl)) throw new Error("Kies een geldige foto.");
    if (!dataUrl) return "";
    if (dataUrl.length <= maxChars) return checkPhotoDataUrl(dataUrl);
    edge = Math.max(280, Math.round(edge * 0.7));
    quality = Math.max(0.32, quality - 0.08);
  }
  if (!dataUrl || dataUrl.length > maxChars) {
    throw new Error("De foto is te groot. Kies een kleinere foto.");
  }
  return checkPhotoDataUrl(dataUrl);
}

function filePickerNameEl(input) {
  const id = input && input.getAttribute("aria-describedby");
  return id ? document.getElementById(id) : null;
}

function setFilePickerName(input, text) {
  const nameEl = filePickerNameEl(input);
  if (nameEl) nameEl.textContent = text;
}

function resetFilePicker(input) {
  if (!input) return;
  input.value = "";
  setFilePickerName(input, "Geen foto gekozen");
}

function bindPhotoPreview(input, preview) {
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    setFilePickerName(input, file ? file.name : "Geen foto gekozen");
    if (!file) {
      preview.replaceChildren();
      preview.classList.add("hidden");
      return;
    }
    const url = URL.createObjectURL(file);
    const img = document.createElement("img");
    img.alt = "Gekozen foto";
    img.src = url;
    const remove = el("button", "photo-preview-remove", "Foto verwijderen");
    remove.type = "button";
    preview.replaceChildren(img, remove);
    preview.classList.remove("hidden");
    remove.addEventListener("click", () => {
      URL.revokeObjectURL(url);
      resetFilePicker(input);
      preview.replaceChildren();
      preview.classList.add("hidden");
    });
  });
}

function closePage(id) {
  const page = document.getElementById(id);
  if (page) page.classList.add("hidden");
}

function closeStaffPages() {
  closePage("add-task-page");
  closePage("report-page");
}

function selectedAddTaskAssignee() {
  const allen = document.getElementById("add-task-assignee-allen");
  return allen && allen.getAttribute("aria-checked") === "true" ? "allen" : "self";
}

function setAddTaskAssignee(value) {
  const forAllen = value === "allen";
  const selfBtn = document.getElementById("add-task-assignee-self");
  const allenBtn = document.getElementById("add-task-assignee-allen");
  if (selfBtn) {
    selfBtn.classList.toggle("is-active", !forAllen);
    selfBtn.setAttribute("aria-checked", String(!forAllen));
    selfBtn.tabIndex = forAllen ? -1 : 0;
  }
  if (allenBtn) {
    allenBtn.classList.toggle("is-active", forAllen);
    allenBtn.setAttribute("aria-checked", String(forAllen));
    allenBtn.tabIndex = forAllen ? 0 : -1;
  }
}

function bindAddTaskAssigneeChoice() {
  const group = document.getElementById("add-task-assignee-choice");
  if (!group) return;
  group.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-assignee]");
    if (!btn || !group.contains(btn)) return;
    setAddTaskAssignee(btn.getAttribute("data-assignee"));
  });
  group.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = (event.key === "ArrowRight" || event.key === "ArrowDown" || event.key === "End")
      ? "allen"
      : "self";
    setAddTaskAssignee(next);
    const focusId = next === "allen" ? "add-task-assignee-allen" : "add-task-assignee-self";
    const focusBtn = document.getElementById(focusId);
    if (focusBtn) focusBtn.focus();
  });
}

function openAddTaskPage() {
  const staff = getCurrentStaff();
  if (!staff) {
    showToast("Je bent niet ingelogd.", "error");
    return;
  }
  closePage("report-page");
  const form = document.getElementById("staff-add-task-form");
  if (form) form.reset();
  resetFilePicker(document.getElementById("add-task-photo"));
  const preview = document.getElementById("add-task-photo-preview");
  if (preview) {
    preview.replaceChildren();
    preview.classList.add("hidden");
  }
  setFormError("add-task-error", "");
  fillLocationSelect(true);
  if (!locationsReady()) setFormError("add-task-error", LOCATION_UNSET_MSG);
  setAddTaskAssignee("self");
  const page = document.getElementById("add-task-page");
  if (page) page.classList.remove("hidden");
  const title = document.getElementById("add-task-title-input");
  if (title && locationsReady()) {
    try { title.focus(); } catch { /* ignore */ }
  }
}

function updateReportCount() {
  const input = document.getElementById("report-description");
  const count = document.getElementById("report-count");
  if (!input || !count) return;
  count.textContent = `${input.value.length} / ${REPORT_DESC_MAX}`;
}

function openReportPage() {
  const staff = getCurrentStaff();
  if (!staff) {
    showToast("Je bent niet ingelogd.", "error");
    return;
  }
  closePage("add-task-page");
  const form = document.getElementById("report-form");
  if (form) form.reset();
  resetFilePicker(document.getElementById("report-photo"));
  const preview = document.getElementById("report-photo-preview");
  if (preview) {
    preview.replaceChildren();
    preview.classList.add("hidden");
  }
  setFormError("report-error", "");
  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  setText("report-info-name", officialStaffName());
  setText("report-info-time", formatDateTime(new Date()));
  setText("report-info-version", appVersion());
  setText("report-info-device", deviceInfo() || "Onbekend");
  updateReportCount();
  const page = document.getElementById("report-page");
  if (page) page.classList.remove("hidden");
  const desc = document.getElementById("report-description");
  if (desc) {
    try { desc.focus(); } catch { /* ignore */ }
  }
}

function writeFormError(err, permissionText, fallback) {
  if (err && err.isLimit) return err.message;
  if (isPermissionDenied(err)) return permissionText;
  if (/te groot|geldige foto|Even wachten|maximaal/i.test(String((err && err.message) || err || ""))) {
    return err.message;
  }
  const code = String((err && err.code) || "");
  const message = String((err && err.message) || err || "");
  const offline = (typeof navigator !== "undefined" && navigator.onLine === false)
    || /unavailable|offline|network/i.test(`${code} ${message}`);
  return offline
    ? "Geen verbinding. Probeer het opnieuw als je weer online bent."
    : fallback;
}

function setFormBusy(form, busy) {
  if (!form) return;
  form.dataset.busy = busy ? "1" : "0";
  form.querySelectorAll("button, input, textarea, select").forEach((el) => {
    el.disabled = Boolean(busy);
  });
  if (!busy && form.id === "staff-add-task-form") fillLocationSelect();
}

async function onAddTaskSubmit(event) {
  event.preventDefault();
  const staff = getCurrentStaff();
  if (!staff) {
    setFormError("add-task-error", "Je bent niet ingelogd.");
    return;
  }
  if (!locationsReady()) {
    setFormError("add-task-error", LOCATION_UNSET_MSG);
    return;
  }
  const title = document.getElementById("add-task-title-input").value.trim();
  const locationId = document.getElementById("add-task-location-input").value.trim();
  const chosen = staffSelectableLocationItems().find((item) => item.id === locationId);
  const location = chosen ? String(chosen.label || "").trim() : "";
  const description = document.getElementById("add-task-description-input").value.trim();
  if (!title) {
    setFormError("add-task-error", "Vul een titel in.");
    return;
  }
  if (title.length > TITLE_MAX) {
    setFormError("add-task-error", `De titel mag maximaal ${TITLE_MAX} tekens zijn.`);
    return;
  }
  if (!locationId || !chosen || !location) {
    setFormError("add-task-error", "Kies een locatie.");
    return;
  }
  if (location.length > LOCATION_MAX) {
    setFormError("add-task-error", `De locatie mag maximaal ${LOCATION_MAX} tekens zijn.`);
    return;
  }
  if (description.length > DESCRIPTION_MAX) {
    setFormError("add-task-error", `De beschrijving mag maximaal ${DESCRIPTION_MAX} tekens zijn.`);
    return;
  }
  if (submitBusy) return;
  const form = document.getElementById("staff-add-task-form");
  const fileInput = document.getElementById("add-task-photo");
  const file = fileInput && fileInput.files && fileInput.files[0];
  submitBusy = true;
  setFormBusy(form, true);
  setFormError("add-task-error", "");
  try {
    const photos = [];
    if (file) {
      const dataUrl = await compressPhoto(file);
      if (dataUrl) photos.push(dataUrl);
    }
    const name = officialStaffName();
    const forAllen = selectedAddTaskAssignee() === "allen";
    const F = STAFF_TASK;
    // dueDate is admin-only: never set it on staff creates, and never show it in this app.
    const payload = {
      [F.title]: title,
      [F.description]: description,
      [F.location]: location,
      [F.locationId]: locationId,
      [F.assigneeId]: forAllen ? "ALLEN" : staff.employeeId,
      [F.assigneeName]: forAllen ? "Allen" : name,
      [F.status]: "open",
      [F.createdAt]: new Date().toISOString(),
      [F.photos]: photos,
      [F.createdByRole]: "staff",
      [F.createdByEmployeeId]: staff.employeeId,
      [F.createdByName]: name,
      [F.adminReview]: "nieuw"
    };
    delete payload.dueDate;
    await sendWithStaffCounter("task", payload, staff.employeeId, (msg) => setFormError("add-task-error", msg));
    closePage("add-task-page");
    showToast("Taak toegevoegd.", "success");
  } catch (err) {
    const message = writeFormError(
      err,
      "Taak toevoegen is nog niet beschikbaar",
      "Opslaan is mislukt. Probeer het opnieuw."
    );
    setFormError("add-task-error", message);
    showToast(message, "error");
  } finally {
    submitBusy = false;
    setFormBusy(form, false);
  }
}

async function onReportSubmit(event) {
  event.preventDefault();
  const staff = getCurrentStaff();
  if (!staff) {
    setFormError("report-error", "Je bent niet ingelogd.");
    return;
  }
  const description = document.getElementById("report-description").value.trim();
  if (!description) {
    setFormError("report-error", "Vul een omschrijving in.");
    return;
  }
  if (description.length > REPORT_DESC_MAX) {
    setFormError("report-error", `De omschrijving mag maximaal ${REPORT_DESC_MAX} tekens zijn.`);
    return;
  }
  if (submitBusy) return;
  const form = document.getElementById("report-form");
  const fileInput = document.getElementById("report-photo");
  const file = fileInput && fileInput.files && fileInput.files[0];
  submitBusy = true;
  setFormBusy(form, true);
  setFormError("report-error", "");
  try {
    const F = REPORT;
    const payload = {
      [F.description]: description,
      [F.employeeId]: staff.employeeId,
      [F.employeeName]: officialStaffName(),
      [F.createdAt]: serverTimestamp(),
      [F.appVersion]: appVersion().slice(0, APP_VERSION_MAX),
      [F.device]: deviceInfo(),
      [F.status]: "nieuw"
    };
    if (file) {
      const dataUrl = await compressPhoto(file);
      if (dataUrl) payload[F.photo] = dataUrl;
    }
    await sendWithStaffCounter("report", payload, staff.employeeId, (msg) => setFormError("report-error", msg));
    closePage("report-page");
    showToast("Bedankt, je melding is verstuurd", "success");
  } catch (err) {
    const message = writeFormError(
      err,
      "Fout melden is nog niet beschikbaar",
      "Versturen is mislukt. Probeer het opnieuw."
    );
    setFormError("report-error", message);
    showToast(message, "error");
  } finally {
    submitBusy = false;
    setFormBusy(form, false);
  }
}

function setupStaffPages() {
  const addForm = document.getElementById("staff-add-task-form");
  const reportForm = document.getElementById("report-form");
  const fab = document.getElementById("add-task-fab");
  const reportBtn = document.getElementById("report-menu-btn");
  if (fab) fab.addEventListener("click", openAddTaskPage);
  if (reportBtn) {
    reportBtn.addEventListener("click", () => {
      const menu = document.getElementById("header-more-menu");
      const btn = document.getElementById("header-more-btn");
      if (menu) menu.classList.add("hidden");
      if (btn) btn.setAttribute("aria-expanded", "false");
      openReportPage();
    });
  }
  if (addForm) addForm.addEventListener("submit", onAddTaskSubmit);
  bindAddTaskAssigneeChoice();
  if (reportForm) reportForm.addEventListener("submit", onReportSubmit);
  ["add-task-close", "add-task-cancel"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", () => closePage("add-task-page"));
  });
  ["report-close", "report-cancel"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", () => closePage("report-page"));
  });
  const reportDesc = document.getElementById("report-description");
  if (reportDesc) reportDesc.addEventListener("input", updateReportCount);
  const addPhoto = document.getElementById("add-task-photo");
  const addPreview = document.getElementById("add-task-photo-preview");
  if (addPhoto && addPreview) bindPhotoPreview(addPhoto, addPreview);
  const reportPhoto = document.getElementById("report-photo");
  const reportPreview = document.getElementById("report-photo-preview");
  if (reportPhoto && reportPreview) bindPhotoPreview(reportPhoto, reportPreview);
  ["add-task-page", "report-page"].forEach((id) => {
    const page = document.getElementById(id);
    if (!page) return;
    page.addEventListener("click", (event) => {
      if (event.target.id === id) closePage(id);
    });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const lightbox = document.getElementById("lightbox");
    if (lightbox && !lightbox.classList.contains("hidden")) return;
    const report = document.getElementById("report-page");
    const add = document.getElementById("add-task-page");
    if (report && !report.classList.contains("hidden")) {
      closePage("report-page");
      return;
    }
    if (add && !add.classList.contains("hidden")) {
      closePage("add-task-page");
      return;
    }
    const modal = document.getElementById("modal");
    if (modal && !modal.classList.contains("hidden")) closeModal(); // B4
  });
}

// --- Restpunt v2: concept bewaren bij verversen -------------------------------
// Tekstvelden gaan via sessionStorage mee over de reload (zelfde tabblad). Een gekozen
// foto kan een browser niet bewaren; daarvoor een melding.
const DRAFT_KEY = "zeiklijst-concept";
const DRAFT_MAX_AGE_MS = 30 * 60 * 1000;
let draftLocationToRestore = "";

function pageOpen(id) {
  const page = document.getElementById(id);
  return Boolean(page && !page.classList.contains("hidden"));
}

function fieldValue(id) {
  const el = document.getElementById(id);
  return el ? String(el.value || "") : "";
}

function hasFile(id) {
  const el = document.getElementById(id);
  return Boolean(el && el.files && el.files.length);
}

function saveDraft() {
  const staff = getCurrentStaff();
  if (!staff) return;
  let draft = null;
  if (pageOpen("add-task-page")) {
    draft = {
      page: "add",
      title: fieldValue("add-task-title-input"),
      description: fieldValue("add-task-description-input"),
      locationId: fieldValue("add-task-location-input"),
      assignee: selectedAddTaskAssignee(),
      photo: hasFile("add-task-photo")
    };
  } else if (pageOpen("report-page")) {
    draft = { page: "report", description: fieldValue("report-description"), photo: hasFile("report-photo") };
  }
  try {
    if (draft) sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ ...draft, employeeId: staff.employeeId, at: Date.now() }));
  } catch { /* ignore quota */ }
}

function restoreDraft() {
  let draft = null;
  try { draft = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "null"); } catch { draft = null; }
  try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
  const staff = getCurrentStaff();
  if (!draft || !staff || draft.employeeId !== staff.employeeId) return;
  if (!(Date.now() - Number(draft.at) < DRAFT_MAX_AGE_MS)) return;
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.value = String(value || "");
  };
  if (draft.page === "add") {
    openAddTaskPage();
    set("add-task-title-input", draft.title);
    set("add-task-description-input", draft.description);
    setAddTaskAssignee(draft.assignee === "allen" ? "allen" : "self");
    draftLocationToRestore = String(draft.locationId || "");
    restoreDraftLocation();
  } else if (draft.page === "report") {
    openReportPage();
    set("report-description", draft.description);
    updateReportCount();
  } else {
    return;
  }
  showToast(draft.photo ? "Je concept is teruggezet. Kies de foto opnieuw." : "Je concept is teruggezet.", "success");
}

function restoreDraftLocation() {
  if (!draftLocationToRestore) return;
  const sel = document.getElementById("add-task-location-input");
  if (!sel || ![...sel.options].some((o) => o.value === draftLocationToRestore)) return;
  sel.value = draftLocationToRestore;
  draftLocationToRestore = "";
}

function setupUpdateBanner() {
  const banner = document.getElementById("update-banner");
  if (!banner) return;
  banner.textContent = "Nieuwe versie, tik om te verversen";
  banner.style.position = "fixed";
  banner.style.top = "0";
  banner.style.zIndex = "1300";

  const RELOAD_GUARD_KEY = "zeiklijst-sw-reload";
  const RELOAD_GUARD_MS = 30 * 1000;
  const UPDATE_CHECK_MS = 5 * 60 * 1000;
  const BUSY_IDS = ["modal", "add-task-page", "report-page", "lightbox", "header-more-menu"];
  const DRAFT_IDS = [
    "add-task-title-input",
    "add-task-description-input",
    "add-task-location-input",
    "add-task-photo",
    "report-description",
    "report-photo",
    "staff-code-input",
    "staff-pin-new",
    "staff-pin-confirm",
    "staff-pin-input",
    "staff-reset-name",
    "staff-reset-note"
  ];

  let reloading = false;
  let pendingReload = false;
  let waitingWorker = null;
  let userRequestedUpdate = false;

  function isUserBusy() {
    if (BUSY_IDS.some((id) => {
      const el = document.getElementById(id);
      return el && !el.classList.contains("hidden");
    })) return true;
    return DRAFT_IDS.some((id) => {
      const el = document.getElementById(id);
      if (!el) return false;
      if (el.closest(".hidden, [hidden]")) return false; // verborgen formulier is geen concept
      if (el.type === "file") return el.files && el.files.length > 0;
      return String(el.value || "").trim() !== "";
    });
  }

  function readGuard() {
    try {
      const g = JSON.parse(sessionStorage.getItem(RELOAD_GUARD_KEY) || "null");
      return g && typeof g === "object" && "version" in g && Number.isFinite(Number(g.at)) ? g : null;
    } catch {
      return null;
    }
  }

  function writeGuard(version, at) {
    try {
      sessionStorage.setItem(RELOAD_GUARD_KEY, JSON.stringify({ version: String(version), at }));
    } catch {
      /* ignore quota */
    }
  }

  function showBanner() {
    banner.classList.remove("hidden");
  }

  function activateWaiting() {
    if (!waitingWorker) return;
    try { waitingWorker.postMessage({ type: "SKIP_WAITING" }); } catch {
      /* ignore */
    }
  }

  function canAutoReload(now) {
    const guard = readGuard();
    if (guard && now - Number(guard.at) < RELOAD_GUARD_MS) return false;
    if (guard && String(guard.version) === String(appVersion())) return false;
    return true;
  }

  function safeReload() {
    if (reloading) return;
    const now = Date.now();
    // B8: een bewuste tik op de balk negeert de 30 s-guard.
    if (!userRequestedUpdate && !canAutoReload(now)) {
      showBanner();
      return;
    }
    reloading = true;
    writeGuard(appVersion(), now);
    saveDraft();
    location.reload();
  }

  function applyUpdate() {
    if (pendingReload) {
      if (isUserBusy()) {
        showBanner();
        return;
      }
      safeReload();
      return;
    }
    if (!waitingWorker) return;
    if (isUserBusy()) {
      showBanner();
      return;
    }
    activateWaiting();
  }

  banner.addEventListener("click", () => {
    userRequestedUpdate = true;
    saveDraft(); // restpunt v2: concept niet kwijt bij tikken op de verversbalk
    if (pendingReload) {
      if (reloading) return;
      reloading = true;
      writeGuard(appVersion(), Date.now());
      location.reload();
      return;
    }
    activateWaiting();
  });

  document.addEventListener("click", applyUpdate);
  document.addEventListener("input", applyUpdate);
  document.addEventListener("change", applyUpdate);
  const observer = new MutationObserver(applyUpdate);
  BUSY_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (el) observer.observe(el, { attributes: true, attributeFilter: ["class"] });
  });

  if (!("serviceWorker" in navigator)) return;

  // Only reload when an existing worker is replaced (not on the very first install).
  // After a first install on this page, remember the controller so a later
  // update in the same tab can still auto-reload.
  let hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    if (!hadController) {
      hadController = true;
      return;
    }
    pendingReload = true;
    if (isUserBusy() && !userRequestedUpdate) {
      showBanner();
      return;
    }
    safeReload();
  });

  navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).then((reg) => {
    const check = () => { reg.update().catch(() => {}); };
    check();
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) check();
    });
    setInterval(check, UPDATE_CHECK_MS);

    const attachWaiting = (worker) => {
      if (!worker) return;
      waitingWorker = worker;
      applyUpdate();
    };
    if (reg.waiting) attachWaiting(reg.waiting);
    reg.addEventListener("updatefound", () => {
      const installing = reg.installing;
      if (!installing) return;
      installing.addEventListener("statechange", () => {
        if (installing.state === "installed" && navigator.serviceWorker.controller) {
          attachWaiting(reg.waiting || installing);
        }
      });
    });
  }).catch(() => {});
}

setupUi();
paintAppVersionLabel();
watchMaintenance();

initStaffAuth({
  showToast,
  onLoggedIn(staff) {
    startListeners();
    renderAdminSwitch();
    startSession(staff);
    restoreDraft();
  },
  onLoggedOut() {
    stopSession();
    closeModal();
    closeStaffPages();
    stopListeners();
    renderTasks();
  }
});
