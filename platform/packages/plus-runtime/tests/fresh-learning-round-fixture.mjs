// Prospective native cohort helper for lifecycle acceptance, not a production
// connector or evidence of business efficacy. Synthetic GOLD is ingested only
// after the caller has independently approved any evaluation protocol.
import assert from 'node:assert/strict';
import { digest } from '@openfoundry/plus-contracts';
import { ctx,trainer,reviewer,at } from './model-evaluation-fixture.mjs';

export async function freshLearningCohort(f,{key,partition,start,records,actor=trainer}){
 assert.ok(['TRAIN','VALIDATION'].includes(partition));assert.ok(records.length>0);
 const protocol={...f.policy,key,partition,expectedSampleCount:records.length,
  inputVisibleFrom:at(start+1),inputVisibleUntil:at(start+2),labelReceivedFrom:at(start+3),labelReceivedUntil:at(start+7),approvalUntil:at(start+9)};
 const previousProtocol=f.datasetConfig.protocolFor;
 f.datasetConfig.protocolFor=async(p,k)=>k===key?structuredClone(protocol):previousProtocol(p,k);
 let splitGroup;
 for(let i=0;i<1000;i++){
  const group=key+'-group-'+i,bucket=parseInt(digest(['dataset-frozen-fixture',ctx.tenantId,['synthetic-group',group]]).slice(0,8),16)%10000;
  if(partition==='TRAIN'?bucket<6000:bucket>=6000&&bucket<7500){splitGroup=group;break;}
 }
 assert.ok(splitGroup);const roots=[],episodes=[],inputs=[],feedbackIds=[],rootIds=new Set(),previousGroup=f.partitionConfig.groupFor;
 f.partitionConfig.groupFor=async(p,ref)=>rootIds.has(ref.id)?{primary:{namespace:'synthetic-group',key:splitGroup},aliases:[]}:previousGroup(p,ref);
 const snapshot=async(i,suffix)=>{
  const stream=await f.runtime.capture(episodes[i]._id,actor,key+'-stream-'+i+'-'+suffix);
  return (await f.runtime.snapshot({streamId:stream.record._id,targetTime:at(start+1)},actor,key+'-snapshot-'+i+'-'+suffix)).record;
 };
 f.advance(start+2);
 for(const [i,record]of records.entries()){
  const root=await f.storage.createObject(ctx,'Machine',{actual:'UNKNOWN',status:'REGISTERED',priority:1,createdAt:at(start),receivedAt:at(start),classification:'SYNTHETIC'});
  roots.push(root);rootIds.add(root._id);
  await f.add({rootId:root._id,origin:key+'-report-'+i,value:record.report,minute:start+1,received:start+1});
  episodes.push(await f.runtime.open({definitionKey:f.definition.key,rootId:root._id,startedAt:at(start)},actor,key+'-episode-'+i));
  const input=await snapshot(i,'input');inputs.push(input);await f.partitions.reserve(input._id,actor);
 }
 const draft=await f.registry.proposeCohort(key,inputs.map(r=>r._id),actor);
 const cohort=await f.registry.reviewCohort(draft.id,draft.version,'APPROVE','Prospective synthetic lifecycle membership',reviewer);
 let frozen=false;
 return {protocol,cohort,roots,inputs,feedbackIds,async freezeWithFeedback(){
  assert.equal(frozen,false,'A lifecycle cohort cannot be relabeled or counted as a second round');frozen=true;
  for(const [i,record]of records.entries()){
   const received=start+4+i*.2;assert.ok(received+.1<start+7);f.advance(received);
   const gold=await f.add({rootId:roots[i]._id,origin:key+'-gold-'+i,kind:'VERIFICATION',value:record.state,minute:start+1,received});
   const labels=await snapshot(i,'labels');await f.partitions.reserve(labels._id,actor);f.advance(received+.1);
   const request=await f.feedback.propose({inputSnapshotId:inputs[i]._id,labelSnapshotId:labels._id,eventId:gold.event._id},actor);
   const reviewed=await f.feedback.review(request.id,request.version,'APPROVE','Independent subsequent synthetic GOLD',reviewer);feedbackIds.push(reviewed.id);
  }
  f.advance(start+9);const data=await f.registry.freeze(cohort.id,actor);
  for(const root of roots)assert.equal((await f.storage.getObject(ctx,'Machine',root._id)).actual,'UNKNOWN');
  return data;
 }};
}
