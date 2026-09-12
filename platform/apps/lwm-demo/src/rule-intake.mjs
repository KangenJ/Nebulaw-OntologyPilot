import {randomUUID} from 'node:crypto';
import {digest} from '../../../packages/plus-contracts/dist/index.js';
import {parseActionManifest} from '../../../packages/actions/dist/index.js';
import {createPlusActionExecutor} from '../../../packages/plus-runtime/dist/index.js';
import {ruleIntakeAction as action,ruleIntakeFields,ruleIntakeWrites,ruleIntakeManifest} from '../../../domain-packs/lwm-plus/mechanisms/rule-intake.mjs';
const fail=(code,status=409)=>{throw Object.assign(Error(code),{code,status});};
const text=v=>typeof v==='string'&&v.length>0&&v.length<=2000&&v.trim()===v&&!/[\x00-\x1f\x7f]/.test(v);

// A scoped source registration, not a rule-expression registry or approval.
// ACTIVE describes the declared source lifecycle; NativeRuleRegistry must still
// independently qualify and review an exact source revision before model use.
export function createRuleIntakeDomain({storage,catalog,cel,tenantId,authorize,ruleImportPolicyFor,taskClassificationFor}){
  return {async execute(raw,principal,key){
    const p=structuredClone(principal);
    if(!p?.id||p.tenantId!==tenantId||!p.roles?.includes('data_reviewer'))fail('RULE_IMPORT_FORBIDDEN',403);
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).sort().join(',')!==[...ruleIntakeFields].sort().join(',')||Object.values(raw).some(v=>!text(v)))fail('RULE_IMPORT_INVALID_INPUT',400);
    if(typeof key!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(key))fail('RULE_IMPORT_IDEMPOTENCY_REQUIRED',400);
    const input=structuredClone(raw),ms=Date.parse(input.effectiveFrom);
    if(!Number.isFinite(ms)||new Date(ms).toISOString()!==input.effectiveFrom||ms>Date.now())fail('RULE_IMPORT_INVALID_TIME',400);
    const policy=structuredClone(await ruleImportPolicyFor(p,input.sourceSystem)??null);
    if(!policy||Object.keys(policy).sort().join(',')!=='allowedRoles,classification,deterministic,workspaceKey'||policy.deterministic!==true||!text(policy.workspaceKey)
      ||!['SYNTHETIC','AUTHORIZED_REAL','IMPORTED_UNVERIFIED'].includes(policy.classification)||!Array.isArray(policy.allowedRoles)||!policy.allowedRoles.some(r=>p.roles.includes(r)))fail('RULE_IMPORT_FORBIDDEN',403);
    const resources=[{type:'RuleVersion',operation:'create',workspaceKey:policy.workspaceKey,readFields:[],writeFields:[...ruleIntakeWrites]}];
    const allowed=async id=>digest(await ruleImportPolicyFor(p,input.sourceSystem)??null)===digest(policy)&&await taskClassificationFor(p,{workspaceKey:policy.workspaceKey})===policy.classification&&await authorize(p,{action,resources:resources.map(r=>({...r,...(id?{id}:{})}))});
    if(!await allowed())fail('RULE_IMPORT_FORBIDDEN',403);
    const ctx={tenantId,actorId:p.id,traceId:randomUUID()};if(!storage.getReadRevision)fail('RULE_IMPORT_READ_GUARD_REQUIRED',503);
    const epoch=await storage.getReadRevision(ctx),current=await catalog.read(p),manifest=current.bundle.manifests[action],expected=parseActionManifest(JSON.stringify(ruleIntakeManifest()));
    if(!manifest||current.bundle.disabledActions.includes(action))fail('RULE_IMPORT_ACTION_NOT_PUBLISHED',503);
    if(!expected.valid||digest(manifest)!==digest(expected.manifest))fail('RULE_IMPORT_CONTRACT_STALE',503);
    const commandKey=digest([tenantId,p.id,key]),commandHash=digest([action,input]),sourceKey=digest([tenantId,input.sourceSystem,input.sourceRecordId,input.sourceRevision]);
    const contentHash=digest({input,workspaceKey:policy.workspaceKey,classification:policy.classification,deterministic:true,lifecycle:'ACTIVE'});
    const one=async(type,field,value)=>{const page=await storage.queryObjects(ctx,type,{field,operator:'eq',value},{limit:2});if(page.hasNextPage||page.totalCount>1)fail('RULE_IMPORT_UNIQUENESS_CONFLICT');return page.items[0];};
    const receipt=()=>one('NativeCommandReceipt','commandKey',commandKey);
    const replay=async row=>{
      if(row.actorId!==p.id||row.actionName!==action||row.commandHash!==commandHash||row.resultType!=='RuleVersion')fail('RULE_IMPORT_IDEMPOTENCY_CONFLICT');
      if(!await allowed(row.resultId))fail('RULE_IMPORT_FORBIDDEN',403);return {success:true,replayed:true,receipt:row};
    };
    const sourceReplay=async row=>{
      if(!await allowed(row._id))fail('RULE_IMPORT_FORBIDDEN',403);
      if(row.importContentHash!==contentHash||row._deletedAt)fail('RULE_IMPORT_SOURCE_CONFLICT');
      return {success:true,replayed:true,sourceReplay:true,result:{type:'RuleVersion',id:row._id,version:row._version}};
    };
    const prior=await receipt();if(prior)return replay(prior);
    const duplicate=await one('RuleVersion','importSourceKey',sourceKey);if(duplicate)return sourceReplay(duplicate);
    // Rule keys are natively unique. A new source revision is never an implicit
    // overwrite of a previously used rule or its reviewed model dependencies.
    if(await one('RuleVersion','ruleKey',input.ruleKey))fail('RULE_IMPORT_SOURCE_CONFLICT');
    let stagedReceipt;
    const executor=createPlusActionExecutor({storage,cel,security:{checkPermission:async()=>({allowed:await allowed()})},stageSourceEvents:async(_tx,envelope)=>{
      const after=Object.values(envelope.audit.detail.after??{}),rule=after.find(o=>o._type==='RuleVersion');stagedReceipt=after.find(o=>o._type==='NativeCommandReceipt');
      if(!rule||rule.importSourceKey!==sourceKey||rule.importContentHash!==contentHash||!stagedReceipt||stagedReceipt.commandKey!==commandKey||stagedReceipt.resultId!==rule._id)fail('RULE_IMPORT_RECEIPT_INVALID');
      // Source metadata is neither a completion observation nor a rule approval.
      if(!await allowed())fail('RULE_IMPORT_FORBIDDEN',403);
    }});
    const result=await executor.execute(manifest,{...input,workspaceKey:policy.workspaceKey,classification:policy.classification,sourceKey,contentHash,commandKey,commandHash,traceId:ctx.traceId},
      {id:p.id,type:'user',roles:[...p.roles]},{requestContext:ctx,expectedReadRevision:epoch},current.bundle.parsed);
    if(!result.success){const raced=await receipt();if(raced)return replay(raced);const source=await one('RuleVersion','importSourceKey',sourceKey);if(source)return sourceReplay(source);fail(result.errors.some(e=>e.code==='READ_SET_CONFLICT')?'RULE_IMPORT_READ_SET_CONFLICT':'RULE_IMPORT_NATIVE_EXECUTION_FAILED');}
    if(!await allowed(stagedReceipt.resultId))fail('RULE_IMPORT_FORBIDDEN',403);
    return {success:true,replayed:false,receipt:await receipt()};
  }};
}
