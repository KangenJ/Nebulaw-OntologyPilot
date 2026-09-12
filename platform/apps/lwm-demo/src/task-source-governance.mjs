import { digest } from '../../../packages/plus-contracts/dist/index.js';
import { parseActionManifest } from '../../../packages/actions/dist/index.js';
import { createPlusActionExecutor,sourceEventDigest } from '../../../packages/plus-runtime/dist/index.js';
import { approvedSourceChanges } from '../../../packages/plus-runtime/dist/source-lineage.js';
import { taskSourceGovernanceManifests } from '../../../domain-packs/lwm-plus/mechanisms/task-source-governance.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code,status:409});};
const ref=o=>({tenantId:o._tenantId,type:o._type,id:o._id,version:o._version});
const expected=Object.fromEntries(Object.entries(taskSourceGovernanceManifests()).map(([name,value])=>{const parsed=parseActionManifest(JSON.stringify(value));if(!parsed.valid)throw new Error('INVALID_NATIVE_REPAIR_MANIFEST');return [name,parsed.manifest];}));
/** Native, reviewed source repair. No request-supplied facts, model result or nested transaction commit. */
export function taskSourceGovernanceAdapter({storage,catalog,tenantId,cel,domain,authorize,qualifySource,binding}){
 const context={tenantId};
 const fields={InvestigationTask:['workspaceKey','actualCompletion','actualCompletionAt','actualCompletionRecordedAt','dataClassification'],
  Observation:[...binding.sources[0].qualificationFields,'reportedCompletion','observedAt','receivedAt'],
  TaskCompletionVerification:[...binding.sources[1].qualificationFields,'result','targetTime','recordedAt','validity']};
 const writeFields={NativeInvalidateTaskVerification:{TaskCompletionVerification:['validity','revokedAt','revokedBy','revocationReason']},
  NativeRebuildTaskCompletion:{InvestigationTask:['actualCompletion','actualCompletionAt','actualCompletionRecordedAt'],TaskCompletionRepair:['repairKey','previousTaskVersion','result','targetTime','basisStatus','basis','recordedAt','recordedBy','classification','reason']}};
 async function links(id,type,direction){const page=await storage.getLinks(context,id,type,direction,{limit:1000});if(page.hasNextPage||page.totalCount>1000)fail('TASK_SOURCE_REPAIR_LIMIT');return page.items;}
 async function get(type,id){const row=await storage.getObject(context,type,id);if(!row||row._deletedAt||row._tenantId!==tenantId)fail('TASK_SOURCE_REPAIR_SOURCE_INVALID');return row;}
 async function contracts(p,root){
  const policy=await domain(p);if(!cel||policy?.sourceGovernance?.enabled!==true)fail('TASK_SOURCE_REPAIR_NOT_CONFIGURED');
  if(policy.workspaceClassifications?.[root.workspaceKey]!==root.dataClassification)fail('TASK_SOURCE_REPAIR_CLASSIFICATION_CONFLICT');
  const current=await catalog.read(p);
  for(const [name,manifest]of Object.entries(expected))if(digest(current.bundle.manifests[name]??null)!==digest(manifest))fail('TASK_SOURCE_REPAIR_CONTRACT_STALE');
  return {policy,current};
 }
 async function canWrite(p,root,action){
  const policy=await domain(p);if(policy?.sourceGovernance?.enabled!==true)return false;
  if(!Array.isArray(policy.sourceGovernance.grants))return false;
  return policy.sourceGovernance.grants.some(grant=>grant.principalId===p.id&&Array.isArray(grant.workspaces)&&grant.workspaces.includes(root.workspaceKey)&&Array.isArray(grant.actions)&&grant.actions.includes(action)
   &&Object.entries(writeFields[action]).every(([type,names])=>Array.isArray(grant.types?.[type]?.write)&&names.every(name=>grant.types[type].write.includes(name))&&(type!=='TaskCompletionRepair'||grant.types[type].create===true)));
 }
 async function prepareSourceChange(p,{root,event,replacement,kind}){
  const {policy,current}=await contracts(p,root),epoch=await storage.getReadRevision(context);
  if(kind==='CORRECTION'&&event.eventKind!=='OBSERVATION')fail('TASK_VERIFICATION_CORRECTION_REQUIRES_REVOKE_AND_NEW_CHECK');
  const rootEvents=[];for(const link of await links(root._id,'TaskPlusEvent','outbound'))rootEvents.push(await get('PlusEvent',link._toId));
  if(!rootEvents.some(e=>e._id===event._id)||replacement&&!rootEvents.some(e=>e._id===replacement._id))fail('TASK_SOURCE_REPAIR_SCOPE_CONFLICT');
  const references=rootEvents.map(e=>e.sourceReference);
  if(!await authorize(p,'source:read',{root:{type:root._type,id:root._id},fields,sources:references}))fail('TASK_SOURCE_REPAIR_FORBIDDEN');
  const currentRoot=await get('InvestigationTask',root._id);if(currentRoot._version!==root._version)fail('TASK_SOURCE_REPAIR_VERSION_CONFLICT');
  const invalidatedEvents=rootEvents.filter(e=>!e.revoked&&e._id!==event._id&&event.eventKind==='OBSERVATION'&&e.eventKind==='VERIFICATION'&&e.verification?.observation?.id===event.sourceReference.id);
  const excluded=new Set([event._id,...invalidatedEvents.map(e=>e._id)]),checksToInvalidate=[],eligible=[],eligibility=[];
  for(const candidate of rootEvents){
   if(sourceEventDigest(candidate)!==candidate.contentHash)fail('TASK_SOURCE_REPAIR_SOURCE_INVALID');
   if(candidate.eventKind!=='VERIFICATION')continue;
   if(candidate.sourceReference?.type!=='TaskCompletionVerification')fail('TASK_SOURCE_REPAIR_SOURCE_INVALID');
   const check=await get('TaskCompletionVerification',candidate.sourceReference.id);
   const roots=await links(check._id,'TaskCompletionCheck','inbound');if(roots.length!==1||roots[0]._fromId!==root._id)fail('TASK_SOURCE_REPAIR_SCOPE_CONFLICT');
   if(excluded.has(candidate._id)){if(!candidate.revoked)checksToInvalidate.push(check);continue;}
   if(candidate.revoked||check.validity==='REVOKED'||(await approvedSourceChanges(storage,context,[candidate._id])).length)continue;
   const historical=await storage.getObjectAtVersion(context,check._type,check._id,candidate.sourceReference.version);
   if(!historical)fail('TASK_SOURCE_REPAIR_SOURCE_INVALID');
   // Remaining facts may only use a currently qualified independent native check.
   const qualification=await qualifySource(p,{root,event:candidate,source:historical,rule:binding.sources[1]});
   eligibility.push({event:ref(candidate),qualification});
   if(qualification.verificationMode==='GOLD')eligible.push({event:candidate,check:historical});
  }
  eligible.sort((a,b)=>b.check.targetTime.localeCompare(a.check.targetTime)||a.event._id.localeCompare(b.event._id));
  const latest=eligible[0]?.check.targetTime,atLatest=eligible.filter(e=>e.check.targetTime===latest),values=new Set(atLatest.map(e=>e.check.result));
  const basisStatus=values.size===1?'VERIFIED':values.size>1?'CONFLICTED':'UNVERIFIED',result=basisStatus==='VERIFIED'?atLatest[0].check.result:'UNKNOWN',targetTime=basisStatus==='VERIFIED'?latest:null;
  const basis={schema:'task-completion-repair-v1',excludedEventIds:[...excluded].sort(),eligibleChecks:eligible.map(e=>({event:ref(e.event),check:ref(e.check),targetTime:e.check.targetTime})),basisStatus};
  const policyHash=digest({sources:policy.sources,verificationMethods:policy.verificationMethods,workspaceClassifications:policy.workspaceClassifications,sourceGovernance:policy.sourceGovernance});
  const fingerprint=digest({schema:'task-source-change-native-v1',kind,root:ref(root),event:ref(event),replacement:replacement?ref(replacement):null,
   rootEvents:rootEvents.map(e=>({reference:ref(e),hash:e.contentHash,revoked:e.revoked})).sort((a,b)=>a.reference.id.localeCompare(b.reference.id)),
   checksToInvalidate:checksToInvalidate.map(ref).sort((a,b)=>a.id.localeCompare(b.id)),eligibility,policyHash,ontologyHash:current.bundle.contentHash,result,targetTime,basis});
  return {fingerprint,invalidatedEvents,async stage(tx,ctx,change){
   if(!p.roles.includes('model_owner'))fail('TASK_SOURCE_REPAIR_FORBIDDEN');
   const after=[];
   const executor=createPlusActionExecutor({storage,cel,security:{checkPermission:async(_actor,action)=>({allowed:await canWrite(p,root,action)})},
    stageSourceEvents:async(transaction,envelope)=>{
     for(const object of Object.values(envelope.audit.detail.after??{})){
      after.push(object);
      if(object._type==='TaskCompletionRepair'){
       const link=await transaction.createLink('TaskRepairSourceChange',object._id,change._id);after.push(link);
       envelope.affectedObjects.push({type:link._type,id:link._id,changeType:'created'});envelope.audit.detail.after[link._type+':'+link._id]=link;
      }
     }
    }});
   async function stage(action,input,key){
    const params={...input,commandKey:digest([tenantId,change._id,action,key]),commandHash:digest({change:change.requestHash,fingerprint,action,input}),traceId:ctx.traceId};
    const result=await executor.stage(current.bundle.manifests[action],params,{id:p.id,type:'user',roles:[...p.roles]},{requestContext:ctx,expectedReadRevision:epoch},current.bundle.parsed,tx);
    if(!result.success)throw Object.assign(new Error('TASK_SOURCE_REPAIR_EXECUTION_FAILED'),{code:'TASK_SOURCE_REPAIR_EXECUTION_FAILED',status:409,cause:result.errors});
   }
   for(const check of checksToInvalidate)await stage('NativeInvalidateTaskVerification',{verification:check._id,expectedVersion:check._version,reason:'Approved source change '+change._id},check._id);
   await stage('NativeRebuildTaskCompletion',{task:root._id,expectedVersion:root._version,result,targetTime,basisStatus,basis,classification:root.dataClassification,reason:'Approved source change '+change._id},root._id);
   return after;
  }};
 }
 return {assertSourceChangeSafe:async(p,{root})=>{await contracts(p,root);},prepareSourceChange};
}
