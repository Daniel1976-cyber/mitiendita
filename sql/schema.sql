-- ═══════════════════════════════════════════════════════════════════════
-- PUNTO DE VENTA — tablas nuevas en el MISMO Supabase de tu tienda.
-- No tocan tu tabla `productos` (excepto una columna nueva al final, que
-- es opcional). Corre esto completo en el SQL Editor.
-- ═══════════════════════════════════════════════════════════════════════

-- Una fila por cada venta registrada en el mostrador ("Factura 1", "Factura 2"...)
create table if not exists facturas (
  id bigint generated always as identity primary key,
  fecha date not null default current_date,
  vendedor text,
  total numeric not null default 0,
  creada_en timestamptz not null default now()
);

-- Las líneas de cada factura (uno o varios productos por venta).
-- "nombre" y "precio" son una COPIA congelada del momento de la venta —
-- si después cambias el precio en el catálogo, esta factura vieja no se altera.
create table if not exists factura_items (
  id bigint generated always as identity primary key,
  factura_id bigint references facturas(id) on delete cascade,
  producto_id bigint,
  nombre text not null,
  precio numeric not null,
  cantidad integer not null,
  subtotal numeric not null
);

-- Cuadre diario por producto: cantidad inicial, entradas, mermas/roturas,
-- vendida (calculada sola desde facturas) y cantidad final.
create table if not exists movimientos_inventario (
  id bigint generated always as identity primary key,
  fecha date not null default current_date,
  producto_id bigint not null,
  nombre text not null,
  cantidad_inicial integer not null default 0,
  entrada integer not null default 0,
  merma integer not null default 0,
  cantidad_vendida integer not null default 0,
  cantidad_final integer not null default 0,
  actualizado_en timestamptz not null default now(),
  unique (fecha, producto_id)
);

-- Estas tablas son 100% internas del punto de venta — nunca las lee el
-- cliente de la tienda online, así que quedan bloqueadas para todo lo que
-- no sea la clave de servicio (service_role), sin política pública.
alter table facturas enable row level security;
alter table factura_items enable row level security;
alter table movimientos_inventario enable row level security;
