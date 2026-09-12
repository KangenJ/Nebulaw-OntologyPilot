import assert from 'node:assert/strict';
import {digest,canonicalJson} from '@openfoundry/plus-contracts';
import {NativeModelDecision,NativeModelDeployment,NativeReplayAuthorization,NativeBeliefRuntime,createNativeReadQualificationPhase} from '../dist/index.js';
import {modelEvaluationFixture,ctx,trainer,owner,at} from './model-evaluation-fixture.mjs';
import {baselineFor} from '../../../../services/plus-engine/observation-fit-fixture.mjs';
import {createObservationReplayEngine} from '../../../../services/plus-engine/online-replay.mjs';

// Approved finite mechanism SUPPORT is a synthetic fixture. Observation
// parameters are genuinely fitted; transition hypotheses are reviewed, NOT
// learned. All FIT/score/decision/selection/consent/history/belief providers are
// actual native instances. This is not complete learned-composition acceptance.
function reviewedBaseline(compiled,{equivalent=false,persistentPrior=.65}={}){
  assert.ok(Number.isFinite(persistentPrior)&&persistentPrior>0&&persistentPrior<1);
  const spec=baselineFor(compiled),initial=spec.hypotheses[0];
  spec.hypotheses=['persistent','mixing'].map((key,i)=>{
    const h=structuredClone(initial);h.key=key;h.prior=i===0?persistentPrior:1-persistentPrior;
    for(const row of h.transition){
      const n=row.probabilities.length,stay=equivalent?.85:i===0?.9:.2;
      for(const outcome of row.probabilities)outcome.p=canonicalJson(outcome.state)===canonicalJson(row.from)?stay:(1-stay)/(n-1);
    }
    return h;
  });
  return spec;
}

export async function jointBeliefNativeFixture(t,equivalent,{persistentPrior=.65}={}){
  const f=await modelEvaluationFixture(t,{stateEvaluation:true,reviewedBaseline:c=>reviewedBaseline(c,{equivalent,persistentPrior})});
  const score=await f.evaluations.evaluate(f.request,trainer),protocol=(await f.protocols.read(f.approved.id,owner)).record;
  const recipe=(await f.recipes.requireApproved(protocol.payload.recipe.hash,owner)).payload;
  const policy={version:'plus-model-admission-v1',id:'joint-native-admission',definitionHash:recipe.compiled.definitionHash,bindingHash:recipe.config.bindingHash,
    scopeKey:recipe.compiled.definition.scope.key,classification:'SYNTHETIC',task:'STATE_ESTIMATION',clockHash:digest(protocol.payload.configuration.clock)};
  const authority=f.evaluationConfig.authorizationRevision,config={storage:f.storage,tenantId:ctx.tenantId,evaluations:f.evaluations,recipes:f.recipes,
    readConsistency:'SHARED_NATIVE_AND_AUTHORITY',authorize:async p=>[trainer.id,owner.id].includes(p.id),policyFor:async()=>structuredClone(policy),authorizationRevision:authority,clock:f.evaluationConfig.clock};
  const decisions=new NativeModelDecision(config),phase=createNativeReadQualificationPhase({storage:f.storage,tenantId:ctx.tenantId,
    readers:[f.recipes,f.compute,decisions],authorizationRevision:authority,clock:f.evaluationConfig.clock});
  for(const c of [config,f.evaluationConfig,f.protocolConfig,f.computeConfig])c.readQualificationPhase=phase;
  const decision=await decisions.decide({key:policy.id,evaluationId:score.id,evaluationVersion:score.version,decision:'APPROVE',reason:'Independent native approval of finite-support observation fit'},owner);
  const {version,id,...target}=policy,key='joint.native-selection';
  const deployments=new NativeModelDeployment({storage:f.storage,tenantId:ctx.tenantId,decisions,readConsistency:'SHARED_NATIVE_AND_AUTHORITY',
    authorize:async p=>p.id===owner.id,targetFor:async()=>structuredClone(target),listKeys:async()=>[key],authorizationRevision:authority,clock:f.evaluationConfig.clock});
  const selected=await deployments.activate({key,expectedVersion:0,decisionId:decision.id,requestKey:'joint-select',reason:'Select qualified model; no online result yet'},owner);
  const clock=protocol.payload.configuration.clock,onlinePolicy={version:'plus-online-replay-policy-v1',id:'joint-native-online',task:'STATE_ESTIMATION',scopeKey:target.scopeKey,classification:'SYNTHETIC',clock};
  const authorizations=new NativeReplayAuthorization({storage:f.storage,tenantId:ctx.tenantId,deployments,readConsistency:'SHARED_NATIVE_AND_AUTHORITY',
    authorize:async p=>p.id===owner.id,policyFor:async()=>structuredClone(onlinePolicy),authorizationRevision:authority,clock:f.evaluationConfig.clock});
  const consent=await authorizations.approve({key,expectedDeploymentVersion:selected.version,reason:'Explicit four-step shared-mechanism online consent'},owner);
  f.advance(20);const root=await f.storage.createObject(ctx,'Machine',{actual:'UNKNOWN',status:'REGISTERED',priority:1,createdAt:at(20),receivedAt:at(20),classification:'SYNTHETIC'});
  const episode=await f.runtime.open({definitionKey:f.definition.key,rootId:root._id,startedAt:at(20)},owner,'joint-online');
  const beliefConfig={storage:f.storage,tenantId:ctx.tenantId,authorizations,episodes:f.runtime,recipes:f.recipes,compute:f.compute,
    authorize:async(p,_permission,k,e)=>p.id===owner.id&&k===key&&e===episode._id,authorizationRevision:authority,
    engine:createObservationReplayEngine(),clock:f.evaluationConfig.clock,readQualificationPhase:phase};
  const beliefs=new NativeBeliefRuntime(beliefConfig);
  async function capture(minute,suffix){const stream=await f.runtime.capture(episode._id,owner,'joint-stream-'+suffix);
    return (await f.runtime.snapshot({streamId:stream.record._id,targetTime:at(minute)},owner,'joint-snapshot-'+suffix)).record;}
  return {...f,recipe,key,root,episode,consent,beliefs,beliefConfig,capture,selected,authorizations,deployments};
}

// Independent complete path enumeration. Does not call finite engine/timeline,
// runtime update or take hidden true states; only fitted artifact + actual public
// native event values. The fixture has constant priority and one event per step.
export function enumerateJointPaths(spec,reports,gold){
  const masses=new Map();let total=0;
  for(const h of spec.hypotheses){
    const context={priority:1},matches=r=>canonicalJson(r.context)===canonicalJson(context);
    let paths=h.initial.find(matches).probabilities.map(r=>({state:r.state,mass:h.prior*r.p}));
    for(const report of reports)paths=paths.flatMap(path=>{
      const row=h.transition.find(r=>r.control==='WAIT'&&matches(r)&&canonicalJson(r.from)===canonicalJson(path.state));
      return row.probabilities.map(next=>{
        const channel=h.channels.find(c=>c.kind==='OBSERVATION'&&c.variable==='report');
        const likelihood=channel.rows.find(r=>matches(r)&&canonicalJson(r.state)===canonicalJson(next.state)).probabilities.find(r=>r.value.kind==='VALUE'&&r.value.value===report).p;
        return {state:next.state,mass:path.mass*next.p*likelihood};
      });
    });
    for(const path of paths){const mass=gold===undefined||path.state.state===gold?path.mass:0;
      const k=canonicalJson([h.key,path.state]);masses.set(k,(masses.get(k)??0)+mass);total+=mass;}
  }
  return {joint:new Map([...masses].map(([k,v])=>[k,v/total])),logEvidence:Math.log(total)};
}
export const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-12,`${a} != ${b}`);
