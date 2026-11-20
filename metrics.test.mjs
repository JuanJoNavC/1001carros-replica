import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { newDb } from "pg-mem";
import { createStore } from "./db.mjs";
import { handleApi } from "./http-api.mjs";
import { classifySource, refFromVisitor, normalizeRef, trafficLight, periodRange, demoDashboard, loadTargets, maxStage } from "./metrics.mjs";

const makeStore=()=>{const memory=newDb(),adapter=memory.adapters.createPg();return createStore(new adapter.Pool());};
async function call(store,method,path,body,deps={},headers={}){const req=Readable.from(body?[JSON.stringify(body)]:[]);req.method=method;req.url=path;req.headers={host:"1001carros.com","content-type":"application/json",...headers};let output="";const res={statusCode:200,setHeader(){},end(value=""){output+=value;}};await handleApi(req,res,new URL(path,"http://localhost"),store,deps);return {status:res.statusCode,body:output?JSON.parse(output):null};}
const NOW=new Date("2026-11-20T15:00:00Z"),DEPS={now:()=>NOW,asesorKey:"clave",analistaKey:"analista"};
const V1="ABCDEFGHJKLMNPQR",V2="ZZZZZ23456789ABC";
const ase={"x-asesor-key":"clave"},ana={"x-analista-key":"analista"};

test("origen de la visita: UTM, identificadores de clic y sitio de origen",()=>{
  assert.equal(classifySource({gclid:"x"}).channel,"google_ads");
  assert.equal(classifySource({utm_source:"google",utm_medium:"cpc"}).channel,"google_ads");
  assert.equal(classifySource({referrer:"https://www.google.com/"}).channel,"google");
  assert.equal(classifySource({fbclid:"x"}).channel,"meta");
  assert.equal(classifySource({utm_source:"instagram"}).channel,"meta");
  assert.equal(classifySource({referrer:"https://www.tiktok.com/@x"}).channel,"tiktok");
  assert.equal(classifySource({referrer:"https://1001carros.com/catalogo"},"1001carros.com").channel,"directo");
  assert.equal(classifySource({}).channel,"directo");
  assert.equal(refFromVisitor(V1),"1001-ABCDE");assert.equal(normalizeRef("ref 1001-abcde"),"1001-ABCDE");assert.equal(normalizeRef("abcde"),"1001-ABCDE");
});

test("semáforo frente a la meta y la línea base",()=>{
  assert.equal(trafficLight(0.0070,0.0068,0.006),"ok");
  assert.equal(trafficLight(0.0064,0.0068,0.006),"warn");
  assert.equal(trafficLight(0.003,0.0068,0.006),"bad");
  assert.equal(trafficLight(0.30,0.35,0.70,"down"),"ok");
  assert.equal(trafficLight(0.5,0.35,0.70,"down"),"warn");
  assert.equal(trafficLight(5,null,null),"na");
});

test("las metas salen del archivo del BSC",()=>{
  const t=loadTargets();
  assert.deepEqual(t.indicadores.conversion_web.meta,[0.0068,0.0076,0.008]);
  assert.equal(t.indicadores.abandono_cedula.linea_base,0.7);
  assert.equal(t.pasos_compra.length,10);
});

test("periodo en hora de Ecuador",()=>{
  const {from,to}=periodRange("mes",new Date("2026-12-01T03:00:00Z"));// 30 nov 22:00 en Ecuador
  assert.equal(from.toISOString(),"2026-11-01T05:00:00.000Z");assert.equal(to.toISOString(),"2026-12-01T05:00:00.000Z");
  const d=periodRange("30d",NOW);assert.equal((d.to-d.from)/86400000,30);
});

test("del clic en Instagram a la venta: eventos, embudo, asesor y tablero",async()=>{
  const store=makeStore(),h={"x-visitor":V1,"x-session":"s1"};
  assert.equal((await call(store,"POST","/api/t",{kind:"page_view",path:"/",sessionId:"s1",source:{utm_source:"instagram",utm_medium:"paid",utm_campaign:"noviembre"}},DEPS,h)).status,204);
  await call(store,"POST","/api/t",{kind:"vehicle_view",path:"/vehiculo/1",vehicleId:1,sessionId:"s1"},DEPS,h);
  await call(store,"POST","/api/t",{kind:"prequal_start",sessionId:"s1"},DEPS,h);
  assert.equal((await call(store,"POST","/api/t",{kind:"hackeo"},DEPS,h)).status,400);
  assert.equal((await call(store,"POST","/api/t",{kind:"page_view"},DEPS,{"x-visitor":"corto"})).status,400);
  // Un formulario del sitio crea el cliente en el embudo, ligado a la visita.
  assert.equal((await call(store,"POST","/api/leads",{kind:"contact",name:"Ana Torres",phone:"0991234567",message:"Me interesa"},DEPS,h)).status,201);
  // Otro visitante abre WhatsApp y el asesor lo registra con la referencia.
  await call(store,"POST","/api/t",{kind:"page_view",path:"/",sessionId:"s2",source:{referrer:"https://www.google.com/"}},DEPS,{"x-visitor":V2});
  await call(store,"POST","/api/t",{kind:"whatsapp_click",sessionId:"s2"},DEPS,{"x-visitor":V2});
  assert.equal((await call(store,"POST","/api/asesor/clientes",{ref:"1001-XXXXX",name:"Luis",phone:"0991111111"},DEPS,ase)).status,404);
  const wa=await call(store,"POST","/api/asesor/clientes",{ref:"Ref. 1001-ZZZZZ",name:"Luis Pérez",phone:"0997777777",advisor:"Pedro"},DEPS,ase);
  assert.equal(wa.status,201,JSON.stringify(wa.body));assert.equal(wa.body.item.channel,"google");assert.equal(wa.body.item.stage,"contactado");
  const list=await call(store,"GET","/api/asesor/clientes",null,DEPS,ase);
  assert.equal(list.body.items.length,2);
  const ana1=list.body.items.find(i=>i.name==="Ana Torres");
  assert.equal(ana1.channel,"meta");assert.equal(ana1.ref,"1001-ABCDE");
  const detail=await call(store,"GET",`/api/asesor/clientes/${ana1.id}`,null,DEPS,ase);
  assert.equal(detail.body.origin.campaign,"noviembre");
  assert.ok(detail.body.journey.some(e=>e.kind==="prequal_start"));
  assert.ok(detail.body.journey.some(e=>e.kind==="lead_form"));
  // El asesor avanza las etapas.
  assert.equal((await call(store,"POST",`/api/asesor/clientes/${ana1.id}/stage`,{stage:"contactado"},DEPS,ase)).status,400);
  for(const stage of ["contactado","cita_agendada","cita_asistida"])assert.equal((await call(store,"POST",`/api/asesor/clientes/${ana1.id}/stage`,{stage,advisor:"Pedro"},DEPS,ase)).status,200);
  assert.equal((await call(store,"POST",`/api/asesor/clientes/${ana1.id}/stage`,{stage:"vendido",advisor:"Pedro"},DEPS,ase)).status,400);
  const sold=await call(store,"POST",`/api/asesor/clientes/${ana1.id}/stage`,{stage:"vendido",advisor:"Pedro",amount:21500},DEPS,ase);
  assert.equal(sold.body.item.stage,"vendido");assert.equal(sold.body.item.saleAmount,21500);
  const lost=await call(store,"POST",`/api/asesor/clientes/${wa.body.item.id}/stage`,{stage:"perdido",advisor:"Pedro",reason:"Precio"},DEPS,ase);
  assert.equal(lost.body.item.lostReason,"Precio");
  // El tablero del analista exige su propia clave.
  assert.equal((await call(store,"GET","/api/analista/dashboard",null,DEPS,ase)).status,401);
  assert.equal((await call(store,"GET","/api/analista/dashboard",null,{...DEPS,analistaKey:""},ana)).status,503);
  const dash=(await call(store,"GET","/api/analista/dashboard?period=mes",null,DEPS,ana)).body.item;
  assert.equal(dash.mode,"real");assert.equal(dash.totals.sessions,2);assert.equal(dash.totals.leads,2);assert.equal(dash.totals.sales,1);
  const k=Object.fromEntries(dash.kpis.map(x=>[x.id,x]));
  assert.equal(k.conversion_web.value,0.5);assert.equal(k.conversion_web.status,"ok");
  assert.equal(k.abandono_cedula.value,1);assert.equal(k.abandono_cedula.status,"bad");
  assert.equal(k.ticket_a_cita.value,0.5);assert.equal(k.cita_asistida.value,1);
  assert.equal(k.costo_prospecto.value,null);
  assert.ok(k.tiempo_respuesta.value>=0);
  assert.equal(dash.channels.find(c=>c.channel==="meta").sales,1);
  assert.equal(dash.lostReasons[0].reason,"Precio");
  assert.equal(dash.advisors[0].advisor,"Pedro");
  assert.ok(dash.tools.find(t=>t.tool==="whatsapp").customers>=1);
  const demo=(await call(store,"GET","/api/analista/dashboard?period=30d&mode=demo",null,DEPS,ana)).body.item;
  assert.equal(demo.mode,"demo");assert.ok(demo.totals.sessions>50000);assert.equal(demo.series.length,30);
});

test("una reserva pagada mueve al cliente a «Reservado» y queda en su recorrido",async()=>{
  const store=makeStore();
  const row=await store.upsertPipeline({kind:"reservation",name:"Ana",phone:"0991234567",message:"Reserva X iniciada"},V1,NOW);
  assert.equal(row.stage,"nuevo");
  const paid=await store.upsertPipeline({kind:"reservation",name:"Ana",phone:"0991234567",message:"Reserva X pagada"},V1,NOW,"reservado");
  assert.equal(paid.id,row.id);assert.equal(paid.stage,"reservado");assert.equal(maxStage(paid),"reservado");
  // Sin contacto no se crea un cliente nuevo.
  assert.equal(await store.upsertPipeline({kind:"prequalification",message:"x"},null,NOW),null);
});

test("datos de ejemplo calibrados con la línea base de la empresa",()=>{
  const {from,to}=periodRange("30d",NOW),d=demoDashboard({from,to,now:NOW});
  const k=Object.fromEntries(d.kpis.map(x=>[x.id,x.value]));
  assert.ok(k.conversion_web>0.006&&k.conversion_web<0.0075,k.conversion_web);
  assert.ok(k.ventas_web>30&&k.ventas_web<60);
  assert.equal(d.funnel.length,8);
});
