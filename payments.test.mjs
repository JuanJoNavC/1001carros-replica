import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { newDb } from "pg-mem";
import { createStore } from "./db.mjs";
import { handleApi } from "./http-api.mjs";
import { simulateCharge, validateReservationInput, toPayphonePhone, buildPaymentBox, interpretConfirmation, paymentSettings, newClientTransactionId, RESERVATION_AMOUNT_CENTS, PAYPHONE_CONFIRM_URL } from "./payments.mjs";

const makeStore=()=>{const memory=newDb(),adapter=memory.adapters.createPg();return createStore(new adapter.Pool());};
async function call(store,method,path,body,deps){const req=Readable.from(body?[JSON.stringify(body)]:[]);req.method=method;req.url=path;req.headers={host:"localhost","content-type":"application/json"};let output="";const res={statusCode:200,setHeader(){},end(value=""){output+=value;}};await handleApi(req,res,new URL(path,"http://localhost"),store,deps);return {status:res.statusCode,body:JSON.parse(output)};}
const DEMO={settings:{mode:"demo",token:"",storeId:""}};
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
  const created=await call(store,"POST","/api/reservations",{vehicleId:1,agencyId:1,...customer},DEMO);
  assert.equal(created.status,201);
  assert.equal(created.body.mode,"demo");
  assert.equal(created.body.item.amount,200);
  assert.equal(created.body.payphone,undefined);
  const tx=created.body.item.clientTransactionId;
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
  const again=await call(store,"POST","/api/reservations",{vehicleId:1,...customer},DEMO);
  assert.equal(again.status,409);
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
  const created=await call(store,"POST","/api/reservations",{vehicleId:2,...customer},{settings,fetchImpl});
  assert.equal(created.body.payphone.config.token,"tok");
  assert.equal(created.body.payphone.config.amount,20000);
  const tx=created.body.item.clientTransactionId;
  const demoAttempt=await call(store,"POST","/api/reservations/confirm",{clientTransactionId:tx},{settings,fetchImpl});
  assert.equal(demoAttempt.status,400);
  const confirmed=await call(store,"POST","/api/reservations/confirm",{clientTransactionId:tx,id:555},{settings,fetchImpl});
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
  const created=await call(store,"POST","/api/reservations",{vehicleId:3,...customer},{settings,fetchImpl});
  const result=await call(store,"POST","/api/reservations/confirm",{clientTransactionId:created.body.item.clientTransactionId,id:7},{settings,fetchImpl});
  assert.equal(result.body.item.status,"canceled");
  assert.equal((await store.getVehicle(3)).status,"available");
  await store.close();
});

test("una reserva iniciada con PayPhone no se puede marcar pagada como demostración",async()=>{
  const store=makeStore();
  const created=await call(store,"POST","/api/reservations",{vehicleId:4,...customer},{settings:{mode:"payphone",token:"tok",storeId:""}});
  const attempt=await call(store,"POST","/api/reservations/confirm",{clientTransactionId:created.body.item.clientTransactionId},DEMO);
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
  const created=await call(store,"POST","/api/reservations",{vehicleId:5,...customer},DEMO),tx=created.body.item.clientTransactionId;
  const fake=await call(store,"POST","/api/sim-payphone/charge",{clientTransactionId:tx,method:"card",cardNumber:"4532015112830366"},DEMO);
  assert.equal(fake.status,400);
  const charge=await call(store,"POST","/api/sim-payphone/charge",{clientTransactionId:tx,method:"card",cardNumber:"4000000000000002"},DEMO);
  const result=await call(store,"POST","/api/reservations/confirm",{clientTransactionId:tx,id:charge.body.id},DEMO);
  assert.equal(result.body.item.status,"canceled");
  assert.match(result.body.reason,/fondos insuficientes/);
  assert.equal((await store.getVehicle(5)).status,"available");
  const retry=await call(store,"POST","/api/reservations",{vehicleId:5,...customer},DEMO);
  const balance=await call(store,"POST","/api/sim-payphone/charge",{clientTransactionId:retry.body.item.clientTransactionId,method:"payphone",approve:true},DEMO);
  const ok=await call(store,"POST","/api/reservations/confirm",{clientTransactionId:retry.body.item.clientTransactionId,id:balance.body.id},DEMO);
  assert.equal(ok.body.item.status,"paid");
  assert.equal(ok.body.item.cardBrand,"Saldo PayPhone");
  await store.close();
});

test("la pasarela simulada no existe cuando PayPhone real está configurado",async()=>{
  const store=makeStore(),settings={mode:"payphone",token:"tok",storeId:""};
  const created=await call(store,"POST","/api/reservations",{vehicleId:6,...customer},{settings});
  const charge=await call(store,"POST","/api/sim-payphone/charge",{clientTransactionId:created.body.item.clientTransactionId,method:"card",cardNumber:"4111111111111111"},{settings});
  assert.equal(charge.status,404);
  await store.close();
});
