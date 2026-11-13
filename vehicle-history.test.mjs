import test from "node:test";
import assert from "node:assert/strict";
import { vehicleHistory, historySummary, formatVerifiedDate, SEAL_KEYS } from "./vehicle-history.mjs";

test("vehicleHistory returns the four seals in a fixed order", () => {
  const h = vehicleHistory(1);
  assert.deepEqual(h.seals.map(s => s.key), SEAL_KEYS);
  assert.equal(SEAL_KEYS.length, 4);
});
test("vehicleHistory is deterministic", () => {
  assert.deepEqual(vehicleHistory(7), vehicleHistory(7));
});
test("most vehicles are fully verified", () => {
  const ids = Array.from({ length: 12 }, (_, i) => i + 1);
  const full = ids.filter(id => historySummary(vehicleHistory(id)).verified === 4);
  assert.ok(full.length >= 9);
});
test("one or two seed vehicles show a pending item", () => {
  const ids = Array.from({ length: 12 }, (_, i) => i + 1);
  const pending = ids.filter(id => historySummary(vehicleHistory(id)).verified < 4);
  assert.ok(pending.length >= 1 && pending.length <= 2);
});
test("pending seals carry status 'pending' and a note", () => {
  const h = vehicleHistory(4);
  const fines = h.seals.find(s => s.key === "fines");
  assert.equal(fines.status, "pending");
  assert.ok(fines.note.length > 0);
  assert.deepEqual(historySummary(h), { verified: 3, total: 4, complete: false });
});
test("verified seals have a verifiedOn ISO date, pending ones do not need one", () => {
  for (const s of vehicleHistory(1).seals) {
    assert.equal(s.status, "verified");
    assert.match(s.verifiedOn, /^\d{4}-\d{2}-\d{2}$/);
  }
});
test("historySummary handles a complete history", () => {
  assert.deepEqual(historySummary(vehicleHistory(1)), { verified: 4, total: 4, complete: true });
});
test("invalid ids do not throw", () => {
  assert.equal(vehicleHistory(undefined).seals.length, 4);
  assert.equal(vehicleHistory("abc").seals.length, 4);
});
test("formatVerifiedDate renders Spanish dates", () => {
  assert.equal(formatVerifiedDate("2026-10-05"), "5 de octubre de 2026");
  assert.equal(formatVerifiedDate("bad"), "");
});
