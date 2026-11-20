// Reserva de vehículos con pago en línea mediante la Cajita de Pagos de PayPhone.
//
// Flujo:
//   1. El cliente elige agencia y deja sus datos -> POST /api/reservations crea una reserva "pending"
//      y devuelve la configuración de la Cajita (el monto lo decide SIEMPRE el servidor).
//   2. El cliente paga en la Cajita; PayPhone redirige a /reserva/confirmacion?id=...&clientTransactionId=...
//   3. La página llama POST /api/reservations/confirm; el servidor confirma con PayPhone
//      (debe hacerse dentro de 5 minutos o PayPhone revierte el cobro) y marca la reserva como pagada.
//
// Si no hay credenciales (PAYPHONE_TOKEN), funciona en "modo demostración" con una pasarela simulada
// que imita a PayPhone: genera una transacción, redirige a /reserva/confirmacion?id=...&clientTransactionId=...
// y el servidor la confirma por el MISMO camino (interpretConfirmation) que un pago real.
// La simulación solo acepta tarjetas de prueba y nunca se usa si hay un token configurado.

import { randomBytes, randomInt, createHash } from "node:crypto";
import { isValidCedula } from "./prequalification.mjs";

export const RESERVATION_AMOUNT_USD = 200;
export const RESERVATION_AMOUNT_CENTS = RESERVATION_AMOUNT_USD * 100;
export const CURRENCY = "USD";
export const PAYPHONE_CONFIRM_URL = "https://paymentbox.payphonetodoesposible.com/api/confirm";
export const PAYPHONE_BOX_CSS = "https://cdn.payphonetodoesposible.com/box/v2.0/payphone-payment-box.css";
export const PAYPHONE_BOX_JS = "https://cdn.payphonetodoesposible.com/box/v2.0/payphone-payment-box.js";
export const APPROVED = 3;
export const CANCELED = 2;

export function paymentSettings(env = process.env) {
  const token = String(env.PAYPHONE_TOKEN || "").trim();
  const storeId = String(env.PAYPHONE_STORE_ID || "").trim();
  return { mode: token ? "payphone" : "demo", token, storeId };
}

export function newClientTransactionId(now = new Date()) {
  // Máximo 50 caracteres según PayPhone. Ej.: RES-20261120-1A2B3C4D5E6F
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `RES-${day}-${randomBytes(6).toString("hex").toUpperCase()}`;
}

const clean = (value, max) => String(value ?? "").trim().slice(0, max);

// Valida los datos del formulario. Devuelve { ok, errors, value }.
export function validateReservationInput(data = {}) {
  const value = {
    vehicleId: Number(data.vehicleId),
    agencyId: data.agencyId === undefined || data.agencyId === null || data.agencyId === "" ? null : Number(data.agencyId),
    name: clean(data.name, 120),
    email: clean(data.email, 160).toLowerCase(),
    phone: clean(data.phone, 20).replace(/[\s-]/g, ""),
    documentId: clean(data.documentId, 13)
  };
  const errors = [];
  if (!Number.isInteger(value.vehicleId) || value.vehicleId <= 0) errors.push("vehicleId");
  if (value.agencyId !== null && (!Number.isInteger(value.agencyId) || value.agencyId <= 0)) errors.push("agencyId");
  if (value.name.length < 3) errors.push("name");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) errors.push("email");
  if (!/^(\+?593|0)9\d{8}$/.test(value.phone)) errors.push("phone");
  if (value.documentId && !/^\d{10}(\d{3})?$/.test(value.documentId)) errors.push("documentId");
  return { ok: errors.length === 0, errors, value };
}

// Teléfono en el formato que pide PayPhone: +593 seguido del número sin el 0 inicial.
export function toPayphonePhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (/^5939\d{8}$/.test(digits)) return `+${digits}`;
  if (/^09\d{8}$/.test(digits)) return `+593${digits.slice(1)}`;
  return undefined;
}

// Configuración de la Cajita de Pagos. El monto (en centavos) lo fija el servidor.
export function buildPaymentBox(reservation, vehicle, settings) {
  const reference = `Reserva ${vehicle.brand} ${vehicle.model} ${vehicle.year} (${vehicle.code})`.slice(0, 100);
  const box = {
    token: settings.token,
    clientTransactionId: reservation.client_tx_id,
    amount: reservation.amount_cents,
    // Se cobra como anticipo sin IVA. Confirmar el tratamiento tributario con contabilidad.
    amountWithoutTax: reservation.amount_cents,
    currency: CURRENCY,
    reference,
    lang: "es",
    timeZone: -5,
    email: reservation.email || undefined,
    phoneNumber: toPayphonePhone(reservation.phone),
    documentId: reservation.document_id || undefined
  };
  if (settings.storeId) box.storeId = settings.storeId;
  for (const key of Object.keys(box)) if (box[key] === undefined) delete box[key];
  return box;
}

// Interpreta la respuesta de /api/confirm de PayPhone.
export function interpretConfirmation(body, reservation) {
  if (!body || typeof body !== "object") return { status: "error", reason: "Respuesta vacía de PayPhone" };
  if (body.errorCode !== undefined && body.statusCode === undefined) return { status: "error", reason: body.message || `Error ${body.errorCode}` };
  if (String(body.clientTransactionId ?? "") !== reservation.client_tx_id) return { status: "error", reason: "La transacción no corresponde a esta reserva" };
  if (Number(body.statusCode) === APPROVED) {
    if (Number(body.amount) !== Number(reservation.amount_cents)) return { status: "error", reason: "El monto pagado no coincide con la reserva" };
    return {
      status: "paid",
      payment: {
        payphoneId: Number(body.transactionId),
        authorizationCode: body.authorizationCode ? String(body.authorizationCode) : null,
        cardBrand: body.cardBrand ? String(body.cardBrand) : null,
        lastDigits: body.lastDigits ? String(body.lastDigits) : null
      }
    };
  }
  if (Number(body.statusCode) === CANCELED) return { status: "canceled", reason: body.message || "Pago cancelado" };
  return { status: "error", reason: body.message || "Estado de pago desconocido" };
}

// Confirma la transacción con PayPhone. `fetchImpl` es inyectable para las pruebas.
export async function confirmWithPayphone({ id, reservation, settings, fetchImpl = fetch }) {
  const response = await fetchImpl(PAYPHONE_CONFIRM_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${settings.token}`, "content-type": "application/json" },
    body: JSON.stringify({ id: Number(id), clientTxId: reservation.client_tx_id })
  });
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  return interpretConfirmation(body, reservation);
}

// Lo que se puede mostrar al cliente sobre su reserva (sin datos sensibles completos).
export function publicReservation(row, vehicle = null) {
  if (!row) return null;
  return {
    clientTransactionId: row.client_tx_id,
    status: row.status,
    mode: row.mode,
    amount: Number(row.amount_cents) / 100,
    currency: CURRENCY,
    vehicleId: Number(row.vehicle_id),
    agencyId: row.agency_id === null || row.agency_id === undefined ? null : Number(row.agency_id),
    name: row.name,
    createdAt: row.created_at,
    paidAt: row.paid_at,
    cardBrand: row.card_brand,
    lastDigits: row.last_digits,
    authorizationCode: row.authorization_code,
    phoneVerified: Boolean(row.phone_verified_at),
    maskedPhone: maskPhone(row.phone),
    documentProvided: Boolean(row.document_id),
    expiresAt: row.expires_at ?? null,
    visitAt: row.visit_at ?? null,
    vehicle: vehicle ? { id: vehicle.id, brand: vehicle.brand, model: vehicle.model, year: vehicle.year, code: vehicle.code, price: Number(vehicle.price), image: vehicle.image ?? "" } : null
  };
}

// ---- Pasarela simulada (modo demostración) ----
// Tarjetas de prueba: solo estas se aceptan; cualquier otro número se rechaza sin guardarse.
export const TEST_CARDS = {
  "4111111111111111": { brand: "Visa", statusCode: APPROVED, label: "Visa · pago aprobado" },
  "5555555555554444": { brand: "Mastercard", statusCode: APPROVED, label: "Mastercard · pago aprobado" },
  "4000000000000002": { brand: "Visa", statusCode: CANCELED, message: "Transacción rechazada: fondos insuficientes", label: "Visa · fondos insuficientes" },
  "5105105105105100": { brand: "Mastercard", statusCode: CANCELED, message: "Transacción rechazada por el banco emisor", label: "Mastercard · rechazada por el banco" }
};

// Devuelve el resultado simulado o { error } si los datos no son de prueba.
export function simulateCharge({ method, cardNumber, approve }) {
  if (method === "card") {
    const digits = String(cardNumber || "").replace(/\D/g, "");
    const card = TEST_CARDS[digits];
    if (!card) return { error: "En la simulación solo se aceptan las tarjetas de prueba." };
    return { method, statusCode: card.statusCode, cardBrand: card.brand, lastDigits: digits.slice(-4), message: card.message || "Transacción aprobada" };
  }
  if (method === "payphone") {
    return approve === false
      ? { method, statusCode: CANCELED, cardBrand: "Saldo PayPhone", lastDigits: null, message: "Pago rechazado desde la app" }
      : { method, statusCode: APPROVED, cardBrand: "Saldo PayPhone", lastDigits: null, message: "Transacción aprobada" };
  }
  return { error: "Método de pago no válido" };
}

export function simulatedAuthorizationCode() {
  return randomBytes(3).toString("hex").toUpperCase();
}

// Respuesta con la misma forma que /api/confirm de PayPhone, a partir de una transacción simulada.
export function simulatedConfirmBody(sim, reservation) {
  return {
    statusCode: Number(sim.status_code),
    transactionStatus: Number(sim.status_code) === APPROVED ? "Approved" : "Canceled",
    transactionId: Number(sim.id),
    clientTransactionId: reservation.client_tx_id,
    amount: Number(sim.amount_cents),
    currency: CURRENCY,
    authorizationCode: sim.authorization_code,
    cardBrand: sim.card_brand,
    lastDigits: sim.last_digits,
    message: sim.message
  };
}

// ---- Filtro antes de reservar (capas 1 y 2) ----
export const HOLD_HOURS = 72;               // la reserva separa el carro 72 h si no se agenda visita
export const MAX_RESERVATIONS_PER_DAY = 5;  // intentos de reserva por celular o correo en 24 h
export const MAX_SIM_CHARGES = 3;           // intentos de pago por reserva (simulación)
export const OTP_TTL_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_SECONDS = 30;
export const OTP_MAX_SENDS = 4;

// Celular en formato único (+5939XXXXXXXX) para comparar personas.
export function normalizePhone(phone) {
  return toPayphonePhone(phone) || String(phone || "").replace(/\D/g, "");
}

export function maskPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length >= 4 ? `••• ${digits.slice(-4)}` : "•••";
}

export function newOtpCode() {
  return String(randomInt(0, 1000000)).padStart(6, "0");
}

export function hashOtp(code, clientTransactionId) {
  return createHash("sha256").update(`${clientTransactionId}:${code}`).digest("hex");
}

// Cédula ecuatoriana (10 dígitos con dígito verificador) o RUC (13 dígitos terminado en 001).
export function isValidDocument(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) return isValidCedula(digits);
  if (digits.length === 13) return digits.endsWith("001");
  return false;
}

// Proveedor de mensajes: sin proveedor configurado, el código se muestra en pantalla (simulación).
export function messagingSettings(env = process.env) {
  return { mode: env.OTP_PROVIDER ? "provider" : "demo" };
}
