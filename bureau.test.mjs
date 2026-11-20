import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { newDb } from "pg-mem";
import { createStore } from "./db.mjs";
import { handleApi } from "./http-api.mjs";
import { decideCredit, simulateBureauReport, scoreBand, payment, validatePrequalInput, TEST_PROFILES, MAX_RATE, MAX_DEBT_RATIO } from "./bureau.mjs";
import { isValidCedula } from "./prequalification.mjs";

const makeStore=()=>{const memory=newDb(),adapter=memory.adapters.createPg();return createStore(new adapter.Pool());};
async function call(store,method,path,body,deps={}){const req=Readable.from(body?[JSON.stringify(body)]:[]);req.method=method;req.url=path;req.headers={host:"localhost","content-type":"application/json"};let output="";const res={statusCode:200,setHeader(){},end(value=""){output+=value;}};await handleApi(req,res,new URL(path,"http://localhost"),store,deps);return {status:res.statusCode,body:JSON.parse(output)};}

test("las cédulas de prueba son válidas y el buró simulado es consistente",()=>{
  for(const cedula of Object.keys(TEST_PROFILES))assert.ok(isValidCedula(cedula),cedula);
  assert.deepEqual(simulateBureauReport("1710034065"),simulateBureauReport("1710034065"));
  const report=simulateBureauReport("1710034065");
  assert.ok(report.thinFile||report.score>=380&&report.score<=979);
});

test("cada perfil de prueba da el resultado esperado para un carro de $25.000 con ingreso de $2.000",()=>{
  const decide=cedula=>decideCredit({report:simulateBureauReport(cedula),income:2000,price:25000});
  const excellent=decide("1700000019");
  assert.equal(excellent.status,"preapproved");
  assert.equal(excellent.offer.downPaymentPct,0.2);
  assert.equal(decide("1700000027").status,"preapproved");
  const highDebt=decide("1700000035");
  assert.ok(["conditional","review"].includes(highDebt.status),highDebt.status);
  assert.equal(decide("1700000043").status,"declined");
  const thin=decide("1700000050");
  assert.equal(thin.status,"review");
  assert.ok(thin.offer);
  assert.equal(thin.offer.downPaymentPct,0.35);
});

test("ninguna oferta supera la tasa máxima legal ni el 40% de endeudamiento",()=>{
  for(const cedula of Object.keys(TEST_PROFILES))for(const income of [800,1500,3000,6000])for(const price of [12000,25000,45000]){
    const decision=decideCredit({report:simulateBureauReport(cedula),income,price});
    for(const option of decision.options){
      assert.ok(option.annualRate<=MAX_RATE);
      assert.ok(option.ratio<=MAX_DEBT_RATIO+0.001,`${cedula} ${income} ${price} ${option.ratio}`);
    }
  }
});

test("la cuota usa amortización francesa",()=>{
  assert.equal(Math.round(payment(20000,0.15,60)),466);
  assert.equal(scoreBand({score:812}).key,"excelente");
  assert.equal(scoreBand({score:null,thinFile:true}).key,"sin-historial");
});

test("exige autorización expresa y datos válidos",()=>{
  assert.match(validatePrequalInput({cedula:"1700000019",income:2000}).error,/autorizar/);
  assert.match(validatePrequalInput({cedula:"1234567890",income:2000,consent:true}).error,/cédula/);
  assert.match(validatePrequalInput({cedula:"1700000019",income:20,consent:true}).error,/ingreso/);
});

test("una consulta al buró por persona: el reporte se reutiliza 30 días y luego vence",async()=>{
  const store=makeStore();
  let clock=new Date("2026-11-20T15:00:00Z");const deps={now:()=>clock,bureau:{provider:"simulado",reportDays:30}};
  const first=await call(store,"POST","/api/prequalification",{vehicleId:1,cedula:"1700000019",income:2500,consent:true},deps);
  assert.equal(first.status,201);
  assert.match(first.body.folio,/^BUR-20261120-/);
  assert.equal(first.body.report.score,912);
  assert.equal(first.body.cedulaMasked,"170*****19");
  assert.equal(first.body.reused,false);
  assert.equal(first.body.reportExpiresAt,"2026-12-20T15:00:00.000Z");
  assert.equal(first.body.decision.status,"preapproved");
  // Otro carro, 10 días después: se reutiliza el reporte sin pedir la cédula ni consultar el buró.
  clock=new Date("2026-11-30T15:00:00Z");
  const other=await call(store,"POST","/api/prequalification/reuse",{reportFolio:first.body.folio,vehicleId:2},deps);
  assert.equal(other.status,201);
  assert.equal(other.body.reused,true);
  assert.equal(other.body.reportFolio,first.body.folio);
  assert.equal(other.body.income,2500);
  // Reutilizar desde una precalificación reutilizada apunta al reporte original.
  const chained=await call(store,"POST","/api/prequalification/reuse",{reportFolio:other.body.folio,vehicleId:3,income:3000},deps);
  assert.equal(chained.body.reportFolio,first.body.folio);
  assert.equal(chained.body.income,3000);
  // Si vuelve a escribir su cédula dentro de la vigencia, tampoco se consulta de nuevo.
  const typedAgain=await call(store,"POST","/api/prequalification",{vehicleId:4,cedula:"1700000019",income:2500,consent:true},deps);
  assert.equal(typedAgain.body.reused,true);
  assert.deepEqual(await store.bureauUsage(new Date("2026-11-01T00:00:00Z")),{queries:1,reused:3});
  // Meses después: el reporte venció; la reutilización se rechaza y una nueva consulta sí va al buró.
  clock=new Date("2027-02-15T15:00:00Z");
  const expired=await call(store,"POST","/api/prequalification/reuse",{reportFolio:first.body.folio,vehicleId:2},deps);
  assert.equal(expired.status,410);
  assert.equal(expired.body.code,"report_expired");
  const fresh=await call(store,"POST","/api/prequalification",{vehicleId:2,cedula:"1700000019",income:2500,consent:true},deps);
  assert.equal(fresh.body.reused,false);
  assert.equal((await store.bureauUsage(new Date("2026-11-01T00:00:00Z"))).queries,2);
  const noConsent=await call(store,"POST","/api/prequalification",{vehicleId:1,cedula:"1700000019",income:2500},deps);
  assert.equal(noConsent.status,400);
  await store.close();
});

test("la vigencia del reporte es configurable",async()=>{
  const { reportValidDays }=await import("./bureau.mjs");
  assert.equal(reportValidDays({}),30);
  assert.equal(reportValidDays({BURO_REPORT_DAYS:"60"}),60);
  assert.equal(reportValidDays({BURO_REPORT_DAYS:"abc"}),30);
});
