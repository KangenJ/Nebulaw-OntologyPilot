const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const text=v=>typeof v==='string'&&v.length>0&&v.length<=2000;
const version=v=>Number.isSafeInteger(v)&&v>0;
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const actor=p=>p?.id&&p.tenantId?JSON.stringify([p.id,p.tenantId,[...(p.roles??[])].sort()]):null;
const fail=()=>{throw Error('INVALID_ACTION_REVIEW_RESPONSE');};
const prefix='/learning/action-requests';

export function createNativeActionReviewWorkbench({document,api,run,isBusy,getPrincipal,getDetail=()=>null,getStorage=()=>globalThis.sessionStorage}){
  const $=s=>document.querySelector(s);let bound,context,generation=0,catalog,selected,bookmark,pending,error='',notice='';
  const current=()=>JSON.stringify(getDetail()?.reference??null),storageKey=()=> 'plus.action-review-intent.v1:'+bound;
  function reset(){generation++;bound=context=catalog=selected=bookmark=pending=undefined;error=notice='';}
  function sync(){const p=actor(getPrincipal());if(p!==bound){reset();bound=p;if(p)try{const raw=getStorage()?.getItem(storageKey());if(raw){const b=JSON.parse(raw);
    if(!exact(b,['schema','actor','requestId','expectedVersion','decision'])||b.schema!=='plus-action-review-intent-v1'||b.actor!==bound||!text(b.requestId)||!version(b.expectedVersion)||!['APPROVE','REJECT'].includes(b.decision))fail();bookmark=b;
  }}catch{error='无法读取原审批标记，请先只读核对原生决定，不要重新提交。';}}
    const c=current();if(c!==context){context=c;catalog=selected=undefined;}}
  function perform(fn){sync();if(isBusy()||!bound)return;const g=generation,p=bound,c=context;
    return run(async epoch=>{const check=()=>{if(g!==generation||p!==actor(getPrincipal())||c!==current())throw Object.assign(Error('审批身份或对象已变化'),{discarded:true});};
      try{error='';await fn(epoch,check);}catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)render();}});
  }
  function validate(v){if(v?.schema!=='plus-action-review-catalog-v1'||v.readOnly!==true||v.qualification!=='NOT_CHECKED'||v.predictionReady!==false||v.executionAuthorized!==false
    ||!Array.isArray(v.items)||v.items.length>100||new Set(v.items.map(i=>i.request?.id)).size!==v.items.length)fail();
    for(const i of v.items){const r=i?.request,c=i?.command,d=i?.decision;
      if(!hash(i.optionKey)||!text(r?.id)||!version(r.version)||!hash(r.requestHash)||!text(r.submittedBy)||!text(r.reason)||!text(r.submittedAt)
        ||!['PROPOSED','APPROVED','REJECTED','STALE','EXECUTED'].includes(r.status)||r.actionName!=='NativeRegisterInvestigationTask'||!r.params||typeof r.params!=='object'||Array.isArray(r.params)
        ||i.root?.type!=='InvestigationTask'||i.root.tenantId!==getPrincipal().tenantId||!text(i.root.id)||!version(i.root.version)
        ||i.matter?.type!=='Matter'||i.matter.tenantId!==getPrincipal().tenantId||!text(i.matter.id)||!version(i.matter.version)
        ||!text(i.scenario?.id)||!version(i.scenario.version)||!hash(i.scenario.hash)||!text(i.episodeId)||!['SYNTHETIC','AUTHORIZED_REAL'].includes(i.classification)
        ||i.qualification!=='NOT_CHECKED'||i.executionAuthorized!==false||!Array.isArray(i.unavailableReasons)||!i.unavailableReasons.every(text))fail();
      if(d!==null&&(!text(d?.id)||!version(d.version)||!version(d.inputVersion)||!['APPROVE','REJECT'].includes(d.decision)||!text(d.decidedBy)||d.decidedBy===r.submittedBy||!text(d.reason)||!text(d.decidedAt)))fail();
      if(c!==null&&(!exact(c,['requestId','expectedVersion'])||c.requestId!==r.id||c.expectedVersion!==r.version||r.status!=='PROPOSED'||r.submittedBy===getPrincipal().id||d!==null||i.unavailableReasons.length))fail();
    }
  }
  function clearBookmark(){getStorage().removeItem(storageKey());bookmark=pending=undefined;}
  function load(){return perform(async(epoch,check)=>{catalog=selected=undefined;const v=await api(prefix+'/review-options',epoch);check();validate(v);catalog=v;
    if(bookmark){const i=v.items.find(i=>i.request.id===bookmark.requestId),d=i?.decision;
      if(d){if(d.inputVersion!==bookmark.expectedVersion)fail();
        notice=d.decidedBy===getPrincipal().id&&d.decision===bookmark.decision?'原生历史已记录该审批方向；未自动重发，具体理由以历史为准。':'原生历史已被其他决定关闭；未重发或覆盖决定。';clearBookmark();
      }else notice='尚未在当前可读目录确认原审批终态；缺席不代表未提交，保留原标记。';
    }
  });}
  function validateReceipt(v,command){if(v?.id!==command.requestId||v.version!==command.expectedVersion+1||v.status!==(command.decision==='APPROVE'?'APPROVED':'REJECTED')||!text(v.decisionId)
    ||!hash(v.requestHash)||v.executionAuthorized!==false||v.physicalOutcomeVerified!==false||v.businessFactsWritten!==false)fail();}
  function send(command){sync();if(isBusy()||!getPrincipal()?.roles.includes('case_reviewer'))return;
    const c=structuredClone(command);if(!exact(c,['requestId','expectedVersion','decision','reason'])||!text(c.requestId)||!version(c.expectedVersion)||!['APPROVE','REJECT'].includes(c.decision)||!text(c.reason)||!c.reason.trim())fail();
    if(!bookmark&&!options().some(i=>i.optionKey===selected&&i.command?.requestId===c.requestId&&i.command?.expectedVersion===c.expectedVersion)){error='请重新读取并选择当前对象的原生待审请求。';render();return;}
    if(bookmark&&(!pending||JSON.stringify(c)!==JSON.stringify(pending))){error='先确认原审批终态，不能用新决定覆盖未知结果。';render();return;}
    if(!bookmark)try{const s=getStorage();if(!s||s.getItem(storageKey())!==null)throw Error('unresolved intent');
      const b={schema:'plus-action-review-intent-v1',actor:bound,requestId:c.requestId,expectedVersion:c.expectedVersion,decision:c.decision};s.setItem(storageKey(),JSON.stringify(b));if(s.getItem(storageKey())!==JSON.stringify(b))throw Error('storage verification');bookmark=b;
    }catch{error='无法保存原审批标记，尚未提交。';render();return;}
    pending=c;selected=undefined;return perform(async(epoch,check)=>{const v=await api(prefix+'/'+encodeURIComponent(c.requestId)+'/decisions',epoch,{expectedVersion:c.expectedVersion,decision:c.decision,reason:c.reason});check();validateReceipt(v,c);clearBookmark();catalog=undefined;notice='原生决定已记录。批准不等于执行，现实结果仍需独立核验。';});
  }
  function options(){const r=getDetail()?.reference;return (catalog?.items??[]).filter(i=>!r||i.root.type===r.type&&i.root.id===r.id);}
  function render(){sync();const i=options().find(i=>i.optionKey===selected),r=i?.request;
    $('#content').innerHTML=`<section class="panel"><h2>独立行动审批</h2><p>当前授权请求及历史；不重新运行模型。批准时服务端重新检查模型、来源、对象、原生规则与版本。拒绝不执行动作。</p>
      <button id="action-review-load">读取 / 刷新审批请求与原决定</button><p>当前对象：${escape(getDetail()?.reference?getDetail().reference.type+' / '+getDetail().reference.id:'全部授权请求')}</p>
      ${error?`<p class="error" role="alert">${escape(error)}</p>`:''}${notice?`<p role="status">${escape(notice)}</p>`:''}
      ${bookmark?`<p>待确认原审批：${escape(bookmark.requestId)} / v${bookmark.expectedVersion} / ${escape(bookmark.decision)}。刷新后只读核对，不自动重发。</p>${pending?'<button id="action-review-retry">重试完全相同的原决定</button>':''}`:''}
      ${catalog?`<label>授权请求<select id="action-review-select"><option value="">选择请求</option>${options().map(x=>`<option value="${x.optionKey}" ${selected===x.optionKey?'selected':''}>${escape(x.request.params.title)} · ${escape(x.request.status)} · ${escape(x.request.submittedBy)}</option>`).join('')}</select></label>${options().length?'':'<p>当前范围无可见请求；不代表平台没有待审请求。</p>'}`:'<p>尚未读取或上次读取失败。</p>'}</section>
      ${i?`<section class="panel"><h2>请求依据与历史</h2><p>${escape(r.actionName)} / ${escape(r.id)} / v${r.version} · ${escape(i.classification)}</p><p>提案人：${escape(r.submittedBy)} · 理由：${escape(r.reason)}</p>
        <table><tbody>${Object.entries(r.params).map(([k,v])=>`<tr><th>${escape(k)}</th><td>${escape(typeof v==='object'?JSON.stringify(v):v)}</td></tr>`).join('')}</tbody></table>
        <p>根对象 ${escape(i.root.id)} / v${i.root.version}；Matter ${escape(i.matter.id)} / v${i.matter.version}；场景 ${escape(i.scenario.id)} / v${i.scenario.version}；过程 ${escape(i.episodeId)}。</p>
        ${i.decision?`<p>历史决定 ${escape(i.decision.decision)} · ${escape(i.decision.decidedBy)} · ${escape(i.decision.reason)}</p>`:''}
        <p>当前资格尚未检查；${escape(i.unavailableReasons.join('，'))}</p>
        ${i.command&&!bookmark?'<form id="action-review-form"><label>决定<select id="action-review-decision"><option value="REJECT">拒绝</option><option value="APPROVE">批准</option></select></label><label>审批理由<textarea id="action-review-reason" maxlength="2000" required></textarea></label><label><input type="checkbox" id="action-review-confirm">我已检查提案、参数、依据和版本，明确提交此决定</label><button>记录独立决定，不执行动作</button></form>':''}</section>`:''}`;
    $('#action-review-load').onclick=()=>void load();const choose=$('#action-review-select');if(choose)choose.onchange=()=>{if(isBusy())return;selected=choose.value;error='';render();};
    const form=$('#action-review-form');if(form)form.onsubmit=e=>{e.preventDefault();if(isBusy()||!$('#action-review-confirm').checked)return;void send({...i.command,decision:$('#action-review-decision').value,reason:$('#action-review-reason').value});};
    const retry=$('#action-review-retry');if(retry)retry.onclick=()=>{if(pending)void send(pending);};
  }
  return {render,reset,load,send};
}
