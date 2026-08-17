// Cotizacion USD -> UYU (venta), con cascada de fuentes y fallback a cache.
//
// Orden:
//   1. Override manual por env COTIZACION_USD_UYU (si queres forzar un valor).
//   2. uy.dolarapi.com  -> cotizacion del BROU, campo "venta" (fuente JSON estable).
//   3. Cache guardada en data/cotizacion-cache.json, marcada como desactualizada.
//
// Devuelve: { usdToUyu, fuente, fecha, stale }

import fs from 'node:fs/promises';

const CACHE_PATH = new URL('../../data/cotizacion-cache.json', import.meta.url);

async function fetchJson(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'Accept': 'application/json', 'User-Agent': 'mtg-store/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Fuente primaria: dolarapi Uruguay (BROU). Intenta el endpoint puntual del dolar
// y, si no, la lista completa buscando la moneda USD.
async function fromDolarApi() {
  const parse = (o) => {
    const venta = Number(o?.venta);
    if (!Number.isFinite(venta) || venta <= 0) return null;
    return {
      // Siempre se redondea hacia arriba (ej. 41.6 -> 42).
      usdToUyu: Math.ceil(venta),
      fuente: 'BROU (uy.dolarapi.com)',
      fecha: (o.fechaActualizacion || '').slice(0, 10) || new Date().toISOString().slice(0, 10),
      stale: false,
    };
  };
  try {
    const one = await fetchJson('https://uy.dolarapi.com/v1/cotizaciones/dolar');
    const r = parse(one);
    if (r) return r;
  } catch { /* sigo con la lista */ }

  const list = await fetchJson('https://uy.dolarapi.com/v1/cotizaciones');
  const usd = Array.isArray(list)
    ? list.find((x) => String(x.moneda).toUpperCase() === 'USD' || /d[oó]lar/i.test(x.nombre || ''))
    : null;
  const r = parse(usd);
  if (!r) throw new Error('dolarapi: no encontre la cotizacion del dolar');
  return r;
}

async function readCache() {
  try {
    const raw = JSON.parse(await fs.readFile(CACHE_PATH, 'utf8'));
    if (Number.isFinite(Number(raw.usdToUyu))) return raw;
  } catch { /* sin cache */ }
  return null;
}

async function writeCache(data) {
  const out = {
    _comment: 'Ultima cotizacion USD->UYU obtenida con exito. Actualizado por el build.',
    usdToUyu: data.usdToUyu,
    fuente: data.fuente,
    fecha: data.fecha,
  };
  await fs.writeFile(CACHE_PATH, JSON.stringify(out, null, 2) + '\n');
}

export async function getCotizacion() {
  // 1. Override manual.
  const override = Number(process.env.COTIZACION_USD_UYU);
  if (Number.isFinite(override) && override > 0) {
    const data = {
      usdToUyu: override,
      fuente: 'override manual (env)',
      fecha: new Date().toISOString().slice(0, 10),
      stale: false,
    };
    await writeCache(data);
    return data;
  }

  // 2. Fuente online.
  try {
    const data = await fromDolarApi();
    await writeCache(data);
    console.log(`  cotizacion: 1 USD = ${data.usdToUyu} UYU (${data.fuente}, ${data.fecha})`);
    return data;
  } catch (e) {
    console.warn(`  cotizacion online fallo (${e.message}); uso cache.`);
  }

  // 3. Cache -> marcada como desactualizada.
  const cache = await readCache();
  if (cache) {
    return {
      usdToUyu: Number(cache.usdToUyu),
      fuente: cache.fuente || 'cache',
      fecha: cache.fecha || null,
      stale: true,
    };
  }

  // Sin nada: devuelvo null para que el sitio muestre solo USD.
  console.warn('  cotizacion: sin fuente ni cache; el sitio mostrara solo USD.');
  return { usdToUyu: null, fuente: null, fecha: null, stale: true };
}
