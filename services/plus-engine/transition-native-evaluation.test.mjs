import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeComputeAdmission,NativeModelEvaluation,NativeModelDecision,NativeModelDeployment,NativeRecipeRegistry,
  transitionComponentContract,requireTransitionComponentContract,createActionOutboxJournal,createNativeReadQualificationPhase } from '../../platform/packages/plus-runtime/dist/index.js';
import { transitionValidationDependencies } from '../../platform/packages/plus-runtime/dist/transition-fit-dependencies.js';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { ctx,at } from '../../platform/packages/plus-runtime/tests/episode-fixture.mjs';
import { trainer,owner } from '../../platform/packages/plus-runtime/tests/dataset-fixture.mjs';
import { transitionValidationFixture } from './transition-validation-fixture.mjs';
import { transitionEstimatorId } from './transition-fit.mjs';
import { createPrivateNativeFitVerifiers,privateFitRequest } from './private-fit-registry.mjs';
import { fitInProcess } from './fit-worker.mjs';
import { createTransitionEvaluator } from './transition-native-evaluator.mjs';

// Actual native FIT dispatch/exposure/completion, VALIDATION and evaluation DB.
// SYNTHETIC Machine sources, controlled clocks and authority adapters; NOT the
// private Task HTTP service or a published/reference comparison acceptance.
async function setup(t,options={}){
  const f=await transitionValidationFixture(t,options),worker={...trainer,id:'transition-score-worker',roles:['plus_compute_worker']};
  const computeConfig={storage:f.storage,tenantId:ctx.tenantId,datasets:f.endpointConfig.datasets,recipes:f.recipes,transitionPlans:f.plan,
    ...createPrivateNativeFitVerifiers({recipes:f.recipes}),clock:()=>Date.parse(at(29)),
    authorize:async p=>[trainer.id,worker.id,owner.id].includes(p.id),
    policyFor:async()=>({version:'plus-compute-policy-v1',workerId:worker.id,engineId:transitionEstimatorId,recipeHash:f.recipeHash,leaseMs:300000,maxAttempts:2}),
    resolvePrincipal:async id=>structuredClone(id===trainer.id?trainer:worker)};
  const compute=new NativeComputeAdmission(computeConfig),job=await compute.enqueue(f.frozenIds[0],'FIT',trainer,'native-transition-score-fit');
  const dispatch=await compute.claim(job.id,worker),candidate=await fitInProcess(privateFitRequest(dispatch.recipe,[dispatch.transitionInput.material]));
  const completed=await compute.completeFit(job.id,dispatch.version,dispatch.leaseToken,candidate,worker);
  const config={storage:f.storage,tenantId:ctx.tenantId,protocols:f.protocols,compute,recipes:f.recipes,datasets:f.validationDatasets,
    transitionPlans:f.validationPlans,authorizationRevision:f.planConfig.authorizationRevision,
    authorize:async(p,permission)=>p.id===trainer.id||options.componentReview&&p.id===owner.id&&permission==='evaluation:result-read',
    evaluator:createTransitionEvaluator(),clock:()=>Date.parse(at(29))};
  const input={protocolId:f.protocol._id,executionId:job.id,validationDatasetIds:[f.validationDataset.id]};
  return {...f,compute,computeConfig,config,input,dispatch,candidate,completed,evaluations:new NativeModelEvaluation(config)};
}

function componentDecision(f,evaluation){
  const component=transitionComponentContract(f.recipe),policy={version:'plus-transition-component-admission-v1',id:'machine.transition-component',
    task:'CONDITIONAL_TRANSITION',definitionHash:component.definitionHash,bindingHash:component.bindingHash,scopeKey:component.scopeKey,
    classification:component.classification,clockHash:component.timeContractHash,component};
  const config={storage:f.storage,tenantId:ctx.tenantId,evaluations:f.evaluations,recipes:f.recipes,
    authorize:async p=>[owner.id,trainer.id].includes(p.id),policyFor:async()=>structuredClone(policy),
    authorizationRevision:f.planConfig.authorizationRevision,clock:()=>Date.parse(at(30)),readConsistency:'SHARED_NATIVE_AND_AUTHORITY'};
  return {policy,config,decisions:new NativeModelDecision(config),input:{key:'machine.transition-component',evaluationId:evaluation.id,
    evaluationVersion:evaluation.version,decision:'APPROVE',reason:'Qualified transition component only, not a complete online model'}};
}

test('actual native transition handoff reuses only a completed same-actor read inside one phase and rejects changes',async t=>{
  const f=await setup(t,{factorizedReference:true});let reads=0,revision=0;
  const original=f.compute.fitResultContext.bind(f.compute);
  f.compute.fitResultContext=(...args)=>{reads++;return original(...args);};
  f.computeConfig.readConsistency='SHARED_NATIVE_AND_AUTHORITY';
  // Explicit full-authority adapter and controlled clock for this native test,
  // not the canonical private HTTP/file-identity qualification.
  const phase=createNativeReadQualificationPhase({storage:f.storage,tenantId:ctx.tenantId,readers:[f.compute,f.recipes],
    authorizationRevision:async()=>digest(revision),clock:()=>Date.parse(at(29))});
  const read=()=>f.compute.readTransitionFitForEvaluation(f.input.executionId,trainer);
  await phase.run(trainer,async()=>{
    const first=await read();first.transition.material.contentHash='caller-mutation';
    const second=await read();assert.equal(reads,1);assert.deepEqual(second.transition.material,f.dispatch.transitionInput.material);
    await assert.rejects(()=>f.compute.readTransitionFitForEvaluation(f.input.executionId,owner),/FORBIDDEN/);
  });
  assert.equal(reads,2,'Other reader must retain its own FIT/source permissions');
  await phase.run(trainer,read);assert.equal(reads,3);
  await read();assert.equal(reads,4,'No phase means the original protected read');
  await assert.rejects(()=>phase.run(trainer,async()=>{await read();revision++;await read();}),/AUTHORITY_STALE/);
  await assert.rejects(()=>phase.run(trainer,async()=>{
    await read();const row=await f.storage.getObject(ctx,'PlusExecution',f.input.executionId);
    await f.storage.updateObject(ctx,'PlusExecution',row._id,{status:row.status},row._version);
    await read();
  }),/CONFLICT/);
});

test('shared native transition result read avoids duplicate material traversal while recomputing the real score and fencing final authority',async t=>{
  const f=await setup(t,{factorizedReference:true,componentReview:true,historyVersion:'plus-native-action-interval-policy-v3'});
  const evaluated=await f.evaluations.evaluate(f.input,trainer);
  let passes=0,runs=0;const material=f.evaluations.materialQualified.bind(f.evaluations),run=f.config.evaluator.run;
  f.evaluations.materialQualified=async(...args)=>{passes++;return material(...args);};
  f.config.evaluator.run=async request=>{runs++;return run(request);};
  const legacy=await f.evaluations.read(evaluated.id,owner,{recompute:true});
  assert.equal(passes,2);assert.equal(runs,1,'Read recomputes once, separate from material qualification');
  f.config.readConsistency='SHARED_NATIVE_AND_AUTHORITY';passes=0;runs=0;
  const epoch=await f.storage.getReadRevision(ctx),shared=await f.evaluations.read(evaluated.id,owner,{recompute:true});
  assert.deepEqual(shared,legacy);assert.equal(passes,1,'One complete traversal under shared native and external authority');assert.equal(runs,1);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);
  await f.evaluations.read(evaluated.id,owner,{recompute:true});assert.equal(passes,2);assert.equal(runs,2,'Independent reads must requalify and recompute');
  // Native eligibility still applies: a component never becomes a complete model.
  assert.equal(shared.modelDeploymentAuthorized,false);assert.equal((await f.rows('PlusDeployment')).totalCount,0);
});

test('shared transition result read reauthenticates secondary material actors after actual score computation',async t=>{
  const f=await setup(t,{factorizedReference:true,componentReview:true,historyVersion:'plus-native-action-interval-policy-v3'});
  const evaluated=await f.evaluations.evaluate(f.input,trainer),run=f.config.evaluator.run;let originalTrainerExpired=false;
  const authority=async p=>{if(originalTrainerExpired&&p.id===trainer.id)throw Object.assign(Error('ORIGINAL_TRAINER_EXPIRED'),{code:'ORIGINAL_TRAINER_EXPIRED'});return f.planConfig.authorizationRevision(p);};
  const phase=createNativeReadQualificationPhase({storage:f.storage,tenantId:ctx.tenantId,readers:[f.compute,f.recipes],authorizationRevision:authority,clock:f.config.clock});
  f.config.authorizationRevision=authority;f.config.readQualificationPhase=phase;f.config.readConsistency='SHARED_NATIVE_AND_AUTHORITY';
  // Register a second actor at the real material boundary; all FIT, source and
  // evaluation work stays native. This is an explicit authority-race adapter,
  // not a claim that synthetic actors prove private-file identity expiration.
  const material=f.evaluations.materialQualified.bind(f.evaluations);
  f.evaluations.materialQualified=(...args)=>phase.run(trainer,()=>material(...args));
  f.config.evaluator.run=async request=>{const output=await run(request);originalTrainerExpired=true;return output;};
  await assert.rejects(()=>f.evaluations.read(evaluated.id,owner,{recompute:true}),{code:'ORIGINAL_TRAINER_EXPIRED'});
  assert.equal((await f.rows('PlusModelEvaluation')).totalCount,1);assert.equal((await f.rows('PlusDeployment')).totalCount,0);
});

test('shared transition result requalification rejects permission, authority, native and score races after real recomputation',async t=>{
  for(const race of ['permission','authority','native','score']){
    await t.test(race,async sub=>{
    // Each race owns its native database: a previous mutation must not reject
    // the next request before its actual score recomputation is reached.
    const f=await setup(sub,{factorizedReference:true,componentReview:true,historyVersion:'plus-native-action-interval-policy-v3'});
    const evaluated=await f.evaluations.evaluate(f.input,trainer),run=f.config.evaluator.run;
    f.config.readConsistency='SHARED_NATIVE_AND_AUTHORITY';let runs=0;
    f.config.evaluator.run=async request=>{const output=await run(request);runs++;
      if(race==='permission')f.config.authorize=async()=>false;
      if(race==='authority')f.bump();
      if(race==='native'){const root=await f.storage.getObject(ctx,'Machine',f.root._id);await f.storage.updateObject(ctx,'Machine',root._id,{priority:root.priority},root._version);}
      if(race==='score')output.metrics={...output.metrics,unexpectedRecomputedValue:true};
      return output;
    };
    const expected={permission:/FORBIDDEN/,authority:/AUTHORITY_STALE/,native:/CONFLICT/,score:/RECOMPUTE_MISMATCH/};
    await assert.rejects(()=>f.evaluations.read(evaluated.id,owner,{recompute:true}),expected[race]);
    assert.equal(runs,1,'The real score must finish before this specific race is rejected');
    assert.equal((await f.rows('PlusModelEvaluation')).totalCount,1);assert.equal((await f.rows('PlusDeployment')).totalCount,0);
    });
  }
});

for(const historyVersion of ['plus-native-action-interval-policy-v2','plus-native-action-interval-policy-v3'])
test(historyVersion+' actual FIT, validation score and independent component admission retain original exposure while requalifying changed outside-interval inventory',async t=>{
  const f=await setup(t,{historyVersion,factorizedReference:true,componentReview:true});
  const material=structuredClone(f.dispatch.transitionInput.material),validation=await f.validationPlans.materializeForValidation(f.protocol._id,f.validationDatasetIds,trainer);
  const evaluated=await f.evaluations.evaluate(f.input,trainer),d=componentDecision(f,evaluated);
  assert.equal(evaluated.decision,'ELIGIBLE_FOR_REVIEW');
  const accepted=await d.decisions.decide(d.input,owner);
  // Synthetic authority adapter here; actual file identity/grant changes are
  // covered by transition-authority-requalification.test.mjs. No FIT, score,
  // admission or material return-value doubles are used in this chain.
  if(historyVersion==='plus-native-action-interval-policy-v3')f.bump();
  // Actual native audit staging with explicit SYNTHETIC bookkeeping, not an
  // executed action. The real nonempty action path has its own CEL acceptance.
  const actionId='history-v2-outside-inventory',tx=await f.storage.beginTransaction(ctx);
  try{await createActionOutboxJournal().stage(tx,{version:'native-action-commit-v1',tenantId:ctx.tenantId,actionId,
    audit:{id:'audit_'+actionId,tenantId:ctx.tenantId,timestamp:at(8.5),traceId:actionId,actor:{id:trainer.id,type:'user',roles:trainer.roles},
      operation:{type:'action',actionType:'PlusExecuteActionRequest',actionId},detail:{result:'success',after:{records:[]}}},affectedObjects:[]});
    await tx.commit();}catch(error){await tx.rollback();throw error;}
  const current=await f.validationPlans.materializeForValidation(f.protocol._id,f.validationDatasetIds,trainer);
  assert.notEqual(current.contentHash,validation.contentHash);
  assert.notEqual(current.sourcePlan.intervals[0].material.readSet.fitInventoryHash,validation.sourcePlan.intervals[0].material.readSet.fitInventoryHash);
  if(historyVersion==='plus-native-action-interval-policy-v3')assert.notEqual(current.sourcePlan.contextPlan.plan.readSet.authorizationRevision,validation.sourcePlan.contextPlan.plan.readSet.authorizationRevision);
  assert.equal(transitionValidationDependencies(current).dependencyHash,transitionValidationDependencies(validation).dependencyHash);
  const read=await f.compute.readTransitionFitForEvaluation(f.input.executionId,trainer);
  assert.deepEqual(read.transition.material,material,'The original native FIT exposure is never rewritten');
  const reopened=new NativeModelEvaluation({...f.config,storage:f.openStorage()});
  const recomputed=await reopened.read(evaluated.id,trainer,{recompute:true});
  assert.equal(recomputed.record.result.metrics.score.schema,'plus-conditional-transition-score-v2');
  assert.equal(recomputed.record.inputReadSet.transition.trainingMaterialHash,material.contentHash);
  assert.equal(recomputed.record.result.metrics.score.reference.artifact.trainingMaterialHash,material.contentHash);
  assert.equal((await d.decisions.requireComponentApproved(accepted.id,owner)).modelComponentApproved,true);
  f.validationEndpointConfig.authorize=async()=>false;
  await assert.rejects(()=>reopened.read(evaluated.id,trainer,{recompute:true}),/FORBIDDEN/);
  assert.equal((await f.rows('PlusDeployment')).totalCount,0,'A component approval is not a whole-model deployment');
});

test('native component dependency uses actual FIT score admission and typed links, rejects withdrawal and never enables a composition engine',async t=>{
  const f=await setup(t,{factorizedReference:true,componentReview:true}),evaluation=await f.evaluations.evaluate(f.input,trainer),d=componentDecision(f,evaluation);
  const accepted=await d.decisions.decide(d.input,owner),record=await f.storage.getObject(ctx,'PlusModelDecision',accepted.id);
  // Test-only recipe envelope proves the native dependency primitive. No new
  // composition estimator is registered and no complete-model score is claimed.
  const payload={schema:'native-dependency-test-only',engineId:'native-dependency-test-only',compiled:f.recipe.compiled,config:f.recipe.config,
    nativeDependencies:[{kind:'TRANSITION_COMPONENT',id:record._id,version:record._version,hash:digest(record)}]};
  const policy={version:'plus-recipe-policy-v1',id:'test-only-dependency',engineIds:[payload.engineId],classifications:['SYNTHETIC'],
    collectionPolicyHashes:[payload.config.collectionPolicyHash],populationPolicyHashes:[payload.config.populationPolicyHash],scopeKeys:[payload.compiled.definition.scope.key]};
  const configuration={storage:f.storage,tenantId:ctx.tenantId,definitions:f.definitions,componentDecisions:d.decisions,
    authorize:async p=>[trainer.id,owner.id].includes(p.id),policyFor:async()=>structuredClone(policy),
    validateRecipe:async p=>assert.equal(digest(p),digest(payload)),qualifyDependencies:async()=>{},
    dependencyAuthorizationRevision:f.planConfig.authorizationRevision,clock:()=>Date.parse(at(30))};
  const recipes=new NativeRecipeRegistry(configuration),input={key:'machine.dependency-test-only',revision:1,definitionKey:f.definition.key,payload};
  await assert.rejects(()=>new NativeRecipeRegistry({...configuration,componentDecisions:undefined}).propose(input,trainer),/RECIPE_COMPONENT_PROVIDER_REQUIRED/);
  const bad=structuredClone(input);bad.payload.nativeDependencies[0].hash=digest('forged-decision');
  await assert.rejects(()=>recipes.propose(bad,trainer),/RECIPE_DEPENDENCY_STALE/);
  const draft=await recipes.propose(input,trainer),approved=await recipes.review(draft.id,draft.version,'APPROVE','Native dependency primitive only',owner);
  const reopened=new NativeRecipeRegistry({...configuration,storage:f.openStorage()});
  assert.deepEqual((await reopened.requireApproved(approved.recipeHash,trainer)).payload,payload);
  const links=await f.storage.getLinks(ctx,draft.id,'PlusRecipeComponentDecision','outbound');assert.equal(links.totalCount,1);assert.equal(links.items[0]._toId,record._id);
  const before=await f.rows('PlusModelRelease');assert.equal(before.totalCount,1);assert.equal((await f.rows('PlusDeployment')).totalCount,0);
  await d.decisions.revoke(accepted.id,accepted.version,'Retire native component',owner);
  await assert.rejects(()=>reopened.requireApproved(approved.recipeHash,trainer),/RECIPE_DEPENDENCY_STALE|MODEL_DECISION_STALE/);
  assert.equal((await reopened.listRevisions(input.key,owner))[0].id,draft.id);
  assert.equal((await f.rows('PlusModelRelease')).totalCount,before.totalCount);
  await f.storage.deleteLink(ctx,'PlusRecipeComponentDecision',links.items[0]._id);
  await assert.rejects(()=>reopened.requireApproved(approved.recipeHash,trainer),/RECIPE_DEPENDENCY_LINK_INVALID/);
});

test('transition component receives independent native admission with ontology compatibility but cannot enter the complete-model deployment path',async t=>{
  const f=await setup(t,{factorizedReference:true,componentReview:true}),result=await f.evaluations.evaluate(f.input,trainer),d=componentDecision(f,result);
  const original=structuredClone(d.policy.component);
  for(const field of ['definitionHash','bindingHash','supervisionHash','layoutHash','timeContractHash','actionHistoryHash']){
    const forged={...original,[field]:digest('incompatible-'+field)};const {contentHash,...body}=forged;forged.contentHash=digest(body);
    assert.throws(()=>requireTransitionComponentContract(forged,f.recipe),{code:'TRANSITION_COMPONENT_CONTRACT_MISMATCH'});
  }
  assert.throws(()=>transitionComponentContract({...f.recipe,schema:'plus-transition-recipe-v2'}),{code:'TRANSITION_COMPONENT_RECIPE'});
  d.policy.task='STATE_ESTIMATION';await assert.rejects(()=>d.decisions.decide(d.input,owner),{code:'MODEL_DECISION_POLICY_INVALID'});d.policy.task='CONDITIONAL_TRANSITION';
  await assert.rejects(()=>d.decisions.decide(d.input,{...trainer,roles:['model_owner']}),{code:'MODEL_DECISION_INDEPENDENT_REVIEW_REQUIRED'});
  // Independent ownership is insufficient without actual TRAIN/VALIDATE rights.
  const grant=f.endpointConfig.authorize;f.endpointConfig.authorize=async p=>p.id===trainer.id;
  await assert.rejects(()=>d.decisions.decide(d.input,owner),/FORBIDDEN/);f.endpointConfig.authorize=grant;
  const accepted=await d.decisions.decide(d.input,owner);assert.equal(accepted.modelDeploymentAuthorized,false);assert.equal(accepted.admissionKind,'TRANSITION_COMPONENT_ONLY');
  const reopened=new NativeModelDecision({...d.config,storage:f.openStorage()}),read=await reopened.requireComponentApproved(accepted.id,owner);
  assert.equal(read.modelApproved,false);assert.equal(read.modelComponentApproved,true);assert.equal(read.modelDeploymentAuthorized,false);
  assert.deepEqual(read.record.policy.component,original);assert.equal(read.record.policy.component.allowedUse,'COMPOSITION_INPUT_ONLY');
  assert.equal((await reopened.decide(d.input,owner)).id,accepted.id);
  d.policy.component={...original,layoutHash:digest('policy-drift')};
  await assert.rejects(()=>reopened.read(accepted.id,owner),{code:'TRANSITION_COMPONENT_CONTRACT_MISMATCH'});d.policy.component=original;
  const {component,...targetSource}=d.policy,{version,id,...target}=targetSource;
  const deployment=new NativeModelDeployment({storage:f.storage,tenantId:ctx.tenantId,decisions:reopened,authorize:async()=>true,
    targetFor:async()=>({...target,task:'STATE_ESTIMATION'}),authorizationRevision:f.planConfig.authorizationRevision,clock:()=>Date.parse(at(31))});
  await assert.rejects(()=>deployment.activate({key:'machine',expectedVersion:0,decisionId:accepted.id,requestKey:'not-a-full-model',reason:'must fail'},owner),{code:'MODEL_DECISION_COMPONENT_ONLY'});
  assert.equal((await f.rows('PlusModelDecision')).totalCount,1);assert.equal((await f.rows('PlusDeployment')).totalCount,0);
  assert.equal((await f.storage.getObject(ctx,'PlusModelRelease',f.completed.candidateId)).status,'CANDIDATE');
  assert.equal((await f.storage.getLinks(ctx,accepted.id,'PlusModelDecisionEvaluation','outbound')).totalCount,1);
  const before=await f.storage.getObject(ctx,'Machine',f.root._id);assert.equal(before.actual,'UNKNOWN');
  await reopened.revoke(accepted.id,accepted.version,'Withdraw component qualification',owner);
  await assert.rejects(()=>reopened.requireComponentApproved(accepted.id,owner),{code:'MODEL_DECISION_STALE'});
  assert.deepEqual(await f.storage.getObject(ctx,'Machine',f.root._id),before);
});

test('transition component admission rejects a genuinely regressing v2 candidate and cannot approve or use the rejection',async t=>{
  const f=await setup(t,{factorizedReference:true,componentReview:true,outcome:'READY'}),result=await f.evaluations.evaluate(f.input,trainer);
  assert.equal(result.decision,'REJECT_REGRESSION');const d=componentDecision(f,result);
  await assert.rejects(()=>d.decisions.decide(d.input,owner),{code:'MODEL_DECISION_REGRESSION'});
  const rejected=await d.decisions.decide({...d.input,decision:'REJECT'},owner);
  await assert.rejects(()=>d.decisions.requireComponentApproved(rejected.id,owner),{code:'MODEL_DECISION_NOT_APPROVED'});
  assert.equal((await f.rows('PlusDeployment')).totalCount,0);
  await f.protocols.revoke(f.protocol._id,f.protocol._version,'Withdraw original validation approval',owner);
  await assert.rejects(()=>d.decisions.read(rejected.id,owner),{code:'MODEL_EVALUATION_STALE'});
});

test('transition component cannot inherit admission from an untrained-only v1 comparison even when that actual score passed',async t=>{
  const f=await setup(t,{componentReview:true}),result=await f.evaluations.evaluate(f.input,trainer);
  assert.equal(result.decision,'ELIGIBLE_FOR_REVIEW');const d=componentDecision(f,result);
  await assert.rejects(()=>d.decisions.decide(d.input,owner),{code:'MODEL_COMPONENT_EVALUATION_REQUIRED'});
  assert.equal((await f.rows('PlusModelDecision')).totalCount,0);assert.equal((await f.rows('PlusDeployment')).totalCount,0);
});

test('actual native transition exposure is handed off explicitly and independent scores persist, recompute and reopen without publication',async t=>{
  const f=await setup(t,{factorizedReference:true}),original=await f.compute.readTransitionFitForEvaluation(f.input.executionId,trainer);
  assert.deepEqual(original.transition.material,f.dispatch.transitionInput.material);
  assert.equal(Object.hasOwn(await f.compute.readFitResult(f.input.executionId,trainer),'transition'),false);
  assert.equal(Object.hasOwn(await f.compute.readFitBatchForEvaluation(f.input.executionId,trainer),'transition'),false);
  await assert.rejects(()=>f.compute.readTransitionFitForEvaluation(f.input.executionId,owner),/FORBIDDEN/);
  const result=await f.evaluations.evaluate(f.input,trainer);assert.equal(result.decision,'ELIGIBLE_FOR_REVIEW');assert.equal(result.modelDeploymentAuthorized,false);
  const read=await f.evaluations.read(result.id,trainer,{recompute:true}),saved=read.record.inputReadSet.transition;
  assert.equal(read.record.result.metrics.score.schema,'plus-conditional-transition-score-v2');
  assert.equal(read.record.result.metrics.score.reference.kind,'SAME_CONDITION_FACTORIZED_COUNTS');
  assert.equal(read.record.result.metrics.score.reference.artifact.trainingMaterialHash,original.transition.material.contentHash);
  assert.deepEqual(read.record.result.metrics.score.candidate,read.record.result.metrics.score.reference.scores);
  assert.equal(saved.trainingExposure.id,original.transition.exposure.id);assert.equal(saved.trainingMaterialHash,original.transition.material.contentHash);
  assert.equal(read.record.result.metrics.score.isolation.nativeAuthorityChecked,false); // pure scorer's own scope remains explicit
  const reopened=new NativeModelEvaluation({...f.config,storage:f.openStorage(),compute:new NativeComputeAdmission({...f.computeConfig,storage:f.openStorage()})});
  assert.deepEqual(await reopened.evaluate(f.input,trainer),result);
  assert.deepEqual((await reopened.read(result.id,trainer,{recompute:true})).record.result,read.record.result);
  assert.equal((await f.rows('PlusModelEvaluation')).totalCount,1);assert.equal((await f.rows('PlusDeployment')).totalCount,0);
  assert.equal((await f.storage.getObject(ctx,'PlusModelRelease',f.completed.candidateId)).status,'CANDIDATE');
  assert.equal((await f.storage.getObject(ctx,'Machine',f.root._id)).actual,'UNKNOWN');
  const denied=new NativeModelEvaluation({...f.config,transitionPlans:undefined});
  await assert.rejects(()=>denied.read(result.id,trainer),/MODEL_EVALUATION_TRANSITION_PROVIDER_REQUIRED/);
  const noAuthority=new NativeModelEvaluation({...f.config,authorizationRevision:undefined});
  await assert.rejects(()=>noAuthority.read(result.id,trainer),/MODEL_EVALUATION_AUTHORITY_GUARD_REQUIRED/);
  f.config.authorize=async()=>false;await assert.rejects(()=>f.evaluations.read(result.id,trainer),/MODEL_EVALUATION_FORBIDDEN/);f.config.authorize=async()=>true;
  f.intervalConfig.authorize=async()=>false;await assert.rejects(()=>f.evaluations.read(result.id,trainer),/ACTION_INTERVAL_FORBIDDEN/);
});

for(const [options,decision]of [[{outcome:'READY'},'REJECT_REGRESSION'],[{missing:true},'INSUFFICIENT_COVERAGE']])test(`native transition record retains ${decision} and cannot turn scoring into deployment`,async t=>{
  const f=await setup(t,options),result=await f.evaluations.evaluate(f.input,trainer);
  assert.equal(result.decision,decision);const row=(await f.evaluations.read(result.id,trainer,{recompute:true})).record;
  assert.equal(row.result.decision,decision);assert.equal(row.result.task,'CONDITIONAL_TRANSITION');assert.equal(row.result.deploymentAuthorized,false);
  if(options.missing){assert.equal(row.result.metrics.score.coverage.enrolledPairs,1);assert.equal(row.result.metrics.score.coverage.scoredPairs,0);}
  await f.protocols.revoke(f.protocol._id,f.protocol._version,'Withdraw scoring source authority',owner);
  assert.equal((await f.storage.getObject(ctx,'PlusModelEvaluation',result.id)).readiness,'SUSPENDED');
  await assert.rejects(()=>f.evaluations.read(result.id,trainer),{code:'MODEL_EVALUATION_STALE'});
  assert.equal((await f.storage.getObject(ctx,'PlusModelRelease',f.completed.candidateId)).status,'CANDIDATE');assert.equal((await f.rows('PlusDeployment')).totalCount,0);
});

test('wrong task, missing transition provider and an in-flight native mutation leave no evaluation or publication',async t=>{
  const f=await setup(t),fixed=createTransitionEvaluator();
  const compute={readFitForEvaluation:()=>assert.fail('Never fall back to legacy FIT handoff')};
  await assert.rejects(()=>new NativeModelEvaluation({...f.config,compute}).evaluate(f.input,trainer),/MODEL_EVALUATION_TRANSITION_PROVIDER_REQUIRED/);
  f.config.evaluator={...fixed,run:async r=>({...await fixed.run(r),task:'STATE_ESTIMATION'})};
  await assert.rejects(()=>f.evaluations.evaluate(f.input,trainer),/MODEL_EVALUATION_RESULT_INVALID/);
  assert.equal((await f.rows('PlusModelEvaluation')).totalCount,0);
  f.config.evaluator={...fixed,run:async r=>{const score=await fixed.run(r),root=await f.storage.getObject(ctx,'Machine',f.root._id);
    await f.storage.updateObject(ctx,'Machine',root._id,{status:'REGISTERED'},root._version);return score;}};
  await assert.rejects(()=>f.evaluations.evaluate(f.input,trainer),/CONFLICT|TRANSITION_VALIDATION_DEPENDENCIES_STALE/);
  assert.equal((await f.rows('PlusModelEvaluation')).totalCount,0);assert.equal((await f.rows('PlusDeployment')).totalCount,0);
  assert.equal((await f.storage.getObject(ctx,'PlusModelRelease',f.completed.candidateId)).status,'CANDIDATE');
});
