"use strict";

const UNCONFIGURED_ROOT_ID = "existingUnconfiguredOnus";
const WARNING_ATTRIBUTE = "data-smartolt-onu-compatibility-warning";
let scanScheduled = false;

// Marca corta por estado, igual que en la ficha (onu-view.js); el texto
// completo queda como tooltip.
const UNCONFIGURED_WARNING_SHORT_TEXTS = {
  [SmartOLTShared.ONU_COMPATIBILITY_STATUS.INCOMPATIBLE]: "⚠️ No compatible",
  [SmartOLTShared.ONU_COMPATIBILITY_STATUS.UNKNOWN_ONU]: "⚠️ ONU desconocida",
};

// ID de OLT (parámetro olt del enlace "Autorizar") + serial (parámetro sn),
// evaluados con la matriz oficial única de SmartOLTShared. Devuelve
// { text, shortText } o null si no hay nada que avisar.
function getUnconfiguredCompatibilityWarning(oltId, serial) {
  const result = SmartOLTShared.evaluateOnuOltCompatibility(oltId, serial);
  if (!result.warning) return null;
  return {
    text: result.warning,
    shortText: UNCONFIGURED_WARNING_SHORT_TEXTS[result.status] || result.warning,
  };
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

  // Un solo aviso por fila: si ya está el mismo no se toca; si cambió, se reemplaza.
  if (existingWarning) {
    if (existingWarning.textContent === warning.shortText) return;
    existingWarning.remove();
  }

  const warningElement = document.createElement("span");
  warningElement.setAttribute(WARNING_ATTRIBUTE, "");
  warningElement.setAttribute("title", warning.text.replace(/^\s*⚠️\s*/, ""));
  warningElement.textContent = warning.shortText;
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
