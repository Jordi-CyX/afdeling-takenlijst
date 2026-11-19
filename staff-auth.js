import {
  auth,
  onAuthStateChanged,
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut
} from "./firebase-init.js";
import {
  createUserWithEmailAndPassword,
  deleteUser,
  setPersistence,
  browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js";
import {
  getDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";
import {
  db,
  doc,
  writeBatch,
  staffPassword,
  startCodeEmail,
  normalizeStartCode,
  formatStartCode,
  isValidStartCode
} from "./shared.js";
import { sendResetRequest } from "./limits.js";

// Login model: ZLA contract zla-step3-status.md (audit H1/M1/M2).
// - Claim (first time, new device, after reset): ONLY the start code.
//   get startCodes/{CODE} -> {employeeId, name, pinVersion} -> choose PIN ->
//   createUser(startCodeEmail(employeeId, pinVersion, CODE), staffPassword(pin, employeeId))
//   -> one batch with exactly two writes (staffAccounts set + startCodes update).
// - The login key (= the code, lowercase) lives ONLY on this device:
//   localStorage {employeeId, pinVersion, loginKey, name}. Login = PIN only.
// - No local data -> start code screen. New device / forgotten PIN -> new code.
// - ZL never reads or writes nameIndex, never lists employees, never reads taskMeta.

const STORAGE_DEVICE = "zeiklijst-staff-device";
const LEGACY_KEYS = [
  "zeiklijst-staff-id",
  "zeiklijst-staff-name-key",
  "zeiklijst-staff-name",
  "zeiklijst-staff-pin-version",
  "zeiklijst-staff-login-key"
];
const STORAGE_PIN_FAILS = "zeiklijst-staff-pin-fails";
const LEGACY_RESET_KEY = "zeiklijst-staff-last-reset"; // replaced by server pinResetLimits (step 4)

const PIN_LENGTH = 6;
const MAX_PIN_FAILS = 5;
const RESET_NAME_MAX = 60;
const RESET_NOTE_MAX = 200;

const MSG_INACTIVE = "Je account is niet actief. Neem contact op met je leidinggevende.";
const MSG_NEEDS_CODE = "Vraag je leidinggevende om een nieuwe startcode.";
const MSG_CODE_FORMAT = "Een startcode bestaat uit 10 tekens, bijvoorbeeld ABCDE-FGH23.";
const MSG_CODE_BAD = "Code onbekend, al gebruikt of verlopen. Vraag je leidinggevende om een nieuwe startcode.";
const MSG_ACCESS_GONE = "Je pincode is gereset of je toegang is veranderd. " + MSG_NEEDS_CODE;
const MSG_LOCKED = "Te vaak een onjuiste pincode. " + MSG_NEEDS_CODE;
const MSG_RESET_SENT = "Verzoek verstuurd. Je leidinggevende geeft je persoonlijk een nieuwe startcode.";
const MSG_RESET_SENT_AGAIN = "Je verzoek is al verstuurd. Je leidinggevende geeft je persoonlijk een nieuwe startcode.";
const MSG_OFFLINE = "Geen verbinding. Probeer het opnieuw als je weer online bent.";

let currentStaff = null;
let pending = null; // claim in progress: {employeeId, name, pinVersion, code}
let hooks = { onLoggedIn: () => {}, onLoggedOut: () => {}, showToast: () => {} };
let persistenceReady = null;
let authReady = false;
let busy = false;

export function getCurrentStaff() {
  return currentStaff;
}

export function setStaffDisplayName(name) {
  const value = String(name || "").trim();
  if (!currentStaff || !value || value === currentStaff.name) return currentStaff;
  currentStaff = { ...currentStaff, name: value };
  saveDevice(currentStaff);
  renderHeaderUser();
  return currentStaff;
}

// --- Device storage --------------------------------------------------------

function pinVersionOf(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function loadDevice() {
  LEGACY_KEYS.forEach((k) => localStorage.removeItem(k));
  try {
    const d = JSON.parse(localStorage.getItem(STORAGE_DEVICE) || "null");
    if (!d || typeof d !== "object") return null;
    const employeeId = String(d.employeeId || "").trim();
    const loginKey = normalizeStartCode(d.loginKey || "");
    if (!employeeId || !isValidStartCode(loginKey)) return null;
    return {
      employeeId,
      pinVersion: pinVersionOf(d.pinVersion),
      loginKey: loginKey.toLowerCase(),
      name: String(d.name || "").trim().slice(0, RESET_NAME_MAX)
    };
  } catch {
    return null;
  }
}

function saveDevice(staff) {
  localStorage.setItem(STORAGE_DEVICE, JSON.stringify({
    employeeId: staff.employeeId,
    pinVersion: staff.pinVersion,
    loginKey: staff.loginKey,
    name: staff.name || ""
  }));
}

function clearDevice() {
  localStorage.removeItem(STORAGE_DEVICE);
  localStorage.removeItem(STORAGE_PIN_FAILS);
  LEGACY_KEYS.forEach((k) => localStorage.removeItem(k));
}

function expectedEmail(staff) {
  return startCodeEmail(staff.employeeId, staff.pinVersion, staff.loginKey).toLowerCase();
}

function pinFails() {
  return Number(localStorage.getItem(STORAGE_PIN_FAILS)) || 0;
}

// --- Errors ----------------------------------------------------------------

function errCode(err) {
  return String((err && err.code) || "");
}

function isOffline(err) {
  const code = errCode(err);
  const message = String((err && err.message) || err || "");
  return (typeof navigator !== "undefined" && navigator.onLine === false)
    || /unavailable|offline|network-request-failed|Failed to get document|network/i.test(`${code} ${message}`);
}

function isPermission(err) {
  return /permission-denied/i.test(`${errCode(err)} ${String((err && err.message) || "")}`);
}

function isWrongPin(err) {
  return [
    "auth/wrong-password",
    "auth/invalid-credential",
    "auth/invalid-login-credentials",
    "auth/user-not-found",
    "auth/invalid-email"
  ].includes(errCode(err));
}

function genericError(err, what) {
  if (isOffline(err)) return MSG_OFFLINE;
  if (errCode(err) === "auth/too-many-requests") return "Te veel pogingen. Probeer het later opnieuw.";
  if (errCode(err) === "auth/operation-not-allowed" || isPermission(err)) {
    return "Dit is nu niet beschikbaar. Probeer het later opnieuw.";
  }
  return `${what} is mislukt. Probeer het opnieuw.`;
}

// --- DOM -------------------------------------------------------------------

function $(id) {
  return document.getElementById(id);
}

function setText(id, message) {
  const el = $(id);
  if (!el) return;
  el.textContent = message || "";
  el.classList.toggle("hidden", !message);
}

function setBusy(form, value) {
  busy = Boolean(value);
  if (!form) return;
  form.querySelectorAll("button, input, textarea").forEach((el) => {
    el.disabled = Boolean(value);
  });
}

function digitsOnly(input) {
  input.addEventListener("input", () => {
    input.value = input.value.replace(/\D/g, "").slice(0, PIN_LENGTH);
  });
}

function startCodeInput(input) {
  input.addEventListener("input", () => {
    input.value = formatStartCode(input.value).slice(0, 11);
  });
}

function validPin(value) {
  return new RegExp(`^\\d{${PIN_LENGTH}}$`).test(value);
}

function weakPin(value) {
  if (/^(\d)\1+$/.test(value)) return true; // 111111
  const digits = value.split("").map(Number);
  const steps = digits.slice(1).map((d, i) => d - digits[i]);
  if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) return true; // 123456, 654321
  if (/^(\d\d)\1+$/.test(value) || /^(\d\d\d)\1$/.test(value)) return true; // 121212, 123123
  return false;
}

const LOGIN_STEPS = {
  code: "staff-code-form",
  setup: "staff-pin-setup-form",
  pin: "staff-pin-form",
  reset: "staff-reset-form"
};
const ERROR_IDS = ["staff-code-error", "staff-pin-setup-error", "staff-pin-error", "staff-reset-error"];
const NOTICE_IDS = { code: "staff-code-notice", pin: "staff-pin-notice", reset: "staff-reset-notice" };

function showStep(step, options = {}) {
  const login = $("staff-login");
  if (!login) return;
  login.classList.remove("hidden");
  login.hidden = false;
  document.body.classList.add("is-locked");
  Object.entries(LOGIN_STEPS).forEach(([key, id]) => {
    const form = $(id);
    if (form) form.classList.toggle("hidden", key !== step);
  });
  ERROR_IDS.forEach((id) => setText(id, ""));
  Object.entries(NOTICE_IDS).forEach(([key, id]) => setText(id, key === step ? options.notice || "" : ""));
  ["staff-pin-new", "staff-pin-confirm", "staff-pin-input"].forEach((id) => {
    const el = $(id);
    if (el) el.value = "";
  });
  const device = loadDevice();
  if (step === "code") {
    const codeInput = $("staff-code-input");
    if (codeInput) codeInput.value = "";
    const back = $("staff-code-back");
    if (back) back.classList.toggle("hidden", !device);
  }
  if (step === "pin") {
    const hello = $("staff-pin-hello");
    if (hello) hello.textContent = device && device.name ? `Hoi ${device.name}, vul je pincode in.` : "Vul je pincode in.";
  }
  if (step === "setup") {
    const hello = $("staff-setup-hello");
    if (hello) {
      hello.textContent = pending && pending.name
        ? `Hoi ${pending.name}, kies een pincode van ${PIN_LENGTH} cijfers. Gebruik geen makkelijke reeks zoals 123456 of 111111.`
        : `Kies een pincode van ${PIN_LENGTH} cijfers. Gebruik geen makkelijke reeks zoals 123456 of 111111.`;
    }
  }
  if (step === "reset") {
    const nameInput = $("staff-reset-name");
    if (nameInput && !nameInput.value) nameInput.value = device && device.name ? device.name : "";
    const note = $("staff-reset-note");
    if (note) note.value = "";
    const form = $("staff-reset-form");
    if (form) form.querySelectorAll("button, input, textarea").forEach((el) => { el.disabled = false; });
  }
  // Hidden username field so password managers file the PIN under the right person.
  ["staff-setup-username", "staff-pin-username"].forEach((id) => {
    const el = $(id);
    if (!el) return;
    const name = step === "setup" ? (pending && pending.name) : (device && device.name);
    el.value = name || "";
  });
  const focusEl = $({
    code: "staff-code-input",
    setup: "staff-pin-new",
    pin: "staff-pin-input",
    reset: "staff-reset-name"
  }[step]);
  if (focusEl) {
    try { focusEl.focus(); } catch { /* ignore */ }
  }
}

// The normal login screen for this device: PIN if it has a login key, else start code.
function showLoginStart(notice) {
  if (loadDevice()) showStep("pin", { notice });
  else showStep("code", { notice: notice || MSG_NEEDS_CODE });
}

function hideLogin() {
  const login = $("staff-login");
  if (login) {
    login.classList.add("hidden");
    login.hidden = true;
  }
  document.body.classList.remove("is-locked");
}

function renderHeaderUser() {
  const name = currentStaff && currentStaff.name ? currentStaff.name : "";
  const header = $("header-user");
  const menu = $("menu-user");
  if (header) {
    header.textContent = name;
    header.classList.toggle("hidden", !name);
    header.hidden = !name;
  }
  if (menu) {
    menu.textContent = name ? `Ingelogd als ${name}` : "";
    menu.classList.toggle("hidden", !name);
  }
  ["logout-menu-btn", "report-menu-btn"].forEach((id) => {
    const btn = $(id);
    if (btn) btn.classList.toggle("hidden", !currentStaff);
  });
}

// --- Firebase helpers ------------------------------------------------------

async function ensurePersistence() {
  if (!persistenceReady) {
    persistenceReady = setPersistence(auth, browserLocalPersistence).catch(() => {});
  }
  await persistenceReady;
}

async function ensureAnonymous() {
  await ensurePersistence();
  if (auth.currentUser && auth.currentUser.isAnonymous) return auth.currentUser;
  if (auth.currentUser) await signOut(auth);
  const cred = await signInAnonymously(auth);
  return cred.user;
}

function millisOf(value) {
  if (!value) return NaN;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  return new Date(value).getTime();
}

// Own employees/{id} doc only (contract §3). Never a list.
// -> { ok: true, name } | { ok: false, reason: "inactive" | "denied" | "error", message }
async function checkOwnEmployee(staff) {
  try {
    const snap = await getDoc(doc(db, "employees", staff.employeeId));
    if (!snap.exists()) return { ok: false, reason: "denied", message: MSG_ACCESS_GONE };
    const data = snap.data() || {};
    if (data.active === false) return { ok: false, reason: "inactive", message: MSG_INACTIVE };
    return { ok: true, name: String(data.name || "").trim() };
  } catch (err) {
    if (isPermission(err)) return { ok: false, reason: "denied", message: MSG_ACCESS_GONE };
    // Offline: keep the authenticated session; the rules still refuse all data
    // for a reset or inactive account as soon as the phone is online again.
    if (isOffline(err)) return { ok: true, name: "" };
    return { ok: false, reason: "error", message: genericError(err, "Inloggen") };
  }
}

function acceptStaff(staff) {
  currentStaff = staff;
  saveDevice(staff);
  localStorage.removeItem(STORAGE_PIN_FAILS);
  pending = null;
  renderHeaderUser();
  hideLogin();
  hooks.onLoggedIn(staff);
}

// After a successful sign-in: own employee doc decides.
async function finishSession(staff) {
  const check = await checkOwnEmployee(staff);
  if (check.ok) {
    if (check.name) staff.name = check.name;
    acceptStaff(staff);
    return true;
  }
  currentStaff = null;
  renderHeaderUser();
  await signOut(auth).catch(() => {});
  if (check.reason === "denied") {
    // PIN reset (pinVersion bumped) or account no longer valid: this device's key is useless.
    clearDevice();
    showStep("code", { notice: check.message });
  } else if (check.reason === "inactive") {
    showLoginStart(check.message);
  } else {
    showLoginStart(check.message);
  }
  return false;
}

async function restoreSession(user) {
  const device = loadDevice();
  const email = String((user && user.email) || "").toLowerCase();
  if (!device || email !== expectedEmail(device)) {
    await signOut(auth).catch(() => {});
    return false;
  }
  return finishSession({ ...device });
}

// --- Claim -----------------------------------------------------------------

async function onCodeSubmit(event) {
  event.preventDefault();
  if (busy) return;
  const form = event.currentTarget;
  setText("staff-code-error", "");
  const code = normalizeStartCode(($("staff-code-input") && $("staff-code-input").value) || "");
  if (!isValidStartCode(code)) {
    setText("staff-code-error", MSG_CODE_FORMAT);
    return;
  }
  setBusy(form, true);
  try {
    await ensureAnonymous();
    let snap;
    try {
      snap = await getDoc(doc(db, "startCodes", code));
    } catch (err) {
      if (isPermission(err)) {
        // Unknown, used and expired all look the same (rules refuse the get).
        setText("staff-code-error", MSG_CODE_BAD);
        return;
      }
      throw err;
    }
    const data = snap.exists() ? snap.data() || {} : null;
    const expires = data ? millisOf(data.expiresAt) : NaN;
    const employeeId = data ? String(data.employeeId || "").trim() : "";
    if (!data || !employeeId || data.used !== false || !Number.isFinite(expires) || expires <= Date.now()) {
      setText("staff-code-error", MSG_CODE_BAD);
      return;
    }
    pending = {
      employeeId,
      name: String(data.name || "").trim().slice(0, RESET_NAME_MAX),
      pinVersion: pinVersionOf(data.pinVersion),
      code
    };
    setBusy(form, false);
    showStep("setup");
  } catch (err) {
    setText("staff-code-error", genericError(err, "Controleren"));
  } finally {
    setBusy(form, false);
  }
}

// Exactly two writes (contract §2.6). No nameIndex, no loginKey in the database.
async function claimBatch(uid, claim) {
  const batch = writeBatch(db);
  batch.set(doc(db, "staffAccounts", uid), {
    employeeId: claim.employeeId,
    pinVersion: claim.pinVersion,
    startCode: claim.code
  });
  batch.update(doc(db, "startCodes", claim.code), {
    used: true,
    usedBy: uid,
    usedAt: serverTimestamp()
  });
  await batch.commit();
}

async function staffAccountExists(uid) {
  try {
    const snap = await getDoc(doc(db, "staffAccounts", uid));
    return snap.exists();
  } catch {
    return false;
  }
}

async function onPinSetupSubmit(event) {
  event.preventDefault();
  if (busy) return;
  const form = event.currentTarget;
  const pin = ($("staff-pin-new") && $("staff-pin-new").value) || "";
  const confirm = ($("staff-pin-confirm") && $("staff-pin-confirm").value) || "";
  setText("staff-pin-setup-error", "");
  if (!pending || !isValidStartCode(pending.code)) {
    showStep("code");
    return;
  }
  if (!validPin(pin) || !validPin(confirm)) {
    setText("staff-pin-setup-error", `Kies een pincode van ${PIN_LENGTH} cijfers.`);
    return;
  }
  if (pin !== confirm) {
    setText("staff-pin-setup-error", "Pincodes komen niet overeen.");
    return;
  }
  if (weakPin(pin)) {
    setText("staff-pin-setup-error", "Deze pincode is te makkelijk te raden. Kies een andere.");
    return;
  }
  setBusy(form, true);
  const claim = { ...pending };
  const email = startCodeEmail(claim.employeeId, claim.pinVersion, claim.code);
  const password = staffPassword(pin, claim.employeeId);
  let user = null;
  let alreadyClaimed = false;
  try {
    await ensurePersistence();
    try {
      user = (await createUserWithEmailAndPassword(auth, email, password)).user;
    } catch (err) {
      if (errCode(err) !== "auth/email-already-in-use") throw err;
      // An earlier attempt with this code created the account but the batch did
      // not save. Resume with the same credentials; never create a second user.
      try {
        user = (await signInWithEmailAndPassword(auth, email, password)).user;
      } catch (signInErr) {
        if (isOffline(signInErr)) throw signInErr;
        setText("staff-pin-setup-error", "Met deze startcode is al een pincode ingesteld. Gebruik dezelfde pincode als de vorige keer, of " + MSG_NEEDS_CODE.charAt(0).toLowerCase() + MSG_NEEDS_CODE.slice(1));
        setBusy(form, false);
        return;
      }
      alreadyClaimed = await staffAccountExists(user.uid);
    }
  } catch (err) {
    setText("staff-pin-setup-error", genericError(err, "Pincode instellen"));
    setBusy(form, false);
    return;
  }
  if (!alreadyClaimed) {
    try {
      await claimBatch(user.uid, claim);
    } catch (err) {
      // Remove the just-created auth account so no orphan stays behind. If that
      // fails, a retry with the same PIN signs in to it and repeats the batch.
      await deleteUser(user).catch(() => {});
      await signOut(auth).catch(() => {});
      setText(
        "staff-pin-setup-error",
        isPermission(err)
          ? "Pincode instellen is niet gelukt. De startcode is niet meer geldig of je account is niet actief. " + MSG_NEEDS_CODE
          : `${isOffline(err) ? "Geen verbinding." : "Opslaan is mislukt."} Probeer het opnieuw met dezelfde pincode.`
      );
      setBusy(form, false);
      return;
    }
  }
  const staff = {
    employeeId: claim.employeeId,
    pinVersion: claim.pinVersion,
    loginKey: claim.code.toLowerCase(),
    name: claim.name
  };
  // The key lives only on this device from now on (replaces any earlier employee here).
  saveDevice(staff);
  localStorage.removeItem(STORAGE_PIN_FAILS);
  try {
    await finishSession(staff);
  } finally {
    setBusy(form, false);
  }
}

// --- PIN login -------------------------------------------------------------

async function onPinSubmit(event) {
  event.preventDefault();
  if (busy) return;
  const form = event.currentTarget;
  const pin = ($("staff-pin-input") && $("staff-pin-input").value) || "";
  setText("staff-pin-error", "");
  setText("staff-pin-notice", "");
  const device = loadDevice();
  if (!device) {
    showStep("code", { notice: MSG_NEEDS_CODE });
    return;
  }
  if (!validPin(pin)) {
    setText("staff-pin-error", `Vul je pincode van ${PIN_LENGTH} cijfers in.`);
    return;
  }
  setBusy(form, true);
  try {
    await ensurePersistence();
    if (auth.currentUser) await signOut(auth).catch(() => {});
    await signInWithEmailAndPassword(auth, expectedEmail(device), staffPassword(pin, device.employeeId));
    localStorage.removeItem(STORAGE_PIN_FAILS);
    setBusy(form, false);
    await finishSession({ ...device });
  } catch (err) {
    if (isWrongPin(err)) {
      const fails = pinFails() + 1;
      if (fails >= MAX_PIN_FAILS) {
        // Lockout: this device's login key is dropped; only a new start code helps.
        clearDevice();
        setBusy(form, false);
        showStep("code", { notice: MSG_LOCKED });
        return;
      }
      localStorage.setItem(STORAGE_PIN_FAILS, String(fails));
      const left = MAX_PIN_FAILS - fails;
      setText("staff-pin-error", `Onjuiste pincode. Nog ${left} ${left === 1 ? "poging" : "pogingen"}.`);
    } else {
      setText("staff-pin-error", genericError(err, "Inloggen"));
    }
  } finally {
    setBusy(form, false);
  }
}

// --- Forgot PIN (contract §4) ---------------------------------------------
// Only notifies the admin; gives no access. Auto id, create-only, in a batch with pinResetLimits (step 4 §2c).

async function onResetSubmit(event) {
  event.preventDefault();
  if (busy) return;
  const form = event.currentTarget;
  setText("staff-reset-error", "");
  setText("staff-reset-notice", "");
  const name = (($("staff-reset-name") && $("staff-reset-name").value) || "").trim();
  const note = (($("staff-reset-note") && $("staff-reset-note").value) || "").trim();
  if (!name) {
    setText("staff-reset-error", "Vul je naam in.");
    return;
  }
  if (name.length > RESET_NAME_MAX) {
    setText("staff-reset-error", `Je naam mag maximaal ${RESET_NAME_MAX} tekens zijn.`);
    return;
  }
  if (note.length > RESET_NOTE_MAX) {
    setText("staff-reset-error", `De toelichting mag maximaal ${RESET_NOTE_MAX} tekens zijn.`);
    return;
  }
  localStorage.removeItem(LEGACY_RESET_KEY);
  setBusy(form, true);
  let sent = false;
  try {
    const user = await ensureAnonymous();
    const payload = { name, requestedAt: serverTimestamp() };
    if (note) payload.note = note;
    // Contract step 4 §2c: request + pinResetLimits/{uid} + pinResetLimits/_global in one batch.
    await sendResetRequest(user.uid, payload, (msg) => setText("staff-reset-notice", msg));
    sent = true;
    setText("staff-reset-notice", MSG_RESET_SENT);
    hooks.showToast(MSG_RESET_SENT, "success");
  } catch (err) {
    if (err && err.isLimit) {
      setText("staff-reset-notice", "");
      setText(err.message === MSG_RESET_SENT_AGAIN ? "staff-reset-notice" : "staff-reset-error", err.message);
      return;
    }
    const message = genericError(err, "Versturen");
    setText("staff-reset-error", message);
    hooks.showToast(message, "error");
  } finally {
    setBusy(form, false);
    if (sent) {
      const submit = form.querySelector("button[type=submit]");
      if (submit) submit.disabled = true;
    }
  }
}

// --- Logout ----------------------------------------------------------------

// Logging out keeps this device's login key, so the next login is PIN only.
// "Andere startcode gebruiken" on the PIN screen replaces it with a new claim.
export async function logoutStaff(message) {
  const hadStaff = Boolean(currentStaff);
  currentStaff = null;
  pending = null;
  renderHeaderUser();
  try {
    await signOut(auth);
  } catch {
    // Still return to the login screen.
  }
  showLoginStart(typeof message === "string" ? message : "");
  if (hadStaff) hooks.onLoggedOut();
}

function bindUi() {
  const on = (id, type, fn) => {
    const el = $(id);
    if (el) el.addEventListener(type, fn);
  };
  on("staff-code-form", "submit", onCodeSubmit);
  on("staff-pin-setup-form", "submit", onPinSetupSubmit);
  on("staff-pin-form", "submit", onPinSubmit);
  on("staff-reset-form", "submit", onResetSubmit);
  on("staff-pin-forgot", "click", () => showStep("reset"));
  on("staff-code-forgot", "click", () => showStep("reset"));
  on("staff-pin-other", "click", () => { pending = null; showStep("code", { notice: "Vul de startcode in die je van je leidinggevende hebt gekregen. Daarmee wordt dit toestel aan jou gekoppeld." }); });
  on("staff-code-back", "click", () => { pending = null; showLoginStart(); });
  on("staff-setup-back", "click", () => { pending = null; showStep("code"); });
  on("staff-reset-back", "click", () => showLoginStart());
  ["staff-pin-new", "staff-pin-confirm", "staff-pin-input"].forEach((id) => {
    const input = $(id);
    if (input) digitsOnly(input);
  });
  const codeInput = $("staff-code-input");
  if (codeInput) startCodeInput(codeInput);
  on("logout-menu-btn", "click", () => { logoutStaff(); });
}

export function initStaffAuth(options) {
  hooks = {
    onLoggedIn: (options && options.onLoggedIn) || (() => {}),
    onLoggedOut: (options && options.onLoggedOut) || (() => {}),
    showToast: (options && options.showToast) || (() => {})
  };
  bindUi();
  renderHeaderUser();
  ensurePersistence();
  onAuthStateChanged(auth, async (user) => {
    if (authReady) return;
    authReady = true;
    try {
      if (user && !user.isAnonymous) {
        if (await restoreSession(user)) return;
        // finishSession already chose a screen when it refused the session.
        if (Object.values(LOGIN_STEPS).some((id) => $(id) && !$(id).classList.contains("hidden"))) return;
      }
    } catch {
      // Fall through to the login screen.
    }
    showLoginStart();
  });
}
