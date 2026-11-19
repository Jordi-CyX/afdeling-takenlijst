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

// Poort: emulators:exec zet FIRESTORE_EMULATOR_HOST (8085 via npm test, 8086 via npm run test:alt).
const EMU_PORT = Number(String(process.env.FIRESTORE_EMULATOR_HOST || "").split(":").pop()) || 8085;
const env = await initializeTestEnvironment({
  projectId: "demo-zeiklijst",
  firestore: { rules: RULES, host: "127.0.0.1", port: EMU_PORT }
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
    // Build v2: locatielijst (oud-pad is inactief: wel in items, niet in labels).
    await db.doc("settings/locations").set({
      items: [
        { id: "bkc", label: "BKC", order: 1, active: true },
        { id: "pad-16", label: "Pad 16", order: 2, active: true },
        { id: "oud-pad", label: "Oud pad", order: 3, active: false },
        // Build v2 (12:46): Overig is actief maar niet kiesbaar voor medewerkers -> niet in labels.
        { id: "overig", label: "Overig", order: 4, active: true, staffSelectable: false }
      ],
      labels: { bkc: "BKC", "pad-16": "Pad 16" },
      updatedAt: TS.now()
    });
    await db.doc("recurring/rec-loc").set({ title: "Pad 16 vegen", description: "", assigneeId: "", assigneeName: "", photos: [], paused: false, locationId: "pad-16", location: "Pad 16", urgent: true });
    await db.doc("tasks/t-pending-new").set({ ...task, title: "Nieuw afgevinkt", assigneeId: "ALLEN", assigneeName: "Allen", status: "pending" });
    await db.doc("taskCompletions/t-pending-new").set({ employeeId: "emp-aart", name: "Aart", at: TS.now() });
    await db.doc("audits/a1").set({ status: "afgerond", auditDate: ymd(), startedAt: TS.now(), updatedAt: TS.now(), sections: [] });
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
const staffTask = (over = {}) => ({ title: "Lamp kapot", description: "", location: "Pad 16", locationId: "pad-16", assigneeId: "emp-staff", assigneeName: "Staff", status: "open", createdAt: iso(), photos: [], createdByRole: "staff", createdByEmployeeId: "emp-staff", createdByName: "Staff", adminReview: "nieuw", recurringId: null, occurrenceDate: null, pendingAt: null, pendingBy: null, completedAt: null, ...over });
const report = (over = {}) => ({ description: "App hangt", employeeId: "emp-staff", employeeName: "Staff", createdAt: ST(), appVersion: "18", device: "iPhone", status: "nieuw", ...over });
// Build v2: afvinken = batch van taak (alleen status) + taskCompletions/{taskId} (wie, servertijd).
const completion = (over = {}) => ({ employeeId: "emp-staff", name: "Staff", at: ST(), ...over });
function tickB(db, taskId, { task = {}, comp = {}, withComp = true } = {}) {
  const b = db.batch();
  b.update(db.doc(`tasks/${taskId}`), { status: "pending", ...task });
  if (withComp) b.set(db.doc(`taskCompletions/${taskId}`), completion(comp));
  return b.commit();
}
function untickB(db, taskId, { task = {}, delComp = true } = {}) {
  const b = db.batch();
  b.update(db.doc(`tasks/${taskId}`), { status: "open", pendingAt: null, pendingBy: null, pendingByEmployeeId: null, ...task });
  if (delComp) b.delete(db.doc(`taskCompletions/${taskId}`));
  return b.commit();
}
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
await t("account", "oude-methode-account: afvinken faalt", () => assertFails(tickB(staffCtx("u-legacy"), "t-own")));
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
await t("L2", "eigen taak afvinken slaagt", () => assertSucceeds(tickB(staffCtx("u-staff"), "t-own")));
await t("L2", "niet-toegewezen taak afvinken slaagt", () => assertSucceeds(tickB(staffCtx("u-staff"), "t1")));
await t("L2", "taak voor Allen afvinken slaagt", () => assertSucceeds(tickB(staffCtx("u-staff"), "t-allen")));
await t("L2", "taak van iemand anders afvinken faalt", () => assertFails(tickB(staffCtx("u-staff"), "t-jane")));
await t("L2", "afvinken zonder taskCompletions-doc faalt", () => assertFails(tickB(staffCtx("u-staff"), "t-own", { withComp: false })));
await t("L2", "afvinken met andermans employeeId in completion faalt", () => assertFails(tickB(staffCtx("u-staff"), "t-own", { comp: { employeeId: "emp-jane" } })));
await t("L2", "andermans oude afvinking terugzetten faalt", () => assertFails(untickB(staffCtx("u-staff"), "t-pending-aart", { delComp: false })));
await t("L2", "eigen oude afvinking (zonder completion) terugzetten slaagt", () => assertSucceeds(untickB(staffCtx("u-aart"), "t-pending-aart", { delComp: false })));
await t("M3", "afvinken met pendingAt op de taak faalt (geen tijd meer op de taak)", () => assertFails(tickB(staffCtx("u-staff"), "t-own", { task: { pendingAt: iso() } })));
await t("M3", "melding met geldige foto ~249000 tekens slaagt", () => assertSucceeds(addReport(staffCtx("u-staff"), report({ photo: "data:image/jpeg;base64," + "A".repeat(249000) }))));
await t("M3", "completion met eigen at (geen servertijd) faalt", () => assertFails(tickB(staffCtx("u-staff"), "t-own", { comp: { at: TS.fromMillis(Date.now() - 3 * DAY) } })));
await t("M3", "completion met naam van iemand anders faalt", () => assertFails(tickB(staffCtx("u-staff"), "t-own", { comp: { name: "Jane" } })));
await t("M3", "afvinken met pendingBy op de taak faalt (geen naam meer op de taak)", () => assertFails(tickB(staffCtx("u-staff"), "t-own", { task: { pendingBy: "Staff", pendingByEmployeeId: "emp-staff" } })));
await t("L2", "afvinken met extra veld (title) faalt", () => assertFails(tickB(staffCtx("u-staff"), "t-own", { task: { title: "x" } })));

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
const details = (over = {}) => ({ role: "Verkoper", department: "Tuin", workdays: [1, 2, 4, 6], note: "Sleutelhouder", updatedAt: ST(), ...over });
await t("details", "admin: volledige details opslaan slaagt", () => assertSucceeds(ADM().doc("employeeDetails/emp-jane").set(details())));
await t("details", "admin: alleen updatedAt (alles leeg) slaagt", () => assertSucceeds(ADM().doc("employeeDetails/emp-jane").set({ updatedAt: ST() })));
await t("details", "admin: lezen, lijst en wissen slaagt", async () => { await seedDoc("employeeDetails/emp-jane", { role: "x", updatedAt: TS.now() }); await assertSucceeds(ADM().doc("employeeDetails/emp-jane").get()); await assertSucceeds(ADM().collection("employeeDetails").get()); await assertSucceeds(ADM().doc("employeeDetails/emp-jane").delete()); });
await t("details", "admin: zelfde batch als medewerker verwijderen slaagt", async () => { await seedDoc("employeeDetails/emp-jane", { role: "x", updatedAt: TS.now() }); const db = ADM(); const b = db.batch(); b.delete(db.doc("employees/emp-jane")); b.delete(db.doc("employeeDetails/emp-jane")); await assertSucceeds(b.commit()); });
await t("details", "medewerker: eigen details lezen faalt", async () => { await seedDoc("employeeDetails/emp-staff", { role: "x", updatedAt: TS.now() }); await assertFails(S().doc("employeeDetails/emp-staff").get()); await assertFails(S().collection("employeeDetails").get()); });
await t("details", "medewerker: details schrijven faalt", () => assertFails(S().doc("employeeDetails/emp-staff").set(details())));
await t("details", "reader: details lezen faalt", async () => { await seedDoc("employeeDetails/emp-jane", { role: "x", updatedAt: TS.now() }); const db = env.authenticatedContext(READER).firestore(); await assertFails(db.doc("employeeDetails/emp-jane").get()); await assertFails(db.collection("employeeDetails").get()); });
await t("details", "anoniem/niet ingelogd: lezen en schrijven faalt", async () => { await seedDoc("employeeDetails/emp-jane", { role: "x", updatedAt: TS.now() }); await assertFails(anonCtx().doc("employeeDetails/emp-jane").get()); await assertFails(anonCtx().doc("employeeDetails/emp-jane").set(details())); await assertFails(env.unauthenticatedContext().firestore().doc("employeeDetails/emp-jane").get()); });
await t("details", "onbekend veld (phone) faalt", () => assertFails(ADM().doc("employeeDetails/emp-jane").set(details({ phone: "0612345678" }))));
await t("details", "zonder updatedAt faalt", async () => { const d = details(); delete d.updatedAt; await assertFails(ADM().doc("employeeDetails/emp-jane").set(d)); });
await t("details", "eigen updatedAt faalt", () => assertFails(ADM().doc("employeeDetails/emp-jane").set(details({ updatedAt: TS.fromMillis(Date.now() - DAY) }))));
await t("details", "onbekende medewerker faalt", () => assertFails(ADM().doc("employeeDetails/emp-bestaatniet").set(details())));
await t("details", "functie > 40 tekens faalt", () => assertFails(ADM().doc("employeeDetails/emp-jane").set(details({ role: "x".repeat(41) }))));
await t("details", "lege functie faalt", () => assertFails(ADM().doc("employeeDetails/emp-jane").set(details({ role: "  " }))));
await t("details", "werkdag 7 faalt", () => assertFails(ADM().doc("employeeDetails/emp-jane").set(details({ workdays: [1, 7] }))));
await t("details", "dubbele werkdag faalt", () => assertFails(ADM().doc("employeeDetails/emp-jane").set(details({ workdays: [1, 1] }))));
await t("details", "werkdagen als tekst faalt", () => assertFails(ADM().doc("employeeDetails/emp-jane").set(details({ workdays: ["ma"] }))));
await t("details", "admin: alleen afdeling slaagt", () => assertSucceeds(ADM().doc("employeeDetails/emp-jane").set({ department: "Bouwstoffen", updatedAt: ST() })));
await t("details", "afdeling 40 tekens slaagt", () => assertSucceeds(ADM().doc("employeeDetails/emp-jane").set(details({ department: "x".repeat(40) }))));
await t("details", "afdeling > 40 tekens faalt", () => assertFails(ADM().doc("employeeDetails/emp-jane").set(details({ department: "x".repeat(41) }))));
await t("details", "lege afdeling faalt", () => assertFails(ADM().doc("employeeDetails/emp-jane").set(details({ department: "   " }))));
await t("details", "afdeling als getal faalt", () => assertFails(ADM().doc("employeeDetails/emp-jane").set(details({ department: 12 }))));
await t("details", "verwijderd veld staffNumber faalt", () => assertFails(ADM().doc("employeeDetails/emp-jane").set(details({ staffNumber: "HB12345" }))));
await t("details", "verwijderd veld contractHours faalt", () => assertFails(ADM().doc("employeeDetails/emp-jane").set(details({ contractHours: 32 }))));
await t("details", "verwijderd veld startDate faalt", () => assertFails(ADM().doc("employeeDetails/emp-jane").set(details({ startDate: "2021-03-01" }))));
await t("details", "onbekend veld (email) faalt", () => assertFails(ADM().doc("employeeDetails/emp-jane").set(details({ email: "a@b.nl" }))));
await t("details", "afdeling niet in employees: medewerker leest eigen employees-doc zonder afdeling", async () => { await seedDoc("employeeDetails/emp-staff", { department: "Tuin", updatedAt: TS.now() }); const snap = await assertSucceeds(S().doc("employees/emp-staff").get()); if ("department" in snap.data()) throw new Error("department in employees"); await assertFails(S().doc("employeeDetails/emp-staff").get()); });
await t("details", "reader: afdeling niet leesbaar", async () => { await seedDoc("employeeDetails/emp-jane", { department: "Tuin", updatedAt: TS.now() }); await assertFails(env.authenticatedContext(READER).firestore().doc("employeeDetails/emp-jane").get()); });
await t("details", "notitie > 500 faalt", () => assertFails(ADM().doc("employeeDetails/emp-jane").set(details({ note: "x".repeat(501) }))));
await t("details", "notitie 500 slaagt", () => assertSucceeds(ADM().doc("employeeDetails/emp-jane").set(details({ note: "x".repeat(500) }))));

// --- Build v2: locaties, spoed, herkomst, afgerond-door, audits, reader ---
const A = () => env.authenticatedContext(ADMIN).firestore();
const RD = () => env.authenticatedContext(READER).firestore();
const S2 = () => staffCtx("u-staff");
const locDoc = (over = {}) => ({ items: [{ id: "bkc", label: "BKC", order: 1, active: true }], labels: { bkc: "BKC" }, updatedAt: ST(), ...over });
const auditDoc = (over = {}) => ({ status: "bezig", auditDate: ymd(), startedAt: TS.now(), updatedAt: ST(), configVersion: 1, sections: [{ locationId: "bkc", questions: [] }], ...over });
const src = (over = {}) => ({ type: "audit", auditId: "a1", auditDate: ymd(), locationId: "pad-16", questionId: "massaplein", ...over });
const cfg = (over = {}) => ({ version: 1, updatedAt: ST(), sections: [], ...over });

// locaties
await t("v2-loc", "medewerker: settings/locations lezen slaagt", () => assertSucceeds(S2().doc("settings/locations").get()));
await t("v2-loc", "anoniem: settings/locations lezen faalt", () => assertFails(anonCtx().doc("settings/locations").get()));
await t("v2-loc", "reader: settings/locations lezen faalt", () => assertFails(RD().doc("settings/locations").get()));
await t("v2-loc", "inactieve medewerker: settings/locations lezen faalt", () => assertFails(staffCtx("u-inact").doc("settings/locations").get()));
await t("v2-loc", "medewerker: settings/locations schrijven faalt", () => assertFails(S2().doc("settings/locations").set(locDoc())));
await t("v2-loc", "medewerker: ander settings-doc lezen faalt", () => assertFails(S2().doc("settings/geheim").get()));
await t("v2-loc", "admin: locatielijst opslaan slaagt", () => assertSucceeds(A().doc("settings/locations").set(locDoc())));
await t("v2-loc", "admin: locatielijst zonder labels faalt", () => assertFails(A().doc("settings/locations").set({ items: [{ id: "bkc" }], updatedAt: ST() })));
await t("v2-loc", "admin: locatielijst met eigen updatedAt faalt", () => assertFails(A().doc("settings/locations").set(locDoc({ updatedAt: TS.now() }))));
await t("v2-loc", "admin: lege locatielijst faalt", () => assertFails(A().doc("settings/locations").set(locDoc({ items: [] }))));
await t("v2-loc", "admin: locatielijst met extra veld faalt", () => assertFails(A().doc("settings/locations").set(locDoc({ extra: 1 }))));
await t("v2-loc", "admin: ander settings-doc schrijven faalt", () => assertFails(A().doc("settings/anders").set(locDoc())));
await t("v2-loc", "eigen taak met geldige locatie slaagt", () => assertSucceeds(addTask(S2(), staffTask())));
await t("v2-loc", "eigen taak zonder locationId faalt", async () => { const d = staffTask(); delete d.locationId; d.location = ""; await assertFails(addTask(S2(), d)); });
await t("v2-loc", "eigen taak met onbekende locationId faalt", () => assertFails(addTask(S2(), staffTask({ locationId: "pad-99", location: "Pad 99" }))));
await t("v2-loc", "eigen taak met inactieve locatie faalt", () => assertFails(addTask(S2(), staffTask({ locationId: "oud-pad", location: "Oud pad" }))));
await t("v2-loc", "eigen taak met label dat niet bij id past faalt", () => assertFails(addTask(S2(), staffTask({ locationId: "pad-16", location: "BKC" }))));
await t("v2-loc", "eigen taak met vrije-tekst-locatie faalt", () => assertFails(addTask(S2(), staffTask({ location: "Achter de kassa" }))));
await t("v2-loc", "eigen taak met locationId in verkeerd formaat faalt", () => assertFails(addTask(S2(), staffTask({ locationId: "Pad 16" }))));
await t("v2-loc", "eigen taak zonder locatielijst faalt", async () => { await env.withSecurityRulesDisabled((c) => c.firestore().doc("settings/locations").delete()); await assertFails(addTask(S2(), staffTask())); });
await t("v2-loc", "admin: oude taak aan locatie koppelen (alleen locationId) slaagt", () => assertSucceeds(A().doc("tasks/t1").update({ locationId: "pad-16" })));
await t("v2-loc", "admin: locationId ontkoppelen slaagt", async () => { await seedDoc("tasks/t9", { title: "x", status: "open", locationId: "bkc", location: "oude tekst" }); await assertSucceeds(A().doc("tasks/t9").update({ locationId: firebase.firestore.FieldValue.delete() })); });
await t("v2-loc", "admin: locationId in verkeerd formaat faalt", () => assertFails(A().doc("tasks/t1").update({ locationId: "Pad 16!" })));
await t("v2-loc", "medewerker: locationId van taak wijzigen faalt", () => assertFails(S2().doc("tasks/t-own").update({ locationId: "bkc" })));
await t("v2-loc", "oude taak met vrije-tekst-locatie blijft leesbaar en afvinkbaar", async () => { await seedDoc("tasks/t-oud", { title: "Oud", description: "", status: "open", createdAt: iso(-30), photos: [], assigneeId: "", assigneeName: "", location: "Gang 12" }); await assertSucceeds(S2().doc("tasks/t-oud").get()); await assertSucceeds(tickB(S2(), "t-oud")); });

// spoed en herkomst
await t("v2-urgent", "eigen taak met urgent faalt", () => assertFails(addTask(S2(), staffTask({ urgent: true }))));
await t("v2-urgent", "eigen taak met urgent false faalt (veld niet toegestaan)", () => assertFails(addTask(S2(), staffTask({ urgent: false }))));
await t("v2-urgent", "eigen taak met source faalt", () => assertFails(addTask(S2(), staffTask({ source: src() }))));
await t("v2-urgent", "medewerker: urgent op taak zetten faalt", () => assertFails(S2().doc("tasks/t-own").update({ urgent: true })));
await t("v2-urgent", "medewerker: urgent meesturen bij afvinken faalt", () => assertFails(tickB(S2(), "t-own", { task: { urgent: true } })));
await t("v2-urgent", "medewerker: source meesturen bij afvinken faalt", () => assertFails(tickB(S2(), "t-own", { task: { source: src() } })));
await t("v2-urgent", "admin: spoed aan/uit slaagt", async () => { await assertSucceeds(A().doc("tasks/t1").update({ urgent: true })); await assertSucceeds(A().doc("tasks/t1").update({ urgent: false })); });
await t("v2-urgent", "admin: urgent als tekst faalt", () => assertFails(A().doc("tasks/t1").update({ urgent: "ja" })));
await t("v2-urgent", "admin: audit-taak met source slaagt", () => assertSucceeds(A().doc("tasks/audit-a1-pad-16-massaplein-rommelig").set({ title: "Pad 16 - Massaplein opruimen", description: "", assigneeId: "ALLEN", assigneeName: "Allen", status: "open", createdAt: iso(), photos: [], locationId: "pad-16", location: "Pad 16", urgent: false, source: src({ reasonId: "rommelig" }) })));
await t("v2-urgent", "admin: source met verkeerd type faalt", () => assertFails(A().doc("tasks/t1").update({ source: src({ type: "import" }) })));
await t("v2-urgent", "admin: source met extra veld faalt", () => assertFails(A().doc("tasks/t1").update({ source: src({ extra: "x" }) })));
await t("v2-urgent", "admin: source zonder questionId faalt", async () => { const x = src(); delete x.questionId; await assertFails(A().doc("tasks/t1").update({ source: x })); });
await t("v2-urgent", "admin: source met foute datum faalt", () => assertFails(A().doc("tasks/t1").update({ source: src({ auditDate: "19-11-2026" }) })));
await t("v2-urgent", "admin: source als tekst faalt", () => assertFails(A().doc("tasks/t1").update({ source: "audit" })));
await t("v2-urgent", "medewerker: audit-taak (Allen) afvinken slaagt", async () => { await seedDoc("tasks/t-audit", { title: "Pad 16 - Opruimen", description: "", assigneeId: "ALLEN", assigneeName: "Allen", status: "open", createdAt: iso(), photos: [], locationId: "pad-16", location: "Pad 16", urgent: false, source: src() }); await assertSucceeds(tickB(S2(), "t-audit")); });

// herhaal-instanties met locatie en spoed
const locInst = (over = {}) => ({ title: "Pad 16 vegen", description: "", assigneeId: "", assigneeName: "", status: "open", createdAt: iso(), photos: [], recurringId: "rec-loc", occurrenceDate: ymd(), location: "Pad 16", locationId: "pad-16", urgent: true, ...over });
await t("v2-rec", "instantie met locationId + urgent van sjabloon slaagt", () => assertSucceeds(S2().doc(`tasks/rec-loc_${ymd()}`).set(locInst())));
await t("v2-rec", "instantie zonder urgent (sjabloon heeft urgent) faalt", async () => { const d = locInst(); delete d.urgent; await assertFails(S2().doc(`tasks/rec-loc_${ymd()}`).set(d)); });
await t("v2-rec", "instantie met andere locationId faalt", () => assertFails(S2().doc(`tasks/rec-loc_${ymd()}`).set(locInst({ locationId: "bkc", location: "Pad 16" }))));
await t("v2-rec", "instantie met urgent bij sjabloon zonder urgent faalt", () => assertFails(S2().doc(`tasks/rec1_${ymd()}`).set(instance(ymd(), { urgent: true }))));
await t("v2-rec", "instantie met urgent false bij sjabloon zonder urgent slaagt", () => assertSucceeds(S2().doc(`tasks/rec1_${ymd()}`).set(instance(ymd(), { urgent: false }))));
await t("v2-rec", "instantie met locationId bij sjabloon zonder locatie faalt", () => assertFails(S2().doc(`tasks/rec1_${ymd()}`).set(instance(ymd(), { locationId: "pad-16" }))));
await t("v2-rec", "instantie met source faalt", () => assertFails(S2().doc(`tasks/rec-loc_${ymd()}`).set(locInst({ source: src() }))));
await t("v2-rec", "medewerker: sjabloon schrijven faalt", () => assertFails(S2().doc("recurring/rec-loc").update({ urgent: false })));
await t("v2-rec", "admin: sjabloon met locatie/spoed/weekdagen slaagt", () => assertSucceeds(A().doc("recurring/rec-new").set({ title: "Z-karren", description: "", assigneeId: "ALLEN", assigneeName: "Allen", photos: [], paused: false, locationId: "z-karren", location: "Z-karren", urgent: false, recurrence: { type: "weekdays", weekdays: [1, 4], startDate: ymd() } })));

// afgerond door (taskCompletions)
await t("v2-done", "medewerker: eigen completion lezen (query) slaagt", async () => { await tickB(S2(), "t-own"); await assertSucceeds(S2().collection("taskCompletions").where("employeeId", "==", "emp-staff").get()); });
await t("v2-done", "medewerker: andermans completion get faalt", () => assertFails(S2().doc("taskCompletions/t-pending-new").get()));
await t("v2-done", "medewerker: alle completions (lijst) faalt", () => assertFails(S2().collection("taskCompletions").get()));
await t("v2-done", "reader: completions lezen faalt", async () => { await assertFails(RD().doc("taskCompletions/t-pending-new").get()); await assertFails(RD().collection("taskCompletions").get()); });
await t("v2-done", "anoniem: completions lezen faalt", () => assertFails(anonCtx().collection("taskCompletions").get()));
await t("v2-done", "admin: completions lezen slaagt", () => assertSucceeds(A().collection("taskCompletions").get()));
await t("v2-done", "medewerker: losse completion zonder taakwijziging faalt", () => assertFails(S2().doc("taskCompletions/t-own").set(completion())));
await t("v2-done", "medewerker: completion met extra veld faalt", () => assertFails(tickB(S2(), "t-own", { comp: { note: "x" } })));
await t("v2-done", "medewerker: completion bij al afgevinkte taak overschrijven faalt", () => assertFails(S2().doc("taskCompletions/t-pending-new").set(completion())));
await t("v2-done", "medewerker: eigen nieuwe afvinking terugzetten (completion wissen) slaagt", async () => { await tickB(S2(), "t-own"); await new Promise((r) => setTimeout(r, 50)); await assertSucceeds(untickB(S2(), "t-own")); });
await t("v2-done", "medewerker: terugzetten zonder completion te wissen faalt", async () => { await tickB(S2(), "t-own"); await assertFails(untickB(S2(), "t-own", { delComp: false })); });
await t("v2-done", "medewerker: andermans nieuwe afvinking terugzetten faalt", () => assertFails(untickB(S2(), "t-pending-new")));
await t("v2-done", "medewerker: completion wissen zonder terugzetten faalt", async () => { await tickB(S2(), "t-own"); await assertFails(S2().doc("taskCompletions/t-own").delete()); });
await t("v2-done", "admin: goedkeuren laat completion staan", async () => { await assertSucceeds(A().doc("tasks/t-pending-new").update({ status: "afgerond", completedAt: iso() })); });
await t("v2-done", "admin: afwijzen = taak open + completion wissen slaagt", async () => { const db = A(); const b = db.batch(); b.update(db.doc("tasks/t-pending-new"), { status: "open" }); b.delete(db.doc("taskCompletions/t-pending-new")); await assertSucceeds(b.commit()); });
await t("v2-done", "admin: migratie oude afvinker naar completion slaagt", async () => { const db = A(); const b = db.batch(); b.set(db.doc("taskCompletions/t-pending-aart"), { employeeId: "emp-aart", name: "Aart", at: TS.now(), legacy: true }); b.update(db.doc("tasks/t-pending-aart"), { pendingAt: firebase.firestore.FieldValue.delete(), pendingBy: firebase.firestore.FieldValue.delete(), pendingByEmployeeId: firebase.firestore.FieldValue.delete() }); await assertSucceeds(b.commit()); });
await t("v2-done", "na migratie: oorspronkelijke afvinker kan terugzetten", async () => { await seedDoc("tasks/t-pending-aart", { title: "x", description: "", assigneeId: "ALLEN", assigneeName: "Allen", status: "pending", createdAt: iso(-1), photos: [] }); await seedDoc("taskCompletions/t-pending-aart", { employeeId: "emp-aart", name: "Aart", at: TS.now(), legacy: true }); await assertSucceeds(untickB(staffCtx("u-aart"), "t-pending-aart")); });
await t("v2-done", "taak-doc bevat na afvinken geen naam of tijd", async () => { await tickB(S2(), "t-own"); let d; await env.withSecurityRulesDisabled(async (c) => { d = (await c.firestore().doc("tasks/t-own").get()).data(); }); if (d.pendingBy || d.pendingAt || d.pendingByEmployeeId) throw new Error("naam/tijd op taak"); });

await t("v2-done", "ZL-1: verouderde completion (na afwijzing) overschrijven door collega bij opnieuw afvinken slaagt", async () => { await seedDoc("taskCompletions/t-allen", { employeeId: "emp-aart", name: "Aart", at: TS.fromMillis(Date.now() - DAY) }); await assertSucceeds(tickB(S2(), "t-allen")); let d; await env.withSecurityRulesDisabled(async (c) => { d = (await c.firestore().doc("taskCompletions/t-allen").get()).data(); }); if (d.employeeId !== "emp-staff" || "legacy" in d) throw new Error("niet overschreven"); });
await t("v2-done", "ZL-1: verouderde completion overschrijven zonder afvinken faalt", async () => { await seedDoc("taskCompletions/t-allen", { employeeId: "emp-aart", name: "Aart", at: TS.fromMillis(Date.now() - DAY) }); await assertFails(S2().doc("taskCompletions/t-allen").set(completion())); });
await t("v2-done", "ZL-1: admin-afwijzing wist de completion", async () => { const db = A(); const b = db.batch(); b.update(db.doc("tasks/t-pending-new"), { status: "open", rejectedCount: 1 }); b.delete(db.doc("taskCompletions/t-pending-new")); await assertSucceeds(b.commit()); let ex; await env.withSecurityRulesDisabled(async (c) => { ex = (await c.firestore().doc("taskCompletions/t-pending-new").get()).exists; }); if (ex) throw new Error("completion bestaat nog"); });
await t("v2-done", "ZL-2: eigenaar wist eigen legacy-completion (at null) bij terugzetten", async () => { await seedDoc("tasks/t-leg", { title: "x", description: "", assigneeId: "ALLEN", assigneeName: "Allen", status: "pending", createdAt: iso(-1), photos: [] }); await seedDoc("taskCompletions/t-leg", { employeeId: "emp-aart", name: "Aart", at: null, legacy: true }); await assertSucceeds(untickB(staffCtx("u-aart"), "t-leg")); });
await t("v2-done", "ZL-2: collega wist andermans legacy-completion faalt", async () => { await seedDoc("tasks/t-leg", { title: "x", description: "", assigneeId: "ALLEN", assigneeName: "Allen", status: "pending", createdAt: iso(-1), photos: [] }); await seedDoc("taskCompletions/t-leg", { employeeId: "emp-aart", name: "Aart", at: null, legacy: true }); await assertFails(untickB(S2(), "t-leg")); });
await t("v2-done", "ZL-2: eigen legacy-completion lezen (query) slaagt", async () => { await seedDoc("taskCompletions/t-leg", { employeeId: "emp-aart", name: "Aart", at: null, legacy: true }); await assertSucceeds(staffCtx("u-aart").collection("taskCompletions").where("employeeId", "==", "emp-aart").get()); });

// zl-vorm: exact dezelfde batches als origin/zl-build-v2 (app.js markPending/unmarkPending/onAddTaskSubmit, d218a85)
const DEL = () => firebase.firestore.FieldValue.delete();
const zlTick = (db, id, emp = "emp-staff", name = "Staff") => { const b = db.batch(); b.update(db.doc(`tasks/${id}`), { status: "pending", pendingAt: DEL(), pendingBy: DEL(), pendingByEmployeeId: DEL() }); b.set(db.doc(`taskCompletions/${id}`), { employeeId: emp, name, at: ST() }); return b.commit(); };
const zlUntickOwn = (db, id) => { const b = db.batch(); b.update(db.doc(`tasks/${id}`), { status: "open" }); b.delete(db.doc(`taskCompletions/${id}`)); return b.commit(); };
const zlUntickLegacy = (db, id) => db.doc(`tasks/${id}`).update({ status: "open", pendingAt: DEL(), pendingBy: DEL(), pendingByEmployeeId: DEL() });
const zlCreate = (over = {}) => ({ title: "Lamp kapot", description: "", location: "Pad 16", locationId: "pad-16", assigneeId: "emp-staff", assigneeName: "Staff", status: "open", createdAt: iso(), photos: [], createdByRole: "staff", createdByEmployeeId: "emp-staff", createdByName: "Staff", adminReview: "nieuw", ...over });
await t("zl-vorm", "ZL-taak aanmaken (13 velden, met teller) slaagt", async () => { if (Object.keys(zlCreate()).length !== 13) throw new Error("niet 13 velden"); await assertSucceeds(addTask(S2(), zlCreate())); });
await t("zl-vorm", "ZL-taak met inactieve locatie faalt", () => assertFails(addTask(S2(), zlCreate({ location: "Oud pad", locationId: "oud-pad" }))));
await t("zl-vorm", "ZL-taak zonder locationId (oude app) faalt", () => { const d = zlCreate(); delete d.locationId; return assertFails(addTask(S2(), d)); });
await t("zl-vorm", "ZL-afvinken (deleteField op ontbrekende velden + completion) slaagt", () => assertSucceeds(zlTick(S2(), "t-allen")));
await t("zl-vorm", "ZL-afvinken ruimt achtergebleven oude pending-velden op en slaagt", async () => { await seedDoc("tasks/t-rest", { title: "x", description: "", assigneeId: "ALLEN", assigneeName: "Allen", status: "open", createdAt: iso(-1), photos: [], pendingAt: null, pendingBy: null, pendingByEmployeeId: null }); await assertSucceeds(zlTick(S2(), "t-rest")); });
await t("zl-vorm", "ZL-afvinken met andere naam dan employees-doc faalt", () => assertFails(zlTick(S2(), "t-allen", "emp-staff", "Iemand anders")));
await t("zl-vorm", "ZL-terugzetten met eigen completion slaagt", async () => { await assertSucceeds(zlTick(S2(), "t-allen")); await assertSucceeds(zlUntickOwn(S2(), "t-allen")); });
await t("zl-vorm", "ZL-terugzetten oude afvinking zonder completion (eigen) slaagt", () => assertSucceeds(zlUntickLegacy(staffCtx("u-aart"), "t-pending-aart")));
await t("zl-vorm", "ZL-terugzetten oude afvinking zonder completion (collega) faalt", () => assertFails(zlUntickLegacy(S2(), "t-pending-aart")));
await t("zl-vorm", "ZL-terugzetten na migratie door collega faalt (completion van Aart bestaat)", async () => { await seedDoc("tasks/t-mig", { title: "x", description: "", assigneeId: "ALLEN", assigneeName: "Allen", status: "pending", createdAt: iso(-1), photos: [] }); await seedDoc("taskCompletions/t-mig", { employeeId: "emp-aart", name: "Aart", at: TS.now(), legacy: true }); await assertFails(zlUntickLegacy(S2(), "t-mig")); });
await t("zl-vorm", "ZL-terugzetten na migratie door eigenaar (eigen doc via query) slaagt", async () => { await seedDoc("tasks/t-mig", { title: "x", description: "", assigneeId: "ALLEN", assigneeName: "Allen", status: "pending", createdAt: iso(-1), photos: [] }); await seedDoc("taskCompletions/t-mig", { employeeId: "emp-aart", name: "Aart", at: TS.now(), legacy: true }); await assertSucceeds(zlUntickOwn(staffCtx("u-aart"), "t-mig")); });
await t("zl-vorm", "ZL-query eigen completions slaagt, zonder filter faalt", async () => { await assertSucceeds(S2().collection("taskCompletions").where("employeeId", "==", "emp-staff").get()); await assertFails(S2().collection("taskCompletions").get()); });
// Locatie "Overig" (eigenaar 12:46): actief, staffSelectable:false, dus niet in labels.
await t("v2-overig", "medewerker: taak met locatie Overig faalt", () => assertFails(addTask(S2(), zlCreate({ location: "Overig", locationId: "overig" }))));
await t("v2-overig", "admin: taak met locatie Overig slaagt", () => assertSucceeds(A().doc("tasks/t-ov").set({ title: "Overig klusje", description: "", assigneeId: "ALLEN", assigneeName: "Allen", status: "open", createdAt: iso(), photos: [], locationId: "overig", location: "Overig" })));
await t("v2-overig", "admin: audit-taak met locatie Overig slaagt", () => assertSucceeds(A().doc("tasks/audit-a1-overig-kopstellingen").set({ title: "Overig - Kopstellingen commercieel maken", description: "", assigneeId: "ALLEN", assigneeName: "Allen", status: "open", createdAt: iso(), photos: [], locationId: "overig", location: "Overig", urgent: false, source: src({ locationId: "overig", questionId: "kopstellingen" }) })));
await t("v2-overig", "admin: oude taak koppelen aan Overig slaagt", () => assertSucceeds(A().doc("tasks/t1").update({ locationId: "overig" })));
await t("v2-overig", "admin: locatielijst met staffSelectable opslaan slaagt", () => assertSucceeds(A().doc("settings/locations").set(locDoc({ items: [{ id: "bkc", label: "BKC", order: 1, active: true, staffSelectable: true }, { id: "overig", label: "Overig", order: 2, active: true, staffSelectable: false }], labels: { bkc: "BKC" } }))));
await t("v2-overig", "medewerker: Overig-taak afvinken (gedeeld) slaagt", async () => { await seedDoc("tasks/t-ov2", { title: "Overig - Gaatjesborden commercieel maken", description: "", assigneeId: "ALLEN", assigneeName: "Allen", status: "open", createdAt: iso(-1), photos: [], locationId: "overig", location: "Overig" }); await assertSucceeds(zlTick(S2(), "t-ov2")); });
// Toewijzing bij aanmaken door een medewerker (eigenaar 12:20): zichzelf of "Allen", geen collega.
await t("v2-assign", "medewerker: taak voor Allen (ALLEN/Allen) slaagt", () => assertSucceeds(addTask(S2(), zlCreate({ assigneeId: "ALLEN", assigneeName: "Allen" }))));
await t("v2-assign", "medewerker: taak voor zichzelf slaagt nog", () => assertSucceeds(addTask(S2(), zlCreate())));
await t("v2-assign", "medewerker: taak toewijzen aan collega faalt", () => assertFails(addTask(S2(), zlCreate({ assigneeId: "emp-aart", assigneeName: "Aart" }))));
await t("v2-assign", "medewerker: ALLEN met andere naam faalt", () => assertFails(addTask(S2(), zlCreate({ assigneeId: "ALLEN", assigneeName: "Staff" }))));
await t("v2-assign", "medewerker: Allen-naam met eigen id faalt", () => assertFails(addTask(S2(), zlCreate({ assigneeName: "Allen" }))));
await t("v2-assign", "medewerker: niet toegewezen (leeg) aanmaken faalt", () => assertFails(addTask(S2(), zlCreate({ assigneeId: "", assigneeName: "" }))));
await t("v2-assign", "medewerker: andermans Allen-taak afvinken slaagt (gedeeld)", async () => { await seedDoc("tasks/t-allen2", { title: "x", description: "", assigneeId: "ALLEN", assigneeName: "Allen", status: "open", createdAt: iso(-1), photos: [] }); await assertSucceeds(zlTick(S2(), "t-allen2")); });
await t("v2-assign", "medewerker: oude taak zonder persoon afvinken slaagt (telt als Allen)", async () => { await seedDoc("tasks/t-leeg", { title: "x", description: "", assigneeId: "", assigneeName: "", status: "open", createdAt: iso(-1), photos: [] }); await assertSucceeds(zlTick(S2(), "t-leeg")); });
await t("v2-assign", "medewerker: oude taak zonder assignee-velden afvinken slaagt", async () => { await seedDoc("tasks/t-geen", { title: "x", description: "", status: "open", createdAt: iso(-1), photos: [] }); await assertSucceeds(zlTick(S2(), "t-geen")); });

// vragenlijst
await t("v2-cfg", "admin: vragenlijst opslaan slaagt", () => assertSucceeds(A().doc("auditConfig/current").set(cfg())));
await t("v2-cfg", "admin: vragenlijst met version 0 faalt", () => assertFails(A().doc("auditConfig/current").set(cfg({ version: 0 }))));
await t("v2-cfg", "admin: vragenlijst met extra veld faalt", () => assertFails(A().doc("auditConfig/current").set(cfg({ x: 1 }))));
await t("v2-cfg", "admin: ander config-doc faalt", () => assertFails(A().doc("auditConfig/oud").set(cfg())));
await t("v2-cfg", "medewerker/reader: vragenlijst lezen faalt", async () => { await seedDoc("auditConfig/current", { version: 1, updatedAt: TS.now(), sections: [] }); await assertFails(S2().doc("auditConfig/current").get()); await assertFails(RD().doc("auditConfig/current").get()); });
await t("v2-cfg", "medewerker: vragenlijst schrijven faalt", () => assertFails(S2().doc("auditConfig/current").set(cfg())));

// audits
await t("v2-audit", "admin: concept-audit opslaan en afronden slaagt", async () => { const db = A(); await assertSucceeds(db.doc("audits/a2").set(auditDoc())); await assertSucceeds(db.doc("audits/a2").set(auditDoc({ status: "afgerond", completedAt: TS.now(), taskIds: ["t1"], taskCount: 1, notesCount: 0, score: { bkc: { good: 3, total: 4 } } }))); });
await t("v2-audit", "admin: audit met onbekende status faalt", () => assertFails(A().doc("audits/a2").set(auditDoc({ status: "klaar" }))));
await t("v2-audit", "admin: audit met eigen updatedAt faalt", () => assertFails(A().doc("audits/a2").set(auditDoc({ updatedAt: TS.now() }))));
await t("v2-audit", "admin: audit met extra veld faalt", () => assertFails(A().doc("audits/a2").set(auditDoc({ extra: 1 }))));
await t("v2-audit", "admin: audit met foute datum faalt", () => assertFails(A().doc("audits/a2").set(auditDoc({ auditDate: "vandaag" }))));
await t("v2-audit", "admin: audit-id met rare tekens faalt", () => assertFails(A().doc("audits/a b").set(auditDoc())));
await t("v2-audit", "reader: audits lezen slaagt", async () => { await assertSucceeds(RD().collection("audits").get()); await assertSucceeds(RD().doc("audits/a1").get()); });
await t("v2-audit", "reader: audit schrijven faalt", () => assertFails(RD().doc("audits/a2").set(auditDoc())));
await t("v2-audit", "medewerker: audits lezen/schrijven faalt", async () => { await assertFails(S2().doc("audits/a1").get()); await assertFails(S2().doc("audits/a2").set(auditDoc())); });
await t("v2-audit", "anoniem: audits lezen faalt", () => assertFails(anonCtx().collection("audits").get()));

// reader
await t("v2-reader", "reader: reports lezen slaagt", async () => { await assertSucceeds(RD().collection("reports").get()); await assertSucceeds(RD().doc("reports/r1").get()); });
await t("v2-reader", "reader: report wijzigen/wissen faalt", async () => { await assertFails(RD().doc("reports/r1").update({ status: "opgelost" })); await assertFails(RD().doc("reports/r1").delete()); });
await t("v2-reader", "reader: employeeDetails/taskCompletions/pinResetRequests faalt", async () => { await assertFails(RD().collection("employeeDetails").get()); await assertFails(RD().collection("taskCompletions").get()); await assertFails(RD().collection("pinResetRequests").get()); });
await t("v2-reader", "medewerker: reports lezen faalt nog steeds", () => assertFails(S2().collection("reports").get()));

// --- Review-fixes (13:01): admin-locatie verplicht alleen in de UI; herstel/noodknop blijven werken ---
await t("rv-fix", "admin: herstel oude taak zonder locationId (import/back-up) slaagt", () => assertSucceeds(A().doc("tasks/rv-legacy").set({ title: "Oud", description: "", assignee: "", status: "open", createdAt: iso(-3), photos: [], location: "Ergens" })));
await t("rv-fix", "admin: herstel oud sjabloon zonder locationId slaagt", () => assertSucceeds(A().doc("recurring/rv-tpl").set({ title: "Oud sjabloon", description: "", location: "", assignee: "", photos: [], paused: false, createdAt: iso(-3), recurrence: { type: "daily", startDate: ymd(-3) } })));
await t("rv-fix", "admin: oude taak bewerken met locatie, oude tekst blijft (K5) slaagt", async () => { await seedDoc("tasks/rv-k5", { title: "Oud", description: "", assignee: "", status: "open", createdAt: iso(-3), photos: [], location: "pad 16 links" }); await assertSucceeds(A().doc("tasks/rv-k5").update({ title: "Nieuw", locationId: "pad-16" })); });
await t("rv-fix", "admin: noodknop zet afvinker terug op taak en wist taskCompletions slaagt", async () => {
  await seedDoc("tasks/rv-pend", { title: "P", description: "", assigneeId: "ALLEN", assigneeName: "Allen", status: "pending", createdAt: iso(-1), photos: [], locationId: "pad-16", location: "Pad 16" });
  await seedDoc("taskCompletions/rv-pend", { employeeId: J.employeeId, name: "Jane", at: TS.now() });
  const db = A(); const b = db.batch();
  b.update(db.doc("tasks/rv-pend"), { pendingBy: "Jane", pendingByEmployeeId: J.employeeId, pendingAt: new Date().toISOString() });
  b.delete(db.doc("taskCompletions/rv-pend"));
  await assertSucceeds(b.commit());
});

// --- Reader en admin ---
await t("reader", "reader: tasks en employees lezen slaagt", async () => { const db = env.authenticatedContext(READER).firestore(); await assertSucceeds(db.collection("tasks").get()); await assertSucceeds(db.collection("employees").get()); });
await t("reader", "reader: geen startCodes/nameIndex/schrijven", async () => { const db = env.authenticatedContext(READER).firestore(); await assertFails(db.collection("startCodes").get()); await assertFails(db.collection("nameIndex").get()); await assertFails(db.doc("tasks/t1").update({ title: "x" })); });
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
console.log(`Emulator-poort: ${EMU_PORT}`);
console.log(`${pass}/${results.length} PASS`);
process.exit(pass === results.length ? 0 : 1);
