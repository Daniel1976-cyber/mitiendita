# Punto de Venta / Registro Diario

App aparte, conectada al **mismo Supabase** de tu tienda online — reutiliza
tu catálogo real (con precios) y retroalimenta el campo `cantidad` que ya
usa el admin de la tienda en "Inventario y Utilidad".

## Qué resuelve

- Registrar cada venta del mostrador como una factura (uno o varios
  productos), con el precio y nombre **congelados** al momento de la venta
  — si después cambias precios en el catálogo, las facturas viejas no se alteran.
- Un cuadre diario por producto: cantidad inicial, entradas, mermas/roturas,
  vendida (calculada sola desde las facturas del día) y cantidad final.
- **Funciona aunque se caiga el wifi un momento**: cada factura se guarda
  primero en el propio celular (localStorage) y se sube a Supabase de
  fondo, con reintentos automáticos. El cuadre del día siempre se calcula
  incluyendo las ventas que aún no se han subido, así nunca se pierde una
  venta ni se descuadra el conteo.

## Pensado para

Un solo dispositivo (un celular o tablet en el mostrador). El campo
"vendedor" es un texto libre que cada quien escribe en su factura — no
hay usuarios/contraseñas individuales.

## Configurar

1. Copia `.env.example` a `.env.local`.
2. Usa el **mismo** `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE` que ya usa tu
   tienda online (están en el `.env.local` de esa tienda).
3. Pon `STORE_CURRENCY_LABEL` según cómo esa tienda maneje sus precios
   ("USD" o "CUP" — debe coincidir con lo que usa el admin de la tienda).
4. Elige una `POS_PASSWORD` (puede ser la misma del admin de la tienda o
   una distinta).
5. Reemplaza `public/logo.png`.
6. Antes de usarlo por primera vez, corre `sql/schema.sql` en el SQL
   Editor de ese mismo proyecto Supabase (crea las tablas `facturas`,
   `factura_items` y `movimientos_inventario` — no toca tu tabla `productos`).
7. `npm install && npm run dev` para probar en `http://localhost:3000`.

## Desplegar

Igual que las otras: sube a GitHub, importa en Vercel, agrega las mismas
variables del `.env.local` en Vercel → Settings → Environment Variables, y
Deploy.

## Limitación a tener en cuenta

Necesitas conexión a internet **la primera vez del día** para iniciar
sesión (la validación de contraseña no puede hacerse sin conectarse una
vez). Después de entrar, la app tolera que se caiga el wifi durante el
resto del día.
