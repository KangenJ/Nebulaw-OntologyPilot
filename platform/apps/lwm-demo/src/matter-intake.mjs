import {randomUUID} from 'node:crypto';
import {digest} from '../../../packages/plus-contracts/dist/index.js';
import {parseActionManifest} from '../../../packages/actions/dist/index.js';
import {createPlusActionExecutor} from '../../../packages/plus-runtime/dist/index.js';
import {matterIntakeAction as action,matterIntakeFields,matterIntakeWrites,matterIntakeManifest} from '../../../domain-packs/lwm-plus/mechanisms/matter-intake.mjs';
const fail=(code,status=409)=>{throw Object.assign(Error(code),{code,status});};
const text=v=>typeof v==='string'&&v.length>0&&v.length<=2000&&v.trim()===v&&!/[\x00-\x1f\x7f]/.test(v);

// Narrow production adapter. Creates one source-attributed native root, never an
// observation, verification, prediction, training record or arbitrary effect.
export function createMatterIntakeDomain({storage,catalog,cel,tenantId,authorize,matterImportPolicyFor,taskClassificationFor}){
  return {async execute(raw,principal,key){
    const p=structuredClone(principal);
    if(!p?.id||p.tenantId!==tenantId||!p.roles?.includes('investigator'))fail('MATTER_IMPORT_FORBIDDEN',403);
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).sort().join(',')!==[...matterIntakeFields].sort().join(',')||Object.values(raw).some(v=>!text(v)))fail('MATTER_IMPORT_INVALID_INPUT',400);
    if(typeof key!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(key))fail('MATTER_IMPORT_IDEMPOTENCY_REQUIRED',400);
    const input=structuredClone(raw),ms=Date.parse(input.openedAt);
    if(!Number.isFinite(ms)||new Date(ms).toISOString()!==input.openedAt||ms>Date.now())fail('MATTER_IMPORT_INVALID_TIME',400);
    const policy=structuredClone(await matterImportPolicyFor(p,input.sourceSystem)??null);
    if(!policy||Object.keys(policy).sort().join(',')!=='allowedRoles,classification,workspaceKey'||!text(policy.workspaceKey)
      ||!['SYNTHETIC','AUTHORIZED_REAL','IMPORTED_UNVERIFIED'].includes(policy.classification)||!Array.isArray(policy.allowedRoles)||!policy.allowedRoles.some(r=>p.roles.includes(r)))fail('MATTER_IMPORT_FORBIDDEN',403);
    const resources=[{type:'Matter',operation:'create',workspaceKey:policy.workspaceKey,readFields:[],writeFields:[...matterIntakeWrites]}];
    const allowed=async id=>digest(await matterImportPolicyFor(p,input.sourceSystem)??null)===digest(policy)&&await taskClassificationFor(p,{workspaceKey:policy.workspaceKey})===policy.classification&&await authorize(p,{action,resources:resources.map(r=>({...r,...(id?{id}:{})}))});
    if(!await allowed())fail('MATTER_IMPORT_FORBIDDEN',403);
    const ctx={tenantId,actorId:p.id,traceId:randomUUID()};if(!storage.getReadRevision)fail('MATTER_IMPORT_READ_GUARD_REQUIRED',503);
    const epoch=await storage.getReadRevision(ctx),current=await catalog.read(p),manifest=current.bundle.manifests[action],expected=parseActionManifest(JSON.stringify(matterIntakeManifest()));
    if(!manifest||current.bundle.disabledActions.includes(action))fail('MATTER_IMPORT_ACTION_NOT_PUBLISHED',503);
    if(!expected.valid||digest(manifest)!==digest(expected.manifest))fail('MATTER_IMPORT_CONTRACT_STALE',503);
    const risk=current.bundle.parsed.enums.find(e=>e.name==='RiskBand');if(!risk?.values.some(v=>v.name===input.riskBand))fail('MATTER_IMPORT_INVALID_INPUT',400);
    const commandKey=digest([tenantId,p.id,key]),commandHash=digest([action,input]),sourceKey=digest([tenantId,input.sourceSystem,input.sourceRecordId,input.sourceRevision]),contentHash=digest({input,workspaceKey:policy.workspaceKey,classification:policy.classification});
    const one=async(type,field,value)=>{const page=await storage.queryObjects(ctx,type,{field,operator:'eq',value},{limit:2});if(page.hasNextPage||page.totalCount>1)fail('MATTER_IMPORT_UNIQUENESS_CONFLICT');return page.items[0];};
    const receipt=()=>one('NativeCommandReceipt','commandKey',commandKey);
    const replay=async row=>{
      if(row.actorId!==p.id||row.actionName!==action||row.commandHash!==commandHash||row.resultType!=='Matter')fail('MATTER_IMPORT_IDEMPOTENCY_CONFLICT');
      if(!await allowed(row.resultId))fail('MATTER_IMPORT_FORBIDDEN',403);return {success:true,replayed:true,receipt:row};
    };
    const sourceReplay=async row=>{
      if(!await allowed(row._id))fail('MATTER_IMPORT_FORBIDDEN',403);
      if(row.importContentHash!==contentHash||row._deletedAt)fail('MATTER_IMPORT_SOURCE_CONFLICT');
      return {success:true,replayed:true,sourceReplay:true,result:{type:'Matter',id:row._id,version:row._version}};
    };
    const prior=await receipt();if(prior)return replay(prior);
    const duplicate=await one('Matter','importSourceKey',sourceKey);if(duplicate)return sourceReplay(duplicate);
    if(await one('Matter','matterNumber',input.matterNumber))fail('MATTER_IMPORT_SOURCE_CONFLICT');
    let stagedReceipt;
    const executor=createPlusActionExecutor({storage,cel,security:{checkPermission:async()=>({allowed:await allowed()})},stageSourceEvents:async(_tx,envelope)=>{
      const after=Object.values(envelope.audit.detail.after??{}),matter=after.find(o=>o._type==='Matter');stagedReceipt=after.find(o=>o._type==='NativeCommandReceipt');
      if(!matter||matter.importSourceKey!==sourceKey||matter.importContentHash!==contentHash||!stagedReceipt||stagedReceipt.commandKey!==commandKey||stagedReceipt.resultId!==matter._id)fail('MATTER_IMPORT_RECEIPT_INVALID');
      // No PlusEvent: a grouping/source root is not a completion observation.
      if(!await allowed())fail('MATTER_IMPORT_FORBIDDEN',403);
    }});
    const result=await executor.execute(manifest,{...input,workspaceKey:policy.workspaceKey,classification:policy.classification,sourceKey,contentHash,commandKey,commandHash,traceId:ctx.traceId},
      {id:p.id,type:'user',roles:[...p.roles]},{requestContext:ctx,expectedReadRevision:epoch},current.bundle.parsed);
    if(!result.success){const raced=await receipt();if(raced)return replay(raced);const source=await one('Matter','importSourceKey',sourceKey);if(source)return sourceReplay(source);fail(result.errors.some(e=>e.code==='READ_SET_CONFLICT')?'MATTER_IMPORT_READ_SET_CONFLICT':'MATTER_IMPORT_NATIVE_EXECUTION_FAILED');}
    if(!await allowed(stagedReceipt.resultId))fail('MATTER_IMPORT_FORBIDDEN',403);
    return {success:true,replayed:false,receipt:await receipt()};
  }};
}
