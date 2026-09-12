import {createNativeParameterView} from './native-parameters-ui.js';
import {createNativeDefinitionWorkbench} from './native-definition-ui.js';
import {suggestOptionalProperties} from './ontology-suggestions.js';
import {createNativeStructureWorkbench} from './native-structure-ui.js';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pretty=value=>'<pre>'+escape(JSON.stringify(value,null,2))+'</pre>';

// UI adapter only. Native catalog owns source construction, validation,
// independent decisions, schema application and audit. No direct object writes.
export function createNativeOntologyWorkbench({document,api,run,isBusy,getCatalog,getPrincipal,onPublished}){
  const $=selector=>document.querySelector(selector);
  let revisions=null,selected=null,preview=null,draftKey='',draftField='',draftType='',draftValueType='String',reason='';
  let suggestions=null,suggestionGeneration=0;
  const parameters=createNativeParameterView({document,api,run,isBusy,onRender:render});
  const definitions=createNativeDefinitionWorkbench({document,api,run,isBusy,getCatalog,getPrincipal,onRender:render});
  const structure=createNativeStructureWorkbench({document,api,run,isBusy,getCatalog,getPrincipal,onRender:render,
    onPreview:value=>{preview=value;draftKey=crypto.randomUUID();},onInvalidate:()=>{preview=null;draftKey='';if($('#ontology-save-draft'))$('#ontology-save-draft').disabled=true;}});
  function reset(){suggestionGeneration++;suggestions=null;revisions=null;selected=null;preview=null;draftKey='';draftField='';draftType='';draftValueType='String';reason='';parameters.reset();definitions.reset();structure.reset();}
  const can=role=>getPrincipal()?.roles.includes(role);
  async function loadRevisions(epoch){revisions=null;selected=null;render();revisions=await api('/ontology/revisions',epoch);render();}
  async function read(id,epoch){selected=null;reason='';render();selected=await api('/ontology/revisions/'+encodeURIComponent(id),epoch);render();}
  function render(){
    const catalog=getCatalog(),types=catalog?.bundle?.parsed?.objectTypes??[],business=types.filter(t=>!t.name.startsWith('Plus'));
    if(!business.some(t=>t.name===draftType))draftType=business[0]?.name??'';
    const record=selected?.record,source=catalog?.bundle?.source;
    $('#content').innerHTML=`<section class="panel"><h2>当前已发布本体</h2><p>本体修订 ${escape(catalog?.row?.revision??'未读取')} · 存储版本 ${escape(catalog?.head?.storageVersion??'未读取')}。发布不等于模型已经兼容新定义。</p>${types.map(t=>'<details><summary>'+escape(t.name)+'</summary>'+pretty(t)+'</details>').join('')}</section>
      <section class="panel"><h2>新增可选属性</h2><p>仅支持业务对象的 String / Int / Boolean 可选属性。预览不保存，草稿不生效；不自动补值、修改控制元数据或恢复旧动作。</p><form id="ontology-property-form"><div class="row"><label>对象类型<select id="ontology-property-type">${business.map(t=>`<option value="${escape(t.name)}" ${t.name===draftType?'selected':''}>${escape(t.name)}</option>`).join('')}</select></label><label>属性名<input id="ontology-property-name" pattern="[A-Za-z][A-Za-z0-9_]{0,127}" maxlength="128" required value="${escape(draftField)}"></label><label>属性类型<select id="ontology-property-value-type">${['String','Int','Boolean'].map(t=>`<option ${t===draftValueType?'selected':''}>${t}</option>`).join('')}</select></label></div><button ${!source||!can('data_reviewer')?'disabled':''}>生成变更预览</button></form>${preview?'<h3>待保存的精确变更</h3>'+pretty(preview.changes)+'<p>基线摘要：'+escape(preview.expectedParentHash)+'</p><button id="ontology-save-draft" class="primary">保存原生草稿</button>':''}</section>
      <section class="panel"><h2>原生修订与审批</h2><button id="ontology-revisions-refresh">读取当前修订</button>${revisions?'<div class="table-wrap"><table><thead><tr><th>修订</th><th>状态</th><th>提交者</th><th>查看</th></tr></thead><tbody>'+revisions.map(r=>`<tr><td>${escape(r.revision)} / v${escape(r._version)}</td><td>${escape(r.status)}</td><td>${escape(r.submittedBy)}</td><td><button data-ontology-revision="${escape(r._id)}">检查变更</button></td></tr>`).join('')+'</tbody></table></div>':'<p>尚未读取修订列表；不沿用上次登录的审批材料。</p>'}
      ${record?'<h3>选中修订 '+escape(record.revision)+' · '+escape(record.status)+'</h3>'+pretty({id:record._id,version:record._version,submittedBy:record.submittedBy,parentHash:record.parentHash,contentHash:record.contentHash})+'<details><summary>检查完整候选本体定义</summary>'+pretty(selected.bundle.parsed)+'</details><details><summary>检查动作定义和停用清单</summary>'+pretty({manifests:selected.bundle.manifests,disabledActions:selected.bundle.disabledActions})+'</details><p>先检查完整候选与当前定义。服务端仍会校验当前基线、版本、权限及独立审批者。</p><button id="ontology-validate" '+(record.status!=='DRAFT'||!can('data_reviewer')?'disabled':'')+'>校验当前草稿</button><label>独立审批理由<textarea id="ontology-review-reason" maxlength="2000">'+escape(reason)+'</textarea></label><div class="row"><button id="ontology-approve" '+(record.status!=='VALIDATED'||!can('model_owner')||record.submittedBy===getPrincipal()?.id?'disabled':'')+'>批准并发布</button><button id="ontology-reject" '+(record.status!=='VALIDATED'||!can('model_owner')||record.submittedBy===getPrincipal()?.id?'disabled':'')+'>拒绝修订</button></div>':''}</section>`;
    $('#content').innerHTML+=`<section class="panel"><h2>从新样本建议可选属性</h2><p>目标为上方选中的 ${escape(draftType)}。选择 1–50 行 JSON 对象数组，最多 500000 字节。样本仅在本机分析，不上传数据值。按类型生成可选属性建议；不是语言模型、因果建模或自动发布。未知类型、疑似引用和嵌套对象需要另行建模。</p><input id="ontology-suggestion-file" type="file" accept=".json,application/json" ${isBusy()?'disabled':''}>${suggestions?`<p>方法：确定性样本类型推断 · ${suggestions.sampleCount} 行 · 本体 ${escape(suggestions.ontologyHash)}</p><div class="table-wrap"><table><thead><tr><th>建议字段</th><th>类型</th><th>覆盖证据</th><th>操作</th></tr></thead><tbody>${suggestions.suggestions.map((s,i)=>`<tr><td>${escape(s.field)}</td><td>${escape(s.valueType)}（可选）</td><td>${escape(s.evidence.present)} / ${s.evidence.rows} 行，null ${s.evidence.nulls}</td><td><button data-ontology-suggestion="${i}" ${isBusy()||!can('data_reviewer')?'disabled':''}>填入上方编辑表单</button></td></tr>`).join('')||'<tr><td colspan="4">没有可直接建议的新属性。</td></tr>'}</tbody></table></div><details><summary>已有字段与待人工建模项</summary>${pretty({known:suggestions.known,unresolved:suggestions.unresolved})}</details><button id="ontology-suggestions-discard">拒绝并清除建议</button><p>选择建议只填入表单。你可以修改或拒绝；仍须明确预览、保存草稿和独立审批，之后才影响原生本体。</p>`:''}</section>`;
    $('#content').innerHTML+=structure.markup()+definitions.markup()+parameters.markup();structure.bind();definitions.bind();parameters.bind();
    $('#ontology-suggestion-file').onchange=()=>{if(isBusy())return;const file=$('#ontology-suggestion-file').files[0];suggestions=null;const local=++suggestionGeneration,chosenType=draftType,ontology=getCatalog();render();if(!file)return;void run(async()=>{
      if(file.size>500000)throw Error('SUGGESTION_FILE_BUDGET');const raw=await file.text();
      if(local!==suggestionGeneration||getCatalog()?.bundle?.contentHash!==ontology?.bundle?.contentHash||draftType!==chosenType)throw Object.assign(Error('建议输入或本体已变化，请重新读取'),{discarded:true});
      const result=suggestOptionalProperties({rows:JSON.parse(raw),objectType:chosenType,catalog:ontology});suggestions=result;render();
    });};
    document.querySelectorAll('[data-ontology-suggestion]').forEach(button=>button.onclick=()=>{
      if(isBusy())return;if(suggestions?.ontologyHash!==getCatalog()?.bundle?.contentHash||suggestions?.objectType!==draftType){suggestions=null;render();return;}
      const choice=suggestions.suggestions[Number(button.dataset.ontologySuggestion)];if(!choice)return;draftField=choice.field;draftValueType=choice.valueType;preview=null;draftKey='';render();
    });
    if(suggestions)$('#ontology-suggestions-discard').onclick=()=>{if(isBusy())return;suggestionGeneration++;suggestions=null;render();};
    const input=()=>{if(isBusy())return;const nextType=$('#ontology-property-type').value;if(nextType!==draftType){suggestionGeneration++;suggestions=null;}draftType=nextType;draftField=$('#ontology-property-name').value;draftValueType=$('#ontology-property-value-type').value;preview=null;draftKey='';if($('#ontology-save-draft'))$('#ontology-save-draft').disabled=true;};
    for(const selector of ['#ontology-property-type','#ontology-property-name','#ontology-property-value-type'])$(selector).oninput=input;
    $('#ontology-property-form').onsubmit=event=>{event.preventDefault();if(isBusy())return;input();void run(async epoch=>{
      render();preview=await api('/ontology/property-previews',epoch,{objectType:draftType,field:draftField,valueType:draftValueType,expectedParentHash:getCatalog().bundle.contentHash});draftKey=crypto.randomUUID();render();
    });};
    if(preview)$('#ontology-save-draft').onclick=()=>void run(async epoch=>{
      const prepared=preview;if(!prepared)return;
      const draft=await api('/ontology/revisions',epoch,{...prepared.source,expectedParentHash:prepared.expectedParentHash},draftKey);
      preview=null;draftKey='';await loadRevisions(epoch);await read(draft._id,epoch);
    });
    $('#ontology-revisions-refresh').onclick=()=>void run(loadRevisions);
    document.querySelectorAll('[data-ontology-revision]').forEach(button=>button.onclick=()=>void run(epoch=>read(button.dataset.ontologyRevision,epoch)));
    if(record){
      $('#ontology-review-reason').oninput=()=>{reason=$('#ontology-review-reason').value;};
      $('#ontology-validate').onclick=()=>void run(async epoch=>{const id=record._id;await api('/ontology/revisions/'+encodeURIComponent(id)+'/validate',epoch,{expectedVersion:record._version});await loadRevisions(epoch);await read(id,epoch);});
      const review=decision=>void run(async epoch=>{
        const id=record._id,note=$('#ontology-review-reason').value.trim();if(!note)throw Error('请填写独立审批理由');
        await api('/ontology/revisions/'+encodeURIComponent(id)+'/review',epoch,{expectedVersion:record._version,decision,reason:note});
        if(decision==='APPROVE'){reset();await onPublished(epoch);}
        else{await loadRevisions(epoch);await read(id,epoch);}
      });
      $('#ontology-approve').onclick=()=>review('APPROVE');$('#ontology-reject').onclick=()=>review('REJECT');
    }
  }
  return {render,reset};
}
