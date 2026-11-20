import { answer, buildConversationRecord, ORIGIN_CODE } from "/assistant.mjs";

const HISTORY_KEY = "1001-assistant-history";
const LOG_KEY = "1001-assistant-log"; // Placeholder for the real Sugar CRM integration: nothing leaves the browser.
const store = (area) => { try { return window[area]; } catch { return null; } };
const read = (area, key, fallback) => { try { return JSON.parse(store(area).getItem(key)) ?? fallback; } catch { return fallback; } };
const write = (area, key, value) => { try { store(area).setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } };

const saved = read("sessionStorage", HISTORY_KEY, {});
const session = { messages: Array.isArray(saved.messages) ? saved.messages : [], flow: saved.flow || null, open: false };
const data = { vehicles: [], agencies: [], loaded: false };
const ai = { checked: false, enabled: false };
const AI_GREETING = "¡Hola! Soy Mil, tu asesor virtual de 1001Carros. Puedo buscarte un carro, calcular tu cuota, precalificarte, reservar y ayudarte con tus documentos. ¿Qué carro estás buscando? (Uso inteligencia artificial y puedo equivocarme; no compartas tu cédula ni datos de tarjeta por aquí.)";
const AI_CHIPS = ["Busco una SUV familiar", "¿Cuánto pagaría al mes?", "Quiero reservar un carro", "¿Qué documentos necesito?", "Hablar con un asesor"];
async function checkAi() { if (ai.checked) return ai.enabled; ai.checked = true; try { ai.enabled = Boolean((await (await fetch("/api/assistant/status")).json()).ai); } catch { ai.enabled = false; } updateHeader(); return ai.enabled; }
const el = (tag, attrs = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), attrs);
  node.append(...children);
  return node;
};
const GREETING = "¡Hola! Soy el asistente virtual de 1001Carros (beta de demostración). Respondo con la información del sitio; para decidir tu compra, un asesor te acompaña. ¿En qué te ayudo?";
const CHIPS = ["Garantía", "Requisitos de crédito", "Horarios", "Disponibilidad", "Agendar test drive", "Hablar con un asesor"];

const button = el("button", { type: "button", className: "assistant-fab", id: "assistant-fab" }, el("span", { ariaHidden: "true", textContent: "💬" }), el("b", { textContent: "Asistente" }));
button.setAttribute("aria-label", "Abrir asistente virtual");
button.setAttribute("aria-expanded", "false");
button.setAttribute("aria-controls", "assistant-panel");
const log = el("div", { className: "assistant-log", tabIndex: 0 });
log.setAttribute("role", "log");
log.setAttribute("aria-live", "polite");
log.setAttribute("aria-label", "Conversación con el asistente");
const chips = el("div", { className: "assistant-chips" });
const input = el("input", { type: "text", name: "message", autocomplete: "off", placeholder: "Escribe tu pregunta" });
input.setAttribute("aria-label", "Escribe tu mensaje");
const close = el("button", { type: "button", className: "assistant-close", textContent: "×" });
close.setAttribute("aria-label", "Cerrar asistente");
const form = el("form", { className: "assistant-form" }, input, el("button", { type: "submit", textContent: "Enviar" }));
const panel = el("section", { className: "assistant-panel", id: "assistant-panel", hidden: true },
  el("header", {}, el("div", {}, el("strong", { textContent: "Asistente virtual" }), el("small", { textContent: "Beta de demostración" })), close),
  log, chips, form);
panel.setAttribute("role", "dialog");
panel.setAttribute("aria-label", "Asistente virtual de 1001Carros");

function persist() {
  write("sessionStorage", HISTORY_KEY, { messages: session.messages, flow: session.flow });
  write("localStorage", LOG_KEY, buildConversationRecord(session.messages, { originCode: ORIGIN_CODE }));
}
function renderBubble(m) {
  const bubble = el("div", { className: `assistant-msg ${m.role}` }, el("p", { textContent: m.text }));
  if (m.cars?.length) bubble.append(el("ul", { className: "assistant-cars" }, ...m.cars.map(c => el("li", {}, el("a", { href: c.href, textContent: `${c.label} · $${Number(c.price).toLocaleString("es-EC")}` }, ), ))));
  for (const action of m.actions || []) {
    const external = /^https?:/.test(action.href);
    const a = el("a", { href: action.href, textContent: action.label, className: `assistant-link assistant-action ${action.type}` });
    if (external) { a.target = "_blank"; a.rel = "noopener"; } else a.setAttribute("data-route", "");
    bubble.append(a);
  }
  for (const link of m.links || []) {
    const external = /^https?:/.test(link.href);
    const a = el("a", { href: link.href, textContent: link.label, className: "assistant-link" });
    if (external) { a.target = "_blank"; a.rel = "noopener"; } else a.setAttribute("data-route", "");
    bubble.append(a);
  }
  for (const a of bubble.querySelectorAll(".assistant-cars a")) a.setAttribute("data-route", "");
  return bubble;
}
function render(chipList) {
  log.replaceChildren(...session.messages.map(renderBubble));
  chips.replaceChildren(...(chipList || (ai.enabled ? AI_CHIPS : CHIPS)).map(label => el("button", { type: "button", textContent: label, className: "assistant-chip" })));
  log.scrollTop = log.scrollHeight;
}
async function loadData() {
  if (data.loaded) return;
  data.loaded = true;
  try { data.vehicles = (await (await fetch("/api/vehicles")).json()).items || []; } catch { data.loaded = false; }
  try { data.agencies = (await (await fetch("/api/agencies")).json()).items || []; } catch { /* hours/agencies answered as missing */ }
}
function currentVehicleId() {
  const m = location.pathname.match(/^\/(?:vehiculo|reservar)\/(\d+)/);
  return m ? Number(m[1]) : null;
}
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
// Simulated "thinking" time so the reply does not appear instantly; shorter for reduced-motion users.
const thinkingDelay = (text) => matchMedia("(prefers-reduced-motion: reduce)").matches ? 150 : Math.min(1400, 600 + text.length * 8);
function typingBubble() {
  const bubble = el("div", { className: "assistant-msg bot assistant-typing" }, el("span", { className: "assistant-dots" }, el("i"), el("i"), el("i")), el("span", { className: "assistant-sr", textContent: "El asistente está escribiendo" }));
  bubble.setAttribute("role", "status");
  return bubble;
}
let busy = false;
async function send(text) {
  text = text.trim();
  if (!text || busy) return;
  busy = true;
  try {
    await sendReply(text);
  } finally {
    busy = false;
  }
}
async function sendReply(text) {
  await loadData();
  if (await checkAi()) return sendAiReply(text);
  const now = new Date();
  const result = answer(text, { vehicles: data.vehicles, agencies: data.agencies, flow: session.flow, now, messages: session.messages, currentVehicleId: currentVehicleId() });
  session.messages.push({ role: "user", text, at: now.toISOString(), intent: result.intent, handoff: result.handoff });
  render([]);
  const typing = typingBubble();
  log.append(typing);
  log.scrollTop = log.scrollHeight;
  await sleep(thinkingDelay(result.text));
  typing.remove();
  session.messages.push({ role: "bot", text: result.text, at: new Date().toISOString(), intent: result.intent, handoff: result.handoff, cars: result.cars, links: result.links });
  session.flow = result.flow;
  persist();
  render(result.chips.length ? result.chips : null);
}
function setOpen(open) {
  session.open = open;
  panel.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
  button.setAttribute("aria-label", open ? "Cerrar asistente virtual" : "Abrir asistente virtual");
  if (open) {
    window.M1001?.track("assistant_open");
    if (!session.messages.length) { session.messages.push({ role: "bot", text: ai.enabled ? AI_GREETING : GREETING, at: new Date().toISOString(), intent: "saludo" }); persist(); }
    render();
    input.focus();
  } else button.focus();
}

button.addEventListener("click", () => setOpen(!session.open));
close.addEventListener("click", () => setOpen(false));
panel.addEventListener("keydown", event => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } });
panel.addEventListener("click", event => {
  const chip = event.target.closest(".assistant-chip");
  if (chip) send(chip.textContent);
  else if (event.target.closest("a[data-route]") && matchMedia("(max-width:700px)").matches) setOpen(false);
});
form.addEventListener("submit", event => { event.preventDefault(); const text = input.value; input.value = ""; send(text); input.focus(); });

document.body.append(button, panel);


// ---------------- Asesor con IA (agente en el servidor) ----------------
function readJson(area, key) { try { return JSON.parse(store(area).getItem(key) || "null"); } catch { return null; } }
function buildContext() {
  const vehicleId = currentVehicleId(), car = data.vehicles.find(item => item.id === vehicleId);
  const prequalStore = readJson("localStorage", "1001-prequal") || {}, records = Object.values(prequalStore.records || {}).filter(r => r?.offer);
  const record = (vehicleId && prequalStore.records?.[vehicleId]) || records.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  const bureau = readJson("localStorage", "1001-bureau");
  const reservations = (readJson("localStorage", "1001-reservations") || []).filter(r => r?.clientTransactionId).map(r => ({ vehicleId: r.vehicleId, label: `${r.vehicle?.brand || ""} ${r.vehicle?.model || ""}`.trim(), code: r.clientTransactionId }));
  return {
    page: location.pathname,
    vehicle: car ? { id: car.id, label: `${car.year} ${car.brand} ${car.model}`, price: car.price } : null,
    prequal: record ? { status: record.decision?.status || "preapproved", vehicleId: record.vehicleId, monthly: record.offer?.monthly, term: record.offer?.term, expiresAt: bureau?.expiresAt || record.reportExpiresAt } : null,
    reservations,
    applications: readJson("localStorage", "1001-apps") || {}
  };
}
async function sendAiReply(text) {
  session.messages.push({ role: "user", text, at: new Date().toISOString(), intent: "ia" });
  render([]);
  const typing = typingBubble();
  log.append(typing);
  log.scrollTop = log.scrollHeight;
  let reply;
  try {
    const history = session.messages.slice(-16).map(m => ({ role: m.role === "bot" ? "assistant" : "user", text: m.text }));
    const response = await fetch("/api/assistant/chat", { method: "POST", headers: { "content-type": "application/json", ...(window.M1001?.headers() || {}) }, body: JSON.stringify({ messages: history, context: buildContext() }) });
    const body = await response.json();
    if (response.status === 503 && body.code === "ai_disabled") { ai.enabled = false; typing.remove(); session.messages.pop(); updateHeader(); return sendReply(text); }
    reply = response.ok ? { text: body.text, cars: body.cars || [], actions: body.actions || [] } : { text: body.error || "No pude responder en este momento.", cars: [], actions: [] };
  } catch {
    reply = { text: "No pude conectarme. Revisa tu conexión e inténtalo de nuevo.", cars: [], actions: [] };
  }
  typing.remove();
  session.messages.push({ role: "bot", text: reply.text, at: new Date().toISOString(), intent: "ia", cars: reply.cars.map(c => ({ ...c, href: c.href })), actions: reply.actions });
  persist();
  render();
}
function updateHeader() {
  const title = panel.querySelector("header strong"), sub = panel.querySelector("header small");
  if (title) title.textContent = ai.enabled ? "Mil · Asesor virtual" : "Asistente virtual";
  if (sub) sub.textContent = ai.enabled ? "Con inteligencia artificial" : "Beta de demostración";
}
checkAi().then(enabled => { if (enabled && session.messages.length === 1 && session.messages[0].intent === "saludo") session.messages[0].text = AI_GREETING; });
