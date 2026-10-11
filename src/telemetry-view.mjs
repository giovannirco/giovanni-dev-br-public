export const memoryGiB = (used, total) => Number.isFinite(used) && Number.isFinite(total) && total > 0
  ? `${(used / 2 ** 30).toFixed(1)}/${(total / 2 ** 30).toFixed(1)} GiB` : '—';

export function usageGraph(history) {
  const values = Array.isArray(history) ? history.slice(0,30) : [];
  let path = '', connected = false, dots = '';
  values.forEach((point,i) => {
    const value=point?.[1];
    if (!Number.isFinite(value) || value<0 || value>1) { connected=false; return; }
    const x=(28+i*232/Math.max(1,values.length-1)).toFixed(1), y=(50-value*40).toFixed(1);
    path += `${connected?'L':'M'}${x},${y} `; connected=true;
    dots += `<circle cx="${x}" cy="${y}" r="1.3"/>`;
  });
  return `<svg class="usage-graph" viewBox="0 0 268 68" role="img" aria-label="GPU usage over the last 15 minutes, zero to 100 percent. Missing samples appear as gaps."><path class="graph-axis" d="M28 10H260M28 50H260"/><text x="0" y="13">100%</text><text x="9" y="53">0%</text><text x="28" y="65">15m ago</text><text x="240" y="65">now</text><path class="graph-line" d="${path.trim()}"/>${dots}</svg>`;
}
