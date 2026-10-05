"use strict";

// Dashboard CCT (v4): validaciones PON/PPPoE, evaluación óptica compartida con
// el informe y lector de la ficha. Correr con: cd tests && npm test

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const ctx = vm.createContext({ self: {}, console });
vm.runInContext(fs.readFileSync(path.join(ROOT, "shared.js"), "utf8"), ctx, { filename: "shared.js" });
const S = ctx.self.SmartOLTShared;

const PON_WARN = "⚠️ No coincide el PON con la caja, se debe verificar.";
const PPPOE_WARN = "⚠️ No coincide el PPPoE con la caja y Puerto, se debe verificar.";
const OLT_A = { oltId: "4", oltName: "4 - OLT-A" };

// ---------- Nomenclatura ----------

test("nomenclatura: A6DB4 = OLT-A / Board 6 / PON 13; prefijo de localidad admitido", () => {
  assert.deepEqual({ ...S.parseCajaNomenclature("A6DB4") }, { oltLetter: "A", board: 6, pon: 13 });
  assert.deepEqual({ ...S.parseCajaNomenclature("ALV-D62B6") }, { oltLetter: "D", board: 6, pon: 2 });
  assert.deepEqual({ ...S.parseCajaNomenclature("c10a1") }, { oltLetter: "C", board: 1, pon: 0 });
  assert.equal(S.parseCajaNomenclature("None"), null);
  assert.equal(S.parseCajaNomenclature("ODB DEMO MARCOS"), null);
  // El patrón es genérico (WND-A08B1 "encaja"); lo que limita la validación a
  // OLT-A..D es resolveNomenclatureOltLetter (ver tests de PON/PPPoE).
});

test("OLT con nomenclatura: solo 4-A, 6-B, 3-C, 5-D con ID y nombre coherentes", () => {
  assert.equal(S.resolveNomenclatureOltLetter("4", "4 - OLT-A"), "A");
  assert.equal(S.resolveNomenclatureOltLetter("6", "6 - OLT-B"), "B");
  assert.equal(S.resolveNomenclatureOltLetter("3", "3 - OLT-C"), "C");
  assert.equal(S.resolveNomenclatureOltLetter("5", "5 - OLT-D"), "D");
  assert.equal(S.resolveNomenclatureOltLetter("8", "8 - OLT-A-WND"), null);
  assert.equal(S.resolveNomenclatureOltLetter("4", "4 - OLT-B"), null);
  assert.equal(S.resolveNomenclatureOltLetter("4", null), null);
});

// ---------- PON vs caja ----------

test("PON: coincide -> sin aviso; board, PON u OLT distintos -> aviso", () => {
  assert.equal(S.validatePonVsCaja({ ...OLT_A, board: "6", pon: "13", caja: "A6DB4" }), null);
  assert.equal(S.validatePonVsCaja({ ...OLT_A, board: "6", pon: "12", caja: "A6DB4" }), PON_WARN);
  assert.equal(S.validatePonVsCaja({ ...OLT_A, board: "5", pon: "13", caja: "A6DB4" }), PON_WARN);
  assert.equal(S.validatePonVsCaja({ ...OLT_A, board: "6", pon: "13", caja: "B6DB4" }), PON_WARN);
  assert.equal(S.validatePonVsCaja({ oltId: "5", oltName: "5 - OLT-D", board: "6", pon: "2", caja: "ALV-D62B6" }), null);
});

test("PON: otra OLT, sin caja o caja fuera de nomenclatura -> no se valida", () => {
  assert.equal(S.validatePonVsCaja({ oltId: "8", oltName: "8 - OLT-A-WND", board: "0", pon: "8", caja: "WND-A08B1" }), null);
  assert.equal(S.validatePonVsCaja({ ...OLT_A, board: "6", pon: "13", caja: null }), null);
  assert.equal(S.validatePonVsCaja({ ...OLT_A, board: "6", pon: "13", caja: "None" }), null);
  assert.equal(S.validatePonVsCaja({ ...OLT_A, board: null, pon: "13", caja: "A6DB4" }), null);
});

// ---------- PPPoE vs caja + puerto ----------

test("PPPoE: caja + puerto NAP en hexadecimal (casos del pedido y relevados)", () => {
  const v = (username, caja, puertoNap, olt = OLT_A) => S.validatePppoeVsCaja({ ...olt, username, caja, puertoNap });
  assert.equal(v("a6db45", "A6DB4", "5"), null);
  assert.equal(v("A6DB45", "A6DB4", "5"), null);
  assert.equal(v("a6db4e", "A6DB4", "14"), null);
  assert.equal(v("a6db4e", "A6DB4", "5"), PPPOE_WARN);
  assert.equal(v("a6db45", "A6DB4", "14"), PPPOE_WARN);
  assert.equal(v("a6db55", "A6DB4", "5"), PPPOE_WARN);
  assert.equal(v("alvd62b68", "ALV-D62B6", "8", { oltId: "5", oltName: "5 - OLT-D" }), null);
});

test("PPPoE: NAP sin puerto -> se valida solo la caja", () => {
  const v = (username, caja) => S.validatePppoeVsCaja({ ...OLT_A, username, caja, puertoNap: null });
  assert.equal(v("b29a33", "B29A3"), null);
  assert.equal(v("b29a43", "B29A3"), PPPOE_WARN);
  assert.equal(v("b29a3", "B29A3"), PPPOE_WARN);
});

test("PPPoE: sin usuario, sin caja u otra OLT -> no se valida", () => {
  assert.equal(S.validatePppoeVsCaja({ ...OLT_A, username: "", caja: "A6DB4", puertoNap: "5" }), null);
  assert.equal(S.validatePppoeVsCaja({ ...OLT_A, username: "a6db45", caja: null, puertoNap: "5" }), null);
  assert.equal(
    S.validatePppoeVsCaja({ oltId: "8", oltName: "8 - OLT-A-WND", username: "wnda08b1", caja: "WND-A08B1", puertoNap: "7" }),
    null
  );
});

// ---------- Evaluación compartida con el informe ----------

function rng(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("evaluateClientOptics da el mismo ✅/❌/⚠️ que el informe (1500 casos)", () => {
  const r = rng(7);
  const round = (x) => Math.round(x * 100) / 100;
  for (let i = 0; i < 1500; i++) {
    const records = [];
    const n = Math.floor(r() * 7);
    for (let k = 0; k < n; k++) {
      const online = r() < 0.75;
      records.push({
        name: `N${k}`, caja: "A6DB4", puerto: String(k + 1), status: online ? "Online" : "LOS", lastChange: "",
        sig1490: online && r() > 0.1 ? round(-21 + (r() - 0.5) * 4) : null,
        sig1310: online && r() > 0.1 ? round(-24.5 + (r() - 0.5) * 4) : null,
        serial: `HWTC${String(k).padStart(8, "0")}`,
      });
    }
    const client = {
      name: "C", caja: r() < 0.9 ? "A6DB4" : "ZZ999", puerto: "5", serial: r() < 0.3 && n ? "HWTC00000000" : "HWTC99999999",
      oltName: null, sig1490: r() < 0.08 ? null : round(-21.5 + (r() - 0.5) * 6), sig1310: r() < 0.08 ? null : round(-25 + (r() - 0.5) * 6),
    };
    const csv = r() < 0.9 ? records : null;
    const ev = S.evaluateClientOptics(client, csv);
    const text = S.buildClientReport(client, csv, rng(i)).text;
    const m = text.match(/`OP Cliente: [^`]*`(✅|❌|⚠️)/);
    assert.ok(m, text);
    assert.equal(ev.badge || "⚠️", m[1], `caso ${i}`);
  }
});

// ---------- Lector de la ficha ----------

const DASH_SRC = fs.readFileSync(path.join(ROOT, "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
function dashboardFunctionSource(name) {
  const start = DASH_SRC.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start !== -1, `dashboard.js no define ${name}`);
  return DASH_SRC.slice(start, DASH_SRC.indexOf("\n}\n", start) + 2);
}

// Estructura observada en SmartOLT (2026-09), anonimizada.
const FICHA = `<!doctype html><html><body><dl>
  <dt>OLT</dt><dd><a class="move-onu" data-olt-id="4" data-board="6" data-port="13" data-main-vlan="280" data-show-olt="1">4 - OLT-A</a></dd>
  <dt>Tarjeta</dt><dd><a class="move-onu" data-olt-id="4" data-board="6" data-port="13" data-show-olt="0">6</a></dd>
  <dt>Estado</dt><dd id="onu_status_wrapper"><span id="onu_status_value">Online<i class="fa fa-globe"></i>(18 horas hace)</span></dd>
  <dt>Señal Rx ONU/OLT</dt><dd id="signal_wrapper">-22.36 dBm / -25.23 dBm (2584m)</dd>
  <dt>Modo de configuración WAN</dt><dd><a class="update-mode" data-mode="routing" data-router-mode="PPPoE" data-username="a6db45" data-password="SECRETO-NO-LEER">PPPoE (TR069)</a></dd>
  <dt>Nombre de usuario PPPoE</dt><dd><span class="hidden_pppoe_username">**********</span><span class="pppoe_username" style="display:none">a6db45</span></dd>
</dl></body></html>`;

test("lector de la ficha: OLT/board/PON, estado y PPPoE — nunca la contraseña", async () => {
  const dom = new JSDOM(FICHA, { runScripts: "outside-only", url: "https://demo.smartolt.com/onu/view/1" });
  const data = JSON.parse(JSON.stringify(dom.window.eval(`(${dashboardFunctionSource("injectedReadDashboardPageData")})()`)));
  dom.window.close();
  assert.deepEqual(data, {
    oltId: "4",
    oltName: "4 - OLT-A",
    board: "6",
    pon: "13",
    username: "a6db45",
    statusText: "Online",
    statusAgo: "18 horas hace",
    distance: 2584,
  });
  assert.ok(!JSON.stringify(data).includes("SECRETO"));
});

test("dashboard.js no accede a data-password; el lector de la ficha no usa dataset", () => {
  const code = (src) => src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/data-password|dataset\.password|["']password["']/i.test(code(DASH_SRC)));
  const reader = code(dashboardFunctionSource("injectedReadDashboardPageData"));
  assert.ok(!/\.dataset\b/.test(reader), "el lector inyectado no debe leer dataset completos");
  assert.match(reader, /mode\.getAttribute\("data-username"\)/);
});
