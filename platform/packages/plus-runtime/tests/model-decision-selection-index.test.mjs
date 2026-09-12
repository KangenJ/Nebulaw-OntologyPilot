import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeModelDecision} from '../dist/index.js';
import {modelAdmissionFixture as fixture,admissionOwner as owner,ctx} from './model-admission-fixture.mjs';

// Native catalog checks. Upstream evaluator/recipe are explicit fixture doubles;
// discovery MUST NOT call them, and never claims usable model qualification.
test('native full-model decision directory is read-only metadata, preserving rejected/revoked records and current policy mismatch',async t=>{
  const f=await fixture(t),approved=await f.decisions.decide(f.input,owner),second=await f.candidate('rejected',true);
  await f.decisions.decide({...f.input,evaluationId:second.evaluation._id,evaluationVersion:second.evaluation._version,decision:'REJECT'},owner);
  f.state.beforeRead=async()=>assert.fail('metadata discovery must not traverse model material');
  const epoch=await f.storage.getReadRevision(ctx),index=await f.decisions.listForSelection(f.input.key,owner);
  assert.equal(index.items.length,2);assert.equal(index.predictionReady,false);assert.equal(index.modelDeploymentAuthorized,false);
  assert.ok(index.items.every(v=>v.qualification==='NOT_CHECKED'&&v.configuredPolicyMatches));assert.equal(await f.storage.getReadRevision(ctx),epoch);
  for(const field of ['inputReadSet','reason','unit governance only','createdBy'])assert.equal(JSON.stringify(index).includes(field),false);
  await f.decisions.revoke(approved.id,approved.version,'Withdraw approval',owner);
  const restored=new NativeModelDecision({...f.config,storage:f.openStorage()}),revoked=(await restored.listForSelection(f.input.key,owner)).items.find(v=>v.id===approved.id);
  assert.equal(revoked.revoked,true);assert.equal(revoked.recordedReadiness,'SUSPENDED');
  f.policy.id='new-policy';assert.ok((await restored.listForSelection(f.input.key,owner)).items.every(v=>!v.configuredPolicyMatches));
  assert.equal((await restored.listForSelection('unpopulated-key',owner)).items.length,0);
});

test('native decision discovery rejects permission, authority, clock and native-version races and component-only scopes',async t=>{
  const f=await fixture(t);await f.decisions.decide(f.input,owner);
  for(const mode of ['permission','authority','clock','native']){
    let calls=0,injected=false;const now=f.config.clock();
    const config={...f.config,authorize:async()=>{if(++calls===2){injected=true;
      if(mode==='authority')f.state.epoch++;
      if(mode==='clock')config.clock=()=>now-1;
      if(mode==='native'){const root=await f.storage.getObject(ctx,'Machine',f.root._id);await f.storage.updateObject(ctx,'Machine',root._id,{priority:Number(root.priority)+1},root._version);}
      if(mode==='permission')return false;
    }return true;}};
    await assert.rejects(()=>new NativeModelDecision(config).listForSelection(f.input.key,owner),/FORBIDDEN|AUTHORITY_STALE|CLOCK_ORDER|CONFLICT/);assert.equal(injected,true);
  }
  await assert.rejects(()=>new NativeModelDecision({...f.config,policyFor:async()=>({...f.policy,version:'plus-transition-component-admission-v1',task:'CONDITIONAL_TRANSITION',component:{}})}).listForSelection(f.input.key,owner),/COMPONENT_ONLY/);
});

test('decision directory rejects duplicate/truncated/foreign rows and broken native links rather than exposing a partial catalog',async t=>{
  const f=await fixture(t),approved=await f.decisions.decide(f.input,owner);
  for(const mode of ['duplicate','truncated','foreign','wrong-key','links']){
    let injected=0;const storage=new Proxy(f.storage,{get(target,property){
      if(property==='queryObjects')return async(...args)=>{const page=await target.queryObjects(...args);if(args[1]!=='PlusModelDecision')return page;
        injected++;if(mode==='duplicate')return {...page,items:[page.items[0],page.items[0]],totalCount:2};
        if(mode==='truncated')return {...page,hasNextPage:true};
        if(mode==='foreign'||mode==='wrong-key')return {...page,items:page.items.map(r=>({...r,...(mode==='foreign'?{_tenantId:'other'}:{policyKey:'other'})}))};return page;};
      if(property==='getLinks'&&mode==='links')return async(...args)=>{const page=await target.getLinks(...args);return args[1]===approved.id?{...page,items:[],totalCount:0}:page;};
      const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;
    }});
    await assert.rejects(()=>new NativeModelDecision({...f.config,storage}).listForSelection(f.input.key,owner),/COLLECTION_LIMIT|INTEGRITY|LINK_INVALID/);assert.ok(injected>0);
  }
});
