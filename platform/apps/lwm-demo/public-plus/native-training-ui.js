const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const actorKey=p=>JSON.stringify(p?{id:p.id,tenantId:p.tenantId,roles:[...(p.roles??[])].sort()}:null);
const ref=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const ids=command=>command.datasetIds??[command.datasetId];
const statuses=['PENDING','LEASED','FAILED','SUCCEEDED','CANCELLED','STALE'];

// Submitter UI, never a worker console. Options are configuration metadata;
// only the existing native enqueue path can authorize and persist actual FIT.
export function createNativeTrainingWorkbench({document,api,run,isBusy,getDataset,getHistoryDataset=getDataset,getPrincipal,onJobChange=()=>{},newKey=()=>globalThis.crypto.randomUUID()}){
  const $=s=>document.querySelector(s);let options,optionKey='',bound,pending,job,jobId,jobContext,history,historyBound,error='',notice='',generation=0;
  const context=(source=getDataset)=>{const value=source(),p=getPrincipal();return value&&p?{datasetId:value.dataset.id,root:value.root,actor:actorKey(p)}:null;};
  const historyContext=()=>context(getHistoryDataset),sameHistory=v=>v&&JSON.stringify(v)===JSON.stringify(historyContext());
  const same=v=>v&&JSON.stringify(v)===JSON.stringify(context());
  function reset(){generation++;options=bound=pending=job=jobId=jobContext=history=historyBound=undefined;optionKey='';error=notice='';}
  function current(g,c,historical=false){if(g!==generation||!(historical?sameHistory(c):same(c)))throw Object.assign(Error('训练身份或数据集已变化'),{discarded:true});}
  function validateCommand(c,datasetId){
    const batch=Object.hasOwn(c??{},'datasetIds'),auth=Object.hasOwn(c??{},'authorization');
    if(!exact(c,[batch?'datasetIds':'datasetId','purpose',...(auth?['authorization']:[])])||c.purpose!=='FIT')throw Error('INVALID_TRAINING_OPTIONS');
    const members=ids(c);if(!Array.isArray(members)||members.length<(batch?2:1)||members.length>10||members.some(v=>!ref(v))||new Set(members).size!==members.length||!members.includes(datasetId))throw Error('INVALID_TRAINING_OPTIONS');
    if(auth&&(!exact(c.authorization,['key','version'])||typeof c.authorization.key!=='string'||!c.authorization.key.trim()||!Number.isSafeInteger(c.authorization.version)||c.authorization.version<1))throw Error('INVALID_TRAINING_OPTIONS');
  }
  function validateOptions(v,datasetId){
    if(v?.schema!=='plus-compute-submission-options-v1'||v.datasetId!==datasetId||v.readOnly!==true||v.trainingEligible!==false||!Array.isArray(v.items)||v.items.length>20
      ||new Set(v.items.map(i=>i?.optionKey)).size!==v.items.length)throw Error('INVALID_TRAINING_OPTIONS');
    for(const item of v.items){const c=item?.command,r=item?.configuredRecipe;
      if(item.qualification!=='NOT_CHECKED'||!/^[a-f0-9]{64}$/.test(item.optionKey)||typeof item.engineId!=='string'||!item.engineId)throw Error('INVALID_TRAINING_OPTIONS');
      validateCommand(c,datasetId);
      if(!(exact(r,['hash'])&&/^[a-f0-9]{64}$/.test(r.hash))&&!(exact(r,['key','revision'])&&typeof r.key==='string'&&r.key&&Number.isSafeInteger(r.revision)&&r.revision>0))throw Error('INVALID_TRAINING_OPTIONS');
    }
  }
  function validateJob(v){if(!v||!ref(v.id)||!Number.isSafeInteger(v.version)||v.version<1||!statuses.includes(v.status)||!Number.isSafeInteger(v.attempts)||v.attempts<0)throw Error('INVALID_TRAINING_RECEIPT');}
  function validateHistoryItem(v,datasetId){validateJob(v);validateCommand(v.command,datasetId);
    if(v.qualification!=='NOT_CHECKED'||typeof v.engineId!=='string'||!v.engineId||!Number.isFinite(Date.parse(v.createdAt))
      ||v.recipeHash!==null&&!/^[a-f0-9]{64}$/.test(v.recipeHash))throw Error('INVALID_TRAINING_HISTORY');}
  const sameCommand=(a,b)=>JSON.stringify([...ids(a)].sort())===JSON.stringify([...ids(b)].sort())&&a.purpose===b.purpose
    &&a.authorization?.key===b.authorization?.key&&a.authorization?.version===b.authorization?.version;
  function readJob(id,c){void run(async epoch=>{const g=generation;job=undefined;jobId=id;jobContext=structuredClone(c);error='';render();
    try{const v=await api('/compute/jobs/'+encodeURIComponent(id),epoch);current(g,c,true);validateJob(v);if(v.id!==id)throw Error('TRAINING_JOB_CHANGED');job=v;}
    catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)render();}});}
  function render(){
    const container=$('#training-workbench');if(!container)return;const ctx=context(),scoped=same(bound),chosen=options?.items.find(i=>i.optionKey===optionKey);
    container.innerHTML=`<h3>提交原生候选训练</h3><p>先核验冻结的 TRAIN 数据集。这里只提交服务端允许的配方与完整数据集组；选项不是训练资格，作业成功也不等于评测通过、发布或在线许可。</p>
      <button id="training-refresh" ${!ctx||pending?'disabled':''}>读取此数据集的训练选项</button>${error?`<p class="error" role="alert">${escape(error)}</p>`:''}${notice?`<p role="status">${escape(notice)}</p>`:''}
      ${options&&scoped?`<label>服务器配置的训练方案<select id="training-option" ${pending?'disabled':''}><option value="">请选择</option>${options.items.map(i=>`<option value="${escape(i.optionKey)}" ${i.optionKey===optionKey?'selected':''}>${escape(i.engineId)} · ${escape(i.configuredRecipe.key?i.configuredRecipe.key+' / r'+i.configuredRecipe.revision:i.configuredRecipe.hash)} · ${ids(i.command).length}个数据集</option>`).join('')}</select></label>${options.items.length?'':'<p>当前没有完整获授权的数据集组；不会自动缩减批次或扩大权限。</p>'}`:''}
      ${chosen&&scoped&&!jobId?`<p>将提交数据集：${ids(chosen.command).map(escape).join('、')}。配置资格 NOT_CHECKED；配方、数据来源和当前授权由服务端提交时重新核验。</p><form id="training-submit"><label><input id="training-confirm" type="checkbox" required ${pending?'checked disabled':''}>确认提交此完整数据集组，仅生成候选；不批准模型或执行业务动作</label><button type="submit">${pending?'以原幂等键重试':'提交候选训练'}</button></form>`:''}
      ${pending?`<p role="status">提交结果未确认：保留原身份、负载和幂等键。本页不会自动认领、重训或伪造完成。</p><button id="training-lookup" ${sameHistory(pending.context)?'':'disabled'}>只读查询原提交结果</button>`:''}
      <h3>我提交的原生训练历史</h3><p>刷新页面后可重新查询历史；目录不证明当前材料或模型可用，也不自动认定某条历史就是丢失响应的请求。</p><button id="training-history-refresh" ${historyContext()?'':'disabled'}>读取此数据集的原生作业</button>
      ${history&&sameHistory(historyBound)?`<table><thead><tr><th>提交时间 / 引擎</th><th>登记作业状态</th><th>读取</th></tr></thead><tbody>${history.items.map(i=>`<tr><td>${escape(i.createdAt)} / ${escape(i.engineId)}</td><td>${escape(i.id)} / ${escape(i.status)}（NOT_CHECKED）</td><td><button data-training-history-id="${escape(i.id)}" ${pending?'disabled':''}>读取此作业</button></td></tr>`).join('')||'<tr><td colspan="3">本次读取没有找到自己的作业；尚在途的请求仍可能随后提交，未找到不等于已取消。</td></tr>'}</tbody></table>`:''}
      ${jobId&&sameHistory(jobContext)?`<p>原生作业 ${escape(jobId)}：${job?`v${escape(job.version)} / ${escape(job.status)}；尝试 ${job.attempts} 次。${job.status==='SUCCEEDED'?'候选计算已完成，仍需独立整体评测和发布决定。':'作业状态以服务端为准；此页面没有 worker 凭据。'}`:'当前状态未核验，不据旧结果判断完成。'}</p><button id="training-job-refresh">读取原生作业状态</button>`:''}`;
    $('#training-refresh').onclick=()=>{if(isBusy()||pending||!context())return;const c=context();void run(async epoch=>{const g=generation;options=undefined;optionKey='';bound=c;job=jobId=undefined;error='';render();
      try{const v=await api('/compute/submission-options?'+new URLSearchParams({datasetId:c.datasetId}),epoch);current(g,c);validateOptions(v,c.datasetId);options=v;}
      catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)render();}});};
    const selector=$('#training-option');if(selector)selector.onchange=()=>{if(isBusy()||pending||!same(bound))return;optionKey=options.items.some(i=>i.optionKey===selector.value)?selector.value:'';render();};
    const submit=$('#training-submit');if(submit)submit.onsubmit=e=>{e.preventDefault();if(isBusy()||jobId||!same(bound)||!chosen||!$('#training-confirm').checked)return;
      if(pending&&!same(pending.context))return;
      if(!pending){const key=newKey();if(typeof key!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(key)){error='INVALID_IDEMPOTENCY_KEY';render();return;}pending={context:structuredClone(bound),command:structuredClone(chosen.command),key};}
      const command=structuredClone(pending);void run(async epoch=>{const g=generation;error='';render();try{
        const v=await api('/compute/jobs',epoch,command.command,command.key);current(g,command.context);validateJob(v);job=v;jobId=v.id;jobContext=command.context;pending=undefined;
        notice='已收到原生训练作业回执；没有批准、发布或自动重训。';
      }catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)render();}});};
    const refresh=$('#training-job-refresh');if(refresh)refresh.onclick=()=>{if(!isBusy()&&!pending&&jobId&&sameHistory(jobContext))readJob(jobId,jobContext);};
    $('#training-history-refresh').onclick=()=>{if(isBusy()||!historyContext())return;const c=historyContext();void run(async epoch=>{const g=generation;history=undefined;historyBound=c;error='';render();
      try{const v=await api('/compute/submissions?'+new URLSearchParams({datasetId:c.datasetId}),epoch);current(g,c,true);
        if(v?.schema!=='plus-submitted-compute-history-v1'||v.datasetId!==c.datasetId||v.readOnly!==true||v.predictionReady!==false||v.executionAuthorized!==false||!Array.isArray(v.items)||v.items.length>100
          ||new Set(v.items.map(i=>i?.id)).size!==v.items.length)throw Error('INVALID_TRAINING_HISTORY');for(const item of v.items)validateHistoryItem(item,c.datasetId);history=v;
      }catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)render();}});};
    document.querySelectorAll?.('[data-training-history-id]').forEach(button=>button.onclick=()=>{
      if(isBusy()||pending||!sameHistory(historyBound))return;const item=history?.items.find(i=>i.id===button.dataset.trainingHistoryId);if(item)readJob(item.id,historyBound);
    });
    const lookup=$('#training-lookup');if(lookup)lookup.onclick=()=>{if(isBusy()||!pending||!sameHistory(pending.context))return;const command=structuredClone(pending);
      void run(async epoch=>{const g=generation;error='';render();try{
        const v=await api('/compute/submissions/lookup',epoch,{datasetId:command.context.datasetId,requestKey:command.key});current(g,command.context,true);
        if(v?.schema!=='plus-submitted-compute-lookup-v1'||v.datasetId!==command.context.datasetId||v.readOnly!==true||v.predictionReady!==false||v.executionAuthorized!==false||v.absenceIsNotCancellation!==true||!Object.hasOwn(v,'item'))throw Error('INVALID_TRAINING_LOOKUP');
        if(v.item===null){notice='此刻未找到原生提交；不代表请求取消或不会提交。保留原键，稍后查询或原样重试。';}
        else{validateHistoryItem(v.item,command.context.datasetId);if(!sameCommand(v.item.command,command.command))throw Error('TRAINING_REQUEST_CHANGED');
          job=v.item;jobId=v.item.id;jobContext=command.context;pending=undefined;notice='已按当前身份及原幂等键找到原生作业，没有新建或重训。';}
      }catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)render();}});};
    onJobChange();
  }
  return {reset,render,evaluationContext:()=>job?.status==='SUCCEEDED'&&job.id===jobId&&sameHistory(jobContext)?{executionId:jobId,datasetId:jobContext.datasetId}:null};
}
