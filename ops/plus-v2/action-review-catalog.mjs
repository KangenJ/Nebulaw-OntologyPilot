import {digest} from '../../platform/packages/plus-contracts/dist/index.js';
import {createTaskDomainAccess} from '../../platform/apps/lwm-demo/src/task-access.mjs';

const fail=code=>{throw Object.assign(Error(code),{code});};
const ref=(r,type,tenant)=>r?.tenantId===tenant&&r.type===type&&typeof r.id==='string'&&r.id.length>0&&Number.isSafeInteger(r.version)&&r.version>0;

// Independent review inbox. Native request history and present domain read
// grants are required; execution-job permissions and model admission are not.
export function createPrivateActionReviewCatalog(options){
  const {storage,tenantId,actionRequests,access,reauthenticate}=options;
  if(typeof actionRequests?.read!=='function'||typeof access?.authorize!=='function'||typeof access?.mayDiscover!=='function')fail('ACTION_REVIEW_PROVIDER_REQUIRED');
  const domain=createTaskDomainAccess({...options,reauthenticate:async()=>{await reauthenticate?.();}});
  return {async read(principal){
    const p=structuredClone(principal);if(p?.tenantId!==tenantId||!p.roles?.includes('case_reviewer'))fail('ACTION_REVIEW_FORBIDDEN');
    const ctx={tenantId,actorId:p.id},authority=await access.authorizationRevision(p),epoch=await storage.getReadRevision(ctx),items=[];
    if(!await access.mayDiscover(p))fail('ACTION_REVIEW_FORBIDDEN');
    const page=await storage.queryObjects(ctx,'PlusActionRequest',{and:[]},{limit:101});
    if(page.hasNextPage||page.items.length>100||page.totalCount!==page.items.length||new Set(page.items.map(r=>r._id)).size!==page.items.length)fail('ACTION_REVIEW_COLLECTION_LIMIT');
    for(const row of page.items){
      if(row._tenantId!==tenantId||row._type!=='PlusActionRequest'||row._deletedAt)fail('ACTION_REVIEW_INTEGRITY');
      const scope=row.readSet?.scope;
      if(!await access.authorize(p,'action-request:read',scope))continue;
      const v=await actionRequests.read(row._id,p),r=v.record,b=r?.readSet,root=b?.inspection?.readSet?.root,matter=b?.inspection?.readSet?.matter;
      if(v.id!==row._id||v.version!==row._version||digest(r)!==digest(row)||v.currentBasisChecked!==false||v.executionAuthorized!==false
        ||b?.inspection?.adapterId!=='native-task-registration-inspector-v1'||!ref(root,'InvestigationTask',tenantId)||!ref(matter,'Matter',tenantId)
        ||r.actionName!=='NativeRegisterInvestigationTask')fail('ACTION_REVIEW_INTEGRITY');
      if(!await domain.authorize(p,{action:r.actionName,resources:[
        {type:root.type,id:root.id,readFields:['workspaceKey','dataClassification','createdAt'],writeFields:[]},
        {type:matter.type,id:matter.id,readFields:['workspaceKey'],writeFields:[]},
      ]}))continue;
      const reasons=[];if(r.status!=='PROPOSED')reasons.push('REQUEST_'+r.status);
      if(r.submittedBy===p.id)reasons.push('INDEPENDENT_REVIEW_REQUIRED');
      if(!await access.authorize(p,'action-request:decide',scope))reasons.push('DECISION_FORBIDDEN');
      const d=v.decision;
      items.push({optionKey:digest({id:r._id,version:r._version,requestHash:r.requestHash}),
        request:{id:r._id,version:r._version,status:r.status,requestHash:r.requestHash,actionName:r.actionName,params:structuredClone(r.typedParams),reason:b.input.reason,submittedBy:r.submittedBy,submittedAt:r.submittedAt},
        root:structuredClone(root),matter:structuredClone(matter),scenario:structuredClone(b.scenario),episodeId:scope.episodeId,classification:b.inspection.classification,
        decision:d?{id:d._id,version:d._version,inputVersion:d.inputVersion,decision:d.decision,decidedBy:d.decidedBy,decidedAt:d.decidedAt,reason:d.reason}:null,
        unavailableReasons:reasons,command:reasons.length?null:{requestId:r._id,expectedVersion:r._version},qualification:'NOT_CHECKED',executionAuthorized:false});
    }
    if(await access.authorizationRevision(p)!==authority)fail('ACTION_REVIEW_AUTHORITY_STALE');
    if(await storage.getReadRevision(ctx)!==epoch)fail('CONFLICT');items.sort((a,b)=>a.request.id.localeCompare(b.request.id));
    return {schema:'plus-action-review-catalog-v1',items,readOnly:true,qualification:'NOT_CHECKED',predictionReady:false,executionAuthorized:false};
  }};
}
