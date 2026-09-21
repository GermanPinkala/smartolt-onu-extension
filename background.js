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

async function saveState(state) {
  try {
    await chrome.storage.session.set({ [STORAGE_KEY]: state });
  } catch (e) {
    // best-effort: si por lo que sea storage.session no está disponible, no
    // hay más red de contención posible acá (no usamos storage.local a propósito).
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
async function captureExport(downloadUrl, request) {
  await saveUpdateStatus("processing", request);
  let resp;
  try {
    resp = await fetch(downloadUrl, { credentials: "include" });
  } catch (e) {
    await saveState({ status: "capture_failed", reason: "network", capturedAt: Date.now() });
    await saveUpdateStatus("failed", request);
    return;
  }

  if (!resp.ok) {
    await saveState({
      status: "capture_failed",
      reason: `http_${resp.status}`,
      capturedAt: Date.now(),
    });
    await saveUpdateStatus("failed", request);
    return;
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
    await saveState({ status: "over_limit", count: result.count, fileName, capturedAt: Date.now() });
    await saveUpdateStatus("failed", request);
    return;
  }

  if (!result.ok) {
    await saveState({
      status: "capture_failed",
      reason: result.code || "parse_error",
      capturedAt: Date.now(),
    });
    await saveUpdateStatus("failed", request);
    return;
  }

  // Se guarda el CSV crudo (byte a byte tal cual lo devolvió SmartOLT) para que
  // "Descargar último CSV" entregue exactamente ese contenido, sin volver a
  // serializarlo. Reemplaza siempre lo anterior — nunca se acumula.
  const capturedAt = Date.now();
  await saveState({
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
  await saveUpdateStatus("completed", request, { capturedAt });
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
  });
});
