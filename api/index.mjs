import { handleApi } from "../http-api.mjs";

export default async function handler(req,res){
  try{
    const incoming=new URL(req.url,`https://${req.headers.host||"localhost"}`);
    const rewritten=Array.isArray(req.query?.path)?req.query.path.join("/"):req.query?.path||incoming.searchParams.get("path")||"";
    incoming.pathname=`/api/${rewritten}`.replace(/\/+$/,"/").replace(/\/api\/$/,"/api");
    incoming.searchParams.delete("path");
    return await handleApi(req,res,incoming);
  }catch(error){
    console.error("API bootstrap error",error);
    res.statusCode=500;
    res.setHeader("content-type","application/json; charset=utf-8");
    res.end(JSON.stringify({error:"No se pudo iniciar la API. Verifica la configuración de PostgreSQL."}));
  }
}
