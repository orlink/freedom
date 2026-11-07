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

## Status: sample data

Only **Bulgaria** and **Switzerland** (with extra canton and city data for Zürich) have assessments, and they are **sample data**, flagged as such in the UI. In the Bulgarian data, articles of the Direct Citizen Participation Act were checked against the Central Election Commission's English translation; every other citation is marked *unverified* in the UI. Other countries show "No data".

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
