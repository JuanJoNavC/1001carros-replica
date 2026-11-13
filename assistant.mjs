// Rule-based virtual assistant (beta/demo). Pure logic: no DOM, no network.
// Facts are reused from existing site copy; when data is missing the assistant says so.

export const ORIGIN_CODE = "WEB-ASSISTANT";
// Company WhatsApp shown on the contact page (099 100 1001) in international format.
export const WHATSAPP_NUMBER = "593991001001";

const LINK = {
  catalog: { label: "Ver catálogo", href: "/catalogo" },
  agencies: { label: "Ver agencias", href: "/agencias" },
  finance: { label: "Financiamiento y Precalifícate", href: "/financiamiento" },
  contact: { label: "Contacto", href: "/contacto" }
};
const MENU_CHIPS = ["Garantía", "Requisitos de crédito", "Horarios", "Disponibilidad", "Agendar test drive", "Hablar con un asesor"];
const DISCLAIMER = "Soy un asistente de demostración (beta): respondo con información del sitio y no sustituyo a un asesor.";

export function normalizeText(text) {
  return String(text ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9/:.,$ ]+/g, " ").replace(/\s+/g, " ").trim();
}
const has = (n, words) => words.some(w => n.includes(w));
const reply = (text, extra = {}) => ({ text, intent: "fallback", chips: [], links: [], cars: [], flow: null, handoff: false, ...extra });
const carLabel = c => `${c.year} ${c.brand} ${c.model}`;
const toCar = c => ({ id: c.id, label: carLabel(c), price: c.price, href: `/vehiculo/${c.id}` });
const usd = n => `$${Number(n).toLocaleString("es-EC")}`;

function findCars(n, vehicles) {
  const byCode = vehicles.filter(c => c.code && n.includes(normalizeText(c.code)));
  if (byCode.length) return byCode;
  const byModel = vehicles.filter(c => n.includes(normalizeText(c.model)));
  const pool = byModel.length ? byModel : vehicles.filter(c => n.includes(normalizeText(c.brand)));
  return pool;
}
function parseMaxPrice(n) {
  const m = n.match(/(?:hasta|menos de|maximo|max|bajo|presupuesto(?: de)?|\$)\s*\$?\s*(\d{1,3}(?:[.,]\d{3})+|\d+)(\s*mil)?/) || n.match(/(\d+)\s*mil\b/);
  if (!m) return null;
  let v = Number(String(m[1]).replace(/[.,]/g, ""));
  if (m[2] !== undefined && /mil/.test(m[2]) || /mil\b/.test(m[0]) && v < 1000) v *= 1000;
  return v >= 1000 ? v : null;
}

const DAYS = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];
const iso = d => d.toISOString().slice(0, 10);
const ecShift = now => new Date(now.getTime() - 5 * 36e5); // Ecuador is fixed GMT-5
const ecToday = now => { const s = ecShift(now); return new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate())); };
// Whole-word match that tolerates a plural suffix and trailing punctuation ("citas", "cita.", "drive,").
const hasWord = (n, words) => words.some(w => new RegExp(`(^| )${w}(s|es)?(?=[ .,:]|$)`).test(n));
export function parseWhen(n, now) {
  const base = ecToday(now);
  let date = null, m;
  if (/\bpasado manana\b/.test(n)) date = new Date(base.getTime() + 2 * 864e5);
  else if (/\bmanana\b/.test(n)) date = new Date(base.getTime() + 864e5);
  else if (/\bhoy\b/.test(n)) date = base;
  else if ((m = n.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/))) {
    const y = m[3] ? Number(m[3]) : base.getUTCFullYear();
    date = new Date(Date.UTC(y, Number(m[2]) - 1, Number(m[1])));
    if (date.getUTCMonth() !== Number(m[2]) - 1) date = null;  } else {
    const idx = DAYS.findIndex(d => n.includes(d));
    if (idx >= 0) date = new Date(base.getTime() + (((idx - base.getUTCDay()) + 7) % 7 || 7) * 864e5);
  }
  let time = null;
  if ((m = n.match(/\b(\d{1,2}):(\d{2})\b/))) time = [Number(m[1]), Number(m[2])];
  else if ((m = n.match(/\b(\d{1,2})\s*(am|pm)\b/))) time = [Number(m[1]) % 12 + (m[2] === "pm" ? 12 : 0), 0];
  else if ((m = n.match(/\ba las (\d{1,2})\b/))) time = [Number(m[1]), 0];
  if (time && (time[0] > 23 || time[1] > 59)) time = null;
  return {
    date: date && !isNaN(date) ? iso(date) : null,
    time: time ? `${String(time[0]).padStart(2, "0")}:${String(time[1]).padStart(2, "0")}` : null
  };
}

function testDriveStep(n, ctx, flow) {
  const { vehicles = [], agencies = [], now = new Date() } = ctx;
  const chips = ["Cancelar"];
  if (flow.step === "car") {
    const found = findCars(n, vehicles);
    if (found.length === 1) return testDriveStep("", ctx, { step: "agency", carId: found[0].id });
    if (found.length > 1) return reply(`Tengo varias opciones: ${found.slice(0, 5).map(c => `${carLabel(c)} (${c.code})`).join("; ")}. ¿Cuál prefieres? Escribe el modelo o el código.`, { intent: "test-drive", flow, chips });
    return reply("¿Para qué carro quieres el test drive? Dime marca y modelo (por ejemplo «Toyota Corolla») o el código del vehículo.", { intent: "test-drive", flow, chips, links: [LINK.catalog] });
  }
  if (flow.step === "agency") {
    const hit = n ? agencies.find(a => n.includes(normalizeText(a.name)) || (n.length >= 3 && normalizeText(a.name).includes(n))) || agencies.find(a => a.city && n.includes(normalizeText(a.city))) : null;
    if (hit) return testDriveStep("", ctx, { ...flow, step: "datetime", agencyId: hit.id });
    if (!agencies.length) return reply("No tengo la lista de agencias en este momento. Puedes elegir la agencia directamente al reservar.", { intent: "test-drive", flow: { ...flow, step: "datetime", agencyId: null }, chips, links: [LINK.agencies] });
    return reply(`¿En qué agencia? ${agencies.map(a => a.name).join(", ")}.`, { intent: "test-drive", flow, chips: [...agencies.slice(0, 4).map(a => a.name), "Cancelar"] });
  }
  const when = parseWhen(n, now);
  if (when.date && when.date < iso(ecToday(now))) return reply("Esa fecha ya pasó. ¿Qué día y hora te acomoda? Por ejemplo «mañana a las 15:00».", { intent: "test-drive", flow, chips });
  const next = { ...flow, date: when.date || flow.date || null, time: when.time || flow.time || null };
  if (next.date && next.time && next.date === iso(ecToday(now))) { const e = ecShift(now); if (next.time < `${String(e.getUTCHours()).padStart(2, "0")}:${String(e.getUTCMinutes()).padStart(2, "0")}`) return reply("Esa hora ya pasó. ¿Qué día y hora te acomoda? Por ejemplo «mañana a las 15:00».", { intent: "test-drive", flow: { ...flow, date: null, time: null }, chips }); }
  if (!next.date || !next.time) return reply(`${next.date ? `Anoté el ${next.date}. ` : ""}Necesito ${next.date ? "la hora" : next.time ? "el día" : "el día y la hora"}. Por ejemplo «mañana a las 15:00» o «20/11 a las 10:00».`, { intent: "test-drive", flow: next, chips });
  const car = vehicles.find(c => c.id === next.carId), agency = agencies.find(a => a.id === next.agencyId);
  const text = `Listo, esto es lo que anoté: ${car ? carLabel(car) : "tu carro"}${agency ? ` en ${agency.name}` : ""}, el ${next.date} a las ${next.time}. Es una solicitud: un asesor la confirmará. Para dejarla registrada, continúa en la reserva.`;
  return reply(text, { intent: "test-drive", chips: ["Hablar con un asesor"], links: [{ label: "Continuar con la reserva", href: `/reservar/${next.carId}` }] });
}

export function answer(message, context = {}) {
  const ctx = { vehicles: [], agencies: [], now: new Date(), ...context };
  const { vehicles, agencies } = ctx;
  const n = normalizeText(message);
  const handoff = text => reply(text, { intent: "asesor", handoff: true, links: [{ label: "Escribir por WhatsApp", href: buildHandoffUrl(ctx.messages || [], { number: WHATSAPP_NUMBER, car: vehicles.find(c => c.id === ctx.currentVehicleId) }) }] });

  if (ctx.flow) {
    if (has(n, ["cancel", "salir", "no gracias"])) return reply("Sin problema, cancelé el agendamiento. ¿En qué más te ayudo?", { intent: "test-drive", chips: MENU_CHIPS });
    if (!has(n, ["asesor", "humano"])) return testDriveStep(n, ctx, ctx.flow);
  }
  if (has(n, ["asesor", "humano", "agente", "persona real", "vendedor", "hablar con alguien"])) return handoff("Claro, te paso con un asesor por WhatsApp. Se abrirá un mensaje con el resumen de nuestra conversación para que no repitas nada.");
  if (hasWord(n, ["test drive", "prueba de manejo", "probar el", "agendar", "agenda", "cita"])) {
    const found = findCars(n, vehicles);
    const carId = found.length === 1 ? found[0].id : ctx.currentVehicleId || null;
    return testDriveStep("", ctx, { step: carId ? "agency" : "car", carId });
  }
  if (has(n, ["garantia", "devolver", "devolucion", "satisfaccion"])) return reply("Tienes la Garantía de satisfacción: 7 días o 300 km para enamorarte de tu seminuevo; si el carro no es para ti, puedes devolverlo bajo las condiciones del programa. Además, los carros incluyen garantía mecánica de 1 año o 20,000 km y garantía legal y de procedencia.", { intent: "garantia", chips: ["Requisitos de crédito", "Disponibilidad"], links: [LINK.catalog] });
  if (has(n, ["credito", "financ", "requisito", "precalific", "cuota", "entrada", "buro"])) return reply("Para precalificar necesitas tu cédula, un ingreso demostrable y dar tu consentimiento para consultar el buró de crédito. La entrada parte desde 20% con buen buró y 25% como base. Puedes ver tu cuota de ejemplo con Precalifícate, sin compromiso; la aprobación final depende de la entidad financiera.", { intent: "credito", chips: ["Agendar test drive", "Hablar con un asesor"], links: [LINK.finance] });
  if (has(n, ["horario", "hora atiend", "a que hora", "abren", "cierran", "abierto", "atienden"])) {
    const hours = [...new Set(agencies.map(a => a.hours).filter(Boolean))];
    if (!hours.length) return reply("El horario depende de la agencia y no lo tengo disponible aquí. Revísalo en la página de agencias.", { intent: "horarios", links: [LINK.agencies] });
    const text = hours.length === 1 ? `Nuestras agencias atienden ${hours[0]}.` : agencies.filter(a => a.hours).map(a => `${a.name}: ${a.hours}`).join(" · ");
    return reply(`${text} Confirma el de tu agencia antes de ir.`, { intent: "horarios", chips: ["Agendar test drive"], links: [LINK.agencies] });
  }
  if (has(n, ["quiero comprar", "listo para comprar", "lo quiero", "quiero reservar", "como compro", "me lo llevo", "quiero el"])) return handoff("¡Excelente! Un asesor puede ayudarte a cerrar la compra. Te dejo el enlace de WhatsApp con el resumen de lo que hablamos.");
  const found = findCars(n, vehicles), max = parseMaxPrice(n);
  if (has(n, ["disponib", "tienen", "hay ", "busco", "stock", "inventario", "catalogo", "carros", "autos"]) || found.length || max) {
    let list = found.length ? found : vehicles;
    if (max) list = list.filter(c => c.price <= max);
    if (!found.length && !max) return reply("¿Qué buscas? Dime marca, modelo o un precio máximo (por ejemplo «Toyota hasta 20 mil»).", { intent: "disponibilidad", links: [LINK.catalog] });
    if (!list.length || !vehicles.length) return reply("No encontré carros que coincidan en este momento. Puedes revisar todo el catálogo o hablar con un asesor.", { intent: "disponibilidad", chips: ["Hablar con un asesor"], links: [LINK.catalog] });
    const cars = [...list].sort((a, b) => a.price - b.price).slice(0, 5).map(toCar);
    return reply(`Encontré ${list.length} ${list.length === 1 ? "opción" : "opciones"}${list.length > cars.length ? ` (te muestro ${cars.length})` : ""}. La disponibilidad se confirma con un asesor.`, { intent: "disponibilidad", cars, chips: ["Agendar test drive", "Hablar con un asesor"], links: [LINK.catalog] });
  }
  if (has(n, ["hola", "buenas", "buenos dias", "buenas tardes", "buenas noches"])) return reply(`¡Hola! ${DISCLAIMER} ¿Sobre qué quieres saber?`, { intent: "saludo", chips: MENU_CHIPS });
  return reply("No estoy seguro de haber entendido. Puedo ayudarte con estos temas:", { intent: "fallback", chips: MENU_CHIPS });
}

export function buildHandoffUrl(messages = [], { number = WHATSAPP_NUMBER, car } = {}) {
  const topics = [...new Set(messages.filter(m => m.role === "user" && m.intent && !["fallback", "saludo"].includes(m.intent)).map(m => m.intent))];
  const parts = ["Hola, vengo del asistente virtual de 1001Carros y quiero hablar con un asesor."];
  if (car) parts.push(`Me interesa el ${carLabel(car)} (${car.code}).`);
  if (topics.length) parts.push(`Temas que consulté: ${topics.join(", ")}.`);
  return `https://wa.me/${number}?text=${encodeURIComponent(parts.join(" "))}`;
}

// Record shaped like what Sugar CRM would receive. PLACEHOLDER for the real CRM integration:
// in this beta it is only stored in localStorage ("1001-assistant-log"); nothing is sent externally.
export function buildConversationRecord(messages = [], { originCode = ORIGIN_CODE } = {}) {
  const times = messages.map(m => m.at).filter(Boolean).sort();
  return {
    originCode,
    startedAt: times[0] || null,
    endedAt: times[times.length - 1] || null,
    messageCount: messages.length,
    intents: [...new Set(messages.map(m => m.intent).filter(i => i && i !== "fallback"))],
    handoff: messages.some(m => m.handoff || m.intent === "asesor"),
    messages: messages.map(({ role, text, at, intent }) => ({ role, text, at, intent: intent || null }))
  };
}
