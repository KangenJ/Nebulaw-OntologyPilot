import assert from 'node:assert/strict';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { NativeModelDeployment,NativePublishedModelReference,learnedCompositionStateEvaluatorId } from '../../platform/packages/plus-runtime/dist/index.js';
import { ctx,trainer,owner } from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import { freshTaskCohort } from '../../platform/packages/plus-runtime/tests/fresh-task-cohort-fixture.mjs';
import { compositionRecipe } from './native-composition-recipe.mjs';
import { observationRecipe } from './native-fit-verifier.mjs';
import { learnedCompositionRecipe } from './learned-composition.mjs';
import { fitInProcess } from './fit-worker.mjs';
import { privateFitRequest } from './private-fit-registry.mjs';

// Actual native complete-model continuation, not observation-only admission.
// Source records, identities, grants, WAIT inventory and clock are explicitly
// SYNTHETIC. Fixed pre-label fixtures test engineering, not business efficacy.
// Transition component is requalified and REUSED; observation parameters learn.
// This file does not claim mechanism-conditioned learning or online recovery.
export async function exerciseCompleteFeedbackRounds(c,{withdrawCurrent}={}){
  const {f,native,recipe,compute,componentDecision,admission:a,authority,worker,phase}=c;
  assert.ok(c.computeAccess,'Versioned private compute authorization required');
  assert.equal(recipe.transition.actionHistoryContract.version,'plus-native-action-interval-policy-v3');
  const cohortFixture={...f,source:f.createSource};
  const references=new NativePublishedModelReference({storage:f.storage,tenantId:ctx.tenantId,deployments:a.deployments,
    recipes:native.recipes,compute,learnedCompositionCompute:compute,authorizationRevision:authority});
  a.protocolConfig.learnedCompositionReferences=references;a.populationConfig.publishedReferences=references;
  assert.equal(f.policy.evaluation,undefined);f.policy.evaluation={protocols:[]};
  const originalPurpose=a.protocolConfig.policyFor;
  a.protocolConfig.policyFor=async(p,key)=>{
    const entry=f.policy.evaluation.protocols.find(r=>r.key===key);
    return entry?structuredClone(entry.purpose):originalPurpose(p,key);
  };
  c.configureQualification({readers:[a.decisions],configs:[a.protocolConfig,a.evaluationConfig,a.decisionConfig]});
  const ids=f.frozenRows.map(r=>r.id),protocolHashes=[...recipe.config.trainingProtocolHashes];
  const originalPolicy=structuredClone(f.policy.compute.jobs[0].policy),first=a.selected,rounds=[];
  let active=first,previousArtifact;
  for(const round of [1,2]){
    const start=60+(round-1)*20;
    // Chosen before either round is run: D1 corroborates DONE, D2 reports NOT_DONE
    // while independent GOLD says DONE. Never tune on observed validation scores.
    const train=await freshTaskCohort(cohortFixture,{key:'complete-new-train-'+round,partition:'TRAIN',start,
      records:[{state:'DONE',report:round===1?'DONE':'NOT_DONE'}]});
    const data=await train.freezeWithFeedback();ids.push(data.id);protocolHashes.push(digest(train.protocol));
    phase('complete-round-'+round+'-new-native-feedback-frozen');
    const base=recipe.observation.statistics;
    const statistics=observationRecipe(base.compiled,base.baseline,{...base.config,trainingProtocolHashes:[...protocolHashes]}).recipe;
    const rule=(await f.rules.requireApproved(recipe.observation.ruleSpecificationHash,trainer)).record;
    const observation=compositionRecipe({compiled:f.compiled,composition:recipe.observation.composition,statistics,ruleSpecification:rule}).recipe;
    const next=await learnedCompositionRecipe({...f.build,observation,
      componentDecision:{id:componentDecision._id,version:componentDecision._version,hash:digest(componentDecision)}});
    assert.deepEqual(next.recipe.transition,recipe.transition);
    const draft=await native.recipes.propose({key:'task.learned.composition',revision:round+1,definitionKey:f.compiled.definition.key,payload:next.recipe},trainer);
    await native.recipes.review(draft.id,draft.version,'APPROVE','New verified observation cohort; retain currently qualified transition component',owner);
    const authorization={key:'actual.complete.fit',version:round+1};
    for(const datasetId of ids)f.policy.compute.jobs.push({datasetId,submitterId:trainer.id,requiredRoles:trainer.roles,authorization:{...authorization},policy:{...originalPolicy,recipeHash:next.recipeHash}});
    for(const grant of f.policy.compute.grants)for(const id of ids)if(!grant.datasetIds.includes(id))grant.datasetIds.push(id);
    c.computeAccess.assertConfigured();
    await assert.rejects(()=>compute.enqueue(ids,'FIT',trainer,'complete-ambiguous-'+round),/COMPUTE_AUTHORIZATION_REQUIRED/);
    const job=await compute.enqueue([...ids],'FIT',trainer,'complete-feedback-fit-'+round,authorization);
    const dispatch=await compute.claim(job.id,worker),material=dispatch.compositionInput.material;
    assert.equal(material.observation.materials.length,round+1);
    assert.deepEqual(material.transition.recipe,recipe.transition);
    assert.equal(new Set(material.closure.datasets.map(r=>r.reference.id)).size,ids.length+f.transitionDatasetIds.length);
    const candidate=await fitInProcess(privateFitRequest(next.recipe,[material]));
    if(previousArtifact)assert.notEqual(digest(candidate.spec),digest(previousArtifact.spec));
    const completed=await compute.completeFit(job.id,dispatch.version,dispatch.leaseToken,candidate,worker);
    assert.equal(completed.status,'SUCCEEDED');assert.equal(completed.deploymentAuthorized,false);
    phase('complete-round-'+round+'-actual-complete-fit-finished');
    const validation=await freshTaskCohort(cohortFixture,{key:'complete-new-heldout-'+round,partition:'VALIDATION',start:start+10,
      records:[{state:'DONE',report:'DONE'}]});
    for(const member of validation.members){
      f.policy.actionIntervals.targets.push({episodeId:member.episode._id,rootId:member.task._id,purpose:'LEARNED_COMPOSITION_VALIDATE',policy:recipe.transition.actionHistoryContract});
      for(const grant of f.policy.actionIntervals.grants)grant.episodeIds.push(member.episode._id);
    }
    const key='complete-new-score-'+round;
    f.policy.evaluation.protocols.push({key,purpose:{version:'plus-evaluation-purpose-v1',id:key,recipeHashes:[next.recipeHash],
      evaluatorIds:[learnedCompositionStateEvaluatorId],classifications:['SYNTHETIC'],reference:{mode:'CURRENT_PUBLICATION',controlKey:a.key}}});
    const protocolDraft=await a.protocols.propose({key,revision:1,recipeHash:next.recipeHash,cohortIds:[validation.cohort.id],evaluatorId:learnedCompositionStateEvaluatorId,
      configuration:{minimumSamples:1,minimumCoverage:1,maximumNllRegression:0,maximumBrierRegression:0,task:'STATE_ESTIMATION',clock:recipe.clock}},trainer);
    const protocol=await a.protocols.review(protocolDraft.id,protocolDraft.version,'APPROVE','Freeze actual complete publication before new heldout GOLD',owner);
    const reference=(await a.protocols.requireApproved(protocol.id,owner)).record.payload.learnedCompositionReference;
    assert.equal(reference.selection.id,active.revisionId);
    phase('complete-round-'+round+'-actual-complete-reference-frozen-before-labels');
    const heldout=await validation.freezeWithFeedback();
    const score=await a.evaluations.evaluate({protocolId:protocol.id,executionId:job.id,validationDatasetIds:[heldout.id]},trainer);
    const result=(await a.evaluations.read(score.id,owner)).record;
    assert.equal(result.result.metrics.nativeContextBound,true);
    const comparison=result.result.metrics.numerics.comparisons.currentPublication;
    phase('complete-round-'+round+'-independent-whole-comparison-finished');
    let decision;
    if(round===1){
      assert.equal(score.decision,'ELIGIBLE_FOR_REVIEW');assert.ok(comparison.groupMacroNllDelta<0);
      decision=await a.decisions.decide({key:a.policy.id,evaluationId:score.id,evaluationVersion:score.version,decision:'APPROVE',reason:'Independent whole-model admission after new verified feedback'},owner);
      active=await a.deployments.activate({key:a.key,expectedVersion:active.version,decisionId:decision.id,requestKey:'complete-new-M1',reason:'Publish actual complete-model update'},owner);
      assert.equal(active.predictionReady,false);assert.equal(active.replayRequired,true);
    }else{
      assert.equal(score.decision,'REJECT_REGRESSION');assert.ok(comparison.groupMacroNllDelta>0);
      decision=await a.decisions.decide({key:a.policy.id,evaluationId:score.id,evaluationVersion:score.version,decision:'REJECT',reason:'Actual complete-model regression against frozen current publication'},owner);
      const pointer=await f.storage.getObject(ctx,'PlusDeployment',first.deploymentId),epoch=await f.storage.getReadRevision(ctx);
      await assert.rejects(()=>a.deployments.activate({key:a.key,expectedVersion:active.version,decisionId:decision.id,requestKey:'complete-rejected-M2',reason:'Rejected complete model must not become current'},owner),/NOT_APPROVED/);
      assert.deepEqual(await f.storage.getObject(ctx,'PlusDeployment',first.deploymentId),pointer);assert.equal(await f.storage.getReadRevision(ctx),epoch);
    }
    rounds.push({train,validation,data,job,candidateId:completed.candidateId,score,decision});previousArtifact=candidate;
    phase('complete-round-'+round+'-whole-decision-and-selection-checked');
  }
  assert.equal(active.generation,2);assert.equal(new Set(rounds.map(r=>r.candidateId)).size,2);
  assert.equal(new Set(rounds.flatMap(r=>r.train.feedbackIds)).size,2);
  const members=rounds.flatMap(r=>[...r.train.members,...r.validation.members]);
  for(const member of members)assert.deepEqual(await f.storage.getObject(ctx,'InvestigationTask',member.task._id),member.task);
  // Default retains the independent admission-withdrawal test. The extended
  // recovery test withdraws actual source evidence instead, through native CEL
  // repair, so an admission revocation cannot mask a missing lineage fence.
  if(withdrawCurrent){
    const changed=await withdrawCurrent({rounds,active});
    assert.deepEqual(changed.repairedTrainingRootIds,[rounds[0].train.members[0].task._id]);
    for(const member of members)if(!changed.repairedTrainingRootIds.includes(member.task._id))
      assert.deepEqual(await f.storage.getObject(ctx,'InvestigationTask',member.task._id),member.task);
  }
  else await a.decisions.revoke(rounds[0].decision.id,rounds[0].decision.version,'Synthetic complete model withdrawal drill',owner);
  const facts=[];for(const member of members)facts.push(await f.storage.getObject(ctx,'InvestigationTask',member.task._id));
  await assert.rejects(()=>a.deployments.read(a.key,owner),/STALE|SUSPENDED/);
  const pointer=await f.storage.getObject(ctx,'PlusDeployment',first.deploymentId);
  const reopened=new NativeModelDeployment({...a.deploymentConfig,storage:f.open()});
  const restored=await reopened.rollback({key:a.key,expectedVersion:pointer._version,revisionId:first.revisionId,requestKey:'complete-clean-M0',reason:'Requalify original complete model, do not undo facts'},owner);
  assert.equal(restored.generation,3);assert.equal(restored.predictionReady,false);assert.equal(restored.replayRequired,true);
  assert.equal((await reopened.read(a.key,owner)).selection.decision.id,a.decision.id);
  await assert.rejects(()=>reopened.rollback({key:a.key,expectedVersion:restored.version,revisionId:active.revisionId,requestKey:'complete-dirty-M1',reason:'Withdrawn complete model must remain unusable'},owner),/STALE/);
  // Preserve complete post-repair facts, not merely the completion enum.
  for(const fact of facts)assert.deepEqual(await f.storage.getObject(ctx,'InvestigationTask',fact._id),fact);
  phase('two-new-complete-candidates-regression-refusal-model-rollback-verified');
  return {rounds:rounds.map(r=>({datasetId:r.data.id,executionId:r.job.id,candidateId:r.candidateId,evaluationId:r.score.id,decision:r.score.decision})),restored};
}
