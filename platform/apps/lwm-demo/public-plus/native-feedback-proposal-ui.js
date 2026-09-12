const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sameRoot=(a,b)=>a?.type===b?.type&&a?.id===b?.id;
const sameInput=(a,b)=>['inputSnapshotId','labelSnapshotId','eventId'].every(k=>a?.[k]===b?.[k]);

// Only existing native snapshots/events are selectable. Preview is read-only;
// partition reservation and feedback proposal are distinct explicit native writes.
export function createNativeFeedbackProposal({document,api,run,isBusy,getDetail,getPrincipal}){
  const $=s=>document.querySelector(s);let options,optionsActorId,preview,pending,result,selected={},error='',notice='',generation=0;
  const current=g=>{if(g!==generation)throw Object.assign(Error('反馈提议会话已变化'),{discarded:true});};
  const scoped=()=>sameRoot(options?.root,getDetail()?.reference);
  const allowed=()=>getPrincipal()?.id===optionsActorId&&getPrincipal()?.roles?.includes('trainer')&&scoped();
  function reset(){generation++;options=optionsActorId=preview=pending=result=undefined;selected={};error=notice='';}
  function candidates(){const input=options?.items.find(v=>v.id===selected.inputSnapshotId),label=options?.items.find(v=>v.id===selected.labelSnapshotId);
    const event=label?.verificationEvents.find(v=>v.id===selected.eventId);return {input,label,event};}
  function selection(){const {input,label,event}=candidates();return input&&label&&event?{inputSnapshotId:input.id,labelSnapshotId:label.id,eventId:event.id}:null;}
  function submit(kind){
    if(isBusy()||!allowed())return;const actor=getPrincipal(),{label}=candidates(),input=selection();
    if(pending&&(pending.actorId!==actor.id||pending.kind!==kind))return;
    if(!pending){
      if(kind==='PROPOSE'&&(!input||!preview||!sameInput(input,preview.input)||!$('#feedback-propose-confirm')?.checked))return;
      if(kind==='RESERVE'&&(!label||label.reservation||!$('#feedback-reserve-confirm')?.checked))return;
      pending={kind,body:kind==='PROPOSE'?input:{snapshotId:label.id},actorId:actor.id};
    }
    const command=structuredClone(pending);void run(async epoch=>{const g=generation;error='';render();
      try{const value=await api(command.kind==='PROPOSE'?'/learning/feedback':'/learning/partitions',epoch,command.body);current(g);
        if(command.kind==='PROPOSE'){
          if(typeof value?.id!=='string'||!Number.isSafeInteger(value.version)||!['PROPOSED','APPROVED','REJECTED'].includes(value.status))throw Error('INVALID_FEEDBACK_PROPOSAL_RECEIPT');
          result={kind:command.kind,id:value.id,status:value.status};notice='反馈登记已返回；尚未因本操作获得独立批准、训练或发布许可。';
        }else{if(typeof value?._id!=='string'||!['TRAIN','VALIDATION','FINAL_EVAL','ONLINE'].includes(value.partition))throw Error('INVALID_PARTITION_RECEIPT');
          result={kind:command.kind,id:value._id,status:value.partition};notice='所选标签快照分区已登记；请重新读取材料并检查提议资格。事前输入资格不能补办。';}
        options=preview=pending=undefined;selected={};
      }catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)render();}
    });
  }
  function render(){
    const container=$('#feedback-proposal');if(!container)return;const root=getDetail()?.reference,{input,label,event}=candidates(),inScope=scoped();
    // The parent marks the workspace inert while running; don't persist the
    // transient busy flag in disabled attributes rendered before run settles.
    const disabled=!!pending||!inScope,selectOptions=(rows,key)=>'<option value="">请选择原生材料</option>'+rows.map(v=>`<option value="${escape(v.id)}" ${selected[key]===v.id?'selected':''}>${escape(v.id)} · ${escape(v.visibleAt??v.receivedAt)}${v.targetTime?' · 目标 '+escape(v.targetTime):''}</option>`).join('');
    container.innerHTML=`<h2>提出新的原生反馈</h2><p>当前对象：${escape(root?root.type+' / '+root.id:'尚未选择')}。选择已有输入与后续核验快照，不手填内部ID或标签。尚未建立快照时不能提议；本页不自动创建快照或追认事前数据。</p><button id="feedback-options-refresh" ${!root||pending||!getPrincipal()?.roles?.includes('trainer')?'disabled':''}>读取可用反馈材料</button>
      ${error?`<p class="error" role="alert">${escape(error)}</p>`:''}${notice?`<p role="status">${escape(notice)}</p>`:''}
      ${options?`<p>材料所属：${escape(options.root.type+' / '+options.root.id)}${inScope?'':'（与当前对象不同，请重新读取）'}。仅显示未标记暂停/过期且本次可读取的快照；这不是反馈批准。</p>
      <label>先前输入快照<select id="feedback-input" ${disabled?'disabled':''}>${selectOptions(options.items,'inputSnapshotId')}</select></label>
      <label>后续核验快照<select id="feedback-label" ${disabled?'disabled':''}>${selectOptions(options.items.filter(v=>v.verificationEvents.length),'labelSnapshotId')}</select></label>
      <label>独立核验事件<select id="feedback-event" ${disabled?'disabled':''}>${selectOptions(label?.verificationEvents??[],'eventId')}</select></label>
      ${input?`<p>输入可见截止 ${escape(input.visibleAt)}；分区 ${escape(input.reservation?.partition??'未登记')}。输入必须在标签获知前完成分区。</p>`:''}
      ${label?`<p>核验快照截止 ${escape(label.visibleAt)}；分区 ${escape(label.reservation?.partition??'未登记')}；选择事件 ${escape(event?.id??'尚未选择')}。</p>`:''}
      ${allowed()&&label&&!label.reservation?`<form id="feedback-reserve-form"><label><input id="feedback-reserve-confirm" type="checkbox" required ${pending?'checked disabled':''}>为所选后续核验快照登记原生分区；不改写先前输入的登记时间</label><button type="submit">${pending?'重试原分区登记':'登记标签快照分区'}</button></form>`:''}
      <button id="feedback-preview" ${disabled||!selection()?'disabled':''}>检查所选反馈资格</button>`:''}
      ${preview&&inScope?`<p>本次提议检查通过：变量 ${escape(preview.variable)}；目标 ${escape(preview.targetTime)}；输入截止 ${escape(preview.visibleAt)}；核验获知 ${escape(preview.receivedAt)}；分区 ${escape(preview.partition)}。没有创建反馈或授予训练资格。</p><form id="feedback-propose-form"><label><input id="feedback-propose-confirm" type="checkbox" required ${pending?'checked disabled':''}>仅提出反馈，等待其他审阅者独立核验</label><button type="submit">${pending?'重试原反馈提议':'提交原生反馈提议'}</button></form>`:''}
      ${pending?`<p role="status">${escape(pending.kind)} 结果未确认，保留原生引用和原请求负载。</p><button id="feedback-proposal-reconcile">停止重试并重新读取材料</button>`:''}
      ${result?`<p>原生操作回执：${escape(result.kind)} / ${escape(result.id)} / ${escape(result.status)}。不是当前模型训练资格。</p>`:''}`;
    $('#feedback-options-refresh').onclick=()=>{if(isBusy()||pending||!getDetail()?.reference||!getPrincipal()?.roles?.includes('trainer'))return;const reference=structuredClone(getDetail().reference),actorId=getPrincipal().id;
      void run(async epoch=>{const g=generation;options=preview=undefined;selected={};error='';render();
        try{const value=await api('/learning/feedback-options?'+new URLSearchParams({rootType:reference.type,rootId:reference.id}),epoch);current(g);
          if(value?.schema!=='plus-feedback-proposal-options-v1'||!sameRoot(value.root,reference)||value.readOnly!==true||value.learningEligible!==false||!Array.isArray(value.items)||value.items.length>32
            ||new Set(value.items.map(v=>v?.id)).size!==value.items.length||value.items.some(v=>typeof v?.id!=='string'||!Number.isSafeInteger(v.version)||v.version<1||v.qualification!=='SNAPSHOT_CHECKED_NOT_FEEDBACK_APPROVED'||!Array.isArray(v.verificationEvents)))throw Error('INVALID_FEEDBACK_OPTIONS');options=value;optionsActorId=actorId;
        }catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)render();}
      });};
    for(const [selector,key]of [['#feedback-input','inputSnapshotId'],['#feedback-label','labelSnapshotId'],['#feedback-event','eventId']]){
      const node=$(selector);if(node)node.onchange=()=>{if(isBusy()||pending||!inScope)return;selected[key]=node.value;if(key==='labelSnapshotId')selected.eventId='';preview=undefined;render();};
    }
    const check=$('#feedback-preview');if(check)check.onclick=()=>{if(isBusy()||pending||!allowed())return;const request=selection();if(!request)return;const saved=candidates();
      void run(async epoch=>{const g=generation;preview=undefined;error='';render();
        try{const value=await api('/learning/feedback-preview',epoch,request);current(g);
          if(value?.schema!=='plus-feedback-proposal-preview-v1'||!sameInput(value.input,request)||!sameRoot(value.root,options.root)||value.readOnly!==true||value.feedbackApproved!==false||value.learningEligible!==false
            ||value.snapshots?.input?.id!==saved.input.id||value.snapshots.input.version!==saved.input.version||value.snapshots?.label?.id!==saved.label.id||value.snapshots.label.version!==saved.label.version)throw Error('FEEDBACK_PREVIEW_CHANGED');preview=value;
        }catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)render();}
      });};
    const propose=$('#feedback-propose-form');if(propose)propose.onsubmit=e=>{e.preventDefault();submit('PROPOSE');};
    const reserve=$('#feedback-reserve-form');if(reserve)reserve.onsubmit=e=>{e.preventDefault();submit('RESERVE');};
    const reconcile=$('#feedback-proposal-reconcile');if(reconcile)reconcile.onclick=()=>{if(isBusy()||!pending||!getDetail()?.reference)return;
      pending=preview=undefined;notice='已停止客户端重试，未取消原生事务；请检查最新登记状态。';$('#feedback-options-refresh').onclick();};
  }
  return {render,reset};
}
