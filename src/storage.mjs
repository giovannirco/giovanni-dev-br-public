// Aggregate at the metrics boundary: disk serials, guest IDs and storage names
// never leave the store. Only currently scraped gauges count as reporting.
const fresh = metric => `(${metric} and (time() - timestamp(${metric}) < 180))`;
export const STORAGE_QUERIES = {
  disks: `count(max by (instance,device) (${fresh('pve_smart_passed')}))`,
  disksPassing: `sum(max by (instance,device) (${fresh('pve_smart_passed')}))`,
  guests: `count(max by (instance,id) (${fresh('pve_backup_log_present')}))`,
  backupLogs: `sum(max by (instance,id) (${fresh('pve_backup_log_present')}))`,
  backupPassed: `sum(max by (instance,id) (${fresh('pve_backup_last_success')}))`,
  backupRuns: `count(max by (instance,id) (${fresh('pve_backup_last_success')}))`,
  newestBackup: `max(${fresh('pve_backup_last_run_timestamp_seconds')})`,
};
export function storageReadings(raw,now) {
  const count=v=>typeof v==='number'&&Number.isInteger(v)&&v>=0&&v<=100000?v:null;
  const out=Object.fromEntries(['disks','disksPassing','guests','backupLogs','backupPassed','backupRuns'].map(k=>[k,count(raw[k])]));
  for(const [part,total] of [['disksPassing','disks'],['backupLogs','guests'],['backupPassed','backupRuns']])if(out[total]===null||out[part]>out[total])out[part]=null;
  const at=raw.newestBackup;
  out.newestBackup=typeof at==='number'&&at>0&&at<=now/1000+30?new Date(at*1000).toISOString():null;
  return out;
}
