import { randomUUID } from 'node:crypto';
import { canonicalJson,digest } from '@openfoundry/plus-contracts';
import type { StorageProvider,OntologyObject,RequestContext,Transaction,DateTime } from '@openfoundry/spi';
import type { PlusPrincipal } from './ontology-catalog.js';
import type { NativeRecipeRegistry } from './recipe-registry.js';
import type { NativeDatasetRegistry,CohortProtocol } from './dataset-registry.js';
import { createActionOutboxJournal } from './outbox.js';
import { modelDecisionDeployments } from './model-lineage.js';
import type { NativePublishedModelReference,PublishedModelReference,LearnedCompositionPublishedReference } from './published-model-reference.js';
import { learnedCompositionStateEvaluatorId } from './learned-composition-evaluation-population.js';
import type { NativeModelDeployment,NativeColdStartBinding } from './model-deployment.js';
import { trainingReferences } from './fit-training-context.js';
import { transitionEvaluatorId, validateTransitionEvaluationMembership, type TransitionEvaluationCohort } from './transition-evaluation-membership.js';
import { qualifiedNativeRead,type NativeReadQualificationPhase } from './read-qualification-phase.js';

export type EvaluationProtocolPermission='evaluation:draft'|'evaluation:review'|'evaluation:read'|'evaluation:use'|'evaluation:revoke';
export interface EvaluationPurposePolicy {
  version:'plus-evaluation-purpose-v1';id:string;evaluatorIds:string[];recipeHashes:string[];classifications:string[];
  reference?:{mode:'CURRENT_PUBLICATION'|'COLD_START';controlKey:string};
}
export interface EvaluationProtocolInput {
  key:string;revision:number;recipeHash:string;cohortIds:string[];evaluatorId:string;configuration:Record<string,unknown>;
}
export interface EvaluationProtocolConfig {
  storage:StorageProvider;tenantId:string;
  recipes:Pick<NativeRecipeRegistry,'requireApproved'>;
  datasets:Pick<NativeDatasetRegistry,'readCohort'>;
  publishedReferences?:Pick<NativePublishedModelReference,'capture'|'requireQualified'>;
  learnedCompositionReferences?:Pick<NativePublishedModelReference,'captureLearnedComposition'|'requireLearnedCompositionQualified'>;
  coldStarts?:Pick<NativeModelDeployment,'captureColdStart'|'requireColdStart'>;
  authorize:(p:PlusPrincipal,permission:EvaluationProtocolPermission,key:string)=>Promise<boolean>;
  policyFor:(p:PlusPrincipal,key:string)=>Promise<EvaluationPurposePolicy>;
  /** Fixed server evaluator registry validates semantics without seeing validation labels. */
  validateConfiguration:(input:{evaluatorId:string;configuration:Record<string,unknown>;recipe:Record<string,unknown>;cohorts:CohortProtocol[]})=>Promise<void>;
  clock?:()=>number;
  /** Required by metadata discovery, not a saved qualification token. */
  authorizationRevision?:(p:PlusPrincipal)=>Promise<string>;
  /** Trusted same-graph read scopes only. No phase may span journal/commit. */
  readQualificationPhase?:NativeReadQualificationPhase;
}
export type EvaluationProtocolPayload={recipe:{id:string;version:number;hash:string;definitionHash:unknown;classification:string};
  cohorts:Array<{id:string;version:number;contentHash:unknown;protocol:CohortProtocol}>;configuration:Record<string,unknown>;policyHash:string;reference?:PublishedModelReference;
  learnedCompositionReference?:LearnedCompositionPublishedReference;coldStart?:NativeColdStartBinding;transitionMembership?:ReturnType<typeof validateTransitionEvaluationMembership>};
type Payload=EvaluationProtocolPayload;
const TYPE='PlusEvaluationProtocol';
function fail(code:string):never{throw Object.assign(new Error(code),{code});}
function text(v:unknown):string{if(typeof v!=='string'||!v.trim()||v.length>2000)fail('EVALUATION_INVALID_INPUT');return v;}
const fingerprint=(r:Record<string,unknown>)=>digest(Object.fromEntries(['revisionKey','protocolKey','revision','evaluatorId','payload','proposedBy','proposedAt'].map(k=>[k,r[k]])));
const summary=(r:OntologyObject)=>({id:r._id,version:r._version,key:r.protocolKey,revision:r.revision,status:r.status,readiness:r.readiness,contentHash:r.contentHash,modelDeploymentAuthorized:false});
type ProtocolReference=PublishedModelReference|LearnedCompositionPublishedReference;
function referenceOf(payload:Payload){
  if([payload.reference,payload.learnedCompositionReference,payload.coldStart].filter(Boolean).length>1)fail('EVALUATION_REFERENCE_CONTRACT_MISMATCH');
  return payload.reference??payload.learnedCompositionReference;
}
function referenceLinks(r:ProtocolReference):Array<[string,string[]]>{return [
  ['PlusEvaluationReferenceDeployment',[r.deploymentId]],['PlusEvaluationReferenceSelection',[r.selection.id]],['PlusEvaluationReferenceDecision',[r.decision.id]],
  ['PlusEvaluationReferenceRelease',[r.release.id]],['PlusEvaluationReferenceDefinition',[r.definition.id]],['PlusEvaluationReferenceRecipe',[r.recipe.id]],
  ['PlusEvaluationReferenceExecution',[r.execution.id]],['PlusEvaluationReferenceTraining',(r.schema==='plus-learned-composition-published-reference-v1'?r.completeTrainingDatasets:trainingReferences(r)).map(v=>v.id)],
];}

/** Native prospective evaluation approval. Does not score, publish or activate a model. */
export class NativeEvaluationProtocolRegistry {
  constructor(private readonly config:EvaluationProtocolConfig){}
  private readPhase<T>(p:PlusPrincipal,read:()=>Promise<T>):Promise<T>{return this.config.readQualificationPhase?this.config.readQualificationPhase.run(p,read):read();}
  private now(){const n=(this.config.clock??Date.now)();if(!Number.isFinite(n))fail('EVALUATION_INVALID_CLOCK');return new Date(n).toISOString();}
  private context(p:PlusPrincipal):RequestContext{if(!p?.id||p.tenantId!==this.config.tenantId)fail('EVALUATION_FORBIDDEN');return {tenantId:p.tenantId,actorId:p.id,traceId:randomUUID()};}
  private async access(p:PlusPrincipal,permission:EvaluationProtocolPermission,key:string){this.context(p);text(key);if(!await this.config.authorize(p,permission,key))fail('EVALUATION_FORBIDDEN');}
  private async epoch(ctx:RequestContext){if(!this.config.storage.getReadRevision)fail('EVALUATION_READ_GUARD_REQUIRED');return this.config.storage.getReadRevision!(ctx);}
  private async row(ctx:RequestContext,id:string){const r=await this.config.storage.getObject(ctx,TYPE,text(id));if(!r||r._tenantId!==ctx.tenantId||r._deletedAt)fail('EVALUATION_NOT_FOUND');return r;}
  private async revisions(ctx:RequestContext,key:string){const r=await this.config.storage.queryObjects(ctx,TYPE,{field:'protocolKey',operator:'eq',value:key},{limit:1000});if(r.hasNextPage||r.totalCount>1000)fail('EVALUATION_COLLECTION_LIMIT');return r.items;}
  private async links(ctx:RequestContext,id:string,type:string,expected:string[]){const r=await this.config.storage.getLinks(ctx,id,type,'outbound',{limit:1000});
    if(r.hasNextPage||r.totalCount!==expected.length||r.items.length!==expected.length||new Set(r.items.map(l=>l._toId)).size!==expected.length||r.items.some(l=>!expected.includes(l._toId)))fail('EVALUATION_LINK_INVALID');}
  private input(v:EvaluationProtocolInput){
    if(!v||Object.keys(v).sort().join(',')!=='cohortIds,configuration,evaluatorId,key,recipeHash,revision'||!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(text(v.key))
      ||!Number.isSafeInteger(v.revision)||v.revision<1||!/^[a-f0-9]{64}$/.test(v.recipeHash)||!Array.isArray(v.cohortIds)||v.cohortIds.length<1||v.cohortIds.length>10||new Set(v.cohortIds).size!==v.cohortIds.length
      ||!v.configuration||typeof v.configuration!=='object'||Array.isArray(v.configuration)||canonicalJson(v.configuration).length>65536)fail('EVALUATION_INVALID_INPUT');
    v.cohortIds.forEach(text);text(v.evaluatorId);return structuredClone({...v,cohortIds:[...v.cohortIds].sort()});
  }
  private async policy(p:PlusPrincipal,key:string){
    const v=structuredClone(await this.config.policyFor(p,key));
    if(!v||v.version!=='plus-evaluation-purpose-v1'||Object.keys(v).sort().join(',')!==(Object.hasOwn(v,'reference')?'classifications,evaluatorIds,id,recipeHashes,reference,version':'classifications,evaluatorIds,id,recipeHashes,version'))fail('EVALUATION_POLICY_INVALID');text(v.id);
    if(Object.hasOwn(v,'reference')){const r=v.reference;if(!r||Object.keys(r).sort().join(',')!=='controlKey,mode'||!['CURRENT_PUBLICATION','COLD_START'].includes(r.mode))fail('EVALUATION_POLICY_INVALID');text(r.controlKey);}
    for(const field of ['evaluatorIds','recipeHashes','classifications'] as const){const a=v[field];if(!Array.isArray(a)||!a.length||a.length>100||new Set(a).size!==a.length)fail('EVALUATION_POLICY_INVALID');a.forEach(text);}
    if(v.recipeHashes.some(h=>!/^[a-f0-9]{64}$/.test(h))||v.classifications.some(c=>!['SYNTHETIC','AUTHORIZED_REAL'].includes(c)))fail('EVALUATION_POLICY_INVALID');return v;
  }
  private async finalAccess(p:PlusPrincipal,permission:EvaluationProtocolPermission,key:string,payload?:Payload){
    await this.access(p,permission,key);if(payload&&digest(await this.policy(p,key))!==payload.policyHash)fail('EVALUATION_POLICY_STALE');
  }
  private async material(v:EvaluationProtocolInput,p:PlusPrincipal,expected?:ProtocolReference,requireCurrent=true,cold?:{binding:NativeColdStartBinding;protocol?:{id:string;version:number;hash:string}}):Promise<Payload>{
    const actor=structuredClone(p),request=structuredClone(v),reference=structuredClone(expected),binding=structuredClone(cold);
    return this.readPhase(actor,()=>this.materialQualified(request,actor,reference,requireCurrent,binding));
  }
  private async materialQualified(v:EvaluationProtocolInput,p:PlusPrincipal,expected?:ProtocolReference,requireCurrent=true,cold?:{binding:NativeColdStartBinding;protocol?:{id:string;version:number;hash:string}}):Promise<Payload>{
    const policy=await this.policy(p,v.key);
    if(!policy.evaluatorIds.includes(v.evaluatorId)||!policy.recipeHashes.includes(v.recipeHash))fail('EVALUATION_PURPOSE_FORBIDDEN');
    const recipe=await this.config.recipes.requireApproved(v.recipeHash,p,'recipe:read');
    const classification=String((recipe.payload.config as {classification?:string})?.classification);
    if(!policy.classifications.includes(classification))fail('EVALUATION_PURPOSE_FORBIDDEN');
    const longitudinal=v.evaluatorId===transitionEvaluatorId;
    const cohorts:Payload['cohorts']=[],samples=new Set<string>(),entities=new Set<string>(),trajectoryCohorts:TransitionEvaluationCohort[]=[];
    for(const id of v.cohortIds){
      const {record:r}=await this.config.datasets.readCohort(id,p),body=r.payload as {protocol:CohortProtocol;members:Array<{sampleKey:string;entityKey:string}>};
      if(r.status!=='APPROVED'||r.readiness!=='READY'||body.protocol.partition!=='VALIDATION'||body.protocol.definitionHash!==recipe.record.definitionHash||body.protocol.classification!==classification)fail('EVALUATION_COHORT_INVALID');
      for(const member of body.members){if(samples.has(member.sampleKey)||!longitudinal&&entities.has(member.entityKey))fail('EVALUATION_COHORT_OVERLAP');samples.add(member.sampleKey);entities.add(member.entityKey);}
      if(longitudinal)trajectoryCohorts.push({id:r._id,protocol:body.protocol,members:body.members as TransitionEvaluationCohort['members']});
      cohorts.push({id:r._id,version:r._version,contentHash:r.contentHash,protocol:structuredClone(body.protocol)});
    }
    await this.config.validateConfiguration({evaluatorId:v.evaluatorId,configuration:structuredClone(v.configuration),recipe:structuredClone(recipe.payload),cohorts:cohorts.map(c=>structuredClone(c.protocol))});
    // Even a permissive embedding validator cannot relax duplicate-entity checks
    // without the fixed transition contract and complete native trajectory gate.
    const transitionMembership=longitudinal?validateTransitionEvaluationMembership(recipe.payload,v.configuration,trajectoryCohorts):undefined;
    let reference:ProtocolReference|undefined,coldStart:NativeColdStartBinding|undefined;
    if(policy.reference?.mode==='COLD_START'){
      if(v.evaluatorId!==learnedCompositionStateEvaluatorId||expected)fail('EVALUATION_COLD_START_ENGINE_REQUIRED');
      const provider=this.config.coldStarts;if(!provider)fail('EVALUATION_COLD_START_PROVIDER_REQUIRED');
      const loaded=cold?await provider.requireColdStart(cold.binding,cold.protocol,p):await provider.captureColdStart(policy.reference.controlKey,p);
      coldStart=loaded.binding;
      const config=recipe.payload.config as {bindingHash:string},compiled=recipe.payload.compiled as {definition:{scope:{key:string}}};
      if(loaded.coldStartQualified!==true||coldStart.controlKey!==policy.reference.controlKey||coldStart.target.definitionHash!==recipe.record.definitionHash
        ||coldStart.target.bindingHash!==config.bindingHash||coldStart.target.scopeKey!==compiled.definition.scope.key||coldStart.target.classification!==classification
        ||v.configuration.task!=='STATE_ESTIMATION'||coldStart.target.task!=='STATE_ESTIMATION'||coldStart.target.clockHash!==digest(v.configuration.clock))fail('EVALUATION_COLD_START_CONTRACT');
    }else if(cold)fail('EVALUATION_REFERENCE_POLICY_CHANGED');
    if(policy.reference?.mode==='CURRENT_PUBLICATION'){
      const schema=await this.config.storage.getSchema(this.context(p));
      for(const [suffix,toType]of [['Deployment','PlusDeployment'],['Selection','PlusDeploymentRevision'],['Decision','PlusModelDecision'],['Release','PlusModelRelease'],
        ['Definition','PlusDefinitionRevision'],['Recipe','PlusModelRecipe'],['Execution','PlusExecution'],['Training','PlusDatasetRevision']]){
        const link=schema.linkTypes.find(l=>l.name==='PlusEvaluationReference'+suffix);
        if(!link||link.fromType!==TYPE||link.toType!==toType||link.cardinality!==(suffix==='Training'?'MANY_TO_MANY':'MANY_TO_ONE'))fail('EVALUATION_REFERENCE_SCHEMA_NOT_CONFIGURED');
      }
      if(v.evaluatorId===learnedCompositionStateEvaluatorId){
        const provider=this.config.learnedCompositionReferences;if(!provider)fail('EVALUATION_COMPLETE_REFERENCE_PROVIDER_REQUIRED');
        if(expected&&expected.schema!=='plus-learned-composition-published-reference-v1')fail('EVALUATION_REFERENCE_CONTRACT_MISMATCH');
        reference=(expected&&!requireCurrent?await provider.requireLearnedCompositionQualified(expected,p):await provider.captureLearnedComposition(policy.reference.controlKey,p)).reference;
        if(reference.schema!=='plus-learned-composition-published-reference-v1')fail('EVALUATION_REFERENCE_CONTRACT_MISMATCH');
      }else{
        const provider=this.config.publishedReferences;if(!provider)fail('EVALUATION_REFERENCE_PROVIDER_REQUIRED');
        if(expected&&expected.schema!=='plus-published-model-reference-v1')fail('EVALUATION_REFERENCE_CONTRACT_MISMATCH');
        reference=(expected&&!requireCurrent?await provider.requireQualified(expected,p):await provider.capture(policy.reference.controlKey,p)).reference;
        if(reference.schema!=='plus-published-model-reference-v1')fail('EVALUATION_REFERENCE_CONTRACT_MISMATCH');
      }
      const config=recipe.payload.config as {bindingHash:string},compiled=recipe.payload.compiled as {definition:{scope:{key:string}}};
      if(reference.controlKey!==policy.reference.controlKey||reference.target.definitionHash!==recipe.record.definitionHash||reference.target.bindingHash!==config.bindingHash
        ||reference.target.scopeKey!==compiled.definition.scope.key||reference.target.classification!==classification||v.configuration.task!=='STATE_ESTIMATION'
        ||reference.target.task!=='STATE_ESTIMATION'||reference.target.clockHash!==digest(v.configuration.clock))fail('EVALUATION_REFERENCE_CONTRACT_MISMATCH');
      if(expected&&digest(expected)!==digest(reference))fail('EVALUATION_REFERENCE_SELECTION_CHANGED');
      const selected=await this.config.storage.getObject(this.context(p),'PlusDeploymentRevision',reference.selection.id);
      if(!selected||selected._tenantId!==this.config.tenantId||selected._deletedAt||!Number.isFinite(Date.parse(String(selected.createdAt)))
        ||String(selected.createdAt)>this.now())fail('EVALUATION_REFERENCE_CLOCK_ORDER');
    }else if(expected)fail('EVALUATION_REFERENCE_POLICY_CHANGED');
    if(digest(await this.policy(p,v.key))!==digest(policy))fail('EVALUATION_POLICY_STALE');
    return {recipe:{id:recipe.record._id,version:recipe.record._version,hash:v.recipeHash,definitionHash:recipe.record.definitionHash,classification},cohorts,configuration:structuredClone(v.configuration),policyHash:digest(policy),
      ...(reference?.schema==='plus-learned-composition-published-reference-v1'?{learnedCompositionReference:structuredClone(reference)}:reference?{reference:structuredClone(reference)}:{}),
      ...(coldStart?{coldStart:structuredClone(coldStart)}:{}),...(transitionMembership?{transitionMembership}:{})};
  }
  private beforeLabels(payload:Payload){if(payload.cohorts.some(c=>this.now()>=c.protocol.labelReceivedFrom))fail('EVALUATION_REGISTRATION_CLOSED');}
  private async integrity(ctx:RequestContext,row:OntologyObject){
    if(fingerprint(row)!==row.contentHash||!['DRAFT','APPROVED','REJECTED','REVOKED'].includes(String(row.status)))fail('EVALUATION_INTEGRITY');
    const payload=row.payload as Payload;
    await this.links(ctx,row._id,'PlusEvaluationProtocolRecipe',[payload.recipe.id]);await this.links(ctx,row._id,'PlusEvaluationProtocolCohort',payload.cohorts.map(c=>c.id));
    const reference=referenceOf(payload);
    if((payload.learnedCompositionReference||payload.coldStart)&&row.evaluatorId!==learnedCompositionStateEvaluatorId||payload.reference&&row.evaluatorId===learnedCompositionStateEvaluatorId)fail('EVALUATION_REFERENCE_CONTRACT_MISMATCH');
    if(reference)for(const [type,ids]of referenceLinks(reference))await this.links(ctx,row._id,type,ids);
    if(row.status==='DRAFT'){if(row.decision!=null||row.decisionHash!=null||row.revocation!=null||row.revocationHash!=null)fail('EVALUATION_INTEGRITY');return;}
    const d=row.decision as {actorId:string;at:string;decision:string;reason:string;fromVersion:number};
    if(!d||d.actorId===row.proposedBy||!['APPROVE','REJECT'].includes(d.decision)||row.decisionHash!==digest({contentHash:row.contentHash,decision:d})||!Number.isFinite(Date.parse(d.at))||d.at<String(row.proposedAt)
      ||!Number.isSafeInteger(d.fromVersion)||d.fromVersion<1||d.decision==='APPROVE'&&payload.cohorts.some(c=>d.at>=c.protocol.labelReceivedFrom))fail('EVALUATION_INTEGRITY');
    if(row.status!=='REVOKED'){if(row.status!==(d.decision==='APPROVE'?'APPROVED':'REJECTED')||row.revocation!=null||row.revocationHash!=null)fail('EVALUATION_INTEGRITY');}
    else{const r=row.revocation as {actorId:string;at:string;reason:string;fromVersion:number};if(d.decision!=='APPROVE'||!r||!Number.isFinite(Date.parse(r.at))||r.at<d.at||row.revocationHash!==digest({contentHash:row.contentHash,decisionHash:row.decisionHash,revocation:r}))fail('EVALUATION_INTEGRITY');}
  }
  private async current(row:OntologyObject,p:PlusPrincipal){
    if(['STALE','SUSPENDED'].includes(String(row.readiness)))fail('EVALUATION_STALE');
    const payload=row.payload as Payload,v={key:String(row.protocolKey),revision:Number(row.revision),recipeHash:payload.recipe.hash,cohortIds:payload.cohorts.map(c=>c.id),evaluatorId:String(row.evaluatorId),configuration:payload.configuration};
    const cold=payload.coldStart?{binding:payload.coldStart,...(row.status==='APPROVED'?{protocol:{id:row._id,version:row._version,hash:String(row.contentHash)}}:{})}:undefined;
    if(digest(await this.material(this.input(v),p,referenceOf(payload),row.status==='DRAFT',cold))!==digest(payload))fail('EVALUATION_STALE');return payload;
  }
  private async begin(ctx:RequestContext,epoch:string){const tx=await this.config.storage.beginTransaction(ctx);try{if(!tx.assertReadRevision)fail('EVALUATION_READ_GUARD_REQUIRED');await tx.assertReadRevision!(epoch);return tx;}catch(e){await tx.rollback();throw e;}}
  private async journal(tx:Transaction,ctx:RequestContext,p:PlusPrincipal,name:string,row:OntologyObject,dependents:OntologyObject[]=[]){const actionId='act_'+randomUUID();
    await createActionOutboxJournal().stage(tx,{version:'native-action-commit-v1',tenantId:ctx.tenantId,actionId,audit:{id:'audit_'+actionId,tenantId:ctx.tenantId,timestamp:this.now() as DateTime,traceId:ctx.traceId!,
      actor:{id:p.id,type:'user',roles:[...p.roles]},operation:{type:'action',actionType:name,actionId},detail:{result:'success',after:{record:summary(row),invalidated:dependents.map(r=>({type:r._type,id:r._id,version:r._version}))}}},affectedObjects:[row,...dependents].map(r=>({type:r._type,id:r._id,changeType:r._version===1?'created':'updated'}))});}
  async propose(input:EvaluationProtocolInput,p:PlusPrincipal){
    p=structuredClone(p);
    const v=this.input(input),ctx=this.context(p);await this.access(p,'evaluation:draft',v.key);if(!p.roles.includes('trainer'))fail('EVALUATION_FORBIDDEN');
    const epoch=await this.epoch(ctx),rows=await this.revisions(ctx,v.key),prior=rows.find(r=>r.revision===v.revision);
    if(prior)await this.integrity(ctx,prior);
    const oldPayload=prior?.payload as Payload|undefined;
    const cold=oldPayload?.coldStart?{binding:oldPayload.coldStart,...(prior!.status==='APPROVED'?{protocol:{id:prior!._id,version:prior!._version,hash:String(prior!.contentHash)}}:{})}:undefined;
    const payload=await this.material(v,p,prior?referenceOf(prior.payload as Payload):undefined,!prior||prior.status==='DRAFT',cold);this.beforeLabels(payload);
    if(prior){await this.integrity(ctx,prior);if(prior.proposedBy!==p.id||prior.evaluatorId!==v.evaluatorId||digest(prior.payload)!==digest(payload))fail('EVALUATION_REVISION_CONFLICT');await this.finalAccess(p,'evaluation:draft',v.key,payload);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');return summary(prior);}
    if(v.revision!==Math.max(0,...rows.map(r=>Number(r.revision)))+1)fail('EVALUATION_REVISION_CONFLICT');
    const fields={revisionKey:digest([ctx.tenantId,v.key,v.revision]),protocolKey:v.key,revision:v.revision,evaluatorId:v.evaluatorId,payload,proposedBy:p.id,proposedAt:this.now()};
    const tx=await this.begin(ctx,epoch);try{
      const row=await tx.createObject(TYPE,{...fields,contentHash:fingerprint(fields),status:'DRAFT',readiness:'INSUFFICIENT_DATA'});
      await tx.createLink('PlusEvaluationProtocolRecipe',row._id,payload.recipe.id);for(const c of payload.cohorts)await tx.createLink('PlusEvaluationProtocolCohort',row._id,c.id);
      const reference=referenceOf(payload);if(reference)for(const [type,ids]of referenceLinks(reference))for(const id of ids)await tx.createLink(type,row._id,id);
      await this.readPhase(p,async()=>{await this.current(row,p);this.beforeLabels(payload);await this.finalAccess(p,'evaluation:draft',v.key,payload);});
      await this.journal(tx,ctx,p,'PlusProposeEvaluationProtocol',row);this.beforeLabels(payload);await tx.commit();return summary(row);
    }catch(e){await tx.rollback();throw e;}
  }
  async review(id:string,version:number,decision:'APPROVE'|'REJECT',reason:string,p:PlusPrincipal){
    p=structuredClone(p);
    if(!Number.isSafeInteger(version)||version<1||!['APPROVE','REJECT'].includes(decision))fail('EVALUATION_INVALID_INPUT');text(reason);
    const ctx=this.context(p),epoch=await this.epoch(ctx),row=await this.row(ctx,id);await this.access(p,'evaluation:review',String(row.protocolKey));
    if(!p.roles.includes('model_owner')||p.id===row.proposedBy)fail('EVALUATION_INDEPENDENT_REVIEW_REQUIRED');await this.integrity(ctx,row);
    const status=decision==='APPROVE'?'APPROVED':'REJECTED',prior=row.decision as {actorId:string;reason:string;fromVersion:number}|undefined;
    if(row.status===status&&prior?.actorId===p.id&&prior.reason===reason&&prior.fromVersion===version){if(decision==='APPROVE')await this.current(row,p);await this.finalAccess(p,'evaluation:review',String(row.protocolKey),decision==='APPROVE'?row.payload as Payload:undefined);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');return summary(row);}
    if(row.status!=='DRAFT'||row._version!==version)fail('EVALUATION_STATE_CONFLICT');
    if(decision==='APPROVE')this.beforeLabels(await this.current(row,p));
    const d={actorId:p.id,decision,reason,fromVersion:version,at:this.now()};if(d.at<String(row.proposedAt))fail('EVALUATION_CLOCK_ORDER');
    const tx=await this.begin(ctx,epoch);try{
      const updated=await tx.updateObject(TYPE,id,{status,readiness:decision==='APPROVE'?'READY':row.readiness,decision:d,decisionHash:digest({contentHash:row.contentHash,decision:d})},version);
      await this.readPhase(p,async()=>{if(decision==='APPROVE')this.beforeLabels(await this.current(row,p));await this.finalAccess(p,'evaluation:review',String(row.protocolKey),decision==='APPROVE'?row.payload as Payload:undefined);});
      await this.journal(tx,ctx,p,'PlusReviewEvaluationProtocol',updated);if(decision==='APPROVE')this.beforeLabels(row.payload as Payload);await tx.commit();return summary(updated);
    }catch(e){await tx.rollback();throw e;}
  }
  async read(id:string,p:PlusPrincipal,permission:'evaluation:read'|'evaluation:use'='evaluation:read'){
    const actor=structuredClone(p);return this.readPhase(actor,()=>qualifiedNativeRead(this,this.config.storage,
      'evaluation:protocol-read',{id,permission},actor,()=>this.readQualified(id,actor,permission)));
  }
  private async readQualified(id:string,p:PlusPrincipal,permission:'evaluation:read'|'evaluation:use'){
    if(!['evaluation:read','evaluation:use'].includes(permission))fail('EVALUATION_FORBIDDEN');
    const ctx=this.context(p),epoch=await this.epoch(ctx),row=await this.row(ctx,id);await this.access(p,permission,String(row.protocolKey));await this.integrity(ctx,row);await this.current(row,p);
    if(permission==='evaluation:use'&&(row.status!=='APPROVED'||row.readiness!=='READY'))fail('EVALUATION_NOT_APPROVED');
    await this.finalAccess(p,permission,String(row.protocolKey),row.payload as Payload);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    return {record:structuredClone(row),evaluationAuthorized:row.status==='APPROVED'&&row.readiness==='READY',modelDeploymentAuthorized:false};
  }
  async requireApproved(id:string,p:PlusPrincipal){return this.read(id,p,'evaluation:use');}
  /** Frozen review evidence; does not resolve a current recipe selection, read
   * labels or qualify protocol use. Current evaluation:read remains mandatory. */
  async readMetadata(id:string,principal:PlusPrincipal){
    const p=structuredClone(principal),ctx=this.context(p),started=this.now();
    const authority=async()=>{if(!this.config.authorizationRevision)fail('EVALUATION_AUTHORITY_GUARD_REQUIRED');
      const value=await this.config.authorizationRevision(p);if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))fail('EVALUATION_AUTHORITY_INVALID');return value;};
    const revision=await authority(),epoch=await this.epoch(ctx),row=await this.row(ctx,id);
    if(row._type!==TYPE||row._id!==id||!Number.isSafeInteger(row._version)||row._version<1)fail('EVALUATION_INTEGRITY');
    await this.access(p,'evaluation:read',String(row.protocolKey));await this.integrity(ctx,row);
    const payload=row.payload as Payload,reference=referenceOf(payload);
    const item={...summary(row),evaluatorId:String(row.evaluatorId),recipe:structuredClone(payload.recipe),configuration:structuredClone(payload.configuration),
      cohorts:payload.cohorts.map(c=>({id:c.id,version:c.version,hash:c.contentHash})),policyHash:payload.policyHash,
      reference:reference?{mode:'CURRENT_PUBLICATION',hash:digest(reference),release:structuredClone(reference.release)}:
        payload.coldStart?{mode:'COLD_START',hash:digest(payload.coldStart),release:null}:null};
    await this.access(p,'evaluation:read',String(row.protocolKey));if(await authority()!==revision)fail('EVALUATION_AUTHORITY_STALE');
    if(await this.epoch(ctx)!==epoch)fail('CONFLICT');if(this.now()<started)fail('EVALUATION_INVALID_CLOCK');
    return {schema:'plus-evaluation-protocol-recorded-v1' as const,item,qualification:'NOT_CHECKED' as const,readOnly:true as const,evaluationAuthorized:false as const};
  }
  /** Bounded metadata for reviewed evaluation choices. No model, source or
   * held-out labels are materialized; recorded approval is NOT current use. */
  async listMetadata(key:string,principal:PlusPrincipal){
    text(key);const p=structuredClone(principal),ctx=this.context(p),started=this.now();
    const authority=async()=>{if(!this.config.authorizationRevision)fail('EVALUATION_AUTHORITY_GUARD_REQUIRED');
      const v=await this.config.authorizationRevision!(p);if(!/^[a-f0-9]{64}$/.test(v))fail('EVALUATION_AUTHORITY_INVALID');return v;};
    const revision=await authority(),epoch=await this.epoch(ctx);await this.access(p,'evaluation:read',key);
    const policy=await this.policy(p,key),page=await this.config.storage.queryObjects(ctx,TYPE,{field:'protocolKey',operator:'eq',value:key},{limit:101});
    if(page.hasNextPage||page.totalCount!==page.items.length||page.items.length>100||new Set(page.items.map(r=>r._id)).size!==page.items.length)fail('EVALUATION_COLLECTION_LIMIT');
    const items=[];
    for(const row of page.items){
      if(row._type!==TYPE||row._tenantId!==p.tenantId||row._deletedAt||row.protocolKey!==key||!Number.isSafeInteger(row._version)||row._version<1)fail('EVALUATION_INTEGRITY');
      await this.integrity(ctx,row);const payload=row.payload as Payload;
      if(!payload?.recipe||!/^[a-f0-9]{64}$/.test(payload.recipe.hash)||!Array.isArray(payload.cohorts)||!payload.cohorts.length||payload.cohorts.length>10
        ||new Set(payload.cohorts.map(c=>c.id)).size!==payload.cohorts.length||payload.cohorts.some(c=>!c.id||!Number.isSafeInteger(c.version)||c.version<1||typeof c.contentHash!=='string'||!/^[a-f0-9]{64}$/.test(c.contentHash)))fail('EVALUATION_INTEGRITY');
      items.push({...summary(row),evaluatorId:String(row.evaluatorId),recipeHash:payload.recipe.hash,
        cohorts:payload.cohorts.map(c=>({id:c.id,version:c.version,hash:String(c.contentHash)})),classification:payload.recipe.classification,
        policyCompatible:payload.policyHash===digest(policy),qualification:'NOT_CHECKED' as const});
    }
    await this.access(p,'evaluation:read',key);if(digest(await this.policy(p,key))!==digest(policy)||await authority()!==revision)fail('EVALUATION_AUTHORITY_STALE');
    if(await this.epoch(ctx)!==epoch)fail('CONFLICT');if(this.now()<started)fail('EVALUATION_INVALID_CLOCK');
    return {schema:'plus-evaluation-protocol-metadata-v1' as const,key,items,readOnly:true as const,evaluationAuthorized:false as const};
  }
  async revoke(id:string,version:number,reason:string,p:PlusPrincipal){
    if(!Number.isSafeInteger(version)||version<1)fail('EVALUATION_INVALID_INPUT');text(reason);
    const ctx=this.context(p),epoch=await this.epoch(ctx),row=await this.row(ctx,id);await this.access(p,'evaluation:revoke',String(row.protocolKey));if(!p.roles.includes('model_owner'))fail('EVALUATION_FORBIDDEN');await this.integrity(ctx,row);
    const old=row.revocation as {actorId:string;reason:string;fromVersion:number}|undefined;
    if(row.status==='REVOKED'&&old?.actorId===p.id&&old.reason===reason&&old.fromVersion===version){await this.access(p,'evaluation:revoke',String(row.protocolKey));if(await this.epoch(ctx)!==epoch)fail('CONFLICT');return summary(row);}
    if(row.status!=='APPROVED'||row._version!==version)fail('EVALUATION_STATE_CONFLICT');
    const links=await this.config.storage.getLinks(ctx,id,'PlusModelEvaluationProtocol','inbound',{limit:1000});if(links.hasNextPage||links.totalCount>1000)fail('EVALUATION_COLLECTION_LIMIT');
    const dependents:OntologyObject[]=[];for(const link of links.items){const r=await this.config.storage.getObject(ctx,'PlusModelEvaluation',link._fromId);if(!r||r._deletedAt)fail('EVALUATION_LINK_INVALID');dependents.push(r);
      const decisions=await this.config.storage.getLinks(ctx,r._id,'PlusModelDecisionEvaluation','inbound',{limit:1000});if(decisions.hasNextPage||decisions.totalCount>1000)fail('EVALUATION_COLLECTION_LIMIT');
      for(const relation of decisions.items){const d=await this.config.storage.getObject(ctx,'PlusModelDecision',relation._fromId);if(!d||d._deletedAt)fail('EVALUATION_LINK_INVALID');dependents.push(d);if(dependents.length>1000)fail('EVALUATION_COLLECTION_LIMIT');}}
    dependents.push(...await modelDecisionDeployments(this.config.storage,ctx,dependents.filter(r=>r._type==='PlusModelDecision').map(r=>r._id)));if(dependents.length>1000)fail('EVALUATION_COLLECTION_LIMIT');
    const revocation={actorId:p.id,reason,fromVersion:version,at:this.now()};if(revocation.at<String((row.decision as {at:string}).at))fail('EVALUATION_CLOCK_ORDER');
    const tx=await this.begin(ctx,epoch);try{
      const updated=await tx.updateObject(TYPE,id,{status:'REVOKED',revocation,revocationHash:digest({contentHash:row.contentHash,decisionHash:row.decisionHash,revocation})},version);
      const changed:OntologyObject[]=[];for(const r of dependents)changed.push(await tx.updateObject(r._type,r._id,{readiness:'SUSPENDED'},r._version));
      await this.access(p,'evaluation:revoke',String(row.protocolKey));await this.journal(tx,ctx,p,'PlusRevokeEvaluationProtocol',updated,changed);await tx.commit();return summary(updated);
    }catch(e){await tx.rollback();throw e;}
  }
}
