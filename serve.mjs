import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { handleApi } from "./http-api.mjs";
import { getStore } from "./db.mjs";

const root=fileURLToPath(new URL(".",import.meta.url));
const port=Number(process.env.PORT||4173);
const types={".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".mjs":"text/javascript; charset=utf-8",".json":"application/json; charset=utf-8",".svg":"image/svg+xml",".png":"image/png",".jpg":"image/jpeg",".webp":"image/webp"};

await getStore().initialize();
const server=createServer(async(req,res)=>{const url=new URL(req.url,`http://${req.headers.host||"localhost"}`);try{if(url.pathname.startsWith("/api/"))return await handleApi(req,res,url);const relative=url.pathname==="/"?"index.html":url.pathname.replace(/^\/+/ ,""),candidate=normalize(join(root,relative));if(candidate.startsWith(root)&&extname(candidate)){const data=await readFile(candidate);res.writeHead(200,{"content-type":types[extname(candidate)]||"application/octet-stream"});return res.end(data);}const html=await readFile(join(root,"index.html"));res.writeHead(200,{"content-type":"text/html; charset=utf-8"});res.end(html);}catch(error){if(!res.headersSent){res.writeHead(500,{"content-type":"application/json; charset=utf-8"});res.end(JSON.stringify({error:"Error interno",detail:process.env.NODE_ENV==="development"?error.message:undefined}));}}});
server.listen(port,"127.0.0.1",()=>console.log(`1001Carros disponible en http://127.0.0.1:${port}\nPostgreSQL conectado`));
for(const signal of ["SIGINT","SIGTERM"])process.once(signal,()=>server.close(async()=>{await getStore().close();process.exit(0);}));
export{server};
