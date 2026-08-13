import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`[store.config] Falta la variable de entorno "${name}". Revisa tu .env.local.`);
  }
  return value;
}

export const storeConfig = {
  nombre: process.env.STORE_NAME || 'Punto de Venta',
  logo: process.env.STORE_LOGO_PATH || '/logo.png',
  colorPrimario: process.env.STORE_COLOR_PRIMARY || '#0f766e',
  // Debe coincidir con cómo esa tienda maneja sus precios: "USD" o "CUP".
  monedaLabel: (process.env.STORE_CURRENCY_LABEL || 'USD').toUpperCase(),

  supabase: {
    get url() { return required('SUPABASE_URL'); },
    // El POS es 100% interno — nunca lo usa un cliente público, así que
    // solo trabaja con la clave de servicio (no hace falta la anon key aquí).
    get serviceRoleKey() { return required('SUPABASE_SERVICE_ROLE'); },
  },

  get posPassword() { return required('POS_PASSWORD'); },

  public() {
    return {
      nombre: this.nombre,
      logo: this.logo,
      colorPrimario: this.colorPrimario,
      monedaLabel: this.monedaLabel,
    };
  },
};
