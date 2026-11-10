# Freedom Map

An interactive map that shows, for any location, how far the people there can govern their own shared interests, at every level from the individual to the supranational union.

> People are free if they have the mechanisms and means to make and carry out decisions about their individual or shared interests without outside interference. They decide either **directly** or through **representatives**.

Pick a place (search an address or click on the map) and you get a row of rectangles, one per level:

home · apartment building section · apartment building · neighbourhood (квартал) · village · town · city · municipality · county · state · country · union, plus individual · business · non-profit

Each button is white (full), light grey (good), dark grey (weak) or black (no ability to govern that level's interests); levels that don't apply to the place are hidden. Click to drill down:

1. **Level** → e.g. *Neighbourhood · Lozenets*
2. **Direct | Representative**
3. **Mechanisms** → e.g. referendum, general assembly, own council, own member of the municipal council
4. **Required properties** → e.g. legally binding, no participation quorum, reasonable signature requirements, vote for individual candidates, elected only by this community
5. **Relevant laws** → the laws that enable or prevent it, with links (specific articles come next)

The drill-down path is kept in the URL, so any view can be shared.

## Status: draft data

**Bulgaria**, **Ireland** and **Switzerland** (with canton and city data for Zürich) have draft assessments. For each property the page shows the relevant laws; the specific articles are the next step and are being worked out together. Article notes gathered so far are in [`docs/research/`](docs/research/) and are not shown on the page. The yes/partly/no assessments are provisional until the articles are confirmed. Other countries show "No data".

## Running it

There is no build step. Run the small Python server (standard library only), which serves the site and stores the shared interest chips in `data/state/interests.json`:

```sh
python3 server.py            # open http://localhost:8000
python3 server.py --host 0.0.0.0 --port 8000   # let others on your network use it
python3 server.py --edit     # the owner's copy: edit the site's own interest lists
```

With `--edit`, opened from the same computer, the interest chips change the site itself: **+ Add**, **×** and dragging a chip (or ← → on a focused chip) rewrite that country's list for the level in `data/interests.json`, which is committed and uploaded like any other file. Without it, and always on the public server, readers' additions and "not applicable" marks apply only to one place and stay in `data/state`.

Each requirement page has a chat button (top right) where readers comment, suggest edits or ask Claude about the requirement. It needs the `anthropic` package and an API key on the server; the key never reaches the browser:

```sh
python3 -m venv .venv && .venv/bin/pip install anthropic   # a venv avoids Homebrew's "externally managed" error
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env && chmod 600 .env   # key from console.anthropic.com
.venv/bin/python server.py
```

The server reads the key from `.env` at startup (git-ignored and never served), so it survives restarts. Every conversation is saved in `data/state/comments.json` for the editors, also when the chat is not set up. The rest of the site runs without the package.

Interest chips that anyone adds, or marks ✕ as not applicable, are shared with everyone using the same server. On a plain static host (for example GitHub Pages) the page still works, but added chips are kept only in that browser.

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
| `docs/HOSTING.md`, `tools/deploy.sh` | The public copy at free.kredor.com and the one-command upload |
| `tools/validate.mjs` | Checks all data files and prints a score table: `node tools/validate.mjs` |
