// V3A (ZLA, admin v28): onderhoudsknop (settings/maintenance) en "Ik pak deze op" tonen/weghalen. Renderen alleen via ctx.dom (geen HTML uit data).
// Datamodel: /workspace/outputs/zla-v3a-data-afspraak.md
import {
  onSnapshot,
  doc,
  setDoc,
  updateDoc,
  serverTimestamp,
  deleteField
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";
import { db, formatDateTime } from "../shared.js";
import { cleanMaintenanceMessage, MAINTENANCE_MAX, displayName } from "./v3a-logic.js?v=28";

let ctx = null;
let maintenance = null; // { enabled, message, updatedAt } of null
let maintenanceReady = false;
let maintenanceDirty = false;
const noop = () => {};

const tsIso = (v) => (v && typeof v.toDate === "function" ? v.toDate().toISOString() : (typeof v === "string" ? v : ""));

export function initV3a(context) {
  ctx = context;
}

export function startV3aListeners() {
  onSnapshot(doc(db, "settings", "maintenance"), (snap) => {
    const d = snap.exists() ? snap.data() : null;
    maintenance = d ? { enabled: d.enabled === true, message: typeof d.message === "string" ? d.message : "", updatedAt: tsIso(d.updatedAt) } : null;
    maintenanceReady = true;
    renderMaintenanceCard();
  }, noop);
}

export function isV3aBusy() {
  return maintenanceDirty;
}

// ---------- Onderhoud (settings/maintenance) ----------
export function renderMaintenanceCard() {
  const root = document.getElementById("maintenance-card");
  if (!root || !ctx) return;
  const { dom } = ctx;
  if (!maintenanceReady) {
    root.replaceChildren(dom`<h3>Onderhoudsscherm medewerkers-app</h3><p class="pin-meta">Laden…</p>`);
    return;
  }
  if (maintenanceDirty && root.querySelector("[data-maint-text]")) return; // niet onder de typende gebruiker wegrenderen
  const on = Boolean(maintenance && maintenance.enabled);
  root.replaceChildren(dom`
    <h3>Onderhoudsscherm medewerkers-app</h3>
    <p class="${on ? "maintenance-on" : "pin-meta"}">${on ? "AAN: medewerkers zien nu het onderhoudsscherm." : "Uit: de medewerkers-app werkt normaal."}</p>
    ${maintenance && maintenance.updatedAt ? dom`<p class="pin-meta">Laatst gewijzigd ${formatDateTime(maintenance.updatedAt)}</p>` : ""}
    <label>
      Tekst voor medewerkers (optioneel, max. ${String(MAINTENANCE_MAX)} tekens)
      <textarea rows="2" maxlength="${String(MAINTENANCE_MAX)}" data-maint-text data-no-dirty placeholder="bijv. We werken de app bij, over 10 minuten weer terug."></textarea>
    </label>
    <div class="form-actions">
      <button type="button" class="${on ? "" : "danger"}" data-maint-toggle>${on ? "Onderhoudsscherm uitzetten" : "Onderhoudsscherm aanzetten"}</button>
      ${on ? dom`<button type="button" class="secondary" data-maint-save>Alleen tekst bijwerken</button>` : ""}
    </div>`);
  const text = root.querySelector("[data-maint-text]");
  text.value = maintenance ? maintenance.message : "";
  text.oninput = () => { maintenanceDirty = true; };
  root.querySelector("[data-maint-toggle]").onclick = () => saveMaintenance(!on, text.value);
  const saveBtn = root.querySelector("[data-maint-save]");
  if (saveBtn) saveBtn.onclick = () => saveMaintenance(true, text.value, { textOnly: true });
}

async function saveMaintenance(enabled, rawText, { textOnly = false } = {}) {
  const message = cleanMaintenanceMessage(rawText);
  if (!textOnly) {
    const ok = await ctx.confirmAction(
      enabled
        ? "Onderhoudsscherm AANzetten? Alle medewerkers zien direct het onderhoudsscherm en kunnen de app niet gebruiken tot je het weer uitzet."
        : "Onderhoudsscherm UITzetten? De medewerkers-app werkt dan direct weer normaal.",
      { title: enabled ? "Onderhoud aan" : "Onderhoud uit", confirmText: enabled ? "Aanzetten" : "Uitzetten", danger: enabled }
    );
    if (!ok) return;
  }
  const payload = { enabled, updatedAt: serverTimestamp() };
  if (message) payload.message = message;
  const done = await ctx.safeWrite(() => setDoc(doc(db, "settings", "maintenance"), payload));
  if (done) {
    maintenanceDirty = false;
    ctx.showToast(textOnly ? "Onderhoudstekst bijgewerkt." : (enabled ? "Onderhoudsscherm staat aan." : "Onderhoudsscherm staat uit."), "ok");
    renderMaintenanceCard();
  }
}

// ---------- "Ik pak deze op" ----------
export function claimLine(task, employees) {
  if (!task || !task.claim || !ctx) return "";
  const name = displayName(task.claim.employeeId, task.claim.name, employees) || "medewerker";
  return ctx.dom`<div class="task-claim">Opgepakt door ${name}</div>`;
}

export function claimDetailText(task, employees) {
  if (!task || !task.claim) return "";
  const name = displayName(task.claim.employeeId, task.claim.name, employees) || "medewerker";
  return `Opgepakt door ${name}${task.claim.at ? ` op ${formatDateTime(task.claim.at)}` : ""}`;
}

export async function removeClaim(task) {
  if (!task || !task.claim) return false;
  const ok = await ctx.confirmAction(`Claim “Opgepakt door ${task.claim.name || "medewerker"}” weghalen? De taak is dan weer vrij om op te pakken.`, { title: "Claim weghalen", confirmText: "Weghalen" });
  if (!ok) return false;
  const done = await ctx.safeWrite(() => updateDoc(doc(db, "tasks", task.id), { claimedBy: deleteField(), claimedAt: deleteField() }));
  if (done) ctx.showToast("Claim weggehaald.", "ok");
  return done;
}
