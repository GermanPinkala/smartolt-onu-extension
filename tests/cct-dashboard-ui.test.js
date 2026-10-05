"use strict";

// Integración de los dashboards del perfil CCT (v4) en el popup real (ver
// popup-harness.js: popup.html + profile.js + scripts del perfil en jsdom).
// Correr con: cd tests && npm test

const test = require("node:test");
const assert = require("node:assert/strict");
const { row, HEALTHY, CONFIGURED_URL, CONFIGURED_PAGE, FICHA, openPopup } = require("./popup-harness");

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
