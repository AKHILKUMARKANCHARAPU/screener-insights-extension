# Screener Insights

A Chrome extension (Manifest V3) that overlays **interactive charts and deep financial analysis** onto company pages at [screener.in](https://www.screener.in). Everything runs **locally in your browser** — no data is collected, sent, or stored on any server.

> ⚠️ **Disclaimer:** This is an independent, unofficial tool and is **not affiliated with screener.in**. It is for **educational and informational purposes only** and is **not investment advice**. Always do your own research.

---

## ✨ Features

A slide-out panel adds analytical tabs to every screener.in company page:

- **Overview** — snapshot cards (market cap, P/B, ROE, ROCE, margins, growth) with drag-to-reorder and hide/unhide, plus a price + delivery-volume chart.
- **Efficiency** — sales growth (YoY + CAGR), DuPont ROE decomposition, working-capital ratios with insights, NFAT (asset turnover) with moat/margin insights, OPM/NPM trend, and a cumulative CFO/PAT/Capex/FCF summary.
- **Financial Health** — an investment checklist (sales growth, margins, interest coverage, D/E, current ratio, cash flow, earnings quality, SSGR, FCF) with an executive summary verdict.
- **Valuation** — current P/E vs 10-year history, PEG, Price-to-Sales, EV/EBITDA, and earnings yield vs G-Sec, with an overall undervalued / fair / overvalued read.
- **SSGR** — self-sustainable growth rate analysis.
- **P&L, Balance Sheet, Cash Flow** — chart-rich breakdowns of the financial statements.

Other niceties: drag-to-reorder and hide/unhide charts per tab, draggable tabs, customizable thresholds (saved locally), and a resizable panel.

---

## 📦 Installation (Load Unpacked)

This extension is not on the Chrome Web Store yet. To run it locally:

1. **Download** this repository (green **Code → Download ZIP**, then unzip) — or `git clone` it.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `screener-insights-extension` folder.
5. Visit any company page on [screener.in](https://www.screener.in) (e.g. a `/company/...` URL) — the insights panel will appear.

---

## 🛠️ Tech

- **Manifest V3** content script — no background server, no external API calls.
- [Chart.js](https://www.chartjs.org/) for all visualizations (bundled in `lib/`, MIT licensed).
- Data is parsed directly from the screener.in page DOM and its public chart endpoints.

---

## 🔒 Privacy

All processing happens **locally in your browser**. The extension does not collect, transmit, or sell any data. User preferences (chart order, thresholds) are stored only in your browser's `localStorage`.

---

## 🤝 Contributing

Issues and pull requests are welcome. Please keep the local-only, no-tracking design intact.

---

## 📄 License

[MIT](LICENSE) © Screener Insights contributors.

Bundled [Chart.js](https://www.chartjs.org/) is © Chart.js Contributors, used under the MIT License.
