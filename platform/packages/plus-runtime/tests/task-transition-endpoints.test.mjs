import test from 'node:test';
import assert from 'node:assert/strict';
import { compileTransitionSupervision,digest } from '@openfoundry/plus-contracts';
import { createTaskLearningServices } from '../../../apps/lwm-demo/src/task-learning.mjs';
import { taskLearningFixture,ctx,trainer,reviewer,owner,at } from './task-learning-fixture.mjs';
import { transitionEstimatorId,transitionRecipe,fitTransitionModel,verifyTransitionFit } from '../../../../services/plus-engine/transition-fit.mjs';
import { NativeActionIntervalReader,NativeComputeAdmission } from '../dist/index.js';
import { createPrivateAuthorizationRevision } from '../../../../ops/plus-v2/private-authority.mjs';
import { createPrivateNativeFitVerifiers,privateFitRequest } from '../../../../services/plus-engine/private-fit-registry.mjs';
import { fitInProcess } from '../../../../services/plus-engine/fit-worker.mjs';
import { exerciseTaskTransitionHost } from './task-transition-host-acceptance.mjs';

// SYNTHETIC canonical Task records created through the existing source fixture;
// actual Task purpose/field/identity policies and native longitudinal governance.
// Empty actual native action inventory uses an explicit synthetic inventory grant;
// not private HTTP ingestion, executed-action training or model admission.
test('Task factory binds approved full transition plans to native endpoints, reconstructs services and enforces current field and purpose withdrawal',async t=>{
  const f=await taskLearningFixture(t,{timedPriority:true,initializePriority:true}),s=f.services;
  const secondReport=await f.source(f.initial.task,{result:'DONE',received:2,eventMinute:2,record:'longitudinal-second-report'});
  const secondInput=await f.capture(f.episode,'second-input',2);f.protocol.expectedSampleCount=2;
  await s.partitions.reserve(f.input.record._id,trainer);await s.partitions.reserve(secondInput.record._id,trainer);
  const draft=await s.datasets.proposeCohort(f.protocol.key,[f.input.record._id,secondInput.record._id],trainer);
  const cohort=await s.datasets.reviewCohort(draft.id,draft.version,'APPROVE','Prospective two-time native Task membership',reviewer);
  const old=f.recipe().recipe.config,populationPolicyHash=digest('synthetic-task-full-prospective-trajectories');
  const timeContract={schema:'plus-transition-time-v1',definitionHash:f.compiled.definitionHash,bindingHash:f.input.compiledInput.bindingHash,stepMs:60000,maxSteps:100,
    origin:'EPISODE_STARTED_AT',alignment:'EXACT_GRID',contextKnowledge:'INTERVAL_START',endpointKnowledge:'PRELABEL_SNAPSHOT',actionWindow:'HALF_OPEN',actionTimestamp:'NATIVE_EXECUTION_RECEIPT'};
  const actionHistoryContract={version:'plus-native-action-interval-policy-v1',id:'task-approved-governed-inventory',rootType:'InvestigationTask',rootEpisodeLink:'TaskPlusEpisode',
    nativeActions:['NativeRegisterInvestigationTask'],inventory:'TENANT_WIDE',orphanPolicy:'REJECT_INTERVAL'};
  const supervision=compileTransitionSupervision({schema:'plus-transition-supervision-v1',key:'task.transition',revision:1,parentDefinitionHash:f.compiled.definitionHash,
    bindingHash:f.input.compiledInput.bindingHash,timeContractHash:digest(timeContract),transitionModule:f.compiled.definition.modules.find(m=>m.kind==='TRANSITION').key,
    classification:'SYNTHETIC',collectionPolicyHash:old.collectionPolicyHash,populationPolicyHash,stepMs:60000,
    contextSupport:{priority:f.compiled.variables.find(v=>v.key==='priority').support},controls:['WAIT'],sampling:'ALL_ADJACENT_PRE_ENROLLED_PAIRS',
    actionSemantics:'OBSERVED_NATIVE_HISTORY_NOT_CAUSAL',budget:{maxPairs:100,maxTrajectories:100}},f.compiled);
  const {recipe,recipeHash}=transitionRecipe(f.compiled,supervision,{classification:'SYNTHETIC',collectionPolicyHash:old.collectionPolicyHash,populationPolicyHash,
    trainingProtocolHashes:[digest(f.protocol)],smoothingAlpha:1,minimumPairs:1,minimumTrajectories:1,minimumGroups:1,minimumPerCondition:1,minimumCoverage:1},timeContract,actionHistoryContract);
  const entry=structuredClone(f.policy.taskLearning.recipes[0]);entry.key='task.transition';entry.policy.id='task-transition-fit-purpose';
  entry.policy.engineIds=[transitionEstimatorId];entry.policy.populationPolicyHashes=[populationPolicyHash];f.policy.taskLearning.recipes.push(entry);
  for(const grant of f.policy.taskLearning.grants)grant.recipeKeys.push(entry.key);
  const recipeDraft=await s.recipes.propose({key:entry.key,revision:1,definitionKey:f.compiled.definition.key,payload:recipe},trainer);
  const recipeApproval=await s.recipes.review(recipeDraft.id,recipeDraft.version,'APPROVE','Freeze complete Task protocol set before labels',owner);
  for(const [minute,observation,input,received,result]of [[1,f.report.object,f.input,4,'NOT_DONE'],[2,secondReport.object,secondInput,6,'DONE']]){
    f.advance(received);const check=await f.source(f.initial.task,{observation,received,result});
    const label=await f.capture(f.episode,'gold-'+minute,minute);await s.partitions.reserve(label.record._id,trainer);f.advance(received+0.1);
    const proposal=await s.feedback.propose({inputSnapshotId:input.record._id,labelSnapshotId:label.record._id,eventId:check.event._id},trainer);
    await s.feedback.review(proposal.id,proposal.version,'APPROVE','Independent point-in-time Task verification',reviewer);
  }
  f.advance(9);const frozen=await s.datasets.freeze(cohort.id,trainer),epoch=await f.storage.getReadRevision(ctx);
  const material=await s.transitionEndpoints.read([frozen.id],'FIT',trainer),points=[...material.datasets[0].points].sort((a,b)=>a.targetTime.localeCompare(b.targetTime));
  assert.equal(points.length,2);assert.deepEqual(points.map(p=>p.targetTime),[at(1),at(2)]);
  assert.ok(points.every(p=>p.variable==='completion'&&p.root.type==='InvestigationTask'&&p.root.id===f.initial.task._id));
  assert.deepEqual(points.map(p=>p.labels[0].value.value),['NOT_DONE','DONE']);assert.equal(points[0].partition.groupHash,points[1].partition.groupHash);
  assert.equal(material.endpointAuthorityChecked,true);assert.equal(material.transitionTrainingAuthorized,false);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.storage.getObject(ctx,'InvestigationTask',f.initial.task._id)).actualCompletion,'UNKNOWN');
  let inventoryAllowed=true;
  const intervalOptions={storage:f.storage,tenantId:ctx.tenantId,catalog:f.catalog,requests:{read:async()=>assert.fail('Fixture has no governed requests')},
    policyFor:async()=>structuredClone(actionHistoryContract),authorize:async p=>inventoryAllowed&&p.id===trainer.id&&f.people.has(p.id),
    authorizationRevision:createPrivateAuthorizationRevision(f.options),clock:()=>Date.parse(at(9))};
  const restored=createTaskLearningServices({...f.options,storage:f.open(),actionIntervals:new NativeActionIntervalReader(intervalOptions)});
  assert.equal((await restored.transitionEndpoints.read([frozen.id],'FIT',trainer)).contentHash,material.contentHash);
  const plan=await s.transitionPlans.read(recipeHash,[frozen.id],trainer);
  assert.deepEqual(plan.coverage,{enrolledEndpoints:2,trajectories:1,plannedPairs:1,pairsWithGold:1,missingPairs:0});
  assert.equal(plan.pairs[0].root.id,f.initial.task._id);assert.equal(plan.pairs[0].root.type,'InvestigationTask');
  assert.equal(plan.pairs[0].from[0].labels[0].value.value,'NOT_DONE');assert.equal(plan.pairs[0].to[0].labels[0].value.value,'DONE');
  assert.equal(plan.nativeMembershipChecked,true);assert.equal(plan.transitionTrainingAuthorized,false);assert.equal(plan.predictionReady,false);
  assert.equal((await restored.transitionPlans.read(recipeHash,[frozen.id],trainer)).contentHash,plan.contentHash);
  const contexts=await s.transitionPlans.readWithContext(recipeHash,[frozen.id],trainer);
  assert.equal(contexts.historicalContextChecked,true);assert.equal(contexts.pairs[0].context.priority.value,'LOW');
  assert.equal(contexts.histories[0].material.temporalInput.visibleAt,at(1));assert.equal(contexts.transitionTrainingAuthorized,false);
  assert.equal(contexts.nativeTimeContractChecked,true);assert.deepEqual(contexts.plan.timeContract,timeContract);
  assert.deepEqual(contexts.pendingQualifications,['COMPLETE_ACTION_INTERVAL']);
  assert.equal((await restored.transitionPlans.readWithContext(recipeHash,[frozen.id],trainer)).contentHash,contexts.contentHash);
  const complete=await restored.transitionPlans.readWithActions(recipeHash,[frozen.id],trainer);
  assert.equal(complete.recipeHistoryBindingChecked,true);assert.equal(complete.nativeReadQualificationsChecked,true);
  assert.equal(complete.intervals[0].material.root.id,f.initial.task._id);assert.equal(complete.intervals[0].material.episodeId,f.episode._id);
  assert.deepEqual(complete.intervals[0].material.executions,[]);assert.deepEqual(complete.contextPlan.plan.actionHistoryContract,actionHistoryContract);
  assert.equal(complete.transitionTrainingAuthorized,false);assert.equal(complete.predictionReady,false);
  const reopened=createTaskLearningServices({...f.options,storage:f.open(),actionIntervals:new NativeActionIntervalReader({...intervalOptions,storage:f.open()})});
  assert.equal((await reopened.transitionPlans.readWithActions(recipeHash,[frozen.id],trainer)).contentHash,complete.contentHash);
  const fitMaterial=await restored.transitionPlans.materializeForFit(recipeHash,[frozen.id],trainer),fit=fitTransitionModel(recipe,[fitMaterial]);
  assert.equal(fit.schema,'plus-transition-fit-result-v2');assert.equal(fit.table.reduce((n,r)=>n+r.observations,0),1);
  assert.equal(fit.consumption.provenance.cohortIds.length,1);assert.equal(fit.consumption.provenance.sourcePlanHash,complete.contentHash);
  const learned=fit.table.find(r=>r.observations===1);assert.equal(learned.condition.from.completion,'NOT_DONE');assert.equal(learned.condition.context.priority,'LOW');
  assert.equal(fit.trainingAuthorized,false);assert.equal(fit.predictionReady,false);assert.deepEqual(verifyTransitionFit(recipe,[fitMaterial],fit),fit);
  assert.equal((await reopened.transitionPlans.materializeForFit(recipeHash,[frozen.id],trainer)).contentHash,fitMaterial.contentHash);
  const revalidated=await reopened.transitionPlans.revalidateForFit(fitMaterial,recipeHash,[frozen.id],trainer);
  assert.equal(revalidated.materialHash,fitMaterial.contentHash);assert.equal(revalidated.nativeQualificationChecked,true);
  assert.equal(revalidated.trainingAuthorized,false);assert.equal(revalidated.predictionReady,false);
  inventoryAllowed=false;await assert.rejects(()=>restored.transitionPlans.readWithActions(recipeHash,[frozen.id],trainer),/ACTION_INTERVAL_FORBIDDEN/);inventoryAllowed=true;
  await assert.rejects(()=>s.transitionPlans.readWithActions(recipeHash,[frozen.id],trainer),/TRANSITION_PLAN_ACTION_READER_REQUIRED/);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);
  const grant=f.policy.taskDomain.episodeGrants.find(g=>g.principalId===trainer.id),fields=grant.types.TaskCompletionVerification.read;
  grant.permissions=grant.permissions.filter(v=>v!=='episode:history');
  await assert.rejects(()=>restored.transitionPlans.readWithContext(recipeHash,[frozen.id],trainer),/FORBIDDEN/);grant.permissions.push('episode:history');
  grant.types.TaskCompletionVerification.read=fields.filter(v=>v!=='result');
  await assert.rejects(()=>restored.transitionEndpoints.read([frozen.id],'FIT',trainer),/FORBIDDEN/);
  await assert.rejects(()=>restored.transitionPlans.read(recipeHash,[frozen.id],trainer),/FORBIDDEN/);grant.types.TaskCompletionVerification.read=fields;
  const learning=f.policy.taskLearning.grants.find(g=>g.principalId===trainer.id),permissions=learning.permissions;
  learning.permissions=permissions.filter(v=>v!=='dataset:FIT');await assert.rejects(()=>restored.transitionEndpoints.read([frozen.id],'FIT',trainer),/FORBIDDEN/);
  await assert.rejects(()=>restored.transitionPlans.read(recipeHash,[frozen.id],trainer),/FORBIDDEN/);learning.permissions=permissions;
  const worker={...trainer,id:'task-transition-worker',roles:['plus_compute_worker']};f.people.set(worker.id,worker);
  const computeConfig={storage:f.storage,tenantId:ctx.tenantId,datasets:restored.datasets,recipes:restored.recipes,transitionPlans:restored.transitionPlans,
    ...createPrivateNativeFitVerifiers({recipes:restored.recipes}),clock:()=>Date.parse(at(9)),
    authorize:async p=>f.people.has(p.id)&&(p.id===trainer.id||p.id===worker.id),
    policyFor:async()=>({version:'plus-compute-policy-v1',workerId:worker.id,engineId:transitionEstimatorId,recipeHash,leaseMs:300000,maxAttempts:2}),
    resolvePrincipal:async id=>{const p=f.people.get(id);if(!p)throw Object.assign(new Error('COMPUTE_FORBIDDEN'),{code:'COMPUTE_FORBIDDEN'});return structuredClone(p);}};
  const compute=new NativeComputeAdmission(computeConfig),job=await compute.enqueue(frozen.id,'FIT',trainer,'task-transition-fit'),dispatch=await compute.claim(job.id,worker);
  const candidate=await fitInProcess(privateFitRequest(dispatch.recipe,[dispatch.transitionInput.material]));
  const completed=await compute.completeFit(job.id,dispatch.version,dispatch.leaseToken,candidate,worker);
  assert.equal(completed.status,'SUCCEEDED');assert.equal(completed.deploymentAuthorized,false);
  assert.equal(candidate.table.reduce((n,r)=>n+r.observations,0),1);assert.equal(candidate.neuralTrained,false);
  const computeReopen=new NativeComputeAdmission({...computeConfig,storage:f.open()});
  assert.deepEqual((await computeReopen.readFitResult(job.id,trainer)).payload,candidate);
  assert.equal((await f.storage.getObject(ctx,'InvestigationTask',f.initial.task._id)).actualCompletion,'UNKNOWN');
  assert.equal((await f.storage.getObject(ctx,'PlusModelRelease',completed.candidateId)).status,'CANDIDATE');
  await exerciseTaskTransitionHost(t,f,{frozen,recipe,recipeHash,actionHistoryContract});
  await restored.recipes.revoke(recipeDraft.id,recipeApproval.version,'Withdraw transition supervision',owner);
  await assert.rejects(()=>computeReopen.readFitResult(job.id,trainer),/RECIPE_NOT_APPROVED|STALE/);
  await assert.rejects(()=>restored.transitionPlans.revalidateForFit(fitMaterial,recipeHash,[frozen.id],trainer),/RECIPE_NOT_APPROVED/);
  await assert.rejects(()=>restored.transitionPlans.materializeForFit(recipeHash,[frozen.id],trainer),/RECIPE_NOT_APPROVED/);
  await assert.rejects(()=>restored.transitionPlans.readWithActions(recipeHash,[frozen.id],trainer),/RECIPE_NOT_APPROVED/);
  await assert.rejects(()=>restored.transitionPlans.read(recipeHash,[frozen.id],trainer),/RECIPE_NOT_APPROVED/);
  f.people.delete(trainer.id);
  await assert.rejects(()=>restored.transitionEndpoints.read([frozen.id],'FIT',trainer),/FORBIDDEN/);
});
