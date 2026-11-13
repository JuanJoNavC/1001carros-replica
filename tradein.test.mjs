import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateTradeIn, createOffer, isOfferValid, tradeInDiscount, VALIDITY_DAYS
} from "./tradein.mjs";

const NOW = new Date("2026-11-12T10:00:00Z");
const BASE = { brand: "Toyota", model: "Corolla", year: 2020, mileage: 60000, condition: "bueno" };

test("estimate returns a rounded range around the midpoint", () => {
  const e = estimateTradeIn(BASE, { now: NOW });
  assert.equal(e.ok, true);
  assert.equal(e.currency, "USD");
  assert.ok(e.low > 0 && e.high > e.low);
  assert.equal(e.low % 50, 0);
  assert.equal(e.high % 50, 0);
  const mid = (e.low + e.high) / 2;
  assert.ok((e.high - e.low) / mid < 0.12, "range roughly +-4%");
});
test("estimate is deterministic", () => {
  assert.deepEqual(estimateTradeIn(BASE, { now: NOW }), estimateTradeIn(BASE, { now: NOW }));
});
test("older and higher mileage lowers the estimate", () => {
  const base = estimateTradeIn(BASE, { now: NOW });
  assert.ok(estimateTradeIn({ ...BASE, year: 2014 }, { now: NOW }).high < base.high);
  assert.ok(estimateTradeIn({ ...BASE, mileage: 160000 }, { now: NOW }).high < base.high);
});
test("condition adjusts the estimate", () => {
  const at = condition => estimateTradeIn({ ...BASE, condition }, { now: NOW }).high;
  assert.ok(at("excelente") > at("bueno"));
  assert.ok(at("bueno") > at("regular"));
});
test("validUntil is VALIDITY_DAYS days ahead", () => {
  const e = estimateTradeIn(BASE, { now: NOW });
  assert.equal(VALIDITY_DAYS, 5);
  assert.equal(new Date(e.validUntil).getTime(), NOW.getTime() + 5 * 86400000);
});
test("catalog reference prices influence the estimate", () => {
  const cheap = [{ brand: "Toyota", model: "Corolla", year: 2020, mileage: 60000, price: 10000 }];
  const dear = [{ brand: "Toyota", model: "Corolla", year: 2020, mileage: 60000, price: 30000 }];
  const lo = estimateTradeIn(BASE, { now: NOW, reference: cheap });
  const hi = estimateTradeIn(BASE, { now: NOW, reference: dear });
  assert.ok(hi.high > lo.high);
  assert.ok(lo.high < 10000);
});
test("invalid inputs are rejected without NaN", () => {
  for (const bad of [null, {}, { ...BASE, year: 1900 }, { ...BASE, year: 2099 }, { ...BASE, year: "abc" },
    { ...BASE, mileage: -5 }, { ...BASE, mileage: "x" }, { ...BASE, brand: "  " }, { ...BASE, model: "" }]) {
    const e = estimateTradeIn(bad, { now: NOW });
    assert.equal(e.ok, false);
    assert.ok(Array.isArray(e.errors) && e.errors.length > 0);
    assert.equal("low" in e, false);
  }
});
test("unknown condition falls back to bueno; string numbers are accepted", () => {
  const a = estimateTradeIn({ ...BASE, condition: "???", year: "2020", mileage: "60000" }, { now: NOW });
  assert.deepEqual(a, estimateTradeIn(BASE, { now: NOW }));
});
test("very old/high-mileage cars keep a positive floor", () => {
  const e = estimateTradeIn({ ...BASE, year: 1992, mileage: 900000, condition: "regular" }, { now: NOW });
  assert.equal(e.ok, true);
  assert.ok(e.low >= 500);
  assert.ok(Number.isFinite(e.high));
});

test("createOffer stores vehicle, range, expiry and tradeIn flag", () => {
  const o = createOffer({ ...BASE, tradeIn: true, plate: "ABC1234" }, { now: NOW });
  assert.equal(o.tradeIn, true);
  assert.equal(o.vehicle.brand, "Toyota");
  assert.equal(o.vehicle.plate, "ABC1234");
  assert.ok(o.low > 0 && o.validUntil && o.createdAt);
  assert.equal(createOffer({}, { now: NOW }), null);
});
test("isOfferValid respects expiry and bad input", () => {
  const o = createOffer(BASE, { now: NOW });
  assert.equal(isOfferValid(o, new Date(NOW.getTime() + 4 * 86400000)), true);
  assert.equal(isOfferValid(o, new Date(NOW.getTime() + 6 * 86400000)), false);
  assert.equal(isOfferValid(null, NOW), false);
  assert.equal(isOfferValid({ validUntil: "garbage" }, NOW), false);
});
test("tradeInDiscount uses the LOW end and only for valid trade-in offers", () => {
  const o = createOffer({ ...BASE, tradeIn: true }, { now: NOW });
  const d = tradeInDiscount(o, 20000, NOW);
  assert.equal(d.credit, o.low);
  assert.equal(d.difference, 20000 - o.low);
  assert.equal(tradeInDiscount(createOffer(BASE, { now: NOW }), 20000, NOW), null, "not a trade-in");
  assert.equal(tradeInDiscount(o, 20000, new Date(NOW.getTime() + 9 * 86400000)), null, "expired");
  assert.equal(tradeInDiscount(null, 20000, NOW), null);
  assert.equal(tradeInDiscount(o, NaN, NOW), null);
  assert.equal(tradeInDiscount(o, o.low - 1000, NOW).difference, 0, "never negative");
});
