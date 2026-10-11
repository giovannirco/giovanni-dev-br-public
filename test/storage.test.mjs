import assert from 'node:assert/strict';
import {test} from 'node:test';
import {storageReadings,STORAGE_QUERIES} from '../src/storage.mjs';
test('storage reports counts with a bounded recorded timestamp and unknowns',()=>{
 const now=1800000000000;
 const result=storageReadings({disks:6,disksPassing:6,guests:51,backupLogs:28,backupRuns:28,backupPassed:27,newestBackup:now/1000-3600},now);
 assert.equal(result.backupLogs,28);assert.equal(result.guests,51);assert.equal(result.backupPassed,27);
 assert.equal(result.newestBackup,new Date(now-3600000).toISOString());
 assert.equal(storageReadings({},now).disks,null);
 const bad=storageReadings({disks:2,disksPassing:3,guests:-1,backupPassed:'secret',newestBackup:now/1000+999},now);
 for(const key of ['disksPassing','guests','backupPassed','newestBackup'])assert.equal(bad[key],null);
 for(const query of Object.values(STORAGE_QUERIES))assert.match(query,/timestamp.*180/);
});
