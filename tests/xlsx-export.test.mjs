// Unit-tests Excel-export: formule-injectie, geheimen niet in het bestand, geldige zip/xlsx.
// Draai: node tests/xlsx-export.test.mjs (of npm run test:export in tests/).
import { safeCellText, xmlEscape, nlDate, buildExportSheets, buildXlsx, crc32 } from "../admin/xlsx-export.js";
import { writeFileSync } from "node:fs";

const results = [];
const t = (name, fn) => { try { fn(); results.push(["PASS", name]); } catch (e) { results.push(["FAIL", name, e.message]); } };
const eq = (a, b) => { if (a !== b) throw new Error(`${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
const ok = (c, m = "verwacht waar") => { if (!c) throw new Error(m); };

// Formule-injectie
for (const bad of ["=HYPERLINK(\"http://x\",\"klik\")", "+1+1", "-2+3", "@SUM(A1)", "\t=1", "\r=1", "=cmd|' /C calc'!A0"]) {
  t(`injectie: ${JSON.stringify(bad)} krijgt apostrof`, () => eq(safeCellText(bad), `'${bad}`));
}
t("injectie: gewone tekst ongewijzigd", () => eq(safeCellText("Pad 16 = rommelig"), "Pad 16 = rommelig"));
t("injectie: datum dd-mm-jjjj ongewijzigd", () => eq(safeCellText("19-11-2026"), "19-11-2026"));
t("ongeldige XML-tekens verwijderd", () => eq(safeCellText("a\u0000b\u0007c\u001Fd"), "abcd"));
t("XML-escape", () => eq(xmlEscape(`<a href="x">&'</a>`), "&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;"));
t("nlDate: datumsleutel", () => eq(nlDate("2026-11-19"), "19-11-2026"));
t("nlDate: ISO-tijd in Amsterdam (23:30 UTC = volgende dag)", () => eq(nlDate("2026-11-19T23:30:00.000Z"), "20-11-2026"));
t("nlDate: Firestore-achtige timestamp", () => eq(nlDate({ toDate: () => new Date("2026-06-30T22:30:00Z") }), "01-07-2026"));
t("crc32 bekende waarde", () => eq(crc32(new TextEncoder().encode("123456789")), 0xCBF43926));

// Testdata met geheimen
const SECRETS = ["PINHASH-GEHEIM-1", "STARTCODE9X", "LOGINKEY-GEHEIM", "PINSALT-GEHEIM", "WACHTWOORD-GEHEIM", "u-geheim-uid"];
const data = {
  tasks: [{ id: "t1", data: { title: "=1+1 kwaadaardig", description: "Pallets", location: "Pad 16", locationId: "pad-16", status: "pending", urgent: true, assigneeId: "jane", assigneeName: "Jane", createdAt: "2026-11-18T10:00:00Z", photos: ["data:image/jpeg;base64,AAAA"] } },
    { id: "t2", data: { title: "Oud", location: "Gang 12", status: "open", assignee: "", createdAt: "2026-11-01T10:00:00Z", pendingBy: "Piet" } }],
  taskMeta: [{ id: "t1", data: { dueDate: "2026-11-21" } }],
  taskCompletions: [{ id: "t1", data: { employeeId: "jane", name: "Jane", at: "2026-11-19T08:00:00Z" } }],
  recurring: [{ id: "r1", data: { title: "Massaplein", location: "Pad 19", locationId: "pad-19", urgent: true, assigneeId: "ALLEN", assigneeName: "Allen", recurrence: { type: "weekdays", weekdays: [1, 3, 5], startDate: "2026-11-19" }, paused: false, createdAt: "2026-11-19T09:00:00Z" } }],
  employees: [{ id: "jane", data: { name: "Jane", active: true, pinVersion: 7, pinHash: SECRETS[0], startCode: SECRETS[1], loginKey: SECRETS[2], pinSalt: SECRETS[3], password: SECRETS[4], uid: SECRETS[5], createdAt: "2026-10-01T10:00:00Z" } }],
  employeeDetails: [{ id: "jane", data: { role: "Verkoper", department: "Bouwstoffen", workdays: [1, 2, 4], note: "@sleutel", updatedAt: "2026-11-01T10:00:00Z" } }],
  reports: [{ id: "r0", data: { description: "+31 6 kapotte lamp", status: "open", employeeName: "Piet", employeeId: "piet", createdAt: "2026-11-18T10:00:00Z", device: "iPhone", appVersion: "v20", photo: "data:image/jpeg;base64,BBBB" } }],
  audits: [{ id: "a1", data: { auditDate: "2026-11-19", status: "afgerond", taskCount: 2, completedAt: "2026-11-19T11:00:00Z", sections: [{ locationId: "bkc", label: "BKC", score: { good: 3, total: 4 }, questions: [{ text: "Staat de TV aan?", note: "-afstandsbediening kwijt" }] }] } }],
  staffAccounts: [{ id: "u1", data: { startCode: SECRETS[1] } }],
  startCodes: [{ id: SECRETS[1], data: { employeeId: "jane" } }]
};
const sheets = buildExportSheets(data, { locationLabel: (id) => ({ "pad-16": "Pad 16", "pad-19": "Pad 19", bkc: "BKC" })[id] || "" });
const bytes = buildXlsx(sheets, new Date("2026-11-19T12:00:00Z"));
const text = Buffer.from(bytes).toString("utf8"); // zip zonder compressie: alle XML is leesbaar
t("vijf tabbladen in vaste volgorde", () => eq(sheets.map((s) => s.name).join("|"), "Taken|Audits|Medewerkers|Meldingen|Terugkerende taken"));
for (const sec of SECRETS) t(`geheim niet in bestand: ${sec.slice(0, 8)}…`, () => ok(!text.includes(sec)));
t("geen pinVersion-waarde/kolom", () => ok(!/pinVersion|Pinversie|>7</i.test(text)));
t("geen kolomnamen met pin/hash/code/wachtwoord", () => ok(sheets.every((s) => s.columns.every((c) => !/pin|hash|code|wachtwoord|login|key|uid/i.test(c))), sheets.flatMap((s) => s.columns).join(",")));
t("geen foto's (base64) in bestand", () => ok(!text.includes("base64")));
t("geen medewerker-id's in Meldingen", () => ok(!sheets[3].rows.some((r) => r.includes("piet"))));
t("injectie in titel ge-escaped in XML", () => ok(text.includes("&apos;=1+1 kwaadaardig") && !text.includes(">=1+1")));
t("injectie in melding (+31) en notitie (@, -) ge-escaped", () => ok(text.includes("&apos;+31 6 kapotte lamp") && text.includes("&apos;@sleutel") && text.includes("BKC: Staat de TV aan? — -afstandsbediening kwijt")));
t("geen formules in het bestand", () => ok(!/<f>|<f /.test(text)));
t("Taken: streefdatum + afvinker + Amsterdam-datum", () => { const r = sheets[0].rows[0]; eq(r[6], "21-11-2026"); eq(r[8], "Jane"); eq(r[9], "19-11-2026"); eq(r[5], "Jane"); eq(r[4], "Ja"); });
t("Taken: oude taak zonder persoon = Allen, legacy afvinker", () => { const r = sheets[0].rows[1]; eq(r[5], "Allen"); eq(r[8], "Piet"); });
t("Audits: score en notities", () => { const r = sheets[1].rows[0]; eq(r[0], "19-11-2026"); eq(r[2], 3); eq(r[3], 4); eq(r[4], 75); eq(r[6], 1); });
t("Medewerkers: extra gegevens", () => { const r = sheets[2].rows[0]; eq(r.slice(0, 5).join("|"), "Jane|Ja|Verkoper|Bouwstoffen|maandag, dinsdag, donderdag"); });
t("Terugkerend: herhaling leesbaar", () => eq(sheets[4].rows[0][5], "Elke maandag, woensdag, vrijdag"));
t("zip begint met PK en eindigt met EOCD", () => { eq(bytes[0], 0x50); eq(bytes[1], 0x4b); const e = bytes.length - 22; eq(new DataView(bytes.buffer).getUint32(e, true), 0x06054b50); });

if (process.argv[2]) writeFileSync(process.argv[2], bytes);
for (const r of results) console.log(r.join(" | "));
const pass = results.filter((r) => r[0] === "PASS").length;
console.log(`${pass}/${results.length} PASS`);
process.exit(pass === results.length ? 0 : 1);
