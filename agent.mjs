// Asesor virtual con IA (agente con herramientas).
//
// El modelo (Claude, de Anthropic) recibe:
//   1. Las instrucciones y el conocimiento de asistente/*.md (editables en español).
//   2. El contexto de la conversación: página actual, carro que está viendo y estado de su trámite.
//   3. Las herramientas: funciones del sitio que puede usar (buscar carros, calcular cuota, etc.).
// Las acciones sensibles (pagar, firmar, autorizar el buró) NO las ejecuta el agente: devuelve botones
// que llevan al cliente a las pantallas seguras del sitio, donde él confirma.
//
// Sin ANTHROPIC_API_KEY el sitio sigue usando el asistente por reglas (assistant.mjs).

import { readFileSync } from "node:fs";
import { loanQuoteServer } from "./agent-tools-math.mjs";
import { createOffer } from "./tradein.mjs";
import { WHATSAPP_NUMBER } from "./assistant.mjs";
import { RESERVATION_AMOUNT_USD } from "./payments.mjs";

export const DEFAULT_MODEL = "claude-haiku-5-5";
export const API_URL = "https://api.anthropic.com/v1/messages";
export const MAX_TOOL_ROUNDS = 5;
export const MAX_HISTORY = 16;
export const MAX_USER_CHARS = 1000;
export const MAX_TURNS_PER_CONVERSATION = 40;

const readText = name => { try { return readFileSync(new URL(`./asistente/${name}`, import.meta.url), "utf8"); } catch { return ""; } };
let cachedPrompt = null;
export function basePrompt() {
  if (!cachedPrompt) cachedPrompt = `${readText("instrucciones.md")}\n\n${readText("conocimiento.md")}`.trim();
  return cachedPrompt;
}

export function agentSettings(env = process.env) {
  const apiKey = String(env.ANTHROPIC_API_KEY || "").trim();
  return { enabled: Boolean(apiKey), apiKey, model: String(env.ASISTENTE_MODEL || DEFAULT_MODEL).trim() };
}

// Protege datos sensibles: nunca se envían al modelo números de cédula o de tarjeta completos.
export function redactSensitive(text) {
  return String(text || "")
    .replace(/\b\d(?:[ -]?\d){12,18}\b/g, "[número oculto]")
    .replace(/\b\d{10}(?:001)?\b/g, "[número oculto]")
    .slice(0, MAX_USER_CHARS);
}

// ---------------- Herramientas ----------------
const S = (properties, required = []) => ({ type: "object", properties, required });
export const TOOLS = [
  { name: "buscar_carros", description: "Busca carros disponibles en el catálogo de 1001Carros. Úsala siempre antes de recomendar o mencionar carros, precios o disponibilidad. Devuelve hasta 6 resultados.",
    input_schema: S({ texto: { type: "string", description: "Marca, modelo u otra palabra clave, ej. 'Toyota RAV4'" }, tipo: { type: "string", enum: ["suv", "automovil", "camioneta"] }, condicion: { type: "string", enum: ["seminuevos", "nuevos"] }, precio_max: { type: "number" }, precio_min: { type: "number" }, transmision: { type: "string", enum: ["Automática", "Manual"] }, ciudad: { type: "string" }, anio_min: { type: "number" }, orden: { type: "string", enum: ["precio-asc", "precio-desc", "anio-desc", "km-asc"] } }) },
  { name: "ver_carro", description: "Detalle completo de un carro por su id: precio, año, kilometraje, motor, color, agencia y si está disponible o reservado.",
    input_schema: S({ carro_id: { type: "number" } }, ["carro_id"]) },
  { name: "calcular_cuota", description: "Calcula la cuota mensual referencial de un carro con una entrada y un plazo (12 a 72 meses). Si no se indica la entrada, usa 25%.",
    input_schema: S({ carro_id: { type: "number" }, precio: { type: "number" }, entrada: { type: "number" }, plazo_meses: { type: "number" } }) },
  { name: "listar_agencias", description: "Lista las agencias de 1001Carros con dirección, ciudad, horario y teléfono.",
    input_schema: S({ ciudad: { type: "string" } }) },
  { name: "cotizar_mi_carro", description: "Estima el rango que 1001Carros pagaría por el carro del cliente (parte de pago o venta). Necesita marca, modelo, año y kilometraje.",
    input_schema: S({ marca: { type: "string" }, modelo: { type: "string" }, anio: { type: "number" }, kilometraje: { type: "number" }, estado: { type: "string", enum: ["excelente", "bueno", "regular"] } }, ["marca", "modelo", "anio", "kilometraje"]) },
  { name: "estado_de_mi_tramite", description: "Muestra cómo va el proceso del cliente: precalificación, reserva y documentos (qué falta). Usa el contexto de la sesión del cliente.",
    input_schema: S({}) },
  { name: "abrir_precalificacion", description: "Prepara el botón para que el cliente se precalifique en un carro (consulta al buró con su autorización). El cliente completa el formulario seguro.",
    input_schema: S({ carro_id: { type: "number" } }, ["carro_id"]) },
  { name: "abrir_reserva", description: `Prepara el botón para reservar un carro con USD ${RESERVATION_AMOUNT_USD}. El cliente elige la agencia, confirma su celular y paga en la pantalla segura.`,
    input_schema: S({ carro_id: { type: "number" } }, ["carro_id"]) },
  { name: "agendar_test_drive", description: "Prepara el botón para agendar un test drive o una visita sin compromiso para un carro.",
    input_schema: S({ carro_id: { type: "number" } }, ["carro_id"]) },
  { name: "abrir_documentos", description: "Prepara el botón para subir documentos, verificar datos y firmar el contrato de un carro.",
    input_schema: S({ carro_id: { type: "number" } }, ["carro_id"]) },
  { name: "hablar_con_asesor", description: "Prepara el botón de WhatsApp con un asesor humano, con un resumen de lo que necesita el cliente. Úsala si lo pide, está molesto, quiere negociar o no puedes resolverlo.",
    input_schema: S({ resumen: { type: "string", description: "Resumen breve para el asesor (sin datos sensibles)." } }, ["resumen"]) }
];

const carLabel = car => `${car.year} ${car.brand} ${car.model}`;
const carCard = car => ({ id: car.id, label: carLabel(car), price: Number(car.price), mileage: Number(car.mileage), city: car.city, transmission: car.transmission, status: car.status, image: car.image || "", href: `/vehiculo/${car.id}` });
const norm = value => String(value || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function matchesText(car, text) {
  const words = norm(text).split(/\s+/).filter(word => word.length > 1);
  const haystack = norm(`${car.brand} ${car.model} ${car.year} ${car.category} ${car.fuel} ${car.city} ${car.transmission} ${car.color}`);
  return words.every(word => haystack.includes(word));
}

export async function runTool(name, input = {}, { store, context = {}, now = new Date() }) {
  const out = { result: null, cars: [], actions: [] };
  const vehicleFor = async id => { const car = Number.isInteger(Number(id)) ? await store.getVehicle(Number(id)) : null; return car; };
  switch (name) {
    case "buscar_carros": {
      const filters = {};
      if (input.tipo) filters.category = input.tipo;
      if (input.condicion) filters.catalogType = input.condicion === "nuevos" ? "nuevos" : "usados";
      if (input.precio_max) filters.maxPrice = input.precio_max;
      if (input.precio_min) filters.minPrice = input.precio_min;
      if (input.transmision) filters.transmission = input.transmision;
      if (input.ciudad) filters.city = input.ciudad;
      filters.sort = { "precio-asc": "price-asc", "precio-desc": "price-desc", "anio-desc": "year-desc", "km-asc": "mileage-asc" }[input.orden] || undefined;
      let cars = await store.listVehicles(filters);
      if (input.anio_min) cars = cars.filter(car => Number(car.year) >= Number(input.anio_min));
      if (input.texto) cars = cars.filter(car => matchesText(car, input.texto));
      const total = cars.length, top = cars.slice(0, 6);
      out.cars = top.map(carCard);
      out.result = { total, resultados: top.map(car => ({ id: car.id, carro: carLabel(car), precio: Number(car.price), km: Number(car.mileage), ciudad: car.city, transmision: car.transmission, tipo: car.category, estado: car.status === "reserved" ? "reservado" : "disponible" })) };
      return out;
    }
    case "ver_carro": {
      const car = await vehicleFor(input.carro_id);
      if (!car) { out.result = { error: "No existe un carro con ese id." }; return out; }
      out.cars = [carCard(car)];
      out.result = { id: car.id, carro: carLabel(car), precio: Number(car.price), km: Number(car.mileage), motor: car.engine, transmision: car.transmission, traccion: car.drive, combustible: car.fuel, color: car.color, ciudad: car.city, agencia: car.agency ? `${car.agency.name}, ${car.agency.address}` : null, estado: car.status === "reserved" ? "reservado" : "disponible" };
      return out;
    }
    case "calcular_cuota": {
      const car = input.carro_id ? await vehicleFor(input.carro_id) : null;
      const price = Number(car?.price || input.precio);
      if (!(price > 0)) { out.result = { error: "Necesito el carro o el precio." }; return out; }
      const down = input.entrada === undefined ? Math.round(price * 0.25) : Number(input.entrada);
      const term = Math.min(72, Math.max(12, Math.round(Number(input.plazo_meses || 60) / 12) * 12));
      out.result = { ...(car ? { carro: carLabel(car) } : {}), ...loanQuoteServer(price, down, term), nota: "Cuota referencial con la tasa de consumo; la cuota real se conoce al precalificarse." };
      return out;
    }
    case "listar_agencias": {
      let agencies = await store.listAgencies();
      if (input.ciudad) agencies = agencies.filter(agency => norm(agency.city).includes(norm(input.ciudad)) || norm(agency.name).includes(norm(input.ciudad)));
      out.result = agencies.map(agency => ({ id: agency.id, nombre: agency.name, direccion: agency.address, ciudad: agency.city, horario: agency.hours, telefono: agency.phone }));
      return out;
    }
    case "cotizar_mi_carro": {
      const reference = await store.listVehicles({});
      const offer = createOffer({ brand: input.marca, model: input.modelo, year: input.anio, mileage: input.kilometraje, condition: input.estado || "bueno" }, { now, reference });
      if (!offer) { out.result = { error: "Revisa marca, modelo, año y kilometraje." }; return out; }
      out.result = { rango_desde: offer.low, rango_hasta: offer.high, valido_hasta: offer.validUntil, nota: "Rango referencial; el valor final se confirma con la inspección en la agencia." };
      out.actions.push({ type: "link", label: "Cotizar mi carro en detalle", href: "/vender" });
      return out;
    }
    case "estado_de_mi_tramite": {
      const status = { precalificacion: context.prequal || null, reservas: context.reservations || [], documentos: [] };
      for (const [vehicleId, token] of Object.entries(context.applications || {}).slice(0, 3)) {
        const app = await store.getApplication(String(token));
        if (!app) continue;
        const files = await store.listApplicationFiles(app.id);
        const { publicApplication } = await import("./applications.mjs");
        const view = publicApplication(app, files);
        status.documentos.push({ carro_id: Number(vehicleId), estado: view.status, faltan: view.required.filter(item => !item.uploaded).map(item => item.label), verificacion: view.verification.status, contrato: view.signedAt ? "firmado" : view.contract ? "generado" : "pendiente" });
        out.actions.push({ type: "link", label: "Continuar con mis documentos", href: `/documentos?vehiculo=${vehicleId}` });
      }
      out.result = status;
      return out;
    }
    case "abrir_precalificacion":
    case "abrir_reserva":
    case "agendar_test_drive":
    case "abrir_documentos": {
      const car = await vehicleFor(input.carro_id);
      if (!car) { out.result = { error: "No existe un carro con ese id." }; return out; }
      if (name === "abrir_reserva" && car.status !== "available") { out.result = { error: "Ese carro ya está reservado. Ofrece opciones similares." }; return out; }
      const action = {
        abrir_precalificacion: { type: "prequal", label: `Precalificarme para el ${car.brand} ${car.model}`, href: `/vehiculo/${car.id}?precalificar=1`, vehicleId: car.id },
        abrir_reserva: { type: "link", label: `Reservar el ${car.brand} ${car.model} por USD ${RESERVATION_AMOUNT_USD}`, href: `/reserva/${car.id}` },
        agendar_test_drive: { type: "link", label: `Agendar test drive del ${car.brand} ${car.model}`, href: `/reservar/${car.id}` },
        abrir_documentos: { type: "link", label: "Subir documentos y firmar", href: `/documentos?vehiculo=${car.id}` }
      }[name];
      out.actions.push(action);
      out.result = { listo: true, boton: action.label, nota: "El cliente verá un botón para continuar en la pantalla segura." };
      return out;
    }
    case "hablar_con_asesor": {
      const summary = redactSensitive(input.resumen || "").slice(0, 400);
      const text = `Hola, vengo del asistente virtual de 1001Carros. ${summary}`.trim();
      out.actions.push({ type: "whatsapp", label: "Hablar con un asesor por WhatsApp", href: `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}` });
      out.result = { listo: true, nota: "El cliente verá el botón de WhatsApp." };
      return out;
    }
    default:
      out.result = { error: `Herramienta desconocida: ${name}` };
      return out;
  }
}

// ---------------- Conversación ----------------
export function contextBlock(context = {}, now = new Date()) {
  const lines = [`Fecha y hora en Ecuador: ${new Date(now.getTime() - 5 * 3600000).toISOString().slice(0, 16).replace("T", " ")}.`];
  if (context.page) lines.push(`El cliente está en la página: ${String(context.page).slice(0, 80)}.`);
  if (context.vehicle) lines.push(`Está viendo el carro id ${context.vehicle.id}: ${String(context.vehicle.label).slice(0, 80)}, precio $${context.vehicle.price}. Si dice "este carro", se refiere a este.`);
  if (context.prequal) lines.push(`Ya se precalificó: ${JSON.stringify(context.prequal).slice(0, 300)}.`);
  if (context.reservations?.length) lines.push(`Tiene reservas: ${JSON.stringify(context.reservations).slice(0, 300)}.`);
  if (context.applications && Object.keys(context.applications).length) lines.push(`Tiene expedientes de documentos para los carros: ${Object.keys(context.applications).join(", ")}.`);
  return lines.join("\n");
}

export function sanitizeContext(raw = {}) {
  const vehicle = raw.vehicle && Number.isInteger(Number(raw.vehicle.id)) ? { id: Number(raw.vehicle.id), label: String(raw.vehicle.label || "").slice(0, 80), price: Number(raw.vehicle.price) || 0 } : null;
  const prequal = raw.prequal && typeof raw.prequal === "object" ? { estado: String(raw.prequal.status || ""), carro_id: Number(raw.prequal.vehicleId) || null, cuota: Number(raw.prequal.monthly) || null, plazo: Number(raw.prequal.term) || null, reporte_vigente_hasta: String(raw.prequal.expiresAt || "").slice(0, 30) } : null;
  const reservations = Array.isArray(raw.reservations) ? raw.reservations.slice(0, 3).map(item => ({ carro_id: Number(item.vehicleId) || null, carro: String(item.label || "").slice(0, 60), codigo: String(item.code || "").slice(0, 40) })) : [];
  const applications = {};
  if (raw.applications && typeof raw.applications === "object") for (const [key, value] of Object.entries(raw.applications).slice(0, 5)) if (/^\d+$/.test(key) && typeof value === "string" && value.length <= 60) applications[key] = value;
  return { page: String(raw.page || "").slice(0, 80), vehicle, prequal, reservations, applications };
}

export function sanitizeHistory(messages = []) {
  const clean = (Array.isArray(messages) ? messages : [])
    .filter(message => message && ["user", "assistant"].includes(message.role) && typeof message.text === "string" && message.text.trim())
    .slice(-MAX_HISTORY)
    .map(message => ({ role: message.role, content: message.role === "user" ? redactSensitive(message.text) : String(message.text).slice(0, 2000) }));
  while (clean.length && clean[0].role !== "user") clean.shift();
  const merged = [];
  for (const message of clean) {
    if (merged.length && merged[merged.length - 1].role === message.role) merged[merged.length - 1].content += `\n${message.content}`;
    else merged.push({ ...message });
  }
  return merged;
}

async function callModel({ settings, system, messages, fetchImpl }) {
  const response = await fetchImpl(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": settings.apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: settings.model, max_tokens: 700, system, tools: TOOLS, messages })
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) throw new Error(body?.error?.message || `Error ${response.status} del servicio de IA`);
  return body;
}

// Ejecuta una conversación: el modelo puede usar varias herramientas antes de responder.
export async function runAgent({ messages, context, store, settings, fetchImpl = fetch, now = new Date() }) {
  const history = sanitizeHistory(messages);
  if (!history.length || history[history.length - 1].role !== "user") throw new Error("Falta el mensaje del cliente.");
  const system = [{ type: "text", text: basePrompt(), cache_control: { type: "ephemeral" } }, { type: "text", text: `## Contexto de esta conversación\n${contextBlock(context, now)}` }];
  const convo = history.map(message => ({ role: message.role, content: message.content }));
  const cars = new Map(), actions = [], toolsUsed = [];
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const body = await callModel({ settings, system, messages: convo, fetchImpl });
    const blocks = Array.isArray(body.content) ? body.content : [];
    const toolCalls = blocks.filter(block => block.type === "tool_use");
    if (body.stop_reason !== "tool_use" || !toolCalls.length || round === MAX_TOOL_ROUNDS) {
      const text = blocks.filter(block => block.type === "text").map(block => block.text).join("\n").trim() || "¿En qué más te puedo ayudar?";
      return { text, cars: [...cars.values()].slice(0, 4), actions: dedupeActions(actions), toolsUsed, usage: body.usage || null };
    }
    convo.push({ role: "assistant", content: blocks });
    const results = [];
    for (const call of toolCalls) {
      toolsUsed.push(call.name);
      let output;
      try { output = await runTool(call.name, call.input || {}, { store, context, now }); }
      catch (error) { console.error("Tool error", call.name, error); output = { result: { error: "No se pudo completar esta acción." }, cars: [], actions: [] }; }
      for (const car of output.cars) cars.set(car.id, car);
      actions.push(...output.actions);
      results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(output.result).slice(0, 6000) });
    }
    convo.push({ role: "user", content: results });
  }
  return { text: "¿En qué más te puedo ayudar?", cars: [], actions: [], toolsUsed };
}

function dedupeActions(actions) {
  const seen = new Set();
  return actions.filter(action => { const key = `${action.type}:${action.href}`; if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 3);
}
