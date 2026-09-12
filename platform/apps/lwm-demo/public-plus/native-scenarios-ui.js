const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const json=v=>'<pre>'+escape(JSON.stringify(v,null,2))+'</pre>';
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v),hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const reference=v=>v&&id(v.id)&&Number.isSafeInteger(v.version)&&v.version>0;
const same=(a,b)=>a?.type===b?.type&&a?.id===b?.id&&a?.version===b?.version;
const discarded=()=>Object.assign(Error('当前对象或身份已变化'),{discarded:true});
const slot='plus-scenario-intent-v1';

// Actual native comparison; no background replay, approval or business action.
// Only a minimal actor/root-bound original key survives refresh. Hypothesis and
// exact retry payload stay in memory; restored intent can only be looked up.
export function createNativeScenarioWorkbench({document,api,run,isBusy,getDetail,getPrincipal,onGoActions=()=>{},getStorage=()=>globalThis.sessionStorage,requestKey=()=>globalThis.crypto.randomUUID()}){
  const $=s=>document.querySelector(s);let identity='',generation=0,catalog,selected='',assumptionId='',pending,bookmark,receipt,result,error='',recoveryError=false;
  const actor=()=>JSON.stringify([getPrincipal()?.tenantId,getPrincipal()?.id,[...(getPrincipal()?.roles??[])].sort()]);
  const context=()=>JSON.stringify([actor(),getDetail()?.reference]);
  // Identity/object-scoped keys survive native version changes, but cached
  // predictions and retry payloads never do. This workbench is not yet deployed;
  // no released single-slot bookmark format is migrated or silently discarded.
  const storageKey=()=>slot+':'+encodeURIComponent(JSON.stringify([actor(),getDetail()?.reference?.type,getDetail()?.reference?.id]));
  function restore(){bookmark=undefined;recoveryError=false;if(!getDetail()?.reference)return;try{const raw=getStorage()?.getItem(storageKey());if(raw==null)return;const v=JSON.parse(raw),r=getDetail().reference;
    if(v?.schema!==slot||v.actor!==actor()||v.root?.type!==r.type||v.root?.id!==r.id||!reference(v.root)||Object.keys(v).sort().join(',')!=='actor,requestKey,root,schema'||typeof v.requestKey!=='string'||!v.requestKey.trim()||v.requestKey.length>256)throw Error('invalid recovery');bookmark=v;
  }catch{recoveryError=true;error='恢复信息不可读，已停止新计算；请保留原会话并核对原请求，不要清空后重提。';}}
  function reset(){generation++;identity='';catalog=pending=bookmark=receipt=result=undefined;selected=assumptionId='';error='';recoveryError=false;}
  function sync(){const c=context();if(c!==identity){reset();identity=c;restore();}}
  const root=()=>({rootType:getDetail().reference.type,rootId:getDetail().reference.id});
  function check(g,c){if(g!==generation||c!==context())throw discarded();}
  const choice=()=>catalog?.items.find(i=>i.optionKey===selected);
  function validateOptions(v){
    if(v?.schema!=='plus-scenario-workbench-options-v1'||!same(v.root,getDetail()?.reference)||v.readOnly!==true||v.predictionReady!==false||v.executionAuthorized!==false||v.qualification!=='NOT_CHECKED'
      ||!Array.isArray(v.items)||v.items.length>1000||new Set(v.items.map(i=>i.optionKey)).size!==v.items.length)throw Error('INVALID_SCENARIO_OPTIONS');
    for(const i of v.items)if(!hash(i.optionKey)||!same(i.root,v.root)||!reference(i.episode)||i.qualification!=='NOT_CHECKED'||i.predictionReady!==false||!Array.isArray(i.unavailableReasons)
      ||!['SYNTHETIC','AUTHORIZED_REAL'].includes(i.classification)||i.head&&(!reference(i.head.belief)||!reference(i.head.snapshot))
      ||i.command&&(i.command.key!==i.key||i.command.episodeId!==i.episode.id||i.command.beliefId!==i.head?.belief.id||i.unavailableReasons.length))throw Error('INVALID_SCENARIO_OPTIONS');
    for(const i of v.items)if(i.adaptiveAssumptions!==undefined&&(!Array.isArray(i.adaptiveAssumptions)||!i.adaptiveAssumptions.length||i.adaptiveAssumptions.length>20
      ||new Set(i.adaptiveAssumptions.map(a=>a.id)).size!==i.adaptiveAssumptions.length||i.adaptiveAssumptions.some(a=>typeof a.id!=='string'||!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(a.id)
        ||![a.recipeHash,a.definitionHash,a.clockHash,a.assumptionHash].every(hash)||a.availabilitySemantics!=='HYPOTHETICAL_STATE_INDEPENDENT_INDEPENDENT_REQUESTS'
        ||!Array.isArray(a.steps)||!a.steps.length||a.steps.length>4||a.steps.some(s=>s.control!=='WAIT'||!Number.isFinite(s.availabilityProbability)||s.availabilityProbability<0||s.availabilityProbability>1))))throw Error('INVALID_SCENARIO_OPTIONS');
    return v;
  }
  function validateResult(v){const p=v?.predictions;
    if(v?.schema!=='plus-scenario-workbench-result-v1'||!same(v.root,getDetail()?.reference)||!reference(v.scenario)||v.scenario.id!==receipt?.id||v.scenario.version!==receipt?.version
      ||v.currentBasisChecked!==true||v.nativeAdmissionChecked!==true||v.readOnly!==true||v.businessFactsWritten!==false||v.executionAuthorized!==false||!['SYNTHETIC','AUTHORIZED_REAL'].includes(v.classification)
      ||p?.businessFactsWritten!==false||p.executionAuthorized!==false||p.nativeAdmissionChecked!==false
      ||['belief','definition','recipe','release','selection'].some(k=>!reference(v.basis?.[k]))||!hash(v.basis.utilityHash)||v.basis.utilityHash!==p.publishedUtilityHash)throw Error('INVALID_SCENARIO_RESULT');
    if(p.schema==='plus-adaptive-verification-comparison-v1'){
      if(p.semantics!=='ADAPTIVE_INFORMATION_POLICY_NOT_LEARNED_CAUSAL_ACTION_EFFECT'||p.mechanismDynamicsLearnedByPlanner!==false||Object.hasOwn(p,'options')
        ||p.assumptions?.physicalTransition!=='WAIT_ONLY'||p.assumptions.futureContexts!=='HYPOTHETICAL_NOT_OBSERVED'
        ||p.assumptions.availability!=='HYPOTHETICAL_STATE_INDEPENDENT_INDEPENDENT_REQUESTS'||p.assumptions.costIncurred!=='ON_EACH_REQUEST'
        ||p.assumptions.verification!=='INSTANTANEOUS_GOLD_AT_REQUEST_STEP_IF_OBTAINED'||p.assumptions.objective!=='TERMINAL_PUBLISHED_LOSS_PLUS_REQUEST_COSTS'
        ||!Number.isSafeInteger(p.initialStep)||p.initialStep<0||!Number.isSafeInteger(p.targetStep)||p.targetStep<=p.initialStep||p.targetStep-p.initialStep>4
        ||!['planHash','assumptionHash','publishedUtilityHash','startingBeliefHash','modelHash'].every(k=>hash(p[k]))
        ||!['adaptiveExpectedLoss','bestFixedLoss','expectedLossReduction'].every(k=>Number.isFinite(p[k])&&p[k]>=-1e-10)
        ||p.adaptiveExpectedLoss>p.bestFixedLoss+1e-10||Math.abs(p.bestFixedLoss-p.adaptiveExpectedLoss-p.expectedLossReduction)>1e-9
        ||p.timeProjection?.schema!=='plus-adaptive-scenario-time-projection-v1'||p.timeProjection.semantics!=='HYPOTHETICAL_FUTURE_BOUNDARIES_NOT_OBSERVED_EVENTS'
        ||!Array.isArray(p.timeProjection.steps)||p.timeProjection.steps.length!==p.targetStep-p.initialStep
        ||p.timeProjection.steps.some((s,i)=>s.step!==p.initialStep+i+1||!Number.isFinite(Date.parse(s.targetTime)))
        ||!Array.isArray(p.assumptions.steps)||p.assumptions.steps.length!==p.timeProjection.steps.length
        ||!Array.isArray(p.fixedSchedules)||p.fixedSchedules.length!==2**p.assumptions.steps.length||!p.policy||p.policy.kind!=='DECISION')throw Error('INVALID_SCENARIO_RESULT');
    }else if(p.schema!=='plus-verification-comparison-v1'
      ||p.semantics!=='HYPOTHETICAL_INFORMATION_VALUE_NOT_VERIFIED_ACTION_EFFECT'||p.assumptions?.physicalTransition!=='NONE'||p.assumptions.target!=='SAME_TARGET_TIME'
      ||!Number.isFinite(p.assumptions.availabilityProbability)||p.assumptions.availabilityProbability<0||p.assumptions.availabilityProbability>1
      ||!Array.isArray(p.options)||p.options.length!==2||new Set(p.options.map(o=>o.key)).size!==2||p.options.some(o=>!['NO_ADDITIONAL_VERIFICATION','REQUEST_VERIFICATION'].includes(o.key)||!Number.isFinite(o.expectedLoss)||o.expectedLoss<0)
      ||!['CONDITIONAL_ON_ASSUMPTIONS','NO_PRACTICAL_DIFFERENCE'].includes(p.ranking)||p.recommendation!==null&&!p.options.some(o=>o.key===p.recommendation)
      )throw Error('INVALID_SCENARIO_RESULT');
    return v;
  }
  function perform(fn){if(isBusy())return;sync();const g=generation,c=context();return run(async epoch=>{
    error='';try{await fn(epoch,()=>check(g,c));}catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)render();}
  });}
  function load(){sync();if(!getDetail()?.reference||bookmark||recoveryError)return;return perform(async(epoch,valid)=>{catalog=undefined;selected='';render();const v=await api('/learning/scenarios/options?'+new URLSearchParams(root()),epoch);valid();catalog=validateOptions(v);});}
  function lookup(){sync();if(!bookmark||recoveryError)return;const originalKey=bookmark.requestKey;return perform(async(epoch,valid)=>{result=undefined;const v=await api('/learning/scenarios/lookup',epoch,{...root(),requestKey:originalKey});valid();
    if(v?.schema!=='plus-scenario-workbench-lookup-v1'||!same(v.root,getDetail()?.reference)||v.readOnly!==true||v.absenceIsNotCancellation!==true||v.predictionReady!==false||v.executionAuthorized!==false||v.item&&(!reference(v.item)||v.item.qualification!=='NOT_CHECKED'))throw Error('INVALID_SCENARIO_LOOKUP');
    if(v.item){receipt={id:v.item.id,version:v.item.version};pending=undefined;}else error='暂未找到原结果，不代表未提交或已取消；请稍后继续查原请求。';
  });}
  function read(){sync();if(!receipt||recoveryError)return;const scenarioId=receipt.id;return perform(async(epoch,valid)=>{result=undefined;render();const v=await api('/learning/scenarios/view',epoch,{...root(),scenarioId});valid();result=validateResult(v);});}
  function send(){sync();if(!pending)return;const intent=structuredClone(pending);return perform(async(epoch,valid)=>{result=undefined;const v=await api('/learning/scenarios',epoch,intent);valid();
    if(!reference(v)||v.readiness!=='READY'||v.executionAuthorized!==false||v.businessFactsWritten!==false)throw Error('INVALID_SCENARIO_RECEIPT');receipt={id:v.id,version:v.version};pending=undefined;
  });}
  function submit(event){event.preventDefault();if(isBusy())return;sync();const c=choice();if(bookmark||recoveryError||!c?.command||!$('#scenario-confirm')?.checked)return;
    const assumption=c.adaptiveAssumptions?.find(a=>a.id===assumptionId);
    if(assumptionId&&!assumption){error='推演假设不在当前授权目录中。';render();return;}
    const value=assumption?'0':$('#scenario-availability').value.trim(),n=Number(value);if(value===''||!Number.isFinite(n)||n<0||n>1){error='核验可获得概率必须是 0 到 1 的明确假设。';render();return;}
    const key=requestKey(),mark={schema:slot,actor:actor(),root:structuredClone(getDetail().reference),requestKey:key};
    try{const storage=getStorage();if(!storage||typeof key!=='string'||!key.trim()||key.length>256)throw Error('missing storage');storage.setItem(storageKey(),JSON.stringify(mark));if(storage.getItem(storageKey())!==JSON.stringify(mark))throw Error('not saved');}
    catch{error='无法保存原请求键，未提交计算。';render();return;}
    bookmark=mark;pending={...structuredClone(c.command),requestKey:key,...(assumption?{schema:'plus-native-adaptive-scenario-input-v1',assumptionId:assumption.id,assumptionHash:assumption.assumptionHash}:{availabilityProbability:n})};void send();
  }
  function render(){sync();const r=getDetail()?.reference,c=choice();$('#content').innerHTML=`<section class="panel"><h2>本体驱动的决策与推演</h2><p>当前对象：${escape(r?r.type+' / '+r.id+' / v'+r.version:'请先从对象浏览器选择')}</p><p>同一目标时点比较“不追加核验”和“请求独立核验”。这是信息价值推演，不模拟已验证的物理行动效果。成本与目标来自已审核机制，模型来自原生版本选择。</p>${error?'<p role="alert" class="error">'+escape(error)+'</p>':''}
    <button id="scenario-load" ${!r||bookmark||recoveryError?'disabled':''}>读取授权推演目录</button>
    ${catalog?`<label>已登记过程和状态<select id="scenario-choice" ${bookmark?'disabled':''}><option value="">请选择</option>${catalog.items.map(i=>`<option value="${escape(i.optionKey)}" ${selected===i.optionKey?'selected':''}>${escape(i.key+' / '+i.episode.id+' / '+(i.head?.recordedReadiness??'尚无状态'))}</option>`).join('')}</select></label><p>目录状态未重新核验模型，不是执行许可。${catalog.items.length?'需要更新状态时，请在学习模块核对当前模型选择及在线许可。':'当前身份和对象范围内没有可见过程；空目录不代表平台尚未训练模型。请先核对所选对象及模型用途授权，不要据此重复训练或修改权限。'}</p>`:''}
    ${c?`<p>数据分类：${escape(c.classification)}；${escape(c.head?'目标 '+c.head.targetTime+'，知识截止 '+c.head.visibleAt:'无已登记状态')}。</p>${c.unavailableReasons.length?'<p>'+escape(c.unavailableReasons.join(' / '))+'</p>':''}`:''}
    ${c?.command&&!bookmark?`<form id="scenario-form">${c.adaptiveAssumptions?`<label>推演模式<select id="scenario-assumption"><option value="">同一时点的信息价值</option>${c.adaptiveAssumptions.map(a=>`<option value="${escape(a.id)}" ${a.id===assumptionId?'selected':''}>多步条件策略 / ${escape(a.id)}</option>`).join('')}</select></label>`:''}${assumptionId?`<p>未来上下文与核验可得性均为已登记假设，不是未来事实；失败的核验也计入成本。提交时重新检查当前模型、时钟和预算。</p>${json(c.adaptiveAssumptions.find(a=>a.id===assumptionId))}`:'<label>取得独立有效核验的概率（明确假设，不是模型置信度）<input id="scenario-availability" type="number" min="0" max="1" step="any" required></label>'}<label><input id="scenario-confirm" type="checkbox" required>确认使用上述对象/状态和假设计算，不执行业务动作</label><button type="submit">计算并保存新方案</button></form>`:''}
    ${bookmark?`<p>已保留原计算请求键；刷新仅查原结果，不会自动重算。</p><button id="scenario-lookup">查原请求结果</button>${pending?'<button id="scenario-retry">重试完全相同的原请求</button>':''}`:''}
    ${receipt?`<p>原生方案 ${escape(receipt.id)} / v${escape(receipt.version)}，已持久化；尚需当前资格核验才显示预测。</p><button id="scenario-read">重新核验并查看方案</button><button id="scenario-new">开始下一次比较</button>`:''}</section>
    ${result?.predictions.schema==='plus-adaptive-verification-comparison-v1'?adaptiveResult(result):result?`<section class="panel"><h2>条件预测 · ${escape(result.classification)}</h2><p>本次读取通过当前资格检查，未来执行仍须再次核验。未修改业务事实，也未授予行动权限。</p><div class="table-wrap"><table><thead><tr><th>方案</th><th>期望损失（${escape(result.predictions.unit)}）</th></tr></thead><tbody>${result.predictions.options.map(o=>`<tr><td>${o.key==='REQUEST_VERIFICATION'?'请求独立核验':'不追加核验'}</td><td>${escape(o.expectedLoss)}</td></tr>`).join('')}</tbody></table></div><p>${result.predictions.recommendation===null?'不足以形成有实际意义的排序。':'条件建议：'+(result.predictions.recommendation==='REQUEST_VERIFICATION'?'请求独立核验':'不追加核验')} 这不是业务效果或置信区间证明。</p><details><summary>假设与数值分支</summary>${json({assumptions:result.predictions.assumptions,options:result.predictions.options,ranking:result.predictions.ranking})}</details><details><summary>本体、模型、状态与效用来源</summary>${json(result.basis)}</details><button id="scenario-actions">到行动工作台创建提案</button><p>更改原生对象、来源或模型后须重新计算；创建提案与人工审批仍是独立步骤。</p></section>`:''}`;
    $('#scenario-load').onclick=()=>void load();const choose=$('#scenario-choice');if(choose)choose.onchange=()=>{if(isBusy()||bookmark)return;selected=choose.value;assumptionId='';error='';result=undefined;render();};
    const mode=$('#scenario-assumption');if(mode)mode.onchange=()=>{if(isBusy()||bookmark)return;assumptionId=mode.value;error='';render();};
    const form=$('#scenario-form');if(form)form.onsubmit=submit;
    for(const [selector,fn]of [['#scenario-lookup',lookup],['#scenario-retry',send],['#scenario-read',read]]){const n=$(selector);if(n)n.onclick=()=>void fn();}
    const next=$('#scenario-new');if(next)next.onclick=()=>{sync();if(isBusy()||!receipt)return;try{const storage=getStorage();storage.removeItem(storageKey());if(storage.getItem(storageKey())!==null)throw Error('not removed');}catch{error='无法清除已确认请求键';render();return;}bookmark=receipt=result=pending=undefined;catalog=undefined;selected='';render();};
    const action=$('#scenario-actions');if(action)action.onclick=()=>{sync();if(!isBusy()&&result)onGoActions(result.scenario);};
  }
  return {render,reset,load,lookup,read};
}

function adaptiveResult(result){const p=result.predictions;return `<section class="panel"><h2>多步条件核验策略 · ${escape(result.classification)}</h2><p>绑定当前完整模型和状态；以下时间与分支是假想预测，不是已发生事件，不授予行动权限。</p><table><thead><tr><th>策略</th><th>期望损失（${escape(p.unit)}）</th></tr></thead><tbody><tr><td>随核验结果调整的策略</td><td>${escape(p.adaptiveExpectedLoss)}</td></tr><tr><td>最佳固定核验日程</td><td>${escape(p.bestFixedLoss)}</td></tr></tbody></table><p>条件损失差：${escape(p.expectedLossReduction)}。不是已验证业务收益，也不代表学得机制条件动力学。</p><details><summary>假设、未来边界与条件分支</summary>${json({assumptions:p.assumptions,timeProjection:p.timeProjection,policy:p.policy,fixedSchedules:p.fixedSchedules})}</details><details><summary>本体、模型、状态与效用来源</summary>${json(result.basis)}</details><p>本策略不能直接生成执行提案。实际核验结果到达后，重新读取当前状态；单次行动仍须独立提案、审批与执行前重验。</p></section>`;}
