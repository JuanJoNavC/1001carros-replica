import { randomBytes } from "node:crypto";
import { getStore, hashPassword, verifyPassword } from "./db.mjs";
import { CONSENT_VERSION, REUSE_HOURS, bureauSettings, queryBureau, decideCredit, validatePrequalInput, publicReport, hashCedula, maskCedula, newFolio } from "./bureau.mjs";
import { RESERVATION_AMOUNT_CENTS, PAYPHONE_BOX_CSS, PAYPHONE_BOX_JS, paymentSettings, newClientTransactionId, validateReservationInput, buildPaymentBox, confirmWithPayphone, publicReservation, simulateCharge, simulatedAuthorizationCode, simulatedConfirmBody, interpretConfirmation, APPROVED, HOLD_HOURS, MAX_RESERVATIONS_PER_DAY, MAX_SIM_CHARGES, OTP_TTL_MINUTES, OTP_MAX_ATTEMPTS, OTP_RESEND_SECONDS, OTP_MAX_SENDS, normalizePhone, maskPhone, newOtpCode, hashOtp, isValidDocument, messagingSettings } from "./payments.mjs";

const json=(res,status,value)=>{res.statusCode=status;res.setHeader("content-type","application/json; charset=utf-8");res.setHeader("cache-control","no-store");res.end(JSON.stringify(value));};
const readBody=async req=>{if(req.body&&typeof req.body==="object")return req.body;const chunks=[];for await(const chunk of req)chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));const text=Buffer.concat(chunks).toString("utf8");return text?JSON.parse(text):{};};
const bearer=req=>(req.headers.authorization||"").replace(/^Bearer\s+/i,"");

export async function handleApi(req,res,url=new URL(req.url,`http://${req.headers.host||"localhost"}`),store=getStore(),deps={}){
  const settings=deps.settings||paymentSettings(),fetchImpl=deps.fetchImpl||fetch,now=deps.now||(()=>new Date()),messaging=deps.messaging||messagingSettings(),bureau=deps.bureau||bureauSettings();
  try{
    const path=url.pathname;
    if(req.method==="GET"&&path==="/api/vehicles"){await store.releaseExpired(now());}if(req.method==="GET"&&path==="/api/vehicles")return json(res,200,{items:await store.listVehicles(Object.fromEntries(url.searchParams))});
    if(req.method==="GET"&&/^\/api\/vehicles\/\d+$/.test(path)){await store.releaseExpired(now());const item=await store.getVehicle(Number(path.split("/").pop()));return item?json(res,200,{item}):json(res,404,{error:"Vehículo no encontrado"});}
    if(req.method==="GET"&&path==="/api/agencies")return json(res,200,{items:await store.listAgencies()});
    if(req.method==="GET"&&path==="/api/brands"){const condition=url.searchParams.get("condition")==="nuevos"?"nuevos":"seminuevos";return json(res,200,{condition,items:await store.listBrands(condition)});}
    if(req.method==="GET"&&path==="/api/stats")return json(res,200,await store.stats());
    if(req.method==="POST"&&path==="/api/leads"){const data=await readBody(req);if(!data.kind||(!data.phone&&!data.email))return json(res,400,{error:"Ingresa un teléfono o correo"});const id=await store.createLead(data);return json(res,201,{id,message:"Solicitud recibida"});}
    if(req.method==="POST"&&path==="/api/auth/register"){const data=await readBody(req);if(!data.name||!data.email||String(data.password||"").length<6)return json(res,400,{error:"Completa los datos; la clave debe tener 6 caracteres"});try{const user=await store.registerUser({name:data.name,email:data.email.toLowerCase(),passwordHash:hashPassword(data.password)}),token=randomBytes(24).toString("hex");await store.createSession(user.id,token);return json(res,201,{token,user});}catch(error){if(error.code==="23505")return json(res,409,{error:"Ese correo ya está registrado"});throw error;}}
    if(req.method==="POST"&&path==="/api/auth/login"){const data=await readBody(req),row=await store.findUserByEmail(String(data.email||"").toLowerCase());if(!row||!verifyPassword(data.password||"",row.password_hash))return json(res,401,{error:"Correo o contraseña incorrectos"});const user={id:row.id,name:row.name,email:row.email},token=randomBytes(24).toString("hex");await store.createSession(user.id,token);return json(res,200,{token,user});}
    if(path==="/api/favorites"&&req.method==="GET"){const user=await store.sessionUser(bearer(req));if(!user)return json(res,401,{error:"Inicia sesión"});return json(res,200,{items:await store.listFavorites(user.id)});}
    if(/^\/api\/favorites\/\d+$/.test(path)&&["POST","DELETE"].includes(req.method)){const user=await store.sessionUser(bearer(req));if(!user)return json(res,401,{error:"Inicia sesión"});const vehicleId=Number(path.split("/").pop());if(req.method==="POST")await store.saveFavorite(user.id,vehicleId);else await store.deleteFavorite(user.id,vehicleId);return json(res,req.method==="POST"?201:200,{saved:req.method==="POST"});}
    if(req.method==="POST"&&path==="/api/prequalification")return await prequalificationRoute(req,res,store,bureau,now);
    if(req.method==="POST"&&path==="/api/reservations")return await createReservationRoute(req,res,store,settings,now,messaging);
    if(req.method==="POST"&&path==="/api/reservations/verify")return await verifyReservationRoute(req,res,store,settings,now);
    if(req.method==="POST"&&path==="/api/reservations/resend")return await resendCodeRoute(req,res,store,now,messaging);
    if(req.method==="POST"&&/^\/api\/reservations\/[A-Za-z0-9-]{1,50}\/(document|visit)$/.test(path))return await updatePaidReservationRoute(req,res,store,now,path.split("/")[3],path.split("/")[4]);
    if(req.method==="POST"&&path==="/api/reservations/confirm")return await confirmReservationRoute(req,res,store,settings,fetchImpl,now);
    if(req.method==="POST"&&path==="/api/sim-payphone/charge")return await simulatedChargeRoute(req,res,store,settings);
    if(req.method==="GET"&&/^\/api\/reservations\/[A-Za-z0-9-]{1,50}$/.test(path)){const row=await store.getReservation(path.split("/").pop());if(!row)return json(res,404,{error:"Reserva no encontrada"});return json(res,200,{item:publicReservation(row,await store.getVehicle(row.vehicle_id))});}
    return json(res,404,{error:"Ruta de API no encontrada"});
  }catch(error){console.error("API error",error);return json(res,500,{error:"Error interno",detail:process.env.NODE_ENV==="development"?error.message:undefined});}
}

const FIELD_ERRORS={vehicleId:"Vehículo no válido",agencyId:"Agencia no válida",name:"Escribe tu nombre completo",email:"Escribe un correo válido",phone:"Escribe un celular válido (ej. 0991234567)",documentId:"Revisa tu cédula o RUC"};

function activeReservationError(active){return {error:`Ya tienes una reserva activa (código ${active.client_tx_id}). Si quieres cambiar de carro, escríbenos y te ayudamos.`,code:"active_reservation"};}

async function sendCode(store,row,now,messaging){
  const code=newOtpCode(),sentAt=now();
  const updated=await store.setOtp(row.client_tx_id,{hash:hashOtp(code,row.client_tx_id),expiresAt:new Date(sentAt.getTime()+OTP_TTL_MINUTES*60000),sentAt});
  // Sin proveedor de WhatsApp/SMS el código se devuelve para mostrarlo en pantalla (simulación).
  // Con OTP_PROVIDER aquí se enviaría por WhatsApp Business o SMS y NO se devolvería.
  return {row:updated,verification:{channel:"whatsapp",sentTo:maskPhone(row.phone),expiresInMinutes:OTP_TTL_MINUTES,resendInSeconds:OTP_RESEND_SECONDS,simulated:messaging.mode==="demo",...(messaging.mode==="demo"?{demoCode:code}:{})}};
}

function paymentPayload(row,vehicle,settings){const payload={item:publicReservation(row,vehicle),mode:settings.mode};if(settings.mode==="payphone")payload.payphone={css:PAYPHONE_BOX_CSS,js:PAYPHONE_BOX_JS,config:buildPaymentBox(row,vehicle,settings)};return payload;}

async function createReservationRoute(req,res,store,settings,now,messaging){
  const check=validateReservationInput(await readBody(req));
  if(!check.ok)return json(res,400,{error:FIELD_ERRORS[check.errors[0]],fields:check.errors});
  const input=check.value,phoneNorm=normalizePhone(input.phone),current=now();
  await store.releaseExpired(current);
  // Capa 1: límite de intentos y una reserva activa por persona (celular o correo).
  if(await store.countRecentReservations(phoneNorm,input.email,new Date(current.getTime()-24*3600000))>=MAX_RESERVATIONS_PER_DAY)return json(res,429,{error:"Hiciste muchos intentos de reserva hoy. Escríbenos por WhatsApp y te ayudamos a completarla.",code:"too_many"});
  const active=await store.activeReservationFor(phoneNorm,input.email,current);
  if(active)return json(res,409,activeReservationError(active));
  const vehicle=await store.getVehicle(input.vehicleId);
  if(!vehicle)return json(res,404,{error:"Vehículo no encontrado"});
  if(vehicle.status!=="available")return json(res,409,{error:"Este vehículo ya está reservado"});
  if(input.agencyId!==null&&!(await store.getAgency(input.agencyId)))return json(res,400,{error:FIELD_ERRORS.agencyId});
  const row=await store.createReservation({...input,phoneNorm,clientTransactionId:newClientTransactionId(current),amountCents:RESERVATION_AMOUNT_CENTS,mode:settings.mode});
  await store.createLead({kind:"reservation",name:input.name,email:input.email,phone:input.phone,vehicleId:input.vehicleId,message:`Reserva ${row.client_tx_id} iniciada (verificación de celular pendiente)`});
  // Capa 2: código de verificación al celular antes de habilitar el pago.
  const sent=await sendCode(store,row,now,messaging);
  return json(res,201,{item:publicReservation(sent.row,vehicle),mode:settings.mode,verification:sent.verification});
}

async function verifyReservationRoute(req,res,store,settings,now){
  const data=await readBody(req),row=await store.getReservation(String(data.clientTransactionId||"").slice(0,50));
  if(!row)return json(res,404,{error:"Reserva no encontrada"});
  if(row.status!=="pending")return json(res,409,{error:"Esta reserva ya fue procesada"});
  const vehicle=await store.getVehicle(row.vehicle_id);
  if(row.phone_verified_at)return json(res,200,paymentPayload(row,vehicle,settings));
  if(!row.otp_hash||new Date(row.otp_expires_at)<=now())return json(res,400,{error:"El código venció. Pide uno nuevo.",code:"otp_expired"});
  if(row.otp_attempts>=OTP_MAX_ATTEMPTS)return json(res,429,{error:"Demasiados intentos. Pide un código nuevo.",code:"otp_locked"});
  const code=String(data.code||"").replace(/\D/g,"");
  if(hashOtp(code,row.client_tx_id)!==row.otp_hash){const updated=await store.addOtpAttempt(row.client_tx_id),left=Math.max(0,OTP_MAX_ATTEMPTS-updated.otp_attempts);return json(res,400,{error:left?`Código incorrecto. Te quedan ${left} intentos.`:"Demasiados intentos. Pide un código nuevo.",code:left?"otp_wrong":"otp_locked"});}
  const active=await store.activeReservationFor(row.phone_norm,row.email,now());
  if(active)return json(res,409,activeReservationError(active));
  if(vehicle.status!=="available")return json(res,409,{error:"Este vehículo ya está reservado"});
  const verified=await store.markPhoneVerified(row.client_tx_id,now());
  return json(res,200,paymentPayload(verified,vehicle,settings));
}

async function resendCodeRoute(req,res,store,now,messaging){
  const data=await readBody(req),row=await store.getReservation(String(data.clientTransactionId||"").slice(0,50));
  if(!row)return json(res,404,{error:"Reserva no encontrada"});
  if(row.status!=="pending"||row.phone_verified_at)return json(res,409,{error:"Este celular ya fue verificado"});
  const wait=row.otp_sent_at?Math.ceil((new Date(row.otp_sent_at).getTime()+OTP_RESEND_SECONDS*1000-now().getTime())/1000):0;
  if(wait>0)return json(res,429,{error:`Espera ${wait} segundos para pedir otro código.`,code:"otp_wait",retryInSeconds:wait});
  if(row.otp_sends>=OTP_MAX_SENDS)return json(res,429,{error:"Ya enviamos varios códigos. Escríbenos por WhatsApp y te ayudamos.",code:"otp_max_sends"});
  const sent=await sendCode(store,row,now,messaging);
  return json(res,200,{verification:sent.verification});
}

async function updatePaidReservationRoute(req,res,store,now,clientTransactionId,field){
  const row=await store.getReservation(clientTransactionId);
  if(!row)return json(res,404,{error:"Reserva no encontrada"});
  if(row.status!=="paid")return json(res,409,{error:"Solo puedes completar datos de una reserva pagada"});
  const data=await readBody(req);
  let updated;
  if(field==="document"){const documentId=String(data.documentId||"").replace(/\D/g,"");if(!isValidDocument(documentId))return json(res,400,{error:"Revisa tu cédula (10 dígitos) o RUC (13 dígitos)."});updated=await store.setReservationDocument(clientTransactionId,documentId);}
  else{const visitAt=new Date(data.visitAt),current=now(),limit=row.expires_at?new Date(row.expires_at):null;
    if(Number.isNaN(visitAt.getTime())||visitAt.getTime()<current.getTime()+3600000)return json(res,400,{error:"Elige una fecha y hora futuras."});
    if(limit&&visitAt>limit)return json(res,400,{error:"Elige una fecha dentro del plazo de tu reserva."});
    updated=await store.setReservationVisit(clientTransactionId,visitAt);
    await store.createLead({kind:"reservation",name:row.name,email:row.email,phone:row.phone,vehicleId:row.vehicle_id,message:`Reserva ${row.client_tx_id}: visita agendada para ${visitAt.toISOString()}`});}
  return json(res,200,{item:publicReservation(updated,await store.getVehicle(row.vehicle_id))});
}

async function confirmReservationRoute(req,res,store,settings,fetchImpl,now){
  const data=await readBody(req),clientTransactionId=String(data.clientTransactionId||"").slice(0,50);
  const row=clientTransactionId&&await store.getReservation(clientTransactionId);
  if(!row)return json(res,404,{error:"Reserva no encontrada"});
  const vehicle=await store.getVehicle(row.vehicle_id);
  if(row.status!=="pending")return json(res,200,{item:publicReservation(row,vehicle)});
  if(!row.phone_verified_at)return json(res,409,{error:"Primero verifica tu celular"});
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
    updated=await store.markReservationPaid(clientTransactionId,{...result.payment,expiresAt:new Date(now().getTime()+HOLD_HOURS*3600000)});
    await store.createLead({kind:"reservation",name:row.name,email:row.email,phone:row.phone,vehicleId:row.vehicle_id,message:`Reserva ${row.client_tx_id} pagada (USD ${row.amount_cents/100}${row.mode==="demo"?", demostración":""})`});
  }else updated=await store.markReservationFailed(clientTransactionId,result.status==="canceled"?"canceled":"failed",result.reason);
  return json(res,200,{item:publicReservation(updated,await store.getVehicle(row.vehicle_id)),reason:result.reason});
}

async function simulatedChargeRoute(req,res,store,settings){
  if(settings.mode!=="demo")return json(res,404,{error:"Ruta de API no encontrada"});
  const data=await readBody(req),row=await store.getReservation(String(data.clientTransactionId||"").slice(0,50));
  if(!row)return json(res,404,{error:"Reserva no encontrada"});
  if(row.status!=="pending")return json(res,409,{error:"Esta reserva ya fue procesada"});
  if(!row.phone_verified_at)return json(res,409,{error:"Primero verifica tu celular"});
  if(await store.countSimPayments(row.client_tx_id)>=MAX_SIM_CHARGES)return json(res,429,{error:"Superaste el número de intentos de pago para esta reserva. Inicia una nueva o escríbenos.",code:"too_many_payments"});
  const outcome=simulateCharge({method:data.method,cardNumber:data.cardNumber,approve:data.approve});
  if(outcome.error)return json(res,400,{error:outcome.error});
  const sim=await store.createSimPayment({clientTransactionId:row.client_tx_id,method:outcome.method,statusCode:outcome.statusCode,amountCents:row.amount_cents,cardBrand:outcome.cardBrand,lastDigits:outcome.lastDigits,authorizationCode:outcome.statusCode===APPROVED?simulatedAuthorizationCode():null,message:outcome.message});
  // Igual que PayPhone: se devuelve el id de la transacción para redirigir a la URL de respuesta.
  return json(res,201,{id:sim.id,clientTransactionId:row.client_tx_id,statusCode:sim.status_code});
}

async function prequalificationRoute(req,res,store,bureau,now){
  const input=validatePrequalInput(await readBody(req));
  if(input.error)return json(res,400,{error:input.error});
  const vehicle=await store.getVehicle(input.vehicleId);
  if(!vehicle)return json(res,404,{error:"Vehículo no encontrado"});
  const current=now(),cedulaHash=hashCedula(input.cedula);
  // Una misma cédula no se vuelve a consultar al buró dentro de 24 h: se reutiliza el reporte (evita costos y consultas repetidas).
  const previous=await store.lastBureauInquiry(cedulaHash,new Date(current.getTime()-REUSE_HOURS*3600000));
  let report;
  try{report=previous?previous.report:await queryBureau(input.cedula,bureau);}
  catch(error){console.error("Bureau error",error);return json(res,502,{error:"No pudimos consultar el buró en este momento. Intenta de nuevo en unos minutos."});}
  const decision=decideCredit({report,income:input.income,price:Number(vehicle.price)});
  const row=await store.createBureauInquiry({folio:newFolio(current),cedulaHash,cedulaMasked:maskCedula(input.cedula),vehicleId:vehicle.id,income:input.income,provider:previous?previous.provider:bureau.provider,consentVersion:CONSENT_VERSION,consentAt:current,report,decisionStatus:decision.status,decision,reusedFrom:previous?.folio,createdAt:current});
  await store.createLead({kind:"prequalification",vehicleId:vehicle.id,message:`Precalificación ${row.folio}: ${decision.status} (score ${report.score??"sin historial"}, ingreso USD ${input.income})`});
  return json(res,201,{folio:row.folio,provider:row.provider==="simulado"?"Buró de prueba (simulado)":row.provider,consultedAt:current.toISOString(),reused:Boolean(previous),consentVersion:CONSENT_VERSION,cedulaMasked:row.cedula_masked,report:publicReport(report),decision});
}
