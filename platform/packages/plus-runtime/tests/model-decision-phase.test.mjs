import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '@openfoundry/plus-contracts';
import {NativeModelDecision,createNativeReadQualificationPhase} from '../dist/index.js';
import {modelEvaluationFixture,ctx,trainer,owner} from './model-evaluation-fixture.mjs';

// Real native FIT/evaluation/decision and numerical recomputation; explicit
// fixture clocks/authority, not complete Task HTTP or deployment qualification.
async function fixture(t){
  const f=await modelEvaluationFixture(t,{stateEvaluation:true}),state={revision:0,validations:0,runs:0,passes:[]};
  const upstream=f.evaluationConfig.authorizationRevision,authority=async p=>digest({upstream:await upstream(p),revision:state.revision});
  f.evaluationConfig.authorizationRevision=authority;
  const score=await f.evaluations.evaluate(f.request,trainer),protocol=(await f.protocols.read(f.approved.id,owner)).record;
  const recipe=(await f.recipes.requireApproved(protocol.payload.recipe.hash,owner)).payload;
  const policy={version:'plus-model-admission-v1',id:'phased-native-admission',definitionHash:recipe.compiled.definitionHash,
    bindingHash:recipe.config.bindingHash,scopeKey:recipe.compiled.definition.scope.key,classification:'SYNTHETIC',task:'STATE_ESTIMATION',clockHash:digest(protocol.payload.configuration.clock)};
  const config={storage:f.storage,tenantId:ctx.tenantId,evaluations:f.evaluations,recipes:f.recipes,
    authorize:async p=>[trainer.id,owner.id].includes(p.id),policyFor:async()=>structuredClone(policy),authorizationRevision:authority,clock:f.evaluationConfig.clock};
  const decisions=new NativeModelDecision(config),phase=createNativeReadQualificationPhase({storage:f.storage,tenantId:ctx.tenantId,readers:[f.recipes,f.compute,decisions],authorizationRevision:authority});
  const configure=enabled=>{for(const c of [config,f.evaluationConfig,f.protocolConfig,f.computeConfig])c.readQualificationPhase=enabled?phase:undefined;};configure(true);
  const validate=f.recipes.validate.bind(f.recipes),run=f.evaluationConfig.evaluator.run,material=decisions.materialQualified.bind(decisions);
  f.recipes.validate=async(...args)=>{state.validations++;return validate(...args);};
  f.evaluationConfig.evaluator.run=async(...args)=>{state.runs++;return run(...args);};
  decisions.materialQualified=async(...args)=>{const before=state.validations;try{return await material(...args);}finally{state.passes.push(state.validations-before);}};
  return {...f,state,config,decisions,configure,input:{key:policy.id,evaluationId:score.id,evaluationVersion:score.version,decision:'APPROVE',reason:'Independent phased native admission'}};
}
test('decision material phases reuse native recipe reads but preserve independent precommit checks and actual recomputation',async t=>{
  const f=await fixture(t),result=await f.decisions.decide(f.input,owner);
  assert.equal(f.state.runs,1);assert.equal(f.state.passes.length,2);assert.ok(f.state.passes.every(v=>v>0));
  assert.equal((await f.storage.queryObjects(ctx,'PlusDeployment',{and:[]})).totalCount,0);
  f.configure(false);f.state.validations=0;f.state.runs=0;
  const legacy=await f.decisions.read(result.id,owner,{recompute:true}),legacyCount=f.state.validations;assert.equal(f.state.runs,1);
  f.configure(true);f.state.validations=0;f.state.runs=0;f.state.passes=[];
  const current=await f.decisions.read(result.id,owner,{recompute:true}),count=f.state.validations;
  assert.deepEqual(current,legacy);assert.equal(f.state.runs,1);assert.equal(f.state.passes.length,2);
  assert.ok(count>0&&count<legacyCount,`${count} phased validations must be fewer than ${legacyCount} uncached`);
  const epoch=await f.storage.getReadRevision(ctx);await f.decisions.read(result.id,owner,{recompute:true});
  assert.equal(f.state.validations,count*2);assert.equal(f.state.runs,2);assert.equal(await f.storage.getReadRevision(ctx),epoch);
});
test('final decision authority withdrawal rolls back staged approval and current native mutation invalidates reads',async t=>{
  const f=await fixture(t),epoch=await f.storage.getReadRevision(ctx);let decisions=0;
  f.config.authorize=async(_p,permission)=>{if(permission==='model:decide'&&++decisions===2)f.state.revision++;return true;};
  await assert.rejects(()=>f.decisions.decide(f.input,owner),/AUTHORITY_STALE/);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.storage.queryObjects(ctx,'PlusModelDecision',{and:[]})).totalCount,0);
  f.config.authorize=async()=>true;const accepted=await f.decisions.decide(f.input,owner);
  const validate=f.recipes.validate.bind(f.recipes);let mutate=true;
  f.recipes.validate=async(...args)=>{const value=await validate(...args);if(mutate){mutate=false;const root=await f.storage.getObject(ctx,'Machine',f.root._id);await f.storage.updateObject(ctx,'Machine',root._id,{priority:root.priority},root._version);}return value;};
  await assert.rejects(()=>f.decisions.read(accepted.id,owner),/CONFLICT/);
  assert.equal((await f.storage.queryObjects(ctx,'PlusModelDecision',{and:[]})).totalCount,1);
});
