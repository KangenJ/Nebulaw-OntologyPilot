const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const actor=p=>JSON.stringify(p?{id:p.id,tenantId:p.tenantId,roles:[...(p.roles??[])].sort()}:null);
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const key=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(v);
const version=v=>Number.isSafeInteger(v)&&v>0;
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const coverage=c=>c&&Number.isSafeInteger(c.enrolled)&&c.enrolled>0&&Number.isSafeInteger(c.eligible)&&c.eligible>=0&&c.eligible<=c.enrolled&&Number.isFinite(c.fraction)&&Math.abs(c.fraction-c.eligible/c.enrolled)<1e-12;
const statuses=['DRAFT','APPROVED','REJECTED','REVOKED'];
const BOOKMARK='plus.compute-authorization.lookup.v1';
const reference=v=>({type:v.type,id:v.id});

/** Native authorization authoring/review, not training or model approval.
 * Only a minimal read-only revision bookmark survives reentry; never tokens,
 * material, draft payload, reason or an automatically replayed mutation. */
export function createNativeComputeAuthorizationWorkbench({document,api,run,isBusy,getDetail,getPrincipal,bookmarkStore=globalThis.sessionStorage}){
 const $=s=>document.querySelector(s);let purposes,keyValue='',options,history,selectedId='',details,pending,bound,error='',notice='',generation=0,checked=new Set(),recipeHash='';
 const context=()=>({actor:actor(getPrincipal()),root:getDetail()?.reference?reference(getDetail().reference):null});
 const same=(c,root=false)=>c?.actor===context().actor&&(!root||JSON.stringify(c.root)===JSON.stringify(context().root));
 const permission=p=>same(bound)&&purposes?.items.find(i=>i.key===keyValue)?.permissions.includes(p);
 const selected=()=>history?.items.find(i=>i.id===selectedId);
 function save(k,r){try{const value=JSON.stringify({actor:context().actor,key:k,revision:r});bookmarkStore?.setItem(BOOKMARK,value);return bookmarkStore?.getItem(BOOKMARK)===value;}catch{return false;}}
 function clear(){try{bookmarkStore?.removeItem(BOOKMARK);}catch{}}
 function reset(){generation++;purposes=options=history=details=pending=bound=undefined;keyValue=selectedId=recipeHash='';checked.clear();error=notice='';}
 function current(g,c,root=false){if(g!==generation||!same(c,root))throw Object.assign(Error('训练授权身份或对象已变化'),{discarded:true});}
 function record(r){if(!r||!id(r.id)||!version(r.version)||!version(r.revision)||!key(r.key)||!statuses.includes(r.status)||r.predictionReady!==false||r.trainingStarted!==false)throw Error('INVALID_COMPUTE_AUTHORIZATION_RECORD');}
 function directory(v,k){if(v?.schema!=='plus-compute-authorization-directory-v1'||v.readOnly!==true||v.computeAuthorized!==false||!Array.isArray(v.items)||v.items.length>100||new Set(v.items.map(r=>r.id)).size!==v.items.length)throw Error('INVALID_COMPUTE_AUTHORIZATION_HISTORY');
  for(const r of v.items){record(r);if(r.key!==k||r.qualification!=='NOT_CHECKED'||!hash(r.recipeHash)||!Array.isArray(r.datasetIds)||r.datasetIds.length<1||r.datasetIds.length>10||r.datasetIds.some(v=>!id(v))||new Set(r.datasetIds).size!==r.datasetIds.length||typeof r.submittedBy!=='string')throw Error('INVALID_COMPUTE_AUTHORIZATION_HISTORY');}}
 function action(fn,root=false){if(isBusy())return;const c=context(),g=generation;void run(async epoch=>{error='';try{await fn(epoch,g,c);}catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)render();}});}
 function loadHistory(){if(!key(keyValue)||!getPrincipal()||(pending?pending.actor!==context().actor:!permission('compute-authorization:read')))return;const k=keyValue;action(async(epoch,g,c)=>{
  const v=await api('/learning/compute-authorizations/'+encodeURIComponent(k)+'/revisions',epoch);current(g,c);directory(v,k);history=v;details=undefined;
  if(pending){const found=v.items.find(r=>r.revision===pending.revision);if(found){selectedId=found.id;pending=undefined;clear();notice='已找到原生修订，显示其登记状态；这不是对上一请求成功的推定。没有重提或自动训练。';}else notice='尚未找到原修订；不代表请求已取消。保留原定位，稍后只读查询。';}
 });}
 function loadOptions(base){
  if(pending||!permission('compute-authorization:propose')||!context().root||base&&(selected()?.id!==base.id||selected()?.version!==base.version||base.status!=='APPROVED'||base.submittedBy!==getPrincipal()?.id))return;
  const k=keyValue;action(async(epoch,g,c)=>{options=undefined;checked.clear();recipeHash='';
   const v=await api('/learning/compute-authorization-options?'+new URLSearchParams({key:k,rootType:c.root.type,rootId:c.root.id,...(base?{baseRevision:String(base.revision)}:{})}),epoch);current(g,c,true);
   if(v?.schema!=='plus-compute-authorization-options-v1'||v.key!==k||JSON.stringify(reference(v.root??{}))!==JSON.stringify(c.root)||v.readOnly!==true||v.computeAuthorized!==false||v.qualification!=='NOT_CHECKED'||!version(v.nextRevision)||!version(v.maxDatasets)||v.maxDatasets>10
    ||!Array.isArray(v.datasets)||v.datasets.length>32||new Set(v.datasets.map(d=>d.id)).size!==v.datasets.length||v.datasets.some(d=>!id(d.id)||!version(d.version)||d.partition!=='TRAIN'||d.readiness!=='READY'||d.qualification!=='NOT_CHECKED'||!coverage(d.coverage))
    ||!Array.isArray(v.recipes)||v.recipes.length>32||new Set(v.recipes.map(r=>r.recipeHash)).size!==v.recipes.length||v.recipes.some(r=>!id(r.id)||!key(r.key)||!version(r.version)||!version(r.revision)||!hash(r.recipeHash)||r.qualification!=='NOT_CHECKED'))throw Error('INVALID_COMPUTE_AUTHORIZATION_OPTIONS');
   if(base?(!v.baseAuthorization||v.baseAuthorization.id!==base.id||v.baseAuthorization.version!==base.version||v.baseAuthorization.revision!==base.revision||v.baseAuthorization.qualification!=='NOT_CHECKED'
     ||v.datasets.some(d=>!['CURRENT_ROOT','BASE_AUTHORIZATION','CURRENT_AND_BASE'].includes(d.origin)||d.origin!=='CURRENT_ROOT'&&!base.datasetIds.includes(d.id))
     ||base.datasetIds.some(id=>!v.datasets.some(d=>d.id===id&&d.origin!=='CURRENT_ROOT'))):v.baseAuthorization!==undefined)throw Error('INVALID_COMPUTE_AUTHORIZATION_BASE');
   options={...v,context:c};});
 }
 function mutate(path,input,revision){if(pending||!key(keyValue))return;const c=context(),g=generation,k=keyValue;
  if(!save(k,revision)){error='无法保存原修订恢复定位；未提交。请启用会话存储后再操作。';render();return;}pending={actor:c.actor,key:k,revision};
  action(async epoch=>{render();const v=await api(path,epoch,input);current(g,c,true);record(v);if(v.key!==k||v.revision!==revision)throw Error('COMPUTE_AUTHORIZATION_RECEIPT_MISMATCH');
   pending=undefined;clear();options=history=details=undefined;checked.clear();recipeHash='';notice='原生授权回执：'+v.status+'；没有启动训练、批准模型或执行业务动作。';
  },true);
 }
 function render(){const container=$('#compute-authorization-workbench');if(!container)return;
  if(!pending&&!purposes){try{const saved=JSON.parse(bookmarkStore?.getItem(BOOKMARK)??'null');if(saved?.actor===context().actor&&key(saved.key)&&version(saved.revision)){pending={actor:saved.actor,key:saved.key,revision:saved.revision};keyValue=saved.key;}}catch{}}
  const c=context(),row=selected(),can=permission('compute-authorization:propose')&&same(options?.context,true),review=permission('compute-authorization:review')&&getPrincipal()?.id!==row?.submittedBy,
   revoke=permission('compute-authorization:revoke'),locked=!!pending;
  container.innerHTML=`<h2>原生训练授权</h2><p>授权只约束训练用途、完整批次与配方。提案、独立审核和训练提交是不同操作；历史批准不代表当前材料仍可用。</p>
   <button id="ca-refresh" ${locked?'disabled':''}>读取可见授权用途</button>${error?`<p class="error" role="alert">${escape(error)}</p>`:''}${notice?`<p role="status">${escape(notice)}</p>`:''}
   ${purposes?`<label>授权用途<select id="ca-purpose" ${locked?'disabled':''}><option value="">请选择</option>${purposes.items.map(i=>`<option value="${escape(i.key)}" ${keyValue===i.key?'selected':''}>${escape(i.key)} · ${escape(i.engineId)} · ${escape(i.classification)}</option>`).join('')}</select></label>`:''}
   ${keyValue?`<button id="ca-history">${locked?'只读查询原修订':'读取原生修订历史'}</button>`:''}
   ${locked?`<p>待确认原修订：${escape(pending.key)} / r${escape(pending.revision)}。不会自动重新提交、跳到新修订或执行训练。</p>`:''}
   ${permission('compute-authorization:propose')?`<button id="ca-options" ${!c.root||locked?'disabled':''}>读取当前对象的冻结批次与配方</button>`:''}
   ${options&&can?`<p>拟提案 r${options.nextRevision}；最多 ${options.maxDatasets} 个批次。此目录未检查当前训练资格，提交时服务端将重新核验。</p>
    ${options.baseAuthorization?`<p>累计参考：原生 r${options.baseAuthorization.revision}。历史批次已重新读取，但不沿用原审批；请明确选择新集合，重新审核。</p>`:''}
    ${options.datasets.map((d,i)=>`<label><input id="ca-dataset-${i}" type="checkbox" ${checked.has(d.id)?'checked':''} ${locked?'disabled':''}>${escape(d.protocolKey)} · ${escape(d.id)} / v${d.version} · ${escape(d.readiness)} · ${escape(d.origin==='BASE_AUTHORIZATION'?'历史授权批次':d.origin==='CURRENT_AND_BASE'?'当前对象与历史授权共有':'当前对象批次')} · 合格/登记 ${d.coverage.eligible}/${d.coverage.enrolled}</label>`).join('')||'<p>此对象没有匹配用途的冻结 TRAIN 批次。</p>'}
    <label>已登记批准的配方<select id="ca-recipe" ${locked?'disabled':''}><option value="">请选择</option>${options.recipes.map(r=>`<option value="${escape(r.recipeHash)}" ${recipeHash===r.recipeHash?'selected':''}>${escape(r.key)} / r${r.revision} · ${escape(r.engineId)}</option>`).join('')}</select></label>
    <form id="ca-propose"><label><input id="ca-propose-confirm" type="checkbox" required ${locked?'disabled':''}>确认所选完整批次和配方，提交独立审核，不启动训练</label><button type="submit" ${locked?'disabled':''}>提交原生授权提案</button></form>`:''}
   ${history&&same(bound)?`<label>原生修订<select id="ca-record" ${locked?'disabled':''}><option value="">请选择</option>${history.items.map(r=>`<option value="${escape(r.id)}" ${r.id===selectedId?'selected':''}>r${r.revision} · ${escape(r.status)} · ${escape(r.submittedBy)}</option>`).join('')}</select></label>`:''}
   ${row&&same(bound)?`<p>r${row.revision} / 对象 v${row.version} · ${escape(row.status)} · 提交者 ${escape(row.submittedBy)}；批次 ${row.datasetIds.map(escape).join('、')}；配方 ${escape(row.recipeHash)}。NOT_CHECKED。</p>
    ${permission('compute-authorization:propose')&&row.status==='APPROVED'&&row.submittedBy===getPrincipal()?.id?`<button id="ca-use-base" ${!c.root||locked?'disabled':''}>以此授权为累计参考读取批次</button>`:''}
    ${review?'<button id="ca-details">以我的权限读取审核材料</button>':''}
    ${details?.record?.id===row.id?`<p>配方 ${escape(details.recipe.key)} / r${details.recipe.revision}，登记 ${escape(details.recipe.status)}。读取不等于批准。</p>${details.datasets.map(d=>`<p>批次 ${escape(d.id)} / v${d.version} · ${escape(d.partition)} · ${escape(d.readiness)} · 合格/登记 ${d.coverage.eligible}/${d.coverage.enrolled}</p>`).join('')}`:''}
    ${review&&row.status==='DRAFT'||revoke&&row.status==='APPROVED'?`<form id="ca-decision"><label>明确决定<select id="ca-decision-kind">${row.status==='APPROVED'?'<option value="REVOKE">撤销训练授权</option>':`<option value="REJECT">拒绝提案</option>${details?.record?.id===row.id?'<option value="APPROVE">批准训练授权</option>':''}`}</select></label><label>理由<textarea id="ca-reason" maxlength="256" required></textarea></label><label><input id="ca-decision-confirm" type="checkbox" required>确认此原生修订和决定，不启动训练</label><button type="submit" ${locked?'disabled':''}>提交独立决定</button></form>`:''}`:''}`;
  $('#ca-refresh').onclick=()=>{if(pending)return;action(async(epoch,g,c)=>{purposes=options=history=details=undefined;keyValue=selectedId=recipeHash='';checked.clear();const v=await api('/learning/compute-authorization-purposes',epoch);current(g,c);
   if(v?.schema!=='plus-compute-authorization-purpose-directory-v1'||v.readOnly!==true||v.computeAuthorized!==false||v.trainingStarted!==false||!Array.isArray(v.items)||v.items.length>100||new Set(v.items.map(i=>i.key)).size!==v.items.length
    ||v.items.some(i=>!key(i.key)||i.qualification!=='NOT_CHECKED'||!Array.isArray(i.permissions)||i.permissions.some(p=>!['propose','review','read','use','revoke'].map(s=>'compute-authorization:'+s).includes(p))))throw Error('INVALID_COMPUTE_AUTHORIZATION_PURPOSES');purposes=v;bound=c;});};
  if($('#ca-purpose'))$('#ca-purpose').onchange=()=>{if(isBusy()||pending||!same(bound))return;const k=$('#ca-purpose').value;keyValue=purposes.items.some(i=>i.key===k)?k:'';options=history=details=undefined;selectedId=recipeHash='';checked.clear();render();};
  if($('#ca-history'))$('#ca-history').onclick=()=>{if(pending?.actor===context().actor&&!same(bound)&&!purposes)bound=context();loadHistory();};
  if($('#ca-options'))$('#ca-options').onclick=()=>loadOptions();
  if($('#ca-use-base'))$('#ca-use-base').onclick=()=>loadOptions(structuredClone(row));
  options?.datasets.forEach((d,i)=>{if($('#ca-dataset-'+i))$('#ca-dataset-'+i).onchange=()=>{if(isBusy()||pending||!same(options.context,true))return;if($('#ca-dataset-'+i).checked)checked.add(d.id);else checked.delete(d.id);render();};});
  if($('#ca-recipe'))$('#ca-recipe').onchange=()=>{if(!isBusy()&&!pending&&same(options?.context,true)){recipeHash=$('#ca-recipe').value;render();}};
  if($('#ca-propose'))$('#ca-propose').onsubmit=e=>{e.preventDefault();if(isBusy()||pending||!permission('compute-authorization:propose')||!same(options?.context,true)||!$('#ca-propose-confirm').checked||!checked.size||checked.size>options.maxDatasets||![...checked].every(id=>options.datasets.some(d=>d.id===id))||!options.recipes.some(r=>r.recipeHash===recipeHash))return;
   mutate('/learning/compute-authorizations',{key:keyValue,revision:options.nextRevision,datasetIds:[...checked].sort(),recipeHash},options.nextRevision);};
  if($('#ca-record'))$('#ca-record').onchange=()=>{if(isBusy()||pending||!same(bound))return;selectedId=history.items.some(r=>r.id===$('#ca-record').value)?$('#ca-record').value:'';details=undefined;if(options?.baseAuthorization){options=undefined;checked.clear();recipeHash='';}render();};
  if($('#ca-details'))$('#ca-details').onclick=()=>{if(isBusy()||pending||!permission('compute-authorization:review')||getPrincipal()?.id===row.submittedBy||selected()?.id!==row.id)return;const saved=structuredClone(row),k=keyValue;action(async(epoch,g,c)=>{details=undefined;const v=await api('/learning/compute-authorization-review?'+new URLSearchParams({key:k,revision:String(saved.revision)}),epoch);current(g,c);
   if(v?.schema!=='plus-compute-authorization-review-v1'||v.record?.id!==saved.id||v.record.version!==saved.version||v.record.key!==saved.key||v.record.revision!==saved.revision||v.record.status!==saved.status||v.readOnly!==true||v.computeAuthorized!==false||v.qualification!=='NOT_CHECKED'||!Array.isArray(v.datasets)||v.datasets.length!==saved.datasetIds.length||new Set(v.datasets.map(d=>d.id)).size!==v.datasets.length||v.datasets.some(d=>!saved.datasetIds.includes(d.id)||!version(d.version)||d.partition!=='TRAIN'||d.readiness!=='READY'||!coverage(d.coverage))||v.recipe?.recipeHash!==saved.recipeHash||!id(v.recipe.id)||!key(v.recipe.key)||!version(v.recipe.revision)||v.recipe.status!=='APPROVED')throw Error('INVALID_COMPUTE_AUTHORIZATION_REVIEW');details=v;});};
  if($('#ca-decision'))$('#ca-decision').onsubmit=e=>{e.preventDefault();if(isBusy()||pending||!same(bound)||selected()?.id!==row.id||selected()?.version!==row.version||row.key!==keyValue||!$('#ca-decision-confirm').checked)return;const decision=$('#ca-decision-kind').value,reason=$('#ca-reason').value?.trim();
   if(!reason||reason.length>256||/[\x00-\x1f\x7f*]/.test(reason))return;
   if(decision==='REVOKE'){if(!revoke||row.status!=='APPROVED')return;mutate('/learning/compute-authorizations/'+row.id+'/revoke',{expectedVersion:row.version,reason},row.revision);}
   else{if(!review||row.status!=='DRAFT'||!['APPROVE','REJECT'].includes(decision)||decision==='APPROVE'&&details?.record?.id!==row.id)return;
    mutate('/learning/compute-authorizations/'+row.id+'/review',{expectedVersion:row.version,decision,reason},row.revision);}
  };
 }
 return {render,reset};
}
