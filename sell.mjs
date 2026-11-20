// Cotizador de carros usados ("Vender mi carro").
//
// La oferta sigue la fórmula «Pricing 2.0» de 1001Carros (cotizador/politica.json, editable):
//   precio del modelo nuevo sin IVA
//   x (1 - depreciación acumulada del grupo de la marca según los años del carro)
//   x ajuste por kilometraje (frente al promedio del portafolio: 18.496 km por año)
//   x ponderación por placa (provincia)
//   - margen de ganancia (8% a 10%)
//   - reparaciones (las asume el cliente) y valores pendientes (si el cliente elige descontarlos)
// Si no hay precio de nuevo cargado, se estima con los carros del mismo modelo del catálogo.
// Los carros chocados, con muchos detalles o fuera de la tabla pasan directo al coordinador de avalúos.
//
// La consulta de valores pendientes por placa es SIMULADA (PLACA_PROVIDER para conectar ANT/AMT/SRI).

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const DEFAULT_POLICY = {
  margen_ganancia: 0.09, margen_venta_catalogo: 0.11,
  grupos_marcas: { 0: ["toyota"], 1: ["chevrolet", "kia", "hyundai", "great wall", "nissan", "suzuki"], 2: ["chery", "renault", "mazda", "ford", "volkswagen"], 3: ["jac", "dfsk", "dongfeng", "shineray", "peugeot", "soueast"], 4: ["citroen", "changan", "mitsubishi", "jetour"] },
  depreciacion_por_anios: { 0: [0.095, 0.122, 0.149, 0.176, 0.203, 0.23], 1: [0.133, 0.166, 0.198, 0.231, 0.264, 0.296], 2: [0.17, 0.21, 0.25, 0.29, 0.329, 0.369], 3: [0.206, 0.256, 0.305, 0.354, 0.403, 0.452], 4: [0.241, 0.287, 0.333, 0.379, 0.425, 0.471], 5: [0.278, 0.334, 0.389, 0.444, 0.5, 0.555], 6: [0.322, 0.381, 0.441, 0.5, 0.56, 0.619], 7: [0.362, 0.415, 0.469, 0.522, 0.575, 0.628], 8: [0.396, 0.456, 0.516, 0.576, 0.636, 0.696], 9: [0.428, 0.489, 0.55, 0.611, 0.672, 0.733] },
  km_promedio_portafolio: 18496, ajuste_km_por_cada_10pct: 0.01, ajuste_km_maximo: 0.08,
  ponderacion_por_placa: {}, precios_nuevos: {},
  costos_reparacion: { frenos: 340, llantas_medias: 200, llantas_cambiar: 450, parabrisas_trizado: 300, pintura_por_pieza: 180, golpe_por_pieza: 250, choque_leve: 250, aire_no_funciona: 350, una_sola_llave: 250, tapiceria_danada: 250, mantenimiento_atrasado: 200 },
  valores_pendientes: { matricula_pendiente: 250 },
  rango_oferta: 0.03, validez_dias: 3, oferta_minima: 1000,
  pasa_a_evaluador: { anios_maximo_tabla: 9, km_maximo: 250000, piezas_con_golpes_maximo: 2, prenda_maxima_sobre_valor: 0.6 }
};

let cachedPolicy = null;
export function loadPolicy() {
  if (cachedPolicy) return cachedPolicy;
  let file = {};
  try { file = JSON.parse(readFileSync(new URL("./cotizador/politica.json", import.meta.url), "utf8")); } catch { file = {}; }
  const merge = key => ({ ...DEFAULT_POLICY[key], ...(file[key] || {}) });
  cachedPolicy = { ...DEFAULT_POLICY, ...file, costos_reparacion: merge("costos_reparacion"), valores_pendientes: merge("valores_pendientes"), pasa_a_evaluador: merge("pasa_a_evaluador"), grupos_marcas: file.grupos_marcas || DEFAULT_POLICY.grupos_marcas, depreciacion_por_anios: file.depreciacion_por_anios || DEFAULT_POLICY.depreciacion_por_anios };
  return cachedPolicy;
}
export const PHOTO_KINDS = {
  frente: "Frente 3/4 (esquina delantera)", atras: "Atrás 3/4 (esquina trasera)", lateral_izq: "Lateral izquierdo", lateral_der: "Lateral derecho",
  tablero: "Tablero encendido (kilometraje y testigos)", interior_del: "Interior delantero", interior_tras: "Asientos traseros", motor: "Motor (capó abierto)",
  llantas: "Llanta y aro (la más gastada)", maletero: "Maletero", detalle_1: "Detalle o daño 1", detalle_2: "Detalle o daño 2", detalle_3: "Detalle o daño 3"
};
export const REQUIRED_PHOTOS = ["frente", "atras", "lateral_izq", "lateral_der", "tablero", "interior_del", "interior_tras", "motor", "llantas"];
export const MEDIA_TYPES = ["image/jpeg", "image/png", "video/webm", "video/mp4", "video/quicktime"];
export const MAX_VIDEO_BYTES = 12 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024;

export const newSellToken = () => randomBytes(18).toString("base64url");
const norm = value => String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
const num = value => (value === "" || value === null || value === undefined ? NaN : Number(value));
const round50 = n => Math.round(n / 50) * 50;

export function normalizePlate(plate) { return String(plate || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }
export const isValidPlate = plate => /^[A-Z]{3}\d{3,4}$/.test(normalizePlate(plate));

// ---- Consulta de valores pendientes por placa (simulada) ----
export const TEST_PLATES = {
  PBA1234: { multas: 0, matricula_pagada_hasta: null, revision_tecnica: "aprobada", prenda_saldo: 0, titular_coincide: true, label: "Sin pendientes" },
  PCD5678: { multas: 135.6, matricula_pagada_hasta: -1, revision_tecnica: "aprobada", prenda_saldo: 0, titular_coincide: true, label: "Multas y matrícula pendiente" },
  GYE2020: { multas: 0, matricula_pagada_hasta: null, revision_tecnica: "aprobada", prenda_saldo: 4500, titular_coincide: true, label: "Con prenda (crédito vigente)" },
  ABC1111: { multas: 48, matricula_pagada_hasta: null, revision_tecnica: "no_aprobada", prenda_saldo: 0, titular_coincide: true, label: "Revisión técnica no aprobada" }
};
export function lookupPlate(plate, now = new Date()) {
  const p = normalizePlate(plate);
  if (!isValidPlate(p)) return { error: "Escribe una placa válida, por ejemplo PBA1234." };
  const year = now.getUTCFullYear();
  const base = TEST_PLATES[p] || (() => { const seed = [...p].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 9973, 7); return { multas: seed % 5 === 0 ? 42.5 * (1 + seed % 3) : 0, matricula_pagada_hasta: seed % 7 === 0 ? -1 : null, revision_tecnica: "aprobada", prenda_saldo: 0, titular_coincide: true }; })();
  return {
    plate: p, source: "Consulta de prueba (simulada: ANT, AMT y SRI)",
    multas: Number(base.multas || 0), matricula_al_dia: base.matricula_pagada_hasta === null, matricula_pagada_hasta: base.matricula_pagada_hasta === null ? year : year + base.matricula_pagada_hasta,
    revision_tecnica: base.revision_tecnica, prenda_saldo: Number(base.prenda_saldo || 0), titular_coincide: base.titular_coincide !== false, testProfile: base.label || null
  };
}

// ---- Validación de la solicitud ----
export function validateSellInput(data = {}, now = new Date()) {
  const v = data.vehicle || {}, c = data.condition || {}, l = data.legal || {}, contact = data.contact || {};
  const maxYear = now.getUTCFullYear() + 1;
  const vehicle = { plate: normalizePlate(v.plate), brand: String(v.brand || "").trim().slice(0, 40), model: String(v.model || "").trim().slice(0, 60), version: String(v.version || "").trim().slice(0, 60), year: num(v.year), mileage: num(v.mileage), transmission: v.transmission === "Manual" ? "Manual" : "Automática", fuel: String(v.fuel || "Gasolina").slice(0, 20), color: String(v.color || "").trim().slice(0, 30), city: String(v.city || "").trim().slice(0, 40), owners: v.owners === "varios" ? "varios" : "uno", dealerMaintenance: Boolean(v.dealerMaintenance) };
  if (!isValidPlate(vehicle.plate)) return { error: "Escribe una placa válida, por ejemplo PBA1234." };
  if (!vehicle.brand || !vehicle.model) return { error: "Escribe la marca y el modelo." };
  if (!Number.isInteger(vehicle.year) || vehicle.year < 1980 || vehicle.year > maxYear) return { error: "Revisa el año del carro." };
  if (!Number.isFinite(vehicle.mileage) || vehicle.mileage < 0 || vehicle.mileage > 1500000) return { error: "Revisa el kilometraje." };
  const pick = (value, options, fallback) => options.includes(value) ? value : fallback;
  const condition = {
    crash: pick(c.crash, ["ninguno", "leve", "fuerte", "estructural"], "ninguno"),
    airbags: Boolean(c.airbags), engineLights: Boolean(c.engineLights), engineNoise: Boolean(c.engineNoise),
    dentedPanels: Math.max(0, Math.min(20, Math.round(num(c.dentedPanels) || 0))), repaintedPanels: Math.max(0, Math.min(20, Math.round(num(c.repaintedPanels) || 0))),
    brakes: Boolean(c.brakes), tires: pick(c.tires, ["buenas", "medias", "cambiar"], "buenas"), windshield: Boolean(c.windshield), acWorks: c.acWorks !== false,
    keys: c.keys === 1 || c.keys === "1" ? 1 : 2, upholstery: Boolean(c.upholstery), maintenanceLate: Boolean(c.maintenanceLate),
    notes: String(c.notes || "").slice(0, 600)
  };
  const legal = {
    multas: Math.max(0, num(l.multas) || 0), matricula_al_dia: l.matricula_al_dia !== false, revision_tecnica: pick(l.revision_tecnica, ["aprobada", "no_aprobada", "pendiente"], "aprobada"),
    prenda_saldo: Math.max(0, num(l.prenda_saldo) || 0), titular_coincide: l.titular_coincide !== false, descontar_pendientes: l.descontar_pendientes !== false, verified: Boolean(l.verified)
  };
  const contactOut = { name: String(contact.name || "").trim().slice(0, 120), email: String(contact.email || "").trim().toLowerCase().slice(0, 160), phone: String(contact.phone || "").replace(/[\s-]/g, "").slice(0, 20), tradeIn: Boolean(contact.tradeIn) };
  if (contactOut.name.length < 3) return { error: "Escribe tu nombre." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactOut.email)) return { error: "Escribe un correo válido." };
  if (!/^(\+?593|0)9\d{8}$/.test(contactOut.phone)) return { error: "Escribe un celular válido (ej. 0991234567)." };
  return { vehicle, condition, legal, contact: contactOut };
}

// ---- Pricing 2.0 ----
export function brandGroup(brand, policy = loadPolicy()) {
  const b = norm(brand);
  for (const [group, brands] of Object.entries(policy.grupos_marcas)) if (!group.startsWith("_") && Array.isArray(brands) && brands.some(name => norm(name) === b)) return Number(group);
  return 5;
}
export function depreciation(group, years, policy = loadPolicy()) {
  const row = policy.depreciacion_por_anios[String(Math.max(0, Math.round(years)))];
  return Array.isArray(row) ? row[group] : null;
}
const ageOf = (year, now) => Math.max(0, now.getUTCFullYear() - Number(year));
export function kmFactor(mileage, years, policy = loadPolicy()) {
  const expected = Math.max(0.5, years) * policy.km_promedio_portafolio;
  const diffPct = (expected - mileage) / expected; // positivo = recorrió menos que el promedio
  const adj = Math.max(-policy.ajuste_km_maximo, Math.min(policy.ajuste_km_maximo, (diffPct / 0.1) * policy.ajuste_km_por_cada_10pct));
  return { factor: 1 + adj, expected: Math.round(expected), adj };
}
export function plateFactor(plate, policy = loadPolicy()) {
  const table = policy.ponderacion_por_placa || {}, letter = normalizePlate(plate)[0];
  const value = Number(table[letter] ?? table.otras ?? 1);
  return Number.isFinite(value) && value > 0 ? value : 1;
}
// Precio del modelo nuevo sin IVA: el cargado en la política o, si no está, estimado con el catálogo
// (precio de venta del seminuevo, sin el margen de venta, devuelto a valor de nuevo con la misma tabla).
export function newPrice(vehicle, catalog, policy = loadPolicy(), now = new Date()) {
  const brand = norm(vehicle.brand), modelWord = norm(vehicle.model).split(" ")[0];
  const table = policy.precios_nuevos || {};
  const key = Object.keys(table).find(k => !k.startsWith("_") && Number(table[k]) > 0 && norm(k) === `${brand} ${norm(vehicle.model)}`) || Object.keys(table).find(k => !k.startsWith("_") && Number(table[k]) > 0 && norm(k) === `${brand} ${modelWord}`);
  const sameBrand = (catalog || []).filter(car => Number(car.price) > 0 && norm(car.brand) === brand);
  const sameModel = sameBrand.filter(car => norm(car.model).split(" ")[0] === modelWord);
  const cars = sameModel.length ? sameModel : sameBrand;
  const comparables = cars.slice(0, 4).map(car => ({ id: car.id, label: `${car.year} ${car.brand} ${car.model}`, price: Number(car.price), mileage: Number(car.mileage) }));
  if (key) return { value: Math.round(Number(table[key])), source: "lista", comparables, stock: sameModel.length };
  const group = brandGroup(vehicle.brand, policy);
  const estimates = cars.map(car => { const dep = depreciation(group, ageOf(car.year, now), policy); return dep === null ? null : Number(car.price) / (1 + policy.margen_venta_catalogo) / (1 - dep); }).filter(Boolean);
  if (!estimates.length) return { value: null, source: "sin_referencia", comparables, stock: sameModel.length };
  return { value: Math.round(estimates.reduce((a, b) => a + b, 0) / estimates.length), source: sameModel.length ? "catalogo" : "misma_marca", comparables, stock: sameModel.length };
}
export function pricing(vehicle, catalog, policy = loadPolicy(), now = new Date()) {
  const group = brandGroup(vehicle.brand, policy), years = ageOf(vehicle.year, now);
  const np = newPrice(vehicle, catalog, policy, now), dep = depreciation(group, years, policy);
  const km = kmFactor(vehicle.mileage, years, policy), plate = plateFactor(vehicle.plate, policy);
  const value = np.value && dep !== null ? Math.round(np.value * (1 - dep) * km.factor * plate) : null;
  return { value, newPrice: np.value, newPriceSource: np.source, group, years, depreciation: dep, kmFactor: Math.round(km.factor * 1000) / 1000, kmExpected: km.expected, plateFactor: plate, comparables: np.comparables, stock: np.stock };
}
// Compatibilidad: valor de mercado = resultado de la fórmula de pricing antes del margen.
export function marketValue(vehicle, catalog, policy = loadPolicy(), now = new Date()) {
  const p = pricing(vehicle, catalog, policy, now);
  return { value: p.value, comparables: p.comparables, basis: p.newPriceSource, stock: p.stock };
}

// ---- Cotización ----
export function quoteSell({ vehicle, condition, legal }, catalog, { policy = loadPolicy(), now = new Date(), hasPhotos = true } = {}) {
  const p = pricing(vehicle, catalog, policy, now);
  const market = { value: p.value, comparables: p.comparables, basis: p.newPriceSource, stock: p.stock };
  const reasons = [];
  const rules = policy.pasa_a_evaluador;
  if (["fuerte", "estructural"].includes(condition.crash)) reasons.push("El carro tuvo un choque fuerte o estructural.");
  if (condition.airbags) reasons.push("Se activaron las bolsas de aire.");
  if (condition.engineLights) reasons.push("Hay testigos de motor encendidos en el tablero.");
  if (condition.engineNoise) reasons.push("El motor tiene ruidos o fugas.");
  if (condition.dentedPanels > rules.piezas_con_golpes_maximo) reasons.push(`Tiene ${condition.dentedPanels} piezas con golpes.`);
  if (p.years > rules.anios_maximo_tabla) reasons.push(`Tiene más de ${rules.anios_maximo_tabla} años: el precio lo da un evaluador.`);
  if (vehicle.mileage > rules.km_maximo) reasons.push(`Supera los ${rules.km_maximo.toLocaleString("es-EC")} km.`);
  if (legal.revision_tecnica === "no_aprobada") reasons.push("La revisión técnica vehicular no está aprobada.");
  if (!legal.titular_coincide) reasons.push("El carro no está a nombre de quien lo vende.");
  if (p.value === null && p.years <= rules.anios_maximo_tabla) reasons.push("Todavía no tenemos precio de referencia para este modelo.");
  if (p.value && legal.prenda_saldo > p.value * rules.prenda_maxima_sobre_valor) reasons.push("El saldo de la prenda es alto frente al valor del carro.");

  const c = policy.costos_reparacion;
  const items = [];
  const add = (label, amount) => { if (amount > 0) items.push({ label, amount: Math.round(amount) }); };
  if (condition.brakes) add("Frenos", c.frenos);
  if (condition.tires === "medias") add("Llantas a media vida", c.llantas_medias);
  if (condition.tires === "cambiar") add("Cambio de llantas", c.llantas_cambiar);
  if (condition.windshield) add("Parabrisas trizado", c.parabrisas_trizado);
  if (condition.repaintedPanels) add(`Pintura (${condition.repaintedPanels} pieza${condition.repaintedPanels > 1 ? "s" : ""})`, c.pintura_por_pieza * condition.repaintedPanels);
  if (condition.dentedPanels) add(`Golpes (${condition.dentedPanels} pieza${condition.dentedPanels > 1 ? "s" : ""})`, c.golpe_por_pieza * condition.dentedPanels);
  if (condition.crash === "leve") add("Reparación de choque leve", c.choque_leve);
  if (!condition.acWorks) add("Aire acondicionado", c.aire_no_funciona);
  if (condition.keys === 1) add("Copia de llave", c.una_sola_llave);
  if (condition.upholstery) add("Tapicería", c.tapiceria_danada);
  if (condition.maintenanceLate) add("Mantenimiento atrasado", c.mantenimiento_atrasado);
  const deduct = legal.descontar_pendientes !== false;
  const pending = [], payBefore = [];
  if (legal.multas > 0) (deduct ? pending : payBefore).push({ label: "Multas pendientes", amount: Math.round(legal.multas * 100) / 100 });
  if (!legal.matricula_al_dia) (deduct ? pending : payBefore).push({ label: "Matrícula pendiente", amount: policy.valores_pendientes.matricula_pendiente });
  if (legal.prenda_saldo > 0) pending.push({ label: "Saldo de prenda (se paga a la entidad)", amount: Math.round(legal.prenda_saldo) });

  const marginPct = policy.margen_ganancia;
  const base = { market, pricing: p, items, pending, payBefore, margin: p.value ? Math.round(p.value * marginPct) : null, marginPct, validUntil: new Date(now.getTime() + policy.validez_dias * 86400000).toISOString() };
  if (reasons.length) return { ...base, status: "evaluation", reasons, offer: null };
  const costs = items.reduce((sum, item) => sum + item.amount, 0), pendingTotal = pending.reduce((sum, item) => sum + item.amount, 0);
  const mid = p.value - base.margin - costs - pendingTotal;
  if (mid < policy.oferta_minima) return { ...base, status: "evaluation", reasons: ["El valor estimado es muy bajo para una oferta automática."], offer: null };
  const low = Math.max(policy.oferta_minima, round50(mid * (1 - policy.rango_oferta))), high = round50(mid * (1 + policy.rango_oferta));
  return { ...base, status: hasPhotos ? "offer" : "preliminary", reasons: [], offer: { low, high, mid: Math.round(mid), costs, pendingTotal } };
}

export function publicSell(row, media = [], extra = {}) {
  if (!row) return null;
  const photos = media.filter(item => item.kind !== "video");
  const uploaded = new Set(photos.map(item => item.kind));
  return {
    token: row.token, id: row.id, status: row.status, vehicle: row.vehicle, condition: row.condition, legal: row.legal, contact: { name: row.contact?.name, tradeIn: row.contact?.tradeIn },
    quote: row.quote, finalOffer: row.final_offer, evaluatorNote: row.evaluator_note, accepted: row.accepted_at, inspection: row.inspection,
    photos: Object.keys(PHOTO_KINDS).map(kind => ({ kind, label: PHOTO_KINDS[kind], required: REQUIRED_PHOTOS.includes(kind), uploaded: uploaded.has(kind) })),
    photosComplete: REQUIRED_PHOTOS.every(kind => uploaded.has(kind)),
    video: media.find(item => item.kind === "video") ? { uploaded: true } : { uploaded: false },
    createdAt: row.created_at, ...extra
  };
}
