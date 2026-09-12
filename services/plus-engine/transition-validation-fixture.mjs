import assert from 'node:assert/strict';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { NativePartitionLedger,NativeFeedbackRegistry,NativeDatasetRegistry,NativeEvaluationProtocolRegistry,NativeTransitionEndpointReader,
  NativeTransitionPlanReader,NativeActionIntervalReader,transitionEvaluatorId } from '../../platform/packages/plus-runtime/dist/index.js';
import { fixture as trainingFixture } from '../../platform/packages/plus-runtime/tests/transition-plan-fixture.mjs';
import { trainer,reviewer,owner } from '../../platform/packages/plus-runtime/tests/dataset-fixture.mjs';
import { ctx,principal,at } from '../../platform/packages/plus-runtime/tests/episode-fixture.mjs';
import { fitTransitionModel } from './transition-fit.mjs';

// One actual native DB for TRAIN and prospectively approved VALIDATION. Native
// records, group ledger, independent reviews, timelines and material readers;
// SYNTHETIC sources, authority and clock adapters, with empty native inventory.
export async function transitionValidationFixture(t,{outcome='BUSY',from='READY',missing=false,reuseTrainingSource=false,secondary=false,factorizedReference=false,componentReview=false,protocolFactory,historyVersion='plus-native-action-interval-policy-v1'}={}){
  const f=await trainingFixture(t,{actionBound:true,secondary,splitCohorts:secondary,historyVersion});
  // Explicit synthetic reviewer grants, before exposure/qualification. Do not
  // impersonate the trainer when the independent owner reads either partition.
  if(componentReview){f.endpointConfig.authorize=async p=>[trainer.id,owner.id].includes(p.id);f.intervalConfig.authorize=async p=>[trainer.id,owner.id].includes(p.id);}
  const trainingMaterial=await f.plan.materializeForFit(f.recipeHash,f.frozenIds,trainer);
  const candidate=fitTransitionModel(f.recipe,[trainingMaterial]);let now=19;
  const advance=n=>{now=n;f.advance(n);};advance(19);
  // Match the approved TRAIN context, not its entity/group/sources. Priority 1
  // has no fitted observations and must not accidentally be used as a success.
  const root=await f.storage.createObject(ctx,'Machine',{actual:'UNKNOWN',...(secondary?{secondary:'UNKNOWN'}:{}),status:'REGISTERED',priority:2,createdAt:at(19),receivedAt:at(19),classification:'SYNTHETIC'});
  const episode=await f.runtime.open({definitionKey:f.definition.key,rootId:root._id,startedAt:at(19)},principal,'heldout-transition-episode');
  const partitionProtocol=await f.partitionConfig.protocolFor();let group;
  for(let i=0;i<1000;i++){const value='heldout-transition-group-'+i,bucket=parseInt(digest([partitionProtocol.seed,ctx.tenantId,['synthetic-group',value]]).slice(0,8),16)%10000;
    if(bucket>=6000&&bucket<7500){group=value;break;}}
  assert.ok(group);
  const partitions=new NativePartitionLedger({...f.partitionConfig,clock:()=>Date.parse(at(now)),groupFor:async()=>({primary:{namespace:'synthetic-group',key:group},aliases:[]})});
  const feedback=new NativeFeedbackRegistry({...f.feedbackConfig,partitions,clock:()=>Date.parse(at(now))});
  const inputs=[];
  for(const minute of [20,21]){
    advance(minute);await f.add({rootId:root._id,kind:'OBSERVATION',value:'OFFLINE',minute,received:minute,
      origin:reuseTrainingSource&&minute===20?'initial-0':'independent-heldout-report-'+minute,revision:reuseTrainingSource?'2':'1'});
    const stream=await f.runtime.capture(episode._id,principal,'heldout-input-stream-'+minute);
    const input=(await f.runtime.snapshot({streamId:stream.record._id,targetTime:at(minute)},principal,'heldout-input-'+minute)).record;
    assert.equal((await partitions.reserve(input._id,trainer)).partition,'VALIDATION');inputs.push(input);
  }
  advance(22);
  const cohortProtocol={...f.policy,key:'independent-transition-heldout',partition:'VALIDATION',expectedSampleCount:2,minimumSamples:1,minimumCoverage:.5,
    inputVisibleFrom:at(20),inputVisibleUntil:at(22),labelReceivedFrom:at(23),labelReceivedUntil:at(27),approvalUntil:at(29)};
  const cohortProtocols=secondary?['state','secondary'].map(variable=>({...cohortProtocol,variable,key:cohortProtocol.key+'-'+variable})):[cohortProtocol];
  const datasets=new NativeDatasetRegistry({...f.datasetConfig,partitions,feedback,clock:()=>Date.parse(at(now)),protocolFor:async(_p,key)=>structuredClone(cohortProtocols.find(q=>q.key===key))});
  const cohorts=[];for(const q of cohortProtocols){const cohortDraft=await datasets.proposeCohort(q.key,inputs.map(r=>r._id),trainer);
    cohorts.push(await datasets.reviewCohort(cohortDraft.id,cohortDraft.version,'APPROVE','Complete new heldout trajectory before labels',reviewer));}
  const purpose={version:'plus-evaluation-purpose-v1',id:'synthetic-transition-score',evaluatorIds:[transitionEvaluatorId],recipeHashes:[f.recipeHash],classifications:['SYNTHETIC']};
  const protocols=protocolFactory?await protocolFactory({fixture:f,datasets,purpose,clock:()=>Date.parse(at(now))}):new NativeEvaluationProtocolRegistry({storage:f.storage,tenantId:ctx.tenantId,recipes:f.recipes,datasets,clock:()=>Date.parse(at(now)),
    authorize:async()=>true,policyFor:async()=>structuredClone(purpose),validateConfiguration:async()=>{}});
  const draft=await protocols.propose({key:'transition.heldout.score',revision:1,recipeHash:f.recipeHash,cohortIds:cohorts.map(c=>c.id),evaluatorId:transitionEvaluatorId,
    configuration:{schema:factorizedReference?'plus-conditional-transition-evaluation-v2':'plus-conditional-transition-evaluation-v1',
      ...(factorizedReference?{reference:{schema:'plus-transition-reference-v1',kind:'SAME_CONDITION_FACTORIZED_COUNTS'}}:{}),task:'CONDITIONAL_TRANSITION',minimumPairs:1,minimumGroups:1,minimumCoverage:1,
      maximumNllRegression:0,maximumBrierRegression:0}},trainer);
  await protocols.review(draft.id,draft.version,'APPROVE','Prospective fixed score and entire cohort',owner);
  for(const [i,value]of [from,outcome].entries()){
    if(missing&&i===1)continue;
    for(const [j,variable]of (secondary?['state','secondary']:['state']).entries()){
    const received=24+i+j*.25;advance(received);const event=await f.add({rootId:root._id,kind:'VERIFICATION',variable,value:variable==='state'?value:i===0?'READY':'OFFLINE',
      minute:20+i,received,origin:'independent-heldout-gold-'+i+(j?'-secondary':'')});
    const stream=await f.runtime.capture(episode._id,principal,'heldout-label-stream-'+i+(j?'-secondary':''));
    const label=(await f.runtime.snapshot({streamId:stream.record._id,targetTime:at(20+i)},principal,'heldout-label-'+i+(j?'-secondary':''))).record;
    await partitions.reserve(label._id,trainer);advance(received+.1);
    const proposal=await feedback.propose({inputSnapshotId:inputs[i]._id,labelSnapshotId:label._id,eventId:event.event._id},trainer);
    await feedback.review(proposal.id,proposal.version,'APPROVE','Independent heldout endpoint check',reviewer);
    }
  }
  advance(29);const allFrozen=[];for(const cohort of cohorts){const frozen=await datasets.freeze(cohort.id,trainer);assert.equal(frozen.readiness,'READY');allFrozen.push(frozen);}
  const authority=f.planConfig.authorizationRevision;
  const validationEndpointConfig={...f.endpointConfig,datasets,feedback,partitions,authorizationRevision:authority,
    authorize:async(p,purpose)=>(p.id===trainer.id||componentReview&&p.id===owner.id)&&purpose==='VALIDATE'};
  const endpoints=new NativeTransitionEndpointReader(validationEndpointConfig);
  const actionIntervals=new NativeActionIntervalReader({...f.intervalConfig,clock:()=>Date.parse(at(now))});
  const plans=new NativeTransitionPlanReader({...f.planConfig,endpoints,validationActionIntervals:actionIntervals,evaluationProtocols:protocols});
  const validationMaterial=await plans.materializeForValidation(draft.id,allFrozen.map(f=>f.id),trainer),protocol=(await protocols.requireApproved(draft.id,trainer)).record;
  return {...f,root,trainingMaterial,candidate,validationMaterial,protocol,protocols,validationPlans:plans,validationEndpointConfig,validationDataset:allFrozen[0],validationDatasetIds:allFrozen.map(f=>f.id),validationDatasets:datasets};
}
