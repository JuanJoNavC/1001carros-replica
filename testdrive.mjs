// Agenda de test drive (se usa en el navegador y en el servidor).
// Horario de prueba de manejo en las agencias, hora de Ecuador (UTC-5):
//   lunes a viernes: 09:00 a 17:00 · sábado: 10:00 a 16:00 · domingo: cerrado.
// Si el carro está en otra ciudad, la primera fecha disponible deja 2 días para el traslado.

const EC_OFFSET_MS = 5 * 3600000;
export const TD_DAYS_AHEAD = 10;
export const TD_MIN_NOTICE_HOURS = 2;
export const TD_TRANSFER_DAYS = 2;
export const TD_SLOTS = { weekday: ["09:00", "10:00", "11:00", "12:00", "14:00", "15:00", "16:00", "17:00"], saturday: ["10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00"], sunday: [] };
const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

const localParts = date => { const d = new Date(new Date(date).getTime() - EC_OFFSET_MS); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), day: d.getUTCDate(), dow: d.getUTCDay(), hh: d.getUTCHours(), mm: d.getUTCMinutes() }; };
export const localDateKey = date => { const p = localParts(date); return `${p.y}-${String(p.m + 1).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`; };
export const slotsForDow = dow => (dow === 0 ? TD_SLOTS.sunday : dow === 6 ? TD_SLOTS.saturday : TD_SLOTS.weekday);
// "2026-11-23" + "10:00" en hora de Ecuador → Date
export const visitDate = (dateKey, time) => new Date(`${dateKey}T${time}:00-05:00`);

export function needsTransfer(car, agency) {
  const norm = v => String(v || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  return Boolean(car && agency && norm(car.city) && norm(agency.city) && norm(car.city) !== norm(agency.city));
}

// Días y horas disponibles. taken: lista de fechas ISO ya ocupadas para ese carro.
export function availableDays({ now = new Date(), transfer = false, taken = [] } = {}) {
  const takenSet = new Set(taken.map(t => new Date(t).getTime()));
  const earliest = now.getTime() + (transfer ? TD_TRANSFER_DAYS * 86400000 : TD_MIN_NOTICE_HOURS * 3600000);
  const start = localParts(now), days = [];
  for (let i = 0; i < TD_DAYS_AHEAD; i++) {
    const dateKey = localDateKey(Date.UTC(start.y, start.m, start.day + i, 12));
    const dow = localParts(visitDate(dateKey, "12:00")).dow;
    const slots = slotsForDow(dow).map(time => { const at = visitDate(dateKey, time); return { time, iso: at.toISOString(), available: at.getTime() >= earliest && !takenSet.has(at.getTime()) }; });
    if (!slots.length) continue;
    const p = localParts(visitDate(dateKey, "12:00"));
    days.push({ dateKey, label: `${WEEKDAYS[dow].slice(0, 3)} ${p.day} ${MONTHS[p.m]}`, longLabel: `${WEEKDAYS[dow]} ${p.day} de ${MONTHS[p.m]}`, slots, open: slots.some(s => s.available) });
  }
  return days;
}

export function isValidSlot(visitAt, { now = new Date(), transfer = false } = {}) {
  const at = new Date(visitAt);
  if (Number.isNaN(at.getTime())) return false;
  const p = localParts(at), time = `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`;
  if (!slotsForDow(p.dow).includes(time)) return false;
  const earliest = now.getTime() + (transfer ? TD_TRANSFER_DAYS * 86400000 : TD_MIN_NOTICE_HOURS * 3600000);
  return at.getTime() >= earliest && at.getTime() <= now.getTime() + (TD_DAYS_AHEAD + 1) * 86400000;
}

export function formatVisit(visitAt) {
  const p = localParts(visitAt);
  return `${WEEKDAYS[p.dow]} ${p.day} de ${MONTHS[p.m]} a las ${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`;
}

// Archivo de calendario (.ics) para que el cliente guarde la cita.
export function icsFor({ visitAt, car, agency, code }) {
  const start = new Date(visitAt), end = new Date(start.getTime() + 45 * 60000);
  const f = d => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const esc = v => String(v || "").replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//1001Carros//Test drive//ES", "BEGIN:VEVENT", `UID:${code}@1001carros.com`, `DTSTAMP:${f(new Date())}`, `DTSTART:${f(start)}`, `DTEND:${f(end)}`,
    `SUMMARY:${esc(`Test drive ${car.brand} ${car.model} · 1001Carros`)}`, `LOCATION:${esc(agency ? `${agency.name}, ${agency.address}, ${agency.city}` : "Agencia 1001Carros")}`,
    `DESCRIPTION:${esc(`Código ${code}. Lleva tu cédula y licencia de conducir vigente.`)}`, "BEGIN:VALARM", "TRIGGER:-PT2H", "ACTION:DISPLAY", "DESCRIPTION:Tu test drive es en 2 horas", "END:VALARM", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
}

export function validateTestDrive(data = {}) {
  const clean = (v, n) => String(v ?? "").trim().slice(0, n);
  const value = { vehicleId: Number(data.vehicleId), agencyId: Number(data.agencyId), visitAt: clean(data.visitAt, 40), name: clean(data.name, 120), phone: clean(data.phone, 20).replace(/[\s-]/g, ""), email: clean(data.email, 160).toLowerCase(), tradeIn: Boolean(data.tradeIn), finance: Boolean(data.finance), notes: clean(data.notes, 300) };
  if (!Number.isInteger(value.vehicleId) || value.vehicleId <= 0) return { error: "Vehículo no válido" };
  if (!Number.isInteger(value.agencyId) || value.agencyId <= 0) return { error: "Elige una agencia" };
  if (value.name.length < 3) return { error: "Escribe tu nombre" };
  if (!/^(\+?593|0)9\d{8}$/.test(value.phone)) return { error: "Escribe un celular válido (ej. 0991234567)" };
  if (value.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) return { error: "Revisa tu correo" };
  return { value };
}
