import { digest } from '@openfoundry/plus-contracts';
import type { OntologyObject,StorageProvider,RequestContext } from '@openfoundry/spi';
import type { NativeReference } from './episode-types.js';

const fail=(code:string):never=>{throw Object.assign(new Error(code),{code});};
export interface SourceChangePayload {
  episodeId:string;root:NativeReference;definitionHash:string;bindingHash:string;
  target:NativeReference;targetHash:string;replacement?:NativeReference;replacementHash?:string;
  replacementQualificationHash?:string;
  nativePlanHash?:string;
  invalidatedEvents?:Array<{reference:NativeReference;hash:string}>;
  reason:string;
}
export interface CapturedSourceChange {id:string;version:number;requestHash:string;decisionHash:string}
export const sourceDecisionHash=(row:OntologyObject|Record<string,unknown>)=>digest({requestHash:row.requestHash,status:row.status,decidedBy:row.decidedBy,decidedAt:row.decidedAt,decisionReason:row.decisionReason});
export async function lineageLinks(storage:StorageProvider,ctx:RequestContext,id:string,type:string,direction:'inbound'|'outbound'){
  const page=await storage.getLinks(ctx,id,type,direction,{limit:1000});
  if(page.hasNextPage||page.totalCount>1000)fail('SOURCE_CHANGE_LIMIT');return page.items;
}
/** Internal structural verifier; callers must authorize the root/source before exposing a record. */
export async function verifySourceChange(storage:StorageProvider,ctx:RequestContext,row:OntologyObject){
  const payload=row.payload as SourceChangePayload;
  if(!payload||row._tenantId!==ctx.tenantId||row._deletedAt||!['CORRECTION','REVOCATION'].includes(String(row.kind))
    ||digest({kind:row.kind,payload,submittedBy:row.submittedBy,submittedAt:row.submittedAt})!==row.requestHash
    ||payload.root?.tenantId!==ctx.tenantId||payload.target?.tenantId!==ctx.tenantId||row.kind==='CORRECTION'&&payload.replacement?.tenantId!==ctx.tenantId
    ||row.kind==='REVOCATION'&&payload.replacement!==undefined)fail('SOURCE_CHANGE_INTEGRITY_ERROR');
  for(const [link,expected]of [['PlusSourceChangeEpisode',payload.episodeId],['PlusSourceChangeTarget',payload.target.id],['PlusSourceChangeReplacement',payload.replacement?.id]]as const){
    const links=await lineageLinks(storage,ctx,row._id,link,'outbound');if(expected?links.length!==1||links[0]!._toId!==expected:links.length!==0)fail('SOURCE_CHANGE_LINK_INVALID');
  }
  const invalidated=payload.invalidatedEvents??[],invalidationLinks=await lineageLinks(storage,ctx,row._id,'PlusSourceChangeInvalidates','outbound');
  if(!Array.isArray(invalidated)||invalidated.length>1000||invalidationLinks.length!==invalidated.length||invalidationLinks.some(l=>!invalidated.some(r=>r.reference.id===l._toId)))fail('SOURCE_CHANGE_LINK_INVALID');
  for(const item of invalidated){
    if(item.reference.tenantId!==ctx.tenantId||item.reference.type!=='PlusEvent')fail('SOURCE_CHANGE_INTEGRITY_ERROR');
    const event=await storage.getObject(ctx,'PlusEvent',item.reference.id);
    if(!event||event._deletedAt||event.contentHash!==item.hash||row.status==='APPROVED'&&event.revoked!==true)fail('SOURCE_CHANGE_INTEGRITY_ERROR');
  }
  if(!['PROPOSED','APPROVED','REJECTED'].includes(String(row.status)))fail('SOURCE_CHANGE_INTEGRITY_ERROR');
  if(row.status!=='PROPOSED'&&(row.submittedBy===row.decidedBy||sourceDecisionHash(row)!==row.decisionHash))fail('SOURCE_CHANGE_INTEGRITY_ERROR');
  if(row.status==='APPROVED'){
    const target=await storage.getObject(ctx,'PlusEvent',payload.target.id);
    if(!target||target._deletedAt||target.contentHash!==payload.targetHash)fail('SOURCE_CHANGE_INTEGRITY_ERROR');
    if(row.kind==='REVOCATION'&&target!.revoked!==true)fail('SOURCE_CHANGE_INTEGRITY_ERROR');
    if(row.kind==='CORRECTION'){
      const links=await lineageLinks(storage,ctx,payload.replacement!.id,'PlusEventSupersedes','outbound');
      if(links.length!==1||links[0]!._toId!==payload.target.id)fail('SOURCE_CHANGE_LINK_INVALID');
    }
  }
  return payload;
}
export async function approvedSourceChanges(storage:StorageProvider,ctx:RequestContext,eventIds:string[]){
  const changes=new Map<string,OntologyObject>();
  for(const id of eventIds)for(const type of ['PlusSourceChangeTarget','PlusSourceChangeInvalidates'])for(const link of await lineageLinks(storage,ctx,id,type,'inbound')){
    const row=await storage.getObject(ctx,'PlusSourceChange',link._fromId);if(!row)fail('SOURCE_CHANGE_LINK_INVALID');
    if(row!.status==='APPROVED'){await verifySourceChange(storage,ctx,row!);changes.set(row!._id,row!);if(changes.size>1000)fail('SOURCE_CHANGE_LIMIT');}
  }
  return [...changes.values()].sort((a,b)=>a._id.localeCompare(b._id));
}
export const captureSourceChange=(row:OntologyObject):CapturedSourceChange=>({id:row._id,version:row._version,requestHash:row.requestHash as string,decisionHash:row.decisionHash as string});

/** Bounded native reverse lineage. Business facts and completed actions are never rolled back here. */
export async function sourceDependents(storage:StorageProvider,ctx:RequestContext,eventId:string){
  const queue:Array<[string,string]>=[['PlusEvent',eventId]],visited=new Set<string>(),affected:OntologyObject[]=[];
  const edges:Record<string,Array<[string,string]>>={
    PlusEvent:[['PlusStreamEvent','PlusStreamRevision'],['PlusDatasetSource','PlusDatasetRevision'],['PlusFeedbackSource','PlusFeedback']],
    PlusStreamRevision:[['PlusInputStream','PlusInputSnapshot']],
    PlusInputSnapshot:[['PlusBeliefInput','PlusBeliefSnapshot'],['PlusExecutionBeliefInput','PlusExecution'],['PlusFeedbackInput','PlusFeedback'],['PlusFeedbackLabelSnapshot','PlusFeedback'],['PlusCohortInput','PlusCohort'],['PlusModelEvaluationInput','PlusModelEvaluation']],
    PlusCohort:[['PlusDatasetCohort','PlusDatasetRevision'],['PlusEvaluationProtocolCohort','PlusEvaluationProtocol']],
    PlusFeedback:[['PlusDatasetFeedback','PlusDatasetRevision']],
    PlusBeliefSnapshot:[['PlusScenarioBelief','PlusScenarioRun'],['PlusBeliefHeadCurrent','PlusBeliefHead']],
    PlusScenarioRun:[['PlusRequestScenario','PlusActionRequest']],
    PlusDatasetRevision:[['PlusReleaseDataset','PlusModelRelease'],['PlusExecutionDataset','PlusExecution'],['PlusModelEvaluationTraining','PlusModelEvaluation'],['PlusModelEvaluationValidation','PlusModelEvaluation']],
    PlusModelRelease:[['PlusDeploymentRelease','PlusDeployment'],['PlusBeliefRelease','PlusBeliefSnapshot'],['PlusModelEvaluationRelease','PlusModelEvaluation']],
    PlusEvaluationProtocol:[['PlusModelEvaluationProtocol','PlusModelEvaluation']],
    PlusModelEvaluation:[['PlusModelDecisionEvaluation','PlusModelDecision']],
    PlusModelDecision:[['PlusDeploymentDecision','PlusDeployment']],
    PlusModelRecipe:[['PlusExecutionRecipe','PlusExecution'],['PlusReleaseRecipe','PlusModelRelease'],['PlusEvaluationProtocolRecipe','PlusEvaluationProtocol']],
  };
  const component=(await storage.getSchema(ctx)).linkTypes.find(l=>l.name==='PlusRecipeComponentDecision');
  if(component){if(component.fromType!=='PlusModelRecipe'||component.toType!=='PlusModelDecision'||component.cardinality!=='MANY_TO_MANY')fail('SOURCE_CHANGE_LINK_INVALID');
    edges.PlusModelDecision!.push(['PlusRecipeComponentDecision','PlusModelRecipe']);}
  while(queue.length){
    const [type,id]=queue.shift()!,key=type+':'+id;if(visited.has(key))continue;visited.add(key);if(visited.size>1000)fail('SOURCE_CHANGE_LIMIT');
    if(type!=='PlusEvent'&&type!=='PlusStreamRevision'&&type!=='PlusModelRecipe'){
      const row=await storage.getObject(ctx,type,id);if(!row||row._deletedAt)fail('SOURCE_CHANGE_LINK_INVALID');affected.push(row!);
    }
    // Recipe approval history stays immutable. Its current component qualifier
    // becomes unusable; downstream executions/releases/results are suspended.
    if(type==='PlusModelRecipe'){const row=await storage.getObject(ctx,type,id);if(!row||row._deletedAt||row._tenantId!==ctx.tenantId)fail('SOURCE_CHANGE_LINK_INVALID');}
    for(const [link,to]of edges[type]??[])for(const relation of await lineageLinks(storage,ctx,id,link,'inbound')){
      queue.push([to,relation._fromId]);if(queue.length+visited.size>5000)fail('SOURCE_CHANGE_LIMIT');
    }
  }
  return affected;
}
