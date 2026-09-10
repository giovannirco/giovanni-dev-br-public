// The node and mempool can stop reporting independently. Keep missing fields
// visible, and reserve zero for a reading that actually says zero.
export function bitcoinNodeRows(node) {
  const finite = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
  if (!node || !Object.values(node).some(finite)) return [["Node", "Not reporting"]];
  const number = (n) => finite(n) ? Math.round(n).toLocaleString("en-US") : "—";
  const minutes = Math.floor(node.uptimeSeconds / 60);
  const uptime = !finite(node.uptimeSeconds) ? "—"
    : minutes < 60 ? `${minutes}m`
      : minutes < 1440 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
        : `${Math.floor(minutes / 1440)}d ${Math.floor(minutes / 60) % 24}h`;
  return [
    ["Peers", number(node.peers)],
    ["Block files", finite(node.chainBytes) ? `${(node.chainBytes / 1e9).toFixed(1)} GB` : "—"],
    ["Node mempool", `${number(node.mempoolTransactions)} txs · ${finite(node.mempoolBytes) ? (node.mempoolBytes / 1e6).toFixed(1) : "—"} MB`],
    ["Node uptime", uptime],
    ...(node.verification === 1 ? [] : [["Verification", finite(node.verification) && node.verification < 1
      ? `Syncing ${Math.floor(node.verification * 1000) / 10}%` : "Unknown"]]),
  ];
}
