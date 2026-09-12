import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '@openfoundry/plus-contracts';
import { NativeModelDecision,NativeModelDeployment,NativePublishedModelReference } from '../dist/index.js';
import { modelEvaluationFixture,ctx,trainer,owner } from './model-evaluation-fixture.mjs';
import { freshLearningCohort } from './fresh-learning-round-fixture.mjs';
import { prepareModelBeliefRecovery } from './model-belief-recovery-fixture.mjs';
import { observationRecipe } from '../../../../services/plus-engine/native-fit-verifier.mjs';
import { fitObservationModel } from '../../../../services/plus-engine/observation-fit.mjs';
import { neuralObservationRecipe } from '../../../../services/plus-engine/native-neural-fit-verifier.mjs';
import { fitNeuralObservationModel } from '../../../../services/plus-engine/neural-observation-fit.mjs';

// Real native feedback/FIT/evaluation/approval/selection. SYNTHETIC Machine data,
// not canonical Task, private HTTP, learned transitions or business efficacy.
for(const neural of [false,true])test(`two new-feedback ${neural?'U3':'U2'} rounds publish a qualified update, reject real reference regression and restore clean model plus current belief`,async t=>{
 const started=Date.now(),progress=stage=>process.stdout.write(JSON.stringify({schema:'plus-two-round-native-progress-v1',updateKind:neural?'U3':'U2',stage,elapsedMs:Date.now()-started})+'\n');
 const f=await modelEvaluationFixture(t,{stateEvaluation:true,batch:neural,neural,versionedCompute:true}),firstRoundStart=neural?40:30;
 const initialScore=await f.evaluations.evaluate(f.request,trainer),initialProtocol=(await f.protocols.read(f.approved.id,owner)).record;
 const originalRecipe=(await f.recipes.requireApproved(initialProtocol.payload.recipe.hash,owner)).payload;
 const actors=[trainer,owner],purposes=new Map();let epoch=1;
 const admissionPolicy={version:'plus-model-admission-v1',id:'two-round-native',definitionHash:originalRecipe.compiled.definitionHash,bindingHash:originalRecipe.config.bindingHash,
  scopeKey:originalRecipe.compiled.definition.scope.key,classification:'SYNTHETIC',task:'STATE_ESTIMATION',clockHash:digest(initialProtocol.payload.configuration.clock)};
 const upstreamAuthority=f.evaluationConfig.authorizationRevision;
 const authority=async p=>digest({upstream:await upstreamAuthority(p),admissionPolicy,actors,purposes:[...purposes],epoch});
 f.evaluationConfig.authorizationRevision=authority;f.evaluationConfig.readConsistency='SHARED_NATIVE_AND_AUTHORITY';
 const decisions=new NativeModelDecision({storage:f.storage,tenantId:ctx.tenantId,evaluations:f.evaluations,recipes:f.recipes,readConsistency:'SHARED_NATIVE_AND_AUTHORITY',
  authorize:async p=>actors.some(a=>a.id===p.id),policyFor:async()=>structuredClone(admissionPolicy),authorizationRevision:authority,clock:f.evaluationConfig.clock});
 const approve=(score,reason)=>decisions.decide({key:'two-round.admission',evaluationId:score.id,evaluationVersion:score.version,decision:'APPROVE',reason},owner);
 const firstDecision=await approve(initialScore,'Independent synthetic M0 admission');
 const {version:_v,id:_id,...target}=admissionPolicy;
 const deploymentConfig={storage:f.storage,tenantId:ctx.tenantId,decisions,readConsistency:'SHARED_NATIVE_AND_AUTHORITY',authorize:async p=>actors.some(a=>a.id===p.id),
  targetFor:async()=>structuredClone(target),authorizationRevision:authority,clock:f.evaluationConfig.clock};
 const deployments=new NativeModelDeployment(deploymentConfig);
 const first=await deployments.activate({key:'two-round.selection',expectedVersion:0,decisionId:firstDecision.id,requestKey:'M0',reason:'Qualified initial reference'},owner);
 progress('INITIAL_MODEL_QUALIFIED');
 const beliefRecovery=await prepareModelBeliefRecovery(f,{deployments,selection:first,recipe:originalRecipe,clock:initialProtocol.payload.configuration.clock,authority,
  onlineStart:firstRoundStart-10,recoveryAt:firstRoundStart+40});
 progress('INITIAL_BELIEF_PERSISTED_NEW_OBSERVATION_INVALIDATES_CURRENT');
 const referenceReader=new NativePublishedModelReference({storage:f.storage,tenantId:ctx.tenantId,deployments,recipes:f.recipes,compute:f.compute,authorizationRevision:authority});
 f.protocolConfig.publishedReferences=referenceReader;f.evaluationConfig.publishedReferences=referenceReader;
 const originalPurpose=f.protocolConfig.policyFor,initialComputePolicy=structuredClone(f.privateComputePolicy.jobs[0].policy);
 f.protocolConfig.policyFor=async(p,key)=>purposes.has(key)?structuredClone(purposes.get(key)):originalPurpose(p,key);
 const trainingIds=neural?[...f.ids]:[f.training.id],trainingProtocolHashes=[...originalRecipe.config.trainingProtocolHashes],rounds=[];
 let selected=first,previousArtifact=f.candidate;
 for(const round of [1,2]){
  const start=firstRoundStart+(round-1)*20,actor=trainer;epoch++;
  // Frozen software fixture: F1 is a corroborating report; F2 is an independently
  // verified misleading report. F2 genuinely worsens READY holdout loss under
  // the SAME smoothing/algorithm. Do not alter gates to admit the candidate.
  const states=['READY','BUSY','OFFLINE'],records=neural?states.map((state,i)=>({state,report:round===1?state:states[(i+1)%states.length]})):[{report:round===1?'READY':'BUSY',state:'READY'}];
  const train=await freshLearningCohort(f,{key:'new-training-'+round,partition:'TRAIN',start,records,actor});
  const training=await train.freezeWithFeedback();trainingIds.push(training.id);trainingProtocolHashes.push(digest(train.protocol));
  progress('ROUND_'+round+'_NEW_FEEDBACK_FROZEN');
  const supervision={...originalRecipe.config,trainingProtocolHashes:[...trainingProtocolHashes]};
  const config=neural?{schema:'plus-neural-observation-config-v1',supervision,network:structuredClone(originalRecipe.network)}:supervision;
  const {recipe,recipeHash}=(neural?neuralObservationRecipe:observationRecipe)(originalRecipe.compiled,originalRecipe.baseline,config);
  const draft=await f.recipes.propose({key:'new-feedback-recipe-'+round,revision:1,definitionKey:f.definition.key,payload:recipe},actor);
  await f.recipes.review(draft.id,draft.version,'APPROVE','Unchanged algorithm; newly eligible training cohort',owner);
  const computePolicy={...initialComputePolicy,recipeHash},authorization={key:'native.feedback.fit',version:round+1};
  for(const datasetId of trainingIds)f.privateComputePolicy.jobs.push({datasetId,submitterId:trainer.id,requiredRoles:['trainer'],authorization:{...authorization},policy:{...computePolicy}});
  for(const grant of f.privateComputePolicy.grants)for(const id of trainingIds)if(!grant.datasetIds.includes(id))grant.datasetIds.push(id);epoch++;
  await assert.rejects(()=>f.compute.enqueue([...trainingIds],'FIT',actor,'ambiguous-round-'+round),/COMPUTE_AUTHORIZATION_REQUIRED/);
  const job=await f.compute.enqueue([...trainingIds],'FIT',actor,'round-'+round+'-fit',authorization),worker=f.computeWorker;
  const queued=await f.storage.getObject(ctx,'PlusExecution',job.id);assert.equal(queued.principalId,trainer.id);assert.equal(queued.inputReadSet.policy.authorization.version,round+1);
  const lease=await f.compute.claim(job.id,worker),artifact=(neural?fitNeuralObservationModel:fitObservationModel)(recipe.compiled,recipe.baseline,lease.inputBatch.materials,config);
  assert.notEqual(digest(artifact.spec),digest(previousArtifact.spec));assert.equal(lease.inputBatch.materials.length,round+(neural?2:1));
  assert.equal(artifact.neuralTrained,neural);
  const samples=lease.inputBatch.materials.flatMap(m=>m.sourceManifest.samples);
  assert.equal(samples.length,neural?6+3*round:round+1);assert.equal(new Set(samples.map(s=>s.entityKey)).size,samples.length);
  await f.compute.completeFit(job.id,lease.version,lease.leaseToken,artifact,worker);
  progress('ROUND_'+round+'_ACTUAL_CUMULATIVE_FIT_COMPLETE');
  const validation=await freshLearningCohort(f,{key:'new-validation-'+round,partition:'VALIDATION',start:start+10,records:[{report:'READY',state:'READY'}],actor});
  const purposeKey='new-feedback-score-'+round;
  purposes.set(purposeKey,{...f.evaluationPurpose,recipeHashes:[recipeHash],reference:{mode:'CURRENT_PUBLICATION',controlKey:'two-round.selection'}});epoch++;
  const pd=await f.protocols.propose({key:purposeKey,revision:1,recipeHash,cohortIds:[validation.cohort.id],evaluatorId:initialProtocol.evaluatorId,configuration:initialProtocol.payload.configuration},actor);
  const protocol=await f.protocols.review(pd.id,pd.version,'APPROVE','Before fresh validation GOLD; freeze current publication',owner);
  progress('ROUND_'+round+'_PROSPECTIVE_COMPARISON_APPROVED');
  const frozen=(await f.protocols.requireApproved(protocol.id,actor)).record.payload.reference;assert.equal(frozen.selection.id,selected.revisionId);
  const heldout=await validation.freezeWithFeedback();
  const score=await f.evaluations.evaluate({protocolId:protocol.id,executionId:job.id,validationDatasetIds:[heldout.id]},actor);
  const record=(await f.evaluations.read(score.id,owner)).record;
  const comparison=neural?record.result.metrics.comparisons.currentPublication:record.result.metrics.publishedComparison;
  progress('ROUND_'+round+'_FROZEN_REFERENCE_SCORE_COMPLETE');
  let decision;
  if(round===1){
   assert.equal(score.decision,'ELIGIBLE_FOR_REVIEW');assert.ok(comparison.groupMacroNllDelta<0);
   decision=await approve(score,'Independent admission for actual new-feedback round '+round);
   selected=await deployments.activate({key:'two-round.selection',expectedVersion:selected.version,decisionId:decision.id,requestKey:'M'+round,reason:'Actual qualified '+(neural?'neural':'statistical')+' update'},owner);
  }else{
   assert.equal(score.decision,'REJECT_REGRESSION');assert.ok(comparison.groupMacroNllDelta>0);
   decision=await decisions.decide({key:'two-round.admission',evaluationId:score.id,evaluationVersion:score.version,decision:'REJECT',reason:'Actual deterioration against frozen publication'},owner);
   const pointer=await f.storage.getObject(ctx,'PlusDeployment',first.deploymentId),before=await f.storage.getReadRevision(ctx);
   await assert.rejects(()=>deployments.activate({key:'two-round.selection',expectedVersion:selected.version,decisionId:decision.id,requestKey:'rejected-M2',reason:'Must not deploy a rejected candidate'},owner),/NOT_APPROVED/);
   assert.deepEqual(await f.storage.getObject(ctx,'PlusDeployment',first.deploymentId),pointer);assert.equal(await f.storage.getReadRevision(ctx),before);
  }
  rounds.push({training,train,validation,score,decision,selected});previousArtifact=artifact;
  progress(round===1?'ROUND_1_INDEPENDENTLY_APPROVED_AND_SELECTED':'ROUND_2_REAL_REGRESSION_REJECTED_CURRENT_SELECTION_UNCHANGED');
 }
 assert.equal(selected.generation,2);assert.notEqual(rounds[0].train.roots[0]._id,rounds[1].train.roots[0]._id);
 assert.notEqual(rounds[0].train.feedbackIds[0],rounds[1].train.feedbackIds[0]);
 // Withdraw active M1's admission, not the clean M0 data. M2 was never admitted.
 // Recovery must requalify M0
 // rather than trusting its historical approval or undoing business facts.
 await decisions.revoke(rounds[0].decision.id,rounds[0].decision.version,'Synthetic current-version withdrawal drill',owner);
 await assert.rejects(()=>deployments.read('two-round.selection',owner),/SUSPENDED|STALE/);
 const suspended=await f.storage.getObject(ctx,'PlusDeployment',first.deploymentId),reopened=new NativeModelDeployment({...deploymentConfig,storage:f.openStorage()});
 const back=await reopened.rollback({key:'two-round.selection',expectedVersion:suspended._version,revisionId:first.revisionId,requestKey:'clean-M0',reason:'Requalify clean historical admission'},owner);
 assert.equal(back.generation,3);assert.equal(back.predictionReady,false);assert.equal(back.replayRequired,true);
 assert.equal((await reopened.read('two-round.selection',owner)).selection.decision.id,firstDecision.id);
 await assert.rejects(()=>reopened.rollback({key:'two-round.selection',expectedVersion:back.version,revisionId:selected.revisionId,requestKey:'dirty-M1',reason:'Must refuse withdrawn candidate'},owner),/STALE/);
 for(const round of rounds)for(const root of [...round.train.roots,...round.validation.roots])assert.equal((await f.storage.getObject(ctx,'Machine',root._id)).actual,'UNKNOWN');
 assert.equal((await f.rows('PlusDeployment')).totalCount,1);
 progress('CLEAN_MODEL_ROLLBACK_QUALIFIED_DIRTY_MODEL_REFUSED');
 await beliefRecovery.recover(back);
 progress('NEW_CONSENT_AND_VALID_EVENT_REPLAY_RESTORED_CURRENT_BELIEF');
 // Canonical private Task-host and independent business-effect gates remain.
});
