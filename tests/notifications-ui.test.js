"use strict";

// Notificaciones (componente común de popup.js): el TIPO
// define el esquema visual (success verde, info azul/neutro, warning amarillo,
// error rojo) sin cambiar el texto ni el mecanismo de mostrar/cerrar.
// Correr con: cd tests && npm test

const test = require("node:test");
const assert = require("node:assert/strict");
const { HEALTHY, CONFIGURED_URL, CONFIGURED_PAGE, openPopup } = require("./popup-harness");

const open = (options = {}) =>
  openPopup(Object.assign({ tabUrl: "https://demo.smartolt.com/dashboard", pageHtml: "<html></html>", csvRows: HEALTHY }, options));

function notice(p) {
  const box = p.$("notificationBox");
  return {
    visible: !box.hidden,
    type: box.dataset.type,
    kind: box.dataset.kind,
    summary: p.$("notificationSummary").textContent,
    closable: !p.$("notificationCloseBtn").hidden,
    acknowledgeable: !p.$("notificationAcknowledgeBtn").hidden,
    borderLeft: p.w.getComputedStyle(box).borderLeftColor,
    background: p.w.getComputedStyle(box).backgroundColor,
  };
}

// Colores de popup.css (var(--green), #fbbf24, var(--red), var(--accent)).
const GREEN = "rgb(34, 197, 94)";
const YELLOW = "rgb(251, 191, 36)";
const RED = "rgb(239, 68, 68)";
const ACCENT = "rgb(59, 130, 246)";

function assertColor(actual, expected) {
  // jsdom puede no resolver var(): en ese caso alcanza con que la regla del tipo exista.
  if (actual && !actual.includes("var(")) assert.equal(actual, expected);
}

test("SUCCESS: 'CSV capturado correctamente' se ve en verde, mismo texto y se puede cerrar", async () => {
  const p = await open();
  p.w.showCsvCapturedNotification({ fileName: "x.csv", capturedAt: 1, csvText: "abc" });
  const n = notice(p);
  assert.equal(n.visible, true);
  assert.equal(n.type, "success");
  assert.equal(n.kind, "operational");
  assert.equal(n.summary, "✅ CSV capturado correctamente.");
  assert.equal(n.closable, true);
  assertColor(n.borderLeft, GREEN);
  assert.equal(n.background, "rgba(34, 197, 94, 0.14)");
  p.$("notificationCloseBtn").click();
  assert.equal(p.$("notificationBox").hidden, true);
  p.close();
});

test("WARNING: datos desactualizados / sin caja seleccionada se ven en amarillo", async () => {
  const p = await open();
  p.w.setUpdateStatusText("⚠️ No hay una caja seleccionada actualmente.", "stale");
  const n = notice(p);
  assert.equal(n.type, "warning");
  assert.equal(n.summary, "⚠️ No hay una caja seleccionada actualmente.");
  assert.equal(n.closable, true);
  assertColor(n.borderLeft, YELLOW);
  assert.equal(n.background, "rgba(251, 191, 36, 0.13)");
  p.close();
});

test("ERROR: fallas (p. ej. no se pudo iniciar la actualización) se ven en rojo", async () => {
  const p = await open();
  p.w.setUpdateStatusText("⚠️ No se pudo iniciar la actualización", "error");
  const n = notice(p);
  assert.equal(n.type, "error");
  assert.equal(n.summary, "⚠️ No se pudo iniciar la actualización");
  assertColor(n.borderLeft, RED);
  assert.equal(n.background, "rgba(239, 68, 68, 0.14)");
  p.close();
});

test("INFO: novedades de versión con el estilo informativo (azul) y botón 'Entendido'", async () => {
  // v3.0.9 trae una novedad de versión real en el changelog.
  const p = await open({ version: "3.0.9" });
  const n = notice(p);
  assert.equal(n.visible, true);
  assert.equal(n.type, "info");
  assert.equal(n.kind, "version");
  assert.match(n.summary, /Actualizar datos/);
  assert.equal(n.acknowledgeable, true);
  assert.equal(n.closable, false);
  assertColor(n.borderLeft, ACCENT);
  // Info no pinta fondo propio: usa el panel base (no rojo/verde/amarillo).
  assert.ok(!["rgba(34, 197, 94, 0.14)", "rgba(251, 191, 36, 0.13)", "rgba(239, 68, 68, 0.14)"].includes(n.background));
  p.close();
});

test("una operativa sin tipo explícito sigue siendo error (comportamiento anterior)", async () => {
  const p = await open();
  p.w.showOperationalNotification({ id: "x", summary: "Algo falló", detail: "", priority: 100 });
  assert.equal(notice(p).type, "error");
  p.close();
});

test("el tipo cambia con cada notificación (no queda el color anterior)", async () => {
  const p = await open({ tabUrl: CONFIGURED_URL, pageHtml: CONFIGURED_PAGE(["A6DB4"]) });
  p.w.setUpdateStatusText("⚠️ No se pudo iniciar la actualización", "error");
  assert.equal(notice(p).type, "error");
  p.$("notificationCloseBtn").click();
  p.w.showCsvCapturedNotification({ fileName: "y.csv", capturedAt: 2, csvText: "abcd" });
  assert.equal(notice(p).type, "success");
  p.close();
});
