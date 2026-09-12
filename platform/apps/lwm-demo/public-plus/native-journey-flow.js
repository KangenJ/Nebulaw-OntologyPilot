const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const flowSteps=[
  ['了解任务','先看材料从哪里来','data','导入新的任务报告'],
  ['检查证据','哪些是报告，哪些已经核实？',null,''],
  ['查看判断','模型怎么看，哪些仍不确定？',null,''],
  ['比较方案','是否值得再做一次核验？','scenarios','在这里计算新方案'],
  ['审批与执行','建议交给谁，谁有权执行？','actions','打开提案、审批与执行'],
  ['核对结果','操作之后，业务事实改变了吗？',null,''],
  ['反馈与改进','业务办完，不等于模型已经学会','learning','打开反馈、评测与发布']
];
export const completionLabel=v=>({DONE:'已完成',NOT_DONE:'未完成',UNKNOWN:'完成情况尚未确认'}[v]??'未提供完成情况');
export function flowEvents({root,reports,belief,scenario,audit,feedback}){
  const events=[];const add=(id,time,title,who,note)=>{if(typeof time==='string'&&Number.isFinite(Date.parse(time)))events.push({id,time,title,who:who??'记录未提供操作人',note});};
  if(root)add('root:'+root._id,root._updatedAt??root.createdAt,'任务记录',root.registeredBy,'对象版本 '+root._version+'；不是完成证明');
  const seen=new Set();for(const i of reports?.items??[]){const o=i.neighbor.object;if(seen.has(o._id))continue;seen.add(o._id);add('report:'+o._id,o.receivedAt??o.recordedAt,'收到报告：'+completionLabel(o.reportedCompletion),o.registeredBy??o.sourceSystem,'来源报告，不等于已核实事实');}
  if(belief)add('belief:'+belief.beliefId,belief.record?.payload?.createdAt??belief.record?._createdAt,'模型判断存档',belief.record?.payload?.createdBy,'已在本次读取时核验；不是业务状态更新');
  if(scenario)add('scenario:'+scenario.scenario.id,scenario.scenario.createdAt,'方案已登记',null,'本次只读核验，不表示已经审批或执行');
  for(const a of audit?.items??[])add('audit:'+a.id,a.audit?.timestamp,'原生提交：'+(a.audit?.actionType??a.audit?.operation??'操作'),a.audit?.actorId,'结果 '+(a.audit?.result??'未提供')+'；投递 '+a.status+'，不等于现实结果');
  for(const f of feedback?.items??[])add('feedback:'+f.id,f.createdAt,'反馈登记',f.createdBy,'资格仍需核验，不能视为完成训练');
  return events.sort((a,b)=>Date.parse(b.time)-Date.parse(a.time)||a.id.localeCompare(b.id));
}
export function flowMarkup({step,detail,previousDetail,sections,checkedAt,needsRefresh,legacy}){
  const get=k=>sections[k]?.status==='ready'?sections[k].value:null;
  const root=get('root')?.object??detail?.object,r=detail?.reference,b=get('belief'),s=get('scenario'),reports=get('reports');
  const events=flowEvents({root:get('root')?.object,reports,belief:b,scenario:s,audit:get('audit'),feedback:get('feedback')});
  const states=[reports?'已读取可见报告':'等待读取',reports?'需检查范围与有效性':'等待读取',b?'当前判断已核验':'尚未核验',s?'已有方案已核验':'尚未核验','请查原请求状态',get('root')?'业务记录已读取':'等待读取',get('feedback')?'反馈登记已读取':'等待读取'];
  const instructions=[
    ['你正在处理什么','围绕这项任务，判断完成情况是否有足够依据，再决定是否需要追加核验。不会把所有任务都解释成同一行业的业务。','导入只新增报告与来源记录，不自动确认完成，也不自动训练。'],
    ['为什么不能直接认定完成','报告可以说“已完成”，业务记录却仍可能“尚未确认”。请核对来源、目标时间、覆盖范围和是否撤回。可见报告不代表全部进入当前模型。','有不同报告不等于已证明同一时点存在矛盾；没有核验结果也不等于失败。'],
    ['系统目前怎么看','下方概率是给定有效输入和当前模型的条件判断。它不是正式核验结果，也不是自动结案的依据。','此处读取并重新核验已有判断；新数据要经过合格快照与受授权重放才能进入新的判断。'],
    ['下一步怎么选','比较不追加核验和请求独立核验。要同时看判断错误代价、核验成本和取得结果的可能性。','调整假设后需实际计算。演示评分不是人民币，预测的损失降低不等于已实现收益。'],
    ['谁决定，谁执行','提案、独立审批、执行是三个不同操作。打开下方原生表单按当前身份处理；没有权限就交给对应负责人。','审批人必须使用自己的身份。即使创建复核任务成功，也不代表现场复核已经完成。'],
    ['结果真的改变了吗','完成操作后重新读取业务记录，核对原始结果与对象版本。模型预测和审计投递都不能代替业务事实。','未知响应请按原请求查证，不能换一个请求重复执行。'],
    ['这次经验如何用于下次','核验后的业务结果先登记为反馈，再独立检查资格、建立数据集、更新候选并评测；批准后才能发布。','用途级版本历史不是本任务的学习证明。没有对应反馈与评测链路，就不标成学习完成。']
  ][step];
  const tool=flowSteps[step][2];
  const before=get('root')&&previousDetail?.reference?.id===r?.id&&previousDetail.reference.type===r?.type?previousDetail:null;
  if(step===5&&before)legacy=`<section class="panel"><h3>两次读取之间，记录改变了吗？</h3><p>对象版本：v${esc(before.reference.version)} → v${esc(r.version)}</p><p>完成情况：${esc(completionLabel(before.object?.actualCompletion))} → ${esc(completionLabel(root?.actualCompletion))}</p><p>这是两次原生读取的差异，不自动归因于刚才的操作；具体原因请查看原请求与核验记录。</p></section>`;
  return `<div class="flow"><header class="panel flow-head"><div class="eyebrow">跟着一件事，看系统如何流转</div><h2>${r?'这项任务的完成情况，确认了吗？':'先选择一件要处理的事'}</h2><p>${esc(root?.title??'用实际业务对象开始，不加载固定演示结论。')}</p><div class="flow-facts"><span>业务记录<strong>${esc(completionLabel(root?.actualCompletion))}</strong></span><span>任务负责人<strong>${esc(root?.assignee??'未提供')}</strong></span><span>当前查看<strong>${esc(flowSteps[step][0])}</strong></span></div><p class="muted">${esc(root?.dataClassification??'分类未提供')} · 当前身份的角色仅决定可用操作，不自动代表任务处理人。${checkedAt?'最近读取 '+esc(checkedAt):'尚未重新读取记录'}</p><div class="row"><button id="flow-refresh" ${r?'':'disabled'}>读取最新业务进度</button><button id="flow-expert">切换专业总览</button></div>${needsRefresh?'<p class="callout">你已操作原生工作表。请读取最新业务进度核对结果；本页不会自动标记完成。</p>':''}</header>
  ${sections.root&&sections.root.status!=='ready'?`<p role="alert" class="callout">最新业务记录尚未读取成功：${esc(sections.root.message??sections.root.status)}。顶部可能保留所选对象的旧记录，不能视为本次最新结果。</p>`:''}
  ${!r?'<section class="panel"><h3>按任务名称找事情</h3><label>任务名称关键词<input id="flow-search-text" maxlength="256" placeholder="输入任务名称，也可以留空"></label><button id="flow-search">查询我可见的任务</button><div id="flow-search-results"></div><p>仅查询授权范围；没有任务类型时请使用对象浏览器。</p><button data-journey-go="objects">打开对象浏览器</button></section>':''}
  <div class="flow-layout"><nav class="flow-rail" aria-label="业务流程步骤">${flowSteps.map(([title],n)=>`<button data-flow-step="${n}" aria-current="${step===n?'step':'false'}"><span>${String(n+1).padStart(2,'0')}</span><strong>${title}</strong><small>${esc(states[n])}</small></button>`).join('')}<p>这是查看步骤，不是业务完成率。切换步骤不写入平台。</p></nav>
  <main class="flow-main" data-step="${step}"><section class="panel flow-instruction"><div class="eyebrow">第 ${step+1} 步 / ${esc(flowSteps[step][0])}</div><h2>${instructions[0]}</h2><p>${instructions[1]}</p><div class="flow-impact"><strong>操作会改变什么？</strong><p>${instructions[2]}</p></div>${tool?`<button id="flow-tool-open" data-tool="${tool}" class="primary" ${r?'':'disabled'}>${flowSteps[step][3]}</button>`:''}${step===5?`<h3>当前业务记录：${esc(completionLabel(root?.actualCompletion))}</h3><p>对象版本：${esc(r?.version??'未读取')}。以下版本信息只说明记录，不自动证明业务结果已核验。</p><button id="flow-result-refresh" ${r?'':'disabled'}>重新读取结果与事件</button>`:''}${step===2?'<button data-journey-go="learning">准备新输入与受授权重放 →</button>':''}</section><section id="flow-tool-slot" hidden></section><div class="flow-original">${legacy}</div><div class="flow-next"><button id="flow-prev" ${step===0?'disabled':''}>查看上一步</button><button id="flow-next" ${step===6?'disabled':''}>查看下一步（不执行操作）</button></div></main>
  <aside class="panel flow-timeline"><h3>实际记录时间线</h3><p>时间来自原生记录，不是刚才点击按钮的时间；仅当前授权且已读取范围。</p>${events.map(e=>`<article><time>${esc(e.time)}</time><strong>${esc(e.title)}</strong><span>${esc(e.who)}</span><small>${esc(e.note)}</small><details><summary>原生引用</summary>${esc(e.id)}</details></article>`).join('')||'<p>尚无可展示的带时间记录。先读取业务进度；不生成预置事件。</p>'}<p>审批、执行或学习链路未取得完整记录时，保持未确认，不补画成功节点。</p></aside></div></div>`;
}
