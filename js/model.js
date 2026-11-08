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
 * Average of the known property values; a "gate" property that is "no" zeroes the mechanism and one that is
 * "partial" halves it. Gates are set per property in the catalog, or per mechanism via `gates`.
 * A mechanism's `weight` (default 1) scales the result, e.g. for fallback mechanisms.
 */
export function scoreMechanism(mech, catalog) {
  // A mechanism with kinds (e.g. referendum: citizen initiative, veto, mandatory) is as good as its best kind.
  if (mech.kinds) {
    const scores = mech.kinds.map(k => scoreMechanism({ type: mech.type, properties: k.properties }, catalog)).filter(x => x != null);
    return scores.length ? Math.max(...scores) : null;
  }
  const props = mech.properties || [];
  let gateFactor = 1;
  const values = [];
  for (const p of props) {
    const v = STATUS_VALUE[p.status];
    const def = catalog.properties[p.type] || {};
    const gate = def.gate || (catalog.mechanisms[mech.type]?.gates || []).includes(p.type);
    if (gate && v === 0) return 0;
    if (gate && v === 0.5) gateFactor *= 0.5;
    if (v != null) values.push(v);
  }
  if (!values.length) return null;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const weight = catalog.mechanisms[mech.type]?.weight ?? 1;
  return avg * gateFactor * weight;
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

const TERRITORY_ONLY_IF_PRESENT = ['village', 'town', 'city'];

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
  return out;
}

/**
 * The property chips of a referendum kind, in the catalog's order. Properties the data leaves out appear as
 * "unknown"; when the kind does not exist in law, every other property is marked `disabled`.
 */
export function kindProperties(kind, mechType, catalog) {
  const order = catalog.mechanisms[mechType]?.kindProperties || [];
  const byType = Object.fromEntries((kind.properties || []).map(p => [p.type, p]));
  const missing = byType.exists?.status === 'no';
  return order.map(t => {
    const p = byType[t] || { type: t, status: 'unknown', laws: [] };
    return t !== 'exists' && missing ? { ...p, disabled: true } : p;
  });
}
