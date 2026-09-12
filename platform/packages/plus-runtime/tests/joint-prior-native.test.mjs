import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalJson,digest} from '@openfoundry/plus-contracts';
import {ctx,owner} from './model-evaluation-fixture.mjs';
import {jointBeliefNativeFixture,enumerateJointPaths,close} from './joint-belief-native-fixture.mjs';

// Paired synthetic native replicas, not two priors silently applied to one
// approved artifact. Each prior is declared BEFORE recipe review/FIT/heldout
// evaluation/admission/selection/consent. Same semantic training and public
// reports; different native ids. Only observation channels are fitted.
for(const equivalent of [false,true])test(`native approved prior sensitivity: ${equivalent?'equivalent mechanisms remain prior dependent':'same evidence gives matching Bayes factors and different joint posteriors'}`,async t=>{
  const priors=[.2,.8],reports=['READY','READY','BUSY','READY'],paired=[];
  for(const persistentPrior of priors){
    const f=await jointBeliefNativeFixture(t,equivalent,{persistentPrior});
    close(f.recipe.baseline.hypotheses[0].prior,persistentPrior);close(f.candidate.spec.hypotheses[0].prior,persistentPrior);
    assert.deepEqual(f.candidate.spec.hypotheses.map(h=>h.transition),f.recipe.baseline.hypotheses.map(h=>h.transition));
    assert.notDeepEqual(f.candidate.spec.hypotheses[0].channels,f.recipe.baseline.hypotheses[0].channels);
    let version=0;const steps=[];
    for(const [i,value]of reports.entries()){
      f.advance(21+i);await f.add({rootId:f.root._id,origin:'paired-prior-source-'+i,value,minute:21+i,received:21+i});
      const input=await f.capture(21+i,'prior-'+i),publicInput=await f.runtime.readCurrentTemporalInput(input._id,owner);
      assert.equal(publicInput.temporal.temporalInput.events.length,i+1);
      assert.ok(publicInput.temporal.temporalInput.events.every(e=>e.event.kind==='OBSERVATION'));
      const response=await f.beliefs.replay({authorizationId:f.consent.id,snapshotId:input._id,expectedVersion:version},owner);version=response.headVersion;
      const current=await f.beliefs.readCurrent(f.key,f.episode._id,owner),expected=enumerateJointPaths(f.candidate.spec,reports.slice(0,i+1));
      for(const row of current.record.explanation.joint)close(row.p,expected.joint.get(canonicalJson([row.mechanism,row.state])));
      close(current.record.distribution.logEvidence,expected.logEvidence);
      const posterior=current.record.explanation.mechanisms.find(m=>m.key==='persistent').p;
      if(equivalent)close(posterior,persistentPrior);
      steps.push({joint:current.record.explanation.joint,posterior,bayesFactor:posterior/(1-posterior)/(persistentPrior/(1-persistentPrior))});
      assert.deepEqual(await f.storage.getObject(ctx,'Machine',f.root._id),f.root);
    }
    const withoutPrior=spec=>({...spec,hypotheses:spec.hypotheses.map(({prior,...h})=>h)});
    paired.push({prior:persistentPrior,recipeHash:digest(f.recipe),baseline:withoutPrior(f.recipe.baseline),fitted:withoutPrior(f.candidate.spec),steps});
  }
  assert.deepEqual(paired[0].baseline,paired[1].baseline,'Reviewed mechanism support differs only in the declared prior');
  assert.deepEqual(paired[0].fitted,paired[1].fitted,'Both real fits give identical non-prior model parameters');
  assert.notEqual(paired[0].recipeHash,paired[1].recipeHash,'A different prior cannot reuse an old approved recipe hash');
  const sensitivity=reports.map((_report,i)=>{
    const [a,b]=paired.map(p=>p.steps[i]);close(a.bayesFactor,b.bayesFactor);
    const totalVariation=a.joint.reduce((sum,row)=>sum+Math.abs(row.p-b.joint.find(other=>canonicalJson([other.mechanism,other.state])===canonicalJson([row.mechanism,row.state])).p),0)/2;
    assert.ok(totalVariation>0.1,'The diagnostic must expose material prior sensitivity, not claim a uniquely identified mechanism');
    return {step:i+1,persistentPosteriorRange:[a.posterior,b.posterior],jointTotalVariation:totalVariation,bayesFactor:a.bayesFactor};
  });
  if(!equivalent)assert.ok(sensitivity.slice(1).some(s=>Math.abs(s.bayesFactor-1)>1e-5));
  console.info('[native-prior-sensitivity] '+JSON.stringify({schema:'plus-native-prior-sensitivity-evidence-v1',
    scope:'PAIRED_SYNTHETIC_NATIVE_REPLICAS_NOT_DEPLOYED_TASK_UI',equivalent,priors,recipeHashes:paired.map(p=>p.recipeHash),sensitivity}));
});
