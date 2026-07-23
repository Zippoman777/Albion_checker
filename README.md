# Albion Profit Forge

A crafting / refining / cooking / transport / focus profit calculator for **Albion Online
(Europe server)**, built as a dependency-free progressive web app.

Live price data comes from the community-run
[Albion Online Data Project](https://www.albion-online-data.com/) — no API key required.

## Running it

### Windows — just double-click `start.bat`

It checks everything and tells you exactly what is wrong if something is missing:

* verifies all 11 application files are present, and **names any that are missing**
* finds Python (via `py` or `python`) or falls back to Node.js
* if neither is installed, explains why a local server is needed, links both downloads,
  and offers to open the Python download page for you
* **checks GitHub for a newer version first** and offers to update (see below)
* picks a free port automatically if 8123 is taken
* waits until the server really answers, then opens your browser
* press any key in the launcher window to stop the server and clean up

## Auto-update

On every launch, `start.bat` checks the GitHub repository
[`Zippoman777/Albion_checker`](https://github.com/Zippoman777/Albion_checker) for a newer
version **before** opening the app. If one is found you get a popup:

> A new version is available. Installed: `abc1234`, Latest: `def5678`. Update now?

* **Yes** — your current files are backed up to `.backup\<timestamp>`, the new files are
  downloaded and installed, a "done" popup appears, and the app opens on the new version.
* **No / Later** — the check is remembered and the app opens on your current version; you will
  be asked again next launch.

**No Python and no Git are required for updating.** The updater (`update.ps1`) uses only
PowerShell — built into every Windows 7+ machine — and GitHub's public ZIP download. Python or
Node is still needed to *serve* the app, but not to update it. If a user has neither, they can
still receive updates; they just need a runtime to run the app afterwards.

How it decides there is an update: it compares the last-installed commit hash (stored locally in
`.app-version`) against the latest commit on the `main` branch via the GitHub API. If GitHub is
unreachable, rate-limited, or the repo is empty, the check is skipped silently and the app opens
normally — an update check can never stop you launching.

Nothing is ever deleted during an update: files are added or overwritten from the repo, but your
own extra files (settings, notes) are left in place, and the previous version is kept under
`.backup\`. To change which repo it tracks, edit the `-Repo`/`-Branch` defaults at the top of
`update.ps1`.

### Any platform — manually

The app must be served over HTTP (the API calls and the service worker will not work from
`file://` — double-clicking `index.html` will *not* work):

```bash
python -m http.server 8123
# then open http://localhost:8123
```

Any static host works — GitHub Pages, Netlify, S3. There is no build step.

## What it does

| Tab | Purpose |
|---|---|
| **Crafting** | Every equipment recipe: optimal material sourcing, station fees, resource return, quality procs, best sell city, profit / ROI / silver-per-focus |
| **Refining** | Ore→Bar, Logs→Planks, Hide→Leather, Fiber→Cloth, Stone→Blocks, plus a "is refining even worth it vs reselling the raws" column |
| **Cooking** | Food and potion recipes, with optional fish-sauce variants |
| **Transport** | Cross-city flip opportunities, split into bulk and specialized freight |
| **Focus** | Every focus sink ranked by silver-per-focus, plus watering and laborer journals |
| **Settings** | Premium, focus, mastery, tax rates, thresholds and market assumptions — all persisted to `localStorage` |

Click any table row to expand a full breakdown: per-material sourcing with the price age of each
quote, the complete fee ledger, the resource-return maths, the quality distribution, and a
city-by-city comparison of where to craft.

## The profit formula

```
profit = (sell price × quality multiplier − setup fee − sales fee)
       − (material cost + crafting station fee)
       + returned resource value
```

* **Materials** are priced at the cheapest city with a quote fresh enough to trust; the panel
  also shows what buying locally would have cost, so the sourcing saving is explicit.
* **Resource return rate** is `base × (1 + premium bonus) + mastery bonus`, where the base is
  picked from the focus × bonus-city matrix. All four matrix values are editable.
* **Quality** only applies to crafted equipment — refined resources and food do not roll quality.
* **Station fees** are modelled as silver-per-100-item-value, which is how the in-game station
  tax actually behaves, rather than a percentage of market price.

## Design notes worth knowing

**Outlier rejection.** Albion's market contains troll listings. During testing a single 50m sell
order on a ~5k Pork Pie produced a "999,461% margin" flip that dominated every ranking. Prices
above `outlierFactor` × the cross-city median are therefore rejected (default 5×, set to 0 to
disable). This is the difference between a calculator you can act on and one that just surfaces
the loudest bad data.

**Data freshness is first-class.** Albion prices are uploaded by players running a data client,
so thin markets go stale or missing. Every row carries the age of the oldest quote behind it,
colour-coded green → red, and a banner appears when the median quote in view is over two hours
old. Quotes older than `maxDataAgeMinutes` are ignored entirely.

**Caching.** Price responses are cached in IndexedDB (falling back to `localStorage`) with a
configurable TTL. Requests are batched into URL-length-safe chunks, serialised with a minimum
400 ms spacing, and retried with exponential backoff on HTTP 429/503. If a batch fails outright
the app falls back to the last good copy on disk and flags the result as partial.

**Cache busting.** Asset URLs carry a `?v=N` build stamp. When you change any file under `js/`
or `css/`, bump that stamp in **both** `index.html` and `BUILD` in `sw.js` — otherwise returning
users can boot a stale mix of old and new modules. (This bit me during development; the service
worker happily served a half-updated app.)

## Recipe accuracy — please read

* **Refining recipes are exact.** They follow the published tier progression
  (T4: 2 raw + 1 T3 refined, T5: 3 + 1, T6: 4 + 1, T7/T8: 5 + 1).
* **Cooking recipes use real item IDs** verified against the game dump — meals and potions exist
  only at specific tiers, and farm produce occupies one fixed tier each, which the code models.
  The *ingredient quantities*, however, are sensible defaults rather than verified game data.
* **Equipment recipes are per-slot templates** (helmet 8 units, armor 16, boots 8, one-handed
  weapons 16+8, two-handed 20+12, and so on). These are accurate in shape and give a realistic
  picture of the economy, but individual items may differ from live game data.

Anything you find to be wrong can be corrected without touching the code — the `recipeOverrides`
map in your saved settings takes an item ID and replaces its material list:

```js
// in the browser console
AO.Settings.data.recipeOverrides['T5_2H_CLAYMORE'] = [
  { id: 'T5_METALBAR', qty: 20 },
  { id: 'T5_LEATHER',  qty: 12 }
];
AO.Settings.save();
location.reload();
```

Likewise, the resource-return percentages and per-city station taxes are all exposed in Settings
because Sandbox Interactive rebalances them periodically.

## Files

```
index.html          markup + tab shell
css/styles.css      dark parchment-and-gold theme, responsive
js/config.js        cities, bonuses, quality curve, freshness thresholds
js/store.js         settings (localStorage) + price cache (IndexedDB)
js/recipes.js       recipe generation (refining / equipment / cooking)
js/api.js           batching, throttling, retry, caching
js/calc.js          all profit mathematics (pure functions)
js/ui.js            formatting + sortable/filterable table widget
js/app.js           controller: loading, tabs, rendering, settings panel
sw.js               service worker (offline shell + data fallback)
manifest.json       PWA manifest
start.bat           Windows launcher: update check, runtime detection, serve
update.ps1          self-updater (PowerShell only — no Python/Git needed)
.gitignore          keeps .app-version and .backup/ out of the repo
```

`js/calc.js` is pure — it takes a price index and a settings object and returns plain data —
so the calculations can be tested or reused without a DOM.
