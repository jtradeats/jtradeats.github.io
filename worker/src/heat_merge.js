// heat_merge.js: PAGE-side. Pure function, no DOM. Paste into news.html's heatmap script (or load it as a module).
// Joins the layout (/heat?part=base) and the colours (/heat?t=...) into the tree ECharts' treemap wants:
//   size = market cap (leaf value of the layout; themes have 1 each), colour = % change (value[1]).
// The setup guide sized tiles by |% change| and had no sectors: that is why the layout call was needed.
export function mergeHeat(base, perf) {
  const pct = (perf && perf.nodes) || {};
  let leaves = 0, matched = 0;
  const walk = n => {
    if (Array.isArray(n.children)) return { name: n.name, children: n.children.map(walk) };
    leaves++;
    const p = pct[n.name], has = typeof p === 'number';
    if (has) matched++;
    return { name: n.name, label: n.displayName || n.name, desc: n.description || '', members: n.extra || '', value: [n.value || 1, has ? p : null] };
  };
  const tree = (base.children || []).map(walk);
  return { tree, leaves, matched, ok: leaves > 0 && matched / leaves >= 0.8 };   // under 80% matched = wrong map pair: show a note, not a wrong map
}
