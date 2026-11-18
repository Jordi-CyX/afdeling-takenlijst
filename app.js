import {
  auth,
  onAuthStateChanged,
  signInAnonymously
} from "./firebase-init.js";
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
  localDateKey
} from "./shared.js";

let tasks = [];
let templates = [];
let employees = [];
let currentTaskId = null;
let knownDate = localDateKey(new Date());
let listenersStarted = false;
let generating = false;

function isRecurring(task) {
  return Boolean(task.recurringId);
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
    tasks = list;
    renderTasks();
    if (currentTaskId) openTask(currentTaskId);
  });
  listenCollection("recurring", normalizeTemplate, async (list) => {
    templates = list;
    await maybeGenerate();
    renderTasks();
  });
  listenCollection("employees", normalizeEmployee, (list) => {
    employees = list.filter((e) => e.active).sort((a, b) => a.name.localeCompare(b.name, "nl"));
    if (currentTaskId) openTask(currentTaskId);
  });
}

const VIEW_KEY = "zeiklijst-view";

function currentView() {
  return localStorage.getItem(VIEW_KEY) === "tiles" ? "tiles" : "list";
}

function applyView(view) {
  const mode = view === "tiles" ? "tiles" : "list";
  localStorage.setItem(VIEW_KEY, mode);
  const list = document.getElementById("task-list");
  list.classList.toggle("view-tiles", mode === "tiles");
  list.classList.toggle("view-list", mode === "list");
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
  applyView(currentView());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) checkDateChange();
  });
  setInterval(checkDateChange, 60000);
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

function checkDateChange() {
  const today = localDateKey(new Date());
  if (today !== knownDate) {
    knownDate = today;
    maybeGenerate();
  }
}

function fillTickSelect() {
  const select = document.getElementById("tick-by-select");
  const current = select.value;
  select.innerHTML = `<option value="">— Geen naam —</option>` + employees.map((e) =>
    `<option value="${escapeAttr(e.name)}">${escapeHtml(e.name)}</option>`
  ).join("");
  if ([...select.options].some((o) => o.value === current)) select.value = current;
}

function renderTasks() {
  const list = document.getElementById("task-list");
  const active = tasks
    .filter((task) => task.status !== "afgerond")
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  if (!active.length) {
    list.innerHTML = '<p class="empty-state">Geen openstaande taken.</p>';
    return;
  }
  list.innerHTML = active.map(taskItemHtml).join("");
  applyView(currentView());
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

function taskItemHtml(task) {
  const location = (task.location || "").trim();
  const pendingMark = task.status === "pending"
    ? '<div class="badge-row"><span class="badge pending">Pending</span></div>'
    : "";
  return `
    <div class="task-item ${task.status}" role="button" tabindex="0" data-task-id="${escapeAttr(task.id)}">
      <div>
        <div class="task-title">${escapeHtml(task.title)}</div>
        <div class="task-location${location ? "" : " hidden"}">${escapeHtml(location)}</div>
      </div>
      ${pendingMark}
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
  if (task.status === "pending") statusBadges.push('<span class="badge pending">Pending</span>');
  if (isRecurring(task)) statusBadges.push('<span class="badge recurring">Herhalend</span>');
  document.getElementById("modal-status").innerHTML = statusBadges.join("");
  const extra = [];
  if (task.createdAt) extra.push(`Aangemaakt op ${escapeHtml(formatDateTime(task.createdAt))}`);
  if (task.pendingAt) {
    const by = task.pendingBy ? ` door ${escapeHtml(task.pendingBy)}` : "";
    extra.push(`Afgevinkt op ${escapeHtml(formatDateTime(task.pendingAt))}${by}`);
  }
  const desc = `<p>${escapeHtml(task.description || "").replace(/\n/g, "<br>")}</p>`
    + (extra.length ? `<div class="task-meta">${extra.join("<br>")}</div>` : "");
  document.getElementById("modal-description").innerHTML = desc;
  const photos = (task.photos || []).filter((src) => typeof src === "string" && src.startsWith("data:image"));
  document.getElementById("modal-photos").innerHTML = photos.map((src) => `<img src="${src}" alt="Foto bij taak">`).join("");

  const tickRow = document.getElementById("tick-by-row");
  tickRow.classList.toggle("hidden", task.status !== "open");
  if (task.status === "open") fillTickSelect();

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

async function markPending(id) {
  const task = tasks.find((item) => item.id === id);
  if (!task || task.status !== "open") return;
  const pendingBy = document.getElementById("tick-by-select").value.trim() || null;
  await updateDoc(doc(db, "tasks", id), {
    status: "pending",
    pendingAt: new Date().toISOString(),
    pendingBy
  });
}

async function unmarkPending(id) {
  const task = tasks.find((item) => item.id === id);
  if (!task || task.status !== "pending") return;
  await updateDoc(doc(db, "tasks", id), {
    status: "open",
    pendingAt: null,
    pendingBy: null
  });
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    try {
      await signInAnonymously(auth);
    } catch {
      document.getElementById("task-list").innerHTML = '<p class="empty-state">Kon niet verbinden. Controleer je internetverbinding.</p>';
    }
    return;
  }
  startListeners();
});

setupUi();
