// Pure trade-in estimate logic (simulated: an example model, not the company's real pricing engine).
//
// Formula:
//   baseNew   = average "as-new" price implied by similar catalog cars (same model, else same brand),
//               each catalog price divided by its own retention; falls back to DEFAULT_NEW_PRICE.
//   retention = ageFactor * mileageFactor
//   ageFactor = 0.88^age (floor 0.12); mileageFactor = 1 - 2% per 10.000 km above 15.000 km/year (clamped 0.7..1.08)
//   midpoint  = baseNew * retention * conditionFactor * AGENCY_MARGIN
//   range     = midpoint +-4%, rounded to 50 USD.
export const VALIDITY_DAYS = 5;
export const CURRENCY = "USD";
export const DEFAULT_NEW_PRICE = 24000;
export const AGENCY_MARGIN = 0.88;
export const CONDITIONS = { excelente: 1.05, bueno: 1, regular: 0.88 };
const SPREAD = 0.04;
const MIN_VALUE = 500;
const DAY_MS = 86400000;
const KM_PER_YEAR = 15000;

const round50 = value => Math.round(value / 50) * 50;
const norm = value => String(value ?? "").trim().toLowerCase();
const toNumber = value => (value === "" || value === null || value === undefined ? NaN : Number(value));

function retention(age, mileage) {
  const ageFactor = Math.max(0.12, 0.88 ** age);
  const excess = (mileage - KM_PER_YEAR * Math.max(age, 1)) / 10000;
  const mileageFactor = Math.min(1.08, Math.max(0.7, 1 - 0.02 * excess));
  return ageFactor * mileageFactor;
}

function impliedNewPrice(reference, now, brand, model) {
  const usable = (Array.isArray(reference) ? reference : []).filter(car =>
    Number(car?.price) > 0 && Number.isFinite(Number(car.year)) && Number.isFinite(Number(car.mileage)));
  const same = usable.filter(car => norm(car.brand) === brand);
  const exact = same.filter(car => norm(car.model) === model);
  const pool = exact.length ? exact : same;
  if (!pool.length) return DEFAULT_NEW_PRICE;
  const values = pool.map(car => Number(car.price) / retention(Math.max(0, now.getUTCFullYear() - Number(car.year)), Number(car.mileage)));
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function estimateTradeIn(input, { now = new Date(), reference = [] } = {}) {
  const errors = [];
  const brand = norm(input?.brand), model = norm(input?.model);
  const year = toNumber(input?.year), mileage = toNumber(input?.mileage);
  const maxYear = now.getUTCFullYear() + 1;
  if (!brand) errors.push("brand");
  if (!model) errors.push("model");
  if (!Number.isInteger(year) || year < 1990 || year > maxYear) errors.push("year");
  if (!Number.isFinite(mileage) || mileage < 0 || mileage > 2000000) errors.push("mileage");
  if (errors.length) return { ok: false, errors };

  const age = Math.max(0, now.getUTCFullYear() - year);
  const conditionFactor = CONDITIONS[norm(input.condition)] ?? CONDITIONS.bueno;
  const base = impliedNewPrice(reference, now, brand, model);
  const midpoint = Math.max(MIN_VALUE, base * retention(age, mileage) * conditionFactor * AGENCY_MARGIN);
  const low = Math.max(MIN_VALUE, round50(midpoint * (1 - SPREAD)));
  const high = Math.max(low + 50, round50(midpoint * (1 + SPREAD)));
  return {
    ok: true, low, high, currency: CURRENCY,
    validUntil: new Date(now.getTime() + VALIDITY_DAYS * DAY_MS).toISOString()
  };
}

export function createOffer(input, { now = new Date(), reference = [] } = {}) {
  const estimate = estimateTradeIn(input, { now, reference });
  if (!estimate.ok) return null;
  return {
    vehicle: {
      plate: String(input.plate ?? "").trim().toUpperCase(),
      brand: String(input.brand).trim(), model: String(input.model).trim(),
      year: Number(input.year), mileage: Number(input.mileage),
      color: String(input.color ?? "").trim(),
      condition: CONDITIONS[norm(input.condition)] ? norm(input.condition) : "bueno"
    },
    tradeIn: Boolean(input.tradeIn),
    low: estimate.low, high: estimate.high, currency: estimate.currency,
    createdAt: now.toISOString(), validUntil: estimate.validUntil
  };
}

export function isOfferValid(offer, now = new Date()) {
  const until = Date.parse(offer?.validUntil);
  return Number.isFinite(until) && until > now.getTime();
}

// Conservative: the LOW end of the range is credited against the car the client wants to buy.
export function tradeInDiscount(offer, price, now = new Date()) {
  if (!offer?.tradeIn || !isOfferValid(offer, now)) return null;
  const target = Number(price), credit = Number(offer.low);
  if (!Number.isFinite(target) || target <= 0 || !Number.isFinite(credit) || credit <= 0) return null;
  return { credit, difference: Math.max(0, target - credit) };
}
