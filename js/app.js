import { resolveJurisdiction, getLevel, scoreLevel, scoreBranch, scoreMechanism, band, statusBand, levelPlaces } from './model.js';

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
  $('#place').hidden = false;
  $('#place').replaceChildren(el('p', { class: 'loading' }, 'Looking up this location…'));
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
    $('#place').replaceChildren(el('p', {}, `Could not look up this location: ${e.message}`));
  }
}

map.on('click', e => locate(e.latlng.lat, e.latlng.lng));
$('#search').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('#q').value.trim();
  if (!q) return;
  try {
    const [r] = await search(q);
    if (!r) { $('#place').hidden = false; $('#place').replaceChildren(el('p', {}, `Nothing found for “${q}”.`)); return; }
    locate(r.lat, r.lon, { zoom: 16, result: r });
  } catch (err) {
    $('#place').hidden = false; $('#place').replaceChildren(el('p', {}, err.message));
  }
});
document.querySelectorAll('.examples button').forEach(b => b.addEventListener('click', () => locate(b.dataset.lat, b.dataset.lon, { zoom: 16 })));

// ---------- rendering ----------
function tile({ name, place, desc, bandInfo, pressed, onclick, title }) {
  return el('button', {
    type: 'button', class: `tile b-${bandInfo.key}`, 'aria-pressed': String(!!pressed), title, onclick,
  },
  el('span', { class: 't-name' }, name),
  place ? el('span', { class: 't-place' }, place) : null,
  desc ? el('span', { class: 't-desc' }, desc) : null,
  el('span', { class: 't-band' }, bandInfo.label));
}

function select(depth, value) {
  state.path = state.path[depth] === value ? state.path.slice(0, depth) : [...state.path.slice(0, depth), value];
  render();
}

function row(title, crumb, content, summary) {
  return el('div', { class: 'row' },
    el('div', { class: 'row-head' }, el('h3', {}, title), crumb ? el('span', { class: 'crumb' }, crumb) : null),
    summary ? el('p', { class: 'row-summary' }, summary) : null,
    content);
}

function render() {
  const { catalog } = state.data;
  const loc = state.loc;
  writeHash();
  if (!loc) return;
  $('#intro').hidden = true;

  // Place header
  $('#place').replaceChildren(
    el('h2', {}, loc.label),
    el('p', { class: 'addr' }, loc.display),
  );

  // Data status notice
  const j = loc.jurisdiction;
  const notice = $('#notice');
  notice.hidden = false;
  if (!j) {
    notice.replaceChildren(el('strong', {}, 'No data yet'), ' ', `There is no assessment for ${loc.address.country || 'this country'} yet. `,
      el('a', { href: 'docs/DATA.md' }, 'Help add it.'));
  } else {
    notice.replaceChildren(el('strong', {}, { reviewed: 'Reviewed data', draft: 'Draft data', sample: 'Sample data' }[j.status] || j.status), ' ',
      j.statusNote || '', j.appliedAreas.length ? ` Local data applied: ${j.appliedAreas.join(', ')}.` : '');
  }

  const rows = [];
  const [levelId, branchId, mechIdx, propIdx] = state.path;

  // Row 1: levels
  const levelTiles = catalog.levels.map(l => {
    const place = loc.places[l.id];
    const lvl = j ? getLevel(j, l.id) : undefined;
    const score = place.absent ? 'na' : scoreLevel(lvl, catalog);
    return tile({
      name: l.name, place: place.absent ? 'Not part of one here' : (place.name || (l.kind === 'sphere' ? '' : '—')),
      bandInfo: band(score), pressed: levelId === l.id, title: l.description, onclick: () => select(0, l.id),
    });
  });
  rows.push(row('Levels of shared interest', null, el('div', { class: 'tiles' }, levelTiles)));

  if (levelId) {
    const ldef = catalog.levels.find(l => l.id === levelId);
    const place = loc.places[levelId];
    const lvl = j ? getLevel(j, levelId) : undefined;
    const crumb = [ldef.name, place.name].filter(Boolean).join(' · ');
    if (place.absent) {
      rows.push(row('Direct | Representative', crumb, el('p', { class: 'empty' }, `This location is not part of a ${ldef.name.toLowerCase()}.`), ldef.description));
    } else if (!lvl) {
      rows.push(row('Direct | Representative', crumb, el('p', { class: 'empty' }, 'No assessment for this level yet.'), ldef.description));
    } else if (lvl.applicable === false) {
      rows.push(row('Direct | Representative', crumb, el('p', { class: 'empty' }, 'This level does not exist here.'), lvl.summary));
    } else {
      const branchTiles = ['direct', 'representative'].map(b => tile({
        name: BRANCH_INFO[b].name, desc: BRANCH_INFO[b].desc, bandInfo: band(scoreBranch(lvl[b], catalog)),
        pressed: branchId === b, onclick: () => select(1, b),
      }));
      rows.push(row('Direct | Representative', crumb, el('div', { class: 'tiles wide' }, branchTiles), lvl.summary));

      if (branchId) {
        const branch = lvl[branchId];
        const bcrumb = `${crumb} › ${BRANCH_INFO[branchId].name}`;
        if (!branch) rows.push(row('Mechanisms', bcrumb, el('p', { class: 'empty' }, 'No assessment yet.')));
        else if (branch.applicable === false) rows.push(row('Mechanisms', bcrumb, el('p', { class: 'empty' }, branch.note || 'Not applicable at this level.')));
        else {
          const mechs = branch.mechanisms || [];
          const mechTiles = mechs.map((m, i) => {
            const mdef = catalog.mechanisms[m.type] || {};
            return tile({
              name: m.name || mdef.name || m.type, desc: mdef.description, bandInfo: band(scoreMechanism(m, catalog)),
              pressed: mechIdx === i, onclick: () => select(2, i),
            });
          });
          rows.push(row('Mechanisms', bcrumb, el('div', { class: 'tiles wide' }, mechTiles)));

          const mech = mechs[mechIdx];
          if (mech) {
            const mname = mech.name || catalog.mechanisms[mech.type]?.name;
            const mcrumb = `${bcrumb} › ${mname}`;
            const props = mech.properties || [];
            const propTiles = props.map((p, i) => {
              const pdef = catalog.properties[p.type] || {};
              return tile({
                name: p.name || pdef.name || p.type, bandInfo: statusBand(p.status), title: pdef.description,
                place: (p.laws || []).map(id => j.laws[id]?.short || id).join(' · '),
                pressed: propIdx === i, onclick: () => select(3, i),
              });
            });
            rows.push(row('Required properties', mcrumb, el('div', { class: 'tiles' }, propTiles), mech.note));

            const prop = props[propIdx];
            if (prop) rows.push(row('Relevant laws', `${mcrumb} › ${prop.name || catalog.properties[prop.type]?.name}`, propDetail(prop, j)));
          }
        }
      }
    }
  }
  $('#rows').replaceChildren(...rows);
}

function propDetail(prop, j) {
  const pdef = state.data.catalog.properties[prop.type] || {};
  const sb = statusBand(prop.status);
  const laws = prop.laws || [];
  return el('div', { class: 'detail' },
    el('h4', {}, el('span', { class: `status b-${sb.key}` }, sb.label), prop.name || pdef.name),
    el('p', { class: 'def' }, pdef.description, pdef.gate ? ' Essential: if this fails, the mechanism does not work.' : ''),
    prop.explanation ? el('p', {}, prop.explanation) : el('p', { class: 'empty' }, 'No explanation recorded yet.'),
    laws.length
      ? el('ul', { class: 'citations' }, laws.map(id => {
          const law = j.laws[id] || { title: id };
          return el('li', {},
            law.url ? el('a', { class: 'art', href: law.url, target: '_blank', rel: 'noopener' }, law.title) : el('span', { class: 'art' }, law.title),
            law.localTitle ? el('div', { class: 'local' }, law.localTitle) : null);
        }))
      : el('p', { class: 'empty' }, 'No law recorded yet.'),
    el('p', { class: 'empty' }, 'Specific articles are still being worked out.'));
}

function renderLegend() {
  const items = [['s0', 'None'], ['s1', 'Very weak'], ['s2', 'Weak'], ['s3', 'Partial'], ['s4', 'Substantial'], ['s5', 'Full'], ['nodata', 'No data'], ['na', 'Not applicable']];
  $('#legend').replaceChildren(...items.map(([k, l]) => el('span', {}, el('i', { class: `b-${k}` }), l)));
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
  renderLegend();
  try {
    state.data = await loadData();
  } catch (e) {
    $('#intro').replaceChildren(el('p', {}, `Could not load data (${e.message}). Serve the site over HTTP, e.g. "python3 -m http.server".`));
    return;
  }
  const h = readHash();
  if (h) { state.path = h.path; locate(h.lat, h.lon, { zoom: 15, keepPath: true }); }
})();
