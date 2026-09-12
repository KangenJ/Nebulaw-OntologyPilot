import assert from 'node:assert/strict';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { NativeComputeAdmission,NativeEvaluationProtocolRegistry,NativeModelEvaluation,NativeModelDecision,NativeLearnedCompositionMaterial,transitionEvaluatorId,createNativeReadQualificationPhase } from '../../platform/packages/plus-runtime/dist/index.js';
import { ctx,trainer,reviewer,owner,at } from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import { createTaskLearningServices } from '../../platform/apps/lwm-demo/src/task-learning.mjs';
import { createPrivateActionIntervalServices } from '../../ops/plus-v2/action-interval-services.mjs';
import { createPrivateAuthorizationRevision } from '../../ops/plus-v2/private-authority.mjs';
import { createPrivateComputeAccess } from '../../ops/plus-v2/compute-access.mjs';
import { learnedCompositionTrainingFixture } from './learned-composition-fixture.mjs';
import { learnedCompositionRecipe,learnedCompositionEstimatorId,fitLearnedComposition } from './learned-composition.mjs';
import { createNativeLearnedCompositionRecipeValidation } from './native-learned-composition-recipe.mjs';
import { createNativeCompositionRecipeValidation } from './native-composition-recipe.mjs';
import { createPrivateNativeFitVerifiers,privateFitRequest,registeredFitEngineIds } from './private-fit-registry.mjs';
import { transitionEstimatorId } from './transition-fit.mjs';
import { createTransitionEvaluator } from './transition-native-evaluator.mjs';
import { fitInProcess } from './fit-worker.mjs';
import { createNativeLearnedCompositionFitVerifier } from './learned-composition-fit.mjs';
import { prepareNativeCompleteHoldout,admitNativeCompleteModel,completeActionIntervalGrants } from './learned-composition-native-admission.mjs';

// Same native Task DB: prospective TRAIN and independent VALIDATION, real FIT
// dispatch/worker/exposure/completion, actual score, independent component
// decision and native complete-model RECIPE approval. Source transactions,
// clocks and top-level compute/evaluation grants are explicit SYNTHETIC adapters.
// Empty action inventory. PLUS_NATIVE_COMPOSITION_JOB=1 adds actual complete
// FIT lifecycle with the fixed child. PLUS_NATIVE_COMPOSITION_ADMISSION=1 also
// adds actual full native admission/selection. PLUS_NATIVE_COMPOSITION_HISTORY_V2=1
// selects the explicitly versioned policy before ANY recipe is approved or
// material exposed; it cannot migrate an existing v1 artifact. None is HTTP/online/G2.
export async function exerciseNativeLearnedComposition(t,{fullFit=false,fullAdmission=false,historyVersion='plus-native-action-interval-policy-v1',qualifiedReads=false,versionedCompute=false,sourceGovernanceCel,afterAdmission}={}){
  assert.ok(!fullAdmission||fullFit,'Full admission requires actual native complete FIT');
  assert.ok(!afterAdmission||fullAdmission,'A continuation requires actual complete model admission');
  assert.ok(!versionedCompute||historyVersion==='plus-native-action-interval-policy-v3','New feedback authorization requires an explicitly reviewed v3 recipe');
  const started=performance.now(),phase=name=>console.info(`[native-composition] ${name} ${Math.round(performance.now()-started)}ms`);
  const f=await learnedCompositionTrainingFixture(t,false,{historyVersion,sourceGovernanceCel}),s=f.services,transition=f.build.transition,transitionHash=digest(transition);
  assert.equal(transition.actionHistoryContract.version,historyVersion);
  assert.equal(f.recipe.transition.actionHistoryContract.version,historyVersion);
  if(historyVersion!=='plus-native-action-interval-policy-v1'){
    assert.ok(f.transitionMaterials.every(m=>m.sourcePlan.intervals.every(i=>i.material.policy.version===historyVersion&&i.material.readSet.intervalEvidence)));
    phase('explicit-'+historyVersion+'-native-material-qualified');
  }
  // Freeze intended recipe-use grants before protected FIT exposure. Adding
  // them after component approval legitimately invalidates that exposure's
  // complete authorization dependencies; never relax the native freshness gate.
  const entry=structuredClone(f.policy.taskLearning.recipes[0]);entry.key='task.learned.composition';entry.policy.engineIds=[learnedCompositionEstimatorId];
  f.policy.taskLearning.recipes.push(entry);for(const grant of f.policy.taskLearning.grants)grant.recipeKeys.push(entry.key);
  phase('training-sources-ready');
  let heldout;
  for(let i=0;i<100;i++){
    const candidate=await f.root(),bucket=parseInt(digest([f.policy.taskLearning.partition.seed,ctx.tenantId,
      ['task-matter-v1',digest(['synthetic',candidate.matter._id])]]).slice(0,8),16)%10000;
    if(bucket>=6000&&bucket<7500){heldout=candidate;break;}
  }
  assert.ok(heldout);assert.notEqual(heldout.matter._id,f.initial.matter._id);
  const protocol={...f.protocol,key:'learned-component-heldout',partition:'VALIDATION',expectedSampleCount:2,
    inputVisibleFrom:at(30),inputVisibleUntil:at(32),labelReceivedFrom:at(33),labelReceivedUntil:at(37),approvalUntil:at(39)};
  f.policy.taskLearning.cohorts.push({workspace:'synthetic',protocol});for(const g of f.policy.taskLearning.grants)g.protocolKeys.push(protocol.key);
  f.advance(30);const episode=await f.episodes.open({definitionKey:f.compiled.definition.key,rootId:heldout.task._id,startedAt:at(0)},trainer,'native-component-heldout');
  const members=[];
  for(const minute of [30,31]){f.advance(minute);
    const report=await f.createSource(heldout.task,{received:minute,eventMinute:minute,record:'native-component-heldout-'+minute});
    const input=await f.capture(episode,'native-component-heldout-input-'+minute,minute);
    assert.equal((await s.partitions.reserve(input.record._id,trainer)).partition,'VALIDATION');members.push({report,input,minute});
  }
  f.advance(32);const draft=await s.datasets.proposeCohort(protocol.key,members.map(m=>m.input.record._id),trainer);
  const cohort=await s.datasets.reviewCohort(draft.id,draft.version,'APPROVE','Independent prospective Task trajectory',reviewer);
  const protocols=new NativeEvaluationProtocolRegistry({storage:f.storage,tenantId:ctx.tenantId,recipes:s.recipes,datasets:s.datasets,clock:f.options.clock,
    authorize:async p=>f.people.has(p.id),policyFor:async()=>({version:'plus-evaluation-purpose-v1',id:'learned-component-validation',evaluatorIds:[transitionEvaluatorId],recipeHashes:[transitionHash],classifications:['SYNTHETIC']}),
    validateConfiguration:async()=>{}});
  const pd=await protocols.propose({key:'task.learned.component.score',revision:1,recipeHash:transitionHash,cohortIds:[cohort.id],evaluatorId:transitionEvaluatorId,
    configuration:{schema:'plus-conditional-transition-evaluation-v2',task:'CONDITIONAL_TRANSITION',reference:{schema:'plus-transition-reference-v1',kind:'SAME_CONDITION_FACTORIZED_COUNTS'},
      minimumPairs:1,minimumGroups:1,minimumCoverage:1,maximumNllRegression:0,maximumBrierRegression:0}},trainer);
  await protocols.review(pd.id,pd.version,'APPROVE','Freeze heldout score and same-information reference before labels',owner);
  for(const [i,member]of members.entries()){
    f.advance(34+i);const gold=await f.createSource(heldout.task,{observation:member.report.object,result:i?'DONE':'NOT_DONE',received:34+i});
    const label=await f.capture(episode,'native-component-heldout-label-'+i,member.minute);await s.partitions.reserve(label.record._id,trainer);f.advance(34.1+i);
    const feedback=await s.feedback.propose({inputSnapshotId:member.input.record._id,labelSnapshotId:label.record._id,eventId:gold.event._id},trainer);
    await s.feedback.review(feedback.id,feedback.version,'APPROVE','Independent synthetic endpoint verification',reviewer);
  }
  f.advance(39);const frozen=await s.datasets.freeze(cohort.id,trainer);
  f.policy.actionIntervals.targets.push({episodeId:episode._id,rootId:heldout.task._id,purpose:'TRANSITION_VALIDATE',policy:transition.actionHistoryContract});
  const completeHoldout=fullAdmission?await prepareNativeCompleteHoldout(f,heldout):undefined;
  const episodeIds=f.policy.actionIntervals.targets.map(r=>r.episodeId);
  f.policy.actionIntervals.grants=completeActionIntervalGrants(episodeIds);
  const intervalOptions={...f.options,requests:{read:async()=>assert.fail('No native action requests in this synthetic source fixture')}};
  const fitIntervals=createPrivateActionIntervalServices(intervalOptions),validationIntervals=createPrivateActionIntervalServices({...intervalOptions,usagePurpose:'TRANSITION_VALIDATE'});
  const learning=createTaskLearningServices({...f.options,actionIntervals:fitIntervals.actionIntervals,validationActionIntervals:validationIntervals.actionIntervals,evaluationProtocols:protocols});
  const privateAuthority=createPrivateAuthorizationRevision(f.options);
  // Shared read consistency must cover the synthetic rule source authority too,
  // not only file-style policy/identity inputs. No dependency is omitted.
  const authority=async p=>digest({privateAuthority:await privateAuthority(p),sourceAuthority:f.state});
  const worker={id:'native-learned-fit-worker',tenantId:ctx.tenantId,roles:['plus_compute_worker']};
  f.people.set(worker.id,structuredClone(worker));
  const computeConfig={storage:f.storage,tenantId:ctx.tenantId,datasets:learning.datasets,recipes:learning.recipes,transitionPlans:learning.transitionPlans,
    ...createPrivateNativeFitVerifiers({recipes:learning.recipes}),clock:f.options.clock,
    authorize:async p=>[trainer.id,worker.id,owner.id].includes(p.id),
    policyFor:async()=>({version:'plus-compute-policy-v1',workerId:worker.id,engineId:transitionEstimatorId,recipeHash:transitionHash,leaseMs:300000,maxAttempts:2}),
    resolvePrincipal:f.options.identities.resolvePrincipal,
    ...(qualifiedReads?{readConsistency:'SHARED_NATIVE_AND_AUTHORITY',authorizationRevision:authority}:{})};
  const compute=new NativeComputeAdmission(computeConfig);
  const registeredReaders=new Set(),registeredConfigs=new Set();
  const qualify=(readers,configs)=>{
    if(!qualifiedReads)return;
    for(const reader of readers)registeredReaders.add(reader);
    for(const config of configs)registeredConfigs.add(config);
    const scope=createNativeReadQualificationPhase({storage:f.storage,tenantId:ctx.tenantId,readers:[...registeredReaders],authorizationRevision:authority,clock:f.options.clock});
    for(const config of registeredConfigs)config.readQualificationPhase=scope;
  };
  qualify([s.recipes,learning.recipes,compute],[computeConfig]);
  const job=await compute.enqueue(f.transitionDatasetIds[0],'FIT',trainer,'real-task-component-fit');
  const dispatch=await compute.claim(job.id,worker),candidate=await fitInProcess(privateFitRequest(dispatch.recipe,[dispatch.transitionInput.material]));
  await compute.completeFit(job.id,dispatch.version,dispatch.leaseToken,candidate,worker);
  phase('native-transition-fit-complete');
  const evaluations=new NativeModelEvaluation({storage:f.storage,tenantId:ctx.tenantId,protocols,compute,recipes:learning.recipes,datasets:learning.datasets,
    transitionPlans:learning.transitionPlans,authorizationRevision:authority,clock:f.options.clock,
    authorize:async(p,permission)=>p.id===trainer.id||p.id===owner.id&&permission==='evaluation:result-read',evaluator:createTransitionEvaluator()});
  const evaluation=await evaluations.evaluate({protocolId:pd.id,executionId:job.id,validationDatasetIds:[frozen.id]},trainer);
  phase('native-transition-scored');
  const component=f.recipe.component,componentPolicy={version:'plus-transition-component-admission-v1',id:'task.learned.component',task:'CONDITIONAL_TRANSITION',
    definitionHash:component.definitionHash,bindingHash:component.bindingHash,scopeKey:component.scopeKey,classification:component.classification,clockHash:component.timeContractHash,component};
  const decisionConfig={storage:f.storage,tenantId:ctx.tenantId,evaluations,recipes:learning.recipes,clock:f.options.clock,
    authorize:async p=>[trainer.id,owner.id].includes(p.id),policyFor:async()=>structuredClone(componentPolicy),authorizationRevision:authority,readConsistency:'SHARED_NATIVE_AND_AUTHORITY'};
  const decisions=new NativeModelDecision(decisionConfig);
  qualify([s.recipes,learning.recipes,compute,decisions],[computeConfig,decisionConfig]);
  const accepted=await decisions.decide({key:componentPolicy.id,evaluationId:evaluation.id,evaluationVersion:evaluation.version,decision:'APPROVE',reason:'Actual independently scored Task transition component'},owner);
  phase('native-component-approved');
  const approved=await decisions.requireComponentApproved(accepted.id,owner),record=approved.record;
  assert.equal(approved.modelComponentApproved,true);assert.equal(approved.modelApproved,false);
  await assert.rejects(()=>decisions.requireApproved(accepted.id,owner),/COMPONENT_ONLY/);
  const {recipe}=await learnedCompositionRecipe({...f.build,componentDecision:{id:record._id,version:record._version,hash:digest(record)}});
  const oldValidation=createNativeCompositionRecipeValidation({definitions:f.definitions,ruleSpecifications:f.rules});
  const newValidation=createNativeLearnedCompositionRecipeValidation({definitions:f.definitions,ruleSpecifications:f.rules,recipes:learning.recipes,componentDecisions:decisions});
  const compositionRecipes={validateRecipe:(p,...args)=>(p.engineId===learnedCompositionEstimatorId?newValidation:oldValidation).validateRecipe(p,...args),
    qualifyDependencies:(p,...args)=>(p.engineId===learnedCompositionEstimatorId?newValidation:oldValidation).qualifyDependencies(p,...args),authorizationRevision:authority};
  const nativeOptions={...f.options,compositionRecipes,componentDecisions:decisions},native=createTaskLearningServices(nativeOptions);
  const request={key:entry.key,revision:1,definitionKey:f.compiled.definition.key,payload:recipe};
  await assert.rejects(()=>createTaskLearningServices({...nativeOptions,componentDecisions:undefined}).recipes.propose(request,trainer),/COMPONENT_PROVIDER_REQUIRED/);
  const changed=structuredClone(request);changed.payload.transition.config.smoothingAlpha=2;
  await assert.rejects(()=>native.recipes.propose(changed,trainer),/COMPONENT_RECIPE_MISMATCH/);
  const proposed=await native.recipes.propose(request,trainer);
  await assert.rejects(()=>native.recipes.review(proposed.id,proposed.version,'APPROVE','self review',trainer),/INDEPENDENT_REVIEW|FORBIDDEN/);
  const published=await native.recipes.review(proposed.id,proposed.version,'APPROVE','Actual component plus reviewed Task observation/rule contract',owner);
  phase('native-complete-recipe-approved');
  const reopened=createTaskLearningServices({...nativeOptions,storage:f.open()});
  assert.deepEqual((await reopened.recipes.requireApproved(published.recipeHash,trainer)).payload,recipe);
  phase('reopened-recipe-qualified');
  assert.deepEqual((await f.storage.getLinks(ctx,proposed.id,'PlusRecipeComponentDecision','outbound')).items.map(r=>r._toId),[accepted.id]);
  assert.deepEqual((await f.storage.getLinks(ctx,proposed.id,'PlusRecipeRuleSpecification','outbound')).items.map(r=>r._toId),[f.rule.id]);
  const materialConfig={storage:f.storage,tenantId:ctx.tenantId,recipes:native.recipes,componentDecisions:decisions,compute,datasets:s.datasets,
    authorize:async p=>[trainer.id,owner.id].includes(p.id),authorizationRevision:authority};
  const materialReader=new NativeLearnedCompositionMaterial(materialConfig);
  const readers=[s.recipes,learning.recipes,native.recipes,compute,decisions];
  qualify(readers,[computeConfig,decisionConfig,materialConfig]);
  const protectedMaterial=await materialReader.materializeForFit(published.recipeHash,f.frozenRows.map(r=>r.id),trainer);
  assert.deepEqual(protectedMaterial.transition.material,dispatch.transitionInput.material);
  assert.deepEqual(protectedMaterial.closure.datasets.map(r=>r.reference.id).sort(),[...f.frozenRows.map(r=>r.id),...f.transitionDatasetIds].sort());
  assert.equal(protectedMaterial.closure.samples.length,5); // one observation + four longitudinal endpoints
  phase('original-exposure-and-closure-qualified');
  const composed=await fitLearnedComposition(recipe,protectedMaterial.observation.materials,[protectedMaterial.transition.material],protectedMaterial.transition.candidate);
  assert.equal(composed.transitionArtifactHash,candidate.artifactHash);assert.equal(composed.nativeAdmissionChecked,false);assert.equal(composed.predictionReady,false);
  let completeJob,completeCompute,completeAdmission,completeConfig,computeAccess;
  if(fullFit){
    const initialAuthorization=versionedCompute?{key:'actual.complete.fit',version:1}:undefined;
    if(versionedCompute){
      assert.equal(f.policy.compute,undefined);
      const datasetIds=f.frozenRows.map(r=>r.id),policy={version:'plus-compute-policy-v1',workerId:worker.id,engineId:learnedCompositionEstimatorId,recipeHash:published.recipeHash,leaseMs:300000,maxAttempts:2};
      f.policy.compute={version:'plus-private-compute-v2',enabled:true,
        jobs:datasetIds.map(datasetId=>({datasetId,submitterId:trainer.id,requiredRoles:trainer.roles,authorization:{...initialAuthorization},policy:{...policy}})),
        grants:[{principalId:trainer.id,requiredRoles:trainer.roles,datasetIds:[...datasetIds],permissions:['compute:submit','compute:inspect','compute:read-result']},
          {principalId:owner.id,requiredRoles:owner.roles,datasetIds:[...datasetIds],permissions:['compute:inspect','compute:read-result']},
          {principalId:worker.id,requiredRoles:worker.roles,datasetIds:[...datasetIds],permissions:['compute:claim','compute:complete','compute:fail']}],
        workers:[{principalId:worker.id,requiredRoles:worker.roles,maxItems:10}]};
      computeAccess=createPrivateComputeAccess({...f.options,engineId:learnedCompositionEstimatorId});computeAccess.assertConfigured();
    }
    const config={storage:f.storage,tenantId:ctx.tenantId,datasets:s.datasets,recipes:native.recipes,learnedComposition:materialReader,
      verifyLearnedCompositionFitResult:createNativeLearnedCompositionFitVerifier({recipes:native.recipes}),clock:f.options.clock,
      authorize:async p=>[trainer.id,worker.id,owner.id].includes(p.id),resolvePrincipal:f.options.identities.resolvePrincipal,
      policyFor:async()=>({version:'plus-compute-policy-v1',workerId:worker.id,engineId:learnedCompositionEstimatorId,recipeHash:published.recipeHash,leaseMs:300000,maxAttempts:2}),
      ...(qualifiedReads?{readConsistency:'SHARED_NATIVE_AND_AUTHORITY',authorizationRevision:authority}:{})};
    if(computeAccess)Object.assign(config,{authorize:computeAccess.authorize,policyFor:computeAccess.policyFor,resolvePrincipal:computeAccess.resolvePrincipal});
    completeConfig=config;
    completeCompute=new NativeComputeAdmission(config);
    readers.push(completeCompute);qualify(readers,[computeConfig,decisionConfig,materialConfig,config]);
    const inputs=f.frozenRows.map(r=>r.id);
    completeJob=await completeCompute.enqueue(inputs.length===1?inputs[0]:inputs,'FIT',trainer,'actual-native-complete-model-fit',initialAuthorization);
    phase('complete-model-native-enqueued');
    const delivered=await completeCompute.claim(completeJob.id,worker);
    assert.deepEqual(delivered.compositionInput.material,protectedMaterial);phase('complete-model-native-dispatched');
    const fitted=await fitInProcess(privateFitRequest(recipe,[delivered.compositionInput.material]));assert.deepEqual(fitted,composed);
    const completed=await completeCompute.completeFit(completeJob.id,delivered.version,delivered.leaseToken,fitted,worker);
    assert.equal(completed.status,'SUCCEEDED');assert.equal(completed.deploymentAuthorized,false);phase('complete-model-native-fitted');
    assert.deepEqual((await f.storage.getLinks(ctx,completed.candidateId,'PlusReleaseDataset','outbound')).items.map(r=>r._toId).sort(),protectedMaterial.closure.datasets.map(r=>r.reference.id).sort());
    const reopenedCompute=new NativeComputeAdmission({...config,storage:f.open()});
    const result=await reopenedCompute.readLearnedCompositionFitForEvaluation(completeJob.id,trainer);
    assert.deepEqual(result.response.payload,fitted);assert.deepEqual(result.composition.material,protectedMaterial);
    assert.equal(result.response.status,'CANDIDATE');phase('complete-model-native-reopened');
    if(fullAdmission)completeAdmission=await admitNativeCompleteModel({f,holdout:completeHoldout,recipes:native.recipes,recipe,
      compute:completeCompute,job:completeJob,candidateId:completed.candidateId,authority,phase,
      configureQualification:({readers:extra,configs})=>qualify([...readers,...extra],[computeConfig,decisionConfig,materialConfig,config,...configs])});
  }
  assert.equal(registeredFitEngineIds.includes(learnedCompositionEstimatorId),false);
  assert.equal((await f.storage.queryObjects(ctx,'PlusModelRelease',{and:[]})).totalCount,completeJob?2:1);
  assert.equal((await f.storage.queryObjects(ctx,'PlusDeployment',{and:[]})).totalCount,completeAdmission?1:0);
  const continuation=await afterAdmission?.({f,native,recipe,published,materialReader,materialConfig,compute:completeCompute,computeConfig:completeConfig,
    componentCompute:compute,componentDecisions:decisions,componentDecision:record,admission:completeAdmission,authority,worker,phase,computeAccess,
    configureQualification:({readers:extra,configs})=>qualify([...readers,...extra],[computeConfig,decisionConfig,materialConfig,completeConfig,...configs])});
  const ownerGrant=f.policy.taskLearning.grants.find(g=>g.principalId===owner.id),permissions=ownerGrant.permissions;
  ownerGrant.permissions=permissions.filter(v=>v!=='dataset:VALIDATE');
  await assert.rejects(()=>learning.transitionPlans.materializeForValidation(pd.id,[frozen.id],owner),/FORBIDDEN/);
  // Full source authority revision can reject the outer graph before the
  // per-reader VALIDATE check; both refusals must remain effective.
  await assert.rejects(()=>reopened.recipes.requireApproved(published.recipeHash,owner),/FORBIDDEN|DEPENDENCIES_STALE/);ownerGrant.permissions=permissions;
  await decisions.revoke(accepted.id,accepted.version,'Retire actual native Task component',owner);
  await assert.rejects(()=>reopened.recipes.requireApproved(published.recipeHash,trainer),/DEPENDENCY_STALE|MODEL_DECISION_STALE/);
  if(completeJob)await assert.rejects(()=>completeCompute.readFitResult(completeJob.id,trainer),/DEPENDENCY_STALE|MODEL_DECISION_STALE|COMPUTE_RESULT_NOT_AVAILABLE|COMPUTE_RECIPE_STALE/);
  if(completeAdmission)await assert.rejects(()=>completeAdmission.deployments.read(completeAdmission.key,owner),/STALE|SUSPENDED|NOT_AVAILABLE/);
  assert.ok((await reopened.recipes.listRevisions(entry.key,owner)).some(r=>r.id===proposed.id));
  assert.equal((await f.storage.getObject(ctx,'InvestigationTask',heldout.task._id)).actualCompletion,'UNKNOWN');
  phase('withdrawal-and-fact-boundaries-verified');
  return {continuation};
}
