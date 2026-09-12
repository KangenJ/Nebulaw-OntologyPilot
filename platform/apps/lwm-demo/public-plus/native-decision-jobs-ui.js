const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const actor=p=>p?.id&&p.tenantId?JSON.stringify({id:p.id,tenantId:p.tenantId,roles:[...(p.roles??[])].sort()}):null;
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.sort().join(',');
const text=v=>typeof v==='string'&&v.trim()&&v.length<=2000;
const key=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(v);
const terminal=v=>['SUCCEEDED','FAILED','CANCELLED'].includes(v);
const fail=()=>{throw Error('INVALID_DECISION_JOB_RECEIPT');};

// Model-owner UI, never a worker console. Session storage holds only the original
// actor-scoped purpose/request key: no bearer, labels, model material or lease.
// After reload the exact native lookup is read-only; absence is NOT cancellation.
export function createNativeDecisionJobs({document,api,run,isBusy,getPrincipal,getStorage=()=>globalThis.sessionStorage,onDecisionChange=()=>{},onResolved=()=>{}}){
  const $=s=>document.querySelector(s);let bound,bookmark,pendingCommand,history,job,error='',notice='',generation=0;
  const storageKey=()=> 'plus.decision-intent.v1:'+bound;
  function reset(){generation++;bound=bookmark=pendingCommand=history=job=undefined;error=notice='';}
  function sync(){const next=actor(getPrincipal());if(next===bound)return;reset();bound=next;if(!bound)return;
    try{const raw=getStorage()?.getItem(storageKey());if(raw){const v=JSON.parse(raw);
      if(!exact(v,['schema','actor','key','requestKey'])||v.schema!=='plus-decision-intent-v1'||v.actor!==bound||!key(v.key)||!text(v.requestKey))throw Error('INVALID_DECISION_INTENT_BOOKMARK');bookmark=v;}
    }catch{error='无法读取原请求标记；请勿重复提交。原生历史仍可只读检查。';}
  }
  function current(g,p){if(g!==generation||p!==actor(getPrincipal())||p!==bound)throw Object.assign(Error('模型决定作业身份已变化'),{discarded:true});}
  function validate(v,k){if(!v||!text(v.id)||v.key!==k||!Number.isSafeInteger(v.version)||v.version<1||!['PENDING','LEASED','SUCCEEDED','FAILED','CANCELLED'].includes(v.status)
    ||v.mode!=='DECIDE'||!Number.isSafeInteger(v.attempts)||v.attempts<0||!/^[a-f0-9]{64}$/.test(v.commandHash)
    ||v.qualification!=='NOT_CHECKED'||v.predictionReady!==false||v.executionAuthorized!==false
    ||(v.status==='SUCCEEDED'? !text(v.recordedDecision?.id)||!Number.isSafeInteger(v.recordedDecision?.version)||v.recordedDecision.version<1||!/^[a-f0-9]{64}$/.test(v.recordedDecision?.contentHash)||!['APPROVE','REJECT'].includes(v.recordedDecision?.decision):v.recordedDecision!==null))fail();}
  function accept(v,k,original=false){validate(v,k);job=v;
    if(original){pendingCommand=undefined;if(terminal(v.status)){
      // Only a response bound to the exact original command/lookup can release
      // the bookmark. Reading an arbitrary historical job cannot clear it.
      getStorage().removeItem(storageKey());bookmark=undefined;onResolved();
    }}
  }
  function action(operation){if(isBusy()||!bound)return;const g=generation,p=bound;return run(async epoch=>{error='';render();
    try{await operation(epoch,()=>current(g,p));}catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}
    finally{if(g===generation)render();}});}
  function submit(command){sync();if(isBusy()||!bound||!getPrincipal()?.roles?.includes('model_owner'))return false;
    const v=structuredClone(command),input=v?.input;
    if(!exact(v,['mode','input'])||v.mode!=='DECIDE'||!exact(input,['key','requestKey','evaluationId','evaluationVersion','decision','reason'])
      ||!key(input.key)||!text(input.requestKey)||!text(input.evaluationId)||!Number.isSafeInteger(input.evaluationVersion)||input.evaluationVersion<1
      ||!['APPROVE','REJECT'].includes(input.decision)||!text(input.reason)){error='INVALID_DECISION_COMMAND';render();return false;}
    if(bookmark&&(!pendingCommand||JSON.stringify(pendingCommand)!==JSON.stringify(v))){error='先按原请求查询并确认终态，不能为未知结果创建第二个请求。';render();return false;}
    if(!bookmark){try{const storage=getStorage();if(!storage)throw Error('storage unavailable');
      // Do not overwrite an unread/corrupt bookmark or post without a durable key.
      if(storage.getItem(storageKey())!==null)throw Error('unresolved stored intent');
      const saved={schema:'plus-decision-intent-v1',actor:bound,key:input.key,requestKey:input.requestKey};
      storage.setItem(storageKey(),JSON.stringify(saved));if(storage.getItem(storageKey())!==JSON.stringify(saved))throw Error('storage verification');bookmark=saved;
    }catch{error='无法保存原请求标记，尚未提交；不会回退到同步执行。';render();return false;}}
    pendingCommand=v;onDecisionChange();void action(async(epoch,check)=>{const value=await api('/learning/decision-jobs',epoch,v);check();accept(value,input.key,true);
      notice='已收到原生作业回执；后台仍需完整资格检查，排队不等于批准或生效。';});return true;
  }
  function lookup(){sync();if(!bookmark)return;const original=structuredClone(bookmark);return action(async(epoch,check)=>{
    const result=await api('/learning/decision-jobs/lookup',epoch,{key:original.key,requestKey:original.requestKey});check();
    if(result?.schema!=='plus-decision-job-lookup-v1'||result.key!==original.key||result.readOnly!==true||result.absenceIsNotCancellation!==true
      ||result.predictionReady!==false||result.executionAuthorized!==false||!Object.hasOwn(result,'item'))fail();
    if(result.item===null)notice='此刻未找到原请求；不代表取消或以后不会提交。保留标记，不自动换键或重试。';
    else{accept(result.item,original.key,true);notice='已按当前身份和原幂等键恢复原生作业，没有新建请求。';}
  });}
  function load(k){sync();if(!key(k))return;return action(async(epoch,check)=>{history=undefined;job=undefined;
    const value=await api('/learning/decision-jobs?'+new URLSearchParams({key:k}),epoch);check();
    if(value?.schema!=='plus-decision-job-index-v1'||value.key!==k||value.readOnly!==true||value.predictionReady!==false||!Array.isArray(value.items)||value.items.length>100
      ||new Set(value.items.map(v=>v.id)).size!==value.items.length)fail();for(const item of value.items)validate(item,k);history=value;
  });}
  function render(){sync();const container=$('#decision-jobs');if(!container)return;
    container.innerHTML=`<h2>人工模型决定后台作业</h2><p>这里只提交意图和读取回执，不领取作业、不运行模型或授予在线许可。浏览器只保存同身份的原请求定位标记，刷新后可准确查询。</p>
      ${error?`<p class="error" role="alert">${escape(error)}</p>`:''}${notice?`<p role="status">${escape(notice)}</p>`:''}
      ${bookmark?`<p>待确认原请求用途：${escape(bookmark.key)}。未知结果不能当作失败。</p><button id="decision-job-lookup">查询原请求 / 更新状态</button>${pendingCommand?'<button id="decision-job-retry">使用完全相同的意图重试提交</button>':''}`:''}
      ${history?`<p>${escape(history.key)} · 我提交的原生作业（资格未检查）</p>${history.items.map(v=>`<button data-decision-job-id="${escape(v.id)}">${escape(v.mode)} / ${escape(v.status)} / ${escape(v.id)}</button>`).join('')||'<p>未找到自己的作业；不代表尚在途的请求已取消。</p>'}`:'<p>从审核用途选择“我的模型决定作业”读取历史。</p>'}
      ${job?`<p role="status">原生作业 ${escape(job.id)}：${escape(job.status)}，尝试 ${job.attempts} 次。${job.status==='SUCCEEDED'?`已记录人工决定 ${escape(job.recordedDecision.decision)} / ${escape(job.recordedDecision.id)}；这不代表当前资格、模型生效或在线许可。`:'状态以原生记录为准。'}</p>`:''}`;
    const find=$('#decision-job-lookup');if(find)find.onclick=()=>{void lookup();};
    const retry=$('#decision-job-retry');if(retry)retry.onclick=()=>{if(pendingCommand)submit(pendingCommand);};
    document.querySelectorAll?.('[data-decision-job-id]').forEach(button=>{if(!button.dataset.decisionJobId)return;button.onclick=()=>{
      const row=history?.items.find(v=>v.id===button.dataset.decisionJobId);if(!row)return;
      void action(async(epoch,check)=>{job=undefined;const value=await api('/learning/decision-jobs/'+encodeURIComponent(row.id),epoch);check();
        if(value?.id!==row.id)fail();accept(value,history.key,false);});
    };});
  }
  return {render,reset,load,submit,lookup};
}
