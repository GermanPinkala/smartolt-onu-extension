"use strict";

// Integración de los dashboards CCT (v4) en el popup real (ver
// popup-harness.js: popup.html + sus scripts en jsdom).
// Correr con: cd tests && npm test

const test = require("node:test");
const assert = require("node:assert/strict");
const { row, HEALTHY, CONFIGURED_URL, CONFIGURED_PAGE, fichaHtml, FICHA, openPopup } = require("./popup-harness");

// Filas de otra caja con distintos problemas.
const D1DB1 = [
  row("D Uno", "D1DB1", 1, "Online", -20.0, -23.0),
  row("D Dos", "D1DB1", 2, "Online", -20.2, -23.1),
  row("D Tres", "D1DB1", 3, "Online", -20.1, -23.2),
  row("D Power", "D1DB1", 4, "Power fail"),
  row("D Offline", "D1DB1", 5, "Offline"),
];
const A6DB4_PROBLEMS = [
  ...HEALTHY,
  row("María González", "A6DB4", 7, "LOS"),
  row("Smaniotto Silvia Marina", "A6DB4", 5, "Online", -22.5, -23.2),
];

function boxTexts(p) {
  return p.boxes().map((b) => b.textContent);
}
function expandedBoxes(p) {
  return p.boxes().map((b) => b.getAttribute("aria-expanded"));
}

// ---------- Contexto de caja: cajas del CSV ----------

test("1. una sola caja en el CSV: se abre sola al cargar; contadores generales ocultos", async () => {
  const p = await openPopup({
    tabUrl: CONFIGURED_URL,
    pageHtml: CONFIGURED_PAGE(["A6DB4"]),
    csvRows: [...HEALTHY, row("Juan Pérez", "A6DB4", 3, "Power fail"), row("María González", "A6DB4", 7, "LOS")],
  });
  assert.deepEqual(p.errors, []);
  assert.equal(p.$("boxDashboard").hidden, false);
  assert.equal(p.$("clientDashboard").hidden, true);
  assert.equal(p.$("capturedBox").dataset.context, "box");
  assert.equal(p.w.getComputedStyle(p.$("compactStats")).display, "none");
  assert.deepEqual(boxTexts(p), ["📦 A6DB4 · Prom. ONU -20.10 / OLT -23.03 dBm6 ONUs · 🔴 2 LOS/Power fail · 🟢 4 Online▾"]);
  assert.deepEqual(expandedBoxes(p), ["true"]);
  // Abierta: sus categorías visibles, todas cerradas (comportamiento interno igual).
  assert.deepEqual(p.cats().map((b) => b.textContent), ["🔴 LOS / Power Fail / Offline2▼"]);
  assert.equal(p.w.document.querySelectorAll(".bd-client").length, 0);
  assert.equal(p.w.document.querySelector("#boxDashboard .bd-mismatch"), null); // 12. caja actual presente: sin aviso
  p.close();
});

test("una sola caja: tocarla la cierra y una actualización posterior no la vuelve a abrir", async () => {
  const p = await openPopup({ tabUrl: CONFIGURED_URL, pageHtml: CONFIGURED_PAGE(["A6DB4"]), csvRows: A6DB4_PROBLEMS });
  assert.deepEqual(expandedBoxes(p), ["true"]);
  p.boxes()[0].click();
  assert.deepEqual(expandedBoxes(p), ["false"]);
  assert.equal(p.cats().length, 0);
  await p.w.refreshDashboard(); // p. ej. cambio de pestaña o CSV nuevo de la misma caja
  assert.deepEqual(expandedBoxes(p), ["false"]);
  p.boxes()[0].click(); // se puede volver a abrir a mano
  assert.deepEqual(expandedBoxes(p), ["true"]);
  p.close();
});

test("una sola caja en el CSV aunque la página muestre otra: se abre sola y hay aviso", async () => {
  const p = await openPopup({ tabUrl: CONFIGURED_URL, pageHtml: CONFIGURED_PAGE(["A4A6"]), csvRows: HEALTHY });
  assert.deepEqual(expandedBoxes(p), ["true"]);
  assert.ok(p.w.document.querySelector("#boxDashboard .bd-mismatch"));
  p.close();
});

test("2-3. varias cajas del CSV (orden natural), todas cerradas", async () => {
  const p = await openPopup({ tabUrl: CONFIGURED_URL, pageHtml: CONFIGURED_PAGE(["A6DB4"]), csvRows: [...D1DB1, ...HEALTHY] });
  assert.deepEqual(boxTexts(p), [
    "📦 A6DB4 · Prom. ONU -20.10 / OLT -23.03 dBm4 ONUs · 🟢 4 Online▸",
    "📦 D1DB1 · Prom. ONU -20.10 / OLT -23.10 dBm5 ONUs · 🔴 2 Power fail · 🟢 3 Online▸",
  ]);
  assert.deepEqual(expandedBoxes(p), ["false", "false"]);
  assert.equal(p.cats().length, 0);
  p.close();
});

test("4-6. acordeón de cajas: abrir, abrir otra cierra la anterior, tocar la abierta la cierra", async () => {
  const p = await openPopup({ tabUrl: CONFIGURED_URL, pageHtml: CONFIGURED_PAGE(["A6DB4"]), csvRows: [...D1DB1, ...A6DB4_PROBLEMS] });
  const catLabels = () => p.cats().map((b) => b.textContent);

  p.boxes()[1].click(); // D1DB1
  assert.deepEqual(expandedBoxes(p), ["false", "true"]);
  assert.equal(p.boxes()[1].textContent.endsWith("▾"), true);
  assert.deepEqual(catLabels(), ["🔴 LOS / Power Fail / Offline2▼"]);

  p.boxes()[0].click(); // A6DB4: D1DB1 se cierra
  assert.deepEqual(expandedBoxes(p), ["true", "false"]);
  assert.deepEqual(catLabels(), ["🔴 LOS / Power Fail / Offline1▼", "🟡 OP fuera de margen1▼"]);

  p.boxes()[0].click(); // cerrar la abierta
  assert.deepEqual(expandedBoxes(p), ["false", "false"]);
  assert.equal(p.cats().length, 0);
  p.close();
});

test("7. caja sin problemas: abierta (caja única) no muestra categorías", async () => {
  const p = await openPopup({ tabUrl: CONFIGURED_URL, pageHtml: CONFIGURED_PAGE(["A6DB4"]), csvRows: HEALTHY });
  assert.deepEqual(boxTexts(p), ["📦 A6DB4 · Prom. ONU -20.10 / OLT -23.03 dBm4 ONUs · 🟢 4 Online▾"]);
  assert.deepEqual(expandedBoxes(p), ["true"]);
  assert.equal(p.cats().length, 0);
  p.close();
});

test("8-11. categorías dentro de una caja: LOS, Power fail/Offline, OP; acordeón de categorías intacto", async () => {
  const p = await openPopup({ tabUrl: CONFIGURED_URL, pageHtml: CONFIGURED_PAGE(["A6DB4"]), csvRows: [...D1DB1, ...A6DB4_PROBLEMS] });
  const clients = () => Array.from(p.w.document.querySelectorAll(".bd-client"), (li) => li.textContent);
  const expandedCats = () => p.cats().map((b) => b.getAttribute("aria-expanded"));

  p.boxes()[1].click(); // D1DB1: Power fail + Offline
  p.cats()[0].click();
  assert.deepEqual(clients(), ["⚫ D PowerPuerto 4 · Power fail", "⚫ D OfflinePuerto 5 · Offline"]);

  p.boxes()[0].click(); // A6DB4: LOS + OP (la categoría abierta de D1DB1 no se arrastra)
  assert.deepEqual(expandedCats(), ["false", "false"]);
  p.cats()[0].click();
  assert.deepEqual(clients(), ["🔴 María GonzálezPuerto 7 · LOS"]);
  p.cats()[1].click(); // una sola categoría abierta
  assert.deepEqual(expandedCats(), ["false", "true"]);
  assert.deepEqual(clients(), ["🟡 Smaniotto Silvia MarinaPuerto 5 · OP fuera de margen"]);
  p.cats()[1].click();
  assert.deepEqual(expandedCats(), ["false", "false"]);
  assert.deepEqual(clients(), []);
  p.close();
});

test("12. caja actual presente en el CSV (entre varias): sin aviso", async () => {
  const p = await openPopup({ tabUrl: CONFIGURED_URL, pageHtml: CONFIGURED_PAGE(["D1DB1"]), csvRows: [...D1DB1, ...HEALTHY] });
  assert.equal(p.w.document.querySelector("#boxDashboard .bd-mismatch"), null);
  assert.equal(p.boxes().length, 2);
  p.close();
});

test("13-15. caja actual NO presente en el CSV: dashboard visible con las cajas del CSV y aviso claro", async () => {
  const p = await openPopup({ tabUrl: CONFIGURED_URL, pageHtml: CONFIGURED_PAGE(["A4A6"]), csvRows: [...D1DB1, ...HEALTHY] });
  assert.deepEqual(p.errors, []);
  assert.equal(p.$("boxDashboard").hidden, false);
  assert.equal(p.$("capturedBox").dataset.context, "box");
  const warning = p.w.document.querySelector("#boxDashboard .bd-mismatch");
  assert.ok(warning);
  assert.equal(
    warning.textContent,
    "⚠️ La página muestra A4A6Esta caja no está en los datos cargados. Abajo, las cajas del CSV."
  );
  assert.deepEqual(boxTexts(p).map((t) => t.split(" · ")[0]), ["📦 A6DB4", "📦 D1DB1"]);
  p.close();
});

test("sin caja identificable en la página: cajas del CSV, sin aviso", async () => {
  const p = await openPopup({ tabUrl: CONFIGURED_URL, pageHtml: "<html><body></body></html>", csvRows: HEALTHY });
  assert.equal(p.$("boxDashboard").hidden, false);
  assert.equal(p.w.document.querySelector("#boxDashboard .bd-mismatch"), null);
  assert.equal(p.boxes().length, 1);
  p.close();
});

test("16. muchas cajas: área de cajas con altura máxima y scroll vertical propio", async () => {
  const rows = [];
  for (let c = 1; c <= 12; c++) {
    for (let k = 1; k <= 3; k++) rows.push(row(`C${c}-${k}`, `A${c}AA1`, k, k === 3 ? "LOS" : "Online", -20.1, -23.1));
  }
  const p = await openPopup({ tabUrl: CONFIGURED_URL, pageHtml: CONFIGURED_PAGE(["A1AA1"]), csvRows: rows });
  assert.equal(p.boxes().length, 12);
  const area = p.w.document.querySelector("#boxDashboard .bd-boxes");
  assert.ok(area.contains(p.boxes()[11]));
  const style = p.w.getComputedStyle(area);
  assert.equal(style.overflowY, "auto");
  assert.equal(style.maxHeight, "320px");
  // El resto del popup no queda limitado.
  // (jsdom devuelve "" para un max-height sin definir)
  assert.ok(["", "none"].includes(p.w.getComputedStyle(p.$("boxDashboard")).maxHeight));
  assert.ok(["", "none"].includes(p.w.getComputedStyle(p.w.document.body).maxHeight));
  p.close();
});

test("dashboard y ESTADO DE CAJAS listan los mismos clientes", async () => {
  const p = await openPopup({ tabUrl: CONFIGURED_URL, pageHtml: CONFIGURED_PAGE(["A6DB4"]), csvRows: A6DB4_PROBLEMS });
  const names = () => Array.from(p.w.document.querySelectorAll(".bd-client > span:first-child"), (s) => s.textContent.replace(/^\S+ /, ""));
  // Caja única: ya está abierta.
  p.cats()[0].click();
  const statusNames = names();
  p.cats()[1].click();
  const opNames = names();
  p.w.navigator.clipboard = { writeText: async () => {} };
  p.$("consultarCajasBtn").click();
  await new Promise((r) => setTimeout(r, 300));
  const report = p.$("generatedTextPreview").value.split("\n");
  assert.deepEqual(report.filter((l) => /^(🔴|⚫) P/.test(l)).map((l) => l.split(" | ")[2]).sort(), statusNames.sort());
  assert.deepEqual(report.filter((l) => l.startsWith("🟡 ")).map((l) => l.split(" | ")[2]), opNames);
  p.close();
});

// ---------- Otros contextos: sin cambios ----------

test("17. ficha de cliente: dashboard individual, SIN contadores generales ni dashboard de caja", async () => {
  const p = await openPopup({ tabUrl: "https://demo.smartolt.com/onu/view/7", pageHtml: FICHA, csvRows: HEALTHY });
  assert.deepEqual(p.errors, []);
  assert.equal(p.$("clientDashboard").hidden, false);
  assert.equal(p.$("boxDashboard").hidden, true);
  assert.equal(p.$("capturedBox").dataset.context, "client");
  assert.equal(p.w.getComputedStyle(p.$("compactStats")).display, "none");
  assert.equal(p.$("cdOnu").textContent, "-20.50 dBm");
  assert.deepEqual(p.calls.statusFetchWorlds, ["MAIN"]);
  p.close();
});

// ---------- Diferencia con el promedio: "X.XX dB mejor/peor que prom." ----------
// Promedio de HEALTHY (3 mejores): ONU -20.10 / OLT -23.03 (-23.0333…).

async function clientDeltas(signal) {
  const p = await openPopup({ tabUrl: "https://demo.smartolt.com/onu/view/7", pageHtml: fichaHtml({ signal }), csvRows: HEALTHY });
  assert.deepEqual(p.errors, []);
  const out = {
    onu: p.$("cdOnu").textContent,
    olt: p.$("cdOlt").textContent,
    onuDelta: p.$("cdOnuDelta").textContent,
    oltDelta: p.$("cdOltDelta").textContent,
    onuLevel: p.$("cdOnuDelta").dataset.level,
    oltLevel: p.$("cdOltDelta").dataset.level,
    verdict: p.$("cdVerdict").textContent,
    average: p.$("cdAverage").textContent,
  };
  p.close();
  return out;
}

test("diferencia peor que el promedio: sin signo, 'X.XX dB peor que prom.'; valores y condición iguales", async () => {
  const d = await clientDeltas("-20.50 dBm / -23.40 dBm (1500m)");
  assert.equal(d.onu, "-20.50 dBm");
  assert.equal(d.olt, "-23.40 dBm");
  assert.equal(d.onuDelta, "0.40 dB peor que prom.");
  assert.equal(d.oltDelta, "0.37 dB peor que prom.");
  assert.equal(d.average, "Prom. caja: ONU -20.10 · OLT -23.03");
  assert.equal(d.verdict, "✅");
  assert.deepEqual([d.onuLevel, d.oltLevel], ["ok", "ok"]);
});

test("diferencia mejor que el promedio: 'X.XX dB mejor que prom.'", async () => {
  const d = await clientDeltas("-19.00 dBm / -22.00 dBm (1500m)");
  assert.equal(d.onuDelta, "1.10 dB mejor que prom.");
  assert.equal(d.oltDelta, "1.03 dB mejor que prom.");
  assert.equal(d.verdict, "✅");
});

test("diferencia casi nula: 'X.XX dB vs prom.' sin dirección", async () => {
  const d = await clientDeltas("-20.12 dBm / -23.05 dBm (1500m)");
  assert.equal(d.onuDelta, "0.02 dB vs prom.");
  assert.equal(d.oltDelta, "0.02 dB vs prom.");
  assert.ok(!/[+−-]/.test(d.onuDelta + d.oltDelta));
});

test("fuera de margen: solo cambia el texto; ❌ y nivel 'bad' como antes", async () => {
  const d = await clientDeltas("-22.00 dBm / -25.00 dBm (1500m)");
  assert.equal(d.onuDelta, "1.90 dB peor que prom.");
  assert.equal(d.oltDelta, "1.97 dB peor que prom.");
  assert.equal(d.verdict, "❌");
  assert.deepEqual([d.onuLevel, d.oltLevel], ["bad", "bad"]);
});

test("formatAverageDifference: ejemplos reales y límites del tramo neutro", async () => {
  const p = await openPopup({ tabUrl: "https://demo.smartolt.com/onu/view/7", pageHtml: FICHA, csvRows: HEALTHY });
  const f = p.w.formatAverageDifference;
  assert.equal(f(-24.56, -22.22), "2.34 dB peor que prom.");
  assert.equal(f(-26.99, -24.46), "2.53 dB peor que prom.");
  assert.equal(f(-20.0, -22.34), "2.34 dB mejor que prom.");
  assert.equal(f(-20.1, -20.1), "0.00 dB vs prom.");
  assert.equal(f(-20.14, -20.1), "0.04 dB vs prom.");
  assert.equal(f(-20.15, -20.1), "0.05 dB peor que prom.");
  assert.equal(f(-20.05, -20.1), "0.05 dB mejor que prom.");
  p.close();
});

// ---------- Contexto de la pestaña: cajas por defecto, cliente solo en /onu/view ----------

const NOSIS = "https://informes.nosis.com/consulta";
const CLIENT_URL = "https://demo.smartolt.com/onu/view/12345";

function assertBoxContext(p, label) {
  assert.equal(p.$("boxDashboard").hidden, false, `${label}: dashboard de cajas visible`);
  assert.equal(p.$("clientDashboard").hidden, true, `${label}: dashboard de cliente oculto`);
  assert.equal(p.$("capturedBox").dataset.context, "box", label);
  assert.equal(p.w.getComputedStyle(p.$("compactStats")).display, "none", `${label}: sin contadores generales`);
}
function assertClientContext(p, label) {
  assert.equal(p.$("clientDashboard").hidden, false, `${label}: dashboard de cliente visible`);
  assert.equal(p.$("boxDashboard").hidden, true, `${label}: dashboard de cajas oculto`);
  assert.equal(p.$("capturedBox").dataset.context, "client", label);
}

test("3, 7-9. página externa (Nosis): dashboard de cajas del CSV, sin aviso y sin leer la página", async () => {
  const p = await openPopup({ tabUrl: NOSIS, pageHtml: CONFIGURED_PAGE(["A4A6"]), csvRows: [...D1DB1, ...HEALTHY] });
  assert.deepEqual(p.errors, []);
  assertBoxContext(p, "Nosis");
  assert.deepEqual(boxTexts(p), [
    "📦 A6DB4 · Prom. ONU -20.10 / OLT -23.03 dBm4 ONUs · 🟢 4 Online▸",
    "📦 D1DB1 · Prom. ONU -20.10 / OLT -23.10 dBm5 ONUs · 🔴 2 Power fail · 🟢 3 Online▸",
  ]);
  // Aunque la página externa tuviera un "#odb", no se busca ninguna caja en ella.
  assert.equal(p.w.document.querySelector("#boxDashboard .bd-mismatch"), null);
  assert.deepEqual(p.calls.injections.filter((c) => !/\.smartolt\.com\//.test(c.url)), []);
  p.close();
});

test("4. otra página de SmartOLT (no /onu/view): dashboard de cajas, sin aviso", async () => {
  const p = await openPopup({ tabUrl: "https://demo.smartolt.com/dashboard", pageHtml: "<html></html>", csvRows: HEALTHY });
  assertBoxContext(p, "SmartOLT /dashboard");
  assert.deepEqual(boxTexts(p), ["📦 A6DB4 · Prom. ONU -20.10 / OLT -23.03 dBm4 ONUs · 🟢 4 Online▾"]); // 12. caja única abierta
  assert.equal(p.w.document.querySelector("#boxDashboard .bd-mismatch"), null);
  p.close();
});

test("1-2, 5-6. transiciones: la URL actual decide; el modo cliente no queda pegado", async () => {
  const p = await openPopup({ tabUrl: CLIENT_URL, pageHtml: FICHA, csvRows: [...D1DB1, ...HEALTHY] });
  assertClientContext(p, "ficha");
  assert.equal(p.$("cdOnu").textContent, "-20.50 dBm");

  await p.navigate(NOSIS); // salir de la ficha
  assertBoxContext(p, "Nosis tras la ficha");
  assert.equal(p.boxes().length, 2);

  await p.navigate(CONFIGURED_URL, CONFIGURED_PAGE(["A4A6"])); // vista de caja: aviso de SmartOLT
  assertBoxContext(p, "/onu/configured");
  assert.ok(p.w.document.querySelector("#boxDashboard .bd-mismatch"));

  await p.navigate(CLIENT_URL, FICHA); // volver a la ficha
  assertClientContext(p, "ficha otra vez");
  assert.equal(p.$("cdOnu").textContent, "-20.50 dBm");

  await p.navigate("https://www.google.com/"); // y salir de nuevo
  assertBoxContext(p, "Google");
  assert.equal(p.w.document.querySelector("#boxDashboard .bd-mismatch"), null);
  assert.deepEqual(p.errors, []);
  p.close();
});

test("10-11. fuera de SmartOLT: acordeón de cajas, categorías y área con scroll funcionan igual", async () => {
  const p = await openPopup({ tabUrl: NOSIS, pageHtml: "<html></html>", csvRows: [...D1DB1, ...A6DB4_PROBLEMS] });
  const expanded = () => p.boxes().map((b) => b.getAttribute("aria-expanded"));
  p.boxes()[1].click();
  assert.deepEqual(expanded(), ["false", "true"]);
  p.cats()[0].click();
  assert.deepEqual(
    Array.from(p.w.document.querySelectorAll(".bd-client"), (li) => li.textContent),
    ["⚫ D PowerPuerto 4 · Power fail", "⚫ D OfflinePuerto 5 · Offline"]
  );
  p.boxes()[0].click();
  assert.deepEqual(expanded(), ["true", "false"]);
  const area = p.w.getComputedStyle(p.w.document.querySelector("#boxDashboard .bd-boxes"));
  assert.equal(area.overflowY, "auto");
  assert.equal(area.maxHeight, "320px");
  p.close();
});

test("12. fuera de SmartOLT: caja única se abre sola", async () => {
  const p = await openPopup({ tabUrl: NOSIS, pageHtml: "<html></html>", csvRows: A6DB4_PROBLEMS });
  assert.deepEqual(p.boxes().map((b) => b.getAttribute("aria-expanded")), ["true"]);
  p.close();
});

test("sin CSV (cualquier página): no hay dashboard de cajas, se mantiene el estado sin CSV de siempre", async () => {
  for (const url of [NOSIS, CONFIGURED_URL]) {
    const p = await openPopup({ tabUrl: url, pageHtml: CONFIGURED_PAGE(["A6DB4"]), csvRows: null });
    assert.equal(p.$("boxDashboard").hidden, true, url);
    assert.equal(p.$("capturedBox").dataset.context, undefined, url);
    assert.equal(p.$("consultarCajasBtn").disabled, true, url);
    p.close();
  }
});

// ---------- Migrados de callcenter-ui.test.js (comportamiento de CCT) ----------

test("CCT: abre directo, sin selector de perfil ni Call Center; sus botones y una sola consulta", async () => {
  const p = await openPopup({ tabUrl: "https://demo.smartolt.com/onu/view/555", pageHtml: FICHA, csvRows: HEALTHY });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(p.errors, []);
  assert.equal(p.visible(p.$("appView")), true);
  assert.equal(p.$("profileSelectView"), null);
  assert.equal(p.$("profileBarLabel"), null);
  assert.equal(p.visible(p.$("consultarCajasBtn")), true);
  assert.equal(p.visible(p.$("obtenerClienteBtn")), true);
  assert.equal(p.$("ccBoxReportBtn"), null);
  assert.equal(p.$("ccObservationBtn"), null);
  assert.equal(p.$("ccClientSection"), null);
  assert.equal(p.w.SmartOLTCallCenter, undefined);
  assert.deepEqual(p.calls.fetches.map((f) => f.url.split("?")[0].replace(/\d+$/, "")), ["/api/onu/get_onu_status_and_signal/"]);
  p.close();
});

test("vista caja CCT: promedio junto al nombre de cada caja", async () => {
  const p = await openPopup({ tabUrl: CONFIGURED_URL, pageHtml: CONFIGURED_PAGE(["A6DB4"]), csvRows: HEALTHY });
  assert.equal(p.w.document.querySelector("#boxDashboard .bd-title").textContent, "📦 A6DB4 · Prom. ONU -20.10 / OLT -23.03 dBm");
  p.close();
});

test("vista caja CCT: nunca muestra 'Posible caja cortada'", async () => {
  const rows = [row("X1", "C27A3", 1, "LOS"), row("X2", "C27A3", 2, "LOS")];
  const p = await openPopup({ tabUrl: CONFIGURED_URL, pageHtml: CONFIGURED_PAGE(["C27A3"]), csvRows: rows });
  assert.ok(!p.$("boxDashboard").textContent.includes("Posible caja cortada"));
  p.close();
});
