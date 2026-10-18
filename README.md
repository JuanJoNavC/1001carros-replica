# 1001Carros — réplica funcional local

Aplicación multipágina inspirada en la experiencia pública de 1001Carros.com. Es un prototipo independiente y no está afiliado a la marca.

## Ejecutar

Requiere Node.js 24.15 o superior porque utiliza SQLite nativo.

```bash
cd 1001carros-clone
npm run dev
```

Abre `http://127.0.0.1:4173`.

La base se crea automáticamente en `data/1001carros.sqlite`. Puedes cambiar la ubicación con `DB_PATH` y el puerto con `PORT`.

## Rutas

- `/` — inicio.
- `/nuevos`, `/seminuevos`, `/usados` — catálogos filtrables.
- `/vehiculo/:id` — ficha, precio, financiamiento, garantías y contacto.
- `/vender` — captación y valoración de vehículos.
- `/financiamiento` — simulador y solicitud de asesoría.
- `/agencias` — puntos de venta por ciudad.
- `/login` — registro, sesión local y cuenta.
- `/favoritos` — selección persistente.
- `/contacto` — formulario de atención.

## Persistencia

SQLite contiene las tablas `vehicles`, `brands`, `agencies`, `leads`, `users` y `favorites`. Las cinco marcas destacadas incluyen modelos para nuevos y seminuevos, además de sus logotipos SVG vectoriales. Los formularios de venta, financiamiento, vehículo y contacto crean registros reales en `leads`; las cuentas y favoritos también se guardan.

## Verificación

```bash
npm test
```

Las imágenes de demostración se cargan desde Unsplash y requieren conexión a internet.
