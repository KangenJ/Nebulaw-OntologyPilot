import {observationImportFields,observationImportLimits,parseObservationFile,planObservationImport,createObservationImportBatch} from './observation-import.js';
import {createNativeIntakeWorkbench} from './native-intake-ui.js';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const statusLabels={PENDING:'未执行',SUBMITTING:'提交中',COMMITTED:'已写入',REPLAYED:'原生幂等返回',FAILED:'失败并停止',UNCERTAIN:'结果未知，可按原请求重试'};

export function createNativeDataWorkbench({document,api,run,isBusy,getCatalog,getDetail,onOpenObject}){
  const $=selector=>document.querySelector(selector);
  let raw='',columns=[],mapping={},sourceSystem='',channelKey='',fileName='',plan,batch,progress,generation=0;
  const intake=createNativeIntakeWorkbench({document,api,run,isBusy,getCatalog,getDetail,onOpenObject,onRender:render});
  function clearPlan(){batch?.invalidate();plan=undefined;batch=undefined;progress=undefined;}
  function reset(){generation++;intake.reset();clearPlan();raw='';columns=[];mapping={};sourceSystem='';channelKey='';fileName='';}
  function render(){
    const selected=getDetail()?.reference,task=selected?.type==='InvestigationTask'?selected:undefined;
    if(plan&&plan.task.id!==task?.id)clearPlan();
    $('#content').innerHTML=`<section class="panel"><h2>导入任务报告</h2><p>选择原生任务后上传 JSON 对象数组（1–50 行，最多 ${observationImportLimits.bytes} 字节）。报告不是已核验事实，不会自动训练或修改实际完成状态。</p><p>当前任务：${escape(task?task.id+' / v'+task.version:'请先到对象浏览器选择 InvestigationTask')}</p><p>来源系统和观察通道必须由管理员在服务端授权；文件不能指定权限、分类或 GOLD 等级。</p><label>报告文件<input id="import-file" type="file" accept=".json,application/json" ${task?'':'disabled'}></label><p>${escape(fileName)}</p>${raw?`<form id="import-map"><div class="row"><label>来源系统<input id="import-source" maxlength="2000" value="${escape(sourceSystem)}" required></label><label>观察通道<input id="import-channel" maxlength="2000" value="${escape(channelKey)}" required></label></div><div class="row">${observationImportFields.map(field=>`<label>${escape(field)}<select id="import-map-${field}" required><option value="">选择来源列</option>${columns.map(column=>`<option value="${escape(column)}" ${mapping[field]===column?'selected':''}>${escape(column)}</option>`).join('')}</select></label>`).join('')}</div><p>eventTime 为 UTC ISO 时间；reportedCompletion 为 DONE / NOT_DONE / UNKNOWN / null。sourceRevision 使用字符串。未映射列不会上传。</p><button class="primary">整批质量预检</button></form>`:''}</section>${plan?`<section class="panel"><h2>已预检 ${plan.inputs.length} 行 · 尚需确认提交</h2><p>本体版本摘要 ${escape(plan.catalogHash)}。以下显示前 10 行的实际映射内容。</p><pre>${escape(JSON.stringify(plan.inputs.slice(0,10),null,2))}</pre><p>每行分别提交原生事务，整批不是单事务。失败立即停止，之前成功的对象不撤销。修正后重新导入由原生来源记录/修订去重。</p><button id="import-confirm" class="primary" ${progress?.entries.some(e=>e.status==='FAILED')||progress?.entries.every(e=>['COMMITTED','REPLAYED'].includes(e.status))?'disabled':''}>${progress?.entries.some(e=>e.status==='UNCERTAIN')?'按原请求重试并继续':'确认导入'}</button></section>`:''}${progress?`<section class="panel"><h2>原生导入结果</h2><p>本页进度只保存在当前会话；原生对象、回执和来源事件持久保存。刷新或退出后请从平台查证，不将页面进度当作持久作业。</p><div class="table-wrap"><table><thead><tr><th>行 / 来源</th><th>状态</th><th>原生结果</th></tr></thead><tbody>${progress.entries.map((entry,index)=>`<tr><td>${index+1} · ${escape(entry.sourceRecordId)} / ${escape(entry.sourceRevision)}</td><td>${escape(statusLabels[entry.status])}${entry.error?'<p>'+escape(entry.error)+'</p>':''}</td><td>${entry.reference?`<button data-import-object="${index}">查看 ${escape(entry.reference.id)}</button><p>回执 ${escape(entry.receiptId??'来源去重返回；无新回执')}；事件 ${escape(entry.eventId??'未返回新事件')}</p>`:'—'}</td></tr>`).join('')}</tbody></table></div></section>`:''}`;
    $('#content').innerHTML=intake.markup()+$('#content').innerHTML;intake.bind();
    $('#import-file').onchange=()=>void run(async()=>{
      const file=$('#import-file').files[0];clearPlan();raw='';columns=[];mapping={};fileName='';if(!file){render();return;}
      const localGeneration=generation;
      try{
        if(!task)throw Error('请先选择原生任务');
        if(file.size>observationImportLimits.bytes)throw Error('文件超过 500000 字节');
        const value=await file.text();if(localGeneration!==generation)throw Object.assign(Error('会话已变化'),{discarded:true});
        const rows=parseObservationFile(value);raw=value;fileName=file.name;
        columns=[...new Set(rows.flatMap(row=>Object.keys(row)))].sort();
        mapping=Object.fromEntries(observationImportFields.map(field=>[field,columns.includes(field)?field:'']));
      }finally{if(localGeneration===generation)render();}
    });
    if(raw){
      const changed=()=>{if(isBusy())return;sourceSystem=$('#import-source').value;channelKey=$('#import-channel').value;mapping=Object.fromEntries(observationImportFields.map(field=>[field,$('#import-map-'+field).value]));clearPlan();if($('#import-confirm'))$('#import-confirm').disabled=true;};
      $('#import-source').oninput=changed;$('#import-channel').oninput=changed;
      for(const field of observationImportFields)$('#import-map-'+field).onchange=changed;
      $('#import-map').onsubmit=event=>{event.preventDefault();if(isBusy())return;changed();void run(async()=>{
        plan=planObservationImport({raw,mapping,sourceSystem,channelKey,task:getDetail()?.reference,catalog:getCatalog()});batch=createObservationImportBatch(plan);progress=batch.snapshot();render();
      });};
    }
    if(plan)$('#import-confirm').onclick=()=>{if(isBusy()||!batch)return;const current=batch,localGeneration=generation;void run(async epoch=>{
      try{await current.run({api,epoch,onProgress:value=>{if(localGeneration===generation&&batch===current){progress=value;render();}}});}
      finally{if(localGeneration===generation)render();}
    });};
    document.querySelectorAll('[data-import-object]').forEach(button=>button.onclick=()=>void run(epoch=>onOpenObject(progress.entries[Number(button.dataset.importObject)].reference,epoch)));
  }
  return {render,reset};
}
