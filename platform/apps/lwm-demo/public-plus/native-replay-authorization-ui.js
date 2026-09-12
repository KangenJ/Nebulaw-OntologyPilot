const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ref=v=>v&&typeof v.id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v.id)&&Number.isSafeInteger(v.version)&&v.version>0;
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const invalid=()=>{throw Error('INVALID_REPLAY_AUTHORIZATION_INDEX');};

// Native purpose/selection discovery, independent online approval and current
// authorization reads. No model switch, implicit inference or business action.
export function createNativeReplayAuthorization({document,api,run,isBusy,getPrincipal}){
  const $=s=>document.querySelector(s);let scope,index,qualified,pending,result,error='',bound='',generation=0;
  const actor=()=>JSON.stringify([getPrincipal()?.tenantId,getPrincipal()?.id,[...(getPrincipal()?.roles??[])].sort()]);
  function reset(){generation++;scope=index=qualified=pending=result=undefined;error=bound='';}
  const check=(g,p)=>{if(g!==generation||p!==actor())throw Object.assign(Error('在线授权身份已变化'),{discarded:true});};
  const currentRow=()=>index?.items.find(v=>v.selection.id===scope?.revisionId);
  function perform(fn){if(isBusy()||bound!==actor())return;const g=generation,p=bound;
    return run(async epoch=>{error='';try{await fn(epoch,()=>check(g,p));}catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)render();}});
  }
  function read(id){if(pending||!index?.items.some(v=>v.id===id))return;return perform(async(epoch,valid)=>{
    qualified=undefined;render();const value=await api('/learning/replay-authorizations/'+encodeURIComponent(id),epoch);valid();
    const row=index.items.find(v=>v.id===id);
    if(value?.record?._id!==id||value.record._version!==row.version||value.record.controlKey!==scope.key||value.replayAuthorized!==true||value.predictionReady!==false
      ||value.material?.revision?.id!==scope.revisionId||value.material.generation!==scope.generation)invalid();
    qualified=value;
  });}
  function submit(event,kind,id){event.preventDefault();if(isBusy()||bound!==actor()||!getPrincipal()?.roles?.includes('model_owner'))return;
    if(!pending){const reason=$('#replay-authorization-reason')?.value?.trim();
      if(!reason||reason.length>2000||!$('#replay-authorization-confirm')?.checked){error='请填写理由并确认在线授权边界';render();return;}
      if(kind==='APPROVE'){
        if(!scope?.expectedVersion||currentRow())return;
        pending={kind,path:'/learning/replay-authorizations',input:{key:scope.key,expectedDeploymentVersion:scope.expectedVersion,reason}};
      }else{
        const row=index?.items.find(v=>v.id===id);if(!row||row.revoked)return;
        pending={kind,path:'/learning/replay-authorizations/'+encodeURIComponent(id)+'/revoke',input:{expectedVersion:row.version,reason}};
      }
    }
    const command=structuredClone(pending);qualified=undefined;
    return perform(async(epoch,valid)=>{
      const value=await api(command.path,epoch,command.input);valid();
      if(!ref(value)||value.predictionReady!==false||!['READY','SUSPENDED'].includes(value.readiness))invalid();
      result={...value,kind:command.kind};pending=undefined;scope=index=undefined;
    });
  }
  function render(){const container=$('#replay-authorization');if(!container)return;
    if(bound&&bound!==actor())reset();const owner=getPrincipal()?.roles?.includes('model_owner'),current=currentRow();
    container.innerHTML=`<h2>独立在线授权与恢复</h2><p>模型生效不等于允许推断。先读取原生授权目录，再由模型负责人明确授权。回滚后的新代次需要新授权；旧授权不能转移。此面板不执行重放或业务动作。</p>
      ${error?`<p class="error" role="alert">${escape(error)}</p>`:''}
      ${scope&&index?`<p>${escape(scope.key)} · 当前登记代次 ${escape(scope.generation)} / 对象 v${escape(scope.expectedVersion)}。目录资格 NOT_CHECKED，不证明模型当前有效。</p>
        <div class="table-wrap"><table><thead><tr><th>代次 / 授权</th><th>登记状态</th><th>操作</th></tr></thead><tbody>${index.items.map(r=>`<tr><td>${escape(r.generation)} / ${escape(r.id)}</td><td>${escape(r.recordedReadiness)}${r.revoked?' / 已撤销':''}${r.configuredPolicyMatches?'':' / 当前配置不匹配'}</td><td><button data-replay-authorization-id="${escape(r.id)}" ${pending?'disabled':''}>重新核验当前授权</button></td></tr>`).join('')||'<tr><td colspan="3">尚无登记授权</td></tr>'}</tbody></table></div>
        ${current?.revoked?'<p>当前代次的授权已撤销，不可原地复活；应先完成受治理的新模型选择，再独立授权。</p>':''}
        ${owner&&(!current&&scope.expectedVersion>0||current&&!current.revoked)?`<form id="replay-authorization-form"><label>${current?'撤销':'授权'}理由<textarea id="replay-authorization-reason" required maxlength="2000" ${pending?'disabled':''}>${escape(pending?.input.reason??'')}</textarea></label><label><input id="replay-authorization-confirm" type="checkbox" required ${pending?'checked disabled':''}>确认${current?'撤销在线使用许可，不撤销历史业务动作':'独立批准本代次在线使用；仍需有效事件和服务端重验'}</label><button type="submit">${pending?'继续原请求':current?'撤销当前代次授权':'提交独立在线授权'}</button></form>`:!owner?'<p>当前身份不是模型负责人；可读取获准的授权信息，不能代替独立批准。</p>':''}`:'<p>从上方模型用途选择“在线授权与恢复”。</p>'}
      ${qualified?`<p role="status">本次授权读取通过：${escape(qualified.record._id)}，第 ${escape(qualified.material.generation)} 代。尚未重放，不代表已有预测。</p>`:''}
      ${pending?'<p role="status">原请求结果未确认；继续时保持同一原生目标、版本和理由。请勿刷新后用不同理由另提请求。</p>':''}
      ${result?`<p role="status">原生${result.kind==='APPROVE'?'授权':'撤销'}回执 ${escape(result.id)} / v${escape(result.version)}。请重新读取目录；回执本身不是当前在线资格。</p>`:''}`;
    document.querySelectorAll('[data-replay-authorization-id]').forEach(button=>{if(button.dataset.replayAuthorizationId)button.onclick=()=>void read(button.dataset.replayAuthorizationId);});
    const form=$('#replay-authorization-form');if(form)form.onsubmit=event=>void submit(event,current?'REVOKE':'APPROVE',current?.id);
  }
  function load(key){if(isBusy()||pending)return;const p=actor();if(!getPrincipal()?.id)return;
    bound=p;return perform(async(epoch,valid)=>{
      scope=index=qualified=result=undefined;render();
      const selections=await api('/learning/deployments',epoch);valid();
      if(selections?.schema!=='plus-model-selection-index-v1'||selections.readOnly!==true||selections.predictionReady!==false||!Array.isArray(selections.items))invalid();
      const item=selections.items.find(v=>v.key===key),selection=item?.recordedSelection;
      if(item?.qualification!=='NOT_CHECKED'||!selection||!Number.isSafeInteger(selection.version)||selection.version<1||!ref({id:selection.revisionId,version:selection.generation}))invalid();
      const value=await api('/learning/replay-authorizations?'+new URLSearchParams({key}),epoch);valid();
      if(value?.schema!=='plus-replay-authorization-index-v1'||value.key!==key||!hash(value.policyHash)||value.readOnly!==true||value.replayAuthorized!==false||value.predictionReady!==false
        ||!Array.isArray(value.items)||value.items.length>100||new Set(value.items.map(v=>v.id)).size!==value.items.length)invalid();
      for(const row of value.items)if(!ref(row)||!hash(row.contentHash)||!ref(row.selection)||!hash(row.selection.hash)||!Number.isSafeInteger(row.generation)||row.generation<1
        ||!['READY','SUSPENDED'].includes(row.recordedReadiness)||typeof row.revoked!=='boolean'||typeof row.configuredPolicyMatches!=='boolean'||row.qualification!=='NOT_CHECKED')invalid();
      scope={key,expectedVersion:selection.version,revisionId:selection.revisionId,generation:selection.generation};index=value;
    });
  }
  return {render,reset,load,authorizationContext:()=>bound===actor()&&qualified?structuredClone(qualified):undefined};
}
