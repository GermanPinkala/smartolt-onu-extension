"use strict";

/**
 * SmartOLT — Control — lógica del perfil CALL CENTER (v4)
 *
 * Funciones PURAS (sin DOM, sin red, sin chrome.*): reciben datos ya leídos y
 * devuelven resultados. Las usa cc-dashboard.js y se testean igual que
 * shared.js. Todo lo técnico se reutiliza de SmartOLTShared: estados,
 * promedios, evaluación óptica (evaluateClientOptics: Check 1/2/3), cajas.
 *
 * Diagnóstico por HALLAZGOS: cada detección respaldada por datos agrega un
 * hallazgo { id, kind, dashboard, observation }:
 *   - kind "problem": algo a revisar (entra en la observación).
 *   - kind "ok": un control hecho que dio normal (solo se usa en la
 *     observación cuando no hay ningún problema).
 *   - dashboard: texto para la sección de Call Center (null si el dashboard
 *     base ya lo muestra, p. ej. el estado o el OP).
 * El generador de observación solo transforma hallazgos en frases: agregar
 * una detección nueva no requiere tocarlo.
 *
 * Nunca se afirma una causa que los datos no demuestran: el OP se describe
 * contra el promedio de la caja, las causas de corte son las que informa la
 * OLT y una caja con todos los clientes caídos es solo "Posible caja cortada".
 */

(function () {
  const S = self.SmartOLTShared;
  const DAY_MS = 24 * 60 * 60 * 1000;

  // ---------- Estados ----------

  // Estados de caída que considera Call Center (Disabled es administrativo:
  // no indica una caída).
  const CRITICAL_STATUSES = ["los", "power fail", "offline"];

  function statusKey(status) {
    return String(status || "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  function isCriticalStatus(status) {
    return CRITICAL_STATUSES.includes(statusKey(status));
  }

  // "Posible caja cortada": TODOS los clientes de la caja (al menos 2, con uno
  // solo no se distingue un problema individual) en LOS, Power fail u
  // Offline, en cualquier combinación.
  function isPossibleCajaCut(recordsInCaja) {
    return (recordsInCaja || []).length >= 2 && recordsInCaja.every((r) => isCriticalStatus(r.status));
  }

  function portLabel(puerto) {
    return puerto ? `P${puerto}` : "P?";
  }

  function joinSpanish(items) {
    if (items.length <= 1) return items.join("");
    return `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`;
  }

  function formatDbValue(value) {
    return value !== null && value !== undefined && Number.isFinite(value) ? value.toFixed(2) : "N/D";
  }

  // ---------- Afectación de la caja (vista cliente) ----------

  // Los demás clientes de la caja salen del CSV cargado; el cliente actual
  // se toma con su estado EN VIVO (el de la ficha), no el del CSV.
  function analyzeClientBox(records, clientData, liveStatus) {
    const key = S.normalizeCajaName(clientData && clientData.caja);
    const recordsInCaja = key ? (records || []).filter((r) => S.normalizeCajaName(r.caja) === key) : [];
    if (recordsInCaja.length === 0) return { inCsv: false };

    const currentIndex = S.findClientRecordIndex(recordsInCaja, clientData);
    const members = recordsInCaja.map((r, i) =>
      i === currentIndex && liveStatus ? Object.assign({}, r, { status: liveStatus }) : r
    );
    let current = currentIndex !== -1 ? members[currentIndex] : null;
    if (!current && liveStatus) {
      // Cliente que no está en el CSV (p. ej. dado de alta después): cuenta
      // igual como miembro de la caja con su estado actual.
      current = { name: clientData.name || "", caja: clientData.caja, puerto: clientData.puerto || "", status: liveStatus };
      members.push(current);
    }
    const others = members.filter((r) => r !== current);
    const otherLos = S.sortByPuertoAscending(others.filter((r) => statusKey(r.status) === "los"));
    return {
      inCsv: true,
      total: members.length,
      possibleCut: isPossibleCajaCut(members),
      otherLosPorts: otherLos.map((r) => r.puerto || ""),
    };
  }

  // ---------- Historial de señal de 24 hs ----------

  // series: { name, points: [[timestampMs, valor|null], ...] } de
  // /signal/get_signal_graph_series_for_onu. null si no hay al menos 2
  // lecturas reales (no se inventa ninguna fluctuación).
  function summarizeSignalSeries(series) {
    if (!series || !Array.isArray(series.points)) return null;
    const values = series.points.map((p) => (Array.isArray(p) ? p[1] : null)).filter((v) => typeof v === "number" && Number.isFinite(v));
    if (values.length < 2) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    return {
      side: /olt\s*rx/i.test(series.name || "") ? "OLT" : String(series.name || "señal"),
      samples: values.length,
      min,
      max,
      fluctuation: Math.round((max - min) * 100) / 100,
    };
  }

  // Una variación mayor que el margen óptico ya usado por la extensión
  // (OPTICAL_TOLERANCE_DB) se considera relevante.
  function isRelevantFluctuation(signal) {
    return !!signal && signal.fluctuation > S.OPTICAL_TOLERANCE_DB;
  }

  // ---------- Cortes de las últimas 24 hs ----------

  const DATETIME_RE = "(\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}:\\d{2}(?:[+-]\\d{2}:?\\d{2}|Z)?)";
  const HISTORY_ENTRY_RE = new RegExp(`^\\s*(\\d{1,3})\\s+${DATETIME_RE}\\s+(.*)$`);
  const DOWN_RE = new RegExp(`^${DATETIME_RE}\\s*(.*)$`);

  function parseDateTime(text) {
    const iso = String(text).replace(" ", "T").replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? null : ms;
  }

  // Tabla "History" de "Obtener estado" (/api/onu/status/ID, OLT Huawei):
  //   #  UP Authentication time  Offline time  Down reason
  //   10  2026-09-28 09:39:14-03:00  ONU is currently online
  //   09  2026-09-28 09:28:30-03:00  2026-09-28 09:31:21-03:00  ONT dying-gasp
  // Devuelve [{ upMs, downMs, reason }] o null si el texto no trae esa tabla
  // (otro formato de OLT): en ese caso no se informa ningún corte.
  function parseStatusHistory(text) {
    const lines = String(text || "").split(/\r?\n/);
    const start = lines.findIndex((l) => /^\s*History\s*$/i.test(l));
    if (start === -1) return null;
    const entries = [];
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) {
        if (entries.length > 0) break;
        continue;
      }
      const m = line.match(HISTORY_ENTRY_RE);
      if (!m) {
        if (entries.length > 0) break;
        continue; // encabezado de la tabla
      }
      const down = m[3].match(DOWN_RE);
      entries.push({
        upMs: parseDateTime(m[2]),
        downMs: down ? parseDateTime(down[1]) : null,
        reason: down ? down[2].trim() : "",
      });
    }
    return entries.length > 0 ? entries : null;
  }

  function normalizeCutReason(reason) {
    const text = String(reason || "").replace(/^ONT\s+/i, "").replace(/\s+alarm$/i, "").trim();
    return text || "sin causa informada";
  }

  // SmartOLT muestra solo las últimas 10 caídas: si todas caen dentro de las
  // 24 hs, el total real puede ser mayor ("al menos N").
  const HISTORY_MAX_ENTRIES = 10;

  function summarizeCuts(entries, nowMs) {
    if (!Array.isArray(entries)) return null;
    const since = nowMs - DAY_MS;
    const cuts = entries.filter((e) => e.downMs !== null && e.downMs >= since && e.downMs <= nowMs);
    const counts = new Map();
    cuts.forEach((e) => {
      const reason = normalizeCutReason(e.reason);
      counts.set(reason, (counts.get(reason) || 0) + 1);
    });
    return {
      count: cuts.length,
      atLeast: entries.length >= HISTORY_MAX_ENTRIES && cuts.length === entries.length,
      reasons: Array.from(counts, ([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    };
  }

  // Caídas del historial dentro de las últimas 24 hs, con su hora y causa
  // (mismo criterio de ventana que summarizeCuts), ordenadas de la más vieja
  // a la más nueva. Solo para mostrar el detalle; el conteo sigue siendo el
  // de summarizeCuts.
  function cutEvents(entries, nowMs) {
    if (!Array.isArray(entries)) return [];
    const since = nowMs - DAY_MS;
    return entries
      .filter((e) => e.downMs !== null && e.downMs >= since && e.downMs <= nowMs)
      .map((e) => ({ downMs: e.downMs, reason: normalizeCutReason(e.reason) }))
      .sort((a, b) => a.downMs - b.downMs);
  }

  // Traducción de causas para el tooltip del dashboard. Una causa no
  // contemplada se muestra tal cual la informa SmartOLT.
  const TOOLTIP_GLOSSES = {
    "dying-gasp": "corte de energía",
    "LOSi/LOBi": "pérdida de señal óptica",
  };
  const NO_REASON = "sin causa informada";

  function tooltipReason(reason) {
    return TOOLTIP_GLOSSES[reason] ? `${reason} (${TOOLTIP_GLOSSES[reason]})` : reason;
  }

  function formatCutTime(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // Texto del tooltip de "✂️ Cortes en 24 hs" (una línea por renglón): el
  // mínimo si el historial no alcanza, las causas agrupadas y, si se conocen,
  // la hora de cada corte.
  function buildCutsTooltip(cuts, events) {
    const lines = [];
    if (cuts.atLeast) lines.push(`Al menos ${cuts.count} cortes detectados en las últimas 24 hs.`);
    const known = cuts.reasons.filter((r) => r.reason !== NO_REASON);
    if (known.length === 0) {
      lines.push("Detalle de causas no disponible.");
    } else {
      cuts.reasons.forEach(({ reason, count }) => lines.push(`${count} por ${tooltipReason(reason)}`));
    }
    if (Array.isArray(events) && events.length > 0) {
      lines.push("", "Cortes detectados en las últimas 24 hs:");
      events.forEach((e) => lines.push(`${formatCutTime(e.downMs)} — ${tooltipReason(e.reason)}`));
    }
    return lines.join("\n");
  }

  // ---------- Hallazgos del cliente ----------

  const STATUS_SENTENCES = {
    los: "Cliente presenta LOS.",
    "power fail": "Cliente presenta Power fail.",
    offline: "Cliente se encuentra Offline.",
  };

  // input = {
  //   status:     estado actual del cliente (texto de SmartOLT),
  //   clientData: { sig1490, sig1310, ... } (los mismos datos del informe),
  //   evaluation: resultado de SmartOLTShared.evaluateClientOptics,
  //   signal:     summarizeSignalSeries(...) | null (sin datos),
  //   cuts:       summarizeCuts(...) | null (no disponible),
  //   cutEvents:  cutEvents(...) (opcional: horas de cada corte, para el tooltip),
  //   box:        analyzeClientBox(...) | null,
  // }
  function buildClientFindings(input) {
    const findings = [];
    const add = (id, kind, dashboard, observation, tooltip = null) =>
      findings.push({ id, kind, dashboard, observation, tooltip });
    const key = statusKey(input.status);

    // Estado (el dashboard base ya lo muestra arriba).
    if (key && key !== "online") {
      add("status", "problem", null, STATUS_SENTENCES[key] || `Cliente en estado ${S.normalizeClientStatusLabel(input.status)}.`);
    }

    // OP: exactamente la evaluación del informe (❌ = no aprueba).
    const ev = input.evaluation;
    const cd = input.clientData || {};
    if (ev && ev.badge === "❌") {
      const diffs = [];
      if (ev.onuOk === false) diffs.push(`${S.opticalDiff(cd.sig1490, ev.cajaInfo.onuResult.avg).toFixed(2)} dB en ONU`);
      if (ev.oltOk === false && ev.effectiveOltOk !== true) {
        diffs.push(`${S.opticalDiff(cd.sig1310, ev.cajaInfo.oltResult.avg).toFixed(2)} dB en OLT`);
      }
      add(
        "op_out_of_margin",
        "problem",
        null,
        `Cliente presenta OP alto (ONU ${formatDbValue(cd.sig1490)} dBm / OLT ${formatDbValue(cd.sig1310)} dBm), ` +
          `con una diferencia de ${joinSpanish(diffs)} respecto al promedio de la caja.`
      );
    } else if (ev && ev.badge === "✅") {
      add("op_ok", "ok", null, "OP dentro del margen de la caja.");
    }

    // Fluctuación de la señal en 24 hs (serie histórica de SmartOLT).
    const signal = input.signal;
    if (signal) {
      const dashboard = `📈 Fluctuación OP ${signal.side} en 24 hs: ${signal.fluctuation.toFixed(2)} dB`;
      if (isRelevantFluctuation(signal)) {
        add(
          "signal_fluctuation",
          "problem",
          dashboard,
          `Se detectaron fluctuaciones de hasta ${signal.fluctuation.toFixed(2)} dB en la señal (${signal.side}) en las últimas 24 hs.`
        );
      } else {
        add("signal_stable", "ok", dashboard, `Sin fluctuaciones relevantes de señal en las últimas 24 hs (${signal.fluctuation.toFixed(2)} dB).`);
      }
    }

    // Cortes en 24 hs (tabla "History" de la OLT).
    const cuts = input.cuts;
    if (cuts) {
      if (cuts.count > 0) {
        const amount = `${cuts.atLeast ? "al menos " : ""}${cuts.count} ${cuts.count === 1 ? "corte" : "cortes"}`;
        // Dashboard: solo la cantidad; las causas (y horas) van en el tooltip.
        add(
          "cuts",
          "problem",
          `✂️ Cortes en 24 hs: ${cuts.atLeast ? "≥" : ""}${cuts.count}`,
          // Observación: solo la cantidad; las causas quedan en el tooltip.
          `Se ${cuts.count === 1 && !cuts.atLeast ? "registró" : "registraron"} ${amount} en las últimas 24 hs, según SmartOLT.`,
          buildCutsTooltip(cuts, input.cutEvents)
        );
      } else {
        add("no_cuts", "ok", "✂️ Sin cortes en 24 hs", "Sin cortes registrados en las últimas 24 hs.");
      }
    }

    // Afectación de la caja (según el CSV cargado).
    const box = input.box;
    if (box && box.inCsv) {
      if (box.possibleCut) {
        add("possible_box_cut", "problem", "🔴 Posible caja cortada", "Posible caja cortada.");
      } else if (box.otherLosPorts.length > 2) {
        add("many_other_los", "problem", "🚨 Varios clientes en LOS", "Se detectan además varios clientes en LOS.");
      } else if (box.otherLosPorts.length === 2) {
        const ports = box.otherLosPorts;
        add(
          "other_los",
          "problem",
          `🚨 Otros clientes en LOS: ${ports.map(portLabel).join(" y ")}`,
          `Se detectan además los puertos ${ports.map((p) => p || "?").join(" y ")} en LOS.`
        );
      } else if (box.otherLosPorts.length === 1) {
        const port = box.otherLosPorts[0];
        add("other_los", "problem", `🚨 Otro cliente en LOS: ${portLabel(port)}`, `Se detecta además el puerto ${port || "?"} en LOS.`);
      }
    }

    return findings;
  }

  // ---------- Observación para la orden de trabajo ----------

  // Con problemas: una frase por hallazgo, en el orden detectado (ninguno se
  // pierde). Sin problemas: el estado y los controles que dieron normal.
  function buildObservation(findings, status) {
    const problems = findings.filter((f) => f.kind === "problem");
    if (problems.length > 0) return problems.map((f) => f.observation).join(" ");
    const oks = findings.filter((f) => f.kind === "ok").map((f) => f.observation);
    const label = S.normalizeClientStatusLabel(status);
    const head = statusKey(status) === "online" ? "Cliente Online." : status ? `Cliente en estado ${label}.` : "";
    return [head, ...oks].filter(Boolean).join(" ");
  }

  // ---------- Informe de caja de Call Center ----------

  // A diferencia de ESTADO DE CAJA(S) de CCT, lista TODOS los clientes de cada
  // caja (orden por puerto), con su estado y, si están Online, su OP. Los
  // clientes con OP fuera de margen salen de buildCajaDiagnosis (la misma
  // fuente que el dashboard y el informe de CCT).
  function describeRecordLine(record, opOut) {
    const key = statusKey(record.status);
    const name = record.name || "(sin nombre)";
    const port = record.puerto ? `P${record.puerto}` : "P-";
    if (key === "online") {
      const op = `ONU ${formatDbValue(record.sig1490)} / OLT ${formatDbValue(record.sig1310)}`;
      return opOut ? `${port} 🟡 ${name} · ${op} · OP fuera de margen` : `${port} 🟢 ${name} · ${op}`;
    }
    if (!key) return `${port} ⚪ ${name} · Sin estado`;
    return `${port} ${S.getStatusIcon(record.status)} ${name} · ${S.normalizeClientStatusLabel(record.status)}`;
  }

  function buildCallCenterBoxReport(records) {
    const blocks = [];
    S.buildDataIdentity(records).cajaNames.forEach((key) => {
      const d = S.buildCajaDiagnosis(records, key);
      if (!d) return;
      const recordsInCaja = records.filter((r) => S.normalizeCajaName(r.caja) === key);
      const opSet = new Set(d.opClients.map((c) => c.record));
      const losCount = d.statusClients.filter((c) => statusKey(c.record.status) === "los").length;
      const otherCount = d.statusClients.length - losCount;

      const summary = [`${d.total} ${d.total === 1 ? "ONU" : "ONUs"}`, `🟢 ${d.online} Online`];
      if (losCount > 0) summary.push(`🔴 ${losCount} LOS`);
      if (otherCount > 0) summary.push(`⚫ ${otherCount} Power fail/Offline`);
      if (opSet.size > 0) summary.push(`🟡 ${opSet.size} OP fuera de margen`);

      const lines = [`📦 ${d.caja} · ${S.formatCajaHeaderAverage(records, d.caja) || "Sin promedio"}`, summary.join(" · ")];
      if (isPossibleCajaCut(recordsInCaja)) lines.push("🔴 Posible caja cortada");
      S.sortByPuertoAscending(recordsInCaja).forEach((r) => lines.push(describeRecordLine(r, opSet.has(r))));
      blocks.push(lines.join("\n"));
    });
    return blocks.join("\n\n");
  }

  const SmartOLTCallCenter = {
    CRITICAL_STATUSES,
    isCriticalStatus,
    isPossibleCajaCut,
    analyzeClientBox,
    summarizeSignalSeries,
    isRelevantFluctuation,
    parseStatusHistory,
    summarizeCuts,
    cutEvents,
    buildCutsTooltip,
    buildClientFindings,
    buildObservation,
    buildCallCenterBoxReport,
  };

  self.SmartOLTCallCenter = SmartOLTCallCenter;
})();
