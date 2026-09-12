import test from 'node:test';
import assert from 'node:assert/strict';
import {startPlusHarness} from './plus-harness.mjs';
import {trainPolicy,identityPolicy,metrics,calibrate} from '../src/policy-learning.mjs';
import {createNativeStorage} from '../src/native-storage.mjs';
import {join} from 'node:path';

test('calibration learner changes actual parameters and rejects degraded outcomes',()=>{
  const good=trainPolicy([{caseId:'a',p:.5,y:0},{caseId:'b',p:.5,y:1}]);assert.equal(good.evaluation.passed,true);
  const bad=trainPolicy(Array.from({length:20},(_,i)=>({caseId:'bad'+i,p:.1,y:1})));assert.equal(bad.evaluation.passed,false);assert.notEqual(bad.artifact.b,0);
  assert.notEqual(calibrate(bad.artifact,.2),calibrate(identityPolicy,.2));assert.ok(metrics(bad.artifact).brier>metrics(identityPolicy).brier);
});

test('full native Plus: ontology publishing, atomic mapped import, real P33, governed action and two learning rounds', {timeout:180000}, async t=>{
  const h=await startPlusHarness(t),{good,call}=h;
  const initial=await good('/state');
  const baseline=initial.objects.DecisionPolicy.items[0];
  const draft=await good('/plus/draftOntology','data_reviewer',{type:'Matter',fields:[{name:'exposure',type:'Float'}]});
  await good('/plus/publishOntology','model_owner',{id:draft.receipt.resultId});
  assert.equal((await good('/state')).ontology.objectTypes.find(t=>t.name==='Matter').fields.some(f=>f.name==='exposure'),true);
  const rows=Array.from({length:4},(_,i)=>({编号:'FULL-'+i,标题:'Full scenario '+i,currentState:'EVIDENCE_COMPLETE',evidence:'Synthetic evidence '+i,exposure:100+i}));
  const mapping={matterNumber:'编号',title:'标题'};
  const imported=await good('/plus/importBatch','investigator',{rows,mapping,source:'synthetic-acceptance-batch'},'full-import-one');
  assert.equal((await good('/plus/importBatch','investigator',{rows,mapping,source:'synthetic-acceptance-batch'},'full-import-one')).replayed,true);
  let s=await good('/state');assert.equal(s.objects.Matter.totalCount,4);assert.equal(s.objects.Matter.items[0].exposure,100);
  assert.equal((await call('/plus/importBatch','investigator',{rows:[{...rows[0],编号:'should-rollback'},{...rows[0]}],mapping,source:'bad-batch'})).status,409);
  assert.equal((await good('/state')).objects.Matter.totalCount,4,'No partially imported first row');
  const analysis=await good('/plus/analyse','viewer',{query:'未核验'});assert.equal(analysis.rows.length,4);
  assert.equal((await call('/plus/analyse','viewer',{query:'delete all objects'})).status,400);
  const policies=[];
  for(let i=0;i<4;i++){
    const matter=s.objects.Matter.items[i], detail=await good('/objects/Matter/'+matter._id);
    const observation=s.objects.Observation.items.find(o=>detail.links.some(l=>l._toId===o._id));
    await good('/actions/NativeVerifyObservation','data_reviewer',{observation:observation._id,expectedVersion:observation._version});
    const options=[{name:'No request',query:{l:1,f:0,prev_action:0,requested_action:0,lawfulness:1},costAct:2,costRefrain:8,interventionCost:0},{name:'Request action',query:{l:1,f:1,prev_action:0,requested_action:1,lawfulness:1},costAct:2,costRefrain:8,interventionCost:1}];
    const simulation=await good('/plus/simulate','investigator',{matter:matter._id,observation:observation._id,expectedVersion:matter._version,options,demonstrations:[]});
    assert.equal(simulation.prediction.parameters,25826);assert.match(simulation.prediction.checkpointHash,/^[a-f0-9]{64}$/);
    assert.equal((await good('/objects/Matter/'+matter._id)).object._version,1,'Simulation does not mutate facts');
    const proposal=await good('/plus/propose','investigator',{simulation:simulation.receipt.resultId,toState:'RETENTION_REQUIRED',rationale:'Synthetic governed choice, not legal advice'});
    await good('/actions/NativeReviewTransition','case_reviewer',{matter:matter._id,proposal:proposal.receipt.resultId,observation:observation._id,expectedVersion:2,decision:'APPROVE',note:'Independent synthetic review'});
    assert.equal((await call('/plus/recordOutcome','investigator',{simulation:simulation.receipt.resultId,optionIndex:1,actual:i%2,evidence:'Wrong selected option'})).status,409);
    const outcome=await good('/plus/recordOutcome','investigator',{simulation:simulation.receipt.resultId,optionIndex:0,actual:i%2,evidence:'Synthetic observed behavior case '+i});
    assert.equal((await call('/plus/qualifyOutcome','investigator',{id:outcome.receipt.resultId,note:'self review',privacyConfirmed:true})).status,403);
    await good('/plus/qualifyOutcome','data_reviewer',{id:outcome.receipt.resultId,note:'Independent synthetic result verified',privacyConfirmed:true});
    if(i%2===1){const trained=await good('/plus/trainPolicy','trainer',{});policies.push(trained);assert.ok(trained.evaluation.datasetHash);if(trained.evaluation.passed)await good('/plus/publishPolicy','model_owner',{id:trained.receipt.resultId});}
  }
  s=await good('/state');assert.equal(s.objects.OutcomeRecord.items.filter(o=>o.status==='VERIFIED').length,4);
  assert.equal(s.objects.FeedbackEvent.items.filter(f=>f.eligibility==='ELIGIBLE').length,4);
  assert.equal(policies.length,2);assert.equal(s.objects.DecisionPolicy.items.length,3);
  assert.notEqual(s.objects.DecisionPolicy.items[1].artifactJson,baseline.artifactJson,'Learning updates real calibration parameters');
  const revoked=s.objects.OutcomeRecord.items.filter(o=>o.actual===0);
  for(const outcome of revoked)await good('/plus/withdrawOutcome','data_reviewer',{id:outcome._id,note:'Synthetic negative-label feedback withdrawn to test release guard'});
  assert.equal((await good('/state')).objects.DecisionPolicy.items.some(p=>p.stage==='SUSPENDED'),true);
  assert.equal((await call('/plus/trainPolicy','trainer',{})).status,409,'Revoked active dataset suspends model use');
  const active=s.objects.DecisionPolicy.items.find(p=>p.stage==='ACTIVE');
  if(active._id!==baseline._id){await good('/plus/rollbackPolicy','model_owner',{id:baseline._id});assert.equal((await good('/state')).objects.DecisionPolicy.items.find(p=>p.stage==='ACTIVE')._id,baseline._id);}
  const degraded=await good('/plus/trainPolicy','trainer',{});
  assert.equal(degraded.evaluation.passed,false,'Biased real qualified outcomes produce a degraded candidate');
  assert.equal((await call('/plus/publishPolicy','model_owner',{id:degraded.receipt.resultId})).status,409,'Native release refuses the actually degraded candidate');
  // Simulate offline storage corruption in this disposable test database.
  // A forged passed flag must not bypass deterministic recomputation.
  const disk=createNativeStorage(join(h.dir,'native.sqlite')),ctx={tenantId:'lwm-demo',traceId:'test-corruption'};
  try{
    const original=await disk.getObject(ctx,'DecisionPolicy',degraded.receipt.resultId);
    await disk.updateObject(ctx,'DecisionPolicy',original._id,{stage:'CANDIDATE',evaluationJson:JSON.stringify({...JSON.parse(original.evaluationJson),passed:true})},original._version);
    const denied=await call('/plus/publishPolicy','model_owner',{id:original._id});assert.equal(denied.status,409);assert.equal(denied.error.code,'EVALUATION_TAMPER');
    await disk.updateObject(ctx,'DecisionPolicy',original._id,{stage:original.stage,evaluationJson:original.evaluationJson},original._version+1);
  }finally{disk.close();}
  assert.equal((await good('/state')).audit.some(a=>a.detail.result==='denied'),true);
  const before=await good('/state');await h.restart();const recovered=await good('/state');
  assert.deepEqual(recovered.objects,before.objects);assert.equal(recovered.plus.ontology.version,before.plus.ontology.version);
  assert.equal(recovered.ontology.objectTypes.find(t=>t.name==='Matter').fields.find(f=>f.name==='exposure').type.name,'Float');
  console.log('PLUS_EVIDENCE '+JSON.stringify({rounds:policies.map(p=>p.evaluation),degraded:degraded.evaluation,releaseDenied:true,feedbackWithdrawalSuspends:true,model:'P33 pretrained checkpoint',nativeFeedback:4,restart:true}));
});
