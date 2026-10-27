import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { newDb } from "pg-mem";
import { createStore } from "./db.mjs";
import { handleApi } from "./http-api.mjs";

const makeStore=()=>{const memory=newDb(),adapter=memory.adapters.createPg();return createStore(new adapter.Pool());};
async function call(store,method,path,body,headers={}){const req=Readable.from(body?[JSON.stringify(body)]:[]);req.method=method;req.url=path;req.headers={host:"localhost","content-type":"application/json",...headers};const responseHeaders={};let output="";const res={statusCode:200,setHeader(name,value){responseHeaders[name]=value;},end(value=""){output+=value;}};await handleApi(req,res,new URL(path,"http://localhost"),store);return {status:res.statusCode,headers:responseHeaders,body:JSON.parse(output)};}

test("la API PostgreSQL sirve catálogo y persiste una sesión",async()=>{
  const store=makeStore();
  const catalog=await call(store,"GET","/api/vehicles?catalogType=usados");
  assert.equal(catalog.status,200);
  assert.ok(catalog.body.items.length>0);
  const registration=await call(store,"POST","/api/auth/register",{name:"Cliente","email":"cliente@example.com","password":"secreto123"});
  assert.equal(registration.status,201);
  const saved=await call(store,"POST","/api/favorites/1",null,{authorization:`Bearer ${registration.body.token}`});
  assert.equal(saved.status,201);
  const favorites=await call(store,"GET","/api/favorites",null,{authorization:`Bearer ${registration.body.token}`});
  assert.equal(favorites.body.items.length,1);
  await store.close();
});
