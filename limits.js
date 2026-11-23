// Server-enforced limits (ZLA contract zla-step4-status.md §2, rules 4a263a4).
// The counters in Firestore are leading; this module only pre-checks with the
// server copy and builds the exact batches the rules require.
import { getDocFromServer, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";
import { db, doc, collection, writeBatch } from "./shared.js?v=22";

// Contract §1 – must equal the rules exactly.
export const MAX_TASKS_PER_DAY = 10;
export const MAX_REPORTS_PER_DAY = 5;
export const SUBMIT_COOLDOWN_MS = 15000;      // shared by task + report
export const SUBMIT_COOLDOWN_CHECK_MS = 16000; // contract §2d: 16 s margin for clock skew
export const RESET_UID_COOLDOWN_MS = 600000;   // pinResetLimits/{uid}
export const RESET_GLOBAL_COOLDOWN_MS = 60000; // pinResetLimits/_global
export const RESET_GLOBAL_PER_DAY = 20;
export const RETRY_DELAY_MS = 16000;           // §2d.2: one automatic retry after 16 s

// Contract §2d texts.
export const MSG_TASKS_DAY = `Je kunt maximaal ${MAX_TASKS_PER_DAY} eigen taken per dag toevoegen.`;
export const MSG_REPORTS_DAY = `Je kunt maximaal ${MAX_REPORTS_PER_DAY} meldingen per dag versturen.`;
export const msgCooldown = (sec) => `Even wachten, je kunt over ${sec} seconden weer iets versturen.`;
export const MSG_RESET_UID = "Je verzoek is al verstuurd. Je leidinggevende geeft je persoonlijk een nieuwe startcode.";
export const MSG_RESET_GLOBAL_WAIT = "Er is net een verzoek verstuurd. Probeer het over een minuut opnieuw.";
export const MSG_RESET_GLOBAL_DAY = "Vandaag kunnen er geen verzoeken meer worden verstuurd. Vraag je leidinggevende persoonlijk om een nieuwe startcode.";
export const MSG_OFFLINE = "Geen verbinding. Probeer het opnieuw als je weer online bent.";

// Fixed UTC+1 day number, identical to the rules' staffDayNumber(). Not Europe/Amsterdam.
export function dayNumber(nowMs = Date.now()) {
  return Math.floor((nowMs + 3600000) / 86400000);
}

export class LimitError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = "LimitError";
    this.isLimit = true;
    this.kind = kind; // "count" (hard) | "cooldown" | "offline"
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isPermission(err) {
  return /permission-denied/i.test(`${(err && err.code) || ""} ${(err && err.message) || ""}`);
}

function millis(ts) {
  if (!ts) return NaN;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  return new Date(ts).getTime();
}

function requireOnline() {
  // §2: only send online; a queued batch arriving after the day change is refused.
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    throw new LimitError(MSG_OFFLINE, "offline");
  }
}

// --- Own task / report (contract §2a/§2b) ----------------------------------

async function readStaffCounter(employeeId) {
  const ref = doc(db, "staffDailyCounters", employeeId);
  const snap = await getDocFromServer(ref);
  const today = dayNumber();
  const prev = snap.exists() ? snap.data() : null;
  const same = Boolean(prev) && prev.day === today;
  return { ref, today, prev, same };
}

// Returns a LimitError or null.
export function staffCounterBlock(kind, c) {
  if (kind === "task" && c.same && c.prev.tasks >= MAX_TASKS_PER_DAY) return new LimitError(MSG_TASKS_DAY, "count");
  if (kind === "report" && c.same && c.prev.reports >= MAX_REPORTS_PER_DAY) return new LimitError(MSG_REPORTS_DAY, "count");
  if (c.prev) {
    const since = Date.now() - millis(c.prev.lastAt);
    if (since < SUBMIT_COOLDOWN_CHECK_MS) {
      return new LimitError(msgCooldown(Math.max(1, Math.ceil((SUBMIT_COOLDOWN_CHECK_MS - since) / 1000))), "cooldown");
    }
  }
  return null;
}

async function staffAttempt(kind, payload, employeeId) {
  requireOnline();
  const c = await readStaffCounter(employeeId);
  const block = staffCounterBlock(kind, c);
  if (block) throw block;
  const ref = doc(collection(db, kind === "task" ? "tasks" : "reports"));
  const batch = writeBatch(db);
  batch.set(ref, payload);
  batch.set(c.ref, {
    day: c.today,
    tasks: (c.same ? c.prev.tasks : 0) + (kind === "task" ? 1 : 0),
    reports: (c.same ? c.prev.reports : 0) + (kind === "report" ? 1 : 0),
    lastAt: serverTimestamp(),
    lastType: kind,
    lastId: ref.id
  });
  await batch.commit();
  return ref.id;
}

// kind: "task" | "report". onWait(message) is called before the single retry.
export async function sendWithStaffCounter(kind, payload, employeeId, onWait) {
  try {
    return await staffAttempt(kind, payload, employeeId);
  } catch (err) {
    if (!isPermission(err)) throw err;
    // §2d.2: re-read the counter from the server and explain.
    const c = await readStaffCounter(employeeId);
    const block = staffCounterBlock(kind, c);
    if (block && block.kind === "count") throw block;
    // Cooldown (e.g. another device just sent) or nothing visible: one retry after 16 s.
    if (onWait) onWait(msgCooldown(Math.round(RETRY_DELAY_MS / 1000)));
    await sleep(RETRY_DELAY_MS);
    try {
      return await staffAttempt(kind, payload, employeeId);
    } catch (err2) {
      if (err2 && err2.isLimit) throw err2;
      if (!isPermission(err2)) throw err2;
      const c2 = await readStaffCounter(employeeId);
      const block2 = staffCounterBlock(kind, c2);
      if (block2) throw block2;
      throw err2;
    }
  }
}

// --- PIN reset request (contract §2c) --------------------------------------

async function readResetLimits(uid) {
  const uidRef = doc(db, "pinResetLimits", uid);
  const globalRef = doc(db, "pinResetLimits", "_global");
  const [u, g] = await Promise.all([getDocFromServer(uidRef), getDocFromServer(globalRef)]);
  return {
    uidRef,
    globalRef,
    today: dayNumber(),
    own: u.exists() ? u.data() : null,
    global: g.exists() ? g.data() : null
  };
}

export function resetBlock(l) {
  const now = Date.now();
  if (l.own && now - millis(l.own.lastAt) < RESET_UID_COOLDOWN_MS) return new LimitError(MSG_RESET_UID, "count");
  if (l.global && l.global.day === l.today && l.global.count >= RESET_GLOBAL_PER_DAY) return new LimitError(MSG_RESET_GLOBAL_DAY, "count");
  if (l.global && now - millis(l.global.lastAt) < RESET_GLOBAL_COOLDOWN_MS) return new LimitError(MSG_RESET_GLOBAL_WAIT, "count");
  return null;
}

async function resetAttempt(uid, payload) {
  requireOnline();
  const l = await readResetLimits(uid);
  const block = resetBlock(l);
  if (block) throw block;
  const reqRef = doc(collection(db, "pinResetRequests"));
  const count = (l.global && l.global.day === l.today ? l.global.count : 0) + 1;
  const batch = writeBatch(db);
  batch.set(reqRef, payload);
  batch.set(l.uidRef, { lastAt: serverTimestamp(), requestId: reqRef.id });
  batch.set(l.globalRef, { lastAt: serverTimestamp(), requestId: reqRef.id, day: l.today, count });
  await batch.commit();
  return reqRef.id;
}

// Caller must have done ensureAnonymous() (or be signed in) first.
export async function sendResetRequest(uid, payload, onWait) {
  try {
    return await resetAttempt(uid, payload);
  } catch (err) {
    if (!isPermission(err)) throw err;
    const block = resetBlock(await readResetLimits(uid));
    if (block) throw block;
    if (onWait) onWait("Even wachten, we proberen het zo nog een keer.");
    await sleep(RETRY_DELAY_MS);
    try {
      return await resetAttempt(uid, payload);
    } catch (err2) {
      if (err2 && err2.isLimit) throw err2;
      if (!isPermission(err2)) throw err2;
      const block2 = resetBlock(await readResetLimits(uid));
      if (block2) throw block2;
      throw err2;
    }
  }
}
