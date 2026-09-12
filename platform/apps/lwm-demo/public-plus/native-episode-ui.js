const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sameRoot=(a,b)=>a?.type===b?.type&&a?.id===b?.id;
const instant=value=>{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,19)!==value.slice(0,19))throw Error('请输入 UTC ISO 时间，例如 2026-09-08T08:00:00.000Z');return new Date(value).toISOString();};

// Native commands only. Metadata discovery is not source qualification. Unknown
// writes preserve the original body and idempotency key for the original actor.
export function createNativeEpisodeWorkbench({document,api,run,isBusy,getDetail,getPrincipal,newKey=()=>crypto.randomUUID()}){
  const $=s=>document.querySelector(s);let definitions,definitionRoot,definitionActor,index,episodeId='',stream,snapshot,pending,result,error='',notice='',generation=0;
  let definitionKey='',startedAt='',targetTime='';
  const current=g=>{if(g!==generation)throw Object.assign(Error('分析过程会话已变化'),{discarded:true});};
  const allowed=()=>sameRoot(index?.root,getDetail()?.reference)&&definitionActor===getPrincipal()?.id&&index?.definition.key===definitionKey;
  const episode=()=>index?.items.find(v=>v.id===episodeId);
  const hasDefinition=()=>sameRoot(definitionRoot,getDetail()?.reference)&&definitionActor===getPrincipal()?.id&&definitions?.some(v=>v.key===definitionKey);
  function reset(){generation++;definitions=definitionRoot=definitionActor=index=stream=snapshot=pending=result=undefined;definitionKey=episodeId=startedAt=targetTime=error=notice='';}
  function command(kind){
    if(isBusy()||!allowed())return;const e=episode();
    if(pending&&(pending.kind!==kind||pending.actorId!==getPrincipal()?.id))return;
    if(!pending){
      if(!$('#episode-'+kind.toLowerCase()+'-confirm')?.checked)return;
      if(kind==='OPEN'&&!index.capabilities.open||kind==='CAPTURE'&&(!e||!index.capabilities.capture)||kind==='SNAPSHOT'&&(!e||!stream||!index.capabilities.snapshot||stream.episodeId!==e.id))return;
      let body;try{body=kind==='OPEN'?{definitionKey,rootId:index.root.id,startedAt:instant($('#episode-start').value)}:kind==='CAPTURE'?{}:{streamId:stream.record._id,targetTime:instant($('#episode-target').value)};}catch(err){error=err.message;render();return;}
      pending={kind,body,path:kind==='OPEN'?'/episodes':kind==='CAPTURE'?'/episodes/'+encodeURIComponent(e.id)+'/captures':'/snapshots',key:newKey(),actorId:getPrincipal().id,root:{type:index.root.type,id:index.root.id},episodeId:e?.id};
    }
    const saved=structuredClone(pending);void run(async epoch=>{const g=generation;error='';render();
      try{const value=await api(saved.path,epoch,saved.body,saved.key);current(g);const row=saved.kind==='OPEN'?value:value?.record;
        if(typeof row?._id!=='string'||!Number.isSafeInteger(row._version)||row._version<1)throw Error('INVALID_EPISODE_RECEIPT');
        if(saved.kind==='OPEN'&&(!sameRoot(row.rootReference,saved.root)||row.definitionHash!==index.definition.hash||row.startedAt!==saved.body.startedAt))throw Error('EPISODE_RECEIPT_CHANGED');
        if(saved.kind==='CAPTURE'&&(value.episodeId!==saved.episodeId||!sameRoot(row.rootReference,saved.root)))throw Error('EPISODE_RECEIPT_CHANGED');
        if(saved.kind==='SNAPSHOT'&&(row.readSet?.stream?.id!==saved.body.streamId||row.targetTime!==saved.body.targetTime||!sameRoot(row.readSet?.root,saved.root)||value.predictionReady!==false))throw Error('EPISODE_RECEIPT_CHANGED');
        result={kind:saved.kind,id:row._id,version:row._version};notice='原生操作已返回并持久化；请刷新过程目录继续。没有批准训练或模型发布，也没有修改任务事实。';
        pending=index=stream=snapshot=undefined;episodeId='';
      }catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)render();}
    });
  }
  function render(){
    const container=$('#episode-workbench');if(!container)return;const root=getDetail()?.reference,e=episode(),can=allowed(),locked=!!pending||!can;
    const confirm=(kind,label)=>`<label><input id="episode-${kind}-confirm" type="checkbox" required ${pending?'checked disabled':''}>${label}</label>`;
    container.innerHTML=`<h2>原生分析过程与时间快照</h2><p>当前对象：${escape(root?root.type+' / '+root.id:'尚未选择')}。选择已发布本体机制，建立过程、采集可见证据，再指定目标时点生成快照。采集截止由服务器记录，不支持回填；后来的核验不会写入早期快照。</p>
      <button id="episode-definitions" ${!root||pending||!getPrincipal()?'disabled':''}>读取适用的已发布机制</button>${error?`<p class="error" role="alert">${escape(error)}</p>`:''}${notice?`<p role="status">${escape(notice)}</p>`:''}
      ${definitions?`<label>本体机制<select id="episode-definition" ${pending?'disabled':''}><option value="">请选择已发布机制</option>${definitions.map(v=>`<option value="${escape(v.key)}" ${definitionKey===v.key?'selected':''}>${escape(v.key)} · 修订 ${escape(v.revision)}</option>`).join('')}</select></label><button id="episode-index-refresh" ${pending||!hasDefinition()?'disabled':''}>刷新原生过程目录</button>`:''}
      ${index?`<p>目录读取时间 ${escape(index.observedAt)}；仅列本机制当前发布定义下的过程。以下是登记元数据，不是来源或模型资格。</p>${!can?'<p>对象、身份或机制已变化，请重新读取。</p>':''}
        ${can&&index.capabilities.open?`<form id="episode-open-form"><label>过程起点（UTC；更早的事件不进入过程）<input id="episode-start" value="${escape(startedAt)}" placeholder="2026-09-08T08:00:00.000Z" required ${pending?'disabled':''}></label>${confirm('open','确认新建过程，不用新过程代替已有请求重试')}<button type="submit">${pending?.kind==='OPEN'?'重试原创建请求':'建立原生分析过程'}</button></form>`:''}
        <label>已有过程<select id="episode-select" ${locked?'disabled':''}><option value="">请选择原生过程</option>${index.items.map(v=>`<option value="${escape(v.id)}" ${episodeId===v.id?'selected':''}>${escape(v.id)} · 起点 ${escape(v.startedAt)} · ${escape(v.streamRevision)} 次采集</option>`).join('')}</select></label>`:''}
      ${e&&can?`<p>过程 ${escape(e.id)}；起点 ${escape(e.startedAt)}。</p>
        ${index.capabilities.capture?`<form id="episode-capture-form">${confirm('capture','采集当前授权且有效的证据，保留原采集版本')}<button type="submit">${pending?.kind==='CAPTURE'?'重试原采集请求':'采集当前证据'}</button></form>`:''}
        <label>已登记采集版本<select id="episode-stream" ${locked?'disabled':''}><option value="">选择后重新检查来源</option>${e.streams.map(v=>`<option value="${escape(v.id)}" ${stream?.record._id===v.id?'selected':''}>第 ${escape(v.streamRevision)} 版 · ${escape(v.capturedAt)} · ${escape(v.id)}</option>`).join('')}</select></label>
        ${stream?`<p>本次采集读取已通过来源检查：${escape(stream.record._id)}；可见截止 ${escape(stream.record.capturedAt)}；引用事件 ${escape(stream.record.eventReferences.length)} 条。</p>${index.capabilities.snapshot?`<form id="episode-snapshot-form"><label>预测/核验的目标时点（UTC，不是采集截止）<input id="episode-target" value="${escape(targetTime)}" required ${pending?'disabled':''}></label>${confirm('snapshot','生成不可变输入快照，不表示预测或训练已获准')}<button type="submit">${pending?.kind==='SNAPSHOT'?'重试原快照请求':'生成原生时间快照'}</button></form>`:''}`:''}
        <label>已登记快照<select id="episode-snapshot" ${locked?'disabled':''}><option value="">选择后检查当前来源资格</option>${e.snapshots.map(v=>`<option value="${escape(v.id)}" ${snapshot?.record._id===v.id?'selected':''}>${escape(v.id)} · 目标 ${escape(v.targetTime)} · 登记状态 ${escape(v.recordedReadiness)}（未核验）</option>`).join('')}</select></label>
        ${snapshot?`<p>本次快照读取通过：${escape(snapshot.record._id)}；目标 ${escape(snapshot.record.targetTime)}；可见截止 ${escape(snapshot.record.visibleAt)}。输入完整度 ${escape(snapshot.record.readiness)}，不等于可训练或允许在线使用。到下方批次/反馈表单重新读取合格材料。</p>`:''}`:''}
      ${pending?'<p role="status">结果未确认，保留原负载和幂等键，仅原身份可重试。刷新页面会丢失客户端重试意图，原生记录不会丢失。</p><button id="episode-reconcile">停止重试并查原生目录</button>':''}
      ${result?`<p>原生回执：${escape(result.kind)} / ${escape(result.id)} / v${escape(result.version)}。</p>`:''}`;
    $('#episode-definitions').onclick=()=>{if(isBusy()||pending||!getDetail()?.reference||!getPrincipal())return;const reference=structuredClone(getDetail().reference),actor=getPrincipal().id;
      void run(async epoch=>{const g=generation;definitions=index=stream=snapshot=undefined;definitionKey=episodeId='';error='';render();
        try{const value=await api('/definitions',epoch);current(g);if(value?.readOnly!==true||value.predictionReady!==false||!Array.isArray(value.items)||value.items.length>128||value.items.some(v=>typeof v.key!=='string'||typeof v.rootType!=='string'))throw Error('INVALID_EPISODE_DEFINITIONS');
          definitions=value.items.filter(v=>v.status==='PUBLISHED'&&v.rootType===reference.type);definitionRoot=reference;definitionActor=actor;
        }catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)render();}
      });};
    const def=$('#episode-definition');if(def)def.onchange=()=>{if(isBusy()||pending)return;definitionKey=def.value;index=stream=snapshot=undefined;episodeId='';render();};
    const refresh=$('#episode-index-refresh');if(refresh)refresh.onclick=()=>{if(isBusy()||pending||!hasDefinition())return;const reference=structuredClone(getDetail().reference),key=definitionKey;
      void run(async epoch=>{const g=generation;index=stream=snapshot=undefined;episodeId='';error='';render();
        try{const value=await api('/episodes?'+new URLSearchParams({definitionKey:key,rootType:reference.type,rootId:reference.id}),epoch);current(g);
          if(value?.schema!=='plus-episode-root-index-v1'||!sameRoot(value.root,reference)||value.definition?.key!==key||value.readOnly!==true||value.predictionReady!==false||value.trainingEligible!==false||!Array.isArray(value.items)||value.items.length>32||!value.capabilities
            ||['open','capture','snapshot'].some(k=>typeof value.capabilities[k]!=='boolean')||new Set(value.items.map(v=>v.id)).size!==value.items.length||value.items.some(v=>typeof v.id!=='string'||v.qualification!=='NOT_CHECKED'||!Array.isArray(v.streams)||!Array.isArray(v.snapshots)||[...v.streams,...v.snapshots].some(r=>typeof r.id!=='string'||r.qualification!=='NOT_CHECKED')))throw Error('INVALID_EPISODE_INDEX');index=value;
        }catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)render();}
      });};
    const choose=$('#episode-select');if(choose)choose.onchange=()=>{if(isBusy()||pending||!can)return;episodeId=choose.value;stream=snapshot=undefined;targetTime='';render();};
    for(const [selector,kind]of [['#episode-stream','STREAM'],['#episode-snapshot','SNAPSHOT']]){const node=$(selector);if(!node)continue;node.onchange=()=>{if(isBusy()||pending||!allowed())return;
      const id=node.value,chosen=episode(),metadata=(kind==='STREAM'?chosen?.streams:chosen?.snapshots)?.find(v=>v.id===id);if(!metadata)return;
      void run(async epoch=>{const g=generation;if(kind==='STREAM')stream=undefined;else snapshot=undefined;error='';render();
        try{const value=await api((kind==='STREAM'?'/streams/':'/snapshots/')+encodeURIComponent(id),epoch);current(g);const row=value?.record;
          if(row?._id!==id||row._version!==metadata.version||!sameRoot(kind==='STREAM'?row.rootReference:row.readSet?.root,index.root)
            ||kind==='STREAM'&&(value.episodeId!==chosen.id||row.contentHash!==metadata.contentHash||!Array.isArray(row.eventReferences))
            ||kind==='SNAPSHOT'&&(value.predictionReady!==false||row.inputHash!==metadata.inputHash||row.readSet?.stream?.id!==metadata.streamId))throw Error('EPISODE_SELECTION_CHANGED');
          if(kind==='STREAM'){stream=value;targetTime=row.capturedAt;}else snapshot=value;
        }catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)render();}
      });};}
    for(const [id,field]of [['#episode-start','start'],['#episode-target','target']]){const node=$(id);if(node)node.oninput=()=>{if(isBusy()||pending)return;if(field==='start')startedAt=node.value;else targetTime=node.value;};}
    for(const kind of ['OPEN','CAPTURE','SNAPSHOT']){const form=$('#episode-'+kind.toLowerCase()+'-form');if(form)form.onsubmit=event=>{event.preventDefault();command(kind);};}
    const reconcile=$('#episode-reconcile');if(reconcile)reconcile.onclick=()=>{if(isBusy()||!pending)return;pending=undefined;notice='停止客户端重试，未取消原生事务；请核对已有过程、采集及快照。';$('#episode-index-refresh')?.onclick();};
  }
  return {render,reset,snapshotContext:()=>allowed()&&snapshot&&episode()?{
    root:structuredClone(index.root),episodeId:episode().id,definitionKey,
    snapshot:structuredClone(snapshot)}:undefined};
}
