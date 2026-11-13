import test from "node:test";
import assert from "node:assert/strict";
import {
  STEPS, MAX_FILE_BYTES, DOCS_KEY, emptyState, validateFile, attachDocument, removeDocument,
  completeIdentity, signContract, stepStatuses, progressPercent, serializeDocs, parseDocs,
  buildContractSummary, contractId
} from "./documents.mjs";

const NOW = new Date("2026-11-12T10:00:00Z");
const JPG = { name: "planilla.jpg", size: 200000, type: "image/jpeg" };
const PDF = { name: "rol.pdf", size: 900000, type: "application/pdf" };
const SELFIE = { name: "selfie.png", size: 100000, type: "image/png" };
const STORE = {
  records: {
    7: { vehicleId: 7, price: 20000, createdAt: "2026-11-10T10:00:00Z", offer: { price: 20000, downPayment: 4000, monthly: 350, term: 60, lender: "Banco Aliado (ejemplo)" } },
    9: { vehicleId: 9, price: 30000, createdAt: "2026-11-11T10:00:00Z", offer: { price: 30000, downPayment: 6000, monthly: 520, term: 48, lender: "Financiera Andina (ejemplo)" } }
  }
};
const ready = () => {
  let s = emptyState();
  s = attachDocument(s, "planilla", JPG, NOW).state;
  s = attachDocument(s, "rol", PDF, NOW).state;
  return completeIdentity(s, SELFIE, NOW).state;
};

test("steps and storage key", () => {
  assert.deepEqual(STEPS, ["planilla", "rol", "identidad", "firma"]);
  assert.equal(DOCS_KEY, "1001-docs");
});
test("validateFile accepts jpg/png/pdf under 5 MB", () => {
  for (const type of ["image/jpeg", "image/png", "application/pdf"]) assert.equal(validateFile({ name: "a", size: 10, type }).ok, true);
});
test("validateFile rejects wrong type, empty and oversize with Spanish messages", () => {
  const bad = validateFile({ name: "a.gif", size: 10, type: "image/gif" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /JPG, PNG o PDF/);
  const big = validateFile({ name: "a.jpg", size: MAX_FILE_BYTES + 1, type: "image/jpeg" });
  assert.match(big.error, /5 MB/);
  assert.equal(validateFile({ name: "a.jpg", size: MAX_FILE_BYTES, type: "image/jpeg" }).ok, true);
  assert.equal(validateFile({ name: "a.jpg", size: 0, type: "image/jpeg" }).ok, false);
  assert.equal(validateFile(null).ok, false);
});
test("attachDocument stores metadata only and returns errors without changing state", () => {
  const s0 = emptyState();
  const r = attachDocument(s0, "planilla", { ...JPG, content: "SECRET", url: "blob:x" }, NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.state.docs.planilla).sort(), ["name", "size", "type", "uploadedAt"]);
  const bad = attachDocument(s0, "planilla", { name: "x.gif", size: 1, type: "image/gif" }, NOW);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.state, s0);
  assert.equal(attachDocument(s0, "firma", JPG, NOW).ok, false);
});
test("identity is gated by both documents", () => {
  let s = attachDocument(emptyState(), "planilla", JPG, NOW).state;
  const r = completeIdentity(s, SELFIE, NOW);
  assert.equal(r.ok, false);
  assert.match(r.error, /planilla|rol/i);
  assert.equal(stepStatuses(s).find(x => x.id === "identidad").status, "locked");
});
test("signature is gated by identity, consent and a full name", () => {
  let s = attachDocument(attachDocument(emptyState(), "planilla", JPG, NOW).state, "rol", PDF, NOW).state;
  assert.equal(signContract(s, { fullName: "Ana Perez", consent: true, contractId: "CT-1" }, NOW).ok, false);
  s = completeIdentity(s, SELFIE, NOW).state;
  assert.equal(signContract(s, { fullName: "Ana Perez", consent: false, contractId: "CT-1" }, NOW).ok, false);
  assert.equal(signContract(s, { fullName: "Ana", consent: true, contractId: "CT-1" }, NOW).ok, false);
  const ok = signContract(s, { fullName: "  Ana  Perez ", consent: true, contractId: "CT-1" }, NOW);
  assert.equal(ok.ok, true);
  assert.equal(ok.state.signature.fullName, "Ana Perez");
  assert.equal(ok.state.signature.signedAt, NOW.toISOString());
  assert.equal(ok.state.signature.contractId, "CT-1");
});
test("signContract keeps a contract summary snapshot when provided", () => {
  const summary = { vehicleId: 7, monthly: 350 };
  const r = signContract(ready(), { fullName: "Ana Perez", consent: true, contractId: "CT-1", summary }, NOW);
  assert.deepEqual(r.state.signature.summary, summary);
  assert.deepEqual(parseDocs(serializeDocs(r.state)), r.state);
});
test("signed state is locked", () => {
  const s = signContract(ready(), { fullName: "Ana Perez", consent: true, contractId: "CT-1" }, NOW).state;
  assert.equal(attachDocument(s, "planilla", JPG, NOW).ok, false);
  assert.equal(removeDocument(s, "planilla").ok, false);
});
test("removing a document resets identity and signature dependents", () => {
  const s = removeDocument(ready(), "rol").state;
  assert.equal(s.docs.rol, undefined);
  assert.equal(s.identity, null);
});
test("stepStatuses and progressPercent", () => {
  assert.equal(progressPercent(emptyState()), 0);
  let s = attachDocument(emptyState(), "planilla", JPG, NOW).state;
  assert.equal(progressPercent(s), 25);
  assert.deepEqual(stepStatuses(s).map(x => x.status), ["done", "current", "locked", "locked"]);
  s = ready();
  assert.equal(progressPercent(s), 75);
  assert.deepEqual(stepStatuses(s).map(x => x.status), ["done", "done", "done", "current"]);
  s = signContract(s, { fullName: "Ana Perez", consent: true, contractId: "CT-1" }, NOW).state;
  assert.equal(progressPercent(s), 100);
  assert.ok(stepStatuses(s).every(x => x.status === "done"));
});
test("serialize round trip and corrupt input", () => {
  const s = ready();
  assert.deepEqual(parseDocs(serializeDocs(s)), s);
  for (const raw of [null, "", "{bad", "[]", '{"docs":5}']) assert.deepEqual(parseDocs(raw), emptyState());
});
test("buildContractSummary uses the requested or latest prequalification", () => {
  assert.equal(buildContractSummary({}), null);
  assert.equal(buildContractSummary(null), null);
  const latest = buildContractSummary(STORE, { vehicleName: "Kia Rio" });
  assert.equal(latest.vehicleId, 9);
  assert.equal(latest.monthly, 520);
  assert.equal(latest.downPayment, 6000);
  assert.equal(latest.term, 48);
  assert.equal(latest.lender, "Financiera Andina (ejemplo)");
  assert.equal(latest.vehicleName, "Kia Rio");
  assert.equal(buildContractSummary(STORE, { vehicleId: 7 }).vehicleId, 7);
});
test("contractId is deterministic and varies with terms", () => {
  const a = buildContractSummary(STORE, { vehicleId: 7 }), b = buildContractSummary(STORE, { vehicleId: 9 });
  assert.match(contractId(a), /^CT-[A-Z0-9]{8}$/);
  assert.equal(contractId(a), contractId({ ...a }));
  assert.notEqual(contractId(a), contractId(b));
});
