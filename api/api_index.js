import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { storeConfig } from '../store.config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const supabase = createClient(storeConfig.supabase.url, storeConfig.supabase.serviceRoleKey);

// ─── Autenticación (una sola contraseña compartida) ───────────────────────
app.post('/api/validatePassword', (req, res) => {
  const { password } = req.body || {};
  if (password !== storeConfig.posPassword) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  res.json({ success: true, token: storeConfig.posPassword });
});

function verifyToken(req, res, next) {
  const token = req.headers['x-pos-token'];
  if (!token || token !== storeConfig.posPassword) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}

app.get('/api/config', (req, res) => res.json(storeConfig.public()));

// ─── Catálogo (para el buscador de producto de cada línea de factura) ────
// Se trae completo UNA vez al abrir la app; el frontend lo guarda en el
// celular para que el buscador funcione aunque se caiga la conexión luego.
app.get('/api/catalogo', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('productos')
      .select('id, nombre, precio, categoria, cantidad, disponible')
      .eq('disponible', true);
    if (error) throw error;
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Guardar una factura (venta) completa ─────────────────────────────────
app.post('/api/facturas', verifyToken, async (req, res) => {
  const { fecha, vendedor, items } = req.body;
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'La factura no tiene productos' });
  }

  const total = items.reduce((acc, i) => acc + i.subtotal, 0);

  try {
    const { data: factura, error: errorFactura } = await supabase
      .from('facturas')
      .insert([{ fecha, vendedor: vendedor || null, total }])
      .select()
      .single();
    if (errorFactura) throw errorFactura;

    const filas = items.map((i) => ({
      factura_id: factura.id,
      producto_id: i.producto_id || null,
      nombre: i.nombre,
      precio: i.precio,
      cantidad: i.cantidad,
      subtotal: i.subtotal,
    }));

    const { error: errorItems } = await supabase.from('factura_items').insert(filas);
    if (errorItems) throw errorItems;

    res.json({ success: true, factura_id: factura.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Eliminar una factura (y sus líneas, por cascade) ─────────────────────
app.delete('/api/facturas/:id', verifyToken, async (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: 'Falta el id de la factura' });

  try {
    const { error } = await supabase.from('facturas').delete().eq('id', id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Cuadre diario ─────────────────────────────────────────────────────────
// Trae, por producto: cantidad inicial (heredada del cierre anterior),
// entrada/merma ya guardadas hoy (si las hay), y la cantidad vendida real
// calculada desde las facturas de esa fecha.
app.get('/api/cuadre', verifyToken, async (req, res) => {
  const fecha = req.query.fecha;
  if (!fecha) return res.status(400).json({ error: 'Falta la fecha' });

  try {
    const { data: productos, error: errorProductos } = await supabase
      .from('productos')
      .select('id, nombre, precio, cantidad');
    if (errorProductos) throw errorProductos;

    const { data: movimientoHoy, error: errorMovHoy } = await supabase
      .from('movimientos_inventario')
      .select('*')
      .eq('fecha', fecha);
    if (errorMovHoy) throw errorMovHoy;

    // Última cantidad_final guardada ANTES de hoy, por producto (para heredar
    // la cantidad inicial). Si nunca se ha hecho un cuadre, se usa productos.cantidad.
    const { data: movimientoAnterior, error: errorMovAnt } = await supabase
      .from('movimientos_inventario')
      .select('producto_id, cantidad_final, fecha')
      .lt('fecha', fecha)
      .order('fecha', { ascending: false });
    if (errorMovAnt) throw errorMovAnt;

    const ultimoPorProducto = {};
    movimientoAnterior.forEach((m) => {
      if (!(m.producto_id in ultimoPorProducto)) ultimoPorProducto[m.producto_id] = m.cantidad_final;
    });

    const { data: itemsVendidosHoy, error: errorVendidos } = await supabase
      .from('factura_items')
      .select('producto_id, cantidad, facturas!inner(fecha)')
      .eq('facturas.fecha', fecha);
    if (errorVendidos) throw errorVendidos;

    const vendidoPorProducto = {};
    itemsVendidosHoy.forEach((it) => {
      if (!it.producto_id) return;
      vendidoPorProducto[it.producto_id] = (vendidoPorProducto[it.producto_id] || 0) + it.cantidad;
    });

    const movHoyPorProducto = {};
    movimientoHoy.forEach((m) => { movHoyPorProducto[m.producto_id] = m; });

    const resultado = productos.map((p) => {
      const guardadoHoy = movHoyPorProducto[p.id];
      const cantidadInicial = guardadoHoy
        ? guardadoHoy.cantidad_inicial
        : (ultimoPorProducto[p.id] ?? p.cantidad ?? 0);
      const entrada = guardadoHoy ? guardadoHoy.entrada : 0;
      const merma = guardadoHoy ? guardadoHoy.merma : 0;
      const vendida = vendidoPorProducto[p.id] || 0;
      const cantidadFinal = cantidadInicial + entrada - merma - vendida;

      return {
        producto_id: p.id,
        nombre: p.nombre,
        precio: p.precio,
        cantidad_inicial: cantidadInicial,
        entrada,
        merma,
        cantidad_vendida: vendida,
        cantidad_final: cantidadFinal,
        importe: vendida * p.precio,
      };
    });

    res.json(resultado);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Guarda entrada/merma de un producto para el día, y (opcional) actualiza
// productos.cantidad con la cantidad_final — así el admin de la tienda
// online ve el inventario real sin tener que tocarlo dos veces.
app.post('/api/cuadre', verifyToken, async (req, res) => {
  const { fecha, producto_id, nombre, cantidad_inicial, entrada, merma, cantidad_vendida, cantidad_final, actualizarCatalogo } = req.body;
  if (!fecha || !producto_id) return res.status(400).json({ error: 'Faltan datos' });

  try {
    const { error } = await supabase
      .from('movimientos_inventario')
      .upsert([{
        fecha, producto_id, nombre,
        cantidad_inicial, entrada, merma, cantidad_vendida, cantidad_final,
        actualizado_en: new Date().toISOString(),
      }], { onConflict: 'fecha,producto_id' });
    if (error) throw error;

    if (actualizarCatalogo) {
      await supabase.from('productos').update({ cantidad: cantidad_final }).eq('id', producto_id);
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Archivos estáticos ────────────────────────────────────────────────────
const publicDir = path.join(projectRoot, 'public');
app.use(express.static(publicDir));
app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

export default app;
