import { randomUUID } from 'node:crypto';
import { digest } from '@openfoundry/plus-contracts';
import type { StorageProvider,OntologyObject,RequestContext,Transaction,DateTime } from '@openfoundry/spi';
import type { PlusPrincipal } from './ontology-catalog.js';
import type { NativeModelEvaluation,EvaluationOutput } from './model-evaluation.js';
import type { NativeRecipeRegistry } from './recipe-registry.js';
import { createActionOutboxJournal } from './outbox.js';
import { modelDecisionDeployments } from './model-lineage.js';
import { requireTransitionComponentContract, validateTransitionComponentContract, type TransitionComponentContract } from './transition-component-contract.js';
import { transitionEvaluatorId } from './transition-evaluation-membership.js';
import { learnedCompositionStateEvaluatorId } from './learned-composition-evaluation-population.js';
import type { EvaluationProtocolPayload } from './evaluation-protocol-registry.js';
import type { NativeModelDeployment } from './model-deployment.js';
import { qualifiedNativeRead, type NativeReadQualificationPhase } from './read-qualification-phase.js';

export interface ModelAdmissionPolicy {
  version:'plus-model-admission-v1';id:string;definitionHash:string;bindingHash:string;scopeKey:string;
  classification:'SYNTHETIC'|'AUTHORIZED_REAL';task:'STATE_ESTIMATION';clockHash:string;
}
export interface TransitionComponentAdmissionPolicy extends Omit<ModelAdmissionPolicy,'version'|'task'> {
  version:'plus-transition-component-admission-v1';task:'CONDITIONAL_TRANSITION';component:TransitionComponentContract;
}
export type NativeAdmissionPolicy=ModelAdmissionPolicy|TransitionComponentAdmissionPolicy;
export interface ModelDecisionInput {key:string;evaluationId:string;evaluationVersion:number;decision:'APPROVE'|'REJECT';reason:string}
export type ModelDecisionPermission='model:decide'|'model:decision-read'|'model:decision-use'|'model:decision-revoke';
export interface ModelDecisionConfig {
  storage:StorageProvider;tenantId:string;evaluations:Pick<NativeModelEvaluation,'read'>;recipes:Pick<NativeRecipeRegistry,'requireApproved'>;
  authorize:(p:PlusPrincipal,permission:ModelDecisionPermission,key:string)=>Promise<boolean>;
  policyFor:(p:PlusPrincipal,key:string)=>Promise<NativeAdmissionPolicy>;
  authorizationRevision:(p:PlusPrincipal)=>Promise<string>;clock?:()=>number;
  coldStarts?:Pick<NativeModelDeployment,'requireColdStart'>;
  /** Trusted assembly assertion: EVERY upstream native read uses this storage's
   * full revision, and authorizationRevision covers all external upstream policy,
   * identity and expiry state. No caller/HTTP option. Otherwise keep full rereads. */
  readConsistency?:'SHARED_NATIVE_AND_AUTHORITY';
  /** Trusted same-graph read scope. Each initial/precommit material pass is independent. */
  readQualificationPhase?:NativeReadQualificationPhase;
}
type Ref={id:string;version:number;hash:string};
type ReadSet={evaluation:Ref;recipe:Ref;release:Ref};
const TYPE='PlusModelDecision';
function fail(code:string):never{throw Object.assign(new Error(code),{code});}
function text(v:unknown):string{if(typeof v!=='string'||!v.trim()||v.length>2000)fail('MODEL_DECISION_INVALID_INPUT');return v;}
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fingerprint=(r:Record<string,unknown>)=>digest(Object.fromEntries(['decisionKey','policyKey','decision','reason','policy','inputReadSet','createdBy','createdAt'].map(k=>[k,r[k]])));
const summary=(r:OntologyObject)=>({id:r._id,version:r._version,decision:r.decision,readiness:r.readiness,contentHash:r.contentHash,
  ...((r.policy as NativeAdmissionPolicy)?.version==='plus-transition-component-admission-v1'?{admissionKind:'TRANSITION_COMPONENT_ONLY'}:{}),modelDeploymentAuthorized:false});
export type ModelDecisionResult=ReturnType<typeof summary>;
/** Short native metadata binding of an explicit human decision. No model or
 * evaluation qualification is implied; the long execution rechecks all inputs. */
export interface PreparedModelDecision {schema:'plus-prepared-model-decision-v1';inputHash:string;policyHash:string;evaluation:Ref;preparedHash:string}
/** Trusted same-storage job integration only, never accepted from HTTP. */
export interface ModelDecisionCommitGuard {assertCurrent:()=>Promise<void>;stage:(tx:Transaction,result:ModelDecisionResult,record:Ref)=>Promise<void>}
function decisionInput(input:ModelDecisionInput):ModelDecisionInput {
  if(!input||Object.keys(input).sort().join(',')!=='decision,evaluationId,evaluationVersion,key,reason'||!['APPROVE','REJECT'].includes(input.decision)
    ||!Number.isSafeInteger(input.evaluationVersion)||input.evaluationVersion<1)fail('MODEL_DECISION_INVALID_INPUT');
  const v=structuredClone(input);text(v.key);text(v.evaluationId);text(v.reason);return v;
}

/** Independent native admission for a specific task/binding/clock, not a mutable
 * global model status. Deployment must separately use a current approved decision.
 */
export class NativeModelDecision {
  constructor(private readonly config:ModelDecisionConfig){}
  private context(p:PlusPrincipal):RequestContext{if(!p?.id||p.tenantId!==this.config.tenantId||!Array.isArray(p.roles))fail('MODEL_DECISION_FORBIDDEN');return {tenantId:p.tenantId,actorId:p.id,traceId:randomUUID()};}
  private now(){const n=(this.config.clock??Date.now)();if(!Number.isFinite(n))fail('MODEL_DECISION_INVALID_CLOCK');return new Date(n).toISOString();}
  private async access(p:PlusPrincipal,permission:ModelDecisionPermission,key:string){this.context(p);text(key);if(!await this.config.authorize(p,permission,key))fail('MODEL_DECISION_FORBIDDEN');}
  private async authority(p:PlusPrincipal){if(typeof this.config.authorizationRevision!=='function')fail('MODEL_DECISION_AUTHORITY_REQUIRED');const h=await this.config.authorizationRevision(p);if(!hash(h))fail('MODEL_DECISION_AUTHORITY_INVALID');return h;}
  private async epoch(ctx:RequestContext){if(!this.config.storage.getReadRevision)fail('MODEL_DECISION_READ_GUARD_REQUIRED');return this.config.storage.getReadRevision!(ctx);}
  private async row(ctx:RequestContext,type:string,id:string){const r=await this.config.storage.getObject(ctx,type,text(id));if(!r||r._tenantId!==ctx.tenantId||r._deletedAt)fail('MODEL_DECISION_NOT_FOUND');return r;}
  private async policy(p:PlusPrincipal,key:string){
    const v=structuredClone(await this.config.policyFor(p,key));
    const component=v?.version==='plus-transition-component-admission-v1';
    if(!v||Object.keys(v).sort().join(',')!==(component?'bindingHash,classification,clockHash,component,definitionHash,id,scopeKey,task,version':'bindingHash,classification,clockHash,definitionHash,id,scopeKey,task,version')
      ||(!component&&v.version!=='plus-model-admission-v1')||!hash(v.definitionHash)||!hash(v.bindingHash)||!hash(v.clockHash)
      ||v.task!==(component?'CONDITIONAL_TRANSITION':'STATE_ESTIMATION')||!['SYNTHETIC','AUTHORIZED_REAL'].includes(v.classification))fail('MODEL_DECISION_POLICY_INVALID');text(v.id);text(v.scopeKey);return v;
  }
  private async material(key:string,evaluationId:string,p:PlusPrincipal,recompute:boolean){
    const actor=structuredClone(p),read=()=>this.materialQualified(key,evaluationId,actor,recompute);
    return this.config.readQualificationPhase?this.config.readQualificationPhase.run(actor,read):read();
  }
  private async materialQualified(key:string,evaluationId:string,p:PlusPrincipal,recompute:boolean){
    const ctx=this.context(p),authority=await this.authority(p),policy=await this.policy(p,key);
    const {record:e}=await this.config.evaluations.read(evaluationId,p,{recompute}),result=e.result as EvaluationOutput;
    const source=e.inputReadSet as {recipe:Ref;candidateId:string},recipe=await this.config.recipes.requireApproved(source.recipe.hash,p,'recipe:read');
    const payload=recipe.payload as {engineId?:string;compiled:{definitionHash:string;definition:{scope:{key:string}}};config:{bindingHash:string}};
    const protocol=await this.row(ctx,'PlusEvaluationProtocol',String((e.inputReadSet as {protocol:Ref}).protocol.id));
    const protocolPayload=protocol.payload as EvaluationProtocolPayload;
    if(e.evaluatorId===learnedCompositionStateEvaluatorId||payload.engineId==='ontology-composed-dynamics-v1'){
      const metrics=result.metrics,reads=e.inputReadSet as {publishedReferenceHash?:string;coldStartHash?:string;learnedComposition?:unknown};
      if(e.evaluatorId!==learnedCompositionStateEvaluatorId||result.evaluatorId!==learnedCompositionStateEvaluatorId||payload.engineId!=='ontology-composed-dynamics-v1'
        ||policy.version!=='plus-model-admission-v1'||!reads.learnedComposition||metrics.schema!=='plus-learned-composition-state-validation-v1'
        ||metrics.nativeContextBound!==true||protocolPayload.reference||!!protocolPayload.coldStart===!!protocolPayload.learnedCompositionReference)fail('MODEL_COMPLETE_COMPARISON_REQUIRED');
      const reference=protocolPayload.learnedCompositionReference,cold=protocolPayload.coldStart;
      if(reference){
        const numeric=metrics.numerics as {references?:{currentPublication?:unknown};comparisons?:{currentPublication?:{regresses?:boolean}}};
        if(metrics.publishedReferenceHash!==digest(reference)||reads.publishedReferenceHash!==digest(reference)||reads.coldStartHash||metrics.coldStartHash
          ||!numeric?.references?.currentPublication||typeof numeric.comparisons?.currentPublication?.regresses!=='boolean')fail('MODEL_COMPLETE_COMPARISON_REQUIRED');
      }else{
        if(!cold||!this.config.coldStarts||metrics.coldStartHash!==digest(cold)||reads.coldStartHash!==digest(cold)||reads.publishedReferenceHash||metrics.publishedReferenceHash)fail('MODEL_COMPLETE_COLD_START_REQUIRED');
        const qualified=await this.config.coldStarts.requireColdStart(cold,{id:protocol._id,version:protocol._version,hash:String(protocol.contentHash)},p,{candidateId:source.candidateId});
        if(!qualified.coldStartQualified||digest(qualified.binding)!==digest(cold))fail('MODEL_COMPLETE_COLD_START_REQUIRED');
      }
    }
    let bindingHash=payload.config.bindingHash,clockHash=policy.version==='plus-model-admission-v1'?digest(protocolPayload.configuration.clock):'';
    if(policy.version==='plus-transition-component-admission-v1'){
      const component=requireTransitionComponentContract(policy.component,recipe.payload),configuration=protocolPayload.configuration as Record<string,unknown>;
      // v1's untrained-only reference cannot authorize even a component. The
      // actual fixed native evaluator must requalify and recompute v2 scores.
      const score=result.metrics?.score as {schema?:string;reference?:{kind?:string};comparisonRule?:string}|undefined;
      if(e.evaluatorId!==transitionEvaluatorId||result.evaluatorId!==transitionEvaluatorId
        ||configuration.schema!=='plus-conditional-transition-evaluation-v2'
        ||digest(configuration.reference)!==digest({schema:'plus-transition-reference-v1',kind:'SAME_CONDITION_FACTORIZED_COUNTS'})
        ||score?.schema!=='plus-conditional-transition-score-v2'||score.reference?.kind!=='SAME_CONDITION_FACTORIZED_COUNTS'
        ||score.comparisonRule!=='NO_REGRESSION_AGAINST_EITHER_FIXED_REFERENCE')fail('MODEL_COMPONENT_EVALUATION_REQUIRED');
      bindingHash=component.bindingHash;clockHash=component.timeContractHash;
      if(component.classification!==policy.classification||component.scopeKey!==policy.scopeKey)fail('MODEL_DECISION_TASK_MISMATCH');
    }
    if(e.readiness!=='READY'||result.task!==policy.task||result.classification!==policy.classification
      ||payload.compiled.definitionHash!==policy.definitionHash||payload.compiled.definition.scope.key!==policy.scopeKey
      ||clockHash!==policy.clockHash||bindingHash!==policy.bindingHash||recipe.record._id!==source.recipe.id||recipe.record._version!==source.recipe.version)fail('MODEL_DECISION_TASK_MISMATCH');
    const release=await this.row(ctx,'PlusModelRelease',source.candidateId);
    if(release.classification!==policy.classification||!['CANDIDATE','EVALUATED','APPROVED'].includes(String(release.status)))fail('MODEL_DECISION_CANDIDATE_INVALID');
    const readSet:ReadSet={evaluation:{id:e._id,version:e._version,hash:String(e.contentHash)},recipe:{id:recipe.record._id,version:recipe.record._version,hash:source.recipe.hash},release:{id:release._id,version:release._version,hash:digest(release)}};
    if(await this.authority(p)!==authority||digest(await this.policy(p,key))!==digest(policy))fail('MODEL_DECISION_AUTHORITY_STALE');
    return {policy,readSet,evaluation:e,release,recipe:recipe.record};
  }
  private async integrity(ctx:RequestContext,r:OntologyObject){
    if(fingerprint(r)!==r.contentHash||!['APPROVE','REJECT'].includes(String(r.decision)))fail('MODEL_DECISION_INTEGRITY');
    const read=r.inputReadSet as ReadSet;if(r.decisionKey!==digest([ctx.tenantId,r.policyKey,read.evaluation.id]))fail('MODEL_DECISION_INTEGRITY');
    for(const [link,target]of [['PlusModelDecisionEvaluation',read.evaluation.id],['PlusModelDecisionRecipe',read.recipe.id],['PlusModelDecisionRelease',read.release.id]]){
      const page=await this.config.storage.getLinks(ctx,r._id,link!,'outbound',{limit:2});if(page.hasNextPage||page.totalCount!==1||page.items.length!==1||page.items[0]!._toId!==target)fail('MODEL_DECISION_LINK_INVALID');
    }
    if(r.revocation!=null){const v=r.revocation as {actorId:string;at:string;reason:string;fromVersion:number};
      if(!v.actorId||!v.reason||!Number.isSafeInteger(v.fromVersion)||v.fromVersion<1||!Number.isFinite(Date.parse(v.at))||v.at<String(r.createdAt)
        ||r.revocationHash!==digest({contentHash:r.contentHash,revocation:v})||r.readiness!=='SUSPENDED')fail('MODEL_DECISION_INTEGRITY');
    }else if(r.revocationHash!=null)fail('MODEL_DECISION_INTEGRITY');
  }
  private async final(p:PlusPrincipal,permission:ModelDecisionPermission,key:string,readSet:ReadSet,policy:NativeAdmissionPolicy,authority:string){
    const current=await this.material(key,readSet.evaluation.id,p,false);
    if(digest(current.readSet)!==digest(readSet)||digest(current.policy)!==digest(policy))fail('MODEL_DECISION_STALE');
    await this.access(p,permission,key);if(await this.authority(p)!==authority)fail('MODEL_DECISION_AUTHORITY_STALE');
  }
  private async begin(ctx:RequestContext,epoch:string){const tx=await this.config.storage.beginTransaction(ctx);try{if(!tx.assertReadRevision)fail('MODEL_DECISION_READ_GUARD_REQUIRED');await tx.assertReadRevision!(epoch);return tx;}catch(e){await tx.rollback();throw e;}}
  private async journal(tx:Transaction,ctx:RequestContext,p:PlusPrincipal,name:string,r:OntologyObject,dependents:OntologyObject[]=[]){const actionId='act_'+randomUUID();
    await createActionOutboxJournal().stage(tx,{version:'native-action-commit-v1',tenantId:ctx.tenantId,actionId,audit:{id:'audit_'+actionId,tenantId:ctx.tenantId,timestamp:this.now() as DateTime,traceId:ctx.traceId!,
      actor:{id:p.id,type:'user',roles:[...p.roles]},operation:{type:'action',actionType:name,actionId},detail:{result:'success',after:{decision:summary(r),suspendedDeployments:dependents.map(d=>({id:d._id,version:d._version}))}}},affectedObjects:[r,...dependents].map(d=>({type:d._type,id:d._id,changeType:d._version===1?'created':'updated'}))});
  }
  async prepareDecision(input:ModelDecisionInput,principal:PlusPrincipal):Promise<PreparedModelDecision>{
    const p=structuredClone(principal),v=decisionInput(input),ctx=this.context(p),started=this.now();
    await this.access(p,'model:decide',v.key);if(!p.roles.includes('model_owner'))fail('MODEL_DECISION_FORBIDDEN');
    const epoch=await this.epoch(ctx),authority=await this.authority(p),policy=await this.policy(p,v.key);
    const e=await this.row(ctx,'PlusModelEvaluation',v.evaluationId);
    if(e._type!=='PlusModelEvaluation'||e._id!==v.evaluationId||e._version!==v.evaluationVersion)fail('MODEL_DECISION_VERSION_CONFLICT');
    // Entire native row (including version/status), NOT client-supplied scoring
    // or an interpretation of READY as current qualification.
    const body={schema:'plus-prepared-model-decision-v1' as const,inputHash:digest(v),policyHash:digest(policy),
      evaluation:{id:e._id,version:e._version,hash:digest(e)}};
    await this.access(p,'model:decide',v.key);
    if(await this.authority(p)!==authority||digest(await this.policy(p,v.key))!==body.policyHash)fail('MODEL_DECISION_AUTHORITY_STALE');
    if(await this.epoch(ctx)!==epoch)fail('CONFLICT');if(this.now()<started)fail('MODEL_DECISION_CLOCK_ORDER');
    return {...body,preparedHash:digest(body)};
  }
  async executePreparedDecision(input:ModelDecisionInput,p:PlusPrincipal,prepared:PreparedModelDecision,guard:ModelDecisionCommitGuard){
    if(typeof guard?.assertCurrent!=='function'||typeof guard?.stage!=='function')fail('MODEL_DECISION_JOB_GUARD_REQUIRED');
    return this.decideInternal(input,p,{prepared:structuredClone(prepared),guard});
  }
  async decide(input:ModelDecisionInput,p:PlusPrincipal){return this.decideInternal(input,p);}
  private async decideInternal(input:ModelDecisionInput,p:PlusPrincipal,job?:{prepared:PreparedModelDecision;guard:ModelDecisionCommitGuard}){
    p=structuredClone(p);
    const v=decisionInput(input),ctx=this.context(p);await this.access(p,'model:decide',v.key);if(!p.roles.includes('model_owner'))fail('MODEL_DECISION_FORBIDDEN');
    const started=this.now(),jobAuthority=job?await this.authority(p):undefined;
    const jobFence=async()=>{if(!job)return;await job.guard.assertCurrent();
      if(digest(await this.prepareDecision(v,p))!==digest(job.prepared))fail('MODEL_DECISION_PREPARED_STALE');
      if(await this.authority(p)!==jobAuthority)fail('MODEL_DECISION_AUTHORITY_STALE');
      if(this.now()<started)fail('MODEL_DECISION_CLOCK_ORDER');};
    const stageJob=async(tx:Transaction,row:OntologyObject)=>{if(!job)return;await jobFence();
      await job.guard.stage(tx,structuredClone(summary(row)),{id:row._id,version:row._version,hash:digest(row)});await jobFence();};
    await jobFence();
    const epoch=await this.epoch(ctx),authority=await this.authority(p),m=await this.material(v.key,v.evaluationId,p,true);
    if(m.readSet.evaluation.version!==v.evaluationVersion)fail('MODEL_DECISION_VERSION_CONFLICT');
    if([m.evaluation.createdBy,m.release.createdBy,m.recipe.submittedBy].includes(p.id))fail('MODEL_DECISION_INDEPENDENT_REVIEW_REQUIRED');
    if(v.decision==='APPROVE'&&(m.evaluation.result as EvaluationOutput).decision!=='ELIGIBLE_FOR_REVIEW')fail('MODEL_DECISION_REGRESSION');
    const decisionKey=digest([ctx.tenantId,v.key,v.evaluationId]),found=await this.config.storage.queryObjects(ctx,TYPE,{field:'decisionKey',operator:'eq',value:decisionKey},{limit:2});
    if(found.hasNextPage||found.items.length>1)fail('MODEL_DECISION_INTEGRITY');
    const old=found.items[0];if(old){await this.integrity(ctx,old);
      if(old.createdBy!==p.id||old.decision!==v.decision||old.reason!==v.reason||digest(old.policy)!==digest(m.policy)||digest(old.inputReadSet)!==digest(m.readSet)||old.readiness!=='READY')fail('MODEL_DECISION_REVISION_CONFLICT');
      await this.final(p,'model:decide',v.key,m.readSet,m.policy,authority);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
      if(job){const tx=await this.begin(ctx,epoch);try{await stageJob(tx,old);await tx.commit();}catch(e){await tx.rollback();throw e;}}
      return summary(old);}
    const createdAt=this.now();if(createdAt<String(m.evaluation.createdAt))fail('MODEL_DECISION_CLOCK_ORDER');
    const fields={decisionKey,policyKey:v.key,decision:v.decision,reason:v.reason,policy:m.policy,inputReadSet:m.readSet,createdBy:p.id,createdAt};
    const tx=await this.begin(ctx,epoch);try{const r=await tx.createObject(TYPE,{...fields,contentHash:fingerprint(fields),readiness:'READY'});
      for(const [link,target]of [['PlusModelDecisionEvaluation',m.readSet.evaluation.id],['PlusModelDecisionRecipe',m.readSet.recipe.id],['PlusModelDecisionRelease',m.readSet.release.id]])await tx.createLink(link!,r._id,target!);
      await this.final(p,'model:decide',v.key,m.readSet,m.policy,authority);await this.journal(tx,ctx,p,'PlusDecideModelAdmission',r);
      await stageJob(tx,r);await tx.commit();return summary(r);
    }catch(e){await tx.rollback();throw e;}
  }
  async read(id:string,p:PlusPrincipal,{recompute=false,permission='model:decision-read' as ModelDecisionPermission}={}){
    p=structuredClone(p);
    if(!['model:decision-read','model:decision-use'].includes(permission))fail('MODEL_DECISION_FORBIDDEN');
    const ctx=this.context(p),epoch=await this.epoch(ctx),r=await this.row(ctx,TYPE,id);await this.access(p,permission,String(r.policyKey));const authority=await this.authority(p);await this.integrity(ctx,r);
    const m=await this.material(String(r.policyKey),(r.inputReadSet as ReadSet).evaluation.id,p,recompute);
    if([m.evaluation.createdBy,m.release.createdBy,m.recipe.submittedBy].includes(r.createdBy)||!Number.isFinite(Date.parse(String(r.createdAt)))||String(r.createdAt)<String(m.evaluation.createdAt))fail('MODEL_DECISION_INTEGRITY');
    if(digest(m.readSet)!==digest(r.inputReadSet)||digest(m.policy)!==digest(r.policy)||r.readiness!=='READY'||r.revocation!=null)fail('MODEL_DECISION_STALE');
    const approved=r.decision==='APPROVE'&&(m.evaluation.result as EvaluationOutput).decision==='ELIGIBLE_FOR_REVIEW';if(permission==='model:decision-use'&&!approved)fail('MODEL_DECISION_NOT_APPROVED');
    if(this.config.readConsistency==='SHARED_NATIVE_AND_AUTHORITY'){
      // Only this read invocation reuses its already verified material. No cache,
      // no skipped evaluation recomputation, and no change to command fences.
      if(digest(await this.policy(p,String(r.policyKey)))!==digest(m.policy))fail('MODEL_DECISION_STALE');
      await this.access(p,permission,String(r.policyKey));
      if(await this.authority(p)!==authority)fail('MODEL_DECISION_AUTHORITY_STALE');
    }else await this.final(p,permission,String(r.policyKey),m.readSet,m.policy,authority);
    if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    const component=m.policy.version==='plus-transition-component-admission-v1';
    return {record:structuredClone(r),modelApproved:approved&&!component,...(component?{modelComponentApproved:approved}:{}),modelDeploymentAuthorized:false};
  }
  async requireApproved(id:string,p:PlusPrincipal){
    const result=await this.read(id,p,{recompute:true,permission:'model:decision-use'});
    if(!result.modelApproved)fail('MODEL_DECISION_COMPONENT_ONLY');return result;
  }
  /** Scoped native decision references for owner selection forms. This never
   * qualifies model/data material or converts a component into a full model. */
  async listForSelection(key:string,principal:PlusPrincipal){
    return this.listDecisionReferences(key,principal,false);
  }
  /** Component authoring directory only. A recorded decision/hash is not current
   * model qualification; consumers must still use requireComponentApproved. */
  async listForComposition(key:string,principal:PlusPrincipal){
    return this.listDecisionReferences(key,principal,true);
  }
  private async listDecisionReferences(key:string,principal:PlusPrincipal,component:boolean){
    const p=structuredClone(principal),ctx=this.context(p),epoch=await this.epoch(ctx),started=this.now();
    await this.access(p,'model:decision-read',key);const authority=await this.authority(p),policy=await this.policy(p,key);
    if(policy.version!==(component?'plus-transition-component-admission-v1':'plus-model-admission-v1'))fail(component?'MODEL_DECISION_NOT_COMPONENT':'MODEL_DECISION_COMPONENT_ONLY');
    if(component&&policy.version==='plus-transition-component-admission-v1')validateTransitionComponentContract(policy.component);
    const page=await this.config.storage.queryObjects(ctx,TYPE,{field:'policyKey',operator:'eq',value:key},
      {limit:101,orderBy:[{field:'createdAt',direction:'asc'},{field:'_id',direction:'asc'}]});
    if(page.hasNextPage||page.totalCount!==page.items.length||page.items.length>100||new Set(page.items.map(r=>r._id)).size!==page.items.length)fail('MODEL_DECISION_COLLECTION_LIMIT');
    const items=[];
    for(const row of page.items){
      if(row._tenantId!==ctx.tenantId||row._type!==TYPE||row._deletedAt||row.policyKey!==key||!Number.isSafeInteger(row._version)||row._version<1)fail('MODEL_DECISION_INTEGRITY');
      await this.integrity(ctx,row);const reads=row.inputReadSet as ReadSet;
      if(!reads||Object.keys(reads).sort().join(',')!=='evaluation,recipe,release'||!['READY','SUSPENDED'].includes(String(row.readiness))
        ||!Number.isFinite(Date.parse(String(row.createdAt)))||String(row.createdAt)>started)fail('MODEL_DECISION_INTEGRITY');
      for(const reference of Object.values(reads))if(!reference||Object.keys(reference).sort().join(',')!=='hash,id,version'||!hash(reference.hash)
        ||!Number.isSafeInteger(reference.version)||reference.version<1||!text(reference.id))fail('MODEL_DECISION_INTEGRITY');
      const stored=row.policy as NativeAdmissionPolicy;
      if(component&&stored.version==='plus-transition-component-admission-v1')validateTransitionComponentContract(stored.component);
      items.push({id:row._id,version:row._version,contentHash:String(row.contentHash),decision:String(row.decision),recordedReadiness:String(row.readiness),
        revoked:row.revocation!=null,createdAt:String(row.createdAt),release:structuredClone(reads.release),evaluation:structuredClone(reads.evaluation),
        ...(component?{recordHash:digest(row),recipe:structuredClone(reads.recipe),component:stored.version==='plus-transition-component-admission-v1'?structuredClone(stored.component):null}:{}),
        configuredPolicyMatches:stored.version===policy.version&&digest(stored)===digest(policy),qualification:'NOT_CHECKED' as const});
    }
    await this.access(p,'model:decision-read',key);if(digest(await this.policy(p,key))!==digest(policy)||await this.authority(p)!==authority)fail('MODEL_DECISION_AUTHORITY_STALE');
    if(await this.epoch(ctx)!==epoch)fail('CONFLICT');if(this.now()<started)fail('MODEL_DECISION_CLOCK_ORDER');
    return {schema:component?'plus-model-component-composition-index-v1' as const:'plus-model-decision-selection-index-v1' as const,key,policyHash:digest(policy),items,readOnly:true as const,predictionReady:false as const,modelDeploymentAuthorized:false as const};
  }
  /** Server-only component handoff. No HTTP-supplied contract and no deployment
   * pointer; complete-model composition/admission must be performed separately. */
  async requireComponentApproved(id:string,p:PlusPrincipal){
    return qualifiedNativeRead(this,this.config.storage,'model:requireComponentApproved',{id},p,async()=>{
    const result=await this.read(id,p,{recompute:true,permission:'model:decision-use'});
    if(result.modelComponentApproved!==true)fail('MODEL_DECISION_NOT_COMPONENT');return result;
    });
  }
  async revoke(id:string,version:number,reason:string,p:PlusPrincipal){
    p=structuredClone(p);
    if(!Number.isSafeInteger(version)||version<1)fail('MODEL_DECISION_INVALID_INPUT');text(reason);
    const ctx=this.context(p),epoch=await this.epoch(ctx),r=await this.row(ctx,TYPE,id);await this.access(p,'model:decision-revoke',String(r.policyKey));if(!p.roles.includes('model_owner'))fail('MODEL_DECISION_FORBIDDEN');
    const authority=await this.authority(p);await this.integrity(ctx,r);const prior=r.revocation as {actorId:string;reason:string;fromVersion:number}|undefined;
    if(prior){if(prior.actorId!==p.id||prior.reason!==reason||prior.fromVersion!==version)fail('MODEL_DECISION_REVISION_CONFLICT');await this.access(p,'model:decision-revoke',String(r.policyKey));if(await this.authority(p)!==authority||await this.epoch(ctx)!==epoch)fail('CONFLICT');return summary(r);}
    if(r._version!==version)fail('MODEL_DECISION_VERSION_CONFLICT');const revocation={actorId:p.id,reason,fromVersion:version,at:this.now()};if(revocation.at<String(r.createdAt))fail('MODEL_DECISION_CLOCK_ORDER');
    const deployments=await modelDecisionDeployments(this.config.storage,ctx,[id]);
    const tx=await this.begin(ctx,epoch);try{const updated=await tx.updateObject(TYPE,id,{readiness:'SUSPENDED',revocation,revocationHash:digest({contentHash:r.contentHash,revocation})},version),changed:OntologyObject[]=[];
      for(const d of deployments)changed.push(await tx.updateObject('PlusDeployment',d._id,{readiness:'SUSPENDED'},d._version));
      await this.access(p,'model:decision-revoke',String(r.policyKey));if(await this.authority(p)!==authority)fail('MODEL_DECISION_AUTHORITY_STALE');await this.journal(tx,ctx,p,'PlusRevokeModelAdmission',updated,changed);await tx.commit();return summary(updated);
    }catch(e){await tx.rollback();throw e;}
  }
}
