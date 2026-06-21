# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Screener Insights** — a Chrome Manifest V3 extension that injects an analytical side-panel into company pages at `screener.in`. It scrapes the page's financial tables (and screener's public chart/schedule APIs), computes derived metrics, and renders interactive Chart.js visualizations and insight tables. Everything runs **locally in the browser**; no build step, no bundler, no external servers, no API keys.

## Build / run / test

- **No build, lint, or test tooling exists.** It's vanilla ES (no modules, no npm). Do not look for `package.json`, webpack, or a test runner — there are none.
- **Run it:** `chrome://extensions` → enable Developer mode → "Load unpacked" → select this folder. Then open any `screener.in/company/...` page.
- **Iterate on changes:** after editing `src/*.js` or `styles/panel.css`, click the **reload icon** on the extension card in `chrome://extensions`, then **reload the screener page**. The panel is built once at page load from scraped data, so a page refresh is required to re-run the scraper.
- **Debug:** logs are namespaced `[SI]` / `[ScreenerInsights]`. In DevTools Console, filter on `SI` and set log level to include **Verbose** (the code uses `console.debug`).
- `lib/chart.min.js` is Chart.js v4.4.4 (vendored). `download_chart.bat` re-downloads it.

## Load order & module namespace

`manifest.json` injects scripts into the page in this exact order (order matters — they depend on each other via a shared global):

```
lib/chart.min.js → src/scraper.js → src/charts.js → src/panel.js → src/content.js
```

Every module is an IIFE that attaches to a single global: `window.ScreenerInsights = { scraper, charts, panel }`. There is no import/export; cross-module calls go through that namespace (e.g. `ScreenerInsights.charts.make(...)`).

## Architecture (the big picture)

**Data flow:** `content.js` (entry) calls `ScreenerInsights.scraper.scrapeAll()` → passes the resulting `data` object to `ScreenerInsights.panel.buildPanel(data)`.

### `scraper.js` — data layer (`ScreenerInsights.scraper`)
- Parses screener's DOM tables (`#profit-loss`, `#balance-sheet`, `#cash-flow`, `#ratios`, `#quarters`, top-ratios, shareholding) into a uniform shape: `{ headers: [...years], data: { 'Row Label': [values aligned to headers] } }`.
- **Same-origin `fetch`** to screener's internal APIs (works because the content script runs on `screener.in`):
  - `/api/company/{id}/chart/?q=...&days=...` — price / PE / EPS / volume timeseries. Dataset labels matter (e.g. `'PE'`, `'EPS'`, `'Volume'`, `'Price'`); query metric names use `-` as separator and `+` within a name (`Price+to+Earning-Median+PE-EPS`).
  - `/api/company/{id}/schedules/?parent=...&section=...` — expands collapsible sub-rows (e.g. P&L "Expenses", BS "Other Assets"). `fetchAndMergeSchedules(table, section)` is generic and must be called per section that needs sub-rows.
- Computes everything downstream into a `derived` object (margins, CAGRs, ROE, SSGR framework, moat checks, `peRange`/`psRange`/`evRange` valuation bands, cumulative CFO/PAT, FCF, etc.).
- Returns one big `data` object: `{ companyName, nseSymbol, keyRatios, pnl, balanceSheet, cashFlow, ratios, quarters, shareholding, derived, peRange, ... }`. Most tables are `{headers, data}`; valuation bands and `derived` are plain objects.

### `charts.js` — Chart.js wrapper (`ScreenerInsights.charts`)
- Thin helpers: `make(id, config)` (creates/destroys a chart on a canvas), `bar(...)`, `line(...)`, `stackedBar(...)`, `destroyAll()`, plus a `C` color palette and a shared `BASE` options object.
- `make()` keeps a registry and auto-destroys the previous chart on the same canvas id — re-rendering a tab is safe.

### `panel.js` — the entire UI (~4600 lines, `ScreenerInsights.panel`)
This is where almost all work happens. Key structure:
- **`buildPanel(data)`** builds the panel shell, the tab rail, and resize/drag handlers. Tab content goes into `#si-body`.
- **`TABS` array + `CONTENT` map** — registers tabs. Each tab has a **builder function** (`tabOverview`, `tabReturns`, `tabValuation`, `tabScorecard`, `tabCF`, `tabCompare`, etc.) that **returns an HTML string**.
- **`switchTab(id)`** sets `#si-body.innerHTML = builder(appData)`, resets scroll, then `setTimeout(() => renderCharts(id, appData), 60)`.
- **`renderCharts(tab, d)`** runs *after* the HTML is in the DOM. It does two jobs per tab: (1) draw the Chart.js canvases declared in that tab's HTML, and (2) **wire all event listeners** (gear/settings popups, radio buttons, drag-to-reorder, compare buttons). Anything interactive is attached here, not in the builder string.

**The two-phase pattern is the most important convention:** builders produce static HTML (including empty `<canvas>` elements and placeholder `<div id="...">`); `renderCharts` then populates canvases and attaches behavior. When adding a chart or interactive control, declare the canvas/element in the builder and wire it in the matching `if (tab === '...')` block of `renderCharts`.

## Conventions & gotchas (learned the hard way)

- **`renderCharts(tab, d)` argument order is `(tab, d)`** — `tab` first. Several historical bugs came from calling `renderCharts(d, 'pnl')` (reversed), which silently matches no branch and renders nothing. Gear "Apply & Redraw" callbacks call `renderCharts('<tab>', d)`.
- **Gear "Reset"/layout rebuilds use `switchTab('<tab>')`**, not `renderCharts`, because the HTML order must be regenerated.
- **CSS `!important` overrides inline styles in tables.** `styles/panel.css` has `.si-table td { color: ... !important }`. To color a cell (e.g. red negatives) you must add a class with `!important` (`.si-neg`, `.si-pos-total`) — a plain inline `color:` won't win. Inline `!important` also works.
- **`findRowLocal(data, ...terms)` / `findRow(...)`** do fuzzy matching (exact label, then substring) and can double-match; pass specific labels and verify when summing components.
- **Row alignment:** a row's value array is parallel to that table's `headers`. To align across statements (P&L vs BS vs Cash Flow), map by the year-string header, not by index — the statements don't share a column range.
- **Graceful degradation:** tab builders should render whatever data is available rather than early-returning the whole tab. Missing series (SME/loss-making companies often lack the chart-API data for PE/PS/EV) should show "N/A"/an info note in *their* section only.
- **localStorage persistence** drives user preferences (no backend). Keys are prefixed `si_*` (e.g. `si_card_order`, `si_tab_order`, `si_<tab>_block_order` + `_hidden`, `si_compare_basket`, `si_peg_years`, threshold keys). When changing a persisted data shape, bump the key (e.g. `si_card_order` → `si_card_order_v2`) so stale data self-heals.
- **Tab content lives in `#si-body`** (not `#si-panel-content`). Drag/reorder code that queries the wrong container silently no-ops.
- **Chart-edge clipping** is handled in `charts.js` `BASE` via `clip:false`, `layout.padding`, and x-axis `offset:true`. Range-gauge value tips are kept inside the card by `tipAlignStyle(pct)` (edge-aware), not by margins alone.

## Compare feature (snapshot model)

The Compare tab does **not** fetch peers live. Visiting a company and clicking "Add" calls `buildCompareSnapshot(d)`, which stores a flat metric snapshot in `localStorage` (`si_compare_basket`). The Compare table then ranks the saved companies relatively (each metric normalized 0–100 between worst/best in the basket, oriented by `dir: 'high'|'low'|'none'`, with optional `cmp`/`allowNeg` per metric). Score = average of a company's normalized metrics. New metrics added to `CMP_METRICS` won't appear for already-saved companies until they're re-added.
