const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pretty=v=>'<pre>'+escape(JSON.stringify(v,null,2))+'</pre>';
const roles=['FACT','OBSERVATION','LATENT','CONTEXT','RULE_DERIVED'];
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fail=m=>{throw Error(m);};
const number=(value,label,integer=false)=>{if(typeof value!=='string'||!value.trim())fail(label+' 必须填写');const n=Number(value);if(!Number.isFinite(n)||n<0||integer&&!Number.isSafeInteger(n))fail(label+' 必须为有效非负'+(integer?'整数':'数值'));return n;};
const atoms=(value,type)=>{
  if(typeof value!=='string')fail('请填写类别');if(!value.trim())return [];
  return value.split(/\r?\n/).map(s=>{const t=s.trim();if(!t)fail('类别不能包含空行');if(type==='Boolean'){if(!['true','false'].includes(t))fail('布尔类别须为 true 或 false');return t==='true';}
    if(['Int','Float','Double','Decimal'].includes(type)){const n=Number(t);if(!Number.isFinite(n)||type==='Int'&&!Number.isSafeInteger(n))fail('数值类别无效');return n;}return t;});
};

// Bounded form editor. Policy, verification eligibility, module implementations,
// native action bindings and tenancy cannot be injected through form fields.
export function editDefinitionCandidate(base,values){
  const d=structuredClone(base);d.title=String(values['definition-title']??'').trim();if(!d.title||d.title.length>2000)fail('请填写机制名称');
  d.variables.forEach((v,i)=>{const prefix='definition-variable-'+i+'-';v.source.field=String(values[prefix+'field']??'');v.role=values[prefix+'role'];if(!roles.includes(v.role))fail('变量角色无效');
    v.unit=String(values[prefix+'unit']??'').trim();if(!v.unit)fail('单位不能为空');v.support=atoms(values[prefix+'support'],v.valueType);v.unknownValues=atoms(values[prefix+'unknown'],v.valueType);
    v.time.eventTimeField=String(values[prefix+'event']??'');v.time.receivedTimeField=String(values[prefix+'received']??'');});
  for(const k of ['mechanisms','horizon','alternatives','branchDepth'])d.budget[k]=number(values['definition-budget-'+k],k,true);
  for(const k of ['verificationCost','minimumDifference'])d.utility[k]=number(values['definition-utility-'+k],k);
  d.utility.losses=d.utility.losses.map((row,i)=>row.map((_,j)=>number(values['definition-loss-'+i+'-'+j],'损失')));
  return d;
}
const formValues=d=>{
  const values={'definition-title':d.title};d.variables.forEach((v,i)=>{const p='definition-variable-'+i+'-';Object.assign(values,{[p+'field']:v.source.field,[p+'role']:v.role,[p+'unit']:v.unit,[p+'support']:v.support.join('\n'),[p+'unknown']:v.unknownValues.join('\n'),[p+'event']:v.time.eventTimeField,[p+'received']:v.time.receivedTimeField});});
  for(const k of ['mechanisms','horizon','alternatives','branchDepth'])values['definition-budget-'+k]=String(d.budget[k]);
  for(const k of ['verificationCost','minimumDifference'])values['definition-utility-'+k]=String(d.utility[k]);
  d.utility.losses.forEach((row,i)=>row.forEach((n,j)=>values['definition-loss-'+i+'-'+j]=String(n)));return values;
};
export function createNativeDefinitionWorkbench({document,api,run,isBusy,getCatalog,getPrincipal,onRender}){
  const $=s=>document.querySelector(s);let index,key='',base,values={},preview,revisions,selected,pending,error='',notice='',generation=0;
  const can=role=>getPrincipal()?.roles.includes(role);
  const current=g=>{if(g!==generation)throw Object.assign(Error('机制会话已变化'),{discarded:true});};
  function reset(){generation++;index=base=preview=revisions=selected=pending=undefined;key=error=notice='';values={};}
  const act=work=>{if(isBusy())return;void run(async epoch=>{const g=generation;error='';try{await work(epoch,g);current(g);}catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)onRender();}});};
  const path=()=>'/definitions/'+encodeURIComponent(key);
  const checkPreview=(v,schema)=>{if(v?.schema!==schema||v.definition?.key!==key||!hash(v.compiledHash)||!hash(v.definitionHash)||!hash(v.ontologyHash)||v.readOnly!==true||v.predictionReady!==false||v.executionAuthorized!==false)fail('INVALID_DEFINITION_PREVIEW');};
  async function list(epoch,g){const rows=await api(path()+'/revisions',epoch);current(g);if(!Array.isArray(rows)||rows.some(r=>r.definitionKey!==key))fail('INVALID_DEFINITION_REVISIONS');revisions=rows;}
  async function read(id,epoch,g){const detail=await api(path()+'/revisions/'+encodeURIComponent(id),epoch);current(g);if(detail?.record?._id!==id||detail.record.definitionKey!==key||detail.predictionReady!==false)fail('INVALID_DEFINITION_REVISION');selected=detail;return detail;}
  function accepted(command,detail){const row=detail.record;if(command.kind==='DRAFT')return row.revision===command.body.definition.revision&&row.submittedBy===command.actor&&row.definitionHash===command.definitionHash&&row.compiledHash===command.body.expectedCompiledHash;
    if(row._version<=command.body.expectedVersion)return false;
    return command.kind==='VALIDATE'?['VALIDATED','PUBLISHED','REJECTED','SUPERSEDED'].includes(row.status):row.status===(command.body.decision==='APPROVE'?'PUBLISHED':'REJECTED')&&row.approvedBy===command.actor;
  }
  async function submit(epoch,g){
    const command=pending;if(!command||command.actor!==getPrincipal()?.id)fail('请重新登录并查证原修订');
    command.sent=true;command.recovery=undefined;let response;
    try{response=await api(command.path,epoch,structuredClone(command.body),command.key);}
    catch(e){current(g);command.definitiveRefusal=[400,409].includes(e.status)&&/^(DEFINITION_PREVIEW_STALE|DEFINITION_REVISION_CONFLICT|INVALID_INPUT)$/.test(e.message);throw e;}
    current(g);
    if(!response?._id||response.definitionKey!==key)fail('INVALID_DEFINITION_RECEIPT');command.id=response._id;
    const detail=await read(command.id,epoch,g);if(!accepted(command,detail))fail('DEFINITION_RECEIPT_CHANGED');pending=undefined;preview=undefined;notice='原生修订已保存；定义发布与模型就绪是不同状态。';await list(epoch,g);
  }
  async function recover(epoch,g){
    const command=pending;if(!command)return;await list(epoch,g);
    const row=command.id?revisions.find(r=>r._id===command.id):revisions.find(r=>r.revision===command.body.definition.revision);
    if(!row){if(command.definitiveRefusal)command.recovery='NO_COMMITTED_REVISION';notice='尚未读到原修订；原请求有明确拒绝时可返回编辑，否则只保留原请求重试。';return;}
    const detail=await read(row._id,epoch,g);if(accepted(command,detail)){pending=preview=undefined;notice='已查证原请求的原生修订，没有重复执行。';}
    else if(command.kind!=='DRAFT'&&row._version===command.body.expectedVersion){notice='当前版本尚未变化；可重试同一版本请求。';}
    else fail('原修订与请求不一致，保留当前材料，请检查冲突');
  }
  const input=(id,label,type='text')=>`<label>${escape(label)}<input id="${id}" type="${type}" ${type==='number'?'min="0" step="any"':''} value="${escape(values[id])}" ${pending?'disabled':''}></label>`;
  function markup(){
    const record=selected?.record,compatible=selected?.compatibility?.compatible===true,targetSupport=base?.variables.find(v=>v.key===base.utility.target)?.support??[];
    return `<section class="panel"><h2>机制候选与受控发布</h2><p>从服务器配置的领域候选起步，按当前本体校验。候选不是模型、独立核验或已批准机制；这里不训练，也不修改业务事实。</p><button id="definition-candidates-refresh" ${pending?'disabled':''}>发现可用机制候选</button>${error?'<p class="error" role="alert">'+escape(error)+'</p>':''}${notice?'<p role="status">'+escape(notice)+'</p>':''}
      ${index?`<label>领域候选<select id="definition-candidate-key" ${pending?'disabled':''}><option value="">请选择</option>${index.items.map(i=>`<option value="${escape(i.key)}" ${i.key===key?'selected':''}>${escape(i.title)} · ${escape(i.rootType)}</option>`).join('')}</select></label><button id="definition-candidate-load" ${!key||pending?'disabled':''}>读取候选与修订</button>${index.items.length?'':'<p>当前没有授权候选，请先完成受审领域配置；不会自动载入测试样例。</p>'}`:''}
      ${base?`<form id="definition-edit-form"><h3>编辑下一修订 r${escape(base.revision)}</h3><p>机制 ${escape(base.key)} · 根对象 ${escape(base.rootType)}。角色、单位与时间须满足服务端语义策略；不能把流程状态改名当成真实标签。</p>${input('definition-title','机制名称')}
      ${base.variables.map((v,i)=>{const p='definition-variable-'+i+'-',type=getCatalog()?.bundle?.parsed?.objectTypes?.find(t=>t.name===v.source.objectType),fields=type?.fields?.map(f=>f.name)??[v.source.field];return `<details><summary>${escape(v.key)} · ${escape(v.source.objectType)}</summary><p>关系路径 ${escape(v.source.path?JSON.stringify(v.source.path):'根对象字段')} · 类型 ${escape(v.valueType)}</p><label>本体属性<select id="${p}field" ${pending?'disabled':''}>${fields.map(f=>`<option value="${escape(f)}">${escape(f)}</option>`).join('')}</select></label><label>变量角色<select id="${p}role" ${pending?'disabled':''}>${roles.map(r=>`<option>${r}</option>`).join('')}</select></label>${input(p+'unit','单位')}<label>支持类别（每行一个，保留顺序）<textarea id="${p}support" ${pending?'disabled':''}>${escape(values[p+'support'])}</textarea></label><label>未知标识（每行一个）<textarea id="${p}unknown" ${pending?'disabled':''}>${escape(values[p+'unknown'])}</textarea></label>${input(p+'event','发生/生效时间字段')}${input(p+'received','接收/记录时间字段')}<p>缺失、监督与策略引用仍保持候选定义，改变字段不能绕过它们。</p>${pretty({missing:v.missingPolicy,verification:v.verification,accessPolicyRef:v.accessPolicyRef,transform:v.transform})}</details>`;}).join('')}
      <h3>计算预算与决策假设</h3><div class="row">${['mechanisms','horizon','alternatives','branchDepth'].map(k=>input('definition-budget-'+k,k,'number')).join('')}${['verificationCost','minimumDifference'].map(k=>input('definition-utility-'+k,k,'number')).join('')}</div><p>损失矩阵行是决策、列是目标状态，不要求方阵。标签按载入的目标支持显示；改变支持后必须检查服务器预检中的完整定义与损失顺序。这是审核配置，不是模型学得的事实。</p>${base.utility.losses.map((row,i)=>'<div class="row">'+row.map((_,j)=>input('definition-loss-'+i+'-'+j,base.utility.decisions[i]+' → '+String(targetSupport[j]??j),'number')).join('')+'</div>').join('')}<details><summary>检查固定模块、动作及范围</summary>${pretty({modules:base.modules,actions:base.actions,scope:base.scope})}</details><button ${pending||!can('data_reviewer')?'disabled':''}>服务器预检编辑结果</button></form>`:''}
      <div id="definition-preview">${preview?'<h3>待明确保存的规范化定义</h3>'+pretty({definition:preview.definition,compiledHash:preview.compiledHash,ontologyHash:preview.ontologyHash,policyHash:preview.policyHash})+'<button id="definition-save" '+(pending||!can('data_reviewer')?'disabled':'')+'>保存原生草稿</button>':''}</div>
      ${key?'<button id="definition-revisions-refresh" '+(pending?'disabled':'')+'>读取机制修订</button>':''}${revisions?'<div class="table-wrap"><table><thead><tr><th>修订/状态</th><th>提交者</th><th>查看</th></tr></thead><tbody>'+revisions.map(r=>`<tr><td>r${escape(r.revision)} / v${escape(r._version)} · ${escape(r.status)}</td><td>${escape(r.submittedBy)}</td><td><button data-definition-revision="${escape(r._id)}" ${pending?'disabled':''}>核对原修订</button></td></tr>`).join('')+'</tbody></table></div>':''}
      ${record?'<h3>选中原生修订</h3>'+pretty({id:record._id,version:record._version,revision:record.revision,status:record.status,submittedBy:record.submittedBy,definitionHash:record.definitionHash,compiledHash:record.compiledHash,compatibility:selected.compatibility})+(compatible?'<details><summary>审核实际定义与本体/策略依赖</summary>'+pretty({definition:selected.compiled.definition,dependencies:selected.compiled.dependencies,policyHash:selected.compiled.policyHash})+'</details>':'<p class="error">依赖已失效，不显示或批准旧编译材料。</p>')+'<button id="definition-edit-selected" '+(pending||!compatible||!can('data_reviewer')?'disabled':'')+'>以此修订创建编辑草稿</button><button id="definition-validate" '+(pending||!compatible||record.status!=='DRAFT'||!can('data_reviewer')?'disabled':'')+'>校验原生草稿</button><button id="definition-approve" '+(pending||!compatible||record.status!=='VALIDATED'||!can('model_owner')||record.submittedBy===getPrincipal()?.id?'disabled':'')+'>独立批准机制</button><button id="definition-reject" '+(pending||!compatible||record.status!=='VALIDATED'||!can('model_owner')||record.submittedBy===getPrincipal()?.id?'disabled':'')+'>拒绝机制</button>':''}
      ${pending?'<p role="alert">结果尚待查证：编辑与新提交已锁定。原请求和版本保留在当前会话；刷新会清除本地进度，请从原生修订列表核对。</p><button id="definition-recover">查询原请求结果</button><button id="definition-retry">重试相同请求</button>'+(pending.recovery==='NO_COMMITTED_REVISION'?'<button id="definition-return-edit">结束已拒请求并重新读取候选</button>':''):''}<p>发布后模型仍须独立评测、批准与上线。拒绝候选不会删除当前已发布定义。</p></section>`;
  }
  function bind(){
    $('#definition-candidates-refresh').onclick=()=>{if(pending)return;act(async(epoch,g)=>{base=preview=selected=revisions=undefined;key='';values={};const value=await api('/definition-candidates',epoch);current(g);if(value?.readOnly!==true||value.predictionReady!==false||!Array.isArray(value.items))fail('INVALID_CANDIDATE_INDEX');index=value;});};
    if(index){$('#definition-candidate-key').value=key;$('#definition-candidate-key').onchange=()=>{if(isBusy()||pending)return;key=$('#definition-candidate-key').value;base=preview=selected=revisions=undefined;values={};onRender();};
      $('#definition-candidate-load').onclick=()=>{if(pending||!index.items.some(i=>i.key===key))return;act(async(epoch,g)=>{const value=await api(path()+'/candidate',epoch);current(g);checkPreview(value,'plus-definition-candidate-v1');base=structuredClone(value.definition);values=formValues(base);preview=selected=undefined;await list(epoch,g);});};}
    if(base){for(const id of Object.keys(values)){const node=$('#'+id);node.value=values[id];node.oninput=()=>{if(isBusy()||pending)return;values[id]=node.value;preview=undefined;$('#definition-preview').innerHTML='';};}
      $('#definition-edit-form').onsubmit=event=>{event.preventDefault();if(pending||!can('data_reviewer'))return;act(async(epoch,g)=>{preview=undefined;const edited=editDefinitionCandidate(base,values),value=await api(path()+'/previews',epoch,edited);current(g);checkPreview(value,'plus-definition-preview-v1');preview=value;});};}
    if(preview)$('#definition-save').onclick=()=>{if(pending||!can('data_reviewer'))return;act(async(epoch,g)=>{pending={kind:'DRAFT',actor:getPrincipal().id,path:path()+'/revisions',body:{definition:structuredClone(preview.definition),expectedCompiledHash:preview.compiledHash},definitionHash:preview.definitionHash,key:crypto.randomUUID()};onRender();await submit(epoch,g);});};
    if(key)$('#definition-revisions-refresh').onclick=()=>{if(!pending)act(async(epoch,g)=>{selected=undefined;await list(epoch,g);});};
    document.querySelectorAll('[data-definition-revision]').forEach(b=>b.onclick=()=>{if(!pending)act((epoch,g)=>read(b.dataset.definitionRevision,epoch,g));});
    const r=selected?.record;if(r){
      $('#definition-edit-selected').onclick=()=>{if(isBusy()||pending||!can('data_reviewer')||!selected?.compatibility?.compatible)return;base=structuredClone(selected.compiled.definition);base.revision=Math.max(base.revision,...revisions.map(v=>v.revision))+1;values=formValues(base);preview=undefined;onRender();};
      const change=(kind,decision)=>{if(pending||!selected.compatibility?.compatible)return;if(kind==='VALIDATE'?(r.status!=='DRAFT'||!can('data_reviewer')):(r.status!=='VALIDATED'||!can('model_owner')||r.submittedBy===getPrincipal()?.id))return;
        act(async(epoch,g)=>{pending={kind,actor:getPrincipal().id,id:r._id,path:path()+'/revisions/'+encodeURIComponent(r._id)+(kind==='VALIDATE'?'/validate':'/review'),body:{expectedVersion:r._version,...(decision?{decision}:{})},key:crypto.randomUUID()};onRender();await submit(epoch,g);});};
      $('#definition-validate').onclick=()=>change('VALIDATE');$('#definition-approve').onclick=()=>change('REVIEW','APPROVE');$('#definition-reject').onclick=()=>change('REVIEW','REJECT');}
    if(pending){$('#definition-recover').onclick=()=>act(recover);$('#definition-retry').onclick=()=>act(submit);
      if(pending.recovery==='NO_COMMITTED_REVISION')$('#definition-return-edit').onclick=()=>{if(isBusy()||pending?.recovery!=='NO_COMMITTED_REVISION')return;pending=base=preview=selected=undefined;values={};notice='原请求已明确拒绝且未找到提交修订；重新读取当前候选，不改写原生历史。';onRender();};}
  }
  return {markup,bind,reset};
}
