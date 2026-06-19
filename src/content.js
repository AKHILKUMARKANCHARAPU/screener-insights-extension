// content.js — Entry point; wires scraper → panel
(function () {
  'use strict';

  if (!location.pathname.includes('/company/')) return;

  async function run() {
    try {
      const data = await ScreenerInsights.scraper.scrapeAll();
      ScreenerInsights.panel.buildPanel(data);
    } catch (err) {
      console.error('[Screener Insights]', err);
    }
  }

  // Keyboard shortcuts (Alt key combos — all fire only when panel exists):
  //   Alt+S  — toggle panel open / closed
  //   Alt+]  — increase panel width by 40px
  //   Alt+[  — decrease panel width by 40px
  //   Alt+W  — open custom-width dialog
  document.addEventListener('keydown', e => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key;
    if (k.toLowerCase() === 's') { e.preventDefault(); ScreenerInsights.panel.toggle(); }
    else if (k === ']')          { e.preventDefault(); ScreenerInsights.panel.adjustWidth(+40); }
    else if (k === '[')          { e.preventDefault(); ScreenerInsights.panel.adjustWidth(-40); }
    else if (k.toLowerCase() === 'w') { e.preventDefault(); ScreenerInsights.panel.openWidthDialog(); }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(run, 700));
  } else {
    setTimeout(run, 700);
  }
})();
