// Firestore-regeltests voor Zeiklijst. Draait alleen tegen de lokale emulator (project demo-zeiklijst).
// Geen echte gegevens, wachtwoorden of sleutels. Zie tests/README.md.
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import firebase from "firebase/compat/app";
import "firebase/compat/firestore";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RULES = readFileSync(fileURLToPath(new URL("../firestore.rules", import.meta.url)), "utf8");
const ADMIN = "Of3mAU2qJeczN6NDUfkgT73kfJn1";
const READER = "2xZjAuMgnYUjMg6Mg4ivPhEOIFr2";
const TS = firebase.firestore.Timestamp;
const ST = () => firebase.firestore.FieldValue.serverTimestamp();
const DAY = 86400000;
const iso = (offsetDays = 0) => new Date(Date.now() + offsetDays * DAY).toISOString();
const ymd = (offsetDays = 0) => iso(offsetDays).slice(0, 10);
const email = (id, v, code) => `emp-${id}-v${v}-${code.toLowerCase()}@zeiklijst.app`;
const GOOD_PHOTO = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/=";
const BAD_PHOTO = 'data:image/png" onerror="alert(1)';

const env = await initializeTestEnvironment({
  projectId: "demo-zeiklijst",
  firestore: { rules: RULES, host: "127.0.0.1", port: 8085 }
});

const future = TS.fromMillis(Date.now() + 7 * DAY);
const past = TS.fromMillis(Date.now() - 60000);
async function seed() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc("employees/emp-jane").set({ name: "Jane", active: true, pinVersion: 3 });
    await db.doc("employees/emp-aart").set({ name: "Aart", active: true, pinVersion: 1 });
    await db.doc("employees/emp-oud").set({ name: "Oud", active: false, pinVersion: 2 });
    await db.doc("employees/emp-staff").set({ name: "Staff", active: true, pinVersion: 1 });
    await db.doc("employees/emp-inact").set({ name: "Inact", active: false, pinVersion: 1 });
    await db.doc("nameIndex/jane").set({ employeeId: "emp-jane", hasPin: false, pinVersion: 3 });
    const base = { createdAt: TS.now(), expiresAt: future, used: false };
    await db.doc("startCodes/ABCDEFGHJK").set({ ...base, employeeId: "emp-jane", name: "Jane", pinVersion: 3 });
    await db.doc("startCodes/USEDKEY222").set({ ...base, employeeId: "emp-jane", name: "Jane", pinVersion: 3, used: true });
    await db.doc("startCodes/EXPRDKEY22").set({ ...base, employeeId: "emp-jane", name: "Jane", pinVersion: 3, expiresAt: past });
    await db.doc("startCodes/PREVVERS22").set({ ...base, employeeId: "emp-jane", name: "Jane", pinVersion: 2 });
    await db.doc("startCodes/AARTKEY222").set({ ...base, employeeId: "emp-aart", name: "Aart", pinVersion: 1 });
    await db.doc("startCodes/QUDKEY2222").set({ ...base, employeeId: "emp-oud", name: "Oud", pinVersion: 2 });
    await db.doc("staffAccounts/u-staff").set({ employeeId: "emp-staff", pinVersion: 1, startCode: "STAFFKEY22" });
    await db.doc("staffAccounts/u-aart").set({ employeeId: "emp-aart", pinVersion: 1, startCode: "AARTKEY223" });
    await db.doc("staffAccounts/u-inact").set({ employeeId: "emp-inact", pinVersion: 1, startCode: "NACTVKEY22" });
    await db.doc("staffAccounts/u-legacy").set({ employeeId: "emp-staff", pinVersion: 1 });
    const task = { description: "", status: "open", createdAt: iso(-1), photos: [] };
    await db.doc("tasks/t1").set({ ...task, title: "Vegen", assigneeId: "", assigneeName: "" });
    await db.doc("tasks/t-own").set({ ...task, title: "Eigen", assigneeId: "emp-staff", assigneeName: "Staff" });
    await db.doc("tasks/t-allen").set({ ...task, title: "Allen", assigneeId: "ALLEN", assigneeName: "Allen" });
    await db.doc("tasks/t-jane").set({ ...task, title: "Van Jane", assigneeId: "emp-jane", assigneeName: "Jane" });
    await db.doc("tasks/t-pending-aart").set({ ...task, title: "Door Aart afgevinkt", assigneeId: "ALLEN", assigneeName: "Allen", status: "pending", pendingAt: iso(), pendingBy: "Aart", pendingByEmployeeId: "emp-aart" });
    await db.doc("taskMeta/t1").set({ dueDate: ymd(3) });
    await db.doc("recurring/rec1").set({ title: "Dagelijks", description: "", assigneeId: "", assigneeName: "", photos: [], paused: false });
    await db.doc("reports/r1").set({ description: "x", status: "nieuw" });
    await db.doc("pinResetRequests/oldreq0000000000001").set({ name: "Jane", requestedAt: TS.now() });
  });
}

function claim(db, uid, { employeeId, pinVersion, code, markUsed = true, usedBy }) {
  const b = db.batch();
  b.set(db.doc(`staffAccounts/${uid}`), { employeeId, pinVersion, startCode: code });
  if (markUsed) b.update(db.doc(`startCodes/${code}`), { used: true, usedBy: usedBy || uid, usedAt: ST() });
  return b.commit();
}
const staffCtx = (uid, em = "x@zeiklijst.app") => env.authenticatedContext(uid, { email: em }).firestore();
const anonCtx = () => env.authenticatedContext("anon1", { firebase: { sign_in_provider: "anonymous" } }).firestore();
const staffTask = (over = {}) => ({ title: "Lamp kapot", description: "", location: "", assigneeId: "emp-staff", assigneeName: "Staff", status: "open", createdAt: iso(), photos: [], createdByRole: "staff", createdByEmployeeId: "emp-staff", createdByName: "Staff", adminReview: "nieuw", recurringId: null, occurrenceDate: null, pendingAt: null, pendingBy: null, completedAt: null, ...over });
const report = (over = {}) => ({ description: "App hangt", employeeId: "emp-staff", employeeName: "Staff", createdAt: ST(), appVersion: "18", device: "iPhone", status: "nieuw", ...over });
const tick = (over = {}) => ({ status: "pending", pendingAt: iso(), pendingBy: "Staff", pendingByEmployeeId: "emp-staff", ...over });
const untick = { status: "open", pendingAt: null, pendingBy: null, pendingByEmployeeId: null };
const instance = (date, over = {}) => ({ title: "Dagelijks", description: "", assigneeId: "", assigneeName: "", status: "open", createdAt: iso(), photos: [], recurringId: "rec1", occurrenceDate: date, ...over });


// --- Stap 4: batch-helpers zoals de staff-app ze moet sturen (zla-step4-status.md) ---
const dayNumber = (ms = Date.now()) => Math.floor((ms + 3600000) / DAY);
async function counterState(employeeId) {
  let snap;
  await env.withSecurityRulesDisabled(async (c) => { snap = await c.firestore().doc(`staffDailyCounters/${employeeId}`).get(); });
  return snap.exists ? snap.data() : null;
}
// Bouwt de tellerwaarde die de regels verwachten (of een aangepaste via over).
async function nextCounter(employeeId, kind, id, over = {}) {
  const prev = await counterState(employeeId);
  const today = dayNumber();
  const same = prev && prev.day === today;
  const tasks = same ? prev.tasks : 0;
  const reports = same ? prev.reports : 0;
  return { day: today, tasks: tasks + (kind === "task" ? 1 : 0), reports: reports + (kind === "report" ? 1 : 0), lastAt: ST(), lastType: kind, lastId: id, ...over };
}
async function addTask(db, data, { counter = true, counterOver = {}, counterEmp } = {}) {
  const ref = db.collection("tasks").doc();
  const b = db.batch();
  b.set(ref, data);
  if (counter) {
    const emp = counterEmp || data.createdByEmployeeId || "emp-staff";
    b.set(db.doc(`staffDailyCounters/${emp}`), await nextCounter(data.createdByEmployeeId || emp, "task", ref.id, counterOver));
  }
  return b.commit();
}
async function addReport(db, data, { counter = true, counterOver = {}, counterEmp } = {}) {
  const ref = db.collection("reports").doc();
  const b = db.batch();
  b.set(ref, data);
  if (counter) {
    const emp = counterEmp || data.employeeId || "emp-staff";
    b.set(db.doc(`staffDailyCounters/${emp}`), await nextCounter(data.employeeId || emp, "report", ref.id, counterOver));
  }
  return b.commit();
}
async function addReset(db, data, { uid = "anon1", own = true, global = true, ownOver = {}, globalOver = {}, id } = {}) {
  let g;
  await env.withSecurityRulesDisabled(async (c) => { g = await c.firestore().doc("pinResetLimits/_global").get(); });
  const gp = g.exists ? g.data() : null;
  const count = (gp && gp.day === dayNumber() ? gp.count : 0) + 1;
  const ref = id ? db.doc(`pinResetRequests/${id}`) : db.collection("pinResetRequests").doc();
  const b = db.batch();
  b.set(ref, data);
  if (own) b.set(db.doc(`pinResetLimits/${uid}`), { lastAt: ST(), requestId: ref.id, ...ownOver });
  if (global) b.set(db.doc("pinResetLimits/_global"), { lastAt: ST(), requestId: ref.id, day: dayNumber(), count, ...globalOver });
  return b.commit();
}
const seedDoc = (path, data) => env.withSecurityRulesDisabled((c) => c.firestore().doc(path).set(data));
const ago = (ms) => TS.fromMillis(Date.now() - ms);

const results = [];
async function t(group, name, fn) {
  await seed();
  try { await fn(); results.push(["PASS", group, name]); }
  catch (e) { results.push(["FAIL", group, name, String(e && e.message || e).slice(0, 300)]); }
}

// --- Claim met startcode (H1: zonder nameIndex) ---
const J = { employeeId: "emp-jane", pinVersion: 3, code: "ABCDEFGHJK" };
await t("claim", "geldige claim (staffAccounts + startCodes) slaagt", () => assertSucceeds(claim(staffCtx("u1", email("emp-jane", 3, J.code)), "u1", J)));
await t("claim", "na claim: taken lezen slaagt", async () => { const db = staffCtx("u1", email("emp-jane", 3, J.code)); await claim(db, "u1", J); await assertSucceeds(db.doc("tasks/t1").get()); });
await t("claim", "tweede claim met dezelfde code faalt", async () => { await claim(staffCtx("u1", email("emp-jane", 3, J.code)), "u1", J); await assertFails(claim(staffCtx("u2", email("emp-jane", 3, J.code)), "u2", J)); });
await t("claim", "gebruikte code faalt", () => assertFails(claim(staffCtx("u1", email("emp-jane", 3, "USEDKEY222")), "u1", { ...J, code: "USEDKEY222" })));
await t("claim", "verlopen code faalt", () => assertFails(claim(staffCtx("u1", email("emp-jane", 3, "EXPRDKEY22")), "u1", { ...J, code: "EXPRDKEY22" })));
await t("claim", "niet-bestaande code faalt", () => assertFails(claim(staffCtx("u1", email("emp-jane", 3, "ZZZZZZZZZZ")), "u1", { ...J, code: "ZZZZZZZZZZ", markUsed: false })));
await t("claim", "code van andere medewerker faalt", () => assertFails(claim(staffCtx("u1", email("emp-jane", 3, "AARTKEY222")), "u1", { ...J, code: "AARTKEY222" })));
await t("claim", "code van oude pinVersion faalt", () => assertFails(claim(staffCtx("u1", email("emp-jane", 2, "PREVVERS22")), "u1", { ...J, pinVersion: 2, code: "PREVVERS22" })));
await t("claim", "verkeerde auth-e-mail faalt", () => assertFails(claim(staffCtx("u1", "emp-emp-jane-v3@zeiklijst.app"), "u1", J)));
await t("claim", "zonder code als gebruikt te markeren faalt", () => assertFails(claim(staffCtx("u1", email("emp-jane", 3, J.code)), "u1", { ...J, markUsed: false })));
await t("claim", "usedBy van iemand anders faalt", () => assertFails(claim(staffCtx("u1", email("emp-jane", 3, J.code)), "u1", { ...J, usedBy: "u9" })));
await t("claim", "oude claim zonder startCode faalt", () => assertFails(staffCtx("u1", "emp-emp-jane-v3@zeiklijst.app").doc("staffAccounts/u1").set({ employeeId: "emp-jane", pinVersion: 3 })));
await t("claim", "code als gebruikt markeren zonder staffAccount faalt", () => assertFails(staffCtx("u1", email("emp-jane", 3, J.code)).doc(`startCodes/${J.code}`).update({ used: true, usedBy: "u1", usedAt: ST() })));
await t("claim", "inactieve medewerker: claim faalt", () => assertFails(claim(staffCtx("u1", email("emp-oud", 2, "QUDKEY2222")), "u1", { employeeId: "emp-oud", pinVersion: 2, code: "QUDKEY2222" })));

// --- H1/M1: nameIndex en startcodes ---
await t("H1/M1", "anoniem: nameIndex get faalt", () => assertFails(anonCtx().doc("nameIndex/jane").get()));
await t("H1/M1", "medewerker: nameIndex get faalt", () => assertFails(staffCtx("u-staff").doc("nameIndex/jane").get()));
await t("H1/M1", "medewerker: nameIndex schrijven faalt", () => assertFails(staffCtx("u-staff").doc("nameIndex/jane").update({ hasPin: true })));
await t("H1/M1", "admin: nameIndex lezen/schrijven slaagt", async () => { const db = env.authenticatedContext(ADMIN).firestore(); await assertSucceeds(db.collection("nameIndex").get()); await assertSucceeds(db.doc("nameIndex/jane").delete()); });
await t("H1/M1", "anoniem: ongebruikte geldige code get slaagt (met name)", async () => { const snap = await assertSucceeds(anonCtx().doc(`startCodes/${J.code}`).get()); if (snap.data().name !== "Jane") throw new Error("geen name"); });
await t("H1/M1", "anoniem: gebruikte code get faalt", () => assertFails(anonCtx().doc("startCodes/USEDKEY222").get()));
await t("H1/M1", "anoniem: verlopen code get faalt", () => assertFails(anonCtx().doc("startCodes/EXPRDKEY22").get()));
await t("H1/M1", "anoniem: niet-bestaande code get faalt", () => assertFails(anonCtx().doc("startCodes/ZZZZZZZZZZ").get()));
await t("H1/M1", "na claim: dezelfde code is niet meer op te vragen", async () => { await claim(staffCtx("u1", email("emp-jane", 3, J.code)), "u1", J); await assertFails(anonCtx().doc(`startCodes/${J.code}`).get()); });
await t("H1/M1", "medewerker: startCodes-lijst faalt", () => assertFails(staffCtx("u-staff").collection("startCodes").get()));
await t("H1/M1", "niet ingelogd: startcode get faalt", () => assertFails(env.unauthenticatedContext().firestore().doc(`startCodes/${J.code}`).get()));
await t("H1/M1", "admin: gebruikte code lezen slaagt", () => assertSucceeds(env.authenticatedContext(ADMIN).firestore().doc("startCodes/USEDKEY222").get()));

// --- Inactief, oude accounts, eigen employee-doc (L3) ---
await t("account", "inactief bestaand account: taken lezen faalt", () => assertFails(staffCtx("u-inact").doc("tasks/t1").get()));
await t("account", "actief startcode-account: taken lezen slaagt", () => assertSucceeds(staffCtx("u-staff").doc("tasks/t1").get()));
await t("account", "oude-methode-account: taken lezen faalt", () => assertFails(staffCtx("u-legacy").doc("tasks/t1").get()));
await t("account", "oude-methode-account: afvinken faalt", () => assertFails(staffCtx("u-legacy").doc("tasks/t-own").update(tick())));
await t("account", "oude-methode-account: melding maken faalt", () => assertFails(addReport(staffCtx("u-legacy"), report())));
await t("account", "ongeldige startCode-string faalt", async () => { await env.withSecurityRulesDisabled((c) => c.firestore().doc("staffAccounts/u-bad").set({ employeeId: "emp-staff", pinVersion: 1, startCode: "kort" })); await assertFails(staffCtx("u-bad").doc("tasks/t1").get()); });
await t("L3", "medewerker: eigen employees-doc get slaagt", () => assertSucceeds(staffCtx("u-staff").doc("employees/emp-staff").get()));
await t("L3", "medewerker: doc van andere medewerker get faalt", () => assertFails(staffCtx("u-staff").doc("employees/emp-jane").get()));
await t("L3", "medewerker: employees-lijst faalt", () => assertFails(staffCtx("u-staff").collection("employees").get()));
await t("L3", "inactief: eigen employees-doc get slaagt", () => assertSucceeds(staffCtx("u-inact").doc("employees/emp-inact").get()));
await t("L3", "inactief: andere doc/lijst/tasks falen", async () => { const db = staffCtx("u-inact"); await assertFails(db.doc("employees/emp-jane").get()); await assertFails(db.collection("employees").get()); await assertFails(db.collection("tasks").get()); });
await t("L3", "inactief: eigen doc schrijven faalt", () => assertFails(staffCtx("u-inact").doc("employees/emp-inact").update({ active: true })));
await t("L3", "verouderde pinVersion: eigen doc get faalt", async () => { await env.withSecurityRulesDisabled((c) => c.firestore().doc("staffAccounts/u-inact-old").set({ employeeId: "emp-inact", pinVersion: 0, startCode: "NACTVKEY23" })); await assertFails(staffCtx("u-inact-old").doc("employees/emp-inact").get()); });
await t("L3", "oude-methode-account: eigen doc get faalt", () => assertFails(staffCtx("u-legacy").doc("employees/emp-staff").get()));
await t("L3", "anoniem: employees-doc get faalt", () => assertFails(anonCtx().doc("employees/emp-inact").get()));

// --- L2: afvinken ---
await t("L2", "eigen taak afvinken slaagt", () => assertSucceeds(staffCtx("u-staff").doc("tasks/t-own").update(tick())));
await t("L2", "niet-toegewezen taak afvinken slaagt", () => assertSucceeds(staffCtx("u-staff").doc("tasks/t1").update(tick())));
await t("L2", "taak voor Allen afvinken slaagt", () => assertSucceeds(staffCtx("u-staff").doc("tasks/t-allen").update(tick())));
await t("L2", "taak van iemand anders afvinken faalt", () => assertFails(staffCtx("u-staff").doc("tasks/t-jane").update(tick())));
await t("L2", "afvinken zonder pendingByEmployeeId faalt", () => assertFails(staffCtx("u-staff").doc("tasks/t-own").update(tick({ pendingByEmployeeId: null }))));
await t("L2", "afvinken met andermans pendingByEmployeeId faalt", () => assertFails(staffCtx("u-staff").doc("tasks/t-own").update(tick({ pendingByEmployeeId: "emp-jane" }))));
await t("L2", "andermans afvinking terugzetten faalt", () => assertFails(staffCtx("u-staff").doc("tasks/t-pending-aart").update(untick)));
await t("L2", "eigen afvinking terugzetten slaagt", () => assertSucceeds(staffCtx("u-aart").doc("tasks/t-pending-aart").update(untick)));
await t("M3", "afvinken met pendingAt geen datum faalt", () => assertFails(staffCtx("u-staff").doc("tasks/t-own").update(tick({ pendingAt: "x".repeat(5000) }))));
await t("M3", "melding met geldige foto ~249000 tekens slaagt", () => assertSucceeds(addReport(staffCtx("u-staff"), report({ photo: "data:image/jpeg;base64," + "A".repeat(249000) }))));
await t("M3", "afvinken met pendingAt 3 dagen terug faalt", () => assertFails(staffCtx("u-staff").doc("tasks/t-own").update(tick({ pendingAt: iso(-3) }))));
await t("M3", "afvinken met pendingBy van iemand anders faalt", () => assertFails(staffCtx("u-staff").doc("tasks/t-own").update(tick({ pendingBy: "Jane" }))));
await t("M3", "afvinken met pendingAt ver in de toekomst faalt", () => assertFails(staffCtx("u-staff").doc("tasks/t-own").update(tick({ pendingAt: iso(30) }))));
await t("L2", "afvinken met extra veld (title) faalt", () => assertFails(staffCtx("u-staff").doc("tasks/t-own").update({ ...tick(), title: "x" })));

// --- M3: eigen taken en meldingen ---
await t("M3", "eigen taak met geldige foto slaagt", () => assertSucceeds(addTask(staffCtx("u-staff"), staffTask({ photos: [GOOD_PHOTO] }))));
await t("M3", "eigen taak zonder foto slaagt", () => assertSucceeds(addTask(staffCtx("u-staff"), staffTask())));
await t("M3", "eigen taak met 2 foto's faalt", () => assertFails(addTask(staffCtx("u-staff"), staffTask({ photos: [GOOD_PHOTO, GOOD_PHOTO] }))));
await t("M3", "eigen taak met foto > 250000 tekens faalt", () => assertFails(addTask(staffCtx("u-staff"), staffTask({ photos: ["data:image/jpeg;base64," + "A".repeat(250000)] }))));
await t("M3", "eigen taak met foto ~249000 tekens slaagt", () => assertSucceeds(addTask(staffCtx("u-staff"), staffTask({ photos: ["data:image/jpeg;base64," + "A".repeat(249000)] }))));
await t("M3", "eigen taak met foute foto-string faalt", () => assertFails(addTask(staffCtx("u-staff"), staffTask({ photos: [BAD_PHOTO] }))));
await t("M3", "eigen taak met svg-foto faalt", () => assertFails(addTask(staffCtx("u-staff"), staffTask({ photos: ["data:image/svg+xml;base64,PHN2Zz4="] }))));
await t("M3", "eigen taak met titel > 120 faalt", () => assertFails(addTask(staffCtx("u-staff"), staffTask({ title: "x".repeat(121) }))));
await t("M3", "eigen taak met omschrijving > 2000 faalt", () => assertFails(addTask(staffCtx("u-staff"), staffTask({ description: "x".repeat(2001) }))));
await t("M3", "eigen taak met locatie > 120 faalt", () => assertFails(addTask(staffCtx("u-staff"), staffTask({ location: "x".repeat(121) }))));
await t("M3", "eigen taak met dueDate faalt", () => assertFails(addTask(staffCtx("u-staff"), staffTask({ dueDate: ymd(1) }))));
await t("L9", "eigen taak met createdAt over 10 dagen faalt", () => assertFails(addTask(staffCtx("u-staff"), staffTask({ createdAt: iso(10) }))));
await t("L9", "eigen taak met createdAt 10 dagen terug faalt", () => assertFails(addTask(staffCtx("u-staff"), staffTask({ createdAt: iso(-10) }))));
await t("M3", "melding met geldige foto slaagt", () => assertSucceeds(addReport(staffCtx("u-staff"), report({ photo: GOOD_PHOTO }))));
await t("M3", "melding met foto > 250000 tekens faalt", () => assertFails(addReport(staffCtx("u-staff"), report({ photo: "data:image/jpeg;base64," + "A".repeat(250000) }))));
await t("M3", "melding met foute foto-string faalt", () => assertFails(addReport(staffCtx("u-staff"), report({ photo: BAD_PHOTO }))));
await t("M3", "melding met omschrijving > 1000 faalt", () => assertFails(addReport(staffCtx("u-staff"), report({ description: "x".repeat(1001) }))));
await t("M3", "melding met device > 300 faalt", () => assertFails(addReport(staffCtx("u-staff"), report({ device: "x".repeat(301) }))));
await t("M3", "melding met appVersion > 40 faalt", () => assertFails(addReport(staffCtx("u-staff"), report({ appVersion: "x".repeat(41) }))));
await t("M3", "inactief: melding maken faalt", () => assertFails(addReport(staffCtx("u-inact"), { ...report(), employeeId: "emp-inact", employeeName: "Inact" })));
await t("M3", "medewerker: recurring schrijven faalt", () => assertFails(staffCtx("u-staff").doc("recurring/rec1").update({ title: "x" })));

// --- L9: herhaal-instanties ---
await t("L9", "instantie voor vandaag slaagt", () => assertSucceeds(staffCtx("u-staff").doc(`tasks/rec1_${ymd()}`).set(instance(ymd()))));
await t("L9", "instantie voor gisteren slaagt", () => assertSucceeds(staffCtx("u-staff").doc(`tasks/rec1_${ymd(-1)}`).set(instance(ymd(-1)))));
await t("L9", "instantie 3 dagen terug faalt (admin haalt in)", () => assertFails(staffCtx("u-staff").doc(`tasks/rec1_${ymd(-3)}`).set(instance(ymd(-3)))));
await t("L9", "instantie over 3 dagen faalt", () => assertFails(staffCtx("u-staff").doc(`tasks/rec1_${ymd(3)}`).set(instance(ymd(3)))));
await t("L9", "instantie ver in de toekomst faalt", () => assertFails(staffCtx("u-staff").doc(`tasks/rec1_${ymd(30)}`).set(instance(ymd(30)))));
await t("L9", "instantie 60 dagen terug faalt", () => assertFails(staffCtx("u-staff").doc(`tasks/rec1_${ymd(-60)}`).set(instance(ymd(-60)))));
await t("L9", "instantie met createdAt in de toekomst faalt", () => assertFails(staffCtx("u-staff").doc(`tasks/rec1_${ymd()}`).set(instance(ymd(), { createdAt: iso(10) }))));
await t("L9", "instantie die niet op sjabloon lijkt faalt", () => assertFails(staffCtx("u-staff").doc(`tasks/rec1_${ymd()}`).set(instance(ymd(), { title: "Anders" }))));

// --- L1: taskMeta ---
await t("L1", "medewerker: taskMeta lezen faalt", () => assertFails(staffCtx("u-staff").doc("taskMeta/t1").get()));
await t("L1", "medewerker: taskMeta schrijven faalt", () => assertFails(staffCtx("u-staff").doc("taskMeta/t1").set({ dueDate: ymd() })));
await t("L1", "reader: taskMeta lezen (doc en lijst) slaagt", async () => { const db = env.authenticatedContext(READER).firestore(); await assertSucceeds(db.doc("taskMeta/t1").get()); await assertSucceeds(db.collection("taskMeta").get()); });
await t("L1", "reader: taskMeta schrijven faalt", () => assertFails(env.authenticatedContext(READER).firestore().doc("taskMeta/t1").set({ dueDate: ymd() })));
await t("L1", "admin: taskMeta schrijven slaagt", () => assertSucceeds(env.authenticatedContext(ADMIN).firestore().doc("taskMeta/t1").set({ dueDate: ymd(5) })));

// --- M2: resetverzoeken ---
await t("M2", "anoniem: verzoek met willekeurig id slaagt", () => assertSucceeds(addReset(anonCtx(), { name: "Jane", requestedAt: ST() })));
await t("M2", "anoniem: verzoek met note slaagt", () => assertSucceeds(addReset(anonCtx(), { name: "Jane", requestedAt: ST(), note: "nieuwe telefoon" })));
await t("M2", "verzoek met naam > 60 faalt", () => assertFails(addReset(anonCtx(), { name: "x".repeat(61), requestedAt: ST() })));
await t("M2", "verzoek met lege naam faalt", () => assertFails(addReset(anonCtx(), { name: "   ", requestedAt: ST() })));
await t("M2", "verzoek met note > 200 faalt", () => assertFails(addReset(anonCtx(), { name: "Jane", requestedAt: ST(), note: "x".repeat(201) })));
await t("M2", "verzoek met extra veld (employeeId) faalt", () => assertFails(addReset(anonCtx(), { name: "Jane", requestedAt: ST(), employeeId: "emp-jane" })));
await t("M2", "verzoek met eigen tijd faalt", () => assertFails(addReset(anonCtx(), { name: "Jane", requestedAt: TS.fromMillis(Date.now() - DAY) })));
await t("M2", "verzoek met employeeId als doc-id faalt", () => assertFails(addReset(anonCtx(), { name: "Jane", requestedAt: ST() }, { id: "emp-jane" })));
await t("M2", "bestaand verzoek overschrijven faalt", () => assertFails(addReset(anonCtx(), { name: "Hacker", requestedAt: ST() }, { id: "oldreq0000000000001" })));
await t("M2", "verzoek lezen door niet-admin faalt", () => assertFails(anonCtx().doc("pinResetRequests/oldreq0000000000001").get()));
await t("M2", "niet ingelogd: verzoek faalt", () => assertFails(addReset(env.unauthenticatedContext().firestore(), { name: "Jane", requestedAt: ST() })));
await t("M2", "verzoek geeft geen toegang", async () => { const db = anonCtx(); await addReset(db, { name: "Jane", requestedAt: ST() }); await assertFails(db.doc("tasks/t1").get()); });

// --- Stap 4, M3: dagteller eigen taken en meldingen (staffDailyCounters) ---
const S = () => staffCtx("u-staff");
const cnt = (over = {}) => ({ day: dayNumber(), tasks: 0, reports: 0, lastAt: ago(60000), lastType: "task", lastId: "seedid00000000000001", ...over });
await t("M3-dag", "eigen taak zonder teller faalt", () => assertFails(addTask(S(), staffTask(), { counter: false })));
await t("M3-dag", "melding zonder teller faalt", () => assertFails(addReport(S(), report(), { counter: false })));
await t("M3-dag", "teller ophogen zonder taak faalt", () => assertFails(S().doc("staffDailyCounters/emp-staff").set({ day: dayNumber(), tasks: 1, reports: 0, lastAt: ST(), lastType: "task", lastId: "nietbestaand00000001" })));
await t("M3-dag", "teller wijst naar ander id faalt", () => assertFails(addTask(S(), staffTask(), { counterOver: { lastId: "anderid0000000000001" } })));
await t("M3-dag", "teller met verkeerd type (report bij taak) faalt", () => assertFails(addTask(S(), staffTask(), { counterOver: { lastType: "report", tasks: 0, reports: 1 } })));
await t("M3-dag", "teller met +2 faalt", async () => { await seedDoc("staffDailyCounters/emp-staff", cnt({ tasks: 3 })); await assertFails(addTask(S(), staffTask(), { counterOver: { tasks: 5 } })); });
await t("M3-dag", "teller terugzetten (tasks 0) faalt", async () => { await seedDoc("staffDailyCounters/emp-staff", cnt({ tasks: 9 })); await assertFails(addTask(S(), staffTask(), { counterOver: { tasks: 1 } })); });
await t("M3-dag", "teller met eigen lastAt faalt", () => assertFails(addTask(S(), staffTask(), { counterOver: { lastAt: TS.now() } })));
await t("M3-dag", "teller met dag van morgen faalt", () => assertFails(addTask(S(), staffTask(), { counterOver: { day: dayNumber() + 1 } })));
await t("M3-dag", "teller met extra veld faalt", () => assertFails(addTask(S(), staffTask(), { counterOver: { extra: 1 } })));
await t("M3-dag", "teller van andere medewerker faalt", () => assertFails(addTask(S(), staffTask(), { counterEmp: "emp-jane" })));
await t("M3-dag", "10e eigen taak op een dag slaagt", async () => { await seedDoc("staffDailyCounters/emp-staff", cnt({ tasks: 9 })); await assertSucceeds(addTask(S(), staffTask())); });
await t("M3-dag", "11e eigen taak op een dag faalt", async () => { await seedDoc("staffDailyCounters/emp-staff", cnt({ tasks: 10 })); await assertFails(addTask(S(), staffTask())); });
await t("M3-dag", "5e melding op een dag slaagt", async () => { await seedDoc("staffDailyCounters/emp-staff", cnt({ reports: 4, tasks: 10 })); await assertSucceeds(addReport(S(), report())); });
await t("M3-dag", "6e melding op een dag faalt", async () => { await seedDoc("staffDailyCounters/emp-staff", cnt({ reports: 5 })); await assertFails(addReport(S(), report())); });
await t("M3-dag", "nieuwe dag: teller begint weer bij 1", async () => { await seedDoc("staffDailyCounters/emp-staff", cnt({ day: dayNumber() - 1, tasks: 10, reports: 5, lastAt: ago(DAY) })); await assertSucceeds(addTask(S(), staffTask())); const c = await counterState("emp-staff"); if (c.tasks !== 1 || c.reports !== 0 || c.day !== dayNumber()) throw new Error(JSON.stringify(c)); });
await t("M3-dag", "nieuwe dag: oude stand doortellen faalt", async () => { await seedDoc("staffDailyCounters/emp-staff", cnt({ day: dayNumber() - 1, tasks: 3, lastAt: ago(DAY) })); await assertFails(addTask(S(), staffTask(), { counterOver: { tasks: 4 } })); });
await t("M3-dag", "binnen 15 s na vorige verzending faalt", async () => { await seedDoc("staffDailyCounters/emp-staff", cnt({ tasks: 1, lastAt: ago(5000) })); await assertFails(addReport(S(), report())); });
await t("M3-dag", "na 16 s weer verzenden slaagt", async () => { await seedDoc("staffDailyCounters/emp-staff", cnt({ tasks: 1, lastAt: ago(16000) })); await assertSucceeds(addReport(S(), report())); });
await t("M3-dag", "twee taken direct na elkaar: tweede faalt", async () => { await assertSucceeds(addTask(S(), staffTask())); await assertFails(addTask(S(), staffTask())); });
await t("M3-dag", "medewerker: eigen teller lezen slaagt, andermans faalt", async () => { await seedDoc("staffDailyCounters/emp-staff", cnt()); await seedDoc("staffDailyCounters/emp-jane", cnt()); await assertSucceeds(S().doc("staffDailyCounters/emp-staff").get()); await assertFails(S().doc("staffDailyCounters/emp-jane").get()); await assertFails(S().collection("staffDailyCounters").get()); });
await t("M3-dag", "anoniem: teller lezen/schrijven faalt", async () => { await seedDoc("staffDailyCounters/emp-staff", cnt()); await assertFails(anonCtx().doc("staffDailyCounters/emp-staff").get()); await assertFails(anonCtx().doc("staffDailyCounters/emp-staff").delete()); });
await t("M3-dag", "medewerker: teller wissen faalt", async () => { await seedDoc("staffDailyCounters/emp-staff", cnt({ tasks: 10 })); await assertFails(S().doc("staffDailyCounters/emp-staff").delete()); });
await t("M3-dag", "admin: tellers lezen en wissen slaagt", async () => { await seedDoc("staffDailyCounters/emp-staff", cnt()); const db = env.authenticatedContext(ADMIN).firestore(); await assertSucceeds(db.collection("staffDailyCounters").get()); await assertSucceeds(db.doc("staffDailyCounters/emp-staff").delete()); });
await t("M3-dag", "admin: taak zonder teller slaagt", () => assertSucceeds(env.authenticatedContext(ADMIN).firestore().collection("tasks").add({ title: "Admin", description: "", status: "open", createdAt: iso(), photos: [] })));
await t("M3-dag", "herhaal-instantie heeft geen teller nodig", () => assertSucceeds(S().doc(`tasks/rec1_${ymd()}`).set(instance(ymd()))));

// --- Stap 4, M2/N3: wachttijd resetverzoeken (pinResetLimits) ---
const anon2 = () => env.authenticatedContext("anon2", { firebase: { sign_in_provider: "anonymous" } }).firestore();
const R = () => ({ name: "Jane", requestedAt: ST() });
await t("M2-limiet", "verzoek zonder limietdocs faalt", () => assertFails(addReset(anonCtx(), R(), { own: false, global: false })));
await t("M2-limiet", "verzoek zonder globaal limietdoc faalt", () => assertFails(addReset(anonCtx(), R(), { global: false })));
await t("M2-limiet", "verzoek zonder eigen limietdoc faalt", () => assertFails(addReset(anonCtx(), R(), { own: false })));
await t("M2-limiet", "zelfde uid binnen 10 min faalt", async () => { await seedDoc("pinResetLimits/anon1", { lastAt: ago(5 * 60000), requestId: "x0000000000000000001" }); await assertFails(addReset(anonCtx(), R())); });
await t("M2-limiet", "zelfde uid na 10 min slaagt", async () => { await seedDoc("pinResetLimits/anon1", { lastAt: ago(601000), requestId: "x0000000000000000001" }); await assertSucceeds(addReset(anonCtx(), R())); });
await t("M2-limiet", "ander uid binnen 60 s (globaal) faalt", async () => { await seedDoc("pinResetLimits/_global", { lastAt: ago(30000), requestId: "x0000000000000000001", day: dayNumber(), count: 1 }); await assertFails(addReset(anon2(), R(), { uid: "anon2" })); });
await t("M2-limiet", "ander uid na 61 s slaagt", async () => { await seedDoc("pinResetLimits/_global", { lastAt: ago(61000), requestId: "x0000000000000000001", day: dayNumber(), count: 1 }); await assertSucceeds(addReset(anon2(), R(), { uid: "anon2" })); });
await t("M2-limiet", "twee verzoeken direct na elkaar (nieuwe uid): tweede faalt", async () => { await assertSucceeds(addReset(anonCtx(), R())); await assertFails(addReset(anon2(), R(), { uid: "anon2" })); });
await t("M2-limiet", "20e verzoek van de dag slaagt", async () => { await seedDoc("pinResetLimits/_global", { lastAt: ago(120000), requestId: "x0000000000000000001", day: dayNumber(), count: 19 }); await assertSucceeds(addReset(anonCtx(), R())); });
await t("M2-limiet", "21e verzoek van de dag faalt", async () => { await seedDoc("pinResetLimits/_global", { lastAt: ago(120000), requestId: "x0000000000000000001", day: dayNumber(), count: 20 }); await assertFails(addReset(anonCtx(), R())); });
await t("M2-limiet", "nieuwe dag: globale teller begint weer bij 1", async () => { await seedDoc("pinResetLimits/_global", { lastAt: ago(DAY), requestId: "x0000000000000000001", day: dayNumber() - 1, count: 20 }); await assertSucceeds(addReset(anonCtx(), R())); });
await t("M2-limiet", "globale teller laag zetten faalt", async () => { await seedDoc("pinResetLimits/_global", { lastAt: ago(120000), requestId: "x0000000000000000001", day: dayNumber(), count: 20 }); await assertFails(addReset(anonCtx(), R(), { globalOver: { count: 1 } })); });
await t("M2-limiet", "globaal: dag van morgen faalt", () => assertFails(addReset(anonCtx(), R(), { globalOver: { day: dayNumber() + 1 } })));
await t("M2-limiet", "limietdoc van ander uid schrijven faalt", () => assertFails(addReset(anonCtx(), R(), { uid: "anon2" })));
await t("M2-limiet", "limietdoc met eigen lastAt faalt", () => assertFails(addReset(anonCtx(), R(), { ownOver: { lastAt: ago(DAY) } })));
await t("M2-limiet", "limietdoc wijst naar ander verzoek faalt", () => assertFails(addReset(anonCtx(), R(), { globalOver: { requestId: "anderid0000000000001" } })));
await t("M2-limiet", "limietdoc zonder verzoek bijwerken faalt", () => assertFails(anonCtx().doc("pinResetLimits/_global").set({ lastAt: ST(), requestId: "nietbestaand00000001", day: dayNumber(), count: 1 })));
await t("M2-limiet", "limietdocs wissen door niet-admin faalt", async () => { await seedDoc("pinResetLimits/_global", { lastAt: ago(30000), requestId: "x0000000000000000001", day: dayNumber(), count: 1 }); await assertFails(anonCtx().doc("pinResetLimits/_global").delete()); });
await t("M2-limiet", "anoniem: eigen en globaal limietdoc lezen slaagt, ander uid faalt", async () => { await seedDoc("pinResetLimits/_global", { lastAt: ago(30000), requestId: "x0000000000000000001", day: dayNumber(), count: 1 }); await seedDoc("pinResetLimits/anon1", { lastAt: ago(30000), requestId: "x0000000000000000001" }); await seedDoc("pinResetLimits/anon2", { lastAt: ago(30000), requestId: "x0000000000000000001" }); await assertSucceeds(anonCtx().doc("pinResetLimits/_global").get()); await assertSucceeds(anonCtx().doc("pinResetLimits/anon1").get()); await assertFails(anonCtx().doc("pinResetLimits/anon2").get()); await assertFails(anonCtx().collection("pinResetLimits").get()); });
await t("M2-limiet", "admin: limietdocs lezen en wissen slaagt", async () => { await seedDoc("pinResetLimits/_global", { lastAt: ago(30000), requestId: "x0000000000000000001", day: dayNumber(), count: 20 }); const db = env.authenticatedContext(ADMIN).firestore(); await assertSucceeds(db.collection("pinResetLimits").get()); await assertSucceeds(db.doc("pinResetLimits/_global").delete()); });

// --- Admin v24: employeeDetails (alleen admin, vaste velden) ---
const ADM = () => env.authenticatedContext(ADMIN).firestore();
const details = (over = {}) => ({ role: "Verkoper", staffNumber: "HB12345", contractHours: 32, workdays: [1, 2, 4, 6], startDate: "2021-03-01", note: "Sleutelhouder", updatedAt: ST(), ...over });
await t("details", "admin: volledige details opslaan slaagt", () => assertSucceeds(ADM().doc("employeeDetails/emp-jane").set(details())));
await t("details", "admin: alleen updatedAt (alles leeg) slaagt", () => assertSucceeds(ADM().doc("employeeDetails/emp-jane").set({ updatedAt: ST() })));
await t("details", "admin: halve contracturen (24.5) slaagt", () => assertSucceeds(ADM().doc("employeeDetails/emp-jane").set(details({ contractHours: 24.5 }))));
await t("details", "admin: 0 en 48 contracturen slagen", async () => { await assertSucceeds(ADM().doc("employeeDetails/emp-jane").set(details({ contractHours: 0 }))); await assertSucceeds(ADM().doc("employeeDetails/emp-aart").set(details({ contractHours: 48 }))); });
await t("details", "admin: lezen, lijst en wissen slaagt", async () => { await seedDoc("employeeDetails/emp-jane", { role: "x", updatedAt: TS.now() }); await assertSucceeds(ADM().doc("employeeDetails/emp-jane").get()); await assertSucceeds(ADM().collection("employeeDetails").get()); await assertSucceeds(ADM().doc("employeeDetails/emp-jane").delete()); });
await t("details", "admin: zelfde batch als medewerker verwijderen slaagt", async () => { await seedDoc("employeeDetails/emp-jane", { role: "x", updatedAt: TS.now() }); const db = ADM(); const b = db.batch(); b.delete(db.doc("employees/emp-jane")); b.delete(db.doc("employeeDetails/emp-jane")); await assertSucceeds(b.commit()); });
await t("details", "medewerker: eigen details lezen faalt", async () => { await seedDoc("employeeDetails/emp-staff", { role: "x", updatedAt: TS.now() }); await assertFails(S().doc("employeeDetails/emp-staff").get()); await assertFails(S().collection("employeeDetails").get()); });
await t("details", "medewerker: details schrijven faalt", () => assertFails(S().doc("employeeDetails/emp-staff").set(details())));
await t("details", "reader: details lezen faalt", async () => { await seedDoc("employeeDetails/emp-jane", { role: "x", updatedAt: TS.now() }); const db = env.authenticatedContext(READER).firestore(); await assertFails(db.doc("employeeDetails/emp-jane").get()); await assertFails(db.collection("employeeDetails").get()); });
await t("details", "anoniem/niet ingelogd: lezen en schrijven faalt", async () => { await seedDoc("employeeDetails/emp-jane", { role: "x", updatedAt: TS.now() }); await assertFails(anonCtx().doc("employeeDetails/emp-jane").get()); await assertFails(anonCtx().doc("employeeDetails/emp-jane").set(details())); await assertFails(env.unauthenticatedContext().firestore().doc("employeeDetails/emp-jane").get()); });
await t("details", "onbekend veld (phone) faalt", () => assertFails(ADM().doc("employeeDetails/emp-jane").set(details({ phone: "0612345678" }))));
await t("details", "onbekend veld (department) faalt", () => assertFails(ADM().doc("employeeDetails/emp-jane").set(details({ department: "Tuin" }))));
await t("details", "zonder updatedAt faalt", async () => { const d = details(); delete d.updatedAt; await assertFails(ADM().doc("employeeDetails/emp-jane").set(d)); });
await t("details", "eigen updatedAt faalt", () => assertFails(ADM().doc("employeeDetails/emp-jane").set(details({ updatedAt: TS.fromMillis(Date.now() - DAY) }))));
await t("details", "onbekende medewerker faalt", () => assertFails(ADM().doc("employeeDetails/emp-bestaatniet").set(details())));
await t("details", "functie > 40 tekens faalt", () => assertFails(ADM().doc("employeeDetails/emp-jane").set(details({ role: "x".repeat(41) }))));
await t("details", "lege functie faalt", () => assertFails(ADM().doc("employeeDetails/emp-jane").set(details({ role: "  " }))));
await t("details", "personeelsnummer met teken faalt", () => assertFails(ADM().doc("employeeDetails/emp-jane").set(details({ staffNumber: "HB-12<3" }))));
await t("details", "personeelsnummer > 20 faalt", () => assertFails(ADM().doc("employeeDetails/emp-jane").set(details({ staffNumber: "A".repeat(21) }))));
await t("details", "contracturen 49 faalt", () => assertFails(ADM().doc("employeeDetails/emp-jane").set(details({ contractHours: 49 }))));
await t("details", "contracturen negatief faalt", () => assertFails(ADM().doc("employeeDetails/emp-jane").set(details({ contractHours: -1 }))));
await t("details", "contracturen als tekst faalt", () => assertFails(ADM().doc("employeeDetails/emp-jane").set(details({ contractHours: "32" }))));
await t("details", "werkdag 7 faalt", () => assertFails(ADM().doc("employeeDetails/emp-jane").set(details({ workdays: [1, 7] }))));
await t("details", "dubbele werkdag faalt", () => assertFails(ADM().doc("employeeDetails/emp-jane").set(details({ workdays: [1, 1] }))));
await t("details", "werkdagen als tekst faalt", () => assertFails(ADM().doc("employeeDetails/emp-jane").set(details({ workdays: ["ma"] }))));
await t("details", "in dienst sinds fout formaat faalt", () => assertFails(ADM().doc("employeeDetails/emp-jane").set(details({ startDate: "01-03-2021" }))));
await t("details", "in dienst sinds over 2 jaar faalt", () => assertFails(ADM().doc("employeeDetails/emp-jane").set(details({ startDate: ymd(800) }))));
await t("details", "in dienst sinds over 2 maanden slaagt", () => assertSucceeds(ADM().doc("employeeDetails/emp-jane").set(details({ startDate: ymd(60) }))));
await t("details", "notitie > 500 faalt", () => assertFails(ADM().doc("employeeDetails/emp-jane").set(details({ note: "x".repeat(501) }))));
await t("details", "notitie 500 slaagt", () => assertSucceeds(ADM().doc("employeeDetails/emp-jane").set(details({ note: "x".repeat(500) }))));

// --- Reader en admin ---
await t("reader", "reader: tasks en employees lezen slaagt", async () => { const db = env.authenticatedContext(READER).firestore(); await assertSucceeds(db.collection("tasks").get()); await assertSucceeds(db.collection("employees").get()); });
await t("reader", "reader: geen startCodes/reports/nameIndex/schrijven", async () => { const db = env.authenticatedContext(READER).firestore(); await assertFails(db.collection("startCodes").get()); await assertFails(db.collection("reports").get()); await assertFails(db.collection("nameIndex").get()); await assertFails(db.doc("tasks/t1").update({ title: "x" })); });
await t("admin", "admin: startcode-uitgifte-batch slaagt", async () => {
  const db = env.authenticatedContext(ADMIN).firestore();
  const b = db.batch();
  b.update(db.doc("employees/emp-jane"), { pinVersion: 4 });
  b.delete(db.doc("pinResetRequests/oldreq0000000000001"));
  b.delete(db.doc(`startCodes/${J.code}`));
  b.set(db.doc("startCodes/NEWKEY2222"), { employeeId: "emp-jane", name: "Jane", pinVersion: 4, createdAt: TS.now(), expiresAt: future, used: false });
  await assertSucceeds(b.commit());
  await assertSucceeds(db.collection("startCodes").get());
  await assertSucceeds(db.collection("reports").get());
  await assertSucceeds(db.collection("staffAccounts").get());
  await assertSucceeds(db.collection("pinResetRequests").get());
});
await t("admin", "admin: taak met dueDate in taskMeta + taak bijwerken slaagt", async () => { const db = env.authenticatedContext(ADMIN).firestore(); const b = db.batch(); b.update(db.doc("tasks/t1"), { title: "Nieuw" }); b.set(db.doc("taskMeta/t1"), { dueDate: ymd(2) }); await assertSucceeds(b.commit()); });

await env.cleanup();
for (const r of results) console.log(r.join(" | "));
const pass = results.filter((r) => r[0] === "PASS").length;
console.log(`${pass}/${results.length} PASS`);
process.exit(pass === results.length ? 0 : 1);
