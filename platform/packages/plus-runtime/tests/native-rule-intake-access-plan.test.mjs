import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {nativeLearningInstallFixture} from './native-learning-install-fixture.mjs';
import {planNativeLearningAccess,applyNativeLearningAccess} from '../../../../ops/plus-v2/native-learning-access-plan.mjs';
import {planNativeRuleIntakeAccess,applyNativeRuleIntakeAccess} from '../../../../ops/plus-v2/native-rule-intake-access-plan.mjs';
import {planReviewedRuntime,applyReviewedRuntimePlan} from '../../../../ops/plus-v2/reviewed-runtime-plan.mjs';
import {readNativeRuntimeProfile} from '../../../../ops/plus-v2/runtime-host.mjs';
import {inspectNativeDatabase} from '../../../../ops/plus-v2/native-backup.mjs';
import {digest} from '../../plus-contracts/dist/index.js';
import {setTimeout as delay} from 'node:timers/promises';

const linux={skip:process.platform!=='linux',timeout:90000};
async function fixture(t){
  const f=await nativeLearningInstallFixture(t),access=await planNativeLearningAccess(f.input),installed=await applyNativeLearningAccess(access,access.planHash);
  const current=readNativeRuntimeProfile(installed.profilePath),policy=JSON.parse(readFileSync(current.policyPath));
  // A historical-policy fixture, not source/schema approval. The published
  // native import contract is real; old installations had no matching grants.
  delete policy.taskDomain.ruleImportSources;
  policy.taskDomain.grants=policy.taskDomain.grants.filter(g=>!g.actions.includes('NativeImportTaskRule'));
  const newFields=['importSourceSystem','importSourceRecordId','importSourceRevision','importSourceKey','importContentHash','importedAt','importedBy','dataClassification'];
  for(const g of policy.objectBrowser.grants.filter(g=>g.objectType==='RuleVersion'))g.fields=g.fields.filter(k=>!newFields.includes(k));
  const policyPath=join(f.parent,'previous-policy.json'),profilePath=join(f.parent,'previous-runtime.json');writeFileSync(policyPath,JSON.stringify(policy),{mode:0o600});writeFileSync(profilePath,JSON.stringify({...current,policyPath}),{mode:0o600});
  const audit=await planReviewedRuntime({schema:'plus-audit-runtime-request-v1',profilePath,outputParent:f.parent,directoryName:'audited',backgroundWorkers:{schema:'plus-native-worker-schedule-v1',audit:1000,selection:0,evaluation:0,decision:0,actionExecution:0}});
  const audited=await applyReviewedRuntimePlan(audit,audit.planHash),profile=readNativeRuntimeProfile(audited.profilePath);
  const input={schema:'plus-native-rule-intake-access-request-v1',profilePath:audited.profilePath,outputParent:f.parent,directoryName:'rule-intake',expectedOntologyHash:profile.expectedOntologyHash,
    workspaceKey:'demo',sourceSystem:'demo-rule',reviewerId:'demo-data_reviewer',readerIds:['demo-viewer','demo-trainer','demo-data_reviewer','demo-model_owner']};
  return {...f,profile,input};
}

for(const initializeMissingReaders of [false,true])test('normal source access retains audit and safely imports; initialize missing readers='+initializeMissingReaders,linux,async t=>{
  const f=await fixture(t),before=inspectNativeDatabase(f.profile.dbPath),auth=readFileSync(f.profile.authPath),policy=readFileSync(f.profile.policyPath),source=readFileSync(f.input.profilePath);
  let actualPolicy=policy;
  if(initializeMissingReaders){
    const old=JSON.parse(policy);old.objectBrowser.grants=old.objectBrowser.grants.filter(g=>g.objectType!=='RuleVersion');writeFileSync(f.profile.policyPath,JSON.stringify(old));actualPolicy=readFileSync(f.profile.policyPath);
    await assert.rejects(()=>planNativeRuleIntakeAccess(f.input),/EXISTING_READER_REQUIRED/);
    f.input.initializeMissingReaders=true;
  }
  const plan=await planNativeRuleIntakeAccess(f.input);assert.deepEqual(await planNativeRuleIntakeAccess(f.input),plan);assert.deepEqual(inspectNativeDatabase(f.profile.dbPath),before);
  const original=JSON.parse(actualPolicy);assert.deepEqual(plan.material.policy.taskLearning,original.taskLearning);assert.deepEqual(plan.material.policy.definitions,original.definitions);
  assert.deepEqual(plan.material.policy.taskDomain.grants.slice(0,original.taskDomain.grants.length),original.taskDomain.grants);
  for(const g of original.objectBrowser.grants){
    const next=plan.material.policy.objectBrowser.grants.find(n=>n.principalId===g.principalId&&n.objectType===g.objectType);
    assert.deepEqual(next,g.objectType==='RuleVersion'&&f.input.readerIds.includes(g.principalId)?{...g,fields:[...g.fields,'dataClassification']}:g);
  }
  const result=await applyNativeRuleIntakeAccess(plan,plan.planHash),profile=readNativeRuntimeProfile(result.profilePath);
  assert.deepEqual(profile.backgroundWorkers,f.profile.backgroundWorkers);assert.equal(profile.schema,'plus-runtime-profile-v4');assert.equal(result.nativeApprovalGranted,false);
  assert.deepEqual(readFileSync(f.profile.authPath),auth);assert.deepEqual(readFileSync(f.profile.policyPath),actualPolicy);assert.deepEqual(readFileSync(f.input.profilePath),source);
  assert.deepEqual(inspectNativeDatabase(profile.dbPath),before);
  const host=await f.start(profile);assert.deepEqual(host.state().workerNames,['audit']);assert.equal(host.state().computeEnabled,false);
  const input={ruleKey:'source-access-test',title:'SYNTHETIC operator source',versionTag:'v1',effectiveFrom:new Date(Date.now()-1000).toISOString(),sourceCitation:'Not a legal norm or approved expression',sourceSystem:'demo-rule',sourceRecordId:'source-access-test',sourceRevision:'1'};
  assert.equal((await f.call('trainer','/actions/NativeImportTaskRule',input,'source-access-import')).status,403);
  assert.equal((await f.call('data_reviewer','/actions/NativeImportTaskRule',{...input,sourceSystem:'unconfigured'},'source-access-foreign')).status,403);
  // Audit delivery can legitimately advance the shared native epoch. Only a
  // confirmed READ_SET_CONFLICT retries the exact same input/idempotency key;
  // it must not leave a partly imported rule. No retry of other failures.
  let response;
  for(let attempt=0;attempt<3;attempt++){
    response=await f.call('data_reviewer','/actions/NativeImportTaskRule',input,'source-access-import');
    if(response.status===200)break;
    assert.equal(response.status,409);assert.equal(response.body.error.code,'RULE_IMPORT_READ_SET_CONFLICT');
    assert.equal(inspectNativeDatabase(profile.dbPath).objectsByType.RuleVersion,undefined);await delay(100);
  }
  assert.equal(response.status,200,JSON.stringify(response.body));const created=response.body.data;
  assert.equal((await f.ok('data_reviewer','/actions/NativeImportTaskRule',input,'source-access-import')).receipt.resultId,created.receipt.resultId);
  const viewed=(await f.ok('viewer','/objects/RuleVersion/'+created.receipt.resultId)).object;assert.equal(viewed.dataClassification,'SYNTHETIC');
  assert.equal(Object.hasOwn(viewed,'importSourceRecordId'),false,'No implicit sensitive source-record visibility');
  const after=inspectNativeDatabase(profile.dbPath);for(const type of ['PlusRuleSpecification','PlusModelRecipe','PlusModelRelease','PlusDeployment','TaskCompletionVerification'])assert.equal(after.objectsByType[type],undefined,type);
  await host.close();await f.start(profile);assert.equal((await f.ok('viewer','/objects/RuleVersion/'+created.receipt.resultId)).object._id,created.receipt.resultId);
});

test('source access refuses foreign scope, unknown/readless identity, worker injection, stale or forged plans and live locks',linux,async t=>{
  const f=await fixture(t);
  for(const patch of [{workspaceKey:'foreign'},{reviewerId:'demo-viewer'},{readerIds:['unknown-reader']},{expectedOntologyHash:'0'.repeat(64)},{backgroundWorkers:{selection:1000}}])await assert.rejects(()=>planNativeRuleIntakeAccess({...f.input,...patch}));
  const plan=await planNativeRuleIntakeAccess(f.input),lock=f.profile.dbPath+'.runtime.lock';writeFileSync(lock,'foreign-owner',{mode:0o600});
  await assert.rejects(()=>applyNativeRuleIntakeAccess(plan,plan.planHash),/STOP_RUNTIME_FIRST/);assert.equal(readFileSync(lock,'utf8'),'foreign-owner');unlinkSync(lock);
  const forged=structuredClone(plan);forged.material.policy.taskDomain.ruleImportSources['demo-rule'].classification='AUTHORIZED_REAL';forged.planHash=digest(forged.material);
  await assert.rejects(()=>applyNativeRuleIntakeAccess(forged,forged.planHash),/STALE/);assert.equal(existsSync(plan.material.target),false);
  const auth=readFileSync(f.profile.authPath);writeFileSync(f.profile.authPath,Buffer.concat([auth,Buffer.from('\n')]));await assert.rejects(()=>applyNativeRuleIntakeAccess(plan,plan.planHash),/STALE/);writeFileSync(f.profile.authPath,auth);
  const installed=await applyNativeRuleIntakeAccess(plan,plan.planHash);
  await assert.rejects(()=>planNativeRuleIntakeAccess({...f.input,profilePath:installed.profilePath,directoryName:'duplicate'}),/EXISTING_SOURCE_PRESERVED/);
});

test('classification metadata extension splits the exact workspace without widening other scopes or accepting ambiguous reader rows',linux,async t=>{
  const f=await fixture(t),policy=JSON.parse(readFileSync(f.profile.policyPath));
  const row=policy.objectBrowser.grants.find(g=>g.principalId==='demo-viewer'&&g.objectType==='RuleVersion');row.workspaces.push('other');
  writeFileSync(f.profile.policyPath,JSON.stringify(policy));
  const plan=await planNativeRuleIntakeAccess(f.input),grants=plan.material.policy.objectBrowser.grants.filter(g=>g.principalId===row.principalId&&g.objectType==='RuleVersion');
  assert.equal(grants.length,2);assert.deepEqual(grants.find(g=>g.workspaces.includes('other')),{...row,workspaces:['other']});
  assert.deepEqual(grants.find(g=>g.workspaces.includes('demo')),{...row,workspaces:['demo'],fields:[...row.fields,'dataClassification']});
  policy.objectBrowser.grants.push({...row,workspaces:['demo']});writeFileSync(f.profile.policyPath,JSON.stringify(policy));
  await assert.rejects(()=>planNativeRuleIntakeAccess(f.input),/EXISTING_READER_REQUIRED/);
  await assert.rejects(()=>planNativeRuleIntakeAccess({...f.input,initializeMissingReaders:true}),/EXISTING_READER_REQUIRED/);
});
