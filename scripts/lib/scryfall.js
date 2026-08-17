// Enriquecimiento con la API publica de Scryfall a partir del Scryfall ID.
// Trae: type_line (tipo de carta) e imagenes. Usa el endpoint /cards/collection
// que acepta hasta 75 identificadores por request.
//
// Cortesia con la API: User-Agent propio, Accept json, y ~120ms entre requests.

const COLLECTION_URL = 'https://api.scryfall.com/cards/collection';
const HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'User-Agent': 'mtg-store/1.0 (coleccion personal)',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// POST con reintentos ante rate-limit (429) o error temporal (503).
// Respeta el header Retry-After; si no viene, espera 65s en 429 (lo que pide
// Scryfall) o backoff exponencial en 503.
async function postWithRetry(url, body, maxRetries = 6) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method: 'POST', headers: HEADERS, body });
    if (res.ok) return res;
    if ((res.status === 429 || res.status === 503) && attempt < maxRetries) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : (res.status === 429 ? 65000 : Math.min(60000, 2000 * 2 ** attempt));
      console.warn(`  Scryfall ${res.status}: espero ${Math.round(waitMs / 1000)}s y reintento (${attempt + 1}/${maxRetries})`);
      await sleep(waitMs);
      continue;
    }
    const text = await res.text();
    throw new Error(`Scryfall ${res.status}: ${text.slice(0, 200)}`);
  }
}

// Deriva un tipo primario en espanol desde el type_line de Scryfall.
export function tipoDesdeTypeLine(typeLine = '') {
  const t = String(typeLine).toLowerCase();
  const mapa = [
    ['creature', 'Criatura'],
    ['planeswalker', 'Planeswalker'],
    ['instant', 'Instantaneo'],
    ['sorcery', 'Conjuro'],
    ['battle', 'Batalla'],
    ['enchantment', 'Encantamiento'],
    ['artifact', 'Artefacto'],
    ['land', 'Tierra'],
  ];
  for (const [en, es] of mapa) if (t.includes(en)) return es;
  return 'Otro';
}

function imagenesDe(card) {
  const src = card.image_uris
    || (Array.isArray(card.card_faces) && card.card_faces[0]?.image_uris)
    || null;
  if (!src) return { image: null, imageSmall: null };
  return {
    image: src.normal || src.large || src.png || src.small || null,
    imageSmall: src.small || src.normal || null,
  };
}

// ids: array de scryfall ids (strings). Devuelve Map<id, {typeLine, tipo, image, imageSmall, scryfallUri}>
export async function enrichByScryfallIds(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  const result = new Map();
  const batches = chunk(unique, 75);

  for (let b = 0; b < batches.length; b++) {
    const identifiers = batches[b].map((id) => ({ id }));
    const res = await postWithRetry(COLLECTION_URL, JSON.stringify({ identifiers }));
    const data = await res.json();
    if (batches.length > 5 && (b % 5 === 0 || b === batches.length - 1)) {
      console.log(`  Scryfall: lote ${b + 1}/${batches.length}`);
    }
    for (const card of data.data || []) {
      const typeLine = card.type_line || '';
      result.set(card.id, {
        typeLine,
        tipo: tipoDesdeTypeLine(typeLine),
        scryfallUri: card.scryfall_uri || null,
        ...imagenesDe(card),
      });
    }
    for (const nf of data.not_found || []) {
      if (nf?.id) console.warn(`  Scryfall no encontro id ${nf.id}`);
    }
    if (b < batches.length - 1) await sleep(250);
  }
  return result;
}
