const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fail=message=>{throw Error(message);};
const choose=(items,index)=>{if(typeof index!=='string'||!/^\d+$/.test(index)||!Object.hasOwn(items,Number(index)))fail('请选择当前可见的原生依赖');return items[Number(index)];};
export const completeRecipeInputKeys=['observationRecipe','transitionRecipe','componentDecision','maxSteps','transitionMechanisms'];
export function prepareNativeCompleteRecipePreview(options,values){
  const l=options?.layout;if(options?.schema!=='plus-recipe-authoring-options-v1'||!options.canDraft||l?.schema!=='plus-complete-authoring-layout-v1')fail('完整配方不可编辑');
  const a=choose(l.observations,values.observationRecipe),b=choose(l.transitions,values.transitionRecipe),d=choose(l.components,values.componentDecision);
  if(d.recipe?.hash!==b.recipeHash||d.decision!=='APPROVE'||d.revoked||d.recordedReadiness!=='READY'||!d.configuredPolicyMatches)fail('组件决定与转移配方不匹配');
  const n=values.maxSteps;if(typeof n!=='string'||!n.trim()||!Number.isSafeInteger(Number(n))||Number(n)<1||Number(n)>Math.min(1024,b.component.maxSteps))fail('请填写批准范围内的最大步数');
  return {selection:structuredClone(options.input),optionsHash:options.optionsHash,probabilities:null,ruleSpecificationHash:null,
    config:{observationRecipeHash:a.recipeHash,transitionRecipeHash:b.recipeHash,componentDecisionId:d.id,maxSteps:Number(n),transitionMechanisms:choose(l.transitionMechanisms,values.transitionMechanisms)}};
}
export function renderNativeCompleteRecipeFields(options,select){const l=options.layout;
  return '<p>组合现有观察/规则与学得转移组件，保留机制初始及观察先验。当前支持共享学得点转移核，不宣称已学习机制条件转移或现实因果效果；在线时钟仅支持经核验的 WAIT 历史。</p>'+
    (l.unavailableReasons.length?'<p role="status">尚缺依赖：'+escape(l.unavailableReasons.join('、'))+'。不会自动创建或批准。</p>':'')+
    '<label>观察/规则配方'+select('recipe-observationRecipe',l.observations.map(r=>r.key+' r'+r.revision))+'</label><label>转移配方'+select('recipe-transitionRecipe',l.transitions.map(r=>r.key+' r'+r.revision))+'</label>'+
    '<label>独立组件决定'+select('recipe-componentDecision',l.components.map(r=>r.key+' / '+r.id))+'</label><label>最大时间步数<input id="recipe-maxSteps" type="number" min="1" max="1024" step="1"></label>'+
    '<label>明确选择组合语义'+select('recipe-transitionMechanisms',l.transitionMechanisms)+'</label><p>清单仅为历史元数据。预览、保存和审核分别重新核验当前材料；配方批准不等于整模型准入。</p>';
}
