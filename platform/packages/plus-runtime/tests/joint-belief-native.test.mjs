import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalJson} from '@openfoundry/plus-contracts';
import {NativeBeliefRuntime} from '../dist/index.js';
import {ctx,owner,at} from './model-evaluation-fixture.mjs';
import {jointBeliefNativeFixture as fixture,enumerateJointPaths as enumerate,close} from './joint-belief-native-fixture.mjs';

for(const equivalent of [false,true])test(`native fitted finite support: four-step ${equivalent?'equivalent mechanisms remain unresolved':'joint state/mechanism matches independent path enumeration'} and survives reopen`,async t=>{
  const f=await fixture(t,equivalent),reports=['READY','READY','BUSY','READY'];let headVersion=0,previous,latest;
  assert.equal(f.candidate.spec.hypotheses.length,2);
  assert.deepEqual(f.candidate.spec.hypotheses.map(h=>h.transition),f.recipe.baseline.hypotheses.map(h=>h.transition),'Reviewed dynamics must not be presented as newly learned');
  assert.notDeepEqual(f.candidate.spec.hypotheses[0].channels,f.recipe.baseline.hypotheses[0].channels,'Observation fitting must actually change the channel');
  for(let i=0;i<reports.length;i++){
    const minute=21+i;f.advance(minute);
    await f.add({rootId:f.root._id,origin:'joint-new-source-'+i,value:reports[i],minute,received:minute});
    if(previous)await assert.rejects(()=>f.beliefs.readCurrent(f.key,f.episode._id,owner),/CURRENT_CAPTURE_REQUIRED/);
    const input=await f.capture(minute,String(i)),current=await f.runtime.readCurrentTemporalInput(input._id,owner);
    assert.equal(current.temporal.temporalInput.events.length,i+1);
    assert.ok(current.temporal.temporalInput.events.every(e=>e.event.kind==='OBSERVATION'),'No hidden true-state/GOLD reset in the online input');
    const command={authorizationId:f.consent.id,snapshotId:input._id,expectedVersion:headVersion};
    latest=await f.beliefs.replay(command,owner);assert.equal(latest.predictionReady,true);headVersion=latest.headVersion;
    const read=await f.beliefs.readCurrent(f.key,f.episode._id,owner),summary=read.record.explanation,expected=enumerate(f.candidate.spec,reports.slice(0,i+1));
    assert.equal(summary.joint.length,2*summary.states.length);
    for(const row of summary.joint)close(row.p,expected.joint.get(canonicalJson([row.mechanism,row.state])));
    close(read.record.distribution.logEvidence,expected.logEvidence);
    if(equivalent)for(const m of summary.mechanisms)close(m.p,m.key==='persistent'?.65:.35);
    if(previous)assert.deepEqual(await f.storage.getObject(ctx,'PlusBeliefSnapshot',previous._id),previous,'Earlier belief remains immutable');
    previous=read.record;
    assert.equal((await f.beliefs.replay(command,owner)).replayed,true);
    assert.deepEqual(await f.storage.getObject(ctx,'Machine',f.root._id),f.root);
  }
  const reopened=new NativeBeliefRuntime({...f.beliefConfig,storage:f.openStorage(),readQualificationPhase:undefined});
  assert.deepEqual((await reopened.readCurrent(f.key,f.episode._id,owner)).record,previous);
  assert.equal((await f.rows('PlusBeliefHead')).totalCount,1);assert.equal((await f.rows('PlusBeliefSnapshot')).totalCount,4);
  if(!equivalent){
    const summary=previous.explanation;
    assert.ok(summary.mechanisms.some(m=>Math.abs(m.p-(m.key==='persistent'?.65:.35))>1e-5),'New reports must actually update the mechanism posterior');
    assert.ok(summary.joint.some(row=>Math.abs(row.p-summary.mechanisms.find(m=>m.key===row.mechanism).p
      *summary.states.find(s=>canonicalJson(s.state)===canonicalJson(row.state)).p)>1e-5),'State/mechanism dependence must not collapse into separate marginals');
  }
  // A newly arrived native StatusCheck is explicitly qualified as GOLD by this
  // synthetic source policy, at the SAME historical target. It is not a hidden
  // per-step reset, nor a real-world verification-method validity claim.
  f.advance(25);
  const gold=await f.add({rootId:f.root._id,kind:'VERIFICATION',value:'BUSY',minute:24,received:25,origin:'joint-later-native-check'});
  await assert.rejects(()=>reopened.readCurrent(f.key,f.episode._id,owner),/CURRENT_CAPTURE_REQUIRED/);
  const goldInput=await f.capture(24,'later-gold'),qualified=await f.runtime.readCurrentTemporalInput(goldInput._id,owner);
  const checks=qualified.temporal.temporalInput.events.filter(e=>e.event.kind==='VERIFICATION');
  assert.equal(checks.length,1);assert.equal(checks[0].sourceReference.id,gold.source._id);
  assert.equal(checks[0].event.verificationMode,'GOLD');assert.equal(checks[0].event.receivedAt,at(25));
  await f.beliefs.replay({authorizationId:f.consent.id,snapshotId:goldInput._id,expectedVersion:headVersion},owner);
  const checked=await f.beliefs.readCurrent(f.key,f.episode._id,owner),expected=enumerate(f.candidate.spec,reports,'BUSY');
  close(checked.record.explanation.states.find(s=>s.state.state==='BUSY').p,1);
  for(const row of checked.record.explanation.joint)close(row.p,expected.joint.get(canonicalJson([row.mechanism,row.state])));
  if(equivalent)for(const m of checked.record.explanation.mechanisms)close(m.p,m.key==='persistent'?.65:.35);
  assert.deepEqual(await f.storage.getObject(ctx,'PlusBeliefSnapshot',previous._id),previous);
  assert.deepEqual(await f.storage.getObject(ctx,'Machine',f.root._id),f.root);
  assert.equal((await f.rows('PlusBeliefSnapshot')).totalCount,5);assert.equal((await f.rows('PlusBeliefHead')).totalCount,1);
  await f.authorizations.revoke(f.consent.id,f.consent.version,'Withdraw online purpose after the four-step native check',owner);
  await assert.rejects(()=>reopened.readCurrent(f.key,f.episode._id,owner),/SUSPENDED|STALE|REVOKED|NOT_APPROVED/);
});
