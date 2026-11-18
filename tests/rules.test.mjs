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
await t("account", "oude-methode-account: melding maken faalt", () => assertFails(staffCtx("u-legacy").collection("reports").add(report())));
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
await t("M3", "melding met geldige foto ~249000 tekens slaagt", () => assertSucceeds(staffCtx("u-staff").collection("reports").add(report({ photo: "data:image/jpeg;base64," + "A".repeat(249000) }))));
await t("M3", "afvinken met pendingAt 3 dagen terug faalt", () => assertFails(staffCtx("u-staff").doc("tasks/t-own").update(tick({ pendingAt: iso(-3) }))));
await t("M3", "afvinken met pendingBy van iemand anders faalt", () => assertFails(staffCtx("u-staff").doc("tasks/t-own").update(tick({ pendingBy: "Jane" }))));
await t("M3", "afvinken met pendingAt ver in de toekomst faalt", () => assertFails(staffCtx("u-staff").doc("tasks/t-own").update(tick({ pendingAt: iso(30) }))));
await t("L2", "afvinken met extra veld (title) faalt", () => assertFails(staffCtx("u-staff").doc("tasks/t-own").update({ ...tick(), title: "x" })));

// --- M3: eigen taken en meldingen ---
await t("M3", "eigen taak met geldige foto slaagt", () => assertSucceeds(staffCtx("u-staff").collection("tasks").add(staffTask({ photos: [GOOD_PHOTO] }))));
await t("M3", "eigen taak zonder foto slaagt", () => assertSucceeds(staffCtx("u-staff").collection("tasks").add(staffTask())));
await t("M3", "eigen taak met 2 foto's faalt", () => assertFails(staffCtx("u-staff").collection("tasks").add(staffTask({ photos: [GOOD_PHOTO, GOOD_PHOTO] }))));
await t("M3", "eigen taak met foto > 250000 tekens faalt", () => assertFails(staffCtx("u-staff").collection("tasks").add(staffTask({ photos: ["data:image/jpeg;base64," + "A".repeat(250000)] }))));
await t("M3", "eigen taak met foto ~249000 tekens slaagt", () => assertSucceeds(staffCtx("u-staff").collection("tasks").add(staffTask({ photos: ["data:image/jpeg;base64," + "A".repeat(249000)] }))));
await t("M3", "eigen taak met foute foto-string faalt", () => assertFails(staffCtx("u-staff").collection("tasks").add(staffTask({ photos: [BAD_PHOTO] }))));
await t("M3", "eigen taak met svg-foto faalt", () => assertFails(staffCtx("u-staff").collection("tasks").add(staffTask({ photos: ["data:image/svg+xml;base64,PHN2Zz4="] }))));
await t("M3", "eigen taak met titel > 120 faalt", () => assertFails(staffCtx("u-staff").collection("tasks").add(staffTask({ title: "x".repeat(121) }))));
await t("M3", "eigen taak met omschrijving > 2000 faalt", () => assertFails(staffCtx("u-staff").collection("tasks").add(staffTask({ description: "x".repeat(2001) }))));
await t("M3", "eigen taak met locatie > 120 faalt", () => assertFails(staffCtx("u-staff").collection("tasks").add(staffTask({ location: "x".repeat(121) }))));
await t("M3", "eigen taak met dueDate faalt", () => assertFails(staffCtx("u-staff").collection("tasks").add(staffTask({ dueDate: ymd(1) }))));
await t("L9", "eigen taak met createdAt over 10 dagen faalt", () => assertFails(staffCtx("u-staff").collection("tasks").add(staffTask({ createdAt: iso(10) }))));
await t("L9", "eigen taak met createdAt 10 dagen terug faalt", () => assertFails(staffCtx("u-staff").collection("tasks").add(staffTask({ createdAt: iso(-10) }))));
await t("M3", "melding met geldige foto slaagt", () => assertSucceeds(staffCtx("u-staff").collection("reports").add(report({ photo: GOOD_PHOTO }))));
await t("M3", "melding met foto > 250000 tekens faalt", () => assertFails(staffCtx("u-staff").collection("reports").add(report({ photo: "data:image/jpeg;base64," + "A".repeat(250000) }))));
await t("M3", "melding met foute foto-string faalt", () => assertFails(staffCtx("u-staff").collection("reports").add(report({ photo: BAD_PHOTO }))));
await t("M3", "melding met omschrijving > 1000 faalt", () => assertFails(staffCtx("u-staff").collection("reports").add(report({ description: "x".repeat(1001) }))));
await t("M3", "melding met device > 300 faalt", () => assertFails(staffCtx("u-staff").collection("reports").add(report({ device: "x".repeat(301) }))));
await t("M3", "melding met appVersion > 40 faalt", () => assertFails(staffCtx("u-staff").collection("reports").add(report({ appVersion: "x".repeat(41) }))));
await t("M3", "inactief: melding maken faalt", () => assertFails(staffCtx("u-inact").collection("reports").add({ ...report(), employeeId: "emp-inact", employeeName: "Inact" })));
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
await t("M2", "anoniem: verzoek met willekeurig id slaagt", () => assertSucceeds(anonCtx().collection("pinResetRequests").add({ name: "Jane", requestedAt: ST() })));
await t("M2", "anoniem: verzoek met note slaagt", () => assertSucceeds(anonCtx().collection("pinResetRequests").add({ name: "Jane", requestedAt: ST(), note: "nieuwe telefoon" })));
await t("M2", "verzoek met naam > 60 faalt", () => assertFails(anonCtx().collection("pinResetRequests").add({ name: "x".repeat(61), requestedAt: ST() })));
await t("M2", "verzoek met lege naam faalt", () => assertFails(anonCtx().collection("pinResetRequests").add({ name: "   ", requestedAt: ST() })));
await t("M2", "verzoek met note > 200 faalt", () => assertFails(anonCtx().collection("pinResetRequests").add({ name: "Jane", requestedAt: ST(), note: "x".repeat(201) })));
await t("M2", "verzoek met extra veld (employeeId) faalt", () => assertFails(anonCtx().collection("pinResetRequests").add({ name: "Jane", requestedAt: ST(), employeeId: "emp-jane" })));
await t("M2", "verzoek met eigen tijd faalt", () => assertFails(anonCtx().collection("pinResetRequests").add({ name: "Jane", requestedAt: TS.fromMillis(Date.now() - DAY) })));
await t("M2", "verzoek met employeeId als doc-id faalt", () => assertFails(anonCtx().doc("pinResetRequests/emp-jane").set({ name: "Jane", requestedAt: ST() })));
await t("M2", "bestaand verzoek overschrijven faalt", () => assertFails(anonCtx().doc("pinResetRequests/oldreq0000000000001").set({ name: "Hacker", requestedAt: ST() })));
await t("M2", "verzoek lezen door niet-admin faalt", () => assertFails(anonCtx().doc("pinResetRequests/oldreq0000000000001").get()));
await t("M2", "niet ingelogd: verzoek faalt", () => assertFails(env.unauthenticatedContext().firestore().collection("pinResetRequests").add({ name: "Jane", requestedAt: ST() })));
await t("M2", "verzoek geeft geen toegang", async () => { const db = anonCtx(); await db.collection("pinResetRequests").add({ name: "Jane", requestedAt: ST() }); await assertFails(db.doc("tasks/t1").get()); });

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
