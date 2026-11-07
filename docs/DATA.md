# Data schema

All assessments live in `data/`. There is no database. Each country is one JSON file, so adding or correcting data is a normal pull request. Run `node tools/validate.mjs` before committing; it checks every reference and prints the resulting scores.

## The model

```
Location ─▶ Level ─▶ Branch (direct | representative) ─▶ Mechanism ─▶ Property ─▶ Citations (law articles)
```

* **Level**: a community of shared interest (`data/catalog.json` → `levels`). *Spheres* (individual, market, cultural) apply everywhere. *Territorial* levels are named from the geocoded address.
* **Branch**: `direct` (the people decide) or `representative` (elected representatives decide).
* **Mechanism**: a concrete way of deciding, such as `referendum`, `initiative`, `general_assembly`, `council`, `executive`, or `upper_council_seat` (the community's own member of the council one level up, used as a fallback when it has no body of its own).
* **Property**: a condition the mechanism needs to give real self-government, such as `binding`, `no_quorum`, `reasonable_signatures`, `individual_vote`, or `local_constituency`. Each has a `status` of `yes`, `partial`, `no` or `unknown`.
* **Citation**: the article of law behind a status.

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
    "dcpa": {
      "title": "Direct Citizen Participation…Act", "localTitle": "Закон за прякото участие…", "url": "https://…",
      "checkedAgainst": { "title": "CEC English translation", "url": "https://…", "version": "as amended to SG No. 15/2022" }
    }
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
                "citations": [
                  { "law": "dcpa", "article": "Art. 60(1), (3)", "checked": true, "url": "optional deep link", "excerpt": "optional quote" }
                ]
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

A level that is missing shows as **No data**. Set `"checked": true` on a citation only after reading the article in the text named by the law's `checkedAgainst`; otherwise the UI labels it *unverified*. A citation may carry a `note`. Secondary sources (e.g. an election observation report) can be listed under `laws` too, with a title that says so.

Status: `sample` is placeholder data, `draft` is based on the legal texts but not reviewed by a lawyer, `reviewed` has been checked by someone qualified.

## Scoring

Scores are in [0, 1] and are coloured in six bands: None (0), Very weak, Weak, Partial, Substantial and Full (1).

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
