const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fail=message=>{throw Error(message);};
export const transitionRecipeInputKeys=['trainingProtocolKeys','population','supervisionKey','supervisionRevision','stepMs','maxSteps','controls','nativeActions','historyPolicyId','maxPairs','maxTrajectories','smoothingAlpha','minimumPairs','minimumTrajectories','minimumGroups','minimumPerCondition','minimumCoverage'];
const textKeys=['trainingProtocolKeys','supervisionKey','controls','nativeActions','historyPolicyId'];
const list=v=>{if(typeof v!=='string')fail('请填写明确的逗号分隔选项');const a=v.split(',').map(v=>v.trim());if(!a.length||a.some(v=>!v)||new Set(a).size!==a.length)fail('选项不能为空或重复');return a;};
const num=(v,min,max,integer=true)=>{if(typeof v!=='string'||!v.trim()||!Number.isFinite(Number(v))||Number(v)<min||Number(v)>max||integer&&!Number.isSafeInteger(Number(v)))fail('请填写范围内的数值');return Number(v);};
export function prepareNativeTransitionRecipePreview(options,values){
  if(options?.schema!=='plus-recipe-authoring-options-v1'||options.layout?.schema!=='plus-transition-authoring-layout-v1'||!options.canDraft)fail('转移配方不可编辑');
  const protocols=list(values.trainingProtocolKeys).map(key=>{const p=options.trainingProtocols.find(p=>p.key===key);if(!p)fail('训练协议不在授权清单内');return p;}),first=protocols[0];
  if(protocols.some(p=>p.classification!==first.classification||p.collectionPolicyHash!==first.collectionPolicyHash)
    ||options.layout.stateVariables.some(v=>!protocols.some(p=>p.variable===v.key)))fail('每个状态变量均须有同范围的监督协议');
  const controls=list(values.controls),nativeActions=list(values.nativeActions);
  if(!controls.includes('WAIT')||controls.some(k=>!options.layout.controls.includes(k))||nativeActions.some(k=>!options.layout.nativeActions.includes(k))
    ||options.layout.requiredNativeActions.some(k=>!nativeActions.includes(k)))fail('动作选择与当前本体不一致');
  const population=options.populationPolicyHashes[num(values.population,0,options.populationPolicyHashes.length-1)];
  for(const k of ['supervisionKey','historyPolicyId'])if(typeof values[k]!=='string'||!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(values[k]))fail('请填写有效的契约键');
  const config={classification:first.classification,collectionPolicyHash:first.collectionPolicyHash,populationPolicyHash:population,trainingProtocolHashes:protocols.map(p=>p.hash),
    supervisionKey:values.supervisionKey,supervisionRevision:num(values.supervisionRevision,1,1000000),historyPolicyId:values.historyPolicyId,
    stepMs:num(values.stepMs,1,31536000000),maxSteps:num(values.maxSteps,1,1024),controls,nativeActions,
    maxPairs:num(values.maxPairs,1,1000),maxTrajectories:num(values.maxTrajectories,1,1000),smoothingAlpha:num(values.smoothingAlpha,1e-6,1e6,false),
    minimumPairs:num(values.minimumPairs,1,1000),minimumTrajectories:num(values.minimumTrajectories,1,1000),minimumGroups:num(values.minimumGroups,1,1000),minimumPerCondition:num(values.minimumPerCondition,1,1000),minimumCoverage:num(values.minimumCoverage,0,1,false)};
  if(config.maxTrajectories>config.maxPairs||config.minimumPairs>config.maxPairs||config.minimumTrajectories>config.maxTrajectories||config.minimumGroups>config.minimumTrajectories||config.minimumPerCondition>config.maxPairs)fail('样本门槛不能超过声明的预算');
  return {selection:structuredClone(options.input),optionsHash:options.optionsHash,probabilities:null,ruleSpecificationHash:null,config};
}
export function renderNativeTransitionRecipeFields(options,select){
  const labels={trainingProtocolKeys:'训练协议键（从下方清单选择，逗号分隔）',supervisionKey:'纵向监督契约键',supervisionRevision:'监督契约修订',stepMs:'时间步长（毫秒）',maxSteps:'最大时间步数',controls:'拟合控制量（逗号分隔，必须包含 WAIT）',nativeActions:'完整动作历史清单（逗号分隔；包含全部绑定动作）',historyPolicyId:'待审核动作历史策略键',maxPairs:'最大相邻样本对',maxTrajectories:'最大轨迹数',smoothingAlpha:'平滑系数',minimumPairs:'最少样本对',minimumTrajectories:'最少轨迹数',minimumGroups:'最少来源组',minimumPerCondition:'每条件最少样本对',minimumCoverage:'最少覆盖比例（0–1）'};
  return '<p>状态来自本体，参数将由合格纵向数据拟合；这里不填入转移概率。UNKNOWN 不是真实状态，缺少支持时明确不可用。时间网格、控制量和历史范围须独立审核；观察到的动作历史不是因果效果证明。</p><pre>'+escape(JSON.stringify({states:options.layout.stateVariables,contextSupport:options.layout.contextSupport,availableControls:options.layout.controls,availableNativeActions:options.layout.nativeActions,requiredNativeActions:options.layout.requiredNativeActions,trainingProtocols:options.trainingProtocols},null,2))+'</pre>'+
    transitionRecipeInputKeys.map(k=>k==='population'?'<label>批准的总体约束'+select('recipe-population',options.populationPolicyHashes)+'</label>':'<label>'+escape(labels[k])+'<input id="recipe-'+k+'" type="'+(textKeys.includes(k)?'text':'number')+'" '+(textKeys.includes(k)?'maxlength="4096"':'step="any"')+'></label>').join('');
}
