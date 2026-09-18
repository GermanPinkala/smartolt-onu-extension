"use strict";

/**
 * SmartOLT — Control de ONUs — service worker (Manifest V3)
 *
 * ÚNICA responsabilidad: detectar cuando el USUARIO exporta un CSV desde la
 * propia interfaz de SmartOLT (botón "Exportar") y capturar ese CSV en
 * memoria de sesión, sin volver a tocar SmartOLT para nada más.
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
 * Nunca se toca ninguna otra descarga del usuario: si la URL no matchea el
 * patrón exacto de exportación de SmartOLT, este listener no hace nada.
 */

importScripts("shared.js");

const STORAGE_KEY = "smartoltState";

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

// Descarga y procesa el CSV que SmartOLT ya generó (job creado y autenticado
// por la propia SmartOLT, no por nosotros). Es el único fetch que hacemos.
async function captureExport(downloadUrl) {
  let resp;
  try {
    resp = await fetch(downloadUrl, { credentials: "include" });
  } catch (e) {
    await saveState({ status: "capture_failed", reason: "network", capturedAt: Date.now() });
    return;
  }

  if (!resp.ok) {
    await saveState({
      status: "capture_failed",
      reason: `http_${resp.status}`,
      capturedAt: Date.now(),
    });
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
    return;
  }

  if (!result.ok) {
    await saveState({
      status: "capture_failed",
      reason: result.code || "parse_error",
      capturedAt: Date.now(),
    });
    return;
  }

  // Se guarda el CSV crudo (byte a byte tal cual lo devolvió SmartOLT) para que
  // "Descargar último CSV" entregue exactamente ese contenido, sin volver a
  // serializarlo. Reemplaza siempre lo anterior — nunca se acumula.
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
    capturedAt: Date.now(),
  });
}

chrome.downloads.onCreated.addListener((item) => {
  if (!item || !item.url) return;
  if (!isSmartOltExportUrl(item.url)) return; // nunca tocar ninguna otra descarga

  // Intento best-effort de cancelar la descarga física antes de que se guarde
  // en Descargas. Si ya se completó (archivo muy chico) o el cancel falla por
  // cualquier motivo, no se rompe nada: igual capturamos nuestra propia copia
  // por fetch más abajo, y el archivo original puede quedar en Descargas además
  // de la copia en memoria — comportamiento documentado, no se intenta borrar
  // nada del disco del usuario.
  try {
    chrome.downloads.cancel(item.id, () => {
      // Se ignora chrome.runtime.lastError a propósito: un cancel que llega
      // tarde (descarga ya completa) no es un error que debamos reportar.
      void chrome.runtime.lastError;
    });
  } catch (e) {
    // ignorar
  }

  captureExport(item.url);
});
