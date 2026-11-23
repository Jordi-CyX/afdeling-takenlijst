// Emulatortest ZL claim + onderhoud (v3a). Draaien: python3 -m http.server 8793 in de repo-root, dan in /tmp/zlemu:
// firebase emulators:exec --config firebase.json --only firestore,auth --project zeiklijst-live "cd /tmp/pw && node emu-claim.mjs"
// (Playwright in /tmp/pw; firebase-init.js wordt alleen in de test via een route naar de emulators omgeleid.)
import { chromium } from "playwright";
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire("/workspace/zl-v3a/tests/package.json");
const { initializeTestEnvironment } = require("@firebase/rules-unit-testing");
const { Timestamp } = require("firebase/firestore");
const ROOT = "/workspace/zl-v3a";
const env = await initializeTestEnvironment({ projectId: "zeiklijst-live", firestore: { host: "127.0.0.1", port: 8086, rules: fs.readFileSync(ROOT + "/firestore.rules", "utf8") } });
const admin = (fn) => env.withSecurityRulesDisabled((c) => fn(c.firestore()));
const now = Timestamp.now();
const future = Timestamp.fromMillis(Date.now() + 86400000);
await admin(async (db) => {
  await db.doc("employees/emp-test").set({ name: "Test A", active: true, pinVersion: 1 });
  await db.doc("employees/emp-ander").set({ name: "Test B", active: true, pinVersion: 1 });
  await db.doc("startCodes/ABCDEFGHJK").set({ employeeId: "emp-test", name: "Test A", pinVersion: 1, createdAt: now, expiresAt: future, used: false });
  await db.doc("settings/locations").set({ items: [{ id: "p14", label: "Pad 14", order: 1, active: true }], labels: { p14: "Pad 14" }, updatedAt: now });
  const base = { status: "open", assigneeId: "ALLEN", assigneeName: "Allen", locationId: "p14", location: "Pad 14", createdAt: new Date().toISOString(), photos: [], description: "" };
  await db.doc("tasks/t1").set({ ...base, title: "Testtaak een" });
  await db.doc("tasks/t2").set({ ...base, title: "Testtaak twee", claimedBy: { employeeId: "emp-ander", name: "Test B" }, claimedAt: now });
  await db.doc("settings/maintenance").set({ enabled: true, message: "Testonderhoud, zo terug.", updatedAt: now });
});
const setMaint = (enabled) => admin((db) => db.doc("settings/maintenance").set({ enabled, message: "Testonderhoud, zo terug.", updatedAt: Timestamp.now() }));
const getTask = async (id) => { let d; await admin(async (db) => { d = (await db.doc("tasks/" + id).get()).data(); }); return d; };

const initSrc = fs.readFileSync(ROOT + "/firebase-init.js", "utf8") + `
import { connectFirestoreEmulator as __cfe } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";
import { connectAuthEmulator as __cae } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js";
__cfe(db, "127.0.0.1", 8086); __cae(auth, "http://127.0.0.1:9099", { disableWarnings: true });
`;
const html = fs.readFileSync(ROOT + "/index.html", "utf8").replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "");
const b = await chromium.launch({ args: ["--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,BlockInsecurePrivateNetworkRequests"] });
const ctx = await b.newContext({ viewport: { width: 390, height: 800 }, serviceWorkers: "block" });
const p = await ctx.newPage();
const errors = [];
p.on("requestfailed", (r) => console.log("REQFAIL", r.url().slice(0, 150)));
p.on("pageerror", (e) => errors.push(e.message));
p.on("console", (m) => { if (["error","warning"].includes(m.type())) console.log("CONSOLE", m.text().slice(0, 300)); });
await p.route((u) => /(googleapis|firebaseio|firebaseapp|gstatic|google)\.com$/.test(u.hostname), (r) => r.abort());
await p.route(/\/firebase-init\.js(\?.*)?$/, (r) => r.fulfill({ contentType: "text/javascript", body: initSrc }));
await p.route(/:8793\/(index\.html)?$/, (r) => r.fulfill({ contentType: "text/html", body: html }));
const R = {};
await p.goto("http://127.0.0.1:8793/index.html");
await p.waitForSelector("#maintenance-screen:not(.hidden)", { timeout: 15000 });
R.voorInloggen_onderhoudAan = (await p.textContent("#maintenance-message")).trim();
await p.screenshot({ path: "/workspace/zl-v3a-emu-onderhoud.png" });
await setMaint(false);
await p.waitForSelector("#maintenance-screen.hidden", { state: "attached", timeout: 15000 });
R.voorInloggen_onderhoudUit_loginZichtbaar = await p.isVisible("#staff-pin-form");
await p.click("#staff-tab-register");
await p.fill("#staff-code-input", "ABCDEFGHJK");
await p.click("#staff-code-form button[type=submit]");
try { await p.waitForSelector("#staff-pin-setup-form:not(.hidden)", { timeout: 20000 }); }
catch (e) { console.log("CODE-ERR", await p.textContent("#staff-code-error"), await p.inputValue("#staff-code-input")); throw e; }
await p.fill("#staff-pin-new", "135792");
await p.fill("#staff-pin-confirm", "135792");
await p.click("#staff-pin-setup-form button[type=submit]");
await p.waitForSelector("body:not(.is-locked)", { timeout: 20000 });
await p.waitForSelector('.task-item[data-task-id="t1"]', { timeout: 15000 });
R.ingelogd = true;
R.codeveldLeeg = (await p.inputValue("#staff-code-input")) === "" && (await p.inputValue("#staff-pin-new")) === "";
await p.click('.task-item[data-task-id="t1"]');
await p.click("#claim-btn");
await p.waitForFunction(() => /Opgepakt door jou/.test(document.querySelector('.task-item[data-task-id="t1"]')?.textContent || ""), null, { timeout: 15000 });
let t1 = await getTask("t1");
R.claim_doc = { claimedBy: t1.claimedBy, claimedAtIsTimestamp: typeof t1.claimedAt?.toMillis === "function" };
await p.waitForTimeout(1700);
await p.waitForSelector("#release-btn", { timeout: 10000 });
await p.click("#release-btn");
await p.waitForFunction(() => !/Opgepakt/.test(document.querySelector('.task-item[data-task-id="t1"]')?.textContent || "x"), null, { timeout: 15000 });
t1 = await getTask("t1");
R.loslaten_doc = { heeftClaimedBy: "claimedBy" in t1, heeftClaimedAt: "claimedAt" in t1 };
await p.click("#modal-close");
await p.click('.task-item[data-task-id="t2"]');
R.andermansClaim_tekst = (await p.textContent("#modal-actions .task-claim")).trim();
R.andermansClaim_loslatenKnop = await p.isVisible("#release-btn");
R.andermansClaim_ikPakKnop = await p.isVisible("#claim-btn");
R.andermansClaim_directWeghalen = await p.evaluate(async () => {
  const { db } = await import("./firebase-init.js");
  const fs = await import("https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js");
  try { await fs.updateDoc(fs.doc(db, "tasks", "t2"), { claimedBy: fs.deleteField(), claimedAt: fs.deleteField() }); return "GELUKT (fout!)"; }
  catch (e) { return e.code || String(e); }
});
await p.click("#modal-close");
await setMaint(true);
await p.waitForSelector("#maintenance-screen:not(.hidden)", { timeout: 15000 });
R.ingelogd_onderhoudAan = await p.isVisible("#maintenance-screen");
await setMaint(false);
await p.waitForSelector("#maintenance-screen.hidden", { state: "attached", timeout: 15000 });
R.ingelogd_onderhoudUit_appTerug = await p.isVisible('.task-item[data-task-id="t1"]');
R.pageErrors = errors;
console.log(JSON.stringify(R, null, 1));
await b.close();
await env.cleanup();
