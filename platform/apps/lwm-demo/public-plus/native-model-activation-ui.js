const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const actor=p=>p?.id&&p.tenantId?JSON.stringify({id:p.id,tenantId:p.tenantId,roles:[...(p.roles??[])].sort()}):null;
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const ref=v=>v&&typeof v.id==='string'&&v.id.length>0&&v.id.length<=128&&Number.isSafeInteger(v.version)&&v.version>0&&hash(v.hash);
const eligible=v=>v.decision==='APPROVE'&&v.recordedReadiness==='READY'&&!v.revoked&&v.configuredPolicyMatches;
const fail=()=>{throw Error('INVALID_MODEL_ACTIVATION_INDEX');};

// Native decision metadata is a choice, not approval at use time. The sole
// submit callback goes to durable owner jobs; no synchronous switch fallback.
export function createNativeModelActivation({document,api,run,isBusy,getPrincipal,onSubmit,newKey=()=>globalThis.crypto.randomUUID()}){
  const $=s=>document.querySelector(s);let scope,index,choice='',command,error='',notice='',generation=0,bound;
  function reset(){generation++;scope=index=command=bound=undefined;choice=error=notice='';}
  const current=(g,p)=>{if(g!==generation||p!==actor(getPrincipal()))throw Object.assign(Error('发布身份已变化'),{discarded:true});};
  function render(){const container=$('#model-activation');if(!container)return;
    if(bound&&bound!==actor(getPrincipal()))reset();const selected=index?.items.find(v=>v.id===choice),owner=getPrincipal()?.roles?.includes('model_owner');
    container.innerHTML=`<h2>选择已批准模型生效</h2><p>从原生决定目录选择候选；APPROVE 是历史登记，资格 NOT_CHECKED。提交后后台独立重验模型、来源、权限与版本，不自动授予在线许可。</p>
      ${error?`<p class="error" role="alert">${escape(error)}</p>`:''}${notice?`<p role="status">${escape(notice)}</p>`:''}
      ${scope&&index?`<p>${escape(scope.key)} · ${scope.expectedVersion===0?'尚未登记生效模型':'当前选择对象 v'+escape(scope.expectedVersion)}</p><label>原生模型决定<select id="model-activation-decision" ${command?'disabled':''}><option value="">请选择</option>${index.items.map(v=>`<option value="${escape(v.id)}" ${v.id===choice?'selected':''} ${eligible(v)?'':'disabled'}>${escape(v.release.id)} / ${escape(v.decision)} / ${escape(v.recordedReadiness)}${v.revoked?' / 已撤销':''}${v.configuredPolicyMatches?'':' / 配置不匹配'}</option>`).join('')}</select></label>${index.items.some(eligible)?'':'<p>没有登记为可提交的完整模型决定；不会自动批准或使用组件批准。</p>'}`:'<p>从模型用途选择“批准决定与发布”。</p>'}
      ${selected&&eligible(selected)?`<p>评测引用 ${escape(selected.evaluation.id)} / v${selected.evaluation.version}，决定 v${selected.version}。页面不据这些引用宣称当前模型有效。</p>${owner?`<form id="model-activation-form"><label>生效理由<textarea id="model-activation-reason" required maxlength="2000" ${command?'disabled':''}>${escape(command?.input.reason??'')}</textarea></label><label><input id="model-activation-confirm" type="checkbox" required ${command?'checked disabled':''}>确认提交选择作业，不修改业务事实；在线使用仍需独立许可</label><button type="submit">${command?'继续提交原意图':'提交模型生效作业'}</button></form>`:'<p>当前身份不是模型负责人，不能提交生效。</p>'}`:''}`;
    const select=$('#model-activation-decision');if(select)select.onchange=()=>{if(isBusy()||command||bound!==actor(getPrincipal()))return;
      choice=index?.items.some(v=>v.id===select.value&&eligible(v))?select.value:'';render();};
    const form=$('#model-activation-form');if(form)form.onsubmit=event=>{event.preventDefault();if(isBusy()||!owner||!scope||!selected||!eligible(selected)||bound!==actor(getPrincipal()))return;
      if(!command){const reason=$('#model-activation-reason')?.value?.trim(),requestKey=newKey();
        if(!reason||reason.length>2000||!$('#model-activation-confirm')?.checked){error='请填写理由并确认发布边界';render();return;}
        if(typeof requestKey!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(requestKey)){error='INVALID_IDEMPOTENCY_KEY';render();return;}
        command={mode:'ACTIVATE',input:{key:scope.key,expectedVersion:scope.expectedVersion,decisionId:selected.id,requestKey,reason}};
      }
      if(typeof onSubmit!=='function'){error='SELECTION_JOB_SUBMISSION_NOT_CONFIGURED';render();return;}
      if(onSubmit(structuredClone(command))){scope=index=command=undefined;choice='';notice='意图已交给原生选择作业入口；请在下方查询原请求，不代表模型已生效。';}render();
    };
  }
  function load(key){if(isBusy()||command)return;const p=actor(getPrincipal());if(!p)return;return run(async epoch=>{
    const g=generation;bound=p;scope=index=undefined;choice=error=notice='';render();
    try{const deployments=await api('/learning/deployments',epoch);current(g,p);
      if(deployments?.schema!=='plus-model-selection-index-v1'||deployments.readOnly!==true||deployments.predictionReady!==false||deployments.executionAuthorized!==false||!Array.isArray(deployments.items)
        ||deployments.items.length>100||new Set(deployments.items.map(v=>v.key)).size!==deployments.items.length)fail();
      const target=deployments.items.find(v=>v.key===key);if(!target||target.qualification!=='NOT_CHECKED')fail();
      const expectedVersion=target.recordedSelection===null?0:target.recordedSelection?.version;if(!Number.isSafeInteger(expectedVersion)||expectedVersion<0)fail();
      const value=await api('/learning/model-decisions?'+new URLSearchParams({key}),epoch);current(g,p);
      if(value?.schema!=='plus-model-decision-selection-index-v1'||value.key!==key||!hash(value.policyHash)||value.readOnly!==true||value.predictionReady!==false||value.modelDeploymentAuthorized!==false
        ||!Array.isArray(value.items)||value.items.length>100||new Set(value.items.map(v=>v.id)).size!==value.items.length)fail();
      for(const v of value.items)if(!ref({id:v.id,version:v.version,hash:v.contentHash})||!ref(v.release)||!ref(v.evaluation)||!Number.isFinite(Date.parse(v.createdAt))
        ||!['APPROVE','REJECT'].includes(v.decision)||!['READY','SUSPENDED'].includes(v.recordedReadiness)||typeof v.revoked!=='boolean'||typeof v.configuredPolicyMatches!=='boolean'||v.qualification!=='NOT_CHECKED')fail();
      scope={key,expectedVersion};index=value;
    }catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)render();}
  });}
  return {render,reset,load};
}
