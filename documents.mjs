// Pure logic for phase 3 of financing: documents, identity check and e-signature (SIMULATED beta).
// Nothing is uploaded: only file metadata (name/size/type) is kept, never file contents.
// Ecuador notes: biometric validation and e-signature acceptance must be confirmed with each lender,
// and personal data handling requires explicit consent. The demo signature is not legally binding.
export const DOCS_KEY = "1001-docs";
export const STEPS = ["planilla", "rol", "identidad", "firma"];
export const STEP_LABELS = {
  planilla: "Planilla de servicios básicos",
  rol: "Rol de pagos",
  identidad: "Validación de identidad",
  firma: "Firma del contrato"
};
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const ACCEPTED_TYPES = ["image/jpeg", "image/png", "application/pdf"];
const DOC_STEPS = ["planilla", "rol"];

export const emptyState = () => ({ docs: {}, identity: null, signature: null });

export function validateFile(file) {
  if (!file || typeof file !== "object") return { ok: false, error: "Selecciona un archivo." };
  if (!ACCEPTED_TYPES.includes(file.type)) return { ok: false, error: "Formato no admitido. Sube una imagen JPG, PNG o PDF." };
  if (!(Number(file.size) > 0)) return { ok: false, error: "El archivo está vacío. Intenta con otra foto." };
  if (Number(file.size) > MAX_FILE_BYTES) return { ok: false, error: "El archivo supera el máximo de 5 MB. Reduce su tamaño e inténtalo de nuevo." };
  return { ok: true };
}

const meta = (file, now) => ({ name: String(file.name ?? ""), size: Number(file.size), type: file.type, uploadedAt: now.toISOString() });
const fail = (state, error) => ({ ok: false, state, error });
const docsDone = state => DOC_STEPS.every(id => state.docs[id]);

export function attachDocument(state, step, file, now = new Date()) {
  if (!DOC_STEPS.includes(step)) return fail(state, "Documento no reconocido.");
  if (state.signature) return fail(state, "El contrato ya fue firmado.");
  const check = validateFile(file);
  if (!check.ok) return fail(state, check.error);
  return { ok: true, state: { ...state, docs: { ...state.docs, [step]: meta(file, now) } } };
}

export function removeDocument(state, step) {
  if (state.signature) return fail(state, "El contrato ya fue firmado.");
  const { [step]: _removed, ...docs } = state.docs;
  return { ok: true, state: { ...state, docs, identity: null } };
}

// `selfie` is optional metadata (a button-only liveness simulation passes null).
export function completeIdentity(state, selfie, now = new Date()) {
  if (state.signature) return fail(state, "El contrato ya fue firmado.");
  if (!docsDone(state)) return fail(state, "Primero sube tu planilla y tu rol de pagos.");
  const identity = { simulated: true, completedAt: now.toISOString() };
  if (selfie) {
    const check = validateFile(selfie);
    if (!check.ok) return fail(state, check.error);
    identity.selfie = { name: String(selfie.name ?? ""), size: Number(selfie.size), type: selfie.type };
  }
  return { ok: true, state: { ...state, identity } };
}

export function signContract(state, { fullName, consent, contractId: id, summary }, now = new Date()) {
  if (state.signature) return fail(state, "El contrato ya fue firmado.");
  if (!state.identity) return fail(state, "Primero completa la validación de identidad.");
  if (consent !== true) return fail(state, "Debes aceptar el contrato y el tratamiento de tus datos para firmar.");
  const name = String(fullName ?? "").trim().replace(/\s+/g, " ");
  if (name.split(" ").filter(Boolean).length < 2) return fail(state, "Escribe tu nombre y apellido completos para firmar.");
  const signedAt = now.toISOString();
  return { ok: true, state: { ...state, signature: { fullName: name, consent: { accepted: true, at: signedAt }, signedAt, contractId: id, ...(summary ? { summary } : {}) } } };
}

const isDone = (state, id) => id === "identidad" ? Boolean(state.identity) : id === "firma" ? Boolean(state.signature) : Boolean(state.docs[id]);

// status: done | current (next actionable) | pending (actionable, not the first) | locked (gated)
export function stepStatuses(state) {
  let currentAssigned = false;
  return STEPS.map(id => {
    const label = STEP_LABELS[id];
    if (isDone(state, id)) return { id, label, status: "done" };
    const unlocked = id === "identidad" ? docsDone(state) : id === "firma" ? Boolean(state.identity) : true;
    if (!unlocked) return { id, label, status: "locked" };
    if (!currentAssigned) { currentAssigned = true; return { id, label, status: "current" }; }
    return { id, label, status: "pending" };
  });
}

export const progressPercent = state => Math.round((STEPS.filter(id => isDone(state, id)).length / STEPS.length) * 100);

export const serializeDocs = state => JSON.stringify(state);

export function parseDocs(raw) {
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.docs !== "object" || data.docs === null) return emptyState();
    return { docs: data.docs, identity: data.identity ?? null, signature: data.signature ?? null };
  } catch {
    return emptyState();
  }
}

// Builds the contract summary from the `1001-prequal` store ({ records }); null without a prequalification.
export function buildContractSummary(store, { vehicleId, vehicleName } = {}) {
  const records = Object.values(store?.records || {}).filter(record => record?.offer);
  if (!records.length) return null;
  const record = vehicleId !== undefined
    ? records.find(item => Number(item.vehicleId) === Number(vehicleId))
    : [...records].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  if (!record) return null;
  const o = record.offer;
  return {
    vehicleId: Number(record.vehicleId),
    vehicleName: vehicleName || `Vehículo ${record.vehicleId}`,
    price: o.price ?? record.price,
    downPayment: o.downPayment,
    monthly: o.monthly,
    term: o.term,
    lender: o.lender,
    createdAt: record.createdAt
  };
}

// Deterministic id (FNV-1a over the contract terms), e.g. CT-1A2B3C4D.
export function contractId(summary) {
  const text = [summary.vehicleId, summary.price, summary.downPayment, summary.monthly, summary.term, summary.lender, summary.createdAt].join("|");
  let hash = 0x811c9dc5;
  for (const char of text) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return `CT-${hash.toString(36).toUpperCase().padStart(8, "0").slice(-8)}`;
}
