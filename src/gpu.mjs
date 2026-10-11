// Fixed query and response bounds: no browser-supplied labels or time ranges.
export const GPU_QUERY = '{__name__=~"nvidia_smi_(index|utilization_gpu_ratio|memory_used_bytes|memory_total_bytes|temperature_gpu|power_draw_watts|power_limit_watts|last_collect_success|last_collect_success_timestamp_seconds)"}[15m]';
const FIELDS = { utilization_gpu_ratio: ['usage', 1], memory_used_bytes: ['memoryUsed', 2 ** 50], memory_total_bytes: ['memoryTotal', 2 ** 50], temperature_gpu: ['temperature', 150], power_draw_watts: ['power', 10000], power_limit_watts: ['powerLimit', 10000] };
const number = x => (typeof x === 'number' || typeof x === 'string' && x.trim()) && Number.isFinite(Number(x)) ? Number(x) : null;
export function gpuReadings(rows, now) {
  const end = Math.floor(now / 1000), start = end - 900;
  const devices = new Map(), collectors = new Map();
  for (const row of rows.slice(0, 512)) {
    const m = row.metric || {}, field = String(m.__name__ || '').replace(/^nvidia_smi_/, '');
    const source = `${m.cluster || ''}\0${m.instance || ''}`;
    const samples = (Array.isArray(row.values) ? row.values : []).slice(-2048)
      .map(s => [number(s?.[0]), number(s?.[1])])
      .filter(([t, v]) => t !== null && t > start && t <= end && v !== null).sort((a,b) => a[0]-b[0]);
    if (field.startsWith('last_collect_')) {
      if (!collectors.has(source)) collectors.set(source, {});
      collectors.get(source)[field] = samples;
    } else if (m.uuid && (field === 'index' || FIELDS[field])) {
      const key = `${source}\0${m.uuid}`;
      if (!devices.has(key)) devices.set(key, { source, fields: {} });
      devices.get(key).fields[field] = samples;
    }
  }
  const healthyAt = (source, at) => {
    const c = collectors.get(source) || {};
    const recent = field => c[field]?.findLast(s => s[0] <= at && at - s[0] < 90)?.[1];
    const timestamp = recent('last_collect_success_timestamp_seconds');
    return recent('last_collect_success') === 1 && Number.isFinite(timestamp) && at - timestamp >= -30 && at - timestamp < 90;
  };
  const gpus = [...devices.values()].sort((a,b) => (a.fields.index?.at(-1)?.[1] ?? 99) - (b.fields.index?.at(-1)?.[1] ?? 99)).slice(0,8).map((device,i) => {
    const result = { name: `GPU ${i+1}`, reporting: healthyAt(device.source,end), updatedAt: null };
    let newest = null;
    for (const [field,[name,max]] of Object.entries(FIELDS)) {
      const sample = device.fields[field]?.at(-1);
      result[name] = result.reporting && sample && end-sample[0]<90 && sample[1]>=0 && sample[1]<=max ? sample[1] : null;
      if (result[name] !== null) newest = Math.max(newest || 0,sample[0]);
    }
    if (!(result.memoryTotal > 0) || result.memoryUsed > result.memoryTotal) result.memoryUsed = null;
    result.updatedAt = newest === null ? null : new Date(newest*1000).toISOString();
    // One-minute buckets preserve gaps and real zeroes, without inventing interpolation.
    result.history = Array.from({length:15},(_,j) => {
      const at=start+(j+1)*60;
      const sample=device.fields.utilization_gpu_ratio?.findLast(s => s[0]>at-60 && s[0]<=at);
      return [at, sample && sample[1]>=0 && sample[1]<=1 && healthyAt(device.source,sample[0]) ? sample[1] : null];
    });
    return result;
  });
  return { gpus, start, end };
}
