// node zl-tests/task-order.test.mjs  (geen emulator nodig)
import assert from "node:assert/strict";
import { sortTasks, isVisibleForDepartment, locationDepartment } from "../task-order.js";

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log("ok -", name); };

const settings = {
  items: [
    { id: "p19", label: "Pad 19", order: 3, department: "tegels" },
    { id: "p14", label: "Pad 14", order: 1, department: "sanitair" },
    { id: "bkc", label: "BKC", order: 2, department: "beide" },
    { id: "p15", label: "Pad 15", order: 4 }
  ],
  departments: { p15: "sanitair" }
};

t("padvolgorde, dan spoed, dan aanmaakdatum; streefdatum telt niet; zonder locatie achteraan", () => {
  const list = [
    { id: "a", locationId: "p19", createdAt: "1" },
    { id: "b", locationId: "p14", createdAt: "3" },
    { id: "c", locationId: "p14", createdAt: "2", dueDate: "2026-11-24" },
    { id: "d", locationId: "p14", urgent: true, createdAt: "9" },
    { id: "e", locationId: "", createdAt: "0" },
    { id: "f", locationId: "bkc", createdAt: "5" },
    { id: "g", locationId: "p14", createdAt: "1", dueDate: "2026-12-31" }
  ];
  assert.deepEqual(sortTasks(list, settings, (x) => x.createdAt).map((x) => x.id), ["d", "g", "c", "b", "f", "a", "e"]);
});

t("afdeling uit map gaat voor items[].department", () => {
  assert.equal(locationDepartment("p15", settings), "sanitair");
  assert.equal(locationDepartment("p19", settings), "tegels");
  assert.equal(locationDepartment("onbekend", settings), "");
});

t("zichtbaarheid volgens punt 3", () => {
  const me = "emp1";
  const tegelTaak = { locationId: "p19", assigneeId: "ALLEN" };
  assert.equal(isVisibleForDepartment(tegelTaak, "sanitair", me, settings), false);
  assert.equal(isVisibleForDepartment(tegelTaak, "tegels", me, settings), true);
  assert.equal(isVisibleForDepartment(tegelTaak, "", me, settings), true, "zonder afdeling ziet alles");
  assert.equal(isVisibleForDepartment(tegelTaak, "beide", me, settings), true);
  assert.equal(isVisibleForDepartment({ locationId: "p19", assigneeId: me }, "sanitair", me, settings), true, "persoonlijk toegewezen");
  assert.equal(isVisibleForDepartment({ locationId: "", assigneeId: "ALLEN" }, "sanitair", me, settings), true, "zonder locatie");
  assert.equal(isVisibleForDepartment({ locationId: "bkc" }, "tegels", me, settings), true, "pad beide");
});

t("v3b: extra afdelingsgevallen", () => {
  const me = "emp1";
  const sanTaak = { locationId: "p14", assigneeId: "ALLEN" };
  assert.equal(isVisibleForDepartment(sanTaak, "tegels", me, settings), false, "tegels ziet geen sanitair-taak voor Allen");
  assert.equal(isVisibleForDepartment({ locationId: "p14", assigneeId: "ander" }, "tegels", me, settings), false, "ook niet persoonlijk van een ander");
  assert.equal(isVisibleForDepartment({ locationId: "p14", assigneeId: me }, "tegels", me, settings), true, "eigen taak andere afdeling");
  assert.equal(isVisibleForDepartment(sanTaak, "Sanitair", me, settings), true, "hoofdletters");
  assert.equal(isVisibleForDepartment(sanTaak, "onzin", me, settings), true, "ongeldige waarde = geen afdeling");
  assert.equal(isVisibleForDepartment({ locationId: "p15" }, "tegels", me, settings), false, "afdeling via departments-map");
  assert.equal(isVisibleForDepartment({ locationId: "nieuw" }, "tegels", me, settings), true, "pad zonder afdeling");
  assert.equal(isVisibleForDepartment({ locationId: "p19" }, "tegels", me, null), true, "geen locatielijst");
});

console.log(`${passed} geslaagd, 0 gefaald`);
