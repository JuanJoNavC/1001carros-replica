// Precalificación de crédito: consulta al buró + motor de decisión.
//
// En Ecuador los burós autorizados (Equifax y Aval) venden la consulta a empresas mediante contrato.
// Mientras 1001Carros no tenga ese contrato, el servidor usa un BURÓ SIMULADO con la misma estructura
// de respuesta (score 0–999, deudas vigentes, cuota mensual de deudas, mora y consultas recientes).
// Para conectar el buró real basta con implementar `queryBureau` para el proveedor (BURO_PROVIDER).

import { createHash, randomBytes } from "node:crypto";
import { isValidCedula } from "./prequalification.mjs";

export const CONSENT_VERSION = "2026-11-v1";
export const CONSENT_TEXT = "Autorizo expresamente a 1001Carros.com y a sus entidades financieras aliadas a consultar y tratar mi información crediticia en los burós de crédito autorizados, con la única finalidad de evaluar mi solicitud de financiamiento vehicular, conforme a la Ley Orgánica de Protección de Datos Personales. Puedo revocar esta autorización en cualquier momento.";
export const MAX_DEBT_RATIO = 0.40;          // deudas totales / ingreso (recomendación de endeudamiento responsable)
export const MAX_RATE = 0.1677;              // tasa efectiva máxima del segmento consumo (BCE)
export const TERMS = [36, 48, 60, 72];
export const REUSE_HOURS = 24;               // una misma cédula no se vuelve a consultar dentro de 24 h
export const MAX_DOWN_PCT = 0.5;

export function bureauSettings(env = process.env) {
  return { provider: env.BURO_PROVIDER ? String(env.BURO_PROVIDER) : "simulado" };
}

// Cédulas de prueba con perfiles fijos para demostrar cada resultado.
export const TEST_PROFILES = {
  "1700000019": { label: "Excelente historial", score: 912, activeDebts: 1, monthlyDebtPayment: 120, maxDaysPastDue24m: 0, recentInquiries: 0 },
  "1700000027": { label: "Buen historial", score: 748, activeDebts: 2, monthlyDebtPayment: 260, maxDaysPastDue24m: 5, recentInquiries: 1 },
  "1700000035": { label: "Deudas altas", score: 690, activeDebts: 4, monthlyDebtPayment: 450, maxDaysPastDue24m: 15, recentInquiries: 3 },
  "1700000043": { label: "Con mora reciente", score: 455, activeDebts: 3, monthlyDebtPayment: 380, maxDaysPastDue24m: 95, recentInquiries: 4 },
  "1700000050": { label: "Sin historial crediticio", score: null, activeDebts: 0, monthlyDebtPayment: 0, maxDaysPastDue24m: 0, recentInquiries: 0, thinFile: true }
};

export const hashCedula = cedula => createHash("sha256").update(`1001carros:${cedula}`).digest("hex");
export const maskCedula = cedula => `${String(cedula).slice(0, 3)}*****${String(cedula).slice(8)}`;
export const newFolio = (now = new Date()) => `BUR-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(3).toString("hex").toUpperCase()}`;

// Buró simulado: mismo resultado siempre para la misma cédula.
export function simulateBureauReport(cedula) {
  const profile = TEST_PROFILES[cedula];
  if (profile) return { ...profile, thinFile: Boolean(profile.thinFile), testProfile: profile.label };
  const seed = parseInt(createHash("sha256").update(String(cedula)).digest("hex").slice(0, 8), 16);
  const pick = (n, offset = 0) => Math.floor(seed / 7 ** offset) % n;
  if (pick(20) === 0) return { score: null, activeDebts: 0, monthlyDebtPayment: 0, maxDaysPastDue24m: 0, recentInquiries: 0, thinFile: true };
  const score = 380 + pick(600, 1);
  const activeDebts = pick(5, 2);
  const monthlyDebtPayment = activeDebts * (60 + pick(140, 3));
  const maxDaysPastDue24m = score >= 750 ? pick(6, 4) : score >= 600 ? [0, 5, 15, 30][pick(4, 4)] : [30, 60, 90, 120][pick(4, 4)];
  return { score, activeDebts, monthlyDebtPayment, maxDaysPastDue24m, recentInquiries: pick(4, 5), thinFile: false };
}

// Punto único de conexión con el buró. Hoy: simulado. Mañana: Equifax o Aval con credenciales.
export async function queryBureau(cedula, settings = bureauSettings()) {
  if (settings.provider !== "simulado") throw new Error(`Proveedor de buró no implementado: ${settings.provider}`);
  return simulateBureauReport(cedula);
}

export function scoreBand(report) {
  if (report.thinFile || report.score === null) return { key: "sin-historial", label: "Sin historial" };
  if (report.score >= 800) return { key: "excelente", label: "Excelente" };
  if (report.score >= 700) return { key: "bueno", label: "Bueno" };
  if (report.score >= 600) return { key: "regular", label: "Regular" };
  return { key: "bajo", label: "Bajo" };
}

// Política de crédito por perfil (ejemplo para el prototipo). Ninguna tasa supera el techo legal.
const POLICIES = {
  excelente: { lender: "Banco Aliado A (ejemplo)", annualRate: 0.1350, downPct: 0.20 },
  bueno: { lender: "Banco Aliado B (ejemplo)", annualRate: 0.1490, downPct: 0.25 },
  regular: { lender: "Cooperativa Aliada (ejemplo)", annualRate: 0.1650, downPct: 0.30 },
  "sin-historial": { lender: "Cooperativa Aliada (ejemplo)", annualRate: MAX_RATE, downPct: 0.35 }
};

const monthlyRate = annualRate => Math.pow(1 + annualRate, 1 / 12) - 1;
export function payment(principal, annualRate, term) {
  if (principal <= 0) return 0;
  const r = monthlyRate(annualRate);
  return principal * r / (1 - Math.pow(1 + r, -term));
}
function principalFor(monthly, annualRate, term) {
  if (monthly <= 0) return 0;
  const r = monthlyRate(annualRate);
  return monthly * (1 - Math.pow(1 + r, -term)) / r;
}
const round = n => Math.round(n);
const round50 = n => Math.ceil(n / 50) * 50;

function buildOption(price, downPayment, policy, term, capacity, income, monthlyDebtPayment) {
  const financed = Math.max(0, price - downPayment);
  const monthly = payment(financed, policy.annualRate, term);
  return {
    term, monthly: round(monthly), downPayment: round(downPayment), downPaymentPct: price ? downPayment / price : 0,
    financed: round(financed), annualRate: policy.annualRate, lender: policy.lender,
    totalInterest: round(monthly * term - financed),
    ratio: income ? (monthly + monthlyDebtPayment) / income : 1,
    affordable: monthly <= capacity + 0.5
  };
}

// Decide con el reporte del buró y el ingreso declarado.
export function decideCredit({ report, income, price }) {
  income = Number(income); price = Number(price);
  const band = scoreBand(report);
  const capacity = Math.max(0, income * MAX_DEBT_RATIO - Number(report.monthlyDebtPayment || 0));
  const base = { band, capacity: round(capacity), income, price };
  const decline = (reason, message) => ({ ...base, status: "declined", title: "Por ahora no podemos precalificarte", reason, message, options: [], offer: null, maxPrice: null });
  if (report.maxDaysPastDue24m > 60) return decline("mora", "Tu historial muestra atrasos recientes en pagos. Un asesor puede ayudarte a revisar alternativas, y cuando regularices tus deudas puedes volver a intentarlo.");
  if (band.key === "bajo") return decline("score", "Tu perfil crediticio actual no cumple las condiciones de nuestras entidades aliadas. Un asesor puede ayudarte a revisar alternativas.");
  if (capacity < 100) return decline("capacidad", "Tus deudas actuales ya ocupan la mayor parte de tu capacidad de pago. Un asesor puede ayudarte a revisar alternativas.");
  const policy = POLICIES[band.key];
  const minDown = price * policy.downPct;
  const options = TERMS.map(term => buildOption(price, minDown, policy, term, capacity, income, report.monthlyDebtPayment));
  const affordable = options.filter(option => option.affordable);
  // Precio máximo de carro que alcanza con la entrada mínima del perfil, a 72 meses.
  const maxFinanced = principalFor(capacity, policy.annualRate, 72);
  const maxPrice = Math.floor(maxFinanced / (1 - policy.downPct) / 100) * 100;
  if (affordable.length) {
    const offer = affordable[0];
    if (band.key === "sin-historial") return { ...base, status: "review", title: "Un asesor revisará tu solicitud", message: "No encontramos historial crediticio a tu nombre. Es común si nunca has tenido un crédito. Con una entrada del 35% y algunos documentos de ingresos, un asesor puede ayudarte a obtener tu financiamiento.", options: affordable, offer, maxPrice };
    return { ...base, status: "preapproved", title: "¡Estás precalificado!", message: "Con tu perfil puedes financiar este carro con estas condiciones.", options: affordable, offer, maxPrice };
  }
  // No alcanza con la entrada mínima: ¿alcanza con más entrada (hasta 50%) a 72 meses?
  const neededDown = round50(price - principalFor(capacity, policy.annualRate, 72));
  if (neededDown <= price * MAX_DOWN_PCT) {
    const conditional = TERMS.map(term => buildOption(price, neededDown, policy, term, capacity, income, report.monthlyDebtPayment)).filter(option => option.affordable);
    return { ...base, status: "conditional", title: "Puedes financiarlo con una entrada mayor", message: `Para que la cuota se ajuste a tu capacidad de pago, necesitas una entrada de ${Math.round(neededDown / price * 100)}% o elegir un carro de hasta $${maxPrice.toLocaleString("en-US")}.`, options: conditional, offer: conditional[0], maxPrice };
  }
  return { ...base, status: "review", title: "Te recomendamos un carro dentro de tu presupuesto", message: `La cuota de este carro supera tu capacidad de pago. Con tu perfil puedes financiar un carro de hasta $${maxPrice.toLocaleString("en-US")}.`, options: [], offer: null, maxPrice };
}

export function validatePrequalInput(data = {}) {
  const cedula = String(data.cedula || "").replace(/\D/g, "");
  const income = Number(data.income);
  if (!isValidCedula(cedula)) return { error: "Ingresa una cédula ecuatoriana válida de 10 dígitos." };
  if (!(income >= 100 && income <= 100000)) return { error: "Ingresa tu ingreso mensual en dólares (entre 100 y 100.000)." };
  if (data.consent !== true) return { error: "Debes autorizar la consulta al buró de crédito para continuar." };
  return { cedula, income: Math.round(income), vehicleId: Number(data.vehicleId) };
}

export function publicReport(report) {
  return {
    score: report.score, band: scoreBand(report), activeDebts: report.activeDebts,
    monthlyDebtPayment: report.monthlyDebtPayment, maxDaysPastDue24m: report.maxDaysPastDue24m,
    recentInquiries: report.recentInquiries, thinFile: Boolean(report.thinFile), testProfile: report.testProfile || null
  };
}
