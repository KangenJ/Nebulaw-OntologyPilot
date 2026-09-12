import test from 'node:test';
import assert from 'node:assert/strict';
import { compileTransitionSupervision,digest } from '@openfoundry/plus-contracts';
import { NativeEvaluationProtocolRegistry,transitionEvaluatorId } from '../dist/index.js';
import { createTaskLearningServices } from '../../../apps/lwm-demo/src/task-learning.mjs';
import { createPrivateActionIntervalServices } from '../../../../ops/plus-v2/action-interval-services.mjs';
import { transitionRecipe,transitionEstimatorId } from '../../../../services/plus-engine/transition-fit.mjs';
import { taskLearningFixture,ctx,trainer,reviewer,owner,at } from './task-learning-fixture.mjs';

// Actual Task ontology, identity/field/purpose policies and native prospective
// validation material. SYNTHETIC source transactions and clock; empty governed
// action inventory. Not private HTTP scoring, current publication or deployment.
test('Task factory materializes independently approved VALIDATE trajectories with explicit private inventory purpose and no FIT fallback',async t=>{
  const f=await taskLearningFixture(t,{timedPriority:true,initializePriority:true}),s=f.services;
  let heldout;
  for(let i=0;i<100;i++){
    const candidate=await f.root(),bucket=parseInt(digest([f.policy.taskLearning.partition.seed,ctx.tenantId,
      ['task-matter-v1',digest(['synthetic',candidate.matter._id])]]).slice(0,8),16)%10000;
    if(bucket>=6000&&bucket<7500){heldout=candidate;break;}
  }
  assert.ok(heldout);assert.notEqual(heldout.matter._id,f.initial.matter._id);
  const protocol={...f.protocol,key:'task-longitudinal-heldout',partition:'VALIDATION',expectedSampleCount:2,
    inputVisibleFrom:at(20),inputVisibleUntil:at(22),labelReceivedFrom:at(23),labelReceivedUntil:at(27),approvalUntil:at(29)};
  f.policy.taskLearning.cohorts.push({workspace:'synthetic',protocol});
  for(const g of f.policy.taskLearning.grants)g.protocolKeys.push(protocol.key);
  f.advance(20);const episode=await f.episodes.open({definitionKey:f.compiled.definition.key,rootId:heldout.task._id,startedAt:at(0)},trainer,'heldout-trajectory');
  const inputs=[],reports=[];
  for(const minute of [20,21]){f.advance(minute);reports.push(await f.source(heldout.task,{received:minute,eventMinute:minute,record:'heldout-only-'+minute}));
    const input=await f.capture(episode,'heldout-input-'+minute,minute);inputs.push(input);
    assert.equal((await s.partitions.reserve(input.record._id,trainer)).partition,'VALIDATION');}
  f.advance(22);const draft=await s.datasets.proposeCohort(protocol.key,inputs.map(i=>i.record._id),trainer);
  const cohort=await s.datasets.reviewCohort(draft.id,draft.version,'APPROVE','Full heldout trajectory before labels',reviewer);
  const populationPolicyHash=digest('synthetic-task-validation-population'),timeContract={schema:'plus-transition-time-v1',definitionHash:f.compiled.definitionHash,
    bindingHash:f.input.compiledInput.bindingHash,stepMs:60000,maxSteps:100,origin:'EPISODE_STARTED_AT',alignment:'EXACT_GRID',
    contextKnowledge:'INTERVAL_START',endpointKnowledge:'PRELABEL_SNAPSHOT',actionWindow:'HALF_OPEN',actionTimestamp:'NATIVE_EXECUTION_RECEIPT'};
  const actionHistoryContract={version:'plus-native-action-interval-policy-v1',id:'task-validation-inventory',rootType:'InvestigationTask',rootEpisodeLink:'TaskPlusEpisode',
    nativeActions:['NativeRegisterInvestigationTask'],inventory:'TENANT_WIDE',orphanPolicy:'REJECT_INTERVAL'};
  const supervision=compileTransitionSupervision({schema:'plus-transition-supervision-v1',key:'task.transition',revision:1,parentDefinitionHash:f.compiled.definitionHash,
    bindingHash:timeContract.bindingHash,timeContractHash:digest(timeContract),transitionModule:f.compiled.definition.modules.find(m=>m.kind==='TRANSITION').key,
    classification:'SYNTHETIC',collectionPolicyHash:protocol.collectionPolicyHash,populationPolicyHash,stepMs:60000,
    contextSupport:{priority:f.compiled.variables.find(v=>v.key==='priority').support},controls:['WAIT'],sampling:'ALL_ADJACENT_PRE_ENROLLED_PAIRS',
    actionSemantics:'OBSERVED_NATIVE_HISTORY_NOT_CAUSAL',budget:{maxPairs:100,maxTrajectories:100}},f.compiled);
  const {recipe,recipeHash}=transitionRecipe(f.compiled,supervision,{classification:'SYNTHETIC',collectionPolicyHash:protocol.collectionPolicyHash,populationPolicyHash,
    trainingProtocolHashes:[digest(f.protocol)],smoothingAlpha:1,minimumPairs:1,minimumTrajectories:1,minimumGroups:1,minimumPerCondition:1,minimumCoverage:1},timeContract,actionHistoryContract);
  const entry=structuredClone(f.policy.taskLearning.recipes[0]);entry.key='task.transition';entry.policy.engineIds=[transitionEstimatorId];entry.policy.populationPolicyHashes=[populationPolicyHash];
  f.policy.taskLearning.recipes.push(entry);for(const g of f.policy.taskLearning.grants)g.recipeKeys.push(entry.key);
  const rd=await s.recipes.propose({key:entry.key,revision:1,definitionKey:f.compiled.definition.key,payload:recipe},trainer);
  await s.recipes.review(rd.id,rd.version,'APPROVE','Explicit time and complete action history contract',owner);
  const protocols=new NativeEvaluationProtocolRegistry({storage:f.storage,tenantId:ctx.tenantId,recipes:s.recipes,datasets:s.datasets,clock:f.options.clock,
    authorize:async p=>f.people.has(p.id),policyFor:async()=>({version:'plus-evaluation-purpose-v1',id:'task-heldout-validation',evaluatorIds:[transitionEvaluatorId],recipeHashes:[recipeHash],classifications:['SYNTHETIC']}),
    validateConfiguration:async()=>{}});
  const evaluation=await protocols.propose({key:'task.transition.heldout',revision:1,recipeHash,cohortIds:[cohort.id],evaluatorId:transitionEvaluatorId,
    configuration:{schema:'plus-conditional-transition-evaluation-v2',task:'CONDITIONAL_TRANSITION',reference:{schema:'plus-transition-reference-v1',kind:'SAME_CONDITION_FACTORIZED_COUNTS'},
      minimumPairs:1,minimumGroups:1,minimumCoverage:1,maximumNllRegression:0,maximumBrierRegression:0}},trainer);
  await protocols.review(evaluation.id,evaluation.version,'APPROVE','Prospective full trajectory and fixed comparison',owner);
  for(const [i,result]of ['NOT_DONE','DONE'].entries()){f.advance(24+i);const gold=await f.source(heldout.task,{observation:reports[i].object,result,received:24+i});
    const label=await f.capture(episode,'heldout-label-'+i,20+i);await s.partitions.reserve(label.record._id,trainer);f.advance(24.1+i);
    const feedback=await s.feedback.propose({inputSnapshotId:inputs[i].record._id,labelSnapshotId:label.record._id,eventId:gold.event._id},trainer);
    await s.feedback.review(feedback.id,feedback.version,'APPROVE','Independent target-time verification',reviewer);}
  f.advance(29);const frozen=await s.datasets.freeze(cohort.id,trainer);assert.equal(frozen.readiness,'READY');
  f.policy.actionIntervals={version:'plus-private-action-intervals-v1',enabled:true,targets:[{episodeId:episode._id,rootId:heldout.task._id,purpose:'TRANSITION_VALIDATE',policy:actionHistoryContract}],
    grants:[{principalId:trainer.id,requiredRoles:trainer.roles,episodeIds:[episode._id],permissions:['action-interval:inventory']}]};
  const inventoryOptions={...f.options,requests:{read:async()=>assert.fail('No governed action requests exist in this source fixture')}};
  const validation=createPrivateActionIntervalServices({...inventoryOptions,usagePurpose:'TRANSITION_VALIDATE'}),fit=createPrivateActionIntervalServices(inventoryOptions);
  const options={...f.options,actionIntervals:fit.actionIntervals,validationActionIntervals:validation.actionIntervals,evaluationProtocols:protocols};
  const learning=createTaskLearningServices(options),before=await f.storage.getReadRevision(ctx);
  const material=await learning.transitionPlans.materializeForValidation(evaluation.id,[frozen.id],trainer),plan=material.sourcePlan.contextPlan.plan;
  assert.equal(material.purpose,'VALIDATE');assert.equal(material.predictionReady,false);assert.equal(material.trainingAuthorized,false);
  assert.equal(plan.pairs.length,1);assert.equal(plan.pairs[0].root.id,heldout.task._id);assert.equal(plan.pairs[0].root.type,'InvestigationTask');
  assert.equal(plan.validation.protocol.id,evaluation.id);assert.deepEqual(material.sourcePlan.intervals[0].material.executions,[]);
  assert.equal(plan.pairs[0].from[0].labels[0].value.value,'NOT_DONE');assert.equal(plan.pairs[0].to[0].labels[0].value.value,'DONE');
  assert.equal(await f.storage.getReadRevision(ctx),before);
  const reopened=createTaskLearningServices({...options,storage:f.open()});
  assert.equal((await reopened.transitionPlans.revalidateForValidation(material,evaluation.id,[frozen.id],trainer)).nativeQualificationChecked,true);
  await assert.rejects(()=>createTaskLearningServices({...options,validationActionIntervals:undefined}).transitionPlans.materializeForValidation(evaluation.id,[frozen.id],trainer),/TRANSITION_VALIDATION_ACTION_READER_REQUIRED/);
  await assert.rejects(()=>createTaskLearningServices({...options,validationActionIntervals:fit.actionIntervals}).transitionPlans.materializeForValidation(evaluation.id,[frozen.id],trainer),/ACTION_INTERVAL_FORBIDDEN/);
  await assert.rejects(()=>learning.transitionPlans.materializeForFit(recipeHash,[frozen.id],trainer),/PARTITION|TRAIN/);
  const grant=f.policy.taskLearning.grants.find(g=>g.principalId===trainer.id),permissions=grant.permissions;
  grant.permissions=permissions.filter(p=>p!=='dataset:VALIDATE');
  await assert.rejects(()=>learning.transitionPlans.materializeForValidation(evaluation.id,[frozen.id],trainer),/FORBIDDEN/);grant.permissions=permissions;
  const fields=f.policy.taskDomain.episodeGrants.find(g=>g.principalId===trainer.id).types.TaskCompletionVerification.read;
  f.policy.taskDomain.episodeGrants.find(g=>g.principalId===trainer.id).types.TaskCompletionVerification.read=fields.filter(v=>v!=='result');
  await assert.rejects(()=>reopened.transitionPlans.revalidateForValidation(material,evaluation.id,[frozen.id],trainer),/FORBIDDEN/);
  f.policy.taskDomain.episodeGrants.find(g=>g.principalId===trainer.id).types.TaskCompletionVerification.read=fields;
  await protocols.revoke(evaluation.id,(await protocols.requireApproved(evaluation.id,owner)).record._version,'Withdraw validation use',owner);
  await assert.rejects(()=>learning.transitionPlans.materializeForValidation(evaluation.id,[frozen.id],trainer),/REVOKED|NOT_APPROVED|STALE/);
  assert.equal((await f.storage.getObject(ctx,'InvestigationTask',heldout.task._id)).actualCompletion,'UNKNOWN');
  for(const type of ['PlusModelRelease','PlusModelDecision','PlusDeployment'])assert.equal((await f.storage.queryObjects(ctx,type,{and:[]})).totalCount,0);
});
