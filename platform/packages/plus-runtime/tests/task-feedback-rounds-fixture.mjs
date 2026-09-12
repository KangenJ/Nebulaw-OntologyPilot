// Actual Task-native new feedback/current-publication comparison. Source records
// are synthetic transactions; private host/canonical online actions run separately.
import assert from 'node:assert/strict';
import { digest } from '@openfoundry/plus-contracts';
import { NativePublishedModelReference } from '../dist/index.js';
import { ctx,trainer,owner } from './task-learning-fixture.mjs';
import { freshTaskCohort } from './fresh-task-cohort-fixture.mjs';
import { observationRecipe } from '../../../../services/plus-engine/native-fit-verifier.mjs';
import { neuralObservationRecipe } from '../../../../services/plus-engine/native-neural-fit-verifier.mjs';
import { fitObservationModel } from '../../../../services/plus-engine/observation-fit.mjs';
import { fitNeuralObservationModel } from '../../../../services/plus-engine/neural-observation-fit.mjs';

export async function exerciseTaskFeedbackRounds(f,{neural,training,recipe,recipeHash,compute,protocols,protocolConfig,evaluations,evaluationConfig,decisions,deployments,selected,authority,evaluatorId,timeContract,worker,progress}){
 const references=new NativePublishedModelReference({storage:f.storage,tenantId:ctx.tenantId,deployments,recipes:f.services.recipes,compute,authorizationRevision:authority});
 protocolConfig.publishedReferences=references;evaluationConfig.publishedReferences=references;
 const ids=[training.id],protocolHashes=[...recipe.config.trainingProtocolHashes],original=structuredClone(f.policy.compute.jobs[0].policy),rounds=[];
 let active={selected,recipe,recipeHash,candidateId:null};
 for(const round of [1,2]){
  const start=30+(round-1)*20;
  // Frozen fixture: first round corroborates; second provides misleading reports
  // with independently verified labels. No gate/hyperparameter tuning to holdout.
  const states=neural?['DONE','NOT_DONE']:['DONE'];
  const train=await freshTaskCohort(f,{key:'task-feedback-train-'+round,partition:'TRAIN',start,
   records:states.map(state=>({state,report:round===1?state:state==='DONE'?'NOT_DONE':'DONE'}))});
  const data=await train.freezeWithFeedback();ids.push(data.id);protocolHashes.push(digest(train.protocol));
  progress('TASK_FEEDBACK_'+round+'_NEW_NATIVE_TRAIN_FROZEN');
  const supervision={...recipe.config,trainingProtocolHashes:[...protocolHashes]},config=neural?{schema:'plus-neural-observation-config-v1',supervision,network:structuredClone(recipe.network)}:supervision;
  const next=(neural?neuralObservationRecipe:observationRecipe)(f.compiled,recipe.baseline,config);
  const draft=await f.services.recipes.propose({key:'task.observation',revision:round+1,definitionKey:'task.completion',payload:next.recipe},trainer);
  await f.services.recipes.review(draft.id,draft.version,'APPROVE','Unchanged algorithm; newly verified Task cohort',owner);
  const authorization={key:'task.observation.fit',version:round+1},policy={...original,recipeHash:next.recipeHash};
  for(const datasetId of ids)f.policy.compute.jobs.push({datasetId,submitterId:trainer.id,requiredRoles:trainer.roles,authorization:{...authorization},policy:{...policy}});
  for(const g of f.policy.compute.grants)for(const id of ids)if(!g.datasetIds.includes(id))g.datasetIds.push(id);
  await assert.rejects(()=>compute.enqueue(ids,'FIT',trainer,'task-ambiguous-'+round),/COMPUTE_AUTHORIZATION_REQUIRED/);
  const fit=await compute.enqueue(ids,'FIT',trainer,'task-feedback-fit-'+round,authorization),lease=await compute.claim(fit.id,worker);
  const artifact=(neural?fitNeuralObservationModel:fitObservationModel)(f.compiled,next.recipe.baseline,lease.inputBatch.materials,config);
  assert.equal(artifact.neuralTrained,neural);assert.equal(lease.inputBatch.materials.length,round+1);
  const samples=lease.inputBatch.materials.flatMap(d=>d.sourceManifest.samples);
  assert.equal(samples.length,neural?4+2*round:1+round);assert.equal(new Set(samples.map(s=>s.entityKey)).size,samples.length);
  const complete=await compute.completeFit(fit.id,lease.version,lease.leaseToken,artifact,worker);
  progress('TASK_FEEDBACK_'+round+'_ACTUAL_CUMULATIVE_FIT_COMPLETE');
  const validation=await freshTaskCohort(f,{key:'task-feedback-validation-'+round,partition:'VALIDATION',start:start+10,records:states.map(state=>({state,report:state}))});
  const key='task-feedback-score-'+round,purpose={version:'plus-evaluation-purpose-v1',id:key,recipeHashes:[next.recipeHash],evaluatorIds:[evaluatorId],classifications:['SYNTHETIC'],reference:{mode:'CURRENT_PUBLICATION',controlKey:'task-v2-current'}};
  f.policy.evaluation.protocols.push({key,purpose});for(const g of f.policy.evaluation.grants)g.protocolKeys.push(key);
  const request=await protocols.propose({key,revision:1,recipeHash:next.recipeHash,cohortIds:[validation.cohort.id],evaluatorId,
   configuration:{minimumSamples:1,minimumCoverage:1,maximumNllRegression:0,task:'STATE_ESTIMATION',maximumBrierRegression:0,clock:timeContract}},trainer);
  const approved=await protocols.review(request.id,request.version,'APPROVE','Before fresh validation labels; freeze actual Task publication',owner);
  const reference=(await protocols.requireApproved(approved.id,owner)).record.payload.reference;
  assert.equal(reference.selection.id,active.selected.revisionId);progress('TASK_FEEDBACK_'+round+'_CURRENT_REFERENCE_FROZEN_BEFORE_LABELS');
  const heldout=await validation.freezeWithFeedback(),score=await evaluations.evaluate({protocolId:approved.id,executionId:fit.id,validationDatasetIds:[heldout.id]},trainer);
  const scored=await evaluations.read(score.id,owner),comparison=neural?scored.record.result.metrics.comparisons.currentPublication:scored.record.result.metrics.publishedComparison;
  progress('TASK_FEEDBACK_'+round+'_ACTUAL_REFERENCE_SCORE_COMPLETE');
  if(round===1){
   assert.equal(score.decision,'ELIGIBLE_FOR_REVIEW');assert.ok(comparison.groupMacroNllDelta<0);
   const decision=await decisions.decide({key:'task-v2-current',evaluationId:score.id,evaluationVersion:score.version,decision:'APPROVE',reason:'Independent admission after fresh Task feedback'},owner);
   const updated=await deployments.activate({key:'task-v2-current',expectedVersion:active.selected.version,decisionId:decision.id,requestKey:'task-feedback-M1',reason:'Publish independently qualified Task candidate'},owner);
   active={selected:updated,recipe:next.recipe,recipeHash:next.recipeHash,candidateId:complete.candidateId};
  }else{
   assert.equal(score.decision,'REJECT_REGRESSION');assert.ok(comparison.groupMacroNllDelta>0);
   const rejected=await decisions.decide({key:'task-v2-current',evaluationId:score.id,evaluationVersion:score.version,decision:'REJECT',reason:'Actual regression after misleading synthetic Task reports'},owner);
   const pointer=await f.storage.getObject(ctx,'PlusDeployment',active.selected.deploymentId),epoch=await f.storage.getReadRevision(ctx);
   await assert.rejects(()=>deployments.activate({key:'task-v2-current',expectedVersion:active.selected.version,decisionId:rejected.id,requestKey:'task-rejected-M2',reason:'Rejected candidate must never become current'},owner),/NOT_APPROVED/);
   assert.deepEqual(await f.storage.getObject(ctx,'PlusDeployment',active.selected.deploymentId),pointer);assert.equal(await f.storage.getReadRevision(ctx),epoch);
  }
  rounds.push({train,validation,score});progress('TASK_FEEDBACK_'+round+'_INDEPENDENT_DECISION_AND_SELECTION_CHECKED');
 }
 assert.notEqual(rounds[0].train.feedbackIds[0],rounds[1].train.feedbackIds[0]);assert.equal(active.selected.generation,2);
 return active;
}
