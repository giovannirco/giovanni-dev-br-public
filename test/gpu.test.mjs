import assert from 'node:assert/strict';
import {test} from 'node:test';
import {gpuReadings} from '../src/gpu.mjs';
import {memoryGiB,usageGraph} from '../src/telemetry-view.mjs';
const now=1800000000000, end=now/1000;
const row=(field,values,device=true)=>({metric:{__name__:`nvidia_smi_${field}`,cluster:'hidden-cluster',instance:'10.44.0.8',...(device?{uuid:'secret-serial'}:{})},values});
const fixture=()=>[
 row('index',[[end-10,0]]),row('utilization_gpu_ratio',[[end-130,.4],[end-10,0]]),
 row('memory_used_bytes',[[end-10,2**30]]),row('memory_total_bytes',[[end-10,24*2**30]]),
 row('temperature_gpu',[[end-10,40]]),row('power_draw_watts',[[end-10,20]]),
 row('last_collect_success',[[end-130,1],[end-10,1]],false),
 row('last_collect_success_timestamp_seconds',[[end-130,end-132],[end-10,end-12]],false),
];
test('GPU readings preserve idle zero, history gaps, binary VRAM and private identity',()=>{
 const result=gpuReadings(fixture(),now),gpu=result.gpus[0];
 assert.equal(gpu.usage,0);assert.equal(gpu.reporting,true);
 assert.equal(gpu.history.length,15);assert.deepEqual(gpu.history.slice(-3).map(x=>x[1]),[.4,null,0]);
 assert.equal(memoryGiB(gpu.memoryUsed,gpu.memoryTotal),'1.0/24.0 GiB');
 assert.doesNotMatch(JSON.stringify(result),/hidden|10\.44|secret/);
 const graph=usageGraph(gpu.history);assert.match(graph,/M[^L]*M/);assert.equal((graph.match(/<circle/g)||[]).length,2);
});
test('GPU stale collectors, failed collection and impossible values remain unavailable',()=>{
 for(const data of [fixture().filter(x=>!x.metric.__name__.includes('last_collect')),fixture().map(x=>x.metric.__name__==='nvidia_smi_last_collect_success'?{...x,values:[[end-10,0]]}:x)]){
 const gpu=gpuReadings(data,now).gpus[0];assert.equal(gpu.reporting,false);assert.equal(gpu.usage,null);
 }
 assert.equal(gpuReadings(fixture(),now+180000).gpus[0].usage,null);
 const data=fixture().map(x=>x.metric.__name__==='nvidia_smi_utilization_gpu_ratio'?{...x,values:[[end-10,'NaN'],[end-5,1e20]]}:x);
 assert.equal(gpuReadings(data,now).gpus[0].usage,null);
 assert.deepEqual(gpuReadings([],now).gpus,[]);
});
test('RAM uses binary usable capacity instead of rounding decimal GB',()=>{
 assert.equal(memoryGiB(8*2**30,33401532416),'8.0/31.1 GiB');
 assert.equal(memoryGiB(null,33401532416),'—');
});
