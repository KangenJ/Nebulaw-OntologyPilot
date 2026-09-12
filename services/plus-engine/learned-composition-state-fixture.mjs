import assert from 'node:assert/strict';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { ctx,trainer,reviewer,at } from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import { learnedCompositionTrainingFixture } from './learned-composition-fixture.mjs';
import { fitLearnedComposition } from './learned-composition.mjs';

// Actual native Task TRAIN/VALIDATION, source snapshots, prospective cohorts and
// independently reviewed GOLD. Synthetic domain grants and clock. This fixture
// does NOT approve a complete FIT, evaluation protocol, native action history or
// model deployment; it exercises the pure complete-kernel scoring prerequisite.
export async function learnedCompositionStateFixture(t,neural=false,{zeroStep=false,missing=false,protocolFactory,historyVersion}={}){
  const f=await learnedCompositionTrainingFixture(t,neural,{historyVersion}),s=f.services;
  const candidate=await fitLearnedComposition(f.recipe,f.materials,f.transitionMaterials,f.transitionCandidate);
  const protocol={...f.protocol,key:'learned-complete-state-heldout',partition:'VALIDATION',expectedSampleCount:2,
    inputVisibleFrom:at(31),inputVisibleUntil:at(32),labelReceivedFrom:at(34),labelReceivedUntil:at(37),approvalUntil:at(39),minimumCoverage:missing ? 0.5 : 1};
  f.policy.taskLearning.cohorts.push({workspace:'synthetic',protocol});for(const g of f.policy.taskLearning.grants)g.protocolKeys.push(protocol.key);
  f.advance(30);let root;
  for(let i=0;i<64;i++){
    const possible=await f.root('synthetic',undefined,30),seed=f.policy.taskLearning.partition.seed;
    const bucket=parseInt(digest([seed,ctx.tenantId,['task-matter-v1',digest(['synthetic',possible.matter._id])]]).slice(0,8),16)%10000;
    if(bucket>=6000&&bucket<7500){root=possible;break;}
  }
  assert.ok(root,'Validation group chosen before reports or GOLD');f.advance(32);const members=[],targetMinute=zeroStep?30:31;
  for(const [i,value]of ['DONE','NOT_DONE'].entries()){
    const current=i?await f.root('synthetic',root.matter,30):root;
    const report=await f.createSource(current.task,{record:'learned-state-heldout-'+i,result:value,eventMinute:targetMinute,received:31});
    const episode=await f.episodes.open({definitionKey:f.compiled.definition.key,rootId:current.task._id,startedAt:at(30)},trainer,'learned-state-heldout-episode-'+i);
    const input=await f.capture(episode,'learned-state-heldout-input-'+i,targetMinute);
    assert.equal((await s.partitions.reserve(input.record._id,trainer)).partition,'VALIDATION');
    members.push({task:current.task,report,episode,input,value});
  }
  const draft=await s.datasets.proposeCohort(protocol.key,members.map(m=>m.input.record._id),trainer);
  const cohort=await s.datasets.reviewCohort(draft.id,draft.version,'APPROVE','Freeze complete-state membership before independent labels',reviewer);
  // Optional actual protocol/FIT setup runs before any heldout GOLD is created.
  const evaluationSetup=await protocolFactory?.({...f,candidate,cohort,members,validationProtocol:protocol,missing});
  for(const [i,m]of members.entries()){
    if(missing&&i===1)continue;
    const received=35+i*.4;f.advance(received);const gold=await f.createSource(m.task,{observation:m.report.object,result:m.value,received});
    const label=await f.capture(m.episode,'learned-state-heldout-label-'+i,targetMinute);await s.partitions.reserve(label.record._id,trainer);f.advance(received+.1);
    const feedback=await s.feedback.propose({inputSnapshotId:m.input.record._id,labelSnapshotId:label.record._id,eventId:gold.event._id},trainer);
    await s.feedback.review(feedback.id,feedback.version,'APPROVE','Independent synthetic heldout completion',reviewer);
  }
  f.advance(39);const frozen=await s.datasets.freeze(cohort.id,trainer);
  const request={configuration:{minimumSamples:missing?1:2,minimumCoverage:missing ? 0.5 : 1,maximumNllRegression:0,maximumBrierRegression:0,task:'STATE_ESTIMATION',clock:f.recipe.clock},
    cohorts:[protocol],recipe:f.recipe,candidate,observationMaterials:f.materials,transitionMaterials:f.transitionMaterials,transitionCandidate:f.transitionCandidate,
    validationMaterials:[await s.datasets.materialize(frozen.id,'VALIDATE',trainer)],
    validationTemporalInputs:await Promise.all(members.map(m=>f.episodes.readTemporalInput(m.input.record._id,trainer)))};
  return {...f,candidate,request,members,validation:frozen,evaluationSetup};
}
