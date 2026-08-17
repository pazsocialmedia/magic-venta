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
    const res = await fetch(COLLECTION_URL, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ identifiers }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Scryfall ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json();
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
    if (b < batches.length - 1) await sleep(120);
  }
  return result;
}
