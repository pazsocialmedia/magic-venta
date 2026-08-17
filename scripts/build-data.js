// Build de datos: Google Sheet -> Scryfall -> Card Kingdom -> cotizacion -> JSON.
// Genera public/data/{cards.json, reporte-sin-precio.json, meta.json}.
//
// Correr:  node scripts/build-data.js
// Requiere credencial de Google (ver scripts/lib/sheets.js).

import fs from 'node:fs/promises';
import { readSheet, readKeyValueTab, getSheetTitles } from './lib/sheets.js';
import { enrichByScryfallIds } from './lib/scryfall.js';
import { loadCardKingdom } from './lib/cardkingdom.js';
import { getCotizacion } from './lib/cotizacion.js';

const ROOT = new URL('../', import.meta.url);
const p = (rel) => new URL(rel, ROOT);

const readJson = async (rel) => JSON.parse(await fs.readFile(p(rel), 'utf8'));
const writeJson = async (rel, obj) =>
  fs.writeFile(p(rel), JSON.stringify(obj, null, 2) + '\n');

function parseFoil(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return !['', 'normal', 'no', 'false', '0', 'nonfoil', 'non-foil'].includes(s);
}

// La columna Color mezcla nombres en ingles (mono) y letras con barra (multi):
//   "Blue" -> [U] ; "U/G" -> [U,G] ; "Colorless" -> [C] ; "W/U/B/R/G" -> [W,U,B,R,G]
const COLOR_NAME_TO_LETTER = {
  WHITE: 'W', BLUE: 'U', BLACK: 'B', RED: 'R', GREEN: 'G', COLORLESS: 'C',
  W: 'W', U: 'U', B: 'B', R: 'R', G: 'G', C: 'C',
};
function parseColors(v) {
  const s = String(v ?? '').trim();
  if (!s) return [];
  return s.split(/[\s,;/|]+/)
    .map((x) => COLOR_NAME_TO_LETTER[x.trim().toUpperCase()] || null)
    .filter(Boolean);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const cfg = await readJson('config.json');
  const col = cfg.columns;

  if (!cfg.sheetId || cfg.sheetId.startsWith('PEGAR_AQUI')) {
    throw new Error('Falta configurar sheetId en config.json');
  }

  console.log('1/5 Leyendo Google Sheet...');
  const titles = await getSheetTitles(cfg.sheetId);
  // Pestaña de datos: la configurada si existe; si no, la primera que no sea la de Config.
  const dataTab = (cfg.sheetRange && titles.includes(cfg.sheetRange))
    ? cfg.sheetRange
    : (titles.find((t) => t !== cfg.configTab) || titles[0]);
  if (!dataTab) throw new Error('El spreadsheet no tiene ninguna pestaña.');
  console.log(`  pestaña de datos: "${dataTab}"`);
  const rawRows = await readSheet(cfg.sheetId, dataTab);
  console.log(`  ${rawRows.length} filas leidas`);

  // Pestaña "Config" opcional (clave|valor) para editar textos/WhatsApp desde el Sheet.
  const siteOverride = {};
  if (titles.includes(cfg.configTab)) {
    const kv = await readKeyValueTab(cfg.sheetId, cfg.configTab);
    const allowed = ['storeName', 'tagline', 'whatsappNumber', 'whatsappMessagePrefix'];
    for (const k of allowed) if (kv[k]) siteOverride[k] = kv[k];
    if (kv.showUyu != null && kv.showUyu !== '') {
      siteOverride.showUyu = !/^(no|false|0)$/i.test(String(kv.showUyu).trim());
    }
    if (kv.whatsappNumber) siteOverride.whatsappNumber = String(kv.whatsappNumber).replace(/[^\d]/g, '');
    console.log(`  pestaña Config encontrada: ${Object.keys(siteOverride).join(', ') || '(vacia)'}`);
  }

  // Normalizar filas y fusionar duplicados por (scryfallId + foil).
  const byId = new Map();
  for (const r of rawRows) {
    const scryfallId = String(r[col.scryfallId] ?? '').trim();
    if (!scryfallId) continue;
    const foil = parseFoil(r[col.foil]);
    const id = `${scryfallId}:${foil ? 'f' : 'n'}`;
    const quantity = Math.max(0, Math.trunc(num(r[col.quantity]) ?? 0));

    if (byId.has(id)) {
      byId.get(id).quantity += quantity;
      continue;
    }
    byId.set(id, {
      id,
      scryfallId,
      name: String(r[col.name] ?? '').trim(),
      color: parseColors(r[col.color]),
      manaValue: num(r[col.manaValue]),
      setCode: String(r[col.setCode] ?? '').trim(),
      setName: String(r[col.setName] ?? '').trim(),
      collectorNumber: String(r[col.collectorNumber] ?? '').trim(),
      foil,
      rarity: String(r[col.rarity] ?? '').trim().toLowerCase(),
      quantity,
    });
  }
  const rows = [...byId.values()];
  console.log(`  ${rows.length} cartas unicas (fusionando duplicados)`);

  console.log('2/5 Enriqueciendo con Scryfall (tipo + imagenes)...');
  const scry = await enrichByScryfallIds(rows.map((r) => r.scryfallId));

  console.log('3/5 Bajando pricelist de Card Kingdom...');
  const ck = await loadCardKingdom();
  console.log(`  ${ck.size} precios indexados por scryfall_id`);

  const overrides = (await readJson('data/overrides-precio.json')).prices || {};

  console.log('4/5 Matcheando precios y armando cartas...');
  const cotizacion = await getCotizacion();
  const rate = cotizacion.usdToUyu;

  // Piso de precio: rarezas valiosas (rare/mythic/promo) no bajan de minPriceUsd.
  const minPrice = Number(cfg.minPriceUsd) || 0;
  const minPriceRarities = new Set(cfg.minPriceRarities || []);

  const cards = [];
  const sinPrecio = [];
  let pisadas = 0;

  for (const r of rows) {
    const enr = scry.get(r.scryfallId) || {};

    // Precio: override (por id foil-aware o por scryfallId pelado) -> Card Kingdom.
    let priceUsd = null;
    let priceSource = null;
    let ckUrl = null;

    const ovKey = `${r.scryfallId}${r.foil ? ':foil' : ''}`;
    if (num(overrides[ovKey]) != null) {
      priceUsd = num(overrides[ovKey]);
      priceSource = 'override';
    } else if (num(overrides[r.scryfallId]) != null && !r.foil) {
      priceUsd = num(overrides[r.scryfallId]);
      priceSource = 'override';
    } else {
      const hit = ck.lookup(r.scryfallId, r.foil);
      if (hit) {
        priceUsd = hit.priceUsd;
        priceSource = 'cardkingdom';
        ckUrl = hit.url;
      }
    }

    if (priceUsd == null) {
      sinPrecio.push({
        name: r.name, setName: r.setName, setCode: r.setCode,
        collectorNumber: r.collectorNumber, foil: r.foil, scryfallId: r.scryfallId,
        motivo: 'Card Kingdom no lo lista para ese scryfall_id + foil',
      });
    } else if (minPrice > 0 && priceUsd < minPrice && minPriceRarities.has(r.rarity)) {
      // Rare/mythic/promo por debajo del piso -> se llevan al minimo.
      priceUsd = minPrice;
      pisadas++;
    }

    const priceUyu = (priceUsd != null && rate) ? Math.round(priceUsd * rate) : null;

    cards.push({
      id: r.id,
      name: r.name,
      setCode: r.setCode,
      setName: r.setName,
      collectorNumber: r.collectorNumber,
      color: r.color,
      manaValue: r.manaValue,
      rarity: r.rarity,
      foil: r.foil,
      quantity: r.quantity,
      scryfallId: r.scryfallId,
      tipo: enr.tipo || 'Otro',
      typeLine: enr.typeLine || '',
      image: enr.image || null,
      imageSmall: enr.imageSmall || null,
      scryfallUri: enr.scryfallUri || null,
      priceUsd,
      priceUyu,
      priceSource,
      ckUrl,
    });
  }

  // Orden por defecto: nombre.
  cards.sort((a, b) => a.name.localeCompare(b.name, 'es'));

  const meta = {
    generatedAt: new Date().toISOString(),
    cotizacion,
    totalCartas: cards.length,
    totalUnidades: cards.reduce((s, c) => s + c.quantity, 0),
    conPrecio: cards.filter((c) => c.priceUsd != null).length,
    sinPrecio: sinPrecio.length,
  };

  console.log('5/5 Escribiendo JSON...');
  await writeJson('public/data/cards.json', { meta, cards });
  await writeJson('public/data/reporte-sin-precio.json', sinPrecio);
  await writeJson('public/data/meta.json', meta);
  await writeJson('public/data/site.json', siteOverride);

  console.log('\nListo:');
  console.log(`  cartas: ${meta.totalCartas} (${meta.conPrecio} con precio, ${meta.sinPrecio} sin precio)`);
  if (pisadas) console.log(`  precio pisado a US$ ${minPrice} (rare/mythic/promo): ${pisadas} cartas`);
  console.log(`  unidades: ${meta.totalUnidades}`);
  if (cotizacion.usdToUyu) {
    console.log(`  cotizacion: 1 USD = ${cotizacion.usdToUyu} UYU (${cotizacion.fuente}${cotizacion.stale ? ', DESACTUALIZADA' : ''})`);
  }
  if (sinPrecio.length) {
    console.log(`  revisa public/data/reporte-sin-precio.json (${sinPrecio.length} cartas)`);
  }
}

main().catch((e) => {
  console.error('\nERROR en el build:', e.message);
  process.exit(1);
});
