const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pretty=v=>'<pre>'+escape(JSON.stringify(v,null,2))+'</pre>';
const fail=message=>{throw Error(message);};
const numbers=['Int','Float','Double','Decimal'];
const support=v=>v?.support?.filter(a=>a!==null&&!v.unknownValues.includes(a))??[];
const variable=(o,k)=>o.variables.find(v=>v.key===k);
const operators=v=>numbers.includes(v?.valueType)?['EQ','NE','LT','LE','GT','GE']:['EQ','NE'];
const selected=(items,value)=>{if(typeof value!=='string'||!/^\d+$/.test(value)||!Object.hasOwn(items,Number(value)))fail('请选择当前本体中的有效选项');return structuredClone(items[Number(value)]);};
const indexPath=k=>'/learning/rule-specifications/'+encodeURIComponent(k)+'/revisions';
export async function nativeRuleSpecificationHash(spec){
  const normalize=(v,depth=0)=>{if(depth>40)fail('RULE_MAX_DEPTH');if(v===null||['string','boolean'].includes(typeof v))return v;
    if(typeof v==='number'){if(!Number.isFinite(v))fail('RULE_NON_FINITE');return v;}if(Array.isArray(v))return v.map(a=>normalize(a,depth+1));
    if(!v||typeof v!=='object')fail('RULE_INVALID_VALUE');const result=Object.create(null);
    for(const k of Object.keys(v).sort()){if(['__proto__','constructor','prototype'].includes(k))fail('RULE_RESERVED_KEY');if(v[k]!==undefined)result[k]=normalize(v[k],depth+1);}return result;};
  const ordered={...spec,rules:[...spec.rules].sort((a,b)=>a.moduleKey.localeCompare(b.moduleKey))};
  const bytes=new TextEncoder().encode(JSON.stringify(normalize(ordered))),hash=await crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(hash)].map(v=>v.toString(16).padStart(2,'0')).join('');
}

// Bounded typed form, not raw CEL/JSON execution. Supports literal comparisons
// over every declared input, ALL/ANY and explicit known output values. Richer
// ASTs remain visible for review but are never silently converted into this form.
export function prepareNativeRuleProposal(options,values,revision){
  if(options?.schema!=='plus-rule-authoring-options-v1'||!options.canDraft||!Number.isSafeInteger(revision)||revision<1)fail('规则草稿不可用');
  const rules=options.modules.map((module,i)=>{
    const source=selected(options.sources,values[i+'.source']);if(!source.moduleKeys.includes(module.key))fail('来源与规则模块不匹配');
    const mode=values[i+'.mode'];if(!['ALL','ANY'].includes(mode))fail('条件组合无效');
    const args=module.inputs.map((k,j)=>{const v=variable(options,k),op=values[i+'.input.'+j+'.op'];
      if(!v||v.referenceType||v.sourceType?.isList&&v.source?.path?.aggregation!=='COUNT'||v.valueType==='DateTime'||!operators(v).includes(op))fail('条件类型不支持');
      return {op,left:k,right:{kind:'LITERAL',value:selected(support(v),values[i+'.input.'+j+'.value'])}};
    });
    if(!args.length)fail('无输入规则需要单独受审的常量表达式，本表单不自动生成');
    const outputs=Object.fromEntries(module.outputs.map((k,j)=>{const v=variable(options,k);if(v?.role!=='RULE_DERIVED')fail('输出不是派生规则变量');return [k,selected(support(v),values[i+'.output.'+j])];}));
    return {moduleKey:module.key,ruleRevision:source.reference,when:args.length===1?args[0]:{op:mode==='ALL'?'AND':'OR',args},outputs};
  });
  return {key:options.key,revision,definitionKey:options.definitionKey,specification:{schema:'plus-rule-spec-v1',definitionHash:options.definitionHash,rules}};
}

export function createNativeRuleWorkbench({document,api,run,isBusy,getPrincipal}){
  const $=s=>document.querySelector(s);let index,options,selection,detail,pending,preview,values={},generation=0,error='',notice='',choice='';
  const current=g=>{if(g!==generation)throw Object.assign(Error('规则会话已变化'),{discarded:true});};
  function reset(){generation++;index=options=selection=detail=pending=preview=undefined;values={};error=notice=choice='';}
  const act=work=>{if(isBusy())return;void run(async epoch=>{const g=generation;error='';try{await work(epoch,g);current(g);}catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)render();}});};
  async function load(input,epoch,g){const result=await api('/learning/rule-specifications/authoring-options',epoch,input);current(g);
    if(result?.schema!=='plus-rule-authoring-options-v1'||result.key!==input.key||result.definitionKey!==input.definitionKey||result.readOnly!==true||result.predictionReady!==false||!Array.isArray(result.sources)||!Array.isArray(result.modules)||!Array.isArray(result.variables)||!Array.isArray(result.revisions))fail('INVALID_RULE_OPTIONS');
    options=result;selection=detail=preview=undefined;values={};
  }
  async function read(row,epoch,g){selection=row;detail=undefined;const value=await api(indexPath(options.key)+'/'+encodeURIComponent(row.id),epoch);current(g);
    if(value?.record?._id!==row.id||value.record.ruleKey!==options.key||!Number.isSafeInteger(value.record._version)||value.record._version<row.version||value.predictionReady!==false||value.executionAuthorized!==false)fail('INVALID_RULE_REVISION');
    selection={...row,version:value.record._version,status:value.record.status};options.revisions=options.revisions.map(r=>r.id===row.id?selection:r);detail=value;
  }
  async function recover(epoch,g){const command=pending;if(!command||command.actor!==getPrincipal()?.id)fail('请以原身份查证请求');
    const rows=await api(indexPath(command.key),epoch);current(g);if(!Array.isArray(rows))fail('INVALID_RULE_REVISIONS');options.revisions=rows;
    const row=rows.find(r=>command.kind==='DRAFT'?r.revision===command.body.revision:r.id===command.id);
    if(!row){notice='尚未找到原修订。只可重试冻结的原请求，不创建新修订。';return;}
    const record=await api(indexPath(command.key)+'/'+encodeURIComponent(row.id)+'/decision',epoch);current(g);
    if(record?.id!==row.id||record.key!==command.key||record.qualification!=='NOT_CHECKED'||record.predictionReady!==false||record.readOnly!==true)fail('INVALID_RULE_DECISION_RECEIPT');
    if(command.kind==='DRAFT'){
      if(record.submittedBy!==command.actor||record.definitionKey!==command.body.definitionKey||record.definitionHash!==command.body.specification.definitionHash||record.specificationHash!==command.specificationHash)fail('RULE_REVISION_CONFLICT');
    }else if(record.decision?.actorId!==command.actor||record.decision?.decision!==command.body.decision||record.decision?.reason!==command.body.reason||record.decision?.fromVersion!==command.body.expectedVersion){
      if(record.status==='DRAFT'&&record.version===command.body.expectedVersion){notice='原修订尚未决定；可重试同一决定。';return;}fail('RULE_STATE_CONFLICT');
    }
    selection=row;detail=undefined;pending=preview=undefined;notice='已核对原生修订与原决定，没有重复提交；这不是当前来源合格或模型上线。请另行核对修订材料。';
  }
  async function submit(epoch,g){const command=pending;if(!command||command.actor!==getPrincipal()?.id)fail('请以原身份查证请求');
    const result=await api(command.path,epoch,structuredClone(command.body),command.requestKey);current(g);
    if(result?.key!==command.key||!result.id||result.predictionReady!==false)fail('INVALID_RULE_RECEIPT');await recover(epoch,g);
  }
  const select=(id,items,disabled=false)=>`<select id="${id}" ${disabled?'disabled':''}><option value="">请选择</option>${items.map(([value,label])=>`<option value="${escape(value)}" ${values[id]===String(value)?'selected':''}>${escape(label)}</option>`).join('')}</select>`;
  function render(){
    const root=$('#rule-workbench');if(!root)return;
    const pairs=index?.items.flatMap(item=>item.definitionKeys.map(definitionKey=>({key:item.key,definitionKey})))??[],record=detail?.record;
    root.innerHTML=`<h2>规则定义与独立审核</h2><p>已导入的来源须先获受控用途配置。本页只创建类型化规则草稿及明确审核记录；不训练、不修改业务事实、不授予行动权限。</p><button id="rules-discover" ${pending?'disabled':''}>发现授权规则用途</button>${error?'<p class="error" role="alert">'+escape(error)+'</p>':''}${notice?'<p role="status">'+escape(notice)+'</p>':''}
      ${index?`<label>规则用途 / 本体定义<select id="rules-purpose" ${pending?'disabled':''}><option value="">请选择</option>${pairs.map((p,i)=>`<option value="${i}" ${choice===String(i)?'selected':''}>${escape(p.key+' / '+p.definitionKey)}</option>`).join('')}</select></label><button id="rules-load" ${pending?'disabled':''}>读取当前来源、参数与修订</button>${pairs.length?'':'<p>无授权规则用途，不自动安装样例或扩大权限。</p>'}`:''}
      ${options?`<p>定义摘要 ${escape(options.definitionHash)}。来源状态不是规则批准；提交及批准时服务端再次核验当前来源和字段权限。</p>${pretty(options.sources.map(s=>({reference:s.reference,fields:s.fields,moduleKeys:s.moduleKeys})))}
        <form id="rules-form"><fieldset ${pending||!options.canDraft?'disabled':''}>${options.modules.map((m,i)=>`<h3>${escape(m.key)}</h3><p>输入 ${escape(m.inputs.join(', '))} → 派生输出 ${escape(m.outputs.join(', '))}</p><label>授权来源${select(i+'.source',options.sources.map((s,n)=>[n,s.fields.title+' / '+s.reference.id]).filter((_,n)=>options.sources[n].moduleKeys.includes(m.key)))}</label><label>条件组合${select(i+'.mode',[['ALL','所有条件'],['ANY','任一条件']])}</label>${m.inputs.map((k,j)=>`<label>${escape(k+' 比较')}${select(i+'.input.'+j+'.op',operators(variable(options,k)).map(v=>[v,v]))}</label><label>已知值${select(i+'.input.'+j+'.value',support(variable(options,k)).map((v,n)=>[n,JSON.stringify(v)]))}</label>`).join('')}${m.outputs.map((k,j)=>`<label>${escape(k+' 输出')}${select(i+'.output.'+j,support(variable(options,k)).map((v,n)=>[n,JSON.stringify(v)]))}</label>`).join('')}`).join('')}<p>表单支持各声明输入与字面量比较，以及“所有/任一”组合；不自动改写其他复杂 AST。请选择所有输入和输出。来源不足或不支持的类型明确拒绝。</p><button>预览下一规则修订</button></fieldset></form>
        ${preview?'<h3>待确认草稿</h3>'+pretty(preview)+'<button id="rules-save" '+(pending?'disabled':'')+'>明确保存规则草稿</button>':''}
        <label>原生修订<select id="rules-revision" ${pending?'disabled':''}><option value="">请选择</option>${options.revisions.map(r=>`<option value="${escape(r.id)}">r${escape(r.revision)} / v${escape(r.version)} · ${escape(r.status)}</option>`).join('')}</select></label><button id="rules-read" ${pending?'disabled':''}>核对选中修订</button>`:''}
      ${selection?`<h3>选中修订</h3>${pretty(detail??selection)}${detail?'':'<p>当前来源资格无法读取；不能批准。原生拒绝操作仍独立检查审核权限和作者。</p>'}<label>独立审核理由<input id="rules-reason" maxlength="256" ${pending?'disabled':''}></label><button id="rules-approve" ${pending||!options.canReview||record?.status!=='DRAFT'||record.submittedBy===getPrincipal()?.id?'disabled':''}>独立批准规则</button><button id="rules-reject" ${pending||!options.canReview||selection.status!=='DRAFT'||record?.submittedBy===getPrincipal()?.id?'disabled':''}>明确拒绝规则</button>`:''}
      ${pending?'<p role="alert">结果待查证，已锁定新草稿和不同决定。当前会话保留原修订与请求；刷新后须从原生修订核对。</p><button id="rules-recover">只查询原请求结果</button><button id="rules-retry">重试冻结原请求</button>':''}`;
    $('#rules-discover').onclick=()=>{if(pending)return;act(async(epoch,g)=>{options=selection=detail=preview=index=undefined;choice='';const v=await api('/learning/rule-specifications/options',epoch);current(g);if(v?.schema!=='plus-rule-workbench-index-v1'||v.readOnly!==true||v.predictionReady!==false||!Array.isArray(v.items))fail('INVALID_RULE_INDEX');index=v;});};
    if(index){$('#rules-purpose').onchange=()=>{if(isBusy()||pending)return;choice=$('#rules-purpose').value;options=selection=detail=preview=undefined;render();};
      $('#rules-load').onclick=()=>{if(pending)return;act((epoch,g)=>load(selected(pairs,choice),epoch,g));};}
    if(options){
      const names=options.modules.flatMap((m,i)=>[i+'.source',i+'.mode',...m.inputs.flatMap((_,j)=>[i+'.input.'+j+'.op',i+'.input.'+j+'.value']),...m.outputs.map((_,j)=>i+'.output.'+j)]);
      for(const name of names){const node=$('[id="'+name+'"]');node.onchange=()=>{if(isBusy()||pending)return;values[name]=node.value;preview=undefined;if($('#rules-save'))$('#rules-save').disabled=true;};}
      $('#rules-form').onsubmit=event=>{event.preventDefault();if(pending||!options.canDraft)return;act(async()=>{for(const name of names)values[name]=$('[id="'+name+'"]').value;preview=prepareNativeRuleProposal(options,values,Math.max(0,...options.revisions.map(r=>r.revision))+1);});};
      if(preview)$('#rules-save').onclick=()=>{if(pending||!options.canDraft)return;act(async(epoch,g)=>{const body=structuredClone(preview),specificationHash=await nativeRuleSpecificationHash(body.specification);current(g);pending={kind:'DRAFT',key:options.key,actor:getPrincipal()?.id,path:'/learning/rule-specifications',body,specificationHash,requestKey:crypto.randomUUID()};await submit(epoch,g);});};
      $('#rules-read').onclick=()=>{if(pending)return;const row=options.revisions.find(r=>r.id===$('#rules-revision').value);if(row)act((epoch,g)=>read(row,epoch,g));};
    }
    if(selection)for(const decision of ['APPROVE','REJECT'])$('#rules-'+(decision==='APPROVE'?'approve':'reject')).onclick=()=>{if(pending||!options.canReview||selection.status!=='DRAFT'||record?.submittedBy===getPrincipal()?.id||decision==='APPROVE'&&record?.status!=='DRAFT')return;
      act(async(epoch,g)=>{const reason=$('#rules-reason').value;if(typeof reason!=='string'||!reason.trim()||reason.trim()!==reason||reason.length>256)fail('请填写审核理由');pending={kind:'REVIEW',key:options.key,actor:getPrincipal()?.id,id:selection.id,path:'/learning/rule-specifications/'+encodeURIComponent(selection.id)+'/review',body:{expectedVersion:selection.version,decision,reason},requestKey:crypto.randomUUID()};await submit(epoch,g);});};
    if(pending){$('#rules-recover').onclick=()=>act(recover);$('#rules-retry').onclick=()=>act(submit);}
  }
  return {render,reset};
}
