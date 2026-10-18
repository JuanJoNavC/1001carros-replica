import test from "node:test";
import assert from "node:assert/strict";
import { openStore, hashPassword, verifyPassword } from "./db.mjs";

test("crea y siembra el catálogo persistente", () => {
  const db=openStore(":memory:");
  const stats=db.prepare("SELECT COUNT(*) vehicles, COUNT(DISTINCT city) cities FROM vehicles").get();
  assert.equal(stats.vehicles,12);
  assert.equal(stats.cities,4);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM agencies").get().count,6);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM brands").get().count,5);
  assert.match(db.prepare("SELECT logo_svg FROM brands WHERE slug='toyota'").get().logo_svg,/^<svg/);
  db.close();
});

test("almacena prospectos y protege contraseñas", () => {
  const db=openStore(":memory:"),hash=hashPassword("secreto123");
  assert.equal(verifyPassword("secreto123",hash),true);
  assert.equal(verifyPassword("incorrecta",hash),false);
  db.prepare("INSERT INTO leads (kind,phone,plate) VALUES (?,?,?)").run("sell","0999999999","ABC-1234");
  assert.equal(db.prepare("SELECT COUNT(*) count FROM leads").get().count,1);
  db.close();
});
