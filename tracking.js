// Medición propia de 1001Carros (sin terceros): solo se activa si el cliente la acepta en el aviso de cookies.
// Guarda un identificador de visitante en este navegador y envía eventos a /api/t.
const CONSENT_KEY = "1001-consent", VISITOR_KEY = "1001-vid", SESSION_KEY = "1001-sid", LAST_KEY = "1001-last", SOURCE_KEY = "1001-src";
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SESSION_IDLE_MS = 30 * 60 * 1000;
const store = { get: (s, k) => { try { return s.getItem(k); } catch { return null; } }, set: (s, k, v) => { try { s.setItem(k, v); } catch {} } };
const randomId = (n, alphabet = ALPHABET) => { const bytes = crypto.getRandomValues(new Uint8Array(n)); return Array.from(bytes, b => alphabet[b % alphabet.length]).join(""); };

const consent = () => store.get(localStorage, CONSENT_KEY);
const enabled = () => consent() === "all";
function visitorId() { if (!enabled()) return null; let id = store.get(localStorage, VISITOR_KEY); if (!/^[A-HJ-NP-Z2-9]{16}$/.test(id || "")) { id = randomId(16); store.set(localStorage, VISITOR_KEY, id); } return id; }
function sessionId() {
  if (!enabled()) return null;
  const now = Date.now(), last = Number(store.get(localStorage, LAST_KEY) || 0);
  let id = store.get(sessionStorage, SESSION_KEY);
  if (!id || now - last > SESSION_IDLE_MS) { id = randomId(12, "abcdefghijklmnopqrstuvwxyz0123456789"); store.set(sessionStorage, SESSION_KEY, id); }
  store.set(localStorage, LAST_KEY, String(now));
  return id;
}
const ref = () => { const id = visitorId(); return id ? `1001-${id.slice(0, 5)}` : null; };

// Origen de la visita: se guarda al llegar (UTM, identificadores de clic de anuncios y sitio de origen).
(function captureSource() {
  if (store.get(sessionStorage, SOURCE_KEY)) return;
  const p = new URLSearchParams(location.search), source = {};
  for (const k of ["utm_source", "utm_medium", "utm_campaign", "gclid", "fbclid", "ttclid"]) if (p.get(k)) source[k] = p.get(k).slice(0, 80);
  if (document.referrer) source.referrer = document.referrer.slice(0, 200);
  store.set(sessionStorage, SOURCE_KEY, JSON.stringify(source));
})();

function headers() { const v = visitorId(); return v ? { "x-visitor": v, "x-session": sessionId() } : {}; }
function track(kind, extra = {}) {
  const v = visitorId(); if (!v) return;
  let source = {}; try { source = JSON.parse(store.get(sessionStorage, SOURCE_KEY) || "{}"); } catch {}
  const body = JSON.stringify({ kind, path: location.pathname, sessionId: sessionId(), source, ...extra });
  fetch("/api/t", { method: "POST", headers: { "content-type": "application/json", "x-visitor": v }, body, keepalive: true }).catch(() => {});
}
let lastPage = "";
function pageView(path) {
  if (path === lastPage) return; lastPage = path;
  if (path.startsWith("/asesor") || path.startsWith("/analista")) return; // el personal no cuenta como visita
  track("page_view");
  const m = path.match(/^\/vehiculo\/(\d+)$/); if (m) track("vehicle_view", { vehicleId: Number(m[1]) });
}

// WhatsApp: el mensaje lleva el código de referencia para que el asesor sepa quién es el cliente.
document.addEventListener("click", event => {
  const a = event.target.closest('a[href*="wa.me/"],a[href*="api.whatsapp.com"]'); if (!a) return;
  const r = ref(); if (!r) return;
  try { const url = new URL(a.href); const text = url.searchParams.get("text") || "Hola"; if (!text.includes("Ref.")) { url.searchParams.set("text", `${text}\n\n(Ref. ${r})`); a.href = url.toString(); } } catch {}
  track("whatsapp_click");
}, true);

// Calculadora: un evento por página cuando el cliente mueve un control.
let calcTracked = "";
const onCalc = event => { if (event.target.closest?.("#price-range,#down-range,#term-range,#detail-down-payment,.detail-finance-card input,.detail-finance-card select") && calcTracked !== location.pathname) { calcTracked = location.pathname; track("calc_use"); } };
document.addEventListener("input", onCalc); document.addEventListener("change", onCalc);

// Precalificación: se registra cada vez que se muestra el formulario que pide la cédula (para medir el abandono).
const watchModal = () => { const modal = document.querySelector("#modal"); if (!modal) return; new MutationObserver(() => { const form = modal.querySelector(".prequal-form"); if (form && form.querySelector("input[name=cedula]") && !form.dataset.tracked) { form.dataset.tracked = "1"; track("prequal_start"); } }).observe(modal, { childList: true, subtree: true }); };
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watchModal); else watchModal();

// Aviso de cookies (Ley Orgánica de Protección de Datos Personales).
function banner() {
  if (consent() || document.querySelector(".cookie-banner")) return;
  const el = document.createElement("section");
  el.className = "cookie-banner"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "Aviso de cookies");
  el.innerHTML = `<p><b>Usamos cookies propias</b> para entender cómo usas el sitio y atenderte mejor (por ejemplo, para que el asesor sepa qué carro viste cuando le escribes). No compartimos estos datos con terceros. Puedes aceptarlas o usar solo las necesarias.</p><div><button type="button" data-consent="necessary">Solo necesarias</button><button type="button" data-consent="all" class="primary">Aceptar</button></div>`;
  el.addEventListener("click", event => { const b = event.target.closest("[data-consent]"); if (!b) return; store.set(localStorage, CONSENT_KEY, b.dataset.consent); el.remove(); if (b.dataset.consent === "all") { lastPage = ""; pageView(location.pathname); } });
  document.body.appendChild(el);
}
function resetConsent() { try { localStorage.removeItem(CONSENT_KEY); } catch {} banner(); }
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", banner); else banner();

window.M1001 = { track, pageView, headers, ref, enabled, resetConsent };
