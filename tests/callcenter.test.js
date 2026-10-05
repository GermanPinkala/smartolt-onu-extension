"use strict";

// Lógica pura del perfil CALL CENTER (callcenter.js): hallazgos, observación,
// cortes, fluctuación, afectación de la caja e informe de cajas.
// Correr con: cd tests && npm test

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const ctx = vm.createContext({ self: {}, console });
vm.runInContext(fs.readFileSync(path.join(ROOT, "shared.js"), "utf8"), ctx, { filename: "shared.js" });
vm.runInContext(fs.readFileSync(path.join(ROOT, "callcenter.js"), "utf8"), ctx, { filename: "callcenter.js" });
const S = ctx.self.SmartOLTShared;
const CC = ctx.self.SmartOLTCallCenter;
// Los objetos vienen del contexto vm: se copian para comparar solo contenido.
const plain = (x) => JSON.parse(JSON.stringify(x));

let serialSeq = 0;
function rec(name, puerto, status, sig1490 = null, sig1310 = null, caja = "A6DB4") {
  serialSeq++;
  return { name, caja, puerto: String(puerto), status, lastChange: "", sig1490, sig1310, serial: `HWTC${String(serialSeq).padStart(8, "0")}` };
}
// Promedio de referencia (3 mejores, sin el cliente): ONU -20.10 / OLT -23.10.
function healthy() {
  return [
    rec("Ref Uno", 1, "Online", -20.0, -23.0),
    rec("Ref Dos", 2, "Online", -20.2, -23.1),
    rec("Ref Tres", 3, "Online", -20.1, -23.2),
    rec("Ref Cuatro", 4, "Online", -20.3, -23.0),
  ];
}

// Cliente de la ficha: puerto 5 de A6DB4, serial fuera del CSV.
const CLIENT = { name: "Cliente Demo", caja: "A6DB4", puerto: "5", serial: "HWTC99999999", sig1490: -20.4, sig1310: -23.3 };

function findingsFor({ records = healthy(), status = "Online", client = CLIENT, signal = null, cuts = null } = {}) {
  const evaluation = S.evaluateClientOptics(client, records);
  const box = CC.analyzeClientBox(records, client, status);
  const findings = CC.buildClientFindings({ status, clientData: client, evaluation, signal, cuts, box });
  return { findings: plain(findings), box: plain(box), observation: CC.buildObservation(findings, status) };
}
const ids = (findings) => findings.map((f) => f.id);
const problems = (findings) => findings.filter((f) => f.kind === "problem").map((f) => f.id);

// Tabla "History" real de "Obtener estado" (OLT Huawei, 2026-09), anonimizada.
const NOW = Date.parse("2026-09-29T10:00:00-03:00");
const HISTORY = [
  "History",
  "#  UP Authentication time        Offline time               Down reason",
  "10  2026-09-29 09:39:14-03:00  ONU is currently online",
  "09  2026-09-29 09:28:30-03:00  2026-09-29 09:31:21-03:00  ONT dying-gasp",
  "08  2026-09-28 18:53:55-03:00  2026-09-29 09:13:16-03:00  ONT dying-gasp",
  "07  2026-09-28 12:42:07-03:00  2026-09-28 13:43:07-03:00  ONT LOSi/LOBi alarm",
  "06  2026-09-25 15:31:45-03:00  2026-09-28 08:30:19-03:00  ONT dying-gasp",
  "",
  "ONU WAN config",
].join("\n");

// ---------- Parser del historial y cortes ----------

test("historial Huawei: se parsean subidas, caídas y causa", () => {
  const entries = plain(CC.parseStatusHistory(HISTORY));
  assert.equal(entries.length, 5);
  assert.deepEqual(entries[0], { upMs: Date.parse("2026-09-29T09:39:14-03:00"), downMs: null, reason: "" });
  assert.deepEqual(entries[1], {
    upMs: Date.parse("2026-09-29T09:28:30-03:00"),
    downMs: Date.parse("2026-09-29T09:31:21-03:00"),
    reason: "ONT dying-gasp",
  });
  assert.equal(entries[3].reason, "ONT LOSi/LOBi alarm");
});

test("historial: otro formato (sin tabla History) -> null, no se inventan cortes", () => {
  assert.equal(CC.parseStatusHistory("ONU details\nRun state : online\n"), null);
  assert.equal(CC.parseStatusHistory(""), null);
  assert.equal(CC.parseStatusHistory(null), null);
});

test("cortes: 0, 1 y múltiples en las últimas 24 hs, con causa informada por la OLT", () => {
  const entries = CC.parseStatusHistory(HISTORY);
  // Hace 24 hs desde NOW: 2026-09-28 10:00 -> entran 09:31, 09:13 (29/09) y 13:43 (28/09).
  assert.deepEqual(plain(CC.summarizeCuts(entries, NOW)), {
    count: 3,
    atLeast: false,
    reasons: [
      { reason: "dying-gasp", count: 2 },
      { reason: "LOSi/LOBi", count: 1 },
    ],
  });
  assert.equal(CC.summarizeCuts(entries, NOW + 12 * 3600 * 1000).count, 2); // 13:43 del 28 ya afuera
  assert.equal(CC.summarizeCuts(entries, NOW + 3 * 24 * 3600 * 1000).count, 0);
});

test("cortes: si las 10 caídas del historial entran en 24 hs, el total es 'al menos'", () => {
  const rows = ["History", "#  UP  Offline  Down reason"];
  for (let i = 10; i >= 1; i--) {
    rows.push(`${String(i).padStart(2, "0")}  2026-09-29 0${i % 10}:10:00-03:00  2026-09-29 0${i % 10}:20:00-03:00  ONT dying-gasp`);
  }
  const summary = CC.summarizeCuts(CC.parseStatusHistory(rows.join("\n")), NOW);
  assert.equal(summary.count, 10);
  assert.equal(summary.atLeast, true);
});

// ---------- Fluctuación ----------

test("fluctuación: máximo - mínimo de las lecturas reales; sin datos suficientes -> null", () => {
  const series = { name: "1310nm OLT Rx for ONU", points: [[1, -25.0], [2, null], [3, -29.5], [4, -21.5]] };
  assert.deepEqual(plain(CC.summarizeSignalSeries(series)), { side: "OLT", samples: 3, min: -29.5, max: -21.5, fluctuation: 8 });
  assert.equal(CC.summarizeSignalSeries({ name: "x", points: [[1, -25], [2, null]] }), null);
  assert.equal(CC.summarizeSignalSeries(null), null);
  assert.equal(CC.isRelevantFluctuation({ fluctuation: 1.0 }), false); // igual al margen óptico: no relevante
  assert.equal(CC.isRelevantFluctuation({ fluctuation: 1.01 }), true);
});

// ---------- Cliente ----------

test("cliente Online normal: sin problemas; la observación resume los controles normales", () => {
  const { findings, observation } = findingsFor({
    signal: { side: "OLT", fluctuation: 0.4, min: -23.5, max: -23.1, samples: 280 },
    cuts: { count: 0, atLeast: false, reasons: [] },
  });
  assert.deepEqual(problems(findings), []);
  assert.deepEqual(ids(findings), ["op_ok", "signal_stable", "no_cuts"]);
  assert.equal(
    observation,
    "Cliente Online. OP dentro del margen de la caja. Sin fluctuaciones relevantes de señal en las últimas 24 hs (0.40 dB). Sin cortes registrados en las últimas 24 hs."
  );
});

test("cliente con OP fuera de margen (misma evaluación que el informe): hallazgo con diferencia al promedio", () => {
  const client = Object.assign({}, CLIENT, { sig1490: -21.2, sig1310: -24.5 });
  assert.equal(S.evaluateClientOptics(client, healthy()).badge, "❌");
  const { findings, observation } = findingsFor({ client });
  assert.deepEqual(problems(findings), ["op_out_of_margin"]);
  assert.equal(
    observation,
    "Cliente presenta OP alto (ONU -21.20 dBm / OLT -24.50 dBm), con una diferencia de 1.10 dB en ONU y 1.47 dB en OLT respecto al promedio de la caja."
  );
});

test("cliente con OP aprobado al límite: NO es OP fuera de margen", () => {
  const client = Object.assign({}, CLIENT, { sig1490: -21.12, sig1310: -24.1 });
  assert.equal(S.evaluateClientOptics(client, healthy()).badge, "✅");
  const { findings } = findingsFor({ client });
  assert.ok(!ids(findings).includes("op_out_of_margin"));
  assert.ok(ids(findings).includes("op_ok"));
});

test("cliente sin CSV: no se evalúa el OP ni el resto de la caja (sin hallazgos inventados)", () => {
  const { findings, box } = findingsFor({ records: [] });
  assert.deepEqual(findings, []);
  assert.deepEqual(box, { inCsv: false });
});

test("fluctuación relevante en la ficha: hallazgo con el valor real", () => {
  const { findings } = findingsFor({ signal: { side: "OLT", fluctuation: 8, min: -29.5, max: -21.5, samples: 200 } });
  const f = findings.find((x) => x.id === "signal_fluctuation");
  assert.equal(f.dashboard, "📈 Fluctuación OP OLT en 24 hs: 8.00 dB");
  assert.equal(f.observation, "Se detectaron fluctuaciones de hasta 8.00 dB en la señal (OLT) en las últimas 24 hs.");
});

test("cortes en la ficha: 0, 1 y múltiples", () => {
  const zero = findingsFor({ cuts: { count: 0, atLeast: false, reasons: [] } }).findings.find((f) => f.id === "no_cuts");
  assert.equal(zero.dashboard, "✂️ Sin cortes en 24 hs");
  const one = findingsFor({ cuts: { count: 1, atLeast: false, reasons: [{ reason: "dying-gasp", count: 1 }] } }).findings.find((f) => f.id === "cuts");
  assert.equal(one.dashboard, "✂️ Cortes en 24 hs: 1");
  assert.equal(one.tooltip, "1 por dying-gasp (corte de energía)");
  // Observación simple (singular): las causas quedan solo en el tooltip.
  assert.equal(one.observation, "Se registró 1 corte en las últimas 24 hs, según SmartOLT.");
  const many = findingsFor({
    cuts: { count: 3, atLeast: false, reasons: [{ reason: "dying-gasp", count: 2 }, { reason: "LOSi/LOBi", count: 1 }] },
  }).findings.find((f) => f.id === "cuts");
  assert.equal(many.dashboard, "✂️ Cortes en 24 hs: 3");
  assert.equal(many.tooltip, "2 por dying-gasp (corte de energía)\n1 por LOSi/LOBi (pérdida de señal óptica)");
  assert.equal(many.observation, "Se registraron 3 cortes en las últimas 24 hs, según SmartOLT.");
  const capped = findingsFor({ cuts: { count: 10, atLeast: true, reasons: [{ reason: "dying-gasp", count: 10 }] } }).findings.find((f) => f.id === "cuts");
  assert.equal(capped.dashboard, "✂️ Cortes en 24 hs: ≥10");
  assert.equal(capped.tooltip, "Al menos 10 cortes detectados en las últimas 24 hs.\n10 por dying-gasp (corte de energía)");
  assert.match(capped.observation, /^Se registraron al menos 10 cortes/);
});

// ---------- Tooltip de cortes ----------

test("tooltip: causa no contemplada se muestra tal cual; sin causas -> 'Detalle de causas no disponible.'", () => {
  const mixed = CC.buildCutsTooltip({ count: 3, atLeast: false, reasons: [{ reason: "unknown-cause", count: 2 }, { reason: "dying-gasp", count: 1 }] });
  assert.equal(mixed, "2 por unknown-cause\n1 por dying-gasp (corte de energía)");
  const none = CC.buildCutsTooltip({ count: 3, atLeast: false, reasons: [{ reason: "sin causa informada", count: 3 }] });
  assert.equal(none, "Detalle de causas no disponible.");
  const noneCapped = CC.buildCutsTooltip({ count: 10, atLeast: true, reasons: [{ reason: "sin causa informada", count: 10 }] });
  assert.equal(noneCapped, "Al menos 10 cortes detectados en las últimas 24 hs.\nDetalle de causas no disponible.");
});

test("tooltip: con el historial agrega la hora de cada corte, sin cambiar conteo ni observación", () => {
  const entries = CC.parseStatusHistory(HISTORY);
  const cuts = CC.summarizeCuts(entries, NOW);
  const events = plain(CC.cutEvents(entries, NOW));
  assert.equal(events.length, cuts.count); // mismo criterio de ventana que el conteo
  assert.deepEqual(events.map((e) => e.reason), ["LOSi/LOBi", "dying-gasp", "dying-gasp"]); // de la más vieja a la más nueva
  const hhmm = (iso) => {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const base = { status: "Online", clientData: CLIENT, evaluation: S.evaluateClientOptics(CLIENT, healthy()), signal: null, cuts, box: null };
  const withEvents = CC.buildClientFindings(Object.assign({ cutEvents: CC.cutEvents(entries, NOW) }, base)).find((f) => f.id === "cuts");
  const withoutEvents = CC.buildClientFindings(base).find((f) => f.id === "cuts");
  assert.equal(
    withEvents.tooltip,
    [
      "2 por dying-gasp (corte de energía)",
      "1 por LOSi/LOBi (pérdida de señal óptica)",
      "",
      "Cortes detectados en las últimas 24 hs:",
      `${hhmm("2026-09-28T13:43:07-03:00")} — LOSi/LOBi (pérdida de señal óptica)`,
      `${hhmm("2026-09-29T09:13:16-03:00")} — dying-gasp (corte de energía)`,
      `${hhmm("2026-09-29T09:31:21-03:00")} — dying-gasp (corte de energía)`,
    ].join("\n")
  );
  // Sin horas: solo las causas agrupadas.
  assert.equal(withoutEvents.tooltip, "2 por dying-gasp (corte de energía)\n1 por LOSi/LOBi (pérdida de señal óptica)");
  // Misma línea del dashboard y misma observación con o sin horas.
  assert.equal(withEvents.dashboard, "✂️ Cortes en 24 hs: 3");
  assert.equal(withEvents.observation, withoutEvents.observation);
  assert.equal(withEvents.observation, "Se registraron 3 cortes en las últimas 24 hs, según SmartOLT.");
});

// ---------- Afectación de la caja desde la ficha ----------

test("exactamente 2 otros clientes en LOS: se listan sus puertos reales", () => {
  const records = [...healthy(), rec("L1", 7, "LOS"), rec("L2", 2 + 10, "LOS")];
  const { findings, observation } = findingsFor({ records, status: "LOS", client: Object.assign({}, CLIENT, { sig1490: null, sig1310: null }) });
  const f = findings.find((x) => x.id === "other_los");
  assert.equal(f.dashboard, "🚨 Otros clientes en LOS: P7 y P12");
  assert.equal(observation, "Cliente presenta LOS. Se detectan además los puertos 7 y 12 en LOS.");
});

test("un solo otro cliente en LOS: se informa su puerto", () => {
  const { findings } = findingsFor({ records: [...healthy(), rec("L1", 7, "LOS")] });
  assert.equal(findings.find((x) => x.id === "other_los").dashboard, "🚨 Otro cliente en LOS: P7");
});

test("más de 2 otros clientes en LOS: 'Varios clientes en LOS', sin listar puertos", () => {
  const records = [...healthy(), rec("L1", 6, "LOS"), rec("L2", 7, "LOS"), rec("L3", 8, "LOS")];
  const { findings, observation } = findingsFor({ records, status: "LOS", client: Object.assign({}, CLIENT, { sig1490: null, sig1310: null }) });
  assert.equal(findings.find((x) => x.id === "many_other_los").dashboard, "🚨 Varios clientes en LOS");
  assert.equal(observation, "Cliente presenta LOS. Se detectan además varios clientes en LOS.");
});

test("100% LOS: posible caja cortada (sin listar además los puertos)", () => {
  const records = [rec("L1", 1, "LOS"), rec("L2", 2, "LOS"), rec("L3", 3, "LOS")];
  const lost = Object.assign({}, CLIENT, { sig1490: null, sig1310: null });
  const { findings, observation } = findingsFor({ records, status: "LOS", client: lost });
  assert.deepEqual(problems(findings), ["status", "possible_box_cut"]);
  assert.equal(findings.find((x) => x.id === "possible_box_cut").dashboard, "🔴 Posible caja cortada");
  assert.equal(observation, "Cliente presenta LOS. Posible caja cortada.");
  assert.ok(!/La caja está cortada|Caja cortada\./.test(observation));
});

test("100% críticos en combinaciones (LOS + Power fail, LOS + Offline, las tres): posible caja cortada", () => {
  const lost = Object.assign({}, CLIENT, { sig1490: null, sig1310: null });
  for (const statuses of [["LOS", "Power fail"], ["LOS", "Offline"], ["LOS", "Power fail", "Offline"], ["Power fail", "Offline"]]) {
    const records = statuses.map((st, i) => rec(`C${i}`, i + 1, st));
    const { findings } = findingsFor({ records, status: "LOS", client: lost });
    assert.ok(ids(findings).includes("possible_box_cut"), statuses.join("+"));
  }
});

test("el estado EN VIVO del cliente cuenta para la caja (CSV desactualizado)", () => {
  // En el CSV el cliente figura Online, pero ahora está en LOS: 100% crítico.
  const records = [rec("Otro", 1, "LOS"), rec("Otro 2", 2, "Power fail"), Object.assign(rec("Yo", 5, "Online", -20, -23), { serial: CLIENT.serial })];
  const lost = Object.assign({}, CLIENT, { sig1490: null, sig1310: null });
  assert.equal(findingsFor({ records, status: "LOS", client: lost }).box.possibleCut, true);
  assert.equal(findingsFor({ records, status: "Online", client: lost }).box.possibleCut, false);
});

test("caja con clientes normales y algunos afectados: no es posible caja cortada", () => {
  const records = [...healthy(), rec("L1", 6, "LOS"), rec("P1", 7, "Power fail")];
  const { findings, box } = findingsFor({ records, status: "LOS", client: Object.assign({}, CLIENT, { sig1490: null, sig1310: null }) });
  assert.equal(box.possibleCut, false);
  assert.ok(!ids(findings).includes("possible_box_cut"));
  assert.equal(findings.find((x) => x.id === "other_los").dashboard, "🚨 Otro cliente en LOS: P6");
});

test("posible caja cortada exige al menos 2 clientes y no cuenta Disabled como caída", () => {
  assert.equal(CC.isPossibleCajaCut([rec("Solo", 1, "LOS")]), false);
  assert.equal(CC.isPossibleCajaCut([rec("A", 1, "LOS"), rec("B", 2, "Disabled")]), false);
  assert.equal(CC.isPossibleCajaCut([rec("A", 1, "LOS"), rec("B", 2, "")]), false);
  assert.equal(CC.isPossibleCajaCut([rec("A", 1, "LOS"), rec("B", 2, "Offline")]), true);
});

// ---------- Generador ----------

test("generador: acumula TODOS los hallazgos (OP alto + fluctuación + cortes + otros LOS)", () => {
  const client = Object.assign({}, CLIENT, { sig1490: -24.1, sig1310: -23.1 });
  const records = [...healthy(), rec("L1", 7, "LOS"), rec("L2", 9, "LOS")];
  const { findings, observation } = findingsFor({
    records,
    client,
    signal: { side: "OLT", fluctuation: 8, min: -29.5, max: -21.5, samples: 280 },
    cuts: { count: 3, atLeast: false, reasons: [{ reason: "dying-gasp", count: 3 }] },
  });
  assert.deepEqual(problems(findings), ["op_out_of_margin", "signal_fluctuation", "cuts", "other_los"]);
  assert.equal(
    observation,
    "Cliente presenta OP alto (ONU -24.10 dBm / OLT -23.10 dBm), con una diferencia de 4.00 dB en ONU respecto al promedio de la caja. " +
      "Se detectaron fluctuaciones de hasta 8.00 dB en la señal (OLT) en las últimas 24 hs. " +
      "Se registraron 3 cortes en las últimas 24 hs, según SmartOLT. " +
      "Se detectan además los puertos 7 y 9 en LOS."
  );
  // Con problemas, los controles normales no se mezclan en la observación.
  assert.ok(!/Sin cortes|dentro del margen/.test(observation));
});

// ---------- Informe de cajas de Call Center ----------

test("informe de caja: todos Online, con su OP", () => {
  const text = CC.buildCallCenterBoxReport(healthy());
  assert.equal(
    text,
    [
      "📦 A6DB4 · Prom. ONU -20.10 / OLT -23.03 dBm",
      "4 ONUs · 🟢 4 Online",
      "P1 🟢 Ref Uno · ONU -20.00 / OLT -23.00",
      "P2 🟢 Ref Dos · ONU -20.20 / OLT -23.10",
      "P3 🟢 Ref Tres · ONU -20.10 / OLT -23.20",
      "P4 🟢 Ref Cuatro · ONU -20.30 / OLT -23.00",
    ].join("\n")
  );
});

test("informe de caja: LOS, Power fail, Offline y OP fuera de margen; TODOS los clientes listados", () => {
  const records = [
    ...healthy(),
    rec("Smaniotto", 5, "Online", -22.5, -23.2),
    rec("Juan Pérez", 6, "Power fail"),
    rec("María González", 7, "LOS"),
    rec("Carlos Gómez", 8, "Offline"),
  ];
  const lines = CC.buildCallCenterBoxReport(records).split("\n");
  assert.equal(lines[1], "8 ONUs · 🟢 5 Online · 🔴 1 LOS · ⚫ 2 Power fail/Offline · 🟡 1 OP fuera de margen");
  assert.deepEqual(lines.slice(2), [
    "P1 🟢 Ref Uno · ONU -20.00 / OLT -23.00",
    "P2 🟢 Ref Dos · ONU -20.20 / OLT -23.10",
    "P3 🟢 Ref Tres · ONU -20.10 / OLT -23.20",
    "P4 🟢 Ref Cuatro · ONU -20.30 / OLT -23.00",
    "P5 🟡 Smaniotto · ONU -22.50 / OLT -23.20 · OP fuera de margen",
    "P6 ⚫ Juan Pérez · Power fail",
    "P7 🔴 María González · LOS",
    "P8 ⚫ Carlos Gómez · Offline",
  ]);
  // Mismos clientes "OP fuera de margen" que el dashboard y el informe CCT.
  assert.deepEqual(plain(S.buildCajaDiagnosis(records, "A6DB4").opClients.map((c) => c.name)), ["Smaniotto"]);
});

test("informe de caja: 100% críticos -> 'Posible caja cortada'; varias cajas en orden natural", () => {
  const records = [
    rec("X1", 1, "LOS", null, null, "C27A3"),
    rec("X2", 2, "Power fail", null, null, "C27A3"),
    rec("X3", 3, "Offline", null, null, "C27A3"),
    ...healthy(),
  ];
  const blocks = CC.buildCallCenterBoxReport(records).split("\n\n");
  assert.equal(blocks.length, 2);
  assert.ok(blocks[0].startsWith("📦 A6DB4"));
  assert.deepEqual(blocks[1].split("\n"), [
    "📦 C27A3 · Sin promedio",
    "3 ONUs · 🟢 0 Online · 🔴 1 LOS · ⚫ 2 Power fail/Offline",
    "🔴 Posible caja cortada",
    "P1 🔴 X1 · LOS",
    "P2 ⚫ X2 · Power fail",
    "P3 ⚫ X3 · Offline",
  ]);
  assert.ok(!blocks[0].includes("Posible caja cortada"));
});
