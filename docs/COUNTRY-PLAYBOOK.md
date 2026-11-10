# Adding a country: the playbook

How to build `data/jurisdictions/<cc>.json` for a new country, to the standard of Bulgaria (`bg.json`) and Ireland
(`ie.json`). The schema is in [DATA.md](DATA.md); this file holds the procedure and the owner's rules for judging
the law. Where a rule here and a later instruction from the owner differ, the owner wins: update this file.

## 1. Procedure

1. **Skeleton.** Copy the level and mechanism structure from `bg.json` or `ie.json`. Set `match`, `addressKeys`
   (which OSM address field names each level: check a few Nominatim reverse results across the country), `mapZoom`
   if the map outline picks the wrong boundary, `hiddenLevels`, `hiddenIn`, and `areas` for regions whose law differs
   (capital city, special cities, a region with an elected mayor, places without a level, e.g. County Dublin has no
   municipal districts and its county level is the actual council: Fingal, DLR, South Dublin, Dublin City).
2. **Every level, every institution.** Fill all territorial levels (home → union) and all spheres (individual,
   business, non-economic). Every level gets the same mechanisms as Bulgaria and Ireland:
   * Direct: referendum (three kinds: citizen initiative, veto, mandatory) and general assembly.
   * Representative: council, executive, and where relevant the level's own members of the higher council
     (`upper_council_seat`).
   * Home: the household mechanism with the eight properties (home inviolable, family privacy, home property,
     parental rights, joint decisions, child rights, abuse protection, education choice).
   * Individual: personal autonomy. Business: Free enterprise and Freedom of contract (personal_autonomy with
     `label`), partners / shareholders / cooperative general meetings, Board / managers, Agents, Trustees.
     Non-economic: freedom of association, general assembly of members, board.
   * Building/entrance: the owners' meeting and its manager or directors, at whichever level the country's
     apartment law works (BG per entrance, IE per development).
   **An institution the law does not provide still appears**, as `exists: no` (black chip) with a Fix. Never leave
   it out.
3. **Fetch the law verbatim.** Every property gets `provisions` quoting the article(s) it rests on, word for word,
   from the official consolidated text (revised acts, not as-enacted, unless only the enacted text exists; note
   "as substituted by …" when quoting an amended provision). Use the official English translation if there is one,
   otherwise translate faithfully and keep article numbers. The cloud sandbox often cannot reach national law sites:
   have the owner's Mac fetch them. Never quote from memory; mark anything unverified and check it before it ships.
   When a rule comes from non-statutory text (e.g. Ireland's boundary committee terms of reference), quote it as
   such, and quote the actual figures for an example place too (its council size, areas and seats).
   Record article notes in `docs/research/<cc>-articles.md`.
4. **Status and explanation.** Set `yes` / `partial` / `weak` / `no` per the rules in section 2. The explanation is
   one or two plain sentences saying what the law does and why that meets or misses the requirement, with concrete
   numbers (seats, thresholds, days). No "Not met." prefixes.
5. **Fixes.** Every `no` and `partial` property gets at least one `fix`: proposed amendment text, drafted in the
   country's own legislative style, on the item it changes (`text` + `fix`), or a new article (`fix` without `text`,
   ref "Article 47A (new)"). Check new section numbers are free (Ireland's LGA already had ss.66A–66H), and that the
   fix does not clash with articles it leaves unchanged (add "Notwithstanding Article …" or amend them too). Each
   fix has a one-sentence `why`, naming the model it follows (Switzerland, Ireland, California, Bulgaria's draft).
   Use the same thresholds across countries unless the owner decides otherwise (section 3).
6. **Interests.** Add the country's own interest chips under `data/interests.json` `countries.<cc>` only if the
   owner gives them; otherwise the level defaults apply.
7. **Validate and test.** `node tools/validate.mjs` (schema and scores), then load the site (Playwright with
   Nominatim mocked in the sandbox; the in-app browser on the Mac for the real network) and click through levels,
   mechanisms, requirement pages and the Fix button. Check the map outline for each level at a few points, including
   the capital and a place where the city and its region share a name; add `mapZoom` or area overrides where it is
   wrong (Sofia, Zürich and County Dublin needed them).
8. **Independent review.** Before upload, a separate agent reviews the diff against the fetched law texts, the
   scoring rules and Bulgaria's and Ireland's treatment: wrong or outdated quotes, statuses that don't fit the law,
   unsound fixes, inconsistencies between countries. Apply its findings. Upload only when the owner says so in
   their own words, with `tools/deploy.sh` from the Mac, then check the site (`/api/editor` false, `/.env` 404).

## 2. Rules for judging (owner's decisions)

**Colours and scoring**
* Requirement: Met (yes) / Partly met (partial or weak) / Not met (no) / Does not apply.
* Mechanism: below 1 = Flawed; black if a gate is `no`. Level and branch take their best mechanism.
* Referendum gates: exists, binding, no quorum. A `weak` gate caps the mechanism at dark grey.
* Council and executive gates: exists, Powers (`binding_powers`); Individual accountability is a cap (no/weak →
  at most dark grey).
* Recall is optional (`optional: true`): counted only when met. It does not apply to bodies elected in districts of
  more than one seat (removed from councils and parliaments).

**Referendums**
* Mandatory referendums have no petition and their topics are set by law: they skip "Reasonable petition
  requirements" and "No topic restrictions" (catalog `skipProperties`).
* No quorum of any kind (turnout or approval): a majority of votes cast decides.
* Citizen initiative and veto: reasonable signatures, concrete proposals (a worded text voters approve as is), no
  topic restrictions, no roadblocks (fixed deadlines, no discretion to delay).
* Agenda initiatives (petitions that only ask parliament to consider something) are not decision-making mechanisms:
  keep them off the map.

**General assemblies**: binding, no attendance quorum, no population ceiling (Bulgaria's 10,000 limit is a flaw);
a `populationRule` applies a legal ceiling to the actual place.

**Representative bodies**
* The council is the local legislature. **Powers** is met when it sets the rules for the local interests of its
  area; it is partly met or not met where those rules are set nationally (schools, policing, transport, taxes…) or
  where it depends on central money. An appointed executive is judged on the Executive chip, not on council Powers.
* **Individual accountability**: voters choose between individual candidates (STV, open lists where preferences
  really decide, single-seat or two-round elections). Closed or first-on-list party lists = not met; large
  multi-member list districts make it worse.
* **Local representation**: districts on community boundaries, equal population per seat from the census, drawn by
  an independent commission. 3–7 seat districts under STV are fine (candidates focus on parts of the area). Very
  large list districts (Bulgaria's 19 seats) are not.
* **Proportional representation**: no legal threshold; seats in proportion to votes. A national threshold such as
  4%, and the minority rule it produces, is partly met.
* Executive/Mayor: a directly elected mayor, or an executive appointed by the elected council (Individual
  accountability then runs through the council, as in the American council-manager system). Partly met where the
  council can only accept or refuse a national body's candidate, or cannot dismiss by majority (Ireland). Not met
  where the state appoints the executive (Bulgaria's regional governor).

**Personal autonomy and "No outside interference"**: outsiders to the interest stepping into the decision (a censor
between author and publisher). Licences, state-set wages, prices or rents count. Rules that protect consent (fraud,
coercion) or affected third parties do not.

**Home**: compare with Bulgaria and Ireland, e.g. removal of a child without a court order must reach a judge
within days (Ireland: 3 days = met; Bulgaria: a month = partly met); poverty or housing alone are never grounds.

## 3. Drafting defaults for fixes

* National referendums: 50,000 signatures to propose, 100,000 to oblige, within six months; veto within 100 days of
  promulgation, the law not in force until then; simple majority, no quorum.
* Local referendums: 1/100 of electors to propose, 1/50 to oblige; veto 1/50 within two months; mandatory for large
  spending (over 5% of the budget), borrowing and sale of public property; votes in just the part of the area
  concerned.
* Councils for every neighbourhood, village and town, elected by STV, with their own budget in proportion to
  population; a directly elected mayor for each.
* Districting on the Irish model: population per seat from the census, 3–5 seat districts on community boundaries,
  an independent commission after each census.
* Recall of mayors: the California model (signature share by size of electorate, fixed deadlines, simple majority).
* Trustees chosen and removable by the beneficiaries (England's TLATA 1996 s.19 model).
* Councils' general competence over all matters of local interest not assigned elsewhere by law (European Charter
  of Local Self-Government, Art. 4).

## 4. Wording

* Chip names come from the catalog; a mechanism `label` overrides it when two mechanisms share a type.
* Breadcrumb names must not deviate from the chip name: the same words, or a slightly longer form that contains
  them ("Veto referendum" → "Veto referendums"). A country's own term (e.g. "Constitutional referendum") may go in
  an explanation, not in the breadcrumb.
* Requirement descriptions (tooltips) are normative: "Voters should …".
* Plain English, full sentences, concrete numbers, and cite the article in the provisions, not in the sentence.
