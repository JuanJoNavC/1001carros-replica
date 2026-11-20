import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { newDb } from "pg-mem";
import { createStore } from "./db.mjs";
import { handleApi } from "./http-api.mjs";
import { simulateCharge, validateReservationInput, toPayphonePhone, buildPaymentBox, interpretConfirmation, paymentSettings, newClientTransactionId, RESERVATION_AMOUNT_CENTS, PAYPHONE_CONFIRM_URL } from "./payments.mjs";

const makeStore=()=>{const memory=newDb(),adapter=memory.adapters.createPg();return createStore(new adapter.Pool());};
async function call(store,method,path,body,deps){const req=Readable.from(body?[JSON.stringify(body)]:[]);req.method=method;req.url=path;req.headers={host:"localhost","content-type":"application/json"};let output="";const res={statusCode:200,setHeader(){},end(value=""){output+=value;}};await handleApi(req,res,new URL(path,"http://localhost"),store,deps);return {status:res.statusCode,body:JSON.parse(output)};}
const DEMO={settings:{mode:"demo",token:"",storeId:""},messaging:{mode:"demo"}};
async function createVerified(store,body,deps=DEMO){const created=await call(store,"POST","/api/reservations",body,deps);assert.equal(created.status,201,JSON.stringify(created.body));const verified=await call(store,"POST","/api/reservations/verify",{clientTransactionId:created.body.item.clientTransactionId,code:created.body.verification.demoCode},deps);assert.equal(verified.status,200,JSON.stringify(verified.body));return {created,verified,tx:created.body.item.clientTransactionId};}
const customer={name:"Ana Pérez",email:"ana@example.com",phone:"0991234567",documentId:"1710034065"};

test("la configuración elige modo demo sin token y PayPhone con token",()=>{
  assert.equal(paymentSettings({}).mode,"demo");
  assert.deepEqual(paymentSettings({PAYPHONE_TOKEN:" abc ",PAYPHONE_STORE_ID:"s1"}),{mode:"payphone",token:"abc",storeId:"s1"});
});

test("valida los datos del cliente y normaliza el teléfono para PayPhone",()=>{
  assert.equal(validateReservationInput({vehicleId:1,...customer}).ok,true);
  assert.deepEqual(validateReservationInput({vehicleId:1,...customer,email:"x",phone:"123"}).errors,["email","phone"]);
  assert.equal(toPayphonePhone("0991234567"),"+593991234567");
  assert.equal(toPayphonePhone("+593 99 123 4567"),"+593991234567");
  assert.equal(toPayphonePhone("022345678"),undefined);
  assert.ok(newClientTransactionId().length<=50);
});

test("la cajita cobra USD 200 en centavos con el monto fijado por el servidor",()=>{
  const box=buildPaymentBox({client_tx_id:"RES-1",amount_cents:RESERVATION_AMOUNT_CENTS,email:"a@b.co",phone:"0991234567",document_id:null},{brand:"Kia",model:"Sportage",year:2022,code:"U-1"},{token:"t",storeId:"s"});
  assert.equal(box.amount,20000);
  assert.equal(box.amountWithoutTax,20000);
  assert.equal(box.storeId,"s");
  assert.equal(box.phoneNumber,"+593991234567");
  assert.ok(!("documentId" in box));
});

test("interpreta las respuestas de confirmación de PayPhone",()=>{
  const row={client_tx_id:"RES-1",amount_cents:20000};
  assert.equal(interpretConfirmation({statusCode:3,clientTransactionId:"RES-1",amount:20000,transactionId:9},row).status,"paid");
  assert.equal(interpretConfirmation({statusCode:2,clientTransactionId:"RES-1",amount:20000},row).status,"canceled");
  assert.equal(interpretConfirmation({statusCode:3,clientTransactionId:"RES-1",amount:100},row).status,"error");
  assert.equal(interpretConfirmation({statusCode:3,clientTransactionId:"OTRA",amount:20000},row).status,"error");
  assert.equal(interpretConfirmation({errorCode:20,message:"La transacción no existe"},row).status,"error");
});

test("reserva en modo demostración: el carro queda reservado y no se puede reservar dos veces",async()=>{
  const store=makeStore();
  const {created,tx}=await createVerified(store,{vehicleId:1,agencyId:1,...customer});
  assert.equal(created.body.mode,"demo");
  assert.equal(created.body.item.amount,200);
  assert.equal(created.body.payphone,undefined);
  const noTx=await call(store,"POST","/api/reservations/confirm",{clientTransactionId:tx},DEMO);
  assert.equal(noTx.status,400);
  const charge=await call(store,"POST","/api/sim-payphone/charge",{clientTransactionId:tx,method:"card",cardNumber:"4111 1111 1111 1111"},DEMO);
  assert.equal(charge.status,201);
  const confirmed=await call(store,"POST","/api/reservations/confirm",{clientTransactionId:tx,id:charge.body.id},DEMO);
  assert.equal(confirmed.body.item.status,"paid");
  assert.equal(confirmed.body.item.cardBrand,"Visa");
  assert.equal(confirmed.body.item.lastDigits,"1111");
  assert.ok(confirmed.body.item.authorizationCode);
  assert.equal((await store.getVehicle(1)).status,"reserved");
  const catalog=await call(store,"GET","/api/vehicles",null,DEMO);
  assert.equal(catalog.body.items.find(car=>car.id===1).badge,"Reservado");
  const again=await call(store,"POST","/api/reservations",{vehicleId:1,...customer,email:"otra@example.com",phone:"0980000000"},DEMO);
  assert.equal(again.status,409);
  assert.match(again.body.error,/reservado/);
  const sameCustomer=await call(store,"POST","/api/reservations",{vehicleId:9,...customer},DEMO);
  assert.equal(sameCustomer.body.code,"active_reservation");
  const lookup=await call(store,"GET",`/api/reservations/${tx}`,null,DEMO);
  assert.equal(lookup.body.item.vehicle.id,1);
  await store.close();
});

test("rechaza datos inválidos sin crear la reserva",async()=>{
  const store=makeStore();
  const bad=await call(store,"POST","/api/reservations",{vehicleId:1,...customer,phone:"12"},DEMO);
  assert.equal(bad.status,400);
  assert.match(bad.body.error,/celular/);
  await store.close();
});

test("con PayPhone confirma el pago en el servidor antes de reservar el carro",async()=>{
  const store=makeStore(),settings={mode:"payphone",token:"tok",storeId:"store-1"};
  let sent;
  const fetchImpl=async(url,options)=>{sent={url,options};const body=JSON.parse(options.body);return {json:async()=>({statusCode:3,transactionStatus:"Approved",transactionId:body.id,clientTransactionId:body.clientTxId,amount:20000,authorizationCode:"A1",cardBrand:"Visa",lastDigits:"4242"})};};
  const deps={settings,fetchImpl,messaging:{mode:"demo"}};
  const created=await call(store,"POST","/api/reservations",{vehicleId:2,...customer},deps);
  assert.equal(created.body.payphone,undefined);
  const tx=created.body.item.clientTransactionId;
  const unverified=await call(store,"POST","/api/reservations/confirm",{clientTransactionId:tx,id:555},deps);
  assert.equal(unverified.status,409);
  const verified=await call(store,"POST","/api/reservations/verify",{clientTransactionId:tx,code:created.body.verification.demoCode},deps);
  assert.equal(verified.body.payphone.config.token,"tok");
  assert.equal(verified.body.payphone.config.amount,20000);
  const demoAttempt=await call(store,"POST","/api/reservations/confirm",{clientTransactionId:tx},deps);
  assert.equal(demoAttempt.status,400);
  const confirmed=await call(store,"POST","/api/reservations/confirm",{clientTransactionId:tx,id:555},deps);
  assert.equal(sent.url,PAYPHONE_CONFIRM_URL);
  assert.equal(sent.options.headers.authorization,"Bearer tok");
  assert.deepEqual(JSON.parse(sent.options.body),{id:555,clientTxId:tx});
  assert.equal(confirmed.body.item.status,"paid");
  assert.equal(confirmed.body.item.lastDigits,"4242");
  assert.equal((await store.getVehicle(2)).status,"reserved");
  await store.close();
});

test("un pago cancelado en PayPhone no reserva el carro",async()=>{
  const store=makeStore(),settings={mode:"payphone",token:"tok",storeId:""};
  const fetchImpl=async(url,options)=>{const body=JSON.parse(options.body);return {json:async()=>({statusCode:2,transactionStatus:"Canceled",clientTransactionId:body.clientTxId,amount:20000,message:"Cancelado por el usuario"})};};
  const deps={settings,fetchImpl,messaging:{mode:"demo"}},{tx}=await createVerified(store,{vehicleId:3,...customer},deps);
  const result=await call(store,"POST","/api/reservations/confirm",{clientTransactionId:tx,id:7},deps);
  assert.equal(result.body.item.status,"canceled");
  assert.equal((await store.getVehicle(3)).status,"available");
  await store.close();
});

test("una reserva iniciada con PayPhone no se puede marcar pagada como demostración",async()=>{
  const store=makeStore();
  const {tx}=await createVerified(store,{vehicleId:4,...customer},{settings:{mode:"payphone",token:"tok",storeId:""},messaging:{mode:"demo"}});
  const attempt=await call(store,"POST","/api/reservations/confirm",{clientTransactionId:tx},DEMO);
  assert.equal(attempt.status,503);
  assert.equal((await store.getVehicle(4)).status,"available");
  await store.close();
});

test("la pasarela simulada solo acepta tarjetas de prueba",()=>{
  assert.equal(simulateCharge({method:"card",cardNumber:"4111111111111111"}).statusCode,3);
  assert.equal(simulateCharge({method:"card",cardNumber:"4000 0000 0000 0002"}).statusCode,2);
  assert.match(simulateCharge({method:"card",cardNumber:"4532015112830366"}).error,/tarjetas de prueba/);
  assert.equal(simulateCharge({method:"payphone",approve:false}).statusCode,2);
});

test("simulación: tarjeta rechazada deja el carro disponible y se puede reintentar",async()=>{
  const store=makeStore();
  const {tx}=await createVerified(store,{vehicleId:5,...customer});
  const fake=await call(store,"POST","/api/sim-payphone/charge",{clientTransactionId:tx,method:"card",cardNumber:"4532015112830366"},DEMO);
  assert.equal(fake.status,400);
  const charge=await call(store,"POST","/api/sim-payphone/charge",{clientTransactionId:tx,method:"card",cardNumber:"4000000000000002"},DEMO);
  const result=await call(store,"POST","/api/reservations/confirm",{clientTransactionId:tx,id:charge.body.id},DEMO);
  assert.equal(result.body.item.status,"canceled");
  assert.match(result.body.reason,/fondos insuficientes/);
  assert.equal((await store.getVehicle(5)).status,"available");
  const retry=await createVerified(store,{vehicleId:5,...customer});
  const balance=await call(store,"POST","/api/sim-payphone/charge",{clientTransactionId:retry.tx,method:"payphone",approve:true},DEMO);
  const ok=await call(store,"POST","/api/reservations/confirm",{clientTransactionId:retry.tx,id:balance.body.id},DEMO);
  assert.equal(ok.body.item.status,"paid");
  assert.equal(ok.body.item.cardBrand,"Saldo PayPhone");
  await store.close();
});

test("la pasarela simulada no existe cuando PayPhone real está configurado",async()=>{
  const store=makeStore(),settings={mode:"payphone",token:"tok",storeId:""};
  const {tx}=await createVerified(store,{vehicleId:6,...customer},{settings,messaging:{mode:"demo"}});
  const charge=await call(store,"POST","/api/sim-payphone/charge",{clientTransactionId:tx,method:"card",cardNumber:"4111111111111111"},{settings});
  assert.equal(charge.status,404);
  await store.close();
});

test("capa 2: el código de verificación controla el acceso al pago",async()=>{
  const store=makeStore();
  let clock=new Date("2026-11-20T15:00:00Z");const deps={...DEMO,now:()=>clock};
  const created=await call(store,"POST","/api/reservations",{vehicleId:10,name:"Luis",email:"luis@example.com",phone:"0987654321"},deps),tx=created.body.item.clientTransactionId;
  assert.equal(created.body.verification.sentTo,"••• 4321");
  assert.equal(created.body.verification.demoCode.length,6);
  const charge=await call(store,"POST","/api/sim-payphone/charge",{clientTransactionId:tx,method:"card",cardNumber:"4111111111111111"},deps);
  assert.equal(charge.status,409);
  const wrong=await call(store,"POST","/api/reservations/verify",{clientTransactionId:tx,code:"000000"===created.body.verification.demoCode?"111111":"000000"},deps);
  assert.match(wrong.body.error,/Te quedan 4 intentos/);
  const early=await call(store,"POST","/api/reservations/resend",{clientTransactionId:tx},deps);
  assert.equal(early.status,429);
  clock=new Date(clock.getTime()+31000);
  const resent=await call(store,"POST","/api/reservations/resend",{clientTransactionId:tx},deps);
  assert.equal(resent.status,200);
  const old=await call(store,"POST","/api/reservations/verify",{clientTransactionId:tx,code:created.body.verification.demoCode},deps);
  if(created.body.verification.demoCode!==resent.body.verification.demoCode)assert.equal(old.status,400);
  clock=new Date(clock.getTime()+11*60000);
  const expired=await call(store,"POST","/api/reservations/verify",{clientTransactionId:tx,code:resent.body.verification.demoCode},deps);
  assert.equal(expired.body.code,"otp_expired");
  await store.close();
});

test("capa 1: límite diario de intentos por celular o correo",async()=>{
  const store=makeStore(),person={name:"Rita",email:"rita@example.com",phone:"0970000000"};
  for(let i=0;i<5;i++)assert.equal((await call(store,"POST","/api/reservations",{vehicleId:11+i,...person},DEMO)).status,201);
  const blocked=await call(store,"POST","/api/reservations",{vehicleId:20,...person,email:"otro@example.com"},DEMO);
  assert.equal(blocked.status,429);
  await store.close();
});

test("capa 1: la reserva vence a las 72 h sin visita y el carro vuelve a estar disponible",async()=>{
  const store=makeStore();
  let clock=new Date("2026-11-20T15:00:00Z");const deps={...DEMO,now:()=>clock};
  const {tx}=await createVerified(store,{vehicleId:21,...customer},deps);
  const charge=await call(store,"POST","/api/sim-payphone/charge",{clientTransactionId:tx,method:"card",cardNumber:"4111111111111111"},deps);
  const paid=await call(store,"POST","/api/reservations/confirm",{clientTransactionId:tx,id:charge.body.id},deps);
  assert.equal(new Date(paid.body.item.expiresAt).toISOString(),"2026-11-23T15:00:00.000Z");
  clock=new Date("2026-11-23T15:00:01Z");
  const vehicle=await call(store,"GET","/api/vehicles/21",null,deps);
  assert.equal(vehicle.body.item.status,"available");
  assert.equal((await store.getReservation(tx)).status,"expired");
  await store.close();
});

test("tras pagar: cédula opcional y visita agendada evitan el vencimiento",async()=>{
  const store=makeStore();
  let clock=new Date("2026-11-20T15:00:00Z");const deps={...DEMO,now:()=>clock};
  const {tx}=await createVerified(store,{vehicleId:22,...customer},deps);
  const unpaidDoc=await call(store,"POST",`/api/reservations/${tx}/document`,{documentId:"1710034065"},deps);
  assert.equal(unpaidDoc.status,409);
  const charge=await call(store,"POST","/api/sim-payphone/charge",{clientTransactionId:tx,method:"card",cardNumber:"5555555555554444"},deps);
  await call(store,"POST","/api/reservations/confirm",{clientTransactionId:tx,id:charge.body.id},deps);
  assert.equal((await call(store,"POST",`/api/reservations/${tx}/document`,{documentId:"1710034066"},deps)).status,400);
  const doc=await call(store,"POST",`/api/reservations/${tx}/document`,{documentId:"1710034065"},deps);
  assert.equal(doc.body.item.documentProvided,true);
  assert.equal((await call(store,"POST",`/api/reservations/${tx}/visit`,{visitAt:"2026-11-30T15:00:00Z"},deps)).status,400);
  const visit=await call(store,"POST",`/api/reservations/${tx}/visit`,{visitAt:"2026-11-22T15:00:00Z"},deps);
  assert.ok(visit.body.item.visitAt);
  clock=new Date("2026-11-24T15:00:00Z");
  await call(store,"GET","/api/vehicles/22",null,deps);
  assert.equal((await store.getReservation(tx)).status,"paid");
  await store.close();
});

test("la reserva acepta abonar más que el mínimo, con tope", async () => {
  const { reservationMaxUsd, RESERVATION_AMOUNT_USD } = await import("./payments.mjs");
  const base = { vehicleId: 1, name: "Ana Torres", email: "ana@example.com", phone: "0991234567" };
  assert.equal(validateReservationInput(base).value.amountUsd, RESERVATION_AMOUNT_USD);
  assert.equal(validateReservationInput({ ...base, amount: 1500 }).value.amountUsd, 1500);
  assert.deepEqual(validateReservationInput({ ...base, amount: 150 }).errors, ["amount"]);
  assert.deepEqual(validateReservationInput({ ...base, amount: 250.5 }).errors, ["amount"]);
  assert.equal(reservationMaxUsd(46900), 5000);
  assert.equal(reservationMaxUsd(12800), 3800);
  assert.equal(reservationMaxUsd(500), 200);
});

test("reserva con un abono mayor: se cobra el monto elegido y respeta el tope del carro", async () => {
  const store = makeStore();
  const tooMuch = await call(store, "POST", "/api/reservations", { vehicleId: 1, ...customer, amount: 9000 }, DEMO);
  assert.equal(tooMuch.status, 400); assert.match(tooMuch.body.error, /hasta USD/);
  const tooLittle = await call(store, "POST", "/api/reservations", { vehicleId: 1, ...customer, amount: 100 }, DEMO);
  assert.equal(tooLittle.status, 400);
  const created = await call(store, "POST", "/api/reservations", { vehicleId: 1, ...customer, amount: 1500 }, DEMO);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.item.amount, 1500);
});
