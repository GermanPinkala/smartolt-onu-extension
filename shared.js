"use strict";

/**
 * SmartOLT — Control de ONUs
 * Lógica pura compartida entre el service worker (background.js) y el popup
 * (popup.js). No toca el DOM ni hace red — solo parsing/análisis/formato.
 *
 * IMPORTANTE: este archivo se carga tanto con <script> en popup.html como con
 * importScripts() en el service worker, así que no puede usar `import`/
 * `export` (módulos ES). Expone todo bajo el objeto global SmartOLTShared.
 *
 * Única fuente de datos: el CSV que exporta SmartOLT (botón "Exportar").
 * No se agregó, quitó ni modificó ninguna regla de cálculo respecto de la
 * versión anterior: promedio de los 3 mejores OP por caja, Signal 1490 (Rx
 * ONU) y Signal 1310 (Rx OLT) por separado, agrupación por ODB con todas las
 * cajas, formato de texto para Telegram y orden ascendente por puerto.
 *
 * Columnas reales del CSV utilizadas:
 *   - "Name"               -> nombre del cliente
 *   - "ODB (Splitter)"     -> caja
 *   - "ODB Port"           -> puerto
 *   - "Status"             -> estado de la ONU (se muestra tal cual aparece en el CSV)
 *   - "Last status change" -> fecha/hora del último cambio de estado
 *   - "Signal 1490"        -> señal Rx ONU (dBm)
 *   - "Signal 1310"        -> señal Rx OLT (dBm)
 */

const REQUIRED_COLUMNS = [
  "Name",
  "ODB (Splitter)",
  "ODB Port",
  "Status",
  "Last status change",
  "Signal 1310",
  "Signal 1490",
];

// Columna del serial/SN de la ONU. A propósito NO es una columna "requerida"
// (no está en REQUIRED_COLUMNS): si el CSV no la trae, la extensión sigue
// funcionando exactamente como antes (sin consolidar nada por serial, cada
// fila es su propia ONU) — solo se usa, cuando está disponible, para detectar
// que una misma ONU física quedó repetida en más de una fila del CSV (ver
// consolidateRecordsBySerial más abajo).
const SERIAL_COLUMN = "SN";

const TOP_N_SIGNAL = 3;

// OLTs cuya familia puede determinarse con seguridad para comparar el prefijo
// del serial de la ONU. Los nombres no incluidos no generan ningún aviso.
const OLT_COMPATIBILITY_GROUPS = {
  huawei: [
    "ADH-OLT-D",
    "MRT-OLT-G",
    "OBE-OLT-A",
    "OBE-OLT-B",
    "OBE-OLT-C",
    "OBE-OLT-D",
    "PAZ-OLT-C",
    "PZA-OLT-A",
    "SNM-OLT-E",
    "WND-OLT-A",
  ],
  zte: ["ELD-OLT-A", "ITU-OLT-A"],
};

const ONU_COMPATIBILITY_PREFIXES = {
  huawei: "HWTC",
  zte: "ZTEG",
};

const ONU_OLT_COMPATIBILITY_WARNING = "⚠️ ONU con serial no compatible con la OLT";

// Solo se incluyen IDs confirmados en SmartOLT. Los demás pueden resolverse
// desde select#olt cuando la página expone un nombre reconocido.
const SMARTOLT_OLT_ID_MAP = {
  "13": "ADH-OLT-D",
  "15": "ITU-OLT-A",
  "16": "ELD-OLT-A",
};

// Alias observados en el selector de SmartOLT. No se intenta invertir ni
// reordenar segmentos del nombre mostrado automáticamente.
const SMARTOLT_OLT_DISPLAY_NAME_MAP = {
  "OLT-A-ELD": "ELD-OLT-A",
};

function resolveSmartoltOltIdentifier(oltId, displayedName) {
  const id = String(oltId || "").trim();
  if (SMARTOLT_OLT_ID_MAP[id]) return SMARTOLT_OLT_ID_MAP[id];

  const name = String(displayedName || "")
    .replace(/^\s*\d+\s*-\s*/, "")
    .trim()
    .toUpperCase();
  if (!name) return null;
  if (SMARTOLT_OLT_DISPLAY_NAME_MAP[name]) return SMARTOLT_OLT_DISPLAY_NAME_MAP[name];

  const knownName = Object.values(OLT_COMPATIBILITY_GROUPS)
    .flat()
    .find((candidate) => candidate === name);
  return knownName || null;
}

function getOnuOltCompatibilityWarning(oltName, serial) {
  const normalizedOlt = String(oltName || "").trim().toUpperCase();
  const normalizedSerial = String(serial || "").trim().toUpperCase();
  if (!normalizedOlt || !normalizedSerial) return null;

  const oltFamily = Object.entries(OLT_COMPATIBILITY_GROUPS).find(([, names]) =>
    names.includes(normalizedOlt)
  );
  if (!oltFamily) return null;

  const [family] = oltFamily;
  return normalizedSerial.startsWith(ONU_COMPATIBILITY_PREFIXES[family])
    ? null
    : ONU_OLT_COMPATIBILITY_WARNING;
}

// Fusible de seguridad ABSOLUTO — es un límite POR PON (128 = capacidad
// máxima de ONUs de un PON GPON; 128 es válido, 129 ya no lo es). Cada CSV que
// procesa la extensión corresponde SIEMPRE a la exportación de un único PON
// (así funciona el propio botón "Exportar" de SmartOLT — de hecho, el nombre
// de archivo que genera trae codificado el OLT/Board/Port exacto, ver
// parsePonFromFileName más abajo), así que este fusible se aplica al TOTAL de
// filas del CSV: si un CSV real ya filtrado por el usuario supera este
// número, no se procesa nada — ni promedios, ni texto, nada. NO es un límite
// arbitrario "del CSV": conceptualmente es el límite del PON que ese CSV
// representa.
const MAX_ONUS = 128;

// ---------- Parser CSV (soporta comillas, comas y "" escapadas dentro de campos) ----------
function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1); // BOM
  }

  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        row.push(field);
        field = "";
      } else if (char === "\r") {
        // ignorar, \n lo maneja
      } else if (char === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else {
        field += char;
      }
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

function normalizeHeader(h) {
  return h.trim().toLowerCase();
}

function findColumnIndex(headerRow, columnName) {
  const target = normalizeHeader(columnName);
  return headerRow.findIndex((h) => normalizeHeader(h) === target);
}

// ---------- Utilidades de datos ----------
function parseSignal(raw) {
  if (raw === undefined || raw === null) return null;
  const v = String(raw).trim();
  if (v === "" || v === "-") return null;
  const num = Number(v);
  return Number.isNaN(num) ? null : num;
}

// "2026-09-08 15:55:12.538649" -> "08/09 15:55"
function formatLastChange(raw) {
  if (!raw) return "";
  const m = String(raw)
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return "";
  const [, , month, day, hour, minute] = m;
  return `${day}/${month} ${hour}:${minute}`;
}

// ---------- Fecha/hora del CSV procesado (sección 4, v3.0.5) ----------
// Formatea un timestamp (ms desde epoch) como "DD/MM/AA HH:mm", en hora
// LOCAL del dispositivo (la misma que ya usa formatLastChange para las
// fechas del propio CSV). Nunca inventa nada: si el timestamp no es un
// número válido, devuelve null y el llamador simplemente omite la línea.
function formatShortDateTime(timestampMs) {
  if (timestampMs === null || timestampMs === undefined) return null;
  const d = new Date(timestampMs);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  const dd = pad(d.getDate());
  const mm = pad(d.getMonth() + 1);
  const yy = pad(d.getFullYear() % 100);
  const hh = pad(d.getHours());
  const min = pad(d.getMinutes());
  return `${dd}/${mm}/${yy} ${hh}:${min}`;
}

// Antepone la fecha/hora del ARCHIVO CSV (nunca la hora actual del click) al
// reporte de ESTADO DE CAJA(S), UNA SOLA VEZ al principio de todo el reporte
// (nunca dentro de cada caja). Si no hay timestamp disponible, no se inventa
// una fecha: se devuelve el reporte tal cual, sin esa línea.
function prependCsvTimestamp(reportText, timestampMs) {
  const label = formatShortDateTime(timestampMs);
  if (!label) return reportText;
  return `📅 Datos del: ${label}\n\n${reportText}`;
}

function average(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Mejor promedio dBm: menos negativo = mejor. Toma los N mejores valores válidos
// y devuelve también cuántos se usaron realmente (puede ser menor a N).
function bestAverageWithCount(values, n) {
  const valid = values.filter((v) => v !== null && v !== undefined && !Number.isNaN(v));
  if (valid.length === 0) return { avg: null, count: 0 };
  const sorted = [...valid].sort((a, b) => b - a); // descendente: -22 antes que -28
  const top = sorted.slice(0, n);
  return { avg: average(top), count: top.length };
}

// Determina, para una caja, si se puede calcular el promedio de señal y con qué datos.
// Regla: solo los clientes Online ("OP") con lectura numérica válida cuentan.
function computeCajaSignalInfo(recordsInCaja) {
  if (recordsInCaja.length === 0) {
    return { kind: "NO_CLIENTS" };
  }

  const onlineRecords = recordsInCaja.filter((r) => r.status.toLowerCase() === "online");
  if (onlineRecords.length === 0) {
    return { kind: "ALL_OFFLINE" };
  }

  // Signal 1490 -> Rx ONU ; Signal 1310 -> Rx OLT
  const onuValid = onlineRecords.map((r) => r.sig1490).filter((v) => v !== null);
  const oltValid = onlineRecords.map((r) => r.sig1310).filter((v) => v !== null);

  if (onuValid.length === 0 && oltValid.length === 0) {
    return { kind: "NO_SIGNAL_DATA" };
  }

  return {
    kind: "OK",
    onuResult: bestAverageWithCount(onuValid, TOP_N_SIGNAL),
    oltResult: bestAverageWithCount(oltValid, TOP_N_SIGNAL),
  };
}

// Fragmento "ONU x / OLT y dBm" (o la explicación "Sin datos — ...") a partir del
// resultado de computeCajaSignalInfo. No cambia la regla de cálculo, solo el texto.
function formatCajaAverageText(info) {
  switch (info.kind) {
    case "NO_CLIENTS":
      return "Sin datos — sin clientes";
    case "ALL_OFFLINE":
      return "Sin datos — todos los OP están LOS/Offline";
    case "NO_SIGNAL_DATA":
      return "Sin datos — OP sin señal válida";
    case "OK": {
      const { onuResult, oltResult } = info;
      const onuStr = onuResult.avg !== null ? onuResult.avg.toFixed(2) : "Sin datos";
      const oltStr = oltResult.avg !== null ? oltResult.avg.toFixed(2) : "Sin datos";

      let suffix = "";
      if (onuResult.avg !== null && oltResult.avg !== null) {
        const minCount = Math.min(onuResult.count, oltResult.count);
        if (minCount < TOP_N_SIGNAL) suffix = ` (${minCount} OP)`;
      } else if (onuResult.avg !== null && onuResult.count < TOP_N_SIGNAL) {
        suffix = ` (${onuResult.count} OP)`;
      } else if (oltResult.avg !== null && oltResult.count < TOP_N_SIGNAL) {
        suffix = ` (${oltResult.count} OP)`;
      }

      return `ONU ${onuStr} / OLT ${oltStr} dBm${suffix}`;
    }
    default:
      return "Sin datos";
  }
}

// Normaliza únicamente diferencias de espacios y mayúsculas. El contador final
// solo se elimina cuando está separado del nombre por espacios, como en
// "A1AA1  8"; nombres como "A1AA1" no se alteran.
function normalizeCajaName(raw) {
  return String(raw || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s+\d+$/, "")
    .trim()
    .toUpperCase();
}

function buildDataIdentity(records, source = {}) {
  const cajaNames = Array.from(
    new Set((records || []).map((record) => normalizeCajaName(record.caja)).filter(Boolean))
  ).sort(naturalCompare);

  return {
    cajaNames,
    pon: source.pon || null,
    sourceUrl: source.sourceUrl || null,
    tabId: source.tabId ?? null,
    capturedAt: source.capturedAt || null,
  };
}

// LOS = problema de señal con la ONU encendida (🔴). Power fail = ONU sin
// alimentación (⚫).
function getStatusIcon(status) {
  return String(status).trim().toLowerCase() === "los" ? "🔴" : "⚫";
}

// Para "CONSULTAR CAJAS", el mini-dashboard y "OBTENER DATOS DEL CLIENTE" solo
// interesan estos dos estados puntuales — CUALQUIER otro estado (Offline,
// Online, o cualquier otro texto que traiga el CSV) se ignora por completo acá,
// aunque sí se siga usando en otros cálculos ya existentes (p. ej. el promedio
// de caja solo cuenta Online, y el reporte de Telegram original agrupa todo lo
// que no sea Online bajo "LOS/Power fail" — esa lógica no se toca).
function isLosOrPowerFailStatus(status) {
  const s = String(status || "").trim().toLowerCase();
  return s === "los" || s === "power fail";
}

// Reconoce cualquier subdominio de smartolt.com (ej. obercom.smartolt.com), no
// un dominio hardcodeado. La usan tanto background.js (detección de la descarga
// del export) como popup.js (detección de la pestaña del cliente).
const SMARTOLT_HOST_RE = /(^|\.)smartolt\.com$/i;

// Ficha de cliente = https://<host>.smartolt.com/onu/view/ID (cualquier ID
// después de "/onu/view/"). Otras rutas de SmartOLT (dashboard, /onu/list,
// etc.) NO son ficha de cliente. Usado por popup.js para habilitar/deshabilitar
// "OBTENER DATOS DEL CLIENTE" según la URL de la pestaña activa.
const CLIENT_PAGE_PATH_RE = /^\/onu\/view\/[^/?#]+/i;
const ONU_CONFIGURED_PATH_RE = /^\/onu\/configured(?:\/)?$/i;

function isClientPageUrl(rawUrl) {
  if (!rawUrl) return false;
  let u;
  try {
    u = new URL(rawUrl);
  } catch (e) {
    return false;
  }
  return SMARTOLT_HOST_RE.test(u.hostname) && CLIENT_PAGE_PATH_RE.test(u.pathname);
}

function isOnuConfiguredPageUrl(rawUrl) {
  if (!rawUrl) return false;
  let u;
  try {
    u = new URL(rawUrl);
  } catch (e) {
    return false;
  }
  return SMARTOLT_HOST_RE.test(u.hostname) && ONU_CONFIGURED_PATH_RE.test(u.pathname);
}

const CAJA_SEPARATOR = "-".repeat(29); // exactamente 29 guiones, solo ENTRE cajas

// Comparador "natural" (alfanumérico): compara tramos de dígitos como números y
// el resto como texto, para que "PZA-0731" quede antes que "PZA-0732" y, en
// general, "PZA-9" quede antes que "PZA-10" (una comparación de texto simple
// pondría "PZA-10" antes que "PZA-9"). Usado para ordenar SIEMPRE las cajas de
// menor a mayor antes de mostrarlas o procesarlas.
function naturalCompare(a, b) {
  const chunkRe = /(\d+|\D+)/g;
  const aParts = String(a).match(chunkRe) || [String(a)];
  const bParts = String(b).match(chunkRe) || [String(b)];
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const ap = aParts[i];
    const bp = bParts[i];
    if (ap === undefined) return -1;
    if (bp === undefined) return 1;
    const isNumA = /^\d+$/.test(ap);
    const isNumB = /^\d+$/.test(bp);
    if (isNumA && isNumB) {
      const diff = Number(ap) - Number(bp);
      if (diff !== 0) return diff;
    } else {
      const cmp = ap.localeCompare(bp, "es", { sensitivity: "base" });
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

// Orden ascendente por ODB Port (numérico). Puertos no numéricos quedan al final,
// manteniendo entre ellos el orden original (sort estable).
function sortByPuertoAscending(records) {
  return [...records].sort((a, b) => {
    const pa = parseInt(a.puerto, 10);
    const pb = parseInt(b.puerto, 10);
    const aValid = !Number.isNaN(pa);
    const bValid = !Number.isNaN(pb);
    if (aValid && bValid) return pa - pb;
    if (aValid) return -1;
    if (bValid) return 1;
    return 0;
  });
}

// A diferencia de isLosOrPowerFailStatus (que reconoce SOLO "LOS"/"Power fail"
// y no se toca, sigue usándose tal cual en otros lugares), este informe
// unificado también agrupa "Offline"/"Disabled" dentro del mismo conteo —
// NUNCA como categoría aparte — por pedido explícito: "Offline y Disabled no
// deben aparecer como una categoría separada en el informe. Se consideran
// parte de Power fail."
function isProblemStatusForCajaReport(status) {
  const s = String(status || "").trim().toLowerCase();
  return s === "los" || s === "power fail" || s === "offline" || s === "disabled";
}

function normalizeClientStatusLabel(status) {
  const raw = String(status || "").trim();
  const normalized = raw.toLowerCase().replace(/\s+/g, " ");
  if (normalized.includes("los") && normalized.includes("power fail")) return "LOS/Power fail";
  if (normalized === "los") return "LOS";
  if (normalized === "power fail") return "Power fail";
  if (normalized === "offline") return "Offline";
  if (normalized === "online") return "Online";
  if (normalized === "disabled") return "Disabled";
  return raw || "Estado N/D";
}

// Etiqueta + conteo de la línea de estado problemático de una caja:
//   - Si hay al menos 1 LOS: "LOS/Power fail", contando LOS + Power fail +
//     Offline/Disabled juntos (LOS tiene prioridad en la etiqueta).
//   - Si no hay ningún LOS pero sí Power fail y/o Offline/Disabled: "Power
//     fail", con el mismo conteo combinado (incluye Offline/Disabled).
//   - Si no hay NINGUNO de los tres: no se muestra ninguna línea (label: null).
// El detalle (lista de ONUs) siempre muestra el estado REAL de cada registro
// (getStatusIcon ya distingue 🔴 LOS de ⚫ para cualquier otro) — la etiqueta
// agrupada de acá es solo para el resumen, nunca altera el detalle.
function classifyCajaProblemStatus(recordsInCaja) {
  const problemRecords = recordsInCaja.filter((r) => isProblemStatusForCajaReport(r.status));
  if (problemRecords.length === 0) return { label: null, count: 0, records: [] };
  const hasLos = problemRecords.some((r) => String(r.status).trim().toLowerCase() === "los");
  return {
    label: hasLos ? "LOS/Power fail" : "Power fail",
    count: problemRecords.length,
    records: problemRecords,
  };
}

// Identificador para mostrar un registro "sin estado" dentro de su caja: el
// serial si está disponible, si no el nombre, si no el puerto — nunca se
// inventa nada; si no hay ningún dato usable queda "(sin identificar)".
function identifyRecordForWarning(rec) {
  if (rec.serial) return rec.serial;
  if (rec.name) return rec.name;
  if (rec.puerto) return `Puerto ${rec.puerto}`;
  return "(sin identificar)";
}

// ---------- Armado del reporte completo por caja (usado por "ESTADO DE CAJA/S") ----------
// Informe unificado: para cada caja, en este orden fijo —
//   1. Promedio de caja       -> `- Prom. caja: ...`
//   2. Puertos ocupados       -> `- N puertos ocupados: 1, 2 y 3` (omitida si no hay ninguno)
//   3. Clientes sin puerto    -> `- ⚠️ N cliente(s) sin puerto asignado` (v3.0.8;
//                                 omitida si no hay ninguno — ver más abajo)
//   4. Online                 -> `- Online: N`
//   5. Estado problemático    -> `- LOS/Power fail: N` o `- Power fail: N` (omitida si N=0)
//   6. Detalle de ONUs afectadas (una línea por registro problemático, orden por puerto)
//   7. Registros inconsistentes, si existen -> `⚠️ N ONU(s) sin estado: `serial``
//   8. Separador de 29 guiones ENTRE cajas (nunca antes de la primera ni después de la última)
// El valor ONU/OLT del promedio va entre backticks (monoespaciado de Telegram) SOLO
// cuando es un valor numérico real (info.kind === "OK"); los puertos ocupados se
// calculan igual que antes (números distintos, sin inventar capacidad ni huecos —
// ver el comentario de formatSpanishList). Las cajas se procesan TODAS y siempre en
// orden natural ascendente (naturalCompare), sin importar el orden del CSV. Los
// `records` de entrada ya deben venir consolidados por serial (ver
// consolidateRecordsBySerial, aplicado una sola vez en buildAnalysisResult/
// getCurrentRecords) — acá no se vuelve a deduplicar nada.
function buildTelegramText(records) {
  const groups = new Map(); // caja -> array de TODOS los records de esa caja

  records.forEach((rec) => {
    const key = rec.caja || "(sin caja)";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rec);
  });

  const cajaNamesSorted = Array.from(groups.keys()).sort(naturalCompare);
  const blocks = [];

  for (const caja of cajaNamesSorted) {
    const recs = groups.get(caja);
    const info = computeCajaSignalInfo(recs);
    const onlineInCaja = recs.filter((r) => r.status.toLowerCase() === "online");
    const problem = classifyCajaProblemStatus(recs);
    // Un registro "sin estado" es, por construcción de consolidateRecordsBySerial,
    // una ONU cuyo estado no se pudo determinar en NINGUNA de sus filas del CSV
    // (nunca se inventa un estado) — se detecta simplemente buscando status vacío.
    const sinEstado = recs.filter((r) => !r.status);

    const cajaAverageText = formatCajaAverageText(info);
    // Solo el valor ONU/OLT (info.kind === "OK") va entre backticks; los textos
    // "Sin datos — ..." de los demás casos quedan sin formato monoespaciado.
    const cajaAverageDisplay = info.kind === "OK" ? `\`${cajaAverageText}\`` : cajaAverageText;

    // Puertos ocupados: mismos números distintos que ya aparecen en "ODB Port"
    // para esta caja (nunca se calculan huecos ni se asume una capacidad total).
    const occupied = new Set();
    recs.forEach((rec) => {
      const raw = rec.puerto === undefined || rec.puerto === null ? "" : String(rec.puerto).trim();
      const p = parseInt(raw, 10);
      if (raw !== "" && !Number.isNaN(p) && p > 0) occupied.add(p);
    });
    const occupiedSorted = Array.from(occupied).sort((a, b) => a - b);

    // Clientes sin puerto asignado (v3.0.8): CADA registro de esta caja cuyo
    // "ODB Port" esté vacío, ausente o no sea un número de puerto válido —
    // MISMO criterio que decide si ese registro entra al set "occupied" de
    // arriba (solo que acá se cuenta cada registro individual, no valores
    // distintos). Nunca se infiere a partir de huecos en la lista de puertos
    // ocupados (p. ej. que falte el "4" en 1,2,3,5,6,7,8 NO significa que haya
    // un cliente sin puerto: ese número simplemente no está ocupado) — solo
    // cuenta un registro real sin ODB Port utilizable.
    const sinPuerto = recs.filter((rec) => {
      const raw = rec.puerto === undefined || rec.puerto === null ? "" : String(rec.puerto).trim();
      const p = parseInt(raw, 10);
      return raw === "" || Number.isNaN(p) || p <= 0;
    });

    const lines = [caja, `- Prom. caja: ${cajaAverageDisplay}`];

    if (occupiedSorted.length > 0) {
      const plural = occupiedSorted.length === 1 ? "puerto ocupado" : "puertos ocupados";
      lines.push(`- ${occupiedSorted.length} ${plural}: ${formatSpanishList(occupiedSorted)}`);
    }

    if (sinPuerto.length > 0) {
      const plural = sinPuerto.length === 1 ? "cliente sin puerto asignado" : "clientes sin puerto asignado";
      lines.push(`- ⚠️ ${sinPuerto.length} ${plural}`);
    }

    lines.push(`- Online: ${onlineInCaja.length}`);

    // Etiqueta del RESUMEN de esta caja: classifyCajaProblemStatus (compartida
    // con el dashboard, que NO se toca) siempre agrupa cualquier LOS como
    // "LOS/Power fail". Para el resumen de ESTADO DE CAJA(S) se afina un paso
    // más: si en esta caja hay LOS pero NINGÚN otro estado problemático
    // (Power fail/Offline/Disabled), el resumen debe decir simplemente "LOS"
    // — "LOS/Power fail" queda reservado para cuando realmente hay una
    // combinación. El CONTEO (problem.count) y el DETALLE de abajo (que
    // siempre muestra el estado real de cada fila) no cambian en absoluto.
    let summaryLabel = problem.label;
    if (summaryLabel === "LOS/Power fail") {
      const hasOtherProblem = problem.records.some((r) => String(r.status).trim().toLowerCase() !== "los");
      if (!hasOtherProblem) summaryLabel = "LOS";
    }

    if (summaryLabel) {
      lines.push(`- ${summaryLabel}: ${problem.count}`);
      sortByPuertoAscending(problem.records).forEach((rec) => {
        const icon = getStatusIcon(rec.status);
        const puertoLabel = rec.puerto || "-";
        const statusLabel = rec.status || "Sin estado";
        const nameLabel = rec.name || "(sin nombre)";
        const dateLabel = formatLastChange(rec.lastChange) || "-";
        lines.push(`${icon} P${puertoLabel} | ${statusLabel} | ${nameLabel} | ${dateLabel}`);
      });
    }

    if (sinEstado.length > 0) {
      const plural = sinEstado.length === 1 ? "ONU" : "ONUs";
      const ids = sinEstado.map((rec) => `\`${identifyRecordForWarning(rec)}\``);
      lines.push(`⚠️ ${sinEstado.length} ${plural} sin estado: ${ids.join(", ")}`);
    }

    blocks.push(lines.join("\n"));
  }

  // Separador de 29 guiones únicamente ENTRE cajas, pegado a ambos lados (sin líneas
  // en blanco alrededor), nunca antes de la primera caja ni después de la última.
  return blocks.join(`\n${CAJA_SEPARATOR}\n`);
}

// ---------- Consolidación de registros duplicados/incompletos por serial ----------
// SmartOLT puede exportar más de una fila de CSV para la MISMA ONU física
// (mismo serial/"SN") — por ejemplo, un registro completo (con estado, caja,
// puerto y señal) y otro incompleto para el mismo serial (sin estado). Sin
// esta consolidación esa ONU se contaría dos veces en los totales.
//
// Regla — nunca se inventa nada, solo se prioriza la información que YA está
// en el CSV:
//   - Se agrupa por "SN" normalizado (trim + mayúsculas). Un registro sin
//     serial (columna ausente, o vacía en esa fila) no se puede fusionar con
//     ningún otro de forma confiable, así que queda tal cual, solo (nunca se
//     agrupa con otros registros igualmente sin serial).
//   - Si dentro de un grupo (mismo serial) al menos un registro trae un
//     Status no vacío, se usa el MÁS COMPLETO de esos registros con estado
//     (el que tenga más campos con datos: status/caja/puerto/señal/nombre)
//     como el registro real de esa ONU — el resto de las filas de ese mismo
//     serial se descartan silenciosamente (es la misma ONU, ya resuelta con
//     una fuente confiable; nunca se cuenta dos veces).
//   - Si NINGÚN registro del grupo trae un Status utilizable, la ONU queda
//     "sin estado": se usa el registro más completo disponible (para poder
//     identificarla por nombre/caja/puerto si los tiene) pero SIN inventar un
//     estado — su `status` queda "" a propósito. El resto de la lógica
//     (Online/LOS/Power fail/promedio) ya ignora automáticamente cualquier
//     registro con status vacío, así que estas ONUs simplemente no suman en
//     ninguno de esos conteos; el llamador las detecta buscando status === ""
//     sobre el resultado (ver buildTelegramText más abajo, sección "sin estado").
function consolidateRecordsBySerial(records) {
  const groups = new Map(); // serial normalizado -> registros
  const passthrough = []; // registros sin serial: no se pueden fusionar entre sí

  records.forEach((rec) => {
    const key = rec.serial ? String(rec.serial).trim().toUpperCase() : "";
    if (!key) {
      passthrough.push(rec);
      return;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rec);
  });

  const completeness = (r) =>
    (r.status ? 1 : 0) +
    (r.caja ? 1 : 0) +
    (r.puerto ? 1 : 0) +
    (r.sig1310 !== null && r.sig1310 !== undefined ? 1 : 0) +
    (r.sig1490 !== null && r.sig1490 !== undefined ? 1 : 0) +
    (r.name ? 1 : 0);

  const pickMostComplete = (recs) => {
    let best = recs[0];
    let bestScore = completeness(best);
    for (let i = 1; i < recs.length; i++) {
      const score = completeness(recs[i]);
      if (score > bestScore) {
        best = recs[i];
        bestScore = score;
      }
    }
    return best;
  };

  const resolved = passthrough.slice();

  for (const group of groups.values()) {
    if (group.length === 1) {
      resolved.push(group[0]);
      continue;
    }
    const withStatus = group.filter((r) => r.status);
    resolved.push(pickMostComplete(withStatus.length > 0 ? withStatus : group));
  }

  return resolved;
}

// ---------- Análisis principal (puro, sin tocar el DOM ni ningún estado externo) ----------
// Recibe records ya normalizados ({name, caja, puerto, status, lastChange, sig1310,
// sig1490, serial}). No guarda nada en ningún lado — el llamador decide qué hacer con
// el resultado (popup.js o background.js).
function buildAnalysisResult(records) {
  if (!records || records.length === 0) {
    return { ok: false, code: "NO_ROWS" };
  }

  // El fusible de 128 (ver analyzeCSV) se aplica ANTES de esto, sobre el total
  // de filas crudas del CSV — eso no cambia. A partir de acá, todo lo que se
  // cuenta y se muestra (dashboard y ESTADO DE CAJA/S) usa ONUs únicas por
  // serial, nunca filas duplicadas.
  const resolved = consolidateRecordsBySerial(records);

  const total = resolved.length;
  const onlineRecords = resolved.filter((r) => r.status.toLowerCase() === "online");
  const offlineRecords = resolved.filter((r) => r.status.toLowerCase() !== "online");
  // Indicador del mini-dashboard: usa EXACTAMENTE la misma clasificación que
  // ESTADO DE CAJA(S) (classifyCajaProblemStatus), aplicada a TODAS las ONUs
  // juntas (sin agrupar por caja). LOS tiene prioridad absoluta: si hay al
  // menos un LOS, todo el combinado (LOS + Power fail + Offline/Disabled) se
  // reporta en "losCount"; si no hay LOS pero sí Power fail y/o
  // Offline/Disabled, ese mismo combinado se reporta en "powerFailCount".
  // Offline y Disabled NUNCA aparecen como categoría propia — igual que en
  // ESTADO DE CAJA(S). Se mantienen los nombres "losCount"/"powerFailCount"
  // (los únicos que background.js reenvía a chrome.storage, y background.js
  // no se toca) — ahora cada uno ya es el conteo combinado final de su rama,
  // nunca solo LOS puntual o solo "Power fail" puntual.
  const problem = classifyCajaProblemStatus(resolved);
  const losCount = problem.label === "LOS/Power fail" ? problem.count : 0;
  const powerFailCount = problem.label === "Power fail" ? problem.count : 0;

  // El reporte incluye TODAS las cajas detectadas, tengan o no clientes sin OP.
  const telegramText = buildTelegramText(resolved);
  // Nombres de caja únicos y SIEMPRE en orden natural ascendente (menor a mayor).
  const cajaNames = Array.from(new Set(resolved.map((r) => r.caja || "(sin caja)"))).sort(naturalCompare);
  const cajaCount = cajaNames.length;

  return {
    ok: true,
    total,
    onlineCount: onlineRecords.length,
    offlineCount: offlineRecords.length,
    losCount,
    powerFailCount,
    cajaCount,
    cajaNames,
    telegramText,
    records: resolved,
  };
}

// ---------- Promedios por caja, reutilizables fuera del texto de Telegram ----------
// Mapa caja -> computeCajaSignalInfo(...) de esa caja. Es EXACTAMENTE el mismo
// cálculo que ya usa buildTelegramText para la línea "Prom. caja", solo que acá
// se expone el resultado numérico (no el texto) para poder compararlo contra la
// señal del cliente en "OBTENER DATOS DEL CLIENTE".
function buildCajaAverages(records) {
  const groups = new Map();
  records.forEach((rec) => {
    const key = rec.caja || "(sin caja)";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rec);
  });
  const averages = new Map();
  for (const [caja, recs] of groups.entries()) {
    averages.set(caja, computeCajaSignalInfo(recs));
  }
  return averages;
}

// Búsqueda case-insensitive y sin espacios extra: el nombre de caja puede venir
// del CSV (columna "ODB (Splitter)") o del DOM de SmartOLT (best-effort) y no
// siempre coincide carácter a carácter.
function findCajaAverage(cajaAverages, cajaName) {
  if (!cajaName || !cajaAverages) return null;
  const target = String(cajaName).trim().toLowerCase();
  for (const [caja, info] of cajaAverages.entries()) {
    if (String(caja).trim().toLowerCase() === target) return info;
  }
  return null;
}

// ---------- Listado de LOS/Power fail agrupado por TODAS las cajas del CSV ----------
// Usado por "CONSULTAR CAJAS" y también al final de "OBTENER DATOS DEL CLIENTE".
// Reutiliza sortByPuertoAscending/getStatusIcon/formatLastChange — las mismas
// funciones que ya arma el reporte completo de Telegram — solo cambia el
// agrupamiento (únicamente cajas con al menos un LOS/Power fail) y el formato.
function buildLosPowerFailReport(records) {
  const groups = new Map();
  records.forEach((rec) => {
    if (!isLosOrPowerFailStatus(rec.status)) return; // solo LOS y Power fail — Offline/Online/otros quedan afuera
    const key = rec.caja || "(sin caja)";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rec);
  });

  const cajasConProblemas = Array.from(groups.keys()).sort(naturalCompare);
  if (cajasConProblemas.length === 0) {
    return { hasAny: false, text: "" };
  }

  const lines = ["LOS/Power fail en caja:"];
  cajasConProblemas.forEach((caja) => {
    lines.push(`${caja}:`);
    sortByPuertoAscending(groups.get(caja)).forEach((rec) => {
      const icon = getStatusIcon(rec.status);
      const puertoLabel = rec.puerto || "-";
      const statusLabel = rec.status || "Sin estado";
      const nameLabel = rec.name || "(sin nombre)";
      const dateLabel = formatLastChange(rec.lastChange) || "-";
      lines.push(`- ${icon} P${puertoLabel} | ${statusLabel} | ${nameLabel} | ${dateLabel}`);
    });
  });

  return { hasAny: true, text: lines.join("\n") };
}

// Arma, en español, una lista de números separados por comas y "y" antes del
// último (ej. [1,4,5] -> "1, 4 y 5"; [7,8] -> "7 y 8"; [1] -> "1"). Usada por
// la línea de puertos ocupados del informe de ESTADO DE CAJA/S.
function formatSpanishList(numbers) {
  if (!numbers || numbers.length === 0) return "";
  if (numbers.length === 1) return String(numbers[0]);
  return `${numbers.slice(0, -1).join(", ")} y ${numbers[numbers.length - 1]}`;
}

// SmartOLT puede mostrar la caja/NAP del cliente como "A47B1 (Port 8)": el
// nombre real de la caja es "A47B1" y el puerto es "8". Si se compara la caja
// del cliente contra las del CSV usando el texto completo ("A47B1 (Port 8)"),
// nunca va a coincidir con "A47B1" del CSV — por eso hay que separarlos ANTES
// de comparar. Si el texto no trae "(Port N)", se devuelve tal cual (puerto
// null, para no pisar un puerto ya obtenido por otro campo de la página).
function parseCajaPortLabel(raw) {
  if (!raw) return { caja: raw || "", puerto: null };
  const m = String(raw)
    .trim()
    .match(/^(.*?)\s*\(\s*port\s*[:#]?\s*(\d+)\s*\)\s*$/i);
  if (m) {
    return { caja: m[1].trim(), puerto: m[2] };
  }
  return { caja: String(raw).trim(), puerto: null };
}

// ---------- Comparación óptica cliente vs promedio de caja ----------
// Check 1 y Check 2 utilizan una diferencia absoluta máxima de 1.00 dB.
// No se aplica un margen adicional: la comparación es simétrica para valores
// dBm más altos o más bajos que el promedio.
const OPTICAL_TOLERANCE_DB = 1;

// Redondeada a 2 decimales para evitar que un residuo de punto flotante
// (0.9999999999...) altere el resultado justo en el límite de 1 dB.
function opticalDiff(clientValue, cajaAvg) {
  if (clientValue === null || clientValue === undefined) return null;
  if (cajaAvg === null || cajaAvg === undefined) return null;
  return Math.round(Math.abs(clientValue - cajaAvg) * 100) / 100;
}

// Devuelve true/false según la dirección y la diferencia, o null si falta
// alguno de los valores. Un valor menos negativo que el promedio es mejor y
// aprueba sin límite; solo se limita cuánto puede ser peor.
function isOpticalApproved(clientValue, cajaAvg) {
  if (clientValue === null || clientValue === undefined) return null;
  if (cajaAvg === null || cajaAvg === undefined) return null;
  if (clientValue >= cajaAvg) return true;
  const worseness = Math.round((cajaAvg - clientValue) * 100) / 100;
  return worseness <= OPTICAL_TOLERANCE_DB;
}

// Check 3 usa los promedios de Check 1 y Check 2 únicamente para seleccionar
// referencias normales. Después calcula el promedio de DIF de todas ellas.
// Requiere dos referencias normales como mínimo: una sola DIF no representa
// razonablemente el comportamiento de una caja.
function evaluateCheck3(clientOnu, clientOlt, referenceRecords, cajaOnuAvg, cajaOltAvg) {
  const validReferences = (referenceRecords || []).filter(
    (record) =>
      String(record.status || "").trim().toLowerCase() === "online" &&
      record.sig1490 !== null &&
      record.sig1490 !== undefined &&
      record.sig1310 !== null &&
      record.sig1310 !== undefined
  );

  if (
    clientOnu === null ||
    clientOnu === undefined ||
    clientOlt === null ||
    clientOlt === undefined ||
    cajaOnuAvg === null ||
    cajaOnuAvg === undefined ||
    cajaOltAvg === null ||
    cajaOltAvg === undefined
  ) {
    return { status: "not_run" };
  }

  const normalReferences = validReferences.filter(
    (record) =>
      Math.abs(record.sig1490 - cajaOnuAvg) <= OPTICAL_TOLERANCE_DB &&
      Math.abs(record.sig1310 - cajaOltAvg) <= OPTICAL_TOLERANCE_DB
  );

  if (normalReferences.length < 2) return { status: "not_run" };

  const normalDifferences = normalReferences.map((record) => Math.abs(record.sig1490 - record.sig1310));
  const normalDifference = average(normalDifferences);
  const clientDifference = Math.abs(clientOnu - clientOlt);
  const deviation = clientDifference - normalDifference;

  return {
    status: deviation <= OPTICAL_TOLERANCE_DB ? "passed" : "failed",
    deviation: Math.round(deviation * 100) / 100,
    normalDifference: Math.round(normalDifference * 100) / 100,
    referenceCount: normalReferences.length,
  };
}

function formatDb(n) {
  return n.toFixed(2);
}

// ---------- Mensajes motivacionales (sección 3, v3.0.5) ----------
// Solo para "OBTENER DATOS DEL CLIENTE". Comparan ÚNICAMENTE la OP ONU del
// cliente (sig1490) contra las OP ONU de las demás ONUs Online de SU MISMA
// CAJA — nunca OP OLT. Dos categorías independientes, nunca ambas a la vez:
//   A) Es la mejor OP ONU de TODA la caja -> siempre esta categoría, aunque
//      además esté 1 dB o más por encima del promedio.
//   B) No es la mejor, pero está 1.00 dB o más MEJOR que el promedio de su
//      caja (el mismo cajaInfo.onuResult.avg ya usado para la comparación de
//      arriba — no se recalcula nada distinto).
// Si no cumple ninguna de las dos, o falta algún dato necesario, no se
// muestra ningún mensaje (nunca se inventa nada).
// v3.0.9: "OP" (Optical Power / Potencia Óptica) es gramaticalmente
// masculino ("el OP", nunca "la OP") — corregido en los mensajes que lo
// usaban como sustantivo mal generizado. Mismo contenido y estilo, sin
// reescribir nada más.
const MOTIVATIONAL_BEST_IN_CAJA_MESSAGES = [
  "🥇 ¡Bien ahí! Tenés el mejor OP de la caja. ¡Seguí así! 🦾",
  "🏆 ¡Tenemos campeón de caja! Esta ONU tiene el mejor OP. 💪🏻",
  "🚀 ¡Excelente! Esta ONU tiene el mejor OP de toda la caja. ✨",
  "🎉 ¡Bien jugado! Esta ONU tiene el mejor valor de OP de la caja. 🥇",
  "🫡 ¡Trabajo fino! El OP de esta ONU es el mejor de la caja. 💙",
  "🎊 ¡Qué señal! Esta ONU tiene el mejor OP de toda la caja. ¡Excelente trabajo! 💪🏻",
  "✨ ¡Primer puesto! Esta ONU tiene el mejor OP de la caja. ¡A seguir así! 🚀",
];

// Cada plantilla trae el placeholder literal "X,XX", reemplazado en tiempo de
// ejecución por la diferencia real (dos decimales, mismo formato que el resto
// del reporte — formatDb).
const MOTIVATIONAL_BETTER_THAN_AVERAGE_MESSAGES = [
  "🚀 ¡Bien ahí! Es X,XX dB mejor que el promedio de la caja. 🦾",
  "✨ ¡Muy buena señal! Está X,XX dB mejor que el promedio. 💪🏻",
  "🥳 ¡Linda señal! Esta ONU está X,XX dB mejor que el promedio de la caja. 🚀",
  "🏆 ¡Excelente! Está X,XX dB mejor que el promedio de la caja. 🫡",
  "🎊 ¡Vamos! Esta ONU está X,XX dB mejor que el promedio de la caja. 💙",
  "💪🏻 ¡Muy bien! Esta ONU está X,XX dB mejor que el promedio de la caja. ¡Seguí así! ✨",
  "🚀 ¡Muy buena señal! Está X,XX dB mejor que el promedio de la caja. 🎉",
];

// randomFn es un punto de inyección para tests (por defecto Math.random, sin
// cambiar el comportamiento real): permite forzar determinísticamente qué
// mensaje de la lista sale elegido.
function pickRandomMessage(list, randomFn) {
  const idx = Math.floor(randomFn() * list.length);
  return list[Math.min(Math.max(idx, 0), list.length - 1)];
}

// Pura: no toca el DOM ni hace red. csvRecords son los records YA parseados
// del CSV capturado (los mismos que recibe buildClientReport) — se usan acá
// para hallar la OP ONU MÁXIMA real de la caja (nunca un promedio) entre las
// ONUs Online con señal válida.
function computeMotivationalMessage(clientOnu, caja, cajaInfo, csvRecords, randomFn) {
  if (!caja) return null; // sin caja -> nunca se muestra nada
  if (clientOnu === null || clientOnu === undefined) return null; // sin OP ONU del cliente -> no se puede determinar
  if (!cajaInfo || cajaInfo.kind !== "OK" || cajaInfo.onuResult.avg === null) return null; // promedio no calculable
  if (!csvRecords || csvRecords.length === 0) return null;

  const onuValuesInCaja = csvRecords
    .filter(
      (r) =>
        (r.caja || "") === caja &&
        r.status.toLowerCase() === "online" &&
        r.sig1490 !== null &&
        r.sig1490 !== undefined
    )
    .map((r) => r.sig1490);

  if (onuValuesInCaja.length === 0) return null;

  const bestOnuInCaja = Math.max(...onuValuesInCaja);

  // >= (no solo >): si el cliente iguala a la mejor OP ONU registrada en el
  // CSV para esa caja, nadie está mejor que él -> sigue siendo "la mejor".
  if (clientOnu >= bestOnuInCaja) {
    return pickRandomMessage(MOTIVATIONAL_BEST_IN_CAJA_MESSAGES, randomFn);
  }

  const diff = Math.round((clientOnu - cajaInfo.onuResult.avg) * 100) / 100;
  if (diff >= OPTICAL_TOLERANCE_DB) {
    const template = pickRandomMessage(MOTIVATIONAL_BETTER_THAN_AVERAGE_MESSAGES, randomFn);
    return template.replace("X,XX", formatDb(diff));
  }

  return null;
}

// ---------- Dato actual vs. CSV desactualizado (v3.0.7), SOLO para "OBTENER
// DATOS DEL CLIENTE" ----------
// El CSV capturado puede haber quedado desactualizado para la ONU que se está
// consultando (p. ej. el técnico ya solucionó el problema y SmartOLT ya
// muestra una OP mejor que la que quedó grabada en el CSV). Esta sección NO
// toca el CSV ni chrome.storage: arma, únicamente en memoria y solo para la
// evaluación de este cliente, dos copias derivadas del mismo array de
// records ya parseados:
//   - adjustedRecords: el mismo CSV, pero si se pudo identificar el registro
//     correspondiente (ver más abajo), su OP ONU/OLT vieja se reemplaza por
//     la OP actual (clientData) — usado para todo lo demás de la evaluación
//     (p. ej. determinar si el cliente tiene la mejor OP de la caja, ver
//     computeMotivationalMessage).
//   - referenceRecords: igual, pero además la ONU consultada queda
//     directamente EXCLUIDA (nunca solo con su valor reemplazado) del grupo
//     de su caja, para que el promedio de referencia (buildCajaAverages) se
//     recalcule con las 3 mejores ONUs restantes, sin el propio cliente.
//
// Identificación del registro del CSV, en este orden estricto (v3.0.8):
//   1. SERIAL: el SERIAL actual (leído en vivo de SmartOLT) existe en el CSV.
//   2. CAJA + PUERTO exactos: cuando el SERIAL actual NO está en el CSV (p.
//      ej. el técnico reemplazó la ONU del cliente por un equipo nuevo, dado
//      de alta después de exportar el CSV), pero existe un registro con
//      EXACTAMENTE la misma Caja/NAP y el mismo Puerto que informa SmartOLT
//      ahora — nunca se infiere usando solo uno de los dos campos.
// Si ninguna de las dos coincide, no se infiere nada: ambas copias quedan
// como el array original, sin cambios (se mantiene el comportamiento actual,
// "no se pudo establecer correspondencia con el registro del CSV").
function normalizeSerialKey(serial) {
  return serial ? String(serial).trim().toUpperCase() : "";
}

// Misma normalización que ya usa findCajaAverage (case-insensitive, sin
// espacios extra) para poder comparar la caja del cliente contra la del CSV.
function normalizeCajaKey(caja) {
  return caja ? String(caja).trim().toLowerCase() : "";
}

// El puerto puede venir formateado distinto entre el CSV y SmartOLT (p. ej.
// "2" vs "02"): se compara como número siempre que ambos lo sean, y como
// texto (trim, sin distinguir mayúsculas) solo si alguno no es numérico —
// nunca dos puertos con distinto contenido "parecen" coincidir por esto.
function normalizePuertoKey(puerto) {
  if (puerto === null || puerto === undefined || puerto === "") return "";
  const trimmed = String(puerto).trim();
  const n = Number(trimmed);
  return trimmed !== "" && !Number.isNaN(n) ? String(n) : trimmed.toLowerCase();
}

function findClientRecordIndex(csvRecords, clientData) {
  const serialKey = normalizeSerialKey(clientData && clientData.serial);
  if (serialKey) {
    const bySerial = csvRecords.findIndex((r) => normalizeSerialKey(r.serial) === serialKey);
    if (bySerial !== -1) return bySerial;
  }

  // Segunda opción, solo si la búsqueda por SERIAL no encontró nada: Caja +
  // Puerto EXACTOS. Requiere que el cliente traiga AMBOS datos — nunca se
  // usa la caja sola ni el puerto solo como criterio.
  const cajaKey = normalizeCajaKey(clientData && clientData.caja);
  const puertoKey = normalizePuertoKey(clientData && clientData.puerto);
  if (!cajaKey || !puertoKey) return -1;

  return csvRecords.findIndex(
    (r) => normalizeCajaKey(r.caja) === cajaKey && normalizePuertoKey(r.puerto) === puertoKey
  );
}

function buildClientEvaluationRecords(csvRecords, clientData) {
  const unchanged = { adjustedRecords: csvRecords, referenceRecords: csvRecords };
  if (!csvRecords || csvRecords.length === 0) return unchanged;

  const matchIndex = findClientRecordIndex(csvRecords, clientData);
  if (matchIndex === -1) return unchanged; // sin coincidencia (ni SERIAL ni Caja+Puerto) -> comportamiento actual

  // Nunca se modifica el record original: se arma un array y un objeto nuevos.
  // El SERIAL también se actualiza al actual (relevante cuando la coincidencia
  // fue por Caja+Puerto, ej. reemplazo de ONU: el registro viejo tenía el
  // serial anterior) — puramente en memoria, nunca se toca el CSV almacenado.
  const adjustedRecords = csvRecords.slice();
  adjustedRecords[matchIndex] = {
    ...csvRecords[matchIndex],
    serial: (clientData && clientData.serial) || csvRecords[matchIndex].serial,
    sig1490: clientData && clientData.sig1490 !== undefined ? clientData.sig1490 : null,
    sig1310: clientData && clientData.sig1310 !== undefined ? clientData.sig1310 : null,
  };

  const referenceRecords = adjustedRecords.filter((_, i) => i !== matchIndex);

  return { adjustedRecords, referenceRecords };
}

// ---------- Reporte completo de "OBTENER DATOS DEL CLIENTE" ----------
// clientData: { name, caja, puerto, serial, oltName, sig1490 (Rx ONU), sig1310 (Rx OLT) },
// con cualquier campo en null/"" si no se pudo detectar en la página de SmartOLT.
// csvRecords: records ya parseados del CSV capturado actualmente (o null/[] si
// no hay ningún CSV capturado todavía). randomFn es opcional (por defecto
// Math.random) — únicamente para poder testear determinísticamente el
// mensaje motivacional; nunca se usa para nada más. No hace red ni toca el
// DOM: es pura.
//
// Formato exacto y orden fijo, SIEMPRE igual sin importar el caso: Cliente ->
// Serial ONU -> Caja + Puerto -> OP cliente -> Prom. de caja -> advertencia
// de mejora (solo si corresponde) -> mensaje motivacional (solo si
// corresponde). A propósito NO incluye ningún listado de LOS/Power
// fail/Offline ni de otras cajas: esa información la entrega por separado
// "ESTADO DE CAJA(S)" (buildTelegramText) y duplicarla acá sobrecargaba el
// mensaje del cliente.
//
// Devuelve { text, cajaWarning, compatibilityWarning }. El aviso de caja es
// solo visual; el aviso ONU/OLT forma parte del texto copiado para que ambos
// canales informen exactamente lo mismo.
// Nunca se inventa un promedio: si no se puede calcular, la línea de
// "Prom. de caja" queda con el texto fijo "no se pudo obtener promedio de
// caja" y no se hace comparación óptica.
function buildClientReport(clientData, csvRecords, randomFn) {
  const rand = typeof randomFn === "function" ? randomFn : Math.random;
  const name = clientData.name || "N/D";
  const caja = clientData.caja || "";
  // El puerto SOLO puede venir de haber parseado el texto de la etiqueta
  // "NAP (Divisor)" (ver injectedExtractClientData + parseCajaPortLabel en
  // popup.js) — nunca del campo general "Puerto" de la ficha. Si no se pudo
  // extraer de ahí, no se inventa ni se usa ningún otro campo como respaldo:
  // se marca explícitamente con ⚠️ (ver más abajo).
  const puerto = clientData.puerto || "";
  const serial = clientData.serial || "N/D";
  const compatibilityWarning = getOnuOltCompatibilityWarning(clientData.oltName, clientData.serial);
  const clientOnu = clientData.sig1490; // Rx ONU -> "OP Cliente"
  const clientOlt = clientData.sig1310; // Rx OLT -> "OP OLT"

  const hasCsv = !!(csvRecords && csvRecords.length > 0);
  // v3.0.7: si el SERIAL de este cliente está en el CSV, evalRecords.adjustedRecords
  // trae su OP vieja reemplazada por la actual (clientData), y evalRecords.referenceRecords
  // además lo excluye de su caja — así el promedio de referencia nunca incluye al
  // propio cliente ni su dato desactualizado. Ver buildClientEvaluationRecords.
  const evalRecords = hasCsv ? buildClientEvaluationRecords(csvRecords, clientData) : null;
  const cajaAverages = hasCsv ? buildCajaAverages(evalRecords.referenceRecords) : null;
  const cajaInfo = caja && cajaAverages ? findCajaAverage(cajaAverages, caja) : null;
  const cajaRecords = evalRecords
    ? evalRecords.adjustedRecords.filter((record) => normalizeCajaName(record.caja) === normalizeCajaName(caja))
    : [];
  const availableOpCount = cajaRecords.filter(
    (record) =>
      String(record.status || "").trim().toLowerCase() === "online" &&
      record.sig1490 !== null &&
      record.sig1490 !== undefined &&
      record.sig1310 !== null &&
      record.sig1310 !== undefined
  ).length;

  const lines = [`Cliente: \`${name}\``, "", `- Serial ONU: \`${serial}\``];

  // Aviso sobre la caja: SOLO para la interfaz, nunca se agrega a "lines"
  // (que es lo único que termina en el portapapeles).
  let cajaWarning = null;
  if (caja) {
    // "Sin puerto asignado" es un caso distinto de "sin OP": el cliente puede
    // tener perfectamente su lectura óptica aunque no se haya podido
    // determinar en qué puerto físico de la caja/NAP está — por eso esto NO
    // afecta el cálculo de "Op cliente"/promedio de caja más abajo, que sigue
    // dependiendo únicamente de la caja.
    const puertoLabel = puerto ? `Puerto ${puerto}` : "⚠️ No tiene puerto asignado";
    lines.push(`- Caja: \`${caja}\` - ${puertoLabel}`);
    if (!cajaAverages) {
      cajaWarning = "No hay ningún CSV capturado — no se pudo calcular el promedio de la caja.";
    } else if (!cajaInfo && cajaRecords.length === 0) {
      cajaWarning = `La caja del cliente (${caja}) no coincide con ninguna caja del CSV.`;
    } else if (cajaInfo && cajaInfo.kind !== "OK") {
      cajaWarning = `No se pudo calcular el promedio de la caja ${caja} (${formatCajaAverageText(cajaInfo)}).`;
    }
  } else {
    // Ni caja ni puerto disponibles: no se inventa ninguno de los dos.
    lines.push("- Caja: ⚠️ No tiene caja ni puerto asignado");
  }

  const clientOnuStr = clientOnu !== null && clientOnu !== undefined ? clientOnu.toFixed(2) : "N/D";
  const clientOltStr = clientOlt !== null && clientOlt !== undefined ? clientOlt.toFixed(2) : "N/D";
  // "dBm" solo acompaña a un valor real — nunca a "N/D" (corrección final
  // v3.0.5, caso NO EVALUABLE: `OP Cliente: ONU -20.00 dBm/OLT N/D`, sin
  // "dBm" después de N/D).
  const onuClientPart = `ONU ${clientOnuStr}${clientOnuStr !== "N/D" ? " dBm" : ""}`;
  const oltClientPart = `OLT ${clientOltStr}${clientOltStr !== "N/D" ? " dBm" : ""}`;
  const canCompare = !!(cajaInfo && cajaInfo.kind === "OK");

  let improvementWarning = null;
  // Hoisteados fuera del if para que la sección de mensaje motivacional (más
  // abajo) pueda usarlos: null significa "no se pudo determinar" (nunca se
  // trata como aprobado ni como reprobado).
  let onuOk = null;
  let oltOk = null;
  let check3 = { status: "not_run" };

  if (canCompare) {
    // onuDiff/oltDiff son las diferencias absolutas usadas por los warnings.
    // onuOk/oltOk aplican la tolerancia exacta de 1.00 dB para cada check.
    const onuDiff = opticalDiff(clientOnu, cajaInfo.onuResult.avg);
    const oltDiff = opticalDiff(clientOlt, cajaInfo.oltResult.avg);
    onuOk = isOpticalApproved(clientOnu, cajaInfo.onuResult.avg);
    oltOk = isOpticalApproved(clientOlt, cajaInfo.oltResult.avg);

    // Corrección final v3.0.5: un lado "no evaluable" (null — falta la lectura
    // del cliente y/o el promedio de esa caja para ese lado) NUNCA cuenta como
    // aprobado. Si falta CUALQUIERA de los dos lados, el resultado global es
    // "NO EVALUABLE" (⚠️) sin importar cómo esté el otro lado — nunca se
    // muestra ✅ ni ❌ ni se calcula ninguna mejora en ese caso. Solo cuando
    // AMBOS lados tienen un resultado determinado (true/false) se decide entre
    // ✅ (ambos aprobados) y ❌ (al menos uno necesita mejorar).
    if (onuOk === true && oltOk === false) {
      const sameCajaReferences = evalRecords.referenceRecords.filter(
        (record) => normalizeCajaName(record.caja) === normalizeCajaName(caja)
      );
      check3 = evaluateCheck3(
        clientOnu,
        clientOlt,
        sameCajaReferences,
        cajaInfo.onuResult.avg,
        cajaInfo.oltResult.avg
      );
    }

    const effectiveOltOk = oltOk === false && check3.status === "passed" ? true : oltOk;
    const bothEvaluable = onuOk !== null && effectiveOltOk !== null;
    let badge;
    if (!bothEvaluable) {
      badge = "⚠️";
    } else {
      badge = onuOk && effectiveOltOk ? "✅" : "❌";
    }

    // Formato definitivo v3.0.5: sin etiquetas "OP ONU"/"OP OLT" repetidas,
    // sin ":" después de "OLT", sin espacios alrededor de "/", "dBm" en
    // ambos valores, y el ✅/❌/⚠️ pegado inmediatamente al backtick de cierre
    // (sin guion ni espacio antes).
    lines.push(`- \`OP Cliente: ${onuClientPart}/${oltClientPart}\`${badge}`);

    const onuAvgPart = cajaInfo.onuResult.avg !== null ? `ONU ${cajaInfo.onuResult.avg.toFixed(2)} dBm` : "ONU Sin datos";
    const oltAvgPart = cajaInfo.oltResult.avg !== null ? `OLT ${cajaInfo.oltResult.avg.toFixed(2)} dBm` : "OLT Sin datos";
    if (availableOpCount >= 3) {
      lines.push(`- \`Prom. de caja: ${onuAvgPart}/${oltAvgPart}\``);
    } else if (availableOpCount === 2) {
      lines.push(`- \`Prom. de caja: ${onuAvgPart}/${oltAvgPart} (solo 2 OP)\``);
    } else {
      lines.push("- Prom. de caja: no hay otro OP para comparar");
    }

    // La advertencia de mejora SOLO se calcula cuando AMBOS lados son
    // evaluables: si falta cualquiera de los dos, el caso completo es "NO
    // EVALUABLE" y no se le pide mejorar nada al técnico (nunca se inventa
    // que un lado sin dato está mal).
    // v3.0.7: el valor mostrado es CUÁNTO le falta al cliente para entrar en
    // la zona segura de OPTICAL_TOLERANCE_DB (1.00 dB) — es decir, el exceso
    // de la diferencia real (onuDiff/oltDiff) por encima de esa zona, no la
    // diferencia real completa. Solo puede llegar acá un lado con onuOk/oltOk
    // === false, y eso solo ocurre cuando la diferencia superó la zona segura,
    // así que la resta siempre da un número positivo.
    if (bothEvaluable) {
      const warnings = [];
      if (onuOk === false) warnings.push(`OP ONU al menos ${formatDb(onuDiff - OPTICAL_TOLERANCE_DB)} dB`);
      if (oltOk === false && check3.status !== "passed") {
        warnings.push(`OP OLT al menos ${formatDb(oltDiff - OPTICAL_TOLERANCE_DB)} dB`);
      }
      if (warnings.length > 0) {
        improvementWarning = `⚠️ Debe mejorar ${warnings.join(" y ")}`;
      }

      if (check3.status === "failed") {
        const check3Warning = "para que la relación ONU/OLT quede acorde al comportamiento de la caja.";
        improvementWarning = improvementWarning
          ? `${improvementWarning} ${check3Warning}`
          : `⚠️ Debe mejorar OP OLT ${check3Warning}`;
      }
    }
  } else {
    // Sin promedio calculable (caja no coincide, sin CSV, o caja sin OP
    // válidos): nunca se inventa un número ni se hace comparación óptica.
    lines.push(`- \`OP Cliente: ${onuClientPart}/${oltClientPart}\`⚠️`);
    lines.push(
      availableOpCount <= 1 && cajaRecords.length > 0
        ? "- Prom. de caja: no hay otro OP para comparar"
        : "- Prom. de caja: no se pudo obtener promedio de caja"
    );
  }

  // El mensaje motivacional solo aparece cuando el resultado final de ONU y
  // OLT está aprobado. Esto incluye el caso en que Check 3 haya aceptado el
  // OLT después de un fallo individual de Check 2.
  const bothApproved = onuOk === true && (oltOk === true || check3.status === "passed");
  const motivationalMessage = bothApproved
    ? computeMotivationalMessage(clientOnu, caja, cajaInfo, evalRecords.adjustedRecords, rand)
    : null;

  if (improvementWarning) {
    lines.push("");
    lines.push(improvementWarning);
  }

  if (motivationalMessage) {
    lines.push("");
    lines.push(motivationalMessage);
  }

  if (compatibilityWarning) {
    lines.push("");
    lines.push(compatibilityWarning);
  }

  return { text: lines.join("\n"), cajaWarning, compatibilityWarning };
}

// Parsea y valida la estructura del CSV, SIN aplicar todavía el fusible de MAX_ONUS
// (eso lo hace analyzeCSV más abajo, que es lo que hay que usar normalmente).
function parseRecordsFromCSV(text) {
  let rows;
  try {
    rows = parseCSV(text);
  } catch (e) {
    return { ok: false, code: "PARSE_ERROR" };
  }

  if (!rows || rows.length < 2) {
    return { ok: false, code: "EMPTY" };
  }

  const header = rows[0];

  const anyMatch = REQUIRED_COLUMNS.some((col) => findColumnIndex(header, col) !== -1);
  if (!anyMatch) {
    return { ok: false, code: "NOT_SMARTOLT" };
  }

  const colIndex = {};
  const missing = [];
  REQUIRED_COLUMNS.forEach((col) => {
    const idx = findColumnIndex(header, col);
    if (idx === -1) missing.push(col);
    else colIndex[col] = idx;
  });

  if (missing.length > 0) {
    return { ok: false, code: "MISSING_COLUMNS", missing };
  }

  // "SN" es opcional: si no está, serialIdx queda en -1 y cada fila recibe
  // serial: "" (comportamiento idéntico al anterior, sin consolidar nada).
  const serialIdx = findColumnIndex(header, SERIAL_COLUMN);

  const dataRows = rows.slice(1);
  const records = [];

  for (const r of dataRows) {
    const name = (r[colIndex["Name"]] || "").trim();
    const caja = (r[colIndex["ODB (Splitter)"]] || "").trim();
    const puerto = (r[colIndex["ODB Port"]] || "").trim();
    const status = (r[colIndex["Status"]] || "").trim();
    const lastChange = (r[colIndex["Last status change"]] || "").trim();
    const sig1310 = parseSignal(r[colIndex["Signal 1310"]]);
    const sig1490 = parseSignal(r[colIndex["Signal 1490"]]);
    const serial = serialIdx !== -1 ? (r[serialIdx] || "").trim() : "";

    if (!name && !caja && !puerto && !status) continue; // fila vacía

    records.push({ name, caja, puerto, status, lastChange, sig1310, sig1490, serial });
  }

  if (records.length === 0) {
    return { ok: false, code: "NO_ROWS" };
  }

  return { ok: true, records };
}

// SmartOLT nombra el archivo exportado con el OLT/Board/Port exacto del PON
// consultado (ej. "SmartOLT_oltid_4_board_3_port_2_onus_list_....csv"). Se usa
// SOLO para mostrar esa identidad en el mensaje de "supera el límite" — nunca
// para decidir si el CSV es válido (esa decisión sigue siendo el total de
// filas vs. MAX_ONUS, ver analyzeCSV). Si el nombre no trae ese patrón (por
// ejemplo, un CSV cargado a mano con otro nombre), no se inventa ningún PON:
// se devuelve null y el mensaje queda genérico.
function parsePonFromFileName(fileName) {
  if (!fileName) return null;
  const m = String(fileName).match(/oltid[_-]?(\d+).*?board[_-]?(\d+).*?port[_-]?(\d+)/i);
  if (!m) return null;
  return { oltId: m[1], board: m[2], port: m[3] };
}

function formatPonLabel(ponInfo) {
  if (!ponInfo) return null;
  return `OLT ${ponInfo.oltId} / Board ${ponInfo.board} / Port ${ponInfo.port}`;
}

// Mensaje único de "se superó el límite de ONUs de un PON", reutilizado tanto
// por la captura automática (background.js, vía chrome.storage.session) como
// por la carga manual de un CSV (popup.js), para que el texto sea siempre
// idéntico sin duplicar esta lógica en los dos lugares.
function formatOverLimitMessage(count, fileName) {
  const ponLabel = formatPonLabel(parsePonFromFileName(fileName));
  const ponPart = ponLabel ? `Este PON (${ponLabel})` : "Esta exportación";
  return `⚠️ ${ponPart} contiene ${count} ONUs. No se procesó porque supera el límite de ${MAX_ONUS} ONUs por PON.`;
}

// Punto de entrada único para procesar un CSV: valida estructura, aplica el
// fusible MAX_ONUS (el límite del PON que representa este CSV — ver el
// comentario de MAX_ONUS más arriba) y recién ahí calcula el análisis
// completo. Si se supera el límite, code = "OVER_LIMIT" y NO se calcula nada
// más (ni promedios, ni texto).
function analyzeCSV(text) {
  const parsed = parseRecordsFromCSV(text);
  if (!parsed.ok) return parsed;

  if (parsed.records.length > MAX_ONUS) {
    return { ok: false, code: "OVER_LIMIT", count: parsed.records.length };
  }

  return buildAnalysisResult(parsed.records);
}

// ---------- Firma del equipo (footer) + easter eggs de fechas especiales ----------
// Puramente basada en la fecha local del sistema — nunca se consulta Internet
// ni ningún servicio externo. El año SIEMPRE se calcula con
// `new Date().getFullYear()` (nunca queda un número fijo escrito), así que no
// hace falta tocar este archivo cuando cambie el año.
//
// Fuera de las fechas especiales de abajo, la firma es siempre:
//   Equipo CCT · [AÑO] · v[VERSIÓN] · Created by Gercsz
//
// La versión SIEMPRE se recibe como parámetro (nunca se escribe a mano acá):
// popup.js la lee dinámicamente de manifest.json vía chrome.runtime.getManifest()
// y se la pasa a getFooterSignatureContent, así el footer coincide siempre con
// la versión realmente instalada. Si no se recibe ninguna (p. ej. un llamador
// que todavía no la provee), el segmento de versión simplemente se omite —
// nunca se inventa un número.
//
// NOTA sobre "Día del Técnico de Fibra": no existe una fecha oficial única y
// universalmente reconocida para esta celebración, así que se eligió el 10 de
// agosto como fecha simbólica (no coincide con ninguna otra fecha especial de
// esta lista). Si el equipo prefiere otra fecha, alcanza con cambiar el
// "month"/"day" de esta entrada — el resto de la lógica no depende de cuál sea.
//
// NOTA sobre "temporada navideña" (v3.0.7): a diferencia de las demás fechas
// especiales (un día puntual), Navidad es un RANGO — desde
// NAVIDAD_THEME_START_MONTH/DAY hasta el 25/12 inclusive (nunca cruza a
// enero) — así que se resuelve aparte, tanto para la firma del footer como
// para el tema visual (ver getActiveTheme más abajo). Si el equipo quiere
// mover el inicio de la temporada, alcanza con cambiar esas dos constantes;
// arranca el 8/12 (1/12 al 7/12 quedan en tema normal).

// Normaliza la versión al formato pedido "vX.Y.Z" (antepone "v" si no lo
// trae ya) — null/"" no generan ningún segmento.
function formatFooterVersion(version) {
  if (!version) return null;
  const v = String(version).trim();
  if (!v) return null;
  return v.startsWith("v") ? v : `v${v}`;
}

const TEAM_SIGNATURE_BASE = (year, version) => {
  const versionLabel = formatFooterVersion(version);
  return versionLabel
    ? `Equipo CCT · ${year} · ${versionLabel} · Created by Gercsz`
    : `Equipo CCT · ${year} · Created by Gercsz`;
};

const NAVIDAD_THEME_START_MONTH = 12;
const NAVIDAD_THEME_START_DAY = 8;

function isChristmasSeason(month, day) {
  return month === NAVIDAD_THEME_START_MONTH && day >= NAVIDAD_THEME_START_DAY && day <= 25;
}

// Navidad NO está en esta lista: es un RANGO (ver isChristmasSeason arriba),
// no una fecha puntual, así que tiene su propia entrada separada
// (NAVIDAD_THEME) y se resuelve con prioridad antes de recorrer esta lista.
const SPECIAL_SIGNATURE_DATES = [
  { id: "anio-nuevo", month: 1, day: 1, emoji: "🎆", phrase: "Que este año todo sincronice. 📡" }, // Año Nuevo
  { id: "dia-internet", month: 5, day: 17, emoji: "📡", phrase: "Conectando todo, incluso los problemas." }, // Día Mundial de las Telecomunicaciones
  { id: "dia-tecnico", month: 8, day: 10, emoji: "🧑‍🔧", phrase: "Donde otros ven un cable, ellos vemos una solución." }, // Día del Técnico de Fibra (fecha simbólica, ver nota arriba)
  { id: "halloween", month: 10, day: 31, emoji: "🎃", phrase: "Noche de OP alto y LOS. 👻" }, // Halloween
];

const NAVIDAD_THEME = { id: "navidad", emoji: "🎄", phrase: "Este año, todas las luces en verde. 🟢" };

// Devuelve { line1, line2 } a partir de un objeto Date (por defecto, ahora
// mismo) y, opcionalmente, la versión de la extensión (string tipo "3.0.6",
// leída dinámicamente por el llamador desde manifest.json — nunca inventada
// acá). line2 es null fuera de las fechas especiales (no se muestra nada).
function getFooterSignatureContent(now, version) {
  const date = now instanceof Date ? now : new Date();
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();

  const base = TEAM_SIGNATURE_BASE(year, version);

  if (isChristmasSeason(month, day)) {
    return { line1: `${NAVIDAD_THEME.emoji} ${base}`, line2: NAVIDAD_THEME.phrase };
  }

  const special = SPECIAL_SIGNATURE_DATES.find((d) => d.month === month && d.day === day);

  if (!special) {
    return { line1: base, line2: null };
  }
  return { line1: `${special.emoji} ${base}`, line2: special.phrase };
}

// ---------- Tema visual por fecha especial (v3.0.7) ----------
// Puramente decorativo: determina qué "skin" de colores debe aplicar
// popup.js (agregando un atributo data-theme al <body>, ver popup.css para
// las reglas body[data-theme="..."]). Nunca toca colores funcionales de
// estado (los ✅/❌ y los emojis 🟢/🔴/⚫ de las lecturas de SmartOLT no
// cambian con el tema), nunca cambia estructura, tamaños, botones, textos ni
// ninguna lógica de datos — solo fondo/paneles/bordes/acento.
//
// Usa exactamente el mismo criterio de fecha que getFooterSignatureContent
// de arriba (misma lista de fechas puntuales + el mismo rango navideño), así
// que el tema visual y la firma del footer SIEMPRE coinciden. Fuera de toda
// fecha especial, el tema es "normal" (el actual, sin ningún cambio).
function getActiveTheme(now) {
  const date = now instanceof Date ? now : new Date();
  const month = date.getMonth() + 1;
  const day = date.getDate();

  if (isChristmasSeason(month, day)) return NAVIDAD_THEME.id;

  const special = SPECIAL_SIGNATURE_DATES.find((d) => d.month === month && d.day === day);
  return special ? special.id : "normal";
}

// ---------- Easter egg de los 6 toques sobre la firma ----------
// Secuencia fija de mensajes. Cada toque (mientras count < 6) avanza el
// contador en 1 y muestra el mensaje correspondiente; popup.js lo deja visible
// unos TAP_EASTER_EGG_DISPLAY_MS y después vuelve a mostrar la firma normal —
// pero el CONTADOR no se reinicia por eso: sigue donde quedó durante toda la
// instancia del popup, y solo vuelve a 0 al cerrar y volver a abrir la
// extensión (popup.js arranca con estado nuevo cada vez). Una vez que el
// contador llega a 6, cualquier toque posterior no hace absolutamente nada
// (advanceTapEasterEgg devuelve message: null para que popup.js sepa que no
// debe cambiar nada en la interfaz).
const TAP_EASTER_EGG_MESSAGES = [
  "Solo faltan 4 toques y serás desarrollador.",
  "¡Vamos! 3 más y estamos.",
  "Dale, ¿tanto te tardas?",
  'Chaque, ya casi tienes el secreto de "La Teoría del Todo".',
  "Felicidades, Ya eres desarrollador 🌚🤌",
  "Perdiste el poder. Eres un simple mortal nuevamente, por ansioso. 💀",
];

// Cuánto tiempo queda visible cada mensaje antes de volver a la firma normal.
const TAP_EASTER_EGG_DISPLAY_MS = 10000;

// Historial permanente de cambios visibles para operadores. Solo las entradas
// con notification.enabled generan una novedad pendiente.
const CHANGELOG_ENTRIES = [
  {
    version: "3.0.11",
    changes: [
      {
        title: "🔌 Compatibilidad ONU / OLT",
        text: "Ahora la extensión detecta cuando el fabricante de la ONU no es compatible con la OLT y muestra una advertencia.",
      },
      {
        title: "⚠️ Aviso en ONUs pendientes de habilitación",
        text: "Las ONUs que aparecen en /onu/unconfigured ahora muestran una advertencia cuando su serial no es compatible con la OLT correspondiente.",
      },
      {
        title: "🔄 Detección de ONUs cargadas dinámicamente",
        text: "La detección de incompatibilidades funciona también cuando SmartOLT carga o reemplaza dinámicamente las ONUs después de presionar \"Actualizar\".",
      },
      {
        title: "📋 Compatibilidad en la consulta de clientes",
        text: "La advertencia de incompatibilidad también se incluye en la consulta y en el texto generado para enviar por Telegram.",
      },
      {
        title: "⚠️ Aviso visual de compatibilidad",
        text: "Ahora, cuando una ONU no es compatible con la OLT, la ficha del cliente muestra una marca breve \"⚠️ No compatible\" junto al serial, con información adicional al pasar el mouse.",
      },
    ],
  },
  {
    version: "3.0.10",
    changes: [
      {
        title: "🛠️ Corrección al actualizar los datos",
        text: "Ahora la falta de una caja seleccionada en SmartOLT se trata como un aviso y no bloquea la consulta ni la generación del reporte.",
      },
    ],
  },
  {
    version: "3.0.9",
    changes: [
      {
        title: "🆕 Nueva forma de actualizar los datos",
        text: "Ahora podés obtener los datos de las cajas directamente desde la extensión.",
      },
      {
        title: "🆕 Previsualización del texto",
        text: "Ahora podés revisar exactamente qué texto copió la extensión para enviarlo por Telegram.",
      },
      {
        title: "👤 Consulta de clientes sin bloqueos innecesarios",
        text: "Ahora podés consultar y copiar los datos aunque falte caja, puerto, OP o promedio de caja.",
      },
      {
        title: "📍 Indicador de actualidad de la caja",
        text: "La caja actual se muestra en verde cuando está incluida en los datos cargados y en gris cuando falta, junto con un aviso para actualizar.",
      },
      {
        title: "🔔 Avisos operativos temporales",
        text: "Los avisos operativos importantes tienen prioridad sobre las novedades y aparecen temporalmente sin ocupar espacio de forma permanente.",
      },
      {
        title: "👀 Historial de versiones",
        text: "Podés consultar desde el pie de la extensión los cambios relevantes de cada versión.",
      },
    ],
    notifications: [
      {
        id: "update-csv-3.0.9",
        priority: 10,
        summary: "🆕 Ya no descargues el CSV manualmente: usá 🔄 Actualizar datos.",
        detail:
          "🆕 Nueva forma de actualizar los datos\n\nAhora podés obtener los datos de las cajas directamente desde la extensión.\n\n1. Seleccioná la/s caja/s en SmartOLT.\n2. Luego, en la extensión, presioná 🔄 Actualizar datos.\n3. Esperá a que finalice la exportación.\n\nListo. Ya podés consultar las cajas o los datos del cliente.",
      },
    ],
  },
  {
    version: "3.0.8",
    changes: [
      {
        title: "📄 Procesamiento de exportaciones SmartOLT",
        text: "La extensión procesa localmente los datos exportados y conserva las consultas existentes.",
      },
    ],
    notifications: [],
  },
];

function initialTapEasterEggState() {
  return { count: 0 };
}

// state: { count }. Devuelve { state, message }: "state" es el nuevo estado a
// guardar; "message" es el texto del toque actual, o null si el contador ya
// llegó a 6 antes de este toque (en ese caso NO pasa nada: ni se muestra
// ningún mensaje nuevo ni se toca el estado). Pura — no usa temporizadores
// (el auto-ocultamiento a los ~10s lo maneja popup.js con setTimeout, porque
// es responsabilidad de la interfaz, no de esta lógica).
function advanceTapEasterEgg(state) {
  const s = state || initialTapEasterEggState();

  if (s.count >= TAP_EASTER_EGG_MESSAGES.length) {
    // Contador ya en 6: cualquier toque posterior no hace absolutamente nada.
    return { state: s, message: null };
  }

  const nextCount = s.count + 1;
  return { state: { count: nextCount }, message: TAP_EASTER_EGG_MESSAGES[nextCount - 1] };
}

const SmartOLTShared = {
  MAX_ONUS,
  REQUIRED_COLUMNS,
  SMARTOLT_HOST_RE,
  CLIENT_PAGE_PATH_RE,
  ONU_CONFIGURED_PATH_RE,
  isClientPageUrl,
  isOnuConfiguredPageUrl,
  OPTICAL_TOLERANCE_DB,
  OLT_COMPATIBILITY_GROUPS,
  ONU_COMPATIBILITY_PREFIXES,
  ONU_OLT_COMPATIBILITY_WARNING,
  SMARTOLT_OLT_ID_MAP,
  SMARTOLT_OLT_DISPLAY_NAME_MAP,
  resolveSmartoltOltIdentifier,
  getOnuOltCompatibilityWarning,
  parseCSV,
  analyzeCSV,
  parseRecordsFromCSV,
  buildAnalysisResult,
  buildTelegramText,
  formatLastChange,
  naturalCompare,
  isLosOrPowerFailStatus,
  parseCajaPortLabel,
  normalizeCajaName,
  buildDataIdentity,
  buildCajaAverages,
  findCajaAverage,
  buildLosPowerFailReport,
  formatSpanishList,
  consolidateRecordsBySerial,
  classifyCajaProblemStatus,
  buildClientReport,
  normalizeSerialKey,
  normalizeCajaKey,
  normalizePuertoKey,
  findClientRecordIndex,
  buildClientEvaluationRecords,
  opticalDiff,
  isOpticalApproved,
  evaluateCheck3,
  computeMotivationalMessage,
  MOTIVATIONAL_BEST_IN_CAJA_MESSAGES,
  MOTIVATIONAL_BETTER_THAN_AVERAGE_MESSAGES,
  formatShortDateTime,
  prependCsvTimestamp,
  formatFooterVersion,
  getFooterSignatureContent,
  getActiveTheme,
  isChristmasSeason,
  NAVIDAD_THEME_START_MONTH,
  NAVIDAD_THEME_START_DAY,
  TAP_EASTER_EGG_MESSAGES,
  TAP_EASTER_EGG_DISPLAY_MS,
  CHANGELOG_ENTRIES,
  initialTapEasterEggState,
  advanceTapEasterEgg,
  parsePonFromFileName,
  formatPonLabel,
  formatOverLimitMessage,
};

// Disponible tanto en el service worker (importScripts) como en el popup (<script>).
if (typeof self !== "undefined") {
  self.SmartOLTShared = SmartOLTShared;
}
