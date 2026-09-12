import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync,unlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {digest} from '../../plus-contracts/dist/index.js';
import {taskLearningFixture,ctx,trainer,owner} from './task-learning-fixture.mjs';
import {startNativeRuntime,validateNativeRuntimeProfile} from '../../../../ops/plus-v2/runtime-host.mjs';
import {inspectNativeDatabase} from '../../../../ops/plus-v2/native-backup.mjs';

// Actual canonical ontology/storage, private identities, full service graph,
// managed CEL and HTTP. This is a DEPLOYMENT CONFIGURATION test; it deliberately
// has no approved complete recipe/dataset/job. No FIT, efficacy or model-ready claim.
test('normal private v2 profile starts the actual graph without synthetic seam; current policy/artifact withdrawal fail closed and no job/model is approved',
 {skip:process.platform!=='linux',timeout:60000},async t=>{
  const f=await taskLearningFixture(t,{timedPriority:true,withRules:true,withTransitionAction:true});
  const engineId='ontology-composed-dynamics-v1',worker={id:'reviewed-complete-worker',tenantId:ctx.tenantId,roles:['plus_compute_worker']};
  const selection={key:'task.complete',revision:1,engineId,definitionHash:f.compiled.definitionHash,bindingHash:f.input.compiledInput.bindingHash,scopeKey:'synthetic',classification:'SYNTHETIC'};
  const policy={...f.policy,version:1,definitions:{'task.completion':{readRoles:['trainer','model_owner'],draftRoles:['data_reviewer'],publishRoles:['model_owner'],policy:f.mechanism.policy}},
    taskRules:{version:'plus-private-task-rules-v1',enabled:true,specifications:[],evaluations:[],grants:[]},
    evaluation:{version:'plus-private-evaluation-v1',enabled:true,protocols:[],grants:[]},
    modelGovernance:{version:'plus-private-model-governance-v1',enabled:true,targets:[],grants:[]},
    actionIntervals:{version:'plus-private-action-intervals-v1',enabled:true,targets:[],grants:[]},
    replayGovernance:{version:'plus-private-replay-governance-v1',enabled:true,targets:[],grants:[]},
    beliefRuntime:{version:'plus-private-belief-runtime-v1',enabled:true,grants:[]},
    learnedCompositionReplay:{version:'plus-private-learned-composition-replay-v1',enabled:true,targets:[]},
    scenarioPlanning:{version:'plus-private-scenario-planning-v1',enabled:true,targets:[],grants:[]},
    actionRequests:{version:'plus-private-action-requests-v1',enabled:true,targets:[],grants:[]},
    compute:{version:'plus-private-compute-v4',enabled:true,workers:[{principalId:worker.id,requiredRoles:worker.roles,maxItems:1}],grants:[
      {principalId:worker.id,requiredRoles:worker.roles,keys:['task.fit'],permissions:['compute:inspect','compute:claim','compute:complete']}]},
    computeAuthorizations:{version:'plus-private-compute-authorizations-v1',enabled:true,targets:[{key:'task.fit',policy:{version:'plus-compute-authorization-policy-v1',id:'reviewed-complete-purpose',
      submitterId:trainer.id,workerId:worker.id,workerRoles:worker.roles,engineId,definitionHash:selection.definitionHash,bindingHash:selection.bindingHash,scopeKey:selection.scopeKey,classification:'SYNTHETIC',leaseMs:300000,maxAttempts:2,maxDatasets:3}}],
      grants:[{principalId:worker.id,requiredRoles:worker.roles,keys:['task.fit'],permissions:['compute-authorization:read']},
        {principalId:trainer.id,requiredRoles:trainer.roles,keys:['task.fit'],permissions:['compute-authorization:read','compute-authorization:propose']}]}};
  const authPath=f.path+'.auth.json',policyPath=f.path+'.policy.json',deploymentPath=f.path+'.reviewed.json',token=p=>'synthetic-reviewed-test-'+p.id;
  const accounts=[trainer,owner,worker].map(p=>({...p,tokenHash:createHash('sha256').update(token(p)).digest('hex'),expiresAt:new Date(Date.now()+300000).toISOString()}));
  writeFileSync(authPath,JSON.stringify(accounts),{mode:0o600});const policyBytes=JSON.stringify(policy);writeFileSync(policyPath,policyBytes,{mode:0o600});
  const deploymentBytes=JSON.stringify({version:'plus-reviewed-native-fit-v1',tenantId:ctx.tenantId,ontologyHash:f.bundle.contentHash,policyHash:digest(policy),recipeSelections:[selection]});
  writeFileSync(deploymentPath,deploymentBytes,{mode:0o600});
  const profile={schema:'plus-runtime-profile-v2',tenantId:ctx.tenantId,dbPath:f.path,authPath,policyPath,ports:{control:0,workbench:0,cel:0},expectedOntologyHash:f.bundle.contentHash,
    reviewedCompleteFit:{path:deploymentPath,sha256:createHash('sha256').update(deploymentBytes).digest('hex')}};
  assert.deepEqual(validateNativeRuntimeProfile(profile),profile);
  for(const change of [{schema:'plus-runtime-profile-v1'},{syntheticCompleteFitQualification:{}},{expectedOntologyHash:'0'.repeat(64)},{workers:{fit:true}}])
    assert.throws(()=>validateNativeRuntimeProfile({...profile,...change}),/RUNTIME_/);
  const before=inspectNativeDatabase(f.path),states=[],runtime=await startNativeRuntime(profile,{celBinary:process.env.LWM_CEL_BINARY,onState:s=>states.push(s)});let afterDenied;
  const get=async(p,path='/compute/jobs',body)=>{const response=await fetch(runtime.state().workbenchUrl+'/api'+path,{method:body?'POST':'GET',headers:{...(p?{authorization:'Bearer '+token(p)}:{}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json()};};
  try{
    assert.equal(runtime.state().registry,'REVIEWED_NATIVE_FIT_PINS');assert.equal(runtime.state().predictionReady,false);assert.equal(runtime.state().backgroundWorkers,'DISABLED');
    assert.equal(runtime.state().computeEnabled,true);assert.equal((await get()).status,401);
    const discovered=await get(worker);assert.equal(discovered.status,200,JSON.stringify(discovered.body));assert.deepEqual(discovered.body.data.items,[]);
    assert.equal((await get(trainer)).status,403);
    const forged=await get(trainer,'/learning/compute-authorizations',{key:'task.fit',revision:1,datasetIds:['not-frozen'],recipeHash:'d'.repeat(64)});
    assert.notEqual(forged.status,200);assert.notEqual(forged.status,500,JSON.stringify(forged.body));
    afterDenied=inspectNativeDatabase(f.path);
    assert.deepEqual({...afterDenied,auditHash:before.auditHash,auditRecords:before.auditRecords},before);
    assert.equal(afterDenied.auditRecords,before.auditRecords+1);assert.notEqual(afterDenied.auditHash,before.auditHash);
    const audit=await f.storage.auditStore.queryPage({tenantId:ctx.tenantId,actorIds:[trainer.id],limit:10});
    assert.equal(audit.records.length,1);assert.equal(audit.records[0].operation.actionType,'PlusLearningRequest');
    assert.equal(audit.records[0].traceId,forged.body.traceId);assert.equal(audit.records[0].detail.denialReason,forged.body.error.code);
    policy.computeAuthorizations.targets[0].policy.classification='AUTHORIZED_REAL';writeFileSync(policyPath,JSON.stringify(policy));
    const changed=await get(worker);assert.equal(changed.status,400);assert.equal(changed.body.error.code,'REVIEWED_FIT_CONFIGURATION_INVALID');
    writeFileSync(policyPath,policyBytes);assert.equal((await get(worker)).status,200);
    unlinkSync(deploymentPath);const withdrawn=await get(worker);assert.equal(withdrawn.status,400);assert.equal(withdrawn.body.error.code,'REVIEWED_FIT_CONFIGURATION_INVALID');
    assert.deepEqual(inspectNativeDatabase(f.path),afterDenied);
    assert.equal(JSON.stringify(states).includes(token(worker)),false);assert.equal(readFileSync(authPath,'utf8').includes(token(worker)),false);
  }finally{await runtime.close();}
  // Exact original artifact restores only the same capability configuration,
  // not a model approval. Restart must preserve the unchanged native inventory.
  writeFileSync(deploymentPath,deploymentBytes,{mode:0o600});const restarted=await startNativeRuntime(profile,{celBinary:process.env.LWM_CEL_BINARY});
  try{assert.equal(restarted.state().registry,'REVIEWED_NATIVE_FIT_PINS');assert.equal(restarted.state().predictionReady,false);assert.deepEqual(inspectNativeDatabase(f.path),afterDenied);}finally{await restarted.close();}
});
