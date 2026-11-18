import {
  auth,
  onAuthStateChanged,
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut
} from "./firebase-init.js";
import {
  createUserWithEmailAndPassword,
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
  setDoc,
  normalizeName,
  staffEmail,
  staffPassword
} from "./shared.js";

const STORAGE_ID = "zeiklijst-staff-id";
const STORAGE_NAME_KEY = "zeiklijst-staff-name-key";
const STORAGE_NAME = "zeiklijst-staff-name";
const STORAGE_PIN_VERSION = "zeiklijst-staff-pin-version";

let currentStaff = null;
let pending = null;
let hooks = { onLoggedIn: () => {}, onLoggedOut: () => {}, showToast: () => {} };
let persistenceReady = null;
let authReady = false;

export function getCurrentStaff() {
  return currentStaff;
}

export function setStaffDisplayName(name) {
  const value = String(name || "").trim();
  if (!currentStaff || !value) return currentStaff;
  currentStaff = { ...currentStaff, name: value };
  persistStaff(currentStaff);
  renderHeaderUser();
  return currentStaff;
}

function pinVersionOf(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function storedStaff() {
  const employeeId = (localStorage.getItem(STORAGE_ID) || "").trim();
  const nameKey = (localStorage.getItem(STORAGE_NAME_KEY) || "").trim();
  const name = (localStorage.getItem(STORAGE_NAME) || "").trim();
  const pinVersion = pinVersionOf(localStorage.getItem(STORAGE_PIN_VERSION));
  if (!employeeId || !nameKey) return null;
  return { employeeId, nameKey, name: name || nameKey, pinVersion };
}

function persistStaff(staff) {
  localStorage.setItem(STORAGE_ID, staff.employeeId);
  localStorage.setItem(STORAGE_NAME_KEY, staff.nameKey);
  localStorage.setItem(STORAGE_NAME, staff.name);
  localStorage.setItem(STORAGE_PIN_VERSION, String(staff.pinVersion));
}

function clearStoredStaff() {
  localStorage.removeItem(STORAGE_ID);
  localStorage.removeItem(STORAGE_NAME_KEY);
  localStorage.removeItem(STORAGE_NAME);
  localStorage.removeItem(STORAGE_PIN_VERSION);
}

function screenshotLoginStep() {
  const value = new URLSearchParams(location.search).get("showLogin");
  if (value === "setup" || value === "pin" || value === "name") return value;
  return "";
}

function isOffline(err) {
  const code = String((err && err.code) || "");
  const message = String((err && err.message) || err || "");
  return (typeof navigator !== "undefined" && navigator.onLine === false)
    || /unavailable|offline|network-request-failed|Failed to get document|network/i.test(`${code} ${message}`);
}

function isPermission(err) {
  const code = String((err && err.code) || "");
  const message = String((err && err.message) || err || "");
  return /permission-denied/i.test(`${code} ${message}`);
}

function lookupErrorMessage(err) {
  if (isOffline(err)) return "Geen verbinding. Probeer het opnieuw als je weer online bent.";
  if (isPermission(err)) return "Inloggen is nog niet beschikbaar. Probeer het later opnieuw.";
  return "Opzoeken is mislukt. Probeer het opnieuw.";
}

function pinAuthErrorMessage(err) {
  const code = String((err && err.code) || "");
  if (code === "auth/too-many-requests") {
    return "Te veel pogingen. Probeer het later opnieuw.";
  }
  if (
    code === "auth/wrong-password"
    || code === "auth/invalid-credential"
    || code === "auth/invalid-login-credentials"
    || code === "auth/user-not-found"
    || code === "auth/invalid-email"
  ) {
    return "Onjuiste pincode";
  }
  if (isOffline(err)) return "Geen verbinding. Probeer het opnieuw als je weer online bent.";
  if (code === "auth/email-already-in-use") return "Onjuiste pincode";
  if (code === "auth/operation-not-allowed" || isPermission(err)) {
    return "Inloggen is nog niet beschikbaar. Probeer het later opnieuw.";
  }
  return "Inloggen is mislukt. Probeer het opnieuw.";
}

function writeErrorMessage(err) {
  if (isOffline(err)) return "Geen verbinding. Probeer het opnieuw als je weer online bent.";
  if (isPermission(err)) return "Opslaan is nog niet beschikbaar. Probeer het later opnieuw.";
  return "Opslaan is mislukt. Probeer het opnieuw.";
}

function $(id) {
  return document.getElementById(id);
}

function setError(id, message) {
  const el = $(id);
  if (!el) return;
  el.textContent = message || "";
  el.classList.toggle("hidden", !message);
}

function setBusy(form, busy) {
  if (!form) return;
  form.querySelectorAll("button, input").forEach((el) => {
    el.disabled = Boolean(busy);
  });
}

function digitsOnly(input) {
  input.addEventListener("input", () => {
    input.value = input.value.replace(/\D/g, "").slice(0, 6);
  });
}

function validPin(value) {
  return /^\d{4,6}$/.test(value);
}

function showStep(step) {
  const login = $("staff-login");
  const nameForm = $("staff-name-form");
  const setupForm = $("staff-pin-setup-form");
  const pinForm = $("staff-pin-form");
  if (!login) return;
  login.classList.remove("hidden");
  login.hidden = false;
  document.body.classList.add("is-locked");
  nameForm.classList.toggle("hidden", step !== "name");
  setupForm.classList.toggle("hidden", step !== "setup");
  pinForm.classList.toggle("hidden", step !== "pin");
  setError("staff-name-error", "");
  setError("staff-pin-setup-error", "");
  setError("staff-pin-error", "");
  const hello = $("staff-pin-hello");
  if (hello) {
    hello.textContent = pending && pending.name
      ? `Hoi ${pending.name}, vul je pincode in.`
      : "Vul je pincode in.";
  }
  ["staff-setup-username", "staff-pin-username"].forEach((id) => {
    const el = $(id);
    if (el) el.value = pending && pending.name ? pending.name : "";
  });
  const focusId = step === "setup"
    ? "staff-pin-new"
    : step === "pin"
      ? "staff-pin-input"
      : "staff-name-input";
  const focusEl = $(focusId);
  if (focusEl) {
    try { focusEl.focus(); } catch { /* ignore */ }
  }
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
  const logoutBtn = $("logout-menu-btn");
  if (header) {
    header.textContent = name;
    header.classList.toggle("hidden", !name);
    header.hidden = !name;
  }
  if (menu) {
    menu.textContent = name ? `Ingelogd als ${name}` : "";
    menu.classList.toggle("hidden", !name);
  }
  if (logoutBtn) logoutBtn.classList.toggle("hidden", !name);
}

function acceptStaff(staff) {
  currentStaff = staff;
  persistStaff(staff);
  pending = null;
  renderHeaderUser();
  hideLogin();
  hooks.onLoggedIn(staff);
}

async function ensurePersistence() {
  if (!persistenceReady) {
    persistenceReady = setPersistence(auth, browserLocalPersistence).catch(() => {});
  }
  await persistenceReady;
}

async function ensureAnonymous() {
  await ensurePersistence();
  if (auth.currentUser && auth.currentUser.isAnonymous) return auth.currentUser;
  if (auth.currentUser && !auth.currentUser.isAnonymous) {
    await signOut(auth);
  }
  const cred = await signInAnonymously(auth);
  return cred.user;
}

async function refreshDisplayName(staff) {
  try {
    const snap = await getDoc(doc(db, "employees", staff.employeeId));
    if (snap.exists()) {
      const name = String((snap.data() || {}).name || "").trim();
      if (name) staff.name = name;
    }
  } catch {
    // Official name is optional; the typed name is enough.
  }
  return staff;
}

async function readNameIndex(nameKey) {
  const snap = await getDoc(doc(db, "nameIndex", nameKey));
  if (!snap.exists()) return null;
  const data = snap.data() || {};
  const employeeId = String(data.employeeId || "").trim();
  if (!employeeId) return null;
  return {
    employeeId,
    hasPin: data.hasPin === true,
    pinVersion: pinVersionOf(data.pinVersion)
  };
}

async function finishStaffSession(staff) {
  await refreshDisplayName(staff);
  acceptStaff(staff);
}

async function verifyExistingSession(user) {
  const stored = storedStaff();
  if (!stored) {
    await signOut(auth).catch(() => {});
    return false;
  }
  let index;
  try {
    index = await readNameIndex(stored.nameKey);
  } catch (err) {
    if (isPermission(err) || isOffline(err)) {
      // Rules may not be published yet; keep the stored staff session.
      await finishStaffSession(stored);
      return true;
    }
    throw err;
  }
  if (!index || index.employeeId !== stored.employeeId) {
    await signOut(auth).catch(() => {});
    clearStoredStaff();
    return false;
  }
  if (!index.hasPin || stored.pinVersion < index.pinVersion) {
    await signOut(auth).catch(() => {});
    pending = {
      employeeId: index.employeeId,
      nameKey: stored.nameKey,
      name: stored.name,
      pinVersion: index.pinVersion,
      hasPin: false
    };
    showStep("setup");
    return "setup";
  }
  stored.pinVersion = index.pinVersion;
  await finishStaffSession(stored);
  return true;
}

function goBackToName() {
  pending = null;
  ["staff-pin-new", "staff-pin-confirm", "staff-pin-input"].forEach((id) => {
    const el = $(id);
    if (el) el.value = "";
  });
  showStep("name");
}

async function onNameSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const input = $("staff-name-input");
  const typed = (input && input.value || "").trim();
  setError("staff-name-error", "");
  if (!typed) {
    setError("staff-name-error", "Vul je naam in.");
    return;
  }
  const nameKey = normalizeName(typed);
  if (!nameKey) {
    setError("staff-name-error", "Naam niet gevonden");
    return;
  }
  setBusy(form, true);
  try {
    await ensureAnonymous();
    const index = await readNameIndex(nameKey);
    if (!index) {
      setError("staff-name-error", "Naam niet gevonden");
      return;
    }
    pending = {
      employeeId: index.employeeId,
      nameKey,
      name: typed,
      pinVersion: index.pinVersion,
      hasPin: index.hasPin
    };
    if (index.hasPin) showStep("pin");
    else showStep("setup");
  } catch (err) {
    setError("staff-name-error", lookupErrorMessage(err));
  } finally {
    setBusy(form, false);
  }
}

async function writePostSignupDocs(user, staff) {
  let failed = null;
  try {
    await setDoc(doc(db, "staffAccounts", user.uid), {
      employeeId: staff.employeeId,
      pinVersion: Math.trunc(pinVersionOf(staff.pinVersion))
    });
  } catch (err) {
    failed = err;
  }
  try {
    await setDoc(doc(db, "nameIndex", staff.nameKey), { hasPin: true }, { merge: true });
  } catch (err) {
    failed = failed || err;
  }
  if (failed) hooks.showToast(writeErrorMessage(failed), "error");
  return !failed;
}

async function onPinSetupSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const pin = ($("staff-pin-new") && $("staff-pin-new").value) || "";
  const confirm = ($("staff-pin-confirm") && $("staff-pin-confirm").value) || "";
  setError("staff-pin-setup-error", "");
  if (!pending) {
    showStep("name");
    return;
  }
  if (!validPin(pin) || !validPin(confirm)) {
    setError("staff-pin-setup-error", "Kies een pincode van 4 tot 6 cijfers.");
    return;
  }
  if (pin !== confirm) {
    setError("staff-pin-setup-error", "Pincodes komen niet overeen.");
    return;
  }
  setBusy(form, true);
  try {
    await ensurePersistence();
    const email = staffEmail(pending.employeeId, pending.pinVersion);
    const password = staffPassword(pin, pending.employeeId);
    let user;
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      user = cred.user;
    } catch (err) {
      if (err && err.code === "auth/email-already-in-use") {
        const cred = await signInWithEmailAndPassword(auth, email, password);
        user = cred.user;
      } else {
        throw err;
      }
    }
    const staff = {
      employeeId: pending.employeeId,
      nameKey: pending.nameKey,
      name: pending.name,
      pinVersion: pending.pinVersion
    };
    await writePostSignupDocs(user, staff);
    await finishStaffSession(staff);
  } catch (err) {
    setError("staff-pin-setup-error", pinAuthErrorMessage(err));
  } finally {
    setBusy(form, false);
  }
}

async function onPinSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const pin = ($("staff-pin-input") && $("staff-pin-input").value) || "";
  setError("staff-pin-error", "");
  if (!pending) {
    showStep("name");
    return;
  }
  if (!validPin(pin)) {
    setError("staff-pin-error", "Vul een pincode van 4 tot 6 cijfers in.");
    return;
  }
  setBusy(form, true);
  try {
    await ensurePersistence();
    const email = staffEmail(pending.employeeId, pending.pinVersion);
    const password = staffPassword(pin, pending.employeeId);
    await signInWithEmailAndPassword(auth, email, password);
    const staff = {
      employeeId: pending.employeeId,
      nameKey: pending.nameKey,
      name: pending.name,
      pinVersion: pending.pinVersion
    };
    await finishStaffSession(staff);
  } catch (err) {
    setError("staff-pin-error", pinAuthErrorMessage(err));
  } finally {
    setBusy(form, false);
  }
}

async function onForgotPin() {
  if (!pending) {
    showStep("name");
    return;
  }
  const btn = $("staff-pin-forgot");
  if (btn) btn.disabled = true;
  setError("staff-pin-error", "");
  try {
    await ensureAnonymous();
    await setDoc(doc(db, "pinResetRequests", pending.employeeId), {
      employeeId: pending.employeeId,
      name: pending.name,
      requestedAt: serverTimestamp()
    });
    hooks.showToast("Verzoek verstuurd, vraag je leidinggevende om je pincode te resetten", "success");
  } catch (err) {
    const message = writeErrorMessage(err);
    setError("staff-pin-error", message);
    hooks.showToast(message, "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

export async function logoutStaff() {
  const hadStaff = Boolean(currentStaff);
  currentStaff = null;
  pending = null;
  clearStoredStaff();
  renderHeaderUser();
  try {
    await signOut(auth);
  } catch {
    // Still return to the login screen.
  }
  showStep("name");
  if (hadStaff) hooks.onLoggedOut();
}

function bindUi() {
  const nameForm = $("staff-name-form");
  const setupForm = $("staff-pin-setup-form");
  const pinForm = $("staff-pin-form");
  if (nameForm) nameForm.addEventListener("submit", onNameSubmit);
  if (setupForm) setupForm.addEventListener("submit", onPinSetupSubmit);
  if (pinForm) pinForm.addEventListener("submit", onPinSubmit);
  const forgot = $("staff-pin-forgot");
  if (forgot) forgot.addEventListener("click", onForgotPin);
  ["staff-pin-back", "staff-setup-back"].forEach((id) => {
    const btn = $(id);
    if (btn) btn.addEventListener("click", goBackToName);
  });
  ["staff-pin-new", "staff-pin-confirm", "staff-pin-input"].forEach((id) => {
    const input = $(id);
    if (input) digitsOnly(input);
  });
  const logoutBtn = $("logout-menu-btn");
  if (logoutBtn) logoutBtn.addEventListener("click", () => { logoutStaff(); });
}

export function initStaffAuth(options) {
  hooks = {
    onLoggedIn: (options && options.onLoggedIn) || (() => {}),
    onLoggedOut: (options && options.onLoggedOut) || (() => {}),
    showToast: (options && options.showToast) || (() => {})
  };
  bindUi();
  renderHeaderUser();

  const forced = screenshotLoginStep();
  if (forced) {
    if (forced === "setup") {
      pending = { employeeId: "demo", nameKey: "demo", name: "Demo", pinVersion: 0, hasPin: false };
    } else if (forced === "pin") {
      pending = { employeeId: "demo", nameKey: "demo", name: "Demo", pinVersion: 0, hasPin: true };
    }
    showStep(forced);
    return;
  }

  ensurePersistence();
  onAuthStateChanged(auth, async (user) => {
    if (authReady) return;
    authReady = true;
    try {
      if (user && !user.isAnonymous) {
        const result = await verifyExistingSession(user);
        if (result === true || result === "setup") return;
      }
    } catch {
      // Fall through to the name screen.
    }
    showStep("name");
  });
}
