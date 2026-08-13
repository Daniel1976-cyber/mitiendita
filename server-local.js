import app from './api/index.js';
import { storeConfig } from './store.config.js';

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`[${storeConfig.nombre}] Punto de venta corriendo en http://localhost:${PORT}`);
});
