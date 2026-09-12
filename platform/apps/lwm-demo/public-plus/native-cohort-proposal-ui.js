const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sameRoot=(a,b)=>a?.type===b?.type&&a?.id===b?.id;

// Server-reviewed protocols and qualified native references only. Enrollment is
// not dataset approval, model training or publication; no outcome entry exists.
export function createNativeCohortProposal({document,api,run,isBusy,getDetail,getPrincipal}){
  const $=s=>document.querySelector(s);let options,actorId,protocolKey='',selected=new Set(),pending,result,error='',notice='',generation=0;
  const current=g=>{if(g!==generation)throw Object.assign(Error('批次登记会话已变化'),{discarded:true});};
  const allowed=()=>sameRoot(options?.root,getDetail()?.reference)&&actorId===getPrincipal()?.id&&getPrincipal()?.roles?.includes('trainer');
  const entry=()=>options?.items.find(v=>v.protocol.key===protocolKey);
  const members=()=>entry()?.items.filter(v=>selected.has(v.id))??[];
  function reset(){generation++;options=actorId=pending=result=undefined;protocolKey='';selected=new Set();error=notice='';}
  function submit(kind,snapshotId){
    if(isBusy()||!allowed())return;const e=entry(),rows=members();
    if(pending&&(pending.kind!==kind||pending.actorId!==getPrincipal().id))return;
    if(!pending){
      if(!e?.enrollmentOpen||e.registered)return;
      if(kind==='PROPOSE'&&(rows.length!==e.protocol.expectedSampleCount||rows.some(v=>!v.reservation)||new Set(rows.map(v=>v.sampleKey)).size!==rows.length||!$('#cohort-propose-confirm')?.checked))return;
      if(kind==='RESERVE'&&(!e.items.some(v=>v.id===snapshotId&&!v.reservation)||!$('#cohort-reserve-confirm')?.checked))return;
      pending={kind,actorId:getPrincipal().id,body:kind==='PROPOSE'?{protocolKey:e.protocol.key,inputSnapshotIds:rows.map(v=>v.id).sort()}:{snapshotId}};
    }
    const command=structuredClone(pending);void run(async epoch=>{const g=generation;error='';render();
      try{const value=await api(command.kind==='PROPOSE'?'/learning/cohorts':'/learning/partitions',epoch,command.body);current(g);
        if(command.kind==='PROPOSE'){
          if(typeof value?.id!=='string'||!Number.isSafeInteger(value.version)||value.version<1||!['PROPOSED','APPROVED','REJECTED'].includes(value.status))throw Error('INVALID_COHORT_RECEIPT');
          result={kind:command.kind,id:value.id,status:value.status};notice='原生批次登记已返回。须在标签窗口前由另一位审阅者独立批准；尚未冻结数据、训练或发布模型。';
        }else{
          if(typeof value?._id!=='string'||!['TRAIN','VALIDATION','FINAL_EVAL','ONLINE'].includes(value.partition))throw Error('INVALID_PARTITION_RECEIPT');
          result={kind:command.kind,id:value._id,status:value.partition};notice='分区由原生策略确定，不能选择或改写。请刷新；不属于协议分区的材料将不再列出。';
        }
        pending=options=undefined;selected.clear();
      }catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)render();}
    });
  }
  function render(){
    const container=$('#cohort-proposal');if(!container)return;const root=getDetail()?.reference,e=entry(),rows=members(),can=allowed(),locked=!!pending||!can;
    container.innerHTML=`<h2>登记事前采样批次</h2><p>当前对象：${escape(root?root.type+' / '+root.id:'尚未选择')}。协议来自服务器审核配置；可选择同一授权工作区的多个任务，不按后续标签筛选成员。样本数量、覆盖率和时间窗口不可在这里修改。</p>
      <button id="cohort-options-refresh" ${!root||pending||!getPrincipal()?.roles?.includes('trainer')?'disabled':''}>读取可登记协议与输入</button>
      ${error?`<p class="error" role="alert">${escape(error)}</p>`:''}${notice?`<p role="status">${escape(notice)}</p>`:''}
      ${options?`<label>审核协议<select id="cohort-protocol" ${locked?'disabled':''}><option value="">请选择服务器协议</option>${options.items.map(v=>`<option value="${escape(v.protocol.key)}" ${v.protocol.key===protocolKey?'selected':''}>${escape(v.protocol.key)} · ${v.registered?'已登记':v.enrollmentOpen?'登记窗口开放':'登记窗口关闭'}</option>`).join('')}</select></label>${!can?'<p>身份或对象已变化，请重新读取。</p>':''}`:''}
      ${e?`<p>监督变量：${escape(e.protocol.variable)}；分区：${escape(e.protocol.partition)}；要求成员 ${escape(e.protocol.expectedSampleCount)}；最低合格样本 ${escape(e.protocol.minimumSamples)}；最低覆盖率 ${escape(e.protocol.minimumCoverage)}。</p><p>输入可见窗口：${escape(e.protocol.inputVisibleFrom)} — ${escape(e.protocol.inputVisibleUntil)}；标签获知窗口：${escape(e.protocol.labelReceivedFrom)} — ${escape(e.protocol.labelReceivedUntil)}；反馈批准截止：${escape(e.protocol.approvalUntil)}。</p>
      ${e.registered?`<p>已登记原生批次 ${escape(e.registered.id)} / ${escape(e.registered.status)}；请在批次审阅区读取，不创建替代批次。这不是当前来源资格检查。</p>`:!e.enrollmentOpen?'<p>事前登记窗口已关闭；不能补办或回填时间。</p>':`<p>已选 ${rows.length} / ${escape(e.protocol.expectedSampleCount)}。每个对象/目标时点只能计一个样本；来源资格与分区在提交时重新检查。</p>
      ${e.items.map((v,i)=>`<label><input id="cohort-input-${i}" type="checkbox" ${selected.has(v.id)?'checked':''} ${locked?'disabled':''}>${escape(v.root.type+' / '+v.root.id)} · 目标 ${escape(v.targetTime)} · 输入 ${escape(v.id)} · ${escape(v.reservation?.partition??'未登记分区')}</label>`).join('')||'<p>没有合格的事前快照；先完成原生过程与快照创建，不使用预置结果替代。</p>'}
      ${e.items.some(v=>!v.reservation)?`<form id="cohort-reserve-form"><label>登记输入分区<select id="cohort-reserve-input" ${locked?'disabled':''}>${e.items.filter(v=>!v.reservation).map(v=>`<option value="${escape(v.id)}">${escape(v.id)}</option>`).join('')}</select></label><label><input id="cohort-reserve-confirm" type="checkbox" required ${pending?'checked disabled':''}>按原生策略登记，不保证属于本协议分区</label><button type="submit">${pending?.kind==='RESERVE'?'重试原分区登记':'登记所选输入分区'}</button></form>`:''}
      <form id="cohort-propose-form"><label><input id="cohort-propose-confirm" type="checkbox" required ${pending?'checked disabled':''}>确认事前成员，提交后等待独立审阅</label><button type="submit" ${!pending&&(rows.length!==e.protocol.expectedSampleCount||rows.some(v=>!v.reservation)||new Set(rows.map(v=>v.sampleKey)).size!==rows.length)||pending&&pending.kind!=='PROPOSE'?'disabled':''}>${pending?.kind==='PROPOSE'?'重试原批次登记':'提交原生采样批次'}</button></form>`}`:''}
      ${pending?'<p role="status">操作结果未确认，仅允许原身份重试原请求。停止重试不会取消已提交的原生事务。</p><button id="cohort-reconcile">停止重试并读取最新登记</button>':''}
      ${result?`<p>原生回执：${escape(result.kind)} / ${escape(result.id)} / ${escape(result.status)}；不代表当前训练资格。</p>`:''}`;
    $('#cohort-options-refresh').onclick=()=>{if(isBusy()||pending||!getDetail()?.reference||!getPrincipal()?.roles?.includes('trainer'))return;
      const reference=structuredClone(getDetail().reference),principalId=getPrincipal().id;void run(async epoch=>{const g=generation;options=undefined;selected.clear();protocolKey='';error='';render();
        try{const value=await api('/learning/cohort-options?'+new URLSearchParams({rootType:reference.type,rootId:reference.id}),epoch);current(g);
          if(value?.schema!=='plus-cohort-proposal-options-v1'||!sameRoot(value.root,reference)||value.readOnly!==true||value.trainingEligible!==false||!Array.isArray(value.items)||value.items.length>32
            ||new Set(value.items.map(v=>v?.protocol?.key)).size!==value.items.length||value.items.some(v=>typeof v?.protocol?.key!=='string'||!Number.isSafeInteger(v.protocol.expectedSampleCount)||v.protocol.expectedSampleCount<1||v.protocol.expectedSampleCount>100||typeof v.enrollmentOpen!=='boolean'||v.readOnly!==true||v.trainingEligible!==false||!Array.isArray(v.items)||v.items.length>100||new Set(v.items.map(r=>r?.id)).size!==v.items.length||v.items.some(r=>typeof r?.id!=='string'||typeof r.sampleKey!=='string'||!Number.isSafeInteger(r.version)||r.version<1||!r.root||r.qualification!=='SNAPSHOT_CHECKED_NOT_ENROLLED')))throw Error('INVALID_COHORT_OPTIONS');
          options=value;actorId=principalId;
        }catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)render();}
      });};
    const selector=$('#cohort-protocol');if(selector)selector.onchange=()=>{if(isBusy()||pending||!allowed())return;protocolKey=selector.value;selected.clear();render();};
    e?.items.forEach((v,i)=>{const checkbox=$('#cohort-input-'+i);if(checkbox)checkbox.onchange=()=>{if(isBusy()||pending||!allowed())return;if(checkbox.checked)selected.add(v.id);else selected.delete(v.id);render();};});
    const propose=$('#cohort-propose-form');if(propose)propose.onsubmit=event=>{event.preventDefault();submit('PROPOSE');};
    const reserve=$('#cohort-reserve-form');if(reserve)reserve.onsubmit=event=>{event.preventDefault();submit('RESERVE',$('#cohort-reserve-input')?.value);};
    const reconcile=$('#cohort-reconcile');if(reconcile)reconcile.onclick=()=>{if(isBusy()||!pending)return;pending=undefined;notice='已停止客户端重试，未取消原生事务；重新读取登记状态。';$('#cohort-options-refresh').onclick();};
  }
  return {render,reset};
}
