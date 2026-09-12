import {digest} from '../../platform/packages/plus-contracts/dist/index.js';
import {parseActionManifest} from '../../platform/packages/actions/dist/index.js';
import {createTaskDomainAccess} from '../../platform/apps/lwm-demo/src/task-access.mjs';
import {taskVerificationManifests} from '../../platform/domain-packs/lwm-plus/mechanisms/task-verification.mjs';
import {taskPriorityRegistrationManifest} from '../../platform/domain-packs/lwm-plus/mechanisms/task-priority.mjs';
import {createPrivateScenarioAccess} from './scenario-services.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};
const actionName='NativeRegisterInvestigationTask',optionKey='REQUEST_VERIFICATION';
const ref=(r,schemaRevision)=>({tenantId:r._tenantId,type:r._type,id:r._id,version:r._version,schemaRevision});

// Discover native historical scenarios and current typed action form bindings.
// No prediction values, raw model read set or execution permission are exposed.
export function createPrivateActionProposalCatalog(options){
  const {storage,tenantId,catalog,scenarios,actionRequests,access,reauthenticate}=options;
  if(typeof scenarios?.readHistory!=='function'||typeof actionRequests?.read!=='function')fail('ACTION_PROPOSAL_PROVIDER_REQUIRED');
  const domain=createTaskDomainAccess({...options,reauthenticate:async()=>{await reauthenticate?.();}}),scenarioAccess=createPrivateScenarioAccess(options);
  async function prepare(p){
    if(p?.tenantId!==tenantId||!p.roles?.includes('investigator'))fail('ACTION_PROPOSAL_FORBIDDEN');
    const authority=await access.authorizationRevision(p),ctx={tenantId,actorId:p.id},epoch=await storage.getReadRevision(ctx);
    if(!await access.mayDiscover(p))fail('ACTION_PROPOSAL_FORBIDDEN');return {p,authority,ctx,epoch};
  }
  async function fence(s){if(await access.authorizationRevision(s.p)!==s.authority)fail('ACTION_PROPOSAL_AUTHORITY_STALE');if(await storage.getReadRevision(s.ctx)!==s.epoch)fail('CONFLICT');}
  async function allowed(p,root,matter){return domain.authorize(p,{action:actionName,resources:[
    {type:'InvestigationTask',id:root,readFields:['workspaceKey','dataClassification','createdAt'],writeFields:[]},
    ...(matter?[{type:'Matter',id:matter,readFields:['workspaceKey'],writeFields:[]}]:[]),
  ]});}
  async function scopeContext(s,row,current){
    const input=row.plans?.input,episode=await storage.getObject(s.ctx,'PlusEpisode',input.episodeId),root=episode?.rootReference;
    if(!episode||episode._deletedAt||episode._tenantId!==tenantId||root?.tenantId!==tenantId||root.type!=='InvestigationTask'||episode.binding?.rootType!==root.type)return null;
    if(!await allowed(s.p,root.id))return null;
    const task=await storage.getObject(s.ctx,root.type,root.id),parents=await storage.getLinks(s.ctx,root.id,'MatterTask','inbound',{limit:2});
    if(!task||task._deletedAt||parents.hasNextPage||parents.totalCount!==1||parents.items.length!==1)fail('ACTION_PROPOSAL_SCOPE_INVALID');
    const parent=parents.items[0];if(parent._fromType!=='Matter'||parent._toType!==root.type||parent._toId!==task._id||parent._tenantId!==tenantId)fail('ACTION_PROPOSAL_SCOPE_INVALID');
    if(!await allowed(s.p,task._id,parent._fromId))return null;const matter=await storage.getObject(s.ctx,'Matter',parent._fromId);
    if(!matter||matter._deletedAt||task.workspaceKey!==matter.workspaceKey||task.dataClassification!==episode.classification||task.dataClassification!==row.classification
      ||!['SYNTHETIC','AUTHORIZED_REAL'].includes(row.classification)||await domain.taskClassificationFor(s.p,matter)!==row.classification)fail('ACTION_PROPOSAL_CLASSIFICATION_FORBIDDEN');
    const bridge=current.bundle.parsed.linkTypes.find(l=>l.name===episode.binding.rootEpisodeLink);
    if(!bridge||bridge.from!==root.type||bridge.to!=='PlusEpisode')fail('ACTION_PROPOSAL_SCOPE_INVALID');
    const links=await storage.getLinks(s.ctx,episode._id,bridge.name,'inbound',{limit:2});
    if(links.hasNextPage||links.totalCount!==1||links.items.length!==1||links.items[0]._fromId!==task._id||links.items[0]._toId!==episode._id)fail('ACTION_PROPOSAL_SCOPE_INVALID');
    return {root:ref(task,current.bundle.contentHash),matter:ref(matter,current.bundle.contentHash),episode:ref(episode,current.bundle.contentHash),episodeStatus:episode.status};
  }
  function actionForm(current){
    const schema=current.bundle.parsed,manifest=current.bundle.manifests[actionName],definition=schema.actionTypes.find(a=>a.name===actionName);
    const expected=manifest?.version===2?taskPriorityRegistrationManifest():taskVerificationManifests()[actionName],parsed=parseActionManifest(JSON.stringify(expected));
    if(!definition||!manifest||!parsed.valid||digest(parsed.manifest)!==digest(manifest))fail('ACTION_PROPOSAL_ACTION_CONTRACT_STALE');
    const server=['classification','commandKey','commandHash','traceId'],bound=['matter','expectedVersion'],user=['taskNumber','title','priority','assignee','instructions','dueAt'];
    const params=definition.fields.filter(f=>f.directives.some(d=>d.kind==='param'));
    if(params.length!==server.length+bound.length+user.length||params.some(f=>![...server,...bound,...user].includes(f.name)||f.type.isList))fail('ACTION_PROPOSAL_ACTION_CONTRACT_STALE');
    const fields=params.filter(f=>user.includes(f.name)).map(f=>{const values=schema.enums.find(e=>e.name===f.type.name)?.values.map(v=>v.name)??null;
      if(!['String','DateTime'].includes(f.type.name)&&!values)fail('ACTION_PROPOSAL_ACTION_CONTRACT_STALE');
      return {name:f.name,type:f.type.name,required:f.type.nonNull,values};});
    return {actionName,optionKey,ontologyHash:current.bundle.contentHash,manifestHash:digest(manifest),fields,serverFields:server,boundFields:bound};
  }
  return {async read(principal){
    const s=await prepare(structuredClone(principal)),current=await catalog.read(s.p),form=actionForm(current),items=[];
    const page=await storage.queryObjects(s.ctx,'PlusScenarioRun',{and:[]},{limit:101});
    if(page.hasNextPage||page.totalCount!==page.items.length||page.items.length>100||new Set(page.items.map(r=>r._id)).size!==page.items.length)fail('ACTION_PROPOSAL_COLLECTION_LIMIT');
    for(const row of page.items){
      if(row._tenantId!==tenantId||row._type!=='PlusScenarioRun'||row._deletedAt)fail('ACTION_PROPOSAL_INTEGRITY');
      const input=row.plans?.input,scope={scenarioId:row._id,key:input?.key,episodeId:input?.episodeId,actionName};
      if(!await access.authorize(s.p,'action-request:submit',scope)||!await scenarioAccess.authorize(s.p,'scenario:read',scope.key,scope.episodeId))continue;
      const context=await scopeContext(s,row,current);if(!context)continue;
      const v=await scenarios.readHistory(row._id,s.p);
      if(v.id!==row._id||v.version!==row._version||digest(v.record)!==digest(row)||v.readOnly!==true||v.nativeAdmissionChecked!==false||v.currentBasisChecked!==false||v.predictionReady!==false||v.executionAuthorized!==false)fail('ACTION_PROPOSAL_INTEGRITY');
      const opts=row.predictions?.options;
      if(!Array.isArray(opts)||opts.filter(o=>o.key===optionKey).length!==1||row.predictions.executionAuthorized!==false||row.predictions.businessFactsWritten!==false)continue;
      const reasons=[];if(row.readiness!=='READY')reasons.push('SCENARIO_'+row.readiness);if(context.episodeStatus!=='OPEN')reasons.push('EPISODE_'+context.episodeStatus);
      const scenario={id:row._id,version:row._version,hash:row.contentHash,createdAt:row.plans.createdAt};
      const item={scenario,...context,key:scope.key,classification:row.classification,form:structuredClone(form),unavailableReasons:reasons,
        qualification:'NOT_CHECKED',predictionReady:false,executionAuthorized:false,command:reasons.length?null:{scenarioId:row._id,optionKey,actionName,boundParams:{matter:context.matter.id,expectedVersion:context.matter.version}}};
      items.push({optionKey:digest(item),...item});
    }
    await fence(s);items.sort((a,b)=>a.scenario.id.localeCompare(b.scenario.id));
    return {schema:'plus-action-proposal-catalog-v1',items,readOnly:true,qualification:'NOT_CHECKED',predictionReady:false,executionAuthorized:false};
  },async lookup(raw,principal){
    if(!raw||Object.keys(raw).join(',')!=='requestKey'||typeof raw.requestKey!=='string'||!raw.requestKey.trim()||raw.requestKey.length>2000)fail('ACTION_PROPOSAL_INVALID_INPUT');
    const s=await prepare(structuredClone(principal)),key=digest([tenantId,s.p.id,raw.requestKey]);
    const page=await storage.queryObjects(s.ctx,'PlusActionRequest',{field:'requestKey',operator:'eq',value:key},{limit:2});
    if(page.hasNextPage||page.totalCount>1||page.items.length!==page.totalCount)fail('ACTION_PROPOSAL_INTEGRITY');let item=null;
    if(page.items.length){const row=page.items[0],v=await actionRequests.read(row._id,s.p),b=v.record?.readSet,root=b?.inspection?.readSet?.root,matter=b?.inspection?.readSet?.matter;
      if(digest(v.record)!==digest(row)||row.submittedBy!==s.p.id||row.requestKey!==key||root?.type!=='InvestigationTask'||matter?.type!=='Matter'||root.tenantId!==tenantId||matter.tenantId!==tenantId||!await allowed(s.p,root.id,matter.id))fail('ACTION_PROPOSAL_FORBIDDEN');
      item={id:row._id,version:row._version,status:row.status,requestHash:row.requestHash,executionAuthorized:false,physicalOutcomeVerified:false};
    }
    await fence(s);return {schema:'plus-action-proposal-lookup-v1',item,readOnly:true,absenceIsNotCancellation:true,predictionReady:false,executionAuthorized:false};
  }};
}
