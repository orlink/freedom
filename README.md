# Freedom Map

An interactive map that shows, for any location, how far the people there can govern their own shared interests, at every level from the individual to the supranational union.

> People are free if they have the mechanisms and means to make and carry out decisions about their individual or shared interests without outside interference. They decide either **directly** or through **representatives**.

Pick a place (search an address or click on the map) and you get a row of rectangles, one per level:

individual · market · cultural · building entrance · apartment building · neighbourhood (квартал) · village · town · city · municipality · county · state · country · union

Each rectangle is coloured from black (no ability to govern that level's interests) to green (full). Click to drill down:

1. **Level** → e.g. *Neighbourhood · Lozenets*
2. **Direct | Representative**
3. **Mechanisms** → e.g. referendum, general assembly, own council, own member of the municipal council
4. **Required properties** → e.g. legally binding, no participation quorum, reasonable signature requirements, vote for individual candidates, elected only by this community
5. **Law** → the specific articles that enable or prevent it, with links

The drill-down path is kept in the URL, so any view can be shared.

## Status: draft data

**Bulgaria**, **Ireland** and **Switzerland** (with canton and city data for Zürich) have assessments based on the texts of their laws. They are marked *draft* in the UI because no lawyer has reviewed them yet. Each citation is labelled *checked*, with a link to the text it was checked against, or *unverified*. Other countries show "No data".

Covered so far:

* **Bulgaria:** Constitution; Direct Citizen Participation Act; Local Self-Government and Local Administration Act; Condominium Management Act; Electoral Code (preference vote and seat allocation). Local tax powers are covered through the Constitution; the remaining public-law and tax acts are not yet.
* **Ireland:** Constitution; Local Government Reform Act 2014; Multi-Unit Developments Act 2011; Finance (Local Property Tax) Act 2012; Limerick directly elected mayor (2024).
* **Switzerland:** Federal Constitution; Civil Code (condominium ownership); Constitution of the Canton of Zürich; Municipal Code of the City of Zürich.

## Running it

It is a static site with no build step. Serve the folder over HTTP (the data is loaded with `fetch`, so opening `index.html` as a file will not work):

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

To publish, enable GitHub Pages for the repository (Settings → Pages → deploy from branch `main`, folder `/`).

Maps use [Leaflet](https://leafletjs.com/) (vendored in `vendor/leaflet`) with OpenStreetMap tiles, and addresses are looked up with [Nominatim](https://nominatim.org/). Both are free. Nominatim's [usage policy](https://operations.osmfoundation.org/policies/nominatim/) allows about one request per second, which is fine for a demo. For heavy traffic, switch to a hosted geocoder.

## Project layout

| Path | What |
| --- | --- |
| `index.html`, `css/`, `js/app.js` | The page, map and drill-down UI |
| `js/model.js` | Pure logic: matching an address to a jurisdiction, scoring, naming levels |
| `data/catalog.json` | Shared vocabulary: levels, mechanism types, property types |
| `data/index.json` | List of jurisdiction files and supranational unions |
| `data/jurisdictions/*.json` | One file per country, with optional overrides for regions and cities |
| `docs/DATA.md` | The data schema, scoring rules and how to add a country |
| `tools/validate.mjs` | Checks all data files and prints a score table: `node tools/validate.mjs` |
