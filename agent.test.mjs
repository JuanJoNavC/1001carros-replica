import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { newDb } from "pg-mem";
import { createStore } from "./db.mjs";
import { handleApi } from "./http-api.mjs";
import { runTool, redactSensitive, sanitizeHistory, sanitizeContext, basePrompt, TOOLS, agentSettings } from "./agent.mjs";

const makeStore=()=>{const memory=newDb(),adapter=memory.adapters.createPg();return createStore(new adapter.Pool());};
async function call(store,method,path,body,deps={}){const req=Readable.from(body?[JSON.stringify(body)]:[]);req.method=method;req.url=path;req.headers={host:"localhost","content-type":"application/json"};let output="";const res={statusCode:200,setHeader(){},end(value=""){output+=value;}};await handleApi(req,res,new URL(path,"http://localhost"),store,deps);return {status:res.statusCode,body:JSON.parse(output)};}
const AGENT={enabled:true,apiKey:"test-key",model:"claude-haiku-5-5"};

// Modelo simulado: devuelve una secuencia de respuestas y guarda lo que recibió.
function fakeModel(replies){const sent=[];let i=0;return {sent,fetchImpl:async(url,options)=>{sent.push({url,headers:options.headers,body:JSON.parse(options.body)});const body=replies[Math.min(i++,replies.length-1)];return {ok:true,status:200,json:async()=>body};}};}
const toolUse=(name,input,id="t1")=>({stop_reason:"tool_use",content:[{type:"tool_use",id,name,input}]});
const final=text=>({stop_reason:"end_turn",content:[{type:"text",text}],usage:{input_tokens:100,output_tokens:20}});

test("instrucciones, conocimiento y herramientas cargados",()=>{
  const prompt=basePrompt();
  assert.match(prompt,/asesor virtual de \*\*1001Carros\.com\*\*/);
  assert.match(prompt,/100% reembolsables/);
  assert.ok(TOOLS.find(tool=>tool.name==="abrir_reserva"));
  assert.equal(agentSettings({}).enabled,false);
  assert.equal(agentSettings({ANTHROPIC_API_KEY:"x"}).model,"claude-haiku-5-5");
});

test("no se envían cédulas ni tarjetas al modelo",()=>{
  assert.equal(redactSensitive("mi cédula es 1700000019"),"mi cédula es [número oculto]");
  assert.equal(redactSensitive("tarjeta 4111 1111 1111 1111 ok"),"tarjeta [número oculto] ok");
  assert.equal(redactSensitive("tengo 20000 de entrada"),"tengo 20000 de entrada");
  const history=sanitizeHistory([{role:"assistant",text:"Hola"},{role:"user",text:"hola"},{role:"user",text:"busco suv"}]);
  assert.deepEqual(history,[{role:"user",content:"hola\nbusco suv"}]);
  assert.equal(sanitizeContext({applications:{"1":"tok","x":"bad"}}).applications["x"],undefined);
});

test("herramientas: buscar, cuota, cotizar, acciones seguras",async()=>{
  const store=makeStore();
  const search=await runTool("buscar_carros",{tipo:"suv",precio_max:30000,orden:"precio-asc"},{store});
  assert.ok(search.result.total>0);
  assert.ok(search.result.resultados.every(car=>car.precio<=30000&&car.tipo==="suv"));
  assert.ok(search.cars.length<=6);
  const byText=await runTool("buscar_carros",{texto:"toyota"},{store});
  assert.ok(byText.result.resultados.every(car=>/Toyota/.test(car.carro)));
  const quote=await runTool("calcular_cuota",{carro_id:1,plazo_meses:60},{store});
  assert.equal(quote.result.entrada_pct,25);
  assert.ok(quote.result.cuota_mensual>500);
  const tradein=await runTool("cotizar_mi_carro",{marca:"Toyota",modelo:"Corolla",anio:2018,kilometraje:80000},{store});
  assert.ok(tradein.result.estimado_desde<tradein.result.estimado_hasta||tradein.result.evaluacion);
  const reserve=await runTool("abrir_reserva",{carro_id:1},{store});
  assert.equal(reserve.actions[0].href,"/reserva/1");
  const prequal=await runTool("abrir_precalificacion",{carro_id:2},{store});
  assert.equal(prequal.actions[0].type,"prequal");
  const advisor=await runTool("hablar_con_asesor",{resumen:"Quiere negociar el precio. Cédula 1700000019"},{store});
  assert.match(advisor.actions[0].href,/^https:\/\/wa\.me\/593964141111\?text=/);
  assert.ok(!decodeURIComponent(advisor.actions[0].href).includes("1700000019"));
  const missing=await runTool("ver_carro",{carro_id:99999},{store});
  assert.match(missing.result.error,/No existe/);
  await store.close();
});

test("el agente usa herramientas y devuelve tarjetas y botones",async()=>{
  const store=makeStore();
  const model=fakeModel([toolUse("buscar_carros",{tipo:"suv",precio_max:30000}),toolUse("abrir_reserva",{carro_id:1},"t2"),final("Te recomiendo estas SUV. Puedes reservar el Corolla Cross aquí.")]);
  const reply=await call(store,"POST","/api/assistant/chat",{messages:[{role:"assistant",text:"Hola"},{role:"user",text:"Busco una SUV de menos de 30 mil, mi cédula es 1700000019"}],context:{page:"/vehiculo/1",vehicle:{id:1,label:"2024 Toyota Corolla Cross",price:32500}}},{agent:AGENT,fetchImpl:model.fetchImpl});
  assert.equal(reply.status,200,JSON.stringify(reply.body));
  assert.match(reply.body.text,/Te recomiendo/);
  assert.ok(reply.body.cars.length>0);
  assert.equal(reply.body.actions[0].href,"/reserva/1");
  const first=model.sent[0];
  assert.equal(first.headers["x-api-key"],"test-key");
  assert.equal(first.body.model,"claude-haiku-5-5");
  assert.ok(first.body.tools.length>=10);
  assert.ok(!JSON.stringify(first.body.messages).includes("1700000019"));
  assert.match(first.body.system[1].text,/Está viendo el carro id 1/);
  // El resultado de la herramienta se devuelve al modelo en la siguiente vuelta.
  const second=model.sent[1].body.messages;
  assert.equal(second.at(-1).content[0].type,"tool_result");
  await store.close();
});

test("sin clave el chat con IA está desactivado y el sitio usa el asistente por reglas",async()=>{
  const store=makeStore();
  assert.deepEqual((await call(store,"GET","/api/assistant/status",null,{agent:{enabled:false}})).body,{ai:false});
  assert.equal((await call(store,"POST","/api/assistant/chat",{messages:[{role:"user",text:"hola"}]},{agent:{enabled:false}})).status,503);
  await store.close();
});

test("si el servicio de IA falla, responde con un error amable",async()=>{
  const store=makeStore();
  const fetchImpl=async()=>({ok:false,status:500,json:async()=>({error:{message:"overloaded"}})});
  const reply=await call(store,"POST","/api/assistant/chat",{messages:[{role:"user",text:"hola"}]},{agent:AGENT,fetchImpl});
  assert.equal(reply.status,502);
  assert.match(reply.body.error,/asesor/);
  await store.close();
});
