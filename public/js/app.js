// ─── Estado ────────────────────────────────────────────────────────────────
const LS_FACTURAS = 'pos_facturas';
const LS_CATALOGO = 'pos_catalogo';
const DB_NAME = 'pos-db';
const DB_VERSION = 1;
const STORE_FACTURAS = 'facturas';

let db = null;
let swRegistration = null;

let token = sessionStorage.getItem('posToken') || '';
let config = null;
let catalogo = [];
let lineasFactura = []; // [{ producto_id, nombre, precio, cantidad }]

function hoyISO() {
  return new Date().toISOString().slice(0, 10);
}

function toast(mensaje) {
  const t = document.getElementById('toast');
  t.textContent = mensaje;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

function formatMonto(valor) {
  const num = Number(valor || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return config?.monedaLabel === 'CUP' ? `${num} CUP` : `$${num}`;
}

// ─── IndexedDB para datos offline resilientes ───────────────────────────────
async function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { db = request.result; resolve(db); };
    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains(STORE_FACTURAS)) {
        database.createObjectStore(STORE_FACTURAS, { keyPath: 'idLocal' });
      }
    };
  });
}

async function guardarFacturaIDB(factura) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_FACTURAS, 'readwrite');
    tx.objectStore(STORE_FACTURAS).put(factura);
    tx.oncomplete = () => { tx.objectStore(STORE_FACTURAS).get(factura.idLocal).onsuccess = (e) => resolve(e.target.result); };
    tx.onerror = () => reject(tx.error);
  });
}

async function obtenerPendientesIDB() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_FACTURAS, 'readonly');
    const store = tx.objectStore(STORE_FACTURAS);
    const range = IDBKeyRange.lowerBound('');
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result.filter(f => !f.sincronizada));
    req.onerror = () => reject(req.error);
  });
}

async function marcarSincronizadaIDB(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_FACTURAS, 'readwrite');
    const store = tx.objectStore(STORE_FACTURAS);
    store.get(id).onsuccess = (e) => {
      if (e.target.result) {
        e.target.result.sincronizada = true;
        store.put(e.target.result);
      }
    };
    tx.oncomplete = resolve;
    tx.onerror = reject;
  });
}

// ─── Guardado local (localStorage) — es la fuente de verdad del día ───────
function leerFacturasLocales() {
  return JSON.parse(localStorage.getItem(LS_FACTURAS) || '[]');
}
function guardarFacturasLocales(lista) {
  localStorage.setItem(LS_FACTURAS, JSON.stringify(lista));
}
function leerCatalogoLocal() {
  return JSON.parse(localStorage.getItem(LS_CATALOGO) || '[]');
}

// ─── Vistas ────────────────────────────────────────────────────────────────
function showView(id) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
function mostrarHome() { showView('home'); renderHome(); }

// ─── Login ─────────────────────────────────────────────────────────────────
async function login() {
  const password = document.getElementById('password').value;
  try {
    const res = await fetch('/api/validatePassword', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      document.getElementById('loginError').textContent = 'Contraseña incorrecta';
      return;
    }
    const data = await res.json();
    token = data.token;
    sessionStorage.setItem('posToken', token);
    await entrarApp();
  } catch (e) {
    document.getElementById('loginError').textContent = 'Sin conexión — necesitas internet para entrar la primera vez.';
  }
}

async function entrarApp() {
  document.getElementById('login').classList.remove('active');
  document.getElementById('topNav').style.display = 'flex';
  await sincronizarCatalogoSiHayInternet();
  catalogo = leerCatalogoLocal();
  mostrarHome();
  intentarSincronizarPendientes();
}

async function sincronizarCatalogoSiHayInternet() {
  try {
    const res = await fetch('/api/catalogo', { headers: { 'x-pos-token': token } });
    if (res.ok) {
      const data = await res.json();
      localStorage.setItem(LS_CATALOGO, JSON.stringify(data));
    }
  } catch (e) { /* offline: seguimos con lo que ya había guardado */ }
}

// ─── Sincronización de facturas pendientes ────────────────────────────────
async function intentarSincronizarPendientes() {
  const lista = leerFacturasLocales();
  const pendientes = lista.filter((f) => !f.sincronizada);
  if (!pendientes.length) { actualizarBadgeSync(0); return; }

  let huboCambios = false;
  for (const f of pendientes) {
    try {
      const res = await fetch('/api/facturas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-pos-token': token },
        body: JSON.stringify({ fecha: f.fecha, vendedor: f.vendedor, items: f.items }),
      });
      if (res.ok) {
        f.sincronizada = true;
        huboCambios = true;
      }
    } catch (e) {
      break; // sigue sin conexión, dejamos de intentar por ahora
    }
  }
  if (huboCambios) {
    guardarFacturasLocales(lista);
    if (db) {
      for (const f of lista.filter(f => f.sincronizada)) await marcarSincronizadaIDB(f.idLocal);
    }
  }
  const quedan = leerFacturasLocales().filter((f) => !f.sincronizada).length;
  actualizarBadgeSync(quedan);
  if (document.getElementById('home').classList.contains('active')) renderHome();
}

async function registrarSync() {
  if (!swRegistration || !('sync' in swRegistration)) return;
  try {
    await swRegistration.sync.register('sync-facturas');
  } catch (e) { /* Sync no disponible */ }
}

function actualizarBadgeSync(pendientes) {
  const badge = document.getElementById('syncBadge');
  if (pendientes > 0) {
    badge.textContent = `${pendientes} sin subir`;
    badge.classList.add('pendiente');
  } else {
    badge.textContent = 'Al día';
    badge.classList.remove('pendiente');
  }
}

window.addEventListener('online', intentarSincronizarPendientes);
setInterval(intentarSincronizarPendientes, 30000); // reintento silencioso cada 30s
function renderHome() {
  const fecha = hoyISO();
  const todas = leerFacturasLocales().filter((f) => f.fecha === fecha);
  const cont = document.getElementById('facturasHoy');

  if (!todas.length) {
    cont.innerHTML = '<p style="color:#64748b; padding:0 .25rem;">Todavía no hay ventas registradas hoy.</p>';
  } else {
    cont.innerHTML = todas.map((f, idx) => `
      <div class="factura-card ${f.sincronizada ? '' : 'pendiente'}">
        <div>
          <div class="num">Factura ${idx + 1}${f.vendedor ? ' · ' + f.vendedor : ''}</div>
          <div class="meta">${new Date(f.creadaEn).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}${f.sincronizada ? '' : ' · pendiente de subir'}</div>
        </div>
        <div class="monto">${formatMonto(f.total)}</div>
      </div>
    `).join('');
  }

  const pendientes = leerFacturasLocales().filter((f) => !f.sincronizada).length;
  actualizarBadgeSync(pendientes);
}

// ─── Nueva factura ─────────────────────────────────────────────────────────
function nuevaFactura() {
  lineasFactura = [];
  document.getElementById('vendedorInput').value = '';
  document.getElementById('facturaMsg').textContent = '';
  agregarLinea();
  showView('vistaFactura');
}

function agregarLinea() {
  lineasFactura.push({ producto_id: null, nombre: '', precio: 0, cantidad: 1 });
  renderLineas();
}

function quitarLinea(idx) {
  lineasFactura.splice(idx, 1);
  renderLineas();
}

function renderLineas() {
  const cont = document.getElementById('lineasContenedor');
  cont.innerHTML = lineasFactura.map((linea, idx) => `
    <div class="linea-producto">
      ${lineasFactura.length > 1 ? `<button class="quitar-linea" onclick="quitarLinea(${idx})">✕</button>` : ''}
      <div class="buscador-wrap">
        <input type="text" placeholder="Buscar producto..." value="${linea.nombre}"
               oninput="buscarProducto(${idx}, this.value)"
               onblur="setTimeout(() => cerrarSugerencias(${idx}), 150)" autocomplete="off" />
        <div class="sugerencias" id="sugerencias-${idx}"></div>
      </div>
      <div class="fila-cantidad">
        <span style="font-size:.85rem; color:#64748b;">Precio: ${formatMonto(linea.precio)}</span>
        <span style="flex:1;"></span>
        <label style="font-size:.85rem;">Cant.</label>
        <input type="number" min="1" value="${linea.cantidad}" style="width:70px;"
               onchange="cambiarCantidad(${idx}, this.value)" />
      </div>
      <div class="subtotal">Subtotal: ${formatMonto(linea.precio * linea.cantidad)}</div>
    </div>
  `).join('');
  actualizarTotalFactura();
}

function buscarProducto(idx, texto) {
  lineasFactura[idx].nombre = texto;
  const cont = document.getElementById(`sugerencias-${idx}`);
  const q = texto.trim().toLowerCase();
  if (!q) { cont.classList.remove('open'); cont.innerHTML = ''; return; }

  const coincidencias = catalogo.filter((p) => p.nombre.toLowerCase().includes(q)).slice(0, 8);
  if (!coincidencias.length) { cont.classList.remove('open'); cont.innerHTML = '<div class="item">Sin resultados</div>'; cont.classList.add('open'); return; }

  cont.innerHTML = coincidencias.map((p) => `
    <div class="item" onmousedown="elegirProducto(${idx}, ${p.id})">
      <span>${p.nombre}</span><span>${formatMonto(p.precio)}</span>
    </div>
  `).join('');
  cont.classList.add('open');
}

function cerrarSugerencias(idx) {
  const cont = document.getElementById(`sugerencias-${idx}`);
  if (cont) cont.classList.remove('open');
}

function elegirProducto(idx, productoId) {
  const p = catalogo.find((x) => x.id === productoId);
  if (!p) return;
  lineasFactura[idx] = { ...lineasFactura[idx], producto_id: p.id, nombre: p.nombre, precio: p.precio };
  renderLineas();
}

function cambiarCantidad(idx, valor) {
  const cantidad = Math.max(1, parseInt(valor, 10) || 1);
  lineasFactura[idx].cantidad = cantidad;
  actualizarTotalFactura();
  renderLineas(); // se dispara al salir del campo (onchange), no mientras se escribe
}

function actualizarTotalFactura() {
  const total = lineasFactura.reduce((acc, l) => acc + l.precio * l.cantidad, 0);
  document.getElementById('totalFactura').textContent = formatMonto(total);
}

async function guardarFactura() {
  const msg = document.getElementById('facturaMsg');
  const validas = lineasFactura.filter((l) => l.producto_id);
  if (!validas.length) {
    msg.className = 'msg error';
    msg.textContent = 'Agrega al menos un producto válido.';
    return;
  }

  const items = validas.map((l) => ({
    producto_id: l.producto_id,
    nombre: l.nombre,
    precio: l.precio,
    cantidad: l.cantidad,
    subtotal: l.precio * l.cantidad,
  }));
  const total = items.reduce((acc, i) => acc + i.subtotal, 0);

  const factura = {
    idLocal: `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    fecha: hoyISO(),
    vendedor: document.getElementById('vendedorInput').value.trim(),
    items,
    total,
    creadaEn: new Date().toISOString(),
    sincronizada: false,
  };

  const lista = leerFacturasLocales();
  lista.push(factura);
  guardarFacturasLocales(lista);

  if (db) {
    await guardarFacturaIDB(factura);
  }

  toast('Factura cerrada correctamente');
  setTimeout(() => {
    mostrarHome();
    if (navigator.onLine) {
      intentarSincronizarPendientes();
    } else if (swRegistration && 'sync' in swRegistration) {
      registrarSync();
    }
  }, 500);
}

// ─── Cuadre del día ────────────────────────────────────────────────────────
function abrirCuadre() {
  document.getElementById('fechaCuadre').value = hoyISO();
  showView('vistaCuadre');
  cargarCuadre();
}

async function cargarCuadre() {
  const fecha = document.getElementById('fechaCuadre').value || hoyISO();
  const msg = document.getElementById('cuadreMsg');
  msg.textContent = '';

  let datosServidor = [];
  try {
    const res = await fetch(`/api/cuadre?fecha=${fecha}`, { headers: { 'x-pos-token': token } });
    if (res.ok) datosServidor = await res.json();
    else throw new Error();
  } catch (e) {
    msg.className = 'msg error';
    msg.textContent = 'No se pudo conectar — mostrando solo lo que hay guardado en este celular.';
  }

  // Sumar ventas locales AÚN NO sincronizadas de esa fecha, para que el
  // cuadre sea exacto aunque el servidor todavía no las tenga.
  const localesPendientes = leerFacturasLocales().filter((f) => f.fecha === fecha && !f.sincronizada);
  const extraPorProducto = {};
  localesPendientes.forEach((f) => {
    f.items.forEach((it) => {
      if (!it.producto_id) return;
      extraPorProducto[it.producto_id] = (extraPorProducto[it.producto_id] || 0) + it.cantidad;
    });
  });

  const base = datosServidor.length ? datosServidor : leerCatalogoLocal().map((p) => ({
    producto_id: p.id, nombre: p.nombre, precio: p.precio,
    cantidad_inicial: p.cantidad || 0, entrada: 0, merma: 0, cantidad_vendida: 0,
    cantidad_final: p.cantidad || 0, importe: 0,
  }));

  const filas = base.map((row) => {
    const extra = extraPorProducto[row.producto_id] || 0;
    const vendida = row.cantidad_vendida + extra;
    return { ...row, cantidad_vendida: vendida, cantidad_final: row.cantidad_inicial + row.entrada - row.merma - vendida, importe: vendida * row.precio };
  });

  renderCuadre(filas);
}

function renderCuadre(filas) {
  const tbody = document.getElementById('cuadreTbody');
  if (!filas.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="padding:1rem; color:#64748b;">Sin productos en el catálogo.</td></tr>';
  } else {
    tbody.innerHTML = filas.map((f, idx) => `
      <tr data-producto-id="${f.producto_id}">
        <td>${f.nombre}</td>
        <td class="num-ro">${f.cantidad_inicial}</td>
        <td><input type="number" value="${f.entrada}" min="0" onchange="recalcularFila(${idx})" id="entrada-${idx}" /></td>
        <td><input type="number" value="${f.merma}" min="0" onchange="recalcularFila(${idx})" id="merma-${idx}" /></td>
        <td class="num-ro">${f.cantidad_vendida}</td>
        <td class="num-ro" id="final-${idx}">${f.cantidad_final}</td>
        <td class="num-ro" id="importe-${idx}">${formatMonto(f.importe)}</td>
      </tr>
    `).join('');
  }
  window._cuadreFilas = filas;
  actualizarTotalCuadre();
}

function recalcularFila(idx) {
  const fila = window._cuadreFilas[idx];
  fila.entrada = parseInt(document.getElementById(`entrada-${idx}`).value, 10) || 0;
  fila.merma = parseInt(document.getElementById(`merma-${idx}`).value, 10) || 0;
  fila.cantidad_final = fila.cantidad_inicial + fila.entrada - fila.merma - fila.cantidad_vendida;
  fila.importe = fila.cantidad_vendida * fila.precio;
  document.getElementById(`final-${idx}`).textContent = fila.cantidad_final;
  document.getElementById(`importe-${idx}`).textContent = formatMonto(fila.importe);
  actualizarTotalCuadre();
}

function actualizarTotalCuadre() {
  const total = (window._cuadreFilas || []).reduce((acc, f) => acc + f.importe, 0);
  document.getElementById('cuadreTotal').textContent = formatMonto(total);
}

async function guardarCuadre() {
  const fecha = document.getElementById('fechaCuadre').value || hoyISO();
  const msg = document.getElementById('cuadreMsg');
  const filas = window._cuadreFilas || [];

  try {
    for (const f of filas) {
      await fetch('/api/cuadre', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-pos-token': token },
        body: JSON.stringify({
          fecha, producto_id: f.producto_id, nombre: f.nombre,
          cantidad_inicial: f.cantidad_inicial, entrada: f.entrada, merma: f.merma,
          cantidad_vendida: f.cantidad_vendida, cantidad_final: f.cantidad_final,
          actualizarCatalogo: true,
        }),
      });
    }
    msg.className = 'msg ok';
    msg.textContent = 'Cuadre guardado ✅';
  } catch (e) {
    msg.className = 'msg error';
    msg.textContent = 'Sin conexión — no se pudo guardar el cuadre. Intenta de nuevo con internet.';
  }
}

// ─── Arranque ────────────────────────────────────────────────────────────
(async function start() {
  try {
    await initDB();
  } catch (e) { /* IndexedDB no disponible */ }
  
  config = await fetch('/api/config').then((r) => r.json());
  document.getElementById('nombreLogin').textContent = config.nombre;
  document.getElementById('logoLogin').src = config.logo;
  document.getElementById('nombreNav').textContent = config.nombre;
  document.getElementById('logoNav').src = config.logo;
  document.documentElement.style.setProperty('--color-primario', config.colorPrimario);

  if (navigator.serviceWorker && 'SyncManager' in window) {
    const registration = await navigator.serviceWorker.register('/sw.js');
    swRegistration = registration;
    
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'sync-requested') {
        intentarSincronizarPendientes();
      }
    });
  }

  if (token) await entrarApp();
})();
