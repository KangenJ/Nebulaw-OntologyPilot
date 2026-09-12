import {suggestBusinessStructure} from './ontology-suggestions.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const options=(values,selected)=>values.map(v=>`<option value="${esc(v)}" ${v===selected?'selected':''}>${esc(v)}</option>`).join('');

// Suggestions are local and disposable. The sole write path is the parent's
// existing native revision/independent approval lifecycle, never sample import.
export function createNativeStructureWorkbench({document,api,run,isBusy,getCatalog,getPrincipal,onRender,onPreview,onInvalidate}){
  const $=s=>document.querySelector(s);let result=null,chosen=null,generation=0;
  const can=()=>getPrincipal()?.roles.includes('data_reviewer');
  const current=()=>result?.ontologyHash===getCatalog()?.bundle?.contentHash;
  function reset(){generation++;result=null;chosen=null;}
  function markup(){
    const types=(getCatalog()?.bundle?.parsed?.objectTypes??[]).filter(t=>!t.name.startsWith('Plus')).map(t=>t.name);
    return `<section class="panel"><h2>从新数据集合建议对象与关系</h2><p>选择 JSON 文件：键为候选对象类型，值为样本行数组，例如 {"Deliverable":[{"title":"示例","matterId":"引用"}]}。最多4个集合，各1–50行；不上传样本值。集合名形成对象候选，引用字段名只形成待确认的关系假设，不证明对象匹配、方向、基数或因果关系。</p><input id="structure-file" type="file" accept=".json,application/json" ${isBusy()?'disabled':''}>
      ${result?`<p>绑定本体：${esc(result.ontologyHash)}</p><div class="row">${result.objects.map((o,i)=>`<button data-structure-object="${i}" ${!can()?'disabled':''}>编辑对象 ${esc(o.name)}</button>`).join('')}${result.links.map((l,i)=>`<button data-structure-link="${i}" ${!can()||!l.endpointsPublished?'disabled':''}>编辑关系 ${esc(l.from)} → ${esc(l.to)}</button>`).join('')}</div><p>关系的两端必须先经审核发布，再重新读取样本。新类型不会自动获得导入、读取、动作或模型权限；这些用途需另行配置。</p><details><summary>待确认的参考字段与无法推断项</summary><pre>${esc(JSON.stringify({links:result.links,unresolved:result.unresolved},null,2))}</pre></details><button id="structure-discard">拒绝并清除本批建议</button>`:''}
      ${chosen?`<form id="structure-form"><h3>检查并修改${chosen.kind==='OBJECT'?'对象':'关系'}候选</h3><label>名称<input id="structure-name" required maxlength="128" pattern="[A-Za-z][A-Za-z0-9_]{0,127}" value="${esc(chosen.name)}"></label>
        ${chosen.kind==='OBJECT'?`<div class="table-wrap"><table><thead><tr><th>保留</th><th>属性名</th><th>可选类型</th></tr></thead><tbody>${chosen.properties.map((p,i)=>`<tr><td><input id="structure-keep-${i}" type="checkbox" ${p.keep?'checked':''}></td><td><input id="structure-field-${i}" required maxlength="128" value="${esc(p.name)}"></td><td><select id="structure-type-${i}">${options(['String','Int','Boolean'],p.valueType)}</select></td></tr>`).join('')}</tbody></table></div>`:
          `<div class="row"><label>起点<select id="structure-from">${options(types,chosen.from)}</select></label><label>终点<select id="structure-to">${options(types,chosen.to)}</select></label><label>人工确认基数<select id="structure-cardinality" required>${options(['','ONE_TO_ONE','ONE_TO_MANY','MANY_TO_ONE','MANY_TO_MANY'],chosen.cardinality)}</select></label></div><label><input id="structure-confirm" type="checkbox" ${chosen.confirmed?'checked':''} required>已核对关系方向与基数；这不表示已验证实例匹配或行动效果</label>`}
        <button ${!can()||isBusy()||!current()?'disabled':''}>生成结构变更预览</button><p>此按钮只预览；仍须保存原生草稿、校验并由独立身份批准。ID由平台管理；不自动迁移或创建业务实例。</p></form>`:''}</section>`;
  }
  function capture(){
    if(!chosen)return;chosen.name=$('#structure-name').value;
    if(chosen.kind==='OBJECT')chosen.properties.forEach((p,i)=>{p.keep=$('#structure-keep-'+i).checked;p.name=$('#structure-field-'+i).value;p.valueType=$('#structure-type-'+i).value;});
    else{chosen.from=$('#structure-from').value;chosen.to=$('#structure-to').value;chosen.cardinality=$('#structure-cardinality').value;chosen.confirmed=$('#structure-confirm').checked;}
  }
  function bind(){
    $('#structure-file').onchange=()=>{if(isBusy())return;const file=$('#structure-file').files[0],epoch=++generation,catalog=getCatalog();result=null;chosen=null;onInvalidate();onRender();if(!file)return;void run(async()=>{
      if(file.size>500000)throw Error('SUGGESTION_FILE_BUDGET');const raw=await file.text();
      if(epoch!==generation||catalog?.bundle?.contentHash!==getCatalog()?.bundle?.contentHash)throw Object.assign(Error('样本或本体已变化，请重新读取'),{discarded:true});
      result=suggestBusinessStructure({tables:JSON.parse(raw),catalog});onRender();
    });};
    const choose=(kind,index)=>{if(isBusy())return;if(!current()){reset();onInvalidate();onRender();return;}
      const item=kind==='OBJECT'?result.objects[index]:result.links[index];if(!item||!can()||kind==='LINK'&&!item.endpointsPublished)return;
      chosen=kind==='OBJECT'?{kind,name:item.name,properties:item.properties.map(p=>({...p,keep:true}))}:{kind,name:item.name,from:item.from,to:item.to,cardinality:'',confirmed:false};onInvalidate();onRender();};
    document.querySelectorAll('[data-structure-object]').forEach(b=>b.onclick=()=>choose('OBJECT',Number(b.dataset.structureObject)));
    document.querySelectorAll('[data-structure-link]').forEach(b=>b.onclick=()=>choose('LINK',Number(b.dataset.structureLink)));
    if(result)$('#structure-discard').onclick=()=>{if(isBusy())return;reset();onInvalidate();onRender();};
    if(chosen){
      $('#structure-form').oninput=()=>{if(isBusy())return;capture();onInvalidate();};
      $('#structure-form').onsubmit=e=>{e.preventDefault();if(isBusy())return;capture();onInvalidate();void run(async epoch=>{
        if(!current())throw Error('ONTOLOGY_STALE_BASE');
        if(chosen.kind==='LINK'&&(!chosen.confirmed||!chosen.cardinality))throw Error('请明确确认关系方向与基数');
        const input={kind:chosen.kind,name:chosen.name,expectedParentHash:result.ontologyHash,...(chosen.kind==='OBJECT'?
          {properties:chosen.properties.filter(p=>p.keep).map(p=>({name:p.name,valueType:p.valueType}))}:{from:chosen.from,to:chosen.to,cardinality:chosen.cardinality})};
        const local=generation,preview=await api('/ontology/structure-previews',epoch,input);
        if(local!==generation||!current())throw Object.assign(Error('ONTOLOGY_STALE_BASE'),{discarded:true});
        onPreview(preview);onRender();
      });};
    }
  }
  return {markup,bind,reset};
}
