import {
  collection,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  runTransaction,
  writeBatch,
  getDocs
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";
import { db } from "./firebase-init.js";

export const STATUS_LABELS = {
  open: "Open",
  pending: "Pending",
  afgerond: "Afgerond"
};

export const WEEKDAYS = [
  { value: 1, short: "Ma", long: "maandag" },
  { value: 2, short: "Di", long: "dinsdag" },
  { value: 3, short: "Wo", long: "woensdag" },
  { value: 4, short: "Do", long: "donderdag" },
  { value: 5, short: "Vr", long: "vrijdag" },
  { value: 6, short: "Za", long: "zaterdag" },
  { value: 0, short: "Zo", long: "zondag" }
];

export const SEED_EMPLOYEES = [
  "Jane", "Aart", "Edwin", "Daan", "Reda", "Akif", "Finn", "Tim", "Guido", "Renato", "Alex"
];

export const STORAGE_TASKS = "takenlijst";
export const STORAGE_TEMPLATES = "takenlijst-templates";
export const STORAGE_MIGRATED = "takenlijst-migrated-to-firebase";

const MAX_PHOTOS = 4;
const MAX_EDGE = 1000;
const JPEG_QUALITY = 0.6;
const MAX_DOC_BYTES = 700 * 1024;

// Datum (JJJJ-MM-DD) in Europe/Amsterdam, onafhankelijk van de tijdzone van het toestel.
export function amsterdamDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function localDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseLocalDate(key) {
  const [y, m, d] = String(key).split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(date, n) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
}

export function calendarDiffDays(later, earlier) {
  const a = Date.UTC(later.getFullYear(), later.getMonth(), later.getDate());
  const b = Date.UTC(earlier.getFullYear(), earlier.getMonth(), earlier.getDate());
  return Math.round((a - b) / 86400000);
}

function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (typeof value === "string" && value.length <= 10) return parseLocalDate(value);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(value) {
  const date = toDate(value);
  if (!date) return "";
  return date.toLocaleDateString("nl-NL", { day: "numeric", month: "short", year: "numeric" });
}

export function formatDateTime(value) {
  const date = toDate(value);
  if (!date) return "";
  return date.toLocaleString("nl-NL", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function toIso(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  const date = toDate(value);
  return date ? date.toISOString() : null;
}

export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[m]));
}

export function escapeAttr(str) {
  return escapeHtml(str);
}

export function safeParse(raw, fallback) {
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw);
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

export function employeeSlug(name) {
  return "emp-" + String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function normalizeName(name) {
  return String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function staffEmail(employeeId, pinVersion) {
  return `emp-${employeeId}-v${Number(pinVersion) || 0}@zeiklijst.app`;
}

export function staffPassword(pin, employeeId) {
  return `zl-${pin}-${employeeId}`;
}

// --- Startcodes (eenmalig, 7 dagen geldig) -------------------------------
// Alfabet: A-Z en 2-9 zonder 0, O, 1, I en L (31 tekens).
export const START_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const START_CODE_LENGTH = 10;
export const START_CODE_VALID_DAYS = 7;

// Voor lookup/doc-id: hoofdletters, alleen geldige tekens (streepjes/spaties weg).
export function normalizeStartCode(s) {
  return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Voor weergave: XXXXX-XXXXX.
export function formatStartCode(s) {
  const code = normalizeStartCode(s);
  if (code.length <= 5) return code;
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

export function isValidStartCode(s) {
  const code = normalizeStartCode(s);
  if (code.length !== START_CODE_LENGTH) return false;
  for (const ch of code) {
    if (!START_CODE_ALPHABET.includes(ch)) return false;
  }
  return true;
}

// Cryptografisch willekeurig, zonder modulo-bias (rejection sampling).
export function generateStartCode() {
  const n = START_CODE_ALPHABET.length;
  const limit = 256 - (256 % n);
  let out = "";
  const buf = new Uint8Array(32);
  while (out.length < START_CODE_LENGTH) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < limit && out.length < START_CODE_LENGTH) out += START_CODE_ALPHABET[b % n];
    }
  }
  return out;
}

// Auth-e-mail voor een medewerker die via een startcode een pincode instelde.
// key = de startcode (of nameIndex.loginKey); wordt genormaliseerd en lowercase.
export function startCodeEmail(employeeId, pinVersion, key) {
  const k = normalizeStartCode(key).toLowerCase();
  return `emp-${employeeId}-v${Number(pinVersion) || 0}-${k}@zeiklijst.app`;
}

// Alleen data:image/(jpeg|png|webp);base64,... wordt als foto geaccepteerd.
const SAFE_IMAGE_DATA_URL = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
export function isSafeImageDataUrl(s) {
  return typeof s === "string" && s.length <= 1000000 && SAFE_IMAGE_DATA_URL.test(s);
}

export function assigneeLabel(task) {
  if (task.assigneeId === "ALLEN") return "Allen";
  if (task.assigneeName) return task.assigneeName;
  if (task.assignee) return task.assignee;
  return "Allen"; // eigenaar 12:20/13:01: zonder persoon = Allen (geen "Niet toegewezen")
}

export function occurrenceInMonth(year, month, day) {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day, lastDay));
}

export function latestDueOnOrBefore(template, todayStr) {
  const recurrence = template.recurrence || {};
  const today = parseLocalDate(todayStr);
  const start = parseLocalDate(recurrence.startDate || todayStr);
  if (Number.isNaN(today.getTime()) || Number.isNaN(start.getTime()) || today < start) return null;
  const type = recurrence.type;
  if (type === "daily") return todayStr;
  if (type === "every_other_day") {
    const diff = calendarDiffDays(today, start);
    if (diff % 2 === 0) return todayStr;
    return localDateKey(addDays(today, -1));
  }
  if (type === "weekdays") {
    const days = Array.isArray(recurrence.weekdays) ? recurrence.weekdays : [];
    if (!days.length) return null;
    for (let i = 0; i < 7; i++) {
      const candidate = addDays(today, -i);
      if (candidate < start) return null;
      if (days.includes(candidate.getDay())) return localDateKey(candidate);
    }
    return null;
  }
  if (type === "date") {
    const target = recurrence.date;
    if (!target) return null;
    if (recurrence.monthly) {
      const day = Number(String(target).split("-")[2]);
      if (!day) return null;
      let occ = occurrenceInMonth(today.getFullYear(), today.getMonth(), day);
      if (occ > today) {
        occ = today.getMonth() === 0
          ? occurrenceInMonth(today.getFullYear() - 1, 11, day)
          : occurrenceInMonth(today.getFullYear(), today.getMonth() - 1, day);
      }
      if (occ < start) return null;
      return localDateKey(occ);
    }
    if (target <= todayStr && target >= (recurrence.startDate || target)) return target;
    return null;
  }
  return null;
}

export function normalizeTask(id, data) {
  const d = data || {};
  let status = d.status || "open";
  if (status === "approved" || status === "completed") status = "afgerond";
  let assigneeId = d.assigneeId || "";
  let assigneeName = d.assigneeName || "";
  if (!assigneeId && d.assignee) {
    if (String(d.assignee).toLowerCase() === "allen") {
      assigneeId = "ALLEN";
      assigneeName = "Allen";
    } else {
      assigneeName = d.assignee;
    }
  }
  return {
    id,
    title: d.title || "",
    description: d.description || "",
    assigneeId,
    assigneeName,
    photos: Array.isArray(d.photos) ? d.photos : [],
    status,
    createdAt: toIso(d.createdAt || d.created) || "",
    pendingAt: toIso(d.pendingAt),
    pendingBy: d.pendingBy || null,
    pendingByEmployeeId: d.pendingByEmployeeId || null,
    completedAt: toIso(d.completedAt || d.completed),
    recurringId: d.recurringId || d.templateId || null,
    occurrenceDate: d.occurrenceDate || d.instanceDate || null,
    rejectedCount: Number(d.rejectedCount) || 0,
    rejections: Array.isArray(d.rejections) ? d.rejections : [],
    lastRejectedAt: toIso(d.lastRejectedAt),
    lastRejectionReason: typeof d.lastRejectionReason === "string" ? d.lastRejectionReason : "",
    location: typeof d.location === "string" ? d.location : "",
    createdByRole: typeof d.createdByRole === "string" ? d.createdByRole : "",
    createdByEmployeeId: d.createdByEmployeeId || "",
    createdByName: d.createdByName || "",
    adminReview: typeof d.adminReview === "string" ? d.adminReview : "",
    // Build v2: vaste locatie, spoed (alleen admin) en herkomst (audit).
    locationId: typeof d.locationId === "string" ? d.locationId : "",
    urgent: d.urgent === true,
    source: normalizeSource(d.source),
    dueDate: (typeof d.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.dueDate.trim())) ? d.dueDate.trim() : ""
  };
}

// Build v2: source = { type: "audit", auditId, auditDate, locationId, questionId, reasonId? } of null.
export function normalizeSource(src) {
  if (!src || typeof src !== "object" || src.type !== "audit") return null;
  const out = {
    type: "audit",
    auditId: String(src.auditId || ""),
    auditDate: String(src.auditDate || ""),
    locationId: String(src.locationId || ""),
    questionId: String(src.questionId || "")
  };
  if (src.reasonId) out.reasonId = String(src.reasonId);
  return out;
}

export function normalizeTemplate(id, data) {
  const d = data || {};
  const recurrence = d.recurrence && typeof d.recurrence === "object"
    ? { ...d.recurrence }
    : { type: "daily", startDate: amsterdamDateKey() };
  if (!recurrence.startDate) recurrence.startDate = amsterdamDateKey();
  let assigneeId = d.assigneeId || "";
  let assigneeName = d.assigneeName || "";
  if (!assigneeId && d.assignee) {
    if (String(d.assignee).toLowerCase() === "allen") {
      assigneeId = "ALLEN";
      assigneeName = "Allen";
    } else {
      assigneeName = d.assignee;
    }
  }
  return {
    id,
    title: d.title || "",
    description: d.description || "",
    assigneeId,
    assigneeName,
    photos: Array.isArray(d.photos) ? d.photos : [],
    recurrence,
    paused: Boolean(d.paused),
    createdAt: toIso(d.createdAt || d.created) || "",
    location: typeof d.location === "string" ? d.location : "",
    locationId: typeof d.locationId === "string" ? d.locationId : "",
    urgent: d.urgent === true
  };
}

export function normalizeEmployee(id, data) {
  const d = data || {};
  return {
    id,
    name: d.name || "",
    active: d.active !== false,
    createdAt: toIso(d.createdAt) || "",
    pinVersion: Number.isFinite(Number(d.pinVersion)) ? Number(d.pinVersion) : 0
  };
}

export function serializeTask(task) {
  const payload = {
    title: task.title || "",
    description: task.description || "",
    assigneeId: task.assigneeId || "",
    assigneeName: task.assigneeName || "",
    status: task.status || "open",
    createdAt: task.createdAt || new Date().toISOString(),
    pendingAt: task.pendingAt || null,
    pendingBy: task.pendingBy || null,
    completedAt: task.completedAt || null,
    recurringId: task.recurringId || null,
    occurrenceDate: task.occurrenceDate || null,
    photos: Array.isArray(task.photos) ? task.photos : [],
    location: task.location || ""
  };
  // Build v2: alleen meesturen als ze er zijn (de regels vergelijken met sjabloon-standaard "" / false).
  if (task.locationId) payload.locationId = task.locationId;
  if (task.urgent === true) payload.urgent = true;
  if (task.source && task.source.type === "audit") payload.source = normalizeSource(task.source);
  if (task.createdByRole || task.createdByEmployeeId || task.createdByName || task.adminReview) {
    payload.createdByRole = task.createdByRole || "";
    payload.createdByEmployeeId = task.createdByEmployeeId || "";
    payload.createdByName = task.createdByName || "";
    payload.adminReview = task.adminReview || "";
  }
  const dueDate = typeof task.dueDate === "string" ? task.dueDate.trim() : "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) payload.dueDate = dueDate;
  return payload;
}

export function serializeTemplate(template) {
  return {
    title: template.title || "",
    description: template.description || "",
    assigneeId: template.assigneeId || "",
    assigneeName: template.assigneeName || "",
    photos: Array.isArray(template.photos) ? template.photos : [],
    location: template.location || "",
    recurrence: template.recurrence || { type: "daily", startDate: amsterdamDateKey() },
    paused: Boolean(template.paused),
    createdAt: template.createdAt || new Date().toISOString(),
    ...(template.locationId ? { locationId: template.locationId } : {}),
    urgent: template.urgent === true
  };
}

export function estimatedSize(obj) {
  return new TextEncoder().encode(JSON.stringify(obj)).length;
}

export function compressImage(file, maxEdge = MAX_EDGE, quality = JPEG_QUALITY) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Afbeelding kon niet worden gelezen"));
    };
    img.src = url;
  });
}

export async function readCompressedPhotos(files) {
  const list = [...(files || [])].slice(0, MAX_PHOTOS);
  if (!list.length) return [];
  const photos = [];
  for (const file of list) {
    if (!file.type || !file.type.startsWith("image/")) continue;
    photos.push(await compressImage(file));
  }
  return photos;
}

export function assertDocSize(payload, extraMessage = "") {
  const size = estimatedSize(payload);
  if (size > MAX_DOC_BYTES) {
    throw new Error("Deze taak is te groot (te veel of te grote foto's). Voeg maximaal 4 gecomprimeerde foto's toe. " + extraMessage);
  }
  if (Array.isArray(payload.photos) && payload.photos.length > MAX_PHOTOS) {
    throw new Error("Maximaal 4 foto's per taak.");
  }
}

export async function generateDueInstances(templates, tasks) {
  const today = amsterdamDateKey();
  for (const template of templates) {
    if (template.paused) continue;
    const due = latestDueOnOrBefore(template, today);
    if (!due) continue;
    const id = `${template.id}_${due}`;
    if (tasks.some((t) => t.id === id || (t.recurringId === template.id && t.occurrenceDate === due))) continue;
    const payload = serializeTask({
      title: template.title,
      description: template.description,
      assigneeId: template.assigneeId || "",
      assigneeName: template.assigneeName || "",
      photos: template.photos || [],
      location: template.location || "",
      locationId: template.locationId || "",
      urgent: template.urgent === true,
      status: "open",
      createdAt: new Date().toISOString(),
      pendingAt: null,
      pendingBy: null,
      completedAt: null,
      recurringId: template.id,
      occurrenceDate: due
    });
    try {
      assertDocSize(payload);
      const ref = doc(db, "tasks", id);
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists()) return;
        tx.set(ref, payload);
      });
    } catch {
      // Rules, offline, or race: ignore; another client or a retry will handle it.
    }
  }
}

export function listenCollection(name, mapFn, onData, onError) {
  return onSnapshot(
    collection(db, name),
    (snap) => onData(snap.docs.map((d) => mapFn(d.id, d.data()))),
    (err) => {
      if (onError) onError(err);
    }
  );
}

export { collection, doc, addDoc, setDoc, updateDoc, deleteDoc, writeBatch, getDocs, db };
