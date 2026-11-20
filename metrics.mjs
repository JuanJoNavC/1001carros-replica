// Medición del cliente desde la web hasta la venta.
//
// - La web registra eventos propios (sin terceros) solo si el cliente acepta la medición.
// - Cada visitante tiene un código de referencia (Ref. 1001-XXXXX) que viaja en los mensajes de WhatsApp.
// - Los leads del sitio se agrupan en "clientes" del embudo comercial; el asesor avanza las etapas.
// - El tablero del analista compara los resultados con las metas del BSC (medicion/metas.json, editable).

import { readFileSync } from "node:fs";

export const VISITOR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const isValidVisitorId = id => typeof id === "string" && /^[A-HJ-NP-Z2-9]{16}$/.test(id);
export const refFromVisitor = id => (isValidVisitorId(id) ? `1001-${id.slice(0, 5)}` : null);
export const normalizeRef = ref => {
  const m = String(ref || "").toUpperCase().replace(/\s/g, "").match(/(?:1001-?)?([A-HJ-NP-Z2-9]{5})$/);
  return m ? `1001-${m[1]}` : null;
};

// Eventos que acepta el registro desde el navegador (los demás se registran en el servidor).
export const CLIENT_EVENTS = ["page_view", "vehicle_view", "calc_use", "whatsapp_click", "prequal_start", "assistant_open", "guide_open"];
export const EVENT_LABELS = {
  page_view: "Visitó una página", vehicle_view: "Vio la ficha de un carro", calc_use: "Usó la calculadora de cuotas",
  whatsapp_click: "Abrió WhatsApp", prequal_start: "Abrió la precalificación (pide cédula)", prequal_done: "Se precalificó con el buró",
  assistant_open: "Abrió el asistente", assistant_message: "Conversó con el asistente IA", reservation_start: "Inició una reserva",
  reservation_paid: "Pagó la reserva", application_start: "Empezó a subir documentos", contract_signed: "Firmó el contrato en línea",
  sell_quote: "Cotizó su carro", sell_submitted: "Envió fotos de su carro", sell_accepted: "Aceptó la oferta por su carro",
  lead_form: "Dejó sus datos en un formulario", guide_open: "Abrió la guía de fotos"
};

export const CHANNELS = {
  google_ads: "Google Ads", google: "Google (orgánico)", meta: "Facebook e Instagram", tiktok: "TikTok",
  whatsapp: "WhatsApp", email: "Correo", referido: "Otros sitios", directo: "Directo"
};

// Fuente de la visita a partir de los parámetros UTM, los identificadores de clic y el sitio de origen.
export function classifySource({ utm_source, utm_medium, utm_campaign, gclid, fbclid, ttclid, referrer } = {}, host = "") {
  const src = String(utm_source || "").toLowerCase(), med = String(utm_medium || "").toLowerCase();
  let ref = "";
  try { ref = referrer ? new URL(referrer).hostname.toLowerCase() : ""; } catch { ref = ""; }
  if (ref && host && ref.endsWith(host.toLowerCase().replace(/^www\./, ""))) ref = "";
  const paid = /cpc|ppc|paid|ads?$/.test(med);
  let channel = "directo";
  if (gclid || (src.includes("google") && paid)) channel = "google_ads";
  else if (fbclid || /facebook|instagram|^fb$|^ig$|meta/.test(src) || /facebook\.|instagram\.|fb\.me/.test(ref)) channel = "meta";
  else if (ttclid || src.includes("tiktok") || ref.includes("tiktok.")) channel = "tiktok";
  else if (src.includes("whatsapp") || /wa\.me|whatsapp\./.test(ref)) channel = "whatsapp";
  else if (src.includes("google") || /(^|\.)google\./.test(ref) || ref.includes("bing.")) channel = "google";
  else if (med === "email" || src.includes("mail")) channel = "email";
  else if (src || ref) channel = "referido";
  return { channel, source: (src || ref || "directo").slice(0, 60), medium: (med || (ref ? "referral" : "none")).slice(0, 40), campaign: String(utm_campaign || "").slice(0, 80) };
}

// ---- Embudo comercial ----
export const STAGES = ["nuevo", "contactado", "cita_agendada", "cita_asistida", "reservado", "vendido", "perdido"];
export const STAGE_LABELS = { nuevo: "Nuevo", contactado: "Contactado", cita_agendada: "Cita agendada", cita_asistida: "Cita asistida", reservado: "Reservado", vendido: "Vendido", perdido: "Perdido" };
export const LOST_REASONS = ["Precio", "Crédito no aprobado", "Compró en otro lugar", "No contesta", "Ya no le interesa", "Otro"];
export const stageIndex = stage => Math.max(0, STAGES.indexOf(stage));
export const isClosed = stage => stage === "vendido" || stage === "perdido";
// Etapa más avanzada a la que llegó un cliente (aunque luego se haya perdido).
export function maxStage(row) {
  const visited = [row.stage, ...(row.history || []).map(h => h.stage)].filter(s => s && s !== "perdido");
  return visited.reduce((best, s) => (stageIndex(s) > stageIndex(best) ? s : best), "nuevo");
}
// Etapa que sugiere un lead automático del sitio.
export function stageHint(kind, message = "") {
  const m = String(message).toLowerCase();
  if (kind === "reservation" && m.includes("pagada")) return "reservado";
  if ((kind === "reservation" && m.includes("visita agendada")) || (kind === "sell" && m.includes("inspección"))) return "cita_agendada";
  return null;
}
export const TOOL_OF_KIND = { reservation: "reserva", prequalification: "precalificacion", sell: "cotizador", contract: "documentos", verification_review: "documentos", assistant: "asistente", whatsapp: "whatsapp" };

// ---- Metas ----
let cachedTargets = null;
export function loadTargets() {
  if (cachedTargets) return cachedTargets;
  try { cachedTargets = JSON.parse(readFileSync(new URL("./medicion/metas.json", import.meta.url), "utf8")); } catch { cachedTargets = { anio_proyecto: 1, indicadores: {}, pasos_compra: [], inversion_marketing_mensual: 0 }; }
  return cachedTargets;
}
const yearTarget = (value, year) => (Array.isArray(value) ? value[Math.min(value.length, Math.max(1, year)) - 1] : value);

// Semáforo: ok si cumple la meta; warn si mejoró frente a la línea base o está cerca; bad si no.
export function trafficLight(value, target, baseline, direction = "up") {
  if (value === null || value === undefined || Number.isNaN(value) || target === null || target === undefined) return "na";
  const better = (a, b) => (direction === "up" ? a >= b : a <= b);
  if (better(value, target)) return "ok";
  if (baseline !== null && baseline !== undefined && better(value, baseline)) return "warn";
  const gap = direction === "up" ? value / target : target / Math.max(value, 1e-9);
  return gap >= 0.9 ? "warn" : "bad";
}

const pct = (a, b) => (b > 0 ? a / b : null);
const DAY = 86400000;
const EC = 5 * 3600000; // Ecuador, UTC-5
export const localDay = d => new Date(new Date(d).getTime() - EC).toISOString().slice(0, 10);
// Periodo en hora de Ecuador: "mes" = mes en curso; "30d" / "90d" = últimos días.
export function periodRange(period = "mes", now = new Date()) {
  const local = new Date(now.getTime() - EC);
  const startOfDay = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) + EC;
  const to = new Date(startOfDay + DAY);
  if (period === "30d" || period === "90d") return { from: new Date(to.getTime() - (period === "30d" ? 30 : 90) * DAY), to, period };
  return { from: new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) + EC), to, period: "mes" };
}

// ---- Tablero con datos reales ----
// raw: { sessionsByChannel:[{channel,sessions}], sessionsByDay:[{day,sessions}], visitorKinds:[{kind,visitors,events}],
//        pipeline:[rows], sell:{total,offer,evaluation,accepted}, visitorTools:{visitorId:[kinds]}, assistantVisitors, conversationVisitors }
export function computeDashboard(raw, { targets = loadTargets(), from, to, now = new Date() } = {}) {
  const year = Number(targets.anio_proyecto || 1), ind = targets.indicadores || {};
  const days = Math.max(1, Math.round((to - from) / DAY));
  const monthFactor = days / 30;
  const sessions = raw.sessionsByChannel.reduce((s, r) => s + Number(r.sessions), 0);
  const kindVisitors = Object.fromEntries(raw.visitorKinds.map(r => [r.kind, Number(r.visitors)]));
  const kindEvents = Object.fromEntries(raw.visitorKinds.map(r => [r.kind, Number(r.events)]));
  const inRange = d => d && new Date(d) >= from && new Date(d) < to;
  const pipe = raw.pipeline;
  const created = pipe.filter(p => inRange(p.created_at));
  const sold = pipe.filter(p => p.stage === "vendido" && inRange(p.sold_at));
  const soldWeb = sold.filter(p => p.visitor_id || (p.channel && p.channel !== "agencia"));
  const reached = s => created.filter(p => stageIndex(maxStage(p)) >= stageIndex(s)).length;
  const tickets = created.length, agendadas = reached("cita_agendada"), asistidas = reached("cita_asistida");
  const ventasDeCreados = created.filter(p => p.stage === "vendido").length;
  const conversations = raw.conversationVisitors;
  const ticketsFromConversations = raw.conversationVisitorsWithLead;
  const prequalStart = kindVisitors.prequal_start || 0, prequalDone = kindVisitors.prequal_done || 0;
  const reservasPagadas = pipe.filter(p => inRange(p.created_at) && (p.kinds || []).includes("reservation") && stageIndex(maxStage(p)) >= stageIndex("reservado"));
  const reservasVendidas = reservasPagadas.filter(p => p.stage === "vendido").length;
  const contacted = created.filter(p => p.contacted_at);
  const avgResponseMin = contacted.length ? contacted.reduce((s, p) => s + (new Date(p.contacted_at) - new Date(p.created_at)), 0) / contacted.length / 60000 : null;
  const avgDaysToSale = sold.length ? sold.reduce((s, p) => s + (new Date(p.sold_at) - new Date(p.created_at)), 0) / sold.length / DAY : null;
  const steps = targets.pasos_compra || [];
  const marketing = Number(targets.inversion_marketing_mensual || 0) * monthFactor;
  const t = id => ind[id] || {};

  const kpi = (id, value, opts = {}) => {
    const def = t(id), target = opts.target !== undefined ? opts.target : yearTarget(def.meta, year);
    return { id, perspective: def.perspectiva, label: def.nombre || id, formula: def.formula, source: def.fuente, value, target, baseline: def.linea_base ?? null,
      unit: def.unidad || "", direction: def.direccion || "up", status: trafficLight(value, target, def.linea_base ?? null, def.direccion || "up"), detail: opts.detail || "", alert: opts.alert || "" };
  };
  const conv = pct(sold.length, sessions);
  const convAlert = t("conversion_web").umbral_valor && conv !== null && conv < t("conversion_web").umbral_valor ? "Por debajo del mínimo para crear valor (≈ 0,68%)." : "";
  const kpis = [
    kpi("conversion_web", conv, { detail: `${sold.length} ventas ÷ ${sessions.toLocaleString("es-EC")} visitas`, alert: convAlert }),
    kpi("ventas_web", soldWeb.length / monthFactor, { detail: `${soldWeb.length} en el periodo (${days} días), llevado a 30 días` }),
    kpi("costo_prospecto", tickets >= 20 ? marketing / tickets : null, { detail: tickets >= 20 ? `Inversión de ${Math.round(marketing).toLocaleString("es-EC")} USD en el periodo ÷ ${tickets} prospectos` : `Se calcula con al menos 20 prospectos (hay ${tickets})` }),
    kpi("conversacion_a_ticket", pct(ticketsFromConversations, conversations), { detail: `${ticketsFromConversations} de ${conversations} visitantes que conversaron dejaron sus datos` }),
    kpi("abandono_cedula", prequalStart ? 1 - prequalDone / prequalStart : null, { detail: `${prequalStart - prequalDone > 0 ? prequalStart - prequalDone : 0} de ${prequalStart} abandonaron al pedir la cédula` }),
    kpi("ventas_por_1000", conversations ? (1000 * created.filter(p => p.stage === "vendido" && p.conversed).length) / conversations : null, { detail: "Ventas de clientes que conversaron × 1.000 ÷ conversaciones" }),
    kpi("ticket_a_cita", pct(agendadas, tickets), { detail: `${agendadas} de ${tickets}` }),
    kpi("cita_asistida", pct(asistidas, agendadas), { detail: `${asistidas} de ${agendadas}` }),
    kpi("asistida_a_venta", pct(ventasDeCreados, asistidas), { detail: `${ventasDeCreados} de ${asistidas}` }),
    kpi("reservas_a_venta", pct(reservasVendidas, reservasPagadas.length), { detail: `${reservasVendidas} de ${reservasPagadas.length} reservas` }),
    kpi("pasos_en_linea", steps.filter(s => s.en_linea).length, { detail: steps.filter(s => s.en_linea).map(s => s.paso).join(", ") }),
    kpi("tiempo_respuesta", avgResponseMin, { detail: `${contacted.length} clientes contactados` }),
    kpi("dias_a_venta", avgDaysToSale, { detail: `${sold.length} ventas` })
  ];

  const viewed = kindVisitors.vehicle_view || 0;
  const conversed = conversations;
  const evaluated = ["calc_use", "prequal_done", "sell_quote"].reduce((m, k) => Math.max(m, kindVisitors[k] || 0), 0);
  const nps = targets.nps || {};
  const funnel = [
    { stage: "Descubre", value: sessions, note: "Visitas (sesiones)" },
    { stage: "Explora la web", value: viewed, note: "Visitantes que vieron una ficha" },
    { stage: "Conversa", value: conversed, note: "Asistente IA o WhatsApp" },
    { stage: "Avalúa y financia", value: evaluated, note: "Calculadora, precalificación o cotizador" },
    { stage: "Reserva", value: kindVisitors.reservation_paid || 0, note: "Reservas pagadas en línea" },
    { stage: "Visita y prueba", value: asistidas, note: "Citas asistidas (las marca el asesor)" },
    { stage: "Compra", value: sold.length, note: "Ventas (las marca el asesor)" },
    { stage: "Entrega y posventa", value: null, note: `NPS ${nps.actual ?? "—"} (meta ${nps.meta ?? "—"}); se mide con la encuesta posventa` }
  ];

  const channels = Object.keys(CHANNELS).map(ch => {
    const s = Number((raw.sessionsByChannel.find(r => r.channel === ch) || {}).sessions || 0);
    const leads = created.filter(p => p.channel === ch).length, ventas = sold.filter(p => p.channel === ch).length;
    const spend = Number((targets.inversion_por_canal || {})[ch] || 0) * monthFactor;
    return { channel: ch, label: CHANNELS[ch], sessions: s, leads, sales: ventas, conversion: pct(ventas, s), costPerLead: spend && leads ? spend / leads : null };
  }).filter(c => c.sessions || c.leads || c.sales);

  const toolNames = { reserva: "Reserva en línea", precalificacion: "Precalificación con buró", asistente: "Asistente IA", cotizador: "Cotizador de tu carro", documentos: "Documentos y contrato", calculadora: "Calculadora de cuotas", whatsapp: "WhatsApp" };
  const tools = Object.keys(toolNames).map(tool => {
    const users = created.filter(p => (p.tools || []).includes(tool));
    return { tool, label: toolNames[tool], customers: users.length, sales: users.filter(p => p.stage === "vendido").length, conversion: pct(users.filter(p => p.stage === "vendido").length, users.length) };
  });

  const advisors = {};
  for (const p of created) {
    const a = p.advisor || "Sin asignar";
    advisors[a] ||= { advisor: a, customers: 0, contacted: 0, sales: 0, responseMin: [] };
    advisors[a].customers++;
    if (p.contacted_at) { advisors[a].contacted++; advisors[a].responseMin.push((new Date(p.contacted_at) - new Date(p.created_at)) / 60000); }
    if (p.stage === "vendido") advisors[a].sales++;
  }
  const lost = {};
  for (const p of created.filter(p => p.stage === "perdido")) lost[p.lost_reason || "Otro"] = (lost[p.lost_reason || "Otro"] || 0) + 1;

  const byDay = {};
  for (let d = new Date(from); d < to; d = new Date(d.getTime() + DAY)) { const k = localDay(d); byDay[k] = { day: k, sessions: 0, leads: 0, sales: 0 }; }
  for (const r of raw.sessionsByDay) if (byDay[r.day]) byDay[r.day].sessions = Number(r.sessions);
  for (const p of created) { const k = localDay(p.created_at); if (byDay[k]) byDay[k].leads++; }
  for (const p of sold) { const k = localDay(p.sold_at); if (byDay[k]) byDay[k].sales++; }

  return {
    mode: "real", from: from.toISOString(), to: to.toISOString(), days, year, generatedAt: now.toISOString(),
    totals: { sessions, visitors: raw.visitors || 0, leads: tickets, sales: sold.length, salesWeb: soldWeb.length, events: Object.values(kindEvents).reduce((a, b) => a + b, 0) },
    kpis, funnel, channels, tools,
    speed: { avgResponseMin, avgDaysToSale, contacted: contacted.length },
    advisors: Object.values(advisors).map(a => ({ advisor: a.advisor, customers: a.customers, contacted: a.contacted, sales: a.sales, avgResponseMin: a.responseMin.length ? a.responseMin.reduce((x, y) => x + y, 0) / a.responseMin.length : null })),
    lostReasons: Object.entries(lost).map(([reason, count]) => ({ reason, count })),
    sell: raw.sell, steps, series: Object.values(byDay)
  };
}

// ---- Datos de ejemplo (calibrados con la línea base de la empresa y el año 1 del caso de negocio) ----
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
export function demoDashboard({ targets = loadTargets(), from, to, now = new Date() } = {}) {
  const r = rng(Math.floor(from.getTime() / DAY) * 31 + Math.floor(to.getTime() / DAY));
  const days = Math.max(1, Math.round((to - from) / DAY)), f = days / 30;
  const jitter = (v, p = 0.08) => v * (1 + (r() * 2 - 1) * p);
  const sessions = Math.round(jitter(60000 * f, 0.03));
  const conversations = Math.round(jitter(5200 * f));
  const tickets = Math.round(conversations * jitter(0.27, 0.05));
  const agendadas = Math.round(tickets * jitter(0.44, 0.04)), asistidas = Math.round(agendadas * jitter(0.47, 0.04));
  const ventasConv = Math.round(asistidas * jitter(0.105, 0.05));
  const soldWeb = Math.round(jitter(41 * f, 0.06)), salesTotal = Math.round(jitter(401 * f, 0.02));
  const prequalStart = Math.round(jitter(1300 * f)), prequalDone = Math.round(prequalStart * jitter(0.52, 0.05));
  const reservas = Math.round(jitter(70 * f)), reservasVendidas = Math.round(reservas * jitter(0.74, 0.04));
  const raw = {
    sessionsByChannel: [], sessionsByDay: [], visitorKinds: [], pipeline: [], visitors: Math.round(sessions * 0.71),
    conversationVisitors: conversations, conversationVisitorsWithLead: tickets,
    sell: { total: Math.round(jitter(210 * f)), offer: 0, evaluation: 0, accepted: 0 }
  };
  raw.sell.evaluation = Math.round(raw.sell.total * 0.31); raw.sell.offer = raw.sell.total - raw.sell.evaluation; raw.sell.accepted = Math.round(raw.sell.total * 0.22);
  const split = { meta: 0.38, google_ads: 0.17, google: 0.16, directo: 0.14, tiktok: 0.07, whatsapp: 0.05, referido: 0.03 };
  const real = computeDashboard({ ...raw }, { targets, from, to, now });
  const year = Number(targets.anio_proyecto || 1), ind = targets.indicadores || {};
  const set = (id, value, detail) => { const k = real.kpis.find(x => x.id === id); if (!k) return; k.value = value; k.detail = detail; k.status = trafficLight(value, k.target, k.baseline, k.direction); k.alert = id === "conversion_web" && ind.conversion_web?.umbral_valor && value < ind.conversion_web.umbral_valor ? "Por debajo del mínimo para crear valor (≈ 0,68%)." : ""; };
  const conv = (360 * f + soldWeb) / sessions;
  set("conversion_web", conv, `${Math.round(360 * f + soldWeb)} ventas ÷ ${sessions.toLocaleString("es-EC")} visitas`);
  set("ventas_web", soldWeb / f, `${soldWeb} ventas adicionales con origen web en ${days} días`);
  set("costo_prospecto", (Number(targets.inversion_marketing_mensual || 0) * f) / (tickets + 1900 * f), `Inversión del periodo ÷ ${Math.round(tickets + 1900 * f)} prospectos`);
  set("conversacion_a_ticket", tickets / conversations, `${tickets} de ${conversations}`);
  set("abandono_cedula", 1 - prequalDone / prequalStart, `${prequalStart - prequalDone} de ${prequalStart}`);
  set("ventas_por_1000", (1000 * ventasConv) / conversations, `${ventasConv} ventas de ${conversations} conversaciones`);
  set("ticket_a_cita", agendadas / tickets, `${agendadas} de ${tickets}`);
  set("cita_asistida", asistidas / agendadas, `${asistidas} de ${agendadas}`);
  set("asistida_a_venta", ventasConv / asistidas, `${ventasConv} de ${asistidas}`);
  set("reservas_a_venta", reservasVendidas / reservas, `${reservasVendidas} de ${reservas}`);
  set("tiempo_respuesta", jitter(38, 0.15), `${Math.round(tickets * 0.93)} clientes contactados`);
  set("dias_a_venta", jitter(24, 0.1), `${salesTotal} ventas`);
  real.mode = "demo";
  real.totals = { sessions, visitors: raw.visitors, leads: tickets, sales: salesTotal, salesWeb: soldWeb, events: Math.round(sessions * 6.4) };
  real.funnel = [
    { stage: "Descubre", value: sessions, note: "Visitas (sesiones)" },
    { stage: "Explora la web", value: Math.round(sessions * 0.46), note: "Visitantes que vieron una ficha" },
    { stage: "Conversa", value: conversations, note: "Asistente IA o WhatsApp" },
    { stage: "Avalúa y financia", value: Math.round(prequalDone + 900 * f), note: "Calculadora, precalificación o cotizador" },
    { stage: "Reserva", value: reservas, note: "Reservas pagadas en línea" },
    { stage: "Visita y prueba", value: asistidas, note: "Citas asistidas (las marca el asesor)" },
    { stage: "Compra", value: salesTotal, note: "Ventas totales; las de origen web se ven en los indicadores" },
    real.funnel[7]
  ];
  real.channels = Object.entries(split).map(([ch, share]) => {
    const s = Math.round(sessions * share), leads = Math.round(tickets * share * jitter(1, 0.25)), sales = Math.max(0, Math.round(soldWeb * share * jitter(1, 0.3)));
    const spend = Number((targets.inversion_por_canal || {})[ch] || 0) * f;
    return { channel: ch, label: CHANNELS[ch], sessions: s, leads, sales, conversion: s ? sales / s : null, costPerLead: spend && leads ? spend / leads : null };
  });
  real.tools = [["reserva", "Reserva en línea", 0.09, 0.62], ["precalificacion", "Precalificación con buró", 0.31, 0.16], ["asistente", "Asistente IA", 0.58, 0.09], ["cotizador", "Cotizador de tu carro", 0.12, 0.14], ["documentos", "Documentos y contrato", 0.07, 0.71], ["calculadora", "Calculadora de cuotas", 0.44, 0.08], ["whatsapp", "WhatsApp", 0.47, 0.1]]
    .map(([tool, label, share, cr]) => { const c = Math.round(tickets * share), s = Math.round(c * jitter(cr, 0.1)); return { tool, label, customers: c, sales: s, conversion: c ? s / c : null }; });
  real.speed = { avgResponseMin: real.kpis.find(k => k.id === "tiempo_respuesta").value, avgDaysToSale: real.kpis.find(k => k.id === "dias_a_venta").value, contacted: Math.round(tickets * 0.93) };
  const names = ["Andrea Salazar", "Diego Jaramillo", "María Fernanda León", "Carlos Vega", "Gabriela Ortiz", "Pablo Andrade"];
  real.advisors = names.map((advisor, i) => { const c = Math.round((tickets / names.length) * jitter(1, 0.3)), s = Math.round(c * jitter(0.035 + i * 0.004, 0.2)); return { advisor, customers: c, contacted: Math.round(c * jitter(0.92, 0.05)), sales: s, avgResponseMin: jitter(20 + i * 9, 0.2) }; });
  real.lostReasons = [["Precio", 0.27], ["Crédito no aprobado", 0.22], ["No contesta", 0.21], ["Compró en otro lugar", 0.17], ["Ya no le interesa", 0.09], ["Otro", 0.04]].map(([reason, share]) => ({ reason, count: Math.round(tickets * 0.55 * share) }));
  real.sell = raw.sell;
  real.series = real.series.map(d => { const w = new Date(d.day).getUTCDay(), k = w === 0 ? 0.7 : w === 6 ? 1.15 : 1; return { day: d.day, sessions: Math.round((sessions / days) * k * jitter(1, 0.12)), leads: Math.round((tickets / days) * k * jitter(1, 0.2)), sales: Math.max(0, Math.round((salesTotal / days) * k * jitter(1, 0.35))) }; });
  return real;
}
