// Pure prequalification logic (simulated: no real credit bureau or lender is queried).
export const RESERVATION_DEPOSIT = 200;
export const TERMS = [36, 48, 60, 72];
export const GOOD_SCORE = 700;
export const MAX_PAYMENT_RATIO = 0.35;

const LENDERS = [
  { min: 760, name: "Financiera Andina (ejemplo)", annualRate: 0.105 },
  { min: GOOD_SCORE, name: "Banco Aliado (ejemplo)", annualRate: 0.119 },
  { min: 600, name: "Cooperativa Horizonte (ejemplo)", annualRate: 0.138 },
  { min: 0, name: "Crédito Directo Sierra (ejemplo)", annualRate: 0.165 }
];

export function isValidCedula(value) {
  if (typeof value !== "string" || !/^\d{10}$/.test(value)) return false;
  const province = Number(value.slice(0, 2));
  if (!((province >= 1 && province <= 24) || province === 30)) return false;
  if (Number(value[2]) > 5) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let product = Number(value[i]) * (i % 2 === 0 ? 2 : 1);
    if (product > 9) product -= 9;
    sum += product;
  }
  return (10 - (sum % 10)) % 10 === Number(value[9]);
}

export function maskCedula(cedula) {
  return `${cedula.slice(0, 3)}*****${cedula.slice(8)}`;
}

// Deterministic simulated bureau score in [300, 850] derived from cedula and income.
export function bureauScore(cedula, income) {
  let hash = 0;
  for (const digit of String(cedula)) hash = (hash * 31 + Number(digit) + 7) % 100003;
  const base = 480 + (hash % 220);
  const incomeBonus = Math.min(150, Math.floor(Number(income) / 30));
  return Math.max(300, Math.min(850, base + incomeBonus));
}

function lenderFor(score) {
  return LENDERS.find(lender => score >= lender.min);
}

function monthlyPayment(principal, annualRate, term) {
  const r = annualRate / 12;
  return Math.round((principal * r) / (1 - Math.pow(1 + r, -term)));
}

function clampTerm(term) {
  return Math.min(72, Math.max(36, Math.round(Number(term) / 12) * 12));
}

function evaluate({ price, income, score, term }) {
  const lender = lenderFor(score);
  const downPaymentPct = score >= GOOD_SCORE ? 0.2 : 0.25;
  const downPayment = Math.round(price * downPaymentPct);
  const financed = price - downPayment;
  const monthly = monthlyPayment(financed, lender.annualRate, term);
  const ratio = monthly / income;
  return {
    simulated: true,
    score,
    price,
    income,
    lender: lender.name,
    annualRate: lender.annualRate,
    downPaymentPct,
    downPayment,
    financed,
    term,
    monthly,
    ratio,
    affordable: ratio <= MAX_PAYMENT_RATIO
  };
}

// When `term` is omitted, picks the shortest affordable term (or 72 if none is).
export function buildOffer({ price, income, score, term }) {
  if (term !== undefined) return evaluate({ price, income, score, term: clampTerm(term) });
  const options = TERMS.map(t => evaluate({ price, income, score, term: t }));
  return options.find(option => option.affordable) || options[options.length - 1];
}

export function createRecord({ vehicleId, price, cedula, income, consent, term, now = new Date() }) {
  if (consent !== true) throw new Error("Credit bureau consent is required");
  if (!isValidCedula(cedula)) throw new Error("Invalid cedula");
  const monthlyIncome = Number(income);
  if (!(monthlyIncome > 0)) throw new Error("Monthly income must be greater than zero");
  const score = bureauScore(cedula, monthlyIncome);
  return {
    vehicleId,
    cedulaMasked: maskCedula(cedula),
    income: monthlyIncome,
    consent: { accepted: true, at: now.toISOString() },
    offer: buildOffer({ price, income: monthlyIncome, score, term }),
    createdAt: now.toISOString()
  };
}
