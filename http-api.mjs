import { randomBytes } from "node:crypto";
import { getStore, hashPassword, verifyPassword } from "./db.mjs";
import { RESERVATION_AMOUNT_CENTS, PAYPHONE_BOX_CSS, PAYPHONE_BOX_JS, paymentSettings, newClientTransactionId, validateReservationInput, buildPaymentBox, confirmWithPayphone, publicReservation, simulateCharge, simulatedAuthorizationCode, simulatedConfirmBody, interpretConfirmation, APPROVED } from "./payments.mjs";

const json=(res,status,value)=>{res.statusCode=status;res.setHeader("content-type","application/json; charset=utf-8");res.setHeader("cache-control","no-store");res.end(JSON.stringify(value));};
const readBody=async req=>{if(req.body&&typeof req.body==="object")return req.body;const chunks=[];for await(const chunk of req)chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));const text=Buffer.concat(chunks).toString("utf8");return text?JSON.parse(text):{};};
const bearer=req=>(req.headers.authorization||"").replace(/^Bearer\s+/i,"");

export async function handleApi(req,res,url=new URL(req.url,`http://${req.headers.host||"localhost"}`),store=getStore(),deps={}){
  const settings=deps.settings||paymentSettings(),fetchImpl=deps.fetchImpl||fetch;
  try{
    const path=url.pathname;
    if(req.method==="GET"&&path==="/api/vehicles")return json(res,200,{items:await store.listVehicles(Object.fromEntries(url.searchParams))});
    if(req.method==="GET"&&/^\/api\/vehicles\/\d+$/.test(path)){const item=await store.getVehicle(Number(path.split("/").pop()));return item?json(res,200,{item}):json(res,404,{error:"Vehículo no encontrado"});}
    if(req.method==="GET"&&path==="/api/agencies")return json(res,200,{items:await store.listAgencies()});
    if(req.method==="GET"&&path==="/api/brands"){const condition=url.searchParams.get("condition")==="nuevos"?"nuevos":"seminuevos";return json(res,200,{condition,items:await store.listBrands(condition)});}
    if(req.method==="GET"&&path==="/api/stats")return json(res,200,await store.stats());
    if(req.method==="POST"&&path==="/api/leads"){const data=await readBody(req);if(!data.kind||(!data.phone&&!data.email))return json(res,400,{error:"Ingresa un teléfono o correo"});const id=await store.createLead(data);return json(res,201,{id,message:"Solicitud recibida"});}
    if(req.method==="POST"&&path==="/api/auth/register"){const data=await readBody(req);if(!data.name||!data.email||String(data.password||"").length<6)return json(res,400,{error:"Completa los datos; la clave debe tener 6 caracteres"});try{const user=await store.registerUser({name:data.name,email:data.email.toLowerCase(),passwordHash:hashPassword(data.password)}),token=randomBytes(24).toString("hex");await store.createSession(user.id,token);return json(res,201,{token,user});}catch(error){if(error.code==="23505")return json(res,409,{error:"Ese correo ya está registrado"});throw error;}}
    if(req.method==="POST"&&path==="/api/auth/login"){const data=await readBody(req),row=await store.findUserByEmail(String(data.email||"").toLowerCase());if(!row||!verifyPassword(data.password||"",row.password_hash))return json(res,401,{error:"Correo o contraseña incorrectos"});const user={id:row.id,name:row.name,email:row.email},token=randomBytes(24).toString("hex");await store.createSession(user.id,token);return json(res,200,{token,user});}
    if(path==="/api/favorites"&&req.method==="GET"){const user=await store.sessionUser(bearer(req));if(!user)return json(res,401,{error:"Inicia sesión"});return json(res,200,{items:await store.listFavorites(user.id)});}
    if(/^\/api\/favorites\/\d+$/.test(path)&&["POST","DELETE"].includes(req.method)){const user=await store.sessionUser(bearer(req));if(!user)return json(res,401,{error:"Inicia sesión"});const vehicleId=Number(path.split("/").pop());if(req.method==="POST")await store.saveFavorite(user.id,vehicleId);else await store.deleteFavorite(user.id,vehicleId);return json(res,req.method==="POST"?201:200,{saved:req.method==="POST"});}
    if(req.method==="POST"&&path==="/api/reservations")return await createReservationRoute(req,res,store,settings);
    if(req.method==="POST"&&path==="/api/reservations/confirm")return await confirmReservationRoute(req,res,store,settings,fetchImpl);
    if(req.method==="POST"&&path==="/api/sim-payphone/charge")return await simulatedChargeRoute(req,res,store,settings);
    if(req.method==="GET"&&/^\/api\/reservations\/[A-Za-z0-9-]{1,50}$/.test(path)){const row=await store.getReservation(path.split("/").pop());if(!row)return json(res,404,{error:"Reserva no encontrada"});return json(res,200,{item:publicReservation(row,await store.getVehicle(row.vehicle_id))});}
    return json(res,404,{error:"Ruta de API no encontrada"});
  }catch(error){console.error("API error",error);return json(res,500,{error:"Error interno",detail:process.env.NODE_ENV==="development"?error.message:undefined});}
}

const FIELD_ERRORS={vehicleId:"Vehículo no válido",agencyId:"Agencia no válida",name:"Escribe tu nombre completo",email:"Escribe un correo válido",phone:"Escribe un celular válido (ej. 0991234567)",documentId:"La cédula o RUC debe tener 10 o 13 dígitos"};

async function createReservationRoute(req,res,store,settings){
  const check=validateReservationInput(await readBody(req));
  if(!check.ok)return json(res,400,{error:FIELD_ERRORS[check.errors[0]],fields:check.errors});
  const input=check.value,vehicle=await store.getVehicle(input.vehicleId);
  if(!vehicle)return json(res,404,{error:"Vehículo no encontrado"});
  if(vehicle.status!=="available")return json(res,409,{error:"Este vehículo ya está reservado"});
  if(input.agencyId!==null&&!(await store.getAgency(input.agencyId)))return json(res,400,{error:FIELD_ERRORS.agencyId});
  const row=await store.createReservation({...input,clientTransactionId:newClientTransactionId(),amountCents:RESERVATION_AMOUNT_CENTS,mode:settings.mode});
  await store.createLead({kind:"reservation",name:input.name,email:input.email,phone:input.phone,vehicleId:input.vehicleId,message:`Reserva ${row.client_tx_id} iniciada (pago pendiente)`});
  const payload={item:publicReservation(row,vehicle),mode:settings.mode};
  if(settings.mode==="payphone")payload.payphone={css:PAYPHONE_BOX_CSS,js:PAYPHONE_BOX_JS,config:buildPaymentBox(row,vehicle,settings)};
  return json(res,201,payload);
}

async function confirmReservationRoute(req,res,store,settings,fetchImpl){
  const data=await readBody(req),clientTransactionId=String(data.clientTransactionId||"").slice(0,50);
  const row=clientTransactionId&&await store.getReservation(clientTransactionId);
  if(!row)return json(res,404,{error:"Reserva no encontrada"});
  const vehicle=await store.getVehicle(row.vehicle_id);
  if(row.status!=="pending")return json(res,200,{item:publicReservation(row,vehicle)});
  let result;
  if(row.mode==="demo"){
    // Solo se simula si la reserva nació en modo demo Y el servidor sigue sin credenciales.
    if(settings.mode!=="demo")return json(res,409,{error:"Esta reserva debe pagarse con PayPhone"});
    const sim=Number.isInteger(Number(data.id))&&Number(data.id)>0?await store.getSimPayment(Number(data.id)):null;
    if(!sim||sim.client_tx_id!==row.client_tx_id)return json(res,400,{error:"No encontramos la transacción de esta reserva"});
    result=interpretConfirmation(simulatedConfirmBody(sim,row),row);
  }else{
    if(settings.mode!=="payphone")return json(res,503,{error:"Los pagos con PayPhone no están configurados en el servidor"});
    const id=Number(data.id);
    if(!Number.isInteger(id)||id<=0)return json(res,400,{error:"Falta el identificador de PayPhone"});
    try{result=await confirmWithPayphone({id,reservation:row,settings,fetchImpl});}
    catch(error){console.error("PayPhone confirm error",error);return json(res,502,{error:"No pudimos comunicarnos con PayPhone. Intenta de nuevo en un momento."});}
  }
  let updated;
  if(result.status==="paid"){
    updated=await store.markReservationPaid(clientTransactionId,result.payment);
    await store.createLead({kind:"reservation",name:row.name,email:row.email,phone:row.phone,vehicleId:row.vehicle_id,message:`Reserva ${row.client_tx_id} pagada (USD ${row.amount_cents/100}${row.mode==="demo"?", demostración":""})`});
  }else updated=await store.markReservationFailed(clientTransactionId,result.status==="canceled"?"canceled":"failed",result.reason);
  return json(res,200,{item:publicReservation(updated,await store.getVehicle(row.vehicle_id)),reason:result.reason});
}

async function simulatedChargeRoute(req,res,store,settings){
  if(settings.mode!=="demo")return json(res,404,{error:"Ruta de API no encontrada"});
  const data=await readBody(req),row=await store.getReservation(String(data.clientTransactionId||"").slice(0,50));
  if(!row)return json(res,404,{error:"Reserva no encontrada"});
  if(row.status!=="pending")return json(res,409,{error:"Esta reserva ya fue procesada"});
  const outcome=simulateCharge({method:data.method,cardNumber:data.cardNumber,approve:data.approve});
  if(outcome.error)return json(res,400,{error:outcome.error});
  const sim=await store.createSimPayment({clientTransactionId:row.client_tx_id,method:outcome.method,statusCode:outcome.statusCode,amountCents:row.amount_cents,cardBrand:outcome.cardBrand,lastDigits:outcome.lastDigits,authorizationCode:outcome.statusCode===APPROVED?simulatedAuthorizationCode():null,message:outcome.message});
  // Igual que PayPhone: se devuelve el id de la transacción para redirigir a la URL de respuesta.
  return json(res,201,{id:sim.id,clientTransactionId:row.client_tx_id,statusCode:sim.status_code});
}
