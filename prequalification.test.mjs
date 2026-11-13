import test from "node:test";
import assert from "node:assert/strict";
import {
  isValidCedula, bureauScore, buildOffer, maskCedula, createRecord, RESERVATION_DEPOSIT
} from "./prequalification.mjs";

const VALID = "1710034065"; // well-known valid Ecuadorian cedula (Pichincha)

test("isValidCedula accepts a valid checksum", () => {
  assert.equal(isValidCedula(VALID), true);
});
test("isValidCedula rejects bad length, letters, province, and checksum", () => {
  assert.equal(isValidCedula("171003406"), false);
  assert.equal(isValidCedula("17100340650"), false);
  assert.equal(isValidCedula("17100340a5"), false);
  assert.equal(isValidCedula("1710034066"), false);
  assert.equal(isValidCedula("9910034065"), false);
  assert.equal(isValidCedula(""), false);
  assert.equal(isValidCedula(null), false);
});

test("bureauScore is deterministic and bounded", () => {
  const a = bureauScore(VALID, 1500);
  assert.equal(a, bureauScore(VALID, 1500));
  assert.ok(a >= 300 && a <= 850);
});
test("bureauScore rises with income for the same cedula", () => {
  assert.ok(bureauScore(VALID, 4000) >= bureauScore(VALID, 600));
});

test("good score lowers down payment to 20%, otherwise 25%", () => {
  const good = buildOffer({ price: 20000, income: 3000, score: 760 });
  const regular = buildOffer({ price: 20000, income: 3000, score: 600 });
  assert.equal(good.downPaymentPct, 0.2);
  assert.equal(good.downPayment, 4000);
  assert.equal(regular.downPaymentPct, 0.25);
  assert.equal(regular.downPayment, 5000);
});
test("better score gets a lower rate", () => {
  const good = buildOffer({ price: 20000, income: 3000, score: 760 });
  const regular = buildOffer({ price: 20000, income: 3000, score: 600 });
  assert.ok(good.annualRate < regular.annualRate);
});
test("term is clamped to 36-72 and selectable", () => {
  assert.equal(buildOffer({ price: 20000, income: 3000, score: 700, term: 48 }).term, 48);
  assert.equal(buildOffer({ price: 20000, income: 3000, score: 700, term: 12 }).term, 36);
  assert.equal(buildOffer({ price: 20000, income: 3000, score: 700, term: 99 }).term, 72);
});
test("longer term lowers the monthly payment", () => {
  const short = buildOffer({ price: 20000, income: 3000, score: 700, term: 36 });
  const long = buildOffer({ price: 20000, income: 3000, score: 700, term: 72 });
  assert.ok(long.monthly < short.monthly);
});
test("affordability uses payment-to-income ratio (35% cap)", () => {
  const ok = buildOffer({ price: 15000, income: 4000, score: 700, term: 60 });
  assert.equal(ok.affordable, true);
  assert.ok(ok.ratio <= 0.35);
  const bad = buildOffer({ price: 60000, income: 800, score: 700, term: 60 });
  assert.equal(bad.affordable, false);
  assert.ok(bad.ratio > 0.35);
});
test("default term is the shortest affordable one, else 72", () => {
  const easy = buildOffer({ price: 12000, income: 6000, score: 700 });
  assert.equal(easy.term, 36);
  const hard = buildOffer({ price: 60000, income: 800, score: 700 });
  assert.equal(hard.term, 72);
});
test("offer is always labelled simulated and includes a lender", () => {
  const o = buildOffer({ price: 20000, income: 3000, score: 700 });
  assert.equal(o.simulated, true);
  assert.ok(o.lender.length > 0);
});

test("maskCedula hides the middle digits", () => {
  assert.equal(maskCedula(VALID), "171*****65");
});

test("createRecord requires consent and records its timestamp", () => {
  const now = new Date("2026-11-12T10:00:00Z");
  assert.throws(() => createRecord({ vehicleId: 1, price: 20000, cedula: VALID, income: 2000, consent: false, now }), /consent/i);
  assert.throws(() => createRecord({ vehicleId: 1, price: 20000, cedula: "123", income: 2000, consent: true, now }), /cedula/i);
  assert.throws(() => createRecord({ vehicleId: 1, price: 20000, cedula: VALID, income: 0, consent: true, now }), /income/i);
  const r = createRecord({ vehicleId: 7, price: 20000, cedula: VALID, income: 2000, consent: true, now });
  assert.equal(r.vehicleId, 7);
  assert.equal(r.consent.accepted, true);
  assert.equal(r.consent.at, "2026-11-12T10:00:00.000Z");
  assert.equal(r.cedulaMasked, "171*****65");
  assert.ok(!JSON.stringify(r).includes(VALID));
  assert.equal(r.offer.simulated, true);
  assert.equal(RESERVATION_DEPOSIT, 200);
});
