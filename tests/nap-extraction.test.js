"use strict";

// Regresión: extracción de caja/puerto del bloque "NAP (Divisor)" de la ficha
// /onu/view de SmartOLT. Correr con: cd tests && npm install && npm test
//
// Los fixtures reproducen la estructura observada en SmartOLT (2026-09),
// anonimizada: <dt>NAP (Divisor) + ícono</dt> -> <dd> con
// <span class="onu-odb-glyph"><svg/></span> y
// <a class="update-location-details" data-odb-id data-odb-port>.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");

// ---------- Carga de shared.js (igual que en el popup: expone self.SmartOLTShared) ----------
function loadShared() {
  const ctx = vm.createContext({ self: {}, console });
  vm.runInContext(fs.readFileSync(path.join(ROOT, "shared.js"), "utf8"), ctx, { filename: "shared.js" });
  return ctx.self.SmartOLTShared;
}
const S = loadShared();

// Extrae el código fuente de una función top-level de popup.js (popup.js no se
// puede cargar entero en Node porque toca la UI al cargarse).
// Se normalizan los finales de línea (el repo puede tener CRLF en Windows).
const POPUP_SRC = fs.readFileSync(path.join(ROOT, "popup.js"), "utf8").replace(/\r\n/g, "\n");
function popupFunctionSource(name) {
  const start = POPUP_SRC.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start !== -1, `popup.js no define ${name}`);
  const end = POPUP_SRC.indexOf("\n}\n", start);
  assert.ok(end !== -1, `no se encontró el cierre de ${name}`);
  return POPUP_SRC.slice(start, end + 2);
}

// Ejecuta una función inyectable dentro del DOM (como chrome.scripting.executeScript:
// se serializa con toString, sin closures, y el resultado se clona).
async function runInjected(html, fnSource) {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://demo.smartolt.com/onu/view/1" });
  const result = await dom.window.eval(`(${fnSource})()`);
  dom.window.close();
  return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
}

async function extractNap(html) {
  const raw = await runInjected(html, S.readNapDivisorBlock.toString());
  return S.resolveNapCajaPort(raw);
}

// ---------- Fixtures ----------
const GLYPH = '<span class="onu-odb-glyph"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M8 0a5 5 0 0 0-5 5c0 4 5 11 5 11s5-7 5-11a5 5 0 0 0-5-5z"/></svg></span>';

function page(napDt, napDd, extra = "") {
  return `<!doctype html><html><body>
    <h2>Cliente Demo</h2>
    <div class="panel"><dl class="dl-horizontal">
      <dt>Name</dt><dd>CLIENTE DEMO 001</dd>
      <dt>SN</dt><dd>HWTC00000001</dd>
      <dt>Zona</dt><dd>OBE-OLT-D</dd>
      <dt>Puerto</dt><dd>gpon-onu_1/2/3:4</dd>
      ${napDt}
      ${napDd}
    </dl></div>
    ${extra}
    <div id="signal_wrapper">-20.10 dBm / -24.30 dBm</div>
  </body></html>`;
}

const DT = '<dt>NAP (Divisor) <i class="fa fa-map-marker"></i></dt>';
function anchor(text, attrs = 'data-odb-id="4821" data-odb-port="7"') {
  return `<a href="#" class="update-location-details" ${attrs}>${text}</a>`;
}

const FIX = {
  current: page(DT, `<dd>${GLYPH}\n  ${anchor("D60B5 (Puerto 7)")}\n</dd>`),
  svgTitle: page(
    DT,
    `<dd><span class="onu-odb-glyph"><svg><title>Ubicación de la NAP</title><desc>pin</desc><path d="M0 0"/></svg></span>${anchor("D60B5 (Puerto 7)")}</dd>`
  ),
  legacyDdPort: page("<dt>NAP (Divisor)</dt>", "<dd>D60B5 (Port 7)</dd>"),
  legacyTable: `<table><tr><th>SN</th><td>HWTC00000001</td></tr><tr><td>NAP (Divisor)</td><td>D60B5 (Port 7)</td></tr></table>`,
  legacyInline: `<div class="info"><div>Zona: OBE-OLT-D</div><div>NAP (Divisor): D60B5 (Port 7)</div></div>`,
  legacyInlineBold: `<div><b>NAP (Divisor):</b> D60B5 (Port 7)</div>`,
  icons: page(
    DT,
    `<dd><i class="fa fa-sitemap"></i><img src="data:," alt=""><span class="ico">📍</span>${GLYPH}${anchor("D60B5 (Puerto 7)")}<span>🔗</span><i class="fa fa-pencil"></i></dd>`
  ),
  emojiBefore: page(DT, `<dd>${GLYPH}${anchor("📍 D60B5 (Puerto 7)")}</dd>`),
  emojiAfter: page(DT, `<dd>${GLYPH}${anchor("D60B5 (Puerto 7) 🔗")}</dd>`),
  emojiText: page(DT, `<dd>📍 ${anchor("D60B5 (Puerto 7)")} 🔗</dd>`),
  whitespace: page(DT, `<dd>\n\t${GLYPH}\n\t${anchor("\n\t  D60B5 \n (  Puerto \t 7 )\n")}\n</dd>`),
  attrOnly: page(DT, `<dd>${GLYPH}${anchor("D60B5")}</dd>`),
  attrMissing: page(DT, `<dd>${GLYPH}${anchor("D60B5 (Puerto 7)", 'data-odb-id="4821"')}</dd>`),
  attrMissingPort: page(DT, `<dd>${GLYPH}${anchor("D60B5 (Port 7)", "")}</dd>`),
  conflict: page(DT, `<dd>${GLYPH}${anchor("D60B5 (Puerto 8)")}</dd>`),
  noPort: page(DT, `<dd>${GLYPH}${anchor("D60B5", "")}</dd>`),
  portZero: page(DT, `<dd>${GLYPH}${anchor("D60B5", 'data-odb-port="0"')}</dd>`),
  noCaja: page(DT, `<dd>${GLYPH}${anchor("(Puerto 7)")}</dd>`),
  emptyDd: page(DT, "<dd>-</dd>"),
  placeholder: page(DT, "<dd>N/A</dd>"),
  noNap: page("", ""),
  dtChildren: page(
    '<dt><span class="lbl">NAP</span> <span>(Divisor)</span><b>:</b> <i class="fa fa-info"></i><svg><title>Info</title></svg><span class="badge">?</span></dt>',
    `<dd>${GLYPH}${anchor("D60B5 (Puerto 7)")}</dd>`
  ),
  dtEmoji: page("<dt>📍 NAP (Divisor):</dt>", `<dd>${GLYPH}${anchor("D60B5 (Puerto 7)")}</dd>`),
  dtHint: page("<dt>NAP (Divisor) <small>ver mapa</small></dt>", `<dd>${GLYPH}${anchor("D60B5 (Puerto 7)")}</dd>`),
  ddTextWithWord: page(DT, "<dd>Ubicación D60B5 (Puerto 7)</dd>"),
  ddTextTwoWordsNoPort: page(DT, "<dd>Ubicación D60B5</dd>"),
  dtWithoutDd: `<dl><dt>NAP (Divisor)</dt></dl>`,
};

const EXPECTED = {
  current: { caja: "D60B5", puerto: "7", portSource: "attribute", conflict: false },
  svgTitle: { caja: "D60B5", puerto: "7", portSource: "attribute", conflict: false },
  legacyDdPort: { caja: "D60B5", puerto: "7", portSource: "text", conflict: false },
  legacyTable: { caja: "D60B5", puerto: "7", portSource: "text", conflict: false },
  legacyInline: { caja: "D60B5", puerto: "7", portSource: "text", conflict: false },
  legacyInlineBold: { caja: "D60B5", puerto: "7", portSource: "text", conflict: false },
  icons: { caja: "D60B5", puerto: "7", portSource: "attribute", conflict: false },
  emojiBefore: { caja: "D60B5", puerto: "7", portSource: "attribute", conflict: false },
  emojiAfter: { caja: "D60B5", puerto: "7", portSource: "attribute", conflict: false },
  emojiText: { caja: "D60B5", puerto: "7", portSource: "attribute", conflict: false },
  whitespace: { caja: "D60B5", puerto: "7", portSource: "attribute", conflict: false },
  attrOnly: { caja: "D60B5", puerto: "7", portSource: "attribute", conflict: false },
  attrMissing: { caja: "D60B5", puerto: "7", portSource: "text", conflict: false },
  attrMissingPort: { caja: "D60B5", puerto: "7", portSource: "text", conflict: false },
  conflict: { caja: "D60B5", puerto: null, portSource: null, conflict: true },
  noPort: { caja: "D60B5", puerto: null, portSource: null, conflict: false },
  portZero: { caja: "D60B5", puerto: null, portSource: null, conflict: false },
  noCaja: { caja: null, puerto: "7", portSource: "attribute", conflict: false },
  emptyDd: { caja: null, puerto: null, portSource: null, conflict: false },
  placeholder: { caja: null, puerto: null, portSource: null, conflict: false },
  noNap: { caja: null, puerto: null, portSource: null, conflict: false },
  dtChildren: { caja: "D60B5", puerto: "7", portSource: "attribute", conflict: false },
  dtEmoji: { caja: "D60B5", puerto: "7", portSource: "attribute", conflict: false },
  dtHint: { caja: "D60B5", puerto: "7", portSource: "attribute", conflict: false },
  ddTextWithWord: { caja: "D60B5", puerto: "7", portSource: "text", conflict: false },
  ddTextTwoWordsNoPort: { caja: null, puerto: null, portSource: null, conflict: false },
  dtWithoutDd: { caja: null, puerto: null, portSource: null, conflict: false },
};

// ---------- 1. Extracción por fixture ----------
for (const [name, html] of Object.entries(FIX)) {
  test(`NAP fixture "${name}"`, async () => {
    const got = await extractNap(html);
    const e = EXPECTED[name];
    assert.equal(got.caja, e.caja, "caja");
    assert.equal(got.puerto, e.puerto, "puerto");
    assert.equal(got.portSource, e.portSource, "portSource");
    assert.equal(got.conflict, e.conflict, "conflict");
  });
}

// ---------- 2. Invariantes sobre TODOS los fixtures ----------
test("invariante: la caja nunca contiene (Puerto N)/(Port N), paréntesis ni decoraciones", async () => {
  for (const [name, html] of Object.entries(FIX)) {
    const { caja } = await extractNap(html);
    if (caja === null) continue;
    assert.doesNotMatch(caja, /puerto|port/i, name);
    assert.doesNotMatch(caja, /[()]/, name);
    assert.match(caja, /^[A-Za-z0-9](?:[A-Za-z0-9._/-]| (?=[A-Za-z0-9]))*$/, name);
  }
});

test("invariante: con conflicto nunca hay puerto", async () => {
  for (const [name, html] of Object.entries(FIX)) {
    const got = await extractNap(html);
    if (got.conflict) assert.equal(got.puerto, null, name);
  }
});

test("data-odb-id se conserva solo como dato de diagnóstico", async () => {
  const got = await extractNap(FIX.current);
  assert.equal(got.odbId, "4821");
  assert.equal(got.source, "anchor");
});

// ---------- 3. resolveNapCajaPort (pura) ----------
test("resolveNapCajaPort: entradas vacías", () => {
  for (const raw of [null, undefined, {}, { found: false }]) {
    const got = S.resolveNapCajaPort(raw);
    assert.equal(got.caja, null);
    assert.equal(got.puerto, null);
  }
});

test("resolveNapCajaPort: dos puertos distintos en el texto = conflicto", () => {
  const got = S.resolveNapCajaPort({ found: true, source: "dd-text", text: "D60B5 (Port 7) (Puerto 8)" });
  assert.equal(got.puerto, null);
  assert.equal(got.conflict, true);
});

// ---------- 4. parseCajaPortLabel (usada para las opciones de #odb) ----------
test("parseCajaPortLabel acepta Port y Puerto", () => {
  assert.deepEqual({ ...S.parseCajaPortLabel("D60B5 (Port 7)") }, { caja: "D60B5", puerto: "7" });
  assert.deepEqual({ ...S.parseCajaPortLabel("D60B5 (Puerto 7)") }, { caja: "D60B5", puerto: "7" });
  assert.deepEqual({ ...S.parseCajaPortLabel("  D60B5  ( puerto : 7 ) ") }, { caja: "D60B5", puerto: "7" });
  assert.deepEqual({ ...S.parseCajaPortLabel("D60B5") }, { caja: "D60B5", puerto: null });
});

// ---------- 5. Las dos rutas usan la misma extracción ----------
test("popup.js: consulta de cliente y contexto de caja usan readNapFromTab", () => {
  assert.match(popupFunctionSource("handleObtenerCliente"), /readNapFromTab\(tab\.id\)/);
  assert.match(popupFunctionSource("getCurrentCajaContext"), /readNapFromTab\(tab\.id\)/);
  assert.match(popupFunctionSource("readNapFromTab"), /SmartOLTShared\.readNapDivisorBlock/);
  assert.match(popupFunctionSource("readNapFromTab"), /SmartOLTShared\.resolveNapCajaPort/);
  assert.doesNotMatch(POPUP_SRC, /findNapDivisorValue|NAP_DIVISOR_LABEL_RE|napLabelRe/);
});

test("injectedExtractClientData ya no devuelve caja cruda y conserva nombre/SN/Zona/señal", async () => {
  const data = await runInjected(FIX.current, popupFunctionSource("injectedExtractClientData"));
  assert.equal(data.caja, null);
  assert.equal(data.puerto, null);
  assert.equal(data.name, "CLIENTE DEMO 001");
  assert.equal(data.serial, "HWTC00000001");
  assert.equal(data.oltName, "OBE-OLT-D");
  assert.equal(data.sig1490, -20.1);
  assert.equal(data.sig1310, -24.3);
});

test("readCurrentCajaContext: #odb sigue igual; en la ficha delega en el lector NAP", async () => {
  const src = popupFunctionSource("readCurrentCajaContext");
  const odb = await runInjected(
    '<select id="odb" multiple><option selected>D60B5</option><option>X1</option><option selected>A47B1</option></select>',
    src
  );
  assert.deepEqual(odb, { source: "odb", ready: true, cajas: ["D60B5", "A47B1"] });
  const view = await runInjected(FIX.current, src);
  assert.equal(view.ready, false);
});

test("contexto de caja y consulta de cliente obtienen la misma caja en cada fixture", async () => {
  for (const [name, html] of Object.entries(FIX)) {
    const nap = await extractNap(html);
    // getCurrentCajaContext
    const contextCaja = S.normalizeCajaName(nap.caja) || null;
    // handleObtenerCliente
    const clientCaja = nap.caja || null;
    assert.equal(contextCaja, clientCaja ? S.normalizeCajaName(clientCaja) : null, name);
  }
});

// ---------- 6. Cruce con CSV y decisiones antes/después ----------
// Réplica literal de la extracción v3.1.0 anterior (para comparar).
const LEGACY_PARSE = (raw) => {
  if (!raw) return { caja: raw || "", puerto: null };
  const m = String(raw).trim().match(/^(.*?)\s*\(\s*port\s*[:#]?\s*(\d+)\s*\)\s*$/i);
  return m ? { caja: m[1].trim(), puerto: m[2] } : { caja: String(raw).trim(), puerto: null };
};
async function legacyExtract(html) {
  // Ruta anterior de injectedExtractClientData: el <dt> con texto exacto
  // "NAP (Divisor)" (máx. 2 hijos) -> textContent completo del <dd>.
  const raw = await runInjected(
    html,
    `function(){
      const norm=(s)=>(s||"").replace(/\\s+/g," ").trim();
      for (const el of document.querySelectorAll("th,td,dt,label,span,div,strong,b,p")) {
        if (el.children.length > 2) continue;
        const lower = norm(el.textContent).replace(/:\\s*$/,"").toLowerCase();
        if (!/^nap\\s*\\(\\s*divisor\\s*\\)$/i.test(lower)) continue;
        if (el.tagName === "DT") { let s=el.nextElementSibling; while (s && s.tagName!=="DD") s=s.nextElementSibling; if (s && norm(s.textContent)) return norm(s.textContent); }
        const s = el.nextElementSibling; if (s && norm(s.textContent)) return norm(s.textContent);
      }
      return null;
    }`
  );
  return raw ? LEGACY_PARSE(raw) : { caja: null, puerto: null };
}

function csvRecords() {
  const rec = (name, puerto, s1490, s1310, serial, caja = "D60B5") => ({
    name, caja, puerto, status: "Online", lastChange: "", sig1490: s1490, sig1310: s1310, serial,
  });
  return [
    rec("A", "1", -19.5, -23.8, "HWTC00000011"),
    rec("B", "2", -20.0, -24.0, "HWTC00000012"),
    rec("C", "3", -20.4, -24.6, "HWTC00000013"),
    rec("D", "4", -21.0, -25.0, "HWTC00000014"),
    rec("CLIENTE DEMO 001", "7", -25.0, -28.0, "HWTC00000001"),
    rec("Z", "1", -18.0, -22.0, "HWTC00000099", "A47B1"),
  ];
}
const fixedRand = () => 0;

function report(nap, sig1490, sig1310) {
  const clientData = {
    name: "CLIENTE DEMO 001",
    caja: nap.caja || null,
    puerto: nap.caja ? nap.puerto : null,
    serial: "HWTC00000001",
    oltName: null,
    sig1490,
    sig1310,
  };
  return S.buildClientReport(clientData, csvRecords(), fixedRand);
}

test("DOM actual (SVG + Puerto): el promedio de caja vuelve a calcularse", async () => {
  const nap = await extractNap(FIX.current);
  const r = report(nap, -20.1, -24.3);
  assert.match(r.text, /- Caja: `D60B5` - Puerto 7/);
  assert.match(r.text, /Prom\. de caja: ONU -\d+\.\d\d dBm\/OLT -\d+\.\d\d dBm/);
  assert.doesNotMatch(r.text, /no se pudo obtener promedio/);
  assert.equal(r.cajaWarning, null);
});

test("ANTES (v3.1.0 original) con el DOM actual: caja contaminada y sin promedio", async () => {
  const legacy = await legacyExtract(FIX.current);
  assert.equal(legacy.caja, "D60B5 (Puerto 7)");
  assert.equal(legacy.puerto, null);
  const r = report(legacy, -20.1, -24.3);
  assert.match(r.text, /No tiene puerto asignado/);
  assert.match(r.text, /no se pudo obtener promedio de caja/);
  assert.match(r.cajaWarning, /no coincide con ninguna caja del CSV/);
});

test("cruce con CSV: la caja coincide sin importar mayúsculas/espacios; una caja ajena avisa", () => {
  const ok = report({ caja: "d60b5", puerto: "7" }, -20.1, -24.3);
  assert.equal(ok.cajaWarning, null);
  const other = report({ caja: "ZZ999", puerto: "7" }, -20.1, -24.3);
  assert.match(other.cajaWarning, /ZZ999.*no coincide con ninguna caja del CSV/);
});

// Mismas señales, mismo CSV: con el formato anterior "(Port 7)" la decisión
// antes/después debe ser idéntica; con el DOM actual, la nueva debe ser igual a
// la que daba el formato anterior.
const SCENARIOS = [
  ["aprobado", -20.1, -24.3],
  ["ONU fuera de margen", -23.5, -24.3],
  ["OLT fuera de margen", -20.1, -27.0],
  ["ambos fuera", -24.0, -27.5],
  ["dentro de tolerancia 1.05", -20.97, -24.37],
  ["mejor que el promedio", -18.5, -22.5],
  ["sin señal ONU", null, -24.3],
];

for (const [label, s1490, s1310] of SCENARIOS) {
  test(`decisión igual antes/después — ${label}`, async () => {
    const before = report(await legacyExtract(FIX.legacyDdPort), s1490, s1310);
    const afterLegacy = report(await extractNap(FIX.legacyDdPort), s1490, s1310);
    const afterCurrent = report(await extractNap(FIX.current), s1490, s1310);
    assert.equal(afterLegacy.text, before.text);
    assert.equal(afterCurrent.text, before.text);
    assert.equal(afterCurrent.cajaWarning, before.cajaWarning);
  });
}
