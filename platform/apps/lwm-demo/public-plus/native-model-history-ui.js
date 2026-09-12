const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const invalid=()=>{throw Error('INVALID_MODEL_HISTORY');};

// References come from the native selection chain. No raw revision IDs or
// client approval flags; rollback remains the existing governed transaction.
export function createNativeModelHistory({document,api,run,isBusy,getPrincipal,onSelectionChange=()=>{},onSubmitRollback,makeRequestKey=()=>globalThis.crypto.randomUUID()}){
  const $=s=>document.querySelector(s);let index,qualified,pending,result,error='',generation=0;
  const current=g=>{if(g!==generation)throw Object.assign(Error('模型历史会话已变化'),{discarded:true});};
  function reset(){generation++;index=qualified=pending=result=undefined;error='';}
  function render(){
    const container=$('#model-history');if(!container)return;
    container.innerHTML=`<h2>历史版本与受治理回滚</h2><p>先从模型用途读取原生历史，再检查目标版本的当前资格。回滚只创建新的模型选择，不恢复业务事实，也不自动重放或授予执行权限。</p>
      ${error?`<p class="error" role="alert">${escape(error)}</p>`:''}
      ${index?`<p>${escape(index.key)} · 当前选择版本 ${escape(index.expectedVersion)}</p><table><thead><tr><th>代次 / 工件</th><th>登记时间</th><th>当前资格</th></tr></thead><tbody>${index.items.map(r=>`<tr><td>${escape(r.generation)} · ${escape(r.release.key)}${r.id===index.currentRevisionId?'（当前登记）':''}</td><td>${escape(r.createdAt)}</td><td><button data-history-revision="${escape(r.id)}" ${pending?'disabled':''}>重新核验此版本</button></td></tr>`).join('')}</tbody></table>`:'<p>尚未读取模型历史。</p>'}
      ${qualified?`<p>已核验目标：${escape(qualified.selection.release.key)} · 原生修订 ${escape(qualified.record._id)}。核验仅对读取时成立，提交仍会独立重验。</p>
        ${qualified.record._id===index.currentRevisionId?'<p>目标已经是当前登记版本，无需回滚。</p>':getPrincipal()?.roles?.includes('model_owner')?`<form id="model-rollback-form"><label>回滚理由<textarea id="model-rollback-reason" required maxlength="2000" ${pending?'disabled':''}>${escape(pending?.reason??'')}</textarea></label><label><input id="model-rollback-confirm" type="checkbox" required ${pending?'checked disabled':''}>确认仅切换模型，后续仍需新在线许可和有效事件重放</label><button type="submit">${pending?'使用原请求重试':'提交受治理回滚'}</button></form>`:'<p>当前身份不是模型负责人；不提供回滚操作。服务端权限仍独立执行。</p>'}`:''}
      ${pending?`<p role="status">请求 ${escape(pending.requestKey)} 的结果尚未确认。重试保留相同目标、理由、版本及幂等键，不生成第二个请求。</p><button id="model-rollback-reconcile">放弃继续提交，重新检查原生历史</button>`:''}
      ${result?`<p role="status">原生回滚回执：${escape(result.revisionId)}。${result.current?'此回执仍是当前选择。':'此历史回执已不是当前选择，请重新读取。'}${result.replayed?'这是同一请求的幂等回执。':''}尚未在线就绪。</p>`:''}`;
    document.querySelectorAll('[data-history-revision]').forEach(button=>{if(!button.dataset.historyRevision)return;
      button.onclick=()=>{if(isBusy()||pending)return;const id=button.dataset.historyRevision,row=index?.items.find(r=>r.id===id);if(!row)return;
        void run(async epoch=>{const g=generation;qualified=undefined;result=undefined;error='';render();
          try{const value=await api('/learning/deployments/'+encodeURIComponent(index.key)+'/revisions/'+encodeURIComponent(id),epoch);current(g);
            if(value?.record?._id!==id||value.record._version!==row.version||value.deploymentId!==index.deploymentId||value.predictionReady!==false||value.executionAuthorized!==false
              ||value.selection?.release?.id!==row.release.id||value.selection.release.hash!==row.release.hash)invalid();qualified=value;
          }catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)render();}
        });};
    });
    const form=$('#model-rollback-form');if(form)form.onsubmit=event=>{event.preventDefault();if(isBusy()||!qualified||!index||qualified.record._id===index.currentRevisionId)return;
      if(!getPrincipal()?.roles?.includes('model_owner'))return;
      const reason=$('#model-rollback-reason')?.value?.trim();
      if(!pending&&(!reason||reason.length>2000||!$('#model-rollback-confirm')?.checked)){error='请填写理由并确认回滚边界';render();return;}
      if(!pending)pending={key:index.key,expectedVersion:index.expectedVersion,revisionId:qualified.record._id,requestKey:makeRequestKey(),reason};
      const command=structuredClone(pending);
      if(onSubmitRollback){if(onSubmitRollback({mode:'ROLLBACK',input:command})){pending=qualified=undefined;render();}return;}
      onSelectionChange();void run(async epoch=>{const g=generation;error='';render();
        try{const value=await api('/learning/deployments/rollback',epoch,command);current(g);
          if(value?.deploymentId!==index.deploymentId||typeof value.revisionId!=='string'||typeof value.current!=='boolean'||typeof value.replayed!=='boolean'||value.predictionReady!==false||value.replayRequired!==true)invalid();
          result=value;pending=qualified=index=undefined;
        }catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)render();}
      });
    };
    const reconcile=$('#model-rollback-reconcile');if(reconcile)reconcile.onclick=()=>{if(isBusy()||!pending)return;const key=pending.key;
      // Explicitly abandoning retries does not claim the operation failed or
      // undo it. A fresh native chain is required before another submission.
      pending=qualified=undefined;void load(key);
    };
  }
  function load(key){if(isBusy()||pending)return;return run(async epoch=>{const g=generation;index=qualified=result=undefined;error='';render();
    try{const value=await api('/learning/deployments/'+encodeURIComponent(key)+'/revisions',epoch);current(g);
      if(value?.schema!=='plus-model-selection-history-index-v1'||value.key!==key||value.readOnly!==true||value.predictionReady!==false||value.executionAuthorized!==false
        ||!Number.isSafeInteger(value.expectedVersion)||value.expectedVersion<1||!Array.isArray(value.items)||!value.items.length||value.items.length>1000
        ||new Set(value.items.map(r=>r.id)).size!==value.items.length||value.items[0].id!==value.currentRevisionId
        ||value.items.some(r=>r.qualification!=='NOT_CHECKED'||typeof r.id!=='string'||!Number.isSafeInteger(r.version)||!r.release))invalid();index=value;
    }catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)render();}
  });}
  return {render,reset,load};
}
