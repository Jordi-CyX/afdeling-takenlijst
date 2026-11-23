// Excel-export (alleen-lezen overzicht, eigenaar 13:16). De JSON-back-up blijft de bron voor herstel.
// Eigen minimale .xlsx-schrijver (zip zonder compressie + SpreadsheetML), geen bibliotheek of CDN,
// zodat de CSP ongewijzigd blijft. Puur JavaScript zonder DOM/Firebase: ook in Node te testen.
//
// Veiligheid:
// - Per tabblad een vaste kolomlijst (whitelist). Pincodes, hashes, startcodes, loginKeys,
//   pinVersion, e-mail/wachtwoord-afleidingen, medewerker-id's en foto's komen er nooit in.
// - Formule-injectie: tekst die begint met = + - @ tab of CR krijgt een apostrof ervoor; alle
//   cellen zijn inline-tekst (geen formules). XML wordt ge-escaped en ongeldige tekens verwijderd.

const TZ = "Europe/Amsterdam";

// ---------- Celwaarden ----------
const INJECTION_START = /^[=+\-@\t\r]/;
export function safeCellText(value) {
  if (value == null) return "";
  let s = String(value);
  // Ongeldige XML 1.0-tekens en losse surrogaten weg (tab, LF en CR blijven).
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "");
  s = s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
  if (INJECTION_START.test(s)) s = `'${s}`;
  if (s.length > 32000) s = `${s.slice(0, 32000)}…`;
  return s;
}

export function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function toDate(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "object" && typeof value.toDate === "function") return value.toDate();
  if (typeof value === "object" && typeof value.seconds === "number") return new Date(value.seconds * 1000);
  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// dd-mm-jjjj in Europe/Amsterdam. Een kale datumsleutel (JJJJ-MM-DD) wordt niet verschoven.
export function nlDate(value) {
  if (typeof value === "string") {
    const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  }
  const d = toDate(value);
  if (!d) return "";
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric" }).formatToParts(d);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return `${get("day")}-${get("month")}-${get("year")}`;
}

const yesNo = (b) => (b ? "Ja" : "Nee");
const STATUS = { open: "Open", pending: "Pending (wacht op controle)", afgerond: "Afgerond" };
const WEEKDAYS = ["zondag", "maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag"];

function assignee(item) {
  const name = String(item.assigneeName || "").trim();
  if (item.assigneeId === "ALLEN" || name.toLowerCase() === "allen") return "Allen";
  if (name) return name;
  if (item.assignee) return String(item.assignee);
  return "Allen";
}

export function recurrenceText(rec) {
  const r = rec || {};
  if (r.type === "daily") return "Elke dag";
  if (r.type === "every_other_day") return "Om de dag";
  if (r.type === "weekdays") {
    const names = (Array.isArray(r.weekdays) ? r.weekdays : []).map((d) => WEEKDAYS[Number(d)]).filter(Boolean);
    return names.length ? `Elke ${names.join(", ")}` : "Op gekozen weekdagen";
  }
  if (r.type === "date") {
    if (r.monthly && r.date) return `Maandelijks op de ${Number(String(r.date).split("-")[2])}e`;
    return r.date ? `Op ${nlDate(r.date)}` : "Op een datum";
  }
  return r.type ? `Herhalend (${r.type})` : "Herhalend";
}

// ---------- Tabbladen (vaste kolommen) ----------
// data: { tasks, taskMeta, taskCompletions, recurring, employees, employeeDetails, reports, audits }
// Elke collectie is een lijst { id, data }. opts.locationLabel(id) en opts.auditTotal(audit) optioneel.
export function buildExportSheets(data, opts = {}) {
  const list = (name) => (Array.isArray(data[name]) ? data[name] : []);
  const byId = (name) => new Map(list(name).map((x) => [x.id, x.data || {}]));
  const meta = byId("taskMeta");
  const done = byId("taskCompletions");
  const details = byId("employeeDetails");
  const loc = (item) => (item.locationId && opts.locationLabel ? opts.locationLabel(item.locationId) : "") || item.location || "";

  const taken = {
    name: "Taken",
    columns: ["Titel", "Omschrijving", "Locatie", "Status", "Spoed", "Toegewezen aan", "Streefdatum", "Aangemaakt op", "Afgevinkt door", "Afgevinkt op", "Afgerond op", "Herkomst", "Auditdatum"],
    rows: list("tasks").map(({ id, data: t }) => {
      const c = done.get(id);
      const m = meta.get(id) || {};
      const by = c ? (c.name || "") : (t.pendingBy || "");
      const at = c ? c.at : t.pendingAt;
      const audit = t.source && t.source.type === "audit";
      return [
        t.title || "", t.description || "", loc(t), STATUS[t.status] || t.status || "", yesNo(t.urgent === true), assignee(t),
        nlDate(m.dueDate || t.dueDate || ""), nlDate(t.createdAt), by, nlDate(at), nlDate(t.completedAt),
        audit ? "Audit" : (t.recurringId ? "Herhaling" : "Los"), audit ? nlDate(t.source.auditDate) : ""
      ];
    })
  };

  const audits = {
    name: "Audits",
    columns: ["Datum", "Status", "Score (goed)", "Score (totaal)", "Score (%)", "Aantal taken", "Aantal notities", "Notities", "Afgerond op", "Variant", "Gelopen door"],
    rows: list("audits").map(({ data: a }) => {
      let good = 0;
      let total = 0;
      if (opts.auditTotal) ({ good, total } = opts.auditTotal(a));
      else for (const s of a.sections || []) { good += (s.score && s.score.good) || 0; total += (s.score && s.score.total) || 0; }
      const notes = [];
      for (const s of a.sections || []) {
        for (const q of s.questions || []) {
          if (String(q.note || "").trim()) notes.push(`${s.label || (opts.locationLabel && opts.locationLabel(s.locationId)) || s.locationId || ""}: ${q.text || ""} — ${q.note}`);
        }
      }
      return [
        nlDate(a.auditDate), a.status === "afgerond" ? "Afgerond" : (a.status === "bezig" ? "Bezig" : a.status || ""),
        good, total, total ? Math.round((good / total) * 100) : "", Number(a.taskCount) || 0, notes.length, notes.join("\n"), nlDate(a.completedAt),
        // V3A punt 7: oude audits zonder variant horen bij "Standaard".
        String(a.variantName || (a.variantId ? a.variantId : "Standaard")), String(a.ranBy || "")
      ];
    })
  };

  const medewerkers = {
    name: "Medewerkers",
    columns: ["Naam", "Actief", "Functie", "Afdeling", "Werkdagen", "Notitie", "Aangemaakt op"],
    rows: list("employees").map(({ id, data: e }) => {
      const d = details.get(id) || {};
      const days = (Array.isArray(d.workdays) ? d.workdays : []).map((x) => WEEKDAYS[Number(x)]).filter(Boolean).join(", ");
      return [e.name || "", yesNo(e.active !== false), d.role || "", d.department || "", days, d.note || "", nlDate(e.createdAt)];
    })
  };

  const meldingen = {
    name: "Meldingen",
    columns: ["Melding", "Status", "Gemeld door", "Gemeld op", "Toestel", "Appversie"],
    rows: list("reports").map(({ data: r }) => [
      r.description || r.text || "", r.status || "", r.employeeName || r.reporterName || "", nlDate(r.createdAt), r.device || "", r.appVersion || ""
    ])
  };

  const terugkerend = {
    name: "Terugkerende taken",
    columns: ["Titel", "Omschrijving", "Locatie", "Spoed", "Toegewezen aan", "Herhaling", "Startdatum", "Gepauzeerd", "Aangemaakt op"],
    rows: list("recurring").map(({ data: t }) => [
      t.title || "", t.description || "", loc(t), yesNo(t.urgent === true), assignee(t), recurrenceText(t.recurrence),
      nlDate((t.recurrence && t.recurrence.startDate) || ""), yesNo(t.paused === true), nlDate(t.createdAt)
    ])
  };

  return [taken, audits, medewerkers, meldingen, terugkerend];
}

// ---------- SpreadsheetML ----------
function colName(i) {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function cellXml(ref, value, style) {
  const s = style ? ` s="${style}"` : "";
  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"${s}><v>${value}</v></c>`;
  const text = safeCellText(value);
  if (!text) return "";
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
}

function sheetXml(sheet) {
  const widths = sheet.columns.map((c, i) => {
    let w = c.length;
    for (const row of sheet.rows.slice(0, 200)) w = Math.max(w, Math.min(60, String(row[i] ?? "").split("\n")[0].length));
    return Math.max(10, Math.min(60, w + 2));
  });
  const cols = `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`;
  const rows = [sheet.columns, ...sheet.rows].map((row, r) => {
    const cells = row.map((v, c) => cellXml(`${colName(c)}${r + 1}`, v, r === 0 ? 1 : 2)).join("");
    return `<row r="${r + 1}">${cells}</row>`;
  }).join("");
  const last = `${colName(sheet.columns.length - 1)}${sheet.rows.length + 1}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols}<sheetData>${rows}</sheetData><autoFilter ref="A1:${last}"/></worksheet>`;
}

function sheetTitle(name) {
  return String(name).replace(/[\\/?*[\]:]/g, " ").slice(0, 31);
}

export function workbookFiles(sheets) {
  const files = [];
  files.push(["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`]);
  files.push(["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`]);
  files.push(["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xmlEscape(sheetTitle(s.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets><definedNames>${sheets.map((s, i) => `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xmlEscape(sheetTitle(s.name).replace(/'/g, "''"))}'!$A$1:$${colName(s.columns.length - 1)}$${s.rows.length + 1}</definedName>`).join("")}</definedNames></workbook>`]);
  files.push(["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`]);
  files.push(["xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEDEBE8"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`]);
  sheets.forEach((s, i) => files.push([`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]));
  return files;
}

// ---------- Zip (methode 0, geen compressie) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export function zipStore(files, now = new Date()) {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(now);
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBytes = enc.encode(name);
    const data = typeof content === "string" ? enc.encode(content) : content;
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 namen
    local.setUint16(8, 0, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let p = 0;
  for (const c of all) { out.set(c, p); p += c.length; }
  return out;
}

export function buildXlsx(sheets, now = new Date()) {
  return zipStore(workbookFiles(sheets), now);
}

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
