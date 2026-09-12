const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const actor=p=>JSON.stringify(p?{id:p.id,tenantId:p.tenantId,roles:[...(p.roles??[])].sort()}:null);
const ref=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const key=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const exact=(v,names)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...names].sort().join(',');

/** Select native prospective protocol + its COMPLETE frozen validation group.
 * No editable labels, thresholds, caller engine, model approval or worker tools. */
export function createNativeEvaluationWorkbench({document,api,run,isBusy,getPrincipal,getExecution,onSubmit,onHistory,newKey=()=>globalThis.crypto.randomUUID()}){
  const $=s=>document.querySelector(s);let bound,options,selected='',intent,error='',notice='',generation=0;
  const context=()=>{const p=getPrincipal(),v=getExecution();return p?.roles?.includes('trainer')&&v&&ref(v.executionId)&&ref(v.datasetId)?{...v,actor:actor(p)}:null;};
  const same=c=>c&&JSON.stringify(c)===JSON.stringify(context());
  function reset(){generation++;bound=options=intent=undefined;selected='';error=notice='';}
  function current(g,c){if(g!==generation||!same(c))throw Object.assign(Error('评测训练记录或身份已变化'),{discarded:true});}
  function validate(v,c){
    if(v?.schema!=='plus-evaluation-submission-options-v1'||v.datasetId!==c.datasetId||v.executionId!==c.executionId||v.readOnly!==true||v.evaluationAuthorized!==false
      ||v.predictionReady!==false||v.executionAuthorized!==false||!Array.isArray(v.keys)||v.keys.length>100||v.keys.some(k=>!key(k))||new Set(v.keys).size!==v.keys.length
      ||!Array.isArray(v.items)||v.items.length>100||new Set(v.items.map(i=>i?.optionKey)).size!==v.items.length)throw Error('INVALID_EVALUATION_OPTIONS');
    for(const i of v.items){const p=i?.protocol,cmd=i?.command;
      if(!hash(i.optionKey)||!v.keys.includes(i.key)||i.qualification!=='NOT_CHECKED'||typeof i.recordedAvailable!=='boolean'||!Array.isArray(i.unavailableReasons)
        ||i.unavailableReasons.some(r=>typeof r!=='string'||r.length>100)||!ref(p?.id)||!Number.isSafeInteger(p.version)||p.version<1||!Number.isSafeInteger(p.revision)||p.revision<1
        ||!hash(p.contentHash)||typeof i.evaluatorId!=='string'||!['SYNTHETIC','AUTHORIZED_REAL'].includes(i.classification))throw Error('INVALID_EVALUATION_OPTIONS');
      if(!i.recordedAvailable){if(cmd!==null||!i.unavailableReasons.length)throw Error('INVALID_EVALUATION_OPTIONS');continue;}
      if(i.unavailableReasons.length||p.status!=='APPROVED'||p.readiness!=='READY'||!exact(cmd,['key','protocolId','executionId','validationDatasetIds'])
        ||cmd.key!==i.key||cmd.protocolId!==p.id||cmd.executionId!==c.executionId||!Array.isArray(cmd.validationDatasetIds)||!cmd.validationDatasetIds.length
        ||cmd.validationDatasetIds.length>10||cmd.validationDatasetIds.some(id=>!ref(id))||new Set(cmd.validationDatasetIds).size!==cmd.validationDatasetIds.length)throw Error('INVALID_EVALUATION_OPTIONS');
    }
  }
  function load(){if(isBusy()||!context()||intent)return;const c=context();return run(async epoch=>{const g=generation;bound=c;options=undefined;selected='';error=notice='';render();
    try{const v=await api('/learning/evaluation-jobs/options?'+new URLSearchParams({datasetId:c.datasetId,executionId:c.executionId}),epoch);current(g,c);validate(v,c);options=v;}
    catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)render();}});}
  function render(){const container=$('#evaluation-workbench');if(!container)return;const c=context(),scoped=same(bound),chosen=options?.items.find(i=>i.optionKey===selected);
    container.innerHTML=`<h3>提交原生模型评测</h3><p>先在训练历史中选择自己的 SUCCEEDED 作业。目录按其真实配方匹配已登记评测协议及完整验证批次，不读取标签或修改门槛。组件评分不能代替整体模型评测；任务范围以协议和评测器为准。</p>
      <p>${c?'当前训练作业：'+escape(c.executionId):'尚未选择当前身份的已完成训练作业。'}</p><button id="evaluation-options-refresh" ${!c||intent?'disabled':''}>读取原生评测选项</button>
      ${error?`<p class="error" role="alert">${escape(error)}</p>`:''}${notice?`<p role="status">${escape(notice)}</p>`:''}
      ${options&&scoped?`<label>原生评测协议<select id="evaluation-option" ${intent?'disabled':''}><option value="">请选择</option>${options.items.map(i=>`<option value="${escape(i.optionKey)}" ${i.optionKey===selected?'selected':''} ${!i.recordedAvailable?'disabled':''}>${escape(i.key)} / r${escape(i.protocol.revision)} / ${escape(i.evaluatorId)} / ${escape(i.classification)}${i.unavailableReasons.length?' / '+escape(i.unavailableReasons.join(', ')):''}</option>`).join('')}</select></label>${!options.items.length?'<p>没有与此训练配方匹配的可见协议；不会自动生成批准或使用示例。</p>':''}<p>目录资格 NOT_CHECKED；登记状态不是当前评测资格。</p>${options.keys.map(k=>`<button data-evaluation-history-key="${escape(k)}">${escape(k)} · 我的评测作业</button>`).join('')}`:''}
      ${chosen?.recordedAvailable&&scoped?`<p>完整验证数据集：${chosen.command.validationDatasetIds.map(escape).join('、')}。提交后后台重新核验协议、配方、来源、时间分区和权限。</p><form id="evaluation-submit"><label><input id="evaluation-confirm" type="checkbox" required>确认提交该协议和完整批次；不批准、生效模型或执行业务动作</label><button type="submit">提交评测作业</button></form>`:''}
      ${intent?'<p>保留本页原始意图；提交状态请在下方原请求查询中确认，不换键新建。</p>':''}`;
    $('#evaluation-options-refresh').onclick=()=>{void load();};
    const select=$('#evaluation-option');if(select)select.onchange=()=>{if(isBusy()||intent||!same(bound))return;selected=options.items.some(i=>i.optionKey===select.value&&i.recordedAvailable)?select.value:'';render();};
    const submit=$('#evaluation-submit');if(submit)submit.onsubmit=e=>{e.preventDefault();if(isBusy()||!same(bound)||!chosen?.recordedAvailable||!$('#evaluation-confirm').checked)return;
      if(!intent){const requestKey=newKey();if(!ref(requestKey)){error='INVALID_IDEMPOTENCY_KEY';render();return;}intent={mode:'EVALUATE',input:{...structuredClone(chosen.command),requestKey}};}
      const accepted=onSubmit(structuredClone(intent));notice=accepted?'评测意图已交给原生作业提交层；下方可查询原请求。':'提交层尚未接受，保留原意图；请先处理下方提示。';render();
    };
    document.querySelectorAll?.('[data-evaluation-history-key]').forEach(button=>{if(!button.dataset.evaluationHistoryKey)return;button.onclick=()=>{
      if(!isBusy()&&same(bound)&&options?.keys.includes(button.dataset.evaluationHistoryKey))void onHistory(button.dataset.evaluationHistoryKey);
    };});
  }
  return {render,reset,load};
}
