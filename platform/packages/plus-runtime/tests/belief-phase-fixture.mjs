import {digest} from '@openfoundry/plus-contracts';
import {NativeModelDecision,NativeModelDeployment,NativeReplayAuthorization,NativeBeliefRuntime,createNativeReadQualificationPhase} from '../dist/index.js';
import {modelEvaluationFixture,ctx,trainer,owner,at} from './model-evaluation-fixture.mjs';
import {createObservationReplayEngine} from '../../../../services/plus-engine/online-replay.mjs';

// Real native SQLite FIT, prospective score, independent decision, selection,
// consent and numerical replay. Synthetic Machine/clock/authority fixture, NOT
// complete-composition Task HTTP performance or production qualification.
export async function beliefPhaseFixture(t){
  const f=await modelEvaluationFixture(t,{stateEvaluation:true}),state={revision:0,validations:0,runs:0,passes:[]};
  const upstream=f.evaluationConfig.authorizationRevision,authority=async p=>digest({upstream:await upstream(p),revision:state.revision});
  f.evaluationConfig.authorizationRevision=authority;
  const score=await f.evaluations.evaluate(f.request,trainer),protocol=(await f.protocols.read(f.approved.id,owner)).record;
  const recipe=(await f.recipes.requireApproved(protocol.payload.recipe.hash,owner)).payload;
  const policy={version:'plus-model-admission-v1',id:'belief-phase-admission',definitionHash:recipe.compiled.definitionHash,
    bindingHash:recipe.config.bindingHash,scopeKey:recipe.compiled.definition.scope.key,classification:'SYNTHETIC',task:'STATE_ESTIMATION',clockHash:digest(protocol.payload.configuration.clock)};
  const decisionConfig={storage:f.storage,tenantId:ctx.tenantId,evaluations:f.evaluations,recipes:f.recipes,readConsistency:'SHARED_NATIVE_AND_AUTHORITY',
    authorize:async p=>[trainer.id,owner.id].includes(p.id),policyFor:async()=>structuredClone(policy),authorizationRevision:authority,clock:f.evaluationConfig.clock};
  const decisions=new NativeModelDecision(decisionConfig),decision=await decisions.decide({key:policy.id,evaluationId:score.id,evaluationVersion:score.version,decision:'APPROVE',reason:'Independent synthetic native approval'},owner);
  const {version,id,...target}=policy,key='belief.phase-selection';
  const deployments=new NativeModelDeployment({storage:f.storage,tenantId:ctx.tenantId,decisions,readConsistency:'SHARED_NATIVE_AND_AUTHORITY',
    authorize:async p=>p.id===owner.id,targetFor:async()=>structuredClone(target),authorizationRevision:authority,clock:f.evaluationConfig.clock});
  const selection=await deployments.activate({key,expectedVersion:0,decisionId:decision.id,requestKey:'phase-selection',reason:'Independent selection; not online yet'},owner);
  const onlinePolicy={version:'plus-online-replay-policy-v1',id:'belief-phase-online',task:'STATE_ESTIMATION',scopeKey:target.scopeKey,classification:'SYNTHETIC',clock:protocol.payload.configuration.clock};
  const replay=new NativeReplayAuthorization({storage:f.storage,tenantId:ctx.tenantId,deployments,readConsistency:'SHARED_NATIVE_AND_AUTHORITY',
    authorize:async p=>p.id===owner.id,policyFor:async()=>structuredClone(onlinePolicy),authorizationRevision:authority,clock:f.evaluationConfig.clock});
  const consent=await replay.approve({key,expectedDeploymentVersion:selection.version,reason:'Independent online consent'},owner);
  f.advance(21);
  const root=await f.storage.createObject(ctx,'Machine',{actual:'UNKNOWN',status:'REGISTERED',priority:1,createdAt:at(20),receivedAt:at(20),classification:'SYNTHETIC'});
  const episode=await f.runtime.open({definitionKey:f.definition.key,rootId:root._id,startedAt:at(20)},owner,'phase-online');
  await f.add({rootId:root._id,origin:'phase-fresh-report',value:'READY',minute:21,received:21});
  const stream=await f.runtime.capture(episode._id,owner,'phase-stream');
  const snapshot=(await f.runtime.snapshot({streamId:stream.record._id,targetTime:at(21)},owner,'phase-snapshot')).record;
  const config={storage:f.storage,tenantId:ctx.tenantId,authorizations:replay,episodes:f.runtime,recipes:f.recipes,compute:f.compute,
    authorize:async(p,_permission,k,e)=>p.id===owner.id&&k===key&&e===episode._id,authorizationRevision:authority,
    engine:createObservationReplayEngine(),clock:f.evaluationConfig.clock};
  const beliefs=new NativeBeliefRuntime(config),phase=createNativeReadQualificationPhase({storage:f.storage,tenantId:ctx.tenantId,
    readers:[f.recipes,f.compute,decisions],authorizationRevision:authority,clock:f.evaluationConfig.clock});
  const configure=enabled=>{for(const c of [config,decisionConfig,f.evaluationConfig,f.protocolConfig,f.computeConfig])c.readQualificationPhase=enabled?phase:undefined;};configure(true);
  const validate=f.recipes.validate.bind(f.recipes),run=config.engine.run,material=beliefs.materialQualified.bind(beliefs);
  f.recipes.validate=async(...a)=>{state.validations++;return validate(...a);};
  config.engine.run=async(...a)=>{state.runs++;return run(...a);};
  beliefs.materialQualified=async(...a)=>{const count=state.validations,start=performance.now();try{return await material(...a);}finally{state.passes.push({validations:state.validations-count,ms:performance.now()-start});}};
  return {...f,state,config,beliefs,configure,root,episode,key,phase,authority,input:{authorizationId:consent.id,snapshotId:snapshot._id,expectedVersion:0}};
}
