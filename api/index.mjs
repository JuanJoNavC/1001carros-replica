import { handleApi } from "../http-api.mjs";

export default async function handler(req,res){
  const incoming=new URL(req.url,`https://${req.headers.host||"localhost"}`);
  const rewritten=Array.isArray(req.query?.path)?req.query.path.join("/"):req.query?.path||incoming.searchParams.get("path")||"";
  incoming.pathname=`/api/${rewritten}`.replace(/\/+$/,"/").replace(/\/api\/$/,"/api");
  incoming.searchParams.delete("path");
  return handleApi(req,res,incoming);
}
