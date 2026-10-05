"use strict";

// Aviso visual de compatibilidad ONU/OLT en la ficha /onu/view/<id>.
// Solo lee el DOM (SN y el data-olt-id del enlace "mover ONU") y reutiliza la
// lógica de SmartOLTShared; no modifica datos, enlaces ni botones de SmartOLT.

const ONU_VIEW_WARNING_ATTRIBUTE = "data-smartolt-onu-view-compatibility-warning";
// Marca corta por estado (el texto completo queda como tooltip).
const ONU_VIEW_WARNING_SHORT_TEXTS = {
  [SmartOLTShared.ONU_COMPATIBILITY_STATUS.INCOMPATIBLE]: "⚠️ No compatible",
  [SmartOLTShared.ONU_COMPATIBILITY_STATUS.UNKNOWN_ONU]: "⚠️ ONU desconocida",
};
const ONU_VIEW_SCAN_DELAY_MS = 250;
let onuViewScanTimer = null;
// Aviso propio presente durante el escaneo actual; su texto se excluye al leer
// valores para que el SN leído no incluya la marca (p. ej. "⚠️ No compatible").
let currentWarningElement = null;

function normText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function textOf(el) {
  if (!el) return "";
  let text = el.textContent || "";
  if (currentWarningElement && el.contains(currentWarningElement)) {
    text = text.replace(currentWarningElement.textContent, "");
  }
  return normText(text);
}

// Misma búsqueda de etiqueta/valor que usa la consulta de cliente del popup
// (injectedExtractClientData en popup.js), para leer los mismos datos.
// Devuelve { element, value }: element es el nodo que contiene el valor.
function valueNearLabelElement(el, lower) {
  const tr = el.closest("tr");
  if (tr && (el.tagName === "TH" || el.tagName === "TD")) {
    const cells = Array.from(tr.children);
    const idx = cells.indexOf(el);
    for (let i = idx + 1; i < cells.length; i++) {
      const v = textOf(cells[i]);
      if (v) return { element: cells[i], value: v };
    }
  }

  if (el.tagName === "DT") {
    let sib = el.nextElementSibling;
    while (sib && sib.tagName !== "DD") sib = sib.nextElementSibling;
    if (sib) {
      const v = textOf(sib);
      if (v) return { element: sib, value: v };
    }
  }

  const raw = textOf(el);
  const inlineMatch = raw.match(/:\s*(.+)$/);
  if (inlineMatch && inlineMatch[1] && inlineMatch[1].trim()) {
    return { element: el, value: normText(inlineMatch[1]) };
  }

  const sibling = el.nextElementSibling;
  if (sibling) {
    const v = textOf(sibling);
    if (v && v.toLowerCase() !== lower) return { element: sibling, value: v };
  }

  const parent = el.parentElement;
  if (parent && parent.children.length === 2) {
    const other = Array.from(parent.children).find((c) => c !== el);
    if (other) {
      const v = textOf(other);
      if (v && v.toLowerCase() !== lower) return { element: other, value: v };
    }
  }
  return null;
}

// Devuelve { element, value } del valor asociado a la primera etiqueta que coincide.
function findLabelByNames(labels) {
  const normalizedLabels = labels.map((l) => l.toLowerCase());
  const all = Array.from(document.querySelectorAll("th,td,dt,label,span,div,strong,b,p"));
  for (const el of all) {
    if (el.closest(`[${ONU_VIEW_WARNING_ATTRIBUTE}]`)) continue;
    if (el.children && el.children.length > 2) continue;
    const raw = textOf(el);
    if (!raw) continue;
    const lower = raw.replace(/:\s*$/, "").toLowerCase();
    if (!normalizedLabels.some((l) => lower === l || lower === l + ":")) continue;
    const found = valueNearLabelElement(el, lower);
    if (found) return found;
  }
  return null;
}

// ID real de la OLT: data-olt-id del enlace "mover ONU" (mismo selector que el
// dashboard del popup). null si la ficha no lo trae (OLT no identificada).
function readOltId() {
  const link = document.querySelector('a.move-onu[data-show-olt="1"]') || document.querySelector("a.move-onu");
  const id = link ? String(link.getAttribute("data-olt-id") || "").trim() : "";
  return id || null;
}

function getOnuViewWarning() {
  const serial = findLabelByNames(["SN", "Serial", "Serial Number", "S/N"]);
  if (!serial) return null;

  const result = SmartOLTShared.evaluateOnuOltCompatibility(readOltId(), serial.value);
  if (!result.warning) return null;
  return {
    text: result.warning,
    shortText: ONU_VIEW_WARNING_SHORT_TEXTS[result.status] || result.warning,
    serialElement: serial.element,
  };
}

function updateOnuViewWarning() {
  const existing = document.querySelector(`[${ONU_VIEW_WARNING_ATTRIBUTE}]`);
  currentWarningElement = existing;
  const warning = getOnuViewWarning();
  currentWarningElement = null;

  if (!warning) {
    if (existing) existing.remove();
    return;
  }
  // Una sola marca: si ya está la misma no se toca; si cambió el caso, se reemplaza.
  if (existing) {
    if (existing.textContent === warning.shortText) return;
    existing.remove();
  }

  // Marca corta junto al valor del SN; el texto completo queda como tooltip.
  const warningElement = document.createElement("span");
  warningElement.setAttribute(ONU_VIEW_WARNING_ATTRIBUTE, "");
  warningElement.setAttribute("title", warning.text.replace(/^\s*⚠️\s*/, ""));
  warningElement.textContent = warning.shortText;
  warning.serialElement.appendChild(warningElement);
}

function scheduleOnuViewScan() {
  if (onuViewScanTimer) return;
  onuViewScanTimer = setTimeout(() => {
    onuViewScanTimer = null;
    updateOnuViewWarning();
  }, ONU_VIEW_SCAN_DELAY_MS);
}

function isOnuViewWarningNode(node) {
  return node.nodeType === Node.ELEMENT_NODE && node.matches(`[${ONU_VIEW_WARNING_ATTRIBUTE}]`);
}

// SmartOLT puede completar la ficha dinámicamente: se reevalúa ante cambios
// del DOM, ignorando los que produce el propio aviso.
new MutationObserver((mutations) => {
  if (mutations.some((mutation) =>
    Array.from(mutation.addedNodes).some((node) => !isOnuViewWarningNode(node)) ||
    Array.from(mutation.removedNodes).some((node) => !isOnuViewWarningNode(node))
  )) {
    scheduleOnuViewScan();
  }
}).observe(document.body || document.documentElement, { childList: true, subtree: true });

updateOnuViewWarning();
