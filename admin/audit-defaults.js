// Build v2 (ZLA): standaardwaarden voor de locatielijst en de audit-vragenlijst.
// Letterlijk volgens zeiklijst-build-brief-v2.md, "Definitieve antwoorden" (19-11-2026 11:28).
// Wordt alleen gebruikt om settings/locations en auditConfig/current te vullen als ze nog niet bestaan.

// Instelbare keuzes (open vragen aan de eigenaar; standaard = voorstel ZLA).
export const AUDIT_SETTINGS = {
  // "Zijn er lege vakken?" ja + "Is er voorraad?" nee: telt als GOED in de score (geen taak).
  emptyWithoutStockCountsAsGood: true,
  // Bij "Waarom?" (massaplein) mogen meerdere redenen tegelijk (elke reden een eigen taak).
  multipleReasons: true,
  // Max. aantal writes per batch bij het aanmaken van taken (Firestore-limiet is 500).
  batchSize: 450,
  // Aantal audits in de geschiedenis/trend.
  historyLimit: 60,
  // Max. lengte notitie per vraag.
  noteMax: 500
};

// Placeholder in taakteksten; wordt bij het aanmaken vervangen door het label van het onderdeel.
export const LOCATION_PLACEHOLDER = "{locatie}";

const PADEN = [14, 15, 16, 17, 18, 19, 20, 21];

export const DEFAULT_LOCATIONS = [
  { id: "bkc", label: "BKC" },
  { id: "achterwand", label: "Achterwand" },
  { id: "kort-pad-13", label: "Kort pad 13" },
  { id: "kort-pad-14", label: "Kort pad 14" },
  ...PADEN.map((n) => ({ id: `pad-${n}`, label: `Pad ${n}` })),
  { id: "balie-sanitair", label: "Balie sanitair" },
  { id: "balie-tegels", label: "Balie tegels" },
  { id: "z-karren", label: "Z-karren" },
  // Eigenaar 12:46: "Overig" alleen voor admin/audit; medewerkers kunnen het niet kiezen.
  { id: "overig", label: "Overig", staffSelectable: false }
].map((loc, i) => ({ staffSelectable: true, ...loc, order: i + 1, active: true }));

const L = LOCATION_PLACEHOLDER;

const STANDARD = () => [
  { id: "obstakels", text: "Is het pad vrij van obstakels?", trigger: "nee", taskText: `${L} - Opruimen` },
  {
    id: "lege-vakken",
    text: "Zijn er lege vakken?",
    trigger: "ja",
    followUp: { text: "Is er voorraad?", trigger: "ja", taskText: `${L} - Vakken navullen` }
  },
  { id: "netjes", text: "Zijn de vakken netjes?", trigger: "nee", taskText: `${L} - Vakken netjes maken` }
];

const SHOWREGALEN = () => ({ id: "showregalen", text: "Zijn de showregalen op orde?", trigger: "nee", taskText: `${L} - Showregalen opruimen` });
const MASSAPLEIN = () => ({
  id: "massaplein",
  text: "Is het massaplein commercieel?",
  trigger: "nee",
  reasons: [
    { id: "niet-gevuld", label: "Niet gevuld", taskText: `${L} - Massaplein vullen` },
    { id: "rommelig", label: "Rommelig", taskText: `${L} - Massaplein opruimen` },
    { id: "missende-prijs", label: "Missende prijs", taskText: `${L} - Massaplein prijzen` }
  ]
});
const BALIE = () => [
  { id: "balie-leeg", text: "Is de balie leeg?", trigger: "nee", taskText: `${L} - Balie opruimen` },
  { id: "retouren", text: "Zijn de retouren opgeruimd?", trigger: "nee", taskText: `${L} - Retouren opruimen` },
  { id: "reclamaties", text: "Zijn de reclamaties verwerkt?", trigger: "nee", taskText: `${L} - Reclamaties verwerken` }
];

function padQuestions(n) {
  const q = STANDARD();
  if (n === 15) {
    q.push({ id: "deponeerbuizen", text: "Zijn de deponeerbuizen geleegd?", trigger: "nee", taskText: "Pad 15 - Buizen legen en verwerken" });
    q.push({ id: "uitverkoophoek", text: "Is de uitverkoophoek commercieel?", trigger: "nee", taskText: "Pad 15 - Uitverkoophoek opruimen" });
  }
  if (n === 16) q.push(MASSAPLEIN());
  if (n === 19 || n === 20) {
    q.push(SHOWREGALEN());
    q.push(MASSAPLEIN());
  }
  if (n === 21) q.push({ id: "aanrijborden", text: "Zijn de aanrijborden aanwezig en in orde?", trigger: "nee", taskText: "Pad 21 - Aanrijborden herstellen" });
  return q;
}

export function defaultAuditSections() {
  const sections = [
    {
      locationId: "bkc",
      questions: [
        { id: "tv", text: "Staat de TV aan?", trigger: "nee", taskText: "BKC - TV aanzetten" },
        { id: "obstakels", text: "Is de BKC vrij van obstakels?", trigger: "nee", taskText: "BKC - Opruimen" },
        { id: "show-commercieel", text: "Is de show commercieel?", trigger: "nee", taskText: "BKC - Show commercieel maken" },
        { id: "show-obstakels", text: "Is de show vrij van obstakels?", trigger: "nee", taskText: "BKC - Show opruimen" }
      ]
    },
    { locationId: "achterwand", questions: STANDARD() },
    { locationId: "kort-pad-13", questions: STANDARD() },
    { locationId: "kort-pad-14", questions: STANDARD() },
    ...PADEN.map((n) => ({ locationId: `pad-${n}`, questions: padQuestions(n) })),
    { locationId: "balie-sanitair", questions: BALIE() },
    { locationId: "balie-tegels", questions: BALIE() },
    {
      locationId: "z-karren",
      questions: [
        { id: "prijzen", text: "Zijn de prijzen duidelijk zichtbaar?", trigger: "nee", taskText: "Z-karren - Prijzen aanbrengen" },
        { id: "artikelen", text: "Zijn de artikelen netjes en commercieel gepresenteerd?", trigger: "nee", taskText: "Z-karren - Opruimen" }
      ]
    },
    {
      // Eigenaar 12:46: laatste onderdeel, zonder standaardvragen.
      locationId: "overig",
      questions: [
        { id: "kopstellingen", text: "Zijn de kopstellingen commercieel?", trigger: "nee", taskText: "Overig - Kopstellingen commercieel maken" },
        { id: "gaatjesborden", text: "Zijn de gaatjesborden commercieel?", trigger: "nee", taskText: "Overig - Gaatjesborden commercieel maken" }
      ]
    }
  ];
  return sections.map((s, i) => ({ ...s, order: i + 1, active: true }));
}
