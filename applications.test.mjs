import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { newDb } from "pg-mem";
import { createStore } from "./db.mjs";
import { handleApi } from "./http-api.mjs";
import { namesMatch, normalizeName, validateUpload, requiredKinds, lookupRegistry } from "./applications.mjs";

const makeStore=()=>{const memory=newDb(),adapter=memory.adapters.createPg();return createStore(new adapter.Pool());};
async function call(store,method,path,body,deps={},headers={}){const req=Readable.from(body?[JSON.stringify(body)]:[]);req.method=method;req.url=path;req.headers={host:"localhost","content-type":"application/json",...headers};let output="";const res={statusCode:200,setHeader(){},end(value=""){output+=value;}};await handleApi(req,res,new URL(path,"http://localhost"),store,deps);return {status:res.statusCode,body:JSON.parse(output)};}
const DEPS={settings:{mode:"demo",token:"",storeId:""},messaging:{mode:"demo"},asesorKey:"clave-asesor"};
const PNG=Buffer.from("89504e470d0a1a0a0000000d49484452","hex").toString("base64");
const applicant={fullName:"María José Pérez López",cedula:"1700000019",address:"Av. Amazonas N34-12, Quito",phone:"0991234567",email:"maria@example.com"};

async function uploadAll(store,token,kinds){for(const kind of kinds){const r=await call(store,"POST",`/api/applications/${token}/files`,{kind,name:`${kind}.png`,type:"image/png",data:PNG},DEPS);assert.equal(r.status,201,JSON.stringify(r.body));}}

test("utilidades: nombres, archivos y documentos requeridos",async()=>{
  assert.equal(normalizeName(" maría  josé pérez "),"MARIA JOSE PEREZ");
  assert.ok(namesMatch("Pérez López María José","MARIA JOSE PEREZ LOPEZ"));
  assert.ok(!namesMatch("Maria Perez","MARIA JOSE PEREZ LOPEZ"));
  assert.match(validateUpload({kind:"planilla",type:"image/gif",data:PNG}).error,/Formato/);
  assert.match(validateUpload({kind:"otro",type:"image/png",data:PNG}).error,/no reconocido/);
  assert.deepEqual(requiredKinds({employment:"dependiente",voting_exempt:false}),["cedula_frente","cedula_reverso","planilla","votacion","rol"]);
  assert.deepEqual(requiredKinds({employment:"independiente",voting_exempt:true}),["cedula_frente","cedula_reverso","planilla","estado_cuenta","ruc"]);
  assert.equal((await lookupRegistry("1700000027","Otro Nombre")).fullName,"CARLOS ANDRES MORA VERA");
});

test("flujo completo: documentos, verificación, contrato y firma en línea",async()=>{
  const store=makeStore();
  const created=await call(store,"POST","/api/applications",{vehicleId:1},DEPS),token=created.body.item.token;
  assert.equal(created.status,201);
  assert.equal(created.body.item.documentsComplete,false);
  await call(store,"PUT",`/api/applications/${token}/applicant`,applicant,DEPS);
  const early=await call(store,"POST",`/api/applications/${token}/verify`,null,DEPS);
  assert.match(early.body.error,/documentos/);
  await uploadAll(store,token,["cedula_frente","cedula_reverso","planilla","votacion","rol"]);
  const verified=await call(store,"POST",`/api/applications/${token}/verify`,null,DEPS);
  assert.equal(verified.body.item.verification.status,"verified");
  assert.equal(verified.body.item.registry.fullName,"MARIA JOSE PEREZ LOPEZ");
  const contract=await call(store,"POST",`/api/applications/${token}/contract`,null,DEPS);
  assert.equal(contract.body.item.contract.buyer.cedula,"1700000019");
  assert.equal(contract.body.item.contract.payment.type,"contado");
  assert.match(contract.body.item.contract.number,/^CT-00001-/);
  const wrongName=await call(store,"POST",`/api/applications/${token}/sign`,{mode:"digital",fullName:"Maria Perez",consent:true},DEPS);
  assert.equal(wrongName.status,400);
  const signed=await call(store,"POST",`/api/applications/${token}/sign`,{mode:"digital",fullName:"maria jose perez lopez",consent:true},DEPS);
  assert.equal(signed.body.item.status,"signed");
  assert.equal(signed.body.item.signature.contractHash,contract.body.item.contract.hash);
  const afterSign=await call(store,"PUT",`/api/applications/${token}/applicant`,applicant,DEPS);
  assert.equal(afterSign.status,409);
  await store.close();
});

test("dato incorrecto: el cliente corrige y se verifica de nuevo",async()=>{
  const store=makeStore();
  const token=(await call(store,"POST","/api/applications",{vehicleId:2},DEPS)).body.item.token;
  await uploadAll(store,token,["cedula_frente","cedula_reverso","planilla","votacion","rol"]);
  await call(store,"PUT",`/api/applications/${token}/applicant`,{...applicant,fullName:"Carlos Andres Mora Vela",cedula:"1700000027"},DEPS);
  const mismatch=await call(store,"POST",`/api/applications/${token}/verify`,null,DEPS);
  assert.equal(mismatch.body.item.verification.status,"mismatch");
  assert.match(mismatch.body.item.verification.note,/nombre no coincide/);
  await call(store,"PUT",`/api/applications/${token}/applicant`,{...applicant,fullName:"Carlos Andrés Mora Vera",cedula:"1700000027"},DEPS);
  const fixed=await call(store,"POST",`/api/applications/${token}/verify`,null,DEPS);
  assert.equal(fixed.body.item.verification.status,"verified");
  await store.close();
});

test("dato incorrecto: se envía a un asesor, que verifica con la cédula subida",async()=>{
  const store=makeStore();
  const token=(await call(store,"POST","/api/applications",{vehicleId:3},DEPS)).body.item.token;
  await call(store,"PUT",`/api/applications/${token}/profile`,{employment:"independiente",votingExempt:true},DEPS);
  await uploadAll(store,token,["cedula_frente","cedula_reverso","planilla","estado_cuenta","ruc"]);
  await call(store,"PUT",`/api/applications/${token}/applicant`,{...applicant,fullName:"Ana Lucia Torres Ruis",cedula:"1700000035"},DEPS);
  await call(store,"POST",`/api/applications/${token}/verify`,null,DEPS);
  const review=await call(store,"POST",`/api/applications/${token}/review`,{note:"Mi apellido es Ruiz, lo escribí mal."},DEPS);
  assert.equal(review.body.item.status,"review");
  const contractBlocked=await call(store,"POST",`/api/applications/${token}/contract`,null,DEPS);
  assert.equal(contractBlocked.status,409);
  // El asesor necesita su clave.
  assert.equal((await call(store,"GET","/api/asesor/applications",null,DEPS)).status,401);
  assert.equal((await call(store,"GET","/api/asesor/applications",null,{...DEPS,asesorKey:""})).status,503);
  const headers={"x-asesor-key":"clave-asesor"};
  const list=await call(store,"GET","/api/asesor/applications",null,DEPS,headers);
  assert.equal(list.body.items[0].status,"review");
  const id=list.body.items[0].id;
  const detail=await call(store,"GET",`/api/asesor/applications/${id}`,null,DEPS,headers);
  assert.ok(detail.body.files.find(file=>file.kind==="cedula_frente").dataUrl.startsWith("data:image/png;base64,"));
  const rejectNoNote=await call(store,"POST",`/api/asesor/applications/${id}/decision`,{action:"reject"},DEPS,headers);
  assert.equal(rejectNoNote.status,400);
  const approved=await call(store,"POST",`/api/asesor/applications/${id}/decision`,{action:"approve",fullName:"Ana Lucía Torres Ruiz",cedula:"1700000035",note:"Verificado con la cédula."},DEPS,headers);
  assert.equal(approved.body.item.verification.status,"verified");
  assert.equal(approved.body.item.applicant.fullName,"ANA LUCIA TORRES RUIZ");
  const agency=await call(store,"POST",`/api/applications/${token}/sign`,{mode:"agency"},DEPS);
  assert.equal(agency.body.item.status,"sign_at_agency");
  assert.ok(agency.body.item.contract);
  await store.close();
});

test("el asesor puede pedir que se vuelva a subir un documento",async()=>{
  const store=makeStore(),headers={"x-asesor-key":"clave-asesor"};
  const token=(await call(store,"POST","/api/applications",{vehicleId:4},DEPS)).body.item.token;
  await uploadAll(store,token,["cedula_frente"]);
  await call(store,"POST",`/api/applications/${token}/review`,{note:"revisar"},DEPS);
  const id=(await call(store,"GET","/api/asesor/applications",null,DEPS,headers)).body.items[0].id;
  const rejected=await call(store,"POST",`/api/asesor/applications/${id}/decision`,{action:"reject",note:"La foto de la cédula está borrosa. Súbela de nuevo."},DEPS,headers);
  assert.equal(rejected.body.item.verification.status,"rejected");
  const client=await call(store,"GET",`/api/applications/${token}`,null,DEPS);
  assert.match(client.body.item.verification.reviewNote,/borrosa/);
  await uploadAll(store,token,["cedula_frente"]);
  assert.equal((await call(store,"GET",`/api/applications/${token}`,null,DEPS)).body.item.verification.status,"pending");
  await store.close();
});

test("el contrato incluye la reserva y el financiamiento precalificado",async()=>{
  const store=makeStore();
  const created=await call(store,"POST","/api/reservations",{vehicleId:5,name:"María José Pérez López",email:"maria@example.com",phone:"0991234567"},DEPS),tx=created.body.item.clientTransactionId;
  await call(store,"POST","/api/reservations/verify",{clientTransactionId:tx,code:created.body.verification.demoCode},DEPS);
  const charge=await call(store,"POST","/api/sim-payphone/charge",{clientTransactionId:tx,method:"card",cardNumber:"4111111111111111"},DEPS);
  await call(store,"POST","/api/reservations/confirm",{clientTransactionId:tx,id:charge.body.id},DEPS);
  const prequal=await call(store,"POST","/api/prequalification",{vehicleId:5,cedula:"1700000019",income:4000,consent:true},DEPS);
  const term=prequal.body.decision.options.at(-1).term;
  const app=await call(store,"POST","/api/applications",{vehicleId:5,reservationTx:tx,prequalFolio:prequal.body.folio,prequalTerm:term},DEPS),token=app.body.item.token;
  assert.equal(app.body.item.applicant.email,"maria@example.com");
  await call(store,"PUT",`/api/applications/${token}/applicant`,applicant,DEPS);
  await uploadAll(store,token,["cedula_frente","cedula_reverso","planilla","votacion","rol"]);
  assert.equal((await call(store,"POST",`/api/applications/${token}/verify`,null,DEPS)).body.item.verification.status,"verified");
  const contract=(await call(store,"POST",`/api/applications/${token}/contract`,null,DEPS)).body.item.contract;
  assert.equal(contract.reservation.amount,200);
  assert.equal(contract.payment.type,"financiado");
  assert.equal(contract.payment.term,term);
  assert.equal(contract.balanceDue,contract.payment.downPayment-200);
  // Una cédula distinta a la de la precalificación no se verifica.
  await call(store,"PUT",`/api/applications/${token}/applicant`,{...applicant,fullName:"Carlos Andres Mora Vera",cedula:"1700000027"},DEPS);
  const other=await call(store,"POST",`/api/applications/${token}/verify`,null,DEPS);
  assert.match(other.body.item.verification.note,/precalificación/);
  await store.close();
});
