// Real, explicitly synthetic demonstration. Every mutation uses authenticated
// native HTTP actions; this is not a precomputed fixture or hidden seed path.
import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
if(!process.argv.includes('--synthetic'))throw new Error('Pass --synthetic to create clearly labelled demonstration records');
const base=process.env.LWM_PLUS_URL??'http://127.0.0.1:4183';
if(!['127.0.0.1','localhost','[::1]'].includes(new URL(base).hostname))throw new Error('Combined local credentials must never be sent off-host');
const access=JSON.parse(readFileSync(process.env.LWM_ACCESS_FILE??'var/lwm/plus-access/local-access.json'));
const run='SYNTH-'+new Date().toISOString().replace(/\D/g,'');
async function api(path,role='viewer',body){
  const token=access.credentials.find(c=>c.role===role).token;
  const response=await fetch(base+'/api'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':randomUUID()},...(body?{body:JSON.stringify(body)}:{})});
  const result=await response.json();if(!response.ok||result.data?.success===false)throw new Error(JSON.stringify(result));return result.data;
}
const before=await api('/state'),baseline=before.objects.DecisionPolicy.items.find(p=>p.stage==='ACTIVE');
const rows=Array.from({length:4},(_,i)=>({matterNumber:run+'-'+i,title:'合成演示：数据保留义务复核 '+(i+1),currentState:'EVIDENCE_COMPLETE',evidence:'明确为合成演示，不含客户或个人数据。观测与行为结果仅用于验证治理链路。'}));
await api('/plus/importBatch','investigator',{rows,source:'synthetic-tour:'+run});
const state=await api('/state'),rounds=[],cases=[];
for(let i=0;i<4;i++){
  const matter=state.objects.Matter.items.find(m=>m.matterNumber===rows[i].matterNumber),detail=await api('/objects/Matter/'+matter._id);
  const observation=state.objects.Observation.items.find(o=>detail.links.some(l=>l._type==='MatterObservation'&&l._toId===o._id));
  await api('/actions/NativeVerifyObservation','data_reviewer',{observation:observation._id,expectedVersion:observation._version});
  const options=[{name:'维持沟通（合成假设）',query:{l:1,f:0,prev_action:0,requested_action:0,lawfulness:1},costAct:2,costRefrain:8,interventionCost:0},{name:'补充沟通（合成假设）',query:{l:1,f:1,prev_action:0,requested_action:1,lawfulness:1},costAct:2,costRefrain:8,interventionCost:1}];
  const simulation=await api('/plus/simulate','investigator',{matter:matter._id,observation:observation._id,expectedVersion:matter._version,options,demonstrations:[]});
  const proposal=await api('/plus/propose','investigator',{simulation:simulation.receipt.resultId,optionIndex:0,toState:'RETENTION_REQUIRED',rationale:'合成人工选择；不是模型法律结论'});
  await api('/actions/NativeReviewTransition','case_reviewer',{matter:matter._id,proposal:proposal.receipt.resultId,observation:observation._id,expectedVersion:2,decision:'APPROVE',note:'独立身份核验合成方案与证据，准许演示状态迁移'});
  const outcome=await api('/plus/recordOutcome','investigator',{simulation:simulation.receipt.resultId,optionIndex:0,actual:i%2,evidence:'合成后续结果 '+(i%2?'ACT':'REFRAIN')+'，用于验证流程而非衡量真实业务效果'});
  await api('/plus/qualifyOutcome','data_reviewer',{id:outcome.receipt.resultId,note:'确认结果为合成示例且不含个人数据；仅准入演示学习',privacyConfirmed:true});
  cases.push({matter:matter._id,simulation:simulation.receipt.resultId,proposal:proposal.receipt.resultId,outcome:outcome.receipt.resultId,modelHash:simulation.prediction.checkpointHash});
  console.log('Completed synthetic case '+(i+1)+' with actual P33 inference and native approval');
  if(i%2===1){
    const candidate=await api('/plus/trainPolicy','trainer',{});
    if(candidate.evaluation.passed)await api('/plus/publishPolicy','model_owner',{id:candidate.receipt.resultId});
    rounds.push({policy:candidate.receipt.resultId,evaluation:candidate.evaluation,published:candidate.evaluation.passed});
  }
}
const current=await api('/state');
if(current.objects.DecisionPolicy.items.find(p=>p.stage==='ACTIVE')._id!==baseline._id)await api('/plus/rollbackPolicy','model_owner',{id:baseline._id});
const report={checkedAt:new Date().toISOString(),run,synthetic:true,notFieldEffectiveness:true,cases,rounds,restoredPolicy:baseline._id};
const output=process.argv.find(a=>a.startsWith('--output='));
if(output)writeFileSync(output.slice(9),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
