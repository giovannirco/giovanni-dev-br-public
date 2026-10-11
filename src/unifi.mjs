export const UNIFI_QUERY = '{__name__=~"orrery_unifi_(collection_success|collection_timestamp_seconds|devices_total|devices_online|aps_total|aps_online|switches_total|switches_online|gateways_total|gateways_online|internet_up|latency_ms|wan_receive_bytes_per_second|wan_transmit_bytes_per_second)",job="unifi-public"}';
const FIELDS={devices_total:'devices',devices_online:'online',aps_total:'aps',aps_online:'apsOnline',switches_total:'switches',switches_online:'switchesOnline',gateways_total:'gateways',gateways_online:'gatewaysOnline',internet_up:'internetUp',latency_ms:'latencyMs',wan_receive_bytes_per_second:'downloadBytes',wan_transmit_bytes_per_second:'uploadBytes'};
const number=x=>(typeof x==='number'||typeof x==='string'&&x.trim())&&Number.isFinite(Number(x))?Number(x):null;
export function unifiReadings(rows,now) {
  const values={};
  for(const row of rows.slice(0,64)) {
    const field=String(row.metric?.__name__||'').replace(/^orrery_unifi_/,'');
    if(Object.hasOwn(FIELDS,field)||field==='collection_success'||field==='collection_timestamp_seconds') values[field]=number(row.value?.[1]);
  }
  const at=values.collection_timestamp_seconds,age=typeof at==='number'?now/1000-at:Infinity;
  const reporting=values.collection_success===1&&age>=-30&&age<=150;
  const out={reporting,updatedAt:reporting?new Date(at*1000).toISOString():null};
  for(const [field,key] of Object.entries(FIELDS)) {
    const value=values[field];out[key]=reporting&&typeof value==='number'&&value>=0?value:null;
    if(/total|online/.test(field)&&(!Number.isInteger(out[key])||out[key]>10000))out[key]=null;
  }
  for(const [online,total] of [['online','devices'],['apsOnline','aps'],['switchesOnline','switches'],['gatewaysOnline','gateways']])if(out[total]===null||out[online]>out[total])out[online]=null;
  out.internetUp=out.internetUp===1?true:out.internetUp===0?false:null;
  if(out.latencyMs>60000)out.latencyMs=null;
  for(const key of ['downloadBytes','uploadBytes'])if(out[key]>1e12)out[key]=null;
  return out;
}
