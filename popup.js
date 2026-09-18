"use strict";

/**
 * SmartOLT — Control de ONUs — popup
 *
 * Este popup es PASIVO: al abrirse solo lee el último estado guardado por el
 * service worker (background.js) en chrome.storage.session y lo muestra. NO
 * dispara ninguna consulta a SmartOLT por su cuenta.
 *
 * La única fuente de datos "oficial" es el CSV que la propia SmartOLT genera
 * cuando el usuario aprieta su botón "Exportar" — eso lo captura background.js
 * en segundo plano (incluso con el popup cerrado) y lo deja en
 * chrome.storage.session, que es memoria de la sesión de Chrome: nunca se
 * escribe a disco, y se pierde solo si se cierra Chrome del todo.
 *
 * Además se conservan dos funciones manuales, como respaldo secundario (no
 * protagonistas de la interfaz, colapsadas bajo "Opciones manuales"):
 *   - "Procesar otro CSV": elegir a mano un CSV histórico ya exportado antes.
 *     Es una vista puntual — no reemplaza el último CSV capturado automáticamente.
 *   - "Detectar último CSV descargado": mecanismo de recuperación si alguna
 *     vez la captura automática en segundo plano falla. Si encuentra un CSV
 *     válido, sí pasa a ser el estado "oficial" (se guarda en
 *     chrome.storage.session), porque su propósito es reemplazar a la
 *     captura automática cuando esta no funcionó.
 *
 * Ninguna de las dos funciones manuales llama a ningún endpoint de SmartOLT:
 * la primera lee un archivo local elegido por el usuario, la segunda lee
 * archivos ya descargados a disco (vía file://). Ninguna genera una
 * exportación nueva.
 */

// =========================================================================
// Tema visual de fecha especial (v3.0.7)
// =========================================================================
// Se aplica UNA sola vez, apenas arranca el popup, a partir de la fecha
// local del sistema (SmartOLTShared.getActiveTheme — sin tocar ningún
// servicio externo). Es puramente decorativo: agrega un atributo data-theme
// al <body> y son las reglas de popup.css (body[data-theme="..."]) las que
// cambian colores de fondo/paneles/bordes/acento — nunca toca estructura,
// tamaños, botones ni ninguna lógica. Fuera de toda fecha especial no se
// agrega ningún atributo, así que el body queda exactamente igual que antes
// (tema normal, sin cambios).
const activeTheme = SmartOLTShared.getActiveTheme(new Date());
if (activeTheme !== "normal") {
  document.body.setAttribute("data-theme", activeTheme);
}

const STORAGE_KEY = "smartoltState";
const MAX_AUTO_DETECT_CANDIDATES = 8;

// ---------- Referencias a elementos del DOM ----------
const screens = {
  home: document.getElementById("homeScreen"),
  error: document.getElementById("errorScreen"),
};

const subtitle = document.getElementById("subtitle");

const capturedBox = document.getElementById("capturedBox");
const overLimitBox = document.getElementById("overLimitBox");
const overLimitText = document.getElementById("overLimitText");
const captureFailedBox = document.getElementById("captureFailedBox");

const csvCapturedBadge = document.getElementById("csvCapturedBadge");
const compactStats = document.getElementById("compactStats");
const sumTotal = document.getElementById("sumTotal");
const sumOnline = document.getElementById("sumOnline");
const losPowerFailChip = document.getElementById("losPowerFailChip");
const cajaNamesEl = document.getElementById("cajaNames");
const consultarCajasBtn = document.getElementById("consultarCajasBtn");
const obtenerClienteBtn = document.getElementById("obtenerClienteBtn");
const downloadCsvBtn = document.getElementById("downloadCsvBtn");
const copyFeedback = document.getElementById("copyFeedback");
const clienteFeedback = document.getElementById("clienteFeedback");
const csvFeedback = document.getElementById("csvFeedback");

const manualLoadingMsg = document.getElementById("manualLoadingMsg");
const selectBtn = document.getElementById("selectBtn");
const fileInput = document.getElementById("fileInput");
const autoDetectBtn = document.getElementById("autoDetectBtn");
const hintMsg = document.getElementById("hintMsg");

const errorText = document.getElementById("errorText");
const errorDetails = document.getElementById("errorDetails");
const backToHomeBtn = document.getElementById("backToHomeBtn");

const teamSignature = document.getElementById("teamSignature");
const teamSignatureLine1 = document.getElementById("teamSignatureLine1");
const teamSignatureLine2 = document.getElementById("teamSignatureLine2");

// Estado local del popup: lo que se está mostrando ahora mismo (viene del CSV
// oficial en chrome.storage.session, o de una carga manual puntual). El texto
// para Telegram y el CSV crudo quedan en memoria del popup nada más mientras
// está abierto — cada vez que se cierra, se vuelve a leer de storage.session.
let currentTelegramText = "";
let currentCsvText = null;
let currentFileName = null;
// Timestamp (ms) del ARCHIVO CSV realmente procesado — nunca la hora actual
// del click de ningún botón. Se usa solo para la línea "📅 Datos del: ..." de
// ESTADO DE CAJA(S) (sección 4, v3.0.5). null si no hay ninguno disponible
// (en ese caso simplemente no se muestra esa línea — nunca se inventa una
// fecha con Date.now()).
let currentCapturedAt = null;

// =========================================================================
// Pantallas
// =========================================================================

// Subtítulo del encabezado ("SmartOLT — Control de ONUs" / subtitle): muestra
// la fecha/hora REAL del último CSV capturado — el MISMO timestamp que ya usa
// "📅 Datos del:" en ESTADO DE CAJA(S) (currentCapturedAt, ver más abajo),
// nunca la hora de apertura del popup ni la de una consulta, y nunca una
// segunda fuente de tiempo nueva. Si no hay ningún CSV capturado (sin CSV
// todavía, over_limit, capture_failed — currentCapturedAt queda en null en
// esos casos, ver renderNoCsv/renderOverLimit/renderCaptureFailed), se
// mantiene el texto genérico anterior tal cual.
function updateSubtitle(screenName) {
  if (screenName === "error") {
    subtitle.textContent = "Hubo un problema con el archivo";
    return;
  }
  const label = currentCapturedAt ? SmartOLTShared.formatShortDateTime(currentCapturedAt) : null;
  subtitle.textContent = label ? `Último CSV capturado: ${label}` : "Estado del último CSV capturado";
}

function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) => {
    el.hidden = key !== name;
  });
  updateSubtitle(name);
}

function hideAllHomeBoxes() {
  capturedBox.hidden = true;
  overLimitBox.hidden = true;
  captureFailedBox.hidden = true;
}

// Estado: todavía no hay ningún CSV capturado (v3.0.8). A diferencia de
// versiones anteriores, esto YA NO bloquea la pantalla con un mensaje de
// "esperá a exportar un CSV": se muestra el mismo bloque de botones que el
// estado "captured" (capturedBox), pero con las partes que dependen del CSV
// ocultas/deshabilitadas:
//   - Se ocultan el badge "✓ CSV capturado" y las estadísticas compactas
//     (ONUs/Online/LOS/Power fail) y el listado de cajas: no hay ningún dato
//     de CSV que mostrar, y no se inventa ninguno.
//   - "🔎 ESTADO DE CAJAS" y "📥 Descargar último CSV" quedan deshabilitados
//     porque ambos necesitan el CSV.
//   - "👤 OBTENER DATOS DEL CLIENTE" NO se toca acá: sigue habilitado o no
//     según refreshClienteBtnState(), que depende únicamente de si la pestaña
//     activa es una ficha de cliente de SmartOLT — nunca de si hay CSV.
function renderNoCsv() {
  hideAllHomeBoxes();

  csvCapturedBadge.hidden = true;
  compactStats.hidden = true;
  losPowerFailChip.hidden = true;
  sumTotal.textContent = "0";
  sumOnline.textContent = "0";
  cajaNamesEl.textContent = "";

  consultarCajasBtn.textContent = formatEstadoCajasLabel(0);
  consultarCajasBtn.disabled = true;
  consultarCajasBtn.title = "Este botón necesita un CSV exportado desde SmartOLT.";

  downloadCsvBtn.disabled = true;

  // Todavía no hay ningún CSV capturado -> el subtítulo debe volver al texto
  // genérico, nunca arrastrar la fecha de una captura previa (relevante si
  // llega un cambio de estado en vivo vía chrome.storage.onChanged), y no hay
  // ningún dato de CSV vigente en memoria.
  currentTelegramText = "";
  currentCsvText = null;
  currentFileName = null;
  currentCapturedAt = null;

  copyFeedback.hidden = true;
  clienteFeedback.hidden = true;
  csvFeedback.hidden = true;

  capturedBox.hidden = false;
  showScreen("home");
}

function renderOverLimit(count, fileName) {
  hideAllHomeBoxes();
  overLimitText.textContent = SmartOLTShared.formatOverLimitMessage(count, fileName);
  overLimitBox.hidden = false;
  // Este CSV superó el límite y no quedó como "capturado" -> mismo motivo que
  // renderNoCsv: el subtítulo no debe mostrar una fecha de una captura
  // anterior que ya no es la vigente.
  currentCapturedAt = null;
  showScreen("home");
}

function renderCaptureFailed() {
  hideAllHomeBoxes();
  captureFailedBox.hidden = false;
  // Falló el procesamiento del CSV -> no quedó ningún CSV "capturado" vigente,
  // mismo motivo que renderNoCsv/renderOverLimit.
  currentCapturedAt = null;
  showScreen("home");
}

// "A47B1 · B46A4 · C35A2 · D47F1" + " ...+1" si hay más de 4. Las cajas ya
// llegan ordenadas de menor a mayor (naturalCompare, calculado en shared.js).
function formatCajaNamesPreview(cajaNames) {
  const MAX_SHOWN = 4;
  const shown = cajaNames.slice(0, MAX_SHOWN).join(" · ");
  const remaining = cajaNames.length - MAX_SHOWN;
  if (remaining <= 0) return shown;
  return `${shown} ...+${remaining}`;
}

// Indicador único de estado problemático del mini-dashboard. losCount y
// powerFailCount ya vienen de shared.js (buildAnalysisResult) como el
// conteo COMBINADO final de su rama (misma clasificación que ESTADO DE
// CAJA(S) — LOS tiene prioridad absoluta, Offline/Disabled nunca aparecen
// como categoría propia, siempre están sumados dentro de una de las dos):
//  - losCount > 0        -> 🔴 N LOS/Power Fail (incluye Power fail y
//                           Offline/Disabled si los hay)
//  - solo powerFailCount -> ⚫ N Power fail (incluye Offline/Disabled si los hay)
//  - ninguno             -> null (no se muestra el indicador)
function formatLosPowerFailChip(losCount, powerFailCount) {
  const los = losCount || 0;
  const pf = powerFailCount || 0;
  if (los > 0) return `🔴 ${los} LOS/Power Fail`;
  if (pf > 0) return `⚫ ${pf} Power fail`;
  return null;
}

// Texto del botón según la cantidad de cajas detectadas: singular con
// exactamente 1 caja, plural con 2 o más. Solo cambia el texto — el id y el
// comportamiento del botón (su listener) son siempre los mismos.
function formatEstadoCajasLabel(cajaCount) {
  return cajaCount === 1 ? "🔎 ESTADO DE CAJA" : "🔎 ESTADO DE CAJAS";
}

// data: { total, onlineCount, cajaCount, cajaNames, losCount, powerFailCount,
//         telegramText, csvText, fileName }
function renderCaptured(data) {
  hideAllHomeBoxes();

  csvCapturedBadge.hidden = false;
  compactStats.hidden = false;

  sumTotal.textContent = String(data.total);
  sumOnline.textContent = String(data.onlineCount || 0);
  cajaNamesEl.textContent = formatCajaNamesPreview(data.cajaNames || []);
  const cajaCount = data.cajaCount !== undefined ? data.cajaCount : (data.cajaNames || []).length;
  consultarCajasBtn.textContent = formatEstadoCajasLabel(cajaCount);
  consultarCajasBtn.disabled = false;
  consultarCajasBtn.title = "";

  downloadCsvBtn.disabled = false;

  const chipText = formatLosPowerFailChip(data.losCount, data.powerFailCount);
  if (chipText) {
    losPowerFailChip.textContent = chipText;
    losPowerFailChip.hidden = false;
  } else {
    losPowerFailChip.hidden = true;
  }

  currentTelegramText = data.telegramText || "";
  currentCsvText = data.csvText || null;
  currentFileName = data.fileName || null;
  currentCapturedAt = data.capturedAt || null;

  copyFeedback.hidden = true;
  clienteFeedback.hidden = true;
  csvFeedback.hidden = true;

  capturedBox.hidden = false;
  showScreen("home");
}

function applyStoredState(state) {
  if (!state || !state.status) {
    renderNoCsv();
    return;
  }
  switch (state.status) {
    case "captured":
      renderCaptured(state);
      break;
    case "over_limit":
      renderOverLimit(state.count, state.fileName);
      break;
    case "capture_failed":
      renderCaptureFailed();
      break;
    default:
      renderNoCsv();
  }
}

async function loadStateFromStorage() {
  try {
    const stored = await chrome.storage.session.get(STORAGE_KEY);
    applyStoredState(stored && stored[STORAGE_KEY]);
  } catch (e) {
    // Si por lo que sea no se puede leer storage.session, no se inventa nada:
    // se muestra el estado sin CSV, sin procesar ni consultar nada.
    renderNoCsv();
  }
}

// Si mientras el popup está abierto llega una captura nueva en segundo plano
// (el usuario exportó justo ahora), se refleja sola — no hace falta cerrar y
// volver a abrir. Esto no dispara ningún procesamiento: solo redibuja lo que
// background.js ya calculó y guardó.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session" || !changes[STORAGE_KEY]) return;
  applyStoredState(changes[STORAGE_KEY].newValue);
});

// =========================================================================
// Errores al procesar un CSV cargado manualmente (selección o auto-detección
// entre descargas) — la captura automática en background nunca pasa por acá.
// =========================================================================

function showError(message, details) {
  errorText.textContent = message;
  errorDetails.innerHTML = "";
  if (details && details.length) {
    details.forEach((d) => {
      const li = document.createElement("li");
      li.textContent = d;
      errorDetails.appendChild(li);
    });
    errorDetails.hidden = false;
  } else {
    errorDetails.hidden = true;
  }
  showScreen("error");
}

function errorMessageForCode(result, fileName) {
  switch (result.code) {
    case "OVER_LIMIT":
      return {
        message: SmartOLTShared.formatOverLimitMessage(result.count, fileName),
        details: [],
      };
    case "MISSING_COLUMNS":
      return {
        message: "⚠️ Faltan columnas necesarias en el archivo:",
        details: result.missing.map((m) => `"${m}"`),
      };
    case "NOT_SMARTOLT":
      return {
        message: "⚠️ No se pudo identificar la estructura del archivo de SmartOLT.",
        details: [
          "Ninguna de las columnas esperadas (Name, ODB (Splitter), ODB Port, Status, Last status change, Signal 1310, Signal 1490) fue encontrada.",
        ],
      };
    case "EMPTY":
    case "NO_ROWS":
      return {
        message: "⚠️ No se pudo identificar la estructura del archivo de SmartOLT.",
        details: ["El archivo está vacío o no contiene filas de datos."],
      };
    default:
      return {
        message: "⚠️ No se pudo identificar la estructura del archivo de SmartOLT.",
        details: [],
      };
  }
}

// =========================================================================
// "Procesar otro CSV" — carga manual puntual, no reemplaza el CSV oficial
// =========================================================================

function handleFile(file) {
  if (!file) return;

  manualLoadingMsg.textContent = "Procesando archivo…";
  manualLoadingMsg.hidden = false;

  const reader = new FileReader();
  reader.onload = (e) => {
    manualLoadingMsg.hidden = true;
    const text = String(e.target.result);
    try {
      const result = SmartOLTShared.analyzeCSV(text);
      if (!result.ok) {
        const { message, details } = errorMessageForCode(result, file.name);
        showError(message, details);
        return;
      }
      // Vista puntual: se muestra pero NO se guarda como estado oficial en
      // chrome.storage.session (ese lugar es del CSV capturado automáticamente).
      // capturedAt usa file.lastModified (la fecha real del ARCHIVO elegido),
      // nunca Date.now() — este flujo puede procesar un CSV descargado hace
      // rato, no en este instante.
      renderCaptured({
        total: result.total,
        onlineCount: result.onlineCount,
        cajaCount: result.cajaCount,
        cajaNames: result.cajaNames,
        losCount: result.losCount,
        powerFailCount: result.powerFailCount,
        telegramText: result.telegramText,
        csvText: text,
        fileName: file.name,
        capturedAt: file.lastModified || null,
      });
    } catch (err) {
      showError("⚠️ No se pudo identificar la estructura del archivo de SmartOLT.", [
        "Ocurrió un error inesperado al leer el archivo.",
      ]);
    }
  };
  reader.onerror = () => {
    manualLoadingMsg.hidden = true;
    showError("⚠️ No se pudo leer el archivo seleccionado.");
  };
  reader.readAsText(file, "UTF-8");
}

// =========================================================================
// "Detectar último CSV descargado" — respaldo de recuperación. Si encuentra
// un CSV válido, SÍ pasa a ser el estado oficial (reemplaza al de background,
// tal como lo haría una nueva captura automática), porque su propósito es
// sustituir a la captura automática cuando esta falló.
// =========================================================================

function pathToFileURL(rawPath) {
  let p = rawPath.replace(/\\/g, "/");
  if (!p.startsWith("/")) p = "/" + p; // "C:/Users/..." -> "/C:/Users/..."
  const parts = p.split("/");
  const encoded = parts
    .map((seg, idx) => {
      if (idx === 1 && /^[A-Za-z]:$/.test(seg)) return seg; // no codificar "C:"
      return encodeURIComponent(seg);
    })
    .join("/");
  return "file://" + encoded;
}

async function saveOfficialState(state) {
  try {
    await chrome.storage.session.set({ [STORAGE_KEY]: state });
  } catch (e) {
    // best-effort, igual que en background.js
  }
}

async function runAutoDetectFlow() {
  hintMsg.hidden = true;
  manualLoadingMsg.textContent = "🔎 Buscando el último CSV descargado…";
  manualLoadingMsg.hidden = false;

  if (!(typeof chrome !== "undefined" && chrome.downloads && chrome.downloads.search)) {
    manualLoadingMsg.hidden = true;
    hintMsg.textContent = "Esta función no está disponible en este navegador.";
    hintMsg.hidden = false;
    return;
  }

  let items;
  try {
    items = await chrome.downloads.search({ orderBy: ["-startTime"], limit: 30, exists: true });
  } catch (e) {
    items = [];
  }

  const csvItems = (items || []).filter(
    (it) => it.filename && it.filename.toLowerCase().endsWith(".csv") && it.state === "complete"
  );

  let found = false;
  let anyReadAttempted = false;

  for (const item of csvItems.slice(0, MAX_AUTO_DETECT_CANDIDATES)) {
    let text = null;
    try {
      const fileUrl = pathToFileURL(item.filename);
      const resp = await fetch(fileUrl);
      if (!resp.ok) {
        anyReadAttempted = true;
        continue;
      }
      text = await resp.text();
      anyReadAttempted = true;
    } catch (e) {
      anyReadAttempted = true;
      continue;
    }

    const result = SmartOLTShared.analyzeCSV(text);
    if (result.ok) {
      const fileName = item.filename.split(/[\\/]/).pop();
      // capturedAt usa item.startTime (cuándo se descargó REALMENTE ese CSV
      // según Chrome), nunca Date.now(): esta función busca entre descargas
      // YA existentes, que pueden ser de hace rato — no de este instante.
      const itemStartTime = item.startTime ? new Date(item.startTime).getTime() : null;
      const officialState = {
        status: "captured",
        csvText: text,
        fileName,
        total: result.total,
        onlineCount: result.onlineCount,
        cajaCount: result.cajaCount,
        cajaNames: result.cajaNames,
        losCount: result.losCount,
        powerFailCount: result.powerFailCount,
        telegramText: result.telegramText,
        capturedAt: itemStartTime,
      };
      await saveOfficialState(officialState);
      renderCaptured(officialState);
      found = true;
      break;
    }
  }

  manualLoadingMsg.hidden = true;

  if (!found) {
    if (csvItems.length === 0) {
      hintMsg.textContent = "No se encontró ningún CSV entre las descargas recientes.";
    } else if (anyReadAttempted) {
      hintMsg.textContent =
        '💡 No se pudo leer ningún CSV válido de SmartOLT. Si el problema persiste, activá "Permitir acceso a las URLs de archivos" en chrome://extensions → Detalles de esta extensión.';
    } else {
      hintMsg.textContent = "No se encontró un CSV de SmartOLT válido entre las descargas recientes.";
    }
    hintMsg.hidden = false;
  }
}

// =========================================================================
// Cierre automático del popup al perder el foco (v3.0.4, corregido en v3.0.5)
// =========================================================================
// Chrome ya cierra el popup de la extensión al hacer click fuera de él en la
// gran mayoría de los casos, pero en algunos entornos/versiones eso no
// ocurre de forma confiable y el popup queda abierto hasta volver a tocar el
// ícono. El mecanismo estándar para forzar ese comportamiento es escuchar el
// evento "blur" de window (se dispara cuando el popup deja de tener foco:
// click en la página de SmartOLT, en otra pestaña o en otra ventana) y
// cerrar el popup con window.close().
//
// OJO 1: NO se puede cerrar ciegamente en cada "blur". El botón "📄 Procesar
// otro CSV" abre el selector de archivos NATIVO del sistema operativo
// (fileInput.click()), y abrir ese diálogo también le quita el foco a la
// ventana del popup — un "blur" ciego cerraría el popup ANTES de que el
// usuario llegue a elegir el archivo, rompiendo esa función por completo.
// Por eso se usa una bandera: se suspende el auto-cierre justo antes de
// abrir el selector de archivos, y se reactiva en cuanto el popup vuelve a
// tener foco (al cerrarse el diálogo nativo, con o sin archivo elegido).
//
// OJO 2 (corrección v3.0.5): un click DENTRO del popup sobre una zona SIN
// foco propio (texto, chip, footer, espacio vacío — cualquier elemento que
// no sea un botón/input/link) puede disparar un "blur" de window igual de
// espurio/transitorio, aunque el usuario nunca haya salido del popup. Por
// eso el cierre NO es inmediato: se espera un instante (setTimeout 0) y
// recién ahí se confirma con document.hasFocus() si el popup realmente
// perdió el foco hacia afuera. Si el click fue interno, el popup sigue
// siendo la ventana activa y document.hasFocus() vuelve a ser true casi al
// instante — en ese caso NO se cierra. Si el click fue realmente afuera
// (otra pestaña, la página de SmartOLT, otra ventana), document.hasFocus()
// sigue en false y el popup se cierra como corresponde.
let suppressAutoCloseOnBlur = false;

window.addEventListener("blur", () => {
  if (suppressAutoCloseOnBlur) return;
  setTimeout(() => {
    if (suppressAutoCloseOnBlur) return;
    if (!document.hasFocus()) {
      window.close();
    }
  }, 0);
});

window.addEventListener("focus", () => {
  suppressAutoCloseOnBlur = false;
});

// =========================================================================
// Eventos
// =========================================================================

selectBtn.addEventListener("click", () => {
  suppressAutoCloseOnBlur = true;
  fileInput.click();
});

fileInput.addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  handleFile(file);
  fileInput.value = "";
});

autoDetectBtn.addEventListener("click", runAutoDetectFlow);

backToHomeBtn.addEventListener("click", () => {
  loadStateFromStorage();
});

// ---------- Copiar al portapapeles (con respaldo textarea+execCommand si la
// API moderna no está disponible/falla). Reutilizada por CONSULTAR CAJAS y
// OBTENER DATOS DEL CLIENTE — no hay dos copias de esta lógica. ----------
async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (err2) {
      ok = false;
    }
    document.body.removeChild(textarea);
    return ok;
  }
}

// Vuelve a parsear el CSV ya capturado (currentCsvText) para obtener los
// records completos. Es una re-lectura 100% local del texto que YA está en
// memoria — no repite ninguna consulta a SmartOLT ni descarga nada de nuevo.
// Antes de devolverlos, consolida por serial (SN): si SmartOLT exportó más de
// una fila para la misma ONU física (p. ej. un registro completo y otro
// incompleto/sin estado), acá se fusionan en un único registro por ONU — así
// tanto "ESTADO DE CAJA/S" como "OBTENER DATOS DEL CLIENTE" (los dos únicos
// consumidores de esta función) trabajan siempre sobre ONUs únicas, nunca
// sobre filas duplicadas del CSV.
function getCurrentRecords() {
  if (!currentCsvText) return null;
  const parsed = SmartOLTShared.parseRecordsFromCSV(currentCsvText);
  return parsed.ok ? SmartOLTShared.consolidateRecordsBySerial(parsed.records) : null;
}

// ---------- ESTADO DE CAJA/S: arma (y copia) el reporte COMPLETO de TODAS las
// cajas del CSV ya capturado — promedio, puertos ocupados, Online, estado
// problemático (LOS/Power fail) con su detalle, y advertencias de registros
// sin estado — sin volver a exportar ni consultar nada en SmartOLT. Reutiliza
// buildTelegramText de shared.js (mismo cálculo de promedio/orden natural que
// ya usa el resto de la extensión); el texto del botón (singular/plural) se
// actualiza en renderCaptured según la cantidad de cajas detectadas. ----------
consultarCajasBtn.addEventListener("click", async () => {
  const records = getCurrentRecords();
  if (!records) {
    copyFeedback.textContent = "⚠️ No hay ningún CSV capturado.";
    copyFeedback.hidden = false;
    setTimeout(() => {
      copyFeedback.hidden = true;
      copyFeedback.textContent = "✓ Copiado";
    }, 2500);
    return;
  }

  // La fecha/hora es la del ARCHIVO CSV procesado (currentCapturedAt), nunca
  // la hora actual de este click — se antepone una sola vez, no dentro de
  // cada caja (ver prependCsvTimestamp en shared.js).
  const reportText = SmartOLTShared.prependCsvTimestamp(SmartOLTShared.buildTelegramText(records), currentCapturedAt);
  const copied = await copyTextToClipboard(reportText);
  copyFeedback.textContent = copied ? "✓ Copiado" : "⚠️ No se pudo copiar automáticamente";
  copyFeedback.hidden = false;
  setTimeout(() => {
    copyFeedback.hidden = true;
    copyFeedback.textContent = "✓ Copiado";
  }, 2000);
});

// ---------- OBTENER DATOS DEL CLIENTE ----------
// Función autocontenida: se serializa e inyecta en la pestaña activa de
// SmartOLT vía chrome.scripting.executeScript, así que NO puede referenciar
// nada del scope externo de popup.js — todo lo que necesita se define acá
// adentro. Solo LEE el DOM ya renderizado por la propia SmartOLT (no hace
// fetch, no llama ninguna API, no hace click en nada).
//
// Nombre, caja/NAP, puerto y serial se siguen buscando por el TEXTO de las
// etiquetas (best-effort, sin depender de clases/IDs específicos, ya que no
// hay una muestra completa del HTML real de la ficha). La potencia óptica del
// cliente, en cambio, SÍ tiene un selector real confirmado: #signal_wrapper,
// con el formato "-21.42 dBm / -25.09 dBm" (izquierda = ONU, derecha = OLT).
// Como ese elemento se actualiza dinámicamente, se reintenta brevemente antes
// de darse por vencido (sin dejar ningún observer permanente).
function injectedExtractClientData() {
  function norm(s) {
    return (s || "").replace(/\s+/g, " ").trim();
  }

  function textOf(el) {
    return norm(el && el.textContent);
  }

  // Dado un elemento ya identificado como "la etiqueta", busca su valor
  // asociado probando, en orden, los patrones de layout más comunes en
  // SmartOLT (fila de tabla, lista de definición, "Etiqueta: Valor" inline,
  // hermano siguiente, contenedor de dos hijos). Reutilizada tanto por la
  // búsqueda genérica por lista de etiquetas como por la búsqueda específica
  // de "NAP (Divisor)" (que necesita su propio matcher por regex, ver abajo).
  function valueNearLabelElement(el, lower) {
    // Fila de tabla: <tr><th>Label</th><td>Valor</td></tr>
    const tr = el.closest("tr");
    if (tr && (el.tagName === "TH" || el.tagName === "TD")) {
      const cells = Array.from(tr.children);
      const idx = cells.indexOf(el);
      for (let i = idx + 1; i < cells.length; i++) {
        const v = textOf(cells[i]);
        if (v) return v;
      }
    }

    // Lista de definición: <dt>Label</dt><dd>Valor</dd>
    if (el.tagName === "DT") {
      let sib = el.nextElementSibling;
      while (sib && sib.tagName !== "DD") sib = sib.nextElementSibling;
      if (sib) {
        const v = textOf(sib);
        if (v) return v;
      }
    }

    // El propio nodo trae "Etiqueta: Valor" en el mismo texto.
    const raw = textOf(el);
    const inlineMatch = raw.match(/:\s*(.+)$/);
    if (inlineMatch && inlineMatch[1] && inlineMatch[1].trim()) {
      return norm(inlineMatch[1]);
    }

    // Siguiente hermano del mismo nivel.
    const sibling = el.nextElementSibling;
    if (sibling) {
      const v = textOf(sibling);
      if (v && v.toLowerCase() !== lower) return v;
    }

    // Contenedor con exactamente dos hijos: etiqueta + valor.
    const parent = el.parentElement;
    if (parent && parent.children.length === 2) {
      const other = Array.from(parent.children).find((c) => c !== el);
      if (other) {
        const v = textOf(other);
        if (v && v.toLowerCase() !== lower) return v;
      }
    }
    return null;
  }

  // Recorre el DOM buscando un elemento "etiqueta" (celda de tabla, <dt>,
  // <label>, etc. — nunca un contenedor grande) cuyo texto (normalizado, sin
  // ":" final) haga match con matchFn, y devuelve el valor asociado según
  // valueNearLabelElement. No depende de ninguna posición fija del DOM: recorre
  // TODO el documento y se queda con la primera coincidencia real.
  function findValueByMatch(matchFn) {
    const all = Array.from(document.querySelectorAll("th,td,dt,label,span,div,strong,b,p"));
    for (const el of all) {
      if (el.children && el.children.length > 2) continue; // saltar contenedores grandes
      const raw = textOf(el);
      if (!raw) continue;
      const withoutColon = raw.replace(/:\s*$/, "");
      const lower = withoutColon.toLowerCase();
      if (!matchFn(lower)) continue;
      const v = valueNearLabelElement(el, lower);
      if (v) return v;
    }
    return null;
  }

  function findValueByLabels(labels) {
    const normalizedLabels = labels.map((l) => l.toLowerCase());
    return findValueByMatch((lower) => normalizedLabels.some((l) => lower === l || lower === l + ":"));
  }

  // Etiqueta "NAP (Divisor)" específicamente (ej. "NAP (Divisor): D1FA1 (Port 6)").
  // Se usa un regex tolerante a espacios extra alrededor de los paréntesis
  // ("NAP(Divisor)", "NAP ( Divisor )", etc.) en lugar de una lista de strings
  // exactos, para no depender de un formato de espaciado específico.
  const NAP_DIVISOR_LABEL_RE = /^nap\s*\(\s*divisor\s*\)$/i;
  function findNapDivisorValue() {
    return findValueByMatch((lower) => NAP_DIVISOR_LABEL_RE.test(lower));
  }

  function findNumber(value) {
    if (!value) return null;
    const m = String(value).match(/-?\d+(?:[.,]\d+)?/);
    if (!m) return null;
    const n = Number(m[0].replace(",", "."));
    return Number.isNaN(n) ? null : n;
  }

  function findClientName() {
    const byLabel = findValueByLabels(["Cliente", "Nombre", "Name", "Customer"]);
    if (byLabel) return byLabel;
    const h1 = document.querySelector("h1, h2");
    return h1 ? textOf(h1) || null : null;
  }

  // "#signal_wrapper" -> "-21.42 dBm / -25.09 dBm": primer número = ONU
  // (Rx ONU / Signal 1490), segundo número = OLT (Rx OLT / Signal 1310).
  function parseSignalWrapperText(raw) {
    if (!raw) return null;
    const nums = String(raw).match(/-?\d+(?:[.,]\d+)?/g);
    if (!nums || nums.length < 2) return null;
    const onu = Number(nums[0].replace(",", "."));
    const olt = Number(nums[1].replace(",", "."));
    if (Number.isNaN(onu) || Number.isNaN(olt)) return null;
    return { onu, olt };
  }

  // El valor de #signal_wrapper puede tardar en cargarse dinámicamente: se
  // reintenta cada 200ms hasta 2 segundos (10 intentos) — breve a propósito,
  // sin dejar ningún MutationObserver corriendo de forma permanente.
  function waitForSignalWrapper(maxAttempts, intervalMs) {
    return new Promise((resolve) => {
      let attempts = 0;
      function tryRead() {
        attempts++;
        const el = document.querySelector("#signal_wrapper");
        const parsed = el ? parseSignalWrapperText(textOf(el)) : null;
        if (parsed || attempts >= maxAttempts) {
          resolve(parsed);
          return;
        }
        setTimeout(tryRead, intervalMs);
      }
      tryRead();
    });
  }

  const name = findClientName();
  // IMPORTANTE: el puerto de la caja/NAP NUNCA debe salir del campo general
  // "Puerto" de la ficha (ese es otro dato — el puerto físico de la ONU en la
  // placa, no el puerto de la caja/NAP). La única fuente válida es el propio
  // texto de la etiqueta "NAP (Divisor)" (ej. "D1FA1 (Port 6)"), que trae caja
  // y puerto juntos — se separan más abajo, fuera de esta función inyectada,
  // con SmartOLTShared.parseCajaPortLabel. Por eso acá NO se busca ningún
  // campo "Puerto" por separado.
  const caja = findNapDivisorValue();
  const serial = findValueByLabels(["SN", "Serial", "Serial Number", "S/N"]);

  return waitForSignalWrapper(10, 200).then((signal) => {
    let sig1490 = null;
    let sig1310 = null;
    if (signal) {
      sig1490 = signal.onu;
      sig1310 = signal.olt;
    } else {
      // Respaldo best-effort si #signal_wrapper no existe o no cargó a tiempo
      // (nunca se inventa un valor: si tampoco se encuentra acá, queda null).
      const sig1490Raw = findValueByLabels(["Rx ONU", "ONU Rx", "Signal 1490", "1490"]);
      const sig1310Raw = findValueByLabels(["Rx OLT", "OLT Rx", "Signal 1310", "1310"]);
      sig1490 = findNumber(sig1490Raw);
      sig1310 = findNumber(sig1310Raw);
    }

    return {
      name: name || null,
      caja: caja || null,
      // El puerto se completa después, fuera de esta función inyectada, a
      // partir de "caja" (que puede traer "D1FA1 (Port 6)") — nunca acá.
      puerto: null,
      serial: serial || null,
      sig1490,
      sig1310,
    };
  });
}

async function handleObtenerCliente() {
  clienteFeedback.textContent = "Buscando datos del cliente…";
  clienteFeedback.hidden = false;

  let tabs;
  try {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (e) {
    tabs = null;
  }
  const tab = tabs && tabs[0];

  // Defensa adicional: el botón ya queda deshabilitado cuando la pestaña
  // activa no es una ficha de cliente (.../onu/view/ID), pero se repite acá
  // la misma verificación por si igual se disparara el evento.
  const isClientPage = !!(tab && tab.url && SmartOLTShared.isClientPageUrl(tab.url));

  if (!tab || !isClientPage) {
    clienteFeedback.textContent = "⚠️ Abrí la ficha del cliente en SmartOLT antes de usar este botón.";
    return;
  }

  let injectionResults;
  try {
    injectionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: injectedExtractClientData,
    });
  } catch (e) {
    clienteFeedback.textContent = "⚠️ No se pudo leer la página de SmartOLT.";
    return;
  }

  const clientData = injectionResults && injectionResults[0] && injectionResults[0].result;
  if (!clientData || (!clientData.name && !clientData.caja && !clientData.serial)) {
    clienteFeedback.textContent = "⚠️ No se pudieron detectar los datos del cliente en esta página.";
    return;
  }

  // SmartOLT muestra la caja/NAP como "A47B1 (Port 8)": separar el nombre real
  // de la caja del puerto ANTES de comparar contra las cajas del CSV (si no,
  // "A47B1 (Port 8)" nunca va a coincidir con "A47B1"). El puerto SIEMPRE sale
  // de acá — nunca del campo general "Puerto" de la ficha, que ya no se lee en
  // ningún lado — y si el texto no trae "(Port N)", el puerto queda null y el
  // informe lo muestra como "no disponible" (sin inventar nada).
  if (clientData.caja) {
    const parsedCaja = SmartOLTShared.parseCajaPortLabel(clientData.caja);
    clientData.caja = parsedCaja.caja;
    clientData.puerto = parsedCaja.puerto;
  } else {
    clientData.puerto = null;
  }

  // El promedio de caja sale del MISMO CSV ya capturado (sin volver a
  // consultar SmartOLT). buildClientReport devuelve { text, cajaWarning }:
  // "text" es EXACTAMENTE lo que se copia (nunca incluye avisos de caja ni
  // listados de LOS/Power fail/otras cajas); "cajaWarning" es un aviso SOLO
  // para esta interfaz (p. ej. "la caja no coincide con el CSV") — nunca se
  // agrega al texto copiado, tal como pidió el usuario.
  const records = getCurrentRecords();
  const result = SmartOLTShared.buildClientReport(clientData, records);

  const copied = await copyTextToClipboard(result.text);
  if (!copied) {
    clienteFeedback.textContent = "⚠️ No se pudo copiar automáticamente";
  } else if (result.cajaWarning) {
    clienteFeedback.textContent = `✓ Copiado — ⚠️ ${result.cajaWarning}`;
  } else {
    clienteFeedback.textContent = "✓ Copiado";
  }
  setTimeout(() => {
    clienteFeedback.hidden = true;
  }, result.cajaWarning ? 4500 : 2500);
}

obtenerClienteBtn.addEventListener("click", handleObtenerCliente);

// ---------- Descargar último CSV (byte a byte tal cual está en memoria, sin
// volver a consultar SmartOLT ni regenerar nada) ----------
downloadCsvBtn.addEventListener("click", () => {
  if (!currentCsvText) {
    csvFeedback.textContent = "⚠️ No hay ningún CSV capturado.";
    csvFeedback.hidden = false;
    setTimeout(() => {
      csvFeedback.hidden = true;
    }, 2500);
    return;
  }

  const pad = (x) => String(x).padStart(2, "0");
  const now = new Date();
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
  const fileName = currentFileName || `smartolt_export_${stamp}.csv`;

  const blob = new Blob([currentCsvText], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// =========================================================================
// Habilitar/deshabilitar "OBTENER DATOS DEL CLIENTE" según la URL de la
// pestaña activa: solo debe usarse dentro de una ficha de cliente real
// (.../onu/view/ID). El criterio principal es la URL (SmartOLTShared.
// isClientPageUrl); no se valida el DOM acá para no tener que inyectar un
// script en cada cambio de pestaña — el propio clic en el botón ya hace una
// verificación real (extrae los datos y avisa si no encuentra nada), así que
// la combinación es robusta sin ese costo extra.
// =========================================================================

async function refreshClienteBtnState() {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (e) {
    tabs = null;
  }
  const tab = tabs && tabs[0];
  const isClientPage = !!(tab && tab.url && SmartOLTShared.isClientPageUrl(tab.url));

  obtenerClienteBtn.disabled = !isClientPage;
  obtenerClienteBtn.title = isClientPage
    ? ""
    : "Abrí la ficha de un cliente en SmartOLT (.../onu/view/ID) para usar este botón.";

  // Corrección visual (sección 6, v3.0.5): azul (btn-primary, como "ESTADO DE
  // CAJAS") cuando la acción está disponible; gris con texto gris medio
  // (btn-client-disabled, nunca blanco) cuando no lo está. Tamaño, posición e
  // ícono no cambian — solo estas dos clases de color se alternan.
  obtenerClienteBtn.classList.toggle("btn-primary", isClientPage);
  obtenerClienteBtn.classList.toggle("btn-client-disabled", !isClientPage);
}

// La pestaña activa puede cambiar de URL (o el usuario puede cambiar de
// pestaña) mientras el popup sigue abierto, así que el estado del botón se
// vuelve a calcular ante esos dos eventos, además de al abrir el popup.
if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url || changeInfo.status === "complete") {
      refreshClienteBtnState();
    }
  });
}
if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.onActivated) {
  chrome.tabs.onActivated.addListener(() => {
    refreshClienteBtnState();
  });
}

// =========================================================================
// Firma del equipo (footer) + easter eggs
// =========================================================================
//
// Versión de la extensión para el footer: se lee DINÁMICAMENTE desde
// manifest.json vía chrome.runtime.getManifest() (API síncrona) — nunca se
// escribe a mano en el código, así el footer siempre coincide con la versión
// realmente instalada, incluso si manifest.json cambia en el futuro. Si por
// algún motivo no está disponible, queda null y el footer simplemente omite
// el segmento de versión (nunca se inventa un número).
const extensionVersion =
  typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.getManifest === "function"
    ? chrome.runtime.getManifest().version
    : null;

// La firma se calcula UNA vez al abrir el popup, a partir de la fecha/hora
// local del sistema (SmartOLTShared.getFooterSignatureContent — sin tocar
// ningún servicio externo). Fuera de las fechas especiales, "line2" queda
// oculto (no hay frase que mostrar).
function renderTeamSignature() {
  const { line1, line2 } = SmartOLTShared.getFooterSignatureContent(new Date(), extensionVersion);
  teamSignatureLine1.textContent = line1;
  if (line2) {
    teamSignatureLine2.textContent = line2;
    teamSignatureLine2.hidden = false;
  } else {
    teamSignatureLine2.hidden = true;
  }
}

// Easter egg de los 6 toques: la firma es tocable/clickeable y avanza una
// secuencia secreta (ver SmartOLTShared.advanceTapEasterEgg). El CONTADOR vive
// solo en memoria del popup y se mantiene durante toda la instancia (nunca se
// reinicia porque un mensaje haya desaparecido) — se reinicia solo con
// naturalidad al cerrar y volver a abrir la extensión. Cada mensaje queda
// visible ~10s y después vuelve a mostrarse la firma normal; ese temporizador
// es responsabilidad de acá (popup.js), no de la lógica pura de shared.js. No
// interfiere con ninguna otra funcionalidad: es un listener aparte sobre un
// elemento propio del footer.
let tapEasterEggState = SmartOLTShared.initialTapEasterEggState();
let tapEasterEggHideTimer = null;

function handleTeamSignatureTap() {
  const result = SmartOLTShared.advanceTapEasterEgg(tapEasterEggState);
  tapEasterEggState = result.state;

  // message === null significa que el contador ya llegó a 6 en un toque
  // anterior: cualquier toque posterior no debe hacer absolutamente nada.
  if (!result.message) return;

  if (tapEasterEggHideTimer) {
    clearTimeout(tapEasterEggHideTimer);
  }

  teamSignatureLine2.textContent = result.message;
  teamSignatureLine2.hidden = false;

  tapEasterEggHideTimer = setTimeout(() => {
    tapEasterEggHideTimer = null;
    renderTeamSignature(); // vuelve a la firma normal (fecha especial o default)
  }, SmartOLTShared.TAP_EASTER_EGG_DISPLAY_MS);
}

teamSignature.addEventListener("click", handleTeamSignatureTap);
teamSignature.addEventListener("keydown", (e) => {
  // Accesibilidad: Enter/Espacio activan el mismo toque que un clic, ya que el
  // elemento tiene role="button" y tabindex="0".
  if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
    e.preventDefault();
    handleTeamSignatureTap();
  }
});

// ---------- Estado inicial: SOLO lee lo que ya está guardado. No procesa ni
// consulta nada por su cuenta. ----------
loadStateFromStorage();
refreshClienteBtnState();
renderTeamSignature();
