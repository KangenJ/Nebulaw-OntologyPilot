import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {digest} from '../../plus-contracts/dist/index.js';
import {planNativeDomain,applyNativeDomainPlan,readBootstrapFile} from '../../../../ops/plus-v2/native-domain-bootstrap.mjs';
import {planNativeLearningAccess,applyNativeLearningAccess} from '../../../../ops/plus-v2/native-learning-access-plan.mjs';
import {startNativeRuntime,readNativeRuntimeProfile} from '../../../../ops/plus-v2/runtime-host.mjs';
import {inspectNativeDatabase} from '../../../../ops/plus-v2/native-backup.mjs';

const linux={skip:process.platform!=='linux',timeout:90000};
import {nativeLearningInstallFixture as fixture} from './native-learning-install-fixture.mjs';

test('production learning plan reads current native definition, installs separate policy without copying facts, and normal runtime captures/partitions actual newly imported objects',linux,async t=>{
  const f=await fixture(t),before=inspectNativeDatabase(f.profile.dbPath),auth=readFileSync(f.profile.authPath),policy=readFileSync(f.profile.policyPath),base=readFileSync(f.input.profilePath);
  const plan=await planNativeLearningAccess(f.input);assert.deepEqual(await planNativeLearningAccess(f.input),plan);assert.deepEqual(inspectNativeDatabase(f.profile.dbPath),before);
  assert.equal(plan.material.definitionReference.definitionHash,f.input.expectedDefinitionHash);assert.equal(plan.dataApprovalGranted,false);
  assert.ok(plan.material.episodeFields.Observation.read.includes('reportedCompletion'));assert.equal(plan.material.episodeFields.Observation.read.includes('summary'),false,'Do not grant unrelated columns');
  assert.equal(Object.hasOwn(plan.material.policy,'compute'),false);assert.equal(plan.material.policy.taskLearning.recipes.length,0);
  const receipt=await applyNativeLearningAccess(plan,plan.planHash),profile=readNativeRuntimeProfile(receipt.profilePath);
  assert.equal(profile.dbPath,f.profile.dbPath);assert.equal(profile.authPath,f.profile.authPath);assert.notEqual(profile.policyPath,f.profile.policyPath);
  assert.deepEqual(inspectNativeDatabase(f.profile.dbPath),before);assert.deepEqual(readFileSync(f.profile.authPath),auth);assert.deepEqual(readFileSync(f.profile.policyPath),policy);assert.deepEqual(readFileSync(f.input.profilePath),base);
  await assert.rejects(()=>applyNativeLearningAccess(plan,plan.planHash),/TARGET_EXISTS/);
  const runtime=await f.start(profile);assert.equal(runtime.state().learningEnabled,true);assert.equal(runtime.state().computeEnabled,false);assert.equal(runtime.state().predictionReady,false);
  const open={definitionKey:'task.completion',rootId:f.task._id,startedAt:f.task.createdAt};assert.equal((await f.call('viewer','/episodes',open)).status,403);
  const episode=await f.ok('trainer','/episodes',open,'learning-open-episode');
  const stream=await f.ok('trainer','/episodes/'+episode._id+'/captures',{},'learning-capture');
  const snapshot=await f.ok('trainer','/snapshots',{streamId:stream.record._id,targetTime:f.eventTime},'learning-snapshot');
  const partition=await f.ok('trainer','/learning/partitions',{snapshotId:snapshot.record._id});assert.ok(['TRAIN','VALIDATION','FINAL_EVAL','ONLINE'].includes(partition.partition));
  assert.equal((await f.call('model_owner','/learning/partitions',{snapshotId:snapshot.record._id})).status,403,'Owner did not receive reserve authority');
  const facts=await f.ok('viewer','/objects/InvestigationTask/'+f.task._id);assert.equal(facts.object.actualCompletion,'UNKNOWN');
  const after=inspectNativeDatabase(f.profile.dbPath);for(const type of ['TaskCompletionVerification','PlusFeedback','PlusDatasetRevision','PlusModelRelease','PlusDeployment','PlusExecution'])assert.equal(after.objectsByType[type],undefined,type);
  await runtime.close();await f.start(profile);assert.equal((await f.ok('trainer','/learning/partitions/'+snapshot.record._id)).partition,partition.partition);
  assert.deepEqual(inspectNativeDatabase(f.profile.dbPath),after);assert.deepEqual(readFileSync(f.profile.authPath),auth);
});

test('installed normal learning preserves pre-episode reports, rejects out-of-window targets, and captures a genuinely new native observation without creating labels',linux,async t=>{
  const f=await fixture(t,{historicalObservation:true}),plan=await planNativeLearningAccess(f.input),installed=await applyNativeLearningAccess(plan,plan.planHash);
  await f.start(readNativeRuntimeProfile(installed.profilePath));
  const open={definitionKey:'task.completion',rootId:f.task._id,startedAt:f.task.createdAt};
  const episode=await f.ok('trainer','/episodes',open,'learning-historical-episode');
  const before=await f.ok('trainer','/episodes/'+episode._id+'/captures',{},'learning-historical-capture');
  assert.equal(before.record.eventReferences.length,0,'Received later does not change the historical event time');
  const inventory=inspectNativeDatabase(f.profile.dbPath);
  const rejected=await f.call('trainer','/snapshots',{streamId:before.record._id,targetTime:f.eventTime},'learning-historical-snapshot');
  assert.equal(rejected.status,409);assert.equal(rejected.body.error.code,'EPISODE_TARGET_OUTSIDE_WINDOW');
  const rejectedInventory=inspectNativeDatabase(f.profile.dbPath);
  const {auditHash:beforeAuditHash,auditRecords:beforeAuditRecords,...beforeNative}=inventory;
  const {auditHash:afterAuditHash,auditRecords:afterAuditRecords,...afterNative}=rejectedInventory;
  assert.deepEqual(afterNative,beforeNative,'Failed snapshot does not partially persist native facts, links or history');
  assert.equal(afterAuditRecords,beforeAuditRecords+1);assert.notEqual(afterAuditHash,beforeAuditHash,'Rejected POST must leave failure audit');
  const auditDb=new DatabaseSync(f.profile.dbPath,{readOnly:true});
  try{const audit=JSON.parse(auditDb.prepare('SELECT record FROM native_audit ORDER BY rowid DESC LIMIT 1').get().record);
    assert.equal(audit.actor.id,'demo-trainer');assert.equal(audit.operation.actionType,'PlusControlRequest');
    assert.equal(audit.detail.result,'error');assert.equal(audit.detail.denialReason,'EPISODE_TARGET_OUTSIDE_WINDOW');
  }finally{auditDb.close();}
  const eventTime=new Date().toISOString(),request={task:f.task._id,expectedVersion:f.task._version,title:'SYNTHETIC new report',summary:'Not a label',reportedCompletion:'UNKNOWN',eventTime,channelKey:'report',sourceSystem:'demo-report',sourceRecordId:'learning-new-report',sourceRevision:'1'};
  const imported=await f.ok('investigator','/actions/NativeRecordTaskObservation',request,'learning-new-report-record');
  const after=await f.ok('trainer','/episodes/'+episode._id+'/captures',{},'learning-new-report-capture');
  assert.equal(after.record.eventReferences.length,1);assert.equal(after.record.eventReferences[0].source.id,imported.receipt.resultId);
  const snapshot=await f.ok('trainer','/snapshots',{streamId:after.record._id,targetTime:eventTime},'learning-new-report-snapshot');
  const partition=await f.ok('trainer','/learning/partitions',{snapshotId:snapshot.record._id});
  const persisted=inspectNativeDatabase(f.profile.dbPath);
  assert.equal(persisted.objectsByType.Observation,2);assert.equal(persisted.objectsByType.PlusInputSnapshot,1);
  for(const type of ['TaskCompletionVerification','PlusFeedback','PlusDatasetRevision','PlusModelRelease','PlusExecution'])assert.equal(persisted.objectsByType[type],undefined);
  assert.equal((await f.ok('trainer','/streams/'+before.record._id)).record.eventReferences.length,0,'Old stream is not rewritten after new evidence');
  await f.runtime().close();await f.start(readNativeRuntimeProfile(installed.profilePath));
  assert.equal((await f.ok('trainer','/learning/partitions/'+snapshot.record._id)).partition,partition.partition);
  assert.equal((await f.ok('viewer','/objects/InvestigationTask/'+f.task._id)).object.actualCompletion,'UNKNOWN');
  assert.deepEqual(inspectNativeDatabase(f.profile.dbPath),persisted);
});

test('plan rejects foreign/changed groups, unknown target, forged role scope, existing learning and stale files; owned lock and incomplete targets are not overwritten',linux,async t=>{
  const f=await fixture(t);
  for(const patch of [{workspaceKey:'foreign'},{expectedDefinitionHash:'0'.repeat(64)},{targetVariable:'administrativeStatus'},
    {principals:{...f.input.principals,trainer:f.input.principals.owner}},{groups:[{...f.input.groups[0],expectedVersion:99}]},{groups:[{matterId:'missing',expectedVersion:1}]},
    {directoryName:'../escape'},{compute:{enabled:true}},{feedback:{...f.input.feedback,minimumMaturityMs:-1}}])await assert.rejects(()=>planNativeLearningAccess({...f.input,...patch}));
  const plan=await planNativeLearningAccess(f.input),lock=f.profile.dbPath+'.runtime.lock';writeFileSync(lock,'somebody-else-lock',{mode:0o600});
  await assert.rejects(()=>applyNativeLearningAccess(plan,plan.planHash),/STOP_RUNTIME_FIRST/);assert.equal(readFileSync(lock,'utf8'),'somebody-else-lock');unlinkSync(lock);
  const changed=structuredClone(plan);changed.material.policy.taskLearning.grants[0].permissions.push('dataset:FIT');changed.planHash=digest(changed.material);
  await assert.rejects(()=>applyNativeLearningAccess(changed,changed.planHash),/STALE/);assert.equal(existsSync(plan.material.target),false);
  const original=readFileSync(f.profile.policyPath);writeFileSync(f.profile.policyPath,JSON.stringify({...JSON.parse(original),taskLearning:{enabled:false}}));
  await assert.rejects(()=>planNativeLearningAccess(f.input),/EXISTING_AUTHORITY_PRESERVED/);writeFileSync(f.profile.policyPath,original);
  const auth=readFileSync(f.profile.authPath);writeFileSync(f.profile.authPath,Buffer.concat([auth,Buffer.from('\n')]));
  await assert.rejects(()=>applyNativeLearningAccess(plan,plan.planHash),/STALE/);assert.equal(existsSync(plan.material.target),false);writeFileSync(f.profile.authPath,auth);
  const receipt=await applyNativeLearningAccess(plan,plan.planHash);await assert.rejects(()=>planNativeLearningAccess({...f.input,profilePath:receipt.profilePath,directoryName:'next'}),/EXISTING_AUTHORITY_PRESERVED/);
});

test('actual learning plan/apply CLI emits only bounded installation metadata without credentials or implicit service start',linux,async t=>{
  const f=await fixture(t),inputPath=join(f.parent,'request.json'),planPath=join(f.parent,'plan.json'),program=fileURLToPath(new URL('../../../../ops/plus-v2/native-learning-access-plan.mjs',import.meta.url));
  writeFileSync(inputPath,JSON.stringify(f.input),{mode:0o600});
  const invoke=args=>execFileSync(process.execPath,[program,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:15000,windowsHide:true});
  const planned=JSON.parse(invoke(['plan',inputPath,planPath]));assert.equal(planned.readOnly,true);
  const receipt=JSON.parse(invoke(['apply',planPath,planned.planHash]));assert.equal(receipt.serviceStarted,false);assert.equal(receipt.trainingStarted,false);assert.equal(receipt.predictionReady,false);
  assert.equal(JSON.stringify([planned,receipt]).includes('tokenHash'),false);assert.equal(readNativeRuntimeProfile(receipt.profilePath).dbPath,f.profile.dbPath);
});
