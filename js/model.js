// Pure data logic: no DOM, no network. Usable from the browser and from Node (tools/validate.mjs).

export const STATUS_VALUE = { yes: 1, partial: 0.5, weak: 0.25, no: 0, unknown: null };
export const STATUSES = Object.keys(STATUS_VALUE);
export const BRANCHES = ['direct', 'representative'];

/** Does an address match an area's `match` object? Each key must equal one of the given values (case-insensitive). */
export function matches(match, address) {
  return Object.entries(match || {}).every(([key, want]) => {
    const have = address[key];
    if (have == null) return false;
    const wants = Array.isArray(want) ? want : [want];
    return wants.some(w => String(w).toLowerCase() === String(have).toLowerCase());
  });
}

/** Pick the jurisdiction for an address and merge any area overrides (later areas win, per level). */
export function resolveJurisdiction(jurisdictions, address) {
  const base = jurisdictions.find(j => matches(j.match, address));
  if (!base) return null;
  const levels = { ...base.levels };
  const appliedAreas = [];
  for (const area of base.areas || []) {
    if (matches(area.match, address)) {
      Object.assign(levels, area.levels);
      appliedAreas.push(area.name);
    }
  }
  return { ...base, levels, appliedAreas };
}

/** Get the assessment for a level, following `sameAs` links. Returns undefined if there is no data. */
export function getLevel(jurisdiction, levelId, seen = new Set()) {
  const lvl = jurisdiction?.levels?.[levelId];
  if (!lvl) return undefined;
  if (lvl.sameAs && !seen.has(levelId)) {
    seen.add(levelId);
    const target = getLevel(jurisdiction, lvl.sameAs, seen);
    if (!target) return { ...lvl };
    return { ...target, ...withoutKeys(lvl, ['sameAs']), sameAs: lvl.sameAs, summary: lvl.summary || target.summary };
  }
  return lvl;
}

function withoutKeys(obj, keys) {
  const out = { ...obj };
  keys.forEach(k => delete out[k]);
  return out;
}

/**
 * Score a mechanism in [0,1], or null if nothing is known.
 * Average of the known property values; a "gate" property that is "no" zeroes the mechanism, one that is
 * "partial" halves it, and one that is "weak" caps it at 0.25 (dark grey). Gates are set per property in the catalog, or per mechanism via `gates`.
 * A property marked `optional` in the catalog (recall) counts only when met, so its absence never lowers the score.
 * A mechanism's `weight` (default 1) scales the result, e.g. for fallback mechanisms.
 */
export function scoreMechanism(mech, catalog) {
  // A mechanism with kinds (e.g. referendum: citizen initiative, veto, mandatory) is as good as its best kind.
  if (mech.kinds) {
    // A kind can skip properties that do not apply to it (catalog `skipProperties`: no petition for a mandatory referendum).
    const applies = k => p => !(catalog.referendumKinds?.[k.type]?.skipProperties || []).includes(p.type);
    const scores = mech.kinds.map(k => scoreMechanism({ type: mech.type, properties: (k.properties || []).filter(applies(k)) }, catalog)).filter(x => x != null);
    return scores.length ? Math.max(...scores) : null;
  }
  const props = mech.properties || [];
  let gateFactor = 1, cap = 1;
  const values = [];
  for (const p of props) {
    const v = STATUS_VALUE[p.status];
    const def = catalog.properties[p.type] || {};
    // An "optional" property (e.g. recall) is welcome but not required: it never lowers the score.
    if (def.optional && v != null && v < 1) continue;
    const gate = def.gate || (catalog.mechanisms[mech.type]?.gates || []).includes(p.type);
    if (gate && v === 0) return 0;
    if (gate && v === 0.5) gateFactor *= 0.5;
    if (gate && v === 0.25) cap = Math.min(cap, 0.25);
    // A "cap" property (e.g. individual vote for a council) that is not fully met limits the mechanism to dark grey.
    if ((catalog.mechanisms[mech.type]?.caps || []).includes(p.type) && v != null && v <= 0.25) cap = Math.min(cap, 0.25);
    if (v != null) values.push(v);
  }
  if (!values.length) return null;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const weight = catalog.mechanisms[mech.type]?.weight ?? 1;
  return Math.min(avg * gateFactor, cap) * weight;
}

/** Score a branch ("direct" | "representative"): the best mechanism counts. 'na' if not applicable. */
export function scoreBranch(branch, catalog) {
  if (!branch) return null;
  if (branch.applicable === false) return 'na';
  const scores = (branch.mechanisms || []).map(m => scoreMechanism(m, catalog)).filter(s => s != null);
  return scores.length ? Math.max(...scores) : null;
}

/** Score a level: people are as free as their best path (direct or representative). */
export function scoreLevel(level, catalog) {
  if (!level) return null;
  if (level.applicable === false) return 'na';
  const scores = BRANCHES.map(b => scoreBranch(level[b], catalog)).filter(s => typeof s === 'number');
  return scores.length ? Math.max(...scores) : null;
}

export const PROPERTY_SCORE = p => (STATUS_VALUE[p.status] ?? null);

/** Map a score to a display band. */
export function band(score) {
  if (score === 'na') return { key: 'na', label: 'Not applicable' };
  if (score == null) return { key: 'nodata', label: 'No data' };
  if (score <= 0) return { key: 's0', label: 'None' };
  if (score < 0.25) return { key: 's1', label: 'Very weak' };
  if (score < 0.5) return { key: 's2', label: 'Weak' };
  if (score < 0.75) return { key: 's3', label: 'Partial' };
  if (score < 1) return { key: 's4', label: 'Substantial' };
  return { key: 's5', label: 'Full' };
}

export function statusBand(status) {
  return { yes: { key: 's5', label: 'Yes' }, partial: { key: 's3', label: 'Partly' }, no: { key: 's0', label: 'No' } }[status]
    || { key: 'nodata', label: 'Unknown' };
}

const TERRITORY_ONLY_IF_PRESENT = ['village', 'town'];

/**
 * Name each level for a geocoded address (e.g. neighbourhood -> "Lozenets").
 * A jurisdiction may override which OSM address keys map to a level (`addressKeys`), since OSM admin levels differ by country.
 */
export function levelPlaces(address, catalog, unions, jurisdiction) {
  const out = {};
  const overrides = jurisdiction?.addressKeys || {};
  const street = [address.road, address.house_number].filter(Boolean).join(' ');
  for (const lvl of catalog.levels) {
    let name = null;
    const keys = overrides[lvl.id] || lvl.addressKeys || [];
    for (const k of keys) if (address[k]) { name = address[k]; break; }
    if (lvl.id === 'building') name = street || address.building || null;
    if (lvl.id === 'home') name = street || null;
    if (lvl.id === 'entrance') name = street ? `Section at ${street}` : null;
    if (lvl.id === 'union') {
      const u = Object.values(unions || {}).find(u => u.members.includes(address.country_code));
      name = u ? u.name : null;
    }
    const absent = TERRITORY_ONLY_IF_PRESENT.includes(lvl.id) && !keys.some(k => address[k]);
    out[lvl.id] = { name, absent: absent || (lvl.id === 'union' && !name) };
  }
  // A jurisdiction can hide levels its law does not know (`hiddenLevels`). In a small settlement some levels do not
  // exist either (`hiddenIn`, by settlement level): by default a village takes the place of the neighbourhood; in
  // Bulgaria villages also have no apartment buildings and towns have no quarters.
  const hiddenLevels = jurisdiction?.hiddenLevels || [];
  const hiddenIn = jurisdiction?.hiddenIn || { village: ['neighbourhood'] };
  for (const [settlement, ids] of Object.entries(hiddenIn)) {
    if (!out[settlement] || out[settlement].absent || hiddenLevels.includes(settlement)) continue;
    for (const id of ids) if (out[id]) out[id].absent = true;
  }
  for (const id of hiddenLevels) if (out[id]) out[id].absent = true;
  // A settlement that is its municipality's centre: the municipality is named after it (in Bulgaria OSM gives the
  // municipality as `state_district`, e.g. town "Етрополе" in municipality "Етрополе" or "Община Етрополе").
  const bare = n => String(n || '').toLocaleLowerCase().replace(/^(община|municipality of)\s+/, '').trim();
  const muni = bare(out.municipality?.name);
  for (const id of TERRITORY_ONLY_IF_PRESENT) {
    const p = out[id];
    if (p && !p.absent && p.name && muni && bare(p.name) === muni) p.centre = true;
  }
  // A town that is its municipality's centre is governed by the municipality itself and is divided into quarters
  // (e.g. Svishtov): show the neighbourhood instead of the town, even where OpenStreetMap does not name the quarter.
  const nb = out.neighbourhood;
  if (out.town?.centre && nb && !hiddenLevels.includes('neighbourhood')) {
    out.town.absent = true;
    nb.absent = false;
  }
  return out;
}

/**
 * The property chips of a referendum kind, in the catalog's order. Properties the data leaves out appear as
 * "unknown"; when the kind does not exist in law, every other property is marked `disabled`.
 */
export function kindProperties(kind, mechType, catalog) {
  const skip = catalog.referendumKinds?.[kind.type]?.skipProperties || [];
  const order = (catalog.mechanisms[mechType]?.kindProperties || []).filter(t => !skip.includes(t));
  const byType = Object.fromEntries((kind.properties || []).map(p => [p.type, p]));
  const missing = byType.exists?.status === 'no';
  return order.map(t => {
    const p = byType[t] || { type: t, status: 'unknown', laws: [] };
    return t !== 'exists' && missing ? { ...p, disabled: true } : p;
  });
}

/**
 * A village or town that is its municipality's centre has no mayor or local referendum of its own: the municipality
 * governs it directly. With `municipalCentre` set (e.g. { "sameAs": "municipality" }), such a settlement's level
 * follows that level instead. Returns a new jurisdiction; the input is not changed.
 */
export function applySettlementRoles(jurisdiction, places) {
  const rule = jurisdiction?.municipalCentre;
  if (!rule) return jurisdiction;
  const levels = { ...jurisdiction.levels };
  for (const id of TERRITORY_ONLY_IF_PRESENT) {
    const p = places?.[id];
    if (p?.centre && levels[id]) levels[id] = { sameAs: rule.sameAs, summary: `${p.name} is the municipal centre. It has no mayor or local referendum of its own and is governed directly by the municipality.` };
  }
  return { ...jurisdiction, levels };
}

/**
 * Apply population thresholds from the law to a resolved jurisdiction (e.g. BG Art. 55(1): a general assembly of the
 * population only where there are up to 10,000 inhabitants). A property with `populationRule` gets its status from
 * the population of the settlement under the pin (`settlement` = { name, population }), as follows:
 *  - use "self"     (the level is the settlement, e.g. a village): population ≤ max → yes, else no; unknown → `ifUnknown`.
 *  - use "part"     (the level lies inside the settlement, e.g. a quarter): settlement ≤ max → yes (a part is smaller);
 *                   otherwise `ifLarger` (default "no": a quarter of a larger city is taken to exceed the limit).
 *  - use "contains" (the level contains the settlement, e.g. a municipality): settlement > max → no; otherwise unchanged.
 * Returns a new jurisdiction; the input is not changed. Each changed property gets an `explanation` saying why.
 */
export function applyPopulation(jurisdiction, settlement) {
  if (!jurisdiction) return jurisdiction;
  const pop = Number.isFinite(settlement?.population) ? settlement.population : null;
  const fmt = n => n.toLocaleString('en-GB');
  const where = settlement?.name || 'This place';
  const ruled = p => {
    const r = p.populationRule;
    if (!r) return p;
    const max = r.max, lim = max != null ? `the limit of ${fmt(max)} inhabitants` : '';
    let status = null, why = null;
    if (r.use === 'self' && r.min != null) {
      // A floor instead of a ceiling (e.g. BG: only settlements of over 100 residents elect their own mayor).
      if (pop != null) { status = pop > r.min ? 'yes' : (r.ifUnder || 'no'); why = `${where} has about ${fmt(pop)} inhabitants (OpenStreetMap), ${pop > r.min ? 'over' : 'not over'} the threshold of ${fmt(r.min)}. ${pop > r.min ? (r.overNote || '') : (r.underNote || '')}`.trim(); }
      else if (r.ifUnknown) { status = r.ifUnknown; why = r.unknownNote || null; }
    } else if (r.use === 'self') {
      if (pop != null) { status = pop <= max ? 'yes' : 'no'; why = `${where} has about ${fmt(pop)} inhabitants (OpenStreetMap), ${pop <= max ? 'within' : 'over'} ${lim}.`; }
      else if (r.ifUnknown) { status = r.ifUnknown; why = r.unknownNote || null; }
    } else if (r.use === 'part') {
      if (pop != null && pop <= max) { status = 'yes'; why = `${where} has about ${fmt(pop)} inhabitants (OpenStreetMap), so any part of it is within ${lim}.`; }
      else if (pop != null) { status = r.ifLarger || 'no'; why = `${where} has about ${fmt(pop)} inhabitants (OpenStreetMap). Its quarters are taken to be over ${lim}, since their own populations are not recorded.`; }
    } else if (r.use === 'contains') {
      if (pop != null && pop > max) { status = 'no'; why = `It includes ${where}, which alone has about ${fmt(pop)} inhabitants (OpenStreetMap), over ${lim}.`; }
    }
    return status ? { ...p, status, explanation: why || p.explanation } : p;
  };
  const mech = m => ({ ...m, properties: (m.properties || []).map(ruled), ...(m.kinds ? { kinds: m.kinds.map(k => ({ ...k, properties: (k.properties || []).map(ruled) })) } : {}) });
  const levels = {};
  for (const [id, lvl] of Object.entries(jurisdiction.levels || {})) {
    const out = { ...lvl };
    for (const b of BRANCHES) if (lvl[b]?.mechanisms) out[b] = { ...lvl[b], mechanisms: lvl[b].mechanisms.map(mech) };
    levels[id] = out;
  }
  return { ...jurisdiction, levels };
}
