import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { readActionOutboxEnvelope,createActionOutboxJournal } from '../../platform/packages/plus-runtime/dist/index.js';
import { randomUUID } from 'node:crypto';
import { createPrivateAuthorizationRevision } from './private-authority.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const fields=(v,n)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===n.length&&n.every(k=>Object.hasOwn(v,k));
const key=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(v);
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);

/** A second delivery effect on the existing native outbox, not a second queue.
 * Failed refresh leaves the outbox retryable/visible; committed audit is independent.
 * Native capture/snapshot/job keys and trigger links make retries convergent. */
export function createNativeBeliefEventSink({storage,tenantId,identities,loadPolicy,servicesFor}){
  const authority=createPrivateAuthorizationRevision({tenantId,identities,loadPolicy}),ctx={tenantId};
  function load(){const raw=loadPolicy()?.beliefRefresh;if(raw===undefined)return null;const v=structuredClone(raw);
    if(!fields(v,['version','enabled','subscriptions'])||v.version!=='plus-private-belief-refresh-v1'||typeof v.enabled!=='boolean'
      ||!Array.isArray(v.subscriptions)||v.subscriptions.length>100)fail('BELIEF_REFRESH_CONFIGURATION_INVALID');
    const episodes=new Set(),ids=new Set();for(const s of v.subscriptions){
      if(!fields(s,['id','key','episodeId','authorizationId','principalId','targetPolicy'])||!key(s.id)||ids.has(s.id)||!key(s.key)||!id(s.episodeId)||episodes.has(s.episodeId)
        ||!id(s.authorizationId)||!id(s.principalId)||s.targetPolicy!=='LATEST_EFFECTIVE_OR_PRIOR_TARGET')fail('BELIEF_REFRESH_CONFIGURATION_INVALID');
      episodes.add(s.episodeId);ids.add(s.id);
    }
    return v;
  }
  async function fence(p,v,epoch){if(await authority(p)!==epoch||digest(load())!==digest(v))fail('BELIEF_REFRESH_AUTHORITY_STALE');}
  async function nativeEnvelope(envelope,key){const rows=await storage.queryObjects(ctx,'PlusOutbox',{field:'deliveryKey',operator:'eq',value:key},{limit:2});
    if(rows.hasNextPage||rows.totalCount!==1)fail('BELIEF_REFRESH_OUTBOX_INVALID');const row=rows.items[0];
    if(digest(readActionOutboxEnvelope(row,tenantId))!==digest(envelope))fail('BELIEF_REFRESH_OUTBOX_INVALID');return row;
  }
  async function dispatch(envelope,deliveryKey,initializationId){
      const config=load();if(!config?.enabled)return {enqueued:0,jobs:[]};
      if(initializationId!==undefined&&(!key(initializationId)||!config.subscriptions.some(s=>s.id===initializationId)))fail('BELIEF_REFRESH_SUBSCRIPTION_NOT_FOUND');
      const outbox=initializationId===undefined?await nativeEnvelope(envelope,deliveryKey):null;let enqueued=0;const jobs=[],failures=[];
      for(const sub of config.subscriptions){
        if(initializationId!==undefined&&sub.id!==initializationId)continue;
        try{
        // Routing reads IDs only. Full native scope/source authority is checked
        // below before capture, model use, or job creation.
        const episode=await storage.getObject(ctx,'PlusEpisode',sub.episodeId);if(!episode||episode._tenantId!==tenantId||episode._deletedAt)fail('BELIEF_REFRESH_EPISODE_INVALID');
        const root=episode.rootReference,binding=episode.binding;
        if(!root||root.tenantId!==tenantId||typeof binding?.rootEventLink!=='string')fail('BELIEF_REFRESH_EPISODE_INVALID');
        const events=await storage.getLinks(ctx,root.id,binding.rootEventLink,'outbound',{limit:1000});if(events.hasNextPage)fail('BELIEF_REFRESH_COLLECTION_LIMIT');
        if(outbox&&!envelope.affectedObjects.some(o=>o.type===root.type&&o.id===root.id||o.type==='PlusEvent'&&events.items.some(l=>l._toId===o.id)
          ||o.type==='PlusReplayAuthorization'&&o.id===sub.authorizationId))continue;
        const p=await identities.resolvePrincipal(sub.principalId),authEpoch=await authority(p),services=servicesFor();
        const approved=await services.replayAuthorizations.requireApproved(sub.authorizationId,p);
        if(approved.replayAuthorized!==true||approved.record.controlKey!==sub.key)fail('BELIEF_REFRESH_AUTHORIZATION_MISMATCH');
        // Route from the qualified native release, never a subscription flag or
        // worker payload that could disable full-model isolation requirements.
        const selected=approved.material.selection?.release;
        const release=selected&&await storage.getObject({tenantId,actorId:p.id},'PlusModelRelease',selected.id);
        if(!release||release._deletedAt||release._tenantId!==tenantId||release._version!==selected.version||digest(release)!==selected.hash)fail('BELIEF_REFRESH_RELEASE_STALE');
        const complete=release.estimatorId==='ontology-composed-dynamics-v1';
        const capture=await services.temporalInputs.captureCurrent(sub.episodeId,p),d=capture.descriptor,clock=approved.material.policy.clock;
        if(d.definitionHash!==clock.definitionHash||d.bindingHash!==clock.bindingHash||d.classification!==approved.material.policy.classification||d.scopeKey!==approved.material.policy.scopeKey)fail('BELIEF_REFRESH_AUTHORIZATION_MISMATCH');
        await fence(p,config,authEpoch);const position=await services.beliefs.replayPosition(sub.key,sub.episodeId,p);
        const targetTime=position.targetTime&&position.targetTime>d.latestEffectiveAt?position.targetTime:d.latestEffectiveAt;
        const started=Date.parse(d.startedAt),point=Date.parse(targetTime),steps=(point-started)/clock.stepMilliseconds;
        if(!Number.isSafeInteger(steps)||steps<0||steps>clock.maxSteps)fail('BELIEF_REFRESH_TIME_UNSUPPORTED');
        const snapshot=await services.temporalInputs.snapshot({streamId:capture.record._id,targetTime},p,'auto-input-'+digest([capture.record._id,targetTime]));
        const current=await services.temporalInputs.readCurrentTemporalInput(snapshot.record._id,p),input=current.temporal.temporalInput;
        for(const at of [input.targetTime,...input.contexts.map(c=>c.effectiveAt),...input.events.map(e=>e.event.eventTime)]){
          const step=(Date.parse(at)-started)/clock.stepMilliseconds;if(!Number.isSafeInteger(step)||step<0||step>clock.maxSteps)fail('BELIEF_REFRESH_TIME_UNSUPPORTED');
        }
        await fence(p,config,authEpoch);
        if(complete){
          if(typeof services.partitions?.reserve!=='function'||typeof services.partitions?.read!=='function')fail('BELIEF_REFRESH_PARTITION_PROVIDER_REQUIRED');
          // Reserve is a separately authorized, idempotent native transaction.
          // Never supply a desired partition, seed, group or trusted certificate.
          // A later failure may retain the audited capture/reservation, but no
          // prediction job is created until ONLINE qualification succeeds.
          const reserved=await services.partitions.reserve(snapshot.record._id,p),verified=await services.partitions.read(snapshot.record._id,p);
          if(reserved._tenantId!==tenantId||verified._tenantId!==tenantId||reserved._id!==verified._id||reserved._version!==verified._version||reserved.contentHash!==verified.contentHash
            ||verified.partition!=='ONLINE'||verified.snapshotId!==snapshot.record._id||verified.inputHash!==snapshot.record.inputHash||verified.classification!==input.classification)fail('BELIEF_REFRESH_ONLINE_PARTITION_REQUIRED');
          await fence(p,config,authEpoch);
        }
        const job=await services.beliefJobs.ensureQueued(sub.authorizationId,snapshot.record._id,p);
        if(!['PENDING','LEASED','SUCCEEDED'].includes(job.status))fail('BELIEF_REFRESH_JOB_TERMINAL');
        if(outbox){await fence(p,config,authEpoch);const revision=await storage.getReadRevision(ctx),links=await storage.getLinks(ctx,job.id,'PlusExecutionTriggerOutbox','outbound',{limit:1000});
        if(links.hasNextPage)fail('BELIEF_REFRESH_COLLECTION_LIMIT');
        if(!links.items.some(l=>l._toId===outbox._id)){const tx=await storage.beginTransaction(ctx);try{
          if(!tx.assertReadRevision)fail('BELIEF_REFRESH_READ_GUARD_REQUIRED');await tx.assertReadRevision(revision);
          await nativeEnvelope(envelope,deliveryKey);await services.beliefJobs.read(job.id,p);await tx.createLink('PlusExecutionTriggerOutbox',job.id,outbox._id);
          const actionId='act_'+randomUUID();await createActionOutboxJournal().stage(tx,{version:'native-action-commit-v1',tenantId,actionId,
            audit:{id:'audit_'+actionId,tenantId,timestamp:new Date().toISOString(),traceId:randomUUID(),actor:{id:p.id,type:'user',roles:[...p.roles]},
              operation:{type:'action',actionType:'PlusAttachBeliefTrigger',actionId},detail:{result:'success',after:{executionId:job.id,outboxId:outbox._id,subscriptionId:sub.id}}},
            affectedObjects:[{type:'PlusExecution',id:job.id,changeType:'updated'}]});
          await fence(p,config,authEpoch);await tx.commit();
        }catch(e){await tx.rollback();throw e;}}}
        await fence(p,config,authEpoch);enqueued++;jobs.push({id:job.id,status:job.status});
        }catch(error){failures.push(error);}
      }
      // One invalid subscription must not suppress another authorized target.
      // Delivery remains failed/retryable until every affected target succeeds;
      // already committed good targets converge by native job/link identity.
      if(failures.length)throw failures[0];
      return {enqueued,jobs};
  }
  return {assertConfigured:()=>{load();if(typeof servicesFor!=='function')fail('BELIEF_REFRESH_CONFIGURATION_INVALID');},
    subscriptions:()=>{const config=load();return structuredClone(config?.enabled?config.subscriptions:[]);},
    deliver:(envelope,deliveryKey)=>dispatch(envelope,deliveryKey),
    // Explicit current-configuration initialization, not a fabricated source
    // event or a replay of business actions. Native enqueue audit and input /
    // authorization / episode links are its provenance. No trigger link is
    // invented for an event delivered before this subscription existed.
    initialize:subscriptionId=>{if(!key(subscriptionId))fail('BELIEF_REFRESH_SUBSCRIPTION_NOT_FOUND');return dispatch(undefined,undefined,subscriptionId);},
  };
}
