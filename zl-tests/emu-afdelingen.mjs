// Emulatortest ZL v3b: zichtbaarheid per afdeling + schakelknop canAdmin. Zelfde opzet als emu-claim-onderhoud.mjs.
import { chromium } from "playwright";
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire("/workspace/zl-v3b/tests/package.json");
const { initializeTestEnvironment } = require("@firebase/rules-unit-testing");
const { Timestamp } = require("firebase/firestore");
const ROOT = "/workspace/zl-v3b";
const env = await initializeTestEnvironment({ projectId: "zeiklijst-live", firestore: { host: "127.0.0.1", port: 8096, rules: fs.readFileSync(process.env.ZL_RULES || ROOT + "/firestore.rules", "utf8") } });
const admin = (fn) => env.withSecurityRulesDisabled((c) => fn(c.firestore()));
const now = Timestamp.now();
const future = Timestamp.fromMillis(Date.now() + 86400000);
await admin(async (db) => {
  await db.doc("employees/emp-test").set({ name: "Test A", active: true, pinVersion: 1 });
  await db.doc("startCodes/ABCDEFGHJK").set({ employeeId: "emp-test", name: "Test A", pinVersion: 1, createdAt: now, expiresAt: future, used: false });
  const items = [
    { id: "p14", label: "Pad 14", order: 1, active: true, department: "sanitair" },
    { id: "p19", label: "Pad 19", order: 2, active: true, department: "tegels" },
    { id: "bkc", label: "BKC", order: 3, active: true, department: "beide" },
    { id: "p99", label: "Pad zonder afdeling", order: 4, active: true }
  ];
  await db.doc("settings/locations").set({ items, labels: Object.fromEntries(items.map((i) => [i.id, i.label])), departments: { p14: "sanitair", p19: "tegels", bkc: "beide" }, updatedAt: now });
  const base = { status: "open", assigneeId: "ALLEN", assigneeName: "Allen", createdAt: new Date().toISOString(), photos: [], description: "" };
  await db.doc("tasks/tS").set({ ...base, title: "San", locationId: "p14", location: "Pad 14" });
  await db.doc("tasks/tT").set({ ...base, title: "Teg", locationId: "p19", location: "Pad 19" });
  await db.doc("tasks/tB").set({ ...base, title: "Bei", locationId: "bkc", location: "BKC" });
  await db.doc("tasks/tN").set({ ...base, title: "Geen", locationId: "", location: "" });
  await db.doc("tasks/tX").set({ ...base, title: "Zonder afd", locationId: "p99", location: "Pad zonder afdeling" });
  await db.doc("tasks/tM").set({ ...base, title: "Mijn teg", locationId: "p19", location: "Pad 19", assigneeId: "emp-test", assigneeName: "Test A" });
});

const initSrc = fs.readFileSync(ROOT + "/firebase-init.js", "utf8") + `
import { connectFirestoreEmulator as __cfe } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";
import { connectAuthEmulator as __cae } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js";
__cfe(db, "127.0.0.1", 8096); __cae(auth, "http://127.0.0.1:9199", { disableWarnings: true });
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
await p.click("#staff-tab-register");
await p.fill("#staff-code-input", "ABCDEFGHJK");
await p.click("#staff-code-form button[type=submit]");
await p.waitForSelector("#staff-pin-setup-form:not(.hidden)", { timeout: 20000 });
await p.fill("#staff-pin-new", "135792");
await p.fill("#staff-pin-confirm", "135792");
await p.click("#staff-pin-setup-form button[type=submit]");
await p.waitForSelector("body:not(.is-locked)", { timeout: 20000 });
await p.click('#filter-chips [data-filter="all"]');
await p.waitForSelector('.task-item[data-task-id="tS"]', { timeout: 15000 });
// v3b: profiel in staffProfiles/{employeeId} (alleen admin schrijft; hier met regels uit gezet).
const setAcc = (fields) => admin(async (db) => {
  const ref = db.doc("staffProfiles/emp-test");
  if (Object.keys(fields).length) await ref.set({ ...fields, updatedAt: Timestamp.now() }); else await ref.delete();
});
await admin((db) => db.doc("staffProfiles/emp-ander").set({ department: "tegels", canAdmin: true, updatedAt: Timestamp.now() }));
const visible = () => p.evaluate(() => [...document.querySelectorAll(".task-item")].map((e) => e.dataset.taskId).sort().join(","));
const menuSwitch = async () => { await p.click("#header-more-btn"); const v = await p.isVisible("#admin-switch-btn"); const href = await p.getAttribute("#admin-switch-btn", "href"); await p.keyboard.press("Escape"); return v ? href : false; };
const settle = () => p.waitForTimeout(1200);
R.geenVelden = { taken: await visible(), knop: await menuSwitch() };
await setAcc({ department: "sanitair" }); await settle();
R.sanitair = { taken: await visible(), padfilter: await p.evaluate(() => [...document.querySelectorAll("#location-filter option")].map((o) => o.value).join(",")) };
await p.click("#add-task-fab");
R.sanitair_nieuweTaakLocaties = await p.evaluate(() => [...document.querySelectorAll("#add-task-location-input option")].map((o) => o.value).filter(Boolean).join(","));
await p.click("#add-task-cancel");
await setAcc({ department: "tegels" }); await settle();
R.tegels = await visible();
await setAcc({ department: "beide" }); await settle();
R.beide = await visible();
await setAcc({ department: "tegels", canAdmin: true }); await settle();
R.canAdminAan = await menuSwitch();
await p.click("#header-more-btn");
await p.screenshot({ path: "/workspace/zl-v3b-emu-tegels-admin.png" });
await p.keyboard.press("Escape");
await setAcc({ department: "tegels", canAdmin: false }); await settle();
R.canAdminUit = await menuSwitch();
await setAcc({}); await settle();
R.veldenWeer_weg = await visible();
R.profielAnderLezen = await p.evaluate(async () => {
  const { db } = await import("./firebase-init.js");
  const fs = await import("https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js");
  try { await fs.getDocFromServer(fs.doc(db, "staffProfiles", "emp-ander")); return "GELEZEN (fout!)"; } catch (e) { return e.code || String(e); }
});
R.profielEigenLezen = await p.evaluate(async () => {
  const { db } = await import("./firebase-init.js");
  const fs = await import("https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js");
  try { await fs.getDocFromServer(fs.doc(db, "staffProfiles", "emp-test")); return "ok"; } catch (e) { return e.code || String(e); }
});
R.pageErrors = errors;
console.log(JSON.stringify(R, null, 1));
await b.close();
await env.cleanup();
