"use strict";

const UNCONFIGURED_ROOT_ID = "existingUnconfiguredOnus";
const WARNING_ATTRIBUTE = "data-smartolt-onu-compatibility-warning";
let scanScheduled = false;

const HUAWEI_ONU_PREFIX = SmartOLTShared.ONU_COMPATIBILITY_PREFIXES.huawei;
const ZTE_ONU_PREFIX = SmartOLTShared.ONU_COMPATIBILITY_PREFIXES.zte;

// Tabla oficial de /onu/unconfigured: ID de OLT (parámetro olt del enlace
// "Autorizar") -> prefijo de serial esperado. Los IDs ausentes no se evalúan.
const UNCONFIGURED_OLT_COMPATIBILITY = {
  "2": HUAWEI_ONU_PREFIX, // OLT-E
  "3": HUAWEI_ONU_PREFIX, // OLT-C
  "4": HUAWEI_ONU_PREFIX, // OLT-A
  "5": HUAWEI_ONU_PREFIX, // OLT-D
  "6": HUAWEI_ONU_PREFIX, // OLT-B
  "7": HUAWEI_ONU_PREFIX, // OLT-A-PZA
  "8": HUAWEI_ONU_PREFIX, // OLT-A-WND
  "10": HUAWEI_ONU_PREFIX, // OLT-F-VBN
  "11": HUAWEI_ONU_PREFIX, // OLT-G-MRT
  "12": HUAWEI_ONU_PREFIX, // OLT-C-PAZ
  "13": HUAWEI_ONU_PREFIX, // OLT-D-ADH
  "15": ZTE_ONU_PREFIX, // OLT-A-ITU
  "16": ZTE_ONU_PREFIX, // OLT-A-ELD
};

function getUnconfiguredCompatibilityWarning(oltId, serial) {
  const expectedPrefix = UNCONFIGURED_OLT_COMPATIBILITY[String(oltId || "").trim()];
  const normalizedSerial = String(serial || "").trim().toUpperCase();
  if (!expectedPrefix || !normalizedSerial) return null;

  return normalizedSerial.startsWith(expectedPrefix)
    ? null
    : SmartOLTShared.ONU_OLT_COMPATIBILITY_WARNING;
}

function getAuthorizationData(link) {
  let url;
  try {
    url = new URL(link.getAttribute("href") || "", window.location.href);
  } catch (e) {
    return null;
  }

  const oltId = url.searchParams.get("olt");
  const serial = url.searchParams.get("sn");
  if (!oltId || !serial) return null;
  return { oltId, serial };
}

function getWarningElement(actionCell) {
  return actionCell.querySelector(`[${WARNING_ATTRIBUTE}]`);
}

function updateWarning(row, actionLink) {
  const actionCell = actionLink.closest("td") || actionLink.parentElement || row;
  const existingWarning = getWarningElement(actionCell);
  const authorizationData = getAuthorizationData(actionLink);
  const warning = authorizationData
    ? getUnconfiguredCompatibilityWarning(authorizationData.oltId, authorizationData.serial)
    : null;

  if (!warning) {
    if (existingWarning) existingWarning.remove();
    return;
  }

  if (existingWarning) return;

  const warningElement = document.createElement("span");
  warningElement.setAttribute(WARNING_ATTRIBUTE, "");
  warningElement.textContent = warning;
  actionCell.appendChild(warningElement);
}

function scanUnconfiguredOnus() {
  const root = document.getElementById(UNCONFIGURED_ROOT_ID);
  if (!root) return;

  const links = root.querySelectorAll("a.activateButton");
  links.forEach((link) => {
    const row = link.closest("tr.valign-center") || link.closest("tr") || link.parentElement;
    if (row) updateWarning(row, link);
  });
}

function scheduleScan() {
  if (scanScheduled) return;
  scanScheduled = true;
  setTimeout(() => {
    scanScheduled = false;
    scanUnconfiguredOnus();
  }, 0);
}

function isOwnWarningNode(node) {
  return node.nodeType === Node.ELEMENT_NODE &&
    (node.matches(`[${WARNING_ATTRIBUTE}]`) || node.querySelector(`[${WARNING_ATTRIBUTE}]`));
}

// Observer único del contenedor: se reconecta (disconnect/observe) cuando
// SmartOLT reemplaza #existingUnconfiguredOnus por AJAX.
let observedRoot = null;
const rootObserver = new MutationObserver((mutations) => {
  if (mutations.some((mutation) =>
    Array.from(mutation.addedNodes).some((node) => !isOwnWarningNode(node)) ||
    mutation.removedNodes.length > 0
  )) {
    scheduleScan();
  }
});

function attachToCurrentRoot() {
  const root = document.getElementById(UNCONFIGURED_ROOT_ID);
  if (root === observedRoot) return;

  rootObserver.disconnect();
  observedRoot = root;
  if (!root) return;

  rootObserver.observe(root, { childList: true, subtree: true });
  scheduleScan();
}

// El observer del documento solo detecta la aparición o el reemplazo del
// contenedor; no escanea filas por sí mismo.
new MutationObserver(attachToCurrentRoot)
  .observe(document.body || document.documentElement, { childList: true, subtree: true });
attachToCurrentRoot();
