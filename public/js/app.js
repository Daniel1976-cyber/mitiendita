// ─── Estado ────────────────────────────────────────────────────────────────
const LS_FACTURAS = 'pos_facturas';
const LS_CATALOGO = 'pos_catalogo';

let token = sessionStorage.getItem('posToken') || '';
let config = null;
let catalogo = [];
let lineasFactura = []; // [{ producto_id, nombre, precio, cantidad }]

function hoyISO() {
  return new Date().toISOString().slice(0, 10);
}

function formatMonto(valor) {
  const num = Number(valor || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return config?.monedaLabel === 'CUP' ? `${num} CUP` : `$${num}`;
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
// fetch con límite de tiempo. Una señal mala a veces no falla ni responde: se
// queda colgada, y sin límite la pantalla espera sin fin. Aquí, pasado el
// tiempo, se corta (error "AbortError") y la app sigue con lo guardado en el
// celular. SOLO para lecturas y el inicio de sesión: NO se usa al subir
// facturas, porque cortar una subida que el servidor sí alcanzó a procesar
// haría que se reintentara y se duplicara la venta.
function fetchConLimite(url, opciones = {}, ms = 4000) {
  const control = new AbortController();
  const temporizador = setTimeout(() => control.abort(), ms);
  return fetch(url, { ...opciones, signal: control.signal }).finally(() => clearTimeout(temporizador));
}

// Ojito del campo de contraseña: alterna entre ocultar y mostrar lo escrito.
// El botón no le quita el foco al campo (onmousedown), así el teclado del
// celular no se cierra, y el cursor se queda donde estaba.
function fijarVisibilidadPassword(visible) {
  const input = document.getElementById('password');
  const inicio = input.selectionStart;
  const fin = input.selectionEnd;
  input.type = visible ? 'text' : 'password';
  document.getElementById('pwToggle').setAttribute('aria-pressed', String(visible));
  return { input, inicio, fin };
}

function togglePassword() {
  const mostrar = document.getElementById('password').type === 'password';
  const { input, inicio, fin } = fijarVisibilidadPassword(mostrar);
  input.focus();
  try { input.setSelectionRange(inicio, fin); } catch (e) { /* algunos navegadores no lo permiten */ }
}

async function login() {
  const password = document.getElementById('password').value;
  try {
    const res = await fetchConLimite('/api/validatePassword', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    }, 10000);
    if (!res.ok) {
      document.getElementById('loginError').textContent = 'Contraseña incorrecta';
      return;
    }
    const data = await res.json();
    token = data.token;
    sessionStorage.setItem('posToken', token);
    // Esta app no tiene botón de salir: se borra la contraseña escrita (y se
    // vuelve a ocultar) para que no se quede dentro del campo.
    document.getElementById('password').value = '';
    fijarVisibilidadPassword(false);
    await entrarApp();
  } catch (e) {
    document.getElementById('loginError').textContent = e.name === 'AbortError'
      ? 'La conexión está muy lenta. Intenta de nuevo.'
      : 'Sin conexión — necesitas internet para entrar la primera vez.';
  }
}

async function entrarApp() {
  document.getElementById('login').classList.remove('active');
  document.getElementById('topNav').style.display = 'flex';
  // Primero lo que ya hay en el celular: la pantalla de inicio aparece al
  // instante, sin esperar a la red. El catálogo se refresca después, con un
  // límite de tiempo, y los precios nuevos se usan en cuanto llegan.
  catalogo = leerCatalogoLocal();
  mostrarHome();
  intentarSincronizarPendientes();
  await sincronizarCatalogoSiHayInternet();
  catalogo = leerCatalogoLocal();
}

// Cerrar sesión. Dos cosas a tener en cuenta en una app que funciona sin conexión:
// 1) Las facturas sin subir viven en el celular (localStorage), no en la sesión:
//    NO se borran; se suben cuando se vuelve a entrar.
// 2) Para entrar hace falta internet (la contraseña se valida en el servidor):
//    quien salga sin conexión no podrá volver a entrar hasta recuperarla.
function cerrarSesion() {
  const pendientes = leerFacturasLocales().filter((f) => !f.sincronizada).length;
  const avisos = [];
  if (pendientes > 0) {
    avisos.push(`Tienes ${pendientes} ${pendientes === 1 ? 'factura sin subir' : 'facturas sin subir'}. No se pierden: se suben cuando vuelvas a entrar con internet.`);
  }
  if (navigator.onLine === false) {
    avisos.push('Estás sin conexión: si sales no podrás volver a entrar (ni facturar) hasta tener internet.');
  }
  if (!confirm(['¿Cerrar sesión?', ...avisos].join('\n\n'))) return;

  token = '';
  sessionStorage.removeItem('posToken');
  document.getElementById('topNav').style.display = 'none';
  document.getElementById('password').value = '';
  fijarVisibilidadPassword(false);
  document.getElementById('loginError').textContent = '';
  lineasFactura = [];
  showView('login');
}

async function sincronizarCatalogoSiHayInternet() {
  try {
    const res = await fetchConLimite('/api/catalogo', { headers: { 'x-pos-token': token } }, 4000);
    if (res.ok) {
      const data = await res.json();
      localStorage.setItem(LS_CATALOGO, JSON.stringify(data));
    }
  } catch (e) { /* offline: seguimos con lo que ya había guardado */ }
}

// ─── Sincronización de facturas pendientes ────────────────────────────────
// Subida de facturas al servidor. Dos reglas para no perder ni duplicar ventas:
// 1) Una sola subida a la vez. Si llega otra llamada mientras hay una en curso
//    (el reintento de 30 s, el aviso de "volvió el internet" o recién guardar una
//    factura), no corre en paralelo —subiría la misma factura dos veces—: se anota
//    y se repite al terminar, para que la factura nueva no se quede esperando.
// 2) Al terminar cada factura se marca SOLO esa dentro de lo guardado en el
//    celular. Antes se reescribía la lista entera con la copia leída al empezar, y
//    una factura guardada mientras tanto desaparecía.
let subiendo = false;
let repetirSubida = false;

function marcarFacturaSubida(idLocal) {
  const lista = leerFacturasLocales();
  const factura = lista.find((f) => f.idLocal === idLocal);
  if (factura) {
    factura.sincronizada = true;
    guardarFacturasLocales(lista);
  }
}

// Sube las facturas que estén pendientes en este momento. Devuelve cuántas intentó.
async function subirPendientesUnaVez() {
  const pendientes = leerFacturasLocales().filter((f) => !f.sincronizada);
  for (const f of pendientes) {
    try {
      const res = await fetch('/api/facturas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-pos-token': token },
        body: JSON.stringify({ fecha: f.fecha, vendedor: f.vendedor, items: f.items }),
      });
      if (res.ok) marcarFacturaSubida(f.idLocal);
    } catch (e) {
      break; // sigue sin conexión, dejamos de intentar por ahora
    }
  }
  return pendientes.length;
}

async function intentarSincronizarPendientes() {
  if (!token) return; // sin sesión (p. ej. tras cerrarla) no hay con qué subir: se hará al volver a entrar
  if (subiendo) { repetirSubida = true; return; }
  subiendo = true;
  let intentadas = 0;
  try {
    do {
      repetirSubida = false;
      intentadas += await subirPendientesUnaVez();
    } while (repetirSubida && token);
  } finally {
    subiendo = false;
  }
  if (!intentadas) { actualizarBadgeSync(0); return; }
  const quedan = leerFacturasLocales().filter((f) => !f.sincronizada).length;
  actualizarBadgeSync(quedan);
  if (document.getElementById('home').classList.contains('active')) renderHome();
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

// ─── Home: lista de ventas de hoy ──────────────────────────────────────────
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

function guardarFactura() {
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

  // Se guarda en el celular DE INMEDIATO — esto es lo que hace que nunca
  // se pierda una venta aunque no haya internet en ese momento.
  const lista = leerFacturasLocales();
  lista.push(factura);
  guardarFacturasLocales(lista);

  mostrarHome();
  intentarSincronizarPendientes();
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
  config = await fetch('/api/config').then((r) => r.json());
  document.getElementById('nombreLogin').textContent = config.nombre;
  document.getElementById('logoLogin').src = config.logo;
  document.getElementById('nombreNav').textContent = config.nombre;
  document.getElementById('logoNav').src = config.logo;
  document.documentElement.style.setProperty('--color-primario', config.colorPrimario);

  if (token) await entrarApp();
})();
