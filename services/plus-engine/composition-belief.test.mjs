import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { CelClient } from '../../platform/packages/actions/dist/index.js';
import { NativeModelDeployment,NativeReplayAuthorization,NativeRuleRuntime,NativeBeliefRuntime,NativeBeliefComposition,NativeScenarioRuntime } from '../../platform/packages/plus-runtime/dist/index.js';
import { ctx,trainer,owner,at } from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import { compositionEvaluationFixture } from './composition-evaluation-fixture.mjs';
import { createIsolatedCompositionReplayEngine } from './composition-replay-process.mjs';
import { createObservationReplayEngine } from './online-replay.mjs';
import { createRuleBackend } from './rule-backend.mjs';
import { createPublishedVerificationPlanner } from './verification-planning.mjs';
import { createCompositionVerificationPlanner } from './composition-verification-planning.mjs';

// Full native model lifecycle and source/history components, synthetic
// source/clock/permission fixtures. Real fixed child + real loopback CEL.
// This is not a full private HTTP host or production/real-business benchmark.
async function fixture(t,{neural=false}={}){
  const started=Date.now(),progress=stage=>process.stdout.write(JSON.stringify({schema:'plus-native-joint-progress-v1',estimator:neural?'U3':'U2',stage,elapsedMs:Date.now()-started})+'\n');
  const f=await compositionEvaluationFixture(t,{neural,batch:neural}),key='composition-current';
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
  assert.ok(process.env.LWM_CEL_BINARY);const celAddress=`127.0.0.1:${port}`;
  const child=spawn(process.env.LWM_CEL_BINARY,[],{env:{...process.env,CEL_HOST:'127.0.0.1',CEL_PORT:String(port)},stdio:'ignore',windowsHide:true});
  let spawnError;child.on('error',e=>{spawnError=e;});const cel=new CelClient({address:celAddress,maxRetries:0,timeoutMs:1000,circuitBreakerResetMs:100});
  t.after(async()=>{cel.close();if(!spawnError&&child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill();await ended;}});
  let ready=false;for(let i=0;i<60;i++){if(spawnError)throw spawnError;try{if((await cel.evaluate('true',{})).value===true){ready=true;break;}}catch{}await delay(100);}assert.ok(ready);
  f.state.jointRead=true;f.state.jointRun=true;f.state.applicationAllowed=true;
  f.decisionConfig.authorize=async(p,permission)=>p.id===owner.id||p.id===trainer.id&&['model:decision-read','model:decision-use'].includes(permission);
  const evaluation=await f.evaluations.evaluate(f.request,trainer);assert.equal(evaluation.decision,'ELIGIBLE_FOR_REVIEW');
  const decision=await f.decisions.decide({key,evaluationId:evaluation.id,evaluationVersion:evaluation.version,decision:'APPROVE',reason:'Synthetic independent joint model admission'},owner);
  const {version,id,...target}=await f.decisionConfig.policyFor(owner,key);
  const deployments=new NativeModelDeployment({storage:f.storage,tenantId:ctx.tenantId,decisions:f.decisions,clock:f.options.clock,
    authorize:async(p,permission)=>p.id===owner.id||p.id===trainer.id&&permission==='deployment:read',targetFor:async()=>target,
    authorizationRevision:f.authority,readConsistency:'SHARED_NATIVE_AND_AUTHORITY'});
  const selection=await deployments.activate({key,expectedVersion:0,decisionId:decision.id,requestKey:'native-joint-selection',reason:'Not yet online'},owner);
  const authorizations=new NativeReplayAuthorization({storage:f.storage,tenantId:ctx.tenantId,deployments,clock:f.options.clock,
    authorize:async(p,permission)=>p.id===owner.id||p.id===trainer.id&&['replay:read','replay:use'].includes(permission),
    policyFor:async()=>({version:'plus-online-replay-policy-v1',id:'native-joint-replay',task:'STATE_ESTIMATION',scopeKey:'synthetic',classification:'SYNTHETIC',clock:f.timeContract}),
    authorizationRevision:f.authority,readConsistency:'SHARED_NATIVE_AND_AUTHORITY'});
  const authorization=await authorizations.approve({key,expectedDeploymentVersion:selection.version,reason:'Independent online use, scoped to approved clock'},owner);
  progress('NATIVE_MODEL_SELECTED_AND_REPLAY_APPROVED');
  f.advance(22);const root=await f.root('synthetic',undefined,20);
  const report=await f.createSource(root.task,{record:'fresh-joint-report',result:'DONE',eventMinute:21,received:21});
  const episode=await f.episodes.open({definitionKey:'task.completion',rootId:root.task._id,startedAt:at(20)},trainer,'fresh-joint-episode');
  const captured=await f.capture(episode,'fresh-joint-input',21),snapshot=captured.record;
  const ruleConfig={storage:f.storage,tenantId:ctx.tenantId,rules:f.rules,episodes:f.episodes,clock:f.options.clock,
    authorize:async(p,permission,k,episodeId)=>p.id===trainer.id&&k==='task.joint.rules'&&episodeId===episode._id&&(permission==='rule:evaluate'?f.state.jointRun:f.state.jointRead),
    authorizationRevision:f.authority,policyFor:async()=>({version:'plus-rule-evaluation-policy-v1',id:'synthetic-joint-rule-purpose',definitionKeys:['task.completion'],scopeKeys:['synthetic'],classifications:['SYNTHETIC'],specificationHashes:[f.recipe.ruleSpecificationHash]}),
    qualifyApplication:async(_p,{specification,targetTime})=>({allowed:f.state.applicationAllowed&&specification.rules.every(r=>r.ruleRevision.id===f.source._id)&&Date.parse(targetTime)>=Date.parse(f.source.effectiveFrom),policyHash:digest('synthetic-reviewed-application')}),
    evaluator:{id:'typed-cel-rule-v1',evaluate:async(compiled,spec,input)=>createRuleBackend(compiled,spec).evaluate(input,{evaluateCel:(...args)=>cel.evaluate(...args)})}};
  const ruleResults=new NativeRuleRuntime(ruleConfig),engine=createIsolatedCompositionReplayEngine({celAddress}),operation={runs:0,afterRun:async result=>result};
  const compositionConfig={storage:f.storage,tenantId:ctx.tenantId,rules:ruleResults,ruleKeyFor:async()=> 'task.joint.rules',
    engine:{id:engine.id,run:async request=>{operation.runs++;return operation.afterRun(await engine.run(request));}}};
  const config={storage:f.storage,tenantId:ctx.tenantId,authorizations,episodes:f.episodes,recipes:f.services.recipes,compute:f.compute,
    authorize:async p=>p.id===trainer.id,authorizationRevision:f.authority,clock:f.options.clock,engine:createObservationReplayEngine(),composition:new NativeBeliefComposition(compositionConfig)};
  progress('FRESH_NATIVE_SNAPSHOT_CAPTURED');
  return {...f,key,root,report,episode,snapshot,authorization,authorizations,deployments,selection,ruleResults,ruleConfig,operation,compositionConfig,config,progress,
    beliefs:new NativeBeliefRuntime(config),input:{authorizationId:authorization.id,snapshotId:snapshot._id,expectedVersion:0}};
}
const count=async(f,type)=>(await f.storage.queryObjects(ctx,type,{and:[]})).totalCount;

test('native U3 joint belief uses actual approved model/rule, one snapshot, fixed child, atomic lineage, retry and current withdrawal',{timeout:1200000},async t=>{
  const f=await fixture(t,{neural:true});
  await assert.rejects(()=>new NativeBeliefRuntime({...f.config,composition:undefined}).prepareReplay(f.input,trainer),/COMPOSITION_NOT_CONFIGURED/);
  const original=await f.storage.getObject(ctx,'InvestigationTask',f.root.task._id),result=await f.beliefs.replay(f.input,trainer);
  f.progress('JOINT_BELIEF_COMMITTED');
  assert.equal(result.predictionReady,true);assert.equal(f.operation.runs,1);
  const current=await f.beliefs.readCurrent(f.key,f.episode._id,trainer),joint=current.record.payload.result.composition;
  assert.equal(joint.rules.results[0].outputs.recommendedPriority.value,'HIGH');
  assert.deepEqual(current.record.distribution,joint.statistics.belief);assert.equal(joint.inputHash,f.snapshot.inputHash);
  assert.equal(joint.authorityChecked,false);assert.equal(joint.predictionReady,false);
  assert.equal((await f.storage.getLinks(ctx,result.beliefId,'PlusBeliefRuleSpecification','outbound')).items[0]._toId,f.rule.id);
  assert.equal(await count(f,'PlusBeliefSnapshot'),1);assert.equal(await count(f,'PlusRuleResult'),0);
  const epoch=await f.storage.getReadRevision(ctx);
  assert.equal((await f.beliefs.replay(f.input,trainer)).replayed,true);assert.equal(f.operation.runs,1);assert.equal(await f.storage.getReadRevision(ctx),epoch);
  // New storage connection to the same database; upstream graph remains live.
  // Not a clean-machine recovery or complete HTTP host restart claim.
  const reopened=new NativeBeliefRuntime({...f.config,storage:f.open()});
  assert.equal((await reopened.readCurrent(f.key,f.episode._id,trainer)).record.contentHash,current.record.contentHash);
  f.progress('JOINT_RETRY_AND_REOPEN_VERIFIED');
  f.state.jointRead=false;await assert.rejects(()=>reopened.readCurrent(f.key,f.episode._id,trainer),/FORBIDDEN/);f.state.jointRead=true;
  f.state.applicationAllowed=false;await assert.rejects(()=>reopened.readCurrent(f.key,f.episode._id,trainer),/APPLICATION_NOT_ELIGIBLE/);f.state.applicationAllowed=true;
  const scenarioConfig={storage:f.storage,tenantId:ctx.tenantId,beliefs:reopened,definitions:f.definitions,compute:f.compute,recipes:f.services.recipes,
    authorize:async p=>p.id===trainer.id,policyFor:async()=>({version:'plus-verification-scenario-policy-v1',id:'synthetic-composition-planning',definitionKeys:['task.completion'],scopeKeys:['synthetic'],classifications:['SYNTHETIC']}),
    authorizationRevision:f.authority,clock:f.options.clock,planner:createPublishedVerificationPlanner(),compositionPlanner:createCompositionVerificationPlanner()};
  const scenarioInput={key:f.key,episodeId:f.episode._id,beliefId:current.record._id,requestKey:'native-joint-comparison',availabilityProbability:.5};
  await assert.rejects(()=>new NativeScenarioRuntime({...scenarioConfig,compositionPlanner:undefined}).compare(scenarioInput,trainer),/COMPOSITION_NOT_CONFIGURED/);
  const scenarios=new NativeScenarioRuntime(scenarioConfig),comparison=await scenarios.compare(scenarioInput,trainer),compared=await scenarios.read(comparison.id,trainer);
  assert.equal(compared.nativeAdmissionChecked,true);assert.deepEqual(compared.record.predictions.composition.rules,joint.rules);
  assert.equal(compared.record.predictions.composition.jointResultHash,joint.contentHash);assert.equal(compared.record.predictions.definitionHash,f.compiled.definitionHash);
  assert.equal(compared.record.predictions.composition.comparison.definitionHash,f.recipe.composition.statistics.definitionHash);
  assert.equal((await scenarios.compare(scenarioInput,trainer)).replayed,true);assert.equal(await count(f,'PlusScenarioRun'),1);
  const tampered=new NativeScenarioRuntime({...scenarioConfig,compositionPlanner:{id:scenarioConfig.compositionPlanner.id,compare:async input=>{
    const bad=structuredClone(await scenarioConfig.compositionPlanner.compare(input));bad.composition.rules.results[0].outputs.recommendedPriority.value='CRITICAL';return bad;}}});
  await assert.rejects(()=>tampered.compare({...scenarioInput,requestKey:'forged-joint-comparison'},trainer),/COMPOSITION_RESULT_INVALID/);assert.equal(await count(f,'PlusScenarioRun'),1);
  f.progress('NATIVE_JOINT_SCENARIO_COMPARISON_AND_RULE_LINEAGE_VERIFIED');
  await f.rules.revoke(f.rule.id,f.rule.version,'Withdraw the joint rule dependency',owner);
  await assert.rejects(()=>reopened.readCurrent(f.key,f.episode._id,trainer),/STALE|REVOKED|NOT_APPROVED|FORBIDDEN/);
  await assert.rejects(()=>scenarios.read(comparison.id,trainer),/STALE|REVOKED|NOT_APPROVED|FORBIDDEN/);
  assert.deepEqual(await f.storage.getObject(ctx,'InvestigationTask',f.root.task._id),original);assert.equal(original.actualCompletion,'UNKNOWN');
  f.progress('JOINT_READ_AND_RULE_WITHDRAWAL_VERIFIED');
});

test('native U2 joint commit rejects computation races, forged rules and late journal failure without half a belief/head/link',{timeout:1200000},async t=>{
  const f=await fixture(t),none=async()=>{assert.equal(await count(f,'PlusBeliefSnapshot'),0);assert.equal(await count(f,'PlusBeliefHead'),0);};
  f.state.jointRun=false;await assert.rejects(()=>f.beliefs.prepareReplay(f.input,trainer),/FORBIDDEN/);f.state.jointRun=true;
  f.operation.afterRun=async result=>{f.state.applicationAllowed=false;return result;};
  await assert.rejects(()=>f.beliefs.replay(f.input,trainer),/APPLICATION_NOT_ELIGIBLE|AUTHORITY_STALE/);await none();f.state.applicationAllowed=true;
  f.operation.afterRun=async result=>{const source=await f.storage.getObject(ctx,'Matter',f.root.matter._id);await f.storage.updateObject(ctx,'Matter',source._id,{title:'Synthetic concurrent edit'},source._version);return result;};
  await assert.rejects(()=>f.beliefs.replay(f.input,trainer),/CONFLICT|STALE/);await none();
  f.operation.afterRun=async result=>{const bad=structuredClone(result);bad.rules.results[0].outputs.recommendedPriority.value='CRITICAL';
    bad.rules.contentHash=digest(Object.fromEntries(Object.entries(bad.rules).filter(([k])=>k!=='contentHash')));
    bad.contentHash=digest(Object.fromEntries(Object.entries(bad).filter(([k])=>k!=='contentHash')));return bad;};
  await assert.rejects(()=>f.beliefs.replay(f.input,trainer),/COMPUTATION_INVALID/);await none();
  f.operation.afterRun=async result=>result;
  const prepared=await f.beliefs.prepareReplay(f.input,trainer),epoch=await f.storage.getReadRevision(ctx);
  await assert.rejects(()=>f.beliefs.replay(f.input,trainer,{preparedHash:prepared.preparedHash,assertCurrent:async()=>{},stage:async()=>{throw new Error('synthetic-job-receipt-failure');}}),/synthetic-job-receipt-failure/);
  await none();assert.equal(await f.storage.getReadRevision(ctx),epoch);
  const success=await f.beliefs.replay(f.input,trainer);assert.equal(success.predictionReady,true);
  f.progress('JOINT_RACES_AND_TRANSACTION_ROLLBACK_VERIFIED');
  await f.authorizations.revoke(f.authorization.id,f.authorization.version,'Withdraw online consent',owner);
  await assert.rejects(()=>f.beliefs.readCurrent(f.key,f.episode._id,trainer),/SUSPENDED|STALE/);
  assert.equal((await f.storage.getObject(ctx,'InvestigationTask',f.root.task._id)).actualCompletion,'UNKNOWN');
});
