import assert from 'node:assert/strict';
import { readFileSync,writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { CelClient } from '../../platform/packages/actions/dist/index.js';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { transitionComponentContract,transitionEvaluatorId,learnedCompositionStateEvaluatorId } from '../../platform/packages/plus-runtime/dist/index.js';
import { ctx,trainer,reviewer,owner } from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import { learnedCompositionTrainingFixture } from './learned-composition-fixture.mjs';
import { transitionRecipe,transitionEstimatorId } from './transition-fit.mjs';
import { compositionRecipe } from './native-composition-recipe.mjs';
import { learnedCompositionEstimatorId } from './learned-composition.mjs';
import { startPlusControlServer } from '../../ops/plus-v2/control-server.mjs';
import {startNativeRuntime,readNativeRuntimeProfile} from '../../ops/plus-v2/runtime-host.mjs';
import {planReviewedRuntime,applyReviewedRuntimePlan} from '../../ops/plus-v2/reviewed-runtime-plan.mjs';
import {dirname} from 'node:path';
import { taskRuleSourceFields } from '../../ops/plus-v2/task-rule-services.mjs';
import { createPrivateIdentityProvider } from '../../ops/plus-v2/private-identity.mjs';
import { createPrivateTaskServices } from '../../ops/plus-v2/task-services.mjs';
import {nativeCompleteComputeConfiguration,authorizeNativeCompleteBatch} from './native-complete-authorization-fixture.mjs';

// Historical source/cohort/GOLD construction is explicitly SYNTHETIC. All new
// rule/recipe/compute/evaluation/governance providers come from the actual
// canonical host, file identities and policy. No approval/FIT provider injection
// and no production clock override. This fixture does not itself approve a model.
export async function createPrivateLearnedCompositionHostFixture(t,{componentValidation=false,selectionJobs=false,
  historyVersion='plus-native-action-interval-policy-v2',sourceGovernanceCel,nativeCompute=false,reviewedRuntime=false}={}){
  assert.equal(typeof nativeCompute,'boolean');
  assert.equal(typeof reviewedRuntime,'boolean');
  if(reviewedRuntime)assert.equal(nativeCompute,true,'Reviewed runtime uses actual native v4 authorizations');
  // Opt-in v3 is an existing reviewed contract: requalify current authority on
  // every read, compare the actual semantic dependencies to saved exposure.
  // Do not reinterpret v2 artifacts or remove their original authority fence.
  assert.ok(['plus-native-action-interval-policy-v2','plus-native-action-interval-policy-v3'].includes(historyVersion),'Explicit supported private action-history contract required');
  const started=performance.now(),phase=name=>console.info(`[complete-host] ${name} ${Math.round(performance.now()-started)}ms`);
  const f=await learnedCompositionTrainingFixture(t,false,{historyVersion,sourceGovernanceCel});
  phase('historical-synthetic-native-training-ready');
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
  assert.ok(process.env.LWM_CEL_BINARY);
  const child=spawn(process.env.LWM_CEL_BINARY,[],{env:{...process.env,CEL_HOST:'127.0.0.1',CEL_PORT:String(port)},stdio:'ignore',windowsHide:true});
  let spawnError;child.on('error',error=>{spawnError=error;});
  const celAddress=`127.0.0.1:${port}`,cel=new CelClient({address:celAddress,maxRetries:0,timeoutMs:1000,circuitBreakerResetMs:100});
  t.after(async()=>{cel.close();if(!spawnError&&child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill();await exit;}});
  let ready=false;for(let i=0;i<60;i++){if(spawnError)throw spawnError;try{if((await cel.evaluate('true',{})).value===true){ready=true;break;}}catch{}await delay(100);}assert.ok(ready);

  // A fresh, fixed wall-clock collection window. A newly approved transition
  // recipe must NOT train on already-labelled historical cohorts.
  let heldout;
  if(componentValidation){
    // Select an independent, explicitly synthetic source group before opening
    // the collection window. Never change a group's native partition to fit it.
    for(let i=0;i<100;i++){
      const root=await f.root(),bucket=parseInt(digest([f.policy.taskLearning.partition.seed,ctx.tenantId,
        ['task-matter-v1',digest(['synthetic',root.matter._id])]]).slice(0,8),16)%10000;
      if(bucket>=6000&&bucket<7500){heldout=root;break;}
    }
    assert.ok(heldout);assert.notEqual(heldout.matter._id,f.initial.matter._id);
  }
  const collectionStart=Date.now(),iso=n=>new Date(n).toISOString();
  const windows=componentValidation?{input:150000,label:210000,end:360000,freeze:390000}:{input:90000,label:120000,end:240000,freeze:270000};
  const trainingProtocol={...f.protocol,key:'task.complete-host.new-train',expectedSampleCount:4,minimumSamples:4,
    inputVisibleFrom:iso(collectionStart-1000),inputVisibleUntil:iso(collectionStart+windows.input),
    labelReceivedFrom:iso(collectionStart+windows.label),labelReceivedUntil:iso(collectionStart+windows.end),approvalUntil:iso(collectionStart+windows.freeze)};
  const validationProtocol=componentValidation?{...trainingProtocol,key:'task.complete-host.new-validation',partition:'VALIDATION',expectedSampleCount:2,minimumSamples:2}:undefined;
  const old=f.build.transition;
  const {recipe:transition,recipeHash:transitionHash}=transitionRecipe(f.compiled,old.supervision,
    {...old.config,minimumPairs:2,trainingProtocolHashes:[digest(trainingProtocol)]},old.timeContract,old.actionHistoryContract);
  assert.notEqual(transitionHash,digest(old));
  const transitionWorker={id:'complete-host-transition-worker',tenantId:ctx.tenantId,roles:['plus_compute_worker']};
  const completeWorker={id:'complete-host-full-worker',tenantId:ctx.tenantId,roles:['plus_compute_worker']};
  const selectionWorker={id:'complete-host-selection-worker',tenantId:ctx.tenantId,roles:['plus_governance_worker']};
  const investigator={id:'complete-host-observer',tenantId:ctx.tenantId,roles:['investigator']};
  const keys={rule:'task.complete-host.rule',transition:'task.complete-host.transition',observation:'task.observation',complete:'task.complete-host.model',
    component:'task.complete-host.component',model:'task.complete-host.current',componentScore:'task.complete-host.component-score',completeScore:'task.complete-host.full-score'};
  const selection={key:keys.complete,revision:1,engineId:learnedCompositionEstimatorId,definitionHash:f.compiled.definitionHash,
    bindingHash:transition.supervision.specification.bindingHash,scopeKey:f.compiled.definition.scope.key,classification:'SYNTHETIC'};
  const qualification=reviewedRuntime?undefined:{version:'plus-synthetic-complete-fit-qualification-v1',tenantId:ctx.tenantId,recipeSelections:[selection]};
  const reviewedSelections=reviewedRuntime?[1,2,3].map(revision=>({...selection,revision})):undefined;
  const policy={...f.policy,version:1,definitions:{'task.completion':{readRoles:['trainer','data_reviewer','model_owner'],draftRoles:['data_reviewer'],publishRoles:['model_owner'],policy:f.mechanism.policy}},
    taskRules:{version:'plus-private-task-rules-v1',enabled:true,specifications:[{key:keys.rule,workspace:'synthetic',policy:{version:'plus-rule-policy-v1',id:'complete-host-rule',
      definitionKeys:['task.completion'],scopeKeys:['synthetic'],bindings:[{moduleKey:'priorityRecommendation',sourceType:'RuleVersion',sourceLink:'TaskRuleSpecificationSource'}]}}],evaluations:[],
      grants:[trainer,reviewer,owner].map(p=>({principalId:p.id,requiredRoles:p.roles,permissions:p.id===reviewer.id?['rule:draft','rule:read','rule:use']:p.id===owner.id?['rule:review','rule:revoke','rule:read','rule:use']:['rule:read','rule:use'],
        specificationKeys:[keys.rule],evaluationKeys:[],sourceIds:[f.source._id],sourceFields:[...taskRuleSourceFields]}))},
    replayGovernance:{version:'plus-private-replay-governance-v1',enabled:true,targets:[],grants:[]},
    beliefRuntime:{version:'plus-private-belief-runtime-v1',enabled:true,grants:[]},
    scenarioPlanning:{version:'plus-private-scenario-planning-v1',enabled:true,targets:[],grants:[]},
    actionRequests:{version:'plus-private-action-requests-v1',enabled:true,targets:[],grants:[]}};
  if(reviewedRuntime)policy.learnedCompositionReplay={version:'plus-private-learned-composition-replay-v1',enabled:true,targets:[]};
  policy.taskLearning.cohorts.push({workspace:'synthetic',protocol:trainingProtocol});
  for(const grant of policy.taskLearning.grants)grant.protocolKeys.push(trainingProtocol.key);
  if(validationProtocol){
    policy.taskLearning.cohorts.push({workspace:'synthetic',protocol:validationProtocol});
    for(const grant of policy.taskLearning.grants)grant.protocolKeys.push(validationProtocol.key);
  }
  const fields=name=>f.bundle.parsed.objectTypes.find(t=>t.name===name).fields.filter(v=>!v.directives.some(d=>['primary','computed','link'].includes(d.kind))).map(v=>v.name);
  const type=name=>({read:fields(name),write:fields(name),create:true});
  policy.taskDomain.grants=[
    {principalId:investigator.id,workspaces:['synthetic'],actions:['NativeRecordTaskObservation'],types:{InvestigationTask:type('InvestigationTask'),Observation:type('Observation')}},
    {principalId:reviewer.id,workspaces:['synthetic'],actions:['NativeVerifyTaskObservation'],types:{InvestigationTask:type('InvestigationTask'),Observation:{read:fields('Observation'),write:[]},TaskCompletionVerification:type('TaskCompletionVerification')}}];
  const component=transitionComponentContract(transition);
  policy.modelGovernance={version:'plus-private-model-governance-v2',enabled:true,targets:[
    {key:keys.component,policy:{version:'plus-transition-component-admission-v1',id:'complete-host-component',task:'CONDITIONAL_TRANSITION',
      definitionHash:component.definitionHash,bindingHash:component.bindingHash,scopeKey:component.scopeKey,classification:component.classification,clockHash:component.timeContractHash,component}},
    {key:keys.model,policy:{version:'plus-model-admission-v1',id:'complete-host-full',task:'STATE_ESTIMATION',definitionHash:f.compiled.definitionHash,
      bindingHash:selection.bindingHash,scopeKey:selection.scopeKey,classification:'SYNTHETIC',clockHash:digest(f.build.clock)}}],grants:[
    {principalId:owner.id,requiredRoles:owner.roles,keys:[keys.component],permissions:['model:decide','model:decision-read','model:decision-use','model:decision-revoke']},
    {principalId:owner.id,requiredRoles:owner.roles,keys:[keys.model],permissions:['model:decide','model:decision-read','model:decision-use','model:decision-revoke','deployment:activate','deployment:read','deployment:rollback']},
    {principalId:trainer.id,requiredRoles:trainer.roles,keys:[keys.component],permissions:['model:decision-read','model:decision-use']},
    {principalId:trainer.id,requiredRoles:trainer.roles,keys:[keys.model],permissions:['model:decision-read','model:decision-use','deployment:read']}]};
  policy.evaluation={version:'plus-private-evaluation-v2',enabled:true,protocols:[
    {key:keys.componentScore,purpose:{version:'plus-evaluation-purpose-v1',id:'complete-host-transition-score',recipeHashes:[transitionHash],evaluatorIds:[transitionEvaluatorId],classifications:['SYNTHETIC']}},
    {key:keys.completeScore,purpose:{version:'plus-evaluation-purpose-v1',id:'complete-host-state-score',recipeSelections:[selection],evaluatorIds:[learnedCompositionStateEvaluatorId],classifications:['SYNTHETIC'],reference:{mode:'COLD_START',controlKey:keys.model}}}],
    grants:[trainer,owner].map(p=>({principalId:p.id,requiredRoles:p.roles,protocolKeys:[keys.componentScore,keys.completeScore],
      permissions:p.id===trainer.id?['evaluation:draft','evaluation:read','evaluation:use','evaluation:run','evaluation:result-read']:['evaluation:review','evaluation:read','evaluation:use','evaluation:revoke','evaluation:result-read']}))};
  // All authority is fixed BEFORE FIT and holdout exposure. Starting the native
  // scheduler later changes no policy, model permission, data or identity.
  if(selectionJobs)policy.selectionJobs={version:'plus-private-selection-jobs-v1',enabled:true,
    targets:[{key:keys.model,policy:{version:'plus-selection-job-policy-v1',workerId:selectionWorker.id,leaseMs:300000,maxAttempts:2}}],grants:[
      {principalId:owner.id,requiredRoles:owner.roles,keys:[keys.model],permissions:['selection-job:enqueue','selection-job:read','selection-job:cancel']},
      {principalId:selectionWorker.id,requiredRoles:selectionWorker.roles,keys:[keys.model],permissions:['selection-job:read','selection-job:claim','selection-job:run','selection-job:fail','selection-job:reconcile']} ]};
  for(const [key,engineId,base]of [[keys.transition,transitionEstimatorId,policy.taskLearning.recipes.find(r=>r.key==='task.learned.transition')],
    [keys.complete,learnedCompositionEstimatorId,policy.taskLearning.recipes[0]]]){
    const entry=structuredClone(base);entry.key=key;entry.policy.engineIds=[engineId];policy.taskLearning.recipes.push(entry);
    for(const grant of policy.taskLearning.grants)grant.recipeKeys.push(key);
  }
  const observationIds=f.frozenRows.map(r=>r.id),transitionIds=f.transitionDatasetIds;
  const transitionAuthorization={key:'complete-host-transition',version:1},completeAuthorization={key:'complete-host-full',version:1};
  policy.compute={version:'plus-private-compute-v3',enabled:true,jobs:[
    ...transitionIds.map(datasetId=>({datasetId,submitterId:trainer.id,requiredRoles:trainer.roles,authorization:transitionAuthorization,
      policy:{version:'plus-compute-policy-v1',workerId:transitionWorker.id,engineId:transitionEstimatorId,recipeHash:transitionHash,leaseMs:300000,maxAttempts:2}})),
    ...observationIds.map(datasetId=>({datasetId,submitterId:trainer.id,requiredRoles:trainer.roles,authorization:completeAuthorization,
      policy:{version:'plus-compute-policy-v1',workerId:completeWorker.id,engineId:learnedCompositionEstimatorId,recipeSelection:selection,leaseMs:300000,maxAttempts:2}}))],
    grants:[trainer,owner].map(p=>({principalId:p.id,requiredRoles:p.roles,datasetIds:[...transitionIds,...observationIds],
      permissions:p.id===trainer.id?['compute:submit','compute:inspect','compute:read-result']:['compute:inspect','compute:read-result']})).concat(
      [[transitionWorker,transitionIds],[completeWorker,observationIds]].map(([p,datasetIds])=>({principalId:p.id,requiredRoles:p.roles,datasetIds,
        permissions:['compute:inspect','compute:claim','compute:complete','compute:fail']}))),
    workers:[transitionWorker,completeWorker].map(p=>({principalId:p.id,requiredRoles:p.roles,maxItems:1}))};
  if(nativeCompute){
    Object.assign(policy,nativeCompleteComputeConfiguration({selection,transitionWorker,completeWorker,transitionAuthorization,completeAuthorization}));
    // Exact finite recipe revisions are declared before any new FIT/holdout.
    // Adding data later creates native authorizations, not new file jobs/pins.
    if(qualification)qualification.recipeSelections=[1,2,3].map(revision=>({...selection,revision}));
  }
  const nativeComputeBaseline=nativeCompute?JSON.stringify({compute:policy.compute,authorizations:policy.computeAuthorizations,qualification}):undefined;
  const intervalIds=policy.actionIntervals.targets.map(r=>r.episodeId);
  policy.actionIntervals.grants=[trainer,owner].map(p=>({principalId:p.id,requiredRoles:p.roles,episodeIds:intervalIds,permissions:['action-interval:inventory']}));
  const authPath=f.path+'.host-auth.json',policyPath=f.path+'.host-policy.json',token=p=>'synthetic-complete-host-'+p.id;
  const accounts=[trainer,reviewer,owner,transitionWorker,completeWorker,investigator,...(selectionJobs?[selectionWorker]:[])].map(p=>({...p,tokenHash:createHash('sha256').update(token(p)).digest('hex'),expiresAt:new Date(Date.now()+7200000).toISOString()}));
  const save=()=>{writeFileSync(authPath,JSON.stringify(accounts),{mode:0o600});writeFileSync(policyPath,JSON.stringify(policy),{mode:0o600});};save();
  let server,managed,reviewedReference,selectionWorkerIntervalMs=0,actionExecutionWorkerIntervalMs=0;const reviewedDeployments=[];
  const start=async()=>{
    if(!reviewedRuntime){server=await startPlusControlServer({dbPath:f.path,authPath,policyPath,tenantId:ctx.tenantId,workerIntervalMs:0,selectionWorkerIntervalMs,actionExecutionWorkerIntervalMs,celAddress,syntheticCompleteFitQualification:qualification});return;}
    assert.ok(!managed||managed.state().status==='STOPPED','Stop the owned runtime before reviewing changed configuration');
    // Real operator plan/apply and normal managed runtime; native review remains
    // independent HTTP. Synthetic config selection is TEST orchestration, never
    // a claim that a human approved production use or that a model is admitted.
    const generation=reviewedDeployments.length+1,basePath=f.path+'.base-runtime-'+generation+'.json';
    writeFileSync(basePath,JSON.stringify({schema:'plus-runtime-profile-v1',tenantId:ctx.tenantId,dbPath:f.path,authPath,policyPath,ports:{control:0,workbench:0,cel:0},expectedOntologyHash:f.bundle.contentHash}),{mode:0o600,flag:'wx'});
    const backgroundWorkers={schema:'plus-native-worker-schedule-v1',audit:0,selection:selectionWorkerIntervalMs,evaluation:0,decision:0,actionExecution:actionExecutionWorkerIntervalMs};
    const plan=await planReviewedRuntime({schema:'plus-reviewed-runtime-request-v2',profilePath:basePath,outputParent:dirname(f.path),directoryName:'reviewed-runtime-'+generation,recipeSelections:reviewedSelections,backgroundWorkers});
    const installed=await applyReviewedRuntimePlan(plan,plan.planHash);assert.equal(installed.nativeApprovalGranted,false);assert.equal(installed.serviceStarted,false);
    const profilePath=installed.profilePath,profile=readNativeRuntimeProfile(profilePath);reviewedReference=profile.reviewedCompleteFit;
    managed=await startNativeRuntime(readNativeRuntimeProfile(profilePath),{celBinary:process.env.LWM_CEL_BINARY});
    const state=managed.state();assert.equal(state.registry,'REVIEWED_NATIVE_FIT_PINS');assert.equal(state.predictionReady,false);
    assert.equal(state.backgroundWorkers,selectionWorkerIntervalMs||actionExecutionWorkerIntervalMs?'EXPLICIT_SCHEDULE':'DISABLED');
    reviewedDeployments.push({generation,profilePath,reference:structuredClone(reviewedReference),policyHash:installed.policyHash,ontologyHash:installed.ontologyHash,planHash:plan.planHash,backgroundWorkers,celPid:state.celPid});
    server={url:state.controlUrl,close:()=>managed.close(),selectionWorkerState:()=>managed.workerStates().selection,actionExecutionWorkerState:()=>managed.workerStates().actionExecution};phase('normal-reviewed-runtime-started-'+generation);
  };
  t.after(async()=>{await server?.close();});await start();phase('actual-canonical-qualified-host-started');
  const request=async(path,input,p=trainer,key='complete-host-request')=>{
    const response=await fetch(server.url+'/api/plus/v2'+path,{method:input===undefined?'GET':'POST',signal:AbortSignal.timeout(180000),
      headers:{authorization:'Bearer '+token(p),...(input===undefined?{}:{'content-type':'application/json','idempotency-key':key})},...(input===undefined?{}:{body:JSON.stringify(input)})});
    return {status:response.status,body:await response.json()};
  };
  const ok=async(...args)=>{const r=await request(...args);assert.equal(r.status,200,JSON.stringify(r.body));return r.body.data;};
  const oldRule=await f.storage.getObject(ctx,'PlusRuleSpecification',f.rule.id),specification=structuredClone(oldRule.specification);
  specification.rules[0].outputs.recommendedPriority='CRITICAL';
  const rd=await ok('/learning/rule-specifications',{key:keys.rule,revision:1,definitionKey:'task.completion',specification},reviewer);
  const rule=await ok('/learning/rule-specifications/'+rd.id+'/review',{expectedVersion:rd.version,decision:'APPROVE',reason:'Actual independent private rule source review'},owner);
  const preview=await ok('/definitions/task.completion/composition');
  const {recipe:observation,recipeHash:observationHash}=compositionRecipe({compiled:f.compiled,composition:preview.composition,statistics:f.originalObservationRecipe.statistics,
    ruleSpecification:await f.storage.getObject(ctx,'PlusRuleSpecification',rule.id)});
  assert.notEqual(observationHash,digest(f.originalObservationRecipe));
  const od=await ok('/learning/recipes',{key:keys.observation,revision:2,definitionKey:'task.completion',payload:observation});
  await ok('/learning/recipes/'+od.id+'/review',{expectedVersion:od.version,decision:'APPROVE',reason:'Actual independently reviewed observation/rule recipe'},owner);
  const td=await ok('/learning/recipes',{key:keys.transition,revision:1,definitionKey:'task.completion',payload:transition});
  await ok('/learning/recipes/'+td.id+'/review',{expectedVersion:td.version,decision:'APPROVE',reason:'Actual independent private longitudinal recipe review'},owner);
  phase('actual-http-rule-observation-and-transition-recipes-approved');
  assert.ok(Date.now()<Date.parse(trainingProtocol.labelReceivedFrom),'New recipe must precede the fixed GOLD window');
  const trainingRows=[];
  const validationRows=[];
  for(let i=0;i<(componentValidation?3:2);i++){
    // Only initial root/group construction remains a synthetic fixture. Every
    // new report, verification, capture, enrollment and review below is HTTP/CEL.
    const root=i===2?heldout:await f.root('synthetic',f.initial.matter),startedAt=iso(Date.now());
    const episode=await ok('/episodes',{definitionKey:'task.completion',rootId:root.task._id,startedAt},trainer,'complete-train-episode-'+i);
    (i===2?validationRows:trainingRows).push({task:root.task,episode,startedAt,members:[],first:i===1?'DONE':'NOT_DONE',partition:i===2?'VALIDATION':'TRAIN'});
  }
  const allRows=[...trainingRows,...validationRows];
  const waitUntil=async at=>{while(Date.now()<Date.parse(at))await delay(Math.min(250,Date.parse(at)-Date.now()));};
  for(let step=0;step<2;step++)for(const [i,row]of allRows.entries()){
    const target=iso(Date.parse(row.startedAt)+step*old.timeContract.stepMs);await waitUntil(target);
    const task=await f.storage.getObject(ctx,'InvestigationTask',row.task._id);
    const report=await ok('/actions/NativeRecordTaskObservation',{task:task._id,expectedVersion:task._version,
      title:'New synthetic longitudinal report',summary:'Actual native input; independent GOLD follows approval',reportedCompletion:'DONE',eventTime:target,
      channelKey:'report',sourceSystem:'task-source',sourceRecordId:`complete-train-${i}-${step}`,sourceRevision:'1'},investigator,`complete-train-report-${i}-${step}`);
    const observation=await f.storage.getObject(ctx,'Observation',report.receipt.resultId);
    const stream=await ok('/episodes/'+row.episode._id+'/captures',{},trainer,`complete-train-capture-${i}-${step}`);
    const input=await ok('/snapshots',{streamId:stream.record._id,targetTime:target},trainer,`complete-train-input-${i}-${step}`);
    assert.equal((await ok('/learning/partitions',{snapshotId:input.record._id})).partition,row.partition);
    row.members.push({observation,input,value:step?'DONE':row.first,target});
  }
  assert.ok(Date.now()<Date.parse(trainingProtocol.labelReceivedFrom));
  const cd=await ok('/learning/cohorts',{protocolKey:trainingProtocol.key,inputSnapshotIds:trainingRows.flatMap(r=>r.members.map(m=>m.input.record._id))});
  const cohort=await ok('/learning/cohorts/'+cd.id+'/review',{expectedVersion:cd.version,decision:'APPROVE',reason:'Four actual prelabel inputs enrolled independently'},reviewer);
  let validationCohort,scoreProtocol;
  if(componentValidation){
    const vd=await ok('/learning/cohorts',{protocolKey:validationProtocol.key,inputSnapshotIds:validationRows.flatMap(r=>r.members.map(m=>m.input.record._id))});
    validationCohort=await ok('/learning/cohorts/'+vd.id+'/review',{expectedVersion:vd.version,decision:'APPROVE',reason:'Independent native heldout trajectory before GOLD'},reviewer);
    const pd=await ok('/learning/evaluation-protocols',{key:keys.componentScore,revision:1,recipeHash:transitionHash,cohortIds:[validationCohort.id],evaluatorId:transitionEvaluatorId,
      configuration:{schema:'plus-conditional-transition-evaluation-v2',task:'CONDITIONAL_TRANSITION',reference:{schema:'plus-transition-reference-v1',kind:'SAME_CONDITION_FACTORIZED_COUNTS'},
        minimumPairs:1,minimumGroups:1,minimumCoverage:1,maximumNllRegression:0,maximumBrierRegression:0}});
    scoreProtocol=await ok('/learning/evaluation-protocols/'+pd.id+'/review',{expectedVersion:pd.version,decision:'APPROVE',reason:'Freeze component comparison before independent labels'},owner);
    phase('actual-http-component-heldout-and-score-protocol-approved-before-gold');
  }
  assert.ok(Date.now()<Date.parse(trainingProtocol.labelReceivedFrom),'All cohort and score approvals must precede GOLD');
  phase('actual-http-four-input-cohort-approved-before-gold');
  await waitUntil(trainingProtocol.labelReceivedFrom);
  for(const [i,row]of allRows.entries())for(const [j,member]of row.members.entries()){
    const task=await f.storage.getObject(ctx,'InvestigationTask',row.task._id);
    const check=await ok('/actions/NativeVerifyTaskObservation',{task:task._id,observation:member.observation._id,expectedVersion:task._version,
      expectedObservationVersion:member.observation._version,result:member.value,targetTime:member.target,methodKey:'independent',
      evidence:'New synthetic independent GOLD, not model output'},reviewer,`complete-train-gold-${i}-${j}`);
    const stream=await ok('/episodes/'+row.episode._id+'/captures',{},trainer,`complete-train-label-capture-${i}-${j}`);
    const label=await ok('/snapshots',{streamId:stream.record._id,targetTime:member.target},trainer,`complete-train-label-${i}-${j}`);
    await ok('/learning/partitions',{snapshotId:label.record._id});
    const feedback=await ok('/learning/feedback',{inputSnapshotId:member.input.record._id,labelSnapshotId:label.record._id,eventId:check.event.id});
    await ok('/learning/feedback/'+feedback.id+'/review',{expectedVersion:feedback.version,decision:'APPROVE',reason:'Independent review of the new native verification'},reviewer);
  }
  assert.equal((await request('/learning/cohorts/'+cohort.id+'/freeze',{})).status,409);
  phase('actual-http-new-gold-reviewed-waiting-fixed-freeze-window');
  await waitUntil(trainingProtocol.approvalUntil);
  const frozen=await ok('/learning/cohorts/'+cohort.id+'/freeze',{});assert.equal(frozen.readiness,'READY');
  const validationFrozen=componentValidation?await ok('/learning/cohorts/'+validationCohort.id+'/freeze',{}):undefined;
  if(validationFrozen)assert.equal(validationFrozen.readiness,'READY');
  // Replace initial historical placeholders before ANY private FIT exposure.
  const oldTransitionIds=[...transitionIds];transitionIds.splice(0,transitionIds.length,frozen.id);
  if(!nativeCompute){
    for(const job of policy.compute.jobs)if(job.policy.engineId===transitionEstimatorId)job.datasetId=frozen.id;
    for(const grant of policy.compute.grants)grant.datasetIds=[...new Set(grant.datasetIds.map(id=>oldTransitionIds.includes(id)?frozen.id:id))];
  }else assert.equal(JSON.stringify({compute:policy.compute,authorizations:policy.computeAuthorizations,qualification}),nativeComputeBaseline);
  policy.actionIntervals.targets=allRows.map(row=>({episodeId:row.episode._id,rootId:row.task._id,purpose:row.partition==='TRAIN'?'TRANSITION_FIT':'TRANSITION_VALIDATE',policy:transition.actionHistoryContract}));
  for(const grant of policy.actionIntervals.grants)grant.episodeIds=allRows.map(row=>row.episode._id);
  save();await server.close();await start();phase('actual-http-fresh-transition-dataset-frozen-before-fit');
  const diagnoseTransition=async()=>{
    // Read-only failure localization with the identical native graph and file
    // authority. It neither enqueues a replacement job nor supplies material to
    // the HTTP request. Successful HTTP execution remains the acceptance gate.
    const graph=createPrivateTaskServices({storage:f.storage,tenantId:ctx.tenantId,cel,celAddress,
      identities:createPrivateIdentityProvider({authPath,tenantId:ctx.tenantId}),loadPolicy:()=>JSON.parse(readFileSync(policyPath,'utf8')),
      ...(reviewedRuntime?{reviewedCompleteFit:reviewedReference}:{syntheticCompleteFitQualification:qualification})});
    graph.assertConfigured();
    await graph.transitionPlans.materializeForFit(transitionHash,transitionIds,trainer);
  };
  return {...f,policy,save,accounts,keys,transition,transitionHash,observation,observationHash,rule,transitionWorker,completeWorker,nativeCompute,nativeComputeBaseline,
    authorizeCompute:(ref,ids,hash)=>authorizeNativeCompleteBatch({policy,ok,request},ref,ids,hash),
    transitionIds,observationIds,transitionAuthorization,completeAuthorization,selection,qualification,phase,request,ok,token,
    reviewedRuntime,reviewedSelections,reviewedDeployments,runtimeState:()=>managed?.state(),
    trainingProtocol,trainingRows,validationProtocol,validationRows,validationCohort,validationFrozen,scoreProtocol,diagnoseTransition,
    baseUrl:()=>server.url,restart:async()=>{await server.close();await start();},
    startSelectionWorker:async()=>{assert.equal(selectionJobs,true);assert.equal(selectionWorkerIntervalMs,0);await server.close();selectionWorkerIntervalMs=1000;await start();},
    selectionWorkerState:()=>server.selectionWorkerState(),
    startActionExecutionWorker:async()=>{assert.equal(policy.actionExecutionJobs?.enabled,true);assert.equal(actionExecutionWorkerIntervalMs,0);await server.close();actionExecutionWorkerIntervalMs=1000;await start();},
    actionExecutionWorkerState:()=>server.actionExecutionWorkerState()};
}
