"use strict";

const UNCONFIGURED_ROOT_ID = "existingUnconfiguredOnus";
const WARNING_ATTRIBUTE = "data-smartolt-onu-compatibility-warning";
let scanScheduled = false;

function getOltNamesById() {
  const result = {};
  const select = document.getElementById("olt");
  if (!select) return result;

  Array.from(select.options).forEach((option) => {
    const id = option.value.trim();
    const internalName = SmartOLTShared.resolveSmartoltOltIdentifier(id, option.textContent);
    if (internalName) result[id] = internalName;
  });
  return result;
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

function updateWarning(row, actionLink, oltNamesById) {
  const actionCell = actionLink.closest("td") || actionLink.parentElement || row;
  const existingWarning = getWarningElement(actionCell);
  const authorizationData = getAuthorizationData(actionLink);
  const internalOltName = authorizationData && oltNamesById[authorizationData.oltId];
  const warning = authorizationData
    ? SmartOLTShared.getOnuOltCompatibilityWarning(internalOltName, authorizationData.serial)
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

  const oltNamesById = getOltNamesById();
  const links = root.querySelectorAll("a.activateButton");
  links.forEach((link) => {
    const row = link.closest("tr.valign-center") || link.closest("tr") || link.parentElement;
    if (row) updateWarning(row, link, oltNamesById);
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
