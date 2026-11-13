import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyAlerts, normalizeAlerts, watchPrice, unwatchPrice, isWatching, addSearch, removeSearch,
  evaluateAlerts, createReservation, addReservation, normalizeReservations, CHANNELS
} from "./account.mjs";

const NOW = new Date("2026-11-12T10:00:00Z");
const CAR = { id: 7, brand: "Toyota", model: "Corolla Cross", year: 2021, price: 20000, image: "x.jpg" };
const CATALOG = [
  CAR,
  { id: 8, brand: "Kia", model: "Sportage", year: 2022, price: 25000 },
  { id: 9, brand: "Toyota", model: "Yaris", year: 2020, price: 12000 }
];

test("emptyAlerts has no watches and no searches", () => {
  assert.deepEqual(emptyAlerts(), { watches: [], searches: [] });
});
test("normalizeAlerts tolerates garbage and drops invalid entries", () => {
  assert.deepEqual(normalizeAlerts(null), emptyAlerts());
  assert.deepEqual(normalizeAlerts("x"), emptyAlerts());
  const out = normalizeAlerts({
    watches: [{ vehicleId: 1, price: 100, channel: "correo", createdAt: "2026-01-01" }, { vehicleId: "a" }, null],
    searches: [{ id: "s1", brand: "Kia", channel: "fax" }, { id: "s2" }]
  });
  assert.equal(out.watches.length, 1);
  assert.equal(out.searches.length, 1);
  assert.equal(out.searches[0].channel, "correo", "unknown channel falls back to correo");
});
test("watchPrice stores the price at activation time and is immutable", () => {
  const base = emptyAlerts();
  const next = watchPrice(base, CAR, { channel: "whatsapp", now: NOW });
  assert.deepEqual(base, emptyAlerts());
  assert.deepEqual(next.watches[0], { vehicleId: 7, price: 20000, channel: "whatsapp", createdAt: NOW.toISOString() });
  assert.equal(isWatching(next, 7), true);
  assert.equal(isWatching(next, 8), false);
});
test("watchPrice replaces an existing watch for the same car and defaults the channel", () => {
  let a = watchPrice(emptyAlerts(), CAR, { now: NOW });
  assert.equal(a.watches[0].channel, "correo");
  a = watchPrice(a, { ...CAR, price: 18000 }, { channel: "whatsapp", now: NOW });
  assert.equal(a.watches.length, 1);
  assert.equal(a.watches[0].price, 18000);
});
test("unwatchPrice removes the watch", () => {
  const a = unwatchPrice(watchPrice(emptyAlerts(), CAR, { now: NOW }), 7);
  assert.equal(a.watches.length, 0);
});
test("addSearch requires a brand, accepts optional model and max price", () => {
  assert.equal(addSearch(emptyAlerts(), { brand: " " }, { now: NOW }).ok, false);
  assert.deepEqual(addSearch(emptyAlerts(), { brand: "" }, { now: NOW }).errors, ["brand"]);
  assert.deepEqual(addSearch(emptyAlerts(), { brand: "Kia", maxPrice: "abc" }, { now: NOW }).errors, ["maxPrice"]);
  const r = addSearch(emptyAlerts(), { brand: "Toyota", model: "Yaris", maxPrice: "15000", channel: "whatsapp" }, { now: NOW });
  assert.equal(r.ok, true);
  const s = r.alerts.searches[0];
  assert.equal(s.brand, "Toyota");
  assert.equal(s.model, "Yaris");
  assert.equal(s.maxPrice, 15000);
  assert.equal(s.channel, "whatsapp");
  assert.ok(s.id);
  const empty = addSearch(emptyAlerts(), { brand: "Kia" }, { now: NOW }).alerts.searches[0];
  assert.equal(empty.maxPrice, null);
  assert.equal(empty.model, "");
});
test("addSearch does not duplicate an identical search", () => {
  const input = { brand: "Kia", model: "", maxPrice: "" };
  const once = addSearch(emptyAlerts(), input, { now: NOW }).alerts;
  const twice = addSearch(once, { ...input, brand: "kia" }, { now: NOW }).alerts;
  assert.equal(twice.searches.length, 1);
});
test("removeSearch removes by id", () => {
  const a = addSearch(emptyAlerts(), { brand: "Kia" }, { now: NOW }).alerts;
  assert.equal(removeSearch(a, a.searches[0].id).searches.length, 0);
});
test("evaluateAlerts: price drop below the stored price triggers", () => {
  const alerts = watchPrice(emptyAlerts(), CAR, { now: NOW });
  const same = evaluateAlerts(alerts, CATALOG);
  assert.equal(same.length, 0, "unchanged price does not trigger");
  const dropped = CATALOG.map(c => (c.id === 7 ? { ...c, price: 18500 } : c));
  const hits = evaluateAlerts(alerts, dropped);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].type, "price-drop");
  assert.equal(hits[0].vehicleId, 7);
  assert.equal(hits[0].oldPrice, 20000);
  assert.equal(hits[0].newPrice, 18500);
  assert.equal(hits[0].drop, 1500);
  assert.equal(hits[0].channel, "correo");
});
test("evaluateAlerts: higher price or missing car does not trigger", () => {
  const alerts = watchPrice(emptyAlerts(), CAR, { now: NOW });
  assert.equal(evaluateAlerts(alerts, CATALOG.map(c => (c.id === 7 ? { ...c, price: 21000 } : c))).length, 0);
  assert.equal(evaluateAlerts(alerts, CATALOG.filter(c => c.id !== 7)).length, 0);
});
test("evaluateAlerts: saved search matches brand, model and max price (case/accent-insensitive)", () => {
  let a = addSearch(emptyAlerts(), { brand: "toyota" }, { now: NOW }).alerts;
  assert.deepEqual(evaluateAlerts(a, CATALOG).map(h => h.vehicleId).sort(), [7, 9]);
  a = addSearch(emptyAlerts(), { brand: "Toyota", model: "yaris" }, { now: NOW }).alerts;
  assert.deepEqual(evaluateAlerts(a, CATALOG).map(h => h.vehicleId), [9]);
  a = addSearch(emptyAlerts(), { brand: "Toyota", maxPrice: "15000" }, { now: NOW }).alerts;
  assert.deepEqual(evaluateAlerts(a, CATALOG).map(h => h.vehicleId), [9]);
  a = addSearch(emptyAlerts(), { brand: "Honda" }, { now: NOW }).alerts;
  assert.equal(evaluateAlerts(a, CATALOG).length, 0);
  a = addSearch(emptyAlerts(), { brand: "Kia", model: "sportagé" }, { now: NOW }).alerts;
  assert.equal(evaluateAlerts(a, CATALOG).length, 1);
});
test("evaluateAlerts: hit shape and tolerance of bad input", () => {
  const a = addSearch(emptyAlerts(), { brand: "Kia", channel: "whatsapp" }, { now: NOW }).alerts;
  const [hit] = evaluateAlerts(a, CATALOG);
  assert.equal(hit.type, "search-match");
  assert.equal(hit.searchId, a.searches[0].id);
  assert.equal(hit.car.id, 8);
  assert.equal(hit.channel, "whatsapp");
  assert.deepEqual(evaluateAlerts(null, CATALOG), []);
  assert.deepEqual(evaluateAlerts(a, null), []);
});
test("CHANNELS lists correo and whatsapp", () => {
  assert.deepEqual([...CHANNELS], ["correo", "whatsapp"]);
});
test("createReservation builds a small record", () => {
  const r = createReservation({ car: CAR, agency: { id: 3, name: "Cumbayá", city: "Quito" }, deposit: 200, prequalified: true, now: NOW });
  assert.equal(r.vehicleId, 7);
  assert.equal(r.vehicle.brand, "Toyota");
  assert.equal(r.vehicle.price, 20000);
  assert.deepEqual(r.agency, { id: 3, name: "Cumbayá", city: "Quito" });
  assert.equal(r.deposit, 200);
  assert.equal(r.prequalified, true);
  assert.equal(r.createdAt, NOW.toISOString());
  assert.equal(createReservation({ car: CAR, now: NOW }).agency, null);
});
test("addReservation keeps newest first and one per vehicle", () => {
  const first = createReservation({ car: CAR, deposit: 500, now: NOW });
  const other = createReservation({ car: CATALOG[1], deposit: 500, now: NOW });
  let list = addReservation(addReservation([], first), other);
  assert.deepEqual(list.map(r => r.vehicleId), [8, 7]);
  list = addReservation(list, createReservation({ car: CAR, deposit: 200, now: NOW }));
  assert.deepEqual(list.map(r => r.vehicleId), [7, 8]);
  assert.equal(list[0].deposit, 200);
});
test("normalizeReservations drops invalid entries", () => {
  assert.deepEqual(normalizeReservations(null), []);
  assert.deepEqual(normalizeReservations({}), []);
  const ok = createReservation({ car: CAR, now: NOW });
  assert.equal(normalizeReservations([ok, { vehicleId: "x" }, null]).length, 1);
});
