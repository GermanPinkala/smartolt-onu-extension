"use strict";

/**
 * SmartOLT — Control — capa de perfiles (v4)
 *
 * Capa superior del popup: decide QUÉ interfaz se muestra según el perfil
 * guardado, sin mezclarse con la lógica de ningún perfil.
 *
 *   profile (chrome.storage.local, clave "profile")
 *   ├── "cct"        -> #appView + popup.js (interfaz y lógica de v3.1.1)
 *   │                   + dashboard.js (dashboards de cliente y de cajas)
 *   └── "callcenter" -> #appView + popup.js + dashboard.js
 *                       + callcenter.js (diagnóstico e informes de Call Center)
 *                       + cc-dashboard.js (su sección, botones y extensiones)
 *
 * - Sin perfil guardado (primera ejecución, o un valor desconocido) se muestra
 *   el selector (#profileSelectView).
 * - El perfil se guarda en chrome.storage.local (persiste entre aperturas del
 *   popup, reinicios de Chrome y del equipo). Solo se lee/escribe la clave
 *   "profile": cambiar de perfil nunca toca ninguna otra configuración.
 * - Los scripts de la vista principal se inyectan SOLO con un perfil activo,
 *   así su inicialización (lectura del CSV, listeners de pestañas, cierre
 *   automático, etc.) corre exactamente igual que en v3.1.1.
 * - <body data-profile="..."> indica el perfil activo: los elementos
 *   .profile-cct / .profile-callcenter solo se ven con su perfil (popup.css).
 *   Ningún script de perfil pregunta por el perfil: cada uno se carga o no.
 * - Al elegir un perfil se guarda y se recarga el popup: equivale a cerrarlo y
 *   volver a abrirlo, así cada perfil arranca siempre desde un estado limpio.
 *
 * Para agregar un perfil nuevo: sumar su entrada en PROFILES (vista,
 * etiqueta y scripts) y, si hace falta, sus elementos .profile-<id>.
 */

const PROFILE_STORAGE_KEY = "profile";

const profileViews = {
  select: document.getElementById("profileSelectView"),
  app: document.getElementById("appView"),
};

// Scripts de cada perfil, en orden: cada uno reutiliza funciones de los
// anteriores (async = false conserva el orden de ejecución).
const APP_SCRIPTS = ["popup.js", "dashboard.js"];

const PROFILES = {
  cct: { view: "app", label: "🛠️ CCT", scripts: APP_SCRIPTS },
  callcenter: { view: "app", label: "📞 CALL CENTER", scripts: [...APP_SCRIPTS, "callcenter.js", "cc-dashboard.js"] },
};

const profileCancelBtn = document.getElementById("profileCancelBtn");
const profileBarLabel = document.getElementById("profileBarLabel");

// Perfil con el que se abrió el popup (null si todavía no hay ninguno).
let activeProfile = null;
let appScriptsLoaded = false;

// Tema de fecha especial: popup.js ya lo aplica en la vista principal; se
// aplica también acá para que el selector use la misma paleta.
if (typeof SmartOLTShared !== "undefined") {
  const profileTheme = SmartOLTShared.getActiveTheme(new Date());
  if (profileTheme !== "normal") {
    document.body.setAttribute("data-theme", profileTheme);
  }
}

function isValidProfile(value) {
  return Object.prototype.hasOwnProperty.call(PROFILES, value);
}

function showProfileView(name) {
  Object.entries(profileViews).forEach(([key, el]) => {
    el.hidden = key !== name;
  });
}

// Cuando se ejecutó el ÚLTIMO script del perfil se avisa con el evento
// "profile-scripts-loaded": así dashboard.js arranca recién cuando todas las
// extensiones del perfil (p. ej. las de Call Center) ya están registradas.
const PROFILE_SCRIPTS_LOADED_EVENT = "profile-scripts-loaded";

function loadProfileScripts(scripts) {
  if (appScriptsLoaded) return;
  appScriptsLoaded = true;
  scripts.forEach((src, index) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = false;
    if (index === scripts.length - 1) {
      script.addEventListener("load", () => document.dispatchEvent(new Event(PROFILE_SCRIPTS_LOADED_EVENT)));
    }
    document.body.appendChild(script);
  });
}

function enterProfile(profile) {
  const config = PROFILES[profile];
  document.body.dataset.profile = profile;
  profileBarLabel.textContent = `Perfil: ${config.label}`;
  showProfileView(config.view);
  loadProfileScripts(config.scripts);
}

function showProfileSelector() {
  // "Cancelar" solo tiene sentido si ya hay un perfil al que volver.
  profileCancelBtn.hidden = !activeProfile;
  showProfileView("select");
}

async function selectProfile(profile) {
  if (!isValidProfile(profile)) return;
  try {
    await chrome.storage.local.set({ [PROFILE_STORAGE_KEY]: profile });
  } catch (e) {
    // Si no se puede guardar, se entra igual al perfil elegido solo por esta
    // vez (la próxima apertura volverá a preguntar). Si ya había scripts de
    // otro perfil cargados, se recarga igual para no mezclarlos.
    if (appScriptsLoaded) {
      location.reload();
      return;
    }
    activeProfile = profile;
    enterProfile(profile);
    return;
  }
  location.reload();
}

async function loadProfile() {
  let stored = null;
  try {
    const result = await chrome.storage.local.get(PROFILE_STORAGE_KEY);
    stored = result ? result[PROFILE_STORAGE_KEY] : null;
  } catch (e) {
    stored = null;
  }

  if (isValidProfile(stored)) {
    activeProfile = stored;
    enterProfile(stored);
  } else {
    showProfileSelector();
  }
}

// ---------- Eventos ----------

document.querySelectorAll(".profile-option").forEach((btn) => {
  btn.addEventListener("click", () => selectProfile(btn.dataset.profile));
});

document.querySelectorAll(".js-change-profile").forEach((btn) => {
  btn.addEventListener("click", showProfileSelector);
});

profileCancelBtn.addEventListener("click", () => {
  if (activeProfile) enterProfile(activeProfile);
});

// Cierre del popup al perder el foco mientras solo está el selector (mismo
// criterio que popup.js). Con la vista principal cargada no se hace nada acá:
// popup.js ya tiene su propio cierre, que además se suspende al abrir el
// selector de archivos — duplicarlo lo rompería.
window.addEventListener("blur", () => {
  if (appScriptsLoaded) return;
  setTimeout(() => {
    if (appScriptsLoaded) return;
    if (!document.hasFocus()) {
      window.close();
    }
  }, 0);
});

loadProfile();
