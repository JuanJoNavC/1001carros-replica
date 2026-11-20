// Expediente de compra: documentos del cliente, verificación de identidad y contrato.
//
// Flujo: reserva o precalificación -> documentos -> verificación de datos (Registro Civil)
//        -> si un dato no coincide: el cliente lo corrige y se verifica de nuevo, o se envía a un asesor
//        -> contrato con los datos verificados -> firma digital o en la agencia.
//
// El "Registro Civil" es SIMULADO en el prototipo (REGISTRO_PROVIDER sin definir). En producción se
// conecta un servicio autorizado de validación de identidad. La firma digital del prototipo no tiene
// validez legal: en producción se usa un proveedor acreditado de firma electrónica.

import { createHash, randomBytes } from "node:crypto";
import { isValidCedula } from "./prequalification.mjs";

export const FILE_KINDS = {
  cedula_frente: "Cédula (lado frontal)",
  cedula_reverso: "Cédula (lado posterior)",
  votacion: "Certificado de votación",
  planilla: "Planilla de servicios básicos",
  rol: "Roles de pago (últimos 3 meses)",
  estado_cuenta: "Estados de cuenta bancarios (últimos 3 meses)",
  ruc: "RUC o declaración de impuestos"
};
export const ACCEPTED_TYPES = ["image/jpeg", "image/png", "application/pdf"];
export const MAX_FILE_BYTES = 2.5 * 1024 * 1024;

export function requiredKinds(application) {
  const kinds = ["cedula_frente", "cedula_reverso", "planilla"];
  if (!application.voting_exempt) kinds.push("votacion");
  if (application.employment === "independiente") kinds.push("estado_cuenta", "ruc");
  else kinds.push("rol");
  return kinds;
}

export const newApplicationToken = () => randomBytes(18).toString("base64url");

// ---- Registro Civil (simulado) ----
export const TEST_REGISTRY = {
  "1700000019": "MARIA JOSE PEREZ LOPEZ",
  "1700000027": "CARLOS ANDRES MORA VERA",
  "1700000035": "ANA LUCIA TORRES RUIZ",
  "1700000043": "JORGE LUIS CEVALLOS PAZ",
  "1700000050": "DANIELA FERNANDA RIOS VEGA"
};

export function normalizeName(name) {
  return String(name || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-ZÑ ]/g, " ").replace(/\s+/g, " ").trim();
}

export function registrySettings(env = process.env) {
  return { provider: env.REGISTRO_PROVIDER ? String(env.REGISTRO_PROVIDER) : "simulado" };
}

// Devuelve los nombres registrados para la cédula. En la simulación, las cédulas de prueba tienen un
// nombre fijo; para cualquier otra cédula válida el registro "confirma" el nombre escrito por el cliente.
export async function lookupRegistry(cedula, typedName, settings = registrySettings()) {
  if (settings.provider !== "simulado") throw new Error(`Proveedor de Registro Civil no implementado: ${settings.provider}`);
  if (!isValidCedula(cedula)) return { found: false };
  const fullName = TEST_REGISTRY[cedula] || normalizeName(typedName);
  return { found: true, cedula, fullName, source: "Registro Civil (simulado)" };
}

export function namesMatch(typed, registered) {
  const a = normalizeName(typed).split(" ").filter(Boolean).sort().join(" ");
  const b = normalizeName(registered).split(" ").filter(Boolean).sort().join(" ");
  return a.length > 0 && a === b;
}

export function validateApplicant(data = {}) {
  const applicant = {
    fullName: String(data.fullName || "").trim().replace(/\s+/g, " ").slice(0, 120),
    cedula: String(data.cedula || "").replace(/\D/g, ""),
    address: String(data.address || "").trim().slice(0, 200),
    phone: String(data.phone || "").replace(/[\s-]/g, "").slice(0, 20),
    email: String(data.email || "").trim().toLowerCase().slice(0, 160)
  };
  if (applicant.fullName.split(" ").length < 3) return { error: "Escribe tus nombres y apellidos completos, como aparecen en tu cédula." };
  if (!isValidCedula(applicant.cedula)) return { error: "Revisa tu número de cédula (10 dígitos)." };
  if (applicant.address.length < 8) return { error: "Escribe tu dirección de domicilio." };
  if (!/^(\+?593|0)9\d{8}$/.test(applicant.phone)) return { error: "Escribe un celular válido (ej. 0991234567)." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(applicant.email)) return { error: "Escribe un correo válido." };
  return { applicant };
}

export function validateUpload(data = {}) {
  const kind = String(data.kind || "");
  if (!FILE_KINDS[kind]) return { error: "Documento no reconocido." };
  const type = String(data.type || "");
  if (!ACCEPTED_TYPES.includes(type)) return { error: "Formato no admitido. Sube una foto JPG o PNG, o un PDF." };
  const base64 = String(data.data || "").replace(/^data:[^,]+,/, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(base64)) return { error: "No pudimos leer el archivo. Inténtalo de nuevo." };
  const size = Math.floor(base64.length * 3 / 4);
  if (size <= 0) return { error: "El archivo está vacío." };
  if (size > MAX_FILE_BYTES) return { error: "El archivo supera 2,5 MB. Toma la foto con menos resolución o sube un PDF más liviano." };
  return { file: { kind, type, size, name: String(data.name || kind).slice(0, 120), data: base64 } };
}

// ---- Contrato ----
export const contractNumber = application => `CT-${String(application.id).padStart(5, "0")}-${application.token.slice(0, 4).toUpperCase()}`;

export function buildContract({ application, vehicle, agency, reservation, prequal, now = new Date() }) {
  const a = application.applicant || {};
  const offer = prequal?.decision?.offer || null;
  const deposit = reservation && reservation.status === "paid" ? Number(reservation.amount_cents) / 100 : 0;
  const price = Number(vehicle.price);
  const contract = {
    number: contractNumber(application),
    city: agency?.city?.split(",")[0] || "Quito",
    date: now.toISOString(),
    seller: { name: "1001Carros.com (Casabaca S.A.) — modelo de prototipo", agency: agency ? `${agency.name}, ${agency.address}` : "Por confirmar" },
    buyer: { fullName: a.fullName, cedula: a.cedula, address: a.address, phone: a.phone, email: a.email },
    vehicle: { brand: vehicle.brand, model: vehicle.model, year: vehicle.year, code: vehicle.code, color: vehicle.color, mileage: vehicle.mileage, transmission: vehicle.transmission },
    price,
    reservation: deposit ? { code: reservation.client_tx_id, amount: deposit } : null,
    payment: offer ? {
      type: "financiado", lender: offer.lender, downPayment: offer.downPayment, financed: offer.financed,
      term: offer.term, monthly: offer.monthly, annualRate: offer.annualRate, prequalFolio: prequal.folio
    } : { type: "contado" },
    balanceDue: Math.max(0, (offer ? offer.downPayment : price) - deposit)
  };
  contract.hash = createHash("sha256").update(JSON.stringify(contract)).digest("hex");
  return contract;
}

export function publicApplication(app, files = [], extra = {}) {
  if (!app) return null;
  const required = requiredKinds(app);
  const uploaded = new Set(files.map(file => file.kind));
  return {
    token: app.token, id: app.id, status: app.status, vehicleId: app.vehicle_id, reservationTx: app.reservation_tx, prequalFolio: app.prequal_folio,
    employment: app.employment, votingExempt: Boolean(app.voting_exempt),
    applicant: app.applicant || null, registry: app.registry || null,
    verification: { status: app.verification_status, note: app.verification_note, reviewNote: app.review_note },
    files: files.map(file => ({ id: file.id, kind: file.kind, label: FILE_KINDS[file.kind], name: file.name, type: file.type, size: file.size, createdAt: file.created_at })),
    required: required.map(kind => ({ kind, label: FILE_KINDS[kind], uploaded: uploaded.has(kind) })),
    documentsComplete: required.every(kind => uploaded.has(kind)),
    contract: app.contract || null, signature: app.signature || null, signMode: app.sign_mode, signedAt: app.signed_at,
    createdAt: app.created_at, updatedAt: app.updated_at, ...extra
  };
}
