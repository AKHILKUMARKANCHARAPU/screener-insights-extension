// scraper.js — Screener.in data parser + equity research framework
window.ScreenerInsights = window.ScreenerInsights || {};

ScreenerInsights.scraper = (() => {

  // ── Helpers ──────────────────────────────────────────────────────────────

  function cleanNumber(str) {
    if (!str) return null;
    const s = str.replace(/[,₹%\s]/g, '').replace(/Cr\.?/gi, '').trim();
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  // Fuzzy row finder — exact match first, then partial substring
  function findRow(data, ...terms) {
    if (!data) return null;
    for (const t of terms) {
      if (data[t] != null) return data[t];
    }
    const tl = terms.map(t => t.toLowerCase());
    for (const [k, v] of Object.entries(data)) {
      if (tl.some(t => k.toLowerCase().includes(t))) return v;
    }
    return null;
  }

  // Parse a market-cap string like "12,345 Cr" or "1.24 L Cr" → number in Crore.
  function parseMarketCapCr(str) {
    if (!str) return null;
    const s = String(str).replace(/,/g, '').trim();
    const lakh = s.match(/([\d.]+)\s*L\s*Cr/i);
    if (lakh) return parseFloat(lakh[1]) * 1e5;
    const cr = s.match(/([\d.]+)\s*Cr/i);
    if (cr) return parseFloat(cr[1]);
    const plain = parseFloat(s);
    return isNaN(plain) ? null : plain;
  }

  // Returns 'Large'|'Mid'|'Small'|'Micro' based on market cap in Crore.
  // SEBI/AMFI official definition (rank-based, Jan 2026 approximate floors):
  //   Large  Rank 1–100    ≥ ~₹1,05,000 Cr
  //   Mid    Rank 101–250  ₹34,700 – ₹1,05,000 Cr
  //   Small  Rank 251–500  ₹9,000 – ₹34,700 Cr   (Nifty 500 ceiling, ~₹9k micro boundary)
  //   Micro  Rank 501+     < ₹9,000 Cr            (Nifty Microcap 250 / convention)
  function marketCapCategory(crores) {
    if (crores == null) return null;
    if (crores >= 105000) return 'Large';
    if (crores >= 34700)  return 'Mid';
    if (crores >= 9000)   return 'Small';
    return 'Micro';
  }

  function avg3(arr) {
    if (!arr) return null;
    const last3 = arr.slice(-3).filter(v => v != null && !isNaN(v));
    if (!last3.length) return null;
    return last3.reduce((a, b) => a + b, 0) / last3.length;
  }

  function cagr(arr, years) {
    if (!arr || arr.length < years + 1) return null;
    const recent = arr[arr.length - 1];
    const base   = arr[arr.length - 1 - years];
    if (base == null || base <= 0 || recent == null) return null;
    return parseFloat(((Math.pow(recent / base, 1 / years) - 1) * 100).toFixed(1));
  }

  // ── DOM parsers ───────────────────────────────────────────────────────────

  function parseTable(sectionId) {
    const section = document.querySelector('#' + sectionId);
    if (!section) return null;
    const table = section.querySelector('table');
    if (!table) return null;

    const headerCells = Array.from(table.querySelectorAll('thead th'));
    const headers = headerCells.slice(1).map(th => th.textContent.trim()).filter(Boolean);

    const data = {};
    table.querySelectorAll('tbody tr').forEach(row => {
      const cells = Array.from(row.querySelectorAll('td'));
      if (cells.length < 2) return;
      const label = cells[0].textContent.trim()
        .replace(/[+\-↑↓]/g, '').replace(/\s+/g, ' ').trim();
      if (!label) return;
      data[label] = cells.slice(1, headers.length + 1).map(td => cleanNumber(td.textContent));
    });

    return { headers, data };
  }

  function parseTopRatios() {
    const ratios = {};
    document.querySelectorAll('#top-ratios li, .company-ratios li').forEach(li => {
      const nameEl = li.querySelector('.name');
      if (!nameEl) return;
      const key = nameEl.textContent.trim().replace(/[*#]/g, '').trim();
      if (!key) return;
      // Always use full li text minus the name label — this correctly captures
      // multi-span values like "High / Low" where screener.in uses two .number spans.
      const val = li.textContent.replace(nameEl.textContent, '').trim().replace(/\s+/g, ' ');
      if (val) ratios[key] = val;
    });
    return ratios;
  }

  function getCompanyName() {
    const el = document.querySelector('h1.margin-0, h1[class*="company"], h1');
    return el ? el.textContent.trim() : document.title.split('|')[0].trim();
  }

  function getNseSymbol() {
    const allText = document.body.innerText;
    const m = allText.match(/NSE:\s*([A-Z0-9&]+)/);
    return m ? m[1] : null;
  }

  function parseShareholding() {
    const section = document.querySelector('#shareholding');
    if (!section) return null;
    const table = section.querySelector('table');
    if (!table) return null;

    const headerCells = Array.from(table.querySelectorAll('thead th'));
    const headers = headerCells.slice(1).map(th => th.textContent.trim()).filter(Boolean);

    const data = {};
    let promoterSharesArr = null;  // to compute pledge % from share count if needed

    table.querySelectorAll('tbody tr').forEach(row => {
      const cells = Array.from(row.querySelectorAll('td'));
      if (cells.length < 2) return;
      const label = cells[0].textContent.trim().replace(/\s+/g, ' ').trim();
      if (!label) return;
      const vals = cells.slice(1, headers.length + 1).map(td => {
        const t = td.textContent.trim().replace(/[,%\s]/g, '');
        const n = parseFloat(t);
        return isNaN(n) ? null : n;
      });
      data[label] = vals;
      const ll = label.toLowerCase();
      if (ll.includes('promoter') && !ll.includes('pledge') && !ll.includes('share')) {
        promoterSharesArr = vals;
      }
    });

    console.debug('[SI] Shareholding rows:', Object.keys(data));

    // ── Resolve pledge % ──────────────────────────────────────────────────────
    // screener.in may show pledge as:
    //   (a) "Pledged percentage" row — already a % value  ← ideal
    //   (b) "No. of shares pledged" row — share count; need total shares to compute %
    //   (c) Nowhere in the table (check top-ratios separately)

    let pledgePctArr = null;

    // Case (a): look for a row whose label contains "pledged" AND whose values look like percentages (0–100)
    for (const [k, v] of Object.entries(data)) {
      const ll = k.toLowerCase();
      if (!ll.includes('pledg')) continue;
      const allPct = v.every(x => x == null || (x >= 0 && x <= 100));
      const hasNonZero = v.some(x => x != null && x > 0);
      if (allPct) {
        pledgePctArr = v;
        console.debug('[SI] Pledge row (pct):', k, v.slice(-3));
        break;
      }
      // Case (b): share count row — too large to be a %, skip for now (handled below)
      console.debug('[SI] Pledge row (count?):', k, v.slice(-3));
    }

    // Case (b): if we found a share-count pledge row, try to convert using "No. of Shares" row
    if (!pledgePctArr) {
      let pledgeCountArr = null, totalSharesArr = null;
      for (const [k, v] of Object.entries(data)) {
        const ll = k.toLowerCase();
        if (ll.includes('pledg')) pledgeCountArr = v;
        if ((ll.includes('no. of shares') || ll === 'shares' || ll.includes('total shares')) && !ll.includes('pledg'))
          totalSharesArr = v;
      }
      if (pledgeCountArr && totalSharesArr) {
        pledgePctArr = pledgeCountArr.map((pc, i) => {
          const ts = totalSharesArr[i];
          return pc != null && ts != null && ts > 0 ? parseFloat((pc / ts * 100).toFixed(2)) : null;
        });
        console.debug('[SI] Pledge computed from share count:', pledgePctArr.slice(-3));
      }
    }

    // Case (c): try top-ratios / prominent page text for current pledge %
    // (will be handled in scrapeAll via keyRatios lookup)

    if (pledgePctArr) data['__pledgePct__'] = pledgePctArr;

    return { headers, data };
  }

  // ── Framework: SSGR + FCF ─────────────────────────────────────────────────

  function computeFramework(pnl, bs, cf) {
    if (!pnl || !bs) return {};

    const pnlD = pnl.data, bsD = bs.data, cfD = cf?.data || {};

    // ── Pull raw series ──────────────────────────────────────────────────
    const sales    = findRow(pnlD, 'Sales', 'Revenue', 'Net Sales', 'Total Revenue', 'Revenue from Operations');
    const np       = findRow(pnlD, 'Net Profit', 'Profit after tax', 'PAT', 'Profit After Tax');
    const dep      = findRow(pnlD, 'Depreciation', 'Depreciation Amortisation', 'Depreciation Amortization', 'D&A');
    const opProfit = findRow(pnlD, 'Operating Profit', 'PBDIT', 'EBITDA', 'EBIT');
    const ocf      = findRow(cfD,  'Cash from Operating Activity', 'Cash from Operations', 'Net Cash from Operating');
    const icf      = findRow(cfD,  'Cash from Investing Activity', 'Cash from Investing', 'Net Cash from Investing');
    const divPaid  = findRow(cfD,  'Dividends paid', 'Dividend Paid', 'Dividends Paid', 'Dividend paid', 'Equity Dividend Paid');
    // screener.in provides "Dividend Payout %" directly in P&L — use it as authoritative DPR source
    const divPayoutPct = findRow(pnlD, 'Dividend Payout %', 'Dividend Payout Ratio', 'Payout %');

    // screener.in labels NFA as "Fixed Assets" (net block after depreciation)
    const nfa  = findRow(bsD, 'Fixed Assets', 'Net Block', 'Net Fixed Assets',
                              'Property, Plant and Equipment', 'Tangible Assets');
    const cwip = findRow(bsD, 'Capital Work in Progress', 'CWIP', 'Capital WIP',
                              'Capital work-in-progress');

    const n = sales ? sales.length : 0;

    // ── Always compute: cumulative CFO vs PAT ────────────────────────────
    const cumCFO = [], cumPAT = [];
    let rCFO = 0, rPAT = 0;
    for (let i = 0; i < n; i++) {
      rCFO += (ocf?.[i] ?? 0);
      rPAT += (np?.[i]  ?? 0);
      cumCFO.push(parseFloat(rCFO.toFixed(0)));
      cumPAT.push(parseFloat(rPAT.toFixed(0)));
    }

    // ── FCF fallback: use OCF + investing CF when NFA unavailable ────────
    const fcfSimple = (ocf && icf)
      ? ocf.map((o, i) => o != null ? parseFloat((o + (icf[i] || 0)).toFixed(0)) : null)
      : null;

    // ── CFO / Operating Profit % ─────────────────────────────────────────
    const cfoOpArr = (ocf && opProfit)
      ? ocf.map((o, i) => {
          const op = opProfit[i];
          return o != null && op && op !== 0 ? parseFloat((o / op * 100).toFixed(1)) : null;
        })
      : null;

    // ── SSGR (requires NFA) ──────────────────────────────────────────────
    const nfatArr = [], npmArr = [], dprArr = [], depRateArr = [];
    const ssgrArr = [], capexArr = [], fcfProperArr = [];
    const years   = [];   // parallel year labels (from index 1 onwards)

    if (nfa && sales && np && dep) {
      const m = Math.min(nfa.length, sales.length, np.length, dep.length);

      for (let i = 1; i < m; i++) {
        years.push(pnl.headers[i] || `Y${i}`);

        // NFAT
        const avgNFA = ((nfa[i - 1] || 0) + (nfa[i] || 0)) / 2;
        const nfat   = avgNFA > 0 && sales[i] != null ? parseFloat((sales[i] / avgNFA).toFixed(2)) : null;
        nfatArr.push(nfat);

        // NPM (fraction)
        const npm = sales[i] > 0 && np[i] != null ? np[i] / sales[i] : null;
        npmArr.push(npm != null ? parseFloat(npm.toFixed(4)) : null);

        // DPR (fraction) — prefer screener.in's own "Dividend Payout %" from P&L (already % value)
        let dpr = 0;
        if (divPayoutPct && divPayoutPct[i] != null) {
          dpr = divPayoutPct[i] / 100;
        } else if (divPaid && np[i] > 0) {
          dpr = Math.abs(divPaid[i] || 0) / np[i];
        }
        dprArr.push(parseFloat(dpr.toFixed(4)));

        // Dep rate = Dep / NFA_end
        const depRate = nfa[i] > 0 ? (dep[i] || 0) / nfa[i] : null;
        depRateArr.push(depRate != null ? parseFloat(depRate.toFixed(4)) : null);

        // Per-year SSGR
        if (nfat != null && npm != null && depRate != null) {
          ssgrArr.push(parseFloat(((nfat * npm * (1 - dpr) - depRate) * 100).toFixed(1)));
        } else {
          ssgrArr.push(null);
        }

        // Capex = (NFA + CWIP)_end - (NFA + CWIP)_start + Dep
        const end   = (nfa[i]   || 0) + (cwip?.[i]   || 0);
        const start = (nfa[i-1] || 0) + (cwip?.[i-1] || 0);
        const capex = end - start + (dep[i] || 0);
        capexArr.push(parseFloat(capex.toFixed(0)));

        // FCF (proper) = OCF - Capex
        const o = ocf?.[i] ?? null;
        fcfProperArr.push(o != null ? parseFloat((o - capex).toFixed(0)) : null);
      }
    }

    // 3-year averages
    const avgNFAT    = avg3(nfatArr);
    const avgNPM     = avg3(npmArr);
    const avgDPR     = avg3(dprArr);
    const avgDepRate = avg3(depRateArr);

    let ssgrFinal = null;
    if (avgNFAT != null && avgNPM != null && avgDPR != null && avgDepRate != null) {
      ssgrFinal = parseFloat(((avgNFAT * avgNPM * (1 - avgDPR) - avgDepRate) * 100).toFixed(1));
    }

    // Prefer screener.in's own "Free Cash Flow" row — it's already computed correctly.
    // Fall back to our balance-sheet-derived Capex calculation, then OCF+ICF.
    const fcfScreener = findRow(cfD, 'Free Cash Flow');
    const fcfFinal = fcfScreener || (fcfProperArr.length ? fcfProperArr : fcfSimple);

    console.debug('[ScreenerInsights] NFA found:', !!nfa, '| NFA label rows:', Object.keys(bsD).filter(k => k.toLowerCase().includes('asset') || k.toLowerCase().includes('block') || k.toLowerCase().includes('fixed')));
    console.debug('[ScreenerInsights] DEP found:', !!dep, '| DEP label rows:', Object.keys(pnlD).filter(k => k.toLowerCase().includes('dep') || k.toLowerCase().includes('amort')));

    return {
      // SSGR
      ssgrYears: years,
      nfatArr, npmArr, dprArr, depRateArr, ssgrArr,
      ssgrInputs: { avgNFAT, avgNPM, avgDPR, avgDepRate },
      ssgrFinal,
      // FCF
      capexArr,
      fcfArr: fcfFinal,
      fcfProper: fcfProperArr.length > 0,
      // CFO/OP
      cfoOpArr,
      // Cumulative
      cumCFO, cumPAT,
    };
  }

  // ── Framework: Moat check ─────────────────────────────────────────────────

  function computeMoatCheck(d, pnl) {
    const checks  = [];
    const pnlData = pnl?.data || {};

    // Step 1 — Sales growth
    const s5 = d.revCAGR5, s3 = d.revCAGR3;
    if (s5 != null) {
      const status = s5 > 12 ? 'pass' : s5 > 5 ? 'caution' : 'fail';
      checks.push({
        step: 1, name: 'Sales Growth vs Peers', status,
        finding: `Revenue CAGR 3Y: ${s3 ?? 'N/A'}%, 5Y: ${s5}%. ${
          status === 'pass'    ? 'Strong consistent growth — likely gaining market share.' :
          status === 'caution' ? 'Moderate growth — verify vs peer set before concluding.' :
                                 'Weak sales momentum — investigate demand or market share loss.'}`
      });
    }

    // Step 2 — OPM stability / pattern
    const opm = findRow(pnlData, 'OPM %');
    if (opm && opm.length >= 4) {
      const valid   = opm.filter(v => v != null);
      const minOPM  = Math.min(...valid), maxOPM = Math.max(...valid);
      const range   = maxOPM - minOPM;
      const recentN = Math.min(3, valid.length);
      const recent  = valid.slice(-recentN).reduce((a, b) => a + b, 0) / recentN;
      const old     = valid.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
      const trend   = recent - old;

      let status = 'pass', pattern = 'Stable/Improving';
      if (range > 15)    { status = 'caution'; pattern = 'Cyclical'; }
      else if (trend < -4) { status = 'fail';    pattern = 'Declining'; }
      else if (trend < -1) { status = 'caution'; pattern = 'Slight erosion'; }

      d.performancePattern = pattern;
      checks.push({
        step: 2, name: 'OPM Stability (Pricing Power)', status,
        finding: `Pattern: ${pattern}. Range: ${minOPM.toFixed(1)}%–${maxOPM.toFixed(1)}%. Recent 3Y avg: ${recent.toFixed(1)}% vs early avg: ${old.toFixed(1)}%.`
      });
    }

    // Step 3 — Sales → Profit conversion
    const p5 = d.profCAGR5;
    if (s5 != null && p5 != null && s5 !== 0) {
      const ratio  = p5 / s5;
      const status = ratio >= 0.8 ? 'pass' : ratio >= 0.4 ? 'caution' : 'fail';
      checks.push({
        step: 3, name: 'Sales → Profit Conversion', status,
        finding: `Profit CAGR 5Y ${p5}% vs Revenue CAGR ${s5}% (ratio ${ratio.toFixed(2)}). ${
          status === 'pass'    ? 'Profits growing in line — operating leverage visible.' :
          status === 'caution' ? 'Profit lagging sales — margin pressure or cost creep.' :
                                 'Hollow growth: profits far behind revenue growth.'}`
      });
    }

    // Step 4 — Profit → Cash (cumulative CFO vs PAT)
    const cCFO = d.cumCFO, cPAT = d.cumPAT;
    if (cCFO && cPAT && cPAT.length) {
      const totCFO = cCFO[cCFO.length - 1];
      const totPAT = cPAT[cPAT.length - 1];
      const ratio  = totPAT > 0 ? totCFO / totPAT : null;
      if (ratio != null) {
        const status = ratio >= 0.9 ? 'pass' : ratio >= 0.65 ? 'caution' : 'fail';
        checks.push({
          step: 4, name: 'Profit → Cash (CFO/PAT)', status,
          finding: `Cum. CFO ₹${totCFO.toFixed(0)} Cr vs Cum. PAT ₹${totPAT.toFixed(0)} Cr → ${(ratio * 100).toFixed(0)}% conversion. ${
            status === 'pass'    ? 'Excellent — profits are real and collected.' :
            status === 'caution' ? 'Moderate — watch debtors/inventory days.' :
                                   'Poor cash conversion — possible working capital leak or fictitious profits.'}`
        });
      }
    }

    // Step 5 — Buffett ₹1 test (semi-automated)
    const retained = cPAT?.[cPAT.length - 1];
    checks.push({
      step: 5, name: 'Buffett ₹1 Test', status: 'info',
      finding: `Approx. cumulative PAT ₹${retained?.toFixed(0) ?? '?'} Cr over period. Verify manually: market cap increase > retained earnings (PAT − dividends) over same 10 years.`
    });

    return checks;
  }

  function ssgrScenario(ssgrPct, salesCAGR) {
    if (ssgrPct == null || salesCAGR == null)
      return { label: 'Insufficient Data', color: 'info', implication: 'Net Block / Fixed Assets data not found on page. Try the standalone (non-consolidated) view or verify the balance sheet section.' };
    if (ssgrPct > salesCAGR + 2)
      return { label: 'Self-Funded Surplus', color: 'pass', implication: `SSGR ${ssgrPct}% > Revenue growth ${salesCAGR}% — company can fund its own growth, debt-free compounding.` };
    if (ssgrPct < salesCAGR - 3)
      return { label: 'External Funding Required', color: 'fail', implication: `SSGR ${ssgrPct}% < Revenue growth ${salesCAGR}% — needs debt/equity to maintain growth. Check if debt is serviceable.` };
    return { label: 'Borderline', color: 'caution', implication: `SSGR ${ssgrPct}% ≈ Revenue growth ${salesCAGR}% — monitor working capital and FCF carefully.` };
  }

  // ── Top Investors (FII / DII sub-holdings) ──────────────────────────────

  // Known star investors and PMS/AIF houses to detect in shareholder lists.
  // Keys are lowercase substrings to match against holder names.
  const STAR_INVESTORS = [
    { key: 'kacholia',            label: 'Ashish Kacholia' },
    { key: 'lucky investment',    label: 'Ashish Kacholia (Lucky Investment)' },
    { key: 'vijay kedia',         label: 'Vijay Kedia' },
    { key: 'kedia securities',    label: 'Vijay Kedia (Kedia Securities)' },
    { key: 'mukul agrawal',       label: 'Mukul Agrawal' },
    { key: 'param capital',       label: 'Mukul Agrawal (Param Capital)' },
    { key: 'dolly khanna',        label: 'Dolly Khanna' },
    { key: 'rekha jhunjhunwala',  label: 'Rekha Jhunjhunwala' },
    { key: 'rare enterprises',    label: 'RARE Enterprises (R. Jhunjhunwala)' },
    { key: 'porinju',             label: 'Porinju Veliyath' },
    { key: 'equity intelligence', label: 'Equity Intelligence (Porinju)' },
    { key: 'anil kumar goel',     label: 'Dr. Anil Kumar Goel' },
    { key: 'ramesh damani',       label: 'Ramesh Damani' },
    { key: 'nemish shah',         label: 'Nemish Shah' },
    { key: 'radhakishan damani',  label: 'Radhakishan Damani' },
    { key: 'abakkus',             label: 'Abakkus (Sunil Singhania)' },
    { key: 'aequitas',            label: 'Aequitas (Siddhartha Bhaiya)' },
    { key: 'sageone',             label: 'SageOne (Samit Vartak)' },
    { key: 'sage one',            label: 'SageOne (Samit Vartak)' },
    { key: 'nine rivers',         label: 'Nine Rivers Capital' },
    { key: 'negen capital',       label: 'Negen Capital (Neil Bahal)' },
    { key: 'marcellus',           label: 'Marcellus (Saurabh Mukherjea)' },
    { key: 'valuequest',          label: 'ValueQuest (Ravi Dharamshi)' },
    { key: 'stallion asset',      label: 'Stallion Asset (Amit Jeswani)' },
    { key: 'solidarity',          label: 'Solidarity Investment' },
    { key: 'multi-act',           label: 'Multi-Act' },
  ];

  // Fetch all holders for one classification; returns sorted array with trend info.
  // trueLatestPeriod: the authoritative latest quarter from the main shareholding
  // table headers (e.g. "Mar 2026"). Passed in so we don't rely on the investor
  // API data — which may only contain older holders — to determine recency.
  async function fetchInvestorClass(companyId, classification, trueLatestPeriod) {
    try {
      // Screener serves the named-holder breakdown under inconsistent paths and
      // classification slugs across companies. Try the known variants and use
      // the first that returns real holder rows, so a single path change (or a
      // company served under a different slug) can't blank the whole feature.
      const slugAliases = {
        foreign_institutions:  ['foreign_institutions', 'fii', 'foreign_institutional_investors'],
        domestic_institutions: ['domestic_institutions', 'dii', 'domestic_institutional_investors', 'mutual_funds'],
        public:                ['public'],
        others:                ['others'],
      }[classification] || [classification];

      const candidates = [];
      for (const slug of slugAliases) {
        candidates.push(`/api/3/${companyId}/investors/${slug}/quarterly/`);
        candidates.push(`/api/company/${companyId}/investors/${slug}/quarterly/`);
        candidates.push(`/api/3/${companyId}/investors/${slug}/`);
      }

      let json = null, usedUrl = null;
      for (const url of candidates) {
        try {
          const resp = await fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
          if (!resp.ok) continue;
          const j = await resp.json();
          if (j && typeof j === 'object' && !Array.isArray(j) &&
              Object.keys(j).filter(k => k !== 'isExpandable').length) {
            json = j; usedUrl = url; break;
          }
        } catch (_) { /* try next candidate */ }
      }
      if (!json) { console.debug('[SI] investors: no endpoint returned data for', classification); return []; }
      console.debug('[SI] investors:', classification, 'via', usedUrl);

      const entries = Object.entries(json).filter(([k]) => k !== 'isExpandable');
      if (!entries.length) return [];

      const MONTH_ORDER = { Jan:1, Feb:2, Mar:3, Apr:4, May:5, Jun:6, Jul:7, Aug:8, Sep:9, Oct:10, Nov:11, Dec:12 };
      const parsePeriod = p => {
        const [m, y] = (p || '').split(' ');
        return (parseInt(y) || 0) * 100 + (MONTH_ORDER[m] || 0);
      };

      // Reference = the latest quarter from the MAIN shareholding table. A holder
      // must still appear in THAT quarter to be "current"; a holder whose last
      // reported quarter is older has exited (e.g. Govt of Singapore that sold
      // out by the latest quarter). Anchoring to the holder sub-data's own latest
      // would wrongly resurrect exited holders, so we anchor to the main table.
      const periodRe = /[A-Z][a-z]{2} \d{4}/;
      const latestScore = parsePeriod(trueLatestPeriod);

      return entries.map(([name, periodData]) => {
        const sorted = Object.entries(periodData)
          .filter(([k]) => k !== 'isExpandable' && periodRe.test(k))
          .sort(([a], [b]) => parsePeriod(a) - parsePeriod(b));

        const withVal = sorted.filter(([, v]) => parseFloat(String(v).replace(/,/g, '')) > 0);
        if (!withVal.length) return null;
        const lastReported = withVal[withVal.length - 1];
        // Exclude any holder not present in the latest quarter (they've exited).
        if (parsePeriod(lastReported[0]) < latestScore) return null;

        const latestVal = parseFloat(String(lastReported[1]).replace(/,/g, ''));
        const prevEntry = withVal.length > 1 ? withVal[withVal.length - 2] : null;
        const previous  = prevEntry ? parseFloat(String(prevEntry[1]).replace(/,/g, '')) : null;
        const change    = previous != null ? parseFloat((latestVal - previous).toFixed(2)) : null;
        const trend     = change == null ? 'new' : change > 0.01 ? 'up' : change < -0.01 ? 'down' : 'flat';
        return { name, pct: latestVal, previous, change, trend, classification };
      }).filter(Boolean).sort((a, b) => b.pct - a.pct);
    } catch (_) { return []; }
  }

  // Returns top 3 holders from a pre-fetched list.
  function topThree(list) { return list.slice(0, 3); }

  // Scans all fetched investor lists for known star investors.
  function detectStarInvestors(lists) {
    const found = [];
    const seen  = new Set();
    for (const holders of lists) {
      for (const h of holders) {
        const lower = h.name.toLowerCase();
        for (const si of STAR_INVESTORS) {
          if (lower.includes(si.key) && !seen.has(si.label)) {
            seen.add(si.label);
            found.push({ ...h, starLabel: si.label });
            break;
          }
        }
      }
    }
    return found.sort((a, b) => b.pct - a.pct);
  }

  // ── PE Range (5Y) ────────────────────────────────────────────────────────

  async function fetchDeliveryData(companyId) {
    const consolidated = location.pathname.includes('/consolidated') ? '&consolidated=true' : '';
    // Use the same metric-name format as the (working) price-series query.
    const urls = [
      `/api/company/${companyId}/chart/?q=Price-DMA50-DMA200-Volume&days=365${consolidated}`,
      `/api/company/${companyId}/chart/?q=Price-Volume&days=365${consolidated}`,
    ];
    const tryFetch = async (url) => {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('status ' + resp.status);
      return resp.json();
    };
    let json = null;
    for (const url of urls) {
      try { json = await tryFetch(url); break; }
      catch (e) { console.debug('[SI] deliveryData fetch failed for', url, e.message); }
    }
    if (!json) return null;
    try {
      // Volume: [date, volume, {delivery: pct}]  Price: [date, price]
      const volDs   = (json.datasets || []).find(ds => ds.label === 'Volume');
      const priceDs = (json.datasets || []).find(ds => ds.label === 'Price' || ds.label === 'Price on NSE' || ds.label === 'Price on BSE');
      if (!volDs?.values?.length) { console.debug('[SI] deliveryData: no Volume dataset'); return null; }
      const priceMap = {};
      (priceDs?.values || []).forEach(([dt, p]) => {
        const num = typeof p === 'number' ? p : parseFloat(String(p).replace(/,/g, ''));
        if (!isNaN(num)) priceMap[dt] = num;
      });
      // Keep ALL points so Price & Volume always renders; delivery % is optional per row.
      const result = volDs.values.map(v => ({
        date: v[0],
        volume: v[1],
        pct: (v[2] && v[2].delivery != null) ? v[2].delivery : null,
        price: priceMap[v[0]] ?? null,
      }));
      return result.length ? result : null;
    } catch (e) { console.debug('[SI] deliveryData parse error:', e); return null; }
  }

  async function fetchPERange(companyId, currentPEFromPage) {
    try {
      const consolidated = location.pathname.includes('/consolidated') ? '&consolidated=true' : '';
      // 3650 days ≈ 10 years of PE history
      const url = `/api/company/${companyId}/chart/?q=Price+to+Earning-Median+PE-EPS&days=3650${consolidated}`;
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const json = await resp.json();
      const peDs  = (json.datasets || []).find(ds => ds.label === 'PE');
      const medDs = (json.datasets || []).find(ds => ds.label?.startsWith('Median PE'));
      const epsDs = (json.datasets || []).find(ds => ds.label === 'EPS');
      if (!peDs || !peDs.values?.length) return null;
      const pairs = peDs.values.filter(v => v[1] != null && v[1] > 0);
      const vals = pairs.map(v => v[1]);
      const medianPE = medDs ? parseFloat(medDs.label.replace(/[^0-9.]/g, '')) : null;

      // Use percentile range (5th–95th) to exclude one-off spikes caused by near-zero
      // earnings quarters inflating PE to extreme values temporarily.
      const sorted = [...vals].sort((a, b) => a - b);
      const pct = (p) => sorted[Math.max(0, Math.floor(sorted.length * p / 100) - 1)];
      const rangeLow  = parseFloat(pct(5).toFixed(1));
      const rangeHigh = parseFloat(pct(95).toFixed(1));

      // Use current P/E from top-ratios (Stock P/E) as the authoritative current value.
      // Extend range if current P/E falls outside the percentile band.
      const current = currentPEFromPage ?? parseFloat(vals[vals.length - 1].toFixed(1));
      const high    = parseFloat(Math.max(rangeHigh, current).toFixed(1));
      const low     = parseFloat(Math.min(rangeLow,  current).toFixed(1));

      // Richer 10Y stats for the Valuation tab
      const mean    = parseFloat((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1));
      const p25     = parseFloat(pct(25).toFixed(1));
      const p75     = parseFloat(pct(75).toFixed(1));
      const med10   = parseFloat(pct(50).toFixed(1));   // computed 10Y median of PE series
      // Percentile rank of the current PE within the historical distribution
      const below   = sorted.filter(v => v <= current).length;
      const pctRank = parseFloat((below / sorted.length * 100).toFixed(0));
      // Approx years of history covered
      const firstTs = pairs[0]?.[0], lastTs = pairs[pairs.length - 1]?.[0];
      const years   = (firstTs && lastTs) ? Math.round((new Date(lastTs) - new Date(firstTs)) / (365.25 * 864e5)) : null;

      // Price series = PE × EPS, aligned by timestamp (for P/S & EV/EBITDA history)
      const epsByTs = {};
      if (epsDs?.values) epsDs.values.forEach(v => { if (v[1] != null) epsByTs[v[0]] = v[1]; });
      const seriesPrice = pairs
        .filter(p => epsByTs[p[0]] != null)
        .map(p => [p[0], parseFloat((p[1] * epsByTs[p[0]]).toFixed(2))]);

      return { high, low, median: medianPE, current, mean, p25, p75, med10, pctRank, years, n: vals.length,
               // Raw series for deriving historical P/S and EV/EBITDA bands
               seriesPE: pairs.map(p => [p[0], p[1]]),
               seriesPrice };
    } catch (_) { return null; }
  }

  // Fetch the actual daily Price series (~10 years) from screener's price chart.
  // Returns [[timestamp, price], ...] or null.
  async function fetchPriceSeries(companyId) {
    try {
      const consolidated = location.pathname.includes('/consolidated') ? '&consolidated=true' : '';
      const url = `/api/company/${companyId}/chart/?q=Price-DMA50-DMA200-Volume&days=3650${consolidated}`;
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const json = await resp.json();
      const priceDs = (json.datasets || []).find(ds => ds.label === 'Price' || ds.label === 'Price on NSE' || ds.label === 'Price on BSE');
      if (!priceDs?.values?.length) return null;
      return priceDs.values
        .filter(v => v[1] != null && v[1] > 0)
        .map(v => [v[0], typeof v[1] === 'number' ? v[1] : parseFloat(String(v[1]).replace(/,/g, ''))]);
    } catch (_) { return null; }
  }

  // Analyse quarterly or annual EPS series for a clear trend.
  // Rules (user spec):
  //   Flat       — last 4 periods max/min spread ≤ 20% (positive EPS only)
  //   Increasing — ≥70% of moves are up over last 6–8 periods
  //   Decreasing — ≥70% of moves are down over last 6–8 periods
  //   null       — mixed / no clear trend (don't show anything)
  function computeEpsTrend(vals) {
    if (!vals) return null;
    const all = vals.filter(v => v != null && !isNaN(v));
    if (all.length < 4) return null;

    // ── Flat: last 4 periods, all positive, max/min spread ≤ 20% ─────────
    const last4 = all.slice(-4);
    const mn4 = Math.min(...last4), mx4 = Math.max(...last4);
    if (mn4 > 0 && (mx4 - mn4) / mn4 <= 0.20) {
      return {
        trend: 'flat',
        detail: `Last 4 periods ₹${mn4.toFixed(1)}–₹${mx4.toFixed(1)} (within 20% range)`,
        first: last4[0], last: last4[last4.length - 1], count: 4
      };
    }

    // ── Increasing / Decreasing: last 6–8 periods ─────────────────────────
    const win = all.slice(-8);
    const n = win.length;
    let ups = 0, downs = 0;
    for (let i = 1; i < n; i++) {
      // Compare absolute values so loss-to-loss improvements count correctly;
      // but also treat sign change (loss→profit) as up, profit→loss as down.
      const prev = win[i - 1], curr = win[i];
      if (curr > prev * 1.03)      ups++;
      else if (curr < prev * 0.97) downs++;
    }
    const moves = ups + downs;
    if (moves < 3) return null;

    const upRatio = ups / moves;
    if (upRatio >= 0.70) {
      return {
        trend: 'increasing',
        detail: `Rising in ${ups} of ${n - 1} consecutive periods`,
        first: win[0], last: win[n - 1], count: n
      };
    }
    if (upRatio <= 0.30) {
      return {
        trend: 'decreasing',
        detail: `Falling in ${downs} of ${n - 1} consecutive periods`,
        first: win[0], last: win[n - 1], count: n
      };
    }
    return null;
  }

  // ── Schedule API (sub-row expansion) ─────────────────────────────────────

  function getCompanyId() {
    return document.querySelector('[data-company-id]')?.dataset?.companyId;
  }

  async function fetchSchedule(companyId, parentName, section) {
    try {
      const url = `/api/company/${companyId}/schedules/?parent=${encodeURIComponent(parentName)}&section=${section}`;
      const resp = await fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      if (!resp.ok) return {};
      return resp.json();
    } catch (_) { return {}; }
  }

  function mergeScheduleRow(tableResult, rowName, yearData) {
    tableResult.data[rowName] = tableResult.headers.map(yr => {
      const v = yearData[yr];
      return (typeof v === 'string' && v.trim() !== '') ? cleanNumber(v) : null;
    });
  }

  // Fetches sub-row data for all expandable rows in a section and merges into tableResult.
  // Does two levels: L1 (parent rows like "Other Assets") and L2 (nested like "Trade receivables").
  async function fetchAndMergeSchedules(tableResult, section) {
    if (!tableResult) return;
    const companyId = getCompanyId();
    if (!companyId) return;

    const sectionEl = document.querySelector('#' + section);
    if (!sectionEl) return;

    // Find all L1 expandable parent row names from DOM buttons
    const parentNames = [];
    sectionEl.querySelectorAll('tbody tr').forEach(row => {
      if (!row.querySelector('td button.button-plain')) return;
      const name = row.querySelector('td')?.textContent
        ?.replace(/[+\-↑↓]/g, '').replace(/\s+/g, ' ').trim();
      if (name) parentNames.push(name);
    });

    if (!parentNames.length) return;

    const l1Results = await Promise.all(
      parentNames.map(n => fetchSchedule(companyId, n, section))
    );

    // Merge L1 rows and collect L2 expandable names
    const l2Names = [];
    l1Results.forEach(scheduleData => {
      for (const [rowName, yearData] of Object.entries(scheduleData)) {
        if (typeof yearData !== 'object' || yearData == null) continue;
        mergeScheduleRow(tableResult, rowName, yearData);
        if (yearData.isExpandable) l2Names.push(rowName);
      }
    });

    // Fetch L2 (e.g. Trade receivables → Receivables over 6m / under 6m)
    if (l2Names.length) {
      const l2Results = await Promise.all(
        l2Names.map(n => fetchSchedule(companyId, n, section))
      );
      l2Results.forEach(scheduleData => {
        for (const [rowName, yearData] of Object.entries(scheduleData)) {
          if (typeof yearData !== 'object' || yearData == null) continue;
          mergeScheduleRow(tableResult, rowName, yearData);
        }
      });
    }

    console.debug('[SI] After schedule merge, BS rows:', Object.keys(tableResult.data));
  }

  // ── Main ─────────────────────────────────────────────────────────────────

  async function scrapeAll() {
    const companyName = getCompanyName();
    const nseSymbol   = getNseSymbol();
    const keyRatios   = parseTopRatios();

    const pnl          = parseTable('profit-loss');
    await fetchAndMergeSchedules(pnl, 'profit-loss');   // pulls Expenses breakdown (raw material, etc.) for GPM
    const bs           = parseTable('balance-sheet');
    await fetchAndMergeSchedules(bs, 'balance-sheet');
    const cf           = parseTable('cash-flow');
    await fetchAndMergeSchedules(cf, 'cash-flow');
    const ratios       = parseTable('ratios');
    const quarters     = parseTable('quarters');
    const shareholding = parseShareholding();
    // Parse current P/E from top-ratios for accurate current value in PE range bar
    let currentPE = null;
    for (const [k, v] of Object.entries(keyRatios)) {
      if (k.toLowerCase().includes('stock p/e') || k.toLowerCase() === 'p/e') {
        currentPE = parseFloat(String(v).replace(/[^0-9.]/g, '')) || null;
        break;
      }
    }
    // Market cap category
    let capCategory = null;
    for (const [k, v] of Object.entries(keyRatios)) {
      if (k.toLowerCase().includes('market cap')) {
        const cr = parseMarketCapCr(String(v));
        capCategory = marketCapCategory(cr);
        break;
      }
    }

    // EPS trend — prefer quarterly table (recent), supplement with annual P&L (longer history)
    let epsTrend = null;
    {
      // Quarterly EPS (last ~4–6 quarters)
      const qEps = quarters?.data
        ? findRow(quarters.data, 'EPS in Rs', 'EPS', 'Basic EPS', 'Diluted EPS', 'Earnings Per Share')
        : null;
      // Annual EPS from P&L (last ~10 years)
      const aEps = pnl?.data
        ? findRow(pnl.data, 'EPS in Rs', 'EPS', 'Basic EPS', 'Diluted EPS', 'Earnings Per Share')
        : null;

      // Use quarterly for recency; if too few points, fall back to annual
      const vals = (qEps && qEps.filter(v => v != null).length >= 4)
        ? qEps
        : (aEps || qEps || []);

      console.debug('[SI] EPS vals (q):', qEps, '| (a):', aEps, '| using:', vals);
      epsTrend = computeEpsTrend(vals);
      console.debug('[SI] EPS trend result:', epsTrend);
    }

    const cid = getCompanyId();
    // Use the last header of the shareholding table as the authoritative latest
    // quarter — this is always the rightmost column on screener.in.
    const shHeaders = shareholding?.headers || [];
    const trueLatest = shHeaders[shHeaders.length - 1] || '';

    const [peRange, priceSeries, deliveryData, fiiFull, diiFull, pubFull, othFull] = await Promise.all([
      fetchPERange(cid, currentPE),
      fetchPriceSeries(cid),
      fetchDeliveryData(cid),
      fetchInvestorClass(cid, 'foreign_institutions', trueLatest),
      fetchInvestorClass(cid, 'domestic_institutions', trueLatest),
      fetchInvestorClass(cid, 'public',                trueLatest),
      fetchInvestorClass(cid, 'others',                trueLatest),
    ]);
    const topFII      = topThree(fiiFull);
    const topDII      = topThree(diiFull);
    const starInvestors = detectStarInvestors([fiiFull, diiFull, pubFull, othFull]);

    const derived = {};

    // ── Base P&L metrics ──────────────────────────────────────────────────
    if (pnl) {
      const sales = findRow(pnl.data, 'Sales', 'Revenue', 'Net Sales', 'Total Revenue');
      const np    = findRow(pnl.data, 'Net Profit', 'Profit after tax', 'PAT');
      if (sales && np)
        derived.npm = sales.map((s, i) => s && np[i] != null ? parseFloat((np[i] / s * 100).toFixed(1)) : null);
      if (sales) { derived.revCAGR3  = cagr(sales, 3); derived.revCAGR5  = cagr(sales, 5); }
      if (np)    { derived.profCAGR3 = cagr(np, 3);    derived.profCAGR5 = cagr(np, 5); }
    }

    // ── Base BS metrics ───────────────────────────────────────────────────
    if (bs) {
      const borrowings = findRow(bs.data, 'Borrowings', 'Total Debt', 'Long Term Borrowings');
      const equity     = findRow(bs.data, 'Equity Capital', 'Share Capital');
      const reserves   = findRow(bs.data, 'Reserves', 'Reserves and Surplus', 'Other Equity');
      if (borrowings && equity && reserves) {
        derived.netWorth   = equity.map((e, i) => (e || 0) + (reserves[i] || 0));
        derived.debtEquity = borrowings.map((d, i) => {
          const nw = derived.netWorth[i];
          return nw > 0 ? parseFloat((d / nw).toFixed(2)) : null;
        });
      }
      // ── ROE = Net Income / (Equity Capital + Reserves) × 100 ─────────────
      if (pnl && equity && reserves) {
        const np = findRow(pnl.data, 'Net Profit', 'Profit after tax', 'PAT');
        if (np) {
          derived.roe = np.map((n, i) => {
            const nw = (equity[i] || 0) + (reserves[i] || 0);
            return nw > 0 && n != null ? parseFloat((n / nw * 100).toFixed(1)) : null;
          });
        }
      }
      derived.totalAssets = findRow(bs.data, 'Total Assets', 'Balance Sheet Total');
    }

    // ── Framework calculations ────────────────────────────────────────────
    const fw = computeFramework(pnl, bs, cf);
    Object.assign(derived, fw);   // adds cumCFO, cumPAT, ssgrFinal, fcfArr, etc.

    // Moat check (runs AFTER cumCFO/cumPAT are in derived)
    derived.moatCheck    = computeMoatCheck(derived, pnl);
    derived.ssgrScenario = ssgrScenario(derived.ssgrFinal, derived.revCAGR5);

    // P/E → Earnings Yield
    let peVal = null;
    for (const [k, v] of Object.entries(keyRatios)) {
      if (k.toLowerCase().includes('p/e') || k.toLowerCase() === 'stock p/e') {
        peVal = parseFloat(v.replace(/[^0-9.]/g, ''));
        break;
      }
    }
    derived.pe = peVal;
    derived.earningsYield = peVal && peVal > 0 ? parseFloat((100 / peVal).toFixed(2)) : null;

    // ── Price-to-Sales (P/S) — current + 10Y band (P/S = P/E × NPM) ─────────
    let psRange = null;
    try {
      const salesRow = pnl ? findRow(pnl.data, 'Sales', 'Revenue', 'Net Sales', 'Total Revenue') : null;
      const npRow    = pnl ? findRow(pnl.data, 'Net Profit', 'Profit after tax', 'PAT') : null;
      const pHdrs    = pnl?.headers || [];

      // Current P/S = Market Cap / latest annual Sales
      let mcapCr = null;
      for (const [k, v] of Object.entries(keyRatios)) {
        if (k.toLowerCase().includes('market cap')) { mcapCr = parseMarketCapCr(String(v)); break; }
      }
      let latestSales = null;
      if (salesRow) for (let i = salesRow.length - 1; i >= 0; i--) { if (salesRow[i] != null) { latestSales = salesRow[i]; break; } }
      const currentPS = (mcapCr && latestSales && latestSales > 0) ? parseFloat((mcapCr / latestSales).toFixed(2)) : null;

      // Historical band: map each PE observation's date to that FY's net margin
      if (peRange?.seriesPE?.length && salesRow && npRow && pHdrs.length) {
        const yearNpm = {};   // FY-end year → NPM fraction
        pHdrs.forEach((h, i) => {
          const m = String(h).match(/(\d{4})/);
          if (m && salesRow[i] && npRow[i] != null) yearNpm[+m[1]] = npRow[i] / salesRow[i];
        });
        const npmForDate = (ts) => {
          const dt = new Date(ts);
          if (isNaN(dt)) return null;
          const fy = dt.getMonth() >= 3 ? dt.getFullYear() : dt.getFullYear() - 1; // Indian FY ends Mar
          if (yearNpm[fy] != null) return yearNpm[fy];
          // nearest available year
          const ys = Object.keys(yearNpm).map(Number);
          if (!ys.length) return null;
          const nearest = ys.reduce((a, b) => Math.abs(b - fy) < Math.abs(a - fy) ? b : a);
          return yearNpm[nearest];
        };
        const psSeries = [];
        peRange.seriesPE.forEach(([ts, pe]) => {
          const npm = npmForDate(ts);
          if (npm != null && npm > 0 && pe > 0) psSeries.push([ts, parseFloat((pe * npm).toFixed(2))]);
        });
        const ps = psSeries.map(p => p[1]);
        if (ps.length >= 20) {
          const sorted = [...ps].sort((a, b) => a - b);
          const pc = p => sorted[Math.max(0, Math.floor(sorted.length * p / 100) - 1)];
          const mean = ps.reduce((a, b) => a + b, 0) / ps.length;
          const curPS = currentPS ?? parseFloat(sorted[sorted.length - 1].toFixed(2));
          const below = sorted.filter(v => v <= curPS).length;
          psRange = {
            current: curPS,
            low:    parseFloat(pc(5).toFixed(2)),
            high:   parseFloat(pc(95).toFixed(2)),
            median: parseFloat(pc(50).toFixed(2)),
            mean:   parseFloat(mean.toFixed(2)),
            pctRank: parseFloat((below / sorted.length * 100).toFixed(0)),
            years:  peRange.years,
            n:      ps.length,
            series: psSeries,
          };
        }
      }
      // If no series, still expose current P/S so the tab can show it
      if (!psRange && currentPS != null) psRange = { current: currentPS, low: null, high: null, median: null, mean: null, pctRank: null, years: null, n: 0 };
    } catch (_) { psRange = null; }
    derived.psRange = psRange;

    // ── EV/EBITDA — current + 10Y band ──────────────────────────────────────
    // EV = MCap + Total Debt − Cash;  MCap = Price × shares;
    // shares = Equity Capital ÷ Face Value;  EBITDA ≈ Operating Profit
    let evRange = null;
    try {
      const eqCapRow = bs ? findRow(bs.data, 'Equity Capital', 'Share Capital', 'Equity Share Capital') : null;
      const debtRow  = bs ? findRow(bs.data, 'Borrowings', 'Total Debt', 'Long Term Borrowings') : null;
      const cashRow  = bs ? findRow(bs.data, 'Cash Equivalents', 'Cash and Bank Balances', 'Cash & Bank', 'Cash and Cash Equivalents', 'Cash & Equivalents', 'Cash') : null;
      const opRow    = pnl ? findRow(pnl.data, 'Operating Profit', 'EBITDA') : null;
      const bsH      = bs?.headers || [];
      const pH2      = pnl?.headers || [];

      let faceVal = null;
      for (const [k, v] of Object.entries(keyRatios)) {
        if (k.toLowerCase().includes('face value')) { faceVal = parseFloat(String(v).replace(/[^0-9.]/g, '')); break; }
      }

      // Prefer the actual price series; fall back to PE×EPS-derived series
      const priceSrc = (priceSeries && priceSeries.length) ? priceSeries : (peRange?.seriesPrice || []);
      if (eqCapRow && opRow && faceVal && faceVal > 0 && priceSrc.length) {
        // FY-end year → { eqCap, debt, cash, ebitda }
        const fyData = {};
        bsH.forEach((h, i) => {
          const m = String(h).match(/(\d{4})/);
          if (!m) return;
          fyData[+m[1]] = fyData[+m[1]] || {};
          fyData[+m[1]].eqCap = eqCapRow[i];
          fyData[+m[1]].debt  = debtRow ? (debtRow[i] ?? 0) : 0;
          fyData[+m[1]].cash  = cashRow ? (cashRow[i] ?? 0) : 0;
        });
        pH2.forEach((h, i) => {
          const m = String(h).match(/(\d{4})/);
          if (m && fyData[+m[1]]) fyData[+m[1]].ebitda = opRow[i];
        });
        const yearsAvail = Object.keys(fyData).map(Number);
        const fyForDate = (ts) => {
          const dt = new Date(ts);
          if (isNaN(dt)) return null;
          const fy = dt.getMonth() >= 3 ? dt.getFullYear() : dt.getFullYear() - 1;
          if (fyData[fy]) return fyData[fy];
          if (!yearsAvail.length) return null;
          return fyData[yearsAvail.reduce((a, b) => Math.abs(b - fy) < Math.abs(a - fy) ? b : a)];
        };

        const evSeries = [];
        priceSrc.forEach(([ts, price]) => {
          const f = fyForDate(ts);
          if (!f || f.eqCap == null || !f.ebitda || f.ebitda <= 0) return;
          const mcapCr = price * f.eqCap / faceVal;          // ₹Cr
          const evCr   = mcapCr + (f.debt || 0) - (f.cash || 0);
          evSeries.push([ts, parseFloat((evCr / f.ebitda).toFixed(2))]);
        });
        const ev = evSeries.map(p => p[1]);

        // Current EV/EBITDA from current MCap + latest debt/cash/EBITDA
        let mcapCrNow = null;
        for (const [k, v] of Object.entries(keyRatios)) {
          if (k.toLowerCase().includes('market cap')) { mcapCrNow = parseMarketCapCr(String(v)); break; }
        }
        const lastIdxBS = bsH.length - 1, lastIdxP = pH2.length - 1;
        const debtNow = debtRow ? (debtRow[lastIdxBS] ?? 0) : 0;
        const cashNow = cashRow ? (cashRow[lastIdxBS] ?? 0) : 0;
        const ebitdaNow = opRow[lastIdxP];
        const curEV = (mcapCrNow != null && ebitdaNow && ebitdaNow > 0)
          ? parseFloat(((mcapCrNow + debtNow - cashNow) / ebitdaNow).toFixed(2)) : null;

        if (ev.length >= 20) {
          const sorted = [...ev].sort((a, b) => a - b);
          const pc = p => sorted[Math.max(0, Math.floor(sorted.length * p / 100) - 1)];
          const mean = ev.reduce((a, b) => a + b, 0) / ev.length;
          const cur  = curEV ?? parseFloat(sorted[sorted.length - 1].toFixed(2));
          const below = sorted.filter(v => v <= cur).length;
          evRange = {
            current: cur,
            low:    parseFloat(pc(5).toFixed(2)),
            high:   parseFloat(pc(95).toFixed(2)),
            median: parseFloat(pc(50).toFixed(2)),
            mean:   parseFloat(mean.toFixed(2)),
            pctRank: parseFloat((below / sorted.length * 100).toFixed(0)),
            years:  peRange.years,
            n:      ev.length,
            series: evSeries,
          };
        } else if (curEV != null) {
          evRange = { current: curEV, low: null, high: null, median: null, mean: null, pctRank: null, years: null, n: 0 };
        }
      }
    } catch (e) { console.debug('[SI] evRange error:', e); evRange = null; }
    console.debug('[SI] evRange:', evRange, '| priceSeries pts:', priceSeries?.length);
    derived.evRange = evRange;

    console.debug('[ScreenerInsights] keyRatios:', Object.keys(keyRatios));
    if (pnl) console.debug('[ScreenerInsights] P&L rows:', Object.keys(pnl.data));
    if (bs)  console.debug('[ScreenerInsights] BS rows:',  Object.keys(bs.data));
    console.debug('[ScreenerInsights] SSGR final:', derived.ssgrFinal, '| FCF arr len:', derived.fcfArr?.length);
    console.debug('[ScreenerInsights] cumCFO:', derived.cumCFO?.slice(-3), '| cumPAT:', derived.cumPAT?.slice(-3));
    console.debug('[ScreenerInsights] Moat checks:', derived.moatCheck?.length);

    // ── Pledge fallback: scan top-ratios and visible page text ────────────────
    if (shareholding && !shareholding.data['__pledgePct__']) {
      // Check keyRatios (some screener views put it there)
      let pledgeFromRatios = null;
      for (const [k, v] of Object.entries(keyRatios)) {
        if (k.toLowerCase().includes('pledg')) {
          pledgeFromRatios = parseFloat(String(v).replace(/[^0-9.]/g, ''));
          break;
        }
      }
      // Scan visible page text for "Pledged : 21.84%" or similar
      if (pledgeFromRatios == null) {
        const pageText = document.body.innerText;
        const m = pageText.match(/pledged?\s*[:%]\s*([\d.]+)/i);
        if (m) pledgeFromRatios = parseFloat(m[1]);
      }
      if (pledgeFromRatios != null && !isNaN(pledgeFromRatios)) {
        // Store as a single-value array aligned to the last quarter
        const n = shareholding.headers.length;
        const arr = Array(n).fill(null);
        arr[n - 1] = pledgeFromRatios;
        shareholding.data['__pledgePct__'] = arr;
        console.debug('[SI] Pledge from page text / ratios:', pledgeFromRatios);
      }
    }
    console.debug('[ScreenerInsights] Shareholding rows:', shareholding ? Object.keys(shareholding.data) : 'not found');

    return { companyName, nseSymbol, keyRatios, pnl, balanceSheet: bs, cashFlow: cf, ratios, quarters, shareholding, derived, peRange, deliveryData, topFII, topDII, starInvestors, capCategory, epsTrend };
  }

  return { scrapeAll, getCompanyId };
})();
