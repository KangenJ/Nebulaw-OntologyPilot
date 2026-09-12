import test from 'node:test';
import assert from 'node:assert/strict';
import { compileTransitionSupervision,digest,validateTransitionTimeContract } from '../../platform/packages/plus-contracts/dist/index.js';
import { transitionFixture,rehash } from './transition-fit-fixture.mjs';
import { transitionRecipe,validateTransitionRecipe,fitTransitionModel,transitionPairKey } from './transition-fit.mjs';

function fixture(){
  const f=transitionFixture(),s=f.supervision.specification;
  const timeContract={schema:'plus-transition-time-v1',definitionHash:f.compiled.definitionHash,bindingHash:s.bindingHash,stepMs:s.stepMs,maxSteps:8,
    origin:'EPISODE_STARTED_AT',alignment:'EXACT_GRID',contextKnowledge:'INTERVAL_START',endpointKnowledge:'PRELABEL_SNAPSHOT',actionWindow:'HALF_OPEN',actionTimestamp:'NATIVE_EXECUTION_RECEIPT'};
  const supervision=compileTransitionSupervision({...s,timeContractHash:digest(timeContract)},f.compiled);
  const {recipe}=transitionRecipe(f.compiled,supervision,f.recipe.config,timeContract);
  const material=intervals=>{const m=f.material('round-1',intervals);m.supervisionHash=supervision.contentHash;
    for(let i=0;i<m.enrollment.plannedPairs.length;i++){const p=m.enrollment.plannedPairs[i],key=transitionPairKey(supervision.contentHash,p.root,p.fromTime,p.toTime);
      p.pairKey=key;m.samples[i].pairKey=key;if(m.samples[i].evidence)m.samples[i].evidence.supervisionHash=supervision.contentHash;}
    return rehash(m);};
  return {...f,timeContract,supervision,recipe,material};
}
test('v2 contains the exact reviewed clock body and actual fit binds its new recipe hash',()=>{
  const f=fixture();assert.equal(f.recipe.schema,'plus-transition-recipe-v2');assert.deepEqual(validateTransitionTimeContract(f.timeContract,f.supervision,f.compiled),f.timeContract);
  const result=fitTransitionModel(f.recipe,[f.material([{id:'a'}])]);assert.equal(result.recipeHash,digest(f.recipe));assert.equal(result.trainingAuthorized,false);
  assert.equal(result.table.reduce((n,r)=>n+r.observations,0),1);
});
for(const [field,value]of [['origin','WALL_CLOCK_NOW'],['alignment','ROUND_NEAREST'],['contextKnowledge','END_OF_INTERVAL'],['endpointKnowledge','LATEST_GOLD'],
  ['actionWindow','CLOSED'],['actionTimestamp','APPROVAL_TIME'],['maxSteps',0],['maxSteps',1025],['stepMs',0]]){
  test('self-rehashed unsupported time semantics reject '+field+'='+value,()=>{
    const f=fixture(),time={...f.timeContract,[field]:value},supervision=compileTransitionSupervision({...f.supervision.specification,timeContractHash:digest(time)},f.compiled);
    assert.throws(()=>transitionRecipe(f.compiled,supervision,f.recipe.config,time));
  });
}
test('time body cannot diverge from approved binding, definition, hash or step even when outer recipe is rehashed',()=>{
  const f=fixture();
  for(const patch of [{bindingHash:digest('other')},{definitionHash:digest('other')},{stepMs:30000},{maxSteps:4},{extra:true}]){
    const recipe=structuredClone(f.recipe);Object.assign(recipe.timeContract,patch);assert.throws(()=>validateTransitionRecipe(recipe,f.compiled));
  }
  const legacy=transitionFixture().recipe;assert.doesNotThrow(()=>validateTransitionRecipe(legacy,legacy.compiled));
  assert.throws(()=>validateTransitionRecipe({...legacy,timeContract:f.timeContract},legacy.compiled));
});
test('maximum temporal horizon applies to every planned interval including missing GOLD',()=>{
  const f=fixture();assert.throws(()=>fitTransitionModel(f.recipe,[f.material([{id:'a',time:480}])]),e=>e.code==='TRANSITION_FIT_TIME_BUDGET');
  assert.throws(()=>fitTransitionModel(f.recipe,[f.material([{id:'a'},{id:'b',time:480,missing:true}])]),e=>e.code==='TRANSITION_FIT_TIME_BUDGET');
});

test('v3 approves complete action history body and retains the v2 time horizon on actual fitting',()=>{
  const f=fixture(),history={version:'plus-native-action-interval-policy-v1',id:'reviewed-actions',rootType:f.compiled.definition.rootType,
    rootEpisodeLink:'TaskPlusEpisode',nativeActions:[...new Set(f.compiled.definition.actions.map(a=>a.nativeAction))],inventory:'TENANT_WIDE',orphanPolicy:'REJECT_INTERVAL'};
  if(!history.nativeActions.length)history.nativeActions.push('ReviewedOtherAction');
  const {recipe}=transitionRecipe(f.compiled,f.supervision,f.recipe.config,f.timeContract,history);
  assert.equal(recipe.schema,'plus-transition-recipe-v3');assert.deepEqual(recipe.actionHistoryContract,history);
  const next=transitionRecipe(f.compiled,f.supervision,f.recipe.config,f.timeContract,{...history,version:'plus-native-action-interval-policy-v2'}).recipe;
  assert.notEqual(digest(next),digest(recipe));assert.equal(next.actionHistoryContract.version,'plus-native-action-interval-policy-v2');
  assert.throws(()=>fitTransitionModel(next,[f.material([{id:'a'}])]),/COMPLETE_PLAN_REQUIRED/);
  const current=transitionRecipe(f.compiled,f.supervision,f.recipe.config,f.timeContract,{...history,version:'plus-native-action-interval-policy-v3'}).recipe;
  assert.notEqual(digest(current),digest(next));assert.doesNotThrow(()=>validateTransitionRecipe(current,f.compiled));
  assert.throws(()=>fitTransitionModel(current,[f.material([{id:'a'}])]),/COMPLETE_PLAN_REQUIRED/);
  assert.equal(fitTransitionModel(recipe,[f.material([{id:'a'}])]).recipeHash,digest(recipe));
  assert.throws(()=>fitTransitionModel(recipe,[f.material([{id:'a',time:480}])]),e=>e.code==='TRANSITION_FIT_TIME_BUDGET');
  assert.throws(()=>fitTransitionModel(recipe,[f.material([{id:'a'},{id:'b',time:480,missing:true}])]),e=>e.code==='TRANSITION_FIT_TIME_BUDGET');
  for(const patch of [{rootType:'WrongRoot'},{nativeActions:[]},{nativeActions:[history.nativeActions[0],history.nativeActions[0]]},
    {inventory:'FIRST_PAGE'},{orphanPolicy:'IGNORE'},{extra:true}]){
    assert.throws(()=>transitionRecipe(f.compiled,f.supervision,f.recipe.config,f.timeContract,{...history,...patch}));
  }
  assert.throws(()=>transitionRecipe(f.compiled,f.supervision,f.recipe.config,undefined,history));
  assert.throws(()=>validateTransitionRecipe({...f.recipe,actionHistoryContract:history},f.compiled));
  if(f.compiled.definition.actions.length)assert.throws(()=>transitionRecipe(f.compiled,f.supervision,f.recipe.config,f.timeContract,{...history,nativeActions:['UnrelatedAction']}));
});
