// charts.js — Chart.js wrapper utilities
window.ScreenerInsights = window.ScreenerInsights || {};

ScreenerInsights.charts = (() => {

  const C = {
    blue:   '#6366f1',
    green:  '#10b981',
    orange: '#f59e0b',
    red:    '#ef4444',
    purple: '#a855f7',
    cyan:   '#06b6d4',
    slate:  '#94a3b8',
    blueA:  'rgba(99,102,241,0.75)',
    greenA: 'rgba(16,185,129,0.75)',
    orangeA:'rgba(245,158,11,0.75)',
    redA:   'rgba(239,68,68,0.75)',
    purpleA:'rgba(168,85,247,0.75)',
    cyanA:  'rgba(6,182,212,0.75)',
  };

  const registry = {};

  const BASE = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 400 },
    clip: false,
    layout: { padding: { left: 6, right: 6 } },
    plugins: {
      legend: { labels: { color: '#94a3b8', font: { size: 10 }, boxWidth: 10, padding: 8 } },
      tooltip: {
        backgroundColor: '#1e293b',
        borderColor: '#475569',
        borderWidth: 1,
        titleColor: '#f1f5f9',
        bodyColor: '#cbd5e1',
        padding: 8,
        callbacks: {
          label: ctx => {
            const v = ctx.parsed.y;
            if (v == null || isNaN(v)) return `${ctx.dataset.label}: N/A`;
            return `${ctx.dataset.label}: ${v.toLocaleString('en-IN')}`;
          }
        }
      }
    },
    scales: {
      x: {
        ticks: { color: '#64748b', font: { size: 9 }, maxRotation: 45 },
        grid:  { color: 'rgba(100,116,139,0.08)' },
        offset: true,
      },
      y: {
        ticks: { color: '#64748b', font: { size: 9 } },
        grid:  { color: 'rgba(100,116,139,0.08)' }
      }
    }
  };

  function destroy(id) {
    if (registry[id]) { registry[id].destroy(); delete registry[id]; }
  }

  function make(id, config) {
    destroy(id);
    const canvas = document.getElementById(id);
    if (!canvas) return null;
    const chart = new Chart(canvas.getContext('2d'), config);
    registry[id] = chart;
    return chart;
  }

  function deepMerge(a, b) {
    const out = Object.assign({}, a);
    for (const k of Object.keys(b)) {
      if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]))
        out[k] = deepMerge(a[k] || {}, b[k]);
      else out[k] = b[k];
    }
    return out;
  }

  // Each dataset: { label, data, color?, colorA? }
  function bar(id, labels, datasets, overrides = {}) {
    return make(id, deepMerge({
      type: 'bar',
      data: {
        labels,
        datasets: datasets.map((ds, i) => {
          const palette = [C.blueA, C.greenA, C.orangeA, C.redA, C.purpleA, C.cyanA];
          return {
            label: ds.label,
            data: ds.data,
            backgroundColor: ds.colorA || palette[i % palette.length],
            borderColor:     ds.color  || [C.blue, C.green, C.orange, C.red, C.purple, C.cyan][i % 6],
            borderWidth: 1,
            borderRadius: 4,
            borderSkipped: false,
          };
        })
      },
      options: BASE
    }, overrides));
  }

  function line(id, labels, datasets, overrides = {}) {
    return make(id, deepMerge({
      type: 'line',
      data: {
        labels,
        datasets: datasets.map((ds, i) => {
          const colors = [C.blue, C.green, C.orange, C.red, C.purple, C.cyan];
          const col = ds.color || colors[i % colors.length];
          return {
            label: ds.label,
            data: ds.data,
            borderColor: col,
            backgroundColor: ds.fill ? col.replace(')', ',0.1)').replace('rgb', 'rgba') : 'transparent',
            fill: !!ds.fill,
            tension: 0.35,
            pointRadius: 3,
            pointHoverRadius: 5,
            pointBackgroundColor: col,
            spanGaps: true,
          };
        })
      },
      options: BASE
    }, overrides));
  }

  function stackedBar(id, labels, datasets) {
    return bar(id, labels, datasets, {
      options: deepMerge(BASE, {
        scales: {
          x: { stacked: true },
          y: { stacked: true }
        }
      })
    });
  }

  function destroyAll() {
    Object.keys(registry).forEach(destroy);
  }

  return { bar, line, stackedBar, make, destroyAll, C };
})();
