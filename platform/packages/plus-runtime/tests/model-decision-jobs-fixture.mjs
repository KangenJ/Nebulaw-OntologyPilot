import assert from 'node:assert/strict';
import {digest} from '@openfoundry/plus-contracts';
import {NativeModelDecision,NativeModelDecisionJobs} from '../dist/index.js';
import {modelAdmissionFixture,admissionOwner,ctx} from './model-admission-fixture.mjs';
import {modelEvaluationFixture,trainer,owner as actualOwner} from './model-evaluation-fixture.mjs';
export {ctx};

// Default: actual native decision/storage, explicit upstream model-governance
// doubles. actual:true uses real native FIT/protocol/numerical evaluation.
// All data, clocks and identity adapters here are synthetic and test-only.
export async function decisionJobsFixture(t,{actual=false,regression=false}={}){
  let f,p;
  if(!actual){f=await modelAdmissionFixture(t,{regression});p=admissionOwner;}
  else{
    const ef=await modelEvaluationFixture(t,{stateEvaluation:true}),score=await ef.evaluations.evaluate(ef.request,trainer);
    const evaluation=await ef.storage.getObject(ctx,'PlusModelEvaluation',score.id),recipe=await ef.recipes.requireApproved(evaluation.inputReadSet.recipe.hash,actualOwner,'recipe:read');
    const protocol=await ef.storage.getObject(ctx,'PlusEvaluationProtocol',ef.request.protocolId);
    const policy={version:'plus-model-admission-v1',id:'actual-native-state-decision',definitionHash:recipe.payload.compiled.definitionHash,bindingHash:recipe.payload.config.bindingHash,
      scopeKey:recipe.payload.compiled.definition.scope.key,classification:'SYNTHETIC',task:'STATE_ESTIMATION',clockHash:digest(protocol.payload.configuration.clock)};
    const config={storage:ef.storage,tenantId:ctx.tenantId,evaluations:ef.evaluations,recipes:ef.recipes,authorize:async()=>true,policyFor:async()=>structuredClone(policy),
      authorizationRevision:ef.evaluationConfig.authorizationRevision,clock:()=>Date.parse(evaluation.createdAt)+1000};
    f={...ef,config,policy,evaluation,input:{key:policy.id,evaluationId:score.id,evaluationVersion:score.version,decision:'APPROVE',reason:'Explicit independent synthetic-model review'}};p=actualOwner;
  }
  const worker={id:'fixed-native-decision-worker',tenantId:ctx.tenantId,roles:['plus_governance_worker']};
  const control={epoch:1,allow:true,workerAllowed:true,ownerRoles:[...p.roles],failStage:false,loseResponse:false,stages:0,qualified:0,beforeMaterial:async()=>{}};
  const jobPolicy={version:'plus-decision-job-policy-v1',workerId:worker.id,leaseMs:300000,maxAttempts:2};
  let now=f.config.clock();const oldAuthority=f.config.authorizationRevision;
  const authority=async actor=>digest({upstream:await oldAuthority(actor),epoch:control.epoch,allow:control.allow,workerAllowed:control.workerAllowed,roles:control.ownerRoles,jobPolicy});
  f.config.authorizationRevision=authority;f.config.clock=()=>now;
  let runtime;
  const runtimeForStorage=storage=>{
    const result=new NativeModelDecision({...f.config,storage}),material=result.materialQualified.bind(result);
    result.materialQualified=async(...args)=>{control.qualified++;await control.beforeMaterial(...args);return material(...args);};return result;
  };
  runtime=runtimeForStorage(f.storage);
  const config={storage:f.storage,tenantId:ctx.tenantId,runtimeFor:actor=>{
    assert.equal(actor.id,p.id);return {prepareDecision:(...args)=>runtime.prepareDecision(...args),executePreparedDecision:async(input,actor,prepared,guard)=>{
      const result=await runtime.executePreparedDecision(input,actor,prepared,{...guard,stage:async(...args)=>{await guard.stage(...args);control.stages++;if(control.failStage)throw Error('TEST_DECISION_STAGE_FAILURE');}});
      if(control.loseResponse)throw Error('TEST_DECISION_RESPONSE_LOST');return result;
    }};
  },resolvePrincipal:async id=>{assert.equal(id,p.id);return {...p,roles:[...control.ownerRoles]};},
    authorize:async(actor,permission,key)=>control.allow&&key===f.input.key&&(actor.id===p.id?['decision-job:enqueue','decision-job:read','decision-job:cancel'].includes(permission)
      :actor.id===worker.id&&control.workerAllowed&&['decision-job:read','decision-job:claim','decision-job:run','decision-job:fail','decision-job:reconcile'].includes(permission)),
    policyFor:async()=>structuredClone(jobPolicy),authorizationRevision:authority,clock:()=>now};
  return {...f,owner:p,worker,control,jobPolicy,jobConfig:config,command:{mode:'DECIDE',input:{...f.input,requestKey:'explicit-decision-1'}},jobs:new NativeModelDecisionJobs(config),
    decisionRuntime:()=>runtime,advance:ms=>now+=ms,
    reopen:()=>{const storage=f.openStorage();runtime=runtimeForStorage(storage);return new NativeModelDecisionJobs({...config,storage});},
    decisionRows:()=>f.storage.queryObjects(ctx,'PlusModelDecision',{and:[]}),jobRows:()=>f.storage.queryObjects(ctx,'PlusExecution',{field:'kind',operator:'eq',value:'MODEL_DECISION'})};
}
