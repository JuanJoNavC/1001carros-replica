import { randomBytes } from "node:crypto";
import { getStore, hashPassword, verifyPassword } from "./db.mjs";

const json=(res,status,value)=>{res.statusCode=status;res.setHeader("content-type","application/json; charset=utf-8");res.setHeader("cache-control","no-store");res.end(JSON.stringify(value));};
const readBody=async req=>{if(req.body&&typeof req.body==="object")return req.body;const chunks=[];for await(const chunk of req)chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));const text=Buffer.concat(chunks).toString("utf8");return text?JSON.parse(text):{};};
const bearer=req=>(req.headers.authorization||"").replace(/^Bearer\s+/i,"");

export async function handleApi(req,res,url=new URL(req.url,`http://${req.headers.host||"localhost"}`),store=getStore()){
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
    return json(res,404,{error:"Ruta de API no encontrada"});
  }catch(error){console.error("API error",error);return json(res,500,{error:"Error interno",detail:process.env.NODE_ENV==="development"?error.message:undefined});}
}
