import { digest,type CompiledDefinition } from '@openfoundry/plus-contracts';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { StorageProvider,RequestContext,OntologyObject } from '@openfoundry/spi';
import type { PlusPrincipal } from './ontology-catalog.js';
import type { NativeModelDecision } from './model-decision.js';
import { requireTransitionComponentContract } from './transition-component-contract.js';

export type RecipeDependency={kind:'RULE_SPECIFICATION'|'TRANSITION_COMPONENT';id:string;version:number;hash:string};
export const recipeDependencyTypes={RULE_SPECIFICATION:{link:'PlusRecipeRuleSpecification',type:'PlusRuleSpecification'},
  TRANSITION_COMPONENT:{link:'PlusRecipeComponentDecision',type:'PlusModelDecision'}} as const;
function fail(code:string):never{throw Object.assign(new Error(code),{code});}
export function recipeDependencies(payload:Record<string,unknown>):RecipeDependency[]{
  if(!Object.hasOwn(payload,'nativeDependencies'))return [];
  const refs=payload.nativeDependencies as RecipeDependency[];
  if(!Array.isArray(refs)||!refs.length||refs.length>32||new Set(refs.map(r=>r?.id)).size!==refs.length)fail('RECIPE_DEPENDENCY_INVALID');
  for(const r of refs)if(!r||Object.keys(r).sort().join(',')!=='hash,id,kind,version'||!Object.hasOwn(recipeDependencyTypes,r.kind)
    ||typeof r.id!=='string'||!r.id.trim()||r.id.length>2000||!Number.isSafeInteger(r.version)||r.version<1
    ||typeof r.hash!=='string'||!/^[a-f0-9]{64}$/.test(r.hash))fail('RECIPE_DEPENDENCY_INVALID');
  return structuredClone(refs);
}

/** Preflight the persisted graph BEFORE invoking native qualification callbacks.
 * First release accepts terminal v3 transition components only. The explicit
 * graph guard also rejects forged indirect cycles rather than recursing through
 * recipe -> decision -> evaluation -> recipe until the process overflows.
 * This internal structural read is not an approval or a public data endpoint. */
async function collectRecipeComponents(storage:StorageProvider,ctx:RequestContext,payload:Record<string,unknown>,compiled:CompiledDefinition,
  p:PlusPrincipal,decisions:Pick<NativeModelDecision,'requireComponentApproved'>|undefined){
  const qualified=new Map<string,Awaited<ReturnType<NativeModelDecision['requireComponentApproved']>>>();
  const refs=recipeDependencies(payload).filter(r=>r.kind==='TRANSITION_COMPONENT');if(!refs.length)return qualified;
  if(typeof decisions?.requireComponentApproved!=='function')fail('RECIPE_COMPONENT_PROVIDER_REQUIRED');
  const active=new Set<string>(),done=new Set<string>();let visits=0;
  const rows=new Map<string,{decision:OntologyObject;recipe:OntologyObject}>();
  async function row(type:string,id:string){const r=await storage.getObject(ctx,type,id);
    if(!r||r._deletedAt||r._tenantId!==ctx.tenantId)fail('RECIPE_DEPENDENCY_STALE');return r!;}
  async function visit(ref:RecipeDependency,depth:number):Promise<void>{
    if(depth>32||++visits>1000)fail('RECIPE_COMPONENT_GRAPH_LIMIT');
    if(active.has(ref.id))fail('RECIPE_COMPONENT_CYCLE');if(done.has(ref.id))return;
    active.add(ref.id);const decision=await row('PlusModelDecision',ref.id);
    if(decision._version!==ref.version||digest(decision)!==ref.hash)fail('RECIPE_DEPENDENCY_STALE');
    const source=(decision.inputReadSet as {recipe?:{id:string;version:number;hash:string}})?.recipe;
    if(!source||typeof source.id!=='string'||!source.id)fail('RECIPE_COMPONENT_LINEAGE_INVALID');
    const recipe=await row('PlusModelRecipe',source.id),body=recipe.payload as Record<string,unknown>;
    if(recipe._version!==source.version||recipe.recipeHash!==source.hash||digest(body)!==source.hash)fail('RECIPE_DEPENDENCY_STALE');
    const links=await storage.getLinks(ctx,decision._id,'PlusModelDecisionRecipe','outbound',{limit:2});
    if(links.hasNextPage||links.totalCount!==1||links.items.length!==1||links.items[0]!._toId!==recipe._id)fail('RECIPE_COMPONENT_LINEAGE_INVALID');
    if(recipe.recipeHash===digest(payload))fail('RECIPE_COMPONENT_CYCLE');
    for(const child of recipeDependencies(body).filter(r=>r.kind==='TRANSITION_COMPONENT'))await visit(child,depth+1);
    rows.set(ref.id,{decision,recipe});active.delete(ref.id);done.add(ref.id);
  }
  for(const ref of refs)await visit(ref,1);
  for(const ref of refs){const saved=rows.get(ref.id)!,body=saved.recipe.payload as Record<string,unknown>;
    if(body.schema!=='plus-transition-recipe-v3'||Object.hasOwn(body,'nativeDependencies'))fail('RECIPE_COMPONENT_TERMINAL_REQUIRED');
    const approved=await decisions!.requireComponentApproved(ref.id,p);
    if(approved.modelComponentApproved!==true||approved.modelApproved!==false||approved.modelDeploymentAuthorized!==false
      ||approved.record._id!==ref.id||approved.record._version!==ref.version||digest(approved.record)!==ref.hash)fail('RECIPE_COMPONENT_NOT_APPROVED');
    const policy=approved.record.policy as {version:string;component:unknown};
    if(policy.version!=='plus-transition-component-admission-v1')fail('RECIPE_COMPONENT_NOT_APPROVED');
    const contract=requireTransitionComponentContract(policy.component,body);
    if(contract.definitionHash!==compiled.definitionHash||contract.scopeKey!==compiled.definition.scope.key
      ||contract.classification!==(payload.config as {classification?:string})?.classification)fail('RECIPE_COMPONENT_SCOPE_MISMATCH');
    qualified.set(ref.id,structuredClone(approved));
  }
  return qualified;
}

type Components=Awaited<ReturnType<typeof collectRecipeComponents>>;
const activeContexts=new WeakMap<object,{scope:string;components:Components}>();
const activeInvocation=new AsyncLocalStorage<object>();
const contextScope=(payload:Record<string,unknown>,compiled:CompiledDefinition,p:PlusPrincipal)=>digest({payload,compiled,principal:{id:p.id,tenantId:p.tenantId,roles:[...p.roles].sort()}});

/** Existing structural/native qualification API: no reusable certificate. */
export async function qualifyRecipeComponents(...args:Parameters<typeof collectRecipeComponents>){await collectRecipeComponents(...args);}

/** Registry-internal call lifetime. The parent registry still fences current
 * native epoch and complete source/identity/policy authority at its boundary.
 * This avoids a second identical native component read in the fixed adapter;
 * never survives the callback and never caches across operations/principals. */
export async function withQualifiedRecipeComponents<T>(storage:StorageProvider,ctx:RequestContext,payload:Record<string,unknown>,compiled:CompiledDefinition,
  p:PlusPrincipal,decisions:Pick<NativeModelDecision,'requireComponentApproved'>|undefined,run:(context:object)=>Promise<T>):Promise<T>{
  const scope=contextScope(payload,compiled,p),components=await collectRecipeComponents(storage,ctx,payload,compiled,p,decisions),context=Object.freeze({});
  if(contextScope(payload,compiled,p)!==scope)fail('RECIPE_COMPONENT_CONTEXT_SCOPE');
  activeContexts.set(context,{scope,components});
  try{return await activeInvocation.run(context,()=>run(context));}finally{activeContexts.delete(context);}
}

/** Only an active in-process registry handle can be consumed. JSON, clones,
 * expired handles and a different recipe/definition/principal fail closed. */
export function readQualifiedRecipeComponent(context:unknown,payload:Record<string,unknown>,compiled:CompiledDefinition,p:PlusPrincipal,id:string){
  if(!context||typeof context!=='object')fail('RECIPE_COMPONENT_CONTEXT_INVALID');
  if(activeInvocation.getStore()!==context)fail('RECIPE_COMPONENT_CONTEXT_INVALID');
  const state=activeContexts.get(context);if(!state)fail('RECIPE_COMPONENT_CONTEXT_INVALID');
  if(state.scope!==contextScope(payload,compiled,p))fail('RECIPE_COMPONENT_CONTEXT_SCOPE');
  const value=state.components.get(id);if(!value)fail('RECIPE_COMPONENT_CONTEXT_SCOPE');return structuredClone(value);
}
