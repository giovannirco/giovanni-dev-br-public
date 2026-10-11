import assert from 'node:assert/strict';
import {test} from 'node:test';
import {unifiReadings} from '../src/unifi.mjs';
const now=1800000000000;
const fixture=(overrides={})=>Object.entries({collection_success:1,collection_timestamp_seconds:now/1000-20,devices_total:13,devices_online:12,aps_total:6,aps_online:6,internet_up:1,latency_ms:8,wan_receive_bytes_per_second:0,wan_transmit_bytes_per_second:120,...overrides}).map(([key,value])=>({metric:{__name__:`orrery_unifi_${key}`,name:'private-device',mac:'00:11:22:33:44:55',wan_ip:'10.55.0.1'},value:[1,value]}));
test('UniFi exposes only allowlisted aggregates and keeps legitimate zero traffic',()=>{
 const out=unifiReadings(fixture(),now);assert.equal(out.reporting,true);assert.equal(out.downloadBytes,0);assert.equal(out.internetUp,true);assert.equal(out.online,12);
 assert.doesNotMatch(JSON.stringify(out),/private-device|00:11|10\.55/);
});
test('UniFi failures, clock skew and impossible readings stay unavailable',()=>{
 for(const overrides of [{collection_success:0},{collection_timestamp_seconds:now/1000-151},{collection_timestamp_seconds:now/1000+31},{collection_timestamp_seconds:null}]){
 const out=unifiReadings(fixture(overrides),now);assert.equal(out.reporting,false);assert.equal(out.internetUp,null);assert.equal(out.downloadBytes,null);
 }
 const out=unifiReadings(fixture({devices_online:14,latency_ms:-1,internet_up:2,wan_receive_bytes_per_second:'bad'}),now);
 for(const key of ['online','latencyMs','internetUp','downloadBytes'])assert.equal(out[key],null);
 assert.equal(unifiReadings([],now).reporting,false);
});
