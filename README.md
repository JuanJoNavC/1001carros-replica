# 1001Carros — réplica funcional

Aplicación multipágina inspirada en la experiencia pública de 1001Carros.com. Es un prototipo independiente y no está afiliado a la marca.

## Requisitos

- Node.js 24.
- PostgreSQL 16 o una base compatible, como Neon o Supabase.

## Ejecutar localmente

1. Inicia PostgreSQL con Docker:

```bash
docker compose up -d postgres
```

2. Crea la configuración local:

```bash
cp .env.example .env
set -a && source .env && set +a
```

3. Instala dependencias e inicia la aplicación:

```bash
npm install
npm run dev
```

Abre `http://127.0.0.1:4173`.

La primera conexión crea las tablas e inyecta automáticamente el catálogo, las marcas y las agencias. `DATABASE_URL` es obligatoria; `PG_POOL_MAX` controla el máximo de conexiones por proceso.

## Rutas

- `/` — inicio.
- `/catalogo` — inventario filtrable de usados y nuevos. Las rutas anteriores `/nuevos`, `/seminuevos` y `/usados` redirigen aquí por compatibilidad.
- `/vehiculo/:id` — ficha, precio, financiamiento, garantías y contacto.
- `/vender` — captación y valoración de vehículos.
- `/financiamiento` — simulador y solicitud de asesoría.
- `/agencias` — puntos de venta por ciudad.
- `/login` — registro, sesión local y cuenta.
- `/favoritos` — selección persistente.
- `/contacto` — formulario de atención.

## Persistencia PostgreSQL

PostgreSQL contiene las tablas `vehicles`, `brands`, `agencies`, `leads`, `users`, `favorites`, `sessions` y `app_meta`. Los formularios crean registros reales en `leads`; las cuentas, favoritos y sesiones también son persistentes. Las sesiones vencen después de 30 días.

### Migrar una base SQLite anterior

Con la base PostgreSQL disponible y `DATABASE_URL` configurada:

```bash
SQLITE_PATH=data/1001carros.sqlite npm run db:migrate:sqlite
```

El proceso conserva catálogo, cuentas, prospectos y favoritos. La migración se marca como completada para evitar duplicar prospectos accidentalmente. Para repetirla de manera consciente, usa `FORCE_SQLITE_MIGRATION=1`.

## Desplegar en Vercel

El repositorio incluye `vercel.json` y una función serverless única en `api/index.mjs`.

1. Importa el repositorio en Vercel.
2. Desde **Storage**, instala Neon Postgres o conecta otro PostgreSQL.
3. Verifica que el proyecto tenga la variable `DATABASE_URL` en Production, Preview y Development.
4. Mantén Node.js `24.x`, definido también en `package.json`.
5. Despliega. La función creará el esquema y los datos iniciales en la primera petición.

Para proveedores serverless usa una URL de conexión con pooler. No guardes `DATABASE_URL` en Git; `.env` está ignorado y `.env.example` solo contiene valores locales.

## Verificación

```bash
npm test
```

Las pruebas usan PostgreSQL en memoria mediante `pg-mem`, sin modificar la base configurada en `DATABASE_URL`. Las imágenes del inventario se cargan desde sitios externos y requieren conexión a internet.
