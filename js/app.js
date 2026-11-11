import { resolveJurisdiction, applyPopulation, applySettlementRoles, getLevel, scoreLevel, scoreMechanism, kindProperties, levelPlaces, placeVerdict } from './model.js';

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const BRANCH_INFO = {
  direct: { name: 'Direct', longName: 'Direct decision making', groupName: 'Direct decision-making institutions', desc: 'The people decide themselves: referendums and general assemblies.' },
  representative: { name: 'Representative', longName: 'Representative bodies', groupName: 'Representative institutions', desc: 'Elected, individually accountable representatives decide.' },
};

const state = { data: null, loc: null, path: [] }; // path: [levelId, branch, mechIndex, propIndex]
const $ = sel => document.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(c));
  return n;
};

// ---------- data ----------
async function loadData() {
  const get = p => fetch(`data/${p}`).then(r => { if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.json(); });
  const [catalog, index, interests] = await Promise.all([get('catalog.json'), get('index.json'), get('interests.json')]);
  const jurisdictions = await Promise.all(index.jurisdictions.map(get));
  return { catalog, unions: index.unions, jurisdictions, interests };
}

// ---------- geocoding ----------
async function nominatim(path, params) {
  const url = `${NOMINATIM}/${path}?` + new URLSearchParams({ format: 'jsonv2', addressdetails: 1, ...params });
  const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) })
    .catch(e => { throw new Error(e.name === 'TimeoutError' ? 'the geocoding service (OpenStreetMap Nominatim) did not answer within 15 seconds; please try again' : e.message); });
  if (!r.ok) throw new Error(`Geocoding failed (${r.status})`);
  return r.json();
}
const reverse = (lat, lon) => nominatim('reverse', { lat, lon, zoom: 18 });
// Nominatim's first hit is often a same-named street elsewhere ("Patrick Street, Cork" in Fermoy): take up to five
// and prefer one whose town or city appears in the query.
async function search(q) {
  const rs = await nominatim('search', { q, limit: 5 });
  const words = q.toLocaleLowerCase().split(/[\s,]+/).filter(w => w.length > 2);
  const placeOf = r => Object.entries(r.address || {}).filter(([k]) => /^(city|town|village|municipality|suburb|city_district|county|state_district)$/.test(k)).map(([, v]) => v.toLocaleLowerCase());
  const best = rs.find(r => placeOf(r).some(p => words.some(w => p.includes(w))));
  return best ? [best, ...rs.filter(r => r !== best)] : rs;
}
// The settlement (city, town or village) around a point, with its population from OpenStreetMap when tagged.
async function settlementAt(lat, lon) {
  const r = await nominatim('reverse', { lat, lon, zoom: 10, extratags: 1 });
  const pop = parseInt(String(r?.extratags?.population || '').replace(/[\s,.]/g, ''), 10);
  return r && !r.error ? { name: r.name, type: r.addresstype, population: Number.isFinite(pop) ? pop : null } : null;
}

// ---------- map ----------
const map = L.map('map', { worldCopyJump: true }).setView([46, 15], 4);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
let marker = null;

// A spinner over the map while a place is being looked up.
const spinner = el('div', { class: 'map-busy', role: 'status', 'aria-label': 'Looking up…' }, el('span', { class: 'spin' }));
document.getElementById('map').appendChild(spinner);
let busyCount = 0;
function busy(on) { busyCount = Math.max(0, busyCount + (on ? 1 : -1)); spinner.classList.toggle('on', busyCount > 0); }
// Lookup timings in the console (?timing in the URL), to see which request is slow.
const timing = (what, t0) => { if (/[?&]timing\b/.test(location.search)) console.log(`[timing] ${what}: ${Math.round(performance.now() - t0)} ms`); };

// The start panel (what the site is, search, examples) shows until a place is chosen; `has-place` on <html> swaps it
// for the header search and the recent places, and gives the map its full height.
const root = document.documentElement;
function setStarted(on) {
  if (root.classList.contains('has-place') === on) return;
  root.classList.toggle('has-place', on);
  map.invalidateSize();
}
// Back to the start: no place, no tree (the browser's Back button from the first place lands here).
function showStart() {
  state.loc = null; state.path = [];
  if (marker) { marker.remove(); marker = null; }
  if (areaLayer) { areaLayer.remove(); areaLayer = null; }
  areaKey = null; viewBeforeArea = null;
  showAlternatives([]);
  $('#place').replaceChildren(); $('#trail').replaceChildren(); $('#tree').replaceChildren();
  $('#status').textContent = '';
  setLegend(null);
  setStarted(false);
  map.setView([46, 15], 4);
}

async function locate(lat, lon, { zoom, result, keepPath } = {}) {
  setStarted(true);
  busy(true);
  let stopped = false;
  const stop = () => { if (!stopped) { stopped = true; busy(false); } };
  const t0 = performance.now();
  lat = +(+lat).toFixed(5); lon = +(+lon).toFixed(5);
  if (marker) marker.setLatLng([lat, lon]); else marker = L.marker([lat, lon]).addTo(map);
  if (areaLayer) { areaLayer.remove(); areaLayer = null; }
  areaKey = null; viewBeforeArea = null;
  if (zoom) map.setView([lat, lon], zoom);
  $('#place').replaceChildren(el('span', { class: 'loading' }, 'Looking up this location…'));
  // The settlement's population (a second lookup) is fetched alongside the address, not after it.
  const settlementP = settlementAt(lat, lon).catch(() => null);
  try {
    const r = result || await reverse(lat, lon);
    if (!r || r.error || !r.address) throw new Error(r?.error || 'No address found here.');
    const address = r.address;
    state.loc = {
      lat, lon, address,
      label: r.name || address.road || address.suburb || address.city || address.town || address.village || r.display_name,
      display: r.display_name,
    };
    state.loc.jurisdiction = resolveJurisdiction(state.data.jurisdictions, address);
    state.loc.places = levelPlaces(address, state.data.catalog, state.data.unions, state.loc.jurisdiction);
    state.loc.jurisdiction = applySettlementRoles(state.loc.jurisdiction, state.loc.places);
    if (!keepPath) state.path = [];
    writeHash(!keepPath);
    // Some requirements depend on population (e.g. BG general assemblies: up to 10,000 inhabitants). Wait briefly
    // for it (0.6 s), so the chips usually appear once with their final colours instead of changing a moment later. If the lookup
    // is slow, show the page anyway and update the colours in place (without the fade-in) when it arrives.
    const loc = state.loc;
    const withPopulation = settlementP.then(settlement => {
      if (state.loc !== loc || !settlement) return false;
      loc.settlement = settlement;
      loc.jurisdiction = applyPopulation(loc.jurisdiction, settlement);
      return true;
    }).catch(() => false); // no population: keep the data's own statuses
    const early = await Promise.race([withPopulation.then(() => true), new Promise(res => setTimeout(() => res(false), 600))]);
    timing('address + population', t0);
    if (state.loc !== loc) return;
    render();
    stop();
    recordVisit(loc);
    if (!early && await withPopulation && state.loc === loc) {
      document.body.classList.add('quiet');
      render();
      requestAnimationFrame(() => document.body.classList.remove('quiet'));
    }
  } catch (e) {
    $('#place').replaceChildren(`Could not look up this location: ${e.message}`);
  } finally {
    stop();
  }
}

// ---------- area outline ----------
// When a territorial level is open (country, county, municipality, …), outline its area on the map. Overpass lists
// the administrative boundaries around the point; the one whose name matches the level's place name is drawn, with
// its simplified shape from Nominatim. Levels without a matching boundary (home, building, union) show no outline.
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
let areaLayer = null, areaKey = null, viewBeforeArea = null;
const areasCache = new Map(), shapeCache = new Map();
const bareName = n => String(n || '').toLocaleLowerCase()
  .replace(/^(община|област|municipality of|county|kanton|bezirk)\s+/, '').replace(/\s+(municipality|county|municipal district)$/, '').trim();
// Match boundaries to levels from the broadest down, each one finer than the last: a city and its region often share
// a name (Sofia, Zürich), and this keeps the region for the county or state and the city for the municipality.
const BROAD_TO_FINE = ['country', 'state', 'county', 'municipality', 'town', 'village', 'neighbourhood'];
function pickArea(areas, places, levelId) {
  let floor = 0;
  for (const id of BROAD_TO_FINE) {
    const name = places[id]?.absent ? null : places[id]?.name;
    if (!name) { if (id === levelId) return null; continue; }
    const want = bareName(name);
    const found = areas.filter(a => a.level > floor && a.names.some(n => n === name || bareName(n) === want))
      .sort((a, b) => a.level - b.level)[0];
    if (id === levelId) return found || null;
    if (found) floor = found.level;
  }
  return null;
}
// Nominatim reverse zoom per level (3 country, 5 state, 8 county, 10 city …); a jurisdiction can override (`mapZoom`).
const MAP_ZOOM = { country: 3, state: 5, county: 8, municipality: 10, town: 12, village: 12, neighbourhood: 12 };
async function shapeAtZoom(loc, levelId) {
  const zoom = loc.jurisdiction?.mapZoom?.[levelId] ?? MAP_ZOOM[levelId];
  const place = loc.places[levelId]?.name;
  if (!zoom || !place) return null;
  const r = await nominatim('reverse', { lat: loc.lat, lon: loc.lon, zoom, polygon_geojson: 1, polygon_threshold: 0.001, namedetails: 1 });
  const names = [r?.name, ...Object.values(r?.namedetails || {})].filter(Boolean);
  const want = bareName(place);
  const ok = r?.osm_type === 'relation' && /Polygon/.test(r.geojson?.type || '') && names.some(n => n === place || bareName(n) === want);
  return ok ? r.geojson : null;
}
// Some boundaries are never returned by reverse lookup (Sofia's Stolichna municipality): search for the place by name.
async function shapeBySearch(loc, levelId) {
  const place = loc.places[levelId]?.name;
  if (!place) return null;
  const rs = await nominatim('search', { q: `${place}, ${loc.address.country || ''}`, limit: 5, polygon_geojson: 1, polygon_threshold: 0.001, namedetails: 1 });
  const want = bareName(place);
  const r = (rs || []).find(r => r.osm_type === 'relation' && /Polygon/.test(r.geojson?.type || '')
    && [r.name, ...Object.values(r.namedetails || {})].some(n => n === place || bareName(n) === want)
    && pointIn(r.boundingbox, loc));
  return r ? r.geojson : null;
}
const pointIn = (bb, { lat, lon }) => bb && lat >= +bb[0] && lat <= +bb[1] && lon >= +bb[2] && lon <= +bb[3];
async function areasAround(lat, lon) {
  const key = `${lat},${lon}`;
  if (!areasCache.has(key)) {
    const q = `[out:json][timeout:20];is_in(${lat},${lon})->.a;rel(pivot.a)[boundary=administrative];out tags;`;
    const ask = url => fetch(url, { method: 'POST', body: new URLSearchParams({ data: q }), signal: AbortSignal.timeout(15000) })
      .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
    areasCache.set(key, ask(OVERPASS[0]).catch(() => ask(OVERPASS[1])) // the main server is often busy
      .then(r => r.elements.map(e => ({ id: e.id, level: +e.tags.admin_level || 99, names: Object.entries(e.tags).filter(([k]) => k === 'name' || k.startsWith('name:') || k === 'official_name').map(([, v]) => v) })))
      .catch(e => { areasCache.delete(key); throw e; }));
  }
  return areasCache.get(key);
}
async function areaShape(id) {
  if (!shapeCache.has(id)) {
    shapeCache.set(id, nominatim('lookup', { osm_ids: `R${id}`, polygon_geojson: 1, polygon_threshold: 0.001 })
      .then(([r]) => r?.geojson && /Polygon/.test(r.geojson.type) ? r.geojson : null)
      .catch(e => { shapeCache.delete(id); throw e; }));
  }
  return shapeCache.get(id);
}
function clearArea() {
  if (areaLayer) { areaLayer.remove(); areaLayer = null; }
  if (viewBeforeArea) { map.setView(viewBeforeArea.center, viewBeforeArea.zoom); viewBeforeArea = null; }
  areaKey = null;
}
async function showArea(levelId) {
  const loc = state.loc;
  const place = levelId && loc?.places?.[levelId];
  const lvl = state.data.catalog.levels.find(l => l.id === levelId);
  if (!place?.name || lvl?.kind !== 'territorial' || ['home', 'entrance', 'building', 'union'].includes(levelId)) { clearArea(); return; }
  const key = `${loc.lat},${loc.lon}|${levelId}`;
  if (key === areaKey) return;
  areaKey = key;
  if (areaLayer) { areaLayer.remove(); areaLayer = null; }
  try {
    // First ask Nominatim for the boundary at this level's zoom (one quick request); if its name is not the level's
    // place, fall back to matching the boundaries Overpass lists around the point.
    let shape = await shapeAtZoom(loc, levelId).catch(() => null);
    if (!shape) shape = await shapeBySearch(loc, levelId).catch(() => null);
    if (!shape) {
      const area = pickArea(await areasAround(loc.lat, loc.lon), loc.places, levelId);
      shape = area && await areaShape(area.id);
    }
    if (!shape || areaKey !== key) return;
    if (!viewBeforeArea) viewBeforeArea = { center: map.getCenter(), zoom: map.getZoom() };
    areaLayer = L.geoJSON(shape, { interactive: false, style: { color: '#1f7a6d', weight: 2, fillColor: '#1f7a6d', fillOpacity: 0.08 } }).addTo(map);
    map.fitBounds(areaLayer.getBounds(), { padding: [12, 12] });
  } catch { if (areaKey === key) areaKey = null; /* no outline (a retry is allowed): the page works without it */ }
}

map.on('click', e => { showAlternatives([]); locate(e.latlng.lat, e.latlng.lng); });
// Other matches of a search, as small links under the address: the first hit can be a same-named street elsewhere.
function showAlternatives(rs, chosen) {
  let box = document.getElementById('alts');
  if (!box) { box = el('div', { id: 'alts', class: 'alts' }); $('#place').after(box); }
  const short = r => {
    const a = r.address || {};
    const town = a.city || a.town || a.village || a.hamlet || a.suburb || a.municipality;
    const region = a.county || a.state_district || a.state;
    const parts = [a.road || r.name, town, region && region !== town ? region : null].filter(Boolean);
    return parts.length > 1 ? parts.join(', ') : r.display_name.split(', ').slice(0, 3).join(', ');
  };
  const seen = new Set(chosen ? [short(chosen)] : []);
  const items = rs.map(r => ({ r, label: short(r) }))
    .filter(x => !seen.has(x.label) && seen.add(x.label)).slice(0, 4);
  box.replaceChildren(...(items.length ? ['Other matches: ', ...items.flatMap((x, i) => [i ? ' · ' : '',
    el('button', { type: 'button', onclick: () => { showAlternatives([]); locate(x.r.lat, x.r.lon, { zoom: 16 }); } }, x.label)]),
    el('span', { class: 'alts-hint' }, ' Not the right place? Try the street\u2019s full name.')] : []));
}
// The same search runs from the header's form and from the start panel's form.
const onSearch = async e => {
  e.preventDefault();
  const q = e.currentTarget.querySelector('input').value.trim();
  if (!q) return;
  $('#q').value = q;
  setStarted(true);
  busy(true);
  const btn = e.submitter || e.currentTarget.querySelector('button'); if (btn) btn.disabled = true;
  $('#place').replaceChildren(el('span', { class: 'loading' }, 'Searching…'));
  const t0 = performance.now();
  try {
    const rs = await search(q), [r] = rs;
    showAlternatives([]);
    timing('search', t0);
    if (!r) { $('#place').replaceChildren(`Nothing found for “${q}”.`); return; }
    // A search hit without its settlement in the address ("Main Street, Bray"): look the point up again for the full address.
    const a = r.address || {};
    await locate(r.lat, r.lon, { zoom: 16, result: (a.city || a.town || a.village || a.hamlet) ? r : undefined });
    showAlternatives(rs.slice(1), r);
  } catch (err) {
    $('#place').replaceChildren(err.message);
  } finally {
    busy(false);
    if (btn) btn.disabled = false;
  }
};
$('#search').addEventListener('submit', onSearch);
$('#start-search').addEventListener('submit', onSearch);
// "Use my location" on the start panel (offered only where the browser can tell it).
if (navigator.geolocation) {
  const btn = $('#locate-me'), note = $('#locate-note');
  btn.hidden = false;
  btn.addEventListener('click', () => {
    btn.disabled = true; note.textContent = 'Finding your location…';
    navigator.geolocation.getCurrentPosition(
      pos => { btn.disabled = false; note.textContent = ''; locate(pos.coords.latitude, pos.coords.longitude, { zoom: 16 }); },
      () => { btn.disabled = false; note.textContent = 'Your location is not available. Search for an address or choose on the map.'; },
      { timeout: 10000, maximumAge: 600000 });
  });
}
// ---------- recent places (the chips under the map) ----------
// Three most recently viewed places, then the most viewed one, kept in this browser. Until there are enough,
// the built-in examples fill the gaps.
const DEFAULT_PLACES = [...document.querySelectorAll('#try button')].map(b => ({ label: b.textContent, lat: +b.dataset.lat, lon: +b.dataset.lon }));
function placeHistory(value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem('freedom-places') || '[]');
    localStorage.setItem('freedom-places', JSON.stringify(value));
  } catch { /* storage unavailable */ }
  return value || [];
}
function recordVisit(loc) {
  const a = loc.address;
  const label = [loc.places.neighbourhood?.name, a.city || a.town || a.village || a.hamlet].filter(Boolean).join(', ');
  if (!label) return;
  const hist = placeHistory();
  const prev = hist.find(p => p.label === label);
  const next = [{ label, lat: loc.lat, lon: loc.lon, n: (prev?.n || 0) + 1, t: Date.now() }, ...hist.filter(p => p.label !== label)];
  placeHistory(next.slice(0, 50));
  renderPlaces();
}
function renderPlaces() {
  const hist = placeHistory();
  // Most viewed; on a tie, the more recent one.
  const top = hist.reduce((best, p) => (!best || p.n > best.n || (p.n === best.n && p.t > best.t) ? p : best), null);
  const shown = [...hist].sort((x, y) => y.t - x.t).filter(p => p !== top).slice(0, 3);
  const unused = DEFAULT_PLACES.filter(d => d.label !== top?.label && !shown.some(p => p.label === d.label));
  while (shown.length < 3 && unused.length) shown.push(unused.shift());
  const last = top || unused.shift();
  $('#places').replaceChildren(...[...shown, last].filter(Boolean).map(p => el('button', {
    type: 'button', title: p === top ? `Your most viewed place (${p.n} views)` : (p.t ? 'Recently viewed' : 'Example'),
    onclick: () => locate(p.lat, p.lon, { zoom: 16 }),
  }, p.label)));
}
renderPlaces();
$('#try').addEventListener('click', e => {
  const b = e.target.closest('button[data-lat]');
  if (b) locate(b.dataset.lat, b.dataset.lon, { zoom: 16 });
});

// ---------- shared interests (wiki-style) ----------
// Added chips and "not applicable here" marks are shared through server.py. If the site is served without it
// (plain static hosting), they fall back to this browser only.
const slug = s => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
function interestKey(levelId) {
  const cc = state.loc.address.country_code || 'xx';
  const place = state.loc.places[levelId]?.name || '';
  return [cc, levelId, place].join('|').toLowerCase().replace(/[^\w\- .,'()/|À-ɏЀ-ӿ]/g, '').slice(0, 200);
}
const interestCache = new Map();
let sharedApi = true;
function localStore(key, value) {
  try {
    const all = JSON.parse(localStorage.getItem('freedom-interests') || '{}');
    if (value === undefined) return all[key] || { added: [], hidden: [] };
    all[key] = value; localStorage.setItem('freedom-interests', JSON.stringify(all));
  } catch { /* storage unavailable */ }
  return value || { added: [], hidden: [] };
}
// A server that answers with its own JSON error (a limit was reached, bad input) is `refused`: the change was not made,
// but the server is there, so the page keeps using it. Anything else (no server.py, network down) is not.
async function api(method, path, body) {
  const r = await fetch(path, method === 'GET' ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = (r.headers.get('content-type') || '').includes('json');
  if (!r.ok) {
    const msg = json ? (await r.json().catch(() => ({}))).error : null;
    throw Object.assign(new Error(msg || String(r.status)), { status: r.status, refused: Boolean(msg) });
  }
  if (!json) throw new Error(r.status);
  return r.json();
}
// A short message at the bottom of the screen, e.g. when the server refuses a change.
function notice(text) {
  let box = document.getElementById('notice');
  if (!box) { box = el('div', { id: 'notice', class: 'notice', role: 'status' }); document.body.append(box); }
  box.textContent = text;
  box.classList.add('on');
  clearTimeout(notice.timer);
  notice.timer = setTimeout(() => box.classList.remove('on'), 6000);
}
async function loadInterests(key) {
  let e;
  if (sharedApi) {
    try { e = await api('GET', `api/interests?key=${encodeURIComponent(key)}`); }
    catch { sharedApi = false; }
  }
  if (!e) e = localStore(key);
  interestCache.set(key, e);
  return e;
}
async function changeInterests(key, path, body, apply) {
  let e;
  if (sharedApi) {
    try { e = await api('POST', path, { key, ...body }); }
    catch (err) {
      if (err.refused) { notice(err.message); render(); return; }
      sharedApi = false;
    }
  }
  if (!e) { e = structuredClone(interestCache.get(key) || { added: [], hidden: [] }); apply(e); localStore(key, e); }
  interestCache.set(key, e);
  render();
}
const addInterest = (key, label) => changeInterests(key, 'api/interests', { label }, e => {
  if (!e.added.some(a => a.label.toLowerCase() === label.toLowerCase())) e.added.push({ id: 'u:' + Date.now().toString(36), label });
});
const hideInterest = (key, id) => changeInterests(key, 'api/interests/hide', { id }, e => { if (!e.hidden.includes(id)) e.hidden.push(id); });

// The site's own list for a level: the country's list if it has one (data/interests.json "countries"), else the default.
const siteInterests = (cc, levelId) => state.data.interests.countries?.[cc]?.[levelId] ?? state.data.interests[levelId] ?? [];
// Editor mode (the owner's local copy, server.py --edit): adding, removing and dragging chips changes that list itself.
let editor = false;
let refocus = null;
async function saveSiteInterests(cc, levelId, labels) {
  try {
    const r = await api('POST', 'api/site-interests', { country: cc, level: levelId, labels });
    ((state.data.interests.countries ??= {})[cc] ??= {})[levelId] = r.labels;
    $('#status').textContent = '';
  } catch (err) { $('#status').textContent = `Could not save the list of interests (${err.message}).`; }
  render();
  if (refocus) { [...document.querySelectorAll('.t-interest')].find(n => n.dataset.label === refocus)?.focus(); refocus = null; }
}
function editorChips(levelId) {
  const cc = state.loc.address.country_code || 'xx';
  const labels = siteInterests(cc, levelId);
  const where = state.loc.address.country || cc.toUpperCase();
  const save = next => saveSiteInterests(cc, levelId, next);
  const move = (from, to) => { if (to < 0 || to >= labels.length || to === from) return; const next = [...labels]; next.splice(to, 0, ...next.splice(from, 1)); save(next); };
  let dragFrom = null;
  const out = labels.map((label, i) => {
    const c = el('div', { class: 'tb t-interest editable', title: `${label}. Drag, or press ← →, to reorder.`, tabindex: '0', draggable: 'true', 'data-label': label,
      ondragstart: ev => { dragFrom = i; ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', label); c.classList.add('dragging'); },
      ondragend: () => c.classList.remove('dragging'),
      ondragover: ev => { if (dragFrom !== null) { ev.preventDefault(); c.classList.add('drop'); } },
      ondragleave: () => c.classList.remove('drop'),
      ondrop: ev => { ev.preventDefault(); c.classList.remove('drop'); const f = dragFrom; dragFrom = null; if (f !== null) move(f, i); },
      onkeydown: ev => {
        if (ev.target !== c) return;
        const d = ev.key === 'ArrowLeft' ? -1 : ev.key === 'ArrowRight' ? 1 : 0;
        if (d) { ev.preventDefault(); refocus = label; move(i, i + d); }
      } },
      el('span', {}, label),
      el('button', { type: 'button', class: 'x', title: `Remove “${label}” from the list for ${where}`, 'aria-label': `Remove “${label}” from the list for ${where}`,
        onclick: () => save(labels.filter((_, j) => j !== i)) }, '×'));
    return c;
  });
  out.push(addChip(null, v => save([...labels, v])));
  return out;
}

function interestChips(levelId) {
  if (editor) return editorChips(levelId);
  const key = interestKey(levelId);
  const e = interestCache.get(key);
  if (!e) { loadInterests(key).then(render); return [el('span', { class: 'loading' }, '…')]; }
  const defaults = siteInterests(state.loc.address.country_code, levelId).map(label => ({ id: 'd:' + slug(label), label }));
  const seen = new Set();
  const chips = [...defaults, ...e.added].filter(c => !e.hidden.includes(c.id) && !seen.has(c.label.toLowerCase()) && seen.add(c.label.toLowerCase()));
  const out = chips.map(c => el('div', { class: 'tb t-interest', title: c.label },
    el('span', {}, c.label),
    el('button', { type: 'button', class: 'x', title: `Not applicable here: ${c.label}`, 'aria-label': `Mark “${c.label}” as not applicable here`, onclick: () => hideInterest(key, c.id) }, '×')));
  out.push(addChip(key));
  return out;
}
function addChip(key, onAdd = v => addInterest(key, v)) {
  const wrap = el('div', { class: 'tb t-add' });
  const start = () => {
    const input = el('input', { type: 'text', maxlength: '60', placeholder: 'New interest', 'aria-label': 'New shared interest' });
    const done = save => { const v = input.value.trim(); if (save && v) onAdd(v); else render(); };
    input.addEventListener('keydown', ev => { if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); });
    input.addEventListener('blur', () => done(true));
    wrap.replaceChildren(input); input.focus();
  };
  wrap.append(el('button', { type: 'button', class: 'add', onclick: start }, '+ Add'));
  return wrap;
}

// ---------- rendering ----------
// Four tones: black = none (0), dark grey = weak (below 0.5), light grey = good (0.5 up to 1), white = full (1).
function tone(score) {
  if (typeof score !== 'number') return null;          // not applicable / no data: hidden
  if (score <= 0) return 'black';
  if (score < 0.5) return 'darkgrey';
  if (score < 1) return 'lightgrey';
  return 'white';
}
// Mechanisms and referendum kinds use three colours (Orlin): no "Limited", so anything short of effective is flawed.
const mechTone = score => { const t = tone(score); return t === 'lightgrey' ? 'darkgrey' : t; };
// The legend's labels depend on what the chips on the screen stand for.
const LEGENDS = {
  levels: [['white', 'Free'], ['lightgrey', 'Mostly free'], ['darkgrey', 'Mostly not free'], ['black', 'Not free']],
  mechanisms: [['white', 'Effective'], ['darkgrey', 'Flawed'], ['black', 'Ineffective or absent']],
  requirements: [['white', 'Met'], ['darkgrey', 'Partly met'], ['black', 'Not met'], ['disabled', 'Does not apply']],
};
function setLegend(kind) {
  const items = LEGENDS[kind] || [];
  $('#legend').hidden = !items.length;
  $('#legend').replaceChildren(...items.map(([t, label]) => el('span', {}, el('i', { class: `t-${t}` }), label)));
}
// Requirements use three colours (Orlin): met white, partly met dark grey (partial or weak), not met black.
const STATUS_TONE = { yes: 'white', partial: 'darkgrey', weak: 'darkgrey', no: 'black', unknown: 'unknown' };
// The trail's drop-down menus: what each colour says in words (for tooltips), and what each chevron is called.
const TONE_WORDS = Object.fromEntries(Object.entries(LEGENDS).map(([k, v]) => [k, { ...Object.fromEntries(v), unknown: 'Not assessed' }]));
const SWITCH_LABEL = { level: 'Switch level', mech: 'Switch institution', prop: 'Switch requirement' };
let trailPlace = null;   // repositions the open menu under its pill when the window changes size
let trailClose = null;   // closes the open menu
window.addEventListener('resize', () => trailPlace?.());
// A click anywhere outside the menu and the chevrons closes it.
document.addEventListener('click', e => { if (trailClose && !e.target.closest?.('.arrow, .switch')) trailClose(); });

function chip({ label, tone, title, onclick, href, disabled }) {
  const attrs = { class: `tb t-${tone}`, title: title || label };
  if (disabled) attrs.disabled = '';
  if (href) return el('a', { ...attrs, href, target: '_blank', rel: 'noopener' }, el('span', {}, label));
  return el('button', { ...attrs, type: 'button', onclick }, el('span', {}, label));
}

// The answer first: one sentence above the level chips on where a person living here is free and where others
// decide for them. Free and Mostly free count as free; Mostly not free and Not free as others deciding.
function verdictLine(levels, loc) {
  const a = loc.address;
  const nb = loc.places.neighbourhood;
  const settlement = ['village', 'town'].map(id => loc.places[id]).find(p => p && !p.absent && p.name);
  const place = (nb && !nb.absent && nb.name) || settlement?.name || a.city || a.town || a.village || a.municipality || '';
  const union = loc.places.union?.name;
  const names = {
    ...(a.country_code === 'ch' ? { state: ['in your canton', 'your canton'] } : {}),
    union: union ? [`in the ${union}`, `the ${union}`] : ['in your union', 'your union'],
  };
  const text = placeVerdict(levels.map(x => ({ id: x.l.id, kind: x.l.kind, free: x.tone === 'white' || x.tone === 'lightgrey' })), place, names);
  return text ? el('p', { class: 'place-verdict' }, text) : null;
}

// Each click opens the next screen; the browser's Back button goes back up the tree.
function go(path) {
  state.path = path;
  writeHash(true);
  render();
}

const rowOf = (chips, cls = '') => chips.length ? el('div', { class: `tree-row ${cls}` }, chips) : null;
const shortName = s => s.replace(/\s*\(.*?\)\s*$/, '');

function renderPlace() {
  const loc = state.loc, a = loc.address;
  const street = [a.road || a.pedestrian || a.footway, a.house_number].filter(Boolean).join(' ');
  const parts = [a.country, a.city || a.town || a.village || a.hamlet, loc.places.neighbourhood?.name, street].filter(Boolean);
  $('#place').replaceChildren(...parts.flatMap((p, i) => i ? [el('span', { class: 'sep' }, '·'), p] : [p]));
}

// A mechanism may be named differently at some levels (catalog `levelNames`), e.g. the council of a country is its parliament.
const levelName = (mdef, levelId, key) => mdef.levelNames?.[levelId]?.[key];
function mechLabel(m, all, catalog, levelId) {
  const mdef = catalog.mechanisms[m.type] || {};
  const twins = all.filter(x => x.type === m.type).length > 1;
  return shortName(m.label || (twins && m.name ? m.name : (levelName(mdef, levelId, 'name') || mdef.name || m.name || m.type)));
}

function mechLongName(m, all, catalog, levelId) {
  const mdef = catalog.mechanisms[m.type] || {};
  const twins = all.filter(x => x.type === m.type).length > 1;
  return m.label || (twins && m.name ? m.name : (levelName(mdef, levelId, 'longName') || mdef.longName || mdef.name || m.name || m.type));
}

// Word-level diff (longest common subsequence), for showing a proposed amendment against the current text.
function wordDiff(a, b) {
  const A = a.split(/\s+/).filter(Boolean), B = b.split(/\s+/).filter(Boolean);
  const L = Array.from({ length: A.length + 1 }, () => new Uint16Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--)
    L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  // Mostly rewritten: show the old text struck through, then the new one, instead of a confetti of small changes.
  if (L[0][0] < 0.5 * Math.max(A.length, B.length)) return [A.length ? el('del', {}, a) : '', A.length && B.length ? ' ' : '', B.length ? el('ins', {}, b) : ''];
  const out = [];
  const push = (kind, w) => { const last = out[out.length - 1]; if (last && last.kind === kind) last.words.push(w); else out.push({ kind, words: [w] }); };
  let i = 0, j = 0;
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) { push('same', A[i]); i++; j++; }
    else if (j < B.length && (i >= A.length || L[i][j + 1] > L[i + 1][j])) push('ins', B[j++]);
    else push('del', A[i++]);
  }
  return out.flatMap((r, k) => [k ? ' ' : '', r.kind === 'same' ? r.words.join(' ') : el(r.kind, {}, r.words.join(' '))]);
}
// One provision's lines, as in the law or, when fixed, as a diff against the proposed amendment.
function provisionLines(it, fixed) {
  const cur = [].concat(it.text || []);
  if (!fixed || it.fix == null) return cur.map(t => el('p', {}, t));
  const fix = [].concat(it.fix);
  if (cur.length <= 1 && fix.length <= 1) return [el('p', {}, ...wordDiff(cur[0] || '', fix[0] || ''))];
  // Lists: pair lines by their item number ("6." with "6."), else by position; unpaired lines are added or removed.
  const num = t => (t.match(/^(\d+[a-z]?)\./) || [])[1];
  const rest = [...fix], out = [];
  cur.forEach((t, k) => {
    let m = num(t) ? rest.findIndex(f => num(f) === num(t)) : -1;
    if (m < 0 && !num(t) && rest.length && !num(rest[0])) m = 0;
    if (m < 0 && fix.length === 1 && k === 0) m = 0;
    out.push(el('p', {}, ...(m >= 0 ? wordDiff(t, rest.splice(m, 1)[0]) : [el('del', {}, t)])));
  });
  rest.forEach(f => out.push(el('p', {}, el('ins', {}, f))));
  return out;
}

// Reader feedback on a proposed amendment: approvals and alternative wordings, shared through server.py
// (/api/fixes) like the interest chips, or kept in this browser when the site is served without it.
const fixKey = (law, ref) => [state.loc?.address?.country_code || 'xx', law, ref].join('|').replace(/[^\w\- .,'()/|À-ɏЀ-ӿ]/g, '').slice(0, 200);
function localFix(key, value) {
  try {
    const all = JSON.parse(localStorage.getItem('freedom-fixes') || '{}');
    if (value === undefined) return all[key] || { approvals: 0, suggestions: [] };
    all[key] = value; localStorage.setItem('freedom-fixes', JSON.stringify(all));
  } catch { /* storage unavailable */ }
  return value || { approvals: 0, suggestions: [] };
}
async function fixFeedback(key, action, body) {
  if (sharedApi) {
    const current = () => api('GET', `api/fixes?key=${encodeURIComponent(key)}`);
    try { return action ? await api('POST', `api/fixes/${action}`, { key, ...body }) : await current(); }
    catch (err) {
      if (err.refused) { notice(err.message); return current().catch(() => ({ approvals: 0, suggestions: [] })); }
      sharedApi = false;
    }
  }
  const e = localFix(key);
  if (action === 'approve') e.approvals++;
  if (action === 'suggest') e.suggestions.push({ text: body.text, at: Math.floor(Date.now() / 1000) });
  return action ? localFix(key, e) : e;
}
const approvedHere = key => { try { return JSON.parse(localStorage.getItem('freedom-fix-approved') || '[]').includes(key); } catch { return false; } };
const markApproved = key => { try { const a = JSON.parse(localStorage.getItem('freedom-fix-approved') || '[]'); a.push(key); localStorage.setItem('freedom-fix-approved', JSON.stringify(a)); } catch { /* ignore */ } };
function fixReview(law, it) {
  const key = fixKey(law, it.ref);
  const box = el('div', { class: 'fix-review' });
  const paint = e => {
    const done = approvedHere(key);
    const approve = el('button', { type: 'button', class: 'fr-btn', disabled: done, onclick: async () => { markApproved(key); paint(await fixFeedback(key, 'approve')); } },
      done ? 'Approved' : 'Approve', e.approvals ? el('span', { class: 'count' }, ` · ${e.approvals}`) : null);
    const write = el('button', { type: 'button', class: 'fr-btn', onclick: () => {
      const ta = el('textarea', { rows: 4, 'aria-label': `Your wording for ${it.ref}` });
      ta.value = [].concat(it.fix).join('\n');
      const send = el('button', { type: 'button', class: 'fr-btn primary', onclick: async () => {
        const text = ta.value.trim();
        if (text) paint(await fixFeedback(key, 'suggest', { text }));
      } }, 'Submit');
      const cancel = el('button', { type: 'button', class: 'fr-btn', onclick: () => paint(e) }, 'Cancel');
      box.replaceChildren(ta, el('div', { class: 'fr-row' }, send, cancel));
      ta.focus();
    } }, 'Write my own');
    const sugg = (e.suggestions || []).map(x => el('div', { class: 'suggestion' }, el('span', { class: 'who' }, 'Suggested by a reader'), ...String(x.text).split('\n').map(t => el('p', {}, t))));
    box.replaceChildren(el('div', { class: 'fr-row' }, approve, write), ...sugg);
  };
  paint({ approvals: 0, suggestions: [] });
  fixFeedback(key).then(paint).catch(() => {});
  return box;
}

// A short excerpt from the explainer (e.g. on the participation quorum) under the verdict, expandable to the full quote.
function explainerMini(explainer) {
  const [first, ...rest] = explainer.quote;
  const more = el('div', { class: 'xm-more', hidden: true },
    ...rest.map(t => el('p', {}, t)),
    el('p', { class: 'source' }, 'Source: ', el('a', { href: explainer.url, target: '_blank', rel: 'noopener' }, explainer.source)));
  const toggle = el('button', { type: 'button', class: 'xm-toggle', onclick: () => {
    more.hidden = !more.hidden; toggle.textContent = more.hidden ? 'Read more' : 'Show less';
  } }, 'Read more');
  return el('div', { class: 'xm' }, el('p', { class: 'xm-title' }, explainer.title), el('p', {}, first), more, toggle);
}

// The legal text behind a requirement: per law, a linked title and the quoted provisions (translated).
// When the data proposes amendments (`fix` on a provision), a Fix button shows them as tracked changes, each
// with a short "why" and buttons for readers to approve it or suggest their own wording. A provision with a
// `fix` but no `text` is a new article: hidden until Fix is pressed, so the act is shown as lacking it.
function provisionsPanel(provisions, laws, explainer, prop) {
  const unmet = ['no', 'partial', 'weak'].includes(prop?.status);
  const fixable = unmet && provisions.some(p => (p.items || []).some(it => it.fix != null));
  const panel = el('div', {});
  const draw = fixed => {
    // A band on top, in the requirement's own colour, says at a glance whether the law meets it.
    const t = fixed ? 'white' : STATUS_TONE[prop?.status];
    const verdictLabel = t && Object.fromEntries(LEGENDS.requirements)[t];
    const btn = fixable ? el('button', { type: 'button', class: 'fix-btn', 'aria-pressed': String(fixed), onclick: () => draw(!fixed) }, fixed ? 'Show current law' : 'Fix') : null;
    const note = fixed ? 'With these amendments (proposed by Freedom Map, not law).' : prop?.explanation;
    const mini = explainer && unmet && !fixed ? explainerMini(explainer) : null;
    const verdict = verdictLabel ? el('div', { class: `verdict t-${t}` },
      el('div', { class: 'vtext' }, el('strong', {}, verdictLabel), note ? el('span', {}, note) : null), mini, btn) : btn;
    panel.className = `provisions${t ? ` v-${t}` : ''}${fixed ? ' fixed' : ''}`;
    panel.replaceChildren(...[verdict, ...provisions.map(p => {
      const law = laws[p.law] || { title: p.law };
      const title = law.url ? el('a', { href: law.url, target: '_blank', rel: 'noopener' }, law.title) : law.title;
      const items = (p.items || []).filter(it => fixed || it.text != null || it.fix == null);
      return el('section', {},
        el('h3', {}, title),
        items.length ? null : el('p', { class: 'absent' }, fixable ? 'The act has no provision for this. Press Fix to see the articles that would provide it.' : 'The act has no provision for this.'),
        ...items.map(it => el('div', { class: 'provision' },
          it.ref ? el('p', { class: 'ref' }, it.ref) : null,
          ...provisionLines(it, fixed),
          fixed && it.fix != null && it.why ? el('p', { class: 'why' }, it.why) : null,
          fixed && it.fix != null ? fixReview(p.law, it) : null)));
    })].filter(Boolean));
  };
  draw(false);
  return panel;
}

// ---------- requirement chat ----------
// A small chat on each requirement page: readers comment, suggest edits or ask Claude about the requirement.
// server.py (/api/chat) holds the API key, gives Claude the site's principles and this page's text, and saves
// every conversation for the editors. Conversations live in memory, one per requirement, for this visit.
const chats = new Map();
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/[^\w-]/g, '');
function pageContext(trail, prop, laws, catalog) {
  const pdef = catalog.properties[prop.type] || {};
  const label = { yes: 'Met', partial: 'Partly met', weak: 'Partly met (weak)', no: 'Not met' }[prop.status] || 'Unknown';
  const a = state.loc?.address || {};
  const place = [a.suburb || a.quarter || a.neighbourhood, a.village || a.town || a.city, a.country].filter(Boolean).join(', ');
  const lines = [trail.join(' › '), `Place: ${place}`, `Requirement: ${prop.name || pdef.name || prop.type} (${pdef.longName || ''})`,
    pdef.description ? `What it means: ${pdef.description}` : '', `Verdict: ${label}`, prop.explanation ? `Why: ${prop.explanation}` : '',
    pdef.explainer ? `Background (${pdef.explainer.title}, ${pdef.explainer.source || ''}): ${(pdef.explainer.quote || []).join(' ')}` : ''];
  for (const p of prop.provisions || []) {
    const law = laws[p.law] || { title: p.law };
    lines.push('', `Law: ${law.title}${law.localTitle ? ` (${law.localTitle})` : ''}${law.url ? ` ${law.url}` : ''}`);
    for (const it of p.items || []) {
      if (it.text != null) lines.push(`${it.ref || ''}: ${[].concat(it.text).join(' ')}`);
      if (it.fix != null) lines.push(`Proposed fix for ${it.ref || 'a new article'}: ${[].concat(it.fix).join(' ')}${it.why ? ` (Why: ${it.why})` : ''}`);
    }
  }
  if (!prop.provisions?.length && prop.laws?.length) lines.push('', 'Laws: ' + prop.laws.map(id => laws[id]?.title || id).join('; '));
  return lines.filter(l => l !== '').join('\n');
}
function chatBox(key, context) {
  const c = chats.get(key) || { id: newId(), messages: [] };
  chats.set(key, c);
  const log = el('div', { class: 'chat-log', 'aria-live': 'polite' });
  const input = el('textarea', { id: 'chat-input', rows: '2', maxlength: '2000', placeholder: 'Comment, suggest an edit, or ask a question', 'aria-label': 'Your message' });
  const send = el('button', { type: 'submit', class: 'chat-send' }, 'Send');
  const paint = (pending, error) => {
    log.replaceChildren(...[
      c.messages.length ? null : el('p', { class: 'chat-intro' }, 'Ask about this requirement, or tell us what you think should change. Your messages are saved for the Freedom Map editors.'),
      ...c.messages.map(m => el('p', { class: `chat-msg ${m.role}` }, m.content)),
      pending ? el('p', { class: 'chat-msg assistant pending' }, 'Thinking…') : null,
      error ? el('p', { class: 'chat-error' }, error) : null].filter(Boolean));
    log.scrollTop = log.scrollHeight;
  };
  const form = el('form', { class: 'chat-form', onsubmit: async e => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || send.disabled) return;
    c.messages.push({ role: 'user', content: text });
    input.value = ''; send.disabled = true; paint(true);
    let error = null;
    try {
      const r = await api('POST', 'api/chat', { key, id: c.id, context, messages: c.messages });
      if (r.reply) c.messages.push({ role: 'assistant', content: r.reply }); else error = r.error || 'No answer.';
    } catch (err) { error = err.refused ? err.message : 'The chat needs the Freedom Map server (server.py). Your message was not saved.'; }
    send.disabled = false; paint(false, error); input.focus();
  } }, input, send);
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  paint(false);
  return { log, form, input };
}
function chatButton(key, context) {
  const wrap = el('div', { class: 'chat-wrap' });
  let pop = null;
  const close = () => { pop?.remove(); pop = null; btn.setAttribute('aria-expanded', 'false'); };
  const btn = el('button', { type: 'button', class: 'chat-btn', 'aria-label': 'Comment or ask about this requirement', title: 'Comment or ask about this requirement', 'aria-expanded': 'false',
    onclick: () => {
      if (pop) return close();
      const box = chatBox(key, context);
      pop = el('div', { class: 'chat-pop', role: 'dialog', 'aria-label': 'Comment or ask about this requirement' },
        el('div', { class: 'chat-head' }, el('strong', {}, 'Comment or ask'), el('button', { type: 'button', class: 'chat-close', 'aria-label': 'Close', onclick: close }, '×')),
        box.log, box.form);
      pop.addEventListener('keydown', e => { if (e.key === 'Escape') { close(); btn.focus(); } });
      wrap.append(pop); btn.setAttribute('aria-expanded', 'true'); box.input.focus();
    } });
  btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M8.5 11h7M8.5 14h4"/></svg>';
  wrap.prepend(btn);
  return wrap;
}

// A referendum's kinds become separate mechanisms, in the catalog's order; a kind the data lacks does not exist in law.
// `scored` keeps the data's own properties for scoring; `properties` are the chips shown (with disabled ones).
function flattenKinds(mechs, catalog) {
  return mechs.flatMap(m => {
    if (!m.kinds) return [m];
    const defs = catalog.referendumKinds || {};
    return (catalog.mechanisms[m.type]?.kinds || []).map(t => {
      const k = m.kinds.find(k => k.type === t) || { type: t, properties: [{ type: 'exists', status: 'no', laws: [] }] };
      const skip = defs[t]?.skipProperties || [];
      return {
        type: m.type, kindType: t, label: defs[t]?.name || t, title: [k.name, defs[t]?.description].filter(Boolean).join('\n\n'),
        properties: kindProperties(k, m.type, catalog),
        scored: { type: m.type, properties: (k.properties || []).filter(p => !skip.includes(p.type)) },
      };
    });
  });
}

function render() {
  const { catalog } = state.data;
  const loc = state.loc;
  if (!loc) return;
  $('#hint').hidden = true;
  renderPlace();
  showArea(state.path[0]);
  const j = loc.jurisdiction;
  $('#status').textContent = j ? (j.statusNote || '') : '';
  if (!j) {
    $('#trail').replaceChildren();
    $('#tree').replaceChildren(el('p', { class: 'nodata' }, `No data for ${loc.address.country || 'this country'} yet.`));
    return;
  }

  // Resolve the path as far as it is valid.
  const [levelId, branchId, mechIdx, step4] = state.path;
  const levels = catalog.levels.map(l => {
    const lvl = loc.places[l.id].absent ? undefined : getLevel(j, l.id);
    return { l, lvl, tone: tone(scoreLevel(lvl, catalog)) };
  }).filter(x => x.tone);
  // A union chip carries the union's own name where the country is a member ("European Union").
  const levelLabel = l => (l.id === 'union' && loc.places.union?.name) || l.name;
  const cur = levels.find(x => x.l.id === levelId);
  const branch = cur && ['direct', 'representative'].includes(branchId) ? cur.lvl[branchId] : undefined;
  const kindDefs = catalog.referendumKinds || {};
  // Each kind of referendum (citizen initiative, veto, mandatory) is its own chip, next to the general assembly.
  const mechs = flattenKinds(branch?.applicable !== false ? (branch?.mechanisms || []) : [], catalog);
  const mech = mechs[mechIdx];
  const props = mech?.properties || [];
  // A mechanism that hinges on a single requirement (e.g. a neighbourhood's representatives in the municipal council:
  // elected in local districts) skips the requirements screen: its chip opens that requirement's page directly.
  const single = mech && props.length === 1;
  const propIdx = single ? 0 : step4;
  const prop = props[propIdx]?.disabled ? undefined : props[propIdx];
  const propPath = i => [levelId, branchId, mechIdx, i];

  // Trail: where you are in the tree. A step's name goes back to that page. Its chevron opens a menu of the step's
  // siblings (the other levels, institutions or requirements) and switches sideways, keeping the rest of the path.
  // Trail uses each chip's long name.
  const steps = [{ name: 'Common interest levels', path: [] }];
  if (cur) steps.push({ kind: 'level', name: levelLabel(cur.l), path: [levelId] });
  if (mech) steps.push({ kind: 'mech', name: mechLongName(mech, mechs, catalog, levelId), path: [levelId, branchId, mechIdx] });
  if (prop && !single) steps.push({ kind: 'prop', name: catalog.properties[prop.type]?.longName || catalog.properties[prop.type]?.name || prop.name, path: propPath(propIdx) });

  const mechsOf = (lvl, b) => flattenKinds(lvl[b]?.applicable !== false ? (lvl[b]?.mechanisms || []) : [], catalog);
  const sameKind = (a, b) => a.type === b.type && a.kindType === b.kindType;
  const propLabel = p => p.name || catalog.properties[p.type]?.name || p.type;
  const deep = prop && !single;   // a requirement's page is open
  // Where the open requirement sits in another institution: its page there if it has one, else the institution's page.
  const landIn = (m, base) => {
    const pi = deep ? m.properties.findIndex(p => p.type === prop.type && !p.disabled) : -1;
    return { pi, path: pi >= 0 && m.properties.length > 1 ? [...base, pi] : base };
  };
  const siblings = {
    // Every level, coloured by the same spot there: the level itself, the same institution or the same requirement.
    // In the order of the first screen: from home to union, then the levels that are not places.
    level: () => {
      const ordered = [...levels.filter(x => x.l.kind === 'territorial'), ...levels.filter(x => x.l.kind !== 'territorial')];
      const rank = mech ? mechs.slice(0, mechIdx).filter(m => sameKind(m, mech)).length : 0;
      const mechName = mech && mechLabel(mech, mechs, catalog, levelId);
      // depth 0: the level itself; 1: the same institution there; 2: the same requirement of that institution.
      const at = (x, depth) => {
        const o = { label: levelLabel(x.l), current: x.l.id === levelId, group: x.l.kind === 'territorial' };
        if (!depth) return { ...o, tone: x.tone, word: TONE_WORDS.levels[x.tone], path: [x.l.id] };
        // The same institution there (of several of one type, the one in the same position).
        const ms = mechsOf(x.lvl, branchId);
        const twins = ms.map((m, i) => i).filter(i => sameKind(ms[i], mech));
        const i = twins[Math.min(rank, twins.length - 1)];
        const m = ms[i];
        const t = m ? mechTone(scoreMechanism(m.scored || m, catalog)) : null;
        if (!t) return null;   // no such institution at this level: left out of the row
        const base = [x.l.id, branchId, i];
        if (depth < 2) return { ...o, tone: t, word: TONE_WORDS.mechanisms[t], path: base };
        const { pi, path } = landIn(m, base);
        if (pi < 0) return { ...o, na: true, path, title: `${o.label}: this requirement does not apply there. Opens the institution's page.` };
        const pt = STATUS_TONE[m.properties[pi].status] || 'unknown';
        return { ...o, tone: pt, word: TONE_WORDS.requirements[pt], path };
      };
      // Compare as deep as some other level can follow: a requirement no other level has falls back to its institution,
      // an institution no other level has falls back to the levels themselves. Levels without the institution are left
      // out (Orlin); a level that has it but where the requirement does not apply stays, dashed.
      for (let depth = deep ? 2 : mech ? 1 : 0; ; depth--) {
        const options = ordered.map(x => at(x, depth)).filter(Boolean);
        if (!depth || options.some(o => !o.current && !o.na)) {
          return { caption: depth === 2 ? `${mechName} › ${propLabel(prop)} at each level` : depth ? `${mechName} at each level` : 'Common interest levels', options };
        }
      }
    },
    // The level's institutions, as on the level's page: direct ones, then representative ones.
    mech: () => ({
      caption: `${levelLabel(cur.l)}: institutions`,
      options: cur.l.informal ? [] : ['direct', 'representative'].flatMap(b => {
        const ms = mechsOf(cur.lvl, b);
        return ms.map((m, i) => {
          const t = mechTone(scoreMechanism(m.scored || m, catalog));
          return t && { label: mechLabel(m, ms, catalog, levelId), tone: t, word: TONE_WORDS.mechanisms[t], group: b, current: b === branchId && i === mechIdx, path: landIn(m, [levelId, b, i]).path };
        }).filter(Boolean);
      }),
    }),
    // The institution's requirements, as on the institution's page.
    prop: () => ({
      caption: `${mechLabel(mech, mechs, catalog, levelId)}: requirements`,
      options: props.map((p, i) => {
        const t = p.disabled ? 'disabled' : (STATUS_TONE[p.status] || 'unknown');
        return { label: propLabel(p), tone: t, word: TONE_WORDS.requirements[t], disabled: p.disabled, current: i === propIdx, path: propPath(i) };
      }),
    }),
  };
  const rows = {};
  const rowFor = kind => rows[kind] || (rows[kind] = siblings[kind]());
  const drawTrail = (open, focus) => {
    const trail = $('#trail');
    trailPlace = trailClose = null;
    if (steps.length < 2) { trail.replaceChildren(); return; }
    const arrow = s => s.kind && rowFor(s.kind).options.length > 1 ? el('button', {
      type: 'button', class: 'arrow', 'data-kind': s.kind, 'aria-haspopup': 'true', 'aria-expanded': String(open === s.kind), 'aria-controls': 'trail-switch',
      'aria-label': SWITCH_LABEL[s.kind], title: SWITCH_LABEL[s.kind], onclick: () => (open === s.kind ? drawTrail(null, s.kind) : drawTrail(s.kind, true)),
    }) : null;   // the chevron is drawn in CSS and turns over while the menu is open
    const last = steps.length - 1;
    const nodes = steps.flatMap((s, i) => {
      const a = arrow(s);
      const name = i < last ? el('button', { type: 'button', class: 'crumb', onclick: () => go(s.path) }, s.name) : null;
      return [
        i ? el('span', { class: 'sep' }, '›') : null,
        // The page you are on is the title: the same pill, larger, its name not a link.
        i === last ? el('span', { class: 'here' }, a ? el('span', { class: `pill${open === s.kind ? ' open' : ''}` }, el('span', { class: 'here-name' }, s.name), a) : el('span', { class: 'here-name' }, s.name))
          : a ? el('span', { class: `pill${open === s.kind ? ' open' : ''}` }, name, a) : name,
      ];
    }).filter(Boolean);
    let box = null;
    if (open) {
      // The menu lists the step's siblings in their usual order and opens over the pill whose chevron opened it, with
      // the current choice lying exactly on the pill, so the others appear above and below it (as an iOS or macOS
      // menu does). Each row has a swatch in the colour of the page it leads to; the current one also has a tick.
      const { caption, options } = rowFor(open);
      const close = () => drawTrail(null, open);
      const rowsOf = options.flatMap((o, i) => [
        i && o.group !== options[i - 1].group ? el('span', { class: 'gap', 'aria-hidden': 'true' }) : null,
        el('button', {
          type: 'button', class: `mini${o.na ? ' na' : ''}${o.current ? ' cur' : ''}`, 'aria-current': o.current ? 'true' : null, disabled: o.disabled,
          title: o.title || (o.disabled ? `${o.label}: does not apply` : [o.label, o.word].filter(Boolean).join(': ')),
          onclick: o.disabled ? null : o.current ? close : () => go(o.path),
        }, el('span', { class: 'label' }, o.current ? steps.find(s => s.kind === open).name : o.label),
          o.current ? el('i', { class: 'tick', 'aria-hidden': 'true' }) : null,
          el('i', { class: `sw ${o.na ? 'na' : `t-${o.tone}`}`, 'aria-hidden': 'true' })),
      ]).filter(Boolean);
      box = el('div', { class: `switch${steps[last].kind === open ? ' big' : ''}`, id: 'trail-switch', role: 'group', 'aria-label': caption,
        onkeydown: e => {
          const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
          if (!step) return;
          const live = [...box.querySelectorAll('.mini:not(:disabled)')];
          const at = live.indexOf(document.activeElement);
          if (at < 0) return;
          e.preventDefault();
          live[(at + step + live.length) % live.length].focus();
        },
      }, rowsOf);
      nodes.push(box);
    }
    trail.replaceChildren(...nodes);
    trail.onkeydown = open ? e => { if (e.key === 'Escape') drawTrail(null, open); } : null;
    if (box) {
      // Over its pill: same left edge, at least as wide, the current row exactly on the pill. Kept inside the window.
      trailPlace = () => {
        const pill = trail.querySelector('.pill.open'), cur = box.querySelector('.mini.cur');
        if (!pill) return;
        const t = trail.getBoundingClientRect(), p = pill.getBoundingClientRect(), vw = document.documentElement.clientWidth;
        box.style.minWidth = `${Math.min(p.width, vw - 16)}px`;
        if (cur) cur.style.minHeight = `${p.height - 2}px`;
        const w = box.offsetWidth;
        box.style.left = `${Math.max(8, Math.min(vw - w - 8, p.left)) - t.left}px`;
        box.style.top = `${p.top - t.top - (cur ? cur.offsetTop : -p.height)}px`;
      };
      trailPlace();
      trailClose = () => drawTrail(null);
      // A menu that would run past the top or bottom of the window brings itself into view.
      if (focus) box.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
    // Keyboard: opening moves to the current item in the menu, closing returns to the chevron.
    if (open && focus) (box.querySelector('.mini.cur') || box.querySelector('.mini:not(:disabled)'))?.focus({ preventScroll: true });
    else if (focus) trail.querySelector(`.arrow[data-kind="${focus}"]`)?.focus({ preventScroll: true });
  };
  drawTrail(null);

  const screen = [];
  if (!cur) {
    // Screen 1: levels of shared interest. Geographical, from home to union; then non-geographical.
    const levelChip = ({ l, tone }) => chip({ label: levelLabel(l), tone, title: [...new Set([levelLabel(l), loc.places[l.id].name].filter(Boolean))].join(': '), onclick: () => go([l.id]) });
    setLegend('levels');
    screen.push(verdictLine(levels, loc));
    screen.push(el('h2', { class: 'group-title' }, 'Common interest levels'));
    screen.push(rowOf(levels.filter(x => x.l.kind === 'territorial').map(levelChip)));
    screen.push(rowOf(levels.filter(x => x.l.kind !== 'territorial').map(levelChip)));
  } else if (!mech) {
    // Screen 2: the level's shared interests, then its decision-making mechanisms in one row: a group of direct and a
    // group of representative mechanisms, side by side, each labelled on its border. A branch without any shows "None".
    setLegend('mechanisms');
    screen.push(el('h2', { class: 'group-title' }, 'Common interest categories'));
    screen.push(rowOf(interestChips(levelId), 'interests'));
    // Some levels (e.g. Home) decide informally, without formal mechanisms (catalog `informal`): one plain chip.
    if (cur.l.informal) {
      const hi = (cur.lvl.direct?.mechanisms || []).findIndex(m => m.type === 'household');
      screen.push(el('div', { class: 'mech-groups' }, rowOf([chip({ label: 'Informal', tone: tone(scoreLevel(cur.lvl, catalog)) || 'white', title: cur.l.informal,
        onclick: hi >= 0 ? () => go([levelId, 'direct', hi]) : undefined })])));
    } else {
      const group = b => {
        const br = cur.lvl[b];
        const ms = flattenKinds(br?.applicable !== false ? (br?.mechanisms || []) : [], catalog);
        const shown = ms.map((m, i) => ({ m, i, tone: mechTone(scoreMechanism(m.scored || m, catalog)) })).filter(x => x.tone);
        const chips = shown.length ? shown.map(({ m, i, tone }) => chip({
          label: mechLabel(m, ms, catalog, levelId), tone, title: m.title || m.name || catalog.mechanisms[m.type]?.description, onclick: () => go([levelId, b, i]),
        })) : [chip({ label: 'None', tone: 'black', title: br?.note || 'No such institution at this level.' })];
        return el('fieldset', { class: 'mech-group', style: `--n: ${chips.length}` }, el('legend', {}, BRANCH_INFO[b].groupName), ...chips);
      };
      screen.push(el('div', { class: 'mech-groups' }, group('direct'), group('representative')));
    }
  } else if (!prop) {
    // Screen 4: the properties the mechanism needs. If it does not exist in law, the rest are disabled.
    setLegend('requirements');
    screen.push(rowOf(props.map((p, i) => {
      const pdef = catalog.properties[p.type] || {};
      return chip({
        label: p.name || pdef.name || p.type, tone: p.disabled ? 'disabled' : (STATUS_TONE[p.status] || 'unknown'),
        title: p.disabled ? 'Does not apply: the institution does not exist in law.' : [pdef.description, p.explanation].filter(Boolean).join('\n\n'),
        onclick: p.disabled ? undefined : () => go(propPath(i)), disabled: p.disabled,
      });
    })));
  } else {
    // Screen 5: the relevant laws.
    setLegend(null);
    const explainer = catalog.properties[prop.type]?.explainer;
    const chatKey = [loc.address.country_code || 'xx', ...state.path].join('|').slice(0, 200);
    const chatBtn = chatButton(chatKey, pageContext(steps.map(s => s.name), prop, j.laws, catalog));
    // The chat button sits in the top right corner of the verdict band (outside the panel, so its pop-up is not clipped).
    if (prop.provisions?.length) screen.push(el('div', { class: 'req has-chat' }, provisionsPanel(prop.provisions, j.laws, explainer, prop), chatBtn));
    else screen.push(el('div', { class: 'req-head' }, chatBtn), rowOf((prop.laws || []).map(id => {
      const law = j.laws[id] || { title: id };
      return chip({ label: law.short || law.title, tone: 'law', title: [law.title, law.localTitle].filter(Boolean).join('\n'), href: law.url });
    })));
  }
  $('#tree').replaceChildren(...screen.filter(Boolean));
}

// ---------- shareable URL: #lat,lon/level/branch/mech/prop ----------
function writeHash(push) {
  if (!state.loc) return;
  const h = `#${state.loc.lat},${state.loc.lon}` + state.path.map(p => `/${p}`).join('');
  if (location.hash === h) return;
  if (push) history.pushState(null, '', h); else history.replaceState(null, '', h);
}
function readHash() {
  const m = location.hash.slice(1).split('/');
  const [lat, lon] = (m[0] || '').split(',').map(Number);
  if (!isFinite(lat) || !isFinite(lon) || !m[0]) return null;
  const path = m.slice(1).map((v, i) => (i >= 2 ? Number(v) : v));
  return { lat, lon, path };
}
window.addEventListener('popstate', () => {
  const h = readHash();
  if (!h) { showStart(); return; }
  if (state.loc && h.lat === state.loc.lat && h.lon === state.loc.lon) { state.path = h.path; render(); }
  else { state.path = h.path; locate(h.lat, h.lon, { zoom: 15, keepPath: true }); }
});

// ---------- boot ----------
(async function boot() {
  try {
    [state.data, editor] = await Promise.all([loadData(), api('GET', 'api/editor').then(r => r.editor === true, () => false)]);
  } catch (e) {
    $('#hint').hidden = false;
    $('#hint').textContent = `Could not load data (${e.message}). Start the site with "python3 server.py".`;
    return;
  }
  const h = readHash();
  if (h) { state.path = h.path; locate(h.lat, h.lon, { zoom: 15, keepPath: true }); }
})();
