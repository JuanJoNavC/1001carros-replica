import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { newDb } from "pg-mem";
import { createStore } from "./db.mjs";
import { handleApi } from "./http-api.mjs";
import { availableDays, isValidSlot, visitDate, needsTransfer, icsFor, formatVisit } from "./testdrive.mjs";

const makeStore=()=>{const memory=newDb(),adapter=memory.adapters.createPg();return createStore(new adapter.Pool());};
async function call(store,method,path,body,deps={},headers={}){const req=Readable.from(body?[JSON.stringify(body)]:[]);req.method=method;req.url=path;req.headers={host:"localhost","content-type":"application/json",...headers};let output="";const res={statusCode:200,setHeader(){},end(value=""){output+=value;}};await handleApi(req,res,new URL(path,"http://localhost"),store,deps);return {status:res.statusCode,body:output?JSON.parse(output):null};}
const NOW=new Date("2026-11-20T15:00:00Z"); // viernes 20 nov, 10:00 en Ecuador
const DEPS={now:()=>NOW,asesorKey:"clave"};

test("horarios: sin domingos, sábados más cortos y 2 horas de anticipación",()=>{
  const days=availableDays({now:NOW});
  assert.ok(days.every(d=>!d.longLabel.startsWith("domingo")));
  const today=days[0];assert.equal(today.dateKey,"2026-11-20");
  assert.equal(today.slots.find(s=>s.time==="11:00").available,false);
  assert.equal(today.slots.find(s=>s.time==="12:00").available,true);
  const saturday=days.find(d=>d.dateKey==="2026-11-21");assert.equal(saturday.slots[0].time,"10:00");assert.equal(saturday.slots.at(-1).time,"16:00");
  assert.equal(isValidSlot(visitDate("2026-11-22","10:00"),{now:NOW}),false,"domingo");
  assert.equal(isValidSlot(visitDate("2026-11-23","13:00"),{now:NOW}),false,"fuera de horario");
  assert.equal(isValidSlot(visitDate("2026-11-23","14:00"),{now:NOW}),true);
  assert.equal(isValidSlot(visitDate("2026-11-21","10:00"),{now:NOW,transfer:true}),false,"traslado necesita 2 días");
  assert.equal(isValidSlot(visitDate("2026-11-23","10:00"),{now:NOW,transfer:true}),true);
  assert.equal(needsTransfer({city:"Guayaquil"},{city:"Quito"}),true);
  assert.equal(needsTransfer({city:"Quito"},{city:"quito"}),false);
  assert.match(formatVisit(visitDate("2026-11-23","14:00")),/lunes 23 de nov a las 14:00/);
  assert.match(icsFor({visitAt:visitDate("2026-11-23","14:00"),car:{brand:"Kia",model:"Soluto"},agency:{name:"A",address:"B",city:"Quito"},code:"TD-1"}),/DTSTART:20261123T190000Z/);
});

test("agendar un test drive: valida el horario, evita choques y marca «Cita agendada» en el embudo",async()=>{
  const store=makeStore(),car=await store.getVehicle(1),agencies=await store.listAgencies();
  const same=agencies.find(a=>a.city.toLowerCase().includes(String(car.city).toLowerCase().slice(0,4)))||agencies[0];
  const transfer=same.city!==car.city;
  const visitAt=visitDate("2026-11-24","10:00").toISOString();
  const base={vehicleId:1,agencyId:same.id,name:"Ana Torres",phone:"0991234567",email:"ana@example.com",tradeIn:true};
  assert.equal((await call(store,"POST","/api/test-drives",{...base,visitAt:visitDate("2026-11-22","10:00").toISOString()},DEPS)).status,400);
  assert.equal((await call(store,"POST","/api/test-drives",{...base,phone:"123",visitAt},DEPS)).status,400);
  const ok=await call(store,"POST","/api/test-drives",{...base,visitAt},DEPS,{"x-visitor":"ABCDEFGHJKLMNPQR"});
  assert.equal(ok.status,201,JSON.stringify(ok.body));assert.match(ok.body.item.code,/^TD-/);assert.equal(ok.body.item.transfer,transfer);
  const clash=await call(store,"POST","/api/test-drives",{...base,phone:"0997777777",visitAt},DEPS);
  assert.equal(clash.status,409);
  const slots=await call(store,"GET","/api/test-drives/slots?vehicleId=1",null,DEPS);
  assert.deepEqual(slots.body.taken,[visitAt]);
  const clients=(await call(store,"GET","/api/asesor/clientes",null,DEPS,{"x-asesor-key":"clave"})).body.items;
  assert.equal(clients[0].stage,"cita_agendada");
  const detail=(await call(store,"GET",`/api/asesor/clientes/${clients[0].id}`,null,DEPS,{"x-asesor-key":"clave"})).body;
  assert.ok(detail.journey.some(e=>e.kind==="test_drive_scheduled"));
  assert.match(clients[0].note,/parte de pago/);
});
