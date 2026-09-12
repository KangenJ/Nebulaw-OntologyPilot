// All learning state is native Open Foundry objects. Model service is stateless.
import {createHash} from 'node:crypto';
import {dynamicsRequest} from './dynamics-client.mjs';
export const learningRoles=Object.freeze({recordTrajectory:'investigator',qualifyTrajectory:'data_reviewer',withdrawTrajectory:'data_reviewer',freezeDataset:'trainer',trainModel:'trainer',publishModel:'model_owner',rollbackModel:'model_owner'});
export const BASE_HASH='92579351b915f59550c56af870d14d66e554b734f7c6f9cb31a0d94b2733cd04';
const sha=s=>createHash('sha256').update(s).digest('hex');
const fail=(code,message)=>Object.assign(new Error(message),{code,status:409});
const text=(s,max=2000)=>{if(typeof s!=='string'||!s.trim()||s.length>max)throw fail('LEARNING_CONTRACT','Bounded nonempty text required');return s.trim();};
const parse=JSON.parse;
const split=key=>parseInt(sha(key).slice(0,8),16)%2===0?'EVAL':'TRAIN';
const artifactHash=s=>s==='null'?BASE_HASH:sha(s);

export async function createNativeLearning({all,get,storage,ctx}){
  if(!(await all('DecisionPolicy')).length){const evaluationJson='{"baseline":true}';await storage.createObject(ctx,'DecisionPolicy',{key:'neural-baseline-v1',artifactJson:'null',artifactHash:BASE_HASH,datasetJson:'[]',evaluationJson,evaluationHash:sha(evaluationJson),trainedBy:'system-bootstrap',approvedBy:'system-bootstrap',stage:'ACTIVE',parentId:'none',createdAt:new Date().toISOString()});}
  async function snapshot(trajectory){
    if(trajectory.status!=='ELIGIBLE'||!trajectory.privacyConfirmed||trajectory.recordedBy===trajectory.verifiedBy)throw fail('DATA_REVOKED','Trajectory lacks independent training qualification');
    const outcome=await get('OutcomeRecord',trajectory.outcomeId);
    if(outcome.status!=='VERIFIED'||!outcome.privacyConfirmed)throw fail('DATA_REVOKED','Outcome withdrawn or no longer verified');
    const sim=await get('SimulationRun',outcome.simulationId),input=parse(sim.inputJson),output=parse(sim.outputJson),option=output.options[outcome.optionIndex],actions=parse(trajectory.actionsJson);
    if(!option?.schedule||actions.length!==option.schedule.length||actions.at(-1)!==outcome.actual)throw fail('TRAJECTORY_MISMATCH','Trajectory does not match approved option and observed end state');
    return {id:trajectory._id,version:trajectory._version,outcomeId:outcome._id,outcomeVersion:outcome._version,caseId:outcome.matterId,mechanismKey:trajectory.mechanismKey,split:trajectory.split,context:input.behaviorDemonstrations,initialAction:input.initialAction,schedule:option.schedule,actualActions:actions};
  }
  async function dataset(id){
    const d=await get('LearningDataset',id);if(d.status!=='FROZEN'||sha(d.rowsJson)!==d.contentHash)throw fail('DATASET_TAMPER','Frozen dataset hash/stage mismatch');
    const rows=parse(d.rowsJson);
    for(const row of rows){const fresh=await snapshot(await get('TrajectoryFeedback',row.id));if(JSON.stringify(fresh)!==JSON.stringify(row))throw fail('DATA_REVOKED','Frozen trajectory or outcome has changed');}
    return {object:d,rows};
  }
  async function verify(policy,visited=new Set()){
    if(visited.has(policy._id)||visited.size>64)throw fail('MODEL_LINEAGE','Invalid model ancestry');visited.add(policy._id);
    if(policy.artifactHash!==artifactHash(policy.artifactJson)||policy.evaluationHash!==sha(policy.evaluationJson))throw fail('MODEL_TAMPER','Model artifact/evaluation hash mismatch');
    if(policy.artifactJson==='null'){
      if(policy.key!=='neural-baseline-v1'||policy.parentId!=='none'||policy.datasetJson!=='[]'||parse(policy.evaluationJson).baseline!==true)throw fail('MODEL_TAMPER','Invalid baseline');
      return;
    }
    const info=parse(policy.datasetJson),evaluation=parse(policy.evaluationJson),d=await dataset(info.datasetId);
    if(info.contentHash!==d.object.contentHash||evaluation.artifactHash!==policy.artifactHash||evaluation.passed!==true)throw fail('MODEL_GATE','Candidate is unapproved, degraded or has changed data');
    const parent=await get('DecisionPolicy',policy.parentId);await verify(parent,visited);
  }
  async function active(){const values=(await all('DecisionPolicy')).filter(p=>['ACTIVE','SUSPENDED'].includes(p.stage));if(values.length!==1||values[0].stage!=='ACTIVE')throw fail('MODEL_SUSPENDED','No active valid model; restore a clean version');await verify(values[0]);return values[0];}
  async function affected(policy,predicate,seen=new Set()){
    if(seen.has(policy._id)||seen.size>64)throw fail('MODEL_LINEAGE','Invalid model ancestry');seen.add(policy._id);
    if(policy.artifactJson==='null')return false;
    const info=parse(policy.datasetJson),d=await get('LearningDataset',info.datasetId);
    if(parse(d.rowsJson).some(predicate))return true;
    return affected(await get('DecisionPolicy',policy.parentId),predicate,seen);
  }
  async function suspend(predicate,c){const p=(await all('DecisionPolicy')).find(p=>p.stage==='ACTIVE');if(p&&await affected(p,predicate)){await c.reference('activePolicy','DecisionPolicy',p._id);c.effects.push(c.update('activePolicy',{stage:'SUSPENDED'}));}}
  async function compile(operation,input,principal,c){
    if(!Object.hasOwn(learningRoles,operation))return false;
    const fields={recordTrajectory:['outcome','mechanismKey','actualActions','source','protocol'],qualifyTrajectory:['id','privacyConfirmed','independentConfirmed','note'],withdrawTrajectory:['id','note'],freezeDataset:['ids'],trainModel:['dataset'],publishModel:['id'],rollbackModel:['id']}[operation];
    if(Object.keys(input).some(k=>!fields.includes(k)))throw fail('LEARNING_CONTRACT','Unknown learning command field');
    const {reference,result,effects,update,extra,commandKey,at}=c;
    if(operation==='recordTrajectory'){
      const outcome=await reference('outcome','OutcomeRecord',input.outcome);
      if(outcome.status!=='VERIFIED')throw fail('OUTCOME_QUALIFICATION','Independently verified executed outcome required');
      const sim=await get('SimulationRun',outcome.simulationId),option=parse(sim.outputJson).options[outcome.optionIndex];
      if(!Array.isArray(input.actualActions)||input.actualActions.length!==option.schedule.length||input.actualActions.some(a=>a!==0&&a!==1)||input.actualActions.at(-1)!==outcome.actual)throw fail('TRAJECTORY_CONTRACT','Complete 2/3-step physical behavior sequence must match the observed end state');
      const mechanismKey=text(input.mechanismKey,200);
      if(!['controlled-demo','prospective-all'].includes(input.protocol))throw fail('SELECTION_PROTOCOL','Explicit controlled-demo or prospective-all collection protocol required');
      result('TrajectoryFeedback',{key:commandKey,outcomeId:outcome._id,mechanismKey,split:split(mechanismKey),actionsJson:JSON.stringify(input.actualActions),source:text(input.source),protocol:input.protocol,status:'HELD',privacyConfirmed:false,recordedBy:principal.id,createdAt:at});
    }else if(operation==='qualifyTrajectory'||operation==='withdrawTrajectory'){
      const row=await reference('trajectory','TrajectoryFeedback',input.id);
      if(operation==='qualifyTrajectory'){
        const outcome=await get('OutcomeRecord',row.outcomeId);
        if(row.status!=='HELD'||outcome.status!=='VERIFIED'||row.recordedBy===principal.id||outcome.recordedBy===principal.id||input.privacyConfirmed!==true||input.independentConfirmed!==true)throw fail('TRAJECTORY_QUALIFICATION','Independent reviewer must verify chronology, source, mechanism grouping, collection protocol and privacy');
        effects.push(update('trajectory',{status:'ELIGIBLE',privacyConfirmed:true,verifiedBy:principal.id,verificationNote:text(input.note)}));
      }else{effects.push(update('trajectory',{status:'WITHDRAWN',verificationNote:text(input.note)}));await suspend(r=>r.id===row._id,c);}
      c.setResult('TrajectoryFeedback','trajectory');
    }else if(operation==='freezeDataset'){
      if(!Array.isArray(input.ids)||input.ids.length<8||input.ids.length>64||new Set(input.ids).size!==input.ids.length)throw fail('DATASET_SIZE','Select 8–64 distinct qualified trajectories');
      const rows=[];for(const id of input.ids.slice().sort())rows.push(await snapshot(await get('TrajectoryFeedback',id)));
      if(new Set(rows.map(r=>r.caseId)).size!==rows.length)throw fail('DATASET_DUPLICATE','One trajectory per independent native case');
      for(const partition of ['TRAIN','EVAL']){const selected=rows.filter(r=>r.split===partition);if(selected.length<4||new Set(selected.map(r=>r.mechanismKey)).size<2)throw fail('DATASET_SPLIT','Each partition requires four cases from two mechanism groups');}
      const rowsJson=JSON.stringify(rows);result('LearningDataset',{key:commandKey,rowsJson,contentHash:sha(rowsJson),status:'FROZEN',createdBy:principal.id,createdAt:at});
    }else if(operation==='trainModel'){
      const parent=await active();await reference('activePolicy','DecisionPolicy',parent._id);
      const d=await dataset(input.dataset);await reference('dataset','LearningDataset',d.object._id);
      const trained=await dynamicsRequest('/v1/train',{parentArtifactJson:parent.artifactJson,rows:d.rows});
      if(trained.artifactHash!==sha(trained.artifactJson)||trained.evaluation.artifactHash!==trained.artifactHash||trained.evaluation.updatedParameters!==260||trained.evaluation.parameterL1Change<=0)throw fail('MODEL_OUTPUT','Training did not produce a valid changed neural artifact');
      result('DecisionPolicy',{key:commandKey,artifactJson:trained.artifactJson,artifactHash:trained.artifactHash,datasetJson:JSON.stringify({datasetId:d.object._id,contentHash:d.object.contentHash}),evaluationJson:trained.evaluationJson,evaluationHash:sha(trained.evaluationJson),trainedBy:principal.id,stage:trained.evaluation.passed?'CANDIDATE':'HELD',parentId:parent._id,createdAt:at});extra.evaluation=trained.evaluation;
    }else{
      const candidate=await reference('policy','DecisionPolicy',input.id);
      await verify(candidate);
      const previous=(await all('DecisionPolicy')).find(p=>['ACTIVE','SUSPENDED'].includes(p.stage));
      if(previous?._id===candidate._id)throw fail('NO_CHANGE','Model already selected');
      if(operation==='publishModel'){
        if(candidate.stage!=='CANDIDATE'||candidate.trainedBy===principal.id||candidate.parentId!==previous?._id)throw fail('MODEL_APPROVAL','Independent release owner and current parent required');
        const parent=await get('DecisionPolicy',candidate.parentId),d=await dataset(parse(candidate.datasetJson).datasetId);
        const review=await dynamicsRequest('/v1/review',{parentArtifactJson:parent.artifactJson,rows:d.rows,candidateArtifactJson:candidate.artifactJson,evaluationJson:candidate.evaluationJson});
        if(!review.verified||!review.passed||review.artifactHash!==candidate.artifactHash)throw fail('MODEL_GATE','Recomputed release evaluation failed');
      }else if(!['STANDBY','ACTIVE'].includes(candidate.stage)||!candidate.approvedBy)throw fail('ROLLBACK_GATE','Only a previously published clean model may be restored');
      if(previous){await reference('activePolicy','DecisionPolicy',previous._id);effects.push(update('activePolicy',{stage:'STANDBY'}));}
      effects.push(update('policy',{stage:'ACTIVE',approvedBy:principal.id}));c.setResult('DecisionPolicy','policy');
    }
    return true;
  }
  return {active,compile,suspend,verify};
}
