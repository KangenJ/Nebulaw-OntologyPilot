import { randomUUID } from 'node:crypto';
import { canonicalJson,digest } from '@openfoundry/plus-contracts';
import type { StorageProvider,OntologyObject,RequestContext,Transaction,DateTime } from '@openfoundry/spi';
import type { PlusPrincipal } from './ontology-catalog.js';
import type { NativeReplayAuthorization,ReplayClock } from './replay-authorization.js';
import type { NativeEpisodeRuntime } from './episode-runtime.js';
import type { NativeRecipeRegistry } from './recipe-registry.js';
import { readFitTrainingContext,trainingFields,type FitTrainingProvider,type FitTrainingContext,type TrainingReadSet } from './fit-training-context.js';
import type { NativeReference } from './episode-types.js';
import type { NativeBeliefComposition,PreparedBeliefComposition } from './belief-composition.js';
import type { NativeLearnedBeliefComposition,PreparedLearnedBeliefComposition,LearnedBeliefFit } from './learned-belief-composition.js';
import { createActionOutboxJournal } from './outbox.js';
import type { NativeReadQualificationPhase } from './read-qualification-phase.js';

type Fit=FitTrainingContext;
type Current=Awaited<ReturnType<NativeEpisodeRuntime['readCurrentTemporalInput']>>;
export interface BeliefReplayInput {authorizationId:string;snapshotId:string;expectedVersion:number}
export interface BeliefEngineRequest {recipe:Record<string,unknown>;candidate:Record<string,unknown>;trainingMaterials:Fit['trainingMaterials'];temporalInput:Current['temporal']['temporalInput'];clock:ReplayClock}
export interface BeliefEngineResult {schema:'plus-online-replay-result-v1';engineId:string;artifactHash:string;inputHash:string;clockHash:string;estimate:Record<string,unknown>;composition?:Record<string,unknown>}
export interface PreparedBeliefReplay {key:string;episodeId:string;preparedHash:string}
/** Trusted native job adapter only, never populated from HTTP/worker JSON. The
 * adapter stages its receipt into the SAME transaction as the derived state. */
export interface BeliefExecutionGuard {
  preparedHash:string;assertCurrent:()=>Promise<void>;
  stage:(tx:Transaction,result:ReturnType<typeof summary>)=>Promise<void>;
}
export interface BeliefRuntimeConfig {
  storage:StorageProvider;tenantId:string;authorizations:Pick<NativeReplayAuthorization,'requireApproved'>;
  episodes:Pick<NativeEpisodeRuntime,'readCurrentTemporalInput'>;recipes:Pick<NativeRecipeRegistry,'requireApproved'>;
  compute:FitTrainingProvider;
  authorize:(p:PlusPrincipal,permission:'belief:replay'|'belief:read',key:string,episodeId:string)=>Promise<boolean>;
  authorizationRevision:(p:PlusPrincipal)=>Promise<string>;
  engine:{id:string;run:(request:BeliefEngineRequest)=>Promise<BeliefEngineResult>};clock?:()=>number;
  /** Trusted optional joint adapter; no HTTP/worker may supply this object. */
  composition?:NativeBeliefComposition;
  /** Complete FIT/ancestor/online-history adapter; no fallback to observation-only. */
  learnedComposition?:NativeLearnedBeliefComposition;
  /** Same-graph trusted read scope, never client configuration. Each material
   * pass ends before numerical execution or commit; final qualification is new. */
  readQualificationPhase?:NativeReadQualificationPhase;
}
type Ref={id:string;version:number;hash:string};
type ReadSet=TrainingReadSet & {authorization:Ref;selection:Ref;deploymentId:string;controlKey:string;generation:number;engineId:string;release:Ref;recipe:Ref;execution:{id:string;version:number};
  snapshot:Ref;episode:NativeReference;inventoryHash:string;temporalHash:string;artifactHash:string;streamRevision:number;headKey:string;composition?:PreparedBeliefComposition['readSet'];
  learnedComposition?:PreparedLearnedBeliefComposition['readSet']};
type Payload={command:BeliefReplayInput;readSet:ReadSet;result:BeliefEngineResult;previous:Ref|null;createdBy:string;createdAt:string};
const BELIEF='PlusBeliefSnapshot',HEAD='PlusBeliefHead';
function fail(code:string):never{throw Object.assign(new Error(code),{code});}
function text(v:unknown):string{if(typeof v!=='string'||!v.trim()||v.length>2000)fail('BELIEF_INVALID_INPUT');return v;}
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const ref=(r:OntologyObject):Ref=>({id:r._id,version:r._version,hash:String(r.contentHash)});
const beliefHash=(r:Record<string,unknown>)=>digest(Object.fromEntries(['beliefKey','classification','distribution','explanation','engineVersion','payload'].map(k=>[k,r[k]])));
const headHash=(r:Record<string,unknown>)=>digest(Object.fromEntries(['headKey','controlKey','deploymentId','episodeId','generation','streamRevision','current'].map(k=>[k,r[k]])));
const summary=(b:OntologyObject,h:OntologyObject,replayed=false)=>({beliefId:b._id,beliefVersion:b._version,headId:h._id,headVersion:h._version,generation:h.generation,
  readiness:h.readiness,current:(h.current as Ref).id===b._id,replayed,predictionReady:h.readiness==='READY'});

/** Current native derived state, never a business fact writer. All computation is
 * outside the transaction; only a still-current complete read set may advance the
 * episode's head. Inputs/results cannot be supplied as arbitrary client JSON.
 */
export class NativeBeliefRuntime {
  constructor(private readonly config:BeliefRuntimeConfig){}
  private context(p:PlusPrincipal):RequestContext{if(!p?.id||p.tenantId!==this.config.tenantId||!Array.isArray(p.roles))fail('BELIEF_FORBIDDEN');return {tenantId:p.tenantId,actorId:p.id,traceId:randomUUID()};}
  private now(){const n=(this.config.clock??Date.now)();if(!Number.isFinite(n))fail('BELIEF_INVALID_CLOCK');return new Date(n).toISOString();}
  private async access(p:PlusPrincipal,permission:'belief:read'|'belief:replay',key:string,episodeId:string){this.context(p);if(!await this.config.authorize(p,permission,text(key),text(episodeId)))fail('BELIEF_FORBIDDEN');}
  private async authority(p:PlusPrincipal){if(!this.config.authorizationRevision)fail('BELIEF_AUTHORITY_REQUIRED');const h=await this.config.authorizationRevision(p);if(!hash(h))fail('BELIEF_AUTHORITY_INVALID');return h;}
  private async epoch(ctx:RequestContext){if(!this.config.storage.getReadRevision)fail('BELIEF_READ_GUARD_REQUIRED');return this.config.storage.getReadRevision!(ctx);}
  private async row(ctx:RequestContext,type:string,id:string){const r=await this.config.storage.getObject(ctx,type,text(id));if(!r||r._tenantId!==ctx.tenantId||r._deletedAt)fail('BELIEF_NOT_FOUND');return r;}
  private async one(ctx:RequestContext,type:string,field:string,value:string){const r=await this.config.storage.queryObjects(ctx,type,{field,operator:'eq',value},{limit:2});if(r.hasNextPage||r.totalCount>1)fail('BELIEF_INTEGRITY');return r.items[0];}
  private async link(ctx:RequestContext,id:string,type:string,expected:string|null){const r=await this.config.storage.getLinks(ctx,id,type,'outbound',{limit:2});
    if(r.hasNextPage||r.items.length!==r.totalCount||r.totalCount!==(expected===null?0:1)||expected!==null&&r.items[0]!._toId!==expected)fail('BELIEF_LINK_INVALID');return r.items[0];}
  private async consumption(ctx:RequestContext,candidate:Record<string,unknown>,current:Current){
    const c=candidate.consumption as {entityKeys:string[];eventKeys:string[];dependenceKeys:string[];sources:Ref[]};
    if(!c||!['entityKeys','eventKeys','dependenceKeys','sources'].every(k=>Array.isArray((c as unknown as Record<string,unknown>)[k])))fail('BELIEF_CONSUMPTION_REQUIRED');
    const input=current.temporal.temporalInput,root=input.rootReference;
    if(c.entityKeys.includes(digest([root.tenantId,root.type,root.id])))fail('BELIEF_TRAINING_ENTITY_OVERLAP');
    const sourceIds=new Set(c.sources.map(r=>text(r.id))),captured=current.snapshot.readSet as {events:Array<{reference:NativeReference;qualification:{dependenceKey:string}}>};
    // Conservatively exclude every source exposed in this capture, not only the
    // report ultimately used by the current estimator.
    if(captured.events.some(e=>sourceIds.has(e.reference.id)||c.dependenceKeys.includes(e.qualification.dependenceKey))
      ||input.events.some(e=>c.eventKeys.includes(e.event.key)||c.dependenceKeys.includes(e.event.dependenceKey)))fail('BELIEF_CONSUMED_SOURCE_OVERLAP');
    if(c.sources.length>10000||captured.events.length>1000)fail('BELIEF_CONSUMPTION_LIMIT');
    const origins=new Set<string>(),objects=new Set<string>();
    const sourceKeys=(e:OntologyObject)=>{const r=e.sourceReference as NativeReference;
      return {origin:digest([text(e.sourceSystem),text(e.sourceRecordId)]),object:digest([r.tenantId,r.type,r.id])};};
    // Include training GOLD and every exposed source, not only the observation
    // keys carried by the fitted likelihood. New event IDs/versions cannot make a
    // previously consumed native origin or source object independent again.
    for(const item of c.sources){const e=await this.row(ctx,'PlusEvent',item.id);
      if(e._version!==item.version||e.contentHash!==item.hash||e.revoked)fail('BELIEF_TRAINING_SOURCE_STALE');
      const keys=sourceKeys(e);origins.add(keys.origin);objects.add(keys.object);
    }
    for(const item of captured.events){const e=await this.row(ctx,'PlusEvent',item.reference.id),keys=sourceKeys(e);
      if(origins.has(keys.origin)||objects.has(keys.object))fail('BELIEF_CONSUMED_SOURCE_OVERLAP');
    }
  }
  private async material(input:BeliefReplayInput,p:PlusPrincipal,permission:'belief:read'|'belief:replay'){
    const command=structuredClone(input),actor=structuredClone(p),read=()=>this.materialQualified(command,actor,permission);
    return this.config.readQualificationPhase?this.config.readQualificationPhase.run(actor,read):read();
  }
  private async materialQualified(input:BeliefReplayInput,p:PlusPrincipal,permission:'belief:read'|'belief:replay'){
    const ctx=this.context(p),a=await this.config.authorizations.requireApproved(input.authorizationId,p),current=await this.config.episodes.readCurrentTemporalInput(input.snapshotId,p);
    const selected=a.material,key=String(a.record.controlKey),episodeId=current.episode.id,temporal=current.temporal.temporalInput;
    await this.access(p,permission,key,episodeId);
    if(a.replayAuthorized!==true||current.snapshot._id!==input.snapshotId||temporal.episodeKey!==episodeId||current.snapshot._tenantId!==ctx.tenantId
      ||temporal.definitionHash!==selected.policy.clock.definitionHash||temporal.bindingHash!==selected.policy.clock.bindingHash||temporal.classification!==selected.policy.classification)fail('BELIEF_AUTHORIZATION_MISMATCH');
    const release=await this.row(ctx,'PlusModelRelease',selected.selection.release.id),executionLinks=await this.config.storage.getLinks(ctx,release._id,'PlusReleaseExecution','outbound',{limit:2});
    if(executionLinks.hasNextPage||executionLinks.totalCount!==1||executionLinks.items.length!==1)fail('BELIEF_LINK_INVALID');
    let completeFit:LearnedBeliefFit|undefined;
    if(release.estimatorId==='ontology-composed-dynamics-v1'){
      if(!this.config.learnedComposition)fail('BELIEF_COMPLETE_NOT_CONFIGURED');
      completeFit=await this.config.learnedComposition.readFit(executionLinks.items[0]!._toId,p);
    }
    const fit=completeFit??await readFitTrainingContext(this.config.compute,executionLinks.items[0]!._toId,p);
    if(!fit.recipeHash)fail('BELIEF_RECIPE_REQUIRED');
    const recipe=await this.config.recipes.requireApproved(fit.recipeHash,p,'recipe:read');
    const candidate=fit.response.payload as Record<string,unknown>,payload=recipe.payload as {compiled:{definitionHash:string;definition:{scope:{key:string}}};config:{bindingHash:string;classification:string}};
    if(fit.response.candidateId!==release._id||fit.response.execution.status!=='SUCCEEDED'||digest(release)!==selected.selection.release.hash||release._version!==selected.selection.release.version
      ||digest(candidate)!==release.artifactHash||digest(recipe.payload)!==fit.recipeHash||recipe.record.recipeHash!==fit.recipeHash||digest(payload.compiled)!==selected.selection.definition.hash
      ||payload.compiled.definitionHash!==temporal.definitionHash||payload.compiled.definition.scope.key!==selected.policy.scopeKey||payload.config.bindingHash!==temporal.bindingHash
      ||payload.config.classification!==temporal.classification)fail('BELIEF_MODEL_MISMATCH');
    let composition:PreparedBeliefComposition|undefined,learnedComposition:PreparedLearnedBeliefComposition|undefined;
    if(recipe.payload.engineId==='ontology-composed-dynamics-v1'){
      if(!completeFit||!this.config.learnedComposition||digest(recipe.payload.clock)!==digest(selected.policy.clock))fail('BELIEF_COMPLETE_MODEL_MISMATCH');
      learnedComposition=await this.config.learnedComposition.prepare(recipe.payload,completeFit,current,key,p,permission);
      await this.consumption(ctx,learnedComposition.consumption,current);
    }else if(completeFit)fail('BELIEF_COMPLETE_MODEL_MISMATCH');
    else if(recipe.payload.engineId==='ontology-composed-observation-v1'){
      if(!this.config.composition)fail('BELIEF_COMPOSITION_NOT_CONFIGURED');
      composition=await this.config.composition.prepare(recipe.payload,current,key,p,permission);
      await this.consumption(ctx,candidate.statistics as Record<string,unknown>,current);
    }else await this.consumption(ctx,candidate,current);
    const readSet:ReadSet={authorization:ref(a.record),selection:selected.revision,deploymentId:selected.deployment.id,controlKey:key,generation:selected.generation,engineId:text(learnedComposition?this.config.learnedComposition!.id:composition?this.config.composition!.id:this.config.engine.id),
      release:selected.selection.release,recipe:{id:recipe.record._id,version:recipe.record._version,hash:fit.recipeHash},execution:{id:fit.response.execution.id,version:fit.response.execution.version},
      ...trainingFields(fit),snapshot:{id:current.snapshot._id,version:current.snapshot._version,hash:String(current.snapshot.inputHash)},episode:current.episode,
      inventoryHash:current.inventoryHash,temporalHash:current.temporal.contentHash,artifactHash:digest(candidate),streamRevision:Number(current.snapshot.streamRevision),headKey:digest([ctx.tenantId,selected.deployment.id,episodeId]),
      ...(composition?{composition:composition.readSet}:{}),...(learnedComposition?{learnedComposition:learnedComposition.readSet}:{})};
    const request:BeliefEngineRequest={recipe:recipe.payload,candidate,trainingMaterials:fit.trainingMaterials,temporalInput:temporal,clock:selected.policy.clock};
    return {readSet,request,composition,learnedComposition};
  }
  private result(value:BeliefEngineResult,request:BeliefEngineRequest){
    const r=structuredClone(value),e=r?.estimate;
    if(!r||Object.keys(r).sort().join(',')!=='artifactHash,clockHash,engineId,estimate,inputHash,schema'||canonicalJson(r).length>4194304
      ||r.schema!=='plus-online-replay-result-v1'||r.engineId!==this.config.engine.id||r.artifactHash!==digest(request.candidate)||r.inputHash!==digest(request.temporalInput)||r.clockHash!==digest(request.clock)
      ||!e||e.schema!=='plus-temporal-estimate-v1'||e.inputHash!==r.inputHash||e.clockHash!==r.clockHash||e.classification!==request.temporalInput.classification
      ||e.targetTime!==request.temporalInput.targetTime||e.visibleAt!==request.temporalInput.visibleAt||e.businessFactsWritten!==false||e.deploymentAuthorized!==false
      ||e.semantics!=='STATE_ESTIMATION_AT_TARGET_GIVEN_KNOWLEDGE_CUTOFF'
      ||e.contentHash!==digest(Object.fromEntries(Object.entries(e).filter(([k])=>k!=='contentHash'))))fail('BELIEF_RESULT_INVALID');
    const belief=e.belief as {episodeKey:string;status:string;hash:string},summary=e.summary;
    if(!belief||belief.episodeKey!==request.temporalInput.episodeKey||!['SUPPORTED','CONFLICTED'].includes(belief.status)||!summary)fail('BELIEF_RESULT_INVALID');
    return r;
  }
  private async belief(ctx:RequestContext,r:OntologyObject){
    if(!r.payload||beliefHash(r)!==r.contentHash)fail('BELIEF_INTEGRITY');const p=r.payload as Payload,s=p.readSet;
    if(r.beliefKey!==digest([ctx.tenantId,p.command.authorizationId,p.command.snapshotId])||p.command.authorizationId!==s.authorization.id||p.command.snapshotId!==s.snapshot.id
      ||s.headKey!==digest([ctx.tenantId,s.deploymentId,s.episode.id])||r.engineVersion!==p.result.engineId||r.engineVersion!==s.engineId||digest(r.distribution)!==digest(p.result.estimate.belief)||digest(r.explanation)!==digest(p.result.estimate.summary))fail('BELIEF_INTEGRITY');
    for(const [type,id]of [['PlusBeliefInput',s.snapshot.id],['PlusBeliefRelease',s.release.id],['PlusBeliefAuthorization',s.authorization.id],['PlusBeliefSelection',s.selection.id],['PlusBeliefPrevious',p.previous?.id??null]] as Array<[string,string|null]>)await this.link(ctx,r._id,type,id);
    if(s.composition&&s.learnedComposition||Boolean(s.composition||s.learnedComposition)!==Boolean(p.result.composition))fail('BELIEF_INTEGRITY');
    if(s.composition)await this.link(ctx,r._id,'PlusBeliefRuleSpecification',s.composition.specification.id);
    if(s.learnedComposition)await this.link(ctx,r._id,'PlusBeliefRuleSpecification',s.learnedComposition.rule.specification.id);
    return p;
  }
  private async head(ctx:RequestContext,h:OntologyObject){
    if(headHash(h)!==h.contentHash||h.headKey!==digest([ctx.tenantId,h.deploymentId,h.episodeId]))fail('BELIEF_HEAD_INTEGRITY');
    const current=h.current as Ref,b=await this.row(ctx,BELIEF,current.id),p=await this.belief(ctx,b);
    if(b.contentHash!==current.hash||p.readSet.headKey!==h.headKey||p.readSet.controlKey!==h.controlKey||p.readSet.generation!==h.generation||p.readSet.streamRevision!==h.streamRevision)fail('BELIEF_HEAD_INTEGRITY');
    await this.link(ctx,h._id,'PlusBeliefHeadCurrent',b._id);await this.link(ctx,h._id,'PlusBeliefHeadDeployment',String(h.deploymentId));await this.link(ctx,h._id,'PlusBeliefHeadEpisode',String(h.episodeId));
    return b;
  }
  private async fence(input:BeliefReplayInput,p:PlusPrincipal,permission:'belief:replay'|'belief:read',readSet:ReadSet,authority:string){
    const material=await this.material(input,p,permission);if(digest(material.readSet)!==digest(readSet))fail('BELIEF_STALE');
    await this.access(p,permission,readSet.controlKey,readSet.episode.id);if(await this.authority(p)!==authority)fail('BELIEF_AUTHORITY_STALE');
    return material;
  }
  private async prepareCommand(input:BeliefReplayInput,p:PlusPrincipal,currentPosition=false){
    this.input(input);const command=structuredClone(input),ctx=this.context(p),epoch=await this.epoch(ctx),authority=await this.authority(p),m=await this.material(command,p,'belief:replay');
    // Resolve CAS within the same authorized preparation, not by traversing the
    // complete model/training graph once with a throwaway expectedVersion=0.
    // Both full material passes and the encompassing authority/epoch fence stay.
    if(currentPosition)command.expectedVersion=(await this.replayPosition(m.readSet.controlKey,m.readSet.episode.id,p)).expectedVersion;
    await this.fence(command,p,'belief:replay',m.readSet,authority);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    const prepared:PreparedBeliefReplay={key:m.readSet.controlKey,episodeId:m.readSet.episode.id,preparedHash:digest({command,readSet:m.readSet})};
    return {command,prepared};
  }
  async prepareReplay(input:BeliefReplayInput,p:PlusPrincipal):Promise<PreparedBeliefReplay>{
    return (await this.prepareCommand(input,p)).prepared;
  }
  /** Native automatic enqueue only. No HTTP-supplied prepared material or CAS. */
  async prepareCurrentReplay(authorizationId:string,snapshotId:string,p:PlusPrincipal){
    return this.prepareCommand({authorizationId,snapshotId,expectedVersion:0},p,true);
  }
  /** Only concurrency/time parameters, never a stale belief distribution. */
  async replayPosition(key:string,episodeId:string,p:PlusPrincipal){
    const ctx=this.context(p);await this.access(p,'belief:replay',key,episodeId);const epoch=await this.epoch(ctx),authority=await this.authority(p);
    const rows=await this.config.storage.queryObjects(ctx,HEAD,{and:[{field:'controlKey',operator:'eq',value:key},{field:'episodeId',operator:'eq',value:episodeId}]},{limit:2});
    if(rows.hasNextPage||rows.totalCount>1)fail('BELIEF_HEAD_INTEGRITY');const h=rows.items[0],b=h?await this.head(ctx,h):undefined;
    const targetTime=b?String((b.payload as Payload).result.estimate.targetTime):null;
    await this.access(p,'belief:replay',key,episodeId);if(await this.authority(p)!==authority||await this.epoch(ctx)!==epoch)fail('BELIEF_STALE');
    return {expectedVersion:h? h._version:0,targetTime};
  }
  private input(input:BeliefReplayInput){
    if(!input||Object.keys(input).sort().join(',')!=='authorizationId,expectedVersion,snapshotId'||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0)fail('BELIEF_INVALID_INPUT');
    text(input.authorizationId);text(input.snapshotId);
  }
  async replay(input:BeliefReplayInput,p:PlusPrincipal,execution?:BeliefExecutionGuard){
    this.input(input);
    const v=structuredClone(input);text(v.authorizationId);text(v.snapshotId);const ctx=this.context(p),epoch=await this.epoch(ctx),authority=await this.authority(p),m=await this.material(v,p,'belief:replay'),s=m.readSet;
    if(execution){if(execution.preparedHash!==digest({command:v,readSet:s}))fail('BELIEF_JOB_INPUT_STALE');await execution.assertCurrent();}
    const h=await this.one(ctx,HEAD,'headKey',s.headKey),previous=h?await this.head(ctx,h):undefined,beliefKey=digest([ctx.tenantId,v.authorizationId,v.snapshotId]);
    const prior=await this.one(ctx,BELIEF,'beliefKey',beliefKey);
    if(prior){const payload=await this.belief(ctx,prior);if(!h||digest(payload.command)!==digest(v)||digest(payload.readSet)!==digest(s)||(h.current as Ref).id!==prior._id
      ||prior._version!==(h.current as Ref).version||!['READY','INSUFFICIENT_DATA','CONFLICTED'].includes(String(prior.readiness)))fail('BELIEF_REQUEST_CONFLICT');
      await this.fence(v,p,'belief:replay',s,authority);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');const result=summary(prior,h,true);
      if(execution){const tx=await this.config.storage.beginTransaction(ctx);try{
        if(!tx.assertReadRevision)fail('BELIEF_READ_GUARD_REQUIRED');await tx.assertReadRevision!(epoch);
        await execution.assertCurrent();await execution.stage(tx,result);await execution.assertCurrent();
        await this.access(p,'belief:replay',s.controlKey,s.episode.id);if(await this.authority(p)!==authority)fail('BELIEF_AUTHORITY_STALE');
        await execution.assertCurrent();
        await tx.commit();
      }catch(e){await tx.rollback();throw e;}}
      return result;}
    if((h? h._version:0)!==v.expectedVersion)fail('BELIEF_VERSION_CONFLICT');
    if(previous){const old=(previous.payload as Payload).result.estimate;
      if(s.generation<Number(h!.generation)||s.streamRevision<Number(h!.streamRevision))fail('BELIEF_NON_MONOTONIC_SELECTION');
      if(m.request.temporalInput.targetTime<String(old.targetTime)||m.request.temporalInput.visibleAt<String(old.visibleAt))fail('BELIEF_NON_MONOTONIC_TARGET');
    }
    const result=m.learnedComposition?await this.config.learnedComposition!.run(m.request,m.learnedComposition)
      :m.composition?await this.config.composition!.run(m.request,m.composition):this.result(await this.config.engine.run(structuredClone(m.request)),m.request),estimate=result.estimate;
    const ruleReady=!result.composition||((result.composition.rules as {results:Array<{outputs:Record<string,{kind:string}>}>}).results.every(r=>Object.values(r.outputs).every(v=>v.kind==='VALUE')));
    const readiness=(estimate.belief as {status:string}).status==='CONFLICTED'?'CONFLICTED':ruleReady&&m.request.temporalInput.events.some(e=>e.event.value.kind==='VALUE')?'READY':'INSUFFICIENT_DATA';
    const createdAt=this.now();if(createdAt<String(m.request.temporalInput.visibleAt))fail('BELIEF_CLOCK_ORDER');
    const payload:Payload={command:v,readSet:s,result,previous:previous?ref(previous):null,createdBy:p.id,createdAt};
    const fields={beliefKey,classification:m.request.temporalInput.classification,distribution:estimate.belief,explanation:estimate.summary,engineVersion:result.engineId,payload};
    await this.fence(v,p,'belief:replay',s,authority);
    const tx=await this.config.storage.beginTransaction(ctx);try{
      if(!tx.assertReadRevision)fail('BELIEF_READ_GUARD_REQUIRED');await tx.assertReadRevision!(epoch);
      const b=await tx.createObject(BELIEF,{...fields,contentHash:beliefHash(fields),readiness});
      for(const [type,id]of [['PlusBeliefInput',s.snapshot.id],['PlusBeliefRelease',s.release.id],['PlusBeliefAuthorization',s.authorization.id],['PlusBeliefSelection',s.selection.id]] as Array<[string,string]>)await tx.createLink(type,b._id,id);
      if(s.composition)await tx.createLink('PlusBeliefRuleSpecification',b._id,s.composition.specification.id);
      if(s.learnedComposition)await tx.createLink('PlusBeliefRuleSpecification',b._id,s.learnedComposition.rule.specification.id);
      if(previous)await tx.createLink('PlusBeliefPrevious',b._id,previous._id);
      const headFields={headKey:s.headKey,controlKey:s.controlKey,deploymentId:s.deploymentId,episodeId:s.episode.id,generation:s.generation,streamRevision:s.streamRevision,current:ref(b)};
      const updated=h?await tx.updateObject(HEAD,h._id,{generation:s.generation,streamRevision:s.streamRevision,current:ref(b),contentHash:headHash(headFields),readiness},h._version)
        :await tx.createObject(HEAD,{...headFields,contentHash:headHash(headFields),readiness});
      if(h){const old=await this.link(ctx,h._id,'PlusBeliefHeadCurrent',previous!._id);await tx.deleteLink('PlusBeliefHeadCurrent',old!._id);}
      else{await tx.createLink('PlusBeliefHeadDeployment',updated._id,s.deploymentId);await tx.createLink('PlusBeliefHeadEpisode',updated._id,s.episode.id);}
      await tx.createLink('PlusBeliefHeadCurrent',updated._id,b._id);
      await this.access(p,'belief:replay',s.controlKey,s.episode.id);if(await this.authority(p)!==authority)fail('BELIEF_AUTHORITY_STALE');
      await this.journal(tx,ctx,p,b,updated,!h);
      if(execution){await execution.assertCurrent();await execution.stage(tx,summary(b,updated));await execution.assertCurrent();}
      await this.access(p,'belief:replay',s.controlKey,s.episode.id);if(await this.authority(p)!==authority)fail('BELIEF_AUTHORITY_STALE');
      await execution?.assertCurrent();
      await tx.commit();return summary(b,updated);
    }catch(e){await tx.rollback();throw e;}
  }
  /** Internal short discovery only: validates native head/links, never model or
   * source admission. Cannot replace readCurrent in planning or execution. */
  async readHeadMetadata(key:string,episodeId:string,principal:PlusPrincipal){
    const p=structuredClone(principal),ctx=this.context(p);text(key);text(episodeId);
    await this.access(p,'belief:read',key,episodeId);const epoch=await this.epoch(ctx),authority=await this.authority(p);
    const rows=await this.config.storage.queryObjects(ctx,HEAD,{and:[{field:'controlKey',operator:'eq',value:key},{field:'episodeId',operator:'eq',value:episodeId}]},{limit:2});
    if(rows.hasNextPage||rows.totalCount>1||rows.totalCount!==rows.items.length)fail('BELIEF_HEAD_INTEGRITY');
    const h=rows.items[0];let item=null;
    if(h){const b=await this.head(ctx,h),payload=b.payload as Payload,s=payload.readSet;
      if(b._version!==(h.current as Ref).version||b.readiness!==h.readiness||s.episode.id!==episodeId||s.controlKey!==key)fail('BELIEF_HEAD_INTEGRITY');
      item={head:ref(h),belief:ref(b),snapshot:structuredClone(s.snapshot),release:structuredClone(s.release),selection:structuredClone(s.selection),
        classification:String(b.classification),recordedReadiness:String(h.readiness),targetTime:payload.result.estimate.targetTime,visibleAt:payload.result.estimate.visibleAt};
    }
    await this.access(p,'belief:read',key,episodeId);if(await this.authority(p)!==authority)fail('BELIEF_AUTHORITY_STALE');if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    return {schema:'plus-belief-head-metadata-v1' as const,item,readOnly:true,qualification:'NOT_CHECKED' as const,predictionReady:false,currentBasisChecked:false};
  }
  async readCurrent(key:string,episodeId:string,p:PlusPrincipal){
    const ctx=this.context(p);await this.access(p,'belief:read',key,episodeId);const epoch=await this.epoch(ctx),authority=await this.authority(p);
    const rows=await this.config.storage.queryObjects(ctx,HEAD,{and:[{field:'controlKey',operator:'eq',value:key},{field:'episodeId',operator:'eq',value:episodeId}]},{limit:2});
    if(rows.hasNextPage||rows.totalCount>1)fail('BELIEF_HEAD_INTEGRITY');const h=rows.items[0];if(!h)fail('BELIEF_NOT_FOUND');
    const b=await this.head(ctx,h),payload=b.payload as Payload;
    if(!['READY','INSUFFICIENT_DATA','CONFLICTED'].includes(String(h.readiness))||b.readiness!==h.readiness||b._version!==(h.current as Ref).version)fail('BELIEF_STALE');
    const material=await this.fence(payload.command,p,'belief:read',payload.readSet,authority);
    if(material.learnedComposition)this.config.learnedComposition!.validate(payload.result,material.request,material.learnedComposition);
    else if(material.composition)this.config.composition!.validate(payload.result,material.request,material.composition);
    if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    return {...summary(b,h),record:structuredClone(b),head:structuredClone(h)};
  }
  private async journal(tx:Transaction,ctx:RequestContext,p:PlusPrincipal,b:OntologyObject,h:OntologyObject,created:boolean){const actionId='act_'+randomUUID();
    await createActionOutboxJournal().stage(tx,{version:'native-action-commit-v1',tenantId:ctx.tenantId,actionId,audit:{id:'audit_'+actionId,tenantId:ctx.tenantId,timestamp:this.now() as DateTime,traceId:ctx.traceId!,
      actor:{id:p.id,type:'user',roles:[...p.roles]},operation:{type:'action',actionType:'PlusReplayCurrentBelief',actionId},detail:{result:'success',after:{belief:summary(b,h)}}},
      affectedObjects:[{type:BELIEF,id:b._id,changeType:'created'},{type:HEAD,id:h._id,changeType:created?'created':'updated'}]});
  }
}
