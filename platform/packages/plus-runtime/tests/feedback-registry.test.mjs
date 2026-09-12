import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '@openfoundry/plus-contracts';
import { NativePartitionLedger,NativeFeedbackRegistry,NativeEpisodeRuntime,createNativeReadQualificationPhase } from '../dist/index.js';
import { episodeFixture,ctx,principal,at } from './episode-fixture.mjs';

const trainer={...principal,id:'trainer',roles:['trainer']},reviewer={...principal,id:'reviewer',roles:['data_reviewer']},owner={...principal,id:'owner',roles:['model_owner']};
async function fixture(t,{reserveBefore=true,kind='VERIFICATION',target=1,maturity=60000,verificationMode='GOLD'}={}){
 const f=await episodeFixture(t);let now=2;
 if(verificationMode!=='GOLD')f.setQualify(async(_p,{rule,event})=>({allowed:true,policyHash:digest('synthetic-policy-v1'),dependenceKey:digest([event.sourceSystem,event.sourceRecordId]),verificationMode:rule.kind==='VERIFICATION'?verificationMode:'NONE',learningEligible:false}));
 const advance=n=>{now=n;f.setTime(n);};advance(2);await f.add();const episode=await f.begin();
 const snapshot=async key=>{
  const stream=await f.runtime.capture(episode._id,principal,'stream-'+key);
  return (await f.runtime.snapshot({streamId:stream.record._id,targetTime:at(1)},principal,'input-'+key)).record;
 };
 const input=await snapshot('before');
 const partitionConfig={storage:f.storage,catalog:f.catalog,episodes:f.runtime,tenantId:ctx.tenantId,authorize:async()=>true,clock:()=>Date.parse(at(now)),
  protocolFor:async()=>({version:'plus-partition-v1',seed:'feedback-frozen-seed',groupingPolicyHash:digest('synthetic-entity-v1'),boundaries:[6000,7500,9000,10000]}),
  groupFor:async(_p,root)=>({primary:{namespace:'native-machine',key:root.id},aliases:[]})};
 const partitions=new NativePartitionLedger(partitionConfig);if(reserveBefore)await partitions.reserve(input._id,trainer);
 advance(4);const label=await f.add({kind,minute:target,received:4,origin:'label-1'}),labels=await snapshot('after');
 if(!reserveBefore)await partitions.reserve(input._id,trainer);
 await partitions.reserve(labels._id,trainer);advance(5);
 const policy={version:'plus-feedback-policy-v1',key:'synthetic-task-learning',collectionPolicyHash:digest('frozen-software-collection'),minimumMaturityMs:maturity,classifications:['SYNTHETIC'],variables:['state']};
 const config={storage:f.storage,tenantId:ctx.tenantId,episodes:f.runtime,partitions,authorize:async()=>true,policyFor:async()=>structuredClone(policy),clock:()=>Date.parse(at(now))};
 const feedback=new NativeFeedbackRegistry(config),request={inputSnapshotId:input._id,labelSnapshotId:labels._id,eventId:label.event._id};
 return {...f,input,labels,label,episode,request,feedback,feedbackConfig:config,partitions,partitionConfig,policy,advance,snapshot};
}
const approve=async f=>{const draft=await f.feedback.propose(f.request,trainer);return f.feedback.review(draft.id,draft.version,'APPROVE','independent source eligibility review',reviewer);};

test('approved native feedback reuses only complete same-actor reads inside a fenced phase and returns detached values',async t=>{
  const f=await fixture(t),approved=await approve(f),material=f.feedback.material.bind(f.feedback);let calls=0;
  f.feedback.material=async(...args)=>{calls++;return material(...args);};
  const phase=createNativeReadQualificationPhase({storage:f.storage,tenantId:ctx.tenantId,readers:[f.feedback],authorizationRevision:async()=>digest('feedback-phase-authority')});
  const epoch=await f.storage.getReadRevision(ctx),baseline=await f.feedback.readApproved(approved.id,trainer);calls=0;
  await phase.run(trainer,async()=>{
    const first=await f.feedback.readApproved(approved.id,trainer);assert.deepEqual(first,baseline);first.payload.input.eventId='changed-copy';
    assert.deepEqual(await f.feedback.readApproved(approved.id,trainer),baseline);assert.equal(calls,1);
    await f.feedback.readApproved(approved.id,owner);assert.equal(calls,2,'different actor requires full native qualification');
  });
  await phase.run(trainer,()=>f.feedback.readApproved(approved.id,trainer));assert.equal(calls,3);
  await f.feedback.readApproved(approved.id,trainer);assert.equal(calls,4,'no cross-request reuse');
  assert.equal(await f.storage.getReadRevision(ctx),epoch);
});

test('feedback read reuse refuses source/native changes, authority withdrawal and expired secondary identities',async t=>{
  for(const change of ['native','authority','secondary-expiry']){
    const f=await fixture(t),approved=await approve(f);let revision=1,expired=false;
    const phase=createNativeReadQualificationPhase({storage:f.storage,tenantId:ctx.tenantId,readers:[f.feedback],authorizationRevision:async p=>{
      if(expired&&p.id===owner.id)throw Error('IDENTITY_EXPIRED');return digest(revision);
    }});
    await assert.rejects(()=>phase.run(trainer,async()=>{
      await f.feedback.readApproved(approved.id,trainer);await f.feedback.readApproved(approved.id,owner);
      if(change==='native')await f.storage.updateObject(ctx,'PlusEvent',f.label.event._id,{revoked:true},f.label.event._version);
      if(change==='authority')revision++;
      if(change==='secondary-expiry')expired=true;
      if(change!=='secondary-expiry')await f.feedback.readApproved(approved.id,trainer);
      return 'must not escape';
    }),/CONFLICT|AUTHORITY_STALE|IDENTITY_EXPIRED/);
    if(change==='native')await assert.rejects(()=>f.feedback.readApproved(approved.id,trainer));
  }
});

test('feedback qualification failures never populate the phase and review still executes independent material checks',async t=>{
  const f=await fixture(t),draft=await f.feedback.propose(f.request,trainer),material=f.feedback.material.bind(f.feedback);let calls=0;
  f.feedback.material=async(...args)=>{calls++;return material(...args);};
  const phase=createNativeReadQualificationPhase({storage:f.storage,tenantId:ctx.tenantId,readers:[f.feedback],authorizationRevision:async()=>digest('feedback-phase-authority')});
  await phase.run(trainer,async()=>{
    await assert.rejects(()=>f.feedback.readApproved(draft.id,trainer),/NOT_ELIGIBLE/);
    await assert.rejects(()=>f.feedback.readApproved(draft.id,trainer),/NOT_ELIGIBLE/);
  });
  assert.equal(calls,0);await f.feedback.review(draft.id,draft.version,'APPROVE','independent review',reviewer);
  assert.ok(calls>=2,'review must retain its independent material and precommit revalidation');
  calls=0;await phase.run(trainer,async()=>{await f.feedback.readApproved(draft.id,trainer);await f.feedback.readApproved(draft.id,trainer);});assert.equal(calls,1);
});

const enableProposalDiscovery=f=>{f.feedbackConfig.discovery={authorizeRoot:async()=>true,authorizeProposalRoot:async()=>true,authorizationRevision:async()=>digest('proposal-authority')};};
test('feedback proposal options and preview are source-qualified read-only native references without label export or approval',async t=>{
  const f=await fixture(t),root={type:'Machine',id:f.root._id};await assert.rejects(()=>f.feedback.proposalOptions(root,trainer),/NOT_CONFIGURED/);enableProposalDiscovery(f);
  const epoch=await f.storage.getReadRevision(ctx),options=await f.feedback.proposalOptions(root,trainer);
  assert.equal(options.items.length,2);assert.equal(options.learningEligible,false);assert.equal(options.items.find(v=>v.id===f.labels._id).verificationEvents[0].id,f.label.event._id);
  assert.equal(options.items.find(v=>v.id===f.input._id).verificationEvents.length,0);assert.equal(JSON.stringify(options).includes('PRIVATE_RAW_EVIDENCE'),false);
  assert.equal(JSON.stringify(options).includes('"label"'),false);assert.equal(JSON.stringify(options).includes('compiledInput'),false);
  const preview=await f.feedback.preview(f.request,trainer);assert.equal(preview.feedbackApproved,false);assert.equal(preview.learningEligible,false);assert.equal(preview.variable,'state');assert.equal(preview.snapshots.input.version,f.input._version);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.rows('PlusFeedback')).totalCount,0);
  await assert.rejects(()=>f.feedback.proposalOptions(root,reviewer),/FORBIDDEN/);
  await f.storage.updateObject(ctx,'PlusInputSnapshot',f.labels._id,{readiness:'SUSPENDED'},f.labels._version);
  assert.equal((await f.feedback.proposalOptions(root,trainer)).items.length,1);await assert.rejects(()=>f.feedback.preview(f.request,trainer),/SUSPENDED/);
});

test('preview does not repair late partitioning or promote ordinary reports into independent labels',async t=>{
  const late=await fixture(t,{reserveBefore:false});enableProposalDiscovery(late);
  await assert.rejects(()=>late.feedback.preview(late.request,trainer),/PARTITION_TOO_LATE/);assert.equal((await late.rows('PlusFeedback')).totalCount,0);
  const ordinary=await fixture(t,{kind:'OBSERVATION'});enableProposalDiscovery(ordinary);
  assert.equal((await ordinary.feedback.proposalOptions({type:'Machine',id:ordinary.root._id},trainer)).items.every(v=>v.verificationEvents.length===0),true);
  await assert.rejects(()=>ordinary.feedback.preview(ordinary.request,trainer),/LABEL_INELIGIBLE/);
});

test('proposal options reject authority changes, native read races and incomplete inventory',async t=>{
  const f=await fixture(t);enableProposalDiscovery(f);const root={type:'Machine',id:f.root._id};let checks=0;
  f.feedbackConfig.discovery.authorizationRevision=async()=>digest(++checks);
  await assert.rejects(()=>f.feedback.proposalOptions(root,trainer),/AUTHORITY_STALE/);enableProposalDiscovery(f);
  const storage=f.feedbackConfig.storage;let mode='truncated',armed=true;
  f.feedbackConfig.storage=new Proxy(storage,{get(target,key){if(key==='queryObjects')return async(...args)=>{const result=await storage.queryObjects(...args);
    if(args[1]==='PlusInputSnapshot'){if(mode==='truncated')return {...result,hasNextPage:true};if(armed){armed=false;await storage.updateObject(ctx,'Machine',f.root._id,{priority:7},f.root._version);}}return result;};return Reflect.get(target,key);}});
  await assert.rejects(()=>f.feedback.proposalOptions(root,trainer),/COLLECTION_LIMIT/);mode='race';await assert.rejects(()=>f.feedback.proposalOptions(root,trainer),/CONFLICT/);
});

test('root feedback discovery is guarded metadata, requalifies authority and allows rejection without treating revoked evidence as learnable',async t=>{
  const f=await fixture(t),draft=await f.feedback.propose(f.request,trainer),root={type:'Machine',id:f.root._id};let allowed=true,authority=1;
  await assert.rejects(()=>f.feedback.listForRoot(root,reviewer),/NOT_CONFIGURED/);
  f.feedbackConfig.discovery={authorizeRoot:async()=>allowed,authorizationRevision:async()=>digest(authority)};
  const epoch=await f.storage.getReadRevision(ctx),index=await f.feedback.listForRoot(root,reviewer);
  assert.equal(index.items.length,1);assert.equal(index.items[0].id,draft.id);assert.equal(index.items[0].qualification,'NOT_CHECKED');
  assert.equal(index.learningEligible,false);assert.equal(JSON.stringify(index).includes('PRIVATE_RAW_EVIDENCE'),false);assert.equal(await f.storage.getReadRevision(ctx),epoch);
  let checks=0;f.feedbackConfig.discovery.authorizeRoot=async()=>{if(++checks===2)authority++;return allowed;};
  await assert.rejects(()=>f.feedback.listForRoot(root,reviewer),/AUTHORITY_STALE/);f.feedbackConfig.discovery.authorizeRoot=async()=>allowed;
  allowed=false;await assert.rejects(()=>f.feedback.listForRoot(root,reviewer),/FORBIDDEN/);allowed=true;
  await f.storage.updateObject(ctx,'PlusEvent',f.label.event._id,{revoked:true},f.label.event._version);
  assert.equal((await f.feedback.listForRoot(root,reviewer)).items[0].qualification,'NOT_CHECKED');
  await assert.rejects(()=>f.feedback.read(draft.id,reviewer),/REVOKED/);
  await assert.rejects(()=>f.feedback.review(draft.id,draft.version,'APPROVE','Cannot learn revoked source',reviewer),/REVOKED/);
  const rejected=await f.feedback.review(draft.id,draft.version,'REJECT','Source was withdrawn',reviewer);assert.equal(rejected.status,'REJECTED');
});

test('feedback discovery rejects unbounded/truncated inventory and native changes during the read',async t=>{
  const f=await fixture(t);await f.feedback.propose(f.request,trainer);const root={type:'Machine',id:f.root._id};
  f.feedbackConfig.discovery={authorizeRoot:async()=>true,authorizationRevision:async()=>digest('stable')};
  const storage=f.feedbackConfig.storage,query=storage.queryObjects.bind(storage);let mode='limit',armed=true;
  f.feedbackConfig.storage=new Proxy(storage,{get(target,name){if(name==='queryObjects')return async(...args)=>{
    const page=await query(...args);if(args[1]==='PlusFeedback'){
      if(mode==='limit')return {...page,hasNextPage:true};
      if(armed){armed=false;await storage.updateObject(ctx,'Machine',f.root._id,{priority:7},f.root._version);}
    }return page;
  };return Reflect.get(target,name);}});
  await assert.rejects(()=>f.feedback.listForRoot(root,reviewer),/COLLECTION_LIMIT/);mode='race';
  await assert.rejects(()=>f.feedback.listForRoot(root,reviewer),/CONFLICT/);assert.equal(armed,false);
});

test('later independent gold is approved against frozen earlier input without label leakage',async t=>{
 const f=await fixture(t),original=structuredClone(f.input.compiledInput),draft=await f.feedback.propose(f.request,trainer);
 assert.equal(draft.status,'PROPOSED');await assert.rejects(()=>f.feedback.readApproved(draft.id,trainer),/FEEDBACK_NOT_ELIGIBLE/);
 const result=await f.feedback.review(draft.id,draft.version,'APPROVE','qualified later gold',reviewer),approved=await f.feedback.readApproved(result.id,trainer);
 assert.equal(result.status,'APPROVED');assert.equal(approved.payload.evidence.label.value,'READY');
 assert.equal(approved.payload.evidence.targetTime,at(1));assert.equal(approved.payload.evidence.receivedAt,at(4));assert.equal(approved.payload.matureAt,at(5));
 assert.equal(approved.payload.evidence.visibleAt,at(2));assert.equal(approved.payload.partitionRefs.length,2);
 assert.deepEqual((await f.runtime.readSnapshot(f.input._id,principal)).compiledInput,original);
 assert.equal(original.events.some(e=>e.kind==='VERIFICATION'),false);
 const epoch=await f.storage.getReadRevision(ctx);
 assert.equal((await f.feedback.propose(f.request,trainer)).id,draft.id);
 assert.equal((await f.feedback.review(draft.id,draft.version,'APPROVE','qualified later gold',reviewer)).id,draft.id);
 assert.equal(await f.storage.getReadRevision(ctx),epoch);
 const outbox=(await f.rows('PlusOutbox')).items.filter(r=>r.envelope.audit.operation.actionType.includes('Feedback'));
 assert.equal(outbox.length,2);assert.equal(JSON.stringify(outbox.map(o=>o.envelope.audit)).includes('PRIVATE_RAW_EVIDENCE'),false);
});

test('feedback proposal review-read requalifies sources without treating readability as approval',async t=>{
 const f=await fixture(t),draft=await f.feedback.propose(f.request,trainer),epoch=await f.storage.getReadRevision(ctx);
 const review=await f.feedback.read(draft.id,reviewer);assert.equal(review.feedbackApproved,false);assert.equal(review.record.status,'PROPOSED');
 assert.equal(review.record.payload.evidence.label.value,'READY');assert.equal(review.record.payload.evidence.visibleAt,at(2));
 assert.equal(await f.storage.getReadRevision(ctx),epoch);await assert.rejects(()=>f.feedback.readApproved(draft.id,reviewer),/NOT_ELIGIBLE/);
 f.feedbackConfig.authorize=async()=>false;await assert.rejects(()=>f.feedback.read(draft.id,reviewer),/FORBIDDEN/);
 f.feedbackConfig.authorize=async()=>true;await f.storage.updateObject(ctx,'PlusEvent',f.label.event._id,{revoked:true},f.label.event._version);
 await assert.rejects(()=>f.feedback.read(draft.id,reviewer),/REVOKED/);
});

test('feedback review-read refuses a late permission change or concurrent native read-set change',async t=>{
 const f=await fixture(t),draft=await f.feedback.propose(f.request,trainer);let reads=0;
 f.feedbackConfig.authorize=async(_p,permission)=>permission!=='feedback:read'||++reads===1;
 await assert.rejects(()=>f.feedback.read(draft.id,reviewer),/FORBIDDEN/);
 f.feedbackConfig.authorize=async()=>true;
 const original=f.feedbackConfig.policyFor;let changed=false;
 f.feedbackConfig.policyFor=async(...args)=>{if(!changed){changed=true;await f.storage.updateObject(ctx,'Machine',f.root._id,{priority:1},f.root._version);}return original(...args);};
 await assert.rejects(()=>f.feedback.read(draft.id,reviewer),/CONFLICT/);
});

test('partitioning after the label arrived cannot qualify a hindsight-selected sample',async t=>{
 const f=await fixture(t,{reserveBefore:false});
 await assert.rejects(()=>f.feedback.propose(f.request,trainer),/FEEDBACK_PARTITION_TOO_LATE/);
 assert.equal((await f.rows('PlusFeedback')).totalCount,0);
});

test('ordinary report and uncertain/noisy verification cannot be relabeled as gold supervision',async t=>{
 const f=await fixture(t,{kind:'OBSERVATION'});
 await assert.rejects(()=>f.feedback.propose(f.request,trainer),/FEEDBACK_LABEL_INELIGIBLE/);
 const g=await fixture(t,{verificationMode:'NOISY'});
 await assert.rejects(()=>g.feedback.propose(g.request,trainer),/FEEDBACK_LABEL_INELIGIBLE/);
});

test('label time must equal the prediction target, not merely be a later completion',async t=>{
 const f=await fixture(t,{target:2});await assert.rejects(()=>f.feedback.propose(f.request,trainer),/FEEDBACK_LABEL_TIME_INVALID/);
});

test('maturity is a server-clock gate and cannot be supplied in the request',async t=>{
 const f=await fixture(t,{maturity:120000});await assert.rejects(()=>f.feedback.propose(f.request,trainer),/FEEDBACK_LABEL_IMMATURE/);
 await assert.rejects(()=>f.feedback.propose({...f.request,matureAt:at(4)},trainer),/FEEDBACK_INVALID_INPUT/);
 f.advance(6);assert.equal((await f.feedback.propose(f.request,trainer)).status,'PROPOSED');
});

test('self-approval, wrong role and wrong tenant cannot certify feedback',async t=>{
 const f=await fixture(t),draft=await f.feedback.propose(f.request,trainer);
 await assert.rejects(()=>f.feedback.review(draft.id,draft.version,'APPROVE','self',{...trainer,roles:['trainer','data_reviewer']}),/FEEDBACK_INDEPENDENT_REVIEW_REQUIRED/);
 await assert.rejects(()=>f.feedback.review(draft.id,draft.version,'APPROVE','wrong',principal),/FEEDBACK_FORBIDDEN/);
 await assert.rejects(()=>f.feedback.readApproved(draft.id,{...trainer,tenantId:'other'}),/FEEDBACK_FORBIDDEN/);
 assert.equal((await f.rows('PlusFeedback')).items[0].status,'PROPOSED');
});

test('purpose-policy changes invalidate approval without changing original proposal',async t=>{
 const f=await fixture(t),draft=await f.feedback.propose(f.request,trainer),epoch=await f.storage.getReadRevision(ctx);
 f.feedbackConfig.policyFor=async()=>({...f.policy,collectionPolicyHash:digest('different-acquisition')});
 await assert.rejects(()=>f.feedback.review(draft.id,draft.version,'APPROVE','changed',reviewer),/FEEDBACK_POLICY_STALE/);
 assert.equal(await f.storage.getReadRevision(ctx),epoch);
 assert.equal((await f.feedback.review(draft.id,draft.version,'REJECT','outdated collection policy',reviewer)).status,'REJECTED');
});

test('withdrawal cascades from label or input into approved feedback but never releases partition locks',async t=>{
 const f=await fixture(t),approved=await approve(f),assignments=(await f.rows('PlusPartitionAssignment')).totalCount;
 const change=await f.runtime.proposeSourceChange({episodeId:f.episode._id,kind:'REVOCATION',eventId:f.label.event._id,eventVersion:f.label.event._version,reason:'withdraw label source'},reviewer,'withdraw-feedback-label');
 await f.runtime.reviewSourceChange(change._id,change._version,'APPROVE','confirmed withdrawal',owner);
 const row=await f.storage.getObject(ctx,'PlusFeedback',approved.id);assert.equal(row.status,'APPROVED');assert.equal(row.readiness,'SUSPENDED');
 await assert.rejects(()=>f.feedback.readApproved(approved.id,trainer),/FEEDBACK_NOT_ELIGIBLE/);
 assert.equal((await f.rows('PlusPartitionAssignment')).totalCount,assignments);
});

test('final permission loss rolls back proposal, native links and outbox together',async t=>{
 const f=await fixture(t);let count=0;f.feedbackConfig.authorize=async()=>++count===1;
 const epoch=await f.storage.getReadRevision(ctx);await assert.rejects(()=>f.feedback.propose(f.request,trainer),/FEEDBACK_FORBIDDEN/);
 assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.rows('PlusFeedback')).totalCount,0);
});

test('native label lineage tampering blocks approved reads even when stored payload hashes are untouched',async t=>{
 const f=await fixture(t),approved=await approve(f);
 const link=(await f.storage.getLinks(ctx,approved.id,'PlusFeedbackSource','outbound')).items[0];await f.storage.deleteLink(ctx,'PlusFeedbackSource',link._id);
 await assert.rejects(()=>f.feedback.readApproved(approved.id,trainer),/FEEDBACK_LINK_INVALID/);
});

test('already known target gold in input cannot become a fresh predictive learning example',async t=>{
 const f=await fixture(t);f.advance(6);const later=await f.add({kind:'VERIFICATION',minute:1,received:6,origin:'another-gold'}),last=await f.snapshot('last');
 await f.partitions.reserve(last._id,trainer);f.advance(7);
 await assert.rejects(()=>f.feedback.propose({inputSnapshotId:f.labels._id,labelSnapshotId:last._id,eventId:later.event._id},trainer),/FEEDBACK_TARGET_ALREADY_KNOWN/);
});

test('reopened native feedback retains independent decision and original sample identity',async t=>{
 const f=await fixture(t),approved=await approve(f),storage=f.openStorage();
 const episodes=new NativeEpisodeRuntime({...f.config,storage});
 const partitions=new NativePartitionLedger({...f.partitionConfig,storage,episodes});
 const registry=new NativeFeedbackRegistry({...f.feedbackConfig,storage,episodes,partitions});
 const epoch=await storage.getReadRevision(ctx),row=await registry.readApproved(approved.id,trainer);
 assert.equal(row.decidedBy,reviewer.id);assert.equal(row.sampleKey,digest([ctx.tenantId,'Machine',f.root._id,'state',at(1)]));
 assert.equal(await storage.getReadRevision(ctx),epoch);
});

test('late private policy change before proposal commit does not leave a pending certificate behind',async t=>{
 const f=await fixture(t);let calls=0;
 f.feedbackConfig.policyFor=async()=>({...f.policy,collectionPolicyHash:++calls>2?digest('changed-after-initial-material'):f.policy.collectionPolicyHash});
 const epoch=await f.storage.getReadRevision(ctx);
 await assert.rejects(()=>f.feedback.propose(f.request,trainer),/FEEDBACK_POLICY_STALE/);
 assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.rows('PlusFeedback')).totalCount,0);
});

test('current label field permission is enforced again when an approved sample is read',async t=>{
 const f=await fixture(t),approved=await approve(f),epoch=await f.storage.getReadRevision(ctx);
 f.setAuthorize(async(_p,_permission,access)=>!access.sources.some(s=>s.type==='StatusCheck'));
 await assert.rejects(()=>f.feedback.readApproved(approved.id,trainer),/EPISODE_FORBIDDEN/);
 assert.equal(await f.storage.getReadRevision(ctx),epoch);
});
