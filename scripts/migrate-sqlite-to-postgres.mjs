import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { createStore } from "../db.mjs";

const sqlitePath=resolve(process.env.SQLITE_PATH||"data/1001carros.sqlite");
if(!process.env.DATABASE_URL)throw new Error("Falta DATABASE_URL para la base PostgreSQL de destino.");
if(!existsSync(sqlitePath))throw new Error(`No existe la base SQLite: ${sqlitePath}`);

const source=new DatabaseSync(sqlitePath,{readOnly:true}),pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1}),store=createStore(pool);
await store.initialize();
const client=await pool.connect();
const rows=table=>source.prepare(`SELECT * FROM ${table}`).all();

try{
  await client.query("BEGIN");
  const done=await client.query("SELECT value FROM app_meta WHERE key='sqlite_migration_complete'");
  if(done.rows.length&&!process.env.FORCE_SQLITE_MIGRATION)throw new Error("La migración SQLite ya fue ejecutada. Usa FORCE_SQLITE_MIGRATION=1 para repetirla.");

  const vehicleIds=new Map();
  for(const vehicle of rows("vehicles")){
    const values=[vehicle.code,vehicle.condition,vehicle.category,vehicle.city,vehicle.brand,vehicle.model,vehicle.year,vehicle.mileage,vehicle.drive,vehicle.transmission,vehicle.fuel,vehicle.engine,vehicle.color,vehicle.upholstery,vehicle.origin,vehicle.price,vehicle.monthly,vehicle.badge,vehicle.image,Boolean(vehicle.featured),vehicle.status];
    const result=await client.query("INSERT INTO vehicles (code,condition,category,city,brand,model,year,mileage,drive,transmission,fuel,engine,color,upholstery,origin,price,monthly,badge,image,featured,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) ON CONFLICT (code) DO UPDATE SET condition=EXCLUDED.condition,category=EXCLUDED.category,city=EXCLUDED.city,brand=EXCLUDED.brand,model=EXCLUDED.model,year=EXCLUDED.year,mileage=EXCLUDED.mileage,drive=EXCLUDED.drive,transmission=EXCLUDED.transmission,fuel=EXCLUDED.fuel,engine=EXCLUDED.engine,color=EXCLUDED.color,upholstery=EXCLUDED.upholstery,origin=EXCLUDED.origin,price=EXCLUDED.price,monthly=EXCLUDED.monthly,badge=EXCLUDED.badge,image=EXCLUDED.image,featured=EXCLUDED.featured,status=EXCLUDED.status RETURNING id",values);
    vehicleIds.set(vehicle.id,result.rows[0].id);
  }
  for(const agency of rows("agencies"))await client.query("INSERT INTO agencies (name,address,city,phone,hours,lat,lng) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (name) DO UPDATE SET address=EXCLUDED.address,city=EXCLUDED.city,phone=EXCLUDED.phone,hours=EXCLUDED.hours,lat=EXCLUDED.lat,lng=EXCLUDED.lng",[agency.name,agency.address,agency.city,agency.phone,agency.hours,agency.lat,agency.lng]);
  for(const brand of rows("brands"))await client.query("INSERT INTO brands (slug,name,models_seminuevos,models_nuevos,logo_svg,sort_order) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6) ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name,models_seminuevos=EXCLUDED.models_seminuevos,models_nuevos=EXCLUDED.models_nuevos,logo_svg=EXCLUDED.logo_svg,sort_order=EXCLUDED.sort_order",[brand.slug,brand.name,brand.models_seminuevos,brand.models_nuevos,brand.logo_svg,brand.sort_order]);

  const userIds=new Map();
  for(const user of rows("users")){const result=await client.query("INSERT INTO users (name,email,password_hash,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name,password_hash=EXCLUDED.password_hash RETURNING id",[user.name,user.email,user.password_hash,user.created_at]);userIds.set(user.id,result.rows[0].id);}
  for(const lead of rows("leads"))await client.query("INSERT INTO leads (kind,name,email,phone,vehicle_id,plate,message,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",[lead.kind,lead.name,lead.email,lead.phone,lead.vehicle_id?vehicleIds.get(lead.vehicle_id)||null:null,lead.plate,lead.message,lead.status,lead.created_at]);
  for(const favorite of rows("favorites")){const userId=userIds.get(favorite.user_id),vehicleId=vehicleIds.get(favorite.vehicle_id);if(userId&&vehicleId)await client.query("INSERT INTO favorites (user_id,vehicle_id,created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",[userId,vehicleId,favorite.created_at]);}
  await client.query("INSERT INTO app_meta (key,value) VALUES ('sqlite_migration_complete',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",[new Date().toISOString()]);
  await client.query("COMMIT");
  console.log(`Migración completada desde ${sqlitePath}`);
}catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();source.close();await store.close();}
