// Pure customer-account logic: price/search alerts and reservation records.
// Storage-agnostic: every function takes and returns plain data; the app persists it (localStorage).
// Notifications are SIMULATED in this beta: evaluateAlerts only reports which alerts are triggered.
export const CHANNELS = Object.freeze(["correo", "whatsapp"]);
export const DEFAULT_CHANNEL = "correo";

const norm = value => String(value ?? "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const channelOf = value => (CHANNELS.includes(value) ? value : DEFAULT_CHANNEL);
const toPrice = value => (value === "" || value === null || value === undefined ? NaN : Number(value));

export const emptyAlerts = () => ({ watches: [], searches: [] });

export function normalizeAlerts(raw) {
  if (!raw || typeof raw !== "object") return emptyAlerts();
  const watches = (Array.isArray(raw.watches) ? raw.watches : [])
    .filter(w => w && Number.isInteger(Number(w.vehicleId)) && w.vehicleId !== null && Number(w.price) > 0)
    .map(w => ({ vehicleId: Number(w.vehicleId), price: Number(w.price), channel: channelOf(w.channel), createdAt: String(w.createdAt ?? "") }));
  const searches = (Array.isArray(raw.searches) ? raw.searches : [])
    .filter(s => s && s.id && String(s.brand ?? "").trim())
    .map(s => ({
      id: String(s.id), brand: String(s.brand).trim(), model: String(s.model ?? "").trim(),
      maxPrice: Number(s.maxPrice) > 0 ? Number(s.maxPrice) : null,
      channel: channelOf(s.channel), createdAt: String(s.createdAt ?? "")
    }));
  return { watches, searches };
}

export const isWatching = (alerts, vehicleId) => (alerts?.watches ?? []).some(w => w.vehicleId === Number(vehicleId));

export function watchPrice(alerts, car, { channel, now = new Date() } = {}) {
  const base = normalizeAlerts(alerts);
  const watch = { vehicleId: Number(car.id), price: Number(car.price), channel: channelOf(channel), createdAt: now.toISOString() };
  return { ...base, watches: [watch, ...base.watches.filter(w => w.vehicleId !== watch.vehicleId)] };
}

export function unwatchPrice(alerts, vehicleId) {
  const base = normalizeAlerts(alerts);
  return { ...base, watches: base.watches.filter(w => w.vehicleId !== Number(vehicleId)) };
}

export function addSearch(alerts, input, { now = new Date() } = {}) {
  const base = normalizeAlerts(alerts);
  const brand = String(input?.brand ?? "").trim(), model = String(input?.model ?? "").trim();
  const rawMax = input?.maxPrice, hasMax = String(rawMax ?? "").trim() !== "";
  const maxPrice = hasMax ? toPrice(rawMax) : null;
  const errors = [];
  if (!brand) errors.push("brand");
  if (hasMax && !(maxPrice > 0)) errors.push("maxPrice");
  if (errors.length) return { ok: false, errors };
  const duplicate = base.searches.find(s => norm(s.brand) === norm(brand) && norm(s.model) === norm(model) && s.maxPrice === maxPrice);
  if (duplicate) return { ok: true, alerts: base };
  const search = {
    id: `s${now.getTime().toString(36)}${base.searches.length}`,
    brand, model, maxPrice, channel: channelOf(input?.channel), createdAt: now.toISOString()
  };
  return { ok: true, alerts: { ...base, searches: [search, ...base.searches] } };
}

export function removeSearch(alerts, id) {
  const base = normalizeAlerts(alerts);
  return { ...base, searches: base.searches.filter(s => s.id !== String(id)) };
}

function matchesSearch(search, car) {
  if (norm(car.brand) !== norm(search.brand)) return false;
  if (search.model && !norm(car.model).includes(norm(search.model))) return false;
  if (search.maxPrice && !(Number(car.price) <= search.maxPrice)) return false;
  return true;
}

// Returns the triggered alerts: price below the stored price, and catalog cars matching a saved search.
export function evaluateAlerts(alerts, catalog) {
  if (!alerts || !Array.isArray(catalog)) return [];
  const { watches, searches } = normalizeAlerts(alerts);
  const hits = [];
  for (const watch of watches) {
    const car = catalog.find(c => Number(c.id) === watch.vehicleId);
    const price = Number(car?.price);
    if (car && Number.isFinite(price) && price < watch.price) {
      hits.push({ type: "price-drop", vehicleId: watch.vehicleId, car, oldPrice: watch.price, newPrice: price, drop: watch.price - price, channel: watch.channel });
    }
  }
  for (const search of searches) {
    for (const car of catalog.filter(c => matchesSearch(search, c))) {
      hits.push({ type: "search-match", searchId: search.id, search, vehicleId: Number(car.id), car, channel: search.channel });
    }
  }
  return hits;
}

export function createReservation({ car, agency = null, deposit, prequalified = false, now = new Date() }) {
  return {
    vehicleId: Number(car.id),
    vehicle: { brand: car.brand, model: car.model, year: car.year, price: Number(car.price), image: car.image ?? "" },
    agency: agency ? { id: agency.id, name: agency.name, city: agency.city ?? "" } : null,
    deposit: Number(deposit), prequalified: Boolean(prequalified), createdAt: now.toISOString()
  };
}

export function normalizeReservations(raw) {
  return (Array.isArray(raw) ? raw : []).filter(r => r && Number.isInteger(r.vehicleId) && r.vehicle && typeof r.vehicle === "object");
}

export function addReservation(list, record) {
  return [record, ...normalizeReservations(list).filter(r => r.vehicleId !== record.vehicleId)];
}
