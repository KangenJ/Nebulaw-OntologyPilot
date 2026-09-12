import { digest } from '../../../packages/plus-contracts/dist/index.js';
import { assertNativeActionParameters,parseActionManifest } from '../../../packages/actions/dist/index.js';
import { taskVerificationManifests } from '../../../domain-packs/lwm-plus/mechanisms/task-verification.mjs';
import { taskPriorityRegistrationManifest } from '../../../domain-packs/lwm-plus/mechanisms/task-priority.mjs';
import { createTaskDomain } from './task-domain.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const ref=(r,schemaRevision)=>({tenantId:r._tenantId,type:r._type,id:r._id,version:r._version,schemaRevision});
/** Fixed read-only inspection for a reviewed request to register a follow-up
 * verification task. Caller is the real submitter/reviewer, not an investigator
 * impersonated for validation. Current read grants do not confer create rights.
 * NativeActionRequests must separately qualify the passed native scenario. */
export function createTaskActionRequestInspector({storage,catalog,tenantId,authorize,taskClassificationFor}){
  return async(p,input,scenario)=>{
    if(p?.tenantId!==tenantId||!p.id||!Array.isArray(p.roles))fail('TASK_REQUEST_FORBIDDEN');
    if(input.actionName!=='NativeRegisterInvestigationTask'||input.optionKey!=='REQUEST_VERIFICATION'||input.scenarioId!==scenario._id)fail('TASK_REQUEST_ACTION_FORBIDDEN');
    const context={tenantId,actorId:p.id},s=scenario.plans?.input;
    if(!s?.episodeId||typeof s.episodeId!=='string')fail('TASK_REQUEST_SCOPE_INVALID');
    const get=async(type,id)=>{const row=await storage.getObject(context,type,id);if(!row||row._tenantId!==tenantId||row._deletedAt)fail('TASK_REQUEST_OBJECT_NOT_FOUND');return row;};
    const episode=await get('PlusEpisode',s.episodeId),root=episode.rootReference;
    if(episode.status!=='OPEN'||root?.tenantId!==tenantId||root.type!=='InvestigationTask'||episode.binding?.rootType!==root.type)fail('TASK_REQUEST_SCOPE_INVALID');
    const resources=[{type:'InvestigationTask',id:root.id,readFields:['workspaceKey','dataClassification','createdAt'],writeFields:[]}];
    const allowed=async()=>await authorize(p,{action:input.actionName,resources:structuredClone(resources)});
    if(!await allowed())fail('TASK_REQUEST_FORBIDDEN');
    const task=await get(root.type,root.id),parents=await storage.getLinks(context,task._id,'MatterTask','inbound',{limit:2});
    if(parents.hasNextPage||parents.totalCount!==1||parents.items.length!==1)fail('TASK_REQUEST_SCOPE_INVALID');
    const parent=parents.items[0];resources.push({type:'Matter',id:parent._fromId,readFields:['workspaceKey'],writeFields:[]});
    if(!await allowed())fail('TASK_REQUEST_FORBIDDEN');const matter=await get('Matter',parent._fromId);
    if(task.workspaceKey!==matter.workspaceKey||task.dataClassification!==episode.classification||task.dataClassification!==scenario.classification
      ||!['SYNTHETIC','AUTHORIZED_REAL'].includes(task.dataClassification)||await taskClassificationFor(p,matter)!==task.dataClassification)fail('TASK_REQUEST_CLASSIFICATION_FORBIDDEN');
    const current=await catalog.read(p),schema=current.bundle.parsed,binding=episode.binding;
    const bridge=schema.linkTypes.find(l=>l.name===binding.rootEpisodeLink);
    if(!bridge||bridge.from!==root.type||bridge.to!=='PlusEpisode')fail('TASK_REQUEST_SCOPE_INVALID');
    const links=await storage.getLinks(context,episode._id,binding.rootEpisodeLink,'inbound',{limit:2});
    if(links.hasNextPage||links.totalCount!==1||links.items.length!==1||links.items[0]._fromId!==task._id)fail('TASK_REQUEST_SCOPE_INVALID');
    const manifest=current.bundle.manifests[input.actionName],expected=manifest?.version===2?taskPriorityRegistrationManifest():taskVerificationManifests()[input.actionName];
    const parsed=parseActionManifest(JSON.stringify(expected)),definition=schema.actionTypes.find(a=>a.name===input.actionName);
    if(!definition||!manifest||!parsed.valid||digest(parsed.manifest)!==digest(manifest))fail('TASK_REQUEST_ACTION_CONTRACT_STALE');
    const params=input.params;if(!params||typeof params!=='object'||Array.isArray(params)||['classification','commandKey','commandHash','traceId'].some(k=>Object.hasOwn(params,k)))fail('TASK_REQUEST_INVALID_INPUT');
    if(params.matter!==matter._id||params.expectedVersion!==matter._version)fail('TASK_REQUEST_SCOPE_CONFLICT');
    try{assertNativeActionParameters(definition,{...params,classification:task.dataClassification,commandKey:'inspection-only',commandHash:digest(params),traceId:'inspection-only'},schema);}catch{fail('TASK_REQUEST_INVALID_INPUT');}
    if(!await allowed()||await taskClassificationFor(p,matter)!==task.dataClassification)fail('TASK_REQUEST_FORBIDDEN');
    const schemaHash=current.bundle.contentHash;
    if(![scenario.plans.createdAt,task.createdAt].every(v=>typeof v==='string'&&Number.isFinite(Date.parse(v))))fail('TASK_REQUEST_TIME_INVALID');
    const notBefore=new Date(Math.max(Date.parse(scenario.plans.createdAt),Date.parse(task.createdAt))).toISOString();
    return {schema:'plus-native-action-inspection-v1',adapterId:'native-task-registration-inspector-v1',actionName:input.actionName,paramsHash:digest(params),
      ontologyHash:schemaHash,manifestHash:digest(manifest),classification:task.dataClassification,
      readSet:{root:ref(task,schemaHash),episode:ref(episode,schemaHash),matter:ref(matter,schemaHash),links:[parent,links.items[0]].map(l=>ref(l,schemaHash))},notBefore};
  };
}

/** Fixed task implementation for the outer request runtime. No independent
 * commit and no caller-supplied native result/command namespace. */
export function createTaskActionRequestExecution(config){
  const domain=createTaskDomain(config);
  return async(p,input,inspection,request)=>{
    if(input.actionName!=='NativeRegisterInvestigationTask'||input.optionKey!=='REQUEST_VERIFICATION'||inspection.adapterId!=='native-task-registration-inspector-v1'
      ||request.actionName!==input.actionName||request.requestHash==null||digest(request.typedParams)!==digest(input.params))fail('TASK_REQUEST_ACTION_FORBIDDEN');
    const plan=await domain.prepareForRequest(input.actionName,input.params,p,request._id),native=plan.readSet;
    if(native.ontologyHash!==inspection.ontologyHash||native.manifestHash!==inspection.manifestHash||native.classification!==inspection.classification||digest(native.input)!==inspection.paramsHash
      ||native.governedRequest?.hash!==request.requestHash||native.governedRequest.version!==request._version)fail('TASK_REQUEST_EXECUTION_STALE');
    return {readRevision:plan.readRevision,inspectionHash:digest(inspection),requestHash:request.requestHash,commandKey:plan.commandKey,commandHash:plan.commandHash,assertCurrent:plan.assertCurrent,stage:plan.stage};
  };
}
