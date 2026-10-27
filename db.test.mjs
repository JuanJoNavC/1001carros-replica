import test from "node:test";
import assert from "node:assert/strict";
import { newDb } from "pg-mem";
import { createStore, databaseUrl, hashPassword, verifyPassword } from "./db.mjs";

function memoryStore(){const database=newDb();const adapter=database.adapters.createPg(),pool=new adapter.Pool();return createStore(pool);}

test("acepta la variable POSTGRES_URL que provee la integración de Neon en Vercel",()=>{
  const originalDatabaseUrl=process.env.DATABASE_URL,originalPostgresUrl=process.env.POSTGRES_URL;
  delete process.env.DATABASE_URL;
  process.env.POSTGRES_URL="postgresql://<REDACTED>@neon.example/neondb?sslmode=require";
  assert.equal(databaseUrl(),process.env.POSTGRES_URL);
  if(originalDatabaseUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=originalDatabaseUrl;
  if(originalPostgresUrl===undefined)delete process.env.POSTGRES_URL;else process.env.POSTGRES_URL=originalPostgresUrl;
});

test("crea y siembra el catálogo PostgreSQL",async()=>{
  const store=memoryStore();
  await store.initialize();
  assert.deepEqual(await store.counts(),{vehicles:12,agencies:7,brands:5,leads:0});
  const stats=await store.stats();
  assert.equal(stats.vehicles,12);
  assert.equal(stats.cities,4);
  const brands=await store.listBrands("seminuevos");
  assert.equal(brands.length,5);
  assert.match(brands.find(brand=>brand.slug==="toyota").logoSvg,/^<svg/);
  await store.close();
});

test("almacena prospectos, sesiones y favoritos",async()=>{
  const store=memoryStore(),hash=hashPassword("secreto123");
  assert.equal(verifyPassword("secreto123",hash),true);
  assert.equal(verifyPassword("incorrecta",hash),false);
  await store.createLead({kind:"sell",phone:"0999999999",plate:"ABC-1234"});
  const user=await store.registerUser({name:"Prueba",email:"prueba@example.com",passwordHash:hash});
  await store.createSession(user.id,"token-prueba");
  assert.equal((await store.sessionUser("token-prueba")).email,"prueba@example.com");
  await store.saveFavorite(user.id,1);
  assert.equal((await store.listFavorites(user.id)).length,1);
  assert.equal((await store.counts()).leads,1);
  await store.close();
});
