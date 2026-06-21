// panel.js — Overlay panel with full equity research framework
window.ScreenerInsights = window.ScreenerInsights || {};

ScreenerInsights.panel = (() => {

  let activeTab = 'overview';
  let isOpen    = false;
  let appData   = null;

  const MIN_WIDTH     = 360;
  const MAX_WIDTH     = () => Math.round(window.innerWidth * 0.88);
  const DEFAULT_WIDTH = 736;

  // Approximate 10Y G-Sec yield — update as needed
  const GSEC_YIELD = 6.8;

  function tail(arr, n = 10) { return (!arr || !arr.length) ? [] : arr.slice(-n); }
  function tailAll(n, ...arrs) { return arrs.map(a => tail(a || [], n)); }

  function fmt(val) {
    if (val == null || (typeof val === 'number' && isNaN(val))) return 'N/A';
    return String(val);
  }

  function findRow(data, ...terms) {
    if (!data) return null;
    for (const t of terms) { if (data[t] != null) return data[t]; }
    const tl = terms.map(t => t.toLowerCase());
    for (const [k, v] of Object.entries(data)) {
      if (tl.some(t => k.toLowerCase().includes(t))) return v;
    }
    return null;
  }

  // ── UI primitives ─────────────────────────────────────────────────────────

  function badge(status, label) {
    const map = { pass:'si-b-pass', caution:'si-b-caution', fail:'si-b-fail', info:'si-b-info' };
    const lbl = label || { pass:'✓ Pass', caution:'⚠ Caution', fail:'✗ Fail', info:'ℹ Info' }[status] || status;
    return `<span class="si-badge ${map[status] || 'si-b-info'}">${lbl}</span>`;
  }

  function card(label, value, sub = '', colorClass = '') {
    const id = 'card-' + label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return `<div class="si-card" draggable="true" data-card-id="${id}">
      <div class="si-card-label">${label}</div>
      <div class="si-card-value ${colorClass}">${fmt(value)}</div>
      ${sub ? `<div class="si-card-sub">${sub}</div>` : ''}
    </div>`;
  }

  function chartBlock(id, title, height = 220) {
    return `<div class="si-chart-wrap">
      <div class="si-chart-label">${title}</div>
      <div style="position:relative;height:${height}px"><canvas id="${id}"></canvas></div>
    </div>`;
  }

  function sectionHead(text) {
    return `<div class="si-section-head">${text}</div>`;
  }

  // Edge-aware positioning for a range-gauge value tip so it never overflows
  // the card: near the right end it anchors right (extends left), near the left
  // end it anchors left (extends right), otherwise stays centred on the dot.
  function tipAlignStyle(pct) {
    if (pct >= 80) return ';left:auto;right:0;transform:none';
    if (pct <= 20) return ';left:0;right:auto;transform:none';
    return '';
  }

  function callout(color, text) {
    return `<div class="si-callout si-callout-${color}">${text}</div>`;
  }

  function pct(v, dec = 1) { return v != null ? v.toFixed(dec) + '%' : 'N/A'; }
  function num(v, dec = 1) { return v != null ? v.toFixed(dec) : 'N/A'; }

  // Gross Profit Margin = (Sales − COGS) / Sales × 100, latest year.
  // COGS = raw materials + purchases of stock-in-trade + change in inventory.
  function latestGPM(pnl) {
    if (!pnl) return null;
    const sales = findRowLocal(pnl.data, 'Sales', 'Revenue', 'Net Sales', 'Total Revenue');
    if (!sales || !sales.length) return null;
    const idx = sales.length - 1;
    const s = sales[idx];
    if (s == null || s <= 0) return null;
    const cogsKeys = Object.keys(pnl.data).filter(k => {
      const l = k.toLowerCase();
      return l.includes('cost of material') || l.includes('raw material')
          || (l.includes('purchase') && l.includes('stock'))
          || l.includes('change in invent') || l.includes('changes in invent');
    });
    if (!cogsKeys.length) return null;
    let cogs = 0, any = false;
    cogsKeys.forEach(k => { const v = pnl.data[k][idx]; if (v != null && !isNaN(v)) { cogs += v; any = true; } });
    if (!any) return null;
    return parseFloat(((s - cogs) / s * 100).toFixed(1));
  }

  // ── Key ratio getter ──────────────────────────────────────────────────────

  function makeGetter(kr) {
    return function get(key) {
      const kl = key.toLowerCase();
      for (const [k, v] of Object.entries(kr)) { if (k.toLowerCase() === kl) return v; }
      for (const [k, v] of Object.entries(kr)) { if (k.toLowerCase().includes(kl)) return v; }
      return 'N/A';
    };
  }

  function parseHighLow(kr) {
    const get = makeGetter(kr);
    const raw = [get('high / low'), get('high/low')].find(v => v !== 'N/A' && v.includes('/')) || '';
    if (raw) {
      // Strip ₹ and extra spaces, then split on the separator "/"
      const parts = raw.replace(/₹/g, '').split('/').map(p => p.trim().replace(/[^0-9.,]/g, '').replace(/,/g, ''));
      if (parts.length >= 2 && parts[0] && parts[1]) {
        return { high: parts[0], low: parts[1] };
      }
    }
    // Fallback: screener.in may have separate "52W High" / "52W Low" keys
    const high = get('52w high') !== 'N/A' ? get('52w high') : get('high');
    const low  = get('52w low')  !== 'N/A' ? get('52w low')  : get('low');
    return { high, low };
  }

  // ── TAB BUILDERS ──────────────────────────────────────────────────────────

  function tabOverview(d) {
    const kr  = d.keyRatios;
    const get = makeGetter(kr);
    const hl  = parseHighLow(kr);
    const { revCAGR3, revCAGR5, profCAGR3, profCAGR5, earningsYield, pe } = d.derived;

    // YoY Revenue & Profit growth (latest vs prior year from P&L)
    const yoyRev = (() => {
      if (!d.pnl) return null;
      const row = findRowLocal(d.pnl.data, 'Sales', 'Revenue', 'Net Sales', 'Total Revenue', 'Revenue from Operations');
      if (!row || row.length < 2) return null;
      const cur = row[row.length - 1], prv = row[row.length - 2];
      if (cur == null || prv == null || prv === 0) return null;
      return parseFloat(((cur - prv) / Math.abs(prv) * 100).toFixed(1));
    })();
    const yoyProfit = (() => {
      if (!d.pnl) return null;
      const row = findRowLocal(d.pnl.data, 'Net Profit', 'PAT', 'Profit after tax');
      if (!row || row.length < 2) return null;
      const cur = row[row.length - 1], prv = row[row.length - 2];
      if (cur == null || prv == null || prv === 0) return null;
      return parseFloat(((cur - prv) / Math.abs(prv) * 100).toFixed(1));
    })();
    const sh  = d.shareholding;

    let pb = 'N/A';
    const price = parseFloat((get('current price') || '').replace(/[^0-9.]/g, ''));
    const bv    = parseFloat((get('book value')    || '').replace(/[^0-9.]/g, ''));
    if (price > 0 && bv > 0) pb = (price / bv).toFixed(2) + 'x';

    // EY verdict for quick display
    let eyColor = '';
    if (earningsYield != null) {
      eyColor = earningsYield > GSEC_YIELD + 2 ? 'si-green'
              : earningsYield > GSEC_YIELD - 1 ? 'si-orange'
              : 'si-red';
    }

    const cagrCard = (lbl, val) => card(
      lbl, val != null ? val + '%' : 'N/A', 'CAGR',
      val != null ? (val > 0 ? 'si-green' : 'si-red') : ''
    );

    // Promoter snapshot cards
    let promoterSection = '';
    if (sh && sh.data) {
      const shD = sh.data;

      // getLatest: returns last non-null value from matching row as "X.X%" string
      // Values >100 are share counts, not percentages — skip them
      const getLatest = (...terms) => {
        for (const t of terms) {
          for (const [k, v] of Object.entries(shD)) {
            if (!k.toLowerCase().includes(t.toLowerCase()) || !Array.isArray(v)) continue;
            const last = [...v].reverse().find(x => x != null && x <= 100);
            return last != null ? last.toFixed(1) + '%' : 'N/A';
          }
        }
        return 'N/A';
      };

      const promoterPct = getLatest('Promoters', 'Promoter');
      // Pledge: prefer the resolved __pledgePct__ key set by the scraper
      const pledgePct   = getLatest('__pledgePct__') !== 'N/A'
                            ? getLatest('__pledgePct__')
                            : getLatest('Pledged', 'Pledge');
      const fiiPct      = getLatest('FII', 'Foreign');
      const diiPct      = getLatest('DII', 'Domestic');
      const pubPctRaw   = getLatest('Public');
      const pubPct      = pubPctRaw !== 'N/A' ? pubPctRaw : 'N/A';
      // Others = residual after Promoters/FII/DII/Public (incl. Government, Bodies, etc.)
      const othersPct   = (() => {
        const n = [promoterPct, fiiPct, diiPct, pubPctRaw].map(p => parseFloat(p));
        if (n.some(isNaN)) return 'N/A';
        const o = 100 - n.reduce((a, b) => a + b, 0);
        return o > 0.05 ? o.toFixed(1) + '%' : '0.0%';
      })();

      // Pledge color: 0 = green, 1–10 = orange, >10 = red
      const pledgeNum = parseFloat(pledgePct);
      const pledgeColor = isNaN(pledgeNum) || pledgeNum === 0 ? 'si-green'
                        : pledgeNum > 10 ? 'si-red' : 'si-orange';

      const trendIcon = t => t === 'up' ? '▲' : t === 'down' ? '▼' : t === 'new' ? '★' : '→';
      const trendColor = t => t === 'up' ? '#34d399' : t === 'down' ? '#f87171' : t === 'new' ? '#f59e0b' : '#94a3b8';

      const topHoldersHtmlEx = (label, holders) => {
        if (!holders || !holders.length) return '';
        const rows = holders.map(h => {
          const icon  = trendIcon(h.trend);
          const color = trendColor(h.trend);
          const chg   = h.change != null && h.trend !== 'flat'
            ? `${h.change > 0 ? '+' : ''}${h.change}%` : '';
          return `
          <div class="si-th-row">
            <span class="si-th-name" title="${h.name}">${h.name.length > 30 ? h.name.slice(0, 28) + '…' : h.name}</span>
            <span class="si-th-right">
              ${chg ? `<span class="si-th-chg" style="color:${color}">${icon} ${chg}</span>` : `<span style="color:${color}">${icon}</span>`}
              <span class="si-th-pct">${h.pct.toFixed(2)}%</span>
            </span>
          </div>`;
        }).join('');
        return `<div class="si-th-block"><div class="si-th-label">${label}</div>${rows}</div>`;
      };

      const fiiBlock = topHoldersHtmlEx('Top FII Holders', d.topFII);
      const diiBlock = topHoldersHtmlEx('Top DII Holders', d.topDII);

      // Star investors block — each star gets its own card-style row
      const stars = d.starInvestors || [];
      const starBlock = stars.length ? `
        <div class="si-th-block si-star-block">
          <div class="si-th-label">⭐ Star Investors Detected</div>
          ${stars.map(h => {
            const icon  = trendIcon(h.trend);
            const color = trendColor(h.trend);
            const chg   = h.change != null ? `${h.change > 0 ? '+' : ''}${h.change}%` : '';
            const badge = h.classification === 'foreign_institutions' ? 'FII'
                        : h.classification === 'domestic_institutions' ? 'DII'
                        : h.classification === 'public' ? 'Public' : 'Others';
            return `
          <div class="si-star-row">
            <div class="si-star-top">
              <span class="si-star-name">${h.starLabel}</span>
              <span class="si-star-badge">${badge}</span>
            </div>
            <div class="si-star-bottom">
              <span class="si-star-stake">${h.pct.toFixed(2)}% stake</span>
              ${chg ? `<span class="si-star-chg" style="color:${color}">${icon} ${chg} vs prev qtr</span>` : `<span style="color:#64748b;font-size:9px">New entry</span>`}
            </div>
          </div>`;
          }).join('')}
        </div>` : '';

      promoterSection = `
        ${sectionHead('Shareholding Pattern')}
        <div class="si-sh-layout">
          <div class="si-sh-donut-wrap">
            <div class="si-sh-donut-title">Latest Quarter</div>
            <div style="position:relative;height:185px;width:185px;margin:0 auto">
              <canvas id="si-c-sh-donut"></canvas>
              <div class="si-sh-donut-center">
                <div class="si-sh-donut-prom">${promoterPct}</div>
                <div class="si-sh-donut-sub">Promoters</div>
              </div>
            </div>
            <div class="si-sh-legend">
              <span class="si-sh-dot" style="background:#6366f1"></span>Promoters ${promoterPct}
              <span class="si-sh-dot" style="background:#22d3ee;margin-left:8px"></span>FII ${fiiPct}
              <span class="si-sh-dot" style="background:#34d399;margin-left:8px"></span>DII ${diiPct}
              <span class="si-sh-dot" style="background:#f59e0b;margin-left:8px"></span>Public ${pubPct}
              <span class="si-sh-dot" style="background:#94a3b8;margin-left:8px"></span>Others ${othersPct}
            </div>
            <div class="si-sh-pledge" style="color:${pledgeColor === 'si-green' ? '#34d399' : pledgeColor === 'si-red' ? '#f87171' : '#f59e0b'}">
              Pledge: ${pledgePct}
            </div>
          </div>
          <div class="si-sh-holders">
            ${fiiBlock}${diiBlock}${starBlock}
            ${!fiiBlock && !diiBlock && !starBlock
              ? `<div class="si-th-block"><div class="si-th-label">Top Institutional Holders</div>
                   <div style="font-size:10px;color:#64748b;line-height:1.5;padding:2px 0">
                     Named FII / DII holder data isn't available for this company on screener
                     (common for SME / small-cap stocks). Aggregate FII ${fiiPct} · DII ${diiPct} shown in the donut.
                   </div></div>`
              : ''}
          </div>
        </div>
        ${chartBlock('si-c-promoter-trend', 'Promoter / FII / DII Holding % — Quarterly', 215)}
        `;
    }

    // Market cap category badge
    const capCat = d.capCategory;
    const capColors = { Large: '#6366f1', Mid: '#22d3ee', Small: '#34d399', Micro: '#f59e0b' };
    const capBadge = capCat
      ? `<span style="display:inline-block;margin-left:6px;padding:1px 7px;border-radius:99px;font-size:9px;font-weight:700;letter-spacing:.5px;background:${capColors[capCat]}22;color:${capColors[capCat]};border:1px solid ${capColors[capCat]}55">${capCat} Cap</span>`
      : '';

    return `
      ${sectionHead('Valuation')}
      <div class="si-grid" data-grid-id="ov-snapshot">
        <div class="si-card" draggable="true" data-card-id="card-market-cap">
          <div class="si-card-label">Market Cap ${capBadge}</div>
          <div class="si-card-value">${get('market cap')}</div>
        </div>
        ${card('P/B Ratio',  pb)}
        ${card('Book Value', get('book value'))}
      </div>
      ${(() => {
        const et = d.epsTrend;
        if (!et) return '';
        const cfg = {
          increasing: { icon: '▲', label: 'EPS Increasing',  color: '#34d399', bg: '#34d39918', border: '#34d39955', note: `EPS has been on a consistent upward trajectory (${et.detail}).` },
          flat:       { icon: '→', label: 'EPS Flat',        color: '#f59e0b', bg: '#f59e0b18', border: '#f59e0b55', note: `EPS has remained broadly stable (${et.detail}).` },
          decreasing: { icon: '▼', label: 'EPS Declining',   color: '#f87171', bg: '#f8717118', border: '#f8717155', note: `EPS has been in a declining trend (${et.detail}).` },
        }[et.trend];
        if (!cfg) return '';
        const curEps = et.last != null ? `Current EPS ₹${et.last.toFixed(1)}` : '';
        const chgPct = et.first && et.first !== 0
          ? ((et.last - et.first) / Math.abs(et.first) * 100).toFixed(1)
          : null;
        return `
        <div class="si-eps-trend-card" style="background:${cfg.bg};border:1px solid ${cfg.border};border-radius:10px;padding:10px 13px;margin:6px 0 4px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <span style="font-size:15px;color:${cfg.color}">${cfg.icon}</span>
            <span style="font-size:11px;font-weight:700;color:${cfg.color};letter-spacing:.4px">${cfg.label}</span>
            ${curEps ? `<span style="margin-left:auto;font-size:11px;color:#e2e8f0;font-weight:600">${curEps}</span>` : ''}
            ${chgPct != null ? `<span style="font-size:10px;color:${cfg.color};font-weight:600">${chgPct > 0 ? '+' : ''}${chgPct}%</span>` : ''}
          </div>
          <div style="font-size:10px;color:#94a3b8;line-height:1.4">${cfg.note}</div>
        </div>`;
      })()}
      ${sectionHead('Profitability & Returns')}
      <div class="si-grid" data-grid-id="ov-profitability">
        ${card('ROE',            get('roe'),            '', 'si-green')}
        ${card('ROCE',           get('roce'),           '', 'si-green')}
        ${card('Dividend Yield', get('dividend yield'))}
        ${card('SSGR',
            d.derived.ssgrFinal != null ? d.derived.ssgrFinal + '%' : 'N/A',
            'Self-sustain growth',
            d.derived.ssgrFinal > (d.derived.revCAGR5 || 0) ? 'si-green' : 'si-orange')}
        ${cagrCard('Revenue 3Y',  revCAGR3)}
        ${cagrCard('Revenue 5Y',  revCAGR5)}
        ${cagrCard('Profit 3Y',   profCAGR3)}
        ${cagrCard('Profit 5Y',   profCAGR5)}
        ${card('Revenue YoY',
            yoyRev != null ? (yoyRev > 0 ? '+' : '') + yoyRev + '%' : 'N/A',
            'vs prior year',
            yoyRev == null ? '' : yoyRev >= 15 ? 'si-green' : yoyRev >= 0 ? 'si-orange' : 'si-red')}
        ${card('Profit YoY',
            yoyProfit != null ? (yoyProfit > 0 ? '+' : '') + yoyProfit + '%' : 'N/A',
            'vs prior year',
            yoyProfit == null ? '' : yoyProfit >= 15 ? 'si-green' : yoyProfit >= 0 ? 'si-orange' : 'si-red')}
      </div>
      ${(() => {
        // Read directly from the live quarterly results DOM table — most reliable source.
        // Looks for the last column (latest quarter) across named rows.
        const qSection = document.querySelector('#quarters');
        const qTable   = qSection?.querySelector('table');
        if (!qTable) return '';

        // Build a map: row-label → array of cell text values (all columns)
        const rowMap = {};
        let colCount = 0;
        const ths = Array.from(qTable.querySelectorAll('thead th'));
        const headers = ths.slice(1).map(th => th.textContent.trim()).filter(Boolean);
        colCount = headers.length;

        qTable.querySelectorAll('tbody tr').forEach(tr => {
          const tds = Array.from(tr.querySelectorAll('td'));
          if (tds.length < 2) return;
          const lbl = tds[0].textContent.trim().replace(/[+\-↑↓]/g, '').replace(/\s+/g, ' ').trim();
          if (!lbl) return;
          rowMap[lbl] = tds.slice(1, colCount + 1).map(td => {
            const t = td.textContent.trim().replace(/[,%\s]/g, '');
            const n = parseFloat(t);
            return isNaN(n) ? null : n;
          });
        });

        console.debug('[SI] Quarterly DOM rows:', Object.keys(rowMap), '| headers:', headers);

        // Get last non-null value from a row
        const lastVal = (...keys) => {
          for (const k of keys) {
            for (const [rk, rv] of Object.entries(rowMap)) {
              if (rk.toLowerCase().includes(k.toLowerCase())) {
                const v = [...rv].reverse().find(x => x != null);
                if (v != null) return { val: v, label: headers[rv.lastIndexOf(v)] ?? headers[headers.length - 1] };
              }
            }
          }
          return null;
        };

        const latestHdr = headers[headers.length - 1] ?? 'Latest Quarter';

        // OPM %: use screener's own row (already = Operating Profit / Sales, excl other income/dep/interest/tax)
        const opmRow = (() => {
          for (const [k, v] of Object.entries(rowMap))
            if (k.toLowerCase().includes('opm')) return v;
          return null;
        })();
        const opm = opmRow ? opmRow[opmRow.length - 1] : null;

        // NPM = (Net Profit − Other Income) / Sales × 100 for latest quarter
        const getLast = (...keys) => {
          for (const k of keys)
            for (const [rk, rv] of Object.entries(rowMap))
              if (rk.toLowerCase().includes(k.toLowerCase())) return rv[rv.length - 1];
          return null;
        };
        const sales    = getLast('sales', 'revenue from operations', 'net sales');
        const netProf  = getLast('net profit', 'profit after tax', 'pat');
        const otherInc = getLast('other income');
        const npm = (netProf != null && sales != null && sales > 0)
          ? parseFloat(((netProf - (otherInc ?? 0)) / sales * 100).toFixed(1))
          : null;

        // ── TTM: sum last 4 quarters for each row ────────────────────────────
        const sumLast4 = (...keys) => {
          for (const k of keys)
            for (const [rk, rv] of Object.entries(rowMap))
              if (rk.toLowerCase().includes(k.toLowerCase())) {
                const last4 = rv.slice(-4).filter(v => v != null);
                return last4.length === 4 ? last4.reduce((a, b) => a + b, 0) : null;
              }
          return null;
        };

        const ttmSales    = sumLast4('sales', 'revenue from operations', 'net sales');
        const ttmOpProf   = sumLast4('operating profit');
        const ttmNetProf  = sumLast4('net profit', 'profit after tax', 'pat');
        const ttmOtherInc = sumLast4('other income');

        const ttmOpm = (ttmOpProf != null && ttmSales != null && ttmSales > 0)
          ? parseFloat((ttmOpProf / ttmSales * 100).toFixed(1)) : null;
        const ttmNpm = (ttmNetProf != null && ttmSales != null && ttmSales > 0)
          ? parseFloat(((ttmNetProf - (ttmOtherInc ?? 0)) / ttmSales * 100).toFixed(1)) : null;

        // If the latest ANNUAL (P&L) period is more recent than the latest
        // reported quarter, prefer the annual figure for the "current" cards.
        const periodVal = s => {
          const m = String(s).match(/([A-Za-z]{3})[a-z]*\s*'?(\d{2,4})/);
          if (!m) return 0;
          const mo = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 }[m[1].toLowerCase()] || 1;
          let y = +m[2]; if (y < 100) y += 2000;
          return y + mo / 12;
        };
        let curOpm = opm, curNpm = npm, curHdr = latestHdr;
        if (d.pnl) {
          const annOpmRow = findRowLocal(d.pnl.data, 'OPM %');
          const annOpm = annOpmRow ? annOpmRow[annOpmRow.length - 1] : null;
          const annNpm = d.derived?.npm ? d.derived.npm[d.derived.npm.length - 1] : null;
          const annHdr = d.pnl.headers ? d.pnl.headers[d.pnl.headers.length - 1] : null;
          if (annHdr && periodVal(annHdr) > periodVal(latestHdr) && (annOpm != null || annNpm != null)) {
            curOpm = annOpm; curNpm = annNpm; curHdr = annHdr;
          }
        }

        console.debug('[SI] OPM:', curOpm, '| NPM:', curNpm, '| TTM OPM:', ttmOpm, '| TTM NPM:', ttmNpm, '| period:', curHdr);
        if (curOpm == null && curNpm == null && ttmOpm == null && ttmNpm == null) return '';

        const mColor = v => v == null ? '#64748b' : v < 0 ? '#f87171' : v >= 20 ? '#34d399' : v >= 10 ? '#f59e0b' : '#f87171';
        const mCard = (lbl, v, sublbl, desc) => v == null ? '' : `
          <div class="si-card" style="border:1px solid ${mColor(v)}33">
            <div class="si-card-label">${lbl} <span style="font-size:9px;color:#475569">${sublbl}</span></div>
            <div class="si-card-value" style="color:${mColor(v)};font-size:18px">${v.toFixed(1)}%</div>
            <div class="si-card-sub" style="font-size:9px;color:#475569;line-height:1.3">${desc}</div>
          </div>`;

        const gpm = latestGPM(d.pnl);
        const gpmHdr = d.pnl?.headers?.length ? d.pnl.headers[d.pnl.headers.length - 1] : '';

        return `
        ${sectionHead('Operating & Net Margins')}
        <div class="si-grid" data-grid-id="ov-margins">
          ${mCard('GPM %', gpm,    gpmHdr,        'Gross profit (Sales − COGS) ÷ sales')}
          ${mCard('OPM %', curOpm, curHdr,        'Excl. other income, dep, interest & tax')}
          ${mCard('NPM %', curNpm, curHdr,        'Net profit excl. other income ÷ sales')}
          ${mCard('OPM %', ttmOpm, 'TTM (4 Qtrs)', 'Sum of last 4 qtrs — operating profit ÷ sales')}
          ${mCard('NPM %', ttmNpm, 'TTM (4 Qtrs)', 'Sum of last 4 qtrs — net profit excl. other income')}
        </div>`;
      })()}
      ${(() => {
        const high = parseFloat(String(hl.high).replace(/[^0-9.]/g, ''));
        const low  = parseFloat(String(hl.low).replace(/[^0-9.]/g, ''));
        if (!price || !high || !low || high <= low) return '';
        const pct     = Math.min(100, Math.max(0, (price - low) / (high - low) * 100));
        const fromLow = ((price - low) / low * 100).toFixed(1);
        const fromHigh= ((high - price) / high * 100).toFixed(1);
        // Gradient interpolation: red (near 52W low) → amber → green (near 52W high)
        const dotColor = (() => {
          const p = Math.min(100, Math.max(0, pct)) / 100;
          const stops = [[239,68,68],[245,158,11],[16,185,129]];
          const t = p * 2, i = Math.min(1, Math.floor(t)), f = t - i;
          const [r1,g1,b1] = stops[i], [r2,g2,b2] = stops[i+1];
          return `rgb(${Math.round(r1+(r2-r1)*f)},${Math.round(g1+(g2-g1)*f)},${Math.round(b1+(b2-b1)*f)})`;
        })();
        return `
        <div class="si-52w-card">
          <div class="si-52w-header">
            <span class="si-52w-title">52-WEEK RANGE</span>
          </div>
          <div class="si-52w-track">
            <div class="si-52w-fill" style="width:100%"></div>
            <div class="si-52w-thumb" style="left:calc(${pct}% - 7px)">
              <div class="si-52w-dot" style="background:${dotColor};box-shadow:0 0 6px ${dotColor}88"></div>
              <div class="si-52w-tip" style="color:${dotColor}${tipAlignStyle(pct)}">₹${price}</div>
            </div>
          </div>
          <div class="si-52w-ends">
            <div>
              <div class="si-52w-val si-red">₹${hl.low}</div>
              <div class="si-52w-lbl">52W Low</div>
            </div>
            <div style="text-align:center">
              <div class="si-52w-val" style="color:#64748b;font-size:10px">▲ ${fromLow}% from low &nbsp;|&nbsp; ▼ ${fromHigh}% from high</div>
            </div>
            <div style="text-align:right">
              <div class="si-52w-val si-green">₹${hl.high}</div>
              <div class="si-52w-lbl">52W High</div>
            </div>
          </div>
        </div>`;
      })()}
      ${(() => {
        const pe = d.peRange;
        if (!pe || !pe.high || !pe.low || pe.high <= pe.low) return '';
        const cur = pe.current;
        const pct = Math.min(100, Math.max(0, (cur - pe.low) / (pe.high - pe.low) * 100));
        const medPct = pe.median != null ? Math.min(100, Math.max(0, (pe.median - pe.low) / (pe.high - pe.low) * 100)) : null;
        // Gradient interpolation: green (low/cheap) → amber → red (high/expensive)
        const dotColor = (() => {
          const p = Math.min(100, Math.max(0, pct)) / 100;
          const stops = [[16,185,129],[245,158,11],[239,68,68]];
          const t = p * 2, i = Math.min(1, Math.floor(t)), f = t - i;
          const [r1,g1,b1] = stops[i], [r2,g2,b2] = stops[i+1];
          return `rgb(${Math.round(r1+(r2-r1)*f)},${Math.round(g1+(g2-g1)*f)},${Math.round(b1+(b2-b1)*f)})`;
        })();
        const fromLow  = ((cur - pe.low)  / pe.low  * 100).toFixed(1);
        const fromHigh = ((pe.high - cur) / pe.high * 100).toFixed(1);
        return `
        <div class="si-52w-card">
          <div class="si-52w-header">
            <span class="si-52w-title">P/E RATIO — 10 YEAR RANGE</span>
          </div>
          <div class="si-52w-track">
            <div class="si-pe-fill" style="width:100%"></div>
            ${medPct != null ? `<div class="si-52w-median" style="left:${medPct}%" title="Median PE ${pe.median}x"></div>` : ''}
            <div class="si-52w-thumb" style="left:calc(${pct}% - 7px)">
              <div class="si-52w-dot" style="background:${dotColor};box-shadow:0 0 6px ${dotColor}88"></div>
              <div class="si-52w-tip" style="color:${dotColor}${tipAlignStyle(pct)}">${cur}x</div>
            </div>
          </div>
          <div class="si-52w-ends">
            <div>
              <div class="si-52w-val si-green">${pe.low}x</div>
              <div class="si-52w-lbl">10Y Low PE</div>
            </div>
            <div style="text-align:center">
              ${pe.median != null ? `<div class="si-52w-val" style="color:#818cf8;font-size:10px">Median ${pe.median}x</div>` : ''}
              <div class="si-52w-val" style="color:#64748b;font-size:10px">▲ ${fromLow}% from low &nbsp;|&nbsp; ▼ ${fromHigh}% from high</div>
            </div>
            <div style="text-align:right">
              <div class="si-52w-val si-red">${pe.high}x</div>
              <div class="si-52w-lbl">10Y High PE</div>
            </div>
          </div>
        </div>`;
      })()}
      <div class="si-chart-block">
        <div class="si-chart-label">Price & Volume — 1 Year</div>
        <div class="si-vol-legend" id="si-vol-legend-pv">
          Volume bar colour = Delivery % that day &nbsp;·&nbsp;
          <span style="color:#34d399">■</span> ≥<span id="si-del-g-pv">40</span>% (conviction)&nbsp;
          <span style="color:#fbbf24">■</span> <span id="si-del-a-pv">20</span>–<span id="si-del-g-pv2">40</span>% (mixed)&nbsp;
          <span style="color:#f87171">■</span> &lt;<span id="si-del-r-pv">20</span>% (speculative)
        </div>
        <div style="height:160px"><canvas id="si-c-price-vol"></canvas></div>
        <div style="display:flex;align-items:center;gap:6px;margin-top:10px">
          <div class="si-chart-label" style="margin:0;flex:1">Delivery % — 1 Year</div>
          <button id="si-del-settings-btn" title="Adjust RAG thresholds"
            style="background:none;border:none;cursor:pointer;color:#64748b;font-size:14px;padding:2px 4px;line-height:1;border-radius:4px"
            onmouseover="this.style.color='#94a3b8'" onmouseout="this.style.color='#64748b'">⚙</button>
        </div>
        <!-- RAG settings popup -->
        <div id="si-del-settings-popup" style="display:none;background:#1e293b;border:1px solid #334155;border-radius:8px;padding:12px 14px;margin-bottom:8px;font-size:11px">
          <div style="color:#94a3b8;font-weight:600;margin-bottom:8px;letter-spacing:.4px">DELIVERY % RAG THRESHOLDS</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
            <div>
              <div style="color:#34d399;font-size:9px;font-weight:600;margin-bottom:3px">● GREEN (conviction) ≥</div>
              <div style="display:flex;align-items:center;gap:4px">
                <input id="si-del-green" type="number" min="1" max="99" step="1"
                  style="width:52px;background:#0f172a;border:1px solid #334155;border-radius:4px;color:#34d399;padding:3px 6px;font-size:11px;font-weight:700">
                <span style="color:#64748b">%</span>
              </div>
            </div>
            <div>
              <div style="color:#fbbf24;font-size:9px;font-weight:600;margin-bottom:3px">● AMBER (mixed) ≥</div>
              <div style="display:flex;align-items:center;gap:4px">
                <input id="si-del-amber" type="number" min="1" max="98" step="1"
                  style="width:52px;background:#0f172a;border:1px solid #334155;border-radius:4px;color:#fbbf24;padding:3px 6px;font-size:11px;font-weight:700">
                <span style="color:#64748b">%</span>
              </div>
            </div>
            <div>
              <div style="color:#f87171;font-size:9px;font-weight:600;margin-bottom:3px">● RED (speculative) &lt;</div>
              <div style="display:flex;align-items:center;gap:4px">
                <input id="si-del-red-lbl" type="number" disabled
                  style="width:52px;background:#0f172a;border:1px solid #1e293b;border-radius:4px;color:#64748b;padding:3px 6px;font-size:11px;font-weight:700">
                <span style="color:#64748b">%</span>
              </div>
            </div>
          </div>
          <div style="display:flex;gap:8px;margin-top:10px">
            <button id="si-del-save" style="flex:1;background:#3b82f6;border:none;border-radius:5px;color:#fff;padding:5px 0;font-size:11px;font-weight:600;cursor:pointer">Apply & Redraw</button>
            <button id="si-del-reset" style="background:#1e293b;border:1px solid #334155;border-radius:5px;color:#94a3b8;padding:5px 10px;font-size:11px;cursor:pointer">Reset</button>
          </div>
        </div>
        <div class="si-vol-legend" id="si-del-legend">
          <span style="color:#34d399">■</span> ≥<span id="si-del-g-lbl">40</span>% Green (conviction / accumulation)&nbsp;&nbsp;
          <span style="color:#fbbf24">■</span> <span id="si-del-a-lbl">20</span>–<span id="si-del-g-lbl2">40</span>% Amber (mixed / watch)&nbsp;&nbsp;
          <span style="color:#f87171">■</span> &lt;<span id="si-del-r-lbl">20</span>% Red (speculative / weak hands)
        </div>
        <div style="height:150px"><canvas id="si-c-delivery"></canvas></div>
        <div id="si-delivery-note" class="si-delivery-note"></div>
      </div>
      ${promoterSection}`;
  }

  function tabPnL(d) {
    const taxBlock = (() => {
      if (!d.pnl?.data || !d.pnl?.headers) return '';
      const taxRow = findRow(d.pnl.data, 'Tax %', 'Tax Rate', 'Effective Tax');
      const pbtRow = findRow(d.pnl.data, 'Profit before tax', 'PBT', 'Profit Before Tax');
      if (!taxRow) return '';
      const hdrs = d.pnl.headers;
      const n    = Math.min(hdrs.length, taxRow.length);
      const recent = [];
      for (let i = n - 1; i >= 0 && recent.length < 5; i--) {
        const t   = taxRow[i];
        const pbt = pbtRow?.[i] ?? null;
        if (t == null || isNaN(t)) continue;
        if (pbt != null && pbt <= 0) continue;
        if (t > 100 || t < -20) continue;
        recent.unshift({ year: hdrs[i], rate: t });
      }
      if (!recent.length) return '';
      const validRates = recent.map(r => r.rate).filter(r => r >= 0);
      const avg = validRates.length ? validRates.reduce((a, b) => a + b, 0) / validRates.length : null;
      if (avg == null) return '';

      let verdict, vColor, vNote;
      if (avg < 10) {
        verdict = 'Critically Low Tax — Red Flag';  vColor = '#f87171';
        vNote = `Average effective tax rate is ${avg.toFixed(1)}% — far below India's 25–30% corporate rate. Strong red flag: check for aggressive tax structuring, carried-forward losses, or accounting irregularities.`;
      } else if (avg < 15) {
        verdict = 'Abnormally Low Tax';  vColor = '#f87171';
        vNote = `Average effective tax rate of ${avg.toFixed(1)}% is well below the standard 25–30%. Could indicate deferred tax credits, MAT applicability, or major incentive schemes. Warrants scrutiny.`;
      } else if (avg < 22) {
        verdict = 'Below-Average Tax Rate';  vColor = '#f59e0b';
        vNote = `Average effective tax rate of ${avg.toFixed(1)}% is below the 25–30% norm. Likely benefiting from tax incentives (SEZ, R&D credits, depreciation benefits). Watch for sustainability when incentives expire.`;
      } else if (avg <= 36) {
        verdict = 'Normal Tax Rate';  vColor = '#34d399';
        vNote = `Average effective tax rate of ${avg.toFixed(1)}% is in line with India's corporate tax regime (25–30% base rate + surcharges). Indicates clean, legitimate tax compliance.`;
      } else {
        verdict = 'Above-Normal Tax Rate';  vColor = '#f59e0b';
        vNote = `Average effective tax rate of ${avg.toFixed(1)}% is above typical levels. Often caused by deferred tax provisions, disallowed expenses, or one-off adjustments. Cross-check PBT vs. taxable income.`;
      }

      const chips = recent.map(r => {
        const c = r.rate < 0 ? '#64748b' : r.rate < 15 ? '#f87171' : r.rate < 22 ? '#f59e0b' : r.rate <= 36 ? '#34d399' : '#f59e0b';
        return `<div style="text-align:center">
          <div style="font-size:9px;color:#475569;margin-bottom:2px">${r.year}</div>
          <div style="font-size:11px;font-weight:700;color:${c}">${r.rate.toFixed(0)}%</div>
        </div>`;
      }).join('');

      return `
      ${sectionHead('Tax Rate Analysis')}
      <div style="background:#0f172a;border:1px solid ${vColor}33;border-radius:10px;padding:10px 13px;margin:4px 0 12px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
          <span style="font-size:11px;font-weight:700;color:${vColor}">${verdict}</span>
          <span style="margin-left:auto;font-size:10px;color:#64748b">Avg ${avg.toFixed(1)}% (last ${validRates.length}Y excl. loss yrs)</span>
        </div>
        <div style="display:flex;gap:12px;justify-content:space-around;padding:6px 0;border-top:1px solid #1e293b;border-bottom:1px solid #1e293b;margin-bottom:8px">
          ${chips}
        </div>
        <div style="font-size:10px;color:#94a3b8;line-height:1.5">${vNote}</div>
      </div>`;
    })();

    return `
      ${chartBlock('si-c-rev-np',  'Revenue vs Net Profit (₹ Cr)', 240)}
      ${chartBlock('si-c-eps',     'EPS Trend — Quarterly (₹)', 195)}
      <div class="si-chart-wrap">
        <div style="display:flex;align-items:center;gap:6px">
          <div class="si-chart-label" style="margin:0;flex:1">Interest Coverage Ratio — Quarterly (Operating Profit ÷ Interest)</div>
          <button id="si-icr-settings-btn" title="Adjust ICR thresholds"
            style="background:none;border:none;cursor:pointer;color:#64748b;font-size:14px;padding:2px 4px;line-height:1;border-radius:4px"
            onmouseover="this.style.color='#94a3b8'" onmouseout="this.style.color='#64748b'">⚙</button>
        </div>
        <!-- ICR settings popup -->
        <div id="si-icr-settings-popup" style="display:none;background:#1e293b;border:1px solid #334155;border-radius:8px;padding:12px 14px;margin:6px 0 4px;font-size:11px">
          <div style="color:#94a3b8;font-weight:600;margin-bottom:8px;letter-spacing:.4px">ICR THRESHOLDS</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
            <div>
              <div style="color:#34d399;font-size:9px;font-weight:600;margin-bottom:3px">● SAFE (green) ≥</div>
              <div style="display:flex;align-items:center;gap:4px">
                <input id="si-icr-safe" type="number" min="0.1" max="50" step="0.5"
                  style="width:52px;background:#0f172a;border:1px solid #334155;border-radius:4px;color:#34d399;padding:3px 6px;font-size:11px;font-weight:700">
                <span style="color:#64748b">x</span>
              </div>
            </div>
            <div>
              <div style="color:#f59e0b;font-size:9px;font-weight:600;margin-bottom:3px">● CAUTION (amber) ≥</div>
              <div style="display:flex;align-items:center;gap:4px">
                <input id="si-icr-caution" type="number" min="0.1" max="49" step="0.5"
                  style="width:52px;background:#0f172a;border:1px solid #334155;border-radius:4px;color:#f59e0b;padding:3px 6px;font-size:11px;font-weight:700">
                <span style="color:#64748b">x</span>
              </div>
            </div>
            <div>
              <div style="color:#f87171;font-size:9px;font-weight:600;margin-bottom:3px">● DANGER (red) &lt;</div>
              <div style="display:flex;align-items:center;gap:4px">
                <input id="si-icr-danger-lbl" type="number" disabled
                  style="width:52px;background:#0f172a;border:1px solid #1e293b;border-radius:4px;color:#64748b;padding:3px 6px;font-size:11px;font-weight:700">
                <span style="color:#64748b">x</span>
              </div>
            </div>
          </div>
          <div style="display:flex;gap:8px;margin-top:10px">
            <button id="si-icr-save" style="flex:1;background:#3b82f6;border:none;border-radius:5px;color:#fff;padding:5px 0;font-size:11px;font-weight:600;cursor:pointer">Apply & Redraw</button>
            <button id="si-icr-reset" style="background:#1e293b;border:1px solid #334155;border-radius:5px;color:#94a3b8;padding:5px 10px;font-size:11px;cursor:pointer">Reset</button>
          </div>
        </div>
        <div style="position:relative;height:220px"><canvas id="si-c-icr"></canvas></div>
      </div>
      ${taxBlock}`;
  }

  function tabReturns() {
    return `
      <div id="si-sales-growth" class="si-chart-wrap"></div>
      <div id="si-cum-table-eff" class="si-chart-wrap"></div>
      <div class="si-chart-wrap">
        <div style="display:flex;align-items:center;gap:6px">
          <div class="si-chart-label" style="margin:0;flex:1">OPM % &amp; Net Margin %</div>
          <button id="si-opm-settings-btn" title="Adjust margin thresholds"
            style="background:none;border:none;cursor:pointer;color:#64748b;font-size:14px;padding:2px 4px;line-height:1;border-radius:4px"
            onmouseover="this.style.color='#94a3b8'" onmouseout="this.style.color='#64748b'">⚙</button>
        </div>
        <div id="si-opm-settings-popup" style="display:none;background:#1e293b;border:1px solid #334155;border-radius:8px;padding:12px 14px;margin:6px 0 4px;font-size:11px">
          <div style="color:#94a3b8;font-weight:600;margin-bottom:8px;letter-spacing:.4px">MARGIN REFERENCE LINES</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <div>
              <div style="color:#34d399;font-size:9px;font-weight:600;margin-bottom:3px">● GOOD OPM (green line) %</div>
              <div style="display:flex;align-items:center;gap:4px">
                <input id="si-opm-good" type="number" min="-100" max="100" step="1"
                  style="width:58px;background:#0f172a;border:1px solid #334155;border-radius:4px;color:#34d399;padding:3px 6px;font-size:11px;font-weight:700">
                <span style="color:#64748b">%</span>
              </div>
            </div>
            <div>
              <div style="color:#f87171;font-size:9px;font-weight:600;margin-bottom:3px">● BREAKEVEN (red line) %</div>
              <div style="display:flex;align-items:center;gap:4px">
                <input id="si-opm-zero" type="number" min="-100" max="100" step="1"
                  style="width:58px;background:#0f172a;border:1px solid #334155;border-radius:4px;color:#f87171;padding:3px 6px;font-size:11px;font-weight:700">
                <span style="color:#64748b">%</span>
              </div>
            </div>
          </div>
          <div style="display:flex;gap:8px;margin-top:10px">
            <button id="si-opm-save" style="flex:1;background:#3b82f6;border:none;border-radius:5px;color:#fff;padding:5px 0;font-size:11px;font-weight:600;cursor:pointer">Apply & Redraw</button>
            <button id="si-opm-reset" style="background:#1e293b;border:1px solid #334155;border-radius:5px;color:#94a3b8;padding:5px 10px;font-size:11px;cursor:pointer">Reset</button>
          </div>
        </div>
        <div style="position:relative;height:215px"><canvas id="si-c-margins"></canvas></div>
      </div>
      <div class="si-chart-wrap">
        <div class="si-chart-label">ROE &amp; ROCE (%)</div>
        <div style="position:relative;height:245px"><canvas id="si-c-roe-roce"></canvas></div>
        <div id="si-dupont"></div>
      </div>
      <div class="si-chart-wrap">
        <div class="si-chart-label">Working Capital Ratios — Debtor / Inventory / Payable Days</div>
        <div style="position:relative;height:245px"><canvas id="si-c-wc-ratios"></canvas></div>
        <div id="si-wc-insight"></div>
      </div>
      <div class="si-chart-wrap">
        <div class="si-chart-label">NFAT — Net Fixed Asset Turnover (Sales ÷ Avg Fixed Assets)</div>
        <div style="position:relative;height:205px"><canvas id="si-c-asset-turn"></canvas></div>
        <div id="si-nfat-insight"></div>
      </div>
      ${chartBlock('si-c-ccc',      'Cash Conversion Cycle (Days)', 205)}`;
  }

  function tabBS() {
    return `
      ${chartBlock('si-c-de-stack',        'Net Worth vs Borrowings (₹ Cr)', 245)}
      ${chartBlock('si-c-de-ratio',        'Debt / Equity Ratio', 205)}
      ${chartBlock('si-c-assets',          'Total Assets (₹ Cr)', 205)}
      ${chartBlock('si-c-cwip',            'CWIP Trend (₹ Cr)', 205)}
      ${chartBlock('si-c-other-assets',    'Other Assets Breakdown — Stacked (₹ Cr)', 265)}
      <div class="si-chart-wrap">
        <div style="display:flex;align-items:center;gap:6px">
          <div class="si-chart-label" style="margin:0;flex:1">Current Ratio (CA ÷ CL)</div>
          <button id="si-cr-settings-btn" title="Adjust Current Ratio threshold"
            style="background:none;border:none;cursor:pointer;color:#64748b;font-size:14px;padding:2px 4px;line-height:1;border-radius:4px"
            onmouseover="this.style.color='#94a3b8'" onmouseout="this.style.color='#64748b'">⚙</button>
        </div>
        <div id="si-cr-settings-popup" style="display:none;background:#1e293b;border:1px solid #334155;border-radius:8px;padding:12px 14px;margin:6px 0 4px;font-size:11px">
          <div style="color:#94a3b8;font-weight:600;margin-bottom:8px;letter-spacing:.4px">CURRENT RATIO THRESHOLD</div>
          <div style="color:#64748b;font-size:10px;margin-bottom:8px">CA = Inventories + Trade Receivables + Cash &amp; Equivalents<br>CL = Trade Payables</div>
          <div>
            <div style="color:#34d399;font-size:9px;font-weight:600;margin-bottom:3px">● MIN. SAFE ratio (green line) ≥</div>
            <div style="display:flex;align-items:center;gap:6px">
              <input id="si-cr-threshold" type="number" min="0.1" max="20" step="0.05"
                style="width:64px;background:#0f172a;border:1px solid #334155;border-radius:4px;color:#34d399;padding:3px 6px;font-size:11px;font-weight:700">
              <span style="color:#64748b">x</span>
            </div>
          </div>
          <div style="display:flex;gap:8px;margin-top:10px">
            <button id="si-cr-save" style="flex:1;background:#3b82f6;border:none;border-radius:5px;color:#fff;padding:5px 0;font-size:11px;font-weight:600;cursor:pointer">Apply &amp; Redraw</button>
            <button id="si-cr-reset" style="background:#1e293b;border:1px solid #334155;border-radius:5px;color:#94a3b8;padding:5px 10px;font-size:11px;cursor:pointer">Reset</button>
          </div>
        </div>
        <div style="position:relative;height:220px"><canvas id="si-c-curr-ratio"></canvas></div>
      </div>
`;
  }

  function tabCF() {
    return `
      <div id="si-cum-table" class="si-chart-wrap"></div>
      ${chartBlock('si-c-cf3',   'Cash Flows (₹ Cr)', 250)}
      ${chartBlock('si-c-capex',       'Capex Trend — (ΔNFA + ΔCWIP + Depreciation) (₹ Cr)', 215)}
      <div class="si-chart-wrap">
        <div class="si-chart-label">CFO vs Capex vs FCF &amp; Capex/CFO Ratio</div>
        <div style="position:relative">
          <div style="position:relative;height:170px;border-bottom:1px solid rgba(255,255,255,0.08)">
            <canvas id="si-c-cfo-capex-fcf-bars"></canvas>
          </div>
          <div style="position:relative;height:140px">
            <canvas id="si-c-cfo-capex-fcf-ratio"></canvas>
          </div>
        </div>
        <div id="si-capex-insight" style="margin-top:10px;padding:10px 12px;background:#0f172a;border-left:3px solid #6366f1;border-radius:0 6px 6px 0;font-size:11px;line-height:1.6;color:#94a3b8">
          <div style="color:#c4b5fd;font-weight:600;font-size:10px;letter-spacing:.5px;margin-bottom:5px">💡 CAPEX EFFICIENCY &amp; MARGIN OF SAFETY</div>
        </div>
      </div>
      ${chartBlock('si-c-fcf',          'Free Cash Flow (₹ Cr)', 215)}
      ${chartBlock('si-c-cfoop', 'CFO / Operating Profit %', 200)}
      <div class="si-chart-wrap">
        <div style="display:flex;align-items:center;gap:6px">
          <div class="si-chart-label" style="margin:0;flex:1">Annual CFO vs PAT &amp; CFO/PAT Ratio</div>
          <button id="si-cfopar-settings-btn" title="Adjust CFO/PAT threshold"
            style="background:none;border:none;cursor:pointer;color:#64748b;font-size:14px;padding:2px 4px;line-height:1;border-radius:4px"
            onmouseover="this.style.color='#94a3b8'" onmouseout="this.style.color='#64748b'">⚙</button>
        </div>
        <div id="si-cfopar-settings-popup" style="display:none;background:#1e293b;border:1px solid #334155;border-radius:8px;padding:12px 14px;margin:6px 0 4px;font-size:11px">
          <div style="color:#94a3b8;font-weight:600;margin-bottom:8px;letter-spacing:.4px">CFO / PAT RATIO THRESHOLD</div>
          <div style="color:#64748b;font-size:10px;margin-bottom:8px">CFO/PAT ≥ threshold → green bar (quality earnings). Below → red.</div>
          <div>
            <div style="color:#34d399;font-size:9px;font-weight:600;margin-bottom:3px">● MIN. THRESHOLD ≥</div>
            <div style="display:flex;align-items:center;gap:6px">
              <input id="si-cfopar-threshold" type="number" min="0.1" max="10" step="0.1"
                style="width:64px;background:#0f172a;border:1px solid #334155;border-radius:4px;color:#34d399;padding:3px 6px;font-size:11px;font-weight:700">
              <span style="color:#64748b">x</span>
            </div>
          </div>
          <div style="display:flex;gap:8px;margin-top:10px">
            <button id="si-cfopar-save" style="flex:1;background:#3b82f6;border:none;border-radius:5px;color:#fff;padding:5px 0;font-size:11px;font-weight:600;cursor:pointer">Apply &amp; Redraw</button>
            <button id="si-cfopar-reset" style="background:#1e293b;border:1px solid #334155;border-radius:5px;color:#94a3b8;padding:5px 10px;font-size:11px;cursor:pointer">Reset</button>
          </div>
        </div>
        <div style="position:relative">
          <!-- Top panel: CFO & PAT lines -->
          <div style="position:relative;height:170px;border-bottom:1px solid rgba(255,255,255,0.08)">
            <canvas id="si-c-cfopat-lines"></canvas>
          </div>
          <!-- Bottom panel: CFO/PAT ratio bars -->
          <div style="position:relative;height:120px">
            <canvas id="si-c-cfopat-bars"></canvas>
          </div>
        </div>
      </div>`;
  }

  function tabQuarters() {
    return `
      ${chartBlock('si-c-q-sales', 'Quarterly Revenue (₹ Cr)', 235)}
      ${chartBlock('si-c-q-np',    'Quarterly Net Profit (₹ Cr)', 220)}
      ${chartBlock('si-c-q-opm',   'Quarterly OPM % & NPM %',    205)}`;
  }

  // Layer 1 — Moat Check
  function tabMoat(d) {
    const checks  = d.derived.moatCheck || [];
    const pattern = d.derived.performancePattern || '—';

    // Render each check as a card instead of a table row to avoid HTML parsing issues
    const checkCards = checks.map(c => `
      <div class="si-moat-row">
        <div class="si-moat-num">${c.step}</div>
        <div class="si-moat-body">
          <div class="si-moat-title">${c.name} ${badge(c.status)}</div>
          <div class="si-moat-finding">${c.finding}</div>
        </div>
      </div>`).join('');

    const passCount   = checks.filter(c => c.status === 'pass').length;
    const failCount   = checks.filter(c => c.status === 'fail').length;
    const totalChecks = checks.length;
    const overallBadge = failCount >= 2                          ? badge('fail',    `✗ Weak Moat`)
                       : passCount >= 3                          ? badge('pass',    `✓ Strong Moat`)
                       : totalChecks === 0                       ? badge('info',    'No data')
                                                                 : badge('caution', `⚠ Moderate Moat`);

    return `
      ${sectionHead('Performance Pattern')}
      <div class="si-verdict-row">
        <span class="si-verdict-label">Detected Pattern:</span>
        <span class="si-pattern-chip">${pattern}</span>
      </div>

      ${sectionHead('5-Step Moat Check')}
      ${totalChecks === 0
        ? callout('info', 'No P&amp;L data found. Ensure you are on a company page with financial data loaded.')
        : checkCards}

      <div class="si-verdict-row" style="margin-top:8px">
        <span class="si-verdict-label">Overall Moat (${passCount}/${totalChecks} passed):</span>
        ${overallBadge}
      </div>

      ${sectionHead('OPM Trend (Pricing Power Proxy)')}
      ${chartBlock('si-c-moat-opm', 'OPM % Over Time', 210)}

      <div class="si-callout si-callout-info">
        <strong>Layer 1 — Qualitative check:</strong> Verify in annual reports, credit rating reports (CARE/CRISIL), and conference call transcripts: pricing power, competition intensity, OEM qualifications, raw-material pass-through ability.
      </div>`;
  }

  // Layer 2 — SSGR & FCF
  function tabSSGR(d) {
    const fw  = d.derived;
    const sc  = fw.ssgrScenario || {};
    const inp = fw.ssgrInputs   || {};

    // ssgrYears is the aligned year labels from scraper (parallel to nfatArr etc.)
    const years = fw.ssgrYears || [];
    const n     = years.length;

    const nfat    = fw.nfatArr    || [];
    const npm     = fw.npmArr     || [];
    const dpr     = fw.dprArr     || [];
    const depRate = fw.depRateArr || [];
    const ssgrY   = fw.ssgrArr    || [];
    const capex   = fw.capexArr   || [];
    const fcfArr  = fw.fcfArr     || [];
    const cfoOp   = fw.cfoOpArr   || [];

    // CFO raw series — aligned to pnl.headers (full, not sliced)
    const cfRaw  = d.cashFlow?.data;
    const ocfFull = cfRaw ? findRow(cfRaw, 'Cash from Operating Activity', 'Cash from Operations') : null;

    // For SSGR table: row per year (years array is already sliced from scraper)
    const ssgrRows = n > 0 ? years.map((yr, i) => `
      <tr>
        <td>${yr}</td>
        <td>${nfat[i] != null ? nfat[i].toFixed(2) + 'x' : '—'}</td>
        <td>${nfat[i] != null && npm[i] != null && dpr[i] != null
            ? (nfat[i] * npm[i] * (1 - dpr[i]) * 100).toFixed(1) + '%' : '—'}</td>
        <td>${dpr[i] != null ? (dpr[i] * 100).toFixed(1) + '%' : '—'}</td>
        <td>${depRate[i] != null ? (depRate[i] * 100).toFixed(1) + '%' : '—'}</td>
        <td><strong class="${ssgrY[i] > (fw.revCAGR5 || 0) ? 'si-green' : 'si-orange'}">${ssgrY[i] != null ? ssgrY[i] + '%' : '—'}</strong></td>
      </tr>`).join('')
    : `<tr><td colspan="6" class="si-td-empty">Fixed Assets / Net Block row not found in Balance Sheet.<br>Check DevTools console for available BS row labels.</td></tr>`;

    // For FCF table: use same years alignment
    const fcfRows = n > 0 ? years.map((yr, i) => {
      // Find CFO for this year: pnl headers start from index 0, ssgrYears starts from index 1
      // so year i in ssgrYears corresponds to pnl.headers[i+1] → ocfFull[i+1] (if pnl headers match)
      const pnlIdx = (d.pnl?.headers || []).indexOf(yr);
      const cfo    = pnlIdx >= 0 && ocfFull ? ocfFull[pnlIdx] : (ocfFull ? ocfFull[i + 1] : null);
      const fcf    = fcfArr[i];
      // Capex = CFO − FCF (derived from screener.in's own FCF row, so it matches their figures)
      const cap    = (cfo != null && fcf != null) ? cfo - fcf : capex[i];
      const cop    = cfoOp.length > 0 ? cfoOp[pnlIdx >= 0 ? pnlIdx : i + 1] : null;
      return `<tr>
        <td>${yr}</td>
        <td class="${(cfo||0) > 0 ? 'si-green' : 'si-red'}">${cfo != null ? cfo.toFixed(0) : '—'}</td>
        <td>${cap != null ? cap.toFixed(0) : '—'}</td>
        <td class="${(fcf||0) > 0 ? 'si-green' : 'si-red'}">${fcf != null ? fcf.toFixed(0) : '—'}</td>
        <td class="${cop > 70 ? 'si-green' : cop > 50 ? 'si-orange' : cop != null ? 'si-red' : ''}">${cop != null ? cop + '%' : '—'}</td>
      </tr>`;
    }).join('')
    : `<tr><td colspan="5" class="si-td-empty">FCF requires Fixed Assets data — not found.</td></tr>`;

    const colorClass = sc.color === 'pass' ? 'si-callout-green' : sc.color === 'fail' ? 'si-callout-red' : 'si-callout-amber';

    return `
      ${sectionHead('SSGR Inputs (3-Year Averages)')}
      <div class="si-table-wrap">
        <table class="si-table">
          <thead><tr><th>Year</th><th>NFAT</th><th>NFAT×NPM×(1−DPR)</th><th>DPR</th><th>Dep Rate</th><th>SSGR</th></tr></thead>
          <tbody>
            ${ssgrRows}
            <tr class="si-avg-row">
              <td><strong>3Y Avg</strong></td>
              <td><strong>${num(inp.avgNFAT,2)}x</strong></td>
              <td><strong>${inp.avgNFAT != null && inp.avgNPM != null && inp.avgDPR != null ? pct(inp.avgNFAT*inp.avgNPM*(1-inp.avgDPR)*100) : '—'}</strong></td>
              <td><strong>${inp.avgDPR != null ? pct(inp.avgDPR*100) : '—'}</strong></td>
              <td><strong>${inp.avgDepRate != null ? pct(inp.avgDepRate*100) : '—'}</strong></td>
              <td><strong class="${fw.ssgrFinal > (d.derived.revCAGR5||0) ? 'si-green':'si-red'}">${fw.ssgrFinal != null ? fw.ssgrFinal + '%' : '—'}</strong></td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="si-callout ${colorClass}">
        <strong>SSGR Verdict — ${sc.label}:</strong> ${sc.implication}
        ${fw.ssgrFinal != null && d.derived.revCAGR5 != null
          ? `<br>SSGR ${fw.ssgrFinal}% vs Revenue growth ${d.derived.revCAGR5}%.` : ''}
      </div>

      ${chartBlock('si-c-ssgr-trend', 'SSGR Trend (%)', 215)}`;
  }

  // ── PEG: which EPS-growth window to use (persisted) ──────────────────────
  const PEG_YEARS_KEY = 'si_peg_years';
  const PEG_OPTIONS = [1, 3, 5, 10];
  function getPegYears() {
    const v = parseInt(localStorage.getItem(PEG_YEARS_KEY), 10);
    return PEG_OPTIONS.includes(v) ? v : 5;
  }
  function savePegYears(v) { localStorage.setItem(PEG_YEARS_KEY, v); }

  // ── Valuation tab — current PE vs 10-year history ─────────────────────────
  function tabValuation(d) {
    // P/E history may be unavailable (loss-making / SME with no chart data),
    // but the rest of the tab (PEG, P/S, EV/EBITDA, Earnings Yield) can still
    // render — so we degrade gracefully instead of blanking the whole tab.
    const pe = d.peRange || {};
    const peAvailable = pe.current != null;
    const cur   = peAvailable ? pe.current : (d.derived?.pe ?? null);
    const yrs   = pe.years || 10;
    // Preferred reference = computed 10Y median of the PE series; fall back to screener median or mean
    const ref   = peAvailable ? (pe.med10 ?? pe.median ?? pe.mean) : null;
    const refLbl = pe.med10 != null ? 'median' : pe.median != null ? 'median' : 'average';
    const devPct = (ref != null && ref > 0 && cur != null) ? ((cur - ref) / ref * 100) : null;
    const rank   = pe.pctRank;   // % of the last-10Y period the PE traded AT or BELOW current

    // Verdict from deviation vs median + percentile rank
    const status = devPct == null ? 'info'
                 : devPct <= -20 ? 'pass'
                 : devPct <= 10  ? 'caution'
                 : 'fail';
    const headline = status === 'pass' ? 'Trading below its historical norm — relatively cheap'
                   : status === 'caution' ? 'Trading near its historical norm — fairly valued'
                   : status === 'fail' ? 'Trading above its historical norm — relatively expensive'
                   : 'Insufficient history to judge';

    const sign = devPct == null ? '' : devPct >= 0 ? '+' : '';
    const devColor = devPct == null ? '#64748b' : devPct <= -20 ? '#34d399' : devPct <= 10 ? '#fbbf24' : '#f87171';

    // Position of current PE within the 10Y low–high band (for a quick gauge)
    const pos = (peAvailable && pe.high > pe.low && cur != null) ? Math.min(100, Math.max(0, (cur - pe.low) / (pe.high - pe.low) * 100)) : null;

    // ── PEG ratio = P/E ÷ EPS growth rate (%) ────────────────────────────────
    // EPS-growth window is user-selectable (1Y / 3Y / 5Y / 10Y).
    const pegYears = getPegYears();
    let epsGrowth = null, epsWin = null, epsReason = null;
    const epsRow = d.pnl ? findRowLocal(d.pnl.data, 'EPS in Rs', 'EPS', 'Adjusted EPS in Rs') : null;
    if (!epsRow) {
      epsReason = 'EPS row not found';
    } else {
      const vals = epsRow.filter(v => v != null && !isNaN(v));
      if (vals.length < 2) {
        epsReason = 'not enough EPS history';
      } else {
        // Use the longest span available up to the selected window.
        // span = number of year-intervals (e.g. 10 annual points → 9-year span).
        const span = Math.min(pegYears, vals.length - 1);
        const s = vals[vals.length - 1 - span], e = vals[vals.length - 1];
        if (s > 0 && e > 0) {
          epsGrowth = (Math.pow(e / s, 1 / span) - 1) * 100;
          epsWin = span;
        } else {
          epsReason = 'EPS was zero/negative at the start of the window';
        }
      }
    }

    const peg = (epsGrowth != null && epsGrowth > 0) ? cur / epsGrowth : null;
    const pegStatus = peg == null ? 'info' : peg < 1 ? 'pass' : peg <= 1.5 ? 'caution' : 'fail';
    const pegColor  = peg == null ? '#64748b' : peg < 1 ? '#34d399' : peg <= 1.5 ? '#fbbf24' : '#f87171';
    const pegVerdict = peg == null ? (epsGrowth != null && epsGrowth <= 0 ? 'EPS not growing — PEG not meaningful' : `PEG unavailable — ${epsReason || 'EPS growth could not be computed'}`)
                     : peg < 1 ? 'PEG < 1 — undervalued relative to its earnings growth'
                     : peg <= 1.5 ? 'PEG ≈ 1 — fairly priced for its growth'
                     : 'PEG > 1 — expensive relative to its earnings growth';

    const statCard = (label, value, sub) => `
      <div class="si-card">
        <div class="si-card-label">${label}</div>
        <div class="si-card-value">${value}</div>
        ${sub ? `<div class="si-card-sub">${sub}</div>` : ''}
      </div>`;

    // ── Consolidated summary across all valuation metrics ────────────────────
    const psR = d.derived?.psRange;
    const evR = d.derived?.evRange;
    const eyV = d.derived?.earningsYield;

    const psStat = (!psR || psR.current == null) ? 'info' : psR.current < 1.5 ? 'pass' : psR.current <= 3 ? 'caution' : 'fail';
    const evStat = (!evR || evR.current == null) ? 'info'
                 : evR.median != null ? ((evR.current - evR.median) / evR.median * 100 <= -15 ? 'pass' : (evR.current - evR.median) / evR.median * 100 <= 10 ? 'caution' : 'fail')
                 : (evR.current < 10 ? 'pass' : evR.current <= 18 ? 'caution' : 'fail');
    const eyStat = eyV == null ? 'info' : eyV > GSEC_YIELD + 2 ? 'pass' : eyV > GSEC_YIELD - 1 ? 'caution' : 'fail';

    const vLabel = s => s === 'pass' ? 'Undervalued' : s === 'caution' ? 'Fairly valued' : s === 'fail' ? 'Overvalued' : '—';

    const summaryRows = [
      { m: 'P/E (vs 10Y median)', val: cur != null ? `${cur}x` : 'N/A', bench: ref != null ? `${ref}x median` : '—', s: cur == null ? 'info' : status },
      { m: 'PEG (P/E ÷ growth)',  val: peg != null ? peg.toFixed(2) : 'N/A', bench: '< 1 cheap',                   s: pegStatus },
      { m: 'P/S',                 val: psR?.current != null ? `${psR.current}x` : 'N/A', bench: psR?.median != null ? `${psR.median}x median` : '< 1.5 cheap', s: psStat },
      { m: 'EV / EBITDA',         val: evR?.current != null ? `${evR.current}x` : 'N/A', bench: evR?.median != null ? `${evR.median}x median` : '—', s: evStat },
      { m: 'Earnings Yield',      val: eyV != null ? `${eyV}%` : 'N/A',      bench: `G-Sec ${GSEC_YIELD}%`,         s: eyStat },
    ];

    const summaryTd = 'padding:10px 14px !important';
    const summaryTable = summaryRows.map(r => `
      <tr>
        <td style="${summaryTd}">${r.m}</td>
        <td style="${summaryTd};text-align:right;font-weight:600">${r.val}</td>
        <td style="${summaryTd};text-align:right;color:#64748b;font-size:11px">${r.bench}</td>
        <td style="${summaryTd};text-align:center">${badge(r.s, r.s === 'info' ? 'N/A' : vLabel(r.s))}</td>
      </tr>`).join('');

    // Overall verdict: score pass +1 / fail −1 across evaluated metrics
    const evalStats = summaryRows.map(r => r.s).filter(s => s !== 'info');
    const score = evalStats.reduce((a, s) => a + (s === 'pass' ? 1 : s === 'fail' ? -1 : 0), 0);
    const nUnder = evalStats.filter(s => s === 'pass').length;
    const nOver  = evalStats.filter(s => s === 'fail').length;
    const overall = evalStats.length === 0 ? { c: 'info', t: 'Insufficient data to value the stock' }
                  : score >= 2 ? { c: 'pass', t: 'Undervalued — trades cheap on most metrics' }
                  : score <= -2 ? { c: 'fail', t: 'Overvalued — rich on most metrics' }
                  : { c: 'caution', t: 'Fairly valued — mixed signals across metrics' };
    const overallBody = `Undervalued on <strong style="color:#34d399">${nUnder}</strong>, overvalued on <strong style="color:#f87171">${nOver}</strong> of ${evalStats.length} metrics. `
      + (overall.c === 'pass' ? 'The balance of evidence suggests the stock is attractively priced — verify the growth and earnings quality behind it.'
       : overall.c === 'fail' ? 'The balance of evidence suggests the market is pricing in significant optimism — limited margin of safety.'
       : 'Signals are mixed; valuation is broadly in line with the company’s own history and growth.');

    return `
      ${sectionHead('Valuation Summary')}
      <div class="si-verdict-final si-b-${overall.c}">
        <div class="si-verdict-label-final">Overall Verdict</div>
        <div class="si-verdict-text">${overall.t}</div>
      </div>
      <div class="si-table-wrap" style="margin-bottom:6px;max-height:none;overflow:visible">
        <table class="si-table" style="line-height:1.6">
          <thead><tr><th>Metric</th><th style="text-align:right">Current</th><th style="text-align:right">Benchmark</th><th style="text-align:center">Read</th></tr></thead>
          <tbody>${summaryTable}</tbody>
        </table>
      </div>
      ${callout(overall.c === 'pass' ? 'green' : overall.c === 'fail' ? 'red' : 'info', overallBody)}

      ${sectionHead(`P/E — Current vs Last ${yrs} Years`)}
      ${!peAvailable ? callout('info', `P/E history is unavailable for this company (loss-making or no chart data)${cur != null ? ` — current P/E is ${cur}x` : ''}. Other valuation metrics below are still shown where data permits.`) : ''}
      ${pos != null ? `
      <div class="si-52w-card" style="margin-top:10px">
        <div class="si-52w-header"><span class="si-52w-title">WHERE CURRENT P/E SITS IN ${yrs}Y RANGE</span></div>
        <div class="si-52w-track">
          <div class="si-pe-fill" style="width:100%"></div>
          ${ref != null && pe.high > pe.low ? `<div class="si-52w-median" style="left:${Math.min(100,Math.max(0,(ref-pe.low)/(pe.high-pe.low)*100))}%" title="${refLbl} ${ref}x"></div>` : ''}
          <div class="si-52w-thumb" style="left:calc(${pos}% - 7px)">
            <div class="si-52w-dot" style="background:${devColor};box-shadow:0 0 6px ${devColor}88"></div>
            <div class="si-52w-tip" style="color:${devColor}${tipAlignStyle(pos)}">${cur}x</div>
          </div>
        </div>
        <div class="si-52w-ends">
          <div><div class="si-52w-val si-green">${pe.low}x</div><div class="si-52w-lbl">${yrs}Y Low</div></div>
          <div style="text-align:center"><div class="si-52w-val" style="color:#818cf8;font-size:10px">${refLbl} ${ref}x</div></div>
          <div style="text-align:right"><div class="si-52w-val si-red">${pe.high}x</div><div class="si-52w-lbl">${yrs}Y High</div></div>
        </div>
      </div>` : ''}

      ${sectionHead('PEG Ratio — P/E vs Earnings Growth')}
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:2px 0 8px">
        <span style="font-size:10px;color:#64748b;letter-spacing:.4px">EPS GROWTH WINDOW:</span>
        ${PEG_OPTIONS.map(w => `
          <label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:${w === pegYears ? '#e2e8f0' : '#94a3b8'};cursor:pointer">
            <input type="radio" name="si-peg-years" value="${w}" ${w === pegYears ? 'checked' : ''} style="accent-color:#6366f1;cursor:pointer">
            ${w === 1 ? '1Y (YoY)' : w + 'Y'}
          </label>`).join('')}
      </div>
      <div class="si-grid">
        ${statCard('PEG Ratio', peg != null ? `<span style="color:${pegColor}">${peg.toFixed(2)}</span>` : 'N/A', `P/E ÷ EPS growth`)}
        ${statCard('Current P/E', cur != null ? `${cur}x` : 'N/A', 'numerator')}
        ${statCard(`EPS Growth${epsWin ? ` (${epsWin}Y)` : ''}`, epsGrowth != null ? `${epsGrowth.toFixed(1)}%` : 'N/A', epsGrowth != null ? 'CAGR — denominator' : (epsReason || 'CAGR — denominator'))}
      </div>

      ${(() => {
        const ps = d.derived?.psRange;
        if (!ps || ps.current == null) return '';
        const cur = ps.current, yrs = ps.years || 10;
        const ref = ps.median;
        const devPct = (ref != null && ref > 0) ? ((cur - ref) / ref * 100) : null;
        // O'Shaughnessy: < 1.5 undervalued, > 3 sell
        const psStatus = cur < 1.5 ? 'pass' : cur <= 3 ? 'caution' : 'fail';
        const psColor  = cur < 1.5 ? '#34d399' : cur <= 3 ? '#fbbf24' : '#f87171';
        const devColor = devPct == null ? '#64748b' : devPct <= 0 ? '#34d399' : '#f87171';
        const sign = devPct == null ? '' : devPct >= 0 ? '+' : '';
        const absVerdict = cur < 1.5 ? 'P/S < 1.5 — considered undervalued (O’Shaughnessy)'
                         : cur <= 3 ? 'P/S between 1.5 and 3 — fairly to richly valued'
                         : 'P/S > 3 — expensive; O’Shaughnessy’s sell zone';
        const hist = (ref != null)
          ? ` Versus its ${yrs}-year median P/S of <strong>${ref}x</strong>, it is currently <strong style="color:${devColor}">${Math.abs(devPct).toFixed(1)}% ${devPct >= 0 ? 'above' : 'below'}</strong>`
            + (ps.pctRank != null ? `, having traded at or below this level <strong>${ps.pctRank}%</strong> of the time` : '') + '.'
          : '';
        const pos = (ps.high != null && ps.low != null && ps.high > ps.low)
          ? Math.min(100, Math.max(0, (cur - ps.low) / (ps.high - ps.low) * 100)) : null;
        return `
          ${sectionHead(`Price-to-Sales — Current vs ${yrs}Y`)}
          ${pos != null ? `
          <div class="si-52w-card" style="margin-top:6px">
            <div class="si-52w-header"><span class="si-52w-title">WHERE CURRENT P/S SITS IN ${yrs}Y RANGE</span></div>
            <div class="si-52w-track">
              <div class="si-pe-fill" style="width:100%"></div>
              ${ref != null ? `<div class="si-52w-median" style="left:${Math.min(100,Math.max(0,(ref-ps.low)/(ps.high-ps.low)*100))}%" title="median ${ref}x"></div>` : ''}
              <div class="si-52w-thumb" style="left:calc(${pos}% - 7px)">
                <div class="si-52w-dot" style="background:${psColor};box-shadow:0 0 6px ${psColor}88"></div>
                <div class="si-52w-tip" style="color:${psColor}${tipAlignStyle(pos)}">${cur}x</div>
              </div>
            </div>
            <div class="si-52w-ends">
              <div><div class="si-52w-val si-green">${ps.low}x</div><div class="si-52w-lbl">${yrs}Y Low</div></div>
              <div style="text-align:center"><div class="si-52w-val" style="color:#818cf8;font-size:10px">median ${ref}x</div></div>
              <div style="text-align:right"><div class="si-52w-val si-red">${ps.high}x</div><div class="si-52w-lbl">${yrs}Y High</div></div>
            </div>
          </div>` : ''}`;
      })()}

      ${(() => {
        const ev = d.derived?.evRange;
        if (!ev || ev.current == null) return '';
        const cur = ev.current, yrs = ev.years || 10;
        const ref = ev.median;
        const devPct = (ref != null && ref > 0) ? ((cur - ref) / ref * 100) : null;
        // Heuristic absolute view: <10x cheap, 10–18x fair, >18x rich
        const evStatus = devPct != null
          ? (devPct <= -15 ? 'pass' : devPct <= 10 ? 'caution' : 'fail')
          : (cur < 10 ? 'pass' : cur <= 18 ? 'caution' : 'fail');
        const evColor  = evStatus === 'pass' ? '#34d399' : evStatus === 'caution' ? '#fbbf24' : '#f87171';
        const devColor = devPct == null ? '#64748b' : devPct <= 0 ? '#34d399' : '#f87171';
        const sign = devPct == null ? '' : devPct >= 0 ? '+' : '';
        const pos = (ev.high != null && ev.low != null && ev.high > ev.low)
          ? Math.min(100, Math.max(0, (cur - ev.low) / (ev.high - ev.low) * 100)) : null;
        const hist = ref != null
          ? ` Versus its ${yrs}-year median of <strong>${ref}x</strong>, it is currently <strong style="color:${devColor}">${Math.abs(devPct).toFixed(1)}% ${devPct >= 0 ? 'above' : 'below'}</strong>`
            + (ev.pctRank != null ? `, having traded at or below this level <strong>${ev.pctRank}%</strong> of the time` : '') + '.'
          : '';
        return `
          ${sectionHead(`EV / EBITDA — Current vs ${yrs}Y`)}
          ${pos != null ? `
          <div class="si-52w-card" style="margin-top:6px">
            <div class="si-52w-header"><span class="si-52w-title">WHERE CURRENT EV/EBITDA SITS IN ${yrs}Y RANGE</span></div>
            <div class="si-52w-track">
              <div class="si-pe-fill" style="width:100%"></div>
              ${ref != null ? `<div class="si-52w-median" style="left:${Math.min(100,Math.max(0,(ref-ev.low)/(ev.high-ev.low)*100))}%" title="median ${ref}x"></div>` : ''}
              <div class="si-52w-thumb" style="left:calc(${pos}% - 7px)">
                <div class="si-52w-dot" style="background:${evColor};box-shadow:0 0 6px ${evColor}88"></div>
                <div class="si-52w-tip" style="color:${evColor}${tipAlignStyle(pos)}">${cur}x</div>
              </div>
            </div>
            <div class="si-52w-ends">
              <div><div class="si-52w-val si-green">${ev.low}x</div><div class="si-52w-lbl">${yrs}Y Low</div></div>
              <div style="text-align:center"><div class="si-52w-val" style="color:#818cf8;font-size:10px">median ${ref}x</div></div>
              <div style="text-align:right"><div class="si-52w-val si-red">${ev.high}x</div><div class="si-52w-lbl">${yrs}Y High</div></div>
            </div>
          </div>` : ''}`;
      })()}

      ${(() => {
        const ey = d.derived?.earningsYield;
        const spread = ey != null ? ey - GSEC_YIELD : null;
        const eyStatus = ey == null ? 'info'
                       : ey > GSEC_YIELD + 2 ? 'pass'
                       : ey > GSEC_YIELD - 1 ? 'caution' : 'fail';
        const eyColor  = eyStatus === 'pass' ? '#34d399' : eyStatus === 'caution' ? '#fbbf24' : eyStatus === 'fail' ? '#f87171' : '#64748b';
        const spreadColor = spread == null ? '#64748b' : spread >= 0 ? '#34d399' : '#f87171';
        const eyVerdict = ey == null ? 'Earnings yield unavailable (loss-making or no P/E).'
                        : eyStatus === 'pass' ? `EY of ${ey}% comfortably exceeds the ${GSEC_YIELD}% risk-free G-Sec yield — the earnings return offers a margin of safety over bonds.`
                        : eyStatus === 'caution' ? `EY of ${ey}% is roughly in line with the ${GSEC_YIELD}% G-Sec yield — fully priced; little premium over risk-free bonds.`
                        : `EY of ${ey}% is below the ${GSEC_YIELD}% G-Sec yield — the stock offers no earnings-yield margin of safety versus risk-free bonds.`;
        return `
          ${sectionHead('Earnings Yield vs G-Sec')}
          <div class="si-grid">
            ${statCard('Earnings Yield', ey != null ? `<span style="color:${eyColor}">${ey}%</span>` : 'N/A', '= 1 ÷ P/E')}
            ${statCard('10Y G-Sec Yield', `${GSEC_YIELD}%`, 'risk-free benchmark')}
            ${statCard('EY Spread', spread != null ? `<span style="color:${spreadColor}">${spread >= 0 ? '+' : ''}${spread.toFixed(2)}%</span>` : 'N/A', 'EY − G-Sec')}
          </div>`;
      })()}`;
  }

  // ── Compare feature: snapshot basket + side-by-side table ─────────────────
  const COMPARE_KEY = 'si_compare_basket';
  function getBasket() { try { return JSON.parse(localStorage.getItem(COMPARE_KEY) || '[]'); } catch (_) { return []; } }
  function saveBasket(a) { localStorage.setItem(COMPARE_KEY, JSON.stringify(a)); }
  function addToBasket(snap) { const a = getBasket().filter(x => x.id !== snap.id); a.push(snap); saveBasket(a); }
  function removeFromBasket(id) { saveBasket(getBasket().filter(x => x.id !== id)); }

  // Metrics compared, grouped, with "best" direction (high/low/none).
  // `allowNeg` lets a 'low' metric rank negative values as best (e.g. CCC).
  const CMP_GROUPS = ['Valuation metrics', 'Return ratios', 'Profitability metrics', 'Cashflow metrics', 'Liquidity metrics', 'Solvency metrics', 'Efficiency metrics'];
  const pctF = v => v == null ? '—' : v + '%';
  const xF   = v => v == null ? '—' : v + 'x';
  const inr  = v => v == null ? '—' : Math.round(v).toLocaleString('en-IN');
  const CMP_METRICS = [
    // ── Valuation ──
    { g: 'Valuation metrics', k: 'price', label: 'Current Price (₹)', dir: 'none', fmt: v => v == null ? '—' : '₹' + v.toLocaleString('en-IN') },
    { g: 'Valuation metrics', k: 'hl52',  label: '52W High / Low (₹)', dir: 'none', fmt: v => v == null ? '—' : `₹${inr(v.hi)} / ${inr(v.lo)}` },
    { g: 'Valuation metrics', k: 'mcap', label: 'Market Cap (₹ Cr)', dir: 'none', fmt: inr },
    { g: 'Valuation metrics', k: 'pe',   label: 'P/E',               dir: 'low',  fmt: xF },
    { g: 'Valuation metrics', k: 'ps',   label: 'P/S',               dir: 'low',  fmt: xF },
    { g: 'Valuation metrics', k: 'ev',   label: 'EV / EBITDA',       dir: 'low',  fmt: xF },
    { g: 'Valuation metrics', k: 'peg',  label: 'PEG (YoY)',         dir: 'low',  fmt: v => v == null ? '—' : v.toFixed(2) },
    // ── Return ratios ──
    { g: 'Return ratios', k: 'roe',  label: 'ROE %',  dir: 'high', fmt: pctF },
    { g: 'Return ratios', k: 'roce', label: 'ROCE %', dir: 'high', fmt: pctF },
    { g: 'Return ratios', k: 'ssgr', label: 'SSGR %', dir: 'high', fmt: pctF },
    // ── Profitability ──
    { g: 'Profitability metrics', k: 'gpm',     label: 'GPM %',            dir: 'high', fmt: pctF },
    { g: 'Profitability metrics', k: 'opm',     label: 'OPM %',            dir: 'high', fmt: pctF },
    { g: 'Profitability metrics', k: 'npm',     label: 'NPM %',            dir: 'high', fmt: pctF },
    { g: 'Profitability metrics', k: 'revC',    label: 'Sales CAGR 5Y %',  dir: 'high', fmt: pctF },
    { g: 'Profitability metrics', k: 'profC',   label: 'Profit CAGR 5Y %', dir: 'high', fmt: pctF },
    { g: 'Profitability metrics', k: 'salesYoY',label: 'Sales YoY %',      dir: 'high', fmt: v => v == null ? '—' : (v >= 0 ? '+' : '') + v + '%' },
    { g: 'Profitability metrics', k: 'patYoY',  label: 'PAT YoY %',        dir: 'high', fmt: v => v == null ? '—' : (v >= 0 ? '+' : '') + v + '%' },
    // ── Cashflow ──
    { g: 'Cashflow metrics', k: 'cfoPat',  label: 'Cum. CFO / PAT',     dir: 'high', fmt: xF },
    { g: 'Cashflow metrics', k: 'fcf',     label: 'Positive FCF Years', dir: 'high', fmt: v => v == null ? '—' : `${v.pos}/${v.total}`, cmp: v => v == null ? null : v.pos / v.total },
    { g: 'Cashflow metrics', k: 'cfoCover',label: 'CFO covers CFI+CFF', dir: 'high', fmt: v => v == null ? '—' : (v ? '✓ Yes' : '✗ No'), cmp: v => v == null ? null : (v ? 1 : 0) },
    // ── Liquidity ──
    { g: 'Liquidity metrics', k: 'cr',        label: 'Current Ratio',          dir: 'high', fmt: xF },
    { g: 'Liquidity metrics', k: 'cashSales', label: 'Cash & Equiv. / Sales %', dir: 'high', fmt: pctF },
    // ── Solvency ──
    { g: 'Solvency metrics', k: 'de',           label: 'Debt / Equity',      dir: 'low',  fmt: xF },
    { g: 'Solvency metrics', k: 'icr',          label: 'Interest Coverage',  dir: 'high', fmt: xF },
    { g: 'Solvency metrics', k: 'reserves',     label: 'Reserves (₹ Cr)',    dir: 'none', fmt: inr },
    { g: 'Solvency metrics', k: 'promoterHold', label: 'Promoter Holding %', dir: 'high', fmt: pctF },
    { g: 'Solvency metrics', k: 'pledge',       label: 'Promoter Pledge %',  dir: 'low',  fmt: pctF },
    // ── Efficiency ──
    { g: 'Efficiency metrics', k: 'invDays',    label: 'Inventory Days',         dir: 'low',  fmt: v => v == null ? '—' : Math.round(v) },
    { g: 'Efficiency metrics', k: 'debtorDays', label: 'Debtor Days',            dir: 'low',  fmt: v => v == null ? '—' : Math.round(v) },
    { g: 'Efficiency metrics', k: 'ccc',        label: 'Cash Conversion Cycle',  dir: 'low',  allowNeg: true, fmt: v => v == null ? '—' : Math.round(v) },
    { g: 'Efficiency metrics', k: 'nfat',       label: 'Asset Turnover (NFAT)',  dir: 'high', fmt: xF },
  ];

  // Build a snapshot of the current company's key metrics for comparison
  function buildCompareSnapshot(d) {
    const get = makeGetter(d.keyRatios);
    const num = s => { const v = parseFloat(String(s).replace(/[^0-9.\-]/g, '')); return isNaN(v) ? null : v; };
    const lastOf = arr => { if (!arr) return null; for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i]; return null; };
    const pnlLast = (...keys) => d.pnl ? lastOf(findRowLocal(d.pnl.data, ...keys)) : null;

    // Current ratio
    let cr = null;
    if (d.balanceSheet) {
      const bget = (...k) => lastOf(findRowLocal(d.balanceSheet.data, ...k));
      const inv  = bget('Inventories', 'Inventory', 'Stocks');
      const recv = bget('Trade receivables', 'Trade Receivables', 'Sundry Debtors', 'Debtors');
      const cash = bget('Cash Equivalents', 'Cash and Bank Balances', 'Cash & Bank', 'Cash and Cash Equivalents', 'Cash & Equivalents', 'Cash');
      const pay  = bget('Trade Payables', 'Trade payables', 'Sundry Creditors', 'Creditors');
      const ca = (inv || 0) + (recv || 0) + (cash || 0);
      if (pay && pay > 0) cr = parseFloat((ca / pay).toFixed(2));
    }
    // Interest coverage
    const op = pnlLast('Operating Profit', 'EBITDA'), interest = pnlLast('Interest', 'Finance Costs', 'Interest Expense');
    let icr = (op != null && interest != null && interest !== 0) ? parseFloat((op / interest).toFixed(1)) : null;
    // PEG (YoY) — P/E ÷ latest year-over-year EPS growth
    let peg = null;
    const epsRow = d.pnl ? findRowLocal(d.pnl.data, 'EPS in Rs', 'EPS', 'Adjusted EPS in Rs') : null;
    if (epsRow && d.derived?.pe) {
      const vals = epsRow.filter(v => v != null && !isNaN(v));
      if (vals.length >= 2) {
        const s = vals[vals.length - 2], e = vals[vals.length - 1];
        if (s > 0 && e > 0) { const g = (e / s - 1) * 100; if (g > 0) peg = parseFloat((d.derived.pe / g).toFixed(2)); }
      }
    }

    // Cumulative CFO / PAT
    const cumPAT = d.derived?.cumPAT || [], cumCFO = d.derived?.cumCFO || [];
    const patTot = cumPAT.length ? cumPAT[cumPAT.length - 1] : null;
    const cfoTot = cumCFO.length ? cumCFO[cumCFO.length - 1] : null;
    const cfoPat = (patTot != null && cfoTot != null && patTot !== 0) ? parseFloat((cfoTot / patTot).toFixed(2)) : null;
    // FCF positive years
    const fcfArr = (d.derived?.fcfArr || []).filter(v => v != null);
    const fcf = fcfArr.length ? { pos: fcfArr.filter(v => v > 0).length, total: fcfArr.length } : null;
    // CFO covers CFI + CFF outflows (latest year)
    const cfd = d.cashFlow ? d.cashFlow.data : null;
    const cfoL = cfd ? lastOf(findRowLocal(cfd, 'Cash from Operating Activity')) : null;
    const cfiL = cfd ? lastOf(findRowLocal(cfd, 'Cash from Investing Activity')) : null;
    const cffL = cfd ? lastOf(findRowLocal(cfd, 'Cash from Financing Activity')) : null;
    let cfoCover = null;
    if (cfoL != null) {
      const outflow = (cfiL != null ? Math.min(0, cfiL) : 0) + (cffL != null ? Math.min(0, cffL) : 0);
      cfoCover = cfoL > 0 && cfoL >= Math.abs(outflow);
    }
    // Sales & PAT YoY growth (latest year)
    const yoy = (...keys) => {
      const arr = d.pnl ? findRowLocal(d.pnl.data, ...keys) : null;
      if (!arr) return null;
      const v = arr.filter(x => x != null);
      if (v.length < 2) return null;
      const a = v[v.length - 2], b = v[v.length - 1];
      return (a == null || a === 0) ? null : parseFloat(((b - a) / Math.abs(a) * 100).toFixed(1));
    };
    const salesYoY = yoy('Sales', 'Revenue', 'Net Sales', 'Total Revenue');
    const patYoY   = yoy('Net Profit', 'Profit after tax', 'PAT');

    // Working-capital / efficiency ratios (from screener's ratios table)
    const rget = (...k) => d.ratios ? lastOf(findRowLocal(d.ratios.data, ...k)) : null;
    const invDays    = rget('Inventory Days');
    const debtorDays = rget('Debtor Days');
    const ccc        = rget('Cash Conversion Cycle');

    // Asset turnover (NFAT) = latest Sales ÷ avg(Fixed Assets)
    let nfat = null;
    if (d.balanceSheet && d.pnl) {
      const fa = findRowLocal(d.balanceSheet.data, 'Fixed Assets', 'Net Fixed Assets', 'Tangible Assets', 'Property Plant Equipment');
      const salesR = findRowLocal(d.pnl.data, 'Sales', 'Revenue', 'Net Sales', 'Total Revenue');
      if (fa && salesR) {
        const faEnd = fa[fa.length - 1], faStart = fa.length > 1 ? fa[fa.length - 2] : faEnd;
        const s = salesR[salesR.length - 1];
        const avgFA = faStart != null ? (faStart + faEnd) / 2 : faEnd;
        if (s != null && avgFA > 0) nfat = parseFloat((s / avgFA).toFixed(2));
      }
    }

    // Cash & equivalents to sales ratio (%)
    const cashL  = d.balanceSheet ? lastOf(findRowLocal(d.balanceSheet.data, 'Cash Equivalents', 'Cash and Bank Balances', 'Cash & Bank', 'Cash and Cash Equivalents', 'Cash & Equivalents', 'Cash')) : null;
    const salesL = pnlLast('Sales', 'Revenue', 'Net Sales', 'Total Revenue');
    const cashSales = (cashL != null && salesL && salesL > 0) ? parseFloat((cashL / salesL * 100).toFixed(1)) : null;

    // Current price
    const price = num(get('current price'));
    // 52-week high / low (from "High / Low" top-ratio, e.g. "₹4,884 / 2,131")
    let hl52 = null;
    const hlStr = get('high / low');
    if (hlStr && hlStr !== 'N/A') {
      const m = String(hlStr).replace(/,/g, '').match(/([\d.]+)\s*\/\s*([\d.]+)/);
      if (m) hl52 = { hi: parseFloat(m[1]), lo: parseFloat(m[2]) };
    }
    // Promoter holding % (latest quarter)
    let promoterHold = null;
    if (d.shareholding?.data) {
      const pr = findRowLocal(d.shareholding.data, 'Promoter', 'Promoters', 'Promoter Group');
      if (pr) promoterHold = lastOf(pr);
    }
    // Reserves (₹ Cr)
    const reserves = d.balanceSheet ? lastOf(findRowLocal(d.balanceSheet.data, 'Reserves', 'Reserves and Surplus', 'Other Equity')) : null;

    const id = (d.nseSymbol || d.companyName || 'company').trim();
    return {
      id, name: d.companyName || d.nseSymbol || 'Company', symbol: d.nseSymbol || '', ts: Date.now(),
      m: {
        cfoPat, fcf, cfoCover, salesYoY, patYoY,
        invDays, debtorDays, ccc, nfat, cashSales,
        price, hl52, promoterHold, reserves,
        mcap:   num(get('market cap')),
        pe:     d.derived?.pe ?? num(get('stock p/e')),
        ps:     d.derived?.psRange?.current ?? null,
        ev:     d.derived?.evRange?.current ?? null,
        peg,
        roe:    num(get('roe')),
        roce:   num(get('roce')),
        gpm:    latestGPM(d.pnl),
        opm:    pnlLast('OPM %'),
        npm:    lastOf(d.derived?.npm),
        revC:   d.derived?.revCAGR5 ?? null,
        profC:  d.derived?.profCAGR5 ?? null,
        de:     lastOf(d.derived?.debtEquity),
        cr,
        icr,
        pledge: num(get('pledged')),
        ssgr:   d.derived?.ssgrFinal ?? null,
      },
    };
  }

  function tabCompare(d) {
    const basket = getBasket();
    const curId  = (d.nseSymbol || d.companyName || '').trim();
    const inBasket = basket.some(b => b.id === curId);
    const btn = 'background:#3b82f6;border:none;border-radius:6px;color:#fff;font-size:11px;font-weight:600;cursor:pointer;padding:6px 12px';
    const btnGhost = 'background:none;border:1px solid #334155;border-radius:6px;color:#94a3b8;font-size:11px;cursor:pointer;padding:6px 12px';

    let html = `${sectionHead('Compare Companies')}
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
        ${inBasket
          ? `<span style="font-size:11px;color:#34d399">✓ ${d.companyName || 'This company'} is in the comparison</span>`
          : `<button id="si-cmp-add" style="${btn}">➕ Add ${d.companyName || 'this company'}</button>`}
        ${basket.length ? `<button id="si-cmp-clear" style="${btnGhost}">Clear all</button>` : ''}
      </div>`;

    if (!basket.length) {
      return html + callout('info', 'No companies added yet. Open any company on screener.in and click <strong>“➕ Add”</strong> here to snapshot it. Add 2 or more to compare them side-by-side. Snapshots are saved locally and persist across sessions.');
    }

    const colSpan = basket.length + 1;

    // ── Overall score: each rankable metric normalised 0–100 between the
    // best & worst in the basket (by direction), then averaged per company.
    const scores = basket.map(() => ({ sum: 0, cnt: 0, wins: 0 }));
    const groupAgg = basket.map(() => ({}));   // per-company, per-category {sum,cnt}
    CMP_METRICS.forEach(mt => {
      if (mt.dir === 'none') return;
      const raw = basket.map(b => b.m ? (mt.cmp ? mt.cmp(b.m[mt.k]) : b.m[mt.k]) : null);
      const valid = raw.map(n => (typeof n === 'number' && !isNaN(n) && (mt.dir === 'low' && !mt.allowNeg ? n > 0 : true)) ? n : null);
      const present = valid.filter(n => n != null);
      if (present.length < 2) return;           // need at least 2 companies to rank
      const mn = Math.min(...present), mx = Math.max(...present), span = mx - mn;
      const bestVal = mt.dir === 'high' ? mx : mn;
      valid.forEach((n, i) => {
        if (n == null) return;
        const norm = span === 0 ? 1 : (mt.dir === 'high' ? (n - mn) / span : (mx - n) / span);
        scores[i].sum += norm; scores[i].cnt++;
        if (n === bestVal) scores[i].wins++;
        const ga = groupAgg[i][mt.g] || (groupAgg[i][mt.g] = { sum: 0, cnt: 0 });
        ga.sum += norm; ga.cnt++;
      });
    });
    const scorePct = scores.map(s => s.cnt ? Math.round(s.sum / s.cnt * 100) : null);
    const maxScore = Math.max(-1, ...scorePct.filter(v => v != null));
    const winnerIdx = scorePct.indexOf(maxScore);

    // ── Per-category leaders ──
    const shortCat = g => g.replace(' metrics', '').replace('Return ratios', 'Returns');
    const catWinners = CMP_GROUPS.map(g => {
      const avgs = basket.map((_, i) => { const a = groupAgg[i][g]; return a && a.cnt ? a.sum / a.cnt : null; });
      const present = avgs.map((v, i) => ({ v, i })).filter(o => o.v != null);
      if (present.length < 2) return null;
      const best = present.reduce((a, b) => b.v > a.v ? b : a);
      return { cat: shortCat(g), name: basket[best.i].symbol || basket[best.i].name };
    }).filter(Boolean);
    const catInner = catWinners.length ? `
      <div style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px">Category Leaders</div>
      <div class="si-table-wrap" style="max-height:none;overflow:visible">
        <table class="si-table" style="width:100%">
          <thead><tr><th>Category</th><th style="text-align:right">Leader</th></tr></thead>
          <tbody>
            ${catWinners.map(c => `<tr>
              <td style="color:#818cf8;font-weight:600;white-space:nowrap">${c.cat}</td>
              <td style="text-align:right !important;font-weight:700;color:#e2e8f0;white-space:nowrap">🏆 ${c.name}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>` : '';

    // Rank map for medals
    const ranked = scorePct.map((v, i) => ({ v, i })).filter(o => o.v != null).sort((a, b) => b.v - a.v);
    const rankOf = {}; ranked.forEach((o, r) => { rankOf[o.i] = r + 1; });
    const medal = r => r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : `#${r}`;

    // ── Score card elements (combined with category leaders below) ──
    const scoreCardEls = basket.length >= 2 ? basket.map((b, i) => {
      const v = scorePct[i], win = v != null && v === maxScore;
      return `<div style="flex:1;min-width:96px;background:${win ? 'linear-gradient(160deg,#10241c,#0f1b2d)' : '#1a2438'};border:1px solid ${win ? '#34d39966' : '#293548'};border-radius:9px;padding:6px 9px">
        <div style="font-size:9px;color:#94a3b8;font-weight:600;letter-spacing:.3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${b.symbol || b.name}</div>
        <div style="display:flex;align-items:baseline;gap:4px;margin-top:1px">
          <span style="font-size:18px;font-weight:800;line-height:1;color:${win ? '#34d399' : '#e2e8f0'}">${v == null ? '—' : v}</span>
          <span style="font-size:9px;color:#64748b">/100</span>
          ${v != null ? `<span style="margin-left:auto;font-size:12px">${medal(rankOf[i])}</span>` : ''}
        </div>
        <div style="font-size:8px;color:#64748b;margin-top:2px">${scores[i].wins} metric win${scores[i].wins === 1 ? '' : 's'}</div>
      </div>`;
    }).join('') : '';

    // Top region: overall-score cards (left) + category leaders (right), side-by-side
    const topRegion = (scoreCardEls || catInner) ? `
      <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start;margin-bottom:12px">
        ${scoreCardEls ? `<div style="flex:2;min-width:230px">
          <div style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px">Overall Score</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">${scoreCardEls}</div>
        </div>` : ''}
        ${catInner ? `<div style="flex:1;min-width:210px">${catInner}</div>` : ''}
      </div>` : '';

    // ── Header columns (winner tinted, right-aligned to match values) ──
    const headCols = basket.map((b, i) => {
      const win = i === winnerIdx && maxScore >= 0;
      return `<th style="text-align:right !important;white-space:normal;overflow-wrap:anywhere;padding:8px 12px !important;color:${win ? '#34d399' : '#e2e8f0'} !important">
        ${win ? '🏆 ' : ''}${b.symbol || b.name}
        <button class="si-cmp-rm" data-id="${b.id}" title="Remove from comparison" style="background:none;border:none;color:#64748b;cursor:pointer;font-size:12px;margin-left:4px;vertical-align:middle">✕</button>
      </th>`;
    }).join('');

    const rowFor = mt => {
      const vals = basket.map(b => b.m ? b.m[mt.k] : null);
      const nums = vals.map(v => mt.cmp ? mt.cmp(v) : v);   // numeric value used for ranking
      let bestIdx = -1;
      if (mt.dir !== 'none') {
        const cand = nums.map((n, i) => ({ n, i }))
          .filter(o => typeof o.n === 'number' && !isNaN(o.n) && (mt.dir === 'low' && !mt.allowNeg ? o.n > 0 : true));
        if (cand.length) {
          const best = mt.dir === 'high' ? cand.reduce((a, b) => b.n > a.n ? b : a) : cand.reduce((a, b) => b.n < a.n ? b : a);
          bestIdx = best.i;
        }
      }
      const cells = vals.map((v, i) =>
        `<td style="text-align:right !important;font-variant-numeric:tabular-nums;${i === bestIdx ? 'color:#34d399 !important;font-weight:700' : ''}">${mt.fmt(v)}</td>`).join('');
      return `<tr><td style="white-space:nowrap;color:#cbd5e1">${mt.label}</td>${cells}</tr>`;
    };
    const rows = CMP_GROUPS.map(g => {
      const ms = CMP_METRICS.filter(m => m.g === g);
      if (!ms.length) return '';
      const header = `<tr><td colspan="${colSpan}" style="background:#0f1b2d !important;color:#818cf8 !important;font-weight:700;font-size:9.5px;letter-spacing:.6px;text-transform:uppercase;padding:8px 14px !important;border-top:1px solid #293548 !important">${g}</td></tr>`;
      return header + ms.map(rowFor).join('');
    }).join('');

    html += `
      ${topRegion}
      <div class="si-table-wrap" style="max-height:none;overflow:auto">
        <table class="si-table" style="line-height:1.55;table-layout:fixed;width:100%;min-width:${170 + basket.length * 90}px">
          <colgroup>
            <col style="width:170px">
            ${basket.map(() => '<col style="width:auto">').join('')}
          </colgroup>
          <thead><tr><th>Metric</th>${headCols}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div style="margin-top:8px;font-size:10px;color:#64748b;line-height:1.5">
        🏆 <strong>Overall Score</strong> (0–100) ranks each company <em>against the others in this basket</em>: per metric, scored between the worst (0) and best (100), then averaged. It's a relative read, not an absolute grade. Best value in each row is green (lower is better for valuation/leverage/days; higher for returns/growth). Re-add a company to refresh its snapshot.
      </div>`;
    return html;
  }

  // Layer 3 — Valuation + Final Scorecard
  function tabScorecard(d) {
    const fw  = d.derived;
    const get = makeGetter(d.keyRatios);
    const ey  = fw.earningsYield;
    const sc  = fw.ssgrScenario || {};
    const mc  = d.derived.moatCheck || [];

    // EY verdict
    const eyStatus = ey == null ? 'info'
                   : ey > GSEC_YIELD + 2 ? 'pass'
                   : ey > GSEC_YIELD - 1 ? 'caution'
                   : 'fail';
    const eyLabel  = eyStatus === 'pass'    ? `EY ${ey}% >> G-Sec ${GSEC_YIELD}% — Margin of Safety`
                   : eyStatus === 'caution' ? `EY ${ey}% ≈ G-Sec ${GSEC_YIELD}% — Fully Priced`
                   : ey != null             ? `EY ${ey}% << G-Sec ${GSEC_YIELD}% — No Margin of Safety`
                   : 'Insufficient data';

    // Moat pass count
    const moatPass = mc.filter(c => c.status === 'pass').length;
    const moatFail = mc.filter(c => c.status === 'fail').length;
    const moatStatus = moatFail >= 2 ? 'fail' : moatPass >= 3 ? 'pass' : 'caution';

    // FCF profile
    const fcfArr = fw.fcfArr || [];
    const posFCF = fcfArr.filter(v => v != null && v > 0).length;
    const fcfStatus = fcfArr.length === 0 ? 'info'
                    : posFCF / fcfArr.length >= 0.8 ? 'pass'
                    : posFCF / fcfArr.length >= 0.5 ? 'caution'
                    : 'fail';

    // SSGR status
    const ssgrStatus = sc.color || 'info';

    // EY layer
    const l3Status = eyStatus;

    // Red flags
    const redFlags = [];
    if (mc.find(c=>c.step===4)?.status === 'fail')   redFlags.push('CFO persistently below PAT — broken cash conversion');
    if ((fw.debtEquity?.[fw.debtEquity?.length-1] || 0) > 1.5) redFlags.push('High D/E ratio — leverage concern');
    if ((fw.revCAGR5||0) > 0 && (fw.profCAGR5||0) < 0) redFlags.push('Profit declining despite revenue growth — margin compression');
    if (fcfStatus === 'fail') redFlags.push('Chronically negative FCF + rising debt — cash guzzler');

    // Positive signals
    const positives = [];
    if (moatStatus === 'pass')  positives.push('OPM stable/improving over multiple years — pricing power evident');
    if (fcfStatus === 'pass')   positives.push('Consistently positive FCF — cash-generative machine');
    if (ssgrStatus === 'pass')  positives.push('SSGR exceeds growth rate — self-funded, debt-free compounding');
    if ((fw.revCAGR5||0) > 12) positives.push('Revenue CAGR > 12% — strong sales momentum');

    // ── Investment Checklist (8 fundamental parameters) ──────────────────────
    const P = d.pnl, BS = d.balanceSheet, CF = d.cashFlow;
    const lastVal = row => { if (!row) return null; for (let i = row.length - 1; i >= 0; i--) if (row[i] != null && !isNaN(row[i])) return row[i]; return null; };
    const findP = (...t) => P  ? findRowLocal(P.data, ...t)  : null;
    const findB = (...t) => BS ? findRowLocal(BS.data, ...t) : null;
    const findC = (...t) => CF ? findRowLocal(CF.data, ...t) : null;

    // 1. Sales growth — CAGR over up to 10 years
    let salesCAGR = null;
    const salesRow = findP('Sales', 'Revenue', 'Net Sales', 'Total Revenue', 'Revenue from Operations');
    if (salesRow) {
      const vals = salesRow.filter(v => v != null && !isNaN(v));
      if (vals.length >= 2) {
        const w = Math.min(10, vals.length);
        const start = vals[vals.length - w], end = vals[vals.length - 1];
        if (start > 0 && end > 0) salesCAGR = (Math.pow(end / start, 1 / (w - 1)) - 1) * 100;
      }
    }
    const salesStatus = salesCAGR == null ? 'info'
                      : salesCAGR > 50 ? 'caution'
                      : salesCAGR >= 15 ? 'pass'
                      : salesCAGR > 0 ? 'caution' : 'fail';
    const salesNote = salesCAGR == null ? 'No sales data'
                    : salesCAGR > 50 ? `${salesCAGR.toFixed(1)}% CAGR — very high, likely unsustainable long-term`
                    : salesCAGR >= 15 ? `${salesCAGR.toFixed(1)}% CAGR — high & healthy`
                    : salesCAGR > 0 ? `${salesCAGR.toFixed(1)}% CAGR — modest growth`
                    : `${salesCAGR.toFixed(1)}% CAGR — contracting`;

    // 2. Profitability — OPM & NPM (prefer NPM > 8%)
    const opmLatest = lastVal(findP('OPM %'));
    const npmLatest = lastVal(d.derived.npm) ?? null;
    const profStatus = npmLatest == null ? 'info' : npmLatest >= 8 ? 'pass' : npmLatest > 0 ? 'caution' : 'fail';
    const profNote = npmLatest == null ? 'No margin data'
                   : `NPM ${npmLatest.toFixed(1)}%${opmLatest != null ? `, OPM ${opmLatest.toFixed(1)}%` : ''} — ${npmLatest >= 8 ? 'healthy net margin' : 'below preferred 8% NPM'}`;

    // 3. Tax payout ratio — near corporate rate (~25%)
    const taxLatest = lastVal(findP('Tax %'));
    const taxStatus = taxLatest == null ? 'info' : (taxLatest >= 20 && taxLatest <= 35) ? 'pass' : 'caution';
    const taxNote = taxLatest == null ? 'No tax data'
                  : (taxLatest >= 20 && taxLatest <= 35) ? `${taxLatest.toFixed(1)}% — near general corporate tax rate`
                  : `${taxLatest.toFixed(1)}% — off the norm; check for tax incentives or one-offs`;

    // 4. Interest coverage = Operating Profit / Interest
    const opProfit = lastVal(findP('Operating Profit', 'EBITDA'));
    const interest = lastVal(findP('Interest', 'Finance Costs', 'Interest Expense'));
    let icr = null;
    if (opProfit != null && interest != null) icr = interest === 0 ? Infinity : opProfit / interest;
    const icrStatus = icr == null ? 'info' : icr > 3 ? 'pass' : icr >= 1.5 ? 'caution' : 'fail';
    const icrNote = icr == null ? 'No interest data'
                  : icr === Infinity ? 'Negligible interest cost — effectively debt-free'
                  : icr > 3 ? `${icr.toFixed(1)}x — comfortably covers interest`
                  : `${icr.toFixed(1)}x — below the safe 3x threshold`;

    // 5. Debt / Equity (prefer < 0.5)
    const deLatest = lastVal(d.derived.debtEquity);
    const deStatus = deLatest == null ? 'info' : deLatest < 0.5 ? 'pass' : deLatest < 1 ? 'caution' : 'fail';
    const deNote = deLatest == null ? 'No D/E data'
                 : deLatest < 0.5 ? `${deLatest.toFixed(2)}x — low leverage`
                 : deLatest < 1 ? `${deLatest.toFixed(2)}x — moderate leverage`
                 : `${deLatest.toFixed(2)}x — high leverage`;

    // 6. Current ratio = CA / CL (prefer > 1.25)
    let cr = null;
    if (BS) {
      const inv  = lastVal(findB('Inventories', 'Inventory', 'Stocks'));
      const recv = lastVal(findB('Trade receivables', 'Trade Receivables', 'Sundry Debtors', 'Debtors'));
      const cash = lastVal(findB('Cash Equivalents', 'Cash and Bank Balances', 'Cash & Bank', 'Cash and Cash Equivalents', 'Cash & Equivalents', 'Cash'));
      const pay  = lastVal(findB('Trade Payables', 'Trade payables', 'Sundry Creditors', 'Creditors'));
      const ca = (inv || 0) + (recv || 0) + (cash || 0);
      if (pay && pay > 0) cr = ca / pay;
    }
    const crStatus = cr == null ? 'info' : cr > 1.25 ? 'pass' : cr >= 1 ? 'caution' : 'fail';
    const crNote = cr == null ? 'Insufficient balance-sheet data'
                 : cr > 1.25 ? `${cr.toFixed(2)}x — healthy short-term liquidity`
                 : cr >= 1 ? `${cr.toFixed(2)}x — adequate but below preferred 1.25x`
                 : `${cr.toFixed(2)}x — liquidity strain`;

    // 7. Cash flow — positive CFO; great if CFO covers CFI + CFF outflows
    const cfoLatest = lastVal(findC('Cash from Operating Activity'));
    const cfiLatest = lastVal(findC('Cash from Investing Activity'));
    const cffLatest = lastVal(findC('Cash from Financing Activity'));
    let cfStatus = 'info', cfNote = 'No cash-flow data';
    if (cfoLatest != null) {
      const outflow = (cfiLatest != null ? Math.min(0, cfiLatest) : 0) + (cffLatest != null ? Math.min(0, cffLatest) : 0);
      if (cfoLatest <= 0) { cfStatus = 'fail'; cfNote = `CFO ${Math.round(cfoLatest)} — negative operating cash flow`; }
      else if (cfoLatest >= Math.abs(outflow)) { cfStatus = 'pass'; cfNote = `CFO ${Math.round(cfoLatest)} fully funds investing + financing outflows`; }
      else { cfStatus = 'caution'; cfNote = `CFO ${Math.round(cfoLatest)} positive but does not fully cover CFI+CFF outflows`; }
    }

    // 8. Cumulative PAT vs CFO over 10 years (should be similar)
    const cumPAT = d.derived?.cumPAT || [];
    const cumCFO = d.derived?.cumCFO || [];
    const patTot = cumPAT.length ? cumPAT[cumPAT.length - 1] : null;
    const cfoTot = cumCFO.length ? cumCFO[cumCFO.length - 1] : null;
    // Number of years actually covered by the cumulative series
    const pcYears = Math.min(cumPAT.length, cumCFO.length);
    let pcRatio = null;
    if (patTot != null && cfoTot != null && patTot !== 0) pcRatio = cfoTot / patTot;
    // CFO meeting or exceeding PAT is good (profits backed by cash). Only CFO
    // trailing PAT is a red flag. So we only penalise the downside.
    const pcStatus = pcRatio == null ? 'info'
                   : pcRatio >= 0.8 ? 'pass'
                   : pcRatio >= 0.6 ? 'caution'
                   : 'fail';
    const pcSpan = pcYears > 0 ? ` (based on ${pcYears} year${pcYears === 1 ? '' : 's'} of data${pcYears < 10 ? ', <10y available' : ''})` : '';
    const pcNote = pcRatio == null ? 'Insufficient cumulative data'
                 : `Cumulative CFO/PAT ${pcRatio.toFixed(2)}x — ${pcRatio >= 1.2 ? 'cash comfortably exceeds reported profit (strong earnings quality)' : pcRatio >= 0.8 ? 'profits well backed by cash' : pcRatio >= 0.6 ? 'cash somewhat trails profit — monitor earnings quality' : 'cash well below reported profit (earnings-quality red flag)'}${pcSpan}`;

    // 9. Promoter pledging — any pledge is a flag
    const pledgePct = (() => {
      const kr = get('pledged');
      let v = (kr && kr !== 'N/A') ? parseFloat(String(kr).replace(/[^0-9.]/g, '')) : NaN;
      if (isNaN(v) && d.shareholding?.data?.['__pledgePct__']) {
        const arr = d.shareholding.data['__pledgePct__'];
        for (let i = arr.length - 1; i >= 0; i--) { if (arr[i] != null) { v = arr[i]; break; } }
      }
      return isNaN(v) ? null : v;
    })();
    const pledgeStatus = pledgePct == null ? 'info'
                       : pledgePct === 0 ? 'pass'
                       : pledgePct <= 10 ? 'caution'
                       : 'fail';
    const pledgeNote = pledgePct == null ? 'Pledge data unavailable'
                     : pledgePct === 0 ? 'No promoter shares pledged'
                     : pledgePct <= 10 ? `${pledgePct}% of promoter holding pledged — monitor (pledging signals promoter cash stress)`
                     : `${pledgePct}% of promoter holding pledged — high; significant risk if share price falls`;

    const checklist = [
      { p: 'Sales Growth',        target: '>15%/yr; >50% unsustainable', status: salesStatus, note: salesNote },
      { p: 'Profitability',       target: 'NPM > 8%',                     status: profStatus,  note: profNote },
      { p: 'Tax Payout Ratio',    target: '≈ corporate tax rate',         status: taxStatus,   note: taxNote },
      { p: 'Interest Coverage',   target: '> 3x',                         status: icrStatus,   note: icrNote },
      { p: 'Debt / Equity',       target: '< 0.5x',                       status: deStatus,    note: deNote },
      { p: 'Current Ratio',       target: '> 1.25x',                      status: crStatus,    note: crNote },
      { p: 'Cash Flow (CFO)',     target: 'Positive; covers CFI+CFF',     status: cfStatus,    note: cfNote },
      { p: 'Cumulative PAT vs CFO', target: `CFO ≥ PAT over ${pcYears >= 10 ? '10Y' : pcYears > 0 ? pcYears + 'Y' : '10Y'}`, status: pcStatus, note: pcNote },
      { p: 'Free Cash Flow',      target: 'Consistently positive',        status: fcfStatus,
        note: fcfArr.length ? `${posFCF}/${fcfArr.length} years positive FCF` : 'No FCF data' },
      { p: 'SSGR',                target: '≥ sales growth (self-funded)',  status: ssgrStatus,
        note: fw.ssgrFinal != null ? `Self-sustainable growth ${fw.ssgrFinal}%${salesCAGR != null ? ` vs ${salesCAGR.toFixed(1)}% sales CAGR` : ''}` : 'SSGR unavailable' },
      { p: 'Promoter Pledging',   target: 'Nil (0%)',                     status: pledgeStatus, note: pledgeNote },
    ];

    const checkRows = checklist.map(c => `
      <tr>
        <td>${c.p}</td>
        <td style="color:#64748b;font-size:11px">${c.target}</td>
        <td>${badge(c.status)}</td>
        <td class="si-td-finding">${c.note}</td>
      </tr>`).join('');

    const nPass = checklist.filter(c => c.status === 'pass').length;
    const nCaut = checklist.filter(c => c.status === 'caution').length;
    const nFail = checklist.filter(c => c.status === 'fail').length;
    const nEval = checklist.filter(c => c.status !== 'info').length;

    const execColor = nFail >= 3 ? 'fail' : (nFail === 0 && nPass >= Math.ceil(nEval * 0.7)) ? 'pass' : nFail <= 1 ? 'caution' : 'fail';
    const execHeadline = execColor === 'pass' ? 'Strong fundamental profile — clears most quality checks'
                       : execColor === 'caution' ? 'Reasonable quality with a few watch-points'
                       : 'Multiple fundamental weaknesses — exercise caution';
    const failList = checklist.filter(c => c.status === 'fail').map(c => c.p);
    const cautList = checklist.filter(c => c.status === 'caution').map(c => c.p);
    const execBody = `Passes <strong style="color:#34d399">${nPass}</strong>, caution on <strong style="color:#fbbf24">${nCaut}</strong>, fails <strong style="color:#f87171">${nFail}</strong> of ${nEval} evaluated criteria.`
      + (failList.length ? ` <br><strong style="color:#f87171">Failing:</strong> ${failList.join(', ')}.` : '')
      + (cautList.length ? ` <br><strong style="color:#fbbf24">Watch:</strong> ${cautList.join(', ')}.` : '');

    return `
      ${sectionHead('Executive Summary')}
      <div class="si-verdict-final si-b-${execColor}">
        <div class="si-verdict-label-final">Fundamental Health</div>
        <div class="si-verdict-text">${execHeadline}</div>
      </div>
      <div class="si-callout si-callout-info" style="line-height:1.6">${execBody}</div>

      ${sectionHead('Investment Checklist')}
      <div class="si-table-wrap">
        <table class="si-table">
          <thead><tr><th>Parameter</th><th>Target</th><th>Status</th><th>Reading</th></tr></thead>
          <tbody>${checkRows}</tbody>
        </table>
      </div>

      ${positives.length ? callout('green', '<strong>✓ Positive Signals:</strong><ul>' + positives.map(p=>`<li>${p}</li>`).join('') + '</ul>') : ''}
      ${redFlags.length  ? callout('red',   '<strong>⚠ Red Flags:</strong><ul>'       + redFlags.map(f=>`<li>${f}</li>`).join('') + '</ul>') : ''}

      <div class="si-callout si-callout-info">
        G-Sec yield used: ${GSEC_YIELD}% (10Y India G-Sec). Update in panel.js → GSEC_YIELD as needed.
      </div>`;
  }

  // ── Delivery helpers ──────────────────────────────────────────────────────

  function getScreenerCompanyId() {
    // Try data attributes on chart/section elements
    const candidates = ['[data-company-id]', '[data-pk]', '#chart', '.company-chart', '[data-id]'];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const id = el.dataset.companyId || el.dataset.pk || el.dataset.id;
      if (id && /^\d+$/.test(id)) return id;
    }
    // Try window globals (Django/template injected)
    for (const key of ['company_id', 'companyId', 'company', '__company__']) {
      const v = window[key];
      if (!v) continue;
      const id = typeof v === 'object' ? (v.id || v.pk) : v;
      if (id && /^\d+$/.test(String(id))) return String(id);
    }
    // Try inline scripts for patterns like company_id = 12345 or "id":12345
    for (const script of document.querySelectorAll('script:not([src])')) {
      const m = script.textContent.match(/company[_.]?id["'\s:=]+(\d+)/i)
             || script.textContent.match(/"pk"\s*:\s*(\d+)/)
             || script.textContent.match(/id\s*=\s*(\d{4,})/);
      if (m) return m[1];
    }
    return null;
  }

  function parseDeliveryFromChart(json) {
    if (!json) return null;
    let dates = [], vals = [], totalVol = [], delivVol = [];

    // Format A: {datasets:[{metric,values:[[ts,val],...]},...]}
    if (json.datasets && Array.isArray(json.datasets)) {
      let volDs = null, delDs = null;
      for (const ds of json.datasets) {
        const nm = (ds.metric || ds.name || '').toLowerCase();
        if (nm.includes('deliv'))                            delDs = ds;
        else if (nm === 'volume' || nm.includes('traded'))   volDs = ds;
      }
      if (delDs && volDs) {
        const volMap = new Map((volDs.values || []).map(v => [v[0], v[1]]));
        for (const [ts, dv] of (delDs.values || [])) {
          const tv = volMap.get(ts) || 0;
          if (tv > 0) {
            dates.push(new Date(ts).toLocaleDateString('en-IN', {day:'2-digit', month:'short'}));
            vals.push(parseFloat((dv / tv * 100).toFixed(1)));
            totalVol.push(tv);
            delivVol.push(dv);
          }
        }
        if (dates.length) return { dates, vals, totalVol, delivVol };
      }
      if (delDs) {
        for (const [ts, v] of (delDs.values || [])) {
          dates.push(new Date(ts).toLocaleDateString('en-IN', {day:'2-digit', month:'short'}));
          vals.push(v);
        }
        if (dates.length) return { dates, vals };
      }
    }

    // Format B: [[ts, o, h, l, c, vol, del_vol], ...]
    if (Array.isArray(json) && Array.isArray(json[0]) && json[0].length >= 7) {
      for (const row of json.slice(-90)) {
        const tv = row[5], dv = row[6];
        if (tv > 0) {
          dates.push(new Date(row[0]).toLocaleDateString('en-IN', {day:'2-digit', month:'short'}));
          vals.push(parseFloat((dv / tv * 100).toFixed(1)));
          totalVol.push(tv);
          delivVol.push(dv);
        }
      }
      if (dates.length) return { dates, vals, totalVol, delivVol };
    }

    // Format C: {delivery:[[ts,val],...], volume:[[ts,val],...]}
    if (json.delivery && Array.isArray(json.delivery)) {
      const volArr = json.volume || [];
      const volMap = new Map((volArr).map(v => Array.isArray(v) ? [v[0], v[1]] : []));
      for (const d of json.delivery.slice(-90)) {
        const ts = Array.isArray(d) ? d[0] : null;
        const dv = Array.isArray(d) ? d[1] : d;
        const tv = ts ? volMap.get(ts) : null;
        dates.push(ts ? new Date(ts).toLocaleDateString('en-IN', {day:'2-digit', month:'short'}) : String(dates.length));
        vals.push(tv && tv > 0 ? parseFloat((dv / tv * 100).toFixed(1)) : dv);
        if (tv) { totalVol.push(tv); delivVol.push(dv); }
      }
      if (dates.length) return { dates, vals, totalVol: totalVol.length ? totalVol : null, delivVol: delivVol.length ? delivVol : null };
    }

    return null;
  }

  async function loadDeliveryChart() {
    const statusEl = document.getElementById('si-del-status');
    const companyId = getScreenerCompanyId();
    if (!companyId) {
      if (statusEl) statusEl.innerHTML = `<div class="si-callout si-callout-amber">
        <strong>Company ID not found.</strong><br>Could not locate the numeric company ID in page DOM/scripts.
        Open DevTools → Network → filter "chart" to find the API URL.
      </div>`;
      return;
    }

    const url = `/api/company/${companyId}/chart/?q=Price-DMA50-DMA200-Volume-Delivery&days=365`;
    try {
      if (statusEl) statusEl.textContent = `Fetching delivery data (company ${companyId})…`;
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      console.debug('[SI] Delivery API response keys:', Array.isArray(json) ? `array[${json.length}]` : Object.keys(json));

      const parsed = parseDeliveryFromChart(json);
      if (!parsed || !parsed.dates.length) {
        if (statusEl) statusEl.innerHTML = `<div class="si-callout si-callout-amber">
          Delivery data not found in API response.<br>
          <small>Keys: ${Array.isArray(json) ? 'array' : Object.keys(json).join(', ')}</small>
        </div>`;
        return;
      }

      if (statusEl) statusEl.style.display = 'none';
      document.getElementById('si-del-chart-wrap').style.display = '';

      const C = ScreenerInsights.charts.C;
      ScreenerInsights.charts.line('si-c-del-pct', parsed.dates, [
        { label: 'Delivery %', data: parsed.vals, color: C.cyan, fill: true }
      ], { options: { scales: { y: { ticks: { callback: v => v + '%' } } } } });

      if (parsed.totalVol && parsed.delivVol) {
        document.getElementById('si-del-vol-wrap').style.display = '';
        ScreenerInsights.charts.bar('si-c-del-vol', parsed.dates, [
          { label: 'Total Vol',    data: parsed.totalVol, color: C.blue,  colorA: C.blueA  },
          { label: 'Delivery Vol', data: parsed.delivVol, color: C.green, colorA: C.greenA },
        ]);
      }

      // Stats summary
      const avg  = (parsed.vals.reduce((a, b) => a + b, 0) / parsed.vals.length).toFixed(1);
      const last = parsed.vals[parsed.vals.length - 1];
      const max  = Math.max(...parsed.vals).toFixed(1);
      const min  = Math.min(...parsed.vals).toFixed(1);
      const statsEl = document.getElementById('si-del-stats');
      if (statsEl) statsEl.innerHTML = `
        <div class="si-grid" style="margin-top:8px">
          ${card('Latest Delivery %', last + '%', 'Most recent day', last >= 50 ? 'si-green' : last < 30 ? 'si-red' : 'si-orange')}
          ${card('1Y Avg Delivery %', avg + '%', 'Last 365 days')}
          ${card('Range', min + '% – ' + max + '%', '1Y min / max')}
        </div>`;
    } catch (e) {
      console.debug('[SI] Delivery fetch error:', e);
      if (statusEl) statusEl.innerHTML = `<div class="si-callout si-callout-amber">
        Error fetching delivery data: ${e.message}<br>
        <small>Tried: ${url}</small>
      </div>`;
    }
  }

  // Delivery % tab
  function tabDelivery() {
    return `
      ${sectionHead('Delivery Volume % Trend')}
      <div id="si-del-status" style="color:#94a3b8;font-size:11px;padding:6px 0">Initialising…</div>
      <div id="si-del-chart-wrap" class="si-chart-wrap" style="display:none">
        <div class="si-chart-label">Delivery % (Last 365 days)</div>
        <div style="height:200px"><canvas id="si-c-del-pct"></canvas></div>
      </div>
      <div id="si-del-vol-wrap" class="si-chart-wrap" style="display:none;margin-top:8px">
        <div class="si-chart-label">Delivery vs Total Volume</div>
        <div style="height:160px"><canvas id="si-c-del-vol"></canvas></div>
      </div>
      <div id="si-del-stats"></div>
      <div class="si-callout si-callout-amber" style="margin-top:8px">
        <strong>Why Delivery % matters:</strong> High delivery % (&gt;50–60%) on rising price = institutional/long-term buying conviction.
        Low delivery on big moves = speculative / intraday activity. Sustained improvement in delivery % confirms accumulation.
      </div>`;
  }

  // ── Chart rendering ───────────────────────────────────────────────────────

  function findRowLocal(data, ...terms) { return findRow(data, ...terms); }

  // ── CFO/PAT ratio threshold (persisted in localStorage) ──────────────────
  const CFO_PAT_KEY = 'si_cfo_pat_threshold';
  function getCfoPat() {
    try { const v = parseFloat(localStorage.getItem(CFO_PAT_KEY)); return isNaN(v) ? 1 : v; }
    catch (_) { return 1; }
  }
  function saveCfoPat(v) { localStorage.setItem(CFO_PAT_KEY, v); }

  // ── Capex/CFO ratio threshold (persisted in localStorage) ─────────────────
  const CAPEX_CFO_KEY = 'si_capex_cfo_threshold';
  function getCapexCfo() {
    try { const v = parseFloat(localStorage.getItem(CAPEX_CFO_KEY)); return isNaN(v) ? 1 : v; }
    catch (_) { return 1; }
  }
  function saveCapexCfo(v) { localStorage.setItem(CAPEX_CFO_KEY, v); }

  // ── ICR thresholds (persisted in localStorage) ───────────────────────────
  const ICR_KEY = 'si_icr_thresholds';
  function getIcrThresholds() {
    try {
      const s = JSON.parse(localStorage.getItem(ICR_KEY) || '{}');
      const safe    = parseFloat(s.safe)    || 3;
      const caution = parseFloat(s.caution) || 1.5;
      return { safe: Math.max(caution + 0.1, safe), caution: Math.max(0.1, caution) };
    } catch (_) { return { safe: 3, caution: 1.5 }; }
  }
  function saveIcrThresholds(safe, caution) {
    localStorage.setItem(ICR_KEY, JSON.stringify({ safe, caution }));
  }

  // ── Current Ratio threshold (persisted in localStorage) ─────────────────
  const CR_KEY = 'si_cr_threshold';
  function getCrThreshold() {
    try { const v = parseFloat(localStorage.getItem(CR_KEY)); return isNaN(v) ? 1.25 : v; }
    catch (_) { return 1.25; }
  }
  function saveCrThreshold(v) { localStorage.setItem(CR_KEY, v); }

  // ── OPM reference line thresholds (persisted in localStorage) ───────────
  const OPM_KEY = 'si_opm_thresholds';
  function getOpmThresholds() {
    try {
      const s = JSON.parse(localStorage.getItem(OPM_KEY) || '{}');
      return { good: parseFloat(s.good) || 20, zero: parseFloat(s.zero) || 0 };
    } catch (_) { return { good: 20, zero: 0 }; }
  }
  function saveOpmThresholds(good, zero) {
    localStorage.setItem(OPM_KEY, JSON.stringify({ good, zero }));
  }

  // ── Delivery % RAG thresholds (persisted in localStorage) ────────────────
  const DEL_KEY = 'si_del_rag';
  function getDelThresholds() {
    try {
      const s = JSON.parse(localStorage.getItem(DEL_KEY) || '{}');
      const g = parseInt(s.green) || 40;
      const a = parseInt(s.amber) || 20;
      return { green: Math.max(a + 1, g), amber: Math.max(1, a) };
    } catch (_) { return { green: 40, amber: 20 }; }
  }
  function saveDelThresholds(green, amber) {
    localStorage.setItem(DEL_KEY, JSON.stringify({ green, amber }));
  }
  function updateDelLegend(g, a) {
    ['si-del-g-lbl','si-del-g-pv','si-del-g-lbl2','si-del-g-pv2'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = g; });
    ['si-del-a-lbl','si-del-a-pv'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = a; });
    ['si-del-r-lbl','si-del-r-pv'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = a; });
    const ri = document.getElementById('si-del-red-lbl'); if (ri) ri.value = a;
  }

  function renderCharts(tab, d) {
    const { bar, line, stackedBar, make, C } = ScreenerInsights.charts;
    const N = 10;

    // Drag-to-reorder for top-level chart blocks in the current tab body.
    // Uses a small grip handle on each block so it never interferes with
    // buttons/inputs (e.g. settings gears) inside the block.
    const setupBlockReorder = (storageKey, redraw) => {
      const body = document.getElementById('si-body');
      if (!body) return;

      // Draggable blocks = direct children that are chart-wraps or insight divs.
      const blocks = Array.from(body.children).filter(el =>
        el.id !== 'si-block-toolbar' && el.tagName !== 'BUTTON' &&
        (el.classList.contains('si-chart-wrap') || (el.id && el.id.startsWith('si-')) || el.querySelector('canvas')));
      if (blocks.length < 2) return;

      // Assign a stable id to each block
      const blockId = el => el.id || el.querySelector('canvas')?.id || null;
      blocks.forEach(el => { const id = blockId(el); if (id) el.dataset.blockId = id; });

      // Restore saved order
      let saved = [];
      try { saved = JSON.parse(localStorage.getItem(storageKey) || '[]'); } catch (_) {}
      if (saved.length) {
        const map = {};
        blocks.forEach(el => { if (el.dataset.blockId) map[el.dataset.blockId] = el; });
        saved.forEach(id => { if (map[id]) body.appendChild(map[id]); });
        // append any new blocks not in saved order (already in DOM, leave as-is)
      }

      const persist = () => {
        const order = Array.from(body.children)
          .map(el => el.dataset.blockId).filter(Boolean);
        localStorage.setItem(storageKey, JSON.stringify(order));
      };

      // ── Hide / unhide state ──────────────────────────────────────────────
      const hiddenKey = storageKey + '_hidden';
      const getHidden = () => { try { return JSON.parse(localStorage.getItem(hiddenKey) || '[]'); } catch (_) { return []; } };
      const saveHidden = arr => localStorage.setItem(hiddenKey, JSON.stringify(arr));
      const blockLabel = el => (el.querySelector('.si-chart-label')?.textContent || el.dataset.blockId || 'Chart').trim();
      const blockById  = id => blocks.find(b => b.dataset.blockId === id);

      // Apply saved hidden state
      getHidden().forEach(id => { const b = blockById(id); if (b) b.style.display = 'none'; });

      let dragSrc = null;
      Array.from(body.children).forEach(block => {
        if (!block.dataset.blockId) return;
        // Skip empty insight placeholders (no content rendered)
        if (!block.firstElementChild && !block.textContent.trim()) return;
        block.style.position = block.style.position || 'relative';

        // Add a drag handle (once)
        if (!block.querySelector('.si-drag-handle')) {
          const h = document.createElement('div');
          h.className = 'si-drag-handle';
          h.title = 'Drag to reorder';
          h.textContent = '⠿';
          h.setAttribute('draggable', 'true');
          // Shift left when the block has a settings gear so they don't overlap
          const hasGear = block.querySelector('[id$="-settings-btn"]');
          const rightOff = hasGear ? 32 : 8;
          h.style.cssText = `position:absolute;top:6px;right:${rightOff}px;z-index:6;cursor:grab;color:#475569;font-size:14px;line-height:1;padding:2px 4px;border-radius:4px;user-select:none`;
          h.onmouseover = () => h.style.color = '#94a3b8';
          h.onmouseout  = () => h.style.color = '#475569';
          h.addEventListener('dragstart', e => {
            dragSrc = block;
            h.style.cursor = 'grabbing';
            setTimeout(() => block.style.opacity = '0.4', 0);
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', block.dataset.blockId);
          });
          h.addEventListener('dragend', () => {
            h.style.cursor = 'grab';
            block.style.opacity = '';
            Array.from(body.children).forEach(c => c.classList.remove('si-drag-over'));
          });
          block.appendChild(h);

          // Hide button (✕) — sits just left of the drag handle
          const x = document.createElement('div');
          x.className = 'si-hide-btn';
          x.title = 'Hide this chart';
          x.textContent = '✕';
          x.style.cssText = `position:absolute;top:6px;right:${rightOff + 22}px;z-index:6;cursor:pointer;color:#475569;font-size:13px;line-height:1;padding:2px 4px;border-radius:4px;user-select:none`;
          x.onmouseover = () => x.style.color = '#f87171';
          x.onmouseout  = () => x.style.color = '#475569';
          x.onclick = e => {
            e.stopPropagation();
            block.style.display = 'none';
            const hid = getHidden();
            if (!hid.includes(block.dataset.blockId)) { hid.push(block.dataset.blockId); saveHidden(hid); }
            buildToolbar();
          };
          block.appendChild(x);
        }

        block.addEventListener('dragover', e => {
          if (!dragSrc || dragSrc === block) return;
          e.preventDefault();
          block.classList.add('si-drag-over');
        });
        block.addEventListener('dragleave', () => block.classList.remove('si-drag-over'));
        block.addEventListener('drop', e => {
          e.preventDefault();
          e.stopPropagation();
          block.classList.remove('si-drag-over');
          if (!dragSrc || dragSrc === block) return;
          // Insert dragSrc before or after target based on pointer position
          const rect = block.getBoundingClientRect();
          const after = (e.clientY - rect.top) > rect.height / 2;
          body.insertBefore(dragSrc, after ? block.nextSibling : block);
          persist();
        });
      });

      // ── Toolbar: unhide chips + reset order (top of tab) ─────────────────
      function buildToolbar() {
        let bar = document.getElementById('si-block-toolbar');
        if (!bar) {
          bar = document.createElement('div');
          bar.id = 'si-block-toolbar';
          bar.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 10px 0';
          body.insertBefore(bar, body.firstElementChild);
        }
        bar.innerHTML = '';

        const hidden = getHidden().filter(id => blockById(id));
        if (hidden.length) {
          const lbl = document.createElement('span');
          lbl.textContent = 'Hidden:';
          lbl.style.cssText = 'font-size:10px;color:#64748b;letter-spacing:.3px';
          bar.appendChild(lbl);
          hidden.forEach(id => {
            const chip = document.createElement('button');
            chip.innerHTML = `👁 ${blockLabel(blockById(id))}`;
            chip.title = 'Click to unhide';
            chip.style.cssText = 'background:#1e293b;border:1px solid #334155;border-radius:12px;color:#94a3b8;font-size:10px;cursor:pointer;padding:3px 10px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
            chip.onmouseover = () => { chip.style.borderColor = '#3b82f6'; chip.style.color = '#cbd5e1'; };
            chip.onmouseout  = () => { chip.style.borderColor = '#334155'; chip.style.color = '#94a3b8'; };
            chip.onclick = () => {
              const b = blockById(id);
              if (b) b.style.display = '';
              saveHidden(getHidden().filter(x => x !== id));
              buildToolbar();
            };
            bar.appendChild(chip);
          });
        }

        const spacer = document.createElement('span');
        spacer.style.cssText = 'flex:1';
        bar.appendChild(spacer);

        const reset = document.createElement('button');
        reset.textContent = '↺ Reset layout';
        reset.style.cssText = 'background:none;border:1px solid #334155;border-radius:5px;color:#64748b;font-size:10px;cursor:pointer;padding:3px 8px';
        reset.onmouseover = () => reset.style.color = '#94a3b8';
        reset.onmouseout  = () => reset.style.color = '#64748b';
        reset.onclick = () => {
          localStorage.removeItem(storageKey);
          localStorage.removeItem(hiddenKey);
          ScreenerInsights.charts.destroyAll();
          if (redraw) redraw();
        };
        bar.appendChild(reset);
      }
      buildToolbar();
    };

    // Cumulative Summary table — shared by Cash Flow & Efficiency tabs
    const renderCumTable = (boxId) => {
      const box = document.getElementById(boxId);
      if (!box || !d.cashFlow) return;
      const cfD = d.cashFlow.data;
      const yrs = tail(d.cashFlow.headers, N);
      const n   = yrs.length;

      const alignTo = (headers, row) => row ? yrs.map(yr => {
        const i = (headers || []).indexOf(yr);
        return i >= 0 ? (row[i] ?? null) : null;
      }) : Array(n).fill(null);

      const sales = d.pnl ? alignTo(d.pnl.headers, findRowLocal(d.pnl.data,'Sales','Revenue','Net Sales','Total Revenue','Revenue from Operations')) : Array(n).fill(null);
      const pat   = d.pnl ? alignTo(d.pnl.headers, findRowLocal(d.pnl.data,'Net Profit','Profit after tax','PAT')) : Array(n).fill(null);
      const cfo   = tail(findRowLocal(cfD,'Cash from Operating Activity')||[], n);

      let capex = Array(n).fill(null);
      if (d.balanceSheet && d.pnl) {
        const bsH  = d.balanceSheet.headers;
        const nfa  = findRowLocal(d.balanceSheet.data,'Fixed Assets','Net Fixed Assets','Tangible Assets','Property Plant Equipment');
        const cwip = findRowLocal(d.balanceSheet.data,'Capital Work in Progress','CWIP','Capital WIP','Capital work-in-progress');
        const dep  = findRowLocal(d.pnl.data,'Depreciation','Amortisation','Depreciation & Amortisation','D&A');
        if (nfa) {
          capex = yrs.map(yr => {
            const ai = bsH.indexOf(yr);
            if (ai < 1) return null;
            const nfaEnd = nfa[ai] ?? 0, nfaStart = nfa[ai-1] ?? 0;
            const cwipEnd = cwip ? (cwip[ai] ?? 0) : 0, cwipStart = cwip ? (cwip[ai-1] ?? 0) : 0;
            const pi = (d.pnl.headers||[]).indexOf(yr);
            const depVal = dep && pi >= 0 ? (dep[pi] ?? 0) : 0;
            return parseFloat(((nfaEnd + cwipEnd) - (nfaStart + cwipStart) + depVal).toFixed(1));
          });
        }
      }
      const fcf = yrs.map((_, i) => (cfo[i] == null || capex[i] == null) ? null : parseFloat((cfo[i] - capex[i]).toFixed(1)));
      const debt = d.balanceSheet ? alignTo(d.balanceSheet.headers, findRowLocal(d.balanceSheet.data,'Borrowings','Total Debt')) : Array(n).fill(null);

      const sum = arr => { const v = arr.filter(x => x != null); return v.length ? v.reduce((a,b)=>a+b,0) : null; };
      const fmt = v => v == null ? '—' : Math.round(v).toLocaleString('en-IN');
      const cell = (v, neg) => `<td class="${v != null && v < 0 ? 'si-neg' : ''}" style="padding:5px 10px;text-align:right;white-space:nowrap">${neg && v != null && v < 0 ? `(${fmt(Math.abs(v))})` : fmt(v)}</td>`;
      const totCell = v => `<td class="${v == null ? '' : v < 0 ? 'si-neg' : 'si-pos-total'}" style="padding:5px 10px;text-align:right;white-space:nowrap;font-weight:700;background:#0f172a">${v != null && v < 0 ? `(${fmt(Math.abs(v))})` : fmt(v)}</td>`;

      const rowHtml = (label, arr, opts={}) => {
        const cells = arr.map(v => cell(v, true)).join('');
        const total = opts.noTotal ? `<td style="background:#0f172a"></td>` : totCell(sum(arr));
        return `<tr>
          <td style="padding:5px 12px;color:#94a3b8;font-weight:600;white-space:nowrap;position:sticky;left:0;background:#1e293b">${label}</td>
          ${cells}${total}</tr>`;
      };

      const headCells = yrs.map(y => `<th style="padding:6px 10px;text-align:right;color:#64748b;white-space:nowrap;position:sticky;top:0;background:#1e293b">${y}</th>`).join('');
      const periodLbl = `Total ${yrs.length} Yrs`;

      box.innerHTML = `
        <div class="si-chart-label">Cumulative Summary — Sales / PAT / CFO / Capex / FCF (₹ Cr)</div>
        <div class="si-table-wrap" style="overflow:auto;max-height:340px">
          <table class="si-table" style="width:100%;border-collapse:collapse;font-size:11px">
            <thead><tr>
              <th style="padding:6px 12px;text-align:left;color:#cbd5e1;position:sticky;left:0;top:0;background:#1e293b;z-index:2">Narration</th>
              ${headCells}
              <th style="padding:6px 10px;text-align:right;color:#cbd5e1;white-space:nowrap;position:sticky;top:0;background:#0f172a">${periodLbl}</th>
            </tr></thead>
            <tbody>
              ${rowHtml('Sales', sales)}
              ${rowHtml('Net Profit (PAT)', pat)}
              ${rowHtml('Cash from Operations (CFO)', cfo)}
              ${rowHtml('Capex (NFA+WIP Δ+Dep)', capex)}
              ${rowHtml('Free Cash Flow (FCF)', fcf)}
              ${rowHtml('Total Debt', debt, { noTotal: true })}
            </tbody>
          </table>
        </div>
        <div style="margin-top:6px;font-size:10px;color:#64748b">Total column = cumulative sum across the period (flows only). Total Debt is a point-in-time balance, so it is not summed. Negative values shown in red / parentheses.</div>`;
    };

    if (tab === 'overview' && d.shareholding) {
      const sh   = d.shareholding;
      const shN  = Math.min(12, sh.headers.length);  // last 12 quarters
      const shYr = tail(sh.headers, shN);
      const n    = shYr.length;

      const shGet = (...terms) => {
        for (const t of terms) {
          for (const [k, v] of Object.entries(sh.data)) {
            if (k.toLowerCase().includes(t.toLowerCase())) return tail(v || [], n);
          }
        }
        return Array(n).fill(null);
      };

      // shGet: skip values >100 (those are share counts, not percentages)
      const shGetPct = (...terms) => {
        for (const t of terms) {
          for (const [k, v] of Object.entries(sh.data)) {
            if (!k.toLowerCase().includes(t.toLowerCase())) continue;
            const cleaned = (v || []).map(x => (x != null && x <= 100) ? x : null);
            if (cleaned.some(x => x != null)) return tail(cleaned, n);
          }
        }
        return Array(n).fill(null);
      };

      const promoters = shGetPct('Promoters', 'Promoter');
      const fiis      = shGetPct('FII', 'Foreign');
      const diis      = shGetPct('DII', 'Domestic');

      // Pledge: prefer the scraper-resolved __pledgePct__ key
      let pledge = sh.data['__pledgePct__'] ? tail(sh.data['__pledgePct__'], n) : null;
      if (!pledge || pledge.every(v => v == null)) pledge = shGetPct('Pledged', 'Pledge');

      line('si-c-promoter-trend', shYr, [
        { label: 'Promoters %', data: promoters, color: C.blue   },
        { label: 'FII %',       data: fiis,      color: C.green  },
        { label: 'DII %',       data: diis,      color: C.orange },
      ], { options: { scales: { y: { min: 0, ticks: { callback: v => v + '%' } } } } });

      const hasAnyPledge = pledge && pledge.some(v => v != null && v > 0);
      if (hasAnyPledge) {
        bar('si-c-pledge-trend', shYr, [
          { label: 'Pledge %', data: pledge, color: C.red, colorA: C.redA },
        ], { options: { scales: { y: { min: 0, ticks: { callback: v => v + '%' } } } } });
      } else {
        line('si-c-pledge-trend', shYr, [
          { label: 'Pledge %', data: Array(n).fill(0), color: C.green, fill: true },
        ], { options: { scales: { y: { min: 0, max: 5, ticks: { callback: v => v + '%' } } } } });
      }

      // Shareholding doughnut chart
      (() => {
        const getNum = (...terms) => {
          for (const t of terms) {
            for (const [k, v] of Object.entries(sh.data)) {
              if (!k.toLowerCase().includes(t.toLowerCase()) || !Array.isArray(v)) continue;
              const last = [...v].reverse().find(x => x != null && x <= 100);
              if (last != null) return last;
            }
          }
          return 0;
        };
        const prom   = getNum('Promoters', 'Promoter');
        const fii    = getNum('FII', 'Foreign');
        const dii    = getNum('DII', 'Domestic');
        const pub    = getNum('Public');
        const others = Math.max(0, parseFloat((100 - prom - fii - dii - pub).toFixed(1)));
        make('si-c-sh-donut', {
          type: 'doughnut',
          data: {
            labels: ['Promoters', 'FII', 'DII', 'Public', 'Others'],
            datasets: [{
              data: [prom, fii, dii, pub, others],
              backgroundColor: ['#6366f1', '#22d3ee', '#34d399', '#f59e0b', '#94a3b8'],
              borderColor: '#1e293b',
              borderWidth: 2,
              hoverOffset: 6,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '68%',
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: { label: ctx => ` ${ctx.label}: ${ctx.parsed.toFixed(1)}%` }
              },
            },
          },
        });
      })();

      // Price + Volume chart (1Y daily data)
      if (d.deliveryData && d.deliveryData.length) {
        const raw    = d.deliveryData;
        const dDates = raw.map(p => p.date);
        const prices = raw.map(p => p.price);
        const vols   = raw.map(p => p.volume);
        // Format volume to k/M for Y-axis labels
        const fmtVol = v => v >= 1e7 ? (v/1e7).toFixed(1)+'Cr' : v >= 1e5 ? (v/1e5).toFixed(0)+'L' : v >= 1e3 ? (v/1e3).toFixed(0)+'k' : v;
        // Color volume bars by delivery % using saved RAG thresholds
        const { green: DG, amber: DA } = getDelThresholds();
        updateDelLegend(DG, DA);
        // Pre-populate settings inputs
        const gi = document.getElementById('si-del-green'); if (gi) gi.value = DG;
        const ai = document.getElementById('si-del-amber'); if (ai) ai.value = DA;
        const ri = document.getElementById('si-del-red-lbl'); if (ri) ri.value = DA;
        // Wire up settings popup toggle
        const btn = document.getElementById('si-del-settings-btn');
        const pop = document.getElementById('si-del-settings-popup');
        if (btn && pop) {
          btn.onclick = () => { pop.style.display = pop.style.display === 'none' ? 'block' : 'none'; };
          document.getElementById('si-del-save').onclick = () => {
            const ng = parseInt(document.getElementById('si-del-green').value) || DG;
            const na = parseInt(document.getElementById('si-del-amber').value) || DA;
            if (ng > na && na > 0) {
              saveDelThresholds(ng, na);
              pop.style.display = 'none';
              ScreenerInsights.charts.destroyAll();
              renderCharts('overview', d);
            }
          };
          document.getElementById('si-del-reset').onclick = () => {
            localStorage.removeItem(DEL_KEY);
            pop.style.display = 'none';
            ScreenerInsights.charts.destroyAll();
            renderCharts('overview', d);
          };
        }
        const vbg = raw.map(p => p.pct == null ? 'rgba(100,116,139,0.3)'  : p.pct >= DG ? 'rgba(52,211,153,0.35)' : p.pct >= DA ? 'rgba(251,191,36,0.25)' : 'rgba(248,113,113,0.3)');
        const vbc = raw.map(p => p.pct == null ? 'rgba(100,116,139,0.55)' : p.pct >= DG ? 'rgba(52,211,153,0.7)'  : p.pct >= DA ? 'rgba(251,191,36,0.6)'  : 'rgba(248,113,113,0.6)');
        make('si-c-price-vol', {
          type: 'bar',
          data: {
            labels: dDates,
            datasets: [
              {
                type: 'bar',
                label: 'Volume',
                data: vols,
                backgroundColor: vbg,
                borderColor: vbc,
                borderWidth: 0,
                yAxisID: 'yVol',
              },
              {
                type: 'line',
                label: 'Price (₹)',
                data: prices,
                borderColor: '#818cf8',
                backgroundColor: 'transparent',
                borderWidth: 1.5,
                pointRadius: 0,
                tension: 0.2,
                yAxisID: 'yPrice',
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
              legend: { display: true, labels: { color: '#94a3b8', font: { size: 10 } } },
              tooltip: {
                callbacks: {
                  label: ctx => ctx.dataset.label === 'Volume'
                    ? ` Vol: ${fmtVol(ctx.parsed.y)}`
                    : ` ₹${ctx.parsed.y?.toFixed(2)}`,
                },
              },
            },
            scales: {
              x: { ticks: { color: '#64748b', font: { size: 9 }, maxTicksLimit: 10, maxRotation: 0, autoSkip: true }, grid: { color: 'rgba(255,255,255,0.04)' } },
              yVol: {
                position: 'left',
                ticks: { color: '#64748b', font: { size: 9 }, callback: fmtVol, maxTicksLimit: 5 },
                grid: { color: 'rgba(255,255,255,0.04)' },
              },
              yPrice: {
                position: 'right',
                ticks: { color: '#818cf8', font: { size: 9 }, maxTicksLimit: 5 },
                grid: { drawOnChartArea: false },
              },
            },
          },
        });
      }

      // Delivery % trend chart (1Y daily data)
      if (d.deliveryData && d.deliveryData.length) {
        const raw    = d.deliveryData;
        const dDates = raw.map(p => p.date);
        const dPcts  = raw.map(p => p.pct);
        // Compute 20-point moving average for trend line
        const ma = dPcts.map((_, i) => {
          const w = dPcts.slice(Math.max(0, i - 19), i + 1);
          return parseFloat((w.reduce((a, b) => a + b, 0) / w.length).toFixed(1));
        });
        // Color daily bars using saved RAG thresholds
        const { green: dG, amber: dA } = getDelThresholds();
        const dbg = dPcts.map(v => v >= dG ? C.greenA : v >= dA ? 'rgba(251,191,36,0.25)' : C.redA);
        const dbc = dPcts.map(v => v >= dG ? C.green  : v >= dA ? 'rgba(251,191,36,0.85)' : C.red);
        make('si-c-delivery', {
          type: 'bar',
          data: {
            labels: dDates,
            datasets: [
              {
                type: 'bar',
                label: 'Delivery %',
                data: dPcts,
                backgroundColor: dbg,
                borderColor: dbc,
                borderWidth: 1,
                borderRadius: 2,
                borderSkipped: false,
              },
              {
                type: 'line',
                label: '20D Avg',
                data: ma,
                borderColor: C.blue,
                backgroundColor: 'transparent',
                borderWidth: 1.5,
                pointRadius: 0,
                tension: 0.3,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: true, labels: { color: '#94a3b8', font: { size: 10 } } },
              tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y}%` } },
            },
            scales: {
              x: { ticks: { color: '#64748b', font: { size: 9 }, maxTicksLimit: 10, maxRotation: 0, autoSkip: true }, grid: { color: 'rgba(255,255,255,0.04)' } },
              y: { min: 0, max: 100, ticks: { color: '#64748b', font: { size: 9 }, callback: v => v + '%' }, grid: { color: 'rgba(255,255,255,0.04)' } },
            },
          },
        });

        // ── Delivery signal note ────────────────────────────────────────────
        (() => {
          const WIN = 20; // recent window
          const n   = raw.length;
          if (n < WIN + 5) return;

          const avg  = v => v.reduce((a, b) => a + b, 0) / v.length;
          const recent = raw.slice(-WIN);
          const older  = raw.slice(0, n - WIN);

          const recentDelPct  = avg(recent.map(p => p.pct));
          const historDelPct  = avg(older.map(p => p.pct));
          const fullAvgDel    = avg(raw.map(p => p.pct));

          const recentVols    = recent.map(p => p.volume).filter(Boolean);
          const olderVols     = older.map(p => p.volume).filter(Boolean);
          const recentVolAvg  = recentVols.length ? avg(recentVols) : null;
          const olderVolAvg   = olderVols.length  ? avg(olderVols)  : null;

          const recentPrices  = recent.map(p => p.price).filter(Boolean);
          const olderPrices   = older.map(p => p.price).filter(Boolean);
          const priceNow      = recentPrices[recentPrices.length - 1];
          const pricePast     = olderPrices[0];

          const delHigh   = recentDelPct >= historDelPct * 1.1;   // 10% above hist avg
          const delLow    = recentDelPct <= historDelPct * 0.9;
          const priceUp   = priceNow && pricePast && priceNow > pricePast * 1.02;
          const priceDown = priceNow && pricePast && priceNow < pricePast * 0.98;
          const volUp     = recentVolAvg && olderVolAvg && recentVolAvg > olderVolAvg * 1.15;
          const volDown   = recentVolAvg && olderVolAvg && recentVolAvg < olderVolAvg * 0.85;

          // Latest single-day spike check (last day vs full avg)
          const lastDayDel = raw[n - 1]?.pct ?? 0;
          const spikeToday = lastDayDel >= fullAvgDel * 1.4 && lastDayDel >= 60;

          let signal, color, icon, detail;

          if (delHigh && priceUp && volUp) {
            signal = 'Strong Accumulation';
            color  = '#34d399'; icon = '▲';
            detail = `Delivery % is running ${recentDelPct.toFixed(0)}% (vs ${historDelPct.toFixed(0)}% historically) with rising price and higher-than-usual volume. Real money is building positions with conviction — the move has genuine depth.`;
          } else if (delHigh && priceUp) {
            signal = 'Accumulation';
            color  = '#34d399'; icon = '▲';
            detail = `Delivery % of ${recentDelPct.toFixed(0)}% is above historical average (${historDelPct.toFixed(0)}%) and price is rising. Buyers are taking delivery — this is conviction-based buying, not just speculative churn.`;
          } else if (delLow && priceUp) {
            signal = 'Speculative Rally';
            color  = '#f59e0b'; icon = '⚠';
            detail = `Price is rising but delivery % (${recentDelPct.toFixed(0)}%) is below the historical average (${historDelPct.toFixed(0)}%). The move is largely intraday/momentum-driven. Weak hands — watch for a sharp reversal if the momentum fades.`;
          } else if (delHigh && priceDown) {
            signal = 'Distribution / Exit';
            color  = '#f87171'; icon = '▼';
            detail = `High delivery % (${recentDelPct.toFixed(0)}% vs ${historDelPct.toFixed(0)}% avg) with falling price indicates genuine distribution. Long-term holders are exiting — this is more serious than normal intraday selling and may signal sustained weakness.`;
          } else if (delLow && priceDown && volUp) {
            signal = 'Panic Selling';
            color  = '#f87171'; icon = '▼';
            detail = `Falling price, elevated volume but low delivery (${recentDelPct.toFixed(0)}%) suggests panic intraday trading. Most sellers aren't delivering, which could mean the fall is exaggerated and may see a technical bounce.`;
          } else if (spikeToday) {
            signal = 'Delivery Spike Today';
            color  = '#a78bfa'; icon = '★';
            detail = `Today's delivery % spiked to ${lastDayDel}% against a 1-year average of ${fullAvgDel.toFixed(0)}%. A sharp one-day delivery surge in a relatively quiet stock often signals that a large investor is building or exiting a real position — worth investigating.`;
          } else if (delHigh) {
            signal = 'Healthy Delivery';
            color  = '#34d399'; icon = '●';
            detail = `Recent delivery % (${recentDelPct.toFixed(0)}%) is running above the historical average (${historDelPct.toFixed(0)}%). Participants are holding their purchases — a sign of steady underlying demand without a strong directional trigger yet.`;
          } else if (delLow) {
            signal = 'Low Conviction';
            color  = '#f59e0b'; icon = '●';
            detail = `Delivery % (${recentDelPct.toFixed(0)}%) has slipped below historical levels (${historDelPct.toFixed(0)}%). Trading is dominated by intraday activity. Until delivery improves, price moves in either direction may lack sustained follow-through.`;
          } else {
            signal = 'Neutral';
            color  = '#94a3b8'; icon = '→';
            detail = `Delivery % is in line with historical norms (${recentDelPct.toFixed(0)}% recent vs ${historDelPct.toFixed(0)}% avg). No standout accumulation or distribution signal at this time.`;
          }

          const noteEl = document.getElementById('si-delivery-note');
          if (!noteEl) return;
          noteEl.innerHTML = `
            <span class="si-dn-icon" style="color:${color}">${icon}</span>
            <span class="si-dn-signal" style="color:${color}">${signal}</span>
            <span class="si-dn-sep">·</span>
            <span class="si-dn-detail">${detail}</span>`;
        })();
      }
      (() => { return;
        const CARD_ORDER_KEY = 'si_card_order';
        const panel = document.getElementById('si-panel-content');
        if (!panel) return;

        // Restore saved order
        const savedOrder = (() => {
          try { return JSON.parse(localStorage.getItem(CARD_ORDER_KEY) || '[]'); } catch(_) { return []; }
        })();
        if (savedOrder.length) {
          const allGrids = Array.from(panel.querySelectorAll('.si-grid'));
          // Collect all cards across all grids into a flat map
          const cardMap = {};
          allGrids.forEach(g => {
            Array.from(g.querySelectorAll('.si-card')).forEach(c => {
              if (c.dataset.cardId) cardMap[c.dataset.cardId] = c;
            });
          });
          // Re-insert in saved order: each entry = {id, gridIndex}
          savedOrder.forEach(({ id, gridIndex }) => {
            const card = cardMap[id];
            const grid = allGrids[gridIndex];
            if (card && grid) grid.appendChild(card);
          });
        }

        // Wire up drag-and-drop on all cards
        let dragSrc = null;
        panel.querySelectorAll('.si-card[draggable]').forEach(card => {
          card.addEventListener('dragstart', e => {
            dragSrc = card;
            card.style.opacity = '0.4';
            e.dataTransfer.effectAllowed = 'move';
          });
          card.addEventListener('dragend', () => {
            card.style.opacity = '';
            panel.querySelectorAll('.si-card').forEach(c => c.classList.remove('si-drag-over'));
          });
          card.addEventListener('dragover', e => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (card !== dragSrc) card.classList.add('si-drag-over');
          });
          card.addEventListener('dragleave', () => card.classList.remove('si-drag-over'));
          card.addEventListener('drop', e => {
            e.preventDefault();
            card.classList.remove('si-drag-over');
            if (!dragSrc || dragSrc === card) return;
            const srcParent = dragSrc.parentNode;
            const tgtParent = card.parentNode;
            // Swap positions: insert dragSrc before card, insert card before dragSrc's old next sibling
            const srcNext = dragSrc.nextSibling;
            tgtParent.insertBefore(dragSrc, card);
            if (srcNext) srcParent.insertBefore(card, srcNext);
            else srcParent.appendChild(card);
            // Persist order
            const allGrids = Array.from(panel.querySelectorAll('.si-grid'));
            const order = [];
            allGrids.forEach((g, gi) => {
              Array.from(g.querySelectorAll('.si-card')).forEach(c => {
                if (c.dataset.cardId) order.push({ id: c.dataset.cardId, gridIndex: gi });
              });
            });
            localStorage.setItem(CARD_ORDER_KEY, JSON.stringify(order));
          });
        });

        // Add reset button to first section head for overview
        const firstHead = panel.querySelector('.si-section-head');
        if (firstHead && !firstHead.querySelector('.si-card-reset-btn')) {
          const btn = document.createElement('button');
          btn.className = 'si-card-reset-btn';
          btn.title = 'Reset card layout';
          btn.textContent = '↺ Reset Layout';
          btn.style.cssText = 'margin-left:auto;background:none;border:none;color:#475569;font-size:9px;cursor:pointer;padding:0 4px;letter-spacing:.3px';
          btn.onmouseover = () => btn.style.color = '#94a3b8';
          btn.onmouseout  = () => btn.style.color = '#475569';
          btn.onclick = () => {
            localStorage.removeItem(CARD_ORDER_KEY);
            ScreenerInsights.charts.destroyAll();
            renderCharts('overview', d);
          };
          firstHead.style.display = 'flex';
          firstHead.appendChild(btn);
        }
      })();
    }

    if (tab === 'overview') {
      // ── Card drag-and-drop ────────────────────────────────────────────────
      // v2: cards are keyed to a STABLE grid id (data-grid-id), not a positional
      // index — so adding/removing sections no longer scrambles the layout.
      const CARD_ORDER_KEY = 'si_card_order_v2';
      const panel = document.getElementById('si-body');
      if (panel) {
        const gridById = id => panel.querySelector(`.si-grid[data-grid-id="${id}"]`);
        // Restore saved order
        const savedOrder = (() => {
          try { return JSON.parse(localStorage.getItem(CARD_ORDER_KEY) || '[]'); } catch(_) { return []; }
        })();
        if (savedOrder.length) {
          const cardMap = {};
          panel.querySelectorAll('.si-card').forEach(c => { if (c.dataset.cardId) cardMap[c.dataset.cardId] = c; });
          savedOrder.forEach(({ id, gridId }) => {
            const card = cardMap[id];
            const grid = gridById(gridId);
            // Only relocate cards whose target grid still exists in this render
            if (card && grid) grid.appendChild(card);
          });
        }

        // Wire drag-and-drop
        let dragSrc = null;
        panel.querySelectorAll('.si-card[draggable]').forEach(card => {
          card.addEventListener('dragstart', e => {
            dragSrc = card;
            setTimeout(() => card.style.opacity = '0.4', 0);
            e.dataTransfer.effectAllowed = 'move';
          });
          card.addEventListener('dragend', () => {
            card.style.opacity = '';
            panel.querySelectorAll('.si-card').forEach(c => c.classList.remove('si-drag-over'));
          });
          card.addEventListener('dragover', e => {
            e.preventDefault();
            if (card !== dragSrc) card.classList.add('si-drag-over');
          });
          card.addEventListener('dragleave', () => card.classList.remove('si-drag-over'));
          card.addEventListener('drop', e => {
            e.stopPropagation();
            card.classList.remove('si-drag-over');
            if (!dragSrc || dragSrc === card) return;
            const srcParent = dragSrc.parentNode;
            const tgtParent = card.parentNode;
            const srcNext   = dragSrc.nextSibling === card ? card.nextSibling : dragSrc.nextSibling;
            tgtParent.insertBefore(dragSrc, card);
            if (srcNext) srcParent.insertBefore(card, srcNext);
            else srcParent.appendChild(card);
            // Persist (keyed by stable grid id)
            const order = [];
            panel.querySelectorAll('.si-grid[data-grid-id]').forEach(g => {
              const gridId = g.dataset.gridId;
              g.querySelectorAll('.si-card').forEach(c => {
                if (c.dataset.cardId) order.push({ id: c.dataset.cardId, gridId });
              });
            });
            localStorage.setItem(CARD_ORDER_KEY, JSON.stringify(order));
          });
        });

        // Reset Layout button
        const firstHead = panel.querySelector('.si-section-head');
        if (firstHead && !firstHead.querySelector('.si-card-reset-btn')) {
          const btn = document.createElement('button');
          btn.className = 'si-card-reset-btn';
          btn.textContent = '↺ Reset Layout';
          btn.style.cssText = 'margin-left:auto;background:none;border:none;color:#475569;font-size:9px;cursor:pointer;padding:0 4px';
          btn.onmouseover = () => btn.style.color = '#94a3b8';
          btn.onmouseout  = () => btn.style.color = '#475569';
          btn.onclick = () => {
            localStorage.removeItem(CARD_ORDER_KEY);
            ScreenerInsights.charts.destroyAll();
            switchTab('overview');
          };
          firstHead.style.display = 'flex';
          firstHead.appendChild(btn);
        }
      }
    }

    if (tab === 'pnl' && d.pnl) {
      const yrs   = tail(d.pnl.headers, N);
      const n     = yrs.length;
      const sales = tail(findRowLocal(d.pnl.data,'Sales','Revenue','Net Sales')||[], n);
      const np    = tail(findRowLocal(d.pnl.data,'Net Profit','Profit after tax','PAT')||[], n);
      const opm   = tail(findRowLocal(d.pnl.data,'OPM %')||[], n);
      const npm   = tail(d.derived.npm||[], n);
      const eps   = tail(findRowLocal(d.pnl.data,'EPS in Rs','EPS')||[], n);
      (() => {
        const npBg = np.map(v => v == null ? 'transparent' : v < 0 ? '#f87171' : C.greenA);
        const npBd = np.map(v => v == null ? 'transparent' : v < 0 ? '#ef4444' : C.green);
        make('si-c-rev-np', {
          type: 'bar',
          data: { labels: yrs, datasets: [
            { label: 'Revenue',    data: sales, backgroundColor: C.blueA, borderColor: C.blue, borderWidth: 1, borderRadius: 4, borderSkipped: false },
            { label: 'Net Profit', data: np,    backgroundColor: npBg,    borderColor: npBd,   borderWidth: 1, borderRadius: 4, borderSkipped: false },
          ]},
          options: {
            responsive: true, maintainAspectRatio: false, clip: false, layout: { padding: { left: 6, right: 6 } },
            plugins: { legend: { display: true, labels: { color: '#94a3b8', font: { size: 10 } } }, tooltip: { mode: 'index', intersect: false } },
            scales: {
              x: { ticks: { color: '#64748b', font: { size: 9 }, maxRotation: 45 }, grid: { color: 'rgba(100,116,139,0.08)' }, offset: true },
              y: { ticks: { color: '#64748b', font: { size: 9 } }, grid: { color: 'rgba(100,116,139,0.08)' } },
            },
          },
        });
      })();
      // EPS from quarterly DOM — green if positive, red if negative
      (() => {
        const qTable = document.querySelector('#quarters table');
        let qEps = null, qHdrs = null;
        if (qTable) {
          const ths = Array.from(qTable.querySelectorAll('thead th'));
          qHdrs = ths.slice(1).map(th => th.textContent.trim()).filter(Boolean);
          qTable.querySelectorAll('tbody tr').forEach(tr => {
            const tds = Array.from(tr.querySelectorAll('td'));
            if (tds.length < 2) return;
            const lbl = tds[0].textContent.trim().replace(/\s+/g,' ').toLowerCase();
            if (lbl.includes('eps') || lbl.includes('earning per share')) {
              qEps = tds.slice(1, qHdrs.length + 1).map(td => {
                const v = parseFloat(td.textContent.trim().replace(/[,%\s]/g,''));
                return isNaN(v) ? null : v;
              });
            }
          });
        }
        const labels = qEps ? qHdrs : yrs;
        const data   = qEps || eps;
        const bg     = data.map(v => v == null ? 'transparent' : v < 0 ? '#f87171' : '#34d399');
        const border = data.map(v => v == null ? 'transparent' : v < 0 ? '#ef4444' : '#10b981');
        make('si-c-eps', {
          type: 'bar',
          data: { labels, datasets: [{ label: 'EPS (₹)', data, backgroundColor: bg, borderColor: border, borderWidth: 1.5, borderRadius: 3, borderSkipped: false }] },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: true, labels: { color: '#94a3b8', font: { size: 10 } } }, tooltip: { callbacks: { label: ctx => ` EPS: ₹${ctx.parsed.y}` } } },
            scales: {
              x: { ticks: { color: '#64748b', font: { size: 9 }, maxTicksLimit: 14, maxRotation: 45, autoSkip: true }, grid: { color: 'rgba(255,255,255,0.04)' } },
              y: { ticks: { color: '#64748b', font: { size: 9 }, callback: v => '₹' + v }, grid: { color: 'rgba(255,255,255,0.04)' } },
            },
          },
        });
      })();

      // ── Interest Coverage Ratio — gear popup wiring ──────────────────────
      (() => {
        const btn   = document.getElementById('si-icr-settings-btn');
        const popup = document.getElementById('si-icr-settings-popup');
        const inSafe    = document.getElementById('si-icr-safe');
        const inCaution = document.getElementById('si-icr-caution');
        const inDanger  = document.getElementById('si-icr-danger-lbl');
        if (!btn || !popup || !inSafe || !inCaution) return;

        const syncDanger = () => { inDanger.value = inCaution.value; };

        const t = getIcrThresholds();
        inSafe.value    = t.safe;
        inCaution.value = t.caution;
        syncDanger();

        inCaution.addEventListener('input', syncDanger);

        btn.addEventListener('click', e => {
          e.stopPropagation();
          popup.style.display = popup.style.display === 'none' ? 'block' : 'none';
        });
        document.addEventListener('click', e => {
          if (!popup.contains(e.target) && e.target !== btn) popup.style.display = 'none';
        }, { capture: true });

        document.getElementById('si-icr-save')?.addEventListener('click', () => {
          const s = parseFloat(inSafe.value);
          const c = parseFloat(inCaution.value);
          if (isNaN(s) || isNaN(c) || s <= c) {
            alert('Safe threshold must be greater than Caution threshold.');
            return;
          }
          saveIcrThresholds(s, c);
          popup.style.display = 'none';
          renderCharts('pnl', d);
        });
        document.getElementById('si-icr-reset')?.addEventListener('click', () => {
          localStorage.removeItem(ICR_KEY);
          const def = getIcrThresholds();
          inSafe.value    = def.safe;
          inCaution.value = def.caution;
          syncDanger();
          popup.style.display = 'none';
          renderCharts('pnl', d);
        });
      })();

      // ── Interest Coverage Ratio — read all quarters from live DOM ──────────
      (() => {
        const { safe: ICR_SAFE, caution: ICR_CAUTION } = getIcrThresholds();

        const qSection = document.querySelector('#quarters');
        const qTable   = qSection?.querySelector('table');
        if (!qTable) return;

        const ths     = Array.from(qTable.querySelectorAll('thead th'));
        const qHdrs   = ths.slice(1).map(th => th.textContent.trim()).filter(Boolean);
        const colCount = qHdrs.length;

        const rowMap = {};
        qTable.querySelectorAll('tbody tr').forEach(tr => {
          const tds = Array.from(tr.querySelectorAll('td'));
          if (tds.length < 2) return;
          const lbl = tds[0].textContent.trim().replace(/[+\-↑↓]/g, '').replace(/\s+/g, ' ').trim();
          if (!lbl) return;
          rowMap[lbl] = tds.slice(1, colCount + 1).map(td => {
            const t = td.textContent.trim().replace(/[,%\s]/g, '');
            const n = parseFloat(t);
            return isNaN(n) ? null : n;
          });
        });

        const getRow = (...keys) => {
          for (const k of keys)
            for (const [rk, rv] of Object.entries(rowMap))
              if (rk.toLowerCase().includes(k.toLowerCase())) return rv;
          return null;
        };

        const opProfRow   = getRow('operating profit');
        const interestRow = getRow('interest', 'finance cost');
        if (!opProfRow || !interestRow) return;

        const icr = qHdrs.map((_, i) => {
          const op = opProfRow[i], ir = interestRow[i];
          if (op == null || ir == null || ir <= 0) return null;
          return parseFloat((op / ir).toFixed(2));
        });

        if (!icr.some(v => v != null)) return;

        const refLine = qHdrs.map(() => ICR_SAFE);

        make('si-c-icr', {
          type: 'line',
          data: {
            labels: qHdrs,
            datasets: [
              {
                label: 'ICR (x)',
                data: icr,
                borderColor: '#34d399',
                backgroundColor: 'rgba(52,211,153,0.08)',
                borderWidth: 2,
                pointRadius: 3,
                pointBackgroundColor: icr.map(v => v == null ? 'transparent' : v >= ICR_SAFE ? '#34d399' : v >= ICR_CAUTION ? '#f59e0b' : '#f87171'),
                pointBorderColor: 'transparent',
                tension: 0.3,
                fill: true,
              },
              {
                label: `Min. Safe (${ICR_SAFE}x)`,
                data: refLine,
                borderColor: '#f87171',
                borderWidth: 1.5,
                borderDash: [5, 4],
                pointRadius: 0,
                backgroundColor: 'transparent',
                tension: 0,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: true, labels: { color: '#94a3b8', font: { size: 10 } } },
              tooltip: { callbacks: { label: ctx => ctx.dataset.label === 'ICR (x)' ? ` ICR: ${ctx.parsed.y}x` : ` Threshold: ${ctx.parsed.y}x` } },
            },
            scales: {
              x: { ticks: { color: '#64748b', font: { size: 9 }, maxTicksLimit: 14, maxRotation: 45, autoSkip: true }, grid: { color: 'rgba(255,255,255,0.04)' } },
              y: { min: 0, ticks: { color: '#64748b', font: { size: 9 }, callback: v => v + 'x' }, grid: { color: 'rgba(255,255,255,0.04)' } },
            },
          },
        });
      })();

      // ── Drag-to-reorder charts (P&L tab) ───────────────────────────────────
      setupBlockReorder('si_pnl_block_order', () => switchTab('pnl'));
    }

    if (tab === 'returns') {
      const src = d.ratios || {};
      const yrs = tail(src.headers || d.pnl?.headers || [], N);
      const n   = yrs.length;

      // ── Sales Growth table (YoY % + period CAGR) ───────────────────────────
      (() => {
        const box = document.getElementById('si-sales-growth');
        if (!box || !d.pnl) return;
        const pHdrs = d.pnl.headers || [];
        const salesRaw = findRowLocal(d.pnl.data,
          'Sales', 'Revenue', 'Net Sales', 'Total Revenue', 'Revenue from Operations');
        if (!salesRaw) return;

        // Align sales to the full P&L header sequence
        const pairs = pHdrs.map((yr, i) => ({ yr, val: salesRaw[i] }))
                           .filter(p => p.val != null && !isNaN(p.val));
        if (pairs.length < 2) return;

        const yoy = pairs.map((p, i) => {
          if (i === 0) return null;
          const prev = pairs[i - 1].val;
          if (prev == null || prev === 0) return null;
          return (p.val - prev) / Math.abs(prev) * 100;
        });

        // CAGR over the full available period
        const first = pairs[0], last = pairs[pairs.length - 1];
        const years = pairs.length - 1;
        let cagr = null;
        if (first.val > 0 && last.val > 0 && years > 0)
          cagr = (Math.pow(last.val / first.val, 1 / years) - 1) * 100;

        const fmtV = v => v == null ? '—' : Math.abs(v) >= 1e3 ? (v/1e3).toFixed(1)+'K' : v.toLocaleString('en-IN');
        const col  = v => v == null ? '#64748b' : v < 0 ? '#f87171' : v >= 15 ? '#34d399' : '#fbbf24';
        const fmtP = v => v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;

        const rows = pairs.map((p, i) => `
          <tr>
            <td style="padding:4px 14px;color:#94a3b8;white-space:nowrap">${p.yr}</td>
            <td style="padding:4px 14px;text-align:right;color:#cbd5e1">${fmtV(p.val)}</td>
            <td class="${yoy[i] != null && yoy[i] < 0 ? 'si-neg' : ''}" style="padding:4px 14px;text-align:right;font-weight:600;color:${col(yoy[i])}">${fmtP(yoy[i])}</td>
          </tr>`).join('');

        const cagrCol = cagr == null ? '#64748b' : cagr < 0 ? '#f87171' : cagr >= 15 ? '#34d399' : '#fbbf24';

        box.innerHTML = `
          <div class="si-chart-label">Sales Growth — YoY % &amp; CAGR</div>
          <div style="display:flex;align-items:center;gap:10px;margin:4px 0 10px;padding:8px 14px;background:#0f172a;border-radius:8px">
            <span style="font-size:10px;color:#64748b;letter-spacing:.4px">SALES CAGR (${first.yr} → ${last.yr}, ${years}Y)</span>
            <span style="font-size:18px;font-weight:700;color:${cagrCol}">${cagr == null ? '—' : `${cagr >= 0 ? '+' : ''}${cagr.toFixed(1)}%`}</span>
          </div>
          <div class="si-table-wrap" style="max-height:320px;overflow:auto">
            <table class="si-table" style="width:100%;border-collapse:collapse;font-size:11px">
              <thead><tr>
                <th style="padding:6px 14px;text-align:left;color:#64748b;position:sticky;top:0;background:#1e293b">Year</th>
                <th style="padding:6px 14px;text-align:right;color:#64748b;position:sticky;top:0;background:#1e293b">Sales (₹ Cr)</th>
                <th style="padding:6px 14px;text-align:right;color:#64748b;position:sticky;top:0;background:#1e293b">YoY %</th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>`;
      })();

      renderCumTable('si-cum-table-eff');

      const roce = tail(findRowLocal(src.data||{},'ROCE %','ROCE')||[], n);
      const roe  = tail(findRowLocal(src.data||{},'ROE %','ROE')||d.derived.roe||[], n);
      line('si-c-roe-roce', yrs, [{label:'ROE %',data:roe,color:C.green},{label:'ROCE %',data:roce,color:C.blue}]);

      // ── DuPont decomposition table: ROE = NPM × Asset Turnover × Leverage ──
      (() => {
        const box = document.getElementById('si-dupont');
        if (!box || !d.pnl || !d.balanceSheet) return;
        const bs = d.balanceSheet, bsH = bs.headers || [], pH = d.pnl.headers || [];
        const salesRow = findRowLocal(d.pnl.data,'Sales','Revenue','Net Sales','Total Revenue','Revenue from Operations');
        const patRow   = findRowLocal(d.pnl.data,'Net Profit','Profit after tax','PAT');
        const faRow    = findRowLocal(bs.data,'Fixed Assets','Net Fixed Assets','Tangible Assets','Property Plant Equipment');
        const capRow   = findRowLocal(bs.data,'Equity Share Capital','Equity Capital','Share Capital');
        const resRow   = findRowLocal(bs.data,'Reserves','Reserves and Surplus','Other Equity');
        if (!salesRow || !patRow || !faRow) return;

        const pVal = (row, yr) => { const i = pH.indexOf(yr); return i >= 0 ? (row[i] ?? null) : null; };
        // Average of current & previous year for balance-sheet items
        const avgBS = (row, yr) => {
          if (!row) return null;
          const ai = bsH.indexOf(yr);
          if (ai < 0 || row[ai] == null) return null;
          const prev = ai > 0 ? row[ai - 1] : null;
          return prev != null ? (row[ai] + prev) / 2 : row[ai];
        };

        const recs = yrs.map(yr => {
          const sales = pVal(salesRow, yr);
          const pat   = pVal(patRow, yr);
          const avgFA = avgBS(faRow, yr);
          const cap = avgBS(capRow, yr), res = avgBS(resRow, yr);
          const avgEq = (cap != null || res != null) ? (cap || 0) + (res || 0) : null;
          const npm = (sales && pat != null) ? pat / sales : null;          // decimal
          const at  = (avgFA && sales != null) ? sales / avgFA : null;      // x
          const fl  = (avgEq && avgFA != null) ? avgFA / avgEq : null;      // x
          const roeV = (npm != null && at != null && fl != null) ? npm * at * fl * 100 : null; // %
          return { roe: roeV, npm: npm != null ? npm * 100 : null, at, fl };
        });

        const fmtPct = v => v == null ? '—' : `${v.toFixed(1)}%`;
        const fmtX   = v => v == null ? '—' : `${v.toFixed(2)}x`;
        const cls    = v => v != null && v < 0 ? 'si-neg' : '';
        const rowHtml = (label, vals, fmt, bold) => `
          <tr>
            <td style="padding:5px 12px;color:#94a3b8;font-weight:${bold?700:600};white-space:nowrap;position:sticky;left:0;background:#1e293b">${label}</td>
            ${recs.map(r => `<td class="${cls(r[vals])}" style="padding:5px 10px;text-align:right;white-space:nowrap;${bold?'font-weight:700;':''}">${fmt(r[vals])}</td>`).join('')}
          </tr>`;

        const headCells = yrs.map(y => `<th style="padding:6px 10px;text-align:right;color:#64748b;white-space:nowrap;position:sticky;top:0;background:#1e293b">${y}</th>`).join('');

        box.innerHTML = `
          <div style="font-size:10px;color:#64748b;letter-spacing:.4px;margin:10px 0 5px">DUPONT: ROE = NPM × ASSET TURNOVER × FINANCIAL LEVERAGE</div>
          <div class="si-table-wrap" style="overflow:auto;max-height:300px">
            <table class="si-table" style="width:100%;border-collapse:collapse;font-size:11px">
              <thead><tr>
                <th style="padding:6px 12px;text-align:left;color:#cbd5e1;position:sticky;left:0;top:0;background:#1e293b;z-index:2">Component</th>
                ${headCells}
              </tr></thead>
              <tbody>
                ${rowHtml('ROE (PAT/Equity)', 'roe', fmtPct, true)}
                ${rowHtml('NPM (PAT/Sales)', 'npm', fmtPct, false)}
                ${rowHtml('Asset Turnover (Sales/Assets)', 'at', fmtX, false)}
                ${rowHtml('Financial Leverage (Assets/Equity)', 'fl', fmtX, false)}
              </tbody>
            </table>
          </div>
          <div style="margin-top:6px;font-size:10px;color:#64748b">Assets = Net Fixed Assets; Assets &amp; Equity use the average of the current and previous year. Equity = Equity Capital + Reserves. ROE shown is the product of the three components.</div>`;
      })();

      // ── OPM % & Net Margin % chart (moved from P&L tab) ────────────────────
      (() => {
        if (!d.pnl) return;
        const pYrs = tail(d.pnl.headers, N);
        const opm  = tail(findRowLocal(d.pnl.data,'OPM %')||[], pYrs.length);
        const npm  = tail(d.derived.npm||[], pYrs.length);

        // gear popup wiring
        const btn   = document.getElementById('si-opm-settings-btn');
        const popup = document.getElementById('si-opm-settings-popup');
        const inGood = document.getElementById('si-opm-good');
        const inZero = document.getElementById('si-opm-zero');
        if (btn && popup && inGood && inZero) {
          const t = getOpmThresholds();
          inGood.value = t.good;
          inZero.value = t.zero;
          btn.addEventListener('click', e => {
            e.stopPropagation();
            popup.style.display = popup.style.display === 'none' ? 'block' : 'none';
          });
          document.addEventListener('click', e => {
            if (!popup.contains(e.target) && e.target !== btn) popup.style.display = 'none';
          }, { capture: true });
          document.getElementById('si-opm-save')?.addEventListener('click', () => {
            const g = parseFloat(inGood.value), z = parseFloat(inZero.value);
            if (isNaN(g) || isNaN(z)) { alert('Please enter valid numbers.'); return; }
            saveOpmThresholds(g, z);
            popup.style.display = 'none';
            renderCharts('returns', d);
          });
          document.getElementById('si-opm-reset')?.addEventListener('click', () => {
            localStorage.removeItem(OPM_KEY);
            const def = getOpmThresholds();
            inGood.value = def.good; inZero.value = def.zero;
            popup.style.display = 'none';
            renderCharts('returns', d);
          });
        }

        const { good: OPM_GOOD, zero: OPM_ZERO } = getOpmThresholds();
        make('si-c-margins', {
          type: 'line',
          data: {
            labels: pYrs,
            datasets: [
              { label:'OPM %',  data:opm, borderColor:C.orange, backgroundColor:'transparent', borderWidth:2, pointRadius:2, tension:0.3 },
              { label:'NPM %',  data:npm, borderColor:C.cyan,   backgroundColor:'transparent', borderWidth:2, pointRadius:2, tension:0.3 },
              { label:`${OPM_GOOD}% (OPM target)`, data:pYrs.map(()=>OPM_GOOD), borderColor:'rgba(52,211,153,0.5)', backgroundColor:'transparent', borderWidth:1, borderDash:[5,4], pointRadius:0 },
              { label:`${OPM_ZERO}% (breakeven)`,  data:pYrs.map(()=>OPM_ZERO),  borderColor:'rgba(248,113,113,0.5)', backgroundColor:'transparent', borderWidth:1, borderDash:[5,4], pointRadius:0 },
            ],
          },
          options: {
            responsive:true, maintainAspectRatio:false,
            plugins: { legend:{ display:true, labels:{ color:'#94a3b8', font:{size:10} } }, tooltip:{ mode:'index', intersect:false } },
            scales: {
              x: { ticks:{ color:'#64748b', font:{size:9}, maxTicksLimit:12, maxRotation:45, autoSkip:true }, grid:{ color:'rgba(255,255,255,0.04)' } },
              y: { ticks:{ color:'#64748b', font:{size:9}, callback: v=>v+'%' }, grid:{ color:'rgba(255,255,255,0.04)' } },
            },
          },
        });
      })();
      const sd = src.data || {};
      const ccc = tail(findRowLocal(sd,'Cash Conversion Cycle')||[], n);
      const invDays   = tail(findRowLocal(sd,'Inventory Days')||[], n);
      const debtorDays = tail(findRowLocal(sd,'Debtor Days')||[], n);
      const payDays    = tail(findRowLocal(sd,'Days Payable')||[], n);
      make('si-c-wc-ratios', {
        type: 'line',
        data: {
          labels: yrs,
          datasets: [
            { label:'Debtor Days',    data:debtorDays, borderColor:C.orange, backgroundColor:'transparent', borderWidth:2, pointRadius:3, pointHoverRadius:5, pointBackgroundColor:C.orange, tension:0.35, spanGaps:true },
            { label:'Inventory Days', data:invDays,    borderColor:C.blue,   backgroundColor:'transparent', borderWidth:2, pointRadius:3, pointHoverRadius:5, pointBackgroundColor:C.blue,   tension:0.35, spanGaps:true },
            { label:'Payable Days',   data:payDays,    borderColor:'rgba(168,85,247,0.45)', backgroundColor:'transparent', borderWidth:2, borderDash:[6,4], pointRadius:3, pointHoverRadius:5, pointBackgroundColor:'rgba(168,85,247,0.45)', tension:0.35, spanGaps:true },
          ],
        },
        options: {
          responsive:true, maintainAspectRatio:false,
          plugins:{ legend:{display:true,labels:{color:'#94a3b8',font:{size:10}}}, tooltip:{mode:'index',intersect:false} },
          scales:{
            x:{ ticks:{color:'#64748b',font:{size:9},maxTicksLimit:12,maxRotation:45,autoSkip:true}, grid:{color:'rgba(255,255,255,0.04)'} },
            y:{ ticks:{color:'#64748b',font:{size:9}}, grid:{color:'rgba(255,255,255,0.04)'} },
          },
        },
      });

      // ── Working Capital Insight ────────────────────────────────────────────
      (() => {
        const el = document.getElementById('si-wc-insight');
        if (!el) return;

        const insights = [];

        // 1. PAT vs CFO — cash conversion quality
        const cumPAT = d.derived?.cumPAT || [];
        const cumCFO = d.derived?.cumCFO || [];
        const patLast = cumPAT[cumPAT.length - 1];
        const cfoLast = cumCFO[cumCFO.length - 1];
        let patCfoFlag = null;
        if (patLast != null && cfoLast != null && patLast !== 0) {
          const ratio = cfoLast / patLast;
          if (ratio < 0.7) {
            const gap = Math.round((patLast - cfoLast) / patLast * 100);
            patCfoFlag = { severity: 'warn', ratio: ratio.toFixed(2), gap };
          } else if (ratio >= 1.0) {
            patCfoFlag = { severity: 'good', ratio: ratio.toFixed(2) };
          } else {
            patCfoFlag = { severity: 'ok', ratio: ratio.toFixed(2) };
          }
        }

        // 2. Inventory days trend — use the MEDIAN of each half so a single
        // one-off spike year (e.g. a large WIP build-up) doesn't distort the read.
        const median = arr => {
          const s = [...arr].sort((a, b) => a - b);
          const m = Math.floor(s.length / 2);
          return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
        };
        const invValid = invDays.filter(v => v != null);
        let invFlag = null;
        if (invValid.length >= 4) {
          const firstHalf = invValid.slice(0, Math.floor(invValid.length / 2));
          const secHalf   = invValid.slice(Math.floor(invValid.length / 2));
          const avg1 = median(firstHalf);
          const avg2 = median(secHalf);
          const chg = ((avg2 - avg1) / avg1 * 100);
          if (chg > 20) invFlag = { trend: 'rising', chg: Math.round(chg), avg1: Math.round(avg1), avg2: Math.round(avg2) };
          else if (chg < -15) invFlag = { trend: 'falling', chg: Math.round(Math.abs(chg)), avg1: Math.round(avg1), avg2: Math.round(avg2) };
          else invFlag = { trend: 'stable' };
        }

        // 3. Debtor / Receivable days trend
        const debValid = debtorDays.filter(v => v != null);
        let debFlag = null;
        if (debValid.length >= 4) {
          const firstHalf = debValid.slice(0, Math.floor(debValid.length / 2));
          const secHalf   = debValid.slice(Math.floor(debValid.length / 2));
          const avg1 = median(firstHalf);
          const avg2 = median(secHalf);
          const chg  = (avg2 - avg1) / avg1 * 100;
          const severity = chg >= 100 ? 'doubled' : chg >= 50 ? 'high' : chg >= 20 ? 'moderate' : chg <= -15 ? 'falling' : 'stable';
          debFlag = { trend: chg > 20 ? 'rising' : chg < -15 ? 'falling' : 'stable', severity, chg: Math.round(Math.abs(chg)), avg1: Math.round(avg1), avg2: Math.round(avg2) };
        }

        // Build insight blocks
        if (patCfoFlag) {
          if (patCfoFlag.severity === 'warn') {
            insights.push({
              icon: '⚠', color: '#f59e0b', bg: '#f59e0b12', border: '#f59e0b40',
              title: 'Profits Not Fully Converting to Cash',
              body: `Cumulative CFO is only <strong>${Math.round(parseFloat(patCfoFlag.ratio) * 100)}%</strong> of cumulative PAT over the last ${cumPAT.length} years — a gap of ~${patCfoFlag.gap}%. A significant portion of profits is stuck in the business and has not translated into actual cash generation.`
            });
          } else if (patCfoFlag.severity === 'good') {
            insights.push({
              icon: '✓', color: '#34d399', bg: '#34d39912', border: '#34d39940',
              title: 'Strong Cash Conversion',
              body: `Cumulative CFO exceeds cumulative PAT (ratio: <strong>${patCfoFlag.ratio}x</strong>) — the company is generating more cash than it reports as profit. This is a hallmark of high-quality earnings.`
            });
          } else {
            insights.push({
              icon: '→', color: '#94a3b8', bg: '#94a3b812', border: '#94a3b840',
              title: 'Moderate Cash Conversion',
              body: `Cumulative CFO is <strong>${Math.round(parseFloat(patCfoFlag.ratio) * 100)}%</strong> of cumulative PAT — reasonably healthy but some profits are yet to convert to cash.`
            });
          }
        }

        if (invFlag && invFlag.trend === 'rising') {
          insights.push({
            icon: '⚠', color: '#f87171', bg: '#f8717112', border: '#f8717140',
            title: 'Cash Stuck in Inventory',
            body: `Inventory days have risen ~<strong>${invFlag.chg}%</strong> (from ~${invFlag.avg1} days earlier to ~${invFlag.avg2} days recently). The company is holding more inventory relative to sales — cash is being locked up in stock, which slows cash conversion.${patCfoFlag?.severity === 'warn' ? ' This is a likely contributor to the PAT–CFO gap above.' : ''}`
          });
        } else if (invFlag && invFlag.trend === 'falling') {
          insights.push({
            icon: '✓', color: '#34d399', bg: '#34d39912', border: '#34d39940',
            title: 'Inventory Efficiency Improving',
            body: `Inventory days have declined ~<strong>${invFlag.chg}%</strong> (from ~${invFlag.avg1} to ~${invFlag.avg2} days) — the company is selling inventory faster, freeing up cash from working capital.`
          });
        }

        if (debFlag?.trend === 'rising') {
          const debColor  = debFlag.severity === 'doubled' ? '#f87171' : debFlag.severity === 'high' ? '#f59e0b' : '#94a3b8';
          const debBg     = debFlag.severity === 'doubled' ? '#f8717112' : debFlag.severity === 'high' ? '#f59e0b12' : '#94a3b812';
          const debBorder = debFlag.severity === 'doubled' ? '#f8717140' : debFlag.severity === 'high' ? '#f59e0b40' : '#94a3b840';
          const debIcon   = debFlag.severity === 'doubled' ? '🚨' : '⚠';
          const debTitle  = debFlag.severity === 'doubled'
            ? 'Receivable Days Have Doubled — Serious Red Flag'
            : debFlag.severity === 'high'
            ? 'Receivable Days Up >50% — Cash Locked in Debtors'
            : 'Receivable Days Gradually Rising';
          const debBody   = debFlag.severity === 'doubled'
            ? `Debtor days have <strong>more than doubled</strong> — from ~${debFlag.avg1} days to ~${debFlag.avg2} days (~${debFlag.chg}% increase). This is a serious warning sign: the company is either struggling to collect payments, extending very aggressive credit terms to push sales, or customers are facing financial stress. A large and growing portion of reported revenue has not been received as cash.${patCfoFlag?.severity === 'warn' ? ' Combined with the PAT–CFO gap above, this strongly suggests earnings quality concerns.' : ''}`
            : debFlag.severity === 'high'
            ? `Debtor days have risen ~<strong>${debFlag.chg}%</strong> — from ~${debFlag.avg1} days to ~${debFlag.avg2} days. A significant increase in receivables relative to sales means cash is being locked in the balance sheet rather than flowing in. Watch whether this is driven by business-mix changes or genuine collection weakness.${patCfoFlag?.severity === 'warn' ? ' This is likely contributing to the PAT–CFO gap noted above.' : ''}`
            : `Debtor days have edged up ~<strong>${debFlag.chg}%</strong> (from ~${debFlag.avg1} to ~${debFlag.avg2} days) — a moderate rise worth monitoring but not alarming in isolation.`;
          insights.push({ icon: debIcon, color: debColor, bg: debBg, border: debBorder, title: debTitle, body: debBody });
        }

        if (!insights.length) return;

        el.innerHTML = insights.map(ins => `
          <div style="background:${ins.bg};border:1px solid ${ins.border};border-radius:10px;padding:11px 14px;margin:6px 0">
            <div style="display:flex;align-items:center;gap:7px;margin-bottom:5px">
              <span style="font-size:14px;color:${ins.color}">${ins.icon}</span>
              <span style="font-size:11px;font-weight:700;color:${ins.color};letter-spacing:.3px">${ins.title}</span>
            </div>
            <div style="font-size:11px;color:#94a3b8;line-height:1.55">${ins.body}</div>
          </div>`).join('');
      })();

      // ── NFAT — Net Fixed Asset Turnover (moved from BS tab) ────────────────
      (() => {
        if (!d.balanceSheet) return;
        const bs   = d.balanceSheet;
        const nYrs = tail(bs.headers, N);
        const salesFull    = d.pnl ? findRowLocal(d.pnl.data,'Sales','Revenue','Net Sales','Total Revenue','Revenue from Operations') : null;
        const fixedAstFull = findRowLocal(bs.data,'Fixed Assets','Net Fixed Assets','Tangible Assets','Property Plant Equipment');
        const nfatArr = salesFull && fixedAstFull ? nYrs.map((yr) => {
          const si     = (d.pnl?.headers || []).indexOf(yr);
          const ai     = bs.headers.indexOf(yr);
          const s      = si >= 0 ? salesFull[si]    : null;
          const faEnd  = ai >= 0 ? fixedAstFull[ai] : null;
          const faStart = ai > 0  ? fixedAstFull[ai - 1] : faEnd;
          if (s == null || faEnd == null) return null;
          const avgFA  = faStart != null ? (faStart + faEnd) / 2 : faEnd;
          return avgFA > 0 ? parseFloat((s / avgFA).toFixed(2)) : null;
        }) : null;
        if (!nfatArr) return;

        const nfatColors = nfatArr.map(v => v == null ? C.cyan : v >= 3 ? '#34d399' : v >= 1.5 ? '#f59e0b' : '#f87171');
        make('si-c-asset-turn', {
          type: 'line',
          data: {
            labels: nYrs,
            datasets: [
              { label: 'NFAT (x)', data: nfatArr, borderColor: C.cyan, backgroundColor: 'rgba(34,211,153,0.08)', borderWidth: 2, pointRadius: 4, pointBackgroundColor: nfatColors, tension: 0.3, fill: true },
              { label: '1.5x (capital intensive)', data: nYrs.map(() => 1.5), borderColor: 'rgba(248,113,113,0.6)', backgroundColor: 'transparent', borderWidth: 1.5, borderDash: [5,4], pointRadius: 0 },
              { label: '3x (efficient)',            data: nYrs.map(() => 3),   borderColor: 'rgba(52,211,153,0.5)',  backgroundColor: 'transparent', borderWidth: 1,   borderDash: [3,4], pointRadius: 0 },
            ],
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: true, labels: { color: '#94a3b8', font: { size: 10 } } }, tooltip: { mode: 'index', intersect: false, callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y}x` } } },
            scales: {
              x: { ticks: { color: '#64748b', font: { size: 9 }, maxTicksLimit: 12, maxRotation: 45, autoSkip: true }, grid: { color: 'rgba(255,255,255,0.04)' } },
              y: { min: 0, ticks: { color: '#64748b', font: { size: 9 }, callback: v => v + 'x' }, grid: { color: 'rgba(255,255,255,0.04)' } },
            },
          },
        });

        // ── NFAT Insights ────────────────────────────────────────────────────
        (() => {
          const el = document.getElementById('si-nfat-insight');
          if (!el) return;
          const valid = nfatArr.filter(v => v != null);
          if (!valid.length) return;

          const avg        = valid.reduce((a,b) => a+b,0) / valid.length;
          const latestNfat = valid[valid.length - 1];
          const insights   = [];

          // OPM for context (latest year)
          const opmFull  = d.pnl ? findRowLocal(d.pnl.data,'OPM %') : null;
          const latestOpm = opmFull ? opmFull[opmFull.length - 1] : null;
          const highOpm  = latestOpm != null && latestOpm >= 20;
          const lowOpm   = latestOpm != null && latestOpm < 20;

          // ── NFAT vs OPM combined diagnosis (period averages) ──────────────
          const opmValid = opmFull ? opmFull.filter(v => v != null && !isNaN(v)) : [];
          const avgOpm   = opmValid.length ? opmValid.reduce((a,b)=>a+b,0) / opmValid.length : null;
          if (avgOpm != null) {
            const nfatLow  = avg <= 1;
            const nfatHigh = avg > 1;
            const opmLow   = avgOpm < 15;
            const opmHigh  = avgOpm > 20;
            const avgN = avg.toFixed(1), avgO = avgOpm.toFixed(1);

            if (nfatLow && opmLow) {
              insights.push({
                icon: '🚨', color: '#f87171', bg: '#f8717112', border: '#f8717140',
                title: 'Low NFAT + Low OPM — Capital Hungry & Cash Starved',
                body: `With average NFAT of <strong>${avgN}x</strong> (&lt;1x) and OPM of <strong>${avgO}%</strong> (&lt;15%), the business needs a large amount of capital to grow revenue yet cannot generate enough internal funds to finance that growth. Low asset efficiency combined with thin margins is the weakest combination — growth here leans heavily on external capital.`
              });
            } else if (nfatLow && opmHigh) {
              insights.push({
                icon: '✓', color: '#34d399', bg: '#34d39912', border: '#34d39940',
                title: 'Low NFAT but High OPM — Margins Fund the Capital Need',
                body: `Average NFAT of <strong>${avgN}x</strong> (&lt;1x) means the business needs heavy capital to grow revenue, but a strong OPM of <strong>${avgO}%</strong> (&gt;20%) lets it generate enough funds to finance that growth despite low asset turnover. The higher the OPM, the better — margins are doing the heavy lifting here.`
              });
            } else if (nfatHigh && opmLow) {
              insights.push({
                icon: '✓', color: '#34d399', bg: '#34d39912', border: '#34d39940',
                title: 'High NFAT despite Low OPM — Capital Efficient',
                body: `Average NFAT of <strong>${avgN}x</strong> (&gt;1x) means the business does not need a lot of capital to grow revenue, so even with a modest OPM of <strong>${avgO}%</strong> (&lt;15%) it can fund growth efficiently. High asset turnover compensates for the thinner margins.`
              });
            } else if (nfatHigh && opmHigh) {
              insights.push({
                icon: '⭐', color: '#34d399', bg: '#34d39912', border: '#34d39940',
                title: 'High NFAT + High OPM — Best Combination (Structural Moat)',
                body: `Average NFAT of <strong>${avgN}x</strong> (&gt;1x) with OPM of <strong>${avgO}%</strong> (&gt;20%) is the best possible combination — the business grows revenue with minimal capital while earning fat margins. If it consistently sustains both high NFAT and high OPM over the period, it likely enjoys a structurally high moat.`
              });
            }
          }

          // 1. Consistently high NFAT
          const mostHigh = valid.filter(v => v >= 2.5).length / valid.length >= 0.75;
          if (mostHigh) {
            insights.push({
              icon: '✓', color: '#34d399', bg: '#34d39912', border: '#34d39940',
              title: 'Consistently High NFAT — Asset-Light Business',
              body: `NFAT has averaged <strong>${avg.toFixed(1)}x</strong> over the period. The company generates strong revenue relative to its fixed-asset base, signalling low capital reinvestment needs, strong brands, or wide distribution reach. Such businesses can grow without proportionate capex — a hallmark of a quality compounder.`
            });
          }

          // 2. NFAT < 1.5 → capital intensive, debt trap risk
          if (latestNfat < 1.5) {
            insights.push({
              icon: '🚨', color: '#f87171', bg: '#f8717112', border: '#f8717140',
              title: 'Highly Capital Intensive (NFAT < 1.5x) — Debt Trap Risk',
              body: `Current NFAT of <strong>${latestNfat}x</strong> classifies this as a highly capital-intensive business. These businesses require continuous heavy fixed-asset investment to sustain operations. If not managed carefully, this raises the risk of falling into a debt trap and, in extreme cases, financial distress. Scrutinise debt levels and interest coverage closely.`
            });
          }

          // 3. Low NFAT + Low OPM → dangerous combination
          if (latestNfat < 1.5 && lowOpm) {
            insights.push({
              icon: '🚨', color: '#f87171', bg: '#f8717112', border: '#f8717140',
              title: 'Dangerous Combination: Low NFAT + Low Margins (OPM < 20%)',
              body: `NFAT of <strong>${latestNfat}x</strong> paired with OPM of <strong>${latestOpm?.toFixed(1)}%</strong> is a serious red flag. A capital-heavy business with thin margins must continually raise large amounts of debt or equity just to fund growth — compressing returns and eroding shareholder value over time. Incremental growth here may actually destroy value rather than create it.`
            });
          }

          // 4. Low NFAT + High OPM → capital as moat
          if (latestNfat < 1.5 && highOpm) {
            insights.push({
              icon: '⚡', color: '#a78bfa', bg: '#a78bfa12', border: '#a78bfa40',
              title: 'High Capital Intensity Acting as an Entry Barrier (Moat)',
              body: `Despite a low NFAT of <strong>${latestNfat}x</strong>, OPM of <strong>${latestOpm?.toFixed(1)}%</strong> (above 20%) suggests the heavy capital requirement may be creating a natural moat — competitors cannot easily replicate the asset base. This can justify the capital intensity as long as margins remain sustainably high and the balance sheet is managed prudently.`
            });
          }

          // 5. Declining asset turnover trend
          if (valid.length >= 5) {
            const half  = Math.floor(valid.length / 2);
            const avg1  = valid.slice(0,half).reduce((a,b)=>a+b,0) / half;
            const avg2  = valid.slice(half).reduce((a,b)=>a+b,0)   / (valid.length - half);
            const decPct = (avg1 - avg2) / avg1 * 100;

            const lastTwo  = valid.slice(-2);
            const prior2   = valid.slice(-4,-2);
            const recentAvg  = lastTwo.reduce((a,b)=>a+b,0) / lastTwo.length;
            const priorAvg   = prior2.length ? prior2.reduce((a,b)=>a+b,0) / prior2.length : null;
            const isAbrupt   = priorAvg != null && (priorAvg - recentAvg) / priorAvg * 100 > 25;

            if (isAbrupt) {
              insights.push({
                icon: '⚠', color: '#f87171', bg: '#f8717112', border: '#f8717140',
                title: 'Abrupt Drop in Asset Turnover — Investigate Immediately',
                body: `NFAT has fallen sharply in recent years to <strong>${latestNfat}x</strong> (from ~${priorAvg?.toFixed(1)}x previously). A sudden drop can signal a large capacity addition not yet generating revenue, a demand slowdown, or rising asset under-utilisation. Investigate capex plans, capacity utilisation, and whether the incremental investment is justified.`
              });
            } else if (decPct > 20) {
              insights.push({
                icon: '⚠', color: '#f59e0b', bg: '#f59e0b12', border: '#f59e0b40',
                title: 'Gradual Asset Turnover Decline — Capital Efficiency Eroding',
                body: `NFAT has declined ~<strong>${Math.round(decPct)}%</strong> over the period (from ~${avg1.toFixed(1)}x to ~${avg2.toFixed(1)}x). A sustained decline means the asset base is growing faster than revenues — either aggressive capacity expansion ahead of demand, or reducing asset efficiency. Monitor whether future revenue growth will justify the incremental capital deployed.`
              });
            }
          }

          if (!insights.length) return;
          el.innerHTML = insights.map(ins => `
            <div style="background:${ins.bg};border:1px solid ${ins.border};border-radius:10px;padding:11px 14px;margin:6px 0">
              <div style="display:flex;align-items:center;gap:7px;margin-bottom:5px">
                <span style="font-size:14px;color:${ins.color}">${ins.icon}</span>
                <span style="font-size:11px;font-weight:700;color:${ins.color};letter-spacing:.3px">${ins.title}</span>
              </div>
              <div style="font-size:11px;color:#94a3b8;line-height:1.55">${ins.body}</div>
            </div>`).join('');
        })();
      })();

      // CCC: green bars when positive, red when negative
      const cccBg     = ccc.map(v => (v != null && v < 0) ? C.redA   : C.greenA);
      const cccBorder = ccc.map(v => (v != null && v < 0) ? C.red    : C.green);
      bar('si-c-ccc', yrs, [{label:'CCC (Days)', data:ccc, color:cccBorder, colorA:cccBg}]);

      // ── Drag-to-reorder charts (Efficiency tab) ────────────────────────────
      setupBlockReorder('si_eff_block_order', () => switchTab('returns'));
    }

    if (tab === 'balance-sheet' && d.balanceSheet) {
      const bs  = d.balanceSheet;
      const yrs = tail(bs.headers, N);
      const n   = yrs.length;
      stackedBar('si-c-de-stack', yrs, [
        {label:'Net Worth',  data:tail(d.derived.netWorth||[],n),                                    color:C.green,  colorA:C.greenA},
        {label:'Borrowings', data:tail(findRowLocal(bs.data,'Borrowings','Total Debt')||[],n), color:C.red,    colorA:C.redA},
      ]);
      line('si-c-de-ratio', yrs, [{label:'D/E Ratio',   data:tail(d.derived.debtEquity||[],n),  color:C.orange, fill:true}]);
      bar ('si-c-assets',   yrs, [{label:'Total Assets', data:tail(d.derived.totalAssets||[],n), color:C.cyan,   colorA:C.cyanA}]);

      // CWIP trend
      const cwip = tail(findRowLocal(bs.data,
        'Capital Work in Progress','CWIP','Capital WIP','Capital work-in-progress')||[], n);
      bar('si-c-cwip', yrs, [{label:'CWIP (₹ Cr)', data:cwip, color:C.purple, colorA:C.purpleA}]);

      // ── Other Assets Stacked Breakdown ────────────────────────────────────
      // bsRow: find a row in bs.data matching any of the given terms (exact then fuzzy),
      // return tail-aligned array. Rows with values >1e6 are skipped (likely share counts).
      const bsRow = (...terms) => {
        const raw = findRowLocal(bs.data, ...terms);
        if (!raw) return Array(n).fill(null);
        return tail(raw, n);
      };

      // Use screener.in's EXACT sub-row labels (visible after expanding "Other Assets -")
      // Do NOT include the "Other Assets" total — it's the sum of these sub-components.
      const inventory  = bsRow('Inventories', 'Inventory', 'Stocks', 'Stock-in-Trade');
      // "Trade receivables" is the sub-total; we also try alternate spellings
      const recvTotal  = bsRow('Trade receivables', 'Trade Receivables', 'Sundry Debtors', 'Debtors');
      const cash       = bsRow('Cash Equivalents', 'Cash and Bank Balances', 'Cash & Bank',
                                'Cash and Cash Equivalents', 'Cash & Equivalents', 'Cash');
      const loans      = bsRow('Loans n Advances', 'Loans and Advances', 'Short Term Loans',
                                'Loans & Advances', 'Advances');
      const otherItems = bsRow('Other asset items', 'Other Current Assets', 'Other Assets (Current)',
                                'Miscellaneous Assets');
      const stInvest   = bsRow('Short Term Investments', 'Current Investments', 'Investments (Current)');

      console.debug('[SI] BS sub-rows — Inventory:', inventory.slice(-3),
                    '| Recv:', recvTotal.slice(-3), '| Cash:', cash.slice(-3),
                    '| Loans:', loans.slice(-3), '| Other:', otherItems.slice(-3));

      // Build datasets — only include series with at least one non-null value
      // Exclude the "Other Assets" total (matched only as a fallback in otherItems)
      const otherAssetsSeries = [
        { label: 'Inventories',        data: inventory,  color: C.orange, colorA: C.orangeA },
        { label: 'Trade Receivables',  data: recvTotal,  color: C.blue,   colorA: C.blueA   },
        { label: 'Cash & Equivalents', data: cash,       color: C.green,  colorA: C.greenA  },
        { label: 'Loans & Advances',   data: loans,      color: C.purple, colorA: C.purpleA },
        { label: 'Other Asset Items',  data: otherItems, color: C.cyan,   colorA: C.cyanA   },
        { label: 'ST Investments',     data: stInvest,   color: C.slate,  colorA: 'rgba(148,163,184,0.75)' },
      ].filter(ds => ds.data.some(v => v != null && v > 0));

      if (otherAssetsSeries.length) {
        stackedBar('si-c-other-assets', yrs, otherAssetsSeries);
      } else {
        // No sub-rows found yet — show the "Other Assets" total as a bar
        const otherTotal = bsRow('Other Assets', 'Other Current Assets');
        bar('si-c-other-assets', yrs, [{ label: 'Other Assets (total)', data: otherTotal, color: C.cyan, colorA: C.cyanA }]);
        const lbl = document.querySelector('#si-c-other-assets')?.closest('.si-chart-wrap')?.querySelector('.si-chart-label');
        if (lbl) lbl.textContent = 'Other Assets Total (expand rows on screener.in to see breakdown)';
      }

      // ── Receivables Aging (<6 months vs >6 months) ────────────────────────
      // screener.in exact labels after expanding "Trade receivables -"
      const recvLt6 = bsRow(
        'Receivables under 6m', 'Receivables Under 6m',
        'Outstanding for less than 6 months', 'Less than Six Months',
        'Receivable (< 6 Months)', 'Trade Receivables - Less than 6 months'
      );
      const recvGt6 = bsRow(
        'Receivables over 6m', 'Receivables Over 6m',
        'Outstanding for more than 6 months', 'More than Six Months',
        'Receivable (> 6 Months)', 'Trade Receivables - More than 6 months'
      );

      const hasAgingData = recvLt6.some(v => v != null && v > 0) || recvGt6.some(v => v != null && v > 0);
      if (hasAgingData) {
        stackedBar('si-c-recv-age', yrs, [
          { label: 'Receivables < 6 mo', data: recvLt6, color: C.green,  colorA: C.greenA  },
          { label: 'Receivables > 6 mo', data: recvGt6, color: C.orange, colorA: C.orangeA },
        ]);
      } else {
        line('si-c-recv-age', yrs, [{ label: 'Total Receivables', data: recvTotal, color: C.blue, fill: true }]);
        const lbl = document.querySelector('#si-c-recv-age')?.closest('.si-chart-wrap')?.querySelector('.si-chart-label');
        if (lbl) lbl.textContent = 'Total Receivables Trend (expand "Trade receivables" on screener.in for aging split)';
      }

      // ── Current Ratio — gear popup wiring ────────────────────────────────
      (() => {
        const btn   = document.getElementById('si-cr-settings-btn');
        const popup = document.getElementById('si-cr-settings-popup');
        const inp   = document.getElementById('si-cr-threshold');
        if (!btn || !popup || !inp) return;
        inp.value = getCrThreshold();
        btn.addEventListener('click', e => {
          e.stopPropagation();
          popup.style.display = popup.style.display === 'none' ? 'block' : 'none';
        });
        document.addEventListener('click', e => {
          if (!popup.contains(e.target) && e.target !== btn) popup.style.display = 'none';
        }, { capture: true });
        document.getElementById('si-cr-save')?.addEventListener('click', () => {
          const v = parseFloat(inp.value);
          if (isNaN(v) || v <= 0) { alert('Please enter a valid positive number.'); return; }
          saveCrThreshold(v);
          popup.style.display = 'none';
          renderCharts('balance-sheet', d);
        });
        document.getElementById('si-cr-reset')?.addEventListener('click', () => {
          localStorage.removeItem(CR_KEY);
          inp.value = getCrThreshold();
          popup.style.display = 'none';
          renderCharts('balance-sheet', d);
        });
      })();

      // ── Current Ratio chart ───────────────────────────────────────────────
      (() => {
        const CR_THRESHOLD = getCrThreshold();
        const tradePayables = bsRow('Trade Payables', 'Creditors', 'Sundry Creditors', 'Trade payables');

        const crArr = yrs.map((_, i) => {
          const ca = (inventory[i] ?? 0) + (recvTotal[i] ?? 0) + (cash[i] ?? 0);
          const cl = tradePayables[i];
          if (!ca || cl == null || cl <= 0) return null;
          return parseFloat((ca / cl).toFixed(2));
        });

        if (!crArr.some(v => v != null)) return;

        const barBg     = crArr.map(v => v == null ? 'transparent' : v >= CR_THRESHOLD ? '#34d399' : v >= 1 ? '#fbbf24' : '#f87171');
        const barBorder = crArr.map(v => v == null ? 'transparent' : v >= CR_THRESHOLD ? '#10b981' : v >= 1 ? '#d97706' : '#ef4444');

        make('si-c-curr-ratio', {
          type: 'bar',
          data: {
            labels: yrs,
            datasets: [
              {
                type: 'bar',
                label: 'Current Ratio (x)',
                data: crArr,
                backgroundColor: barBg,
                borderColor: barBorder,
                borderWidth: 1.5,
                borderRadius: 3,
                borderSkipped: false,
              },
              {
                type: 'line',
                label: `Min. Safe (${CR_THRESHOLD}x)`,
                data: yrs.map(() => CR_THRESHOLD),
                borderColor: 'rgba(52,211,153,0.6)',
                borderWidth: 1.5,
                borderDash: [5, 4],
                pointRadius: 0,
                backgroundColor: 'transparent',
              },
              {
                type: 'line',
                label: 'Breakeven (1x)',
                data: yrs.map(() => 1),
                borderColor: 'rgba(248,113,113,0.5)',
                borderWidth: 1,
                borderDash: [3, 4],
                pointRadius: 0,
                backgroundColor: 'transparent',
              },
            ],
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              legend: { display: true, labels: { color: '#94a3b8', font: { size: 10 } } },
              tooltip: { callbacks: { label: ctx => ctx.dataset.type === 'bar' ? ` CR: ${ctx.parsed.y}x` : ` ${ctx.dataset.label}` } },
            },
            scales: {
              x: { ticks: { color: '#64748b', font: { size: 9 }, maxTicksLimit: 12, maxRotation: 45, autoSkip: true }, grid: { color: 'rgba(255,255,255,0.04)' } },
              y: { min: 0, ticks: { color: '#64748b', font: { size: 9 }, callback: v => v + 'x' }, grid: { color: 'rgba(255,255,255,0.04)' } },
            },
          },
        });
      })();

      // ── Drag-to-reorder charts (Balance Sheet tab) ─────────────────────────
      setupBlockReorder('si_bs_block_order', () => switchTab('balance-sheet'));
    }

    if (tab === 'cash-flow' && d.cashFlow) {
      const cf  = d.cashFlow;
      const yrs = tail(cf.headers, N);
      const n   = yrs.length;
      const cfD = cf.data;

      renderCumTable('si-cum-table');

      // Cash Flows — solid colors
      make('si-c-cf3', {
        type: 'bar',
        data: {
          labels: yrs,
          datasets: [
            { label:'Operating CF',  data:tail(findRowLocal(cfD,'Cash from Operating Activity')||[],n), backgroundColor:'#10b981', borderColor:'#10b981', borderWidth:1, borderRadius:3, borderSkipped:false },
            { label:'Investing CF',  data:tail(findRowLocal(cfD,'Cash from Investing Activity')||[],n), backgroundColor:'#f59e0b', borderColor:'#f59e0b', borderWidth:1, borderRadius:3, borderSkipped:false },
            { label:'Financing CF',  data:tail(findRowLocal(cfD,'Cash from Financing Activity')||[],n), backgroundColor:'#a855f7', borderColor:'#a855f7', borderWidth:1, borderRadius:3, borderSkipped:false },
          ],
        },
        options: {
          responsive:true, maintainAspectRatio:false, clip:false, layout:{padding:{left:6,right:6}},
          plugins:{ legend:{display:true,labels:{color:'#94a3b8',font:{size:10}}}, tooltip:{mode:'index',intersect:false} },
          scales:{
            x:{ticks:{color:'#64748b',font:{size:9},maxTicksLimit:12,maxRotation:45,autoSkip:true},grid:{color:'rgba(255,255,255,0.04)'},offset:true},
            y:{ticks:{color:'#64748b',font:{size:9},callback:v=>v>=1e5?(v/1e5).toFixed(1)+'L':v>=1e3?(v/1e3).toFixed(0)+'K':v},grid:{color:'rgba(255,255,255,0.04)'}},
          },
        },
      });

      // Capex = (NFA+CWIP)_end - (NFA+CWIP)_start + Depreciation
      (() => {
        if (!d.balanceSheet || !d.pnl) return;
        const bsH  = d.balanceSheet.headers;
        const nfa  = findRowLocal(d.balanceSheet.data,'Fixed Assets','Net Fixed Assets','Tangible Assets','Property Plant Equipment');
        const cwip = findRowLocal(d.balanceSheet.data,'Capital Work in Progress','CWIP','Capital WIP','Capital work-in-progress');
        const dep  = findRowLocal(d.pnl.data,'Depreciation','Amortisation','Depreciation & Amortisation','D&A');
        if (!nfa) return;

        const capexArr = yrs.map(yr => {
          const ai  = bsH.indexOf(yr);
          if (ai < 1) return null;
          const nfaEnd   = nfa[ai]  ?? 0;
          const nfaStart = nfa[ai-1] ?? 0;
          const cwipEnd  = cwip ? (cwip[ai]   ?? 0) : 0;
          const cwipStart= cwip ? (cwip[ai-1] ?? 0) : 0;
          const depVal   = dep ? (() => {
            const pi = (d.pnl.headers || []).indexOf(yr);
            return pi >= 0 ? (dep[pi] ?? 0) : 0;
          })() : 0;
          const val = (nfaEnd + cwipEnd) - (nfaStart + cwipStart) + depVal;
          return parseFloat(val.toFixed(1));
        });

        if (!capexArr.some(v => v != null)) return;
        make('si-c-capex', {
          type: 'line',
          data: {
            labels: yrs,
            datasets: [{
              label: 'Capex (₹ Cr)',
              data: capexArr,
              borderColor: '#6366f1',
              backgroundColor: 'rgba(99,102,241,0.12)',
              borderWidth: 2,
              pointRadius: 4,
              pointBackgroundColor: '#6366f1',
              tension: 0.3,
              fill: true,
            }],
          },
          options: {
            responsive:true, maintainAspectRatio:false, clip:false, layout:{padding:{left:6,right:6}},
            plugins:{legend:{display:true,labels:{color:'#94a3b8',font:{size:10}}},tooltip:{callbacks:{label:ctx=>` Capex: ₹${ctx.parsed.y} Cr`}}},
            scales:{
              x:{ticks:{color:'#64748b',font:{size:9},maxTicksLimit:12,maxRotation:45,autoSkip:true},grid:{color:'rgba(255,255,255,0.04)'},offset:true},
              y:{ticks:{color:'#64748b',font:{size:9},callback:v=>v>=1e3?(v/1e3).toFixed(0)+'K':v},grid:{color:'rgba(255,255,255,0.04)'}},
            },
          },
        });

        // CFO vs Capex vs FCF split-panel chart + Capex/CFO ratio
        const cfoData2 = tail(findRowLocal(cfD,'Cash from Operating Activity')||[], n);
        const fcfData2 = tail(d.derived.fcfArr||[], n);
        const fmtTick  = v => v==null?'':Math.abs(v)>=1e5?(v/1e5).toFixed(1)+'L':Math.abs(v)>=1e3?(v/1e3).toFixed(0)+'K':String(v);

        // Top panel — CFO (amber), Capex (indigo), FCF (green/red) bars
        make('si-c-cfo-capex-fcf-bars', {
          type: 'bar',
          data: {
            labels: yrs,
            datasets: [
              { label:'CFO',   data:cfoData2,  backgroundColor:'#f59e0b', borderColor:'#f59e0b', borderWidth:1, borderRadius:3, borderSkipped:false },
              { label:'Capex', data:capexArr,  backgroundColor:'#6366f1', borderColor:'#6366f1', borderWidth:1, borderRadius:3, borderSkipped:false },
              { label:'FCF',   data:fcfData2,  backgroundColor:fcfData2.map(v=>v==null?'transparent':v<0?'#f87171':'#34d399'),
                                               borderColor:    fcfData2.map(v=>v==null?'transparent':v<0?'#ef4444':'#10b981'),
                                               borderWidth:1, borderRadius:3, borderSkipped:false },
            ],
          },
          options: {
            responsive:true, maintainAspectRatio:false, clip:false, layout:{padding:{left:6,right:6,top:6}},
            plugins:{legend:{display:true,labels:{color:'#94a3b8',font:{size:10}}},tooltip:{mode:'index',intersect:false,callbacks:{label:ctx=>` ${ctx.dataset.label}: ₹${fmtTick(ctx.parsed.y)} Cr`}}},
            scales:{
              x:{display:false,offset:true},
              y:{ticks:{color:'#64748b',font:{size:9},callback:fmtTick},grid:{color:'rgba(255,255,255,0.04)'},title:{display:true,text:'₹ Cr',color:'#475569',font:{size:9}}},
            },
          },
        });

        // Bottom panel — Capex/CFO ratio line chart (green ≥ 0, red < 0).
        // Colour switches exactly at 0: we insert an interpolated node wherever
        // the line crosses 0, so every segment lies fully on one side.
        const capexCfoRatio = yrs.map((_, i) => {
          const capex = capexArr[i], cfo = cfoData2[i];
          if (capex == null || cfo == null || cfo === 0) return null;
          return parseFloat((capex / cfo).toFixed(2));
        });

        // Build {x,y} points on a numeric x-axis, inserting zero-crossing nodes.
        const ratioPts = [];
        let prevX = null, prevY = null;
        capexCfoRatio.forEach((y, i) => {
          if (y == null) { prevX = null; prevY = null; return; }
          if (prevY != null && ((prevY < 0 && y >= 0) || (prevY >= 0 && y < 0))) {
            // crossing point where y = 0
            const t = (0 - prevY) / (y - prevY);
            ratioPts.push({ x: prevX + t * (i - prevX), y: 0 });
          }
          ratioPts.push({ x: i, y });
          prevX = i; prevY = y;
        });

        make('si-c-cfo-capex-fcf-ratio', {
          type: 'line',
          data: {
            datasets: [
              {
                label: 'Capex/CFO (x)',
                data: ratioPts,
                borderWidth: 2,
                pointRadius: ctx => {
                  const x = ctx.raw && ctx.raw.x;
                  return Number.isInteger(x) ? 3 : 0; // hide interpolated crossing nodes
                },
                pointHoverRadius: 5,
                tension: 0,
                fill: false,
                segment: {
                  borderColor: ctx => {
                    // colour depends only on whether the segment is above/below 0
                    const mid = (ctx.p0.parsed.y + ctx.p1.parsed.y) / 2;
                    return mid < 0 ? 'rgba(248,113,113,0.9)' : 'rgba(52,211,153,0.9)';
                  },
                },
                borderColor: 'rgba(52,211,153,0.9)',
                backgroundColor: 'transparent',
                pointBackgroundColor: ctx => (ctx.raw && ctx.raw.y < 0) ? '#f87171' : '#34d399',
                pointBorderColor: ctx => (ctx.raw && ctx.raw.y < 0) ? '#f87171' : '#34d399',
              },
              {
                label: '0 (baseline)',
                data: [{ x: 0, y: 0 }, { x: n - 1, y: 0 }],
                borderColor: 'rgba(148,163,184,0.55)',
                backgroundColor: 'transparent',
                borderWidth: 1.5,
                pointRadius: 0,
              },
              {
                label: '1x (Capex = CFO)',
                data: [{ x: 0, y: 1 }, { x: n - 1, y: 1 }],
                borderColor: 'rgba(148,163,184,0.45)',
                backgroundColor: 'transparent',
                borderWidth: 1.5,
                borderDash: [5, 4],
                pointRadius: 0,
              },
            ],
          },
          options: {
            responsive:true, maintainAspectRatio:false, clip:false, layout:{padding:{left:6,right:6,bottom:4}},
            plugins:{
              legend:{display:true,labels:{color:'#94a3b8',font:{size:10},filter:item=>item.text!=='0 (baseline)'}},
              tooltip:{
                mode:'index',intersect:false,
                filter:item=>item.dataset.label==='Capex/CFO (x)' && Number.isInteger(item.raw && item.raw.x),
                callbacks:{
                  title:items=>items.length?yrs[Math.round(items[0].raw.x)]:'',
                  label:ctx=>` Capex/CFO: ${ctx.parsed.y}x`,
                },
              },
            },
            scales:{
              x:{
                type:'linear', min:0, max:n-1, offset:true,
                ticks:{
                  color:'#64748b',font:{size:9},maxRotation:45,autoSkip:true,maxTicksLimit:12,stepSize:1,
                  callback:v=>Number.isInteger(v)?yrs[v]:'',
                },
                grid:{color:'rgba(255,255,255,0.04)'},
              },
              y:{
                ticks:{color:'#64748b',font:{size:9},callback:v=>v+'x'},
                grid:{color:'rgba(255,255,255,0.04)'},
                title:{display:true,text:'Capex/CFO (x)',color:'#475569',font:{size:9}},
              },
            },
          },
        });

        // ── Dynamic margin-of-safety insight ─────────────────────────────────
        (() => {
          const box = document.getElementById('si-capex-insight');
          if (!box) return;

          // Sales row aligned to `yrs`
          const salesRaw = d.pnl ? findRowLocal(d.pnl.data,
            'Sales', 'Revenue', 'Net Sales', 'Total Revenue', 'Revenue from Operations') : null;
          const salesArr = salesRaw ? yrs.map(yr => {
            const i = (d.pnl.headers || []).indexOf(yr);
            return i >= 0 ? (salesRaw[i] ?? null) : null;
          }) : null;

          // CAGR needs valid positive start & end sales over the window
          let cagr = null, cagrYrs = null;
          if (salesArr) {
            for (const w of [10, 5, 3]) {
              if (salesArr.length < w) continue;
              const start = salesArr[salesArr.length - w];
              const end   = salesArr[salesArr.length - 1];
              if (start != null && end != null && start > 0 && end > 0) {
                cagr = (Math.pow(end / start, 1 / (w - 1)) - 1) * 100;
                cagrYrs = w;
                break;
              }
            }
          }

          // Average Capex/CFO over the same preference of windows
          let avgRatio = null, ratioYrs = null;
          for (const w of [10, 5, 3]) {
            const cap = capexArr.slice(-w), cfo = cfoData2.slice(-w);
            if (cap.length < w) continue;
            const pairs = [];
            for (let i = 0; i < w; i++) {
              if (cap[i] != null && cfo[i] != null && cfo[i] !== 0) pairs.push(cap[i] / cfo[i]);
            }
            if (pairs.length >= Math.min(w, 3)) {
              avgRatio = pairs.reduce((a, b) => a + b, 0) / pairs.length;
              ratioYrs = w;
              break;
            }
          }

          const period = (cagrYrs || ratioYrs || 10);
          const cagrStr  = cagr   == null ? 'N/A' : `<strong style="color:#60a5fa">${cagr.toFixed(1)}%</strong>`;
          const avgStr   = avgRatio == null ? 'N/A' : `<strong style="color:${avgRatio < 1 ? '#34d399' : '#f87171'}">${(avgRatio * 100).toFixed(0)}%</strong>`;

          let lead = '';
          if (cagr != null && avgRatio != null) {
            lead = `Over the last <strong>${period} years</strong>, the company achieved a sales CAGR of ${cagrStr} while deploying an average of ${avgStr} of its CFO as Capex. `;
          } else if (avgRatio != null) {
            lead = `Over the last <strong>${ratioYrs} years</strong>, the company deployed an average of ${avgStr} of its CFO as Capex (sales CAGR unavailable). `;
          } else {
            lead = `Insufficient data to compute the Capex/CFO trend. `;
          }

          let verdict = '';
          if (avgRatio != null) {
            if (avgRatio < 0)
              verdict = `The average Capex/CFO is <strong style="color:#f87171">negative</strong>, indicating negative operating cash flow (or net divestment) over the period — treat the ratio with caution and review the underlying cash flows.`;
            else if (avgRatio < 0.5)
              verdict = `Using only a <strong style="color:#34d399">minimum fraction of CFO as Capex</strong>, it self-funds growth and retains substantial free cash — implying a <strong style="color:#34d399">significantly higher margin of safety</strong>.`;
            else if (avgRatio < 1)
              verdict = `It consumes a <strong style="color:#fbbf24">large share of CFO on Capex</strong>, leaving a modest free-cash buffer and a <strong style="color:#fbbf24">moderate margin of safety</strong>.`;
            else
              verdict = `Its Capex has <strong style="color:#f87171">exceeded its entire CFO</strong> (negative FCF) — growth has been funded by borrowing, implying a <strong style="color:#f87171">very low / negative margin of safety</strong>.`;
          }

          box.innerHTML =
            `<div style="color:#c4b5fd;font-weight:600;font-size:10px;letter-spacing:.5px;margin-bottom:5px">💡 CAPEX EFFICIENCY &amp; MARGIN OF SAFETY</div>` +
            lead + verdict;
        })();
      })();

      (() => {
        const fcf = tail(d.derived.fcfArr || [], n);
        const fcfBg     = fcf.map(v => v == null ? 'transparent' : v < 0 ? '#f87171' : '#34d399');
        const fcfBorder = fcf.map(v => v == null ? 'transparent' : v < 0 ? '#ef4444' : '#10b981');

        // Cash equivalents from BS (aligned to same years)
        const cashRaw = d.balanceSheet ? findRowLocal(d.balanceSheet.data,
          'Cash Equivalents', 'Cash and Bank Balances', 'Cash & Bank',
          'Cash and Cash Equivalents', 'Cash & Equivalents', 'Cash') : null;
        const cashData = cashRaw ? yrs.map(yr => {
          const i = (d.balanceSheet.headers || []).indexOf(yr);
          return i >= 0 ? (cashRaw[i] ?? null) : null;
        }) : null;

        const datasets = [
          {
            type: 'bar',
            label: 'Free Cash Flow',
            data: fcf,
            backgroundColor: fcfBg,
            borderColor: fcfBorder,
            borderWidth: 1.5,
            borderRadius: 3,
            borderSkipped: false,
            yAxisID: 'y',
          },
        ];
        if (cashData && cashData.some(v => v != null)) {
          datasets.push({
            type: 'line',
            label: 'Cash & Equivalents',
            data: cashData,
            borderColor: '#a78bfa',
            backgroundColor: 'transparent',
            borderWidth: 2,
            pointRadius: 3,
            tension: 0.3,
            yAxisID: 'y',
          });
        }

        make('si-c-fcf', {
          type: 'bar',
          data: { labels: yrs, datasets },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              legend: { display: true, labels: { color: '#94a3b8', font: { size: 10 } } },
              tooltip: { mode: 'index', intersect: false },
            },
            scales: {
              x: { ticks: { color: '#64748b', font: { size: 9 }, maxTicksLimit: 12, maxRotation: 45, autoSkip: true }, grid: { color: 'rgba(255,255,255,0.04)' } },
              y: { ticks: { color: '#64748b', font: { size: 9 }, callback: v => v >= 1e5 ? (v/1e5).toFixed(1)+'L' : v >= 1e3 ? (v/1e3).toFixed(0)+'K' : v }, grid: { color: 'rgba(255,255,255,0.04)' } },
            },
          },
        });
      })();

      // ── Annual CFO vs PAT + CFO/PAT ratio ────────────────────────────────
      (() => {
        // Gear popup wiring
        const btn   = document.getElementById('si-cfopar-settings-btn');
        const popup = document.getElementById('si-cfopar-settings-popup');
        const inp   = document.getElementById('si-cfopar-threshold');
        if (btn && popup && inp) {
          inp.value = getCfoPat();
          btn.addEventListener('click', e => {
            e.stopPropagation();
            popup.style.display = popup.style.display === 'none' ? 'block' : 'none';
          });
          document.addEventListener('click', e => {
            if (!popup.contains(e.target) && e.target !== btn) popup.style.display = 'none';
          }, { capture: true });
          document.getElementById('si-cfopar-save')?.addEventListener('click', () => {
            const v = parseFloat(inp.value);
            if (isNaN(v) || v <= 0) { alert('Please enter a valid positive number.'); return; }
            saveCfoPat(v);
            popup.style.display = 'none';
            renderCharts('cash-flow', d);
          });
          document.getElementById('si-cfopar-reset')?.addEventListener('click', () => {
            localStorage.removeItem(CFO_PAT_KEY);
            inp.value = getCfoPat();
            popup.style.display = 'none';
            renderCharts('cash-flow', d);
          });
        }

        const THRESHOLD = getCfoPat();
        const cfoData = tail(findRowLocal(cfD, 'Cash from Operating Activity') || [], n);
        const patData = d.pnl ? (() => {
          const raw = findRowLocal(d.pnl.data, 'Net Profit', 'PAT', 'Profit after tax') || [];
          return yrs.map(yr => {
            const i = (d.pnl.headers || []).indexOf(yr);
            return i >= 0 ? (raw[i] ?? null) : null;
          });
        })() : Array(n).fill(null);

        const ratioData = yrs.map((_, i) => {
          const c = cfoData[i], p = patData[i];
          if (c == null || p == null || p === 0) return null;
          return parseFloat((c / p).toFixed(2));
        });

        const ratioBg     = ratioData.map(v => v == null ? 'transparent' : v >= THRESHOLD ? '#34d399' : v >= 0 ? '#f59e0b' : '#f87171');
        const ratioBorder = ratioData.map(v => v == null ? 'transparent' : v >= THRESHOLD ? '#10b981' : v >= 0 ? '#d97706' : '#ef4444');

        // Split chart: lines top 60%, bars bottom 40%
        const validAmts  = [...cfoData, ...patData].filter(v => v != null);
        const validRatio = ratioData.filter(v => v != null);
        const maxAmt   = validAmts.length  ? Math.max(...validAmts)  : 1;
        const maxRatio = validRatio.length ? Math.max(...validRatio, THRESHOLD) : THRESHOLD;

        const amtMin   = -(maxAmt * 0.67);
        const ratioMax = Math.ceil(maxRatio * 2.5 * 10) / 10;

        const fmtAmt = v => v == null ? '' : Math.abs(v) >= 1e5 ? (v/1e5).toFixed(1)+'L' : Math.abs(v) >= 1e3 ? (v/1e3).toFixed(0)+'K' : String(v);

        // Top panel — CFO & PAT lines (no X-axis labels)
        make('si-c-cfopat-lines', {
          type: 'line',
          data: {
            labels: yrs,
            datasets: [
              { label: 'CFO (₹ Cr)', data: cfoData, borderColor: '#f59e0b', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 2, tension: 0.3 },
              { label: 'PAT (₹ Cr)', data: patData, borderColor: C.blue,    backgroundColor: 'transparent', borderWidth: 2, pointRadius: 2, tension: 0.3 },
              { label: '0 (breakeven)', data: yrs.map(() => 0), borderColor: 'rgba(248,113,113,0.55)', backgroundColor: 'transparent', borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0 },
            ],
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              legend: { display: true, labels: { color: '#94a3b8', font: { size: 10 } } },
              tooltip: { mode: 'index', intersect: false, callbacks: { label: ctx => ` ${ctx.dataset.label}: ₹${fmtAmt(ctx.parsed.y)} Cr` } },
            },
            scales: {
              x: { display: false },
              y: {
                position: 'left',
                ticks: { color: '#64748b', font: { size: 9 }, callback: fmtAmt },
                grid: { color: 'rgba(255,255,255,0.04)' },
                title: { display: true, text: '₹ Cr', color: '#475569', font: { size: 9 } },
              },
            },
          },
        });

        // Bottom panel — CFO/PAT ratio bars (shows X-axis labels)
        make('si-c-cfopat-bars', {
          type: 'bar',
          data: {
            labels: yrs,
            datasets: [
              {
                label: 'CFO/PAT (x)',
                data: ratioData,
                backgroundColor: ratioBg,
                borderColor: ratioBorder,
                borderWidth: 1,
                borderRadius: 3,
                borderSkipped: false,
              },
              {
                type: 'line',
                label: `Threshold (${THRESHOLD}x)`,
                data: yrs.map(() => THRESHOLD),
                borderColor: 'rgba(248,113,113,0.65)',
                backgroundColor: 'transparent',
                borderWidth: 1.5,
                borderDash: [5, 4],
                pointRadius: 0,
              },
            ],
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              legend: { display: true, labels: { color: '#94a3b8', font: { size: 10 } } },
              tooltip: { mode: 'index', intersect: false, callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y}x` } },
            },
            scales: {
              x: { ticks: { color: '#64748b', font: { size: 9 }, maxTicksLimit: 12, maxRotation: 45, autoSkip: true }, grid: { color: 'rgba(255,255,255,0.04)' } },
              y: {
                position: 'left',
                min: 0,
                ticks: { color: '#64748b', font: { size: 9 }, callback: v => v + 'x', maxTicksLimit: 5 },
                grid: { color: 'rgba(255,255,255,0.04)' },
                title: { display: true, text: 'CFO/PAT', color: '#475569', font: { size: 9 } },
              },
            },
          },
        });
      })();

      // CFO / Operating Profit %
      if (d.derived) {
        const cfoYrs    = tail(d.pnl?.headers || cf.headers, N);
        const cfoOpData = tail(d.derived.cfoOpArr || [], cfoYrs.length);
        make('si-c-cfoop', {
          type: 'line',
          data: {
            labels: cfoYrs,
            datasets: [
              { label: 'CFO/Op Profit %', data: cfoOpData, borderColor: C.green, backgroundColor: 'rgba(52,211,153,0.15)', borderWidth: 2, pointRadius: 2, tension: 0.3, fill: true },
              { label: '100% threshold',  data: cfoYrs.map(() => 100), borderColor: 'rgba(248,113,113,0.65)', backgroundColor: 'transparent', borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0 },
            ],
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: true, labels: { color: '#94a3b8', font: { size: 10 } } }, tooltip: { mode: 'index', intersect: false } },
            scales: {
              x: { ticks: { color: '#64748b', font: { size: 9 }, maxTicksLimit: 12, maxRotation: 45, autoSkip: true }, grid: { color: 'rgba(255,255,255,0.04)' } },
              y: { ticks: { color: '#64748b', font: { size: 9 }, callback: v => v + '%' }, grid: { color: 'rgba(255,255,255,0.04)' } },
            },
          },
        });
      }

      // ── Drag-to-reorder charts (Cash Flow tab) ─────────────────────────────
      setupBlockReorder('si_cf_block_order', () => switchTab('cash-flow'));
    }

    if (tab === 'quarters' && d.quarters) {
      const q  = d.quarters;
      const qL = tail(q.headers, 8);
      const n  = qL.length;
      const qSales = tail(findRowLocal(q.data,'Sales','Revenue')||[], n);
      const qNP    = tail(findRowLocal(q.data,'Net Profit','PAT')||[], n);
      const qOPM   = tail(findRowLocal(q.data,'OPM %')||[], n);
      const rawS   = findRowLocal(q.data,'Sales','Revenue')||[];
      const rawNP  = findRowLocal(q.data,'Net Profit','PAT')||[];
      const qNPM   = tail(rawS.map((v,i) => v&&rawNP[i]!=null ? parseFloat((rawNP[i]/v*100).toFixed(1)) : null), n);
      bar ('si-c-q-sales', qL, [{label:'Revenue (₹ Cr)',    data:qSales, color:C.blue,  colorA:C.blueA}]);
      bar ('si-c-q-np',    qL, [{label:'Net Profit (₹ Cr)', data:qNP,    color:C.green, colorA:C.greenA}]);
      line('si-c-q-opm',   qL, [{label:'OPM %',data:qOPM,color:C.orange},{label:'NPM %',data:qNPM,color:C.cyan}]);

      // ── Drag-to-reorder charts (Quarters tab) ──────────────────────────────
      setupBlockReorder('si_q_block_order', () => switchTab('quarters'));
    }

    if (tab === 'moat' && d.pnl) {
      const yrs = tail(d.pnl.headers, N);
      const n   = yrs.length;
      const opm = tail(findRowLocal(d.pnl.data,'OPM %')||[], n);
      line('si-c-moat-opm', yrs, [{label:'OPM %', data:opm, color:C.orange, fill:true}]);

    }

    if (tab === 'ssgr') {
      const yrs = d.pnl ? tail(d.pnl.headers.slice(1), N) : [];
      const n   = yrs.length;

      // SSGR trend: year-by-year SSGR vs revenue CAGR reference line
      const ssgrData   = tail(d.derived.ssgrArr || [], n);
      const revenueCAGR = d.derived.revCAGR5;
      const ssgrSeries = [{ label: 'SSGR %', data: ssgrData, color: C.cyan, fill: false }];
      if (revenueCAGR != null) {
        ssgrSeries.push({ label: `Rev CAGR 5Y (${revenueCAGR}%)`, data: Array(n).fill(revenueCAGR), color: C.orange, fill: false });
      }
      line('si-c-ssgr-trend', yrs, ssgrSeries);

      // ── Drag-to-reorder charts (SSGR tab) ──────────────────────────────────
      setupBlockReorder('si_ssgr_block_order', () => switchTab('ssgr'));
    }

    if (tab === 'valuation') {
      document.querySelectorAll('input[name="si-peg-years"]').forEach(radio => {
        radio.addEventListener('change', () => {
          savePegYears(parseInt(radio.value, 10));
          switchTab('valuation');   // rebuild so PEG recalculates with the new window
        });
      });
    }

    if (tab === 'compare') {
      document.getElementById('si-cmp-add')?.addEventListener('click', () => {
        addToBasket(buildCompareSnapshot(d));
        switchTab('compare');
      });
      document.getElementById('si-cmp-clear')?.addEventListener('click', () => {
        saveBasket([]);
        switchTab('compare');
      });
      document.querySelectorAll('.si-cmp-rm').forEach(b =>
        b.addEventListener('click', () => { removeFromBasket(b.dataset.id); switchTab('compare'); }));
    }

    if (tab === 'delivery') {
      loadDeliveryChart();
    }
  }

  // ── Tab registry ──────────────────────────────────────────────────────────

  const TABS = [
    { id: 'overview',   label: 'Overview',    icon: '⊙' },
    { id: 'returns',    label: 'Efficiency',   icon: '%'  },
    { id: 'scorecard',  label: 'Health',      icon: '★'  },
    { id: 'valuation',  label: 'Valuation',   icon: '⚖' },
    { id: 'ssgr',       label: 'SSGR',        icon: '⚡' },
    { id: 'pnl',        label: 'P & L',       icon: '₹' },
    { id: 'balance-sheet', label: 'B / S',    icon: '⚖'  },
    { id: 'cash-flow',  label: 'Cash Flow',   icon: '↻'  },
    { id: 'compare',    label: 'Compare',     icon: '⇄' },
  ];

  const CONTENT = {
    overview:      tabOverview,
    pnl:           tabPnL,
    returns:       tabReturns,
    'balance-sheet': tabBS,
    'cash-flow':   tabCF,
    ssgr:          tabSSGR,
    valuation:     tabValuation,
    scorecard:     tabScorecard,
    compare:       tabCompare,
  };

  // ── Tab switch ────────────────────────────────────────────────────────────

  function switchTab(id) {
    activeTab = id;
    document.querySelectorAll('.si-tab').forEach(btn =>
      btn.classList.toggle('si-tab-active', btn.dataset.tab === id)
    );
    const body = document.getElementById('si-body');
    if (!body) return;
    const builder = CONTENT[id];
    body.innerHTML = builder ? builder(appData) : '';
    body.scrollTop = 0;                          // always start a tab at the top
    setTimeout(() => {
      renderCharts(id, appData);
      body.scrollTop = 0;                        // re-assert after blocks reorder / charts render
    }, 60);
  }

  // ── Resize ────────────────────────────────────────────────────────────────

  function initResize(panel, trigger) {
    const handle = document.getElementById('si-resize-handle');
    if (!handle) return;
    let dragging = false, startX = 0, startW = 0;

    handle.addEventListener('mousedown', e => {
      dragging = true; startX = e.clientX;
      startW   = panel.getBoundingClientRect().width;
      panel.style.transition = trigger.style.transition = 'none';
      document.body.style.userSelect = 'none';
      document.body.style.cursor     = 'ew-resize';
      e.preventDefault(); e.stopPropagation();
    });

    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      const newW = Math.min(MAX_WIDTH(), Math.max(MIN_WIDTH, startW + (startX - e.clientX)));
      panel.style.width = newW + 'px';
      trigger.style.right = newW + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      panel.style.transition = trigger.style.transition = '';
      document.body.style.userSelect = document.body.style.cursor = '';
    });
  }

  // ── Width control ─────────────────────────────────────────────────────────

  const STEP = 40; // px per Alt+[ / Alt+] press

  function setWidth(px) {
    const panel   = document.getElementById('si-panel');
    const trigger = document.getElementById('si-trigger');
    if (!panel) return;
    const clamped = Math.min(MAX_WIDTH(), Math.max(MIN_WIDTH, Math.round(px)));
    panel.style.width   = clamped + 'px';
    if (trigger && isOpen) trigger.style.right = clamped + 'px';
  }

  function getWidth() {
    const panel = document.getElementById('si-panel');
    return panel ? Math.round(panel.getBoundingClientRect().width) : DEFAULT_WIDTH;
  }

  function adjustWidth(delta) {
    setWidth(getWidth() + delta);
  }

  function openWidthDialog() {
    // Remove any existing dialog
    document.getElementById('si-width-dialog')?.remove();

    const cur = getWidth();
    const dialog = document.createElement('div');
    dialog.id = 'si-width-dialog';
    dialog.innerHTML = `
      <div class="si-wd-title">Panel Width</div>
      <div class="si-wd-current">Current: <strong>${cur}px</strong> &nbsp;|&nbsp; Min: ${MIN_WIDTH}px &nbsp;|&nbsp; Max: ${MAX_WIDTH()}px</div>
      <div class="si-wd-row">
        <button class="si-wd-btn" data-delta="-${STEP * 2}">−${STEP * 2}</button>
        <button class="si-wd-btn" data-delta="-${STEP}">−${STEP}</button>
        <input id="si-wd-input" class="si-wd-input" type="number" value="${cur}" min="${MIN_WIDTH}" max="${MAX_WIDTH()}" />
        <button class="si-wd-btn" data-delta="+${STEP}">+${STEP}</button>
        <button class="si-wd-btn" data-delta="+${STEP * 2}">+${STEP * 2}</button>
      </div>
      <div class="si-wd-row si-wd-actions">
        <button id="si-wd-cancel" class="si-wd-btn si-wd-secondary">Cancel (Esc)</button>
        <button id="si-wd-apply"  class="si-wd-btn si-wd-primary">Apply (Enter)</button>
      </div>
      <div class="si-wd-hint">Alt+[ &nbsp;Decrease &nbsp;·&nbsp; Alt+] &nbsp;Increase &nbsp;·&nbsp; Alt+W &nbsp;This dialog</div>`;

    document.body.appendChild(dialog);

    const input = dialog.querySelector('#si-wd-input');
    input.focus();
    input.select();

    const apply = () => {
      const v = parseInt(input.value, 10);
      if (!isNaN(v)) setWidth(v);
      dialog.remove();
    };
    const cancel = () => dialog.remove();

    dialog.querySelector('#si-wd-apply').addEventListener('click', apply);
    dialog.querySelector('#si-wd-cancel').addEventListener('click', cancel);

    dialog.querySelectorAll('[data-delta]').forEach(btn => {
      btn.addEventListener('click', () => {
        const delta = parseInt(btn.dataset.delta, 10);
        const next  = Math.min(MAX_WIDTH(), Math.max(MIN_WIDTH, (parseInt(input.value, 10) || cur) + delta));
        input.value = next;
        setWidth(next);
      });
    });

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); apply();  }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });

    // Click outside to close
    const outside = e => { if (!dialog.contains(e.target)) { cancel(); document.removeEventListener('mousedown', outside); } };
    setTimeout(() => document.addEventListener('mousedown', outside), 50);
  }

  // ── Toggle ────────────────────────────────────────────────────────────────

  function toggle() {
    isOpen = !isOpen;
    const panel   = document.getElementById('si-panel');
    const trigger = document.getElementById('si-trigger');
    if (!panel || !trigger) return;
    panel.classList.toggle('si-open', isOpen);
    if (isOpen) {
      requestAnimationFrame(() => {
        trigger.style.right = (panel.getBoundingClientRect().width || DEFAULT_WIDTH) + 'px';
      });
    } else {
      trigger.style.right = '0px';
    }
  }

  // ── Build panel ───────────────────────────────────────────────────────────

  const TAB_ORDER_KEY = 'si_tab_order';
  function orderedTabs() {
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem(TAB_ORDER_KEY) || '[]'); } catch (_) {}
    if (!saved.length) return TABS.slice();
    const byId = Object.fromEntries(TABS.map(t => [t.id, t]));
    const out = [];
    saved.forEach(id => { if (byId[id]) { out.push(byId[id]); delete byId[id]; } });
    // append any tabs not in the saved order (e.g. newly added)
    TABS.forEach(t => { if (byId[t.id]) out.push(t); });
    return out;
  }

  function buildPanel(data) {
    appData = data;
    document.getElementById('si-root')?.remove();

    const tabsOrdered = orderedTabs();

    const root = document.createElement('div');
    root.id = 'si-root';
    root.innerHTML = `
      <button id="si-trigger" title="Open Screener Insights">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
        </svg>
      </button>

      <aside id="si-panel" style="width:${DEFAULT_WIDTH}px">
        <div id="si-resize-handle" title="Drag to resize"></div>

        <header class="si-header">
          <span class="si-co-name" title="${data.companyName}">${data.companyName}</span>
          <button class="si-btn-close" id="si-close">✕</button>
        </header>

        <div class="si-layout">
          <nav class="si-tab-rail">
            ${tabsOrdered.map((t, i) => `
              <button class="si-tab${i === 0 ? ' si-tab-active' : ''}" draggable="true"
                      data-tab="${t.id}" title="${t.label} — drag to reorder">
                <span class="si-tab-icon">${t.icon}</span>
                <span class="si-tab-label">${t.label}</span>
              </button>`).join('')}
          </nav>
          <div id="si-body" class="si-body"></div>
        </div>
      </aside>`;

    document.body.appendChild(root);

    const panel   = root.querySelector('#si-panel');
    const trigger = root.querySelector('#si-trigger');

    trigger.addEventListener('click', toggle);
    root.querySelector('#si-close').addEventListener('click', toggle);
    const rail = root.querySelector('.si-tab-rail');
    let tabDrag = null;
    root.querySelectorAll('.si-tab').forEach(btn => {
      btn.addEventListener('click', () => { if (!tabDrag) switchTab(btn.dataset.tab); });
      btn.addEventListener('dragstart', e => {
        tabDrag = btn;
        e.dataTransfer.effectAllowed = 'move';
        setTimeout(() => btn.style.opacity = '0.4', 0);
      });
      btn.addEventListener('dragend', () => {
        btn.style.opacity = '';
        root.querySelectorAll('.si-tab').forEach(t => t.classList.remove('si-drag-over'));
        // small delay so the trailing click after a drag is suppressed
        setTimeout(() => { tabDrag = null; }, 50);
      });
      btn.addEventListener('dragover', e => {
        if (!tabDrag || tabDrag === btn) return;
        e.preventDefault();
        btn.classList.add('si-drag-over');
      });
      btn.addEventListener('dragleave', () => btn.classList.remove('si-drag-over'));
      btn.addEventListener('drop', e => {
        e.preventDefault();
        btn.classList.remove('si-drag-over');
        if (!tabDrag || tabDrag === btn) return;
        const rect = btn.getBoundingClientRect();
        const after = (e.clientY - rect.top) > rect.height / 2;
        rail.insertBefore(tabDrag, after ? btn.nextSibling : btn);
        const order = Array.from(rail.querySelectorAll('.si-tab')).map(t => t.dataset.tab);
        localStorage.setItem(TAB_ORDER_KEY, JSON.stringify(order));
      });
    });

    initResize(panel, trigger);
    switchTab(tabsOrdered[0].id);
  }

  return { buildPanel, toggle, adjustWidth, openWidthDialog };
})();
