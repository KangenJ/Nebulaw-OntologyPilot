import { randomUUID } from 'node:crypto';
import { digest } from '../../../packages/plus-contracts/dist/index.js';
import { createPlusActionExecutor } from '../../../packages/plus-runtime/dist/index.js';
import { parseActionManifest } from '../../../packages/actions/dist/index.js';
import { taskPriorityManifest } from '../../../domain-packs/lwm-plus/mechanisms/task-priority.mjs';
const action='NativeSetTaskPriority',bands=['LOW','MEDIUM','HIGH','CRITICAL'];
const fail=(code,status=409,cause)=>{throw Object.assign(new Error(code,cause?{cause}:undefined),{code,status});};
const instant=v=>{if(typeof v!=='string'||!Number.isFinite(Date.parse(v))||new Date(v).toISOString()!==v)fail('TASK_INVALID_EVENT_TIME',400);return v;};
/** A narrow native context action, never a free-form field/status/fact setter. */
export function createTaskPriorityDomain({storage,catalog,cel,tenantId,authorize,taskClassificationFor}){
  return {async execute(raw,p,key){
    if(!p?.id||p.tenantId!==tenantId||!Array.isArray(p.roles)||!p.roles.includes('investigator'))fail('TASK_FORBIDDEN',403);
    if(!raw||Array.isArray(raw)||Object.keys(raw).sort().join(',')!=='effectiveAt,expectedVersion,priority,reason,task'
      ||typeof raw.task!=='string'||!raw.task||raw.task.length>128||!Number.isSafeInteger(raw.expectedVersion)||raw.expectedVersion<1
      ||!bands.includes(raw.priority)||typeof raw.reason!=='string'||!raw.reason.trim()||raw.reason.length>2000)fail('TASK_INVALID_INPUT',400);
    if(typeof key!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(key))fail('TASK_IDEMPOTENCY_REQUIRED',400);
    const input=structuredClone(raw);instant(input.effectiveAt);
    const ctx={tenantId,actorId:p.id,traceId:randomUUID()},resources=[
      {type:'InvestigationTask',id:input.task,readFields:['workspaceKey','dataClassification','status','priority','createdAt','receivedAt','priorityEffectiveAt','priorityRecordedAt'],writeFields:['priority','priorityEffectiveAt','priorityRecordedAt']},
      {type:'TaskPriorityChange',operation:'create',readFields:[],writeFields:['changeKey','taskVersion','previousPriority','priority','previousEffectiveAt','previousRecordedAt','effectiveAt','recordedAt','recordedBy','reason','workspaceKey','classification']},
    ];
    const allowed=()=>authorize(p,{action,resources:structuredClone(resources)});if(!await allowed())fail('TASK_FORBIDDEN',403);
    if(!storage.getReadRevision)fail('TASK_READ_GUARD_REQUIRED',503);const epoch=await storage.getReadRevision(ctx),current=await catalog.read(p);
    const expected=parseActionManifest(JSON.stringify(taskPriorityManifest())),manifest=current.bundle.manifests[action];
    if(!manifest)fail('TASK_ACTION_NOT_PUBLISHED',503);if(!expected.valid||digest(manifest)!==digest(expected.manifest))fail('TASK_ACTION_CONTRACT_STALE',503);
    const commandKey=digest([tenantId,p.id,key]),commandHash=digest([action,input]);
    const receipt=async()=>{const page=await storage.queryObjects(ctx,'NativeCommandReceipt',{field:'commandKey',operator:'eq',value:commandKey},{limit:2});if(page.hasNextPage||page.totalCount>1)fail('TASK_UNIQUENESS_CONFLICT');return page.items[0];};
    const replay=async row=>{if(row.actorId!==p.id||row.commandHash!==commandHash||row.actionName!==action)fail('TASK_IDEMPOTENCY_CONFLICT');if(!await allowed())fail('TASK_FORBIDDEN',403);return {success:true,replayed:true,receipt:row};};
    const prior=await receipt();if(prior)return replay(prior);
    const task=await storage.getObject(ctx,'InvestigationTask',input.task);if(!task||task._tenantId!==tenantId||task._deletedAt)fail('TASK_OBJECT_NOT_FOUND',404);
    if(task._version!==input.expectedVersion)fail('TASK_VERSION_CONFLICT');if(!['OPEN','IN_PROGRESS'].includes(task.status))fail('TASK_CONTEXT_STATUS_CONFLICT');
    if(!bands.includes(task.priority)||task.priority===input.priority)fail('TASK_CONTEXT_NO_CHANGE',400);
    const timed=task.priorityEffectiveAt!=null,recorded=task.priorityRecordedAt!=null;if(timed!==recorded)fail('TASK_CONTEXT_TIME_INCOMPLETE');
    // Existing initial values have explicit native creation/receipt times. This
    // records their predecessor, not a silent historical-model binding fallback.
    const previousEffectiveAt=instant(timed?task.priorityEffectiveAt:task.createdAt),previousRecordedAt=instant(recorded?task.priorityRecordedAt:task.receivedAt);
    if(input.effectiveAt<previousEffectiveAt||Date.parse(input.effectiveAt)>Date.now()||Date.parse(previousRecordedAt)>=Date.now())fail('TASK_CONTEXT_TIME_CONFLICT');
    const classification=await taskClassificationFor(p,task);if(classification!==task.dataClassification||!['SYNTHETIC','AUTHORIZED_REAL','IMPORTED_UNVERIFIED'].includes(classification))fail('TASK_CLASSIFICATION_CONFLICT');
    const executor=createPlusActionExecutor({storage,cel,security:{checkPermission:async()=>({allowed:await allowed()&&await taskClassificationFor(p,task)===classification})}});
    const result=await executor.execute(manifest,{...input,previousPriority:task.priority,previousEffectiveAt,previousRecordedAt,classification,commandKey,commandHash,traceId:ctx.traceId},
      {id:p.id,type:'user',roles:[...p.roles]},{requestContext:ctx,expectedReadRevision:epoch},current.bundle.parsed);
    if(!result.success){const raced=await receipt();if(raced)return replay(raced);fail(result.errors.some(e=>e.code==='READ_SET_CONFLICT')?'TASK_READ_SET_CONFLICT':'TASK_NATIVE_EXECUTION_FAILED',409,{actionId:result.actionId,errors:result.errors});}
    return {success:true,replayed:false,receipt:await receipt()};
  }};
}
