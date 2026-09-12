import {matterIntakeFields,taskRegistrationFields,ruleIntakeFields,planNativeIntake,createNativeIntakeCommand} from './native-intake.js';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={matterNumber:'来源业务编号',title:'标题',jurisdiction:'所属法域/区域',currentState:'来源流程状态（非现实核验）',riskBand:'来源风险级别（非模型预测）',openedAt:'来源建立时间',sourceSystem:'已授权来源系统',sourceRecordId:'来源记录ID',sourceRevision:'来源修订',taskNumber:'任务编号',priority:'任务优先级',assignee:'执行人',instructions:'任务说明',dueAt:'截止时间'};
const statuses={PENDING:'已预检，尚未提交',SUBMITTING:'提交中',COMMITTED:'原生事务已提交',REPLAYED:'原生幂等返回',UNCERTAIN:'结果未知，必须使用原请求查证/重试',FAILED:'服务拒绝或预检失效，请修正后重新预检'};
Object.assign(labels,{ruleKey:'规则来源键（不是表达式）',versionTag:'来源版本标记',effectiveFrom:'来源生效时间',sourceCitation:'来源引用与说明（不是审批）'});
export function createNativeIntakeWorkbench({document,api,run,isBusy,getCatalog,getDetail,onOpenObject,onRender}){
  const $=selector=>document.querySelector(selector);let values={MATTER:{},TASK:{},RULE:{}},command,generation=0;
  const locked=()=>['SUBMITTING','UNCERTAIN'].includes(command?.snapshot().status);
  function reset(){generation++;command?.invalidate();command=undefined;values={MATTER:{},TASK:{},RULE:{}};}
  function markup(){
    const catalog=getCatalog(),bands=catalog?.bundle?.parsed?.enums?.find(e=>e.name==='RiskBand')?.values?.map(v=>v.name)??[],matter=getDetail()?.reference;
    const form=(kind,fields,available)=>`<form id="intake-${kind}"><fieldset ${!available||locked()?'disabled':''}><div class="row">${fields.map(field=>`<label>${escape(labels[field])}${['priority','riskBand'].includes(field)?`<select id="intake-${kind}-${field}" required><option value="">请选择</option>${bands.map(b=>`<option value="${escape(b)}" ${values[kind][field]===b?'selected':''}>${escape(b)}</option>`).join('')}</select>`:`<input id="intake-${kind}-${field}" value="${escape(values[kind][field]??'')}" maxlength="${field==='instructions'?20000:2000}" required>`}</label>`).join('')}</div><button>检查并预览${kind==='MATTER'?'来源对象':kind==='RULE'?'规则来源':'任务'}</button></fieldset></form>`;
    const state=command?.snapshot(),ruleAvailable=!!catalog?.bundle?.manifests?.NativeImportTaskRule&&!catalog.bundle.disabledActions?.includes('NativeImportTaskRule');
    const ruleForm=`<section class="panel"><h2>规则来源登记</h2><p>数据审核员登记原生 RuleVersion。来源不是可执行表达式；导入不批准规则、模型或训练，也不生成监督标签。权限、工作空间和分类由服务端核验。</p><p>合成环境可使用已授权 demo-rule 来源；其他环境须使用管理员授权的来源。旧实例必须先受控发布原生动作；本页不会自动迁移。来源修订不覆盖已有规则键。</p>${ruleAvailable?'':'<p>当前本体未启用规则来源导入。</p>'}${form('RULE',ruleIntakeFields,ruleAvailable)}</section>`;
    return ruleForm+`<section class="panel"><h2>1. 登记来源业务对象</h2><p>无需预置数据。输入真实来源记录；来源系统在服务端确定工作空间和数据分类。这里只导入原始流程属性，不创建观察、核验、模型结论或审批。旧 NativeImportMatter 保持禁用。</p><p>独立合成演示环境的来源名为 demo-matter；其他环境须使用管理员已授权的来源。时间格式例如 2026-09-01T00:00:00.000Z；没有来源值时不要编造风险等级。</p>${form('MATTER',matterIntakeFields,!!catalog?.bundle?.manifests?.NativeImportTaskMatter)}</section><section class="panel"><h2>2. 在当前业务对象下登记任务</h2><p>${escape(matter?.type==='Matter'?matter.id+' / v'+matter.version:'先查看刚导入的 Matter，再返回数据工作台')}</p><p>新任务的实际完成状态保持 UNKNOWN，流程状态不是监督标签。</p>${form('TASK',taskRegistrationFields,matter?.type==='Matter'&&!!catalog?.bundle?.manifests?.NativeRegisterInvestigationTask)}</section>${state?`<section class="panel"><h2>当前登记请求：${escape(state.plan.action)}</h2><p>${escape(statuses[state.status])}</p><p>绑定本体 ${escape(state.plan.catalogHash)}；以下是本次冻结请求，不随当前选择的对象改变。</p><pre>${escape(JSON.stringify(state.plan.body,null,2))}</pre>${state.error?'<p class="error">'+escape(state.error)+'</p>':''}<button id="intake-confirm" ${['COMMITTED','REPLAYED','FAILED','SUBMITTING'].includes(state.status)?'disabled':''}>${state.status==='UNCERTAIN'?'按完全相同的原请求重试':'确认提交原生动作'}</button>${state.reference?`<p>回执 ${escape(state.receiptId??'来源去重；未创建新回执')}</p><button id="intake-open">查看 ${escape(state.reference.type+' / '+state.reference.id)}</button>`:''}<p>请求进度仅保存在当前会话，平台对象、来源和回执持久保存。结果未知时不要更换请求键或重新登记；重新登录后先在平台查证来源记录。</p></section>`:''}`;
  }
  function bind(){
    for(const [kind,fields]of [['MATTER',matterIntakeFields],['TASK',taskRegistrationFields],['RULE',ruleIntakeFields]]){
      const collect=()=>Object.fromEntries(fields.map(f=>[f,$('#intake-'+kind+'-'+f).value]));
      for(const field of fields)$('#intake-'+kind+'-'+field).oninput=()=>{if(isBusy()||locked())return;values[kind]=collect();if(command?.snapshot().status==='PENDING'){command.invalidate();command=undefined;if($('#intake-confirm'))$('#intake-confirm').disabled=true;}};
      $('#intake-'+kind).onsubmit=event=>{event.preventDefault();if(isBusy()||locked())return;values[kind]=collect();void run(async()=>{
        const plan=planNativeIntake({kind,input:values[kind],matter:getDetail()?.reference,catalog:getCatalog()});command?.invalidate();command=createNativeIntakeCommand(plan);onRender();
      });};
    }
    if(command){const selected=command,epochGeneration=generation;$('#intake-confirm').onclick=()=>{if(isBusy())return;void run(async epoch=>{try{await selected.submit(api,epoch);}finally{if(epochGeneration===generation&&command===selected)onRender();}});};}
    if(command?.snapshot().reference)$('#intake-open').onclick=()=>void run(epoch=>onOpenObject(command.snapshot().reference,epoch));
  }
  return {markup,bind,reset};
}
