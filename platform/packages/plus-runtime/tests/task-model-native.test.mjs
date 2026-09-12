import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '@openfoundry/plus-contracts';
import { NativeComputeAdmission,NativeEvaluationProtocolRegistry,NativeModelEvaluation,NativeModelDecision,NativeModelDeployment,NativeReplayAuthorization } from '../dist/index.js';
import { taskLearningFixture,ctx,trainer,reviewer,owner,at } from './task-learning-fixture.mjs';
import { fitObservationModel } from '../../../../services/plus-engine/observation-fit.mjs';
import { stateEvaluatorId,validateStateEvaluationProtocol,createStateEvaluator } from '../../../../services/plus-engine/state-evaluation-protocol.mjs';
import { exerciseTaskModelHost } from './task-model-host-acceptance.mjs';
import { neuralObservationRecipe,neuralObservationEstimatorId } from '../../../../services/plus-engine/native-neural-fit-verifier.mjs';
import { fitNeuralObservationModel } from '../../../../services/plus-engine/neural-observation-fit.mjs';
import { neuralStateEvaluatorId,validateNeuralStateEvaluationProtocol,createNeuralStateEvaluator } from '../../../../services/plus-engine/neural-state-evaluation.mjs';
import { createPrivateComputeAccess } from '../../../../ops/plus-v2/compute-access.mjs';
import { createRegisteredNativeFitVerifiers } from '../../../../services/plus-engine/estimator-registry.mjs';
import { exerciseTaskFeedbackRounds } from './task-feedback-rounds-fixture.mjs';
import { createPrivateModelGovernanceAccess } from '../../../../ops/plus-v2/model-governance.mjs';

// Native Task revision 2, real data/recipe/FIT/evaluation/admission/replay classes.
// Historical TRAIN/VALIDATION records use explicit SYNTHETIC source transactions
// and fixture time. Online Task/report actions and the real private host use wall
// time. Neither part proves real business efficacy or main-service deployment.
for(const {neural,freshFeedback} of [{neural:false,freshFeedback:false},{neural:true,freshFeedback:false},{neural:false,freshFeedback:true},{neural:true,freshFeedback:true}])test(`Task revision 2 ${neural?'U3':'U2'} ${freshFeedback?'two-feedback-rounds':'first-model'} native TRAIN and held-out state evaluation admit a fitted model; canonical new Task actions drive real private host/outbox/HTTP job/fixed child and restart`,async t=>{
  const started=Date.now(),progress=stage=>process.stdout.write(JSON.stringify({schema:'plus-task-model-test-progress-v1',updateKind:neural?'U3':'U2',stage,elapsedMs:Date.now()-started})+'\n');
  const f=await taskLearningFixture(t,{timedPriority:true,initializePriority:true}),s=f.services;
  assert.equal(typeof f.options.identities.authorizationRevision,'function','Private model runtime requires a current identity revision provider');
  assert.equal(f.compiled.definition.revision,2);assert.ok(f.compiled.variables.find(v=>v.key==='priority').time.initial);
  const trainMembers=[{task:f.initial.task,report:f.report,episode:f.episode,input:f.input,value:'DONE'}];
  if(neural){
    // Fixed software cohort covers both ontology states before any GOLD. The
    // feedback variant includes one predeclared misleading initial report;
    // later reliable evidence can correct it. No holdout-based selection.
    const additions=freshFeedback?[{state:'NOT_DONE',report:'DONE'},{state:'DONE',report:'DONE'},{state:'NOT_DONE',report:'NOT_DONE'}]:[{state:'NOT_DONE',report:'NOT_DONE'}];
    f.protocol.expectedSampleCount=1+additions.length;
    f.policy.taskLearning.recipes[0].policy.engineIds.push(neuralObservationEstimatorId);
    for(const [i,record]of additions.entries()){
      const root=await f.root('synthetic',f.initial.matter,0),report=await f.source(root.task,{record:'train-coverage-'+i,result:record.report});
      const episode=await f.episodes.open({definitionKey:'task.completion',rootId:root.task._id,startedAt:at(0)},trainer,'train-coverage-episode-'+i);
      const input=await f.capture(episode,'train-coverage-'+i);trainMembers.push({task:root.task,report,episode,input,value:record.state});
    }
  }
  for(const member of trainMembers)await s.partitions.reserve(member.input.record._id,trainer);
  const proposed=await s.datasets.proposeCohort(f.protocol.key,trainMembers.map(m=>m.input.record._id),trainer);
  const cohort=await s.datasets.reviewCohort(proposed.id,proposed.version,'APPROVE','SYNTHETIC prospective training membership',reviewer);
  for(const [i,member]of trainMembers.entries()){
    const received=4+i*.4;f.advance(received);const check=await f.source(member.task,{observation:member.report.object,result:member.value,received}),labels=await f.capture(member.episode,'train-labels-'+i);
    await s.partitions.reserve(labels.record._id,trainer);f.advance(received+.1);
    const feedback=await s.feedback.propose({inputSnapshotId:member.input.record._id,labelSnapshotId:labels.record._id,eventId:check.event._id},trainer);
    await s.feedback.review(feedback.id,feedback.version,'APPROVE','SYNTHETIC independent TRAIN label',reviewer);
  }
  f.advance(9);const training=await s.datasets.freeze(cohort.id,trainer),base=f.recipe(),network={schema:'one-hot-tanh-softmax-v1',hiddenWidth:4,epochs:100,learningRate:.2,l2:.001,seed:41};
  const neuralConfig={schema:'plus-neural-observation-config-v1',supervision:{...base.recipe.config,trainingProtocolHashes:[digest(f.protocol)]},network};
  const {recipe,recipeHash}=neural?neuralObservationRecipe(f.compiled,base.recipe.baseline,neuralConfig):base;
  const draft=await s.recipes.propose({key:'task.observation',revision:1,definitionKey:'task.completion',payload:recipe},trainer);
  await s.recipes.review(draft.id,draft.version,'APPROVE','SYNTHETIC Task revision-2 '+(neural?'U3':'U2')+' recipe',owner);
  const worker={id:'task-native-model-worker',tenantId:ctx.tenantId,roles:['plus_compute_worker']};
  f.people.set(worker.id,worker);
  const authorization={key:'task.observation.fit',version:1};
  f.policy.compute={version:'plus-private-compute-v2',enabled:true,
    jobs:[{datasetId:training.id,submitterId:trainer.id,requiredRoles:trainer.roles,authorization,
      policy:{version:'plus-compute-policy-v1',workerId:worker.id,engineId:recipe.engineId,recipeHash,leaseMs:300000,maxAttempts:2}}],
    grants:[{principalId:trainer.id,requiredRoles:trainer.roles,datasetIds:[training.id],permissions:['compute:submit','compute:inspect','compute:read-result']},
      {principalId:owner.id,requiredRoles:owner.roles,datasetIds:[training.id],permissions:['compute:inspect','compute:read-result']},
      {principalId:worker.id,requiredRoles:worker.roles,datasetIds:[training.id],permissions:['compute:inspect','compute:claim','compute:complete','compute:fail']}],
    workers:[{principalId:worker.id,requiredRoles:worker.roles,maxItems:1}]};
  const clock=f.options.clock,authority=async()=>digest({policy:f.policy,people:[...f.people.values()]}),compute=new NativeComputeAdmission({storage:f.storage,tenantId:ctx.tenantId,datasets:s.datasets,recipes:s.recipes,
    ...createPrivateComputeAccess({tenantId:ctx.tenantId,identities:f.options.identities,loadPolicy:()=>f.policy,engineId:recipe.engineId}),
    ...createRegisteredNativeFitVerifiers({recipes:s.recipes}),clock});
  const fit=await compute.enqueue(training.id,'FIT',trainer,'task-v2-fit',authorization),lease=await compute.claim(fit.id,worker);
  const artifact=(neural?fitNeuralObservationModel:fitObservationModel)(f.compiled,recipe.baseline,[lease.input],neural?neuralConfig:recipe.config);
  assert.equal(artifact.neuralTrained,neural);assert.equal(lease.input.sourceManifest.samples.length,neural?(freshFeedback?4:2):1);
  const complete=await compute.completeFit(fit.id,lease.version,lease.leaseToken,artifact,worker);
  assert.equal(complete.status,'SUCCEEDED');progress('TASK_V2_NATIVE_FIT_COMPLETE');

  const protocol={...f.protocol,key:'task-validation',partition:'VALIDATION',expectedSampleCount:neural?2:1,inputVisibleFrom:at(11),inputVisibleUntil:at(12),labelReceivedFrom:at(13),labelReceivedUntil:at(17),approvalUntil:at(19)};
  f.policy.taskLearning.cohorts.push({workspace:'synthetic',protocol});for(const grant of f.policy.taskLearning.grants)grant.protocolKeys.push(protocol.key);
  // Choose a fixture group in VALIDATION before creating any report or label.
  // This is explicit software partition coverage, not outcome-based selection.
  let validationRoot;
  for(let i=0;i<64;i++){
    const candidate=await f.root('synthetic',undefined,10),seed=f.policy.taskLearning.partition.seed;
    const bucket=parseInt(digest([seed,ctx.tenantId,['task-matter-v1',digest(['synthetic',candidate.matter._id])]]).slice(0,8),16)%10000;
    if(bucket>=6000&&bucket<7500){validationRoot=candidate;break;}
  }
  assert.ok(validationRoot,'Synthetic prospective validation group required');f.advance(12);
  const report=await f.source(validationRoot.task,{record:'held-out-report',eventMinute:11,received:11});
  const validationEpisode=await f.episodes.open({definitionKey:'task.completion',rootId:validationRoot.task._id,startedAt:at(10)},trainer,'validation-task-episode');
  const input=await f.capture(validationEpisode,'validation-input',11),validationMembers=[{task:validationRoot.task,report,episode:validationEpisode,input,value:'DONE'}];
  if(neural){
    const root=await f.root('synthetic',validationRoot.matter,10),report=await f.source(root.task,{record:'held-out-not-done',result:'NOT_DONE',eventMinute:11,received:11});
    const episode=await f.episodes.open({definitionKey:'task.completion',rootId:root.task._id,startedAt:at(10)},trainer,'validation-not-done-episode');
    const input=await f.capture(episode,'validation-not-done',11);validationMembers.push({task:root.task,report,episode,input,value:'NOT_DONE'});
  }
  for(const member of validationMembers)assert.equal((await s.partitions.reserve(member.input.record._id,trainer)).partition,'VALIDATION');
  const vd=await s.datasets.proposeCohort(protocol.key,validationMembers.map(m=>m.input.record._id),trainer),vc=await s.datasets.reviewCohort(vd.id,vd.version,'APPROVE','SYNTHETIC frozen membership before labels',reviewer);
  const timeContract={schema:'plus-fixed-step-clock-v1',definitionHash:f.compiled.definitionHash,bindingHash:recipe.config.bindingHash,stepMilliseconds:60000,maxSteps:4,transitionContext:'INTERVAL_START',interventions:'WAIT_ONLY'};
  const evaluatorId=neural?neuralStateEvaluatorId:stateEvaluatorId;
  f.policy.evaluation={version:'plus-private-evaluation-v1',enabled:true,
    protocols:[{key:'task-v2-state-score',purpose:{version:'plus-evaluation-purpose-v1',id:'task-v2-state-purpose',recipeHashes:[recipeHash],evaluatorIds:[evaluatorId],classifications:['SYNTHETIC']}}],
    grants:[trainer,owner].map(p=>({principalId:p.id,requiredRoles:p.roles,permissions:['evaluation:read','evaluation:use','evaluation:result-read'],protocolKeys:['task-v2-state-score']}))};
  const protocolConfig={storage:f.storage,tenantId:ctx.tenantId,recipes:s.recipes,datasets:s.datasets,authorize:async p=>[trainer.id,owner.id].includes(p.id),
    policyFor:async(_p,key)=>{const purpose=f.policy.evaluation.protocols.find(p=>p.key===key)?.purpose;assert.ok(purpose);return structuredClone(purpose);},validateConfiguration:neural?validateNeuralStateEvaluationProtocol:validateStateEvaluationProtocol,clock};
  const protocols=new NativeEvaluationProtocolRegistry(protocolConfig);
  const ep=await protocols.propose({key:'task-v2-state-score',revision:1,recipeHash,cohortIds:[vc.id],evaluatorId,
    configuration:{minimumSamples:1,minimumCoverage:1,maximumNllRegression:0,task:'STATE_ESTIMATION',maximumBrierRegression:0,clock:timeContract}},trainer);
  const approved=await protocols.review(ep.id,ep.version,'APPROVE','SYNTHETIC state scoring before held-out labels',owner);
  for(const [i,member]of validationMembers.entries()){
    const received=14+i*.4;f.advance(received);const gold=await f.source(member.task,{observation:member.report.object,result:member.value,received}),label=await f.capture(member.episode,'validation-label-'+i,11);
    await s.partitions.reserve(label.record._id,trainer);f.advance(received+.1);
    const vf=await s.feedback.propose({inputSnapshotId:member.input.record._id,labelSnapshotId:label.record._id,eventId:gold.event._id},trainer);
    await s.feedback.review(vf.id,vf.version,'APPROVE','SYNTHETIC independently recorded validation label',reviewer);
  }
  f.advance(19);const validation=await s.datasets.freeze(vc.id,trainer);
  const evaluationConfig={storage:f.storage,tenantId:ctx.tenantId,protocols,compute,datasets:s.datasets,recipes:s.recipes,authorize:async p=>[trainer.id,owner.id].includes(p.id),
    evaluator:(neural?createNeuralStateEvaluator:createStateEvaluator)(),temporalInputs:f.episodes,authorizationRevision:authority,readConsistency:'SHARED_NATIVE_AND_AUTHORITY',clock};
  const evaluations=new NativeModelEvaluation(evaluationConfig);
  const evaluation=await evaluations.evaluate({protocolId:approved.id,executionId:fit.id,validationDatasetIds:[validation.id]},trainer);
  progress('TASK_V2_NATIVE_HELD_OUT_STATE_EVALUATED');
  const admissionPolicy={version:'plus-model-admission-v1',id:'task-v2-state-admission',definitionHash:f.compiled.definitionHash,bindingHash:recipe.config.bindingHash,
    scopeKey:f.compiled.definition.scope.key,classification:'SYNTHETIC',task:'STATE_ESTIMATION',clockHash:digest(timeContract)};
  f.policy.modelGovernance={version:'plus-private-model-governance-v1',enabled:true,targets:[{key:'task-v2-current',policy:admissionPolicy}],grants:[
    {principalId:owner.id,requiredRoles:owner.roles,keys:['task-v2-current'],permissions:['model:decide','model:decision-read','model:decision-use','model:decision-revoke','deployment:activate','deployment:rollback','deployment:read']},
    {principalId:trainer.id,requiredRoles:trainer.roles,keys:['task-v2-current'],permissions:['model:decision-read','model:decision-use','deployment:read']}]};
  const governance=createPrivateModelGovernanceAccess({tenantId:ctx.tenantId,identities:f.options.identities,loadPolicy:()=>f.policy});
  const decisions=new NativeModelDecision({storage:f.storage,tenantId:ctx.tenantId,evaluations,recipes:s.recipes,...governance,readConsistency:'SHARED_NATIVE_AND_AUTHORITY',clock});
  await assert.rejects(()=>decisions.decide({key:'task-v2-current',evaluationId:evaluation.id,evaluationVersion:evaluation.version,decision:'APPROVE',reason:'Trainer cannot approve own candidate'},trainer),/FORBIDDEN/);
  const decision=await decisions.decide({key:'task-v2-current',evaluationId:evaluation.id,evaluationVersion:evaluation.version,decision:'APPROVE',reason:'SYNTHETIC independent admission'},owner);
  const {version,id,...target}=admissionPolicy;
  const deployments=new NativeModelDeployment({storage:f.storage,tenantId:ctx.tenantId,decisions,...governance,readConsistency:'SHARED_NATIVE_AND_AUTHORITY',clock});
  await assert.rejects(()=>deployments.activate({key:'task-v2-current',expectedVersion:0,decisionId:decision.id,requestKey:'trainer-activation-denied',reason:'Read access is not publication authority'},trainer),/FORBIDDEN/);
  const selected=await deployments.activate({key:'task-v2-current',expectedVersion:0,decisionId:decision.id,requestKey:'task-v2-first-selection',reason:'SYNTHETIC first Task selection'},owner);
  assert.equal(selected.predictionReady,false);
  const active=freshFeedback?await exerciseTaskFeedbackRounds(f,{neural,training,recipe,recipeHash,compute,protocols,protocolConfig,evaluations,evaluationConfig,decisions,deployments,selected,authority,evaluatorId,timeContract,worker,progress}):{selected,recipe,recipeHash,candidateId:complete.candidateId};
  const authorizations=new NativeReplayAuthorization({storage:f.storage,tenantId:ctx.tenantId,deployments,authorize:async p=>p.id===owner.id,
    policyFor:async()=>({version:'plus-online-replay-policy-v1',id:'task-v2-online-state',task:'STATE_ESTIMATION',scopeKey:target.scopeKey,classification:'SYNTHETIC',clock:timeContract}),authorizationRevision:authority,clock});
  const consent=await authorizations.approve({key:'task-v2-current',expectedDeploymentVersion:active.selected.version,reason:'SYNTHETIC explicit online purpose and exact time grid'},owner);
  progress('TASK_V2_NATIVE_MODEL_SELECTED_AND_REPLAY_APPROVED');
  await exerciseTaskModelHost(f,{worker,training,recipe:active.recipe,recipeHash:active.recipeHash,evaluatorId,computePolicy:f.policy.compute,evaluationPolicy:f.policy.evaluation,modelGovernancePolicy:f.policy.modelGovernance,admissionPolicy,timeContract,consent,candidateId:active.candidateId,progress,
    revoke:()=>protocols.revoke(approved.id,approved.version,'SYNTHETIC evaluation consent withdrawal',owner)});
});
