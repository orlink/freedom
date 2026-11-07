// Validates data files against the catalog and prints a score table.
// Usage: node tools/validate.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { STATUSES, BRANCHES, resolveJurisdiction, getLevel, scoreLevel, scoreBranch, band } from '../js/model.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const read = p => JSON.parse(readFileSync(join(root, p), 'utf8'));
const catalog = read('catalog.json');
const index = read('index.json');
const levelIds = new Set(catalog.levels.map(l => l.id));
const errors = [];

function checkLevel(where, lvl, j) {
  if (lvl.sameAs && !levelIds.has(lvl.sameAs)) errors.push(`${where}: sameAs unknown level "${lvl.sameAs}"`);
  for (const b of BRANCHES) {
    const branch = lvl[b];
    if (!branch || branch.applicable === false) continue;
    for (const [mi, m] of (branch.mechanisms || []).entries()) {
      const mdef = catalog.mechanisms[m.type];
      if (!mdef) errors.push(`${where}.${b}[${mi}]: unknown mechanism type "${m.type}"`);
      else if (mdef.branch !== b) errors.push(`${where}.${b}[${mi}]: mechanism "${m.type}" belongs to ${mdef.branch}`);
      for (const p of m.properties || []) {
        if (!catalog.properties[p.type]) errors.push(`${where}.${b}.${m.type}: unknown property "${p.type}"`);
        if (!STATUSES.includes(p.status)) errors.push(`${where}.${b}.${m.type}.${p.type}: bad status "${p.status}"`);
        for (const c of p.citations || []) if (!j.laws?.[c.law]) errors.push(`${where}.${b}.${m.type}.${p.type}: unknown law "${c.law}"`);
      }
    }
  }
}

const jurisdictions = index.jurisdictions.map(read);
for (const j of jurisdictions) {
  if (!['sample', 'draft', 'reviewed'].includes(j.status)) errors.push(`${j.id}: status must be sample|draft|reviewed`);
  for (const [id, lvl] of Object.entries(j.levels)) {
    if (!levelIds.has(id)) errors.push(`${j.id}.${id}: unknown level`);
    checkLevel(`${j.id}.${id}`, lvl, j);
  }
  for (const a of j.areas || []) for (const [id, lvl] of Object.entries(a.levels)) {
    if (!levelIds.has(id)) errors.push(`${j.id}[${a.name}].${id}: unknown level`);
    checkLevel(`${j.id}[${a.name}].${id}`, lvl, j);
  }
}

const samples = {
  'Sofia, Lozenets': { country_code: 'bg', city: 'Sofia', suburb: 'Lozenets' },
  'Zürich': { country_code: 'ch', city: 'Zürich', state: 'Zürich' },
};
for (const [name, addr] of Object.entries(samples)) {
  const j = resolveJurisdiction(jurisdictions, addr);
  console.log(`\n${name} (${j.name}${j.appliedAreas.length ? ' + ' + j.appliedAreas.join(', ') : ''})`);
  for (const l of catalog.levels) {
    const lvl = getLevel(j, l.id);
    const s = scoreLevel(lvl, catalog);
    const fmt = x => (typeof x === 'number' ? x.toFixed(2) : String(x));
    console.log(`  ${l.id.padEnd(14)} ${fmt(s).padEnd(6)} ${band(s).label.padEnd(12)} direct=${fmt(scoreBranch(lvl?.direct, catalog))} rep=${fmt(scoreBranch(lvl?.representative, catalog))}`);
  }
}

if (errors.length) { console.error('\nErrors:\n' + errors.join('\n')); process.exit(1); }
console.log('\nAll data files valid.');
