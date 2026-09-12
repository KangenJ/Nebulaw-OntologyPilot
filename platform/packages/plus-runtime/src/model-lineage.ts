import type { StorageProvider,RequestContext,OntologyObject } from '@openfoundry/spi';

/** Current heads only. Historical selection revisions stay immutable and do not
 * suspend a clean replacement merely because an older decision was withdrawn. */
export async function modelDecisionDeployments(storage:StorageProvider,ctx:RequestContext,ids:string[]){
  const result=new Map<string,OntologyObject>();
  const fail=(code:string):never=>{throw Object.assign(new Error(code),{code});};
  // Older schemas remain readable. A component edge is only legal with its
  // exact typed migration; do not infer it from an arbitrary JSON reference.
  const schema=await storage.getSchema(ctx),component=schema.linkTypes.find(l=>l.name==='PlusRecipeComponentDecision');
  if(component&&(component.fromType!=='PlusModelRecipe'||component.toType!=='PlusModelDecision'||component.cardinality!=='MANY_TO_MANY'))fail('MODEL_LINEAGE_INVALID');
  const edges:Record<string,Array<[string,string]>>={
    PlusModelDecision:[['PlusDeploymentDecision','PlusDeployment'],...(component?[['PlusRecipeComponentDecision','PlusModelRecipe'] as [string,string]]:[])],
    PlusModelRecipe:[['PlusReleaseRecipe','PlusModelRelease'],['PlusEvaluationProtocolRecipe','PlusEvaluationProtocol']],
    PlusModelRelease:[['PlusModelEvaluationRelease','PlusModelEvaluation']],
    PlusEvaluationProtocol:[['PlusModelEvaluationProtocol','PlusModelEvaluation']],
    PlusModelEvaluation:[['PlusModelDecisionEvaluation','PlusModelDecision']]};
  const queue:Array<[string,string,number]>=Array.from(new Set(ids),id=>['PlusModelDecision',id,0]),seen=new Set<string>();
  if(queue.length>1000)fail('MODEL_LINEAGE_LIMIT');
  while(queue.length){const [type,id,depth]=queue.shift()!,key=type+':'+id;if(seen.has(key))continue;
    if(depth>32||seen.size>=1000)fail('MODEL_LINEAGE_LIMIT');seen.add(key);
    for(const [linkType,targetType]of edges[type]??[]){
      const page=await storage.getLinks(ctx,id,linkType,'inbound',{limit:1000});
      if(page.hasNextPage||page.totalCount>1000)fail('MODEL_LINEAGE_LIMIT');
      for(const link of page.items){const row=await storage.getObject(ctx,targetType,link._fromId);
        if(!row||row._deletedAt||row._tenantId!==ctx.tenantId)fail('MODEL_LINEAGE_INVALID');
        if(targetType==='PlusDeployment')result.set(row!._id,row!);
        else queue.push([targetType,row!._id,depth+1]);
        if(result.size>1000||queue.length>5000)fail('MODEL_LINEAGE_LIMIT');
      }
    }
  }
  return [...result.values()];
}
