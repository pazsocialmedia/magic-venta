// Precios de Card Kingdom desde el pricelist publico v2.
// Clave del match: scryfall_id + foil (exacto, sin depender de nombres de edicion).
//
// El pricelist es un JSON grande (>10MB). Se baja una vez por corrida y se
// indexa en memoria. Precio usado: NM (nm_price si existe, si no price_retail).

const PRICELIST_URL = 'https://api.cardkingdom.com/api/v2/pricelist';
const DEFAULT_BASE = 'https://www.cardkingdom.com';

function toBool(v) {
  return v === true || v === 1 || v === '1' || v === 'true';
}

function nmPriceOf(entry) {
  const cv = entry.condition_values || {};
  const nm = Number(cv.nm_price);
  if (Number.isFinite(nm) && nm > 0) return nm;
  const retail = Number(entry.price_retail);
  return Number.isFinite(retail) && retail > 0 ? retail : null;
}

function nmQtyOf(entry) {
  const cv = entry.condition_values || {};
  const q = Number(cv.nm_qty);
  if (Number.isFinite(q)) return q;
  const r = Number(entry.qty_retail);
  return Number.isFinite(r) ? r : 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Descarga e indexa. Devuelve { lookup(scryfallId, foil) -> {priceUsd, url, edition} | null, size }
export async function loadCardKingdom() {
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(PRICELIST_URL, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'mtg-store/1.0' },
    });
    if (res.ok) break;
    if ((res.status === 429 || res.status === 503) && attempt < 5) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(60000, 3000 * 2 ** attempt);
      console.warn(`  Card Kingdom ${res.status}: espero ${Math.round(waitMs / 1000)}s y reintento (${attempt + 1}/5)`);
      await sleep(waitMs);
      continue;
    }
    throw new Error(`Card Kingdom ${res.status}`);
  }
  const json = await res.json();

  const entries = Array.isArray(json) ? json : (json.data || []);
  const base = (json.meta && json.meta.base_url) || DEFAULT_BASE;

  // key = `${scryfall_id}|${foil?1:0}`
  const map = new Map();
  let indexed = 0;

  for (const e of entries) {
    const sid = e.scryfall_id;
    if (!sid) continue;
    const price = nmPriceOf(e);
    if (price == null) continue;

    const foil = toBool(e.is_foil);
    const key = `${sid}|${foil ? 1 : 0}`;
    const qty = nmQtyOf(e);
    const candidate = {
      priceUsd: price,
      qty,
      url: e.url ? (e.url.startsWith('http') ? e.url : base + e.url) : null,
      edition: e.edition || null,
    };

    const prev = map.get(key);
    if (!prev) {
      map.set(key, candidate);
      indexed++;
    } else {
      // Preferir el que tiene stock; a igualdad, el mas barato.
      const prevHasStock = prev.qty > 0;
      const curHasStock = candidate.qty > 0;
      if ((curHasStock && !prevHasStock) ||
          (curHasStock === prevHasStock && candidate.priceUsd < prev.priceUsd)) {
        map.set(key, candidate);
      }
    }
  }

  return {
    size: indexed,
    lookup(scryfallId, foil) {
      if (!scryfallId) return null;
      return map.get(`${scryfallId}|${foil ? 1 : 0}`) || null;
    },
  };
}
