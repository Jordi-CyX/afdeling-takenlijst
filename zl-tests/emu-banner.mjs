// Emulatortest ZL v3c: Uitloggen + Naar beheer (ZLA) in de bovenbanner op 360 en 1280 px, canAdmin aan/uit.
import { chromium } from "playwright";
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire("/workspace/zl-v3c/tests/package.json");
const { initializeTestEnvironment } = require("@firebase/rules-unit-testing");
const { Timestamp } = require("firebase/firestore");
const ROOT = "/workspace/zl-v3c";
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
const setProfile = (fields) => admin(async (db) => {
  const ref = db.doc("staffProfiles/emp-test");
  if (Object.keys(fields).length) await ref.set({ ...fields, updatedAt: Timestamp.now() }); else await ref.delete();
});
const settle = () => p.waitForTimeout(1200);
const check = () => p.evaluate(() => {
  const vis = (el) => !!el && el.offsetParent !== null && getComputedStyle(el).display !== "none";
  const box = (id) => { const el = document.getElementById(id); if (!vis(el)) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), right: Math.round(r.right) }; };
  const header = document.querySelector("header .header-inner");
  return {
    beheer: box("admin-switch-btn"), uitloggen: box("logout-btn"), meer: box("header-more-btn"),
    beheerNaam: document.getElementById("admin-switch-btn").textContent.trim(),
    pageOverloop: document.documentElement.scrollWidth > window.innerWidth,
    headerOverloop: header.scrollWidth > header.clientWidth,
    menuHeeftLogoutOfBeheer: !!document.querySelector("#header-more-menu #logout-btn, #header-more-menu #admin-switch-btn")
  };
});
for (const [w, h] of [[360, 740], [1280, 800]]) {
  await p.setViewportSize({ width: w, height: h });
  await setProfile({}); await settle();
  R[`w${w}_canAdminUit`] = await check();
  await setProfile({ canAdmin: true }); await settle();
  R[`w${w}_canAdminAan`] = await check();
  await p.screenshot({ path: `/workspace/zl-v3c-banner-${w}.png`, clip: { x: 0, y: 0, width: w, height: 220 } });
}
await admin((db) => db.doc("settings/maintenance").set({ enabled: true, message: "Test", updatedAt: Timestamp.now() }));
await p.waitForSelector("#maintenance-screen:not(.hidden)", { timeout: 15000 });
R.onderhoud_knoppenZichtbaar = await p.evaluate(() => ["logout-btn", "admin-switch-btn"].some((id) => { const el = document.getElementById(id); return el.offsetParent !== null && getComputedStyle(el).display !== "none"; }));
await admin((db) => db.doc("settings/maintenance").set({ enabled: false, updatedAt: Timestamp.now() }));
await p.waitForSelector("#maintenance-screen.hidden", { state: "attached", timeout: 15000 });
await p.click("#logout-btn");
await p.waitForSelector("body.is-locked", { timeout: 15000 });
R.naUitloggen_inlogscherm = await p.isVisible("#staff-pin-form");
R.naUitloggen_knoppenZichtbaar = await p.evaluate(() => ["logout-btn", "admin-switch-btn"].some((id) => { const el = document.getElementById(id); return el.offsetParent !== null && getComputedStyle(el).display !== "none"; }));
R.pageErrors = errors;
console.log(JSON.stringify(R, null, 1));
await b.close();
await env.cleanup();
