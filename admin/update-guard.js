// Auto-verversen (eigenaar 13:31, afgestemd met het patroon van ZL). Pure beslislogica, ook in Node te testen.
// - register("./sw.js", { updateViaCache: "none" }); reg.update() bij openen, bij zichtbaar worden en elke 5 min.
// - SW doet GEEN automatische skipWaiting: de pagina stuurt { type: "SKIP_WAITING" } naar de wachtende worker
//   zodra de gebruiker niet bezig is (decideWaiting). Bezig = balk "Nieuwe versie, tik om te verversen".
// - activate: clients.claim(). controllerchange: één keer herladen (decideReload), bewaakt met
//   sessionStorage "zeiklijst-admin-sw-reload" (staff-app gebruikt "zeiklijst-sw-reload"; zelfde origin, dus aparte sleutels) ({ flag, at }), hooguit 1x per 30 s; niet bij eerste installatie.
export const UPDATE_CHECK_MS = 5 * 60 * 1000;
export const RELOAD_GUARD_KEY = "zeiklijst-admin-sw-reload";
export const RELOAD_GUARD_MS = 30 * 1000;
export const UPDATE_BAR_TEXT = "Nieuwe versie, tik om te verversen";

// Er staat een nieuwe worker klaar ("waiting"). busy = audit loopt, venster open, formulier met invoer, export bezig.
export function decideWaiting({ hasWaiting, hadController, busy }) {
  if (!hasWaiting || !hadController) return "none"; // eerste installatie: niets te doen
  return busy ? "bar" : "skip";
}

// De pagina kreeg een nieuwe controller. hadController = was er al een SW bij het laden van de pagina?
export function decideReload({ hadController, guard, now }) {
  if (!hadController) return "none"; // eerste installatie: niet herladen
  if (guard && guard.flag === true && now - Number(guard.at) < RELOAD_GUARD_MS) return "none"; // geen lus
  return "reload";
}

export function makeGuard(now) {
  return JSON.stringify({ flag: true, at: now });
}

export function readGuard(raw) {
  try {
    const g = JSON.parse(raw || "null");
    return g && typeof g === "object" && g.flag === true && Number.isFinite(Number(g.at)) ? g : null;
  } catch {
    return null;
  }
}

// V3A (fix 15c): de pagina /admin/ kan bij het eerste bezoek al door de staff-SW (scope "/") worden bestuurd.
// Alleen een controller met scriptURL op /admin/sw.js telt als "eigen"; anders geldt het als eerste installatie
// van de admin-SW en wordt er niet herladen.
export function isOwnController(scriptURL) {
  if (typeof scriptURL !== "string" || !scriptURL) return false;
  let path = scriptURL;
  try { path = new URL(scriptURL).pathname; } catch { path = scriptURL.split(/[?#]/)[0]; }
  return /\/admin\/sw\.js$/.test(path);
}

// V3A: het inlogformulier telt als "bezig" zodra er iets is ingevuld of een veld focus heeft.
export function isLoginBusy({ loginVisible, emailValue, passwordValue, focused }) {
  if (!loginVisible) return false;
  return Boolean(focused) || Boolean(String(emailValue || "").length) || Boolean(String(passwordValue || "").length);
}
