// Bounded-label timings only; no arguments, native payloads, tokens or identities.
// Uses the SAME private service factory as the actual host, on an isolated copy.
import * as native from '../../platform/packages/plus-runtime/dist/index.js';
import { performance } from 'node:perf_hooks';
import { readFileSync,writeFileSync } from 'node:fs';
import { join,resolve,basename } from 'node:path';
import { createNativeStorage } from '../../platform/apps/lwm-demo/src/native-storage.mjs';
import { createPrivateIdentityProvider } from './private-identity.mjs';
import { createPrivateTaskServices } from './task-services.mjs';
import { createNativeBeliefEventSink } from './belief-event-sink.mjs';
import { CelClient } from '../../platform/packages/actions/dist/index.js';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
const root=resolve(process.argv[2]??''),operation=process.argv[3]??'authorization';
if(process.argv.length<3||process.argv.length>4||!/^profile-task-[A-Za-z0-9]+$/.test(basename(root))||!['authorization','position','event-delivery','action-execution'].includes(operation))throw new Error('EXPLICIT_SYNTHETIC_PROFILE_REQUIRED');
const loadPolicy=()=>JSON.parse(readFileSync(join(root,'policy.json'),'utf8')),policy=loadPolicy(),sub=policy.beliefRefresh?.subscriptions?.[0];
if(!sub||policy.beliefRefresh.subscriptions.length!==1||policy.modelGovernance.targets.some(t=>t.policy.classification!=='SYNTHETIC'))throw new Error('SYNTHETIC_SINGLE_SUBSCRIPTION_REQUIRED');
const accounts=JSON.parse(readFileSync(join(root,'auth.json'),'utf8')),tenantId=accounts.find(p=>p.id===sub.principalId)?.tenantId;
if(!tenantId)throw new Error('PROFILE_IDENTITY_REQUIRED');
const stats=new Map(),restore=[],started=performance.now();let last=started;
const snapshot=()=>[...stats].map(([method,row])=>({method,...row})).sort((a,b)=>b.inclusiveMs-a.inclusiveMs).slice(0,25);
for(const [name,value]of Object.entries(native))if(name.startsWith('Native')&&typeof value==='function'&&value.prototype){
  for(const method of Object.getOwnPropertyNames(value.prototype)){
    const descriptor=Object.getOwnPropertyDescriptor(value.prototype,method),original=descriptor?.value;
    if(typeof original!=='function'||original.constructor.name!=='AsyncFunction')continue;
    const label=name+'.'+method;stats.set(label,{calls:0,inclusiveMs:0,failures:0});
    value.prototype[method]=async function(...args){const at=performance.now(),row=stats.get(label);row.calls++;
      try{return await original.apply(this,args);}catch(e){row.failures++;throw e;}
      finally{row.inclusiveMs+=performance.now()-at;if(performance.now()-last>=10000){last=performance.now();console.log(JSON.stringify({schema:'plus-native-profile-progress-v1',elapsedMs:last-started,methods:snapshot()}));}}
    };restore.push(()=>{value.prototype[method]=original;});
  }
}
const storage=createNativeStorage(join(root,'platform.sqlite'));let before,result,errorCode,cel,celProcess,celSpawnError;
try{
  // The real service graph requires CEL when native action requests are enabled,
  // even if this particular diagnostic only traverses model/source authority.
  // Supply an actual isolated evaluator, never a permissive/dummy interface.
  if(policy.actionRequests?.enabled===true){
    if(!process.env.LWM_CEL_BINARY)throw Object.assign(new Error('PROFILE_CEL_BINARY_REQUIRED'),{code:'PROFILE_CEL_BINARY_REQUIRED'});
    const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
    celProcess=spawn(process.env.LWM_CEL_BINARY,[],{env:{...process.env,CEL_HOST:'127.0.0.1',CEL_PORT:String(port)},stdio:'ignore',windowsHide:true});
    celProcess.on('error',e=>{celSpawnError=e;});cel=new CelClient({address:`127.0.0.1:${port}`,maxRetries:0,timeoutMs:500,circuitBreakerResetMs:100});
    let ready=false;for(let i=0;i<60;i++){if(celSpawnError||celProcess.exitCode!==null)break;try{if((await cel.evaluate('true',{})).value===true){ready=true;break;}}catch{}await delay(100);}
    if(!ready)throw Object.assign(new Error('PROFILE_CEL_UNAVAILABLE'),{code:'PROFILE_CEL_UNAVAILABLE'});
  }
  const identities=createPrivateIdentityProvider({authPath:join(root,'auth.json'),tenantId}),principal=await identities.resolvePrincipal(sub.principalId);
  const services=createPrivateTaskServices({storage,tenantId,identities,loadPolicy,cel});services.assertConfigured();before=await storage.getReadRevision({tenantId});
  if(operation==='action-execution'){
    // Explicitly mutate this isolated SYNTHETIC copy only. No approval is
    // fabricated or imported from a different source; execute the native
    // approved request through the same actual private service factory.
    const pending=await storage.queryObjects({tenantId},'PlusActionRequest',{field:'status',operator:'eq',value:'APPROVED'},{limit:2});
    if(pending.hasNextPage||pending.totalCount!==1)throw new Error('PROFILE_SINGLE_APPROVED_ACTION_REQUIRED');
    const request=pending.items[0];
    if(request.actionName!=='NativeRegisterInvestigationTask'||request.typedParams?.taskNumber!=='HOST-FOLLOWUP')throw new Error('PROFILE_SYNTHETIC_ACTION_REQUIRED');
    const actor=await identities.resolvePrincipal(request.submittedBy);
    if(!actor.roles.includes('investigator'))throw new Error('PROFILE_ACTION_ACTOR_REQUIRED');
    result=await services.actionRequests.execute({requestId:request._id,expectedVersion:request._version},actor);
    if(result?.status!=='EXECUTED'||result.physicalOutcomeVerified!==false)throw new Error('PROFILE_ACTION_UNCONFIRMED');
  }else if(operation==='event-delivery'){
    // Explicit diagnostic mutation of this synthetic copy only. The source
    // action already ran in the acceptance fixture; never replay that action.
    const ctx={tenantId},events=await storage.queryObjects(ctx,'PlusEvent',{field:'sourceRecordId',operator:'eq',value:'canonical-host-report'},{limit:2});
    if(events.hasNextPage||events.totalCount!==1||events.items[0].classification!=='SYNTHETIC')throw new Error('SYNTHETIC_SOURCE_EVENT_REQUIRED');
    const event=events.items[0],page=await storage.queryObjects(ctx,'PlusOutbox',{and:[]},{limit:1000});
    if(page.hasNextPage)throw new Error('PROFILE_OUTBOX_BUDGET');
    const matching=page.items.filter(row=>native.readActionOutboxEnvelope(row,tenantId).affectedObjects.some(o=>o.type==='PlusEvent'&&o.id===event._id));
    if(matching.length!==1)throw new Error('SYNTHETIC_SOURCE_OUTBOX_REQUIRED');
    const outbox=matching[0],sink=createNativeBeliefEventSink({storage,tenantId,identities,loadPolicy,
      servicesFor:()=>createPrivateTaskServices({storage,tenantId,identities,loadPolicy,cel})});sink.assertConfigured();
    result=await sink.deliver(native.readActionOutboxEnvelope(outbox,tenantId),outbox.deliveryKey);
    if(result?.enqueued!==1||result.jobs?.length!==1)throw new Error('PROFILE_DELIVERY_UNCONFIRMED');
  }else result=operation==='authorization'?await services.replayAuthorizations.requireApproved(sub.authorizationId,principal):await services.beliefs.replayPosition(sub.key,sub.episodeId,principal);
}catch(e){errorCode=/^[A-Z][A-Z0-9_]{0,90}$/.test(e?.code??'')?e.code:'PROFILE_READ_FAILED';process.exitCode=1;}
finally{
  const after=await storage.getReadRevision({tenantId});restore.forEach(f=>f());storage.close();
  cel?.close();if(celProcess&&!celSpawnError&&celProcess.exitCode===null&&celProcess.signalCode===null){const ended=once(celProcess,'exit');celProcess.kill();await ended;}
  const report={schema:'plus-native-qualification-profile-v1',operation,elapsedMs:performance.now()-started,readSucceeded:!!result,errorCode:errorCode??null,
    nativeStateUnchanged:before===after,diagnosticMutation:['event-delivery','action-execution'].includes(operation),methods:snapshot(),durationSemantics:'INCLUSIVE_NESTED_DURATIONS_NOT_ADDITIVE',
    scope:operation==='action-execution'?'Synthetic copy; actual approved action and private factory execute only, not full HTTP/model/worker/restart acceptance':operation==='event-delivery'?'Synthetic copy; actual event sink and private factory enqueue only, not full HTTP/worker/ack acceptance':'Synthetic copy; direct private service qualification, not HTTP/event/worker acceptance'};
  writeFileSync(join(root,'profile-'+operation+'.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
}
