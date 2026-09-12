const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const reference=r=>r&&typeof r.type==='string'&&typeof r.id==='string'&&Number.isSafeInteger(r.version)&&r.version>0;
const identity=p=>p?.id&&p.tenantId?JSON.stringify([p.id,p.tenantId,[...(p.roles??[])].sort()]):null;
const fail=()=>{throw Error('INVALID_NATIVE_ANALYSIS');};
const label=c=>c.kind==='UNOBSERVED'?'未提供字段':c.kind==='MISSING'?'字段为空':`原始值：${String(c.value)}`;

// A deliberately bounded language grammar, NOT a language model or arbitrary
// natural-language reasoning. Parsing only fills a reviewable read query form.
export function parseNativeAnalysisText(input,fields){
  if(typeof input!=='string'||input.length>256)throw Error('仅支持：按 字段名 分组，或 汇总 字段名');
  const group=input.trim().match(/^按\s+([A-Za-z][A-Za-z0-9_]{0,127})\s+分组$/),numeric=input.trim().match(/^汇总\s+([A-Za-z][A-Za-z0-9_]{0,127})$/);
  if(!group&&!numeric)throw Error('仅支持：按 字段名 分组，或 汇总 字段名');
  const field=(group??numeric)[1],mode=group?'GROUP_COUNT':'NUMERIC_SUMMARY';
  if(!fields.some(f=>f.name===field&&f.modes.includes(mode)))throw Error('字段或分析方式不在当前本体允许列表中');return {field,mode};
}

export function createNativeAnalysisWorkbench({document,api,run,isBusy,getPrincipal,getCatalog,getDetail,onOpenObject}){
  const $=s=>document.querySelector(s);let context,choice='',field='',mode='GROUP_COUNT',result,error='',text='',generation=0;
  const current=()=>JSON.stringify([identity(getPrincipal()),getDetail()?.reference??null]);
  function reset(){generation++;context=undefined;choice=field='';mode='GROUP_COUNT';result=undefined;error=text='';}
  function sync(){const next=current();if(next!==context){reset();context=next;}}
  function links(){const root=getDetail()?.reference;return (getCatalog()?.bundle?.parsed?.linkTypes??[]).flatMap(l=>[
    ...(l.from===root?.type?[{key:l.name+':outbound',linkType:l.name,direction:'outbound',targetType:l.to}]:[]),
    ...(l.to===root?.type?[{key:l.name+':inbound',linkType:l.name,direction:'inbound',targetType:l.from}]:[])]);}
  function fields(){const schema=getCatalog()?.bundle?.parsed,link=links().find(l=>l.key===choice);
    return (schema?.objectTypes.find(t=>t.name===link?.targetType)?.fields??[]).flatMap(f=>{
      if(f.type.isList||f.directives.some(d=>['computed','link'].includes(d.kind)))return [];
      const modes=['Int','Float'].includes(f.type.name)?['NUMERIC_SUMMARY']:['String','Boolean'].includes(f.type.name)||schema.enums.some(e=>e.name===f.type.name)?['GROUP_COUNT']:[];
      return modes.length?[{name:f.name,modes}]:[];
    });
  }
  function validate(v,root,query){
    const nonnegative=n=>Number.isSafeInteger(n)&&n>=0;
    if(v?.schema!=='plus-object-analysis-v1'||v.readOnly!==true||v.snapshotConsistent!==true||v.predictionReady!==false||v.executionAuthorized!==false
      ||!reference(v.root)||v.root.type!==root.type||v.root.id!==root.id||v.root.version!==root.version||v.scope!=='AUTHORIZED_ONE_HOP'||v.countUnit!=='DISTINCT_OBJECT'
      ||v.linkType!==query.linkType||v.direction!==query.direction||v.field!==query.field||v.mode!==query.mode||!nonnegative(v.objectCount)||v.objectCount>1000
      ||!nonnegative(v.visibleLinkCount)||v.visibleLinkCount>1000||!nonnegative(v.missingCount)||!nonnegative(v.nullCount)||v.missingCount+v.nullCount>v.objectCount
      ||!Array.isArray(v.sources?.objects)||v.sources.objects.length!==v.objectCount||!v.sources.objects.every(reference)||v.sources.objects.some(r=>r.type!==v.targetType)
      ||new Set(v.sources.objects.map(r=>r.type+':'+r.id)).size!==v.objectCount||!Array.isArray(v.sources.links)||v.sources.links.length!==v.visibleLinkCount
      ||!v.sources.links.every(reference)||new Set(v.sources.links.map(r=>r.id)).size!==v.visibleLinkCount)fail();
    const connected=new Set();
    for(const link of v.sources.links){const origin=v.direction==='outbound'?link.from:link.to,target=v.direction==='outbound'?link.to:link.from;
      if(link.type!==v.linkType||origin?.type!==root.type||origin?.id!==root.id||!v.sources.objects.some(r=>r.type===target?.type&&r.id===target?.id))fail();
      connected.add(target.type+':'+target.id);
    }
    if(connected.size!==v.objectCount)fail();
    if(v.mode==='GROUP_COUNT'){
      if(v.numeric!==null||!Array.isArray(v.groups)||v.groups.length>32)fail();const members=[],values=[];let missing=0,nulls=0;
      for(const g of v.groups){const c=g?.value;if(!nonnegative(g?.count)||g.count===0||!Array.isArray(g.members)||g.members.length!==g.count||!c||!['VALUE','MISSING','UNOBSERVED'].includes(c.kind)
        ||c.kind==='VALUE'&&!['string','boolean'].includes(typeof c.value)||g.members.some(r=>!v.sources.objects.some(s=>s.type===r.type&&s.id===r.id&&s.version===r.version)))fail();
        members.push(...g.members.map(r=>r.type+':'+r.id));values.push(JSON.stringify(c));if(c.kind==='UNOBSERVED')missing+=g.count;if(c.kind==='MISSING')nulls+=g.count;
      }
      if(members.length!==v.objectCount||new Set(members).size!==v.objectCount||new Set(values).size!==values.length||missing!==v.missingCount||nulls!==v.nullCount)fail();
    }else{const n=v.numeric;if(v.groups!==null||!n||!nonnegative(n.count)||n.count+v.missingCount+v.nullCount!==v.objectCount)fail();
      if(n.count===0){if([n.sum,n.mean,n.min,n.max].some(x=>x!==null))fail();}
      else if(![n.sum,n.mean,n.min,n.max].every(Number.isFinite)||n.min>n.max||n.mean!==n.sum/n.count)fail();
    }
  }
  function load(){sync();if(isBusy()||!getDetail()?.reference)return;const root=structuredClone(getDetail().reference),link=links().find(l=>l.key===choice),g=generation,c=context;
    if(!link||!fields().some(f=>f.name===field&&f.modes.includes(mode)))return;
    const query={linkType:link.linkType,direction:link.direction,field,mode};result=undefined;error='';render();
    return run(async epoch=>{try{const v=await api('/objects/'+encodeURIComponent(root.type)+'/'+encodeURIComponent(root.id)+'/analysis?'+new URLSearchParams(query),epoch);
      if(g!==generation||c!==current())throw Object.assign(Error('分析主体或对象已变化'),{discarded:true});
      if(v?.root?.version!==root.version)throw Error('根对象版本已变化，请先刷新对象详情');validate(v,root,query);if(v.targetType!==link.targetType)fail();result=v;
    }catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)render();}});
  }
  function render(){sync();const root=getDetail()?.reference;
    if(!links().some(l=>l.key===choice))choice=links()[0]?.key??'';
    if(!fields().some(f=>f.name===field&&f.modes.includes(mode))){const first=fields()[0];field=first?.name??'';mode=first?.modes[0]??'GROUP_COUNT';}
    const candidates=fields(),n=result?.numeric;
    $('#content').innerHTML=`<section class="panel"><h2>当前对象关联分析</h2><p>统计来自当前授权的一跳关联对象，按对象去重，不包括隐藏对象或关系。不是全平台总量、世界模型预测或已核验现实状态。</p>
      ${root?`<p>${escape(root.type)} / ${escape(root.id)} / v${root.version}</p><form id="analysis-query"><label>关系<select id="analysis-link">${links().map(l=>`<option value="${escape(l.key)}" ${l.key===choice?'selected':''}>${escape(l.linkType)} · ${l.direction==='outbound'?'指向':'来自'} ${escape(l.targetType)}</option>`).join('')}</select></label>
      <label>目标字段<select id="analysis-field">${candidates.map(f=>`<option value="${escape(f.name)}" ${f.name===field?'selected':''}>${escape(f.name)} · ${f.modes[0]==='GROUP_COUNT'?'分组计数':'数值汇总'}</option>`).join('')}</select></label><button ${candidates.length?'':'disabled'}>查询当前授权数据</button></form>
      <form id="analysis-text-form"><label>受限中文查询<input id="analysis-text" maxlength="256" value="${escape(text)}" placeholder="按 status 分组，或 汇总 amount"></label><button>解析到查询表单</button></form><p>仅识别上述两种固定语法，不调用语言模型或任意工具；解析后仍需点击查询。字段可见不表示已获读取许可，权限由服务端执行。</p>`:'<p>请先从对象浏览器选择原生对象，再进入分析工作台。</p>'}
      ${error?`<p class="error" role="alert">${escape(error)}</p>`:''}</section>
      ${result?`<section class="panel"><h2>原生分析结果</h2><p>${result.objectCount} 个可见独立对象，${result.visibleLinkCount} 条可见关系；未提供字段 ${result.missingCount}，字段为空 ${result.nullCount}。同次读取版本一致，后续下钻将重新检查当前权限。</p>
        ${result.groups?`<table><thead><tr><th>原始记录分组</th><th>对象数</th><th>分布</th><th>下钻</th></tr></thead><tbody>${result.groups.map(g=>`<tr><td>${escape(label(g.value))}</td><td>${g.count}</td><td><meter min="0" max="${Math.max(1,result.objectCount)}" value="${g.count}">${g.count}</meter></td><td>${g.members.map(r=>`<button data-analysis-object="${result.sources.objects.findIndex(s=>s.id===r.id&&s.type===r.type)}">${escape(r.type)} / ${escape(r.id)}</button>`).join('')}</td></tr>`).join('')}</tbody></table>`:`<dl><dt>有效数值</dt><dd>${n.count}</dd><dt>总和</dt><dd>${n.sum??'无值'}</dd><dt>均值</dt><dd>${n.mean??'无值'}</dd><dt>范围</dt><dd>${n.min??'无值'} — ${n.max??'无值'}</dd></dl>${result.sources.objects.map((r,i)=>`<button data-analysis-object="${i}">${escape(r.type)} / ${escape(r.id)}</button>`).join('')}`}
        <details><summary>来源关系与版本</summary><pre>${escape(JSON.stringify(result.sources.links,null,2))}</pre></details><p>范围：单根、一跳、最多1000条扫描关系及32类分组；超限明确拒绝，不截断冒充完整结果。空结果只表示当前授权范围内没有匹配数据。</p></section>`:'<section class="panel"><p>尚未查询或上次查询失败，未显示旧统计。</p></section>'}`;
    const query=$('#analysis-query');if(query)query.onsubmit=e=>{e.preventDefault();void load();};
    const link=$('#analysis-link');if(link)link.onchange=()=>{if(isBusy())return;choice=link.value;field='';result=undefined;error='';render();};
    const f=$('#analysis-field');if(f)f.onchange=()=>{if(isBusy())return;field=f.value;mode=fields().find(v=>v.name===field)?.modes[0]??'';result=undefined;error='';render();};
    const form=$('#analysis-text-form');if(form)form.onsubmit=e=>{e.preventDefault();if(isBusy())return;text=$('#analysis-text').value;result=undefined;try{({field,mode}=parseNativeAnalysisText(text,fields()));error='';}catch(e){error=e.message;}render();};
    document.querySelectorAll?.('[data-analysis-object]').forEach(b=>b.onclick=()=>{const r=result?.sources.objects[Number(b.dataset.analysisObject)];if(!r||isBusy())return;void run(epoch=>onOpenObject(structuredClone(r),epoch));});
  }
  return {render,reset,load};
}
