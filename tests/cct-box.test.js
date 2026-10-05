"use strict";

// Diagnóstico de caja (v4): una sola fuente (diagnoseCajaRecords /
// buildCajaDiagnosis) para el dashboard de caja y ESTADO DE CAJA(S).
// Correr con: cd tests && npm test

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const ctx = vm.createContext({ self: {}, console });
vm.runInContext(fs.readFileSync(path.join(ROOT, "shared.js"), "utf8"), ctx, { filename: "shared.js" });
const S = ctx.self.SmartOLTShared;

let serialSeq = 0;
function rec(name, puerto, status, sig1490 = null, sig1310 = null, caja = "A6DB4") {
  serialSeq++;
  return {
    name, caja, puerto: String(puerto), status, lastChange: "2026-09-28 10:00",
    sig1490, sig1310, serial: `HWTC${String(serialSeq).padStart(8, "0")}`,
  };
}

// 4 OP de referencia normales: promedio (3 mejores, sin el cliente) ONU -20.10 / OLT -23.10.
function healthy() {
  return [
    rec("Ref Uno", 1, "Online", -20.0, -23.0),
    rec("Ref Dos", 2, "Online", -20.2, -23.1),
    rec("Ref Tres", 3, "Online", -20.1, -23.2),
    rec("Ref Cuatro", 4, "Online", -20.3, -23.0),
  ];
}
// Los arrays vienen del contexto vm de shared.js: se copian a arrays locales
// para que deepStrictEqual compare solo el contenido.
const names = (list) => Array.from(list, (c) => c.name);
const pick = (list, fn) => Array.from(list, fn);
const diag = (records, caja = "A6DB4") => S.buildCajaDiagnosis(records, caja);

// ---------- Categorías ----------

test("1. caja sin problemas: listas vacías, conteos correctos", () => {
  const d = diag(healthy());
  assert.equal(d.total, 4);
  assert.equal(d.online, 4);
  assert.equal(d.problemCount, 0);
  assert.equal(d.problemLabel, null);
  assert.deepEqual(names(d.statusClients), []);
  assert.deepEqual(names(d.opClients), []);
});

test("2. solo LOS", () => {
  const d = diag([...healthy(), rec("Juan Pérez", 7, "LOS")]);
  assert.deepEqual(pick(d.statusClients, (c) => [c.name, c.puerto, c.reason]), [["Juan Pérez", "7", "LOS"]]);
  assert.equal(d.problemLabel, "LOS");
  assert.equal(d.opClients.length, 0);
});

test("3. solo Power fail", () => {
  const d = diag([...healthy(), rec("María González", 3, "Power fail")]);
  assert.deepEqual(pick(d.statusClients, (c) => c.reason), ["Power fail"]);
  assert.equal(d.problemLabel, "Power fail");
});

test("4. solo Offline (se conserva el motivo real)", () => {
  const d = diag([...healthy(), rec("Carlos Gómez", 12, "Offline")]);
  assert.deepEqual(pick(d.statusClients, (c) => [c.name, c.reason]), [["Carlos Gómez", "Offline"]]);
  assert.equal(d.problemCount, 1);
});

test("5. solo OP fuera de margen", () => {
  const d = diag([...healthy(), rec("Smaniotto Silvia Marina", 5, "Online", -22.5, -23.2)]);
  assert.equal(d.statusClients.length, 0);
  assert.deepEqual(pick(d.opClients, (c) => [c.name, c.puerto, c.reason]), [["Smaniotto Silvia Marina", "5", "OP fuera de margen"]]);
});

test("6. LOS + OP fuera de margen: cada uno en su categoría", () => {
  const d = diag([...healthy(), rec("Juan Pérez", 7, "LOS"), rec("Smaniotto", 5, "Online", -22.5, -23.2)]);
  assert.deepEqual(names(d.statusClients), ["Juan Pérez"]);
  assert.deepEqual(names(d.opClients), ["Smaniotto"]);
  assert.equal(d.total, 6);
  assert.equal(d.online, 5);
});

test("7. múltiples problemáticos: orden por puerto, sin duplicados", () => {
  const d = diag([
    ...healthy(),
    rec("C Offline", 12, "Offline"),
    rec("A LOS", 7, "LOS"),
    rec("B Power", 3, "Power fail"),
    rec("D Disabled", 9, "Disabled"),
    rec("OP Malo 2", 8, "Online", -20.1, -25.0),
    rec("OP Malo 1", 6, "Online", -23.0, -23.1),
  ]);
  assert.deepEqual(names(d.statusClients), ["B Power", "A LOS", "D Disabled", "C Offline"]);
  assert.deepEqual(names(d.opClients), ["OP Malo 1", "OP Malo 2"]);
  assert.equal(d.problemLabel, "LOS/Power fail");
  assert.equal(d.problemCount, 4);
  for (const list of [d.statusClients, d.opClients]) {
    assert.equal(new Set(pick(list, (c) => c.record)).size, list.length);
  }
});

// ---------- Criterio óptico: el mismo del informe de cliente ----------

test("11. aprobado (incluso al límite de 1.05 o por Check 3) NO aparece como OP fuera de margen", () => {
  // ONU peor que el promedio por 1.02 dB y OLT por 1.00: aprobado dentro de tolerancia.
  const nearLimit = rec("Al Límite", 5, "Online", -21.12, -24.1);
  // ONU aprobado, OLT peor 1.2 dB pero Check 3 lo acepta (DIF normal de la caja ~3.0).
  const check3 = rec("Check Tres", 6, "Online", -21.0, -24.3);
  const records = [...healthy(), nearLimit, check3];
  for (const r of [nearLimit, check3]) {
    const ev = S.evaluateClientOptics(r, records);
    assert.equal(ev.badge, "✅", r.name);
  }
  assert.equal(S.evaluateClientOptics(check3, records).check3.status, "passed");
  assert.deepEqual(names(diag(records).opClients), []);
});

test("12. rechazado por el sistema óptico SÍ aparece; no evaluable (⚠️) no", () => {
  const bad = rec("Rechazado", 5, "Online", -21.2, -23.1); // ONU peor 1.10 dB -> ❌
  const noSignal = rec("Sin Señal", 6, "Online", null, -23.1); // ⚠️ no evaluable
  const records = [...healthy(), bad, noSignal];
  assert.equal(S.evaluateClientOptics(bad, records).badge, "❌");
  assert.equal(S.evaluateClientOptics(noSignal, records).badge, "⚠️");
  assert.deepEqual(names(diag(records).opClients), ["Rechazado"]);
});

// ---------- Informe de caja (ESTADO DE CAJA/S) ----------

// ---------- Informe de caja (ESTADO DE CAJA/S): formato v4 ----------

// Líneas de la caja desde "- Online:" hasta el final (sin cabecera).
function statusSection(records) {
  const lines = S.buildTelegramText(records).split("\n");
  return lines.slice(lines.findIndex((l) => l.startsWith("- Online:")));
}

test("formato 1. Online sin OP fuera de margen: sin paréntesis", () => {
  assert.deepEqual(statusSection(healthy()), ["- Online: 4"]);
});

test("formato 2. Online con OP fuera de margen: (Y OP fuera de margen)", () => {
  const out = statusSection([...healthy(), rec("Smaniotto Silvia Marina", 5, "Online", -22.5, -23.2)]);
  assert.equal(out[0], "- Online: 5 (1 OP fuera de margen)");
});

test("formato 3. LOS", () => {
  assert.deepEqual(statusSection([...healthy(), rec("Juan Pérez", 7, "LOS")]), [
    "- Online: 4",
    "- LOS: 1",
    "",
    "🔴 P7 | LOS | Juan Pérez | -",
  ]);
});

test("formato 4. Power fail (contador combinado, motivo real)", () => {
  assert.deepEqual(statusSection([...healthy(), rec("Juan Pérez", 3, "Power fail")]), [
    "- Online: 4",
    "- Power fail/Offline: 1",
    "",
    "⚫ P3 | Power fail | Juan Pérez | -",
  ]);
});

test("formato 5. Offline (contador combinado, motivo real)", () => {
  assert.deepEqual(statusSection([...healthy(), rec("María González", 7, "Offline")]), [
    "- Online: 4",
    "- Power fail/Offline: 1",
    "",
    "⚫ P7 | Offline | María González | -",
  ]);
});

test("formato 6. Power fail + Offline en un único contador", () => {
  const out = statusSection([...healthy(), rec("María González", 7, "Offline"), rec("Juan Pérez", 3, "Power fail")]);
  assert.deepEqual(out, [
    "- Online: 4",
    "- Power fail/Offline: 2",
    "",
    "⚫ P3 | Power fail | Juan Pérez | -",
    "⚫ P7 | Offline | María González | -",
  ]);
});

test("formato 7. LOS + Power fail/Offline: dos contadores, LOS primero", () => {
  const out = statusSection([
    ...healthy(),
    rec("Juan Pérez", 3, "Power fail"),
    rec("Benitez Aldo Javier", 9, "LOS"),
    rec("María González", 7, "Offline"),
  ]);
  assert.deepEqual(out, [
    "- Online: 4",
    "- LOS: 1",
    "- Power fail/Offline: 2",
    "",
    "🔴 P9 | LOS | Benitez Aldo Javier | -",
    "⚫ P3 | Power fail | Juan Pérez | -",
    "⚫ P7 | Offline | María González | -",
  ]);
});

test("formato 8. OP fuera de margen", () => {
  assert.deepEqual(statusSection([...healthy(), rec("Smaniotto Silvia Marina", 5, "Online", -22.5, -23.2)]), [
    "- Online: 5 (1 OP fuera de margen)",
    "",
    "🟡 P5 | OP fuera de margen | Smaniotto Silvia Marina",
  ]);
});

test("formato 9. cliente con LOS + OP fuera de margen: una línea por problema", () => {
  // Registro LOS que conserva lecturas en el CSV: la evaluación óptica
  // existente lo rechaza, así que aparece en ambos grupos (una vez en cada uno).
  const out = statusSection([...healthy(), rec("Benitez Aldo Javier", 1, "LOS", -23.0, -23.1)]);
  assert.deepEqual(out, [
    "- Online: 4",
    "- LOS: 1",
    "",
    "🔴 P1 | LOS | Benitez Aldo Javier | -",
    "🟡 P1 | OP fuera de margen | Benitez Aldo Javier",
  ]);
});

test("formato 10-12. ejemplo completo: bloque continuo, orden LOS -> Power fail/Offline -> OP, sin ceros", () => {
  const records = [
    ...healthy(),
    rec("Espinoza Serna Ricardo Alexis", 8, "LOS"),
    rec("Juan Pérez", 3, "Power fail"),
    rec("María González", 7, "Offline"),
    rec("Smaniotto Silvia Marina", 5, "Online", -22.5, -23.2),
    rec("Benitez Aldo Javier", 6, "Online", -20.1, -25.4),
  ];
  const text = S.buildTelegramText(records);
  assert.equal(
    text,
    [
      "A6DB4",
      "- Prom. caja: `ONU -20.07 / OLT -23.03 dBm`",
      "- 8 puertos ocupados: 1, 2, 3, 4, 5, 6, 7 y 8",
      "- Online: 6 (2 OP fuera de margen)",
      "- LOS: 1",
      "- Power fail/Offline: 2",
      "",
      "🔴 P8 | LOS | Espinoza Serna Ricardo Alexis | -",
      "⚫ P3 | Power fail | Juan Pérez | -",
      "⚫ P7 | Offline | María González | -",
      "🟡 P5 | OP fuera de margen | Smaniotto Silvia Marina",
      "🟡 P6 | OP fuera de margen | Benitez Aldo Javier",
    ].join("\n")
  );
  // Sin títulos intermedios ni contadores viejos.
  assert.ok(!/^- (LOS\/Power fail|OP fuera de margen|Power fail|Offline):/m.test(text));
});

test("formato 12. categorías en 0 no se muestran (ni '(0 OP...)')", () => {
  const text = S.buildTelegramText(healthy());
  assert.ok(!/: 0$/m.test(text));
  assert.ok(!text.includes("(0 OP"));
  assert.ok(!text.includes("LOS") && !text.includes("Power fail"));
});

test("formato: Disabled sigue contando dentro de Power fail/Offline con su motivo real", () => {
  assert.deepEqual(statusSection([...healthy(), rec("Pedro Díaz", 2, "Disabled")]), [
    "- Online: 4",
    "- Power fail/Offline: 1",
    "",
    "⚫ P2 | Disabled | Pedro Díaz | -",
  ]);
});

test("formato: separador entre cajas y aviso 'sin estado' se mantienen", () => {
  const records = [
    ...healthy(),
    rec("Juan Pérez", 7, "LOS"),
    rec("Sin Estado", 9, ""),
    rec("Otra Caja", 1, "Power fail", null, null, "B29A3"),
  ];
  const text = S.buildTelegramText(records);
  const [a6, b29] = text.split("\n" + "-".repeat(29) + "\n");
  assert.ok(a6.endsWith("🔴 P7 | LOS | Juan Pérez | -\n⚠️ 1 ONU sin estado: `" + records[5].serial + "`"), a6);
  assert.ok(b29.startsWith("B29A3\n"));
});

test("10. dashboard e informe listan exactamente los mismos clientes (300 cajas aleatorias)", () => {
  let a = 42;
  const r = () => {
    a = (a * 1664525 + 1013904223) % 4294967296;
    return a / 4294967296;
  };
  const STATUSES = ["Online", "Online", "Online", "Online", "LOS", "Power fail", "Offline", "Disabled"];
  for (let i = 0; i < 300; i++) {
    const records = [];
    for (const caja of ["A6DB4", "B29A3"]) {
      const n = Math.floor(r() * 12);
      for (let k = 0; k < n; k++) {
        const status = STATUSES[Math.floor(r() * STATUSES.length)];
        const online = status === "Online";
        const sig = (base) => (online && r() > 0.05 ? Math.round((base + (r() - 0.5) * (r() < 0.2 ? 8 : 2.5)) * 100) / 100 : null);
        records.push(rec(`${caja}-${i}-${k}`, k + 1, status, sig(-21), sig(-24.5), caja));
      }
    }
    if (records.length === 0) continue;
    const text = S.buildTelegramText(records);
    for (const caja of ["A6DB4", "B29A3"]) {
      const d = diag(records, caja);
      const block = text.split(`\n${"-".repeat(29)}\n`).find((b) => b.split("\n")[0] === caja) || "";
      const reportOp = block.split("\n").filter((l) => l.startsWith("🟡 ")).map((l) => l.split(" | ")[2]);
      const reportStatus = block.split("\n").filter((l) => /^(🔴|⚫) P/.test(l)).map((l) => l.split(" | ")[2]);
      assert.deepEqual(reportOp, d ? names(d.opClients) : [], `caso ${i} ${caja} OP`); // mismo orden (por puerto)
      assert.deepEqual([...reportStatus].sort(), (d ? names(d.statusClients) : []).sort(), `caso ${i} ${caja} estado`);
    }
  }
});

// ---------- Informe de cliente: sin cambios ----------

test("13. el informe de cliente se mantiene exactamente igual (ejemplo real)", () => {
  const records = [
    rec("Uno", 1, "Online", -21.3, -24.05),
    rec("Dos", 2, "Online", -21.34, -24.09),
    rec("Tres", 3, "Online", -21.38, -24.13),
  ];
  const { text } = S.buildClientReport(
    { name: "Smaniotto Silvia Marina", caja: "A6DB4", puerto: "5", serial: "HWTCD4EC0FD2", oltName: "OBE-OLT-A", sig1490: -22.44, sig1310: -25.38 },
    records,
    () => 0
  );
  assert.equal(
    text,
    [
      "Cliente: `Smaniotto Silvia Marina`",
      "",
      "- Serial ONU: `HWTCD4EC0FD2`",
      "- Caja: `A6DB4` - Puerto 5",
      "- `OP Cliente: ONU -22.44 dBm/OLT -25.38 dBm`❌",
      "- `Prom. de caja: ONU -21.34 dBm/OLT -24.09 dBm`",
      "",
      "🫣 ¡Qué cerca! Para entrar en el margen permitido: mejorar ONU 0.10 dB y OLT 0.29 dB.",
      "💡 Para alcanzar el promedio de la caja: mejorar ONU 1.10 dB y OLT 1.29 dB.",
    ].join("\n")
  );
});
