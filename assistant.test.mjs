import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeText, answer, buildConversationRecord, buildHandoffUrl, WHATSAPP_NUMBER, ORIGIN_CODE
} from "./assistant.mjs";

const NOW = new Date("2026-11-12T10:00:00Z"); // Thursday
const vehicles = [
  { id: 1, code: "U-1", brand: "Toyota", model: "Corolla", year: 2020, price: 17900, mileage: 40000 },
  { id: 2, code: "U-2", brand: "Toyota", model: "Hilux", year: 2021, price: 31900, mileage: 30000 },
  { id: 3, code: "U-3", brand: "Kia", model: "Sportage", year: 2019, price: 19900, mileage: 52000 }
];
const agencies = [
  { id: 1, name: "Cumbayá", city: "Quito", hours: "Lun–Sáb 09:00–18:00" },
  { id: 2, name: "Guayaquil Norte", city: "Guayaquil", hours: "Lun–Sáb 09:00–18:00" }
];
const ctx = (extra = {}) => ({ vehicles, agencies, now: NOW, ...extra });

test("normalizeText strips accents, case and punctuation", () => {
  assert.equal(normalizeText("  ¿Garantía?? "), "garantia");
});
test("warranty intent reuses the existing program copy", () => {
  const r = answer("¿Qué garantía tienen?", ctx());
  assert.equal(r.intent, "garantia");
  assert.match(r.text, /7 días o 300 km/);
});
test("credit requirements mention cedula, income, bureau consent, down payment and Precalifícate", () => {
  const r = answer("requisitos para el credito", ctx());
  assert.equal(r.intent, "credito");
  assert.match(r.text, /cédula/i);
  assert.match(r.text, /ingreso/i);
  assert.match(r.text, /buró/i);
  assert.match(r.text, /20%/);
  assert.match(r.text, /25%/);
  assert.ok(r.links.some(l => l.href === "/financiamiento"));
});
test("hours come from agency data when present", () => {
  const r = answer("a que hora abren?", ctx());
  assert.equal(r.intent, "horarios");
  assert.match(r.text, /09:00–18:00/);
});
test("hours without agency data do not invent a schedule", () => {
  const r = answer("horario de atencion", ctx({ agencies: [] }));
  assert.equal(r.intent, "horarios");
  assert.doesNotMatch(r.text, /\d\d:\d\d/);
  assert.ok(r.links.some(l => l.href === "/agencias"));
});
test("availability filters by brand and max price", () => {
  const r = answer("tienen toyota hasta 20 mil", ctx());
  assert.equal(r.intent, "disponibilidad");
  assert.deepEqual(r.cars.map(c => c.id), [1]);
  assert.equal(r.cars[0].href, "/vehiculo/1");
});
test("availability with no match says so and links the catalog", () => {
  const r = answer("hay mazda?", ctx());
  assert.equal(r.intent, "disponibilidad");
  assert.equal(r.cars.length, 0);
  assert.ok(r.links.some(l => l.href === "/catalogo"));
});
test("accent-insensitive model matching", () => {
  assert.deepEqual(answer("busco una SPORTAGE", ctx()).cars.map(c => c.id), [3]);
});
test("test drive flow collects car, agency and date/time then links /reservar", () => {
  let r = answer("quiero agendar un test drive", ctx());
  assert.equal(r.intent, "test-drive");
  assert.equal(r.flow.step, "car");
  r = answer("el corolla", ctx({ flow: r.flow }));
  assert.equal(r.flow.step, "agency");
  assert.equal(r.flow.carId, 1);
  r = answer("cumbaya", ctx({ flow: r.flow }));
  assert.equal(r.flow.step, "datetime");
  r = answer("mañana a las 15:00", ctx({ flow: r.flow }));
  assert.equal(r.flow, null);
  assert.equal(r.intent, "test-drive");
  assert.match(r.text, /2026-11-13/);
  assert.match(r.text, /15:00/);
  assert.ok(r.links.some(l => l.href === "/reservar/1"));
});
test("test drive on a vehicle page skips the car step", () => {
  const r = answer("agendar prueba de manejo", ctx({ currentVehicleId: 3 }));
  assert.equal(r.flow.step, "agency");
  assert.equal(r.flow.carId, 3);
});
test("datetime step asks again when time is missing; cancel exits the flow", () => {
  let r = answer("mañana", ctx({ flow: { step: "datetime", carId: 1, agencyId: 1 } }));
  assert.equal(r.flow.step, "datetime");
  r = answer("cancelar", ctx({ flow: r.flow }));
  assert.equal(r.flow, null);
});
test("past dates are rejected", () => {
  const r = answer("10/11 a las 10:00", ctx({ flow: { step: "datetime", carId: 1, agencyId: 1 } }));
  assert.equal(r.flow.step, "datetime");
});
test("advisor request triggers handoff with wa.me link", () => {
  const r = answer("quiero hablar con un asesor", ctx());
  assert.equal(r.intent, "asesor");
  assert.equal(r.handoff, true);
  assert.ok(r.links.some(l => l.href.startsWith(`https://wa.me/${WHATSAPP_NUMBER}?text=`)));
});
test("purchase-ready intent triggers handoff", () => {
  const r = answer("estoy listo para comprar el corolla", ctx());
  assert.equal(r.handoff, true);
});
test("fallback offers the menu", () => {
  const r = answer("asdf qwer", ctx());
  assert.equal(r.intent, "fallback");
  assert.ok(r.chips.length >= 4);
});
test("handoff url prefilled with summary of topics", () => {
  const msgs = [{ role: "user", text: "garantia", intent: "garantia", at: NOW.toISOString() }];
  const url = buildHandoffUrl(msgs, { number: "593991001001" });
  const text = decodeURIComponent(url.split("text=")[1]);
  assert.match(text, /asistente virtual/i);
  assert.match(text, /garantia/i);
});
test("conversation record shape for the CRM placeholder", () => {
  const msgs = [
    { role: "user", text: "hola", at: "2026-11-12T10:00:00.000Z", intent: "saludo" },
    { role: "bot", text: "Hola", at: "2026-11-12T10:00:01.000Z", intent: "saludo" },
    { role: "user", text: "asesor", at: "2026-11-12T10:01:00.000Z", intent: "asesor", handoff: true }
  ];
  const rec = buildConversationRecord(msgs, { originCode: ORIGIN_CODE });
  assert.equal(rec.originCode, "WEB-ASSISTANT");
  assert.equal(rec.startedAt, "2026-11-12T10:00:00.000Z");
  assert.equal(rec.endedAt, "2026-11-12T10:01:00.000Z");
  assert.deepEqual(rec.intents, ["saludo", "asesor"]);
  assert.equal(rec.handoff, true);
  assert.equal(rec.messageCount, 3);
  assert.equal(buildConversationRecord([], {}).handoff, false);
});
test("agency step matches a partial name such as 'cumbaya' against '1001Carros Cumbayá'", () => {
  const prefixed = [{ id: 7, name: "1001Carros Cumbayá", city: "Quito" }, { id: 8, name: "1001Carros Sur", city: "Quito" }];
  const r = answer("cumbaya", ctx({ agencies: prefixed, flow: { step: "agency", carId: 1 } }));
  assert.equal(r.flow.step, "datetime");
  assert.equal(r.flow.agencyId, 7);
});
