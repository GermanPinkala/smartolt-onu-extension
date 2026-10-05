"use strict";

// Compatibilidad ONU ↔ OLT (Fase 2): matriz oficial de NOC por ID de OLT,
// ONU de tipo desconocido y que los tres consumidores (informe del cliente,
// ficha /onu/view y /onu/unconfigured) usen la misma fuente.
// Correr con: cd tests && npm test

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const { HEALTHY, fichaHtml, openPopup } = require("./popup-harness");

const ROOT = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const ctx = vm.createContext({ self: {}, console });
vm.runInContext(read("shared.js"), ctx, { filename: "shared.js" });
const S = ctx.self.SmartOLTShared;
const ST = S.ONU_COMPATIBILITY_STATUS;

const HWTC = "HWTCD4EC0FD2";
const ZTEG = "ZTEGC8A1B2C3";
const FHTT = "FHTT11AB0F70";
const ALL_OLTS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "15", "16"];
const ZTEG_OLTS = ["9", "12", "13", "15", "16"];
const ZTEG_INCOMPATIBLE_OLTS = ["2", "3", "4", "5", "6", "7", "8", "10", "11"];
const UNKNOWN_WARNING = "⚠️ ONU de tipo desconocido: no se dispone de información de compatibilidad para este serial.";
const INCOMPATIBLE_WARNING = "⚠️ ONU con serial no compatible con la OLT";

const evaluate = (oltId, serial) => JSON.parse(JSON.stringify(S.evaluateOnuOltCompatibility(oltId, serial)));

// ---------- Matriz oficial ----------

test("matriz oficial de NOC: exactamente estos 14 OLT y prefijos", () => {
  const expected = {};
  ALL_OLTS.forEach((id) => {
    expected[id] = ZTEG_OLTS.includes(id) ? ["HWTC", "ZTEG"] : ["HWTC"];
  });
  assert.deepEqual(JSON.parse(JSON.stringify(S.OLT_COMPATIBLE_ONU_PREFIXES)), expected);
  assert.equal(S.ONU_UNKNOWN_TYPE_WARNING, UNKNOWN_WARNING);
  assert.equal(S.ONU_OLT_COMPATIBILITY_WARNING, INCOMPATIBLE_WARNING);
});

test("A) HWTC es compatible en todos los OLT contemplados", () => {
  ALL_OLTS.forEach((id) => {
    assert.deepEqual(evaluate(id, HWTC), { status: ST.COMPATIBLE, warning: null }, `OLT ${id}`);
    assert.equal(S.getOnuOltCompatibilityWarning(id, HWTC), null, `OLT ${id}`);
  });
});

test("B) ZTEG es compatible en OLT 9, 12, 13, 15 y 16", () => {
  ZTEG_OLTS.forEach((id) => {
    assert.deepEqual(evaluate(id, ZTEG), { status: ST.COMPATIBLE, warning: null }, `OLT ${id}`);
  });
});

test("C) ZTEG es incompatible en OLT 2, 3, 4, 5, 6, 7, 8, 10 y 11", () => {
  ZTEG_INCOMPATIBLE_OLTS.forEach((id) => {
    assert.deepEqual(evaluate(id, ZTEG), { status: ST.INCOMPATIBLE, warning: INCOMPATIBLE_WARNING }, `OLT ${id}`);
  });
});

test("D) prefijo desconocido (FHTT...): unknown_onu en cualquier OLT, nunca incompatible", () => {
  ALL_OLTS.forEach((id) => {
    const r = evaluate(id, FHTT);
    assert.deepEqual(r, { status: ST.UNKNOWN_ONU, warning: UNKNOWN_WARNING }, `OLT ${id}`);
    assert.ok(!/no compatible/i.test(r.warning), `OLT ${id}`);
  });
});

test("E) serial vacío: no_serial, sin aviso", () => {
  ["", "   ", null, undefined].forEach((serial) => {
    assert.deepEqual(evaluate("4", serial), { status: ST.NO_SERIAL, warning: null }, String(serial));
  });
});

test("F) OLT no identificado o no contemplado: no se afirma compatibilidad ni incompatibilidad", () => {
  [null, undefined, "", "1", "14", "17", "99", "abc", "OBE-OLT-A"].forEach((oltId) => {
    [HWTC, ZTEG].forEach((serial) => {
      assert.deepEqual(evaluate(oltId, serial), { status: ST.UNKNOWN_OLT, warning: null }, `${oltId} / ${serial}`);
    });
  });
});

test("G) ONU desconocida + OLT desconocido: se mantiene el aviso de ONU desconocida", () => {
  [null, "", "14", "99"].forEach((oltId) => {
    assert.deepEqual(evaluate(oltId, FHTT), { status: ST.UNKNOWN_ONU, warning: UNKNOWN_WARNING }, String(oltId));
  });
});

test("el serial se normaliza (mayúsculas/espacios) y el ID de OLT puede venir como número", () => {
  assert.equal(evaluate(4, " zteg12345678 ").status, ST.INCOMPATIBLE);
  assert.equal(evaluate(" 15 ", "hwtc12345678").status, ST.COMPATIBLE);
});

// ---------- H) Fuente única, sin tablas viejas en paralelo ----------

test("H) no quedan tablas de compatibilidad viejas ni prefijos HWTC/ZTEG fuera de shared.js", () => {
  const files = ["shared.js", "popup.js", "dashboard.js", "onu-view.js", "unconfigured.js", "background.js"];
  const OLD = /OLT_COMPATIBILITY_GROUPS|UNCONFIGURED_OLT_COMPATIBILITY|SMARTOLT_OLT_ID_MAP|SMARTOLT_OLT_DISPLAY_NAME_MAP|resolveSmartoltOltIdentifier|hasKnownSerialPrefix|HUAWEI_ONU_PREFIX|ZTE_ONU_PREFIX/;
  files.forEach((file) => {
    const source = read(file);
    assert.ok(!OLD.test(source), `${file} conserva una tabla/función vieja`);
    if (file !== "shared.js") assert.ok(!/HWTC|ZTEG/.test(source), `${file} define prefijos propios`);
  });
  assert.equal((read("shared.js").match(/const OLT_COMPATIBLE_ONU_PREFIXES\b/g) || []).length, 1);
  assert.match(read("onu-view.js"), /SmartOLTShared\.evaluateOnuOltCompatibility\(/);
  assert.match(read("unconfigured.js"), /SmartOLTShared\.evaluateOnuOltCompatibility\(/);
});

// ---------- Informe del cliente (texto copiado) ----------

function report(serial, oltId) {
  return S.buildClientReport({ name: "Cliente Demo", caja: "A6DB4", puerto: "5", serial, oltId, oltName: "OBE-OLT-A", sig1490: -20.1, sig1310: -23.1 }, [], () => 0);
}

test("informe: ONU desconocida -> aviso de ONU desconocida al final del texto copiado", () => {
  const r = report(FHTT, "4");
  assert.equal(r.compatibilityWarning, UNKNOWN_WARNING);
  assert.ok(r.text.endsWith(`\n\n${UNKNOWN_WARNING}`), r.text);
  assert.ok(!r.text.includes(INCOMPATIBLE_WARNING));
});

test("informe: ZTEG en OLT 4 -> aviso de no compatible; en OLT 15 o con HWTC, sin aviso", () => {
  const bad = report(ZTEG, "4");
  assert.equal(bad.compatibilityWarning, INCOMPATIBLE_WARNING);
  assert.ok(bad.text.endsWith(`\n\n${INCOMPATIBLE_WARNING}`));
  [report(ZTEG, "15"), report(HWTC, "4"), report(ZTEG, null), report(null, "4")].forEach((r) => {
    assert.equal(r.compatibilityWarning, null);
    assert.ok(!/⚠️ ONU (con serial|de tipo)/.test(r.text), r.text);
  });
});

test("informe: la OLT se identifica por ID, no por la Zona", () => {
  // Zona de una OLT Huawei con ZTEG pero sin ID: no se afirma nada.
  assert.equal(report(ZTEG, null).compatibilityWarning, null);
});

// ---------- Ficha /onu/view (onu-view.js) ----------

function onuViewPage({ serial, oltId }) {
  const olt = oltId === null ? "" : `<dt>OLT</dt><dd><a class="move-onu" data-olt-id="${oltId}" data-show-olt="1">${oltId} - OLT</a></dd>`;
  return `<!doctype html><html><body><dl>${olt}<dt>SN</dt><dd>${serial}</dd><dt>Zona</dt><dd>OBE-OLT-A</dd></dl></body></html>`;
}

async function runContentScript(html, url, script) {
  const dom = new JSDOM(html, { runScripts: "outside-only", url });
  dom.window.eval(read("shared.js"));
  dom.window.eval(read(script));
  await new Promise((r) => setTimeout(r, 350));
  return dom;
}

function onuViewMarks(dom) {
  return Array.from(dom.window.document.querySelectorAll("[data-smartolt-onu-view-compatibility-warning]"), (el) => ({
    text: el.textContent,
    title: el.getAttribute("title"),
  }));
}

test("onu-view: cada caso con su marca (ID de OLT desde data-olt-id)", async () => {
  const cases = [
    { serial: FHTT, oltId: "4", marks: [{ text: "⚠️ ONU desconocida", title: UNKNOWN_WARNING.replace("⚠️ ", "") }] },
    { serial: FHTT, oltId: null, marks: [{ text: "⚠️ ONU desconocida", title: UNKNOWN_WARNING.replace("⚠️ ", "") }] },
    { serial: ZTEG, oltId: "4", marks: [{ text: "⚠️ No compatible", title: INCOMPATIBLE_WARNING.replace("⚠️ ", "") }] },
    { serial: ZTEG, oltId: "12", marks: [] },
    { serial: HWTC, oltId: "16", marks: [] },
    { serial: ZTEG, oltId: null, marks: [] },
  ];
  for (const c of cases) {
    const dom = await runContentScript(onuViewPage(c), "https://demo.smartolt.com/onu/view/1", "onu-view.js");
    assert.deepEqual(onuViewMarks(dom), c.marks, `${c.serial} / OLT ${c.oltId}`);
    dom.window.close();
  }
});

test("onu-view: la marca no se duplica al volver a escanear y cambia si cambia el caso", async () => {
  const dom = await runContentScript(onuViewPage({ serial: FHTT, oltId: "4" }), "https://demo.smartolt.com/onu/view/1", "onu-view.js");
  const doc = dom.window.document;
  doc.body.appendChild(doc.createElement("div")); // SmartOLT actualiza la ficha
  await new Promise((r) => setTimeout(r, 350));
  assert.deepEqual(onuViewMarks(dom).map((m) => m.text), ["⚠️ ONU desconocida"]);

  // Mismo DD con otro serial (ZTEG en OLT 4): la marca pasa a "No compatible".
  const dd = Array.from(doc.querySelectorAll("dd")).find((el) => el.textContent.includes(FHTT));
  dd.firstChild.textContent = ZTEG;
  doc.body.appendChild(doc.createElement("div"));
  await new Promise((r) => setTimeout(r, 350));
  assert.deepEqual(onuViewMarks(dom).map((m) => m.text), ["⚠️ No compatible"]);
  dom.window.close();
});

// ---------- /onu/unconfigured (unconfigured.js) ----------

function unconfiguredPage(rows) {
  const trs = rows
    .map(
      ({ olt, sn }) =>
        `<tr class="valign-center"><td>${sn}</td><td><a class="activateButton" href="/onu/authorize?olt=${olt}&amp;sn=${sn}">Autorizar</a></td></tr>`
    )
    .join("");
  return `<!doctype html><html><body><div id="existingUnconfiguredOnus"><table>${trs}</table></div></body></html>`;
}

// Marcas por fila: texto corto visible + texto completo en el tooltip (title).
function unconfiguredMarks(dom) {
  return Array.from(dom.window.document.querySelectorAll("tr"), (tr) =>
    Array.from(tr.querySelectorAll("[data-smartolt-onu-compatibility-warning]"), (el) => ({
      text: el.textContent,
      title: el.getAttribute("title"),
    }))
  );
}

test("unconfigured: misma matriz oficial; marcas cortas con el detalle en el tooltip", async () => {
  const rows = [
    { olt: "4", sn: HWTC },
    { olt: "4", sn: ZTEG },
    { olt: "9", sn: ZTEG },
    { olt: "12", sn: ZTEG },
    { olt: "13", sn: ZTEG },
    { olt: "15", sn: HWTC },
    { olt: "10", sn: ZTEG },
    { olt: "4", sn: FHTT },
    { olt: "99", sn: FHTT },
    { olt: "99", sn: ZTEG },
  ];
  const dom = await runContentScript(unconfiguredPage(rows), "https://demo.smartolt.com/onu/unconfigured", "unconfigured.js");
  const NOT_COMPATIBLE = { text: "⚠️ No compatible", title: INCOMPATIBLE_WARNING.replace("⚠️ ", "") };
  const UNKNOWN = { text: "⚠️ ONU desconocida", title: UNKNOWN_WARNING.replace("⚠️ ", "") };
  assert.deepEqual(unconfiguredMarks(dom), [
    [],
    [NOT_COMPATIBLE],
    [],
    [],
    [],
    [],
    [NOT_COMPATIBLE],
    [UNKNOWN],
    [UNKNOWN],
    [],
  ]);
  // Sin window.close(): vaciar el documento dispararía el MutationObserver de
  // unconfigured.js sobre una ventana ya destruida (artefacto de jsdom).
});

test("unconfigured: el aviso no se duplica al volver a escanear (SmartOLT actualiza la lista)", async () => {
  const rows = [
    { olt: "4", sn: ZTEG },
    { olt: "4", sn: FHTT },
    { olt: "4", sn: HWTC },
  ];
  const dom = await runContentScript(unconfiguredPage(rows), "https://demo.smartolt.com/onu/unconfigured", "unconfigured.js");
  const doc = dom.window.document;
  for (let i = 0; i < 3; i++) {
    doc.querySelector("#existingUnconfiguredOnus table").appendChild(doc.createElement("tbody"));
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.deepEqual(
    unconfiguredMarks(dom).map((marks) => marks.map((m) => m.text)),
    [["⚠️ No compatible"], ["⚠️ ONU desconocida"], []]
  );
});

// ---------- Popup: GENERAR INFORME con una ONU desconocida ----------

test("popup: GENERAR INFORME muestra y copia el aviso de ONU desconocida", async () => {
  const p = await openPopup({ tabUrl: "https://demo.smartolt.com/onu/view/555", pageHtml: fichaHtml({ serial: FHTT }), csvRows: HEALTHY });
  p.$("obtenerClienteBtn").click();
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal(p.$("compatibilityWarning").hidden, false);
  assert.equal(p.$("compatibilityWarning").textContent, UNKNOWN_WARNING);
  assert.ok(p.calls.clipboard && p.calls.clipboard.endsWith(UNKNOWN_WARNING), p.calls.clipboard);
  p.close();
});

test("popup: GENERAR INFORME con HWTC en OLT 4 (data-olt-id de la ficha) no muestra aviso", async () => {
  const p = await openPopup({ tabUrl: "https://demo.smartolt.com/onu/view/555", pageHtml: fichaHtml({ serial: HWTC }), csvRows: HEALTHY });
  p.$("obtenerClienteBtn").click();
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal(p.$("compatibilityWarning").hidden, true);
  assert.ok(p.calls.clipboard && !/⚠️ ONU (con serial|de tipo)/.test(p.calls.clipboard), p.calls.clipboard);
  p.close();
});
