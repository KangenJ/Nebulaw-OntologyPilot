import {flowSteps} from './native-journey-flow.js';

// Fictional teaching fixture, never sent to native APIs or used as model evidence.
export const mockCase = Object.freeze({
  id: 'MOCK-SUPPLIER-001', title: '供应商消防整改：能否通过验收？',
  company: '示例企业：启衡制造（虚构）', supplier: '示例供应商：恒川包装（虚构）',
  target: '2026-09-08 17:00 的消防通道整改状态',
  amount: '待验收合同尾款 120,000 元（背景信息；本演练不执行付款）'
});
export function mockComparison(availability = 0.8) {
  if (!Number.isFinite(availability) || availability < 0 || availability > 1) throw Error('INVALID_MOCK_ASSUMPTION');
  // Explicit teaching assumptions, not output from the deployed model.
  const noCheck = 0.3 * 10000;
  return {noCheck, check: 600 + (1 - availability) * noCheck};
}
const lessons = [
  ['采购经理收到一项验收任务', '供应商承诺在 9 月 8 日 17:00 前清除消防通道堆料。采购经理需要先确认整改是否完成，才能进入后续验收流程。',
    '<h3>预设业务资料</h3><ul><li>合同附件：通道净宽须达到约定标准，且验收照片须覆盖整个通道。</li><li>任务负责人：采购经理林女士；现场核验人：质量专员周先生。</li><li>目标状态：已完成 / 未完成；当前业务记录：尚未核实。</li></ul>',
    '材料 → InvestigationTask（验收任务）与 Observation（来源报告）。这些只是映射示例，本演练没有创建原生对象。'],
  ['两份材料，不等于两个已确认事实', '两份材料指向同一目标时点，但覆盖范围不同。系统应保留来源和冲突，不直接采用供应商的结论。',
    '<article class="panel"><h3>Mock 材料 A · 供应商自报</h3><p>9 月 8 日 17:10 收到：“17:00 前已全部清理。”附件仅有通道入口照片；报告值：DONE。</p></article><article class="panel"><h3>Mock 材料 B · 仓库现场记录</h3><p>9 月 8 日 17:15 收到：“17:00 巡查时，通道末端仍有托盘。”附末端照片描述；报告值：NOT_DONE。</p></article><p>此处只有虚构文本材料，没有真实附件或已核验图片。两份报告均待核验。</p>',
    '保留来源、获知时间、目标时点与覆盖范围，不能把“收到报告”当成“事实已确认”。'],
  ['Logic 把证据、状态与行动分开', '业务规则是：自报完成不自动通过验收；材料存在冲突时先核验；提案人不能批准自己的提案。规则不是让聊天模型凭语气猜结论。',
    '<h3>讲解用条件判断 · 非在线模型输出</h3><p>假设已完成概率 70%，未完成概率 30%。这两个数是手工预设，仅用于下一步展示成本计算。</p><h3>三层意思</h3><ul><li>事实层：两份来源报告已收到，但结果尚未核实。</li><li>判断层：用条件分布表达不确定性，不改写事实。</li><li>规则层：约束哪些操作允许被提出、批准与执行。</li></ul>',
    '实际系统必须使用合格输入和原生模型读取契约；本页没有调用模型，也不能证明其准确率。'],
  ['花 600 元核验，值不值得？', '只比较“直接接受供应商自报”和“请求独立核验”的教学成本。假设错误接受造成损失 10,000 元，核验成本 600 元，取得有效核验后能完全消除本次误判损失；未取得结果时回到原策略。', '',
    '这是简化期望损失计算，忽略停工、延误及核验错误等成本；不是线上推演合同、付款授权或实际节省金额。'],
  ['建议交给人，执行受约束', '以“请求独立核验”为例，下面是预设流程剧本，不会提交提案或执行动作。',
    '<ol><li>林女士提出核验申请，附两份材料与方案假设。</li><li>独立审批人王经理检查预算、职责和证据；可以批准，也可以拒绝。</li><li>获批后，由获授权执行人创建现场核验任务。</li><li>若版本冲突则重新读取；若响应未知则查原请求，不重复执行。</li></ol><p class="callout">Mock 剧本状态：等待独立审批。点击下一步只是看后续示例，不代表审批通过。</p>',
    '审批成功 ≠ 执行成功；创建核验任务 ≠ 现场核验完成。付款不在本演练执行范围。'],
  ['现场结果回来，才能确认事实', '假设后续独立核验确实发现通道末端未清理，并取得了覆盖目标时点的合格材料。以下是虚构结果示例，不是刚才点击产生的记录。',
    '<h3>Mock 前后对照</h3><p>核验前：完成情况 UNKNOWN；核验后示例：NOT_DONE。</p><p>业务处理：不通过本次整改验收，要求供应商再次整改。后续时点清理完成，需要新的核验，不能倒推此前已经完成。</p><p>正式系统中必须能打开原生核验材料、动作回执、对象版本与审计；本演练不伪造这些引用。</p>',
    '业务事实更新需要合格材料与受治理动作，不能由模型概率或页面动画代替。'],
  ['让纠错进入下一轮，而非宣称学会了', '本次如果被核实为未完成，可以成为候选反馈。但需要先核对时点、来源、授权、重复与泄漏风险，再决定是否允许用于更新。',
    '<h3>预设学习验收剧本</h3><ul><li>轮次一：Mock 基线验证损失 0.24，候选 0.28 → 退化，拒绝发布。</li><li>轮次二：Mock 候选验证损失 0.22 → 仅进入人工发布审核，仍需其他门槛通过。</li><li>审核通过才可发布；保留上一版本以便回滚。</li></ul><p>上述评测数值全部手工预设，不来自训练运行；本页未创建反馈、数据集、模型或发布版本。</p>',
    '可持续学习的价值是可追溯更新、独立评测与阻止退化，不是保证每一轮都提升。']
];
export function mockMarkup(step = 0, availability = 0.8) {
  const [title, description, content, boundary] = lessons[step];
  const costs = mockComparison(availability);
  return `<div class="flow"><header class="panel flow-head"><span class="badge">MOCK · 虚构业务数据 · 无原生写入</span><h2>${mockCase.title}</h2><p>${mockCase.company} / ${mockCase.supplier}</p><p>${mockCase.amount}</p><p>统一目标时点：${mockCase.target}</p><p>这是现实业务逻辑的演练，不是真实客户案例、在线模型结果或平台执行证据。</p><button id="flow-mock-exit">退出演练，返回真实业务</button></header><div class="flow-layout"><nav class="flow-rail" aria-label="Mock 场景步骤">${flowSteps.map(([name],i)=>`<button data-mock-step="${i}" aria-current="${step===i?'step':'false'}"><span>${String(i+1).padStart(2,'0')}</span><strong>${name}</strong><small>预设讲解 · 非执行状态</small></button>`).join('')}</nav><main class="flow-main"><section class="panel"><div class="eyebrow">Mock 第 ${step+1} 步 / ${mockCase.id}</div><h2>${title}</h2><p>${description}</p>${content}${step===3?`<label>取得有效独立核验的概率（教学假设）<select id="mock-availability">${[0.2,0.5,0.8,1].map(p=>`<option value="${p}" ${p===availability?'selected':''}>${p*100}%</option>`).join('')}</select></label><div class="journey-options"><article class="journey-option"><h3>直接接受自报</h3><strong>${costs.noCheck.toFixed(0)} 元</strong><p>30% × 10,000</p></article><article class="journey-option"><h3>请求独立核验</h3><strong>${costs.check.toFixed(0)} 元</strong><p>600 + (1 − ${availability*100}%) × 3,000</p></article></div><p>本组假设下：${costs.check<costs.noCheck?'核验方案期望损失较低':costs.check>costs.noCheck?'核验方案期望损失较高':'两方案期望损失相同'}。改变假设会重算这个教学公式，不调用线上模型。</p>`:''}<div class="flow-impact"><strong>真实落地时必须满足</strong><p>${boundary}</p></div></section><div class="flow-next"><button id="mock-prev" ${step===0?'disabled':''}>上一步讲解</button><button id="mock-next" ${step===6?'disabled':''}>下一步讲解（不执行）</button></div></main><aside class="panel flow-timeline"><h3>这件事的业务主线</h3><p>收到两份材料 → 判断是否可信 → 比较核验成本 → 独立审批 → 现场核验 → 反馈评测。</p><h3>演练边界</h3><p>没有真实事件时间线；没有审批、执行或学习成功记录。退出后继续使用原有原生业务对象与权限。</p></aside></div></div>`;
}
