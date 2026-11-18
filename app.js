import {
  db,
  doc,
  updateDoc,
  listenCollection,
  generateDueInstances,
  normalizeTask,
  normalizeTemplate,
  normalizeEmployee,
  escapeHtml,
  escapeAttr,
  formatDateTime,
  assigneeLabel,
  localDateKey,
  normalizeName
} from "./shared.js";
import {
  getCurrentStaff,
  initStaffAuth,
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

function startListeners() {
  if (listenersStarted) return;
  listenersStarted = true;
  unsubscribers.push(listenCollection("tasks", normalizeTask, (list) => {
    tasks = list;
    renderTasks();
    if (currentTaskId) openTask(currentTaskId);
  }));
  unsubscribers.push(listenCollection("recurring", normalizeTemplate, async (list) => {
    templates = list;
    await maybeGenerate();
    renderTasks();
  }));
  unsubscribers.push(listenCollection("employees", normalizeEmployee, (list) => {
    employees = list.filter((e) => e.active).sort((a, b) => a.name.localeCompare(b.name, "nl"));
    const staff = getCurrentStaff();
    if (staff) {
      const mine = employees.find((e) => e.id === staff.employeeId) || list.find((e) => e.id === staff.employeeId);
      if (mine && mine.name) setStaffDisplayName(mine.name);
    }
    if (currentTaskId) openTask(currentTaskId);
  }));
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
    openList.innerHTML = openTasks.map(taskItemHtml).join("");
    bindList(openList);
  } else {
    openList.innerHTML = "";
  }

  if (showPending) {
    pendingList.innerHTML = pendingTasks.map(taskItemHtml).join("");
    bindList(pendingList);
  } else if (forcePending) {
    pendingList.innerHTML = '<p class="empty-state">Geen taken ter controle.</p>';
  } else {
    pendingList.innerHTML = "";
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

function taskItemHtml(task) {
  const location = (task.location || "").trim();
  const assignee = assigneeLabel(task);
  const unassigned = assignee === "Niet toegewezen";
  const age = formatRelativeAge(task.createdAt);
  const badges = [];
  if (task.status === "open" && wasRejected(task)) {
    badges.push('<span class="badge rejected">Afgewezen</span>');
  }
  if (task.status === "pending") {
    badges.push('<span class="badge pending">Ter controle</span>');
  }
  if (isRecurring(task)) {
    badges.push('<span class="badge recurring">Herhalend</span>');
  }
  const badgeRow = badges.length ? `<div class="badge-row">${badges.join("")}</div>` : "";
  return `
    <div class="task-item ${task.status}" role="button" tabindex="0" data-task-id="${escapeAttr(task.id)}">
      <div class="task-item-main">
        <div>
          <div class="task-title">${escapeHtml(task.title)}</div>
          <div class="task-location${location ? "" : " hidden"}">${escapeHtml(location)}</div>
          <div class="task-age${age ? "" : " hidden"}">${escapeHtml(age)}</div>
        </div>
        ${badgeRow}
      </div>
      <div class="task-assignee${unassigned ? " is-muted" : ""}">${escapeHtml(assignee)}</div>
    </div>
  `;
}

function openTask(id) {
  const task = tasks.find((item) => item.id === id);
  if (!task) return;
  currentTaskId = id;
  document.getElementById("modal-title").textContent = task.title;
  const location = (task.location || "").trim();
  const locEl = document.getElementById("modal-location");
  locEl.textContent = location;
  locEl.hidden = !location;
  document.getElementById("modal-assignee").textContent = "Toegewezen aan: " + assigneeLabel(task);
  const statusBadges = [];
  if (task.status === "open" && wasRejected(task)) {
    statusBadges.push('<span class="badge rejected">Afgewezen</span>');
  }
  if (task.status === "pending") statusBadges.push('<span class="badge pending">Ter controle</span>');
  if (isRecurring(task)) statusBadges.push('<span class="badge recurring">Herhalend</span>');
  document.getElementById("modal-status").innerHTML = statusBadges.join("");

  const rejectionEl = document.getElementById("modal-rejection");
  if (wasRejected(task) && task.status === "open") {
    const when = rejectionAt(task);
    const by = rejectionBy(task);
    const reason = rejectionReason(task);
    const parts = ["<p>Deze taak staat weer open.</p>"];
    if (when) {
      parts.push(`<p>Afgewezen op ${escapeHtml(formatDateTime(when))}${by ? ` door ${escapeHtml(by)}` : ""}.</p>`);
    }
    if (reason) parts.push(`<p>Reden: ${escapeHtml(reason)}</p>`);
    rejectionEl.innerHTML = parts.join("");
    rejectionEl.classList.remove("hidden");
  } else {
    rejectionEl.innerHTML = "";
    rejectionEl.classList.add("hidden");
  }

  const extra = [];
  if (task.createdAt) {
    const age = formatRelativeAge(task.createdAt);
    extra.push(`Aangemaakt op ${escapeHtml(formatDateTime(task.createdAt))}${age ? ` (${escapeHtml(age)})` : ""}`);
  }
  if (task.pendingAt) {
    const by = task.pendingBy ? ` door ${escapeHtml(task.pendingBy)}` : "";
    extra.push(`Afgevinkt op ${escapeHtml(formatDateTime(task.pendingAt))}${by}`);
  }
  const desc = `<p>${escapeHtml(task.description || "").replace(/\n/g, "<br>")}</p>`
    + (extra.length ? `<div class="task-meta">${extra.join("<br>")}</div>` : "");
  document.getElementById("modal-description").innerHTML = desc;
  const photos = (task.photos || []).filter((src) => typeof src === "string" && src.startsWith("data:image"));
  document.getElementById("modal-photos").innerHTML = photos.map((src) =>
    `<img src="${src}" alt="Foto bij taak" tabindex="0">`
  ).join("");

  const tickRow = document.getElementById("tick-by-row");
  tickRow.classList.toggle("hidden", task.status !== "open");
  if (task.status === "open") fillTickName();

  const actions = document.getElementById("modal-actions");
  actions.innerHTML = "";
  if (task.status === "open") {
    actions.innerHTML = `<button type="button" class="success" id="tick-btn">Markeer als gedaan</button>`;
    document.getElementById("tick-btn").onclick = () => markPending(task.id);
  } else if (task.status === "pending") {
    actions.innerHTML = `<button type="button" class="secondary" id="untick-btn">Ongedaan maken</button>`;
    document.getElementById("untick-btn").onclick = () => unmarkPending(task.id);
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

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });

  navigator.serviceWorker.register("./sw.js").then((reg) => {
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
    stopListeners();
    renderTasks();
  }
});
