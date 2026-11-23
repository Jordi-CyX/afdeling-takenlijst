// Alleen-lezen controle vóór livegang van de admin (ZLA). Schrijft niets, publiceert niets.
// Gebruik: node tests/deploy-check.mjs [--expect <commit>] [--branch v3a] [--run-tests] [--live-url https://…/admin/version.js]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const arg = (k, d = "") => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? (process.argv[i + 1] || "") : d; };
const has = (k) => process.argv.includes(`--${k}`);
const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim();
const res = [];
const ok = (name, cond, extra = "") => { res.push(cond); console.log(`${cond ? "OK  " : "FOUT"} ${name}${extra ? ` — ${extra}` : ""}`); };

const head = git("rev-parse", "HEAD");
const expect = arg("expect");
if (expect) ok("HEAD is de verwachte commit", head.startsWith(expect), head.slice(0, 10));
const dirty = git("status", "--porcelain", "--untracked-files=no");
ok("werkmap schoon (getrackte bestanden)", !dirty, dirty.split("\n").slice(0, 5).join("; "));
const branch = arg("branch", "v3a");
try {
  git("fetch", "--quiet", "origin", branch);
  ok(`HEAD staat op origin/${branch}`, git("rev-parse", `origin/${branch}`) === head || git("merge-base", "--is-ancestor", "HEAD", `origin/${branch}`) === "");
} catch {
  ok(`HEAD staat op origin/${branch}`, false, "fetch of vergelijking mislukt");
}

const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
const version = Number((read("admin/version.js").match(/ZEIKLIJST_ADMIN_VERSION\s*=\s*(\d+)/) || [])[1]);
ok("admin/version.js heeft een versie", Number.isInteger(version), String(version));
const html = read("admin/index.html");
for (const f of ["version.js", "admin.js", "admin.css", "manifest.webmanifest"]) {
  const m = html.match(new RegExp(`${f.replace(".", "\\.")}\\?v=(\\d+)`));
  if (m || f !== "manifest.webmanifest") ok(`index.html: ${f}?v=${version}`, m && Number(m[1]) === version, m ? `v=${m[1]}` : "niet gevonden");
}
const own = ["admin.js", "v2.js", "v3a.js", "v3b.js"];
for (const f of own) {
  const src = read(`admin/${f}`);
  const bad = [...src.matchAll(/from\s+"\.\/([a-z0-9-]+\.js)(\?v=(\d+))?"/g)].filter((m) => Number(m[3]) !== version).map((m) => m[1] + (m[2] || ""));
  ok(`${f}: eigen modules met ?v=${version}`, !bad.length, bad.join(", "));
}
const sw = read("admin/sw.js");
const assets = [...(sw.match(/ASSETS\s*=\s*\[([\s\S]*?)\]/) || ["", ""])[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const needed = ["./v2.js", "./v3a.js", "./v3a-logic.js", "./v3b.js", "./v3b-logic.js", "./update-guard.js", "./xlsx-export.js", "./audit-defaults.js"];
ok("sw.js ASSETS bevat alle admin-modules", needed.every((n) => assets.some((a) => a.split("?")[0] === n)), needed.filter((n) => !assets.some((a) => a.split("?")[0] === n)).join(", "));

if (has("run-tests")) {
  for (const s of ["test:unit", "test", "test:alt"]) {
    try { execFileSync("npm", ["run", "--silent", s], { cwd: path.join(ROOT, "tests"), stdio: "ignore" }); ok(`npm run ${s}`, true); } catch { ok(`npm run ${s}`, false); }
  }
}
const live = arg("live-url");
if (live) {
  try {
    const txt = await (await fetch(live, { cache: "no-store" })).text();
    const lv = Number((txt.match(/ZEIKLIJST_ADMIN_VERSION\s*=\s*(\d+)/) || [])[1]);
    ok("live admin-versie (alleen lezen)", Number.isInteger(lv), `live v${lv}, repo v${version}`);
  } catch (e) { ok("live admin-versie (alleen lezen)", false, String(e.message || e)); }
}
const pass = res.filter(Boolean).length;
console.log(`${pass}/${res.length} OK`);
process.exit(pass === res.length ? 0 : 1);
