const ADMIN_PASSWORD = "admin123"; // Pas dit aan!

let isAdmin = false;
let tasks = JSON.parse(localStorage.getItem("takenlijst") || "[]");
let currentTaskId = null;

const adminBtn = document.getElementById("admin-btn");
const logoutBtn = document.getElementById("logout-btn");
const adminControls = document.getElementById("admin-controls");
const addTaskSection = document.getElementById("add-task-section");
const taskListEl = document.getElementById("task-list");
const modal = document.getElementById("modal");

function init() {
  renderTasks();
  setupListeners();
}

function setupListeners() {
  adminBtn.onclick = () => {
    const pwd = prompt("Admin wachtwoord:");
    if (pwd === ADMIN_PASSWORD) setAdmin(true);
    else if (pwd !== null) alert("Verkeerd wachtwoord");
  };

  logoutBtn.onclick = () => setAdmin(false);

  document.getElementById("export-btn").onclick = exportData;
  document.getElementById("import-btn").onclick = () => document.getElementById("import-file").click();
  document.getElementById("import-file").onchange = importData;

  document.getElementById("add-task-form").onsubmit = addTask;

  document.querySelector(".close").onclick = closeModal;
  modal.onclick = (e) => { if (e.target === modal) closeModal(); };
}

function setAdmin(admin) {
  isAdmin = admin;
  adminControls.classList.toggle("hidden", !admin);
  document.getElementById("auth-section").classList.toggle("hidden", admin);
  addTaskSection.classList.toggle("hidden", !admin);
  renderTasks();
}

function addTask(e) {
  e.preventDefault();
  const title = document.getElementById("title").value.trim();
  const description = document.getElementById("description").value.trim();
  const assignee = document.getElementById("assignee").value.trim();
  const files = document.getElementById("photos").files;

  if (!title || !description) return;

  const task = {
    id: Date.now().toString(),
    title,
    description,
    assignee,
    photos: [],
    status: "open",
    created: new Date().toISOString()
  };

  // Foto's als base64 opslaan
  if (files.length > 0) {
    let loaded = 0;
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        task.photos.push(reader.result);
        loaded++;
        if (loaded === files.length) {
          tasks.push(task);
          saveAndRender();
          e.target.reset();
        }
      };
      reader.readAsDataURL(file);
    }
  } else {
    tasks.push(task);
    saveAndRender();
    e.target.reset();
  }
}

function renderTasks() {
  const active = tasks.filter(t => t.status !== "approved");
  if (active.length === 0) {
    taskListEl.innerHTML = "<p>Geen openstaande taken.</p>";
    return;
  }

  taskListEl.innerHTML = active.map(task => `
    <div class="task-item ${task.status}" onclick="openTask('${task.id}')">
      <div>
        <div class="task-title">${escapeHtml(task.title)}</div>
        <div class="task-meta">
          ${task.assignee ? "Toegewezen aan: " + escapeHtml(task.assignee) : "Niet toegewezen"}
        </div>
      </div>
      <span class="badge ${task.status}">
        ${task.status === "open" ? "Open" : "Completion pending"}
      </span>
    </div>
  `).join("");
}

function openTask(id) {
  currentTaskId = id;
  const task = tasks.find(t => t.id === id);
  if (!task) return;

  document.getElementById("modal-title").textContent = task.title;
  document.getElementById("modal-assignee").textContent = task.assignee 
    ? `Toegewezen aan: ${task.assignee}` 
    : "Niet toegewezen";
  document.getElementById("modal-status").innerHTML = `
    <span class="badge ${task.status}">
      ${task.status === "open" ? "Open" : "Completion pending"}
    </span>
  `;
  document.getElementById("modal-description").innerHTML = `<p>${escapeHtml(task.description).replace(/\n/g, "<br>")}</p>`;

  const photosEl = document.getElementById("modal-photos");
  photosEl.innerHTML = task.photos.map(src => `<img src="${src}" alt="Foto">`).join("");

  const actions = document.getElementById("modal-actions");
  actions.innerHTML = "";

  if (task.status === "open") {
    actions.innerHTML += `<button class="success" onclick="markPending('${task.id}')">Markeer als gedaan</button>`;
  }

  if (isAdmin && task.status === "pending") {
    actions.innerHTML += `<button class="success" onclick="approveTask('${task.id}')">Goedkeuren & verwijderen</button>`;
  }

  if (isAdmin) {
    actions.innerHTML += `<button class="danger" onclick="deleteTask('${task.id}')">Verwijderen</button>`;
  }

  modal.classList.remove("hidden");
}

function closeModal() {
  modal.classList.add("hidden");
  currentTaskId = null;
}

function markPending(id) {
  const task = tasks.find(t => t.id === id);
  if (task && task.status === "open") {
    task.status = "pending";
    saveAndRender();
    openTask(id); // refresh modal
  }
}

function approveTask(id) {
  if (!isAdmin) return;
  tasks = tasks.filter(t => t.id !== id); // verdwijnt uit de lijst
  saveAndRender();
  closeModal();
}

function deleteTask(id) {
  if (!isAdmin || !confirm("Taak definitief verwijderen?")) return;
  tasks = tasks.filter(t => t.id !== id);
  saveAndRender();
  closeModal();
}

function saveAndRender() {
  localStorage.setItem("takenlijst", JSON.stringify(tasks));
  renderTasks();
}

function exportData() {
  const blob = new Blob([JSON.stringify(tasks, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "takenlijst.json";
  a.click();
}

function importData(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      tasks = JSON.parse(reader.result);
      saveAndRender();
      alert("Data geïmporteerd");
    } catch {
      alert("Ongeldig bestand");
    }
  };
  reader.readAsText(file);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, m => ({
    "&": "&", "<": "<", ">": ">", '"': """, "'": "&#39;"
  }[m]));
}

// Start
init();