// Simulated vehicle history (example data: no real inspection, fines or registry is queried).
export const SEAL_KEYS = ["inspection", "fines", "registration", "liens"];

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const BASE_DATE = Date.UTC(2026, 9, 1); // 2026-10-01
const DAY_MS = 86400000;

const toId = value => {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

// Every 5th vehicle starting at id 4 has one pending item; the item alternates by block.
function pendingKey(id) {
  if (id % 5 !== 4) return null;
  return Math.floor(id / 5) % 2 === 0 ? "fines" : "registration";
}

const PENDING_NOTES = {
  fines: "Se registra una multa pendiente de pago. Se regulariza antes de la entrega.",
  registration: "La matrícula vence pronto. Se renueva antes de la entrega."
};

export function vehicleHistory(vehicleId) {
  const id = toId(vehicleId);
  const pending = pendingKey(id);
  const seals = SEAL_KEYS.map((key, index) => {
    if (key === pending) return { key, status: "pending", note: PENDING_NOTES[key] };
    const date = new Date(BASE_DATE + ((id * 3 + index * 5) % 28) * DAY_MS);
    return { key, status: "verified", verifiedOn: date.toISOString().slice(0, 10) };
  });
  return { vehicleId: id, simulated: true, seals };
}

export function historySummary(history) {
  const total = history.seals.length;
  const verified = history.seals.filter(seal => seal.status === "verified").length;
  return { verified, total, complete: verified === total };
}

export function formatVerifiedDate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  if (!match) return "";
  return `${Number(match[3])} de ${MONTHS[Number(match[2]) - 1]} de ${match[1]}`;
}
