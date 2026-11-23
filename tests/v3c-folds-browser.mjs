// Draait tests/v3c-folds.html in headless Chrome (lokale http-server, geen Firebase, geen netwerk naar buiten).
// Gebruik: node tests/v3c-folds-browser.mjs [--chrome /pad/naar/chrome]
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!p.startsWith(ROOT) || !existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": types[path.extname(p)] || "application/octet-stream" });
  res.end(readFileSync(p));
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const port = server.address().port;
const i = process.argv.indexOf("--chrome");
const chrome = i > 0 ? process.argv[i + 1] : ["google-chrome", "chromium", "chromium-browser"].find((c) => { try { execFileSync("which", [c], { stdio: "ignore" }); return true; } catch { return false; } });
const out = await new Promise((resolve) => {
  const p = spawn(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--window-size=390,800", "--virtual-time-budget=5000", "--dump-dom", `http://127.0.0.1:${port}/tests/v3c-folds.html`]);
  let s = ""; p.stdout.on("data", (d) => { s += d; }); p.on("close", () => resolve(s));
});
server.close();
const m = out.match(/<pre id="out">([\s\S]*?)<\/pre>/);
const text = m ? m[1].replace(/&amp;/g, "&") : "geen uitvoer";
console.log(text);
const r = text.match(/RESULT (\d+)\/(\d+)/);
process.exit(r && r[1] === r[2] ? 0 : 1);
