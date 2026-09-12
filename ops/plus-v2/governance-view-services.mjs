import {readActionOutboxEnvelope} from '../../platform/packages/plus-runtime/dist/index.js';
import {createPrivateAuthorizationRevision} from './private-authority.mjs';
import {createPrivateObjectReader} from './object-read-services.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const text=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(v);
const list=v=>Array.isArray(v)&&v.length>0&&v.length<=100&&v.every(text)&&new Set(v).size===v.length;
const code=v=>typeof v==='string'&&/^[A-Z][A-Z0-9_]{0,90}$/.test(v)?v:null;
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const time=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))?v:null;
const permissions=['audit:read','jobs:read','host:read','object-audit:read'];
const states=['PENDING','LEASED','SUCCEEDED','FAILED','STALE','CANCELLED'];
const workerStates=['STARTING','DISABLED','IDLE','RUNNING','DEGRADED','FAILED','STOPPED'];
export function createPrivateGovernanceView(options){
  const {storage,tenantId,loadPolicy,hostState}=options,authority=createPrivateAuthorizationRevision(options);
  function policy(){const v=structuredClone(loadPolicy().governanceView);
    if(v===undefined)return {enabled:false,grants:[]};
    if(!exact(v,['version','enabled','grants'])||v.version!=='plus-private-governance-view-v1'||typeof v.enabled!=='boolean'||!Array.isArray(v.grants)||v.grants.length>500)fail('GOVERNANCE_CONFIGURATION_INVALID');
    for(const g of v.grants)if(!exact(g,['principalId','requiredRoles','permissions','actorIds'])||!text(g.principalId)||!list(g.requiredRoles)||!list(g.permissions)||g.permissions.some(p=>!permissions.includes(p))||!list(g.actorIds))fail('GOVERNANCE_CONFIGURATION_INVALID');
    return v;
  }
  async function prepare(principal,permission){const p=structuredClone(principal),revision=await authority(p),v=policy();
    const grants=v.enabled?v.grants.filter(g=>g.principalId===p.id&&g.requiredRoles.every(r=>p.roles.includes(r))&&g.permissions.includes(permission)):[];
    if(!grants.length)fail('GOVERNANCE_FORBIDDEN');const actors=[...new Set(grants.flatMap(g=>g.actorIds))];if(actors.length>100)fail('GOVERNANCE_COLLECTION_LIMIT');
    const ctx={tenantId,actorId:p.id},epoch=await storage.getReadRevision(ctx);return {p,ctx,revision,epoch,actors};
  }
  async function fence(s){if(await authority(s.p)!==s.revision)fail('GOVERNANCE_AUTHORITY_STALE');if(await storage.getReadRevision(s.ctx)!==s.epoch)fail('CONFLICT');}
  function query(raw,root=false){if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!(root?['rootType','rootId','limit','after']:['limit','after']).includes(k))
    ||Object.values(raw).some(v=>typeof v!=='string')||raw.limit!==undefined&&!/^(?:[1-9]|[1-4][0-9]|50)$/.test(raw.limit)||raw.after!==undefined&&!text(raw.after)
    ||root&&(!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(raw.rootType)||!text(raw.rootId)))fail('GOVERNANCE_INVALID_INPUT');return {limit:Number(raw.limit??25),after:raw.after};}
  function audit(record,s){if(record?.tenantId!==tenantId||!s.actors.includes(record.actor?.id)||!text(record.id)||!time(record.timestamp)||!text(record.traceId)
    ||!['user','system','connector'].includes(record.actor.type)||!['read','create','update','delete','action','query','link','unlink'].includes(record.operation?.type)
    ||!['success','denied','error'].includes(record.detail?.result))fail('GOVERNANCE_INTEGRITY');
    return {id:record.id,timestamp:record.timestamp,traceId:record.traceId,actorId:record.actor.id,actorType:record.actor.type,
      operation:record.operation.type,actionType:text(record.operation.actionType)?record.operation.actionType:null,result:record.detail.result,errorCode:code(record.detail.denialReason)};
  }
  const common=()=>({readOnly:true,predictionReady:false,executionAuthorized:false,qualification:'NOT_CHECKED',observedAt:new Date().toISOString()});
  const page=(items,limit)=>({items:items.slice(0,limit),hasMore:items.length>limit,nextAfter:items.length>limit?items[limit-1].id:null});
  return {assertConfigured:policy,async read(mode,raw,principal){
    if(!['host','audit','jobs','object'].includes(mode))fail('NOT_FOUND');
    const s=await prepare(principal,mode==='object'?'object-audit:read':mode+':read');let result;
    if(mode==='host'){
      if(!exact(raw,[]))fail('GOVERNANCE_INVALID_INPUT');if(typeof hostState!=='function')fail('GOVERNANCE_HOST_NOT_CONFIGURED');const h=await hostState();
      if(!h||!Array.isArray(h.workers)||h.workers.length!==5||new Set(h.workers.map(w=>w.key)).size!==5||h.workers.some(w=>!['audit','selection','evaluation','decision','action'].includes(w.key)))fail('GOVERNANCE_INTEGRITY');
      const workers=h.workers.map(w=>{if(!workerStates.includes(w.state?.status))fail('GOVERNANCE_INTEGRITY');return {key:w.key,status:w.state.status,lastRunAt:time(w.state.lastRunAt),lastError:code(w.state.lastError),
        processed:integer(w.state.processed)?w.state.processed:null,outboxFailed:integer(w.state.outboxHealth?.failed)?w.state.outboxHealth.failed:null,retryWaiting:integer(w.state.outboxHealth?.retryWaiting)?w.state.outboxHealth.retryWaiting:null};});
      result={schema:'plus-governance-host-v1',workers,sample:'CURRENT_PROCESS_NOT_CLUSTER_HEALTH',...common()};
    }else if(mode==='audit'){
      const q=query(raw);if(typeof storage.auditStore?.queryPage!=='function')fail('GOVERNANCE_AUDIT_NOT_CONFIGURED');
      const v=await storage.auditStore.queryPage({tenantId,actorIds:s.actors,...q});
      if(!Array.isArray(v.records)||v.records.length>q.limit||typeof v.hasMore!=='boolean'||v.hasMore!==(v.nextAfter!==null))fail('GOVERNANCE_INTEGRITY');
      result={schema:'plus-governance-audit-v1',items:v.records.map(r=>audit(r,s)),hasMore:v.hasMore,nextAfter:v.nextAfter,scope:'EXPLICIT_ACTORS_IN_CURRENT_TENANT',...common()};
    }else if(mode==='jobs'){
      const q=query(raw),filters=[{or:s.actors.map(value=>({field:'principalId',operator:'eq',value}))}];if(q.after)filters.push({field:'_id',operator:'gt',value:q.after});
      const v=await storage.queryObjects(s.ctx,'PlusExecution',{and:filters},{limit:q.limit+1,orderBy:[{field:'_id',direction:'asc'}]});
      const items=v.items.map(r=>{if(r._tenantId!==tenantId||r._type!=='PlusExecution'||r._deletedAt||!text(r._id)||!integer(r._version)||r._version<1||!s.actors.includes(r.principalId)||!text(r.kind)||!states.includes(r.status)||!integer(r.attempts))fail('GOVERNANCE_INTEGRITY');
        return {id:r._id,version:r._version,kind:r.kind,status:r.status,attempts:r.attempts,principalId:r.principalId,errorCode:code(r.errorCode),leaseUntil:time(r.leaseUntil)};});
      if(items.length>q.limit+1||new Set(items.map(r=>r.id)).size!==items.length)fail('GOVERNANCE_INTEGRITY');
      result={schema:'plus-governance-jobs-v1',...page(items,q.limit),scope:'RECORDED_METADATA_NOT_RESULT_ADMISSION',...common()};
    }else{
      const q=query(raw,true),objects=createPrivateObjectReader(options),root=await objects.read(raw.rootType,raw.rootId,s.p);
      const rows=await storage.queryObjects(s.ctx,'PlusOutbox',{and:[]},{limit:1001});
      if(rows.hasNextPage||rows.totalCount!==rows.items.length||rows.items.length>1000)fail('GOVERNANCE_COLLECTION_LIMIT');const items=[];
      for(const row of rows.items){if(!s.actors.includes(row.envelope?.audit?.actor?.id))continue;const envelope=readActionOutboxEnvelope(row,tenantId);
        if(!envelope.affectedObjects.some(r=>r.type===raw.rootType&&r.id===raw.rootId))continue;
        if(!['PENDING','LEASED','DELIVERED','FAILED'].includes(row.status)||!integer(row.attempts))fail('GOVERNANCE_INTEGRITY');
        if(!q.after||row._id>q.after)items.push({id:row._id,version:row._version,status:row.status,attempts:row.attempts,errorCode:code(row.errorCode),audit:audit(envelope.audit,s)});
      }
      items.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);result={schema:'plus-governance-object-v1',root:root.reference,...page(items,q.limit),scope:'NATIVE_COMMITTED_OUTBOX_NOT_ALL_ATTEMPTS',...common()};
    }
    await fence(s);return result;
  }};
}
