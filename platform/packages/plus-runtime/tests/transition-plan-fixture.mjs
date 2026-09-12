import assert from 'node:assert/strict';
import { compileTransitionSupervision,digest } from '@openfoundry/plus-contracts';
import { NativeDatasetRegistry,NativeRecipeRegistry,NativeTransitionEndpointReader,NativeTransitionPlanReader,NativeActionIntervalReader } from '../dist/index.js';
import { datasetFixture,trainer,reviewer,owner } from './dataset-fixture.mjs';
import { principal,ctx,at } from './episode-fixture.mjs';
import { transitionRecipe,validateTransitionRecipe,transitionEstimatorId } from '../../../../services/plus-engine/transition-fit.mjs';

// Actual native records, approvals, partitions and frozen datasets. Explicitly
// synthetic source/clock/authority adapters; not production interval authority.
export async function fixture(t,{missing=false,extraGold=false,stepMs=60000,recipeAt=2,alterSpec,alterConfig,timed=false,maxSteps=100,actionBound=false,splitCohorts=false,thirdMissing=false,secondary=false,historyVersion='plus-native-action-interval-policy-v1'}={}){
  timed ||= actionBound;
  const f=await datasetFixture(t,{secondary}),stream=await f.runtime.capture(f.episodes[0]._id,principal,'plan-stream');
  const second=(await f.runtime.snapshot({streamId:stream.record._id,targetTime:at(2)},principal,'plan-second')).record;
  await f.partitions.reserve(second._id,trainer);
  const inputIds=[f.inputs[0]._id,second._id];
  if(thirdMissing){assert.equal(splitCohorts,false);f.advance(3);await f.add({kind:'OBSERVATION',value:'OFFLINE',minute:3,received:3,origin:'missing-endpoint-only-report'});
    const stream=await f.runtime.capture(f.episodes[0]._id,principal,'plan-third-stream');
    const third=(await f.runtime.snapshot({streamId:stream.record._id,targetTime:at(3)},principal,'plan-third')).record;
    await f.partitions.reserve(third._id,trainer);inputIds.push(third._id);}
  const protocol={...f.policy,key:'plan-longitudinal',expectedSampleCount:inputIds.length,minimumSamples:1,minimumCoverage:0.5,
    ...(thirdMissing?{inputVisibleUntil:at(3),labelReceivedFrom:at(4)}:{})};
  if(secondary)assert.equal(splitCohorts,true);
  const protocols=splitCohorts?(secondary?['state','secondary']:['state']).flatMap(variable=>inputIds.map((_id,i)=>({...protocol,variable,key:'plan-'+variable+'-time-'+i,expectedSampleCount:1,minimumCoverage:1}))):[protocol];
  const datasets=new NativeDatasetRegistry({...f.datasetConfig,protocolFor:async(_p,key)=>structuredClone(protocols.find(q=>q.key===key))});
  const drafts=[];for(let i=0;i<protocols.length;i++){
    const draft=await datasets.proposeCohort(protocols[i].key,splitCohorts?[inputIds[i%inputIds.length]]:inputIds,trainer);
    await datasets.reviewCohort(draft.id,draft.version,'APPROVE','Enroll times before labels',reviewer);drafts.push(draft);}
  const compiled=(await f.definitions.requirePublished(f.definition.key,trainer)).compiled;
  const raw={schema:'plus-transition-supervision-v1',key:'machine.transition',revision:1,parentDefinitionHash:compiled.definitionHash,
    bindingHash:f.inputs[0].compiledInput.bindingHash,timeContractHash:digest('synthetic-minute-grid'),transitionModule:compiled.definition.modules.find(m=>m.kind==='TRANSITION').key,
    classification:'SYNTHETIC',collectionPolicyHash:protocol.collectionPolicyHash,populationPolicyHash:digest('all-plan-trajectories'),stepMs,
    contextSupport:{priority:[1,2]},controls:['WAIT'],sampling:'ALL_ADJACENT_PRE_ENROLLED_PAIRS',actionSemantics:'OBSERVED_NATIVE_HISTORY_NOT_CAUSAL',budget:{maxPairs:100,maxTrajectories:100}};
  const timeContract={schema:'plus-transition-time-v1',definitionHash:compiled.definitionHash,bindingHash:raw.bindingHash,stepMs,maxSteps,
    origin:'EPISODE_STARTED_AT',alignment:'EXACT_GRID',contextKnowledge:'INTERVAL_START',endpointKnowledge:'PRELABEL_SNAPSHOT',actionWindow:'HALF_OPEN',actionTimestamp:'NATIVE_EXECUTION_RECEIPT'};
  if(timed)raw.timeContractHash=digest(timeContract);
  alterSpec?.(raw);const supervision=compileTransitionSupervision(raw,compiled);
  const config={classification:'SYNTHETIC',collectionPolicyHash:raw.collectionPolicyHash,populationPolicyHash:raw.populationPolicyHash,
    trainingProtocolHashes:protocols.map(q=>digest(q)),smoothingAlpha:1,minimumPairs:1,minimumTrajectories:1,minimumGroups:1,minimumPerCondition:1,minimumCoverage:0.5};
  const actionHistoryContract={version:historyVersion,id:'machine-native-actions',rootType:'Machine',rootEpisodeLink:'MachineEpisode',
    nativeActions:['VerifyObject'],inventory:'TENANT_WIDE',orphanPolicy:'REJECT_INTERVAL'};
  alterConfig?.(config);const {recipe,recipeHash}=transitionRecipe(compiled,supervision,config,timed?timeContract:undefined,actionBound?actionHistoryContract:undefined);
  const recipes=new NativeRecipeRegistry({storage:f.storage,tenantId:ctx.tenantId,definitions:f.definitions,clock:()=>Date.parse(at(recipeAt)),
    authorize:async()=>true,policyFor:async()=>({version:'plus-recipe-policy-v1',id:'plan-purpose',engineIds:[transitionEstimatorId],classifications:['SYNTHETIC'],
      collectionPolicyHashes:[raw.collectionPolicyHash],populationPolicyHashes:[raw.populationPolicyHash],scopeKeys:[compiled.definition.scope.key]}),
    validateRecipe:async(payload,parent)=>{validateTransitionRecipe(payload,parent);}});
  const proposed=await recipes.propose({key:'machine.transition',revision:1,definitionKey:compiled.definition.key,payload:recipe},trainer);
  const approved=await recipes.review(proposed.id,proposed.version,'APPROVE','Review complete prospective protocol set',owner);
  await f.addLabel();if(extraGold)await f.addLabel();
  if(secondary)await f.addLabel(0,{variable:'secondary',value:'READY'});
  if(!missing){f.advance(6);const gold=await f.add({kind:'VERIFICATION',value:'BUSY',minute:2,received:6,origin:'second-gold'});
    const stream=await f.runtime.capture(f.episodes[0]._id,principal,'plan-gold-stream');
    const label=(await f.runtime.snapshot({streamId:stream.record._id,targetTime:at(2)},principal,'plan-gold-input')).record;
    await f.partitions.reserve(label._id,trainer);f.advance(6.1);
    const feedback=await f.feedback.propose({inputSnapshotId:second._id,labelSnapshotId:label._id,eventId:gold.event._id},trainer);
    await f.feedback.review(feedback.id,feedback.version,'APPROVE','Independent later endpoint',reviewer);
    if(secondary){f.advance(6.3);const gold=await f.add({kind:'VERIFICATION',variable:'secondary',value:'OFFLINE',minute:2,received:6.3,origin:'second-secondary-gold'});
      const stream=await f.runtime.capture(f.episodes[0]._id,principal,'secondary-gold-stream');
      const label=(await f.runtime.snapshot({streamId:stream.record._id,targetTime:at(2)},principal,'secondary-gold-input')).record;
      await f.partitions.reserve(label._id,trainer);f.advance(6.4);
      const feedback=await f.feedback.propose({inputSnapshotId:second._id,labelSnapshotId:label._id,eventId:gold.event._id},trainer);
      await f.feedback.review(feedback.id,feedback.version,'APPROVE','Independent secondary component',reviewer);}}
  f.advance(9);const frozenAll=[];for(const draft of drafts)frozenAll.push(await datasets.freeze(draft.id,trainer));const frozen=frozenAll[0];let revision=0;
  const authority=async()=>digest(['synthetic-full-identity-policy',revision]);
  const endpointConfig={storage:f.storage,tenantId:ctx.tenantId,datasets,feedback:f.feedback,episodes:f.runtime,partitions:f.partitions,
    authorize:async p=>p.id===trainer.id,authorizationRevision:authority};
  const endpoints=new NativeTransitionEndpointReader(endpointConfig);
  f.config.qualifyContextHistory=async()=>({allowed:true,policyHash:digest('synthetic-history-scope')});
  const intervalConfig={storage:f.storage,tenantId:ctx.tenantId,catalog:f.catalog,requests:{read:async()=>assert.fail('Empty native inventory must not invent a request')},
    policyFor:async()=>structuredClone(actionHistoryContract),authorize:async p=>p.id===trainer.id,authorizationRevision:authority,clock:()=>Date.parse(at(9))};
  const actionIntervals=new NativeActionIntervalReader(intervalConfig);
  const planConfig={storage:f.storage,tenantId:ctx.tenantId,recipes,endpoints,authorizationRevision:authority,episodes:f.runtime,actionIntervals};
  return {...f,frozen,frozenIds:frozenAll.map(d=>d.id),recipe,approved,recipeHash,recipes,endpoints,endpointConfig,planConfig,intervalConfig,actionIntervals,plan:new NativeTransitionPlanReader(planConfig),bump:()=>revision++};
}
