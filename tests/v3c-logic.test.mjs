// Unit-tests voor admin/v3c-logic.js (V3C). Draai: node tests/v3c-logic.test.mjs
import * as L from "../admin/v3c-logic.js";
const results = [];
const t = (name, got, want) => { const g = JSON.stringify(got); const w = JSON.stringify(want); results.push([g === w ? "PASS" : "FAIL", name, g === w ? "" : `${g} != ${w}`]); };

// Inklappen (punt 4)
t("foldKey: pagina + kopje", L.foldKey("audits", "Audit-varianten"), "audits:audit varianten");
t("foldKey: variantnaam na · telt niet", L.foldKey("audits", "Vragenlijst en ronde · Netheid"), L.foldKey("audits", "Vragenlijst en ronde"));
t("foldKey: tellers/cijfers tellen niet", L.foldKey("dashboard", "Streefdatum verstreken (3)"), L.foldKey("dashboard", "Streefdatum verstreken (12)"));
t("foldKey: zelfde kopje op andere pagina = andere sleutel", L.foldKey("dashboard", "Pincode vergeten") !== L.foldKey("medewerkers", "Pincode vergeten"), true);
t("foldKey: leeg kopje", L.foldKey("", ""), "app:onderdeel");
t("foldKey: accenten blijven", L.foldKey("data", "Export / import (oud formaat)"), "data:export import");
t("parseFoldState: rommel = leeg", L.parseFoldState("{kapot"), {});
t("parseFoldState: alleen booleans", L.parseFoldState(JSON.stringify({ a: false, b: "x", c: true })), { a: false, c: true });
t("parseFoldState: lijst = leeg", L.parseFoldState("[1,2]"), {});
t("isFoldOpen: standaard open", L.isFoldOpen({}, "x"), true);
t("isFoldOpen: ingeklapt", L.isFoldOpen({ x: false }, "x"), false);
const s1 = L.setFoldState({}, "x", false);
t("setFoldState: inklappen bewaart false", s1, { x: false });
t("setFoldState: openklappen verwijdert sleutel", L.setFoldState(s1, "x", true), {});
t("setFoldState: muteert niet", s1, { x: false });

// Vragenbank (punt 6)
t("normalize: directe taak", L.normalizeBankQuestion({ text: " Vloer schoon? ", trigger: "nee", taskText: "{locatie} - vegen", id: "x", note: "n" }), { text: "Vloer schoon?", trigger: "nee", taskText: "{locatie} - vegen" });
t("normalize: onbekende trigger = nee", L.normalizeBankQuestion({ text: "a", trigger: "?", taskText: "b" }).trigger, "nee");
t("normalize: zonder tekst = null", L.normalizeBankQuestion({ text: " ", taskText: "b" }), null);
t("normalize: zonder taaktekst = null", L.normalizeBankQuestion({ text: "a" }), null);
t("normalize: controlevraag", L.normalizeBankQuestion({ text: "a", trigger: "nee", followUp: { text: "Voorraad?", trigger: "ja", taskText: "Bijvullen", x: 1 } }), { text: "a", trigger: "nee", followUp: { text: "Voorraad?", trigger: "ja", taskText: "Bijvullen" } });
t("normalize: onvolledige controlevraag = null", L.normalizeBankQuestion({ text: "a", followUp: { text: "b" } }), null);
t("normalize: keuzes (lege weg, id aangevuld)", L.normalizeBankQuestion({ text: "a", reasons: [{ label: "Vuil", taskText: "Schoon" }, { label: "", taskText: "x" }] }).reasons, [{ id: "keuze-1", label: "Vuil", taskText: "Schoon" }]);
t("normalize: max 20 keuzes", L.normalizeBankQuestion({ text: "a", reasons: Array(25).fill({ id: "k", label: "a", taskText: "b" }) }).reasons.length, 20);
t("normalize: lengtes afgekapt", [L.normalizeBankQuestion({ text: "x".repeat(300), taskText: "y".repeat(300) }).text.length, L.normalizeBankQuestion({ text: "x", taskText: "y".repeat(300) }).taskText.length], [200, 120]);
t("bankPayload: alleen toegestane velden", Object.keys(L.bankPayload({ text: "a", trigger: "ja", taskText: "b", id: "q1", note: "x", answer: "ja" })).sort(), ["taskText", "text", "trigger"]);
t("bankPayload: ongeldig = null", L.bankPayload({ text: "" }), null);
t("bankFromQuestion: id en antwoorden weg", L.bankFromQuestion({ id: "q", text: "a", trigger: "nee", taskText: "b", answer: "nee" }), { text: "a", trigger: "nee", taskText: "b" });
const nq = L.questionFromBank({ text: "Vloer schoon?", trigger: "nee", taskText: "t" }, ["vloer-schoon"]);
t("questionFromBank: uniek id binnen onderdeel", nq.id, "vloer-schoon-2");
t("questionFromBank: inhoud gekopieerd", [nq.text, nq.trigger, nq.taskText], ["Vloer schoon?", "nee", "t"]);
const src = { text: "a", trigger: "nee", reasons: [{ id: "r", label: "l", taskText: "t" }] };
const copy = L.questionFromBank(src, []);
copy.reasons[0].label = "gewijzigd";
t("questionFromBank: kopie, bron blijft gelijk", src.reasons[0].label, "l");
t("questionFromBank: eigen id-maker", L.questionFromBank({ text: "a", taskText: "b" }, [], () => "vast").id, "vast");
t("questionFromBank: ongeldig = null", L.questionFromBank({ text: "" }, []), null);
t("sameQuestionText: hoofdletters/spaties", L.sameQuestionText({ text: " Vloer Schoon? " }, { text: "vloer schoon?" }), true);
t("sortBank: op tekst (nl)", L.sortBank([{ text: "b" }, { text: "A" }, { text: "c" }]).map((x) => x.text), ["A", "b", "c"]);

for (const r of results) console.log(r.filter(Boolean).join(" | "));
const pass = results.filter((r) => r[0] === "PASS").length;
console.log(`${pass}/${results.length} PASS`);
process.exit(pass === results.length ? 0 : 1);
