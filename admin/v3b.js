// V3B (admin v29): afdeling + adminknop per medewerker (staffProfiles/{employeeId}) en de knop terug naar ZL.
// Datacontract: /workspace/outputs/zla-v3b-data-afspraak.md. Renderen alleen via ctx.dom (geen HTML uit data).
import { onSnapshot, collection, doc, setDoc, deleteDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";
import { db } from "../shared.js";
import { FEATURES, DEPARTMENTS, DEPARTMENT_LABELS, normalizeProfile, profilePayload, profileSummary } from "./v3b-logic.js?v=29";

let ctx = null;
let profiles = new Map(); // employeeId -> { department, canAdmin }
let profilesReady = false;
let profilesError = false;
let cardFor = "";
let dirty = false;

export function initV3b(context) {
  ctx = context;
  // Schakelknop: terug naar de medewerkers-app. Alleen zichtbaar met de vlag aan.
  document.querySelectorAll(".nav-link-zl").forEach((el) => el.classList.toggle("hidden", !FEATURES.adminSwitch));
}

export function startV3bListeners() {
  if (!FEATURES.departments && !FEATURES.adminSwitch) return;
  onSnapshot(collection(db, "staffProfiles"), (snap) => {
    profiles = new Map(snap.docs.map((d) => [d.id, normalizeProfile(d.data())]));
    profilesReady = true;
    profilesError = false;
    if (ctx && ctx.onProfilesChange) ctx.onProfilesChange();
  }, () => {
    // Regels nog niet gepubliceerd: kaart toont een melding, verder werkt alles.
    profilesReady = true;
    profilesError = true;
    if (ctx && ctx.onProfilesChange) ctx.onProfilesChange();
  });
}

export function profileFor(employeeId) {
  return profiles.get(employeeId) || { department: "", canAdmin: false };
}

export function profileBadgeText(employeeId) {
  return profileSummary(profileFor(employeeId));
}

export function isV3bBusy() {
  return dirty;
}

const flag = (b) => (b ? "1" : "");

export function renderProfileCard(emp) {
  const el = document.getElementById("emp-dash-profile");
  if (!el || !ctx) return;
  const show = FEATURES.departments || FEATURES.adminSwitch;
  el.classList.toggle("hidden", !show || !emp);
  if (!show || !emp) return;
  if (dirty && cardFor === emp.id) return; // niet overschrijven tijdens het wijzigen
  cardFor = emp.id;
  dirty = false;
  const { dom } = ctx;
  const p = profileFor(emp.id);
  el.replaceChildren(dom`
    <h3>Afdeling en adminknop</h3>
    <p class="pin-meta">Alleen in de admin zichtbaar. Medewerkers met een afdeling zien in de app alleen taken van hun afdeling, plus taken zonder pad, paden van "Beide" en hun eigen taken. Geen afdeling = alles zien.</p>
    ${profilesError ? dom`<p class="form-error">Kan de afdelingen niet lezen (regels nog niet gepubliceerd?). Opslaan lukt pas na de nieuwe regels.</p>` : ""}
    ${!profilesReady ? dom`<p class="pin-meta">Laden…</p>` : ""}
    <form class="emp-profile-form" data-profile-form novalidate>
      ${FEATURES.departments ? dom`<label>Afdeling
        <select data-acc-dept>
          <option value="" data-selected="${flag(!p.department)}">Geen afdeling (ziet alles)</option>
          ${DEPARTMENTS.map((d) => dom`<option value="${d}" data-selected="${flag(p.department === d)}">${DEPARTMENT_LABELS[d]}</option>`)}
        </select>
      </label>` : ""}
      ${FEATURES.adminSwitch ? dom`<label class="check-row"><input type="checkbox" data-acc-admin data-checked="${flag(p.canAdmin)}"> Adminknop in de medewerkers-app (naar ZLA)</label>
      <p class="pin-meta">Geeft geen extra rechten: de admin-app vraagt altijd om de eigen admin-login. Voorlopig alleen voor Jordi.</p>` : ""}
      <div class="form-actions">
        <button type="submit" data-acc-save data-disabled="${flag(!profilesReady || profilesError)}">Opslaan</button>
      </div>
    </form>`);
  el.querySelectorAll('[data-selected="1"]').forEach((o) => { o.selected = true; });
  el.querySelectorAll('[data-checked="1"]').forEach((o) => { o.checked = true; });
  el.querySelectorAll('[data-disabled="1"]').forEach((o) => { o.disabled = true; });
  const form = el.querySelector("[data-profile-form]");
  form.oninput = () => { dirty = true; };
  form.onchange = () => { dirty = true; };
  form.onsubmit = (e) => {
    e.preventDefault();
    saveProfile(emp, form);
  };
}

async function saveProfile(emp, form) {
  const sel = form.querySelector("[data-acc-dept]");
  const box = form.querySelector("[data-acc-admin]");
  const prev = profileFor(emp.id);
  const next = {
    department: sel ? sel.value : prev.department,
    canAdmin: box ? box.checked : prev.canAdmin
  };
  if (next.canAdmin !== prev.canAdmin) {
    const ok = await ctx.confirmAction(
      next.canAdmin
        ? `${emp.name} krijgt de knop naar de admin-app in de medewerkers-app. Inloggen in de admin blijft nodig. Doorgaan?`
        : `De adminknop bij ${emp.name} weghalen?`,
      { title: "Adminknop", confirmText: next.canAdmin ? "Aanzetten" : "Weghalen" }
    );
    if (!ok) return;
  }
  const payload = profilePayload(next);
  const ref = doc(db, "staffProfiles", emp.id);
  const done = await ctx.safeWrite(() => (payload ? setDoc(ref, { ...payload, updatedAt: serverTimestamp() }) : deleteDoc(ref)));
  if (!done) return;
  dirty = false;
  cardFor = "";
  ctx.showToast("Afdeling en adminknop opgeslagen.", "ok");
  renderProfileCard(emp);
}
