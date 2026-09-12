const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const actor=p=>p?.id&&p.tenantId?JSON.stringify({id:p.id,tenantId:p.tenantId,roles:[...(p.roles??[])].sort()}):null;
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const text=v=>typeof v==='string'&&!!v.trim()&&v.length<=2000;
const key=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const version=v=>Number.isSafeInteger(v)&&v>0;
const terminal=v=>['SUCCEEDED','FAILED','CANCELLED'].includes(v);
const fail=()=>{throw Error('INVALID_ACTION_WORKBENCH_RESPONSE');};
const prefix='/learning/action-execution-jobs';

// Only native investigator intents. Neither saved history nor a checked form is
// execution authority. The worker independently requalifies the whole request.
export function createNativeActionWorkbench({document,api,run,isBusy,getPrincipal,getDetail=()=>null,getStorage=()=>globalThis.sessionStorage,requestKey=()=>globalThis.crypto.randomUUID()}){
  const $=s=>document.querySelector(s);let bound,context,catalog,selected,bookmark,pendingCommand,job,history,generation=0,error='',notice='';
  const currentContext=()=>{const r=getDetail()?.reference;return r?JSON.stringify([r.type,r.id,r.version]):null;};
  const storageKey=()=> 'plus.action-execution-intent.v1:'+bound;
  function reset(){generation++;bound=context=catalog=selected=bookmark=pendingCommand=job=history=undefined;error=notice='';}
  function sync(){const next=actor(getPrincipal());
    if(next!==bound){reset();bound=next;if(bound)try{const raw=getStorage()?.getItem(storageKey());if(raw){const b=JSON.parse(raw);
      if(!exact(b,['schema','actor','key','requestKey'])||b.schema!=='plus-action-execution-intent-v1'||b.actor!==bound||!key(b.key)||!text(b.requestKey))fail();bookmark=b;}
    }catch{error='无法读取原请求标记；请勿重复提交。可只读检查原生历史。';}}
    const root=currentContext();if(root!==context){context=root;catalog=selected=undefined;}
  }
  function check(g,p,c){if(g!==generation||p!==actor(getPrincipal())||p!==bound||c!==undefined&&c!==currentContext())throw Object.assign(Error('行动工作台身份或对象已变化'),{discarded:true});}
  function action(operation,bindContext=false){sync();if(isBusy()||!bound)return;const g=generation,p=bound,c=bindContext?context:undefined;
    return run(async epoch=>{error='';try{await operation(epoch,()=>check(g,p,c));}catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}
      finally{if(g===generation)render();}});
  }
  function validateJob(v,k){if(!v||!text(v.id)||v.key!==k||!version(v.version)||!['PENDING','LEASED','SUCCEEDED','FAILED','CANCELLED'].includes(v.status)
    ||v.mode!=='EXECUTE'||!Number.isSafeInteger(v.attempts)||v.attempts<0||!hash(v.commandHash)||v.qualification!=='NOT_CHECKED'||v.predictionReady!==false||v.executionAuthorized!==false
    ||(v.status==='SUCCEEDED'?!text(v.recordedExecution?.id)||!version(v.recordedExecution?.version)||!text(v.recordedExecution?.receiptId):v.recordedExecution!==null))fail();}
  function accept(v,k,original=false){validateJob(v,k);job=v;if(original){pendingCommand=undefined;if(terminal(v.status)){
    getStorage().removeItem(storageKey());bookmark=undefined;catalog=selected=undefined;
  }}}
  function validateCatalog(v){if(v?.schema!=='plus-action-execution-catalog-v1'||v.readOnly!==true||v.qualification!=='NOT_CHECKED'||v.predictionReady!==false||v.executionAuthorized!==false
    ||!Array.isArray(v.keys)||v.keys.length>100||!v.keys.every(key)||new Set(v.keys).size!==v.keys.length||!Array.isArray(v.items)||v.items.length>100
    ||new Set(v.items.map(i=>i.optionKey)).size!==v.items.length)fail();
    for(const i of v.items){const r=i?.request,c=i?.command,d=i?.decision;
      if(!hash(i?.optionKey)||!v.keys.includes(i.key)||i.qualification!=='NOT_CHECKED'||i.executionAuthorized!==false||!text(r?.id)||!version(r.version)||!hash(r.requestHash)
        ||!['PROPOSED','APPROVED','REJECTED','STALE','EXECUTED'].includes(r.status)||r.actionName!=='NativeRegisterInvestigationTask'||r.submittedBy!==getPrincipal().id
        ||!r.params||typeof r.params!=='object'||Array.isArray(r.params)||!text(r.reason)||i.root?.type!=='InvestigationTask'||i.root?.tenantId!==getPrincipal().tenantId||!text(i.root.id)||!version(i.root.version)
        ||!['SYNTHETIC','AUTHORIZED_REAL'].includes(i.classification)||!Array.isArray(i.unavailableReasons)||!i.unavailableReasons.every(text)
        ||c!==null&&(!exact(c,['key','requestId','expectedVersion'])||c.key!==i.key||c.requestId!==r.id||c.expectedVersion!==r.version||r.status!=='APPROVED'||i.unavailableReasons.length
          ||d?.decision!=='APPROVE'||d.decidedBy===r.submittedBy||!text(d.id)||!version(d.version)))fail();
    }
  }
  function options(){const r=getDetail()?.reference;return (catalog?.items??[]).filter(i=>!r||i.root.type===r.type&&i.root.id===r.id);}
  function load(){return action(async(epoch,check)=>{catalog=selected=undefined;render();const v=await api(prefix+'/options',epoch);check();validateCatalog(v);catalog=v;},true);}
  function send(command){sync();if(isBusy()||!bound||!getPrincipal()?.roles?.includes('investigator'))return false;
    const v=structuredClone(command),i=v?.input;
    if(!exact(v,['mode','input'])||v.mode!=='EXECUTE'||!exact(i,['key','requestKey','requestId','expectedVersion'])||!key(i.key)||!text(i.requestKey)||!text(i.requestId)||!version(i.expectedVersion))fail();
    if(bookmark&&(!pendingCommand||JSON.stringify(pendingCommand)!==JSON.stringify(v))){error='先确认原请求终态；不能为未知结果另建请求。';render();return false;}
    if(!bookmark){try{const storage=getStorage();if(!storage||storage.getItem(storageKey())!==null)throw Error('unresolved intent');
      const b={schema:'plus-action-execution-intent-v1',actor:bound,key:i.key,requestKey:i.requestKey};storage.setItem(storageKey(),JSON.stringify(b));
      if(storage.getItem(storageKey())!==JSON.stringify(b))throw Error('storage verification');bookmark=b;
    }catch{error='无法保存原请求标记，尚未提交；不会回退到同步执行。';render();return false;}}
    pendingCommand=v;selected=undefined;render();void action(async(epoch,check)=>{const value=await api(prefix,epoch,v);check();accept(value,i.key,true);
      notice='原生作业已受理；后台仍需重新检查资格，受理不等于执行成功。';});return true;
  }
  function lookup(){sync();if(!bookmark)return;const original=structuredClone(bookmark);return action(async(epoch,check)=>{
    const v=await api(prefix+'/lookup',epoch,{key:original.key,requestKey:original.requestKey});check();
    if(v?.schema!=='plus-action-execution-job-lookup-v1'||v.key!==original.key||v.readOnly!==true||v.absenceIsNotCancellation!==true||v.predictionReady!==false||v.executionAuthorized!==false||!Object.hasOwn(v,'item'))fail();
    if(v.item===null)notice='此刻未找到原请求；不代表取消或以后不会提交。保留原键，不自动重发。';
    else{accept(v.item,original.key,true);notice='已按当前身份和原请求键查询，没有新建执行请求。';}
  });}
  function loadHistory(k){if(!key(k))return;return action(async(epoch,check)=>{history=job=undefined;const v=await api(prefix+'?'+new URLSearchParams({key:k}),epoch);check();
    if(v?.schema!=='plus-action-execution-job-index-v1'||v.key!==k||v.readOnly!==true||v.predictionReady!==false||!Array.isArray(v.items)||v.items.length>100||new Set(v.items.map(i=>i.id)).size!==v.items.length)fail();
    for(const i of v.items)validateJob(i,k);history=v;
  });}
  function render(){sync();const container=$('#content');if(!container)return;const chosen=options().find(i=>i.optionKey===selected),owner=getPrincipal()?.roles?.includes('investigator');
    container.innerHTML=`<section class="panel"><h2>原生行动执行</h2><p>读取本人有权查看的原生请求；目录未检查当前模型资格。提案和独立审批在行动工作台的对应入口分别进行；此执行面板不会自动批准或生成提案。</p>
      <p>当前对象：${escape(getDetail()?.reference?getDetail().reference.type+' / '+getDetail().reference.id:'未选择，可查看本人全部可见请求')}。模型回滚不会撤销已执行的业务动作。</p>
      ${error?`<p class="error" role="alert">${escape(error)}</p>`:''}${notice?`<p role="status">${escape(notice)}</p>`:''}
      <button id="action-catalog-load" ${owner?'':'disabled'}>读取 / 刷新我的行动请求</button>
      ${catalog?`<label>原生请求<select id="action-request-select"><option value="">请选择请求</option>${options().map(i=>`<option value="${escape(i.optionKey)}" ${i.optionKey===selected?'selected':''}>${escape(i.request.params.title??i.request.actionName)} · ${escape(i.request.status)} · ${escape(i.root.id)}</option>`).join('')}</select></label>${options().length?'':'<p>当前对象范围内无可见请求；不会生成样例记录。</p>'}`:''}
      ${chosen?`<h3>${escape(chosen.request.actionName)} · ${escape(chosen.request.status)}</h3><p>${escape(chosen.classification)} · 请求 ${escape(chosen.request.id)} / v${chosen.request.version} · 对象 ${escape(chosen.root.id)} / v${chosen.root.version}</p>
        <p>提案理由：${escape(chosen.request.reason)}</p><pre>${escape(JSON.stringify(chosen.request.params,null,2))}</pre>
        <p>原生场景 ${escape(chosen.scenario?.id)} · 过程 ${escape(chosen.episodeId)}</p>
        <p>人工决定：${escape(chosen.decision?chosen.decision.decision+' / '+chosen.decision.decidedBy+' / '+chosen.decision.reason:'尚无')}；历史审批不表示当前执行许可。</p>
        ${chosen.command&&!bookmark?'<form id="action-execute-form"><label><input id="action-execute-confirm" type="checkbox" required>我已核对动作、参数与批准版本，确认提交受治理执行。</label><button class="primary">提交执行意图</button></form>':`<p>暂不可提交：${escape(bookmark?'原请求结果待确认':chosen.unavailableReasons.join(', '))}</p>`}`:''}
      </section><section class="panel"><h2>执行进度与恢复</h2><p>只保存主体绑定的原请求定位标记，不保存凭据或动作参数。刷新后先查询原请求，未知结果不等于失败。</p>
      ${bookmark?`<p>待确认用途 ${escape(bookmark.key)}</p><button id="action-job-lookup">查询原请求 / 更新状态</button>${pendingCommand?'<button id="action-job-retry">以完全相同的意图重试提交</button>':''}`:''}
      ${catalog?catalog.keys.map(k=>`<button data-action-history-key="${escape(k)}">我的执行历史：${escape(k)}</button>`).join(''):''}
      ${history?history.items.map(v=>`<button data-action-job-id="${escape(v.id)}">${escape(v.status)} / ${escape(v.id)}</button>`).join('')||'<p>尚无本人的原生作业；不代表在途请求已取消。</p>':''}
      ${job?`<p role="status">作业 ${escape(job.id)}：${escape(job.status)}，尝试 ${job.attempts} 次。${job.status==='SUCCEEDED'?`原生请求 ${escape(job.recordedExecution.id)} / v${job.recordedExecution.version}，回执 ${escape(job.recordedExecution.receiptId)}。动作已记录，不代表现实结果已经核验。`:''}</p>
        ${['PENDING','LEASED'].includes(job.status)?'<form id="action-cancel-form"><label><input id="action-cancel-confirm" type="checkbox" required>确认请求取消此作业（不撤销已提交动作，也不代表底层计算已停止）</label><button>请求取消</button></form>':''}`:''}</section>`;
    const loadButton=$('#action-catalog-load');if(loadButton)loadButton.onclick=()=>{if(owner)void load();};
    const select=$('#action-request-select');if(select)select.onchange=()=>{if(isBusy())return;selected=select.value;render();};
    const form=$('#action-execute-form');if(form)form.onsubmit=e=>{e.preventDefault();if(isBusy()||!$('#action-execute-confirm')?.checked||!chosen?.command||bookmark)return;
      // An actor/object switch invalidates the rendered selection before posting.
      sync();if(!options().some(i=>i.optionKey===chosen.optionKey)||selected!==chosen.optionKey)return;
      send({mode:'EXECUTE',input:{...chosen.command,requestKey:requestKey()}});
    };
    const find=$('#action-job-lookup');if(find)find.onclick=()=>{void lookup();};
    const retry=$('#action-job-retry');if(retry)retry.onclick=()=>{if(pendingCommand)send(pendingCommand);};
    document.querySelectorAll?.('[data-action-history-key]').forEach(b=>b.onclick=()=>{if(catalog?.keys.includes(b.dataset.actionHistoryKey))void loadHistory(b.dataset.actionHistoryKey);});
    document.querySelectorAll?.('[data-action-job-id]').forEach(b=>b.onclick=()=>{const row=history?.items.find(i=>i.id===b.dataset.actionJobId);if(!row)return;
      void action(async(epoch,check)=>{const v=await api(prefix+'/'+encodeURIComponent(row.id),epoch);check();if(v?.id!==row.id)fail();accept(v,row.key);});});
    const cancel=$('#action-cancel-form');if(cancel)cancel.onsubmit=e=>{e.preventDefault();if(isBusy()||!$('#action-cancel-confirm')?.checked||!job)return;const original=structuredClone(job);
      void action(async(epoch,check)=>{const v=await api(prefix+'/'+encodeURIComponent(original.id)+'/cancel',epoch,{expectedVersion:original.version});check();if(v?.id!==original.id)fail();accept(v,original.key);
        notice='取消结果已记录；原请求标记仍须原键查询确认。不会撤销已提交动作，也不声明计算已停止。';});};
  }
  return {render,reset,load,lookup,loadHistory};
}
