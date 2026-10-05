"use strict";

// Integración del perfil CALL CENTER en el popup real (ver popup-harness.js):
// botones y sección propios, dashboard de cajas con promedio y "Posible caja
// cortada", informe de cajas, diagnóstico de la ficha (historial de señal,
// cortes, otros clientes) y observación. También que CCT no cambie.
// Correr con: cd tests && npm test

const test = require("node:test");
const assert = require("node:assert/strict");
const { row, HEALTHY, CONFIGURED_URL, CONFIGURED_PAGE, fichaHtml, FICHA, openPopup } = require("./popup-harness");

const CLIENT_URL = "https://demo.smartolt.com/onu/view/555";

// "YYYY-MM-DD HH:MM:SSZ" a partir de hace N horas (formato de la tabla History).
function hoursAgo(hours) {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ") + "Z";
}
function historyText(downsHoursAgo, reason = "ONT dying-gasp") {
  const lines = ["Optical status", "Rx optical power(dBm)  : -20.50", "", "History", "#  UP Authentication time  Offline time  Down reason"];
  lines.push(`${String(downsHoursAgo.length + 1).padStart(2, "0")}  ${hoursAgo(0.5)}  ONU is currently online`);
  downsHoursAgo.forEach((h, i) => {
    lines.push(`${String(downsHoursAgo.length - i).padStart(2, "0")}  ${hoursAgo(h + 1)}  ${hoursAgo(h)}  ${reason}`);
  });
  lines.push("", "ONU WAN config", "IPv4 address  : 10.0.0.1");
  return lines.join("\n");
}

// SmartOLT simulado para la ficha: estado, serie de señal de 24 hs y "Obtener estado".
function smartOltFetch({ signalValues = [-23.4, -23.5], history = historyText([]), statusAsJson = true } = {}) {
  return (url) => {
    if (url.includes("/api/onu/get_onu_status_and_signal/")) {
      return { status: true, onu_status: "Online", last_status_change_unix: Math.floor(Date.now() / 1000) - 3600, distance: 1500 };
    }
    if (url.includes("/signal/get_signal_graph_series_for_onu/")) {
      const now = Date.now();
      return { start: 0, end: 0, step: 300, series: [{ name: "1310nm OLT Rx for ONU", points: signalValues.map((v, i) => [now - i * 300000, v]) }] };
    }
    if (url.includes("/api/onu/status/")) {
      const html = `<pre>${history.replace(/\n/g, "<br>")}</pre>`;
      return statusAsJson ? { status: true, response: html } : html;
    }
    return null;
  };
}

function ccLines(p) {
  return Array.from(p.w.document.querySelectorAll("#ccClientSection .cc-line"), (el) => el.textContent);
}
async function settle(ms = 300) {
  await new Promise((r) => setTimeout(r, ms));
}

// ---------- Perfiles: cada uno con sus botones ----------

test("Call Center: barra de perfil, botones propios visibles y los de CCT ocultos", async () => {
  const p = await openPopup({ profile: "callcenter", tabUrl: CONFIGURED_URL, pageHtml: CONFIGURED_PAGE(["A6DB4"]), csvRows: HEALTHY });
  assert.deepEqual(p.errors, []);
  assert.equal(p.$("profileBarLabel").textContent, "Perfil: 📞 CALL CENTER");
  assert.equal(p.visible(p.$("ccBoxReportBtn")), true);
  assert.equal(p.visible(p.$("ccObservationBtn")), true);
  assert.equal(p.visible(p.$("consultarCajasBtn")), false);
  assert.equal(p.visible(p.$("obtenerClienteBtn")), false);
  assert.equal(p.$("ccBoxReportBtn").disabled, false);
  assert.equal(p.$("ccObservationBtn").disabled, true); // sin ficha de cliente
  p.close();
});

test("CCT sin cambios: sus botones, sin nada de Call Center ni consultas nuevas", async () => {
  const p = await openPopup({ profile: "cct", tabUrl: CLIENT_URL, pageHtml: FICHA, csvRows: HEALTHY, fetchHandler: smartOltFetch() });
  await settle();
  assert.deepEqual(p.errors, []);
  assert.equal(p.$("profileBarLabel").textContent, "Perfil: 🛠️ CCT");
  assert.equal(p.visible(p.$("consultarCajasBtn")), true);
  assert.equal(p.visible(p.$("obtenerClienteBtn")), true);
  assert.equal(p.visible(p.$("ccBoxReportBtn")), false);
  assert.equal(p.visible(p.$("ccObservationBtn")), false);
  assert.equal(p.visible(p.$("ccClientSection")), false);
  assert.equal(p.w.SmartOLTCallCenter, undefined); // callcenter.js no se carga en CCT
  assert.deepEqual(p.calls.fetches.map((f) => f.url.split("?")[0].replace(/\d+$/, "")), ["/api/onu/get_onu_status_and_signal/"]);
  p.close();
});

// ---------- Vista caja ----------

test("vista caja (ambos perfiles): promedio junto al nombre de cada caja", async () => {
  for (const profile of ["cct", "callcenter"]) {
    const p = await openPopup({ profile, tabUrl: CONFIGURED_URL, pageHtml: CONFIGURED_PAGE(["A6DB4"]), csvRows: HEALTHY });
    assert.equal(p.w.document.querySelector("#boxDashboard .bd-title").textContent, "📦 A6DB4 · Prom. ONU -20.10 / OLT -23.03 dBm", profile);
    p.close();
  }
});

test("vista caja Call Center: 'Posible caja cortada' solo en la caja 100% crítica; acordeón igual", async () => {
  const rows = [...HEALTHY, row("X1", "C27A3", 1, "LOS"), row("X2", "C27A3", 2, "Power fail"), row("X3", "C27A3", 3, "Offline")];
  const p = await openPopup({ profile: "callcenter", tabUrl: "https://informes.nosis.com/", pageHtml: "<html></html>", csvRows: rows });
  const texts = p.boxes().map((b) => b.textContent);
  assert.equal(texts.length, 2);
  assert.ok(!texts[0].includes("Posible caja cortada"), texts[0]);
  assert.match(texts[1], /^📦 C27A3 · Sin promedio3 ONUs · 🔴 3 LOS\/Power fail · 🟢 0 Online🔴 Posible caja cortada▸$/);
  p.boxes()[1].click();
  assert.deepEqual(p.boxes().map((b) => b.getAttribute("aria-expanded")), ["false", "true"]);
  assert.deepEqual(p.cats().map((b) => b.textContent), ["🔴 LOS / Power Fail / Offline3▼"]);
  p.close();
});

test("vista caja CCT: nunca muestra 'Posible caja cortada'", async () => {
  const rows = [row("X1", "C27A3", 1, "LOS"), row("X2", "C27A3", 2, "LOS")];
  const p = await openPopup({ profile: "cct", tabUrl: CONFIGURED_URL, pageHtml: CONFIGURED_PAGE(["C27A3"]), csvRows: rows });
  assert.ok(!p.$("boxDashboard").textContent.includes("Posible caja cortada"));
  p.close();
});

test("📦 INFORME DE CAJAS (Call Center): todos los clientes, con fecha del CSV", async () => {
  const rows = [...HEALTHY, row("María González", "A6DB4", 7, "LOS"), row("Smaniotto", "A6DB4", 5, "Online", -22.5, -23.2)];
  const p = await openPopup({ profile: "callcenter", tabUrl: CONFIGURED_URL, pageHtml: CONFIGURED_PAGE(["A6DB4"]), csvRows: rows });
  p.$("ccBoxReportBtn").click();
  await settle();
  const text = p.$("generatedTextPreview").value;
  assert.equal(p.calls.clipboard, text);
  const lines = text.split("\n");
  assert.match(lines[0], /^📅 Datos del: /);
  assert.ok(lines.includes("📦 A6DB4 · Prom. ONU -20.10 / OLT -23.03 dBm"));
  assert.ok(lines.includes("6 ONUs · 🟢 5 Online · 🔴 1 LOS · 🟡 1 OP fuera de margen"));
  assert.equal(lines.filter((l) => /^P\d /.test(l)).length, 6);
  assert.ok(lines.includes("P7 🔴 María González · LOS"));
  assert.ok(lines.includes("P5 🟡 Smaniotto · ONU -22.50 / OLT -23.20 · OP fuera de margen"));
  p.close();
});

// ---------- Vista cliente ----------

test("ficha Call Center: dashboard base + historial, cortes y otros LOS; consultas en la página", async () => {
  const rows = [...HEALTHY, row("L1", "A6DB4", 7, "LOS"), row("L2", "A6DB4", 9, "LOS")];
  const p = await openPopup({
    profile: "callcenter",
    tabUrl: CLIENT_URL,
    pageHtml: FICHA,
    csvRows: rows,
    fetchHandler: smartOltFetch({ signalValues: [-23.4, -29.5, -21.5, -23.0], history: historyText([2, 5, 30]) }),
  });
  await settle();
  assert.deepEqual(p.errors, []);
  // Dashboard base intacto.
  assert.equal(p.$("cdStatus").textContent, "🟢 ONLINE");
  assert.equal(p.$("cdOnu").textContent, "-20.50 dBm");
  assert.equal(p.$("boxDashboard").hidden, true);
  // Sección de Call Center.
  assert.equal(p.visible(p.$("ccClientSection")), true);
  const lines = ccLines(p);
  assert.deepEqual(lines.slice(0, 3), [
    "📈 Fluctuación OP OLT en 24 hs: 8.00 dB",
    "✂️ Cortes en 24 hs: 2",
    "🚨 Otros clientes en LOS: P7 y P9",
  ]);
  // Referencia temporal simple del CSV: la fecha/hora real de la captura.
  assert.equal(lines[3], `CSV · ${p.w.eval("SmartOLTShared.formatShortDateTime(currentCapturedAt)")}`);
  assert.match(lines[3], /^CSV · \d\d\/\d\d\/\d\d \d\d:\d\d$/);
  assert.equal(lines.length, 4);
  // Detalle de causas y horas solo en el tooltip de la línea de cortes.
  const cutsLine = Array.from(p.w.document.querySelectorAll("#ccClientSection .cc-line")).find((el) => el.textContent.startsWith("✂️"));
  assert.ok(cutsLine.classList.contains("cc-has-tooltip"));
  const tip = cutsLine.title.split("\n");
  assert.equal(tip.length, 5);
  assert.equal(tip[0], "2 por dying-gasp (corte de energía)");
  assert.equal(tip[2], "Cortes detectados en las últimas 24 hs:");
  assert.match(tip[3], /^\d\d\/\d\d \d\d:\d\d — dying-gasp \(corte de energía\)$/);
  // Las demás líneas no tienen tooltip.
  assert.equal(p.w.document.querySelectorAll("#ccClientSection .cc-has-tooltip").length, 1);
  // Consultas: serie de señal y "Obtener estado", ambas dentro de la página (MAIN).
  const worlds = Object.fromEntries(p.calls.injections.map((c) => [c.name, c.world]));
  assert.equal(worlds.injectedFetchSignalSeries, "MAIN");
  assert.equal(worlds.injectedFetchStatusHistory, "MAIN");
  const signalFetch = p.calls.fetches.find((f) => f.url.includes("/signal/"));
  assert.match(signalFetch.url, /\/signal\/get_signal_graph_series_for_onu\/555\?from=\d+&to=\d+&step=300$/);
  assert.equal(p.calls.fetches.filter((f) => f.url.includes("/api/onu/status/")).length, 1); // una sola consulta a la OLT
  assert.equal(p.$("ccObservationBtn").disabled, false);
  // Nada sensible en la sección.
  assert.ok(!/TOKEN|NO-LEER|10\.0\.0\.1/.test(p.$("clientDashboard").textContent));
  p.close();
});

test("📋 GENERAR OBSERVACIÓN: junta todos los hallazgos y la copia", async () => {
  const rows = [...HEALTHY, row("L1", "A6DB4", 7, "LOS"), row("L2", "A6DB4", 9, "LOS")];
  const p = await openPopup({
    profile: "callcenter",
    tabUrl: CLIENT_URL,
    pageHtml: fichaHtml({ signal: "-24.10 dBm / -23.10 dBm (1500m)" }),
    csvRows: rows,
    fetchHandler: smartOltFetch({ signalValues: [-23.1, -31.1], history: historyText([1, 3, 6], "ONT LOSi/LOBi alarm") }),
  });
  p.$("ccObservationBtn").click();
  await settle(500);
  const text = p.$("generatedTextPreview").value;
  assert.equal(p.calls.clipboard, text);
  assert.equal(
    text,
    "Cliente presenta OP alto (ONU -24.10 dBm / OLT -23.10 dBm), con una diferencia de 4.00 dB en ONU respecto al promedio de la caja. " +
      "Se detectaron fluctuaciones de hasta 8.00 dB en la señal (OLT) en las últimas 24 hs. " +
      "Se registraron 3 cortes en las últimas 24 hs, según SmartOLT. " +
      "Se detectan además los puertos 7 y 9 en LOS."
  );
  assert.equal(p.$("clienteFeedback").textContent, "✓ Observación copiada");
  p.close();
});

test("ficha Call Center: cliente en LOS con toda la caja caída -> posible caja cortada", async () => {
  const rows = [row("L1", "A6DB4", 1, "LOS"), row("P1", "A6DB4", 2, "Power fail"), row("O1", "A6DB4", 3, "Offline")];
  const p = await openPopup({
    profile: "callcenter",
    tabUrl: CLIENT_URL,
    pageHtml: fichaHtml({ status: "LOS", signal: "-" }),
    csvRows: rows,
    fetchHandler: (url) =>
      url.includes("get_onu_status_and_signal")
        ? { status: true, onu_status: "LOS", last_status_change_unix: Math.floor(Date.now() / 1000) - 600 }
        : smartOltFetch({ signalValues: [], history: historyText([0.2]) })(url),
  });
  await settle();
  assert.ok(ccLines(p).includes("🔴 Posible caja cortada"));
  assert.ok(!ccLines(p).some((l) => l.startsWith("🚨")));
  p.$("ccObservationBtn").click();
  await settle(500);
  assert.equal(
    p.$("generatedTextPreview").value,
    "Cliente presenta LOS. Se registró 1 corte en las últimas 24 hs, según SmartOLT. Posible caja cortada."
  );
  p.close();
});

test("ficha Call Center: respuesta de 'Obtener estado' como texto, sin historial o sin CSV", async () => {
  // Texto plano (no JSON) con historial vacío de cortes.
  let p = await openPopup({ profile: "callcenter", tabUrl: CLIENT_URL, pageHtml: FICHA, csvRows: HEALTHY, fetchHandler: smartOltFetch({ statusAsJson: false }) });
  await settle();
  assert.deepEqual(ccLines(p).slice(0, 2), ["📈 Fluctuación OP OLT en 24 hs: 0.10 dB", "✂️ Sin cortes en 24 hs"]);
  p.close();
  // OLT con otro formato (sin tabla History) y sin serie: no se inventa nada.
  p = await openPopup({
    profile: "callcenter",
    tabUrl: CLIENT_URL,
    pageHtml: FICHA,
    csvRows: null,
    fetchHandler: (url) => (url.includes("/api/onu/status/") ? { status: true, response: "ONU details\nRun state: online" } : url.includes("/signal/") ? { series: [] } : smartOltFetch()(url)),
  });
  await settle();
  assert.deepEqual(ccLines(p), [
    "📈 Sin datos suficientes de señal en 24 hs",
    "✂️ Cortes en 24 hs: no disponibles",
    "Sin CSV cargado: no se analiza al resto de la caja.",
  ]);
  p.close();
});

test("contexto: al salir de la ficha la sección y la observación se desactivan; al volver se rehacen", async () => {
  const p = await openPopup({ profile: "callcenter", tabUrl: CLIENT_URL, pageHtml: FICHA, csvRows: HEALTHY, fetchHandler: smartOltFetch() });
  await settle();
  assert.equal(p.visible(p.$("ccClientSection")), true);
  await p.navigate("https://informes.nosis.com/");
  assert.equal(p.visible(p.$("ccClientSection")), false);
  assert.equal(p.$("ccObservationBtn").disabled, true);
  assert.equal(p.$("boxDashboard").hidden, false);
  await p.navigate(CLIENT_URL, FICHA);
  await settle();
  assert.equal(p.visible(p.$("ccClientSection")), true);
  assert.equal(p.$("ccObservationBtn").disabled, false);
  assert.equal(p.calls.fetches.filter((f) => f.url.includes("/api/onu/status/")).length, 2); // una por apertura de ficha
  p.close();
});

test("vista caja Call Center sin CSV: estado sin CSV de siempre, informe deshabilitado", async () => {
  const p = await openPopup({ profile: "callcenter", tabUrl: CONFIGURED_URL, pageHtml: CONFIGURED_PAGE(["A6DB4"]), csvRows: null });
  assert.equal(p.$("boxDashboard").hidden, true);
  assert.equal(p.$("ccBoxReportBtn").disabled, true);
  p.close();
});
