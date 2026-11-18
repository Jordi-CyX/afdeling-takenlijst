import {
  db,
  doc,
  addDoc,
  collection,
  updateDoc,
  listenCollection,
  generateDueInstances,
  normalizeTask,
  normalizeTemplate,
  normalizeEmployee,
  formatDateTime,
  assigneeLabel,
  localDateKey,
  normalizeName,
  compressImage,
  isSafeImageDataUrl
} from "./shared.js";
import { serverTimestamp } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";
import {
  getCurrentStaff,
  initStaffAuth,
  logoutStaff,
  setStaffDisplayName
} from "./staff-auth.js";

let tasks = [];
let templates = [];
let employees = [];
let currentTaskId = null;
let knownDate = localDateKey(new Date());
let listenersStarted = false;
let generating = false;
let toastTimer = 0;

const VIEW_KEY = "zeiklijst-view";
const FILTER_KEY = "zeiklijst-filter";
const FILTERS = new Set(["all", "mine", "allen", "unassigned", "pending"]);

const TITLE_MAX = 120;
const LOCATION_MAX = 120;
const DESCRIPTION_MAX = 2000;
const REPORT_DESC_MAX = 1000;
const PHOTO_MAX_CHARS = 700000;
const DEVICE_MAX_CHARS = 300;

// Field names for staff-created tasks and reports. Must match ZLA's rules exactly.
const STAFF_TASK = {
  title: "title",
  description: "description",
  location: "location",
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
  return (typeof self !== "undefined" && self.APP_CACHE_NAME) || "zeiklijst-v18";
}

function isStaffCreated(task) {
  return Boolean(task && task.createdByRole === "staff");
}

function officialStaffName() {
  const staff = getCurrentStaff();
  if (!staff) return "";
  const mine = employees.find((e) => e.id === staff.employeeId);
  return (mine && mine.name) || staff.name || "";
}

function isRecurring(task) {
  return Boolean(task.recurringId);
}

function currentFilter() {
  const value = localStorage.getItem(FILTER_KEY) || "mine";
  return FILTERS.has(value) ? value : "mine";
}

function setFilter(value) {
  const next = FILTERS.has(value) ? value : "mine";
  localStorage.setItem(FILTER_KEY, next);
  renderTasks();
}

function isAllen(task) {
  return task.assigneeId === "ALLEN" || (task.assigneeName || "").trim().toLowerCase() === "allen";
}

function isUnassigned(task) {
  return !isAllen(task) && !(task.assigneeName || "").trim();
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
  if (filter === "unassigned") return isUnassigned(task);
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
  logoutStaff(message || "Je hebt geen toegang meer. Log opnieuw in of neem contact op met je leidinggevende.");
}

function startListeners() {
  if (listenersStarted) return;
  listenersStarted = true;
  accessLostHandled = false;
  unsubscribers.push(listenCollection("tasks", normalizeTask, (list) => {
    tasks = list;
    renderTasks();
    if (currentTaskId) openTask(currentTaskId);
  }, onListenerError));
  unsubscribers.push(listenCollection("recurring", normalizeTemplate, async (list) => {
    templates = list;
    await maybeGenerate();
    renderTasks();
  }, onListenerError));
  unsubscribers.push(listenCollection("employees", normalizeEmployee, (list) => {
    employees = list.filter((e) => e.active).sort((a, b) => a.name.localeCompare(b.name, "nl"));
    const staff = getCurrentStaff();
    if (staff) {
      const mine = employees.find((e) => e.id === staff.employeeId) || list.find((e) => e.id === staff.employeeId);
      if (mine && mine.name) setStaffDisplayName(mine.name);
      if (mine && mine.active === false) {
        onListenerError(
          { code: "permission-denied" },
          "Je account is niet actief. Neem contact op met je leidinggevende."
        );
        return;
      }
    }
    if (currentTaskId) openTask(currentTaskId);
  }, onListenerError));
}

function stopListeners() {
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
  employees = [];
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
  const today = localDateKey(new Date());
  if (today !== knownDate) {
    knownDate = today;
    maybeGenerate();
  }
}

function fillTickName() {
  const el = document.getElementById("tick-by-name");
  const staff = getCurrentStaff();
  if (el) el.textContent = staff && staff.name ? staff.name : "";
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
  const visible = tasks.filter((task) => task.status !== "afgerond" && matchesFilter(task, filter));
  const openTasks = visible
    .filter((task) => task.status === "open")
    .sort((a, b) => createdStamp(a).localeCompare(createdStamp(b)));
  const pendingTasks = visible
    .filter((task) => task.status === "pending")
    .sort((a, b) => pendingStamp(a).localeCompare(pendingStamp(b)));

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
    boardEmpty.textContent = tasks.some((task) => task.status !== "afgerond")
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
  const location = (task.location || "").trim();
  const assignee = assigneeLabel(task);
  const unassigned = assignee === "Niet toegewezen";
  const age = formatRelativeAge(task.createdAt);

  const item = el("div", "task-item");
  if (KNOWN_STATUSES.has(task.status)) item.classList.add(task.status);
  item.setAttribute("role", "button");
  item.tabIndex = 0;
  item.dataset.taskId = String(task.id);

  const main = el("div", "task-item-main");
  const textCol = el("div");
  textCol.append(
    el("div", "task-title", task.title || ""),
    el("div", "task-location" + (location ? "" : " hidden"), location),
    el("div", "task-age" + (age ? "" : " hidden"), age)
  );
  main.append(textCol);
  const badges = badgeElements(task);
  if (badges.length) {
    const row = el("div", "badge-row");
    row.append(...badges);
    main.append(row);
  }
  item.append(main, el("div", "task-assignee" + (unassigned ? " is-muted" : ""), assignee));
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
  const location = (task.location || "").trim();
  const locEl = document.getElementById("modal-location");
  locEl.textContent = location;
  locEl.hidden = !location;
  document.getElementById("modal-assignee").textContent = "Toegewezen aan: " + assigneeLabel(task);
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
  if (task.pendingAt) {
    const by = task.pendingBy ? ` door ${task.pendingBy}` : "";
    extra.push(`Afgevinkt op ${formatDateTime(task.pendingAt)}${by}`);
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

  const tickRow = document.getElementById("tick-by-row");
  tickRow.classList.toggle("hidden", task.status !== "open");
  if (task.status === "open") fillTickName();

  const actions = document.getElementById("modal-actions");
  actions.replaceChildren();
  if (task.status === "open") {
    const btn = el("button", "success", "Markeer als gedaan");
    btn.type = "button";
    btn.id = "tick-btn";
    btn.onclick = () => markPending(task.id);
    actions.append(btn);
  } else if (task.status === "pending") {
    const btn = el("button", "secondary", "Ongedaan maken");
    btn.type = "button";
    btn.id = "untick-btn";
    btn.onclick = () => unmarkPending(task.id);
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

async function markPending(id) {
  const task = tasks.find((item) => item.id === id);
  if (!task || task.status !== "open") return;
  const staff = getCurrentStaff();
  const pendingBy = staff && staff.name ? staff.name : "";
  if (!pendingBy) {
    showToast("Je bent niet ingelogd.", "error");
    return;
  }
  try {
    await updateDoc(doc(db, "tasks", id), {
      status: "pending",
      pendingAt: new Date().toISOString(),
      pendingBy
    });
    closeModal();
    showToast("Taak is ter controle gezet.", "success");
  } catch (err) {
    showToast(writeErrorMessage(err), "error");
  }
}

async function unmarkPending(id) {
  const task = tasks.find((item) => item.id === id);
  if (!task || task.status !== "pending") return;
  try {
    await updateDoc(doc(db, "tasks", id), {
      status: "open",
      pendingAt: null,
      pendingBy: null
    });
    closeModal();
    showToast("Afvinken ongedaan gemaakt.", "success");
  } catch (err) {
    showToast(writeErrorMessage(err), "error");
  }
}


function screenshotForm() {
  const params = new URLSearchParams(location.search);
  if (params.get("showAddTask") === "1") return "add";
  if (params.get("showReport") === "1") return "report";
  return "";
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

async function compressPhoto(file, maxChars = PHOTO_MAX_CHARS) {
  let edge = 1000;
  let quality = 0.6;
  let dataUrl = "";
  for (let i = 0; i < 7; i++) {
    dataUrl = await compressImage(file, edge, quality);
    if (dataUrl && !isSafeImageDataUrl(dataUrl)) throw new Error("Kies een geldige foto.");
    if (!dataUrl || dataUrl.length <= maxChars) return dataUrl;
    edge = Math.max(280, Math.round(edge * 0.7));
    quality = Math.max(0.32, quality - 0.08);
  }
  if (!dataUrl || dataUrl.length > maxChars) {
    throw new Error("De foto is te groot. Kies een kleinere foto.");
  }
  return dataUrl;
}

function bindPhotoPreview(input, preview) {
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
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
      input.value = "";
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

function openAddTaskPage() {
  const staff = getCurrentStaff();
  if (!staff) {
    showToast("Je bent niet ingelogd.", "error");
    return;
  }
  closePage("report-page");
  const form = document.getElementById("staff-add-task-form");
  if (form) form.reset();
  const preview = document.getElementById("add-task-photo-preview");
  if (preview) {
    preview.replaceChildren();
    preview.classList.add("hidden");
  }
  setFormError("add-task-error", "");
  const assignee = document.getElementById("add-task-assignee");
  if (assignee) assignee.textContent = officialStaffName();
  const page = document.getElementById("add-task-page");
  if (page) page.classList.remove("hidden");
  const title = document.getElementById("add-task-title-input");
  if (title) {
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

function openScreenshotForm() {
  const which = screenshotForm();
  if (which === "add") openAddTaskPage();
  if (which === "report") openReportPage();
}

function writeFormError(err, permissionText, fallback) {
  if (isPermissionDenied(err)) return permissionText;
  if (/te groot|geldige foto/i.test(String((err && err.message) || err || ""))) {
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
  form.querySelectorAll("button, input, textarea").forEach((el) => {
    el.disabled = Boolean(busy);
  });
}

async function onAddTaskSubmit(event) {
  event.preventDefault();
  const staff = getCurrentStaff();
  if (!staff) {
    setFormError("add-task-error", "Je bent niet ingelogd.");
    return;
  }
  const title = document.getElementById("add-task-title-input").value.trim();
  const location = document.getElementById("add-task-location-input").value.trim();
  const description = document.getElementById("add-task-description-input").value.trim();
  if (!title) {
    setFormError("add-task-error", "Vul een titel in.");
    return;
  }
  if (title.length > TITLE_MAX) {
    setFormError("add-task-error", `De titel mag maximaal ${TITLE_MAX} tekens zijn.`);
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
  const form = document.getElementById("staff-add-task-form");
  const fileInput = document.getElementById("add-task-photo");
  const file = fileInput && fileInput.files && fileInput.files[0];
  setFormBusy(form, true);
  setFormError("add-task-error", "");
  try {
    const photos = [];
    if (file) {
      if (file.type && !file.type.startsWith("image/")) {
        throw new Error("Kies een geldige foto.");
      }
      const dataUrl = await compressPhoto(file);
      if (dataUrl) photos.push(dataUrl);
    }
    const name = officialStaffName();
    const F = STAFF_TASK;
    // dueDate is admin-only: never set it on staff creates, and never show it in this app.
    const payload = {
      [F.title]: title,
      [F.description]: description,
      [F.location]: location,
      [F.assigneeId]: staff.employeeId,
      [F.assigneeName]: name,
      [F.status]: "open",
      [F.createdAt]: new Date().toISOString(),
      [F.photos]: photos,
      [F.createdByRole]: "staff",
      [F.createdByEmployeeId]: staff.employeeId,
      [F.createdByName]: name,
      [F.adminReview]: "nieuw"
    };
    delete payload.dueDate;
    await addDoc(collection(db, "tasks"), payload);
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
  const form = document.getElementById("report-form");
  const fileInput = document.getElementById("report-photo");
  const file = fileInput && fileInput.files && fileInput.files[0];
  setFormBusy(form, true);
  setFormError("report-error", "");
  try {
    const F = REPORT;
    const payload = {
      [F.description]: description,
      [F.employeeId]: staff.employeeId,
      [F.employeeName]: officialStaffName(),
      [F.createdAt]: serverTimestamp(),
      [F.appVersion]: appVersion(),
      [F.device]: deviceInfo(),
      [F.status]: "nieuw"
    };
    if (file) {
      if (file.type && !file.type.startsWith("image/")) {
        throw new Error("Kies een geldige foto.");
      }
      const dataUrl = await compressPhoto(file);
      if (dataUrl) payload[F.photo] = dataUrl;
    }
    await addDoc(collection(db, "reports"), payload);
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
    if (add && !add.classList.contains("hidden")) closePage("add-task-page");
  });
}

function setupUpdateBanner() {
  const banner = document.getElementById("update-banner");
  if (!banner) return;
  let reloading = false;
  const params = new URLSearchParams(location.search);
  const forced = params.get("showUpdate") === "1";

  const show = () => banner.classList.remove("hidden");
  let waitingWorker = null;

  const attachWaiting = (worker) => {
    if (!worker) return;
    waitingWorker = worker;
    show();
  };

  banner.addEventListener("click", () => {
    if (waitingWorker) {
      waitingWorker.postMessage({ type: "SKIP_WAITING" });
      return;
    }
    if (forced) location.reload();
  });

  if (forced) show();

  if (!("serviceWorker" in navigator)) return;

  // Only reload when an existing worker is replaced (not on the very first install).
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });

  navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).then((reg) => {
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) reg.update().catch(() => {});
    });
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
initStaffAuth({
  showToast,
  onLoggedIn() {
    startListeners();
  },
  onLoggedOut() {
    closeModal();
    closeStaffPages();
    stopListeners();
    renderTasks();
  }
});
openScreenshotForm();
