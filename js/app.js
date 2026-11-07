import { resolveJurisdiction, getLevel, scoreLevel, scoreBranch, scoreMechanism, levelPlaces } from './model.js';

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const BRANCH_INFO = {
  direct: { name: 'Direct', desc: 'The people decide themselves: referendums, initiatives, assemblies.' },
  representative: { name: 'Representative', desc: 'Elected, individually accountable representatives decide.' },
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
  const [catalog, index] = await Promise.all([get('catalog.json'), get('index.json')]);
  const jurisdictions = await Promise.all(index.jurisdictions.map(get));
  return { catalog, unions: index.unions, jurisdictions };
}

// ---------- geocoding ----------
async function nominatim(path, params) {
  const url = `${NOMINATIM}/${path}?` + new URLSearchParams({ format: 'jsonv2', addressdetails: 1, ...params });
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Geocoding failed (${r.status})`);
  return r.json();
}
const reverse = (lat, lon) => nominatim('reverse', { lat, lon, zoom: 18 });
const search = q => nominatim('search', { q, limit: 1 });

// ---------- map ----------
const map = L.map('map', { worldCopyJump: true }).setView([46, 15], 4);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
let marker = null;

async function locate(lat, lon, { zoom, result, keepPath } = {}) {
  lat = +(+lat).toFixed(5); lon = +(+lon).toFixed(5);
  if (marker) marker.setLatLng([lat, lon]); else marker = L.marker([lat, lon]).addTo(map);
  if (zoom) map.setView([lat, lon], zoom);
  $('#place').replaceChildren(el('span', { class: 'loading' }, 'Looking up this location…'));
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
    if (!keepPath) state.path = [];
    render();
  } catch (e) {
    $('#place').replaceChildren(`Could not look up this location: ${e.message}`);
  }
}

map.on('click', e => locate(e.latlng.lat, e.latlng.lng));
$('#search').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('#q').value.trim();
  if (!q) return;
  try {
    const [r] = await search(q);
    if (!r) { $('#place').replaceChildren(`Nothing found for “${q}”.`); return; }
    locate(r.lat, r.lon, { zoom: 16, result: r });
  } catch (err) {
    $('#place').replaceChildren(err.message);
  }
});
document.querySelectorAll('.examples button').forEach(b => b.addEventListener('click', () => locate(b.dataset.lat, b.dataset.lon, { zoom: 16 })));

// ---------- rendering ----------
// Four tones: black = none (0), dark grey = weak (below 0.5), light grey = good (0.5 up to 1), white = full (1).
function tone(score) {
  if (typeof score !== 'number') return null;          // not applicable / no data: hidden
  if (score <= 0) return 'black';
  if (score < 0.5) return 'darkgrey';
  if (score < 1) return 'lightgrey';
  return 'white';
}
const STATUS_TONE = { yes: 'white', partial: 'lightgrey', no: 'black', unknown: 'unknown' };

function button({ label, tone, pressed, title, onclick, href }) {
  const attrs = { class: `tb t-${tone}`, title: title || label };
  if (href) return el('a', { ...attrs, href, target: '_blank', rel: 'noopener' }, el('span', {}, label));
  return el('button', { ...attrs, type: 'button', 'aria-pressed': String(!!pressed), onclick }, el('span', {}, label));
}

function select(depth, value) {
  state.path = state.path[depth] === value ? state.path.slice(0, depth) : [...state.path.slice(0, depth), value];
  render();
}

const rowOf = buttons => buttons.length ? el('div', { class: 'tree-row' }, buttons) : null;
const shortName = s => s.replace(/\s*\(.*?\)\s*$/, '');

function renderPlace() {
  const loc = state.loc, a = loc.address;
  const parts = [a.country, a.city || a.town || a.village || a.hamlet, loc.places.neighbourhood?.name].filter(Boolean);
  $('#place').replaceChildren(...parts.flatMap((p, i) => i ? [el('span', { class: 'sep' }, '·'), p] : [p]));
}

function render() {
  const { catalog } = state.data;
  const loc = state.loc;
  writeHash();
  if (!loc) return;
  $('#hint').hidden = true;
  renderPlace();
  const j = loc.jurisdiction;
  $('#status').textContent = j
    ? (j.statusNote || ({ draft: 'Draft data.', sample: 'Sample data.', reviewed: 'Reviewed data.' }[j.status] || ''))
    : '';

  const rows = [];
  if (!j) {
    rows.push(el('p', { class: 'nodata' }, `No data for ${loc.address.country || 'this country'} yet.`));
    $('#tree').replaceChildren(...rows);
    return;
  }
  let [levelId, branchId, mechIdx, propIdx] = state.path;

  // Levels: hide those that don't apply here or have no data.
  const levels = catalog.levels.map(l => {
    const lvl = loc.places[l.id].absent ? undefined : getLevel(j, l.id);
    return { l, lvl, tone: tone(scoreLevel(lvl, catalog)) };
  }).filter(x => x.tone);
  rows.push(rowOf(levels.map(({ l, tone }) => button({
    label: l.name, tone, pressed: levelId === l.id, title: [l.name, loc.places[l.id].name].filter(Boolean).join(': '),
    onclick: () => select(0, l.id),
  }))));

  const cur = levels.find(x => x.l.id === levelId);
  if (cur) {
    // Direct and Representative are always shown under every level; a path that doesn't exist counts as none (black).
    const branches = ['direct', 'representative'].map(b => ({ b, tone: tone(scoreBranch(cur.lvl[b], catalog)) || 'black' }));
    rows.push(rowOf(branches.map(({ b, tone }) => button({
      label: BRANCH_INFO[b].name, tone, title: BRANCH_INFO[b].desc, pressed: branchId === b, onclick: () => select(1, b),
    }))));

    const branch = branches.some(x => x.b === branchId) && cur.lvl[branchId]?.applicable !== false ? cur.lvl[branchId] : null;
    if (branch) {
      const mechs = (branch.mechanisms || []).map((m, i) => ({ m, i, tone: tone(scoreMechanism(m, catalog)) })).filter(x => x.tone);
      const typeCount = mechs.reduce((n, { m }) => ({ ...n, [m.type]: (n[m.type] || 0) + 1 }), {});
      rows.push(rowOf(mechs.map(({ m, i, tone }) => {
        const mdef = catalog.mechanisms[m.type] || {};
        // Short generic names ("Referendum", "General assembly"); local names only to tell two of a kind apart.
        return button({
          label: shortName(typeCount[m.type] > 1 && m.name ? m.name : (mdef.name || m.name || m.type)), tone, title: m.name || mdef.description,
          pressed: mechIdx === i, onclick: () => select(2, i),
        });
      })));

      const mech = mechs.find(x => x.i === mechIdx)?.m;
      if (mech) {
        const props = mech.properties || [];
        rows.push(rowOf(props.map((p, i) => {
          const pdef = catalog.properties[p.type] || {};
          return button({
            label: p.name || pdef.name || p.type, tone: STATUS_TONE[p.status] || 'unknown',
            title: [pdef.description, p.explanation].filter(Boolean).join('\n\n'),
            pressed: propIdx === i, onclick: () => select(3, i),
          });
        })));

        const prop = props[propIdx];
        if (prop) rows.push(rowOf((prop.laws || []).map(id => {
          const law = j.laws[id] || { title: id };
          return button({ label: law.short || law.title, tone: 'law', title: [law.title, law.localTitle].filter(Boolean).join('\n'), href: law.url });
        })));
      }
    }
  }
  $('#tree').replaceChildren(...rows.filter(Boolean));
}

// ---------- shareable URL: #lat,lon/level/branch/mech/prop ----------
function writeHash() {
  if (!state.loc) return;
  const h = `#${state.loc.lat},${state.loc.lon}` + state.path.map(p => `/${p}`).join('');
  if (location.hash !== h) history.replaceState(null, '', h);
}
function readHash() {
  const m = location.hash.slice(1).split('/');
  const [lat, lon] = (m[0] || '').split(',').map(Number);
  if (!isFinite(lat) || !isFinite(lon) || !m[0]) return null;
  const path = m.slice(1).map((v, i) => (i >= 2 ? Number(v) : v));
  return { lat, lon, path };
}

// ---------- boot ----------
(async function boot() {
  try {
    state.data = await loadData();
  } catch (e) {
    $('#hint').textContent = `Could not load data (${e.message}). Serve the site over HTTP, e.g. "python3 -m http.server".`;
    return;
  }
  const h = readHash();
  if (h) { state.path = h.path; locate(h.lat, h.lon, { zoom: 15, keepPath: true }); }
})();
