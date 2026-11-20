import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { newDb } from "pg-mem";
import { createStore } from "./db.mjs";
import { handleApi } from "./http-api.mjs";
import { quoteSell, marketValue, pricing, brandGroup, depreciation, lookupPlate, validateSellInput, loadPolicy, REQUIRED_PHOTOS } from "./sell.mjs";

const makeStore=()=>{const memory=newDb(),adapter=memory.adapters.createPg();return createStore(new adapter.Pool());};
async function call(store,method,path,body,deps={},headers={}){const req=Readable.from(body?[JSON.stringify(body)]:[]);req.method=method;req.url=path;req.headers={host:"localhost","content-type":"application/json",...headers};let output="",raw=null;const res={statusCode:200,setHeader(){},end(value=""){if(Buffer.isBuffer(value))raw=value;else output+=value;}};await handleApi(req,res,new URL(path,"http://localhost"),store,deps);return {status:res.statusCode,body:raw?null:JSON.parse(output),raw};}
const NOW=new Date("2026-11-20T15:00:00Z"),DEPS={now:()=>NOW,asesorKey:"clave"};
const PNG=Buffer.from("89504e470d0a1a0a0000000d49484452","hex").toString("base64");
const catalog=[{id:1,brand:"Toyota",model:"RAV4 LE",year:2020,mileage:76733,price:29290},{id:2,brand:"Toyota",model:"RAV4 AC",year:2022,mileage:33278,price:34790},{id:3,brand:"Kia",model:"Sportage",year:2021,mileage:40000,price:24000}];
const good={vehicle:{plate:"PBA1234",brand:"Toyota",model:"RAV4",year:2020,mileage:80000,color:"Blanco"},condition:{crash:"ninguno",tires:"buenas"},legal:{},contact:{name:"Luis Pérez",email:"luis@example.com",phone:"0991234567"}};
const input=data=>validateSellInput(data,NOW);

test("la política se lee del archivo editable",()=>{
  const policy=loadPolicy();
  assert.equal(policy.margen_ganancia,0.09);
  assert.equal(policy.validez_dias,3);
  assert.equal(policy.costos_reparacion.frenos,340);
});

test("Pricing 2.0: grupos de marca y tabla de depreciación de la empresa",()=>{
  assert.equal(brandGroup("Toyota"),0);assert.equal(brandGroup("KIA"),1);assert.equal(brandGroup("Volkswagen"),2);assert.equal(brandGroup("Citroën"),4);assert.equal(brandGroup("Lada"),5);
  assert.equal(depreciation(0,5),0.278);assert.equal(depreciation(5,9),0.733);assert.equal(depreciation(0,10),null);
  const policy={...loadPolicy(),precios_nuevos:{"toyota rav4":40000}};
  const p=pricing({brand:"Toyota",model:"RAV4",year:2021,mileage:5*18496,plate:"PBA1234"},[],policy,NOW);
  assert.equal(p.newPriceSource,"lista");assert.equal(p.years,5);assert.equal(p.kmFactor,1);
  assert.equal(p.value,Math.round(40000*(1-0.278)));
  const low=pricing({brand:"Toyota",model:"RAV4",year:2021,mileage:40000,plate:"PBA1234"},[],policy,NOW);
  assert.ok(low.value>p.value,"menos km recibe beneficio");
  const high=pricing({brand:"Toyota",model:"RAV4",year:2021,mileage:200000,plate:"PBA1234"},[],policy,NOW);
  assert.equal(high.value,Math.round(40000*(1-0.278)*0.92),"castigo con tope de 8%");
});

test("valor de mercado con carros parecidos del catálogo",()=>{
  const market=marketValue(input(good).vehicle,catalog);
  assert.equal(market.basis,"catalogo");
  assert.equal(market.comparables.length,2);
  assert.ok(market.value>20000&&market.value<29290,market.value);
  assert.equal(marketValue({...input(good).vehicle,brand:"Lada",model:"Niva"},catalog).value,null);
});

test("la oferta descuenta margen, reacondicionamiento, novedades y valores pendientes",()=>{
  const clean=quoteSell(input(good),catalog,{now:NOW});
  assert.equal(clean.status,"offer");
  const worn=quoteSell(input({...good,condition:{tires:"cambiar",windshield:true,repaintedPanels:2,keys:1},legal:{multas:135.6,matricula_al_dia:false,prenda_saldo:3000}}),catalog,{now:NOW});
  assert.equal(worn.status,"offer");
  const expectedCosts=450+300+360+250;
  assert.equal(worn.offer.costs,expectedCosts);
  assert.equal(worn.offer.pendingTotal,135.6+250+3000);
  assert.equal(worn.offer.mid,Math.round(worn.market.value-worn.margin-expectedCosts-(135.6+250+3000)));
  assert.ok(worn.offer.low<clean.offer.low);
  assert.ok(clean.offer.mid<clean.market.value*0.92,"queda margen para 1001Carros");
  const payBefore=quoteSell(input({...good,legal:{multas:640,descontar_pendientes:false}}),catalog,{now:NOW});
  assert.equal(payBefore.offer.pendingTotal,0);assert.equal(payBefore.payBefore[0].amount,640);
  const brakes=quoteSell(input({...good,condition:{brakes:true}}),catalog,{now:NOW});
  assert.equal(brakes.offer.costs,340);
});

test("pasa directo a un evaluador si está chocado o tiene muchos detalles",()=>{
  const cases=[{condition:{crash:"fuerte"}},{condition:{airbags:true}},{condition:{engineLights:true}},{condition:{dentedPanels:3}},{legal:{revision_tecnica:"no_aprobada"}},{legal:{titular_coincide:false}},{vehicle:{...good.vehicle,year:2015}},{vehicle:{...good.vehicle,brand:"Lada",model:"Niva"}}];
  for(const extra of cases){const q=quoteSell(input({...good,...extra,condition:{...good.condition,...(extra.condition||{})},legal:{...(extra.legal||{})}}),catalog,{now:NOW});assert.equal(q.status,"evaluation",JSON.stringify(extra));assert.ok(q.reasons.length);}
});

test("consulta de valores pendientes por placa (simulada)",()=>{
  assert.equal(lookupPlate("pcd-5678",NOW).multas,135.6);
  assert.equal(lookupPlate("PCD5678",NOW).matricula_al_dia,false);
  assert.equal(lookupPlate("GYE2020",NOW).prenda_saldo,4500);
  assert.equal(lookupPlate("ABC1111",NOW).revision_tecnica,"no_aprobada");
  assert.match(lookupPlate("12",NOW).error,/placa/);
});

test("flujo completo: cotización, fotos, video por partes, oferta y aceptación",async()=>{
  const store=makeStore();
  const created=await call(store,"POST","/api/sell/requests",{...good,vehicle:{...good.vehicle,brand:"Toyota",model:"RAV4"}},DEPS);
  assert.equal(created.status,201,JSON.stringify(created.body));
  const token=created.body.item.token;
  assert.equal(created.body.item.quote.status,"preliminary");
  const early=await call(store,"POST",`/api/sell/requests/${token}/submit`,null,DEPS);
  assert.match(early.body.error,/Faltan 9 fotos/);
  for(const kind of REQUIRED_PHOTOS)assert.equal((await call(store,"POST",`/api/sell/requests/${token}/media`,{kind,type:"image/png",data:PNG},DEPS)).status,201);
  const video=Buffer.from("video-de-prueba-del-motor".repeat(10));
  const halves=[video.subarray(0,100),video.subarray(100)];
  for(const [index,part] of halves.entries())await call(store,"POST",`/api/sell/requests/${token}/media`,{kind:"video",type:"video/webm",uploadId:"v1",chunkIndex:index,chunkCount:2,data:part.toString("base64")},DEPS);
  const view=await call(store,"GET",`/api/sell/requests/${token}`,null,DEPS);
  assert.equal(view.body.item.photosComplete,true);
  assert.equal(view.body.item.video.uploaded,true);
  const submitted=await call(store,"POST",`/api/sell/requests/${token}/submit`,null,DEPS);
  assert.equal(submitted.body.item.status,"offer");
  assert.ok(submitted.body.item.quote.offer.low>1000);
  const accepted=await call(store,"POST",`/api/sell/requests/${token}/accept`,{agencyId:1,visitAt:"2026-11-22T15:00:00Z"},DEPS);
  assert.equal(accepted.body.item.status,"accepted");
  // El evaluador ve el video completo.
  const list=await call(store,"GET","/api/asesor/sell",null,DEPS,{"x-asesor-key":"clave"});
  const id=list.body.items[0].id;
  const raw=await call(store,"GET",`/api/asesor/sell/${id}/video`,null,DEPS,{"x-asesor-key":"clave"});
  assert.equal(raw.raw.toString(),video.toString());
  await store.close();
});

test("un carro chocado va al evaluador, que fija la oferta o pide más fotos",async()=>{
  const store=makeStore(),headers={"x-asesor-key":"clave"};
  const token=(await call(store,"POST","/api/sell/requests",{...good,condition:{crash:"fuerte"}},DEPS)).body.item.token;
  for(const kind of REQUIRED_PHOTOS)await call(store,"POST",`/api/sell/requests/${token}/media`,{kind,type:"image/png",data:PNG},DEPS);
  const submitted=await call(store,"POST",`/api/sell/requests/${token}/submit`,null,DEPS);
  assert.equal(submitted.body.item.status,"evaluation");
  assert.equal((await call(store,"POST",`/api/sell/requests/${token}/accept`,{agencyId:1,visitAt:"2026-11-22T15:00:00Z"},DEPS)).status,409);
  const id=(await call(store,"GET","/api/asesor/sell",null,DEPS,headers)).body.items[0].id;
  const detail=await call(store,"GET",`/api/asesor/sell/${id}`,null,DEPS,headers);
  assert.equal(detail.body.photos.length,REQUIRED_PHOTOS.length);
  const more=await call(store,"POST",`/api/asesor/sell/${id}/decision`,{action:"more_photos",note:"Envía una foto del golpe de cerca."},DEPS,headers);
  assert.equal(more.body.item.status,"more_photos");
  await call(store,"POST",`/api/sell/requests/${token}/media`,{kind:"detalle_1",type:"image/png",data:PNG},DEPS);
  assert.equal((await call(store,"POST",`/api/sell/requests/${token}/submit`,null,DEPS)).body.item.status,"evaluation");
  const offer=await call(store,"POST",`/api/asesor/sell/${id}/decision`,{action:"offer",amount:14800,note:"Precio considerando la reparación del guardachoque."},DEPS,headers);
  assert.equal(offer.body.item.finalOffer.amount,14800);
  const client=await call(store,"GET",`/api/sell/requests/${token}`,null,DEPS);
  assert.equal(client.body.item.status,"evaluated");
  assert.equal((await call(store,"POST",`/api/sell/requests/${token}/accept`,{agencyId:2,visitAt:"2026-11-23T15:00:00Z"},DEPS)).body.item.status,"accepted");
  await store.close();
});
