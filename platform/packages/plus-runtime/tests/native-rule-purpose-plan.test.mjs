import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {digest} from '../../plus-contracts/dist/index.js';
import {nativeLearningInstallFixture} from './native-learning-install-fixture.mjs';
import {nativeRulePurposeInput} from './native-rule-install-fixture.mjs';
import {planNativeLearningAccess,applyNativeLearningAccess} from '../../../../ops/plus-v2/native-learning-access-plan.mjs';
import {planNativeRulePurpose,applyNativeRulePurpose} from '../../../../ops/plus-v2/native-rule-purpose-plan.mjs';
import {readBootstrapFile} from '../../../../ops/plus-v2/native-domain-bootstrap.mjs';
import {readNativeRuntimeProfile} from '../../../../ops/plus-v2/runtime-host.mjs';
import {assertInitialLearningConfiguration} from '../../../../ops/plus-v2/initial-learning-configuration.mjs';
import {inspectNativeDatabase} from '../../../../ops/plus-v2/native-backup.mjs';
import {createNativeStorage} from '../../../apps/lwm-demo/src/native-storage.mjs';
import {planReviewedRuntime,applyReviewedRuntimePlan} from '../../../../ops/plus-v2/reviewed-runtime-plan.mjs';

const linux={skip:process.platform!=='linux',timeout:90000};
test('rule purpose continues an actual audit-only runtime without dropping audit, changing facts or granting model compute',linux,async t=>{
  const f=await fixture(t),schedule={schema:'plus-native-worker-schedule-v1',audit:1000,selection:0,evaluation:0,decision:0,actionExecution:0};
  const auditPlan=await planReviewedRuntime({schema:'plus-audit-runtime-request-v1',profilePath:f.ruleInput.profilePath,outputParent:f.parent,directoryName:'audited',backgroundWorkers:schedule});
  const audit=await applyReviewedRuntimePlan(auditPlan,auditPlan.planHash),input={...f.ruleInput,profilePath:audit.profilePath};
  const before=inspectNativeDatabase(f.profile.dbPath),auth=readFileSync(f.profile.authPath),source=readFileSync(audit.profilePath);
  const plan=await planNativeRulePurpose(input),installed=await applyNativeRulePurpose(plan,plan.planHash),profile=readNativeRuntimeProfile(installed.profilePath);
  assert.equal(profile.schema,'plus-runtime-profile-v4');assert.deepEqual(profile.backgroundWorkers,schedule);assert.equal(profile.reviewedCompleteFit,undefined);
  assert.deepEqual(inspectNativeDatabase(profile.dbPath),before);assert.deepEqual(readFileSync(audit.profilePath),source);assert.deepEqual(readFileSync(profile.authPath),auth);
  assert.equal(installed.nativeApprovalGranted,false);assert.equal(installed.trainingStarted,false);
  const host=await f.start(profile);assert.deepEqual(host.state().workerNames,['audit']);assert.equal(host.state().computeEnabled,false);assert.equal(host.state().predictionReady,false);
  assert.equal((await f.call('viewer','/me')).status,200);await host.close();
  const again=await f.start(profile);assert.deepEqual(again.state().workerNames,['audit']);assert.equal(again.state().computeEnabled,false);
});
async function fixture(t){
  const f=await nativeLearningInstallFixture(t),access=await planNativeLearningAccess(f.input),installed=await applyNativeLearningAccess(access,access.planHash);
  const ruleInput=await nativeRulePurposeInput(f,installed.profilePath),profile=readNativeRuntimeProfile(installed.profilePath);
  return {...f,profile,ruleInput};
}
test('normal rule source and pure operator planning install actual rule dependencies; independent native review and restart do not grant a model',linux,async t=>{
  const f=await fixture(t),before=inspectNativeDatabase(f.profile.dbPath),policy=readFileSync(f.profile.policyPath),auth=readFileSync(f.profile.authPath);
  const plan=await planNativeRulePurpose(f.ruleInput);assert.deepEqual(await planNativeRulePurpose(f.ruleInput),plan);assert.deepEqual(inspectNativeDatabase(f.profile.dbPath),before);
  const prior=readBootstrapFile(f.profile.policyPath);for(const k of Object.keys(prior))assert.deepEqual(plan.material.policy[k],prior[k],'Existing policy is not broadened');
  const material=structuredClone(plan.material.policy),copy=structuredClone(material);assertInitialLearningConfiguration(material);assert.deepEqual(material,copy,'Pure validation does not mutate the plan');
  const installed=await applyNativeRulePurpose(plan,plan.planHash),profile=readNativeRuntimeProfile(installed.profilePath);
  assert.equal(profile.dbPath,f.profile.dbPath);assert.equal(profile.authPath,f.profile.authPath);assert.equal(installed.nativeApprovalGranted,false);assert.equal(installed.serviceStarted,false);
  assert.deepEqual(inspectNativeDatabase(f.profile.dbPath),before);assert.deepEqual(readFileSync(f.profile.policyPath),policy);assert.deepEqual(readFileSync(f.profile.authPath),auth);
  await f.start(profile);
  const ref=plan.material.sourceReferences[0],proposal={key:f.ruleInput.specificationKey,revision:1,definitionKey:'task.completion',specification:{schema:'plus-rule-spec-v1',definitionHash:f.input.expectedDefinitionHash,
    rules:[{moduleKey:ref.moduleKey,ruleRevision:{id:ref.id,version:ref.version,hash:ref.hash},when:{op:'EQ',left:'priority',right:{kind:'LITERAL',value:'LOW'}},outputs:{recommendedPriority:'HIGH'}}]}};
  assert.equal((await f.call('trainer','/learning/rule-specifications',proposal)).status,403);
  const draft=await f.ok('data_reviewer','/learning/rule-specifications',proposal,'normal-rule-proposal');
  const review={expectedVersion:draft.version,decision:'APPROVE',reason:'Independent review of actual native source and typed rule'};
  assert.equal((await f.call('data_reviewer','/learning/rule-specifications/'+draft.id+'/review',review)).status,403);
  const approved=await f.ok('model_owner','/learning/rule-specifications/'+draft.id+'/review',review,'normal-rule-approval');assert.equal(approved.status,'APPROVED');
  const inventory=inspectNativeDatabase(profile.dbPath);assert.equal(inventory.objectsByType.PlusRuleSpecification,1);
  for(const type of ['PlusModelRecipe','PlusModelRelease','PlusDeployment','TaskCompletionVerification'])assert.equal(inventory.objectsByType[type],undefined,type);
  await f.runtime().close();await f.start(profile);assert.deepEqual(inspectNativeDatabase(profile.dbPath),inventory);assert.equal(f.runtime().state().predictionReady,false);
  const storage=createNativeStorage(profile.dbPath);try{const links=await storage.getLinks({tenantId:profile.tenantId},draft.id,'TaskRuleSpecificationSource','outbound');assert.equal(links.totalCount,1);assert.equal(links.items[0]._toId,ref.id);}finally{storage.close();}
});

test('rule planning pins actual sources and authority; forged modules, hidden fields, locks, stale identity and widening fail before installation',linux,async t=>{
  const f=await fixture(t),input=f.ruleInput;
  for(const patch of [{workspaceKey:'foreign'},{expectedDefinitionHash:'0'.repeat(64)},{bindings:[{...input.bindings[0],moduleKey:'transition'}]},{bindings:[{...input.bindings[0],expectedSourceVersion:99}]},
    {principals:{...input.principals,trainer:input.principals.owner}},{directoryName:'../escape'},{expressions:['true']}])await assert.rejects(()=>planNativeRulePurpose({...input,...patch}));
  const plan=await planNativeRulePurpose(input),lock=f.profile.dbPath+'.runtime.lock';writeFileSync(lock,'foreign-lock',{mode:0o600});
  await assert.rejects(()=>applyNativeRulePurpose(plan,plan.planHash),/STOP_RUNTIME_FIRST/);assert.equal(readFileSync(lock,'utf8'),'foreign-lock');unlinkSync(lock);
  const changed=structuredClone(plan);changed.material.policy.taskRules.grants[0].permissions.push('rule:review');changed.planHash=digest(changed.material);
  await assert.rejects(()=>applyNativeRulePurpose(changed,changed.planHash),/STALE/);assert.equal(existsSync(plan.material.target),false);
  const auth=readFileSync(f.profile.authPath);writeFileSync(f.profile.authPath,Buffer.concat([auth,Buffer.from('\n')]));await assert.rejects(()=>applyNativeRulePurpose(plan,plan.planHash),/STALE/);writeFileSync(f.profile.authPath,auth);
  const original=readFileSync(f.profile.policyPath),policy=readBootstrapFile(f.profile.policyPath);
  policy.objectBrowser.grants.find(g=>g.principalId===input.principals.trainer&&g.objectType==='RuleVersion').fields=policy.objectBrowser.grants.find(g=>g.principalId===input.principals.trainer&&g.objectType==='RuleVersion').fields.filter(f=>f!=='sourceCitation');
  writeFileSync(f.profile.policyPath,JSON.stringify(policy));await assert.rejects(()=>planNativeRulePurpose(input),/SOURCE_FIELDS_REQUIRED/);writeFileSync(f.profile.policyPath,original);
  const invalid=structuredClone(plan.material.policy);invalid.taskRules.grants[0].sourceIds=[];assert.throws(()=>assertInitialLearningConfiguration(invalid),/RULE_SOURCES_REQUIRED/);
  assert.throws(()=>assertInitialLearningConfiguration({...plan.material.policy,compute:{enabled:true}}),/INITIAL_CONFIGURATION_REQUIRED/);
  const installed=await applyNativeRulePurpose(plan,plan.planHash);await assert.rejects(()=>planNativeRulePurpose({...input,profilePath:installed.profilePath,directoryName:'duplicate'}),/EXISTING_AUTHORITY_PRESERVED/);
  await assert.rejects(()=>applyNativeRulePurpose(plan,plan.planHash),/TARGET_EXISTS/);
});

test('source mutation after preview invalidates exact operator plan, not repaired by another valid source or a stale approval',linux,async t=>{
  const f=await fixture(t),plan=await planNativeRulePurpose(f.ruleInput),storage=createNativeStorage(f.profile.dbPath);
  // Deliberate adversarial native mutation, NOT the source intake implementation.
  try{const ref=plan.material.sourceReferences[0];await storage.updateObject({tenantId:f.profile.tenantId},'RuleVersion',ref.id,{lifecycle:'SUPERSEDED'},ref.version);}finally{storage.close();}
  await assert.rejects(()=>applyNativeRulePurpose(plan,plan.planHash));assert.equal(existsSync(plan.material.target),false);
});

test('rule purpose CLI writes only a private exact plan/configuration and emits no credentials or automatic approvals',linux,async t=>{
  const f=await fixture(t),request=join(f.parent,'rule-request.json'),planFile=join(f.parent,'rule-plan.json'),program=fileURLToPath(new URL('../../../../ops/plus-v2/native-rule-purpose-plan.mjs',import.meta.url));
  writeFileSync(request,JSON.stringify(f.ruleInput),{mode:0o600});
  const invoke=args=>execFileSync(process.execPath,[program,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:15000,windowsHide:true});
  const plan=JSON.parse(invoke(['plan',request,planFile])),installed=JSON.parse(invoke(['apply',planFile,plan.planHash]));
  assert.equal(plan.readOnly,true);assert.equal(installed.nativeApprovalGranted,false);assert.equal(installed.trainingStarted,false);assert.equal(installed.serviceStarted,false);
  assert.equal(JSON.stringify([plan,installed]).includes('tokenHash'),false);assert.equal(readNativeRuntimeProfile(installed.profilePath).dbPath,f.profile.dbPath);
});
