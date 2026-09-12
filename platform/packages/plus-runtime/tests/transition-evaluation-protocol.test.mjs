import test from 'node:test';
import assert from 'node:assert/strict';
import { compileTransitionSupervision,digest } from '@openfoundry/plus-contracts';
import { NativeDatasetRegistry,NativeRecipeRegistry,NativeEvaluationProtocolRegistry,NativeTransitionEndpointReader,NativeTransitionPlanReader,NativeActionIntervalReader,transitionEvaluatorId,validateTransitionEvaluationMembership } from '../dist/index.js';
import { datasetFixture,trainer,reviewer,owner } from './dataset-fixture.mjs';
import { principal,ctx,at } from './episode-fixture.mjs';
import { transitionRecipe,validateTransitionRecipe,transitionEstimatorId,fitTransitionModel } from '../../../../services/plus-engine/transition-fit.mjs';

// Real native definitions, snapshots, partitions, cohort/recipe/protocol approval
// and persistence. Source/clock and embedding permission adapters are SYNTHETIC.
// This is pre-label registration, NOT a scored model or a private host deployment.
test('v2 reference is prospectively fixed and cannot be injected into v1 or replaced by arbitrary comparison logic',async t=>{
  const f=await setup(t),reference={schema:'plus-transition-reference-v1',kind:'SAME_CONDITION_FACTORIZED_COUNTS'};
  const raw=structuredClone(f.input);raw.configuration={...raw.configuration,schema:'plus-conditional-transition-evaluation-v2',reference:structuredClone(reference)};
  for(const alter of [v=>{v.configuration.schema='plus-conditional-transition-evaluation-v1';},v=>{delete v.configuration.reference;},
    v=>{v.configuration.reference.kind='CURRENT_PUBLICATION';},v=>{v.configuration.reference.program='arbitrary.mjs';}]){
    const input=structuredClone(raw);alter(input);await assert.rejects(()=>f.registry.propose(input,trainer),/TRANSITION_EVALUATION_CONFIGURATION|TRANSITION_EVALUATION_REFERENCE/);
  }
  const draft=await f.registry.propose(raw,trainer);await f.registry.review(draft.id,draft.version,'APPROVE','Fixed same-information independence control before labels',owner);
  const approved=await f.registry.requireApproved(draft.id,trainer);assert.deepEqual(approved.record.payload.configuration.reference,reference);
  raw.configuration.reference.kind='CURRENT_PUBLICATION';
  assert.deepEqual((await f.registry.requireApproved(draft.id,trainer)).record.payload.configuration.reference,reference);
});
async function setup(t,{secondary=false,stepMs=60000,incomplete=false,minimumCoverage=1}={}){
  const f=await datasetFixture(t,{partition:'VALIDATION',secondary});let now=2;
  const stream=await f.runtime.capture(f.episodes[0]._id,principal,'transition-validation-stream');
  const second=(await f.runtime.snapshot({streamId:stream.record._id,targetTime:at(2)},principal,'transition-validation-second')).record;
  await f.partitions.reserve(second._id,trainer);
  const compiled=(await f.definitions.requirePublished(f.definition.key,trainer)).compiled;
  const protocols=(secondary&&!incomplete?['state','secondary']:['state']).map(variable=>({...f.policy,key:'transition-validation-'+variable,variable,expectedSampleCount:2,minimumSamples:1,minimumCoverage}));
  const datasetConfig={...f.datasetConfig,protocolFor:async(_p,key)=>structuredClone([...protocols,f.policy].find(q=>q.key===key))};
  const datasets=new NativeDatasetRegistry(datasetConfig),cohorts=[];
  for(const protocol of protocols){
    const draft=await datasets.proposeCohort(protocol.key,[f.inputs[0]._id,second._id],trainer);
    cohorts.push(await datasets.reviewCohort(draft.id,draft.version,'APPROVE','Entire trajectory before either label',reviewer));
  }
  const train={...protocols[0],key:'separate-prospective-training',partition:'TRAIN'};
  const timeContract={schema:'plus-transition-time-v1',definitionHash:compiled.definitionHash,bindingHash:f.inputs[0].compiledInput.bindingHash,stepMs,maxSteps:100,
    origin:'EPISODE_STARTED_AT',alignment:'EXACT_GRID',contextKnowledge:'INTERVAL_START',endpointKnowledge:'PRELABEL_SNAPSHOT',actionWindow:'HALF_OPEN',actionTimestamp:'NATIVE_EXECUTION_RECEIPT'};
  const populationPolicyHash=digest('synthetic-complete-transition-population'),supervision=compileTransitionSupervision({schema:'plus-transition-supervision-v1',key:'machine.transition.validation',revision:1,
    parentDefinitionHash:compiled.definitionHash,bindingHash:timeContract.bindingHash,timeContractHash:digest(timeContract),transitionModule:compiled.definition.modules.find(m=>m.kind==='TRANSITION').key,
    classification:'SYNTHETIC',collectionPolicyHash:train.collectionPolicyHash,populationPolicyHash,stepMs,contextSupport:{priority:[1,2]},controls:['WAIT'],
    sampling:'ALL_ADJACENT_PRE_ENROLLED_PAIRS',actionSemantics:'OBSERVED_NATIVE_HISTORY_NOT_CAUSAL',budget:{maxPairs:100,maxTrajectories:100}},compiled);
  const actionHistoryContract={version:'plus-native-action-interval-policy-v1',id:'prospective-transition-history',rootType:'Machine',rootEpisodeLink:'MachineEpisode',nativeActions:['VerifyObject'],inventory:'TENANT_WIDE',orphanPolicy:'REJECT_INTERVAL'};
  const {recipe,recipeHash}=transitionRecipe(compiled,supervision,{classification:'SYNTHETIC',collectionPolicyHash:train.collectionPolicyHash,populationPolicyHash,
    trainingProtocolHashes:[digest(train)],smoothingAlpha:1,minimumPairs:1,minimumTrajectories:1,minimumGroups:1,minimumPerCondition:1,minimumCoverage:1},timeContract,actionHistoryContract);
  const recipes=new NativeRecipeRegistry({storage:f.storage,tenantId:ctx.tenantId,definitions:f.definitions,clock:()=>Date.parse(at(now)),authorize:async()=>true,
    policyFor:async()=>({version:'plus-recipe-policy-v1',id:'synthetic-transition-purpose',engineIds:[transitionEstimatorId],classifications:['SYNTHETIC'],
      collectionPolicyHashes:[train.collectionPolicyHash],populationPolicyHashes:[populationPolicyHash],scopeKeys:[compiled.definition.scope.key]}),validateRecipe:async(p,c)=>validateTransitionRecipe(p,c)});
  const rd=await recipes.propose({key:'machine.transition',revision:1,definitionKey:compiled.definition.key,payload:recipe},trainer);
  await recipes.review(rd.id,rd.version,'APPROVE','Independent recipe; no heldout labels used',owner);
  const policy={version:'plus-evaluation-purpose-v1',id:'synthetic-transition-validation',evaluatorIds:[transitionEvaluatorId,'legacy-test-evaluator'],recipeHashes:[recipeHash],classifications:['SYNTHETIC']};
  const config={storage:f.storage,tenantId:ctx.tenantId,recipes,datasets,clock:()=>Date.parse(at(now)),authorize:async()=>true,policyFor:async()=>structuredClone(policy),
    // Deliberately permissive embedding adapter: fixed native membership validation
    // must still enforce the exact transition task/recipe/trajectory contract.
    validateConfiguration:async()=>{}};
  const input={key:'machine.transition.validation',revision:1,recipeHash,cohortIds:cohorts.map(c=>c.id),evaluatorId:transitionEvaluatorId,
    configuration:{schema:'plus-conditional-transition-evaluation-v1',task:'CONDITIONAL_TRANSITION',minimumPairs:1,minimumGroups:1,minimumCoverage:1,maximumNllRegression:0,maximumBrierRegression:0}};
  const members=[];for(const c of cohorts){const r=(await datasets.readCohort(c.id,trainer)).record;members.push({id:r._id,protocol:r.payload.protocol,members:r.payload.members});}
  return {...f,episodeConfig:f.config,second,actionHistoryContract,recipes,recipe,recipeHash,config,registry:new NativeEvaluationProtocolRegistry(config),input,cohorts,members,datasets,datasetConfig,policy,
    advance:n=>{now=n;f.advance(n);}};
}

test('native prospective transition approval preserves two times of one object, independent review, reopen and revocation without scoring',async t=>{
  const f=await setup(t),draft=await f.registry.propose(f.input,trainer);
  await assert.rejects(()=>f.registry.review(draft.id,draft.version,'APPROVE','self',{...trainer,roles:['trainer','model_owner']}),/INDEPENDENT_REVIEW/);
  const approved=await f.registry.review(draft.id,draft.version,'APPROVE','Whole longitudinal heldout population',owner);
  const read=await f.registry.requireApproved(draft.id,trainer),m=read.record.payload.transitionMembership;
  assert.deepEqual(m.coverage,{enrolledEndpoints:2,trajectories:1,plannedPairs:1,groups:1});
  assert.equal(m.scoringReady,false);assert.equal(m.modelDeploymentAuthorized,false);assert.ok(m.pendingQualifications.includes('TRAIN_HOLDOUT_SOURCE_SEPARATION'));
  assert.equal((await f.registry.propose(f.input,trainer)).id,draft.id);
  const epoch=await f.storage.getReadRevision(ctx),reopened=new NativeEvaluationProtocolRegistry({...f.config,storage:f.openStorage()});
  assert.deepEqual((await reopened.requireApproved(draft.id,trainer)).record.payload.transitionMembership,m);assert.equal(await f.storage.getReadRevision(ctx),epoch);
  assert.equal((await f.storage.queryObjects(ctx,'PlusModelEvaluation',{and:[]})).totalCount,0);
  assert.equal((await f.storage.queryObjects(ctx,'PlusDeployment',{and:[]})).totalCount,0);
  await reopened.revoke(draft.id,approved.version,'Withdraw prospective protocol',owner);
  await assert.rejects(()=>reopened.requireApproved(draft.id,trainer),/NOT_APPROVED/);
});

test('two latent variables require a complete shared trajectory, not four unrelated one-point samples',async t=>{
  const f=await setup(t,{secondary:true}),draft=await f.registry.propose(f.input,trainer);
  const row=(await f.registry.read(draft.id,trainer)).record;
  assert.deepEqual(row.payload.transitionMembership.coverage,{enrolledEndpoints:4,trajectories:1,plannedPairs:1,groups:1});
  const missing=structuredClone(f.input);missing.key='missing-component';missing.cohortIds=missing.cohortIds.slice(0,1);
  await assert.rejects(()=>f.registry.propose(missing,trainer),/INCOMPLETE_STATE/);
});

test('old evaluator still rejects entity overlap and a transition name cannot bypass native configuration or population validation',async t=>{
  const f=await setup(t),epoch=await f.storage.getReadRevision(ctx);
  await assert.rejects(()=>f.registry.propose({...f.input,evaluatorId:'legacy-test-evaluator'},trainer),/COHORT_OVERLAP/);
  for(const change of [c=>c.task='STATE_ESTIMATION',c=>c.labels=['READY'],c=>c.minimumCoverage=0,c=>c.maximumBrierRegression=-1,c=>c.minimumPairs=2,c=>c.minimumGroups=2]){
    const input=structuredClone(f.input);change(input.configuration);await assert.rejects(()=>f.registry.propose(input,trainer),/TRANSITION_EVALUATION_/);
  }
  await assert.rejects(()=>f.registry.propose({...f.input,cohortIds:[f.cohort.id]},trainer),/UNPAIRED/);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);
});

test('a preapproved time contract cannot silently bridge missing steps',async t=>{
  const f=await setup(t,{stepMs:30000});await assert.rejects(()=>f.registry.propose(f.input,trainer),/TRANSITION_EVALUATION_GAP/);
});

test('fixed transition evaluator rejects a legacy recipe even for a single member and a permissive embedding validator',async t=>{
  const f=await setup(t),legacy=structuredClone(f.recipe);legacy.schema='plus-transition-recipe-v1';delete legacy.timeContract;delete legacy.actionHistoryContract;
  const recipeHash=digest(legacy),draft=await f.recipes.propose({key:'legacy.transition',revision:1,definitionKey:legacy.compiled.definition.key,payload:legacy},trainer);
  await f.recipes.review(draft.id,draft.version,'APPROVE','Legacy recipe is not an approved history contract',owner);f.policy.recipeHashes.push(recipeHash);
  const epoch=await f.storage.getReadRevision(ctx);
  await assert.rejects(()=>f.registry.propose({...f.input,recipeHash,cohortIds:[f.cohort.id]},trainer),/TRANSITION_EVALUATION_RECIPE/);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);
});

test('registration/approval close before labels and protocol revision cannot retune thresholds',async t=>{
  const f=await setup(t),draft=await f.registry.propose(f.input,trainer),changed=structuredClone(f.input);changed.configuration.maximumNllRegression=.1;
  await assert.rejects(()=>f.registry.propose(changed,trainer),/REVISION_CONFLICT/);
  f.advance(3);await assert.rejects(()=>f.registry.review(draft.id,draft.version,'APPROVE','late',owner),/REGISTRATION_CLOSED/);
  await assert.rejects(()=>f.registry.propose({...f.input,key:'hindsight'},trainer),/REGISTRATION_CLOSED/);
});

test('current cohort read, identity purpose and full native membership are rechecked after approval',async t=>{
  const f=await setup(t),draft=await f.registry.propose(f.input,trainer);await f.registry.review(draft.id,draft.version,'APPROVE','Independent',owner);
  f.datasetConfig.authorize=async()=>false;await assert.rejects(()=>f.registry.requireApproved(draft.id,trainer),/FORBIDDEN/);f.datasetConfig.authorize=async()=>true;
  f.policy.id='changed-purpose';await assert.rejects(()=>f.registry.requireApproved(draft.id,trainer),/STALE/);f.policy.id='synthetic-transition-validation';
  f.config.authorize=async()=>false;await assert.rejects(()=>f.registry.requireApproved(draft.id,trainer),/FORBIDDEN/);
});

test('structural membership checker rejects duplicate components, group splits and training-protocol reuse without reading GOLD',async t=>{
  const f=await setup(t),check=(recipe,members)=>validateTransitionEvaluationMembership(recipe,f.input.configuration,members);
  assert.equal(check(f.recipe,f.members).scoringReady,false);
  for(const mutate of [m=>m[0].members[1].targetTime=m[0].members[0].targetTime,m=>m[0].members[1].splitGroupHash=digest('other-group'),
    m=>m[0].members[1].entityKey=digest('forged-root'),m=>m[0].members[1].sampleKey=m[0].members[0].sampleKey]){
    const members=structuredClone(f.members);mutate(members);assert.throws(()=>check(f.recipe,members),/TRANSITION_EVALUATION_/);
  }
  const recipe=structuredClone(f.recipe);recipe.config.trainingProtocolHashes=[digest(f.members[0].protocol)];
  assert.throws(()=>check(recipe,f.members),/COHORT_CONTRACT/);
});

for(const missing of [false,true])test(`approved native validation retains complete trajectory/history and missing denominator (missing GOLD: ${missing})`,async t=>{
  const f=await setup(t,{minimumCoverage:missing ? 0.5 : 1}),draft=await f.registry.propose(f.input,trainer);
  const approval=await f.registry.review(draft.id,draft.version,'APPROVE','Independent before GOLD',owner);
  await f.addLabel();f.advance(6);
  if(!missing){
  const gold=await f.add({kind:'VERIFICATION',value:'BUSY',minute:2,received:6,origin:'heldout-transition-second-gold'});
  const stream=await f.runtime.capture(f.episodes[0]._id,principal,'heldout-label-stream');
  const label=(await f.runtime.snapshot({streamId:stream.record._id,targetTime:at(2)},principal,'heldout-second-label')).record;
  await f.partitions.reserve(label._id,trainer);f.advance(6.1);
  const feedback=await f.feedback.propose({inputSnapshotId:f.second._id,labelSnapshotId:label._id,eventId:gold.event._id},trainer);
  await f.feedback.review(feedback.id,feedback.version,'APPROVE','Later independent endpoint',reviewer);
  }
  f.advance(9);const frozen=await f.datasets.freeze(f.cohorts[0].id,trainer);
  let allowed=true,revision=0;const authority=async()=>digest(['synthetic-validation-current-authority',revision]);
  const endpoints=new NativeTransitionEndpointReader({storage:f.storage,tenantId:ctx.tenantId,datasets:f.datasets,feedback:f.feedback,episodes:f.runtime,partitions:f.partitions,
    authorizationRevision:authority,authorize:async(p,purpose)=>allowed&&p.id===trainer.id&&purpose==='VALIDATE'});
  f.episodeConfig.qualifyContextHistory=async()=>({allowed:true,policyHash:digest('synthetic-heldout-history')});
  const intervalConfig={storage:f.storage,tenantId:ctx.tenantId,catalog:f.catalog,requests:{read:async()=>assert.fail('Actual native inventory is empty')},
    policyFor:async()=>structuredClone(f.actionHistoryContract),authorize:async()=>allowed,authorizationRevision:authority,clock:()=>Date.parse(at(9))};
  const planConfig={storage:f.storage,tenantId:ctx.tenantId,recipes:f.recipes,endpoints,episodes:f.runtime,actionIntervals:new NativeActionIntervalReader(intervalConfig),
    validationActionIntervals:new NativeActionIntervalReader(intervalConfig),evaluationProtocols:f.registry,authorizationRevision:authority};
  const plans=new NativeTransitionPlanReader(planConfig),epoch=await f.storage.getReadRevision(ctx);
  const material=await plans.materializeForValidation(draft.id,[frozen.id],trainer),plan=material.sourcePlan.contextPlan.plan;
  assert.equal(material.purpose,'VALIDATE');assert.equal(material.scoringReady,false);assert.equal(material.trainingAuthorized,false);
  assert.equal(plan.validation.protocol.id,draft.id);assert.equal(plan.validation.protocol.version,approval.version);
  assert.deepEqual(plan.datasets.map(d=>d.protocol.partition),['VALIDATION']);assert.equal(plan.pairs.length,1);
  assert.deepEqual(plan.pairs[0].from.map(p=>p.labels[0].value.value),['READY']);
  assert.deepEqual(plan.pairs[0].to.flatMap(p=>p.labels.map(l=>l.value.value)),missing?[]:['BUSY']);
  assert.equal(plan.coverage.enrolledEndpoints,2);assert.equal(plan.coverage.plannedPairs,1);assert.equal(plan.coverage.missingPairs,missing?1:0);
  assert.equal(material.sourcePlan.contextPlan.historicalContextChecked,true);assert.deepEqual(material.sourcePlan.intervals[0].material.executions,[]);
  assert.equal(material.sourcePlan.nativeReadQualificationsChecked,true);assert.ok(material.sourcePlan.pendingQualifications.includes('TRAIN_HOLDOUT_SOURCE_SEPARATION'));
  assert.equal(await f.storage.getReadRevision(ctx),epoch);
  assert.equal((await new NativeTransitionPlanReader({...planConfig,storage:f.openStorage()}).materializeForValidation(draft.id,[frozen.id],trainer)).contentHash,material.contentHash);
  assert.throws(()=>fitTransitionModel(f.recipe,[material]),/TRANSITION_FIT_/);
  await assert.rejects(()=>plans.materializeForFit(f.recipeHash,[frozen.id],trainer),/FORBIDDEN/);
  await assert.rejects(()=>new NativeTransitionPlanReader({...planConfig,evaluationProtocols:undefined}).materializeForValidation(draft.id,[frozen.id],trainer),/PROTOCOL_PROVIDER_REQUIRED/);
  await assert.rejects(()=>new NativeTransitionPlanReader({...planConfig,validationActionIntervals:undefined}).materializeForValidation(draft.id,[frozen.id],trainer),/TRANSITION_VALIDATION_ACTION_READER_REQUIRED/);
  await assert.rejects(()=>new NativeTransitionPlanReader({...planConfig,validationActionIntervals:{read:async()=>{throw Object.assign(new Error('No explicit validation inventory grant'),{code:'ACTION_INTERVAL_FORBIDDEN'});}}})
    .materializeForValidation(draft.id,[frozen.id],trainer),{code:'ACTION_INTERVAL_FORBIDDEN'});
  allowed=false;revision++;await assert.rejects(()=>plans.materializeForValidation(draft.id,[frozen.id],trainer),/FORBIDDEN/);allowed=true;revision++;
  await f.registry.revoke(draft.id,approval.version,'Withdraw heldout permission',owner);
  await assert.rejects(()=>plans.materializeForValidation(draft.id,[frozen.id],trainer),/NOT_APPROVED/);
  assert.equal((await f.storage.queryObjects(ctx,'PlusModelEvaluation',{and:[]})).totalCount,0);
});
