const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const actor=p=>p?.id&&p.tenantId?JSON.stringify({id:p.id,tenantId:p.tenantId,roles:[...(p.roles??[])].sort()}):null;
const ref=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const key=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const exact=(v,n)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...n].sort().join(',');
const fail=()=>{throw Error('INVALID_MODEL_REVIEW_OPTIONS');};
function metrics(value){const rows=[];let visited=0;function walk(v,path,depth){if(++visited>1000||depth>6||rows.length>=120)return;
  if(typeof v==='number'&&Number.isFinite(v)){rows.push([path,v]);return;}if(v&&typeof v==='object'&&!Array.isArray(v))for(const [k,item]of Object.entries(v))walk(item,path?path+'.'+k:k,depth+1);
}walk(value,'',0);return `<div class="table-wrap"><table><thead><tr><th>记录指标（原始字段名）</th><th>值</th></tr></thead><tbody>${rows.map(([k,v])=>`<tr><td>${escape(k)}</td><td>${escape(v)}</td></tr>`).join('')}</tbody></table></div><p>最多展示 120 个数值指标；完整评分及其摘要以原生记录为准，不从这些数字自动作出批准。</p>`;}

/** Model-owner review, independent of trainer job history and deployment index. */
export function createNativeModelReview({document,api,run,isBusy,getPrincipal,onSubmit,onHistory,newKey=()=>globalThis.crypto.randomUUID()}){
  const $=s=>document.querySelector(s);let bound,options,selected='',intent,error='',notice='',generation=0;
  const context=()=>getPrincipal()?.roles?.includes('model_owner')?actor(getPrincipal()):null;
  const same=()=>bound&&bound===context();
  function reset(){generation++;bound=options=intent=undefined;selected='';error=notice='';}
  function validate(v){
    if(v?.schema!=='plus-model-decision-review-v1'||v.readOnly!==true||v.qualification!=='NOT_CHECKED'||v.predictionReady!==false||v.executionAuthorized!==false
      ||!Array.isArray(v.keys)||v.keys.length>100||v.keys.some(k=>!key(k))||new Set(v.keys).size!==v.keys.length
      ||!Array.isArray(v.items)||v.items.length>100||new Set(v.items.map(i=>i?.optionKey)).size!==v.items.length)fail();
    for(const i of v.items){const s=i?.score,p=i?.protocol,r=i?.recipe,c=i?.command;
      if(!hash(i.optionKey)||!v.keys.includes(i.key)||i.qualification!=='NOT_CHECKED'||!ref(s?.id)||!Number.isSafeInteger(s.version)||s.version<1||!hash(s.contentHash)
        ||!ref(r?.id)||!ref(p?.id)||!hash(r.recipeHash)||!hash(p.contentHash)||!s.evidence||!s.result?.metrics||!p.configuration
        ||!['ELIGIBLE_FOR_REVIEW','REJECT_REGRESSION','INSUFFICIENT_COVERAGE'].includes(s.result.decision)||s.result.deploymentAuthorized!==false
        ||!['TRANSITION_COMPONENT','COMPLETE_MODEL'].includes(i.scope?.modelKind)||!['SYNTHETIC','AUTHORIZED_REAL'].includes(i.scope?.classification)
        ||![i.unavailableReasons,i.approvalUnavailableReasons].every(a=>Array.isArray(a)&&a.length<=20&&a.every(x=>typeof x==='string'&&x.length<=100))
        ||![s.evidence.trainingDatasets,s.evidence.validationDatasets].every(a=>Array.isArray(a)&&a.length<=20&&a.every(x=>ref(x.id))))fail();
      if(c===null){if(!i.unavailableReasons.length)fail();continue;}
      if(i.unavailableReasons.length||!exact(c,['key','evaluationId','evaluationVersion'])||c.key!==i.key||c.evaluationId!==s.id||c.evaluationVersion!==s.version)fail();
      if(s.result.decision!=='ELIGIBLE_FOR_REVIEW'&&!i.approvalUnavailableReasons.length)fail();
    }
  }
  function load(){if(isBusy()||!context()||intent)return;const c=context(),g=++generation;bound=c;options=undefined;selected='';error=notice='';
    return run(async epoch=>{render();try{const value=await api('/learning/decision-jobs/options',epoch);
      if(g!==generation||c!==context())throw Object.assign(Error('审核身份已变化'),{discarded:true});validate(value);options=value;
    }catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)render();}});
  }
  function render(){const container=$('#model-review');if(!container)return;const scoped=same(),chosen=scoped?options?.items.find(i=>i.optionKey===selected):undefined;
    container.innerHTML=`<h2>人工模型审核</h2><p>按当前模型所有者的用途权限读取原生候选和评分，无需训练员作业历史或部署读取权限。历史证据的当前资格为 NOT_CHECKED；后台执行决定时重新核验。</p>
      <button id="model-review-refresh" ${!context()||intent?'disabled':''}>读取可审核候选</button>${!context()?'<p>当前身份不是模型所有者，不能发起审核。</p>':''}
      ${error?`<p class="error" role="alert">${escape(error)}</p>`:''}${notice?`<p role="status">${escape(notice)}</p>`:''}
      ${scoped&&options?`<label>原生候选<select id="model-review-choice" ${intent?'disabled':''}><option value="">请选择</option>${options.items.map(i=>`<option value="${escape(i.optionKey)}" ${i.optionKey===selected?'selected':''}>${escape(i.key)} / ${escape(i.score.id)} / ${escape(i.scope.modelKind)} / ${escape(i.score.result.decision)}</option>`).join('')}</select></label>${options.items.length?'':'<p>没有同时满足当前可见范围的候选；不自动扩大权限或创建样例。</p>'}${options.keys.map(k=>`<button data-decision-history-key="${escape(k)}">${escape(k)} · 我的模型决定</button>`).join('')}`:''}
      ${chosen?`<h3>审核依据</h3><p>数据：${escape(chosen.scope.classification)}；范围：${escape(chosen.scope.scopeKey)}；任务：${escape(chosen.scope.task)}；${chosen.scope.modelKind==='TRANSITION_COMPONENT'?'仅转移组件，不能独立部署':'完整模型审核用途，不代表当前可用'}。</p>
        <dl><dt>本体定义摘要</dt><dd>${escape(chosen.scope.definitionHash)}</dd><dt>参数绑定摘要</dt><dd>${escape(chosen.scope.bindingHash)}</dd><dt>配方与版本</dt><dd>${escape(chosen.recipe.id)} / v${escape(chosen.recipe.version)} / ${escape(chosen.recipe.recipeHash)}</dd><dt>候选工件</dt><dd>${escape(chosen.score.evidence.candidateId)} / ${escape(chosen.score.evidence.artifactHash)}</dd><dt>评分版本及记录人</dt><dd>${escape(chosen.score.id)} / v${escape(chosen.score.version)} / ${escape(chosen.score.createdBy)} / ${escape(chosen.score.createdAt)}</dd></dl>
        <p>记录结论：${escape(chosen.score.result.decision)}。当前资格未检查，记录成功不等于当前可批准。</p>${metrics(chosen.score.result.metrics)}
        <details><summary>冻结协议门槛、时钟与参考版本（只读）</summary><pre>${escape(JSON.stringify({protocol:chosen.protocol.id,version:chosen.protocol.version,configuration:chosen.protocol.configuration,reference:chosen.protocol.reference},null,2))}</pre></details>
        <p>训练引用：${chosen.score.evidence.trainingDatasets.map(r=>escape(r.id)).join('、')}。验证引用：${chosen.score.evidence.validationDatasets.map(r=>escape(r.id)).join('、')}。引用不是源数据读取授权。</p>
        ${chosen.unavailableReasons.length?`<p role="status">暂不可提交：${escape(chosen.unavailableReasons.join('、'))}</p>`:`<form id="model-review-submit"><label>明确决定<select id="model-review-decision" ${intent?'disabled':''}><option value="">请选择批准或拒绝</option><option value="APPROVE" ${chosen.approvalUnavailableReasons.length?'disabled':''}>批准</option><option value="REJECT">拒绝</option></select></label><label>审核理由<textarea id="model-review-reason" maxlength="2000" required ${intent?'disabled':''}></textarea></label><label><input id="model-review-confirm" type="checkbox" required ${intent?'disabled':''}>确认已检查依据；本决定不自动生效模型或执行业务动作</label><button type="submit" ${intent?'disabled':''}>提交人工决定</button></form>${chosen.approvalUnavailableReasons.length?`<p>不可批准的已知原因：${escape(chosen.approvalUnavailableReasons.join('、'))}。</p>`:''}`}`:''}
      ${intent?'<p>已有明确意图；请在下方查询原请求。刷新不自动重发，未知结果不当作取消。</p>':''}`;
    $('#model-review-refresh').onclick=()=>{void load();};
    const select=$('#model-review-choice');if(select)select.onchange=()=>{if(isBusy()||intent||!same())return;selected=options.items.some(i=>i.optionKey===select.value)?select.value:'';render();};
    const form=$('#model-review-submit');if(form)form.onsubmit=e=>{e.preventDefault();if(isBusy()||intent||!same()||!chosen?.command)return;
      const decision=$('#model-review-decision').value,reason=$('#model-review-reason').value?.trim();
      if(!['APPROVE','REJECT'].includes(decision)||decision==='APPROVE'&&chosen.approvalUnavailableReasons.length||!reason||reason.length>2000||!$('#model-review-confirm').checked)return;
      const requestKey=newKey();if(!ref(requestKey)){error='INVALID_IDEMPOTENCY_KEY';render();return;}
      const proposed={mode:'DECIDE',input:{...structuredClone(chosen.command),requestKey,decision,reason}};
      if(onSubmit(structuredClone(proposed))){intent=proposed;notice='人工决定已交给原生作业提交层；下方可按原请求查询。';}
      else notice='未发起新决定；请处理下方原请求或存储提示后再提交。';render();
    };
    document.querySelectorAll?.('[data-decision-history-key]').forEach(button=>{if(!button.dataset.decisionHistoryKey)return;button.onclick=()=>{
      if(!isBusy()&&same()&&options?.keys.includes(button.dataset.decisionHistoryKey))void onHistory(button.dataset.decisionHistoryKey);
    };});
  }
  return {render,reset,load};
}
