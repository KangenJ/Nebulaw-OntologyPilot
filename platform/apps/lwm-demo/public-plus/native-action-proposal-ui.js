const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const text=v=>typeof v==='string'&&v.length>0&&v.length<=2000;
const version=v=>Number.isSafeInteger(v)&&v>0,hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const identity=p=>p?.id&&p.tenantId?JSON.stringify([p.id,p.tenantId,[...(p.roles??[])].sort()]):null;
const fail=()=>{throw Error('INVALID_ACTION_PROPOSAL_RESPONSE');};
const prefix='/learning/action-requests';
const labels={taskNumber:'新核验任务编号',title:'任务标题',priority:'优先级',assignee:'负责人',instructions:'核验说明',dueAt:'截止时间（ISO 8601，含时区）'};

export function createNativeActionProposalWorkbench({document,api,run,isBusy,getPrincipal,getDetail=()=>null,getStorage=()=>globalThis.sessionStorage,requestKey=()=>globalThis.crypto.randomUUID()}){
  const $=s=>document.querySelector(s);let bound,context,generation=0,catalog,selected,bookmark,pending,result,error='',notice='';
  const current=()=>JSON.stringify(getDetail()?.reference??null),storageKey=()=> 'plus.action-proposal-intent.v1:'+bound;
  function reset(){generation++;bound=context=catalog=selected=bookmark=pending=result=undefined;error=notice='';}
  function sync(){const p=identity(getPrincipal());if(p!==bound){reset();bound=p;if(p)try{const raw=getStorage()?.getItem(storageKey());if(raw){const b=JSON.parse(raw);
    if(!exact(b,['schema','actor','requestKey'])||b.schema!=='plus-action-proposal-intent-v1'||b.actor!==p||!text(b.requestKey))fail();bookmark=b;
  }}catch{error='原提案标记不可读，请先核对原生历史，不要重复创建。';}}
    const c=current();if(c!==context){context=c;catalog=selected=undefined;}}
  function perform(fn){sync();if(isBusy()||!bound)return;const g=generation,p=bound,c=context;
    return run(async epoch=>{const check=()=>{if(g!==generation||p!==identity(getPrincipal())||c!==current())throw Object.assign(Error('提案身份或对象已变化'),{discarded:true});};
      try{error='';await fn(epoch,check);}catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)render();}});
  }
  function validateCatalog(v){if(v?.schema!=='plus-action-proposal-catalog-v1'||v.readOnly!==true||v.qualification!=='NOT_CHECKED'||v.predictionReady!==false||v.executionAuthorized!==false||!Array.isArray(v.items)||v.items.length>100||new Set(v.items.map(i=>i.optionKey)).size!==v.items.length)fail();
    for(const i of v.items){const c=i.command,f=i.form;
      if(!hash(i.optionKey)||!text(i.scenario?.id)||!version(i.scenario.version)||!hash(i.scenario.hash)||!text(i.scenario.createdAt)
        ||i.root?.type!=='InvestigationTask'||i.root.tenantId!==getPrincipal().tenantId||!text(i.root.id)||!version(i.root.version)
        ||i.matter?.type!=='Matter'||i.matter.tenantId!==getPrincipal().tenantId||!text(i.matter.id)||!version(i.matter.version)
        ||i.episode?.type!=='PlusEpisode'||i.episode.tenantId!==getPrincipal().tenantId||!text(i.episode.id)||!version(i.episode.version)
        ||!['SYNTHETIC','AUTHORIZED_REAL'].includes(i.classification)||i.qualification!=='NOT_CHECKED'||i.predictionReady!==false||i.executionAuthorized!==false
        ||!Array.isArray(i.unavailableReasons)||!i.unavailableReasons.every(text)||f?.actionName!=='NativeRegisterInvestigationTask'||f.optionKey!=='REQUEST_VERIFICATION'||!hash(f.ontologyHash)||!hash(f.manifestHash)
        ||!Array.isArray(f.fields)||f.fields.length!==6||new Set(f.fields.map(x=>x.name)).size!==6||f.fields.some(x=>!Object.hasOwn(labels,x.name)||typeof x.required!=='boolean'||!text(x.type)||x.values!==null&&(!Array.isArray(x.values)||!x.values.length||x.values.length>128||!x.values.every(text))))fail();
      if(c!==null&&(!exact(c,['scenarioId','optionKey','actionName','boundParams'])||c.scenarioId!==i.scenario.id||c.optionKey!==f.optionKey||c.actionName!==f.actionName
        ||!exact(c.boundParams,['matter','expectedVersion'])||c.boundParams.matter!==i.matter.id||c.boundParams.expectedVersion!==i.matter.version||i.unavailableReasons.length||i.episodeStatus!=='OPEN'))fail();
    }
  }
  function validateResult(v){if(!text(v?.id)||!version(v.version)||!hash(v.requestHash)||!['PROPOSED','APPROVED','REJECTED','STALE','EXECUTED'].includes(v.status)||v.executionAuthorized!==false||v.physicalOutcomeVerified!==false)fail();}
  function accept(v){validateResult(v);getStorage().removeItem(storageKey());bookmark=pending=undefined;result=v;catalog=selected=undefined;notice='原生提案已记录，后续仍需独立审批与受治理执行；这里没有执行业务动作。';}
  function load(){return perform(async(epoch,check)=>{catalog=selected=undefined;const v=await api(prefix+'/proposal-options',epoch);check();validateCatalog(v);catalog=v;});}
  function lookup(){sync();if(!bookmark)return;const b=structuredClone(bookmark);return perform(async(epoch,check)=>{const v=await api(prefix+'/lookup',epoch,{requestKey:b.requestKey});check();
    if(v?.schema!=='plus-action-proposal-lookup-v1'||v.readOnly!==true||v.absenceIsNotCancellation!==true||v.predictionReady!==false||v.executionAuthorized!==false||!Object.hasOwn(v,'item'))fail();
    if(v.item===null)notice='暂未找到原提案，不代表未提交或已取消；保留原键，不自动重发。';else accept(v.item);
  });}
  function options(){const r=getDetail()?.reference;return (catalog?.items??[]).filter(i=>!r||i.root.type===r.type&&i.root.id===r.id);}
  function send(command){sync();if(isBusy()||!getPrincipal()?.roles.includes('investigator'))return;
    const c=structuredClone(command);
    if(bookmark&&(!pending||JSON.stringify(c)!==JSON.stringify(pending))){error='先确认原提案结果，不能另建新请求。';render();return;}
    if(!bookmark){const i=options().find(i=>i.optionKey===selected);
      if(!i?.command||c.scenarioId!==i.scenario.id||c.actionName!==i.form.actionName||c.optionKey!==i.form.optionKey||c.params.matter!==i.matter.id||c.params.expectedVersion!==i.matter.version){error='请重新读取并选择当前场景。';render();return;}
      try{const s=getStorage();if(!s||s.getItem(storageKey())!==null)throw Error('unresolved');const b={schema:'plus-action-proposal-intent-v1',actor:bound,requestKey:c.requestKey};s.setItem(storageKey(),JSON.stringify(b));if(s.getItem(storageKey())!==JSON.stringify(b))throw Error('storage verification');bookmark=b;}
      catch{error='无法保存原请求标记，尚未提交。';render();return;}
    }
    pending=c;selected=undefined;return perform(async(epoch,check)=>{const v=await api(prefix,epoch,c);check();accept(v);});
  }
  function submit(e){e.preventDefault();if(isBusy()||!$('#action-proposal-confirm')?.checked)return;sync();const i=options().find(i=>i.optionKey===selected);if(!i?.command||bookmark)return;
    try{const params=structuredClone(i.command.boundParams);for(const f of i.form.fields){const value=$('#action-proposal-'+f.name).value;
      if(!text(value)||f.required&&!value.trim()||f.values&&!f.values.includes(value)||f.type==='DateTime'&&(!/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value))))throw Error('请检查字段：'+labels[f.name]);params[f.name]=value;}
      const reason=$('#action-proposal-reason').value;if(!text(reason)||!reason.trim())throw Error('请填写提案理由');
      void send({scenarioId:i.command.scenarioId,optionKey:i.command.optionKey,actionName:i.command.actionName,params,reason,requestKey:requestKey()});
    }catch(e){error=String(e.message);render();}
  }
  function render(){sync();const i=options().find(i=>i.optionKey===selected);
    $('#content').innerHTML=`<section class="panel"><h2>从原生推演创建行动提案</h2><p>目录只列当前授权的历史场景与本体动作参数，不宣称模型仍有效或推荐该动作。提交时会重新核验当前资格；不会直接执行动作。</p>
      <button id="action-proposal-load">读取 / 刷新授权场景</button>${error?`<p class="error" role="alert">${escape(error)}</p>`:''}${notice?`<p role="status">${escape(notice)}</p>`:''}
      ${bookmark?`<p>待确认原提案：${escape(bookmark.requestKey)}</p><button id="action-proposal-lookup">只读查询原提案</button>${pending?'<button id="action-proposal-retry">重试完全相同的原提案</button>':''}`:''}
      ${result?`<p>原生请求 ${escape(result.id)} / v${result.version} · ${escape(result.status)}</p>`:''}
      ${catalog?`<label>真实场景<select id="action-proposal-select"><option value="">选择场景</option>${options().map(x=>`<option value="${x.optionKey}" ${selected===x.optionKey?'selected':''}>${escape(x.scenario.id)} · ${escape(x.scenario.createdAt)} · ${escape(x.classification)}</option>`).join('')}</select></label>${options().length?'':'<p>当前范围没有可见场景，请先在推演工作台生成真实结果；这里不提供预置答案。</p>'}`:'<p>尚未读取或上次读取失败。</p>'}</section>
      ${i?`<section class="panel"><h2>本体绑定与提案参数</h2><p>原生动作 ${escape(i.form.actionName)}；根对象 ${escape(i.root.id)} / v${i.root.version}；Matter ${escape(i.matter.id)} / v${i.matter.version}；场景 v${i.scenario.version}。</p>
        <p>本体摘要 ${escape(i.form.ontologyHash)}；当前资格未检查。${escape(i.unavailableReasons.join('，'))}</p><p>这是补充核验任务，不意味着原对象的现实状态已经改变。</p>
        ${i.command&&!bookmark?`<form id="action-proposal-form">${i.form.fields.map(f=>`<label>${labels[f.name]} · ${escape(f.type)}${f.values?`<select id="action-proposal-${f.name}" required><option value="">选择</option>${f.values.map(v=>`<option value="${escape(v)}">${escape(v)}</option>`).join('')}</select>`:`<input id="action-proposal-${f.name}" maxlength="2000" required ${f.type==='DateTime'?'placeholder="2027-01-01T00:00:00Z"':''}>`}</label>`).join('')}<label>提案理由<textarea id="action-proposal-reason" maxlength="2000" required></textarea></label><label><input type="checkbox" id="action-proposal-confirm">我已检查场景引用、参数和理由，明确创建待审批提案</label><button>创建原生提案，不批准或执行</button></form>`:''}</section>`:''}`;
    $('#action-proposal-load').onclick=()=>void load();const choose=$('#action-proposal-select');if(choose)choose.onchange=()=>{if(isBusy())return;selected=choose.value;error='';render();};
    const form=$('#action-proposal-form');if(form)form.onsubmit=submit;const lookupButton=$('#action-proposal-lookup');if(lookupButton)lookupButton.onclick=()=>void lookup();
    const retry=$('#action-proposal-retry');if(retry)retry.onclick=()=>{if(pending)void send(pending);};
  }
  return {render,reset,load,lookup};
}
