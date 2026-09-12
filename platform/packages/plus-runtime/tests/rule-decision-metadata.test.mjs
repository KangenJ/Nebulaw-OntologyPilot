import test from 'node:test';
import assert from 'node:assert/strict';
import {ruleFixture,author,owner,ctx} from './rule-registry-fixture.mjs';
import {NativeRuleRegistry} from '../dist/index.js';
import {digest} from '../../plus-contracts/dist/index.js';
import {nativeRuleSpecificationHash} from '../../../apps/lwm-demo/public-plus/native-rule-ui.js';

test('browser rule fingerprint matches actual native canonical artifact; historical receipt survives source withdrawal without granting use',async t=>{
  const f=await ruleFixture(t),approved=await f.approve();assert.equal(await nativeRuleSpecificationHash(f.input.specification),approved.specificationHash);
  assert.equal(approved.specificationHash,digest(f.input.specification));
  f.state.sourceReadable=false;
  await assert.rejects(()=>f.registry.readRevision(f.input.key,approved.id,owner));await assert.rejects(()=>f.registry.requireApproved(approved.specificationHash,owner));
  const m=await f.registry.decisionMetadata(f.input.key,approved.id,owner);assert.equal(m.status,'APPROVED');assert.equal(m.decision.actorId,owner.id);assert.equal(m.qualification,'NOT_CHECKED');assert.equal(m.readOnly,true);assert.equal(m.predictionReady,false);assert.equal(m.executionAuthorized,false);
  for(const k of ['specification','nativeRules','source','policy','compiled'])assert.equal(Object.hasOwn(m,k),false,k);
  assert.deepEqual(await f.reopen().registry.decisionMetadata(f.input.key,approved.id,owner),m);
  f.state.allow=false;await assert.rejects(()=>f.registry.decisionMetadata(f.input.key,approved.id,owner));
});
test('source-invalid draft can be independently rejected and original decision retained; self review still refused',async t=>{
  const f=await ruleFixture(t),draft=await f.registry.propose(f.input,author);f.state.sourceReadable=false;
  await assert.rejects(()=>f.registry.review(draft.id,draft.version,'APPROVE','Unavailable source',owner));
  await assert.rejects(()=>f.registry.review(draft.id,draft.version,'REJECT','Self rejection',author));
  const r=await f.registry.review(draft.id,draft.version,'REJECT','Source is no longer qualified',owner),m=await f.registry.decisionMetadata(f.input.key,r.id,owner);
  assert.equal(m.status,'REJECTED');assert.equal(m.decision.fromVersion,draft.version);assert.equal(m.decision.reason,'Source is no longer qualified');
});
test('decision metadata checks exact key, full native integrity and late authority revision',async t=>{
  const f=await ruleFixture(t),r=await f.approve();await assert.rejects(()=>f.registry.decisionMetadata('wrong',r.id,owner));
  let calls=0;const registry=new NativeRuleRegistry({...f.config,authorizationRevision:async()=>String(++calls)});
  await assert.rejects(()=>registry.decisionMetadata(f.input.key,r.id,owner),/AUTHORITY/);
  // Adversarial corruption only in an isolated fixture, not a normal write path.
  await f.storage.updateObject(ctx,'PlusRuleSpecification',r.id,{submittedBy:'forged-author'},r.version);
  await assert.rejects(()=>f.registry.decisionMetadata(f.input.key,r.id,owner));
});
