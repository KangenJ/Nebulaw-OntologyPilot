import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {nativeLearningInstallFixture} from './native-learning-install-fixture.mjs';
import {planNativeLearningAccess,applyNativeLearningAccess} from '../../../../ops/plus-v2/native-learning-access-plan.mjs';
import {planReviewedRuntime,applyReviewedRuntimePlan} from '../../../../ops/plus-v2/reviewed-runtime-plan.mjs';
import {readNativeRuntimeProfile} from '../../../../ops/plus-v2/runtime-host.mjs';
import {createNativeStorage} from '../../../apps/lwm-demo/src/native-storage.mjs';
test('real audit delivery interleaves native intake, episode capture, snapshots and partition reservation without self-invalidating HTTP requests; reopen preserves both facts and delivered audit',
 {skip:process.platform!=='linux',timeout:120000},async t=>{
  const f=await nativeLearningInstallFixture(t),access=await planNativeLearningAccess(f.input),learning=await applyNativeLearningAccess(access,access.planHash);
  const plan=await planReviewedRuntime({schema:'plus-audit-runtime-request-v1',profilePath:learning.profilePath,outputParent:f.parent,directoryName:'foreground-audit',backgroundWorkers:{schema:'plus-native-worker-schedule-v1',audit:1000,selection:0,evaluation:0,decision:0,actionExecution:0}});
  const installed=await applyReviewedRuntimePlan(plan,plan.planHash),profile=readNativeRuntimeProfile(installed.profilePath);await f.start(profile);assert.deepEqual(f.runtime().state().workerNames,['audit']);
  const references=[];
  for(let i=0;i<6;i++){
   const registered=await f.ok('investigator','/actions/NativeRegisterInvestigationTask',{matter:f.matter._id,expectedVersion:f.matter._version,taskNumber:'AUDIT-GATE-'+i,title:'SYNTHETIC concurrent audit input',priority:'LOW',assignee:'demo-investigator',instructions:'No verification or model qualification implied',dueAt:new Date(Date.now()+3600000).toISOString()},'audit-task-'+i);
   const task=(await f.ok('viewer','/objects/InvestigationTask/'+registered.receipt.resultId)).object,startedAt=new Date().toISOString();
   const episode=await f.ok('trainer','/episodes',{definitionKey:'task.completion',rootId:task._id,startedAt},'audit-episode-'+i);
   await f.ok('investigator','/actions/NativeRecordTaskObservation',{task:task._id,expectedVersion:task._version,title:'SYNTHETIC report',summary:'Not GOLD',reportedCompletion:'DONE',eventTime:startedAt,channelKey:'report',sourceSystem:'demo-report',sourceRecordId:'audit-report-'+i,sourceRevision:'1'},'audit-report-'+i);
   const stream=await f.ok('trainer','/episodes/'+episode._id+'/captures',{},'audit-capture-'+i),snapshot=await f.ok('trainer','/snapshots',{streamId:stream.record._id,targetTime:startedAt},'audit-snapshot-'+i);
   const reserved=await f.ok('trainer','/learning/partitions',{snapshotId:snapshot.record._id},'audit-partition-'+i);assert.ok(reserved.partition);references.push(task._id);
  }
  const storage=createNativeStorage(profile.dbPath),ctx={tenantId:profile.tenantId};
  try{const deadline=Date.now()+10000;let pending;
   do{pending=await storage.queryObjects(ctx,'PlusOutbox',{field:'status',operator:'neq',value:'DELIVERED'},{limit:100});if(!pending.totalCount)break;assert.ok(Date.now()<deadline);await delay(100);}while(true);
   const before=await storage.auditStore.query();assert.ok(before.length>=12);await f.runtime().close();await f.start(profile);
   for(const id of references)assert.equal((await f.ok('viewer','/objects/InvestigationTask/'+id)).object.actualCompletion,'UNKNOWN');
   assert.equal((await storage.auditStore.query()).length,before.length);assert.equal((await storage.queryObjects(ctx,'TaskCompletionVerification',{and:[]})).totalCount,0);
  }finally{storage.close();}
 });
