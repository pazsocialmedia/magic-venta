'use strict';

const CART_KEY = 'mtg-store-cart-v1';
const state = {
  config: {},
  cards: [],
  meta: null,
  byId: new Map(),
  cart: loadCart(),          // Map<id, qty>
  filters: {
    search: '', colors: new Set(), set: '', rarity: '', tipo: '',
    mana: '', foil: '', min: null, max: null, instock: false,
  },
  sort: 'name',
  group: 'none',
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ---------- carga ----------
async function init() {
  try {
    const [config, override, data] = await Promise.all([
      fetch('site.config.json').then((r) => r.json()).catch(() => ({})),
      fetch('data/site.json', { cache: 'no-cache' }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
      fetch('data/cards.json', { cache: 'no-cache' }).then((r) => r.json()),
    ]);
    // site.config.json = defaults; data/site.json = lo editado desde la pestaña Config del Sheet.
    state.config = { ...config, ...override };
    state.cards = data.cards || [];
    state.meta = data.meta || null;
    state.byId = new Map(state.cards.map((c) => [c.id, c]));
  } catch (e) {
    $('#grid').innerHTML = `<p class="empty">No pude cargar el catalogo (${e.message}).</p>`;
    return;
  }
  pruneCart();
  applyConfig();
  buildFilterOptions();
  bindEvents();
  render();
  renderCart();
}

function applyConfig() {
  const c = state.config;
  if (c.storeName) { $('#store-name').textContent = c.storeName; document.title = c.storeName; }
  $('#tagline').textContent = c.tagline || '';

  const m = state.meta;
  if (m) {
    const fecha = new Date(m.generatedAt);
    let txt = `Actualizado: ${fecha.toLocaleString('es-UY', { dateStyle: 'medium', timeStyle: 'short' })}`;
    const cot = m.cotizacion;
    if (cot && cot.usdToUyu) {
      txt += ` · 1 USD = ${cot.usdToUyu} UYU (${cot.fuente || 'cotizacion'}`;
      txt += cot.stale ? ', desactualizada)' : ')';
    }
    const el = $('#update-info');
    el.textContent = txt;
    if (cot && cot.stale) el.classList.add('stale');
  }
}

// ---------- filtros ----------
const COLOR_INFO = { W: ['W', 'Blanco'], U: ['U', 'Azul'], B: ['B', 'Negro'], R: ['R', 'Rojo'], G: ['G', 'Verde'], C: ['C', 'Incoloro'] };

function cardColorKeys(card) {
  return (card.color && card.color.length) ? card.color : ['C'];
}

function buildFilterOptions() {
  // Sets: solo los que tienen al menos una carta disponible (stock > 0).
  const disponibles = state.cards.filter((c) => c.quantity > 0);
  const sets = [...new Set(disponibles.map((c) => c.setName).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
  const rarities = [...new Set(state.cards.map((c) => c.rarity).filter(Boolean))].sort();
  const tipos = [...new Set(state.cards.map((c) => c.tipo).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
  const manas = [...new Set(state.cards.map((c) => c.manaValue).filter((v) => v != null))].sort((a, b) => a - b);
  const colorsPresent = new Set();
  state.cards.forEach((c) => cardColorKeys(c).forEach((k) => colorsPresent.add(k)));

  fillSelect('#filter-set', sets);
  fillSelect('#filter-rarity', rarities, capitalize);
  fillSelect('#filter-tipo', tipos);
  fillSelect('#filter-mana', manas);

  const chips = $('#filter-colors');
  ['W', 'U', 'B', 'R', 'G', 'C'].filter((k) => colorsPresent.has(k)).forEach((k) => {
    const [sym, label] = COLOR_INFO[k];
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = sym;
    chip.title = label;
    chip.setAttribute('aria-pressed', 'false');
    chip.dataset.color = k;
    chip.addEventListener('click', () => {
      const on = chip.getAttribute('aria-pressed') === 'true';
      chip.setAttribute('aria-pressed', String(!on));
      if (on) state.filters.colors.delete(k); else state.filters.colors.add(k);
      render();
    });
    chips.appendChild(chip);
  });
}

function fillSelect(sel, values, labelFn = (x) => x) {
  const el = $(sel);
  values.forEach((v) => {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = labelFn(v);
    el.appendChild(opt);
  });
}

function passesFilters(card) {
  const f = state.filters;
  if (f.search && !card.name.toLowerCase().includes(f.search)) return false;
  if (f.set && card.setName !== f.set) return false;
  if (f.rarity && card.rarity !== f.rarity) return false;
  if (f.tipo && card.tipo !== f.tipo) return false;
  if (f.mana !== '' && String(card.manaValue) !== String(f.mana)) return false;
  if (f.foil === 'foil' && !card.foil) return false;
  if (f.foil === 'normal' && card.foil) return false;
  if (f.instock && card.quantity <= 0) return false;
  if (f.colors.size) {
    const keys = cardColorKeys(card);
    if (![...f.colors].some((k) => keys.includes(k))) return false;
  }
  if (f.min != null && (card.priceUsd == null || card.priceUsd < f.min)) return false;
  if (f.max != null && (card.priceUsd == null || card.priceUsd > f.max)) return false;
  return true;
}

const COLOR_ORDER = { W: 0, U: 1, B: 2, R: 3, G: 4 };
const RARITY_ORDER = { common: 0, uncommon: 1, rare: 2, mythic: 3, special: 4, bonus: 5 };
function colorRank(card) {
  const cols = cardColorKeys(card);
  if (cols.length > 1) return 5;          // multicolor
  const c = cols[0];
  if (c === 'C') return 6;                // incoloro
  return COLOR_ORDER[c] ?? 7;
}
const rarityRank = (card) => RARITY_ORDER[card.rarity] ?? 9;
const byName = (a, b) => a.name.localeCompare(b.name, 'es');

function sortCards(cards) {
  const s = state.sort;
  const arr = [...cards];
  if (s === 'price-asc') arr.sort((a, b) => (a.priceUsd ?? Infinity) - (b.priceUsd ?? Infinity) || byName(a, b));
  else if (s === 'price-desc') arr.sort((a, b) => (b.priceUsd ?? -1) - (a.priceUsd ?? -1) || byName(a, b));
  else if (s === 'set') arr.sort((a, b) => (a.setName || '').localeCompare(b.setName || '', 'es') || byName(a, b));
  else if (s === 'color') arr.sort((a, b) => colorRank(a) - colorRank(b) || byName(a, b));
  else if (s === 'mana') arr.sort((a, b) => (a.manaValue ?? Infinity) - (b.manaValue ?? Infinity) || byName(a, b));
  else if (s === 'rarity') arr.sort((a, b) => rarityRank(a) - rarityRank(b) || byName(a, b));
  else arr.sort(byName);
  return arr;
}

// ---------- render grilla ----------
function render() {
  const filtered = sortCards(state.cards.filter(passesFilters));
  $('#result-count').textContent = `${filtered.length} carta${filtered.length === 1 ? '' : 's'}`;
  $('#empty').hidden = filtered.length > 0;

  const mount = $('#grid');
  mount.innerHTML = '';
  if (state.group === 'none') {
    mount.appendChild(gridOf(filtered));
    return;
  }
  for (const g of groupCards(filtered, state.group)) {
    const section = document.createElement('section');
    section.className = 'group';
    const header = document.createElement('div');
    header.className = 'group-header';
    header.innerHTML = `<span>${escapeHtml(g.label)}</span><span class="count">${g.cards.length}</span>`;
    section.appendChild(header);
    section.appendChild(gridOf(g.cards));
    mount.appendChild(section);
  }
}

function gridOf(cards) {
  const grid = document.createElement('div');
  grid.className = 'grid';
  const frag = document.createDocumentFragment();
  cards.forEach((card) => frag.appendChild(renderCard(card)));
  grid.appendChild(frag);
  return grid;
}

const TIPO_ORDER = ['Criatura', 'Planeswalker', 'Instantaneo', 'Conjuro', 'Artefacto', 'Encantamiento', 'Batalla', 'Tierra', 'Otro'];
const COLOR_GROUP = { W: ['Blanco', 0], U: ['Azul', 1], B: ['Negro', 2], R: ['Rojo', 3], G: ['Verde', 4] };

function groupInfo(card, by) {
  if (by === 'tipo') {
    const t = card.tipo || 'Otro';
    return { key: t, label: t, order: TIPO_ORDER.indexOf(t) >= 0 ? TIPO_ORDER.indexOf(t) : 99 };
  }
  if (by === 'color') {
    const cols = cardColorKeys(card);
    if (cols.length > 1) return { key: 'multi', label: 'Multicolor', order: 5 };
    if (cols[0] === 'C') return { key: 'C', label: 'Incoloro', order: 6 };
    const [name, ord] = COLOR_GROUP[cols[0]] || ['Otro', 7];
    return { key: cols[0], label: name, order: ord };
  }
  if (by === 'set') {
    const s = card.setName || card.setCode || '—';
    return { key: s, label: s, order: 0 };
  }
  if (by === 'rarity') {
    return { key: card.rarity || '—', label: capitalize(card.rarity || '—'), order: rarityRank(card) };
  }
  if (by === 'mana') {
    const mv = card.manaValue;
    if (mv == null) return { key: 'x', label: 'Sin coste', order: 999 };
    return { key: String(mv), label: `Maná ${mv}`, order: mv };
  }
  return { key: '—', label: '—', order: 0 };
}

function groupCards(cards, by) {
  const map = new Map();
  for (const c of cards) {
    const { key, label, order } = groupInfo(c, by);
    if (!map.has(key)) map.set(key, { label, order, cards: [] });
    map.get(key).cards.push(c);
  }
  return [...map.values()].sort((a, b) => (a.order - b.order) || a.label.localeCompare(b.label, 'es'));
}

function renderCard(card) {
  const inCart = state.cart.get(card.id) || 0;
  const agotada = card.quantity <= 0;

  const el = document.createElement('article');
  el.className = 'card' + (agotada ? ' agotada' : '');

  const imgSrc = card.imageSmall || card.image || '';
  el.innerHTML = `
    <div class="card-imgwrap">
      ${imgSrc ? `<img loading="lazy" src="${imgSrc}" alt="${escapeHtml(card.name)}" />` : ''}
      ${card.foil ? '<span class="foil-badge">FOIL</span>' : ''}
      <span class="stock-badge">${agotada ? 'Agotada' : 'x' + card.quantity}</span>
    </div>
    <div class="card-body">
      <span class="card-name">${escapeHtml(card.name)}</span>
      <span class="card-meta">${escapeHtml(card.setName || card.setCode)}${card.collectorNumber ? ' · #' + escapeHtml(card.collectorNumber) : ''}${card.tipo ? ' · ' + escapeHtml(card.tipo) : ''}</span>
      <span class="card-price">${priceHtml(card)}</span>
      <div class="card-add"></div>
    </div>`;

  const img = el.querySelector('img');
  if (img) img.addEventListener('click', () => openLightbox(card.image || imgSrc, card.name));

  renderAddControls(el.querySelector('.card-add'), card, inCart, agotada);
  return el;
}

function renderAddControls(container, card, inCart, agotada) {
  container.innerHTML = '';
  if (agotada || card.priceUsd == null) {
    const btn = document.createElement('button');
    btn.className = 'add-btn';
    btn.disabled = true;
    btn.textContent = agotada ? 'Sin stock' : 'Sin precio';
    container.appendChild(btn);
    return;
  }
  if (inCart <= 0) {
    const btn = document.createElement('button');
    btn.className = 'add-btn';
    btn.textContent = 'Agregar';
    btn.addEventListener('click', () => { setQty(card.id, 1); });
    container.appendChild(btn);
  } else {
    container.appendChild(qtyControls(card, inCart));
  }
}

function qtyControls(card, qty) {
  const wrap = document.createElement('div');
  wrap.className = 'qty-controls';
  const minus = document.createElement('button');
  minus.textContent = '−'; minus.setAttribute('aria-label', 'Quitar uno');
  minus.addEventListener('click', () => setQty(card.id, qty - 1));
  const num = document.createElement('span');
  num.className = 'qty-num'; num.textContent = qty;
  const plus = document.createElement('button');
  plus.textContent = '+'; plus.setAttribute('aria-label', 'Agregar uno');
  plus.disabled = qty >= card.quantity;
  plus.addEventListener('click', () => setQty(card.id, qty + 1));
  wrap.append(minus, num, plus);
  return wrap;
}

// ---------- carrito ----------
function setQty(id, qty) {
  const card = state.byId.get(id);
  if (!card) return;
  const clamped = Math.max(0, Math.min(qty, card.quantity));
  if (clamped <= 0) state.cart.delete(id);
  else state.cart.set(id, clamped);
  saveCart();
  render();
  renderCart();
}

function cartEntries() {
  const out = [];
  for (const [id, qty] of state.cart) {
    const card = state.byId.get(id);
    if (card) out.push({ card, qty });
  }
  out.sort((a, b) => a.card.name.localeCompare(b.card.name, 'es'));
  return out;
}

function totals() {
  let usd = 0, units = 0;
  for (const { card, qty } of cartEntries()) { usd += (card.priceUsd || 0) * qty; units += qty; }
  const rate = state.meta?.cotizacion?.usdToUyu || null;
  return { usd, units, uyu: rate ? usd * rate : null, rate };
}

function renderCart() {
  const entries = cartEntries();
  const itemsEl = $('#cart-items');
  itemsEl.innerHTML = '';
  $('#cart-empty').hidden = entries.length > 0;

  entries.forEach(({ card, qty }) => {
    const row = document.createElement('div');
    row.className = 'cart-item';
    row.innerHTML = `
      <span class="ci-name">${escapeHtml(card.name)}${card.foil ? ' ✨' : ''}</span>
      <span class="ci-price">US$ ${(card.priceUsd * qty).toFixed(2)}</span>
      <span class="ci-meta">${escapeHtml(card.setName || card.setCode)} · US$ ${card.priceUsd.toFixed(2)} c/u</span>`;
    row.appendChild(qtyControls(card, qty));
    itemsEl.appendChild(row);
  });

  const t = totals();
  $('#total-usd').textContent = `US$ ${t.usd.toFixed(2)}`;
  const uyuLine = $('#total-uyu-line');
  if (t.uyu != null && state.config.showUyu !== false) {
    uyuLine.hidden = false;
    $('#total-uyu').textContent = `$U ${Math.round(t.uyu).toLocaleString('es-UY')}`;
  } else {
    uyuLine.hidden = true;
  }

  $('#cart-count').textContent = t.units;
  $('#fab-count').textContent = t.units;

  const wa = $('#whatsapp-order');
  if (entries.length && state.config.whatsappNumber) {
    wa.setAttribute('aria-disabled', 'false');
    wa.href = `https://wa.me/${state.config.whatsappNumber}?text=${encodeURIComponent(orderText())}`;
  } else {
    wa.setAttribute('aria-disabled', 'true');
    wa.removeAttribute('href');
  }
}

function orderText() {
  const entries = cartEntries();
  const t = totals();
  const lines = [];
  if (state.config.whatsappMessagePrefix) lines.push(state.config.whatsappMessagePrefix, '');
  entries.forEach(({ card, qty }) => {
    const set = card.setName || card.setCode;
    const foil = card.foil ? ' (Foil)' : '';
    if (qty === 1) {
      lines.push(`• ${card.name}${foil} — ${set} — US$ ${card.priceUsd.toFixed(2)}`);
    } else {
      lines.push(`• ${qty}x ${card.name}${foil} — ${set} — US$ ${card.priceUsd.toFixed(2)} c/u = US$ ${(card.priceUsd * qty).toFixed(2)}`);
    }
  });
  // Solo mostramos el total cuando hay mas de una carta distinta (si es una sola, la linea ya lo dice).
  if (entries.length > 1) {
    lines.push('');
    let total = `Total: US$ ${t.usd.toFixed(2)}`;
    if (t.uyu != null) total += ` (aprox. $U ${Math.round(t.uyu).toLocaleString('es-UY')})`;
    total += ` — ${t.units} carta${t.units === 1 ? '' : 's'}`;
    lines.push(total);
  }
  return lines.join('\n');
}

async function copyOrder() {
  const text = orderText();
  try {
    await navigator.clipboard.writeText(text);
    flash('#copy-order', 'Copiado ✓');
  } catch {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
    flash('#copy-order', 'Copiado ✓');
  }
}

function flash(sel, msg) {
  const btn = $(sel);
  const prev = btn.textContent;
  btn.textContent = msg;
  setTimeout(() => { btn.textContent = prev; }, 1400);
}

// ---------- lightbox ----------
function openLightbox(src, alt) {
  if (!src) return;
  $('#lightbox-img').src = src;
  $('#lightbox-img').alt = alt || '';
  $('#lightbox').hidden = false;
}

// ---------- eventos ----------
function bindEvents() {
  $('#search').addEventListener('input', (e) => { state.filters.search = e.target.value.trim().toLowerCase(); render(); });
  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; render(); });
  $('#group').addEventListener('change', (e) => { state.group = e.target.value; render(); });

  const toTop = $('#to-top');
  window.addEventListener('scroll', () => { toTop.hidden = window.scrollY < 400; }, { passive: true });
  toTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  $('#toggle-filters').addEventListener('click', (e) => {
    const panel = $('#filters');
    panel.hidden = !panel.hidden;
    e.target.setAttribute('aria-expanded', String(!panel.hidden));
  });
  $('#filter-set').addEventListener('change', (e) => { state.filters.set = e.target.value; render(); });
  $('#filter-rarity').addEventListener('change', (e) => { state.filters.rarity = e.target.value; render(); });
  $('#filter-tipo').addEventListener('change', (e) => { state.filters.tipo = e.target.value; render(); });
  $('#filter-mana').addEventListener('change', (e) => { state.filters.mana = e.target.value; render(); });
  $('#filter-foil').addEventListener('change', (e) => { state.filters.foil = e.target.value; render(); });
  $('#filter-instock').addEventListener('change', (e) => { state.filters.instock = e.target.checked; render(); });
  $('#filter-min').addEventListener('input', (e) => { state.filters.min = e.target.value === '' ? null : Number(e.target.value); render(); });
  $('#filter-max').addEventListener('input', (e) => { state.filters.max = e.target.value === '' ? null : Number(e.target.value); render(); });
  $('#clear-filters').addEventListener('click', clearFilters);

  $('#copy-order').addEventListener('click', copyOrder);
  $('#clear-cart').addEventListener('click', () => { state.cart.clear(); saveCart(); render(); renderCart(); });
  $('#cart-fab').addEventListener('click', () => $('#cart').scrollIntoView({ behavior: 'smooth' }));

  const lb = $('#lightbox');
  lb.addEventListener('click', () => { lb.hidden = true; });
}

function clearFilters() {
  state.filters = { search: '', colors: new Set(), set: '', rarity: '', tipo: '', mana: '', foil: '', min: null, max: null, instock: false };
  $('#search').value = ''; $('#filter-set').value = ''; $('#filter-rarity').value = '';
  $('#filter-tipo').value = ''; $('#filter-mana').value = ''; $('#filter-foil').value = '';
  $('#filter-instock').checked = false; $('#filter-min').value = ''; $('#filter-max').value = '';
  $$('#filter-colors .chip').forEach((c) => c.setAttribute('aria-pressed', 'false'));
  render();
}

// ---------- helpers ----------
function priceHtml(card) {
  if (card.priceUsd == null) return '<span class="noprice">Consultar</span>';
  let html = `US$ ${card.priceUsd.toFixed(2)}`;
  if (card.priceUyu != null && state.config.showUyu !== false) {
    html += `<span class="uyu">$U ${card.priceUyu.toLocaleString('es-UY')}</span>`;
  }
  return html;
}

function loadCart() {
  try {
    const raw = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
    return new Map(raw);
  } catch { return new Map(); }
}
function saveCart() {
  localStorage.setItem(CART_KEY, JSON.stringify([...state.cart]));
}
function pruneCart() {
  // Sacar del carrito cartas que ya no existen o quedaron sin stock, y capar cantidades.
  for (const [id, qty] of [...state.cart]) {
    const card = state.byId.get(id);
    if (!card || card.quantity <= 0) state.cart.delete(id);
    else if (qty > card.quantity) state.cart.set(id, card.quantity);
  }
  saveCart();
}

const capitalize = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

init();
