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
  setDoc,
  writeBatch,
  normalizeName,
  staffEmail,
  staffPassword,
  startCodeEmail,
  normalizeStartCode,
  formatStartCode,
  isValidStartCode
} from "./shared.js";

// Login model (agreed with ZLA, see zl-startcode-model.md):
// - First PIN / after a reset: name -> nameIndex -> one-time start code from the
//   admin (startCodes/{CODE}) -> choose PIN -> auth account
//   startCodeEmail(employeeId, pinVersion, code) -> one claim batch.
// - Login: name -> nameIndex {employeeId, hasPin, pinVersion, loginKey}
//   -> startCodeEmail(employeeId, pinVersion, loginKey) + PIN.
// - Accounts from before start codes (hasPin without loginKey) still log in
//   with the old staffEmail(employeeId, pinVersion) as long as the rules allow
//   it; if that fails they are asked for a new start code.
// - There is no way to claim an account with only a name.

const STORAGE_ID = "zeiklijst-staff-id";
const STORAGE_NAME_KEY = "zeiklijst-staff-name-key";
const STORAGE_NAME = "zeiklijst-staff-name";
const STORAGE_PIN_VERSION = "zeiklijst-staff-pin-version";
const STORAGE_LOGIN_KEY = "zeiklijst-staff-login-key";

const PIN_LENGTH = 6;

const MSG_NOT_FOUND = "Medewerker niet gevonden";
const MSG_INACTIVE = "Je account is niet actief. Neem contact op met je leidinggevende.";
const MSG_NO_ACCESS = "Je hebt geen toegang. Neem contact op met je leidinggevende.";
const MSG_ASK_NEW_CODE = "Vraag je leidinggevende om een nieuwe startcode.";
const MSG_CODE_FORMAT = "Een startcode bestaat uit 10 tekens, bijvoorbeeld ABCDE-FGH23.";
const MSG_CODE_INVALID = "Deze startcode klopt niet. Controleer de code of vraag je leidinggevende om een nieuwe startcode.";
const MSG_CODE_USED = "Deze startcode is al gebruikt. " + MSG_ASK_NEW_CODE;
const MSG_CODE_EXPIRED = "Deze startcode is verlopen. " + MSG_ASK_NEW_CODE;
const MSG_CODE_REPLACED = "Deze startcode is vervangen door een nieuwere. Gebruik de nieuwste code of vraag je leidinggevende om een nieuwe startcode.";
const MSG_PIN_RESET = "Je pincode is gereset. Vul de nieuwe startcode van je leidinggevende in.";
const MSG_NEEDS_CODE = "Vraag je leidinggevende om een nieuwe startcode";

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
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function loginKeyOf(value) {
  return normalizeStartCode(value).toLowerCase();
}

function expectedEmail(staff) {
  const email = staff.loginKey
    ? startCodeEmail(staff.employeeId, staff.pinVersion, staff.loginKey)
    : staffEmail(staff.employeeId, staff.pinVersion); // pre-start-code account
  return email.toLowerCase();
}

function storedStaff() {
  const employeeId = (localStorage.getItem(STORAGE_ID) || "").trim();
  const nameKey = (localStorage.getItem(STORAGE_NAME_KEY) || "").trim();
  const name = (localStorage.getItem(STORAGE_NAME) || "").trim();
  const pinVersion = pinVersionOf(localStorage.getItem(STORAGE_PIN_VERSION));
  const loginKey = loginKeyOf(localStorage.getItem(STORAGE_LOGIN_KEY));
  if (!employeeId || !nameKey) return null;
  return { employeeId, nameKey, name: name || nameKey, pinVersion, loginKey };
}

function persistStaff(staff) {
  localStorage.setItem(STORAGE_ID, staff.employeeId);
  localStorage.setItem(STORAGE_NAME_KEY, staff.nameKey);
  localStorage.setItem(STORAGE_NAME, staff.name);
  localStorage.setItem(STORAGE_PIN_VERSION, String(staff.pinVersion));
  localStorage.setItem(STORAGE_LOGIN_KEY, staff.loginKey || "");
}

function clearStoredStaff() {
  localStorage.removeItem(STORAGE_ID);
  localStorage.removeItem(STORAGE_NAME_KEY);
  localStorage.removeItem(STORAGE_NAME);
  localStorage.removeItem(STORAGE_PIN_VERSION);
  localStorage.removeItem(STORAGE_LOGIN_KEY);
}

function screenshotLoginStep() {
  const value = new URLSearchParams(location.search).get("showLogin");
  if (value === "setup" || value === "pin" || value === "name" || value === "code") return value;
  return "";
}

function screenshotPreviewStaff() {
  const params = new URLSearchParams(location.search);
  return params.get("showAddTask") === "1" || params.get("showReport") === "1";
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
  if (isPermission(err)) return "Inloggen is nu niet beschikbaar. Probeer het later opnieuw.";
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
  if (code === "auth/operation-not-allowed" || isPermission(err)) {
    return "Inloggen is nu niet beschikbaar. Probeer het later opnieuw.";
  }
  return "Inloggen is mislukt. Probeer het opnieuw.";
}

function writeErrorMessage(err) {
  if (isOffline(err)) return "Geen verbinding. Probeer het opnieuw als je weer online bent.";
  if (isPermission(err)) return "Versturen is nu niet beschikbaar. Probeer het later opnieuw.";
  return "Versturen is mislukt. Probeer het opnieuw.";
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

function setNotice(id, message) {
  setError(id, message);
}

function setBusy(form, busy) {
  if (!form) return;
  form.querySelectorAll("button, input").forEach((el) => {
    el.disabled = Boolean(busy);
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
  name: "staff-name-form",
  code: "staff-code-form",
  setup: "staff-pin-setup-form",
  pin: "staff-pin-form"
};

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
  ["staff-name-error", "staff-code-error", "staff-pin-setup-error", "staff-pin-error"].forEach((id) => setError(id, ""));
  setNotice("staff-login-notice", step === "name" ? options.notice || "" : "");
  setNotice("staff-pin-notice", step === "pin" ? options.notice || "" : "");
  if (step === "code") {
    setError("staff-code-error", options.notice || "");
    const codeInput = $("staff-code-input");
    if (codeInput) codeInput.value = "";
  }
  const hello = $("staff-pin-hello");
  if (hello) {
    hello.textContent = pending && pending.name
      ? `Hoi ${pending.name}, vul je pincode in.`
      : "Vul je pincode in.";
  }
  const codeHello = $("staff-code-hello");
  if (codeHello) {
    codeHello.textContent = pending && pending.name
      ? `Hoi ${pending.name}, vul de startcode in die je van je leidinggevende hebt gekregen.`
      : "Vul de startcode in die je van je leidinggevende hebt gekregen.";
  }
  ["staff-setup-username", "staff-pin-username"].forEach((id) => {
    const el = $(id);
    if (el) el.value = pending && pending.name ? pending.name : "";
  });
  const focusId = {
    name: "staff-name-input",
    code: "staff-code-input",
    setup: "staff-pin-new",
    pin: "staff-pin-input"
  }[step];
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
  const reportBtn = $("report-menu-btn");
  if (reportBtn) reportBtn.classList.toggle("hidden", !name);
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

async function readNameIndex(nameKey) {
  const snap = await getDoc(doc(db, "nameIndex", nameKey));
  if (!snap.exists()) return null;
  const data = snap.data() || {};
  const employeeId = String(data.employeeId || "").trim();
  if (!employeeId) return null;
  return {
    employeeId,
    hasPin: data.hasPin === true,
    pinVersion: pinVersionOf(data.pinVersion),
    loginKey: loginKeyOf(data.loginKey)
  };
}

function millisOf(value) {
  if (!value) return NaN;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  return new Date(value).getTime();
}

// Reads employees/{id} with the signed-in staff account.
// Returns { ok: true, name } or { ok: false, message }.
async function checkEmployeeActive(staff) {
  try {
    const snap = await getDoc(doc(db, "employees", staff.employeeId));
    if (!snap.exists()) return { ok: false, message: MSG_NOT_FOUND };
    const data = snap.data() || {};
    if (data.active === false) return { ok: false, message: MSG_INACTIVE };
    return { ok: true, name: String(data.name || "").trim() };
  } catch (err) {
    // Offline: keep the (already authenticated) session; the rules still
    // refuse all data for inactive staff once the phone is online again.
    if (isOffline(err) && !isPermission(err)) return { ok: true, name: "" };
    if (isPermission(err)) return { ok: false, message: MSG_NO_ACCESS };
    return { ok: false, message: lookupErrorMessage(err) };
  }
}

async function refuseSession(message) {
  currentStaff = null;
  pending = null;
  clearStoredStaff();
  renderHeaderUser();
  await signOut(auth).catch(() => {});
  showStep("name", { notice: message });
}

async function finishStaffSession(staff) {
  const check = await checkEmployeeActive(staff);
  if (!check.ok) {
    // An old (pre-start-code) account that the rules no longer accept.
    const message = !staff.loginKey && check.message === MSG_NO_ACCESS ? MSG_NEEDS_CODE : check.message;
    await refuseSession(message);
    return false;
  }
  if (check.name) staff.name = check.name;
  acceptStaff(staff);
  return true;
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
    if (isOffline(err) && !isPermission(err)) {
      // Offline start: keep the stored session (cached data only).
      acceptStaff(stored);
      return true;
    }
    await refuseSession(isPermission(err) ? MSG_NO_ACCESS : lookupErrorMessage(err));
    return "refused";
  }
  if (!index || index.employeeId !== stored.employeeId) {
    await refuseSession("");
    return "refused";
  }
  const staff = { ...stored, pinVersion: index.pinVersion, loginKey: index.loginKey };
  const email = String((user && user.email) || "").toLowerCase();
  if (!index.hasPin || email !== expectedEmail(staff)) {
    // PIN was reset: a new start code is needed.
    await signOut(auth).catch(() => {});
    clearStoredStaff();
    pending = {
      employeeId: index.employeeId,
      nameKey: stored.nameKey,
      name: stored.name,
      pinVersion: index.pinVersion,
      hasPin: index.hasPin,
      loginKey: index.loginKey,
      startCode: ""
    };
    showStep("code", { notice: MSG_PIN_RESET });
    return "setup";
  }
  const ok = await finishStaffSession(staff);
  return ok ? true : "refused";
}

function goBackToName() {
  pending = null;
  ["staff-pin-new", "staff-pin-confirm", "staff-pin-input", "staff-code-input"].forEach((id) => {
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
  setNotice("staff-login-notice", "");
  if (!typed) {
    setError("staff-name-error", "Vul je naam in.");
    return;
  }
  const nameKey = normalizeName(typed);
  if (!nameKey) {
    setError("staff-name-error", MSG_NOT_FOUND);
    return;
  }
  setBusy(form, true);
  try {
    await ensureAnonymous();
    const index = await readNameIndex(nameKey);
    if (!index) {
      setError("staff-name-error", MSG_NOT_FOUND);
      return;
    }
    pending = {
      employeeId: index.employeeId,
      nameKey,
      name: typed,
      pinVersion: index.pinVersion,
      hasPin: index.hasPin,
      loginKey: index.loginKey,
      startCode: ""
    };
    if (index.hasPin) showStep("pin");
    else showStep("code");
  } catch (err) {
    setError("staff-name-error", lookupErrorMessage(err));
  } finally {
    setBusy(form, false);
  }
}

async function onCodeSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  setError("staff-code-error", "");
  if (!pending) {
    showStep("name");
    return;
  }
  const code = normalizeStartCode(($("staff-code-input") && $("staff-code-input").value) || "");
  if (!isValidStartCode(code)) {
    setError("staff-code-error", MSG_CODE_FORMAT);
    return;
  }
  setBusy(form, true);
  try {
    await ensureAnonymous();
    const snap = await getDoc(doc(db, "startCodes", code));
    if (!snap.exists()) {
      setError("staff-code-error", MSG_CODE_INVALID);
      return;
    }
    const data = snap.data() || {};
    if (String(data.employeeId || "") !== pending.employeeId) {
      // Do not reveal that the code belongs to someone else.
      setError("staff-code-error", MSG_CODE_INVALID);
      return;
    }
    if (data.used === true) {
      setError("staff-code-error", MSG_CODE_USED);
      return;
    }
    const expires = millisOf(data.expiresAt);
    if (!Number.isFinite(expires) || expires <= Date.now()) {
      setError("staff-code-error", MSG_CODE_EXPIRED);
      return;
    }
    if (pinVersionOf(data.pinVersion) !== pending.pinVersion) {
      setError("staff-code-error", MSG_CODE_REPLACED);
      return;
    }
    pending.startCode = code;
    showStep("setup");
  } catch (err) {
    setError("staff-code-error", lookupErrorMessage(err));
  } finally {
    setBusy(form, false);
  }
}

// One batch; the rules check code, employee, pinVersion, active and token email.
async function claimStartCode(user, staff, code) {
  const batch = writeBatch(db);
  batch.set(doc(db, "staffAccounts", user.uid), {
    employeeId: staff.employeeId,
    pinVersion: staff.pinVersion,
    startCode: code
  });
  batch.update(doc(db, "startCodes", code), {
    used: true,
    usedBy: user.uid,
    usedAt: serverTimestamp()
  });
  batch.update(doc(db, "nameIndex", staff.nameKey), {
    hasPin: true,
    loginKey: code.toLowerCase()
  });
  await batch.commit();
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
  if (!pending.startCode || !isValidStartCode(pending.startCode)) {
    showStep("code");
    return;
  }
  if (!validPin(pin) || !validPin(confirm)) {
    setError("staff-pin-setup-error", `Kies een pincode van ${PIN_LENGTH} cijfers.`);
    return;
  }
  if (pin !== confirm) {
    setError("staff-pin-setup-error", "Pincodes komen niet overeen.");
    return;
  }
  if (weakPin(pin)) {
    setError("staff-pin-setup-error", "Deze pincode is te makkelijk te raden. Kies een andere.");
    return;
  }
  setBusy(form, true);
  const code = pending.startCode;
  const staff = {
    employeeId: pending.employeeId,
    nameKey: pending.nameKey,
    name: pending.name,
    pinVersion: pending.pinVersion,
    loginKey: code.toLowerCase()
  };
  const email = startCodeEmail(staff.employeeId, staff.pinVersion, code);
  const password = staffPassword(pin, staff.employeeId);
  let user = null;
  try {
    await ensurePersistence();
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      user = cred.user;
    } catch (err) {
      if (!(err && err.code === "auth/email-already-in-use")) throw err;
      // An earlier attempt with this code created the account but the claim
      // did not save. Only the same PIN can resume it.
      try {
        const cred = await signInWithEmailAndPassword(auth, email, password);
        user = cred.user;
      } catch (signInErr) {
        if (isOffline(signInErr)) throw signInErr;
        setError("staff-pin-setup-error", MSG_CODE_USED);
        setBusy(form, false);
        return;
      }
    }
  } catch (err) {
    setError("staff-pin-setup-error", pinAuthErrorMessage(err));
    setBusy(form, false);
    return;
  }
  try {
    await claimStartCode(user, staff, code);
  } catch (err) {
    // Remove the just-created auth account so no orphan stays behind. If that
    // fails, a retry with the same PIN signs in to it (email-already-in-use)
    // and repeats the batch; a second user is never created.
    await deleteUser(user).catch(() => {});
    await signOut(auth).catch(() => {});
    if (isPermission(err)) {
      setError(
        "staff-pin-setup-error",
        "Pincode instellen is niet gelukt. De startcode is niet meer geldig of je account is niet actief. Neem contact op met je leidinggevende."
      );
    } else {
      setError(
        "staff-pin-setup-error",
        `${isOffline(err) ? "Geen verbinding." : "Opslaan is mislukt."} Probeer het opnieuw met dezelfde pincode.`
      );
    }
    setBusy(form, false);
    return;
  }
  try {
    await finishStaffSession(staff);
  } finally {
    setBusy(form, false);
  }
}

async function onPinSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const pin = ($("staff-pin-input") && $("staff-pin-input").value) || "";
  setError("staff-pin-error", "");
  setNotice("staff-pin-notice", "");
  if (!pending) {
    showStep("name");
    return;
  }
  if (!validPin(pin)) {
    setError("staff-pin-error", `Vul je pincode van ${PIN_LENGTH} cijfers in.`);
    return;
  }
  setBusy(form, true);
  try {
    await ensurePersistence();
    const staff = {
      employeeId: pending.employeeId,
      nameKey: pending.nameKey,
      name: pending.name,
      pinVersion: pending.pinVersion,
      loginKey: pending.loginKey
    };
    await signInWithEmailAndPassword(auth, expectedEmail(staff), staffPassword(pin, staff.employeeId));
    await finishStaffSession(staff);
  } catch (err) {
    const message = pinAuthErrorMessage(err);
    // Old login method failed (wrong PIN, or closed in the rules).
    setError("staff-pin-error", !pending.loginKey && message === "Onjuiste pincode"
      ? `Inloggen lukt niet. ${MSG_NEEDS_CODE}`
      : message);
  } finally {
    setBusy(form, false);
  }
}

// A reset request only notifies the admin. It gives no access: the employee
// can only set a new PIN with a new start code from the admin.
async function onForgotPin() {
  if (!pending) {
    showStep("name");
    return;
  }
  const btn = $("staff-pin-forgot");
  if (btn) btn.disabled = true;
  setError("staff-pin-error", "");
  setNotice("staff-pin-notice", "");
  try {
    await ensureAnonymous();
    await setDoc(doc(db, "pinResetRequests", pending.employeeId), {
      employeeId: pending.employeeId,
      name: pending.name,
      requestedAt: serverTimestamp()
    });
    setNotice("staff-pin-notice", `Verzoek verstuurd. ${MSG_ASK_NEW_CODE}`);
    hooks.showToast(`Verzoek verstuurd. ${MSG_ASK_NEW_CODE}`, "success");
  } catch (err) {
    const message = writeErrorMessage(err);
    setError("staff-pin-error", message);
    hooks.showToast(message, "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

export async function logoutStaff(message) {
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
  showStep("name", { notice: typeof message === "string" ? message : "" });
  if (hadStaff) hooks.onLoggedOut();
}

function bindUi() {
  const nameForm = $("staff-name-form");
  const codeForm = $("staff-code-form");
  const setupForm = $("staff-pin-setup-form");
  const pinForm = $("staff-pin-form");
  if (nameForm) nameForm.addEventListener("submit", onNameSubmit);
  if (codeForm) codeForm.addEventListener("submit", onCodeSubmit);
  if (setupForm) setupForm.addEventListener("submit", onPinSetupSubmit);
  if (pinForm) pinForm.addEventListener("submit", onPinSubmit);
  const forgot = $("staff-pin-forgot");
  if (forgot) forgot.addEventListener("click", onForgotPin);
  ["staff-pin-back", "staff-setup-back", "staff-code-back"].forEach((id) => {
    const btn = $(id);
    if (btn) btn.addEventListener("click", goBackToName);
  });
  ["staff-pin-new", "staff-pin-confirm", "staff-pin-input"].forEach((id) => {
    const input = $(id);
    if (input) digitsOnly(input);
  });
  const codeInput = $("staff-code-input");
  if (codeInput) startCodeInput(codeInput);
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

  if (screenshotPreviewStaff()) {
    currentStaff = { employeeId: "demo", nameKey: "demo", name: "Demo", pinVersion: 0, loginKey: "" };
    renderHeaderUser();
    hideLogin();
    return;
  }

  const forced = screenshotLoginStep();
  if (forced) {
    if (forced !== "name") {
      pending = {
        employeeId: "demo",
        nameKey: "demo",
        name: "Demo",
        pinVersion: 0,
        hasPin: forced === "pin",
        loginKey: forced === "pin" ? "demo" : "",
        startCode: ""
      };
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
        if (result) return;
      }
    } catch {
      // Fall through to the name screen.
    }
    showStep("name");
  });
}
