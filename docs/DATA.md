# Data schema

All assessments live in `data/`. There is no database. Each country is one JSON file, so adding or correcting data is a normal pull request. Run `node tools/validate.mjs` before committing; it checks every reference and prints the resulting scores.

## The model

```
Location ─▶ Level ─▶ Branch (direct | representative) ─▶ Mechanism ─▶ Property ─▶ Relevant laws  (─▶ articles, next step)
```

* **Level**: a community of shared interest (`data/catalog.json` → `levels`). *Spheres* (individual, business, non-profit) apply everywhere. *Territorial* levels are named from the geocoded address.
* A **referendum** lists `kinds` instead of `properties`: `citizen_initiative`, `veto_referendum` and `mandatory_referendum` (catalog `referendumKinds`). Each kind has its own `properties`; the page always shows the five in `kindProperties` (exists, binding, no quorum, concrete proposals, reasonable petition requirements). A kind that does not exist only needs `exists: no`, and the other four appear disabled.
* Every level, mechanism type and property type in the catalog has a short `name` (shown on its chip) and a `longName` (shown in the breadcrumb trail).
* **Branch**: `direct` (the people decide) or `representative` (elected representatives decide).
* **Mechanism**: a concrete way of deciding, such as `referendum`, `general_assembly`, `council`, `executive`, or `upper_council_seat` (the community's own member of the council one level up, used as a fallback when it has no body of its own).
  Agenda initiatives (a petition the council only has to consider) are deliberately left out: they are not a decision-making mechanism, because no representative is accountable for the proposal.
* **Property**: a condition the mechanism needs to give real self-government, such as `binding`, `no_quorum`, `reasonable_signatures`, `individual_vote`, or `local_constituency`. Each has a `status` of `yes`, `partial`, `no` or `unknown`.
* **Relevant laws**: the leaves of the tree. Each property lists the laws (`laws`, ids into the file's `laws` map) that govern it. Specific articles are the next step and are being worked out separately, starting from the notes in `docs/research/`.

## Jurisdiction file

```jsonc
{
  "id": "bg",
  "name": "Bulgaria",
  "match": { "country_code": "bg" },        // matched against Nominatim's address fields
  "status": "sample",                       // sample | draft | reviewed (shown in the UI)
  "statusNote": "…",
  "addressKeys": { "county": ["state"] },   // optional: which OSM address fields name each level in this country
  "laws": {
    "dcpa": { "title": "Direct Citizen Participation…Act", "localTitle": "Закон за прякото участие…", "short": "ЗПУГДВМС", "url": "https://…" }
  },
  "levels": {
    "neighbourhood": {
      "summary": "One or two sentences shown above Direct | Representative.",
      "direct": {
        "mechanisms": [
          {
            "type": "general_assembly",              // key in catalog.mechanisms
            "name": "General assembly of the population", // optional local name
            "properties": [
              {
                "type": "no_quorum",                 // key in catalog.properties
                "status": "no",                      // yes | partial | no | unknown
                "explanation": "One quarter of voters must attend…",
                "laws": ["const", "dcpa"]                  // the leaves: laws that govern this property
              }
            ]
          }
        ]
      },
      "representative": { "applicable": false, "note": "Why not" }   // or { "mechanisms": [...] }
    },
    "building": { "sameAs": "entrance" },     // reuse another level's assessment
    "state":    { "applicable": false, "summary": "Unitary state." }
  },
  "areas": [                                  // optional, later entries override earlier, per level
    { "name": "City of Zürich", "match": { "city": ["Zürich", "Zurich"] }, "levels": { "municipality": { … } } }
  ]
}
```

A level that is missing shows as **No data**. Every property must list at least one law (`node tools/validate.mjs` checks this).

Status: `sample` is placeholder data, `draft` lists the relevant laws with provisional assessments, articles not yet confirmed, `reviewed` has been checked by someone qualified.

## Scoring

Scores are in [0, 1]. The page uses four colours: black for 0 (none), dark grey below 0.5 (weak), light grey from 0.5 up to 1 (good), white for 1 (full). A property marked yes is white, partly is light grey, no is black. Levels, branches and mechanisms with no data or that do not apply are hidden.

* **Property**: yes = 1, partial = 0.5, no = 0, unknown is ignored.
* **Mechanism**: the average of its known properties. *Gate* properties (`exists`, `binding`, `binding_powers`, plus any listed in the mechanism's `gates`) zero the mechanism when `no` and halve it when `partial`. The mechanism's `weight` scales the result: `upper_council_seat` counts at 0.4, because a seat in someone else's council is a weak substitute for the community's own body, and it is void if that seat is not elected by this community alone (for example, a council elected from one municipality-wide list).
* **Branch**: the best mechanism counts. One working path is enough.
* **Level**: the better of direct and representative.

These rules are in `js/model.js` and are deliberately simple so they can be debated and changed.

## Adding a country

1. Copy `data/jurisdictions/bg.json` to `data/jurisdictions/<country code>.json` and edit it.
2. Add it to `data/index.json`.
3. If OSM uses different admin levels in that country, set `addressKeys`. Check what Nominatim returns with `https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&lat=…&lon=…`.
4. Run `node tools/validate.mjs`.
