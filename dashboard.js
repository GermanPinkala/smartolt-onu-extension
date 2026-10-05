"use strict";

/**
 * SmartOLT — Control — dashboards de diagnóstico CCT (v4)
 *
 * Paneles de CONSULTA según el contexto de la pestaña:
 *   - Ficha de cliente (/onu/view/ID): estado, niveles ópticos contra el
 *     promedio de su caja, caja/puerto/OLT/board/PON y avisos internos (PON y
 *     PPPoE vs caja).
 *   - Cualquier otra página (estado por defecto, dentro o fuera de
 *     SmartOLT): las cajas del CSV, cada una desplegable
 *     con sus clientes a revisar agrupados en categorías desplegables.
 *
 * - popup.html lo carga DESPUÉS de popup.js, así que reutiliza directamente
 *   las piezas de popup.js (getActiveTab, injectedExtractClientData,
 *   readNapFromTab, getCurrentRecords) y de shared.js (evaluateClientOptics y las validaciones) — el cálculo del
 *   promedio, Check 1/2/3 y el ✅/❌/⚠️ es exactamente el mismo del informe.
 * - Nunca modifica el informe: "📋 GENERAR INFORME" sigue siendo
 *   handleObtenerCliente de popup.js, sin cambios.
 * - Bajo impacto sobre SmartOLT: lee el DOM que la propia página ya cargó y
 *   hace UNA consulta de estado (/api/onu/get_onu_status_and_signal/ID
 *   ?signal=db, que lee de la base de datos y no de la OLT) al abrir el popup,
 *   al cambiar de ficha o al tocar ↻. Sin polling automático.
 * - Esa consulta corre dentro de la propia página (world MAIN) para usar la
 *   sesión y el X-Token de SmartOLT: el token nunca sale de la página, no se
 *   guarda ni se muestra — a la extensión solo vuelve el estado.
 * - PPPoE: se lee únicamente el usuario (data-username). El mismo enlace de
 *   SmartOLT trae la contraseña: nunca se lee.
 */

const clientDashboard = document.getElementById("clientDashboard");
const cdStatus = document.getElementById("cdStatus");
const cdSince = document.getElementById("cdSince");
const cdRefreshBtn = document.getElementById("cdRefreshBtn");
const cdOnu = document.getElementById("cdOnu");
const cdOnuDelta = document.getElementById("cdOnuDelta");
const cdOlt = document.getElementById("cdOlt");
const cdOltDelta = document.getElementById("cdOltDelta");
const cdVerdict = document.getElementById("cdVerdict");
const cdVerdictLabel = document.getElementById("cdVerdictLabel");
const cdAverage = document.getElementById("cdAverage");
const cdCaja = document.getElementById("cdCaja");
const cdNetwork = document.getElementById("cdNetwork");
const cdAlerts = document.getElementById("cdAlerts");
const boxDashboard = document.getElementById("boxDashboard");

const ONU_VIEW_ID_RE = /\/onu\/view\/(\d+)/i;

// Con isCurrentDashboardRun(runId) un trabajo asíncrono sabe si su resultado
// sigue vigente (ver dashboardRunId más abajo).
function isCurrentDashboardRun(runId) {
  return runId === dashboardRunId;
}

// ---------- Lectores inyectados en la ficha (autocontenidos) ----------

// Datos estructurados de la ficha que no usa el informe. OLT/board/PON salen
// de los data-* del enlace "mover ONU" de SmartOLT (a.move-onu); el nombre de
// la OLT ("4 - OLT-A") es su texto. Del enlace a.update-mode se lee SOLO el
// atributo data-username: ese enlace también trae la contraseña PPPoE, así
// que nunca se lee su dataset completo.
function injectedReadDashboardPageData() {
  function norm(s) {
    return (s || "").replace(/\s+/g, " ").trim();
  }
  const move = document.querySelector('a.move-onu[data-show-olt="1"]') || document.querySelector("a.move-onu");
  const mode = document.querySelector("a.update-mode");
  const username = mode ? mode.getAttribute("data-username") : null;
  const statusEl = document.getElementById("onu_status_value");
  const statusRaw = statusEl ? norm(statusEl.textContent) : "";
  const signalEl = document.getElementById("signal_wrapper");
  const distanceMatch = norm(signalEl && signalEl.textContent).match(/\((\d+)\s*m\)/i);
  return {
    oltId: move ? move.getAttribute("data-olt-id") : null,
    oltName: move ? norm(move.textContent) : null,
    board: move ? move.getAttribute("data-board") : null,
    pon: move ? move.getAttribute("data-port") : null,
    username: username ? norm(username) : null,
    statusText: statusRaw.replace(/\([^)]*\)\s*$/, "").trim() || null,
    statusAgo: (statusRaw.match(/\(([^)]*)\)\s*$/) || [])[1] || null,
    distance: distanceMatch ? Number(distanceMatch[1]) : null,
  };
}

// Corre en el contexto de la página (world MAIN): la misma consulta que hace
// SmartOLT para refrescar "Estado", con su propia sesión y X-Token. Devuelve
// solo campos del estado — nunca el token.
async function injectedFetchOnuStatus(onuId) {
  try {
    const token = window.config && window.config.X_TOKEN;
    if (!token) return { ok: false, error: "no_token" };
    const res = await fetch(`/api/onu/get_onu_status_and_signal/${encodeURIComponent(onuId)}?signal=db`, {
      headers: { "X-Token": token, "X-Requested-With": "XMLHttpRequest" },
      credentials: "same-origin",
    });
    const data = await res.json().catch(() => null);
    if (!data) return { ok: false, error: "bad_response" };
    if (data.status !== true) {
      return { ok: false, error: String(data.error_code || "error"), message: String(data.error || "").slice(0, 120) };
    }
    const unix = Number(data.last_status_change_unix);
    const distance = Number(data.distance);
    return {
      ok: true,
      status: data.onu_status ? String(data.onu_status) : null,
      lastChangeUnix: Number.isFinite(unix) && unix > 0 ? unix : null,
      distance: Number.isFinite(distance) && distance > 0 ? distance : null,
    };
  } catch (e) {
    return { ok: false, error: "network" };
  }
}

async function runInTab(tabId, func, args, world) {
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func,
      args: args || [],
      world: world || "ISOLATED",
    });
    return result && result[0] ? result[0].result : null;
  } catch (e) {
    return null;
  }
}

// ---------- Formato ----------

const STATUS_BADGES = [
  { re: /^online$/i, icon: "🟢", label: "ONLINE" },
  { re: /^power\s*fail$/i, icon: "🔌", label: "POWER FAIL" },
  { re: /^los$/i, icon: "🔴", label: "LOS" },
  { re: /^offline$/i, icon: "⚫", label: "OFFLINE" },
];

function formatStatus(status) {
  const text = String(status || "").trim();
  if (!text) return "⚪ Estado desconocido";
  const known = STATUS_BADGES.find((item) => item.re.test(text));
  return known ? `${known.icon} ${known.label}` : `⚪ ${text.toUpperCase()}`;
}

function formatElapsed(ms) {
  if (!(ms >= 0)) return null;
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "hace instantes";
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `hace ${hours} h`;
  return `hace ${Math.floor(hours / 24)} días`;
}

function formatDbm(value) {
  return value !== null && value !== undefined ? `${value.toFixed(2)} dBm` : "N/D";
}

function stripOltNumber(oltName) {
  return String(oltName || "").replace(/^\s*\d+\s*-\s*/, "").trim();
}

// Rellena un <p> con segmentos de texto; los { strong } van resaltados. Todo
// por textContent: nada de la página se inserta como HTML.
function setLine(el, segments) {
  el.textContent = "";
  segments.filter(Boolean).forEach((segment) => {
    if (typeof segment === "string") {
      el.appendChild(document.createTextNode(segment));
    } else {
      const strong = document.createElement("strong");
      strong.textContent = segment.strong;
      el.appendChild(strong);
    }
  });
}

// Diferencia con el promedio de la caja y nivel visual, a partir de la misma
// clasificación que usa el feedback del informe (classifyOpFeedback).
function describeSide(clientValue, cajaAvg, approved, acceptedByCheck3) {
  const data = SmartOLTShared.getOpFeedbackData(clientValue, cajaAvg);
  if (!data) return { text: "", level: null };
  const signed = Math.round((clientValue - cajaAvg) * 100) / 100;
  const text = `${signed >= 0 ? "+" : "−"}${Math.abs(signed).toFixed(2)} vs prom.`;
  if (acceptedByCheck3) return { text, level: "near", title: "Aprobado por Check 3" };
  const F = SmartOLTShared.OP_FEEDBACK;
  const category = SmartOLTShared.classifyOpFeedback(approved, data);
  if (category === F.NEAR_LIMIT || category === F.WITHIN_TOLERANCE) return { text, level: "near" };
  if (category === F.OUT_VERY_CLOSE || category === F.OUT_OF_MARGIN || category === F.OUT_FAR) {
    return { text, level: "bad" };
  }
  return { text, level: approved === true ? "ok" : null };
}

function setDelta(el, side) {
  el.textContent = side.text;
  el.title = side.title || "";
  if (side.level) el.dataset.level = side.level;
  else delete el.dataset.level;
}

const VERDICTS = {
  "✅": "Aprobado",
  "❌": "Fuera de margen",
  "⚠️": "No evaluable",
};

function averageLine(evaluation, clientData, hasCsv) {
  const { cajaInfo, availableOpCount } = evaluation;
  if (evaluation.canCompare) {
    const onuAvg = cajaInfo.onuResult.avg !== null ? cajaInfo.onuResult.avg.toFixed(2) : "Sin datos";
    const oltAvg = cajaInfo.oltResult.avg !== null ? cajaInfo.oltResult.avg.toFixed(2) : "Sin datos";
    const suffix = availableOpCount >= 3 ? "" : availableOpCount === 2 ? " (solo 2 OP)" : " (no hay otro OP)";
    return ["Prom. caja: ", { strong: `ONU ${onuAvg}` }, " · ", { strong: `OLT ${oltAvg}` }, suffix];
  }
  if (!clientData.caja) return null;
  if (!hasCsv) return ["Sin promedio: no hay ningún CSV capturado."];
  if (!cajaInfo && evaluation.cajaRecords.length === 0) return ["Sin promedio: la caja no está en el CSV cargado."];
  return ["Sin promedio: la caja no tiene OP válidos en el CSV."];
}

// ---------- Render ----------

function renderDashboard({ page, clientData, live }) {
  // Estado: el de la consulta ?signal=db; si no respondió, el que muestra la ficha.
  if (live && live.ok === false && live.error === "olt_unreachable") {
    cdStatus.textContent = "⚠️ OLT inalcanzable";
  } else {
    cdStatus.textContent = formatStatus((live && live.ok && live.status) || (page && page.statusText));
  }
  if (live && live.ok && live.lastChangeUnix) {
    const ms = live.lastChangeUnix * 1000;
    const since = SmartOLTShared.formatShortDateTime(ms);
    const elapsed = formatElapsed(Date.now() - ms);
    cdSince.textContent = [since && `desde ${since}`, elapsed].filter(Boolean).join(" · ");
  } else {
    cdSince.textContent = page && page.statusAgo ? `(${page.statusAgo})` : "";
  }

  const records = getCurrentRecords();
  const hasCsv = !!(records && records.length > 0);
  const evaluation = SmartOLTShared.evaluateClientOptics(clientData, records);
  const avg = evaluation.canCompare ? evaluation.cajaInfo : null;

  cdOnu.textContent = formatDbm(clientData.sig1490);
  cdOlt.textContent = formatDbm(clientData.sig1310);
  setDelta(cdOnuDelta, avg ? describeSide(clientData.sig1490, avg.onuResult.avg, evaluation.onuOk, false) : { text: "" });
  setDelta(
    cdOltDelta,
    avg
      ? describeSide(
          clientData.sig1310,
          avg.oltResult.avg,
          evaluation.oltOk,
          evaluation.oltOk === false && evaluation.effectiveOltOk === true
        )
      : { text: "" }
  );
  cdVerdict.textContent = evaluation.badge || "—";
  setDelta(cdVerdictLabel, { text: evaluation.badge ? VERDICTS[evaluation.badge] : "Sin promedio" });

  const avgSegments = averageLine(evaluation, clientData, hasCsv);
  if (avgSegments) setLine(cdAverage, avgSegments);
  else cdAverage.textContent = "";

  const pppoe = page && page.username;
  if (clientData.caja) {
    setLine(cdCaja, [
      "📦 ",
      { strong: clientData.caja },
      clientData.puerto ? ` · Puerto ${clientData.puerto}` : " · ⚠️ sin puerto asignado",
      pppoe ? " · PPPoE " : null,
      pppoe ? { strong: pppoe } : null,
    ]);
  } else {
    setLine(cdCaja, ["📦 ⚠️ Sin caja asignada", pppoe ? " · PPPoE " : null, pppoe ? { strong: pppoe } : null]);
  }

  const distance = (live && live.ok && live.distance) || (page && page.distance);
  if (page && page.oltName) {
    setLine(cdNetwork, [
      "🗼 ",
      { strong: stripOltNumber(page.oltName) || page.oltName },
      page.board !== null ? ` · Board ${page.board}` : null,
      page.pon !== null ? ` · PON ${page.pon}` : null,
      distance ? ` · ${(distance / 1000).toFixed(2)} km` : null,
    ]);
  } else {
    cdNetwork.textContent = "";
  }

  const alerts = page
    ? [
        SmartOLTShared.validatePonVsCaja({
          oltId: page.oltId,
          oltName: page.oltName,
          board: page.board,
          pon: page.pon,
          caja: clientData.caja,
        }),
        SmartOLTShared.validatePppoeVsCaja({
          oltId: page.oltId,
          oltName: page.oltName,
          username: page.username,
          caja: clientData.caja,
          puertoNap: clientData.puerto,
        }),
      ].filter(Boolean)
    : [];
  cdAlerts.textContent = "";
  alerts.forEach((text) => {
    const p = document.createElement("p");
    p.className = "cd-alert";
    p.textContent = text;
    cdAlerts.appendChild(p);
  });
  cdAlerts.hidden = alerts.length === 0;
  return { evaluation, records };
}

// ---------- Dashboard de caja ----------
// Fuera de una ficha de cliente (estado por defecto, en
// cualquier página): TODAS las cajas del CSV capturado, cada una como un
// bloque desplegable (acordeón de cajas: como máximo UNA abierta). Cerrada,
// una caja muestra solo su nombre y sus contadores; abierta, las categorías de
// clientes a revisar que tengan al menos un caso, también en acordeón (como
// máximo UNA categoría abierta). Los clientes salen de
// SmartOLTShared.buildCajaDiagnosis: la MISMA fuente que usa ESTADO DE CAJA(S)
// para el informe. Todo sale del CSV capturado; no se consulta nada a SmartOLT.
//
// La caja que muestra la página (currentCajas, de getCurrentCajaContext) y las
// cajas del CSV (csvCajas) no se mezclan: el dashboard siempre muestra las del
// CSV y, si la de la página no está entre ellas, lo avisa arriba.

// Caja abierta (nombre normalizado) y categoría abierta ("caja|clave"), o
// null. Se conservan entre actualizaciones mientras sigan existiendo.
let openBox = null;
let openBoxCategory = null;
// Última caja única abierta automáticamente (ver refreshBoxDashboard).
let autoOpenedBox = null;

const BOX_CATEGORIES = [
  { key: "status", label: "🔴 LOS / Power Fail / Offline", clients: (d) => d.statusClients },
  { key: "op", label: "🟡 OP fuera de margen", clients: (d) => d.opClients },
];

function clientIcon(categoryKey, client) {
  return categoryKey === "op" ? "🟡" : SmartOLTShared.getStatusIcon(client.record.status);
}

function renderBoxCategories(container, d, rerender) {
  BOX_CATEGORIES.forEach((category) => {
    const clients = category.clients(d);
    if (clients.length === 0) return; // categoría vacía: no se muestra
    const key = `${d.key}|${category.key}`;
    const open = openBoxCategory === key;

    const header = document.createElement("button");
    header.type = "button";
    header.className = "bd-cat";
    header.dataset.category = key;
    header.setAttribute("aria-expanded", String(open));
    const label = document.createElement("span");
    label.className = "bd-cat-label";
    label.textContent = category.label;
    const count = document.createElement("span");
    count.className = "bd-count";
    count.textContent = String(clients.length);
    const chevron = document.createElement("span");
    chevron.className = "bd-chevron";
    chevron.textContent = open ? "▲" : "▼";
    header.append(label, count, chevron);
    header.addEventListener("click", () => {
      openBoxCategory = openBoxCategory === key ? null : key;
      rerender();
    });
    container.appendChild(header);

    const list = document.createElement("ul");
    list.className = "bd-list";
    list.hidden = !open;
    if (open) {
      clients.forEach((client) => {
        const item = document.createElement("li");
        item.className = "bd-client";
        const name = document.createElement("span");
        name.textContent = `${clientIcon(category.key, client)} ${client.name}`;
        const meta = document.createElement("span");
        meta.className = "bd-client-meta";
        meta.textContent = `${client.puerto ? `Puerto ${client.puerto}` : "Sin puerto"} · ${client.reason}`;
        item.append(name, meta);
        list.appendChild(item);
      });
    }
    container.appendChild(list);
  });
}

// diagnoses: [{ key (nombre normalizado), caja, ...diagnóstico }] de las cajas
// del CSV. missingCajas: cajas que muestra la página y no están en el CSV.
function renderBoxDashboard(diagnoses, missingCajas) {
  const rerender = () => renderBoxDashboard(diagnoses, missingCajas);
  if (!diagnoses.some((d) => d.key === openBox)) openBox = null;
  const validCategories = new Set();
  diagnoses.forEach((d) =>
    BOX_CATEGORIES.forEach((c) => {
      if (d.key === openBox && c.clients(d).length > 0) validCategories.add(`${d.key}|${c.key}`);
    })
  );
  if (!validCategories.has(openBoxCategory)) openBoxCategory = null;

  boxDashboard.textContent = "";

  if (missingCajas.length > 0) {
    const warning = document.createElement("div");
    warning.className = "bd-mismatch";
    const line1 = document.createElement("p");
    line1.className = "cd-alert";
    line1.textContent = `⚠️ La página muestra ${missingCajas.join(", ")}`;
    const line2 = document.createElement("p");
    line2.className = "cd-line";
    line2.textContent =
      missingCajas.length === 1
        ? "Esta caja no está en los datos cargados. Abajo, las cajas del CSV."
        : "Estas cajas no están en los datos cargados. Abajo, las cajas del CSV.";
    warning.append(line1, line2);
    boxDashboard.appendChild(warning);
  }

  // Área con altura máxima y scroll vertical (ver popup.css).
  const boxes = document.createElement("div");
  boxes.className = "bd-boxes";
  diagnoses.forEach((d) => {
    const open = openBox === d.key;
    const box = document.createElement("div");
    box.className = "bd-box";

    const header = document.createElement("button");
    header.type = "button";
    header.className = "bd-box-header";
    header.dataset.box = d.key;
    header.setAttribute("aria-expanded", String(open));
    const text = document.createElement("span");
    text.className = "bd-box-text";
    const title = document.createElement("span");
    title.className = "bd-title";
    title.textContent = `📦 ${d.caja}`;
    // Promedio de la caja junto al nombre (mismo cálculo que "Prom. caja").
    const average = document.createElement("span");
    average.className = "bd-avg";
    average.textContent = ` · ${d.average || "Sin promedio"}`;
    title.appendChild(average);
    const summary = document.createElement("span");
    summary.className = "cd-line";
    setLine(summary, [
      { strong: String(d.total) },
      d.total === 1 ? " ONU" : " ONUs",
      d.problemCount > 0 ? " · 🔴 " : null,
      d.problemCount > 0 ? { strong: String(d.problemCount) } : null,
      d.problemCount > 0 ? ` ${d.problemLabel}` : null,
      " · 🟢 ",
      { strong: String(d.online) },
      " Online",
    ]);
    text.append(title, summary);
    const chevron = document.createElement("span");
    chevron.className = "bd-chevron";
    chevron.textContent = open ? "▾" : "▸";
    header.append(text, chevron);
    header.addEventListener("click", () => {
      // Abrir otra caja cierra la anterior (y su categoría abierta).
      openBox = openBox === d.key ? null : d.key;
      openBoxCategory = null;
      rerender();
    });
    box.appendChild(header);

    if (open) {
      const body = document.createElement("div");
      body.className = "bd-box-body";
      renderBoxCategories(body, d, rerender);
      box.appendChild(body);
    }
    boxes.appendChild(box);
  });
  boxDashboard.appendChild(boxes);
}

async function refreshBoxDashboard(tab, runId) {
  const records = getCurrentRecords();
  if (!records || records.length === 0) return false;
  const csvCajas = SmartOLTShared.buildDataIdentity(records).cajaNames;
  const diagnoses = csvCajas
    .map((key) => {
      const d = SmartOLTShared.buildCajaDiagnosis(records, key);
      if (!d) return null;
      return Object.assign(
        {
          key,
          records: records.filter((r) => SmartOLTShared.normalizeCajaName(r.caja) === key),
          average: SmartOLTShared.formatCajaHeaderAverage(records, d.caja),
        },
        d
      );
    })
    .filter(Boolean);
  if (diagnoses.length === 0) return false;

  // La caja de la página solo se lee en /onu/configured de SmartOLT; en
  // cualquier otra página (otra de SmartOLT o una externa) no se busca nada en
  // la pestaña y no hay aviso de discrepancia.
  const onConfiguredPage = !!(tab && SmartOLTShared.isOnuConfiguredPageUrl(tab.url));
  const context = onConfiguredPage ? await getCurrentCajaContext(tab) : null;
  if (runId !== dashboardRunId) return false;
  const currentCajas = context && context.status === "identified" ? context.cajas : [];
  const missingCajas = currentCajas.filter((caja) => !csvCajas.includes(caja));
  // Con UNA sola caja en el CSV, se abre sola al cargar (una vez por caja: si
  // el operador la cierra, una actualización posterior no la vuelve a abrir).
  if (diagnoses.length === 1 && autoOpenedBox !== diagnoses[0].key) {
    autoOpenedBox = diagnoses[0].key;
    openBox = diagnoses[0].key;
  }
  renderBoxDashboard(diagnoses, missingCajas);
  return true;
}

// ---------- Ciclo de actualización ----------

// Contexto visible: "client" (ficha), "box" (caja seleccionada) o ninguno. En
// ficha y caja los contadores generales del CSV se ocultan (ver popup.css).
function setDashboardContext(context) {
  clientDashboard.hidden = context !== "client";
  boxDashboard.hidden = context !== "box";
  if (context) capturedBox.dataset.context = context;
  else delete capturedBox.dataset.context;
}

// Cada actualización tiene un número: si mientras tanto empezó otra (el
// operador cambió de ficha o tocó ↻), el resultado viejo se descarta.
let dashboardRunId = 0;

async function refreshDashboard() {
  const runId = ++dashboardRunId;
  const tab = await getActiveTab();
  const match = tab && SmartOLTShared.isClientPageUrl(tab.url) ? String(tab.url).match(ONU_VIEW_ID_RE) : null;
  if (!match) {
    // Fuera de una ficha de cliente, el dashboard de cajas es el estado por
    // defecto (cualquier página, dentro o fuera de SmartOLT),
    // siempre que haya un CSV con cajas.
    const showBox = await refreshBoxDashboard(tab, runId);
    if (runId === dashboardRunId) setDashboardContext(showBox ? "box" : null);
    return;
  }

  setDashboardContext("client");
  cdRefreshBtn.disabled = true;
  try {
    const [page, extracted, nap, live] = await Promise.all([
      runInTab(tab.id, injectedReadDashboardPageData),
      runInTab(tab.id, injectedExtractClientData),
      readNapFromTab(tab.id).catch(() => null),
      runInTab(tab.id, injectedFetchOnuStatus, [match[1]], "MAIN"),
    ]);
    if (runId !== dashboardRunId) return;

    if (!extracted && !page) {
      cdStatus.textContent = "⚠️ No se pudo leer la ficha";
      cdSince.textContent = "";
      return;
    }
    // Caja y puerto: misma regla que el informe (handleObtenerCliente).
    const clientData = Object.assign({ name: null, serial: null, oltName: null, sig1490: null, sig1310: null }, extracted);
    clientData.caja = (nap && nap.caja) || null;
    clientData.puerto = clientData.caja && nap ? nap.puerto : null;
    renderDashboard({ page, clientData, live });
  } finally {
    if (runId === dashboardRunId) cdRefreshBtn.disabled = false;
  }
}

let dashboardRefreshTimer = null;
function scheduleDashboardRefresh() {
  clearTimeout(dashboardRefreshTimer);
  dashboardRefreshTimer = setTimeout(refreshDashboard, 300);
}

cdRefreshBtn.addEventListener("click", refreshDashboard);

if (chrome.tabs && chrome.tabs.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url || changeInfo.status === "complete") scheduleDashboardRefresh();
  });
}
if (chrome.tabs && chrome.tabs.onActivated) {
  chrome.tabs.onActivated.addListener(scheduleDashboardRefresh);
}
// Un CSV nuevo cambia el promedio de la caja: se recalcula.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes[STORAGE_KEY]) scheduleDashboardRefresh();
});

// Primera actualización al abrir el popup (popup.js ya se cargó antes).
refreshDashboard();
