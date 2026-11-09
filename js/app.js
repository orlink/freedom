import { resolveJurisdiction, applyPopulation, getLevel, scoreLevel, scoreBranch, scoreMechanism, kindProperties, levelPlaces } from './model.js';

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const BRANCH_INFO = {
  direct: { name: 'Direct', longName: 'Direct decision making mechanisms', desc: 'The people decide themselves: referendums and general assemblies.' },
  representative: { name: 'Representative', longName: 'Representative bodies', desc: 'Elected, individually accountable representatives decide.' },
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
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Geocoding failed (${r.status})`);
  return r.json();
}
const reverse = (lat, lon) => nominatim('reverse', { lat, lon, zoom: 18 });
const search = q => nominatim('search', { q, limit: 1 });
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
    writeHash(!keepPath);
    render();
    // Some requirements depend on population (e.g. BG general assemblies: up to 10,000 inhabitants). Fetched after
    // the first render so the page doesn't wait for it; ignored if the pin has moved on meanwhile.
    const loc = state.loc;
    settlementAt(lat, lon).then(settlement => {
      if (state.loc !== loc || !settlement) return;
      loc.settlement = settlement;
      loc.jurisdiction = applyPopulation(loc.jurisdiction, settlement);
      render();
    }).catch(() => { /* no population: keep the data's own statuses */ });
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
async function api(method, path, body) {
  const r = await fetch(path, method === 'GET' ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) throw new Error(r.status);
  return r.json();
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
  if (sharedApi) { try { e = await api('POST', path, { key, ...body }); } catch { sharedApi = false; } }
  if (!e) { e = structuredClone(interestCache.get(key) || { added: [], hidden: [] }); apply(e); localStore(key, e); }
  interestCache.set(key, e);
  render();
}
const addInterest = (key, label) => changeInterests(key, 'api/interests', { label }, e => {
  if (!e.added.some(a => a.label.toLowerCase() === label.toLowerCase())) e.added.push({ id: 'u:' + Date.now().toString(36), label });
});
const hideInterest = (key, id) => changeInterests(key, 'api/interests/hide', { id }, e => { if (!e.hidden.includes(id)) e.hidden.push(id); });

function interestChips(levelId) {
  const key = interestKey(levelId);
  const e = interestCache.get(key);
  if (!e) { loadInterests(key).then(render); return [el('span', { class: 'loading' }, '…')]; }
  const defaults = (state.data.interests[levelId] || []).map(label => ({ id: 'd:' + slug(label), label }));
  const chips = [...defaults, ...e.added].filter(c => !e.hidden.includes(c.id));
  const out = chips.map(c => el('div', { class: 'tb t-interest', title: c.label },
    el('span', {}, c.label),
    el('button', { type: 'button', class: 'x', title: `Not applicable here: ${c.label}`, 'aria-label': `Mark “${c.label}” as not applicable here`, onclick: () => hideInterest(key, c.id) }, '×')));
  out.push(addChip(key));
  return out;
}
function addChip(key) {
  const wrap = el('div', { class: 'tb t-add' });
  const start = () => {
    const input = el('input', { type: 'text', maxlength: '60', placeholder: 'New interest', 'aria-label': 'New shared interest' });
    const done = save => { const v = input.value.trim(); if (save && v) addInterest(key, v); else render(); };
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

function chip({ label, tone, title, onclick, href, disabled }) {
  const attrs = { class: `tb t-${tone}`, title: title || label };
  if (disabled) attrs.disabled = '';
  if (href) return el('a', { ...attrs, href, target: '_blank', rel: 'noopener' }, el('span', {}, label));
  return el('button', { ...attrs, type: 'button', onclick }, el('span', {}, label));
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
  const parts = [a.country, a.city || a.town || a.village || a.hamlet, loc.places.neighbourhood?.name].filter(Boolean);
  $('#place').replaceChildren(...parts.flatMap((p, i) => i ? [el('span', { class: 'sep' }, '·'), p] : [p]));
}

// A mechanism may be named differently at some levels (catalog `levelNames`), e.g. the council of a country is its parliament.
const levelName = (mdef, levelId, key) => mdef.levelNames?.[levelId]?.[key];
function mechLabel(m, all, catalog, levelId) {
  const mdef = catalog.mechanisms[m.type] || {};
  const twins = all.filter(x => x.type === m.type).length > 1;
  return shortName(twins && m.name ? m.name : (levelName(mdef, levelId, 'name') || mdef.name || m.name || m.type));
}

function mechLongName(m, all, catalog, levelId) {
  const mdef = catalog.mechanisms[m.type] || {};
  const twins = all.filter(x => x.type === m.type).length > 1;
  return twins && m.name ? m.name : (levelName(mdef, levelId, 'longName') || mdef.longName || mdef.name || m.name || m.type);
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

// The legal text behind a requirement: per law, a linked title and the quoted provisions (translated).
// When the data proposes amendments (`fix` on a provision), a Fix button shows them as tracked changes.
function provisionsPanel(provisions, laws, explainer, prop) {
  const fixable = provisions.some(p => (p.items || []).some(it => it.fix != null));
  const panel = el('div', {});
  const draw = fixed => {
    // A band on top, in the requirement's own colour, says at a glance whether the law meets it.
    const t = fixed ? 'white' : STATUS_TONE[prop?.status];
    const verdictLabel = t && Object.fromEntries(LEGENDS.requirements)[t];
    const btn = fixable ? el('button', { type: 'button', class: 'fix-btn', 'aria-pressed': String(fixed), onclick: () => draw(!fixed) }, fixed ? 'Show current law' : 'Fix') : null;
    const note = fixed ? 'With these amendments (proposed by Freedom Map, not law).' : prop?.explanation;
    const verdict = verdictLabel ? el('div', { class: `verdict t-${t}` },
      el('strong', {}, verdictLabel), note ? el('span', {}, note) : null, btn) : btn;
    panel.className = `provisions${t ? ` v-${t}` : ''}${fixed ? ' fixed' : ''}`;
    panel.replaceChildren(...[verdict, ...provisions.map(p => {
      const law = laws[p.law] || { title: p.law };
      const title = law.url ? el('a', { href: law.url, target: '_blank', rel: 'noopener' }, law.title) : law.title;
      return el('section', {},
        el('h3', {}, title),
        ...(p.items || []).map(it => el('div', { class: 'provision' },
          it.ref ? el('p', { class: 'ref' }, it.ref) : null,
          ...provisionLines(it, fixed))));
    }), explainer && !fixed ? el('section', { class: 'explainer' },
      el('h3', {}, explainer.title),
      el('blockquote', {}, explainer.quote.map(t => el('p', {}, t))),
      el('p', { class: 'source' }, 'Source: ', el('a', { href: explainer.url, target: '_blank', rel: 'noopener' }, explainer.source))) : null].filter(Boolean));
  };
  draw(false);
  return panel;
}

function render() {
  const { catalog } = state.data;
  const loc = state.loc;
  if (!loc) return;
  $('#hint').hidden = true;
  renderPlace();
  const j = loc.jurisdiction;
  $('#status').textContent = j ? (j.statusNote || '') : '';
  if (!j) {
    $('#trail').replaceChildren();
    $('#tree').replaceChildren(el('p', { class: 'nodata' }, `No data for ${loc.address.country || 'this country'} yet.`));
    return;
  }

  // Resolve the path as far as it is valid.
  const [levelId, branchId, mechIdx, step4, step5] = state.path;
  const levels = catalog.levels.map(l => {
    const lvl = loc.places[l.id].absent ? undefined : getLevel(j, l.id);
    return { l, lvl, tone: tone(scoreLevel(lvl, catalog)) };
  }).filter(x => x.tone);
  const cur = levels.find(x => x.l.id === levelId);
  const branch = cur && ['direct', 'representative'].includes(branchId) ? cur.lvl[branchId] : undefined;
  const mechs = branch?.applicable !== false ? (branch?.mechanisms || []) : [];
  const mech = mechs[mechIdx];
  // A mechanism with kinds (referendum) has one more screen: the kinds, then each kind's properties.
  const kindIdx = mech?.kinds ? step4 : undefined;
  const kind = mech?.kinds?.[kindIdx];
  const kindDefs = catalog.referendumKinds || {};
  const props = kind ? kindProperties(kind, mech.type, catalog) : (mech?.kinds ? [] : mech?.properties || []);
  const propIdx = mech?.kinds ? step5 : step4;
  const prop = props[propIdx]?.disabled ? undefined : props[propIdx];
  const propPath = i => (mech.kinds ? [levelId, branchId, mechIdx, kindIdx, i] : [levelId, branchId, mechIdx, i]);

  // Trail: where you are in the tree; each step is clickable.
  // Trail uses each chip's long name.
  const steps = [['Shared interest levels', []]];
  if (cur) steps.push([cur.l.longName || cur.l.name, [levelId]]);
  if (cur && branchId && BRANCH_INFO[branchId]) steps.push([BRANCH_INFO[branchId].longName, [levelId, branchId]]);
  if (mech) steps.push([mechLongName(mech, mechs, catalog, levelId), [levelId, branchId, mechIdx]]);
  if (kind) steps.push([kind.name || kindDefs[kind.type]?.longName || kind.type, [levelId, branchId, mechIdx, kindIdx]]);
  if (prop) steps.push([prop.name || catalog.properties[prop.type]?.longName || catalog.properties[prop.type]?.name, propPath(propIdx)]);
  $('#trail').replaceChildren(...(steps.length > 1 ? steps.flatMap(([name, path], i) => [
    i ? el('span', { class: 'sep' }, '›') : null,
    i < steps.length - 1 ? el('button', { type: 'button', onclick: () => go(path) }, name) : el('span', { class: 'here' }, name),
  ]).filter(Boolean) : []));

  const screen = [];
  if (!cur) {
    // Screen 1: levels of shared interest. Geographical, from home to union; then non-geographical.
    const levelChip = ({ l, tone }) => chip({ label: l.name, tone, title: [l.name, loc.places[l.id].name].filter(Boolean).join(': '), onclick: () => go([l.id]) });
    setLegend('levels');
    screen.push(el('h2', { class: 'group-title' }, 'Shared interest levels'));
    screen.push(rowOf(levels.filter(x => x.l.kind === 'territorial').map(levelChip)));
    screen.push(rowOf(levels.filter(x => x.l.kind !== 'territorial').map(levelChip)));
  } else if (!branch && branchId !== 'direct' && branchId !== 'representative') {
    // Screen 2: the level's shared interests, then the two ways of deciding.
    setLegend('levels');
    screen.push(el('h2', { class: 'group-title' }, 'Shared interest types'));
    screen.push(rowOf(interestChips(levelId), 'interests'));
    screen.push(el('h2', { class: 'group-title' }, 'Decision making mechanism types'));
    screen.push(rowOf(['direct', 'representative'].map(b => chip({
      label: BRANCH_INFO[b].name, tone: tone(scoreBranch(cur.lvl[b], catalog)) || 'black', title: BRANCH_INFO[b].desc,
      onclick: () => go([levelId, b]),
    }))));
  } else if (!mech) {
    // Screen 3: mechanisms (e.g. referendum, general assembly). None at all: one black chip saying so.
    const shown = mechs.map((m, i) => ({ m, i, tone: mechTone(scoreMechanism(m, catalog)) })).filter(x => x.tone);
    setLegend('mechanisms');
    screen.push(rowOf(shown.length ? shown.map(({ m, i, tone }) => chip({
      label: mechLabel(m, mechs, catalog, levelId), tone, title: m.name || catalog.mechanisms[m.type]?.description, onclick: () => go([levelId, branchId, i]),
    })) : [chip({ label: 'None', tone: 'black', title: branch?.note || 'No such mechanism at this level.' })]));
  } else if (mech.kinds && !kind) {
    // Screen 4a: kinds of referendum (citizen initiative, veto, mandatory). Each is always shown; missing ones are black.
    setLegend('mechanisms');
    screen.push(rowOf((catalog.mechanisms[mech.type]?.kinds || []).map(t => {
      const i = mech.kinds.findIndex(k => k.type === t);
      const k = mech.kinds[i], def = kindDefs[t] || {};
      const score = k ? scoreMechanism({ type: mech.type, properties: k.properties }, catalog) : 0;
      return chip({
        label: def.name || t, tone: mechTone(score) || 'unknown', title: [k?.name, def.description].filter(Boolean).join('\n\n'),
        onclick: i >= 0 ? () => go([levelId, branchId, mechIdx, i]) : undefined,
      });
    })));
  } else if (!prop) {
    // Screen 4: the properties the mechanism needs. If it does not exist in law, the rest are disabled.
    setLegend('requirements');
    screen.push(rowOf(props.map((p, i) => {
      const pdef = catalog.properties[p.type] || {};
      return chip({
        label: p.name || pdef.name || p.type, tone: p.disabled ? 'disabled' : (STATUS_TONE[p.status] || 'unknown'),
        title: p.disabled ? 'Does not apply: the mechanism does not exist in law.' : [pdef.description, p.explanation].filter(Boolean).join('\n\n'),
        onclick: p.disabled ? undefined : () => go(propPath(i)), disabled: p.disabled,
      });
    })));
  } else {
    // Screen 5: the relevant laws.
    setLegend(null);
    const explainer = catalog.properties[prop.type]?.explainer;
    if (prop.provisions?.length) screen.push(provisionsPanel(prop.provisions, j.laws, explainer, prop));
    else screen.push(rowOf((prop.laws || []).map(id => {
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
  if (!h) return;
  if (state.loc && h.lat === state.loc.lat && h.lon === state.loc.lon) { state.path = h.path; render(); }
  else { state.path = h.path; locate(h.lat, h.lon, { zoom: 15, keepPath: true }); }
});

// ---------- boot ----------
(async function boot() {
  try {
    state.data = await loadData();
  } catch (e) {
    $('#hint').textContent = `Could not load data (${e.message}). Start the site with "python3 server.py".`;
    return;
  }
  const h = readHash();
  if (h) { state.path = h.path; locate(h.lat, h.lon, { zoom: 15, keepPath: true }); }
})();
