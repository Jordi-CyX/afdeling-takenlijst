import {
  auth,
  ADMIN_UID,
  ADMIN_EMAIL,
  onAuthStateChanged,
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut
} from "../firebase-init.js";
import { increment, arrayUnion } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";
import {
  db,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  writeBatch,
  listenCollection,
  generateDueInstances,
  normalizeTask,
  normalizeTemplate,
  normalizeEmployee,
  serializeTask,
  serializeTemplate,
  readCompressedPhotos,
  assertDocSize,
  escapeHtml,
  escapeAttr,
  formatDate,
  formatDateTime,
  assigneeLabel,
  localDateKey,
  WEEKDAYS,
  SEED_EMPLOYEES,
  employeeSlug,
  STORAGE_TASKS,
  STORAGE_TEMPLATES,
  STORAGE_MIGRATED,
  safeParse
} from "../shared.js";

let isAdmin = false;
let tasks = [];
let templates = [];
let employees = [];
let currentTaskId = null;
let editingTemplateId = null;
let editingTaskId = null;
let knownDate = localDateKey(new Date());
let listenersStarted = false;
let generating = false;
let seededOnce = false;

const SECTION_KEY = "zeiklijst-admin-section";
const SECTIONS = ["dashboard", "medewerkers", "taken", "controle", "workflow", "data"];
const SECTION_LABELS = {
  dashboard: "Dashboard",
  medewerkers: "Medewerkers",
  taken: "Taken",
  controle: "Controle",
  workflow: "Workflow",
  data: "Data"
};
let currentSection = "dashboard";
let taskFilters = { q: "", status: "all", employee: "all", location: "all", recurring: "all" };
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

function showToast(message, type = "error") {
  const el = document.getElementById("app-toast");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("error", type === "error");
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 4500);
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
    tasks = list;
    renderAll();
    if (currentTaskId) openTask(currentTaskId);
  });
  listenCollection("recurring", normalizeTemplate, async (list) => {
    templates = list;
    await maybeGenerate();
    renderAll();
  });
  listenCollection("employees", normalizeEmployee, (list) => {
    employees = list.sort((a, b) => a.name.localeCompare(b.name, "nl"));
    renderAll();
    if (currentTaskId) openTask(currentTaskId);
    if (isAdmin && !seededOnce && employees.length === 0) {
      seededOnce = true;
      seedEmployees().catch(() => {});
    }
  });
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
    if (!document.getElementById("modal").classList.contains("hidden")) {
      closeModal();
      return;
    }
    closeNav();
  });
  document.getElementById("stat-open-card").onclick = () => showSection("taken", true, { filters: { status: "open" } });
  document.getElementById("stat-pending-card").onclick = () => showSection("controle");
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
  document.getElementById("cleanup-btn").onclick = cleanupOldCompleted;
  document.getElementById("workflow-period").onchange = renderWorkflow;
  document.getElementById("export-btn").onclick = exportData;
  document.getElementById("import-btn").onclick = () => document.getElementById("import-file").click();
  document.getElementById("import-file").onchange = importData;
  document.getElementById("migrate-btn").onclick = migrateLocalToFirebase;
  document.getElementById("migrate-dismiss").onclick = () => {
    localStorage.setItem(STORAGE_MIGRATED, "1");
    document.getElementById("migration-banner").classList.add("hidden");
  };
  document.getElementById("add-task-form").onsubmit = submitTaskForm;
  document.getElementById("task-cancel-edit").onclick = resetTaskForm;
  document.getElementById("is-recurring").onchange = updateRecurrenceVisibility;
  document.getElementById("recurrence-type").onchange = updateRecurrenceVisibility;
  document.getElementById("modal-close").onclick = closeModal;
  document.getElementById("modal").onclick = (event) => {
    if (event.target.id === "modal") closeModal();
  };
  document.getElementById("reassign-btn").onclick = reassignCurrentTask;
  document.getElementById("add-employee-form").onsubmit = addEmployee;
  document.getElementById("seed-employees-btn").onclick = () => seedEmployees();
  buildWeekdayPicker();
  document.getElementById("recurrence-start").value = localDateKey(new Date());
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
}

async function submitLogin(event) {
  event.preventDefault();
  const email = document.getElementById("login-email").value.trim() || ADMIN_EMAIL;
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

function fillAssigneeSelects() {
  const options = [
    `<option value="">Niet toegewezen</option>`,
    `<option value="ALLEN">Allen</option>`,
    ...activeEmployees().map((e) => `<option value="${escapeAttr(e.id)}">${escapeHtml(e.name)}</option>`)
  ].join("");
  const formSelect = document.getElementById("assignee-select");
  const current = formSelect.value;
  formSelect.innerHTML = options;
  if ([...formSelect.options].some((o) => o.value === current)) formSelect.value = current;
  const reassign = document.getElementById("reassign-select");
  if (reassign) {
    const rec = reassign.value;
    reassign.innerHTML = options;
    if ([...reassign.options].some((o) => o.value === rec)) reassign.value = rec;
  }
}

function assigneeFromSelect(select) {
  const id = select.value;
  if (id === "ALLEN") return { assigneeId: "ALLEN", assigneeName: "Allen" };
  if (!id) return { assigneeId: "", assigneeName: "" };
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
  const startDate = document.getElementById("recurrence-start").value || localDateKey(new Date());
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
  const location = document.getElementById("location").value.trim();
  if (!title) {
    showToast("Vul een titel in.");
    document.getElementById("title").focus();
    return;
  }
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
        location,
        ...assignee,
        photos: nextPhotos
      };
      assertDocSize({ ...serializeTask({ ...task, ...payload }), ...payload });
      const ok = await safeWrite(() => updateDoc(doc(db, "tasks", editingTaskId), payload));
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
      ...assignee,
      photos,
      status: "open",
      createdAt: new Date().toISOString()
    });
    assertDocSize(payload);
    const ok = await safeWrite(() => addDoc(collection(db, "tasks"), payload));
    if (ok) resetTaskForm();
  } catch (err) {
    showToast(err.message || "Opslaan mislukt.");
  }
}

function resetTaskForm() {
  editingTemplateId = null;
  editingTaskId = null;
  document.getElementById("add-task-form").reset();
  document.getElementById("recurrence-start").value = localDateKey(new Date());
  setSelectedWeekdays([]);
  document.getElementById("task-form-heading").textContent = "Nieuwe taak";
  document.getElementById("task-submit-btn").textContent = "Taak toevoegen";
  document.getElementById("task-cancel-edit").classList.add("hidden");
  document.getElementById("is-recurring").disabled = false;
  document.getElementById("photo-note").classList.add("hidden");
  updateRecurrenceVisibility();
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
  document.getElementById("location").value = task.location || "";
  document.getElementById("description").value = task.description || "";
  document.getElementById("assignee-select").value = task.assigneeId || "";
  document.getElementById("is-recurring").checked = false;
  document.getElementById("is-recurring").disabled = true;
  document.getElementById("photos").value = "";
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
  document.getElementById("location").value = template.location || "";
  document.getElementById("description").value = template.description || "";
  document.getElementById("assignee-select").value = template.assigneeId || "";
  document.getElementById("is-recurring").checked = true;
  document.getElementById("is-recurring").disabled = true;
  const recurrence = template.recurrence || {};
  document.getElementById("recurrence-type").value = recurrence.type || "daily";
  document.getElementById("recurrence-start").value = recurrence.startDate || localDateKey(new Date());
  document.getElementById("recurrence-date").value = recurrence.date || "";
  document.getElementById("recurrence-monthly").checked = Boolean(recurrence.monthly);
  setSelectedWeekdays(recurrence.weekdays || []);
  editingTaskId = null;
  document.getElementById("photos").value = "";
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
    if (btn.dataset.section === section) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  });
  closeNav();
  if (section === "taken" && options.filters) renderTasks();
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
}

function renderAll() {
  fillAssigneeSelects();
  fillTaskFilters();
  renderDashboard();
  renderTasks();
  renderCompleted();
  renderTemplates();
  renderEmployees();
  renderControle();
  renderWorkflow();
  updateNavBadge();
}

function currentWorkloadGroups() {
  const groups = new Map();
  const ensure = (key, label) => {
    if (!groups.has(key)) groups.set(key, { key, label, open: 0, pending: 0 });
    return groups.get(key);
  };
  ensure("ALLEN", "Allen");
  ensure("UNASSIGNED", "Niet toegewezen");
  for (const emp of employees.filter((e) => e.active)) {
    ensure(emp.id || emp.name, emp.name || emp.id);
  }
  for (const task of tasks) {
    if (task.status !== "open" && task.status !== "pending") continue;
    let group;
    if (task.assigneeId === "ALLEN" || task.assigneeName === "Allen") group = ensure("ALLEN", "Allen");
    else if (!(task.assigneeName || "").trim() && !task.assigneeId) group = ensure("UNASSIGNED", "Niet toegewezen");
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
    if (a.key === "UNASSIGNED") return 1;
    if (b.key === "UNASSIGNED") return -1;
    return a.label.localeCompare(b.label, "nl");
  });
}

function renderDashboard() {
  document.getElementById("stat-open").textContent = tasks.filter((t) => t.status === "open").length;
  document.getElementById("stat-pending").textContent = tasks.filter((t) => t.status === "pending").length;
  document.getElementById("stat-done").textContent = tasks.filter((t) => t.status === "afgerond").length;
  const workload = document.getElementById("dashboard-workload");
  const rows = currentWorkloadGroups();
  if (!rows.length) {
    workload.innerHTML = '<p class="empty-state">Nog geen taken om te verdelen.</p>';
  } else {
    workload.innerHTML = rows.map((g) => `
      <button type="button" class="workload-row" data-workload="${escapeAttr(g.key)}">
        <span>${escapeHtml(g.label)}</span>
        <span class="counts">${g.open} open · ${g.pending} pending</span>
      </button>
    `).join("");
    workload.querySelectorAll("[data-workload]").forEach((btn) => {
      btn.onclick = () => showSection("taken", true, { filters: { status: "all", employee: btn.dataset.workload } });
    });
  }
  const pendingBox = document.getElementById("dashboard-pending");
  const latest = tasks
    .filter((task) => task.status === "pending")
    .sort((a, b) => String(b.pendingAt || b.createdAt || "").localeCompare(String(a.pendingAt || a.createdAt || "")))
    .slice(0, 5);
  if (!latest.length) {
    pendingBox.innerHTML = '<p class="empty-state">Geen pending taken.</p>';
    return;
  }
  pendingBox.innerHTML = latest.map(taskItemHtml).join("");
  bindTaskItems(pendingBox);
}

function workflowGroup(task) {
  if (task.assigneeId === "ALLEN" || task.assigneeName === "Allen") {
    return { key: "ALLEN", label: "Allen" };
  }
  const name = (task.assigneeName || "").trim();
  if (!name && !task.assigneeId) return { key: "UNASSIGNED", label: "Niet toegewezen" };
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
  ensure("UNASSIGNED", "Niet toegewezen");
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
    const ticker = (task.pendingBy || "").trim();
    if (ticker) {
      const entry = ensureTicker(ticker);
      if (task.status === "pending") entry.pending += 1;
      if (task.status === "afgerond" && inPeriod(task.completedAt, start)) entry.completed += 1;
    }
  }
  const items = [...groups.values()].sort((a, b) => {
    if (a.key === "ALLEN") return -1;
    if (b.key === "ALLEN") return 1;
    if (a.key === "UNASSIGNED") return 1;
    if (b.key === "UNASSIGNED") return -1;
    return a.label.localeCompare(b.label, "nl");
  });
  if (!items.length) {
    list.innerHTML = '<p class="empty-state">Nog geen workflowgegevens.</p>';
    return;
  }
  const tickerItems = [...tickers.values()].sort((a, b) => a.name.localeCompare(b.name, "nl"));
  list.innerHTML = items.map((g) => `
    <article class="workflow-card">
      <h3>${escapeHtml(g.label)}</h3>
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
    </article>
  `).join("") + (tickerItems.length ? `
    <h3 class="workflow-tickers">Afgevinkt door</h3>
    ${tickerItems.map((g) => `
      <article class="workflow-card">
        <h3>${escapeHtml(g.name)}</h3>
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
      </article>
    `).join("")}
  ` : "");
}

function renderControle() {
  const list = document.getElementById("controle-list");
  if (!list) return;
  const pending = tasks
    .filter((task) => task.status === "pending")
    .sort((a, b) => String(b.pendingAt || b.createdAt || "").localeCompare(String(a.pendingAt || a.createdAt || "")));
  if (!pending.length) {
    list.innerHTML = '<p class="empty-state">Geen pending taken. Alles is bij.</p>';
    return;
  }
  list.innerHTML = pending.map((task) => `
    <div class="controle-item">
      ${taskItemHtml(task)}
      <div class="controle-actions">
        <button type="button" class="success" data-approve="${escapeAttr(task.id)}">Goedkeuren</button>
        <button type="button" class="secondary" data-reject="${escapeAttr(task.id)}">Afwijzen</button>
      </div>
    </div>
  `).join("");
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
  const location = (item && item.location || "").trim();
  if (!location) return "";
  return `<div class="task-location">${escapeHtml(location)}</div>`;
}

function assigneeBanner(task) {
  const name = (task.assigneeName || "").trim();
  const isAllen = task.assigneeId === "ALLEN" || name.toLowerCase() === "allen";
  const unassigned = !isAllen && !name;
  const label = unassigned ? "Niet toegewezen" : (isAllen ? "Allen" : name);
  const cls = unassigned ? " task-assignee--muted" : "";
  return `<div class="task-assignee${cls}">${escapeHtml(label)}</div>`;
}

function taskItemHtml(task) {
  const badges = [
    `<span class="badge ${task.status}">${task.status === "open" ? "Open" : task.status === "pending" ? "Pending" : "Afgerond"}</span>`
  ];
  if (isRecurring(task)) badges.unshift('<span class="badge recurring">Herhalend</span>');
  return `
    <div class="task-item ${task.status}" role="button" tabindex="0" data-task-id="${escapeAttr(task.id)}">
      <div class="task-item-main">
        <div>
          <div class="task-title">${escapeHtml(task.title)}</div>
          ${locationLabel(task)}
        </div>
        <div class="badge-row">${badges.join("")}</div>
      </div>
      ${assigneeBanner(task)}
    </div>
  `;
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
  if (!includeCompleted && status !== "all" && task.status !== status) return false;
  const q = (taskFilters.q || "").trim().toLowerCase();
  if (q) {
    const hay = `${task.title || ""} ${task.location || ""} ${task.description || ""} ${task.assigneeName || ""}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  const employee = taskFilters.employee || "all";
  if (employee !== "all") {
    if (employee === "ALLEN") {
      if (!(task.assigneeId === "ALLEN" || task.assigneeName === "Allen")) return false;
    } else if (employee === "UNASSIGNED" || employee === "") {
      const unassigned = !(task.assigneeName || "").trim() && !task.assigneeId;
      if (!unassigned) return false;
    } else if (task.assigneeId !== employee && (task.assigneeName || "") !== employee) {
      return false;
    }
  }
  const location = taskFilters.location || "all";
  if (location !== "all") {
    const loc = (task.location || "").trim();
    if (location === "__none__") {
      if (loc) return false;
    } else if (loc !== location) return false;
  }
  const recurring = taskFilters.recurring || "all";
  if (recurring === "yes" && !isRecurring(task)) return false;
  if (recurring === "no" && isRecurring(task)) return false;
  return true;
}

function fillTaskFilters() {
  const empSelect = document.getElementById("filter-employee");
  if (!empSelect) return;
  const previous = taskFilters.employee || "all";
  const options = [
    `<option value="all">Iedereen</option>`,
    `<option value="ALLEN">Allen</option>`,
    `<option value="UNASSIGNED">Niet toegewezen</option>`,
    ...employees.filter((e) => e.active).map((e) => `<option value="${escapeAttr(e.id)}">${escapeHtml(e.name)}</option>`)
  ];
  empSelect.innerHTML = options.join("");
  if ([...empSelect.options].some((o) => o.value === previous)) empSelect.value = previous;
  else empSelect.value = "all";
  taskFilters.employee = empSelect.value;

  const locSelect = document.getElementById("filter-location");
  const locations = [...new Set(tasks.map((task) => (task.location || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "nl"));
  const prevLoc = taskFilters.location || "all";
  locSelect.innerHTML = [
    `<option value="all">Alle locaties</option>`,
    `<option value="__none__">Geen locatie</option>`,
    ...locations.map((loc) => `<option value="${escapeAttr(loc)}">${escapeHtml(loc)}</option>`)
  ].join("");
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
  const empSelect = document.getElementById("filter-employee");
  if (empSelect && [...empSelect.options].some((o) => o.value === taskFilters.employee)) empSelect.value = taskFilters.employee;
  const locSelect = document.getElementById("filter-location");
  if (locSelect && [...locSelect.options].some((o) => o.value === taskFilters.location)) locSelect.value = taskFilters.location;
}

function renderTasks() {
  const list = document.getElementById("task-list");
  const active = tasks
    .filter((task) => taskMatchesFilters(task, false))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  if (!active.length) {
    list.innerHTML = '<p class="empty-state">Geen taken die aan de filters voldoen.</p>';
    return;
  }
  list.innerHTML = active.map(taskItemHtml).join("");
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
  list.innerHTML = done.map(taskItemHtml).join("");
  bindTaskItems(list);
}

function renderTemplates() {
  const list = document.getElementById("template-list");
  if (!templates.length) {
    list.innerHTML = '<p class="empty-state">Nog geen terugkerende taken. Vink bij een nieuwe taak "Herhalende taak" aan.</p>';
    return;
  }
  list.innerHTML = templates.map((template) => `
    <div class="template-item">
      <div class="template-top">
        <div>
          <div class="task-title">${escapeHtml(template.title)}</div>
          ${locationLabel(template)}
          <div class="task-meta">
            ${escapeHtml(assigneeLabel(template))}
            · ${escapeHtml(describeRecurrence(template))}
          </div>
        </div>
        <div class="badge-row">
          ${template.paused ? '<span class="badge paused">Gepauzeerd</span>' : '<span class="badge recurring">Actief</span>'}
        </div>
      </div>
      <div class="template-actions">
        <button type="button" class="secondary" data-edit-template="${escapeAttr(template.id)}">Bewerken</button>
        <button type="button" class="secondary" data-pause-template="${escapeAttr(template.id)}">${template.paused ? "Hervatten" : "Pauzeren"}</button>
        <button type="button" class="danger" data-delete-template="${escapeAttr(template.id)}">Verwijderen</button>
      </div>
    </div>
  `).join("");
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
  if (!employees.length) {
    list.innerHTML = '<p class="empty-state">Nog geen medewerkers. Vul de standaardlijst of voeg zelf namen toe.</p>';
    return;
  }
  list.innerHTML = employees.map((emp) => `
    <div class="employee-item">
      <div class="employee-top">
        <div class="task-title">${escapeHtml(emp.name)}</div>
        <span class="badge ${emp.active ? "open" : "paused"}">${emp.active ? "Actief" : "Inactief"}</span>
      </div>
      <div class="employee-actions">
        <button type="button" class="secondary" data-rename-emp="${escapeAttr(emp.id)}">Hernoemen</button>
        <button type="button" class="secondary" data-toggle-emp="${escapeAttr(emp.id)}">${emp.active ? "Deactiveren" : "Activeren"}</button>
        <button type="button" class="danger" data-delete-emp="${escapeAttr(emp.id)}">Verwijderen</button>
      </div>
    </div>
  `).join("");
  list.querySelectorAll("[data-rename-emp]").forEach((btn) => {
    btn.onclick = () => renameEmployee(btn.dataset.renameEmp);
  });
  list.querySelectorAll("[data-toggle-emp]").forEach((btn) => {
    btn.onclick = () => toggleEmployee(btn.dataset.toggleEmp);
  });
  list.querySelectorAll("[data-delete-emp]").forEach((btn) => {
    btn.onclick = () => removeEmployee(btn.dataset.deleteEmp);
  });
}

async function addEmployee(event) {
  event.preventDefault();
  const name = document.getElementById("employee-name").value.trim();
  if (!name) return;
  const id = employeeSlug(name);
  const ok = await safeWrite(() => setDoc(doc(db, "employees", id), {
    name,
    active: true,
    createdAt: new Date().toISOString()
  }, { merge: true }));
  if (ok) document.getElementById("employee-name").value = "";
}

async function seedEmployees() {
  const batch = writeBatch(db);
  const now = new Date().toISOString();
  for (const name of SEED_EMPLOYEES) {
    const id = employeeSlug(name);
    const existing = employees.find((e) => e.id === id);
    if (existing) continue;
    batch.set(doc(db, "employees", id), { name, active: true, createdAt: now }, { merge: true });
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
  const ok = await safeWrite(async () => {
    let batch = writeBatch(db);
    let count = 0;
    const add = async (ref, data) => {
      batch.update(ref, data);
      count += 1;
      if (count >= 400) {
        await batch.commit();
        batch = writeBatch(db);
        count = 0;
      }
    };
    await add(doc(db, "employees", id), { name });
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
  await safeWrite(() => updateDoc(doc(db, "employees", id), { active: !emp.active }));
}

async function removeEmployee(id) {
  const emp = employees.find((e) => e.id === id);
  if (!emp) return;
  const ok = await confirmAction(`Medewerker ${emp.name} verwijderen? Bestaande taken blijven bewaard.`, { title: "Verwijderen", confirmText: "Verwijderen", danger: true });
  if (!ok) return;
  await safeWrite(() => deleteDoc(doc(db, "employees", id)));
}

function openTask(id) {
  const task = tasks.find((item) => item.id === id);
  if (!task) return;
  currentTaskId = id;
  document.getElementById("modal-title").textContent = task.title;
  const locationEl = document.getElementById("modal-location");
  const location = (task.location || "").trim();
  locationEl.textContent = location;
  locationEl.classList.toggle("hidden", !location);
  document.getElementById("modal-assignee").textContent = "Toegewezen aan: " + assigneeLabel(task);
  const statusBadges = [`<span class="badge ${task.status}">${task.status === "open" ? "Open" : task.status === "pending" ? "Pending" : "Afgerond"}</span>`];
  if (isRecurring(task)) statusBadges.push('<span class="badge recurring">Herhalend</span>');
  if (task.rejectedCount || task.lastRejectedAt || (Array.isArray(task.rejections) && task.rejections.length)) {
    statusBadges.push('<span class="badge paused">Afgewezen</span>');
  }
  document.getElementById("modal-status").innerHTML = statusBadges.join("");
  const extra = [];
  if (task.createdAt) extra.push(`Aangemaakt op ${escapeHtml(formatDateTime(task.createdAt))}`);
  if (task.pendingAt) {
    extra.push(`Afgevinkt op ${escapeHtml(formatDateTime(task.pendingAt))}${task.pendingBy ? " door " + escapeHtml(task.pendingBy) : ""}`);
  }
  if (task.completedAt) extra.push(`Goedgekeurd op ${escapeHtml(formatDateTime(task.completedAt))}`);
  document.getElementById("modal-description").innerHTML =
    `<p>${escapeHtml(task.description || "").replace(/\n/g, "<br>")}</p>` +
    (extra.length ? `<div class="task-meta">${extra.join("<br>")}</div>` : "");
  const historyEl = document.getElementById("modal-rejections");
  historyEl.innerHTML = rejectionHistoryHtml(task);
  const photos = (task.photos || []).filter((src) => typeof src === "string" && src.startsWith("data:image"));
  document.getElementById("modal-photos").innerHTML = photos.map((src) => `<img src="${src}" alt="Foto bij taak">`).join("");
  fillAssigneeSelects();
  document.getElementById("reassign-select").value = task.assigneeId || "";

  const actions = document.getElementById("modal-actions");
  actions.innerHTML = "";
  if (task.status === "open" || task.status === "pending") {
    actions.innerHTML += `<button type="button" class="secondary" data-action="edit">Bewerken</button>`;
  }
  if (task.status === "open") {
    actions.innerHTML += `<button type="button" class="success" data-action="pending">Markeer als gedaan</button>`;
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
  if (editBtn) editBtn.onclick = () => startEditTask(task.id);
  if (pendingBtn) pendingBtn.onclick = () => markPending(task.id);
  if (approveBtn) approveBtn.onclick = () => approveTask(task.id);
  if (rejectBtn) rejectBtn.onclick = () => rejectTask(task.id);
  if (reopenBtn) reopenBtn.onclick = () => reopenTask(task.id);
  if (deleteBtn) deleteBtn.onclick = () => deleteTask(task.id);
  document.getElementById("modal").classList.remove("hidden");
}

function rejectionHistoryHtml(task) {
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
  return `<div class="rejection-history">
    <h3>Afwijzingen</h3>
    <ul>${items.map((item) => {
      const reason = (item.reason || "").trim();
      const meta = [item.at ? formatDateTime(item.at) : "", item.by].filter(Boolean).join(" · ");
      return `<li>
        ${meta ? `<div class="task-meta">${escapeHtml(meta)}</div>` : ""}
        <p>${reason ? escapeHtml(reason) : "Geen reden opgegeven"}</p>
      </li>`;
    }).join("")}</ul>
  </div>`;
}

function closeModal() {
  document.getElementById("modal").classList.add("hidden");
  currentTaskId = null;
}

async function markPending(id) {
  const task = tasks.find((item) => item.id === id);
  if (!task || task.status !== "open") return;
  await safeWrite(() => updateDoc(doc(db, "tasks", id), {
    status: "pending",
    pendingAt: new Date().toISOString(),
    pendingBy: null
  }));
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
  const by = (auth.currentUser && auth.currentUser.email) || "Admin";
  const ok = await safeWrite(() => updateDoc(doc(db, "tasks", id), {
    status: "open",
    pendingAt: null,
    pendingBy: null,
    rejectedCount: increment(1),
    lastRejectedAt: at,
    lastRejectionReason: reason,
    rejections: arrayUnion({ at, by, reason })
  }));
  if (ok) closeModal();
}

async function reopenTask(id) {
  const task = tasks.find((item) => item.id === id);
  if (!task || task.status !== "afgerond") return;
  const confirmed = await confirmAction(`Taak “${task.title}” terugzetten naar open?`, { title: "Terugzetten", confirmText: "Terugzetten naar open" });
  if (!confirmed) return;
  const ok = await safeWrite(() => updateDoc(doc(db, "tasks", id), {
    status: "open",
    completedAt: null,
    pendingAt: null,
    pendingBy: null
  }));
  if (ok) closeModal();
}

async function deleteTask(id) {
  const confirmed = await confirmAction("Taak definitief verwijderen?", { title: "Verwijderen", confirmText: "Verwijderen", danger: true });
  if (!confirmed) return;
  const ok = await safeWrite(() => deleteDoc(doc(db, "tasks", id)));
  if (ok) closeModal();
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
  exportData();
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
      count += 1;
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
    employees
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
          batch.set(doc(db, "employees", id), {
            name: emp.name || "",
            active: emp.active !== false,
            createdAt: emp.createdAt || new Date().toISOString()
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
