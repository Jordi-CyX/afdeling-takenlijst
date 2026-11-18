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

export function assigneeLabel(task) {
  if (task.assigneeId === "ALLEN") return "Allen";
  if (task.assigneeName) return task.assigneeName;
  if (task.assignee) return task.assignee;
  return "Niet toegewezen";
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
    adminReview: typeof d.adminReview === "string" ? d.adminReview : ""
  };
}

export function normalizeTemplate(id, data) {
  const d = data || {};
  const recurrence = d.recurrence && typeof d.recurrence === "object"
    ? { ...d.recurrence }
    : { type: "daily", startDate: localDateKey(new Date()) };
  if (!recurrence.startDate) recurrence.startDate = localDateKey(new Date());
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
    location: typeof d.location === "string" ? d.location : ""
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
  if (task.createdByRole || task.createdByEmployeeId || task.createdByName || task.adminReview) {
    payload.createdByRole = task.createdByRole || "";
    payload.createdByEmployeeId = task.createdByEmployeeId || "";
    payload.createdByName = task.createdByName || "";
    payload.adminReview = task.adminReview || "";
  }
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
    recurrence: template.recurrence || { type: "daily", startDate: localDateKey(new Date()) },
    paused: Boolean(template.paused),
    createdAt: template.createdAt || new Date().toISOString()
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
  const today = localDateKey(new Date());
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
