import { digest } from '@openfoundry/plus-contracts';
import { NativeDatasetRegistry,NativeFeedbackRegistry,NativePartitionLedger } from '../dist/index.js';
import { episodeFixture,ctx,principal,at,start } from './episode-fixture.mjs';
export const trainer={...principal,id:'trainer',roles:['trainer']},reviewer={...principal,id:'reviewer',roles:['data_reviewer']},owner={...principal,id:'owner',roles:['model_owner']};
export async function datasetFixture(t,{count=1,minimumCoverage=1,minimumSamples=1,partition='TRAIN',approveCohort=true,secondary=false}={}){
 const f=await episodeFixture(t,{secondary});let now=2;
 const advance=n=>{now=n;f.setTime(n);};advance(2);
 const boundaries=[6000,7500,9000,10000],seed='dataset-frozen-fixture';let group;
 for(let i=0;i<1000;i++){const g='group-'+i,bucket=parseInt(digest([seed,ctx.tenantId,['synthetic-group',g]]).slice(0,8),16)%10000;
  if(['TRAIN','VALIDATION','FINAL_EVAL','ONLINE'][boundaries.findIndex(b=>bucket<b)]===partition){group=g;break;}}
 if(!group)throw new Error('software fixture group unavailable');
 const partitionConfig={storage:f.storage,catalog:f.catalog,episodes:f.runtime,tenantId:ctx.tenantId,authorize:async()=>true,clock:()=>Date.parse(at(now)),
  protocolFor:async()=>({version:'plus-partition-v1',seed,boundaries,groupingPolicyHash:digest('synthetic-fixed-group')}),groupFor:async()=>({primary:{namespace:'synthetic-group',key:group},aliases:[]})};
 const partitions=new NativePartitionLedger(partitionConfig),inputs=[],roots=[],episodes=[];
 const snapshot=async(index,key)=>{const stream=await f.runtime.capture(episodes[index]._id,principal,'stream-'+key);return (await f.runtime.snapshot({streamId:stream.record._id,targetTime:at(1)},principal,'snapshot-'+key)).record;};
 for(let i=0;i<count;i++){
  const root=i===0?f.root:await f.storage.createObject(ctx,'Machine',{actual:'UNKNOWN',...(secondary?{secondary:'UNKNOWN'}:{}),status:'REGISTERED',priority:1,createdAt:start,receivedAt:start,classification:'SYNTHETIC'});roots.push(root);
  await f.add({rootId:root._id,origin:'initial-'+i});episodes.push(await f.runtime.open({definitionKey:f.definition.key,rootId:root._id,startedAt:start},principal,'episode-'+i));
  const input=await snapshot(i,'initial-'+i);inputs.push(input);await partitions.reserve(input._id,trainer);
 }
 const collectionPolicyHash=digest('preapproved-software-cohort-selection');
 const policy={version:'plus-cohort-v1',key:'cohort-round-1',collectionPolicyHash,definitionHash:inputs[0].compiledInput.definitionHash,variable:'state',classification:'SYNTHETIC',partition,
  inputVisibleFrom:at(1),inputVisibleUntil:at(2),labelReceivedFrom:at(3),labelReceivedUntil:at(7),approvalUntil:at(9),expectedSampleCount:count,minimumSamples,minimumCoverage};
 const feedbackPolicy={version:'plus-feedback-policy-v1',key:'cohort-feedback-policy',collectionPolicyHash,minimumMaturityMs:0,classifications:['SYNTHETIC'],variables:secondary?['state','secondary']:['state']};
 const feedbackConfig={storage:f.storage,tenantId:ctx.tenantId,episodes:f.runtime,partitions,authorize:async()=>true,policyFor:async()=>structuredClone(feedbackPolicy),clock:()=>Date.parse(at(now))};
 const feedback=new NativeFeedbackRegistry(feedbackConfig);
 const config={storage:f.storage,tenantId:ctx.tenantId,episodes:f.runtime,partitions,feedback,authorize:async()=>true,protocolFor:async()=>structuredClone(policy),clock:()=>Date.parse(at(now))};
 const registry=new NativeDatasetRegistry(config),draft=await registry.proposeCohort(policy.key,inputs.map(r=>r._id),trainer);
 let cohort=draft;if(approveCohort)cohort=await registry.reviewCohort(draft.id,draft.version,'APPROVE','approve prospective membership and collection window',reviewer);
 let labelNumber=0;
 const addLabel=async(index=0,{value='READY',received=Math.max(4,now+0.2),approve=true,variable='state'}={})=>{
  const key='label-'+labelNumber++;advance(received);
  const label=await f.add({rootId:roots[index]._id,kind:'VERIFICATION',value,minute:1,received,origin:key,variable}),labels=await snapshot(index,key);
  await partitions.reserve(labels._id,trainer);advance(received+0.1);
  const request={inputSnapshotId:inputs[index]._id,labelSnapshotId:labels._id,eventId:label.event._id},proposed=await feedback.propose(request,trainer);
  const result=approve?await feedback.review(proposed.id,proposed.version,'APPROVE','qualified point-in-time feedback',reviewer):proposed;
  return {label,labels,feedback:result,request};
 };
 return {...f,registry,datasetConfig:config,policy,feedback,feedbackConfig,partitions,partitionConfig,cohort,inputs,roots,episodes,advance,addLabel,snapshot};
}
