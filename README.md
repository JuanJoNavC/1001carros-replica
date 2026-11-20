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

La primera conexión crea las tablas e inyecta automáticamente el catálogo, las marcas y las agencias. En desarrollo, `npm run dev` y `npm start` cargan automáticamente el archivo local `.env`; `DATABASE_URL` sigue siendo obligatoria y `PG_POOL_MAX` controla el máximo de conexiones por proceso.

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

## Reserva en línea con PayPhone

Desde la ficha de cada vehículo el cliente puede **reservarlo por USD 200** (`/reserva/:id`): elige agencia, deja sus datos y paga con la Cajita de Pagos de PayPhone. El resultado se muestra en `/reserva/confirmacion`.

- El servidor fija el monto (20000 centavos) y confirma cada pago con PayPhone (`/api/confirm`) antes de marcar el carro como reservado. PayPhone revierte el cobro si no se confirma en 5 minutos.
- Las reservas se guardan en la tabla `reservations` (estados: `pending`, `paid`, `canceled`, `failed`, `paid_conflict`). Un carro reservado sigue en el catálogo con la etiqueta "Reservado" y no se puede volver a reservar.
- **Sin credenciales funciona en modo demostración** con una pasarela simulada que imita a PayPhone (tarjeta o saldo PayPhone, procesamiento, aprobación o rechazo, vencimiento de 10 minutos). Genera una transacción, redirige a `/reserva/confirmacion?id=...&clientTransactionId=...` y el servidor la confirma por el mismo camino que un pago real. Nunca se simula un pago cuando hay un token configurado.
- La simulación solo acepta tarjetas de prueba (cualquier otro número se rechaza sin enviarse): `4111 1111 1111 1111` y `5555 5555 5555 4444` se aprueban; `4000 0000 0000 0002` (fondos insuficientes) y `5105 1051 0510 5100` (rechazada por el banco) se rechazan.

Para activar los pagos reales o de prueba de PayPhone:

1. En Payphone Developer, crea una aplicación de tipo **WEB** con el dominio del sitio (por ejemplo `1001carros-prueba.vercel.app`) y como URL de respuesta `https://<dominio>/reserva/confirmacion`.
2. En Vercel → Settings → Environment Variables agrega `PAYPHONE_TOKEN` y `PAYPHONE_STORE_ID` y vuelve a desplegar.
3. Usa primero el **modo de prueba** de PayPhone (todas las transacciones se aprueban sin cobro real) antes de pasar a producción.

### Filtro antes de reservar (sin pedir cédula)

1. **Reglas invisibles:** una reserva activa por celular o correo; máximo 5 intentos de reserva por persona en 24 h y 3 intentos de pago por reserva; la reserva separa el carro 72 horas y, si no se agenda la visita, vence sola, el carro vuelve a estar disponible y se registra un aviso para gestionar el reembolso.
2. **Código por WhatsApp:** antes de pagar, el cliente confirma su celular con un código de 6 dígitos (vence en 10 minutos, 5 intentos, reenvío cada 30 segundos). Sin proveedor de mensajes (`OTP_PROVIDER`) el código se muestra en pantalla como simulación.
3. **Después de pagar:** el cliente agenda su visita y, de forma opcional, registra su cédula o RUC ("Lo completo en la agencia").

El buró de crédito no se usa para reservar: queda en la precalificación, con autorización expresa del cliente.
