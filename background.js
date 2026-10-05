"use strict";

/**
 * SmartOLT — Control de ONUs — service worker (Manifest V3)
 *
 * Captura únicamente una exportación previamente iniciada por el botón de esta
 * extensión. Las exportaciones iniciadas directamente en SmartOLT pasan sin
 * intervención.
 *
 * Este archivo NO:
 *   - hace click en ningún botón de SmartOLT ni simula ninguna acción del usuario;
 *   - llama /api/export/create ni /api/export/status/{job_id};
 *   - llama /onu/get_configured_list ni consulta ONUs individuales;
 *   - inicia ninguna exportación por su cuenta.
 *
 * La exportación la crea SIEMPRE SmartOLT con su propia autenticación, porque
 * el usuario apretó su botón "Exportar". Lo único que hacemos es:
 *   1) escuchar chrome.downloads.onCreated (API "downloads", ya declarada);
 *   2) quedarnos solo con las descargas cuya URL es exactamente el endpoint
 *      final y no-gateado que ya confirmamos que funciona con la sesión
 *      normal del navegador: GET https://<algo>.smartolt.com/export_download/file/{job_id}
 *   3) intentar cancelar esa descarga física (best-effort, nunca a costa de
 *      romper otras descargas del usuario);
 *   4) pedir nosotros mismos ese mismo archivo con fetch() + credentials
 *      "include" (exactamente el mecanismo ya verificado — sin API key, sin
 *      replicar ningún header privado) y guardarlo en chrome.storage.session
 *      (RAM de la sesión de Chrome, nunca disco; se pierde solo si se cierra
 *      Chrome del todo).
 *
 * La URL final es solo una señal candidata: no autoriza la captura por sí sola.
 */

importScripts("shared.js");

const STORAGE_KEY = "smartoltState";
const PENDING_EXPORTS_KEY = "smartoltPendingExports";
const UPDATE_STATUS_KEY = "smartoltUpdateStatus";
// Error de la última captura, separado de los datos válidos: un fallo nunca
// reemplaza ni borra smartoltState. Se elimina con la próxima carga válida.
const LAST_CAPTURE_ERROR_KEY = "smartoltLastCaptureError";

// Acepta cualquier subdominio de smartolt.com (ej. obercom.smartolt.com), no
// un dominio hardcodeado, para no atarse a un solo reseller.
// (Se reutiliza SmartOLTShared.SMARTOLT_HOST_RE, definido una sola vez en
// shared.js, para no duplicar esta lógica entre background.js y popup.js.)
const EXPORT_PATH_RE = /\/export_download\/file\//i;

function isSmartOltExportUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch (e) {
    return false;
  }
  return self.SmartOLTShared.SMARTOLT_HOST_RE.test(u.hostname) && EXPORT_PATH_RE.test(u.pathname);
}

function extractFilenameFromContentDisposition(headerValue) {
  if (!headerValue) return null;
  const starMatch = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(headerValue);
  if (starMatch) {
    try {
      return decodeURIComponent(starMatch[1].replace(/["']/g, "").trim());
    } catch (e) {
      // seguir con el intento simple de abajo
    }
  }
  const plainMatch = /filename="?([^";]+)"?/i.exec(headerValue);
  if (plainMatch) return plainMatch[1].trim();
  return null;
}

function defaultFileName() {
  const pad = (x) => String(x).padStart(2, "0");
  const d = new Date();
  return `smartolt_export_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(
    d.getHours()
  )}${pad(d.getMinutes())}.csv`;
}

// Guarda un resultado VÁLIDO y, en la misma escritura, descarta el error de la
// captura anterior. Devuelve false si storage.session no lo aceptó.
async function saveState(state) {
  try {
    await chrome.storage.session.set({ [STORAGE_KEY]: state });
  } catch (e) {
    // best-effort: si por lo que sea storage.session no está disponible, no
    // hay más red de contención posible acá (no usamos storage.local a propósito).
    return false;
  }
  try {
    await chrome.storage.session.remove(LAST_CAPTURE_ERROR_KEY);
  } catch (e) {
    // Los datos ya quedaron guardados; el aviso viejo puede cerrarse a mano.
  }
  return true;
}

async function saveCaptureError(error) {
  try {
    await chrome.storage.session.set({
      [LAST_CAPTURE_ERROR_KEY]: { ...error, failedAt: Date.now() },
    });
  } catch (e) {
    // Los datos válidos anteriores siguen intactos aunque no se registre el error.
  }
}

async function saveUpdateStatus(status, request, extra = {}) {
  try {
    await chrome.storage.session.set({
      [UPDATE_STATUS_KEY]: {
        status,
        requestId: request && request.requestId,
        updatedAt: Date.now(),
        ...extra,
      },
    });
  } catch (e) {
    // El procesamiento no depende de que el popup siga abierto.
  }
}

let claimQueue = Promise.resolve();

function claimPendingExport(item) {
  const operation = claimQueue.then(async () => {
    let stored;
    try {
      stored = await chrome.storage.session.get(PENDING_EXPORTS_KEY);
    } catch (e) {
      return null;
    }

    const now = Date.now();
    const pending = Array.isArray(stored[PENDING_EXPORTS_KEY]) ? stored[PENDING_EXPORTS_KEY] : [];
    const valid = pending.filter(
      (request) =>
        request &&
        request.status === "registered" &&
        Number.isInteger(request.tabId) &&
        typeof request.requestId === "string" &&
        request.requestId.length > 0 &&
        typeof request.host === "string" &&
        typeof request.pageUrl === "string" &&
        Number.isFinite(request.requestedAt) &&
        Number.isFinite(request.expiresAt) &&
        request.requestedAt <= now &&
        request.expiresAt > now
    );
    const itemUrl = new URL(item.url);
    const itemHost = itemUrl.hostname.toLowerCase();
    let candidates = valid.filter((request) => String(request.host || "").toLowerCase() === itemHost);

    // Sin referrer no existe una asociación segura entre la descarga y la
    // pestaña que registró la solicitud. En ese caso se prioriza el falso
    // negativo y la descarga sigue su curso normal.
    if (!item.referrer) {
      await chrome.storage.session.set({ [PENDING_EXPORTS_KEY]: valid });
      return null;
    }

    try {
      const referrerUrl = new URL(item.referrer);
      const referrerHost = referrerUrl.hostname.toLowerCase();
      candidates = candidates.filter((request) => {
        try {
          const pageUrl = new URL(request.pageUrl);
          return pageUrl.hostname.toLowerCase() === referrerHost && pageUrl.pathname === referrerUrl.pathname;
        } catch (e) {
          return false;
        }
      });
    } catch (e) {
      candidates = [];
    }

    // Si más de una solicitud podría corresponder, se elige no capturar.
    if (candidates.length !== 1) {
      await chrome.storage.session.set({ [PENDING_EXPORTS_KEY]: valid });
      return null;
    }

    const request = candidates[0];
    const remaining = valid.filter((candidate) => candidate.requestId !== request.requestId);
    await chrome.storage.session.set({ [PENDING_EXPORTS_KEY]: remaining });
    return request;
  });

  claimQueue = operation.catch(() => null);
  return operation;
}

// Descarga y procesa el CSV que SmartOLT ya generó (job creado y autenticado
// por la propia SmartOLT, no por nosotros). Es el único fetch que hacemos.
// Toda captura termina en "completed" o "failed", incluso ante una excepción
// inesperada, para que el popup nunca quede esperando una operación trabada.
async function captureExport(downloadUrl, request) {
  let completed = false;
  try {
    completed = await captureExportData(downloadUrl, request);
  } catch (e) {
    await saveCaptureError({ status: "capture_failed", reason: "exception" });
  }
  await saveUpdateStatus(completed ? "completed" : "failed", request, completed ? { capturedAt: completed } : {});
}

// Devuelve el capturedAt del resultado válido guardado, o false si falló.
async function captureExportData(downloadUrl, request) {
  await saveUpdateStatus("processing", request);
  let resp;
  try {
    resp = await fetch(downloadUrl, { credentials: "include" });
  } catch (e) {
    await saveCaptureError({ status: "capture_failed", reason: "network" });
    return false;
  }

  if (!resp.ok) {
    await saveCaptureError({ status: "capture_failed", reason: `http_${resp.status}` });
    return false;
  }

  const csvText = await resp.text();
  const fileName =
    extractFilenameFromContentDisposition(resp.headers.get("content-disposition")) ||
    defaultFileName();

  const result = self.SmartOLTShared.analyzeCSV(csvText);

  if (!result.ok && result.code === "OVER_LIMIT") {
    // Se guarda también el nombre de archivo: trae codificado el OLT/Board/Port
    // del PON (ver SmartOLTShared.parsePonFromFileName), así el popup puede
    // mostrar de qué PON se trata en el mensaje de "supera el límite".
    // El CSV no se guarda y los datos válidos anteriores quedan intactos.
    await saveCaptureError({ status: "over_limit", reason: "OVER_LIMIT", count: result.count, fileName });
    return false;
  }

  if (!result.ok) {
    await saveCaptureError({ status: "capture_failed", reason: result.code || "parse_error", fileName });
    return false;
  }

  // Se guarda el CSV crudo (byte a byte tal cual lo devolvió SmartOLT) para que
  // "Descargar último CSV" entregue exactamente ese contenido, sin volver a
  // serializarlo. Solo un resultado válido reemplaza lo anterior.
  const capturedAt = Date.now();
  const saved = await saveState({
    status: "captured",
    csvText,
    fileName,
    total: result.total,
    onlineCount: result.onlineCount,
    cajaCount: result.cajaCount,
    cajaNames: result.cajaNames,
    losCount: result.losCount,
    powerFailCount: result.powerFailCount,
    telegramText: result.telegramText,
    capturedAt,
    dataIdentity: self.SmartOLTShared.buildDataIdentity(result.records, {
      sourceUrl: request.pageUrl,
      tabId: request.tabId,
      capturedAt,
    }),
    requestedCajaNames: request.cajaNames || [],
  });
  if (!saved) {
    await saveCaptureError({ status: "capture_failed", reason: "storage", fileName });
    return false;
  }
  return capturedAt;
}

chrome.downloads.onCreated.addListener((item) => {
  if (!item || !item.url) return;
  if (!isSmartOltExportUrl(item.url)) return; // nunca tocar ninguna otra descarga

  claimPendingExport(item).then(async (request) => {
    if (!request) return;

    await saveUpdateStatus("generating", request);

    // Intento best-effort de cancelar la descarga física antes de que se guarde
  // en Descargas. Si ya se completó (archivo muy chico) o el cancel falla por
  // cualquier motivo, no se rompe nada: igual capturamos nuestra propia copia
  // por fetch más abajo, y el archivo original puede quedar en Descargas además
  // de la copia en memoria — comportamiento documentado, no se intenta borrar
  // nada del disco del usuario.
    try {
      chrome.downloads.cancel(item.id, () => {
        void chrome.runtime.lastError;
      });
    } catch (e) {
      // ignorar
    }

    await captureExport(item.url, request);
  }).catch(() => {
    // Sin rechazos sin manejar: si algo falla antes de capturar, el popup
    // considera vencida la operación en curso (ver UPDATE_STATUS_TIMEOUT_MS).
  });
});
