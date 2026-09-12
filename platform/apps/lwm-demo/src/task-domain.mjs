import { randomUUID } from 'node:crypto';
import { createPlusActionExecutor } from '../../../packages/plus-runtime/dist/index.js';
import { digest } from '../../../packages/plus-contracts/dist/index.js';
import { parseActionManifest,assertNativeActionParameters } from '../../../packages/actions/dist/index.js';
import { taskVerificationManifests } from '../../../domain-packs/lwm-plus/mechanisms/task-verification.mjs';
import { taskPriorityRegistrationManifest } from '../../../domain-packs/lwm-plus/mechanisms/task-priority.mjs';

const fail=(code,status=409,cause)=>{throw Object.assign(new Error(code,cause?{cause}:undefined),{code,status});};
const text=(v,max=2000)=>{if(typeof v!=='string'||!v.trim()||v.length>max)fail('TASK_INVALID_INPUT',400);return v;};
const version=v=>{if(!Number.isSafeInteger(v)||v<1)fail('TASK_INVALID_VERSION',400);return v;};
const time=v=>{text(v,64);if(!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(v)||!Number.isFinite(Date.parse(v))||Date.parse(v)>Date.now())fail('TASK_INVALID_EVENT_TIME',400);return new Date(v).toISOString();};
const ref=(o,schemaRevision)=>({tenantId:o._tenantId,type:o._type,id:o._id,version:o._version,schemaRevision});
const actions={
  NativeRegisterInvestigationTask:{role:'investigator',fields:['matter','expectedVersion','taskNumber','title','priority','assignee','instructions','dueAt']},
  NativeRecordTaskObservation:{role:'investigator',fields:['task','expectedVersion','title','summary','reportedCompletion','eventTime','channelKey','sourceSystem','sourceRecordId','sourceRevision']},
  NativeVerifyTaskObservation:{role:'data_reviewer',fields:['task','observation','expectedVersion','expectedObservationVersion','result','targetTime','methodKey','evidence']},
};
const classifications=['SYNTHETIC','AUTHORIZED_REAL','IMPORTED_UNVERIFIED'];

/** Domain adapter only. All facts are native objects; business effects use reviewed native manifests.
 * authorize must enforce CURRENT object/field scope, not merely a role boolean.
 * classification/source/method policies are trusted server callbacks, never request fields.
 */
export function createTaskDomain({storage,catalog,cel,tenantId,authorize,taskClassificationFor,sourcePolicyFor,verificationPolicyFor}){
  const ctx=p=>{if(!p?.id||p.tenantId!==tenantId||!Array.isArray(p.roles))fail('TASK_FORBIDDEN',403);return {tenantId,actorId:p.id,traceId:randomUUID()};};
  const guard=async()=>{if(!storage.getReadRevision)fail('TASK_READ_GUARD_REQUIRED',503);return storage.getReadRevision({tenantId});};
  const query=async(context,type,field,value)=>{const rows=await storage.queryObjects(context,type,{field,operator:'eq',value},{limit:2});if(rows.totalCount>1)fail('TASK_UNIQUENESS_CONFLICT');return rows.items[0];};
  const object=async(context,type,id)=>{const o=await storage.getObject(context,type,text(id));if(!o||o._tenantId!==tenantId||o._deletedAt)fail('TASK_OBJECT_NOT_FOUND',404);return o;};
  function resources(action,input){
    if(action==='NativeRegisterInvestigationTask')return [{type:'Matter',id:input.matter,readFields:['workspaceKey'],writeFields:[]},{type:'InvestigationTask',operation:'create',readFields:[],writeFields:['workspaceKey','taskNumber','title','status','priority','assignee','instructions','dueAt','createdAt','receivedAt','registeredBy','actualCompletion','dataClassification']}];
    return [{type:'InvestigationTask',id:input.task,readFields:['workspaceKey','dataClassification','actualCompletion','actualCompletionAt','actualCompletionRecordedAt'],writeFields:action==='NativeVerifyTaskObservation'?['actualCompletion','actualCompletionAt','actualCompletionRecordedAt']:[]},
      ...(action==='NativeRecordTaskObservation'?[{type:'Observation',operation:'create',readFields:[],writeFields:['workspaceKey','observationNumber','title','kind','source','summary','confidence','verified','recordedBy','observedAt','receivedAt','reportedCompletion','channelKey','sourceSystem','sourceRecordId','sourceRevision','sourceEventKey','sourceContentHash','dataClassification']}]:
        [{type:'Observation',id:input.observation,readFields:['workspaceKey','recordedBy','observedAt','dataClassification','reportedCompletion'],writeFields:[]},{type:'TaskCompletionVerification',operation:'create',readFields:[],writeFields:['verificationKey','taskVersion','observationVersion','result','targetTime','recordedAt','recordedBy','methodKey','mode','evidence','classification']}])];
  }
  async function operate(action,raw,principal,key,prepareOnly=false,requestId){
    const p=structuredClone(principal),context=ctx(p),spec=Object.hasOwn(actions,action)?actions[action]:undefined;if(!spec)fail('TASK_ACTION_NOT_ENABLED',404);
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!spec.fields.includes(k))||spec.fields.some(k=>!Object.hasOwn(raw,k)))fail('TASK_INVALID_INPUT',400);
    const input=structuredClone(raw);version(input.expectedVersion);
    for(const [name,value]of Object.entries(input))if(!['expectedVersion','expectedObservationVersion','reportedCompletion'].includes(name))text(value,name==='summary'||name==='instructions'||name==='evidence'?20000:2000);
    if(action==='NativeVerifyTaskObservation')version(input.expectedObservationVersion);
    if(typeof key!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(key))fail('TASK_IDEMPOTENCY_REQUIRED',400);
    const requestResources=resources(action,input);
    const allowed=async()=>p.roles.includes(spec.role)&&await authorize(p,{action,resources:structuredClone(requestResources)});
    if(!await allowed())fail('TASK_FORBIDDEN',403);
    const epoch=await guard(),current=await catalog.read(p);
    const manifest=current.bundle.manifests[action];if(!manifest)fail('TASK_ACTION_NOT_PUBLISHED',503);
    const timedRegistration=action==='NativeRegisterInvestigationTask'&&manifest.version===2;
    const expected=parseActionManifest(JSON.stringify(timedRegistration?taskPriorityRegistrationManifest():taskVerificationManifests()[action]));
    if(!expected.valid||digest(manifest)!==digest(expected.manifest))fail('TASK_ACTION_CONTRACT_STALE',503);
    if(timedRegistration){
      requestResources.find(r=>r.type==='InvestigationTask').writeFields.push('priorityEffectiveAt','priorityRecordedAt');
      if(!await allowed())fail('TASK_FORBIDDEN',403);
    }
    let governedRequest;
    if(requestId!==undefined){
      if(!prepareOnly)fail('TASK_GOVERNED_PREPARATION_REQUIRED');governedRequest=await object(context,'PlusActionRequest',requestId);
      if(governedRequest.status!=='APPROVED'||governedRequest._version!==2||governedRequest.actionName!==action||digest(governedRequest.typedParams)!==digest(input))fail('TASK_GOVERNED_REQUEST_STALE');
    }
    const commandKey=governedRequest?digest([tenantId,'PlusActionRequest',governedRequest._id]):digest([tenantId,p.id,key]),commandHash=digest([action,input]);
    const prior=await query(context,'NativeCommandReceipt','commandKey',commandKey);
    const replay=async receipt=>{
      if(receipt.commandHash!==commandHash||receipt.actionName!==action||receipt.actorId!==p.id)fail('TASK_IDEMPOTENCY_CONFLICT');
      if(!await allowed())fail('TASK_FORBIDDEN',403);
      return {success:true,replayed:true,receipt};
    };
    if(prior){const result=await replay(prior);if(prepareOnly)fail('TASK_ALREADY_EXECUTED');return result;}
    let task,observation,method,matter,sourcePolicy;const params={...input,commandKey,commandHash,traceId:context.traceId};
    if(action==='NativeRegisterInvestigationTask'){
      matter=await object(context,'Matter',input.matter);if(matter._version!==input.expectedVersion)fail('TASK_VERSION_CONFLICT');
      params.classification=await taskClassificationFor(p,matter);
    }else{
      task=await object(context,'InvestigationTask',input.task);if(task._version!==input.expectedVersion)fail('TASK_VERSION_CONFLICT');
      if(action==='NativeRecordTaskObservation'){
        if(!['DONE','NOT_DONE','UNKNOWN',null].includes(input.reportedCompletion))fail('TASK_INVALID_REPORT',400);
        params.eventTime=time(input.eventTime);
        const source=await sourcePolicyFor(p,input.sourceSystem);
        if(!source||!source.channelKeys?.includes(input.channelKey)||!source.allowedRoles?.some(r=>p.roles.includes(r)))fail('TASK_SOURCE_FORBIDDEN',403);
        params.classification=source.classification;
        sourcePolicy=structuredClone(source);
        params.sourceEventKey=digest([tenantId,input.sourceSystem,input.sourceRecordId,input.sourceRevision]);
        params.sourceContentHash=digest({taskId:task._id,...Object.fromEntries(Object.entries(input).filter(([k])=>k!=='expectedVersion')),eventTime:params.eventTime});
        const previous=await query(context,'Observation','sourceEventKey',params.sourceEventKey);
        if(previous){
          if(previous.sourceContentHash!==params.sourceContentHash)fail('TASK_SOURCE_CONFLICT');
          if(!await allowed()||await guard()!==epoch)fail('TASK_SOURCE_REPLAY_CONFLICT');
          if(prepareOnly)fail('TASK_ALREADY_EXECUTED');
          return {success:true,replayed:true,sourceReplay:true,result:{type:'Observation',id:previous._id,version:previous._version}};
        }
      }else{
        observation=await object(context,'Observation',input.observation);if(observation._version!==input.expectedObservationVersion)fail('TASK_OBSERVATION_VERSION_CONFLICT');
        const links=await storage.getLinks(context,observation._id,'TaskObservation','inbound',{limit:2});
        if(links.totalCount!==1||links.items[0]?._fromId!==task._id)fail('TASK_OBSERVATION_SCOPE_CONFLICT');
        if(observation.recordedBy===p.id)fail('TASK_INDEPENDENT_VERIFICATION_REQUIRED',403);
        params.targetTime=time(input.targetTime);if(params.targetTime!==observation.observedAt)fail('TASK_VERIFICATION_TIME_CONFLICT');
        if(!['DONE','NOT_DONE'].includes(input.result))fail('TASK_INVALID_VERIFICATION',400);
        method=await verificationPolicyFor(p,input.methodKey);
        if(!method||!['GOLD','NOISY'].includes(method.mode)||!method.allowedRoles?.some(r=>p.roles.includes(r))||!method.classifications?.includes(observation.dataClassification))fail('TASK_VERIFICATION_POLICY_FORBIDDEN',403);
        params.mode=method.mode;params.classification=observation.dataClassification;
        text(method.policyRef,128);method=structuredClone(method);
        if(method.mode==='GOLD'&&task.actualCompletionAt===params.targetTime&&['DONE','NOT_DONE'].includes(task.actualCompletion)&&task.actualCompletion!==input.result)fail('TASK_CONFLICTING_GOLD_REQUIRES_CORRECTION');
      }
      if(params.classification!==task.dataClassification)fail('TASK_CLASSIFICATION_CONFLICT');
    }
    if(!classifications.includes(params.classification))fail('TASK_CLASSIFICATION_NOT_APPROVED',403);
    let event,stagedReceipt;
    const currentPermission=async()=>{
      if(!await allowed())return false;
      if(matter)return await taskClassificationFor(p,matter)===params.classification;
      if(sourcePolicy)return digest(await sourcePolicyFor(p,input.sourceSystem)??null)===digest(sourcePolicy);
      return digest(await verificationPolicyFor(p,input.methodKey)??null)===digest(method);
    };
    const executor=createPlusActionExecutor({storage,cel,security:{checkPermission:async()=>({allowed:await currentPermission()})},
      stageSourceEvents:async(tx,envelope)=>{
        stagedReceipt=Object.values(envelope.audit.detail.after??{}).find(o=>o._type==='NativeCommandReceipt');
        if(!stagedReceipt||stagedReceipt.commandKey!==commandKey||stagedReceipt.commandHash!==commandHash||stagedReceipt.actorId!==p.id)fail('TASK_COMMAND_RECEIPT_INVALID');
        if(action==='NativeRegisterInvestigationTask')return;
        const sourceType=action==='NativeRecordTaskObservation'?'Observation':'TaskCompletionVerification';
        const source=Object.values(envelope.audit.detail.after??{}).find(o=>o._type===sourceType);if(!source)fail('TASK_EVENT_SOURCE_MISSING');
        const typedValue=sourceType==='Observation'?(source.reportedCompletion===null?{kind:'MISSING'}:source.reportedCompletion==='UNKNOWN'?{kind:'UNKNOWN',marker:'UNKNOWN'}:{kind:'VALUE',value:source.reportedCompletion}):{kind:'VALUE',value:source.result};
        const properties={sourceKey:sourceType==='Observation'?source.sourceEventKey:digest([tenantId,'native.task-verification',source._id,String(source._version)]),eventKind:sourceType==='Observation'?'OBSERVATION':'VERIFICATION',classification:params.classification,
          sourceSystem:sourceType==='Observation'?source.sourceSystem:'native.task-verification',sourceRecordId:sourceType==='Observation'?source.sourceRecordId:source._id,sourceRevision:sourceType==='Observation'?source.sourceRevision:String(source._version),
          sourceReference:ref(source,current.bundle.contentHash),eventTime:sourceType==='Observation'?source.observedAt:source.targetTime,ingestedAt:sourceType==='Observation'?source.receivedAt:source.recordedAt,
          variableKey:sourceType==='Observation'?'reportedCompletion':'actualCompletion',typedValue,
          ...(method?{verification:{mode:method.mode,policyRef:method.policyRef,policyHash:digest(method),observation:ref(observation,current.bundle.contentHash),verifiedBy:p.id,targetTime:params.targetTime}}:{}),revoked:false};
        const {revoked,...immutableProperties}=properties;
        properties.contentHash=digest(immutableProperties);event=await tx.createObject('PlusEvent',properties);
        const rootLink=await tx.createLink('TaskPlusEvent',task._id,event._id),sourceLink=await tx.createLink(sourceType==='Observation'?'EventSourceObservation':'EventSourceTaskVerification',event._id,source._id);
        for(const o of [event,rootLink,sourceLink]){envelope.affectedObjects.push({type:o._type,id:o._id,changeType:'created'});envelope.audit.detail.after[o._type+':'+o._id]=o;}
      }});
    if(prepareOnly){
      // Read-only preparation. This is a trusted server composition capability,
      // never an HTTP response or an alternate public action authorization path.
      const definition=current.bundle.parsed.actionTypes.find(t=>t.name===action);if(!definition)fail('TASK_ACTION_NOT_PUBLISHED',503);
      try{assertNativeActionParameters(definition,params,current.bundle.parsed);}catch(cause){fail('TASK_INVALID_INPUT',400,cause);}
      const readSet={schema:'plus-native-task-action-plan-v1',action,input,ontologyHash:current.bundle.contentHash,manifestHash:digest(manifest),
        references:[matter,task,observation].filter(Boolean).map(o=>ref(o,current.bundle.contentHash)),
        classification:params.classification,sourcePolicyHash:sourcePolicy?digest(sourcePolicy):null,verificationPolicyHash:method?digest(method):null,
        ...(governedRequest?{governedRequest:{id:governedRequest._id,version:governedRequest._version,hash:governedRequest.requestHash}}:{})};
      const assertCurrent=async()=>{if(!await currentPermission())fail('TASK_FORBIDDEN',403);if(await guard()!==epoch)fail('TASK_READ_SET_CONFLICT');};
      await assertCurrent();let consumed=false;
      return {readRevision:epoch,fingerprint:digest(readSet),readSet:structuredClone(readSet),commandKey,commandHash,
        assertCurrent,
        async stage(tx,outerContext){
          try{
            if(consumed)fail('TASK_PREPARATION_CONSUMED');consumed=true;
            const stagedContext=structuredClone(outerContext);
            if(!stagedContext||stagedContext.tenantId!==tenantId||stagedContext.actorId!==p.id||typeof stagedContext.traceId!=='string'||!stagedContext.traceId.trim())fail('TASK_TRANSACTION_CONTEXT_INVALID');
            if(!tx?.assertContext||!tx.assertReadRevision)fail('TASK_READ_GUARD_REQUIRED',503);
            await tx.assertContext(stagedContext);await tx.assertReadRevision(epoch);await assertCurrent();
            const result=await executor.stage(manifest,{...params,traceId:stagedContext.traceId},{id:p.id,type:'user',roles:[...p.roles]},
              {requestContext:stagedContext,expectedReadRevision:epoch},current.bundle.parsed,tx);
            if(!result.success)fail(result.errors.some(e=>e.code==='READ_SET_CONFLICT')?'TASK_READ_SET_CONFLICT':'TASK_NATIVE_EXECUTION_FAILED',409,{actionId:result.actionId,errors:result.errors});
            await assertCurrent();
            // The caller still owns the transaction. It must requalify its own
            // approval/authority and stage its receipt before committing once.
            return {staged:true,committed:false,actionId:result.actionId,receipt:structuredClone(stagedReceipt),affectedObjects:structuredClone(result.affectedObjects),
              ...(event?{event:{id:event._id,version:event._version}}:{})};
          }catch(error){await tx?.rollback();throw error;}
        }};
    }
    const result=await executor.execute(manifest,params,{id:p.id,type:'user',roles:[...p.roles]},{requestContext:context,expectedReadRevision:epoch},current.bundle.parsed);
    if(!result.success){const raced=await query(context,'NativeCommandReceipt','commandKey',commandKey);if(raced)return replay(raced);fail(result.errors.some(e=>e.code==='READ_SET_CONFLICT')?'TASK_READ_SET_CONFLICT':'TASK_NATIVE_EXECUTION_FAILED',409,{actionId:result.actionId,errors:result.errors});}
    return {success:true,replayed:false,receipt:await query(context,'NativeCommandReceipt','commandKey',commandKey),...(event?{event:{id:event._id,version:event._version}}:{})};
  }
  return {execute:(action,input,p,key)=>operate(action,input,p,key),prepare:(action,input,p,key)=>operate(action,input,p,key,true),
    // Trusted outer governance runtime only. No HTTP route accepts this namespace.
    prepareForRequest:(action,input,p,requestId)=>operate(action,input,p,'governed-request',true,requestId)};
}
