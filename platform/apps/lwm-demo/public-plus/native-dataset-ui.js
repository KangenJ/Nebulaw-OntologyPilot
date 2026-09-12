const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sameRoot=(a,b)=>a?.type===b?.type&&a?.id===b?.id;
const actorKey=p=>JSON.stringify(p?{id:p.id,tenantId:p.tenantId,roles:[...(p.roles??[])].sort()}:null);
const referenceId=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);

// Discover native prospective membership, independently review it, then freeze
// through the existing native dataset transaction. Never author training labels.
export function createNativeDatasetWorkbench({document,api,run,isBusy,getDetail,getPrincipal,onDatasetChange=()=>{}}){
  const $=s=>document.querySelector(s);let index,item,qualified,pending,receipt,receiptContext,inspection,frozenIndex,frozenContext,error='',notice='',generation=0;
  const trainingContext=()=>receipt&&inspection?.id===receipt.id
    &&inspection.partition==='TRAIN'&&inspection.readiness==='READY'&&sameRoot(receiptContext?.root,getDetail()?.reference)&&receiptContext?.actor===actorKey(getPrincipal())
    ?{dataset:structuredClone(inspection),root:structuredClone(receiptContext.root)}:null;
  const trainingHistoryContext=()=>receipt&&sameRoot(receiptContext?.root,getDetail()?.reference)&&receiptContext?.actor===actorKey(getPrincipal())
    ?{dataset:structuredClone(receipt),root:structuredClone(receiptContext.root)}:null;
  const current=g=>{if(g!==generation)throw Object.assign(Error('数据集会话已变化'),{discarded:true});};
  function reset(){generation++;index=item=qualified=pending=receipt=receiptContext=inspection=frozenIndex=frozenContext=undefined;error=notice='';}
  const frozenInScope=()=>sameRoot(frozenContext?.root,getDetail()?.reference)&&frozenContext?.actor===actorKey(getPrincipal());
  const inScope=()=>sameRoot(index?.root,getDetail()?.reference);
  function operation(mode,body){
    const actor=getPrincipal();if(isBusy()||!item||!inScope())return;
    if(mode==='review'&&(!actor?.roles?.includes('data_reviewer')||actor.id===item.proposedBy||item.status!=='PROPOSED'))return;
    if(mode==='freeze'&&(!actor?.roles?.includes('trainer')||item.status!=='APPROVED'||!qualified?.freezeWindowOpen))return;
    if(pending&&(pending.actorId!==actor.id||pending.id!==item.id||pending.mode!==mode))return;
    if(!pending)pending={id:item.id,mode,body:structuredClone(body),actorId:actor.id,actor:actorKey(actor),root:structuredClone(getDetail().reference)};
    const command=structuredClone(pending);void run(async epoch=>{const g=generation;error='';render();
      try{const result=await api('/learning/cohorts/'+encodeURIComponent(command.id)+'/'+command.mode,epoch,command.body);current(g);
        if(command.mode==='review'){
          if(result?.id!==command.id||result.status!==(command.body.decision==='APPROVE'?'APPROVED':'REJECTED')||!Number.isSafeInteger(result.version))throw Error('INVALID_COHORT_RECEIPT');
          notice='原生批次审阅已登记：'+result.status+'。请重新读取当前批次；尚未冻结或训练。';
        }else{validateDataset(result);receipt=result;receiptContext={actorId:command.actorId,actor:command.actor,root:command.root};notice='原生数据集冻结回执已取得；不是当前训练资格或模型发布许可。';}
        index=item=qualified=pending=inspection=undefined;
      }catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)render();}
    });
  }
  function validateDataset(value){if(!value||typeof value.id!=='string'||!Number.isSafeInteger(value.version)||value.version<1||!['READY','INSUFFICIENT_DATA'].includes(value.readiness)
    ||!['TRAIN','VALIDATION','FINAL_EVAL'].includes(value.partition)||!value.coverage||!Number.isSafeInteger(value.coverage.enrolled)||!Number.isSafeInteger(value.coverage.eligible)
    ||value.coverage.enrolled<1||value.coverage.eligible<0||value.coverage.eligible>value.coverage.enrolled||!Number.isFinite(value.coverage.fraction)||value.coverage.fraction<0||value.coverage.fraction>1)throw Error('INVALID_DATASET_RECEIPT');}
  function render(){
    const container=$('#dataset-workbench');if(!container)return;const actor=getPrincipal(),root=getDetail()?.reference,scoped=inScope();
    const canReview=scoped&&item?.status==='PROPOSED'&&actor?.roles?.includes('data_reviewer')&&actor.id!==item.proposedBy;
    const canFreeze=scoped&&item?.status==='APPROVED'&&qualified?.freezeWindowOpen&&actor?.roles?.includes('trainer');
    const protocol=qualified?.record.payload.protocol;
    container.innerHTML=`<h2>原生采样批次与数据集</h2><p>当前对象：${escape(root?root.type+' / '+root.id:'尚未选择')}。登记不代表当前来源合格，批准批次不等于训练许可。</p><button id="cohorts-refresh" ${!root||pending?'disabled':''}>读取当前对象批次</button>
      ${error?`<p class="error" role="alert">${escape(error)}</p>`:''}${notice?`<p role="status">${escape(notice)}</p>`:''}
      ${index?`<p>批次所属对象：${escape(index.root.type+' / '+index.root.id)}${scoped?'':'（与当前对象不同，请重新读取）'}</p><table><thead><tr><th>协议与批次</th><th>登记状态</th><th>资格</th></tr></thead><tbody>${index.items.map(r=>`<tr><td>${escape(r.protocolKey)} / ${escape(r.id)}</td><td>${escape(r.status)} / ${escape(r.readiness)}</td><td><button data-cohort-id="${escape(r.id)}" ${pending||!scoped?'disabled':''}>核验成员与协议</button></td></tr>`).join('')||'<tr><td colspan="3">没有当前身份可读取且包含此对象的登记批次。</td></tr>'}</tbody></table>`:'<p>尚未查询，不预置采样批次。</p>'}
      ${qualified&&scoped?`<p>本次成员与协议核验通过：${escape(protocol.key)}；变量 ${escape(protocol.variable)}；分区 ${escape(protocol.partition)}；登记成员 ${escape(qualified.record.payload.members.length)}；最低样本 ${escape(protocol.minimumSamples)}；最低覆盖率 ${escape(protocol.minimumCoverage)}。</p><p>输入截止 ${escape(protocol.inputVisibleUntil)}；标签窗口 ${escape(protocol.labelReceivedFrom)} 至 ${escape(protocol.labelReceivedUntil)}；反馈审批截止 ${escape(protocol.approvalUntil)}。服务端冻结窗口：${qualified.freezeWindowOpen?'已到达':'未到达'}。不能改变既定门槛。</p>`:''}
      ${canReview?`<form id="cohort-review-form"><label>批次决定<select id="cohort-decision" ${pending?'disabled':''}><option value="REJECT" ${pending?.body.decision!=='APPROVE'?'selected':''}>拒绝</option>${qualified?.approvalWindowOpen?`<option value="APPROVE" ${pending?.body.decision==='APPROVE'?'selected':''}>批准</option>`:''}</select></label><label>理由<textarea id="cohort-reason" maxlength="2000" required ${pending?'disabled':''}>${escape(pending?.body.reason??'')}</textarea></label><label><input id="cohort-confirm" type="checkbox" required ${pending?'checked disabled':''}>确认在标签获知前独立审阅固定成员；失效或窗口关闭时只能拒绝</label><button type="submit">${pending?'重试原批次审阅':'提交原生批次审阅'}</button></form>`:''}
      ${canFreeze?`<form id="dataset-freeze-form"><label><input id="dataset-freeze-confirm" type="checkbox" required ${pending?'checked disabled':''}>按原协议冻结全部登记成员，保留缺失样本分母；不启动训练</label><button type="submit">${pending?'重试原冻结请求':'冻结原生数据集'}</button></form>`:qualified&&scoped?'<p>冻结需要批准批次、到达服务端截止时间和训练员权限；实际提交仍由服务端重新核验。</p>':''}
      ${pending?`<p role="status">结果未确认，保留原 ${escape(pending.mode)} 请求及负载，不能修改意图。</p><button id="cohort-reconcile">停止重试并重新读取批次</button>`:''}
      <h3>已冻结数据集历史</h3><p>只读查找原生回执；无需重新冻结或读取已撤回来源。登记状态不是当前训练资格。</p><button id="datasets-history-refresh" ${!root||!actor||pending?'disabled':''}>读取当前对象的冻结历史</button>
      ${frozenIndex&&frozenInScope()?`<table><thead><tr><th>协议 / 数据集</th><th>登记状态</th><th>历史引用</th></tr></thead><tbody>${frozenIndex.items.map(d=>`<tr><td>${escape(d.protocolKey)} / ${escape(d.id)}</td><td>${escape(d.partition)} / ${escape(d.readiness)}（NOT_CHECKED）</td><td><button data-frozen-dataset-id="${escape(d.id)}" ${pending?'disabled':''}>选择历史数据集</button></td></tr>`).join('')||'<tr><td colspan="3">当前身份可读取的批次中没有此对象的冻结回执。</td></tr>'}</tbody></table>`:''}
      ${receipt&&trainingHistoryContext()?`<p>历史冻结回执：${escape(receipt.id)} / v${escape(receipt.version)}；${escape(receipt.readiness)}；历史合格/登记 ${escape(receipt.coverage.eligible)}/${escape(receipt.coverage.enrolled)}。这是回执，不代表当前仍可用于计算。</p><button id="dataset-inspect">重新核验已冻结数据集</button>`:''}
      ${inspection?`<p>本次数据集读取核验：${escape(inspection.readiness)}；分区 ${escape(inspection.partition)}；覆盖率 ${escape(inspection.coverage.fraction)}。计算时仍须独立用途权限与资格检查，尚未训练模型。</p>`:''}`;
    onDatasetChange();
    $('#datasets-history-refresh').onclick=()=>{if(isBusy()||pending||!getDetail()?.reference||!getPrincipal())return;
      const c={root:structuredClone(getDetail().reference),actor:actorKey(getPrincipal())};void run(async epoch=>{const g=generation;frozenIndex=undefined;frozenContext=c;error='';render();
        try{const value=await api('/learning/datasets?'+new URLSearchParams({rootType:c.root.type,rootId:c.root.id}),epoch);current(g);
          if(!frozenInScope())throw Object.assign(Error('数据集对象或身份已变化'),{discarded:true});
          if(value?.schema!=='plus-frozen-dataset-root-index-v1'||!sameRoot(value.root,c.root)||value.readOnly!==true||value.trainingEligible!==false||!Array.isArray(value.items)||value.items.length>32
            ||new Set(value.items.map(v=>v?.id)).size!==value.items.length)throw Error('INVALID_FROZEN_DATASET_INDEX');
          for(const d of value.items){if(d?.qualification!=='NOT_CHECKED'||!referenceId(d.id)||!referenceId(d.cohortId)||typeof d.protocolKey!=='string'||!d.protocolKey||!Number.isFinite(Date.parse(d.createdAt))
            ||!['READY','INSUFFICIENT_DATA','STALE','SUSPENDED'].includes(d.readiness))throw Error('INVALID_FROZEN_DATASET_INDEX');
            validateDataset({...d,readiness:'INSUFFICIENT_DATA'});}
          frozenIndex=value;
        }catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)render();}
      });};
    document.querySelectorAll('[data-frozen-dataset-id]').forEach(button=>button.onclick=()=>{
      if(isBusy()||pending||!frozenInScope())return;const value=frozenIndex.items.find(d=>d.id===button.dataset.frozenDatasetId);if(!value)return;
      receipt=structuredClone(value);receiptContext=structuredClone(frozenContext);inspection=undefined;notice='已选择历史数据集引用，可只读查训练历史；没有重新冻结、训练或恢复来源资格。';render();
    });
    $('#cohorts-refresh').onclick=()=>{if(isBusy()||pending||!getDetail()?.reference)return;const reference=structuredClone(getDetail().reference);
      void run(async epoch=>{const g=generation;index=item=qualified=inspection=undefined;error='';render();
        try{const value=await api('/learning/cohorts?'+new URLSearchParams({rootType:reference.type,rootId:reference.id}),epoch);current(g);
          if(value?.schema!=='plus-cohort-root-index-v1'||!sameRoot(value.root,reference)||value.readOnly!==true||value.trainingEligible!==false||!Array.isArray(value.items)||value.items.length>32
            ||new Set(value.items.map(v=>v?.id)).size!==value.items.length||value.items.some(v=>v?.qualification!=='NOT_CHECKED'||typeof v.id!=='string'||!Number.isSafeInteger(v.version)||v.version<1))throw Error('INVALID_COHORT_INDEX');index=value;
        }catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)render();}
      });};
    document.querySelectorAll('[data-cohort-id]').forEach(button=>button.onclick=()=>{
      if(isBusy()||pending||!inScope())return;const row=index.items.find(v=>v.id===button.dataset.cohortId);if(!row)return;
      void run(async epoch=>{const g=generation;item=row;qualified=inspection=undefined;error='';render();
        try{const value=await api('/learning/cohorts/'+encodeURIComponent(row.id),epoch);current(g);
          if(value?.record?._id!==row.id||value.record._version!==row.version||value.record.status!==row.status||value.record.protocolKey!==row.protocolKey
            ||typeof value.approvalWindowOpen!=='boolean'||typeof value.freezeWindowOpen!=='boolean'||!value.record.payload?.members?.some(m=>sameRoot(m.root,index.root)))throw Error('COHORT_VERSION_OR_SCOPE_CHANGED');qualified=value;
        }catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)render();}
      });
    });
    const review=$('#cohort-review-form');if(review)review.onsubmit=e=>{e.preventDefault();if(getPrincipal()?.id!==actor?.id||isBusy()||!inScope())return;
      const decision=$('#cohort-decision').value,reason=$('#cohort-reason').value?.trim();
      if(!pending&&(!['APPROVE','REJECT'].includes(decision)||decision==='APPROVE'&&!qualified?.approvalWindowOpen||!reason||reason.length>2000||!$('#cohort-confirm').checked)){error='请核验成员、填写理由并确认独立审阅';render();return;}
      operation('review',{expectedVersion:item.version,decision,reason});};
    const freeze=$('#dataset-freeze-form');if(freeze)freeze.onsubmit=e=>{e.preventDefault();if(getPrincipal()?.id!==actor?.id||!$('#dataset-freeze-confirm').checked)return;operation('freeze',{});};
    const reconcile=$('#cohort-reconcile');if(reconcile)reconcile.onclick=()=>{if(isBusy()||!pending||!getDetail()?.reference)return;
      pending=item=qualified=inspection=undefined;notice='已停止客户端重试，未取消原生事务；重新查询批次后再核验。';$('#cohorts-refresh').onclick();};
    const inspect=$('#dataset-inspect');if(inspect)inspect.onclick=()=>{if(isBusy()||pending||!trainingHistoryContext())return;const id=receipt.id;
      void run(async epoch=>{const g=generation;inspection=undefined;error='';render();
        try{const value=await api('/learning/datasets/'+encodeURIComponent(id),epoch);current(g);validateDataset(value);if(value.id!==id)throw Error('DATASET_REFERENCE_CHANGED');inspection=value;
        }catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)render();}
      });};
  }
  return {render,reset,trainingContext,trainingHistoryContext};
}
