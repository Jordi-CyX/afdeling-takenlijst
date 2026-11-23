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

console.log(`${passed} geslaagd, 0 gefaald`);
