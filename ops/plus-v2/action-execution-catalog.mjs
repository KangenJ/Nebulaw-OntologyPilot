import {digest} from '../../platform/packages/plus-contracts/dist/index.js';
import {createTaskDomainAccess} from '../../platform/apps/lwm-demo/src/task-access.mjs';

const fail=code=>{throw Object.assign(Error(code),{code});};
const ref=(v,type,tenantId)=>v?.tenantId===tenantId&&v.type===type&&typeof v.id==='string'&&v.id.length>0&&Number.isSafeInteger(v.version)&&v.version>0;

/** Short, current-authorized history of the investigator's own native requests.
 * Does not admit models, re-run scenarios, check create rights or grant execution.
 * Historical action-read permission AND current native reference read grants are
 * required before returning params/reasons. No raw model/inspection read set. */
export function createPrivateActionExecutionCatalog(options){
  const {storage,tenantId,actionRequests,jobsAccess,actionAccess,reauthenticate}=options;
  if(typeof storage?.getReadRevision!=='function'||typeof actionRequests?.read!=='function'||typeof jobsAccess?.submissionKeys!=='function'
    ||typeof actionAccess?.authorize!=='function')fail('ACTION_EXECUTION_CATALOG_PROVIDER_REQUIRED');
  const domain=createTaskDomainAccess({...options,reauthenticate:async()=>{await reauthenticate?.();}});
  return {async read(principal){
    const p=structuredClone(principal);
    if(p?.tenantId!==tenantId||!p.id||!p.roles?.includes('investigator'))fail('ACTION_EXECUTION_CATALOG_FORBIDDEN');
    const ctx={tenantId,actorId:p.id},authority=await jobsAccess.authorizationRevision(p),epoch=await storage.getReadRevision(ctx),keys=await jobsAccess.submissionKeys(p),items=[];
    if(keys.length){
      const page=await storage.queryObjects(ctx,'PlusActionRequest',{field:'submittedBy',operator:'eq',value:p.id},{limit:101});
      if(page.hasNextPage||page.totalCount!==page.items.length||page.items.length>100||new Set(page.items.map(r=>r._id)).size!==page.items.length)fail('ACTION_EXECUTION_CATALOG_COLLECTION_LIMIT');
      for(const row of page.items){
        if(row._type!=='PlusActionRequest'||row._tenantId!==tenantId||row._deletedAt||row.submittedBy!==p.id)fail('ACTION_EXECUTION_CATALOG_INTEGRITY');
        const scope=row.readSet?.scope;
        if(!keys.includes(scope?.key)||!await actionAccess.authorize(p,'action-request:read',scope))continue;
        const value=await actionRequests.read(row._id,p),r=value.record,b=r?.readSet,root=b?.inspection?.readSet?.root,matter=b?.inspection?.readSet?.matter;
        if(value.id!==row._id||value.version!==row._version||value.currentBasisChecked!==false||value.executionAuthorized!==false
          ||digest(r)!==digest(row)||digest(b.scope)!==digest(scope)||b.inspection.adapterId!=='native-task-registration-inspector-v1'
          ||!ref(root,'InvestigationTask',tenantId)||!ref(matter,'Matter',tenantId)||r.actionName!=='NativeRegisterInvestigationTask')fail('ACTION_EXECUTION_CATALOG_INTEGRITY');
        if(!await domain.authorize(p,{action:r.actionName,resources:[
          {type:root.type,id:root.id,readFields:['workspaceKey','dataClassification','createdAt'],writeFields:[]},
          {type:matter.type,id:matter.id,readFields:['workspaceKey'],writeFields:[]},
        ]}))continue;
        const reasons=[];
        if(r.status!=='APPROVED')reasons.push('REQUEST_'+r.status);
        if(!await actionAccess.authorize(p,'action-request:execute',scope))reasons.push('EXECUTION_SUBMISSION_FORBIDDEN');
        const d=value.decision;
        items.push({optionKey:digest({id:r._id,version:r._version,requestHash:r.requestHash}),key:scope.key,
          request:{id:r._id,version:r._version,status:r.status,actionName:r.actionName,params:structuredClone(r.typedParams),reason:b.input.reason,requestHash:r.requestHash,
            submittedBy:r.submittedBy,submittedAt:r.submittedAt},root:structuredClone(root),scenario:structuredClone(b.scenario),episodeId:scope.episodeId,
          classification:b.inspection.classification,decision:d?{id:d._id,version:d._version,decision:d.decision,decidedBy:d.decidedBy,decidedAt:d.decidedAt,reason:d.reason}:null,
          receipt:value.nativeReceipt?{id:value.nativeReceipt._id,version:value.nativeReceipt._version}:null,
          unavailableReasons:reasons,qualification:'NOT_CHECKED',executionAuthorized:false,
          command:reasons.length?null:{key:scope.key,requestId:r._id,expectedVersion:r._version}});
      }
    }
    if(await jobsAccess.authorizationRevision(p)!==authority||digest(await jobsAccess.submissionKeys(p))!==digest(keys))fail('ACTION_EXECUTION_CATALOG_AUTHORITY_STALE');
    if(await storage.getReadRevision(ctx)!==epoch)fail('CONFLICT');
    items.sort((a,b)=>a.request.id.localeCompare(b.request.id));
    return {schema:'plus-action-execution-catalog-v1',keys,items,readOnly:true,qualification:'NOT_CHECKED',predictionReady:false,executionAuthorized:false};
  }};
}
