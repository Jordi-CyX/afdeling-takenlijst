// V3C (admin v30): elk onderdeel op elke ZLA-pagina inklapbaar (stand per apparaat in localStorage)
// en de knoppen Uitloggen / terug naar ZL in de bovenbanner.
// Werkt op elk <h3>-kopje in de app: het kopje wordt een knop en klapt alles eronder in tot het
// volgende kopje (in een kaart: de hele kaart). Opnieuw getekende inhoud krijgt de stand direct terug.
import { FOLD_STORE_KEY, foldKey, parseFoldState, isFoldOpen, setFoldState } from "./v3c-logic.js?v=30";

// Niet inklappen: bestaande <details>-blokken (eigen pijl), de audit-wizard (één onderdeel per scherm),
// vraag-editors en dialoogvensters.
const SKIP = "summary, #audit-root, .question-editor, .modal, .print-view, [data-no-fold]";
let state = {};
let observer = null;
let queued = false;

function load() {
  try { return parseFoldState(localStorage.getItem(FOLD_STORE_KEY)); } catch { return {}; }
}
function save() {
  try { localStorage.setItem(FOLD_STORE_KEY, JSON.stringify(state)); } catch { /* privé-modus: alleen deze sessie */ }
}

function sectionOf(el) {
  const sec = el.closest(".admin-section[data-section]");
  return sec ? sec.dataset.section : "app";
}

function keyOf(h) {
  if (!h.dataset.foldKey) h.dataset.foldKey = foldKey(sectionOf(h), h.dataset.foldLabel || h.textContent);
  return h.dataset.foldKey;
}

// Alles na het kopje tot het volgende kopje van hetzelfde of een hoger niveau.
function bodyOf(h) {
  const out = [];
  for (let n = h.nextElementSibling; n; n = n.nextElementSibling) {
    if (/^H[1-3]$/.test(n.tagName) || n.classList.contains("back-up")) break;
    out.push(n);
  }
  return out;
}

function sync(h) {
  const open = isFoldOpen(state, keyOf(h));
  if (h.getAttribute("aria-expanded") !== String(open)) h.setAttribute("aria-expanded", String(open));
  h.classList.toggle("is-folded", !open);
  for (const n of bodyOf(h)) if (n.classList.contains("fold-hidden") === open) n.classList.toggle("fold-hidden", !open);
  const card = h.parentElement;
  if (card && card.classList.contains("emp-dash-card") && card.firstElementChild === h) card.classList.toggle("card-folded", !open);
}

function toggle(h) {
  const key = keyOf(h);
  const open = !isFoldOpen(state, key);
  state = setFoldState(state, key, open);
  save();
  // Zelfde kopje kan op meerdere plekken staan (bijv. na opnieuw tekenen): allemaal bijwerken.
  document.querySelectorAll("h3.fold-head").forEach((x) => { if (keyOf(x) === key) sync(x); });
}

function enhance(h) {
  h.classList.add("fold-head");
  h.setAttribute("role", "button");
  h.tabIndex = 0;
  h.title = "Tik om in of uit te klappen";
  h.dataset.foldReady = "1";
}

export function applyFolds(root) {
  const scope = root || document.getElementById("admin-app");
  if (!scope) return;
  scope.querySelectorAll("h3").forEach((h) => {
    if (h.closest(SKIP)) return;
    if (!h.dataset.foldReady) enhance(h);
    sync(h);
  });
}

function schedule() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => { queued = false; applyFolds(); });
}

export function isFoldHead(el) {
  return !!(el && el.classList && el.classList.contains("fold-head"));
}

export function initV3c() {
  state = load();
  const app = document.getElementById("admin-app");
  if (!app) return;
  // Eén luisteraar voor alle kopjes (ook kopjes die later getekend worden).
  app.addEventListener("click", (e) => {
    const h = e.target.closest && e.target.closest("h3.fold-head");
    if (!h || !app.contains(h) || e.target.closest("button, a, input, select, label")) return;
    toggle(h);
  });
  app.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const h = e.target;
    if (!isFoldHead(h)) return;
    e.preventDefault();
    toggle(h);
  });
  // Ander tabblad/venster wijzigt de stand: hier ook bijwerken.
  window.addEventListener("storage", (e) => {
    if (e.key !== FOLD_STORE_KEY) return;
    state = load();
    applyFolds();
  });
  applyFolds();
  observer = new MutationObserver(schedule);
  observer.observe(app, { childList: true, subtree: true });
}

