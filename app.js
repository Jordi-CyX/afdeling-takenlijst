// Alleen een PBKDF2-hash van het admin-wachtwoord staat hier, niet het wachtwoord zelf.
const ADMIN_SALT = "88b0401bc4e016166e5abf5597a60f80";
const ADMIN_HASH = "0440fad32c490307cf21f9c35d2bd8df4084af2e05e0abf91d266cae38a00df0";

async function hashPassword(pwd) {
  const enc = new TextEncoder();
  const salt = new Uint8Array(ADMIN_SALT.match(/../g).map(b => parseInt(b, 16)));
  const key = await crypto.subtle.importKey("raw", enc.encode(pwd), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 200000, hash: "SHA-256" }, key, 256);
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, "0")).join("");
}

const STORAGE_TASKS = "takenlijst";
const STORAGE_TEMPLATES = "takenlijst-templates";

const STATUS_LABELS = {
  open: "Open",
  pending: "Pending",
  afgerond: "Afgerond"
};

const WEEKDAYS = [
  { value: 1, short: "Ma", long: "maandag" },
  { value: 2, short: "Di", long: "dinsdag" },
  { value: 3, short: "Wo", long: "woensdag" },
  { value: 4, short: "Do", long: "donderdag" },
  { value: 5, short: "Vr", long: "vrijdag" },
  { value: 6, short: "Za", long: "zaterdag" },
  { value: 0, short: "Zo", long: "zondag" }
];

let isAdmin = false;
let tasks = [];
let templates = [];
let currentTaskId = null;
let editingTemplateId = null;
let knownDate = localDateKey(new Date());

function localDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseLocalDate(key) {
  const [y, m, d] = String(key).split("-").map(Number);
  return new Date(y, m - 1, d);
}

function addDays(date, n) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
}

function calendarDiffDays(later, earlier) {
  const a = Date.UTC(later.getFullYear(), later.getMonth(), later.getDate());
  const b = Date.UTC(earlier.getFullYear(), earlier.getMonth(), earlier.getDate());
  return Math.round((a - b) / 86400000);
}

function formatDate(keyOrIso) {
  if (!keyOrIso) return "";
  const date = keyOrIso.length <= 10 ? parseLocalDate(keyOrIso) : new Date(keyOrIso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("nl-NL", { day: "numeric", month: "short", year: "numeric" });
}

function safeParse(raw, fallback) {
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw);
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

function migrateTasks(list) {
  if (!Array.isArray(list)) return [];
  return list.map((item) => {
    const task = { ...item };
    if (task.status === "approved" || task.status === "completed") {
      task.status = "afgerond";
    }
    if (!task.status) task.status = "open";
    if (!Array.isArray(task.photos)) task.photos = [];
    if (task.status === "afgerond" && !task.completed) {
      task.completed = task.created || new Date().toISOString();
    }
    if (task.templateId && task.recurring == null) task.recurring = true;
    return task;
  });
}

function migrateTemplates(list) {
  if (!Array.isArray(list)) return [];
  return list.map((item) => {
    const template = { ...item };
    if (!template.recurrence || typeof template.recurrence !== "object") {
      template.recurrence = { type: "daily", startDate: localDateKey(new Date()) };
    }
    if (!template.recurrence.startDate) {
      template.recurrence.startDate = localDateKey(new Date());
    }
    if (!Array.isArray(template.photos)) template.photos = [];
    if (typeof template.paused !== "boolean") template.paused = false;
    return template;
  });
}

function loadData() {
  tasks = migrateTasks(safeParse(localStorage.getItem(STORAGE_TASKS), []));
  templates = migrateTemplates(safeParse(localStorage.getItem(STORAGE_TEMPLATES), []));
}

function saveData() {
  localStorage.setItem(STORAGE_TASKS, JSON.stringify(tasks));
  localStorage.setItem(STORAGE_TEMPLATES, JSON.stringify(templates));
}

function occurrenceInMonth(year, month, day) {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day, lastDay));
}

function latestDueOnOrBefore(template, todayStr) {
  const recurrence = template.recurrence || {};
  const today = parseLocalDate(todayStr);
  const start = parseLocalDate(recurrence.startDate || todayStr);
  if (Number.isNaN(today.getTime()) || Number.isNaN(start.getTime()) || today < start) {
    return null;
  }

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

function generateDueInstances() {
  const today = localDateKey(new Date());
  let added = 0;
  for (const template of templates) {
    if (template.paused) continue;
    const due = latestDueOnOrBefore(template, today);
    if (!due) continue;
    const exists = tasks.some((task) => task.templateId === template.id && task.instanceDate === due);
    if (exists) continue;
    tasks.push({
      id: `inst-${template.id}-${due}`,
      title: template.title,
      description: template.description,
      assignee: template.assignee || "",
      photos: [...(template.photos || [])],
      status: "open",
      created: new Date().toISOString(),
      templateId: template.id,
      instanceDate: due,
      recurring: true
    });
    added += 1;
  }
  if (added) saveData();
  return added;
}

function checkDateChange() {
  const today = localDateKey(new Date());
  if (today !== knownDate) {
    knownDate = today;
    generateDueInstances();
    renderAll();
  }
}

function init() {
  loadData();
  generateDueInstances();
  buildWeekdayPicker();
  document.getElementById("recurrence-start").value = localDateKey(new Date());
  setupListeners();
  renderAll();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

function buildWeekdayPicker() {
  const picker = document.getElementById("weekday-picker");
  picker.innerHTML = WEEKDAYS.map((day) => `
    <label>
      <input type="checkbox" value="${day.value}">
      <span>${day.short}</span>
    </label>
  `).join("");
}

function setupListeners() {
  document.getElementById("admin-btn").onclick = () => openLogin();
  document.getElementById("logout-btn").onclick = () => setAdmin(false);
  document.getElementById("login-cancel").onclick = closeLogin;
  document.getElementById("login-form").onsubmit = submitLogin;
  document.getElementById("login-modal").onclick = (event) => {
    if (event.target.id === "login-modal") closeLogin();
  };

  document.getElementById("export-btn").onclick = exportData;
  document.getElementById("import-btn").onclick = () => document.getElementById("import-file").click();
  document.getElementById("import-file").onchange = importData;

  document.getElementById("add-task-form").onsubmit = submitTaskForm;
  document.getElementById("task-cancel-edit").onclick = resetTaskForm;
  document.getElementById("is-recurring").onchange = updateRecurrenceVisibility;
  document.getElementById("recurrence-type").onchange = updateRecurrenceVisibility;

  document.getElementById("modal-close").onclick = closeModal;
  document.getElementById("modal").onclick = (event) => {
    if (event.target.id === "modal") closeModal();
  };
  document.getElementById("reassign-btn").onclick = reassignCurrentTask;

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) checkDateChange();
  });
  setInterval(checkDateChange, 60000);
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
  const input = document.getElementById("login-password");
  const error = document.getElementById("login-error");
  const password = input.value;
  input.value = "";
  if ((await hashPassword(password)) === ADMIN_HASH) {
    error.classList.add("hidden");
    closeLogin();
    setAdmin(true);
  } else {
    error.classList.remove("hidden");
    input.focus();
  }
}

function openLogin() {
  document.getElementById("login-error").classList.add("hidden");
  document.getElementById("login-password").value = "";
  document.getElementById("login-modal").classList.remove("hidden");
  document.getElementById("login-password").focus();
}

function closeLogin() {
  document.getElementById("login-modal").classList.add("hidden");
  document.getElementById("login-password").value = "";
}

function setAdmin(admin) {
  isAdmin = admin;
  document.getElementById("admin-controls").classList.toggle("hidden", !admin);
  document.getElementById("auth-section").classList.toggle("hidden", admin);
  document.getElementById("dashboard").classList.toggle("hidden", !admin);
  document.getElementById("completed-section").classList.toggle("hidden", !admin);
  if (!admin) resetTaskForm();
  renderAll();
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

function readPhotos(files) {
  return new Promise((resolve) => {
    if (!files || files.length === 0) {
      resolve([]);
      return;
    }
    const photos = [];
    let loaded = 0;
    [...files].forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string" && reader.result.startsWith("data:image")) {
          photos.push(reader.result);
        }
        loaded += 1;
        if (loaded === files.length) resolve(photos);
      };
      reader.onerror = () => {
        loaded += 1;
        if (loaded === files.length) resolve(photos);
      };
      reader.readAsDataURL(file);
    });
  });
}

function readRecurrenceFromForm() {
  const type = document.getElementById("recurrence-type").value;
  const startDate = document.getElementById("recurrence-start").value || localDateKey(new Date());
  const recurrence = { type, startDate };
  if (type === "weekdays") {
    recurrence.weekdays = selectedWeekdays();
    if (!recurrence.weekdays.length) {
      alert("Kies minstens één weekdag.");
      return null;
    }
  }
  if (type === "date") {
    recurrence.date = document.getElementById("recurrence-date").value;
    recurrence.monthly = document.getElementById("recurrence-monthly").checked;
    if (!recurrence.date) {
      alert("Kies een datum voor de herhaling.");
      return null;
    }
  }
  return recurrence;
}

async function submitTaskForm(event) {
  event.preventDefault();
  const title = document.getElementById("title").value.trim();
  const description = document.getElementById("description").value.trim();
  const assignee = document.getElementById("assignee").value.trim();
  if (!title || !description) return;

  const newPhotos = await readPhotos(document.getElementById("photos").files);

  if (editingTemplateId) {
    const template = templates.find((item) => item.id === editingTemplateId);
    if (!template) return;
    const recurrence = readRecurrenceFromForm();
    if (!recurrence) return;
    template.title = title;
    template.description = description;
    template.assignee = assignee;
    template.recurrence = recurrence;
    if (newPhotos.length) template.photos = newPhotos;
    saveData();
    generateDueInstances();
    resetTaskForm();
    renderAll();
    return;
  }

  const isRecurring = document.getElementById("is-recurring").checked;
  if (isRecurring) {
    const recurrence = readRecurrenceFromForm();
    if (!recurrence) return;
    templates.push({
      id: `tpl-${Date.now()}`,
      title,
      description,
      assignee,
      photos: newPhotos,
      recurrence,
      paused: false,
      created: new Date().toISOString()
    });
    saveData();
    generateDueInstances();
    resetTaskForm();
    renderAll();
    return;
  }

  tasks.push({
    id: Date.now().toString(),
    title,
    description,
    assignee,
    photos: newPhotos,
    status: "open",
    created: new Date().toISOString()
  });
  saveAndRender();
  resetTaskForm();
}

function resetTaskForm() {
  editingTemplateId = null;
  document.getElementById("add-task-form").reset();
  document.getElementById("recurrence-start").value = localDateKey(new Date());
  document.getElementById("recurrence-monthly").checked = false;
  setSelectedWeekdays([]);
  document.getElementById("task-form-heading").textContent = "Nieuwe taak toevoegen";
  document.getElementById("task-submit-btn").textContent = "Taak toevoegen";
  document.getElementById("task-cancel-edit").classList.add("hidden");
  document.getElementById("is-recurring").disabled = false;
  updateRecurrenceVisibility();
}

function startEditTemplate(id) {
  const template = templates.find((item) => item.id === id);
  if (!template) return;
  editingTemplateId = id;
  document.getElementById("title").value = template.title || "";
  document.getElementById("description").value = template.description || "";
  document.getElementById("assignee").value = template.assignee || "";
  document.getElementById("is-recurring").checked = true;
  document.getElementById("is-recurring").disabled = true;
  const recurrence = template.recurrence || {};
  document.getElementById("recurrence-type").value = recurrence.type || "daily";
  document.getElementById("recurrence-start").value = recurrence.startDate || localDateKey(new Date());
  document.getElementById("recurrence-date").value = recurrence.date || "";
  document.getElementById("recurrence-monthly").checked = Boolean(recurrence.monthly);
  setSelectedWeekdays(recurrence.weekdays || []);
  document.getElementById("task-form-heading").textContent = "Terugkerende taak bewerken";
  document.getElementById("task-submit-btn").textContent = "Opslaan";
  document.getElementById("task-cancel-edit").classList.remove("hidden");
  updateRecurrenceVisibility();
  document.getElementById("title").focus();
}

function pauseTemplate(id) {
  const template = templates.find((item) => item.id === id);
  if (!template) return;
  template.paused = !template.paused;
  saveData();
  if (!template.paused) generateDueInstances();
  renderAll();
}

function deleteTemplate(id) {
  if (!confirm("Deze terugkerende taak verwijderen? Bestaande taken blijven bewaard.")) return;
  templates = templates.filter((item) => item.id !== id);
  if (editingTemplateId === id) resetTaskForm();
  saveAndRender();
}

function weekdayNames(values) {
  const map = new Map(WEEKDAYS.map((day) => [day.value, day.long]));
  return (values || []).map((value) => map.get(Number(value))).filter(Boolean);
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

function renderAll() {
  renderDashboard();
  renderTasks();
  renderCompleted();
  renderTemplates();
}

function renderDashboard() {
  document.getElementById("stat-open").textContent = tasks.filter((task) => task.status === "open").length;
  document.getElementById("stat-pending").textContent = tasks.filter((task) => task.status === "pending").length;
  document.getElementById("stat-done").textContent = tasks.filter((task) => task.status === "afgerond").length;
}

function isRecurringTask(task) {
  return Boolean(task.recurring || task.templateId);
}

function taskItemHtml(task) {
  const badges = [
    `<span class="badge ${task.status}">${STATUS_LABELS[task.status] || task.status}</span>`
  ];
  if (isRecurringTask(task)) {
    badges.unshift('<span class="badge recurring">Herhalend</span>');
  }
  const completed = task.status === "afgerond" && task.completed
    ? `<div class="task-meta">Afgerond op ${formatDate(task.completed)}</div>`
    : "";
  return `
    <div class="task-item ${task.status}" role="button" tabindex="0" data-task-id="${escapeAttr(task.id)}">
      <div>
        <div class="task-title">${escapeHtml(task.title)}</div>
        <div class="task-meta">
          ${task.assignee ? "Toegewezen aan: " + escapeHtml(task.assignee) : "Niet toegewezen"}
        </div>
        ${completed}
      </div>
      <div class="badge-row">${badges.join("")}</div>
    </div>
  `;
}

function renderTasks() {
  const list = document.getElementById("task-list");
  const active = tasks
    .filter((task) => task.status !== "afgerond")
    .sort((a, b) => String(b.created || "").localeCompare(String(a.created || "")));
  if (active.length === 0) {
    list.innerHTML = '<p class="empty-state">Geen openstaande taken.</p>';
    return;
  }
  list.innerHTML = active.map(taskItemHtml).join("");
  bindTaskItems(list);
}

function renderCompleted() {
  const list = document.getElementById("completed-list");
  const done = tasks
    .filter((task) => task.status === "afgerond")
    .sort((a, b) => String(b.completed || b.created || "").localeCompare(String(a.completed || a.created || "")));
  document.getElementById("completed-count").textContent = String(done.length);
  if (done.length === 0) {
    list.innerHTML = '<p class="empty-state">Nog geen afgeronde taken.</p>';
    return;
  }
  list.innerHTML = done.map(taskItemHtml).join("");
  bindTaskItems(list);
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
          <div class="task-meta">
            ${template.assignee ? "Toegewezen aan: " + escapeHtml(template.assignee) : "Niet toegewezen"}
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

function openTask(id) {
  currentTaskId = id;
  const task = tasks.find((item) => item.id === id);
  if (!task) return;

  document.getElementById("modal-title").textContent = task.title;
  document.getElementById("modal-assignee").textContent = task.assignee
    ? `Toegewezen aan: ${task.assignee}`
    : "Niet toegewezen";

  const statusBadges = [`<span class="badge ${task.status}">${STATUS_LABELS[task.status] || task.status}</span>`];
  if (isRecurringTask(task)) statusBadges.push('<span class="badge recurring">Herhalend</span>');
  if (task.status === "afgerond" && task.completed) {
    statusBadges.push(`<span class="badge afgerond">Op ${escapeHtml(formatDate(task.completed))}</span>`);
  }
  document.getElementById("modal-status").innerHTML = statusBadges.join("");
  document.getElementById("modal-description").innerHTML = `<p>${escapeHtml(task.description || "").replace(/\n/g, "<br>")}</p>`;

  const photosEl = document.getElementById("modal-photos");
  const photos = (task.photos || []).filter((src) => typeof src === "string" && src.startsWith("data:image"));
  photosEl.innerHTML = photos.map((src) => `<img src="${src}" alt="Foto bij taak">`).join("");

  const reassignRow = document.getElementById("reassign-row");
  reassignRow.classList.toggle("hidden", !isAdmin);
  document.getElementById("reassign-input").value = task.assignee || "";

  const actions = document.getElementById("modal-actions");
  actions.innerHTML = "";
  if (task.status === "open") {
    actions.innerHTML += `<button type="button" class="success" data-action="pending">Markeer als gedaan</button>`;
  }
  if (isAdmin && task.status === "pending") {
    actions.innerHTML += `<button type="button" class="success" data-action="approve">Goedkeuren</button>`;
  }
  if (isAdmin) {
    actions.innerHTML += `<button type="button" class="danger" data-action="delete">Verwijderen</button>`;
  }
  const pendingBtn = actions.querySelector('[data-action="pending"]');
  const approveBtn = actions.querySelector('[data-action="approve"]');
  const deleteBtn = actions.querySelector('[data-action="delete"]');
  if (pendingBtn) pendingBtn.onclick = () => markPending(task.id);
  if (approveBtn) approveBtn.onclick = () => approveTask(task.id);
  if (deleteBtn) deleteBtn.onclick = () => deleteTask(task.id);

  document.getElementById("modal").classList.remove("hidden");
}

function closeModal() {
  document.getElementById("modal").classList.add("hidden");
  currentTaskId = null;
}

function markPending(id) {
  const task = tasks.find((item) => item.id === id);
  if (task && task.status === "open") {
    task.status = "pending";
    saveAndRender();
    openTask(id);
  }
}

function approveTask(id) {
  if (!isAdmin) return;
  const task = tasks.find((item) => item.id === id);
  if (!task || task.status !== "pending") return;
  task.status = "afgerond";
  task.completed = new Date().toISOString();
  saveAndRender();
  closeModal();
}

function deleteTask(id) {
  if (!isAdmin || !confirm("Taak definitief verwijderen?")) return;
  tasks = tasks.filter((item) => item.id !== id);
  saveAndRender();
  closeModal();
}

function reassignCurrentTask() {
  if (!isAdmin || !currentTaskId) return;
  const task = tasks.find((item) => item.id === currentTaskId);
  if (!task) return;
  task.assignee = document.getElementById("reassign-input").value.trim();
  saveAndRender();
  openTask(task.id);
}

function saveAndRender() {
  saveData();
  renderAll();
}

function exportData() {
  const payload = {
    version: 2,
    exportedAt: new Date().toISOString(),
    tasks,
    templates
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "takenlijst.json";
  a.click();
  URL.revokeObjectURL(a.href);
}

function importData(event) {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (Array.isArray(data)) {
        tasks = migrateTasks(data);
      } else if (data && typeof data === "object") {
        if (Array.isArray(data.tasks)) tasks = migrateTasks(data.tasks);
        if (Array.isArray(data.templates)) templates = migrateTemplates(data.templates);
      } else {
        throw new Error("Ongeldig bestand");
      }
      generateDueInstances();
      saveAndRender();
      alert("Data geïmporteerd");
    } catch {
      alert("Ongeldig bestand");
    }
  };
  reader.readAsText(file);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[m]));
}

function escapeAttr(str) {
  return escapeHtml(str);
}

init();
