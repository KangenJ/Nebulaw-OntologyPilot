import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '@openfoundry/plus-contracts';
import { assertNativeActionParameters } from '@openfoundry/actions';
import { NativeActionRequests,NativeScenarioRuntime } from '../dist/index.js';
import { beliefFixture } from './belief-fixture.mjs';
import { principal,ctx,at } from './episode-fixture.mjs';
import { createPublishedVerificationPlanner } from '../../../../services/plus-engine/verification-planning.mjs';

const reviewer={...principal,id:'independent-case-reviewer',roles:['case_reviewer']};
// Native published three-category ontology, real belief/planner, actual request,
// decision, links and SQLite. Belief fixture labels upstream model governance
// doubles. The fixture's VerifyObject inspector reads real native definitions
// and references; this is not the Task registration adapter or an HTTP workflow.
async function fixture(t){
  const f=await beliefFixture(t),belief=await f.beliefs.replay(f.input,principal),state={allow:true,epoch:1,clock:Date.parse(at(12)),inspections:0,beforeInspect:async()=>{}};
  const authority=async()=>digest({upstream:await f.bc.authorizationRevision(),allow:state.allow,epoch:state.epoch});
  const scenarios=new NativeScenarioRuntime({storage:f.storage,tenantId:ctx.tenantId,beliefs:f.beliefs,definitions:f.definitions,recipes:f.bc.recipes,compute:f.bc.compute,
    authorize:async()=>state.allow,policyFor:async()=>({version:'plus-verification-scenario-policy-v1',id:'synthetic-review',definitionKeys:[f.compiled.definition.key],scopeKeys:[f.compiled.definition.scope.key],classifications:['SYNTHETIC']}),
    authorizationRevision:authority,planner:createPublishedVerificationPlanner(),clock:()=>Date.parse(at(10))});
  const scenario=await scenarios.compare({key:'unit.belief',episodeId:f.episode._id,beliefId:belief.beliefId,requestKey:'request-fixture-scenario',availabilityProbability:.5},principal);
  const config={storage:f.storage,tenantId:ctx.tenantId,scenarios,authorizationRevision:authority,clock:()=>state.clock,
    authorize:async(_p,_permission,scope)=>state.allow&&scope.key==='unit.belief'&&scope.episodeId===f.episode._id&&scope.scenarioId===scenario.id&&scope.actionName==='VerifyObject',
    inspectAction:async(p,input,record)=>{
      state.inspections++;await state.beforeInspect();const catalog=await f.catalog.read(p),root=await f.storage.getObject(ctx,'Machine',f.root._id);
      assert.equal(input.actionName,'VerifyObject');assertNativeActionParameters(catalog.bundle.parsed.actionTypes.find(a=>a.name===input.actionName),input.params,catalog.bundle.parsed);
      assert.equal(input.params.task,root._id);assert.equal(input.params.expectedVersion,root._version);
      const episode=await f.storage.getObject(ctx,'PlusEpisode',f.episode._id),links=await f.storage.getLinks(ctx,episode._id,'MachineEpisode','inbound');
      assert.equal(links.totalCount,1);assert.equal(links.items[0]._fromId,root._id);
      return {schema:'plus-native-action-inspection-v1',adapterId:'synthetic-native-VerifyObject-inspector',actionName:input.actionName,paramsHash:digest(input.params),ontologyHash:catalog.bundle.contentHash,
        manifestHash:digest(catalog.bundle.manifests[input.actionName]),classification:root.classification,readSet:{root:f.ref(root),episode:f.ref(episode),links:links.items.map(f.ref),policyHash:digest('reviewed-synthetic-purpose')},notBefore:record.plans.createdAt};
    }};
  const input={scenarioId:scenario.id,optionKey:'REQUEST_VERIFICATION',actionName:'VerifyObject',params:{task:f.root._id,expectedVersion:f.root._version,note:'Synthetic requested check; no outcome supplied'},reason:'Human selected an additional check',requestKey:'first-request'};
  return {...f,requestState:state,requestConfig:config,requests:new NativeActionRequests(config),requestInput:input,scenario};
}
const decide=(r,decision='APPROVE',reason='Independent synthetic review')=>({requestId:r.id,expectedVersion:r.version,decision,reason});

test('an adaptive strategy cannot become executable by attaching a same-time option key',async t=>{
  const f=await fixture(t),original=f.requestConfig.scenarios.read.bind(f.requestConfig.scenarios),epoch=await f.storage.getReadRevision(ctx);
  // Explicit malicious-provider injection tests the action admission boundary,
  // not an actual adaptive record (which has no executable options at all).
  f.requestConfig.scenarios={read:async(...args)=>{const r=structuredClone(await original(...args));r.record.predictions.schema='plus-adaptive-verification-comparison-v1';return r;}};
  await assert.rejects(()=>new NativeActionRequests(f.requestConfig).submit(f.requestInput,principal),/ACTION_REQUEST_SCENARIO_INVALID/);
  assert.equal(f.requestState.inspections,0);
  assert.equal((await f.rows('PlusActionRequest')).totalCount,0);assert.equal(await f.storage.getReadRevision(ctx),epoch);
});

test('native proposal and distinct human decision persist immutable basis, exact links and redacted journals without any action or fact execution',async t=>{
  const f=await fixture(t),before=await f.storage.getObject(ctx,'Machine',f.root._id),r=await f.requests.submit(f.requestInput,principal);
  assert.equal(r.status,'PROPOSED');assert.equal(r.executionAuthorized,false);const epoch=await f.storage.getReadRevision(ctx);
  assert.equal((await f.requests.submit(f.requestInput,principal)).id,r.id);assert.equal(await f.storage.getReadRevision(ctx),epoch);
  const approved=await f.requests.decide(decide(r),reviewer);assert.equal(approved.status,'APPROVED');assert.equal(approved.executionAuthorized,false);
  const read=await new NativeActionRequests({...f.requestConfig,storage:f.openStorage()}).read(r.id,reviewer);
  assert.equal(read.currentBasisChecked,false);assert.equal(read.executionAuthorized,false);assert.equal(read.decision.inputVersion,1);
  assert.equal(read.decision.decidedBy,reviewer.id);assert.equal(read.record.submittedBy,principal.id);assert.equal(read.decision.requestHash,read.record.requestHash);
  assert.equal((await f.storage.getLinks(ctx,r.id,'PlusRequestScenario','outbound')).items[0]._toId,f.scenario.id);
  assert.equal((await f.storage.getLinks(ctx,r.id,'PlusRequestDecision','outbound')).items[0]._toId,approved.decisionId);
  const after=await f.storage.getReadRevision(ctx);assert.equal((await f.requests.decide(decide(r),reviewer)).replayed,true);assert.equal(await f.storage.getReadRevision(ctx),after);
  read.record.typedParams.note='FORGED';assert.notEqual((await f.requests.read(r.id,principal)).record.typedParams.note,'FORGED');
  assert.deepEqual(await f.storage.getObject(ctx,'Machine',f.root._id),before);assert.equal((await f.rows('PlusActionRequest')).totalCount,1);assert.equal((await f.rows('PlusActionDecision')).totalCount,1);
  const journal=(await f.rows('PlusOutbox')).items.filter(o=>['PlusSubmitActionRequest','PlusDecideActionRequest'].includes(o.envelope.audit.operation.actionType));assert.equal(journal.length,2);
  assert.equal(JSON.stringify(journal).includes(f.requestInput.params.note),false);assert.equal(JSON.stringify(journal).includes(f.requestInput.reason),false);
});

test('exact request shapes, independent actors, native action parameter types, version and idempotency content are enforced',async t=>{
  const f=await fixture(t),before=await f.storage.getReadRevision(ctx);
  for(const input of [{...f.requestInput,decision:'APPROVE'},{...f.requestInput,executionReceipt:{}},{...f.requestInput,optionKey:'NO_ADDITIONAL_VERIFICATION'},
    {...f.requestInput,params:{...f.requestInput.params,expectedVersion:'1'}},{...f.requestInput,params:{...f.requestInput.params,result:'DONE'}},
    {...f.requestInput,params:{...f.requestInput.params,task:{_id:f.root._id}}}])await assert.rejects(()=>f.requests.submit(input,principal));
  await assert.rejects(()=>f.requests.submit(f.requestInput,reviewer),/FORBIDDEN/);assert.equal(await f.storage.getReadRevision(ctx),before);
  const r=await f.requests.submit(f.requestInput,principal);
  await assert.rejects(()=>f.requests.submit({...f.requestInput,reason:'Different command'},principal),/KEY_CONFLICT/);
  await assert.rejects(()=>f.requests.decide(decide(r),{...principal,roles:['investigator','case_reviewer']}),/INDEPENDENT_REVIEW_REQUIRED/);
  await assert.rejects(()=>f.requests.decide({...decide(r),expectedVersion:2},reviewer),/VERSION_CONFLICT/);
  await assert.rejects(()=>f.requests.decide({...decide(r),decidedBy:reviewer.id},reviewer),/INVALID_INPUT/);
  await f.requests.decide(decide(r,'REJECT'),reviewer);await assert.rejects(()=>f.requests.decide(decide(r),reviewer),/DECISION_CONFLICT/);
  assert.equal((await f.rows('PlusActionDecision')).totalCount,1);
});

test('model withdrawal blocks approval but not an authorized human rejection; historical reads never advertise current execution permission',async t=>{
  const f=await fixture(t),r=await f.requests.submit(f.requestInput,principal);f.state.active=false;
  await assert.rejects(()=>f.requests.decide(decide(r),reviewer),/STALE/);assert.equal((await f.requests.read(r.id,reviewer)).status,'PROPOSED');
  const rejected=await f.requests.decide(decide(r,'REJECT','Model basis withdrawn'),reviewer);assert.equal(rejected.status,'REJECTED');
  assert.equal((await f.requests.read(r.id,reviewer)).currentBasisChecked,false);
  f.requestState.allow=false;await assert.rejects(()=>f.requests.read(r.id,reviewer),/FORBIDDEN/);
});

test('new native source or changed inspection basis prevents approval, while immutable old request remains auditable',async t=>{
  const f=await fixture(t),r=await f.requests.submit(f.requestInput,principal);await f.add({origin:'after-request',minute:2});
  await assert.rejects(()=>f.requests.decide(decide(r),reviewer),/STALE|CURRENT_CAPTURE_REQUIRED/);assert.equal((await f.requests.read(r.id,principal)).status,'PROPOSED');
  const g=await fixture(t),s=await g.requests.submit(g.requestInput,principal),original=g.requestConfig.inspectAction;
  g.requestConfig.inspectAction=async(...args)=>{const x=await original(...args);x.readSet.policyHash=digest('different-reviewed-purpose');return x;};
  await assert.rejects(()=>g.requests.decide(decide(s),reviewer),/ACTION_REQUEST_STALE/);assert.equal((await g.rows('PlusActionDecision')).totalCount,0);
});

test('authority and native changes during qualification cannot submit, and audit failure rolls back proposal and link',async t=>{
  const f=await fixture(t);f.requestState.beforeInspect=async()=>{f.requestState.epoch++;};
  await assert.rejects(()=>f.requests.submit(f.requestInput,principal),/AUTHORITY_STALE/);assert.equal((await f.rows('PlusActionRequest')).totalCount,0);
  f.requestState.beforeInspect=async()=>{const root=await f.storage.getObject(ctx,'Machine',f.root._id);await f.storage.updateObject(ctx,'Machine',root._id,{status:'changed'},root._version);};
  await assert.rejects(()=>f.requests.submit(f.requestInput,principal));assert.equal((await f.rows('PlusActionRequest')).totalCount,0);
  const g=await fixture(t),broken=new Proxy(g.storage,{get(target,k){if(k!=='beginTransaction')return target[k];return async context=>{
    const tx=await target.beginTransaction(context);return new Proxy(tx,{get(t,k){if(k!=='createObject')return t[k];return async(type,...args)=>{if(type==='PlusOutbox')throw new Error('injected-request-journal');return t.createObject(type,...args);};}});};}});
  await assert.rejects(()=>new NativeActionRequests({...g.requestConfig,storage:broken}).submit(g.requestInput,principal),/injected-request-journal/);assert.equal((await g.rows('PlusActionRequest')).totalCount,0);
});

test('permission withdrawal after the decision and request state are staged rolls back both with their journal',async t=>{
  const f=await fixture(t),r=await f.requests.submit(f.requestInput,principal),before=await f.storage.getReadRevision(ctx);
  const guarded=new Proxy(f.storage,{get(target,k){if(k!=='beginTransaction')return target[k];return async context=>{const tx=await target.beginTransaction(context);
    return new Proxy(tx,{get(t,k){if(k!=='createObject')return t[k];return async(type,...args)=>{const row=await t.createObject(type,...args);if(type==='PlusOutbox')f.requestState.allow=false;return row;};}});};}});
  await assert.rejects(()=>new NativeActionRequests({...f.requestConfig,storage:guarded}).decide(decide(r),reviewer),/FORBIDDEN|AUTHORITY_STALE/);
  assert.equal(await f.storage.getReadRevision(ctx),before);assert.equal((await f.rows('PlusActionDecision')).totalCount,0);assert.equal((await f.rows('PlusActionRequest')).items[0].status,'PROPOSED');
});

test('concurrent approval and rejection commit exactly one decision and one corresponding status',async t=>{
  const f=await fixture(t),r=await f.requests.submit(f.requestInput,principal),answers=await Promise.allSettled([f.requests.decide(decide(r),reviewer),f.requests.decide(decide(r,'REJECT'),{...reviewer,id:'other-reviewer'})]);
  assert.equal(answers.filter(x=>x.status==='fulfilled').length,1);assert.equal((await f.rows('PlusActionDecision')).totalCount,1);
  const read=await f.requests.read(r.id,principal);assert.equal(read.status,read.decision.decision==='APPROVE'?'APPROVED':'REJECTED');
});

test('decision tampering, missing links, tenant substitution and backward clocks never turn a stored proposal into execution authorization',async t=>{
  const f=await fixture(t),r=await f.requests.submit(f.requestInput,principal);
  f.requestState.clock=Date.parse(at(11));await assert.rejects(()=>f.requests.decide(decide(r),reviewer),/CLOCK_ORDER/);f.requestState.clock=Date.parse(at(13));
  const d=await f.requests.decide(decide(r),reviewer);await f.storage.updateObject(ctx,'PlusActionDecision',d.decisionId,{reason:'forged'},1);
  await assert.rejects(()=>f.requests.read(r.id,principal),/DECISION_INTEGRITY/);
  await assert.rejects(()=>f.requests.read(r.id,{...principal,tenantId:'foreign'}),/FORBIDDEN/);
  const g=await fixture(t),s=await g.requests.submit(g.requestInput,principal),link=(await g.storage.getLinks(ctx,s.id,'PlusRequestScenario','outbound')).items[0];
  await g.storage.deleteLink(ctx,'PlusRequestScenario',link._id);await assert.rejects(()=>g.requests.read(s.id,principal),/LINK_INVALID/);
});
