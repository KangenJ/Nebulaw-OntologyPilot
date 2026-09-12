// Task-native prospective synthetic cohort. This is an engineering fixture,
// not a product connector, business-effect claim or canonical source action.
import assert from 'node:assert/strict';
import { digest } from '@openfoundry/plus-contracts';
import { ctx,trainer,reviewer,at } from './task-learning-fixture.mjs';

export async function freshTaskCohort(f,{key,partition,start,records}){
 assert.ok(['TRAIN','VALIDATION'].includes(partition));assert.ok(records.length>0&&records.length<=10);
 const s=f.services,protocol={...f.protocol,key,partition,expectedSampleCount:records.length,
  inputVisibleFrom:at(start+1),inputVisibleUntil:at(start+2),labelReceivedFrom:at(start+3),labelReceivedUntil:at(start+7),approvalUntil:at(start+9)};
 assert.equal(f.policy.taskLearning.cohorts.some(c=>c.protocol.key===key),false);
 f.policy.taskLearning.cohorts.push({workspace:'synthetic',protocol});for(const g of f.policy.taskLearning.grants)g.protocolKeys.push(key);
 f.advance(start+2);let selected;
 // Select the Matter group by the already frozen hash partition, before labels.
 // Tasks in one cohort share that group and are not counted as independent groups.
 for(let i=0;i<128;i++){
  const root=await f.root('synthetic',undefined,start),seed=f.policy.taskLearning.partition.seed;
  const bucket=parseInt(digest([seed,ctx.tenantId,['task-matter-v1',digest(['synthetic',root.matter._id])]]).slice(0,8),16)%10000;
  if(partition==='TRAIN'?bucket<6000:bucket>=6000&&bucket<7500){selected=root;break;}
 }
 assert.ok(selected,'Pre-label synthetic Matter partition required');
 const members=[],feedbackIds=[];
 for(const [i,record]of records.entries()){
  const root=i===0?selected:await f.root('synthetic',selected.matter,start);
  const report=await f.source(root.task,{record:key+'-report-'+i,result:record.report,eventMinute:start+1,received:start+1});
  const episode=await f.episodes.open({definitionKey:'task.completion',rootId:root.task._id,startedAt:at(start)},trainer,key+'-episode-'+i);
  const input=await f.capture(episode,key+'-input-'+i,start+1);
  assert.equal((await s.partitions.reserve(input.record._id,trainer)).partition,partition);
  members.push({task:root.task,report,episode,input,state:record.state});
 }
 const draft=await s.datasets.proposeCohort(key,members.map(m=>m.input.record._id),trainer);
 const cohort=await s.datasets.reviewCohort(draft.id,draft.version,'APPROVE','Pre-label synthetic Task membership',reviewer);
 let used=false;
 return {protocol,cohort,members,feedbackIds,async freezeWithFeedback(){
  assert.equal(used,false,'A Task cohort cannot be relabeled as another feedback round');used=true;
  for(const [i,m]of members.entries()){
   const received=start+4+i*.2;f.advance(received);
   const gold=await f.source(m.task,{observation:m.report.object,result:m.state,received});
   const labels=await f.capture(m.episode,key+'-labels-'+i,start+1);await s.partitions.reserve(labels.record._id,trainer);f.advance(received+.1);
   const feedback=await s.feedback.propose({inputSnapshotId:m.input.record._id,labelSnapshotId:labels.record._id,eventId:gold.event._id},trainer);
   const reviewed=await s.feedback.review(feedback.id,feedback.version,'APPROVE','Independent later synthetic Task verification',reviewer);feedbackIds.push(reviewed.id);
  }
  f.advance(start+9);const dataset=await s.datasets.freeze(cohort.id,trainer);
  for(const m of members)assert.equal((await f.storage.getObject(ctx,'InvestigationTask',m.task._id)).actualCompletion,'UNKNOWN');
  return dataset;
 }};
}
