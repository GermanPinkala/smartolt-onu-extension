"use strict";

/**
 * SmartOLT — Control — interfaz del perfil CALL CENTER (v4)
 *
 * Se carga solo con el perfil Call Center, después de popup.js, dashboard.js
 * y callcenter.js. No cambia nada de los dashboards base: se suma a ellos
 * como EXTENSIÓN (registerDashboardExtension de dashboard.js) y agrega sus
 * dos botones:
 *   - 📋 GENERAR OBSERVACIÓN (ficha de cliente): observación breve para la
 *     orden de trabajo, armada con TODOS los hallazgos (callcenter.js).
 *   - 📦 INFORME DE CAJAS: todos los clientes de cada caja del CSV.
 *
 * En la ficha de cliente, además de lo que ya muestra el dashboard base:
 *   - 📈 fluctuación de la señal en 24 hs: /signal/get_signal_graph_series_for_onu
 *     (la misma serie del gráfico "Señal" de la ficha; datos de la base de
 *     SmartOLT, no consulta la OLT);
 *   - ✂️ cortes en 24 hs: tabla "History" de "Obtener estado"
 *     (/api/onu/status/ID). ESTA SÍ consulta la OLT en vivo (~10 s): se hace
 *     UNA vez por apertura de la ficha (y al tocar ↻), igual que si el operador
 *     tocara "Obtener estado";
 *   - 🚨/🔴 afectación del resto de la caja, según el CSV cargado.
 * Las dos consultas corren dentro de la página (world MAIN, con la sesión y el
 * X-Token de SmartOLT). A la extensión solo vuelven la serie de señal y las
 * líneas de la tabla "History": nunca el token ni el resto de la salida de la
 * OLT (IPs, MACs, configuración).
 */

const ccClientSection = document.getElementById("ccClientSection");
const ccBoxReportBtn = document.getElementById("ccBoxReportBtn");
const ccObservationBtn = document.getElementById("ccObservationBtn");

const CC = self.SmartOLTCallCenter;
const CC_HISTORY_WINDOW_SEC = 24 * 60 * 60;
// Paso de 5 minutos: el mismo que usa el gráfico de señal de la ficha.
const CC_SIGNAL_STEP_SEC = 300;

// ---------- Consultas inyectadas en la ficha (world MAIN, autocontenidas) ----------

async function injectedFetchSignalSeries(onuId, fromSec, toSec, stepSec) {
  try {
    const url = `/signal/get_signal_graph_series_for_onu/${encodeURIComponent(onuId)}?from=${fromSec}&to=${toSec}&step=${stepSec}`;
    const res = await fetch(url, { credentials: "same-origin" });
    const data = await res.json().catch(() => null);
    const series = data && Array.isArray(data.series) ? data.series[0] : null;
    if (!series || !Array.isArray(series.points)) return { ok: false };
    return {
      ok: true,
      name: String(series.name || ""),
      points: series.points
        .filter((p) => Array.isArray(p))
        .map((p) => [Number(p[0]), typeof p[1] === "number" ? p[1] : null]),
    };
  } catch (e) {
    return { ok: false };
  }
}

async function injectedFetchStatusHistory(onuId) {
  try {
    const token = window.config && window.config.X_TOKEN;
    if (!token) return { ok: false, error: "no_token" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    const res = await fetch(`/api/onu/status/${encodeURIComponent(onuId)}`, {
      headers: { "X-Token": token, "X-Requested-With": "XMLHttpRequest" },
      credentials: "same-origin",
      signal: controller.signal,
    });
    clearTimeout(timer);
    const raw = await res.text();
    let body = raw;
    try {
      const data = JSON.parse(raw);
      if (data && data.status === false) return { ok: false, error: String(data.error_code || "error") };
      body = typeof data === "string" ? data : typeof data.response === "string" ? data.response : "";
    } catch (e) {
      // Respuesta de texto/HTML: se usa tal cual.
    }
    const text = body
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&");
    // Solo la tabla "History" (hasta la primera línea en blanco después de
    // sus filas): nada más de la salida de la OLT sale de la página.
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((l) => /^\s*History\s*$/i.test(l));
    if (start === -1) return { ok: true, history: null };
    const section = [lines[start]];
    let seenRow = false;
    for (let i = start + 1; i < lines.length && i < start + 40; i++) {
      if (!lines[i].trim()) {
        if (seenRow) break;
        continue;
      }
      if (/^\s*\d/.test(lines[i])) seenRow = true;
      section.push(lines[i]);
    }
    return { ok: true, history: section.join("\n") };
  } catch (e) {
    return { ok: false, error: "network" };
  }
}

// ---------- Estado del diagnóstico de la ficha actual ----------

// { runId, status, findings, ready } de la última ficha dibujada. "ready" se
// resuelve cuando terminaron las consultas de historial (la observación la
// espera para no perder ningún hallazgo).
let ccClient = null;

// tooltip: detalle bajo demanda (atributo title, el mismo mecanismo de
// tooltip que ya usa la extensión); la línea no cambia de tamaño.
function ccLine(text, kind, tooltip) {
  const p = document.createElement("p");
  p.className = `cc-line${kind ? ` cc-${kind}` : ""}${tooltip ? " cc-has-tooltip" : ""}`;
  p.textContent = text;
  if (tooltip) p.title = tooltip;
  return p;
}

function renderCcClientSection(state) {
  const { signal, cuts, findings, box, clientData } = state;
  ccClientSection.textContent = "";

  const shown = findings.filter((f) => f.dashboard);
  const signalShown = shown.some((f) => f.id.startsWith("signal_"));
  const cutsShown = shown.some((f) => f.id === "cuts" || f.id === "no_cuts");

  if (signal === undefined) ccClientSection.appendChild(ccLine("📈 Consultando historial de señal (24 hs)…", "info"));
  else if (!signalShown) ccClientSection.appendChild(ccLine("📈 Sin datos suficientes de señal en 24 hs", "info"));

  if (cuts === undefined) ccClientSection.appendChild(ccLine("✂️ Consultando cortes en la OLT…", "info"));
  else if (!cutsShown) ccClientSection.appendChild(ccLine("✂️ Cortes en 24 hs: no disponibles", "info"));

  shown.forEach((f) => ccClientSection.appendChild(ccLine(f.dashboard, f.kind === "problem" ? "problem" : "ok", f.tooltip)));

  let source;
  if (box && box.inCsv) {
    // Referencia temporal de los datos del resto de la caja (fecha real del CSV).
    const date = SmartOLTShared.formatShortDateTime(currentCapturedAt);
    source = date ? `CSV · ${date}` : null;
  } else if (!getCurrentRecords()) {
    source = "Sin CSV cargado: no se analiza al resto de la caja.";
  } else if (clientData.caja) {
    source = "La caja no está en el CSV cargado: no se analiza al resto de la caja.";
  }
  if (source) ccClientSection.appendChild(ccLine(source, "source"));
  ccClientSection.hidden = false;
}

function ccClientRendered({ runId, tab, onuId, page, clientData, live, evaluation, records }) {
  const status = (live && live.ok && live.status) || (page && page.statusText) || "";
  const box = CC.analyzeClientBox(records, clientData, status);
  const state = { runId, status, clientData, evaluation, box, signal: undefined, cuts: undefined, cutEvents: [], findings: [] };
  const update = () => {
    state.findings = CC.buildClientFindings({
      status,
      clientData,
      evaluation,
      signal: state.signal || null,
      cuts: state.cuts || null,
      cutEvents: state.cutEvents,
      box,
    });
    if (isCurrentDashboardRun(runId)) renderCcClientSection(state);
  };
  update();

  const toSec = Math.floor(Date.now() / 1000);
  const signalP = runInTab(
    tab.id,
    injectedFetchSignalSeries,
    [onuId, toSec - CC_HISTORY_WINDOW_SEC, toSec, CC_SIGNAL_STEP_SEC],
    "MAIN"
  ).then((result) => {
    state.signal = result && result.ok ? CC.summarizeSignalSeries(result) : null;
    update();
  });
  const cutsP = runInTab(tab.id, injectedFetchStatusHistory, [onuId], "MAIN").then((result) => {
    const entries = result && result.ok ? CC.parseStatusHistory(result.history) : null;
    const now = Date.now();
    state.cuts = entries ? CC.summarizeCuts(entries, now) : null;
    state.cutEvents = entries ? CC.cutEvents(entries, now) : [];
    update();
  });

  ccClient = { runId, state, ready: Promise.all([signalP, cutsP]).catch(() => {}) };
  setCcObservationEnabled(true);
}

// ---------- Botones ----------

function setCcObservationEnabled(enabled) {
  ccObservationBtn.disabled = !enabled;
  ccObservationBtn.classList.toggle("btn-primary", enabled);
  ccObservationBtn.classList.toggle("btn-client-disabled", !enabled);
}

function showCcFeedback(el, text, ms) {
  el.textContent = text;
  el.hidden = false;
  setTimeout(() => {
    el.hidden = true;
  }, ms);
}

async function handleCcObservation() {
  if (!ccClient || !isCurrentDashboardRun(ccClient.runId)) {
    showCcFeedback(clienteFeedback, "⚠️ Abrí la ficha del cliente en SmartOLT antes de usar este botón.", 3000);
    return;
  }
  const current = ccClient;
  clearGeneratedTextPreview();
  const label = ccObservationBtn.textContent;
  ccObservationBtn.disabled = true;
  ccObservationBtn.textContent = "⏳ Reuniendo datos…";
  try {
    await current.ready; // cortes e historial: ningún hallazgo se pierde
  } finally {
    ccObservationBtn.textContent = label;
    ccObservationBtn.disabled = false;
  }
  if (!isCurrentDashboardRun(current.runId)) return;
  const text = CC.buildObservation(current.state.findings, current.state.status);
  showGeneratedText(text);
  const copied = await copyTextToClipboard(text);
  showCcFeedback(clienteFeedback, copied ? "✓ Observación copiada" : "⚠️ No se pudo copiar automáticamente", 2500);
}

async function handleCcBoxReport() {
  clearGeneratedTextPreview();
  const records = getCurrentRecords();
  if (!records || records.length === 0) {
    showCcFeedback(copyFeedback, "⚠️ No hay ningún CSV capturado.", 2500);
    return;
  }
  const text = SmartOLTShared.prependCsvTimestamp(CC.buildCallCenterBoxReport(records), currentCapturedAt);
  showGeneratedText(text);
  const copied = await copyTextToClipboard(text);
  showCcFeedback(copyFeedback, copied ? "✓ Copiado" : "⚠️ No se pudo copiar automáticamente", 2000);
}

ccObservationBtn.addEventListener("click", handleCcObservation);
ccBoxReportBtn.addEventListener("click", handleCcBoxReport);

// ---------- Extensión de los dashboards ----------

registerDashboardExtension({
  clientRendered: ccClientRendered,
  boxFlags: (box) => (CC.isPossibleCajaCut(box.records) ? ["🔴 Posible caja cortada"] : []),
  // Se llama al empezar cada actualización: el diagnóstico de la ficha
  // anterior se descarta enseguida (clientRendered arma el nuevo).
  contextChanged() {
    const records = getCurrentRecords();
    ccBoxReportBtn.disabled = !(records && records.length > 0);
    ccBoxReportBtn.title = ccBoxReportBtn.disabled ? "Este botón necesita un CSV exportado desde SmartOLT." : "";
    ccClient = null;
    ccClientSection.hidden = true;
    ccClientSection.textContent = "";
    setCcObservationEnabled(false);
  },
});
