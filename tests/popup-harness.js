"use strict";

// Harness compartido por los tests de integración del popup (CCT): carga el
// popup.html real con sus scripts (shared.js, popup.js, dashboard.js) en
// jsdom. Las funciones que la extensión inyecta en la pestaña
// (chrome.scripting.executeScript) se ejecutan de verdad contra un segundo DOM
// que reproduce la página activa (SmartOLT u otra).

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.join(__dirname, "..");

let serialSeq = 0;
function row(name, caja, puerto, status, sig1490 = "", sig1310 = "") {
  serialSeq++;
  return [name, caja, puerto, status, "", sig1310, sig1490, `HWTC${String(serialSeq).padStart(8, "0")}`].join(",");
}
function csv(rows) {
  return ["Name,ODB (Splitter),ODB Port,Status,Last status change,Signal 1310,Signal 1490,SN", ...rows].join("\n");
}
const HEALTHY = [
  row("Ref Uno", "A6DB4", 1, "Online", -20.0, -23.0),
  row("Ref Dos", "A6DB4", 2, "Online", -20.2, -23.1),
  row("Ref Tres", "A6DB4", 3, "Online", -20.1, -23.2),
  row("Ref Cuatro", "A6DB4", 4, "Online", -20.3, -23.0),
];

const CONFIGURED_URL = "https://demo.smartolt.com/onu/configured";

const CONFIGURED_PAGE = (cajas) =>
  `<!doctype html><html><body><select id="odb" multiple>${cajas
    .map((c) => `<option value="1" selected>${c}</option>`)
    .join("")}</select></body></html>`;

// Ficha de cliente (estructura relevada en SmartOLT, anonimizada).
function fichaHtml({ status = "Online", signal = "-20.50 dBm / -23.40 dBm (1500m)", nap = "A6DB4 (Puerto 5)", odbPort = "5", serial = "HWTC00000099" } = {}) {
  return `<!doctype html><html><body><dl>
  <dt>OLT</dt><dd><a class="move-onu" data-olt-id="4" data-board="6" data-port="13" data-show-olt="1">4 - OLT-A</a></dd>
  <dt>SN</dt><dd>${serial}</dd><dt>Zona</dt><dd>OBE-OLT-A</dd><dt>Nombre</dt><dd>Cliente Demo</dd>
  <dt>NAP (Divisor)</dt><dd><a href="#" class="update-location-details" data-odb-id="1" data-odb-port="${odbPort}">${nap}</a></dd>
  <dt>Estado</dt><dd><span id="onu_status_value">${status}(1 hora hace)</span></dd>
  <dt>Señal</dt><dd id="signal_wrapper">${signal}</dd>
  <dt>WAN</dt><dd><a class="update-mode" data-username="a6db45" data-password="NO-LEER">PPPoE</a></dd>
</dl></body></html>`;
}
const FICHA = fichaHtml();

// Respuesta por defecto de los endpoints de la ficha.
function defaultFetch(url) {
  if (url.includes("/api/onu/get_onu_status_and_signal/")) {
    return { status: true, onu_status: "Online", last_status_change_unix: 1 };
  }
  return null;
}

// fetchHandler(url, options) devuelve el JSON (objeto) o el texto (string)
// que respondería SmartOLT para esa URL.
async function openPopup({ localStore = null, version = "3.1.1", tabUrl, pageHtml, csvRows, fetchHandler = defaultFetch, capturedAt = Date.now() }) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => {
    if (!/navigation|not implemented/i.test(e.message)) errors.push(e);
  });
  const calls = { statusFetchWorlds: [], injections: [], fetches: [], clipboard: null };
  // Pestaña activa simulada; navigate() la cambia durante la sesión.
  const tab = { url: tabUrl, dom: null };
  const loadTab = (url, html) => {
    if (tab.dom) tab.dom.window.close();
    tab.url = url;
    tab.dom = new JSDOM(html, { runScripts: "outside-only", url });
    tab.dom.window.config = { X_TOKEN: "TOKEN-DE-PRUEBA" };
    tab.dom.window.fetch = async (url, options) => {
      calls.fetches.push({ url: String(url), headers: options && options.headers });
      const body = fetchHandler(String(url), options);
      const text = typeof body === "string" ? body : JSON.stringify(body);
      return { status: 200, ok: true, json: async () => JSON.parse(text), text: async () => text };
    };
  };
  loadTab(tabUrl, pageHtml);
  // local: "disco" de chrome.storage.local; se puede pasar uno propio para
  // simular varias aperturas del popup con el mismo almacenamiento.
  const local = localStore || {};
  const session = csvRows
    ? { smartoltState: { status: "captured", total: csvRows.length, onlineCount: 0, csvText: csv(csvRows), fileName: "x.csv", capturedAt } }
    : {};
  const area = (store) => ({
    async get(k) {
      const out = {};
      (k == null ? Object.keys(store) : [].concat(k)).forEach((x) => {
        if (x in store) out[x] = store[x];
      });
      return out;
    },
    async set(o) {
      Object.assign(store, o);
    },
    async remove() {},
  });
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, "popup.html"), "utf8"), {
    url: pathToFileURL(path.join(ROOT, "popup.html")).href,
    runScripts: "dangerously",
    resources: "usable",
    virtualConsole: vc,
    pretendToBeVisual: true,
    beforeParse(w) {
      w.chrome = {
        storage: { local: area(local), session: area(session), onChanged: { addListener() {} } },
        tabs: { query: async () => [{ id: 1, url: tab.url }], onUpdated: { addListener() {} }, onActivated: { addListener() {} } },
        runtime: { getManifest: () => ({ version }) },
        scripting: {
          executeScript: async ({ func, args = [], world }) => {
            calls.injections.push({ name: func.name, url: tab.url, world: world || "ISOLATED" });
            // Como Chrome: sin permiso de host fuera de SmartOLT no se puede inyectar.
            if (!/\.smartolt\.com\//.test(tab.url)) throw new Error("Cannot access contents of the page");
            if (func.name === "injectedFetchOnuStatus") calls.statusFetchWorlds.push(world);
            const result = await tab.dom.window.eval(`(${func.toString()})(...${JSON.stringify(args)})`);
            return [{ result: result === undefined ? null : JSON.parse(JSON.stringify(result)) }];
          },
        },
      };
      w.close = () => {};
      w.navigator.clipboard = {
        writeText: async (text) => {
          calls.clipboard = text;
        },
      };
    },
  });
  const w = dom.window;
  await new Promise((r) => w.addEventListener("load", r));
  await new Promise((r) => setTimeout(r, 2600)); // la lectura de la ficha reintenta hasta 2 s
  const $ = (id) => w.document.getElementById(id);
  return {
    w,
    $,
    errors,
    calls,
    local,
    boxes: () => Array.from(w.document.querySelectorAll("#boxDashboard .bd-box-header")),
    cats: () => Array.from(w.document.querySelectorAll("#boxDashboard .bd-cat")),
    // Cambia la pestaña activa y vuelve a calcular el dashboard (como al
    // cambiar de pestaña o reabrir el popup).
    async navigate(url, html = "<html><body></body></html>") {
      loadTab(url, html);
      await w.refreshDashboard();
    },
    visible(el) {
      // Visible = sin [hidden] propio ni de ancestros y sin display:none por CSS.
      for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
        if (node.hidden || w.getComputedStyle(node).display === "none") return false;
      }
      return true;
    },
    close() {
      w.close();
      tab.dom.window.close();
    },
  };
}

module.exports = { ROOT, row, csv, HEALTHY, CONFIGURED_URL, CONFIGURED_PAGE, fichaHtml, FICHA, openPopup };
