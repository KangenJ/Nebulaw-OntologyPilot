import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { NativeModelDeployment,NativePublishedModelReference,NativeEvaluationProtocolRegistry,NativeModelEvaluation } from '../../platform/packages/plus-runtime/dist/index.js';
import { ctx,trainer,reviewer,owner,at } from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import { compositionEvaluationFixture } from './composition-evaluation-fixture.mjs';
import { compositionStateEvaluatorId } from './composition-state-evaluation.mjs';
import { compositionRecipe } from './native-composition-recipe.mjs';
import { neuralObservationRecipe,neuralRecipeConfig } from './native-neural-fit-verifier.mjs';
import { fitCompositionObservations } from './composition-training.mjs';

// Real native reference selection/capture/prospective approval/requalification.
// Synthetic source/clock/permission fixtures; reuses TRAIN, NOT two new rounds.
test('native U3 batch composition reference is frozen before fresh labels, actually scored on the same history and rejected after withdrawal',async t=>{
  const f=await compositionEvaluationFixture(t,{neural:true,batch:true}),s=f.services,key='composition-current';
  f.decisionConfig.authorize=async(p,permission)=>p.id===owner.id||p.id===trainer.id&&['model:decision-read','model:decision-use'].includes(permission);
  const initial=await f.evaluations.evaluate(f.request,trainer);assert.equal(initial.decision,'ELIGIBLE_FOR_REVIEW');
  const decision=await f.decisions.decide({key,evaluationId:initial.id,evaluationVersion:initial.version,decision:'APPROVE',reason:'Synthetic initial composition admission'},owner);
  const {version,id,...target}=await f.decisionConfig.policyFor(owner,key);
  const deployments=new NativeModelDeployment({storage:f.storage,tenantId:ctx.tenantId,decisions:f.decisions,clock:f.options.clock,
    authorize:async(p,permission)=>p.id===owner.id||p.id===trainer.id&&permission==='deployment:read',targetFor:async()=>target,
    authorizationRevision:f.authority,readConsistency:'SHARED_NATIVE_AND_AUTHORITY'});
  const selection=await deployments.activate({key,expectedVersion:0,decisionId:decision.id,requestKey:'first-composition-reference',reason:'Synthetic selection only'},owner);
  assert.equal(selection.predictionReady,false);
  const references=new NativePublishedModelReference({storage:f.storage,tenantId:ctx.tenantId,deployments,recipes:s.recipes,compute:f.compute,authorizationRevision:f.authority});
  // A genuinely different, predeclared recipe and a separately authorized FIT
  // execution; never score the currently selected release against itself.
  const nextTrainer={...trainer,id:'composition-reference-candidate-trainer'};f.people.set(nextTrainer.id,nextTrainer);
  const oldGrant=f.policy.taskLearning.grants.find(g=>g.principalId===trainer.id);
  f.policy.taskLearning.grants.push({...structuredClone(oldGrant),principalId:nextTrainer.id});
  const statistics=neuralObservationRecipe(f.recipe.composition.statistics,f.recipe.statistics.baseline,
    {...neuralRecipeConfig(f.recipe.statistics),network:{...f.recipe.statistics.network,epochs:120}}).recipe;
  const next=compositionRecipe({compiled:f.compiled,composition:f.recipe.composition,statistics,ruleSpecification:(await f.rules.requireApproved(f.rule.specificationHash,owner)).record});
  const recipeDraft=await s.recipes.propose({key:'task.observation',revision:2,definitionKey:'task.completion',payload:next.recipe},nextTrainer);
  await s.recipes.review(recipeDraft.id,recipeDraft.version,'APPROVE','Predeclared new network budget before fresh holdout',owner);
  const previousPolicy=f.computeConfig.policyFor,previousAccess=f.computeConfig.authorize;
  f.computeConfig.policyFor=async(p,...args)=>({...await previousPolicy(p,...args),...(p.id===nextTrainer.id?{recipeHash:next.recipeHash}:{})});
  f.computeConfig.authorize=async(p,...args)=>previousAccess(p.id===nextTrainer.id?trainer:p,...args);
  await assert.rejects(()=>f.compute.enqueue(f.frozenRows.map(r=>r.id),'FIT',nextTrainer,'missing-source-grant'),/EPISODE_FORBIDDEN/);
  const episodeGrant=f.policy.taskDomain.episodeGrants.find(g=>g.principalId===trainer.id);
  f.policy.taskDomain.episodeGrants.push({...structuredClone(episodeGrant),principalId:nextTrainer.id,workspaces:['synthetic'],permissions:['episode:read','episode:history']});
  const nextFit=await f.compute.enqueue(f.frozenRows.map(r=>r.id),'FIT',nextTrainer,'independent-reference-candidate');
  const worker=await f.options.identities.resolvePrincipal('composition-evaluation-worker'),lease=await f.compute.claim(nextFit.id,worker);
  const nextCandidate=await fitCompositionObservations(lease.recipe,lease.inputBatch.materials);
  const nextComplete=await f.compute.completeFit(nextFit.id,lease.version,lease.leaseToken,nextCandidate,worker);
  assert.notEqual(nextComplete.candidateId,f.completion.candidateId);assert.notEqual(digest(nextCandidate.statistics.spec),digest(f.candidate.statistics.spec));
  const protocol={...f.protocol,key:'composition-reference-heldout',partition:'VALIDATION',expectedSampleCount:1,inputVisibleFrom:at(21),inputVisibleUntil:at(22),
    labelReceivedFrom:at(23),labelReceivedUntil:at(27),approvalUntil:at(29)};
  f.policy.taskLearning.cohorts.push({workspace:'synthetic',protocol});for(const grant of f.policy.taskLearning.grants)grant.protocolKeys.push(protocol.key);
  let root;
  for(let i=0;i<64;i++){
    const candidate=await f.root('synthetic',undefined,20),seed=f.policy.taskLearning.partition.seed;
    const bucket=parseInt(digest([seed,ctx.tenantId,['task-matter-v1',digest(['synthetic',candidate.matter._id])]]).slice(0,8),16)%10000;
    if(bucket>=6000&&bucket<7500){root=candidate;break;}
  }
  assert.ok(root);f.advance(22);
  const report=await f.createSource(root.task,{record:'fresh-reference-report',result:'DONE',eventMinute:21,received:21});
  const episode=await f.episodes.open({definitionKey:'task.completion',rootId:root.task._id,startedAt:at(20)},trainer,'fresh-reference-episode');
  const input=await f.capture(episode,'fresh-reference-input',21);assert.equal((await s.partitions.reserve(input.record._id,trainer)).partition,'VALIDATION');
  const cd=await s.datasets.proposeCohort(protocol.key,[input.record._id],trainer),cohort=await s.datasets.reviewCohort(cd.id,cd.version,'APPROVE','Synthetic fresh membership before GOLD',reviewer);
  const basePurpose=await f.protocolConfig.policyFor(trainer,'composition-state-score');
  const protocols=new NativeEvaluationProtocolRegistry({...f.protocolConfig,publishedReferences:references,
    policyFor:async()=>({...basePurpose,recipeHashes:[next.recipeHash],id:'composition-reference-purpose',reference:{mode:'CURRENT_PUBLICATION',controlKey:key}})});
  const ep=await protocols.propose({key:'composition-reference-score',revision:1,recipeHash:next.recipeHash,cohortIds:[cohort.id],evaluatorId:compositionStateEvaluatorId,
    configuration:{minimumSamples:1,minimumCoverage:1,maximumNllRegression:0,maximumBrierRegression:0,task:'STATE_ESTIMATION',clock:f.timeContract}},trainer);
  const approved=await protocols.review(ep.id,ep.version,'APPROVE','Synthetic current reference before labels',owner);
  const frozen=(await protocols.requireApproved(approved.id,trainer)).record.payload.reference;
  assert.equal(frozen.selection.id,selection.revisionId);assert.equal(frozen.trainingDatasets.length,2);
  f.advance(24);const gold=await f.createSource(root.task,{observation:report.object,result:'DONE',received:24,eventMinute:21});
  const label=await f.capture(episode,'fresh-reference-gold',21);await s.partitions.reserve(label.record._id,trainer);f.advance(24.1);
  const feedback=await s.feedback.propose({inputSnapshotId:input.record._id,labelSnapshotId:label.record._id,eventId:gold.event._id},trainer);
  await s.feedback.review(feedback.id,feedback.version,'APPROVE','Synthetic independent fresh reference label',reviewer);
  f.advance(29);const dataset=await s.datasets.freeze(cohort.id,trainer);
  const config={...f.evaluationConfig,protocols,publishedReferences:references};
  const evaluations=new NativeModelEvaluation(config),request={protocolId:approved.id,executionId:nextFit.id,validationDatasetIds:[dataset.id]};
  const result=await evaluations.evaluate(request,trainer),read=await evaluations.read(result.id,owner,{recompute:true}),metrics=read.record.result.metrics;
  assert.equal(metrics.publishedReferenceHash,digest(frozen));assert.equal(metrics.publishedArtifactHash,digest(f.candidate));
  assert.equal(metrics.comparisons.currentPublication.groupMacroNllDelta,metrics.candidate.groupMacroNll-metrics.references.currentPublication.groupMacroNll);
  assert.equal(metrics.comparisons.currentPublication.groupMacroBrierDelta,metrics.candidate.groupMacroBrier-metrics.references.currentPublication.groupMacroBrier);
  assert.notEqual(metrics.comparisons.currentPublication.groupMacroNllDelta,0);
  assert.equal(result.decision,Object.values(metrics.comparisons).some(c=>c.regresses)?'REJECT_REGRESSION':'ELIGIBLE_FOR_REVIEW');
  assert.equal(Object.keys(metrics.references).length,4);assert.equal(metrics.predictionReceipts.length,1);
  assert.equal(metrics.notEvaluated.includes('CURRENT_PUBLISHED_MODEL_COMPARISON'),false);
  assert.deepEqual((await references.requireQualified(frozen,owner)).reference,frozen);
  const reopened=new NativeModelEvaluation({...config,storage:f.open()});assert.equal((await reopened.read(result.id,owner)).record.contentHash,read.record.contentHash);
  await f.rules.revoke(f.rule.id,f.rule.version,'Withdraw reference rule dependency',owner);
  await assert.rejects(()=>references.requireQualified(frozen,owner),/FORBIDDEN|REVOKED|STALE|NOT_APPROVED/);
  await assert.rejects(()=>reopened.read(result.id,owner),/FORBIDDEN|REVOKED|STALE|NOT_APPROVED/);
});
