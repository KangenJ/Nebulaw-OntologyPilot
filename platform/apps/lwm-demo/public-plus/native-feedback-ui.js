const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sameRoot=(a,b)=>a?.type===b?.type&&a?.id===b?.id;

// Metadata is not learning eligibility. All decisions use the existing native
// independent-review endpoint; no raw feedback records or labels are authored.
export function createNativeFeedbackReview({document,api,run,isBusy,getDetail,getPrincipal}){
  const $=s=>document.querySelector(s);let index,item,qualified,pending,result,error='',notice='',generation=0;
  const current=g=>{if(g!==generation)throw Object.assign(Error('反馈会话已变化'),{discarded:true});};
  function reset(){generation++;index=item=qualified=pending=result=undefined;error=notice='';}
  function render(){
    const container=$('#feedback-review');if(!container)return;const root=getDetail()?.reference,p=getPrincipal(),inScope=index&&sameRoot(index.root,root);
    const canReview=inScope&&item?.status==='PROPOSED'&&p?.roles?.includes('data_reviewer')&&p.id!==item.proposedBy;
    container.innerHTML=`<h2>原生反馈与独立审阅</h2><p>当前对象：${escape(root?root.type+' / '+root.id:'尚未选择')}。登记列表不代表来源仍合格，批准后也不等于已训练模型。</p><button id="feedback-refresh" ${!root||pending?'disabled':''}>读取当前对象反馈</button>
      ${error?`<p class="error" role="alert">${escape(error)}</p>`:''}
      ${notice?`<p role="status">${escape(notice)}</p>`:''}
      ${index?`<p>反馈所属对象：${escape(index.root.type+' / '+index.root.id)}${inScope?'':'（与当前对象不同，请重新读取）'}</p><table><thead><tr><th>反馈 / 版本</th><th>登记状态</th><th>当前资格</th></tr></thead><tbody>${index.items.map(row=>`<tr><td>${escape(row.id)} / ${escape(row.version)}</td><td>${escape(row.status)} · ${escape(row.readiness)}</td><td><button data-feedback-id="${escape(row.id)}" ${pending||!inScope?'disabled':''}>检查来源与监督</button></td></tr>`).join('')||'<tr><td colspan="3">该对象没有当前身份可读取的反馈。</td></tr>'}</tbody></table>`:'<p>尚未查询，不加载预置反馈。</p>'}
      ${qualified&&inScope?`<p>本次来源检查通过。变量 ${escape(qualified.record.payload.evidence.variable)}；核验值 ${escape(JSON.stringify(qualified.record.payload.evidence.label))}；目标时间 ${escape(qualified.record.payload.evidence.targetTime)}；输入可见截止 ${escape(qualified.record.payload.evidence.visibleAt)}；核验获知时间 ${escape(qualified.record.payload.evidence.receivedAt)}。</p><p>状态：${escape(qualified.record.status)}。仍需满足独立审阅、数据分区和训练资格。</p>`:''}
      ${canReview?`<form id="feedback-review-form"><p>审阅目标：${escape(item.id)} / v${escape(item.version)}；提议者 ${escape(item.proposedBy)}。</p><label>决定<select id="feedback-decision" ${pending?'disabled':''}><option value="REJECT" ${pending?.body.decision!=='APPROVE'?'selected':''}>拒绝</option>${qualified?`<option value="APPROVE" ${pending?.body.decision==='APPROVE'?'selected':''}>批准</option>`:''}</select></label><label>理由<textarea id="feedback-reason" required maxlength="2000" ${pending?'disabled':''}>${escape(pending?.body.reason??'')}</textarea></label><label><input id="feedback-confirm" type="checkbox" required ${pending?'checked disabled':''}>确认独立审阅；来源失效时只能拒绝</label><button type="submit">${pending?'重试原审阅请求':'提交原生审阅'}</button></form>`:item?'<p>需要在同一对象下由独立数据审阅者处理尚未决定的反馈。</p>':''}
      ${pending?`<p role="status">审阅结果未确认，原决定为 ${escape(pending.body.decision)}。重试保留原决定、理由及版本；不能改成另一项决定。</p><button id="feedback-reconcile">停止重试并重新读取登记状态</button>`:''}
      ${result?`<p role="status">原生审阅回执：${escape(result.id)} / v${escape(result.version)} · ${escape(result.status)}。未触发模型训练或发布。</p>`:''}`;
    $('#feedback-refresh').onclick=()=>{if(isBusy()||pending||!getDetail()?.reference)return;const reference=getDetail().reference;
      void run(async epoch=>{const g=generation;index=item=qualified=result=undefined;error='';render();
        try{const q=new URLSearchParams({rootType:reference.type,rootId:reference.id}),value=await api('/learning/feedback?'+q,epoch);current(g);
          if(value?.schema!=='plus-feedback-root-index-v1'||!sameRoot(value.root,reference)||value.readOnly!==true||value.learningEligible!==false||!Array.isArray(value.items)||value.items.length>500
            ||new Set(value.items.map(v=>v?.id)).size!==value.items.length||value.items.some(v=>v?.qualification!=='NOT_CHECKED'||typeof v.id!=='string'||!Number.isSafeInteger(v.version)||v.version<1))throw Error('INVALID_FEEDBACK_INDEX');index=value;
        }catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)render();}
      });};
    const reconcile=$('#feedback-reconcile');if(reconcile)reconcile.onclick=()=>{
      if(isBusy()||!pending||!getDetail()?.reference)return;
      // This stops only client retries. The original transaction may have committed.
      pending=item=qualified=result=undefined;notice='已停止客户端重试，未取消原生事务；重新查询的登记状态仍不代表训练资格。';
      $('#feedback-refresh').onclick();
    };
    document.querySelectorAll('[data-feedback-id]').forEach(button=>{if(!button.dataset.feedbackId)return;button.onclick=()=>{
      if(isBusy()||pending||!sameRoot(index?.root,getDetail()?.reference))return;const row=index.items.find(v=>v.id===button.dataset.feedbackId);if(!row)return;
      void run(async epoch=>{const g=generation;item=row;qualified=result=undefined;error='';render();
        try{const value=await api('/learning/feedback/'+encodeURIComponent(row.id),epoch);current(g);
          if(value?.record?._id!==row.id||value.record._version!==row.version||value.record.status!==row.status||!sameRoot(value.record.payload?.evidence?.root,index.root))throw Error('FEEDBACK_VERSION_OR_SCOPE_CHANGED');qualified=value;
        }catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)render();}
      });};});
    const form=$('#feedback-review-form');if(form)form.onsubmit=event=>{event.preventDefault();const actor=getPrincipal();
      if(isBusy()||!canReview||!sameRoot(index?.root,getDetail()?.reference)||!actor?.roles?.includes('data_reviewer')||actor.id===item?.proposedBy)return;
      const decision=$('#feedback-decision').value,reason=$('#feedback-reason').value?.trim();
      if(!pending&&(!['APPROVE','REJECT'].includes(decision)||decision==='APPROVE'&&!qualified||!reason||reason.length>2000||!$('#feedback-confirm').checked)){error='请核验来源、填写理由并确认独立审阅';render();return;}
      if(!pending)pending={id:item.id,body:{expectedVersion:item.version,decision,reason}};
      const command=structuredClone(pending);void run(async epoch=>{const g=generation;error='';render();
        try{const value=await api('/learning/feedback/'+encodeURIComponent(command.id)+'/review',epoch,command.body);current(g);
          if(value?.id!==command.id||value.status!==(command.body.decision==='APPROVE'?'APPROVED':'REJECTED')||!Number.isSafeInteger(value.version))throw Error('INVALID_FEEDBACK_RECEIPT');
          result=value;index=item=qualified=pending=undefined;
        }catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)render();}
      });};
  }
  return {render,reset};
}
