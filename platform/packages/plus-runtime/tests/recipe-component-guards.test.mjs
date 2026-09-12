import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '@openfoundry/plus-contracts';
import { recipeDependencies,qualifyRecipeComponents } from '../dist/recipe-component-dependencies.js';
import { modelDecisionDeployments } from '../dist/model-lineage.js';
import { sourceDependents } from '../dist/source-lineage.js';

// Structural graph tests with an explicit read-only storage adapter. Native
// FIT/approval/transactions are covered separately, not inferred from these.
const ctx={tenantId:'component-graph-test'},p={id:'reader',tenantId:ctx.tenantId,roles:['trainer']};
const edge={name:'PlusRecipeComponentDecision',fromType:'PlusModelRecipe',toType:'PlusModelDecision',cardinality:'MANY_TO_MANY'};
function graph(){
  const rows=new Map(),links=[];const add=(type,id,data={})=>{const r={_id:id,_type:type,_tenantId:ctx.tenantId,_version:1,...data};rows.set(type+':'+id,r);return r;};
  const link=(type,from,to)=>links.push({_id:type+':'+from+':'+to,_fromId:from,_toId:to,_type:type});
  const storage={getSchema:async()=>({linkTypes:[edge]}),getObject:async(_ctx,type,id)=>structuredClone(rows.get(type+':'+id)),
    getLinks:async(_ctx,id,type,direction)=>{const items=links.filter(l=>l._type===type&&(direction==='outbound'?l._fromId:l._toId)===id);
      return {items:structuredClone(items),totalCount:items.length,hasNextPage:false};}};
  return {rows,links,add,link,storage};
}
function component(g,id,body){
  const recipe=g.add('PlusModelRecipe','recipe-'+id,{payload:body,recipeHash:digest(body)});
  const decision=g.add('PlusModelDecision',id,{inputReadSet:{recipe:{id:recipe._id,version:1,hash:recipe.recipeHash}}});
  g.link('PlusModelDecisionRecipe',id,recipe._id);
  return {kind:'TRANSITION_COMPONENT',id,version:1,hash:digest(decision)};
}

test('component dependency parser remains exact, bounded and rejects untyped or duplicated references',()=>{
  const ref={kind:'TRANSITION_COMPONENT',id:'decision',version:1,hash:digest('row')};
  assert.deepEqual(recipeDependencies({nativeDependencies:[ref]}),[ref]);
  for(const refs of [[],[ref,ref],[{...ref,kind:'DEPLOYMENT'}],[{...ref,approved:true}],[{...ref,version:0}],[{...ref,id:''}],
    Array.from({length:33},(_,i)=>({...ref,id:'d'+i}))])assert.throws(()=>recipeDependencies({nativeDependencies:refs}),/RECIPE_DEPENDENCY_INVALID/);
});

test('nonterminal, broken lineage, missing authority and over-depth component graphs fail before any native approval callback',async()=>{
  const compiled={definitionHash:digest('definition'),definition:{scope:{key:'test'}}};let calls=0;
  const decisions={requireComponentApproved:async()=>{calls++;assert.fail('Malformed graph must not enter recursive approval');}};
  const g=graph(),ref=component(g,'a',{schema:'unimplemented-composition'}),payload={config:{classification:'SYNTHETIC'},nativeDependencies:[ref]};
  await assert.rejects(()=>qualifyRecipeComponents(g.storage,ctx,payload,compiled,p,undefined),/PROVIDER_REQUIRED/);
  await assert.rejects(()=>qualifyRecipeComponents(g.storage,ctx,payload,compiled,p,decisions),/TERMINAL_REQUIRED/);
  g.links[0]._toId='wrong';await assert.rejects(()=>qualifyRecipeComponents(g.storage,ctx,payload,compiled,p,decisions),/LINEAGE_INVALID/);
  const deep=graph();let next;
  for(let i=33;i>=0;i--)next=component(deep,'depth-'+i,{schema:'unimplemented-composition',...(next?{nativeDependencies:[next]}:{})});
  await assert.rejects(()=>qualifyRecipeComponents(deep.storage,ctx,{nativeDependencies:[next]},compiled,p,decisions),/GRAPH_LIMIT/);
  assert.equal(calls,0);
});

test('component withdrawal traversal reaches only current dependent deployment heads and tolerates shared ancestry',async()=>{
  const g=graph();for(const [type,id]of [['PlusModelDecision','component'],['PlusModelRecipe','composed'],['PlusModelRelease','release'],
    ['PlusModelEvaluation','evaluation'],['PlusModelDecision','complete'],['PlusDeployment','dependent'],['PlusDeployment','clean']])g.add(type,id);
  g.link('PlusRecipeComponentDecision','composed','component');g.link('PlusReleaseRecipe','release','composed');
  g.link('PlusModelEvaluationRelease','evaluation','release');g.link('PlusModelDecisionEvaluation','complete','evaluation');
  g.link('PlusDeploymentDecision','dependent','complete');g.link('PlusDeploymentDecision','clean','replacement');
  // Historical selection is not a current head and must never suspend a clean rollback.
  g.link('PlusDeploymentRevisionDecision','old-selection','complete');
  assert.deepEqual((await modelDecisionDeployments(g.storage,ctx,['component','component'])).map(r=>r._id),['dependent']);
  g.links.find(l=>l._type==='PlusDeploymentDecision'&&l._fromId==='dependent')._toId='replacement';
  assert.deepEqual(await modelDecisionDeployments(g.storage,ctx,['component']),[]);
});

test('component withdrawal rejects substituted schema, missing native targets and truncated edge collections',async()=>{
  const g=graph();g.link('PlusRecipeComponentDecision','missing','component');
  await assert.rejects(()=>modelDecisionDeployments(g.storage,ctx,['component']),/MODEL_LINEAGE_INVALID/);
  await assert.rejects(()=>modelDecisionDeployments({...g.storage,getSchema:async()=>({linkTypes:[{...edge,toType:'PlusDeployment'}]})},ctx,['component']),/MODEL_LINEAGE_INVALID/);
  await assert.rejects(()=>modelDecisionDeployments({...g.storage,getLinks:async()=>({items:[],hasNextPage:true,totalCount:1001})},ctx,['component']),/MODEL_LINEAGE_LIMIT/);
  assert.deepEqual(await modelDecisionDeployments({...g.storage,getSchema:async()=>({linkTypes:[]})},ctx,['component']),[]);
});

test('source withdrawal crosses component edges without rewriting recipe approval or completed business actions',async()=>{
  const g=graph();for(const [type,id]of [['PlusDatasetRevision','train'],['PlusModelRelease','component-fit'],['PlusModelEvaluation','component-score'],
    ['PlusModelDecision','component'],['PlusModelRecipe','composed'],['PlusModelRelease','composed-fit'],['PlusDeployment','dependent']])g.add(type,id);
  g.link('PlusDatasetSource','train','source');g.link('PlusReleaseDataset','component-fit','train');
  g.link('PlusModelEvaluationRelease','component-score','component-fit');g.link('PlusModelDecisionEvaluation','component','component-score');
  g.link('PlusRecipeComponentDecision','composed','component');g.link('PlusReleaseRecipe','composed-fit','composed');
  g.link('PlusDeploymentRelease','dependent','composed-fit');
  const rows=await sourceDependents(g.storage,ctx,'source');
  assert.ok(rows.some(r=>r._id==='composed-fit'));assert.ok(rows.some(r=>r._id==='dependent'));
  assert.equal(rows.some(r=>r._type==='PlusModelRecipe'),false);
});
