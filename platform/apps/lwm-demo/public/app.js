const viewContainer = document.querySelector('#view-container');
const pageTitle = document.querySelector('#page-title');
const queueNavCount = document.querySelector('#queue-nav-count');
const reviewDialog = document.querySelector('#review-dialog');
const taskDialog = document.querySelector('#task-dialog');
const confirmDialog = document.querySelector('#confirm-dialog');
const tourDialog = document.querySelector('#tour-dialog');

let state = null;
let activeView = 'queue';
let selectedMatterId = 'matter-014';
let riskFilter = 'ALL';
let searchQuery = '';
let accessToken = '';
let currentUser = null;
const loginDialog = document.querySelector('#login-dialog');

const labels = {
  PENDING: '待复核',
  NEEDS_EVIDENCE: '待补证',
  APPROVED: '已批准',
  MODIFIED: '已修正',
  REJECTED: '已拒绝',
  IN_REVIEW: '复核中',
  DECIDED: '已裁定',
  CLOSED: '已关闭',
  PASS: '通过',
  BLOCKED: '阻断',
  WARN: '提示',
  HIGH: '高',
  CRITICAL: '关键',
  MEDIUM: '中',
  LOW: '低',
  ACTIVE: '当前版本',
  CANDIDATE: '候选版本',
  STANDBY: '待命版本',
  HELD: '已暂停',
  COMPLETED: '已完成',
  OPEN: '进行中',
  ACCEPTED: '接受',
  CORRECTED: '修正',
  GATE_BLOCKED: '门禁阻断',
};

const viewTitles = {
  queue: '待办队列',
  review: '审查工作台',
  learning: '学习与审计',
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatDate(value, withTime = false) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
  }).format(new Date(value));
}

function pct(value, digits = 0) {
  return `${(value * 100).toFixed(digits)}%`;
}

function statusPill(value, extra = '') {
  const normalized = String(value).toLowerCase().replaceAll('_', '-');
  return `<span class="status-pill status-${normalized} ${extra}">${escapeHtml(labels[value] ?? value)}</span>`;
}

function iconForKind(kind) {
  return { DOCUMENT: 'DOC', EVENT: 'EVT', TESTIMONY: 'WIT', SYSTEM_SIGNAL: 'SYS' }[kind] ?? 'OBS';
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(options.method === 'POST' ? { 'if-match': String(state?.revision), 'idempotency-key': crypto.randomUUID() } : {}),
      ...(options.headers ?? {}) },
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error?.message ?? '请求失败');
    error.code = payload.error?.code;
    if (response.status === 401) loginDialog.showModal();
    throw error;
  }
  return payload.data ?? payload;
}

function toast(message, kind = 'success') {
  const region = document.querySelector('#toast-region');
  const item = document.createElement('div');
  item.className = `toast toast-${kind}`;
  item.innerHTML = `<span class="toast-mark">${kind === 'success' ? '✓' : '!'}</span><span>${escapeHtml(message)}</span>`;
  region.append(item);
  setTimeout(() => item.classList.add('is-visible'), 20);
  setTimeout(() => {
    item.classList.remove('is-visible');
    setTimeout(() => item.remove(), 220);
  }, 3600);
}

function setView(view) {
  activeView = view;
  pageTitle.textContent = viewTitles[view];
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.view === view);
  });
  render();
}

function getMatter(matterId = selectedMatterId) {
  return state.matters.find((matter) => matter.id === matterId) ?? state.matters[0];
}

function getProposal(matter) {
  return state.proposals.find((proposal) => proposal.id === matter.proposalId);
}

function renderMetric(label, value, detail, tone = '') {
  return `
    <article class="metric-card ${tone}">
      <span class="metric-label">${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <span class="metric-detail">${escapeHtml(detail)}</span>
    </article>`;
}

function renderQueue() {
  const pending = state.matters.filter((matter) => {
    const proposal = getProposal(matter);
    const open = ['PENDING', 'NEEDS_EVIDENCE'].includes(proposal?.status);
    const matchesRisk = riskFilter === 'ALL' || matter.riskBand === riskFilter;
    const haystack = `${matter.matterNumber} ${matter.title} ${matter.owner}`.toLowerCase();
    return open && matchesRisk && haystack.includes(searchQuery.toLowerCase());
  });

  const cards = pending.map((matter) => {
    const proposal = getProposal(matter);
    const blocked = proposal.gateStatus === 'BLOCKED';
    return `
      <button type="button" class="matter-card ${blocked ? 'is-blocked' : ''}" data-open-matter="${escapeHtml(matter.id)}">
        <div class="matter-card-top">
          <div class="matter-id"><span>${escapeHtml(matter.matterNumber)}</span>${statusPill(matter.riskBand)}</div>
          <span class="due-date">截止 ${formatDate(matter.dueAt, true)}</span>
        </div>
        <div class="matter-card-body">
          <div>
            <h3>${escapeHtml(matter.title)}</h3>
            <p>${escapeHtml(matter.summary)}</p>
          </div>
          <div class="proposal-signal">
            <div class="confidence-ring" style="--confidence:${Math.round(proposal.confidence * 100)}">
              <span>${Math.round(proposal.confidence * 100)}</span><small>%</small>
            </div>
            <div><span>模型建议</span><strong>${escapeHtml(proposal.toState)}</strong></div>
          </div>
        </div>
        <div class="matter-card-footer">
          <span class="owner-chip"><i>${escapeHtml(matter.owner.slice(0, 1))}</i>${escapeHtml(matter.owner)}</span>
          <span class="state-path"><code>${escapeHtml(matter.currentState)}</code><b>→</b><code>${escapeHtml(proposal.toState)}</code></span>
          <span class="gate-indicator gate-${proposal.gateStatus.toLowerCase()}"><i></i>${blocked ? '确定性门阻断' : '门禁已通过'}</span>
        </div>
      </button>`;
  }).join('');

  return `
    <div class="page-intro">
      <div>
        <span class="eyebrow">OPERATIONAL QUEUE</span>
        <h2>把不确定性排在最前面</h2>
        <p>模型只能提出状态迁移建议。确定性规则先阻断，人工复核后才会写入事实与反馈。</p>
      </div>
      <div class="snapshot-stamp"><span>快照版本</span><b>${state.revision}</b><small>全量合成 · 持久化</small></div>
    </div>
    <div class="metrics-grid">
      ${renderMetric('待裁定建议', state.computed.pendingCount, '3 个业务域', 'metric-primary')}
      ${renderMetric('高风险 / 关键', state.computed.highRiskCount, '优先进入人工复核')}
      ${renderMetric('确定性门阻断', state.computed.blockedCount, '不能由模型绕过', 'metric-warning')}
      ${renderMetric('开放调查任务', state.computed.openTaskCount, '证据闭环中')}
    </div>
    <section class="section-card queue-section">
      <div class="section-header queue-toolbar">
        <div>
          <span class="eyebrow">PRIORITIZED MATTERS</span>
          <h2>事项队列 <small>${pending.length} 条</small></h2>
        </div>
        <div class="queue-controls">
          <label class="search-box"><span aria-hidden="true">⌕</span><input id="queue-search" value="${escapeHtml(searchQuery)}" placeholder="搜索事项、负责人"></label>
          <div class="filter-group" aria-label="风险筛选">
            ${['ALL', 'CRITICAL', 'HIGH', 'MEDIUM'].map((risk) => `<button type="button" data-risk="${risk}" class="filter-button ${riskFilter === risk ? 'is-active' : ''}">${risk === 'ALL' ? '全部' : labels[risk]}</button>`).join('')}
          </div>
        </div>
      </div>
      <div class="matter-list">
        ${cards || '<div class="empty-state"><span>✓</span><h3>当前筛选下没有待办</h3><p>调整风险等级或搜索条件。</p></div>'}
      </div>
    </section>
    <div class="governance-strip">
      <span class="mono-label">CONTROL PLANE</span>
      <div><b>模型提议</b><small>不可直接执行</small></div><i>→</i>
      <div><b>规则门禁</b><small>缺证据即阻断</small></div><i>→</i>
      <div><b>人工裁定</b><small>接受 / 修正 / 拒绝</small></div><i>→</i>
      <div><b>离线学习</b><small>候选版本人工晋级</small></div>
    </div>`;
}

function renderReview() {
  const matter = getMatter();
  const proposal = getProposal(matter);
  const observations = state.observations.filter((observation) => matter.observationIds.includes(observation.id));
  const tasks = state.tasks.filter((task) => matter.taskIds.includes(task.id));
  const model = state.models.find((entry) => entry.id === proposal.modelId);
  const stillOpen = ['PENDING', 'NEEDS_EVIDENCE'].includes(proposal.status);
  const latestReview = state.reviews.find((review) => review.proposalId === proposal.id);

  return `
    <div class="review-heading">
      <button type="button" class="back-button" data-view-jump="queue">← 返回队列</button>
      <div class="review-title-row">
        <div>
          <span class="matter-number">${escapeHtml(matter.matterNumber)} · ${escapeHtml(matter.jurisdiction)}</span>
          <h2>${escapeHtml(matter.title)}</h2>
        </div>
        <div class="heading-pills">${statusPill(matter.riskBand)}${statusPill(proposal.status)}</div>
      </div>
    </div>

    <div class="review-layout">
      <div class="review-main">
        <section class="section-card state-card">
          <div class="section-header">
            <div><span class="eyebrow">STATE TRANSITION</span><h3>建议的状态迁移</h3></div>
            <span class="model-chip">${escapeHtml(model.versionLabel)} · ${pct(proposal.confidence)}</span>
          </div>
          <div class="state-transition">
            <div class="state-node"><small>${stillOpen ? '当前事实状态' : '迁移前状态'}</small><strong>${escapeHtml(stillOpen ? matter.currentState : latestReview?.previousState ?? matter.currentState)}</strong><span>写入 ${formatDate(matter.openedAt)}</span></div>
            <div class="transition-arrow"><span>${Math.round(proposal.confidence * 100)}%</span><i>→</i><small>模型置信度</small></div>
            <div class="state-node state-node-proposed"><small>${stillOpen ? '建议目标状态' : '人工裁定结果'}</small><strong>${escapeHtml(latestReview?.appliedState ?? proposal.toState)}</strong><span>${stillOpen ? '尚未执行' : labels[proposal.status]}</span></div>
          </div>
          <div class="proposal-copy">
            <div><span>推理摘要</span><p>${escapeHtml(proposal.rationale)}</p></div>
            <div><span>证据覆盖</span><p>${escapeHtml(proposal.evidenceSummary)}</p></div>
          </div>
        </section>

        <section class="section-card evidence-card">
          <div class="section-header">
            <div><span class="eyebrow">EVIDENCE LEDGER</span><h3>事实与证据</h3></div>
            <span class="verified-count">${observations.filter((item) => item.verified).length}/${observations.length} 已核验</span>
          </div>
          <div class="evidence-list">
            ${observations.map((item) => `
              <article class="evidence-item">
                <span class="evidence-kind">${iconForKind(item.kind)}</span>
                <div><h4>${escapeHtml(item.title)}</h4><p>${escapeHtml(item.summary)}</p><small>${escapeHtml(item.source)} · ${formatDate(item.observedAt, true)}</small></div>
                <span class="confidence-label">${pct(item.confidence)}<small>可信</small></span>
              </article>`).join('')}
          </div>
        </section>

        ${tasks.length ? `
        <section class="section-card task-card">
          <div class="section-header"><div><span class="eyebrow">INVESTIGATION</span><h3>调查任务</h3></div></div>
          ${tasks.map((task) => `
            <div class="task-row">
              <div class="task-check ${task.status === 'COMPLETED' ? 'is-done' : ''}">${task.status === 'COMPLETED' ? '✓' : '!'}</div>
              <div><strong>${escapeHtml(task.title)}</strong><p>${escapeHtml(task.instructions)}</p><small>${escapeHtml(task.assignee)} · 截止 ${formatDate(task.dueAt, true)}</small></div>
              ${!['COMPLETED', 'CANCELLED'].includes(task.status) ? `<button class="button button-primary" type="button" data-complete-task="${escapeHtml(task.id)}">${task.status === 'AWAITING_REVIEW' ? '独立核验证据' : '提交补证材料'}</button>` : statusPill('COMPLETED')}
            </div>`).join('')}
        </section>` : ''}
      </div>

      <aside class="review-rail">
        <section class="section-card gate-card gate-card-${proposal.gateStatus.toLowerCase()}">
          <div class="gate-verdict"><span class="gate-symbol">${proposal.gateStatus === 'PASS' ? '✓' : '×'}</span><div><small>DETERMINISTIC GATE</small><strong>${proposal.gateStatus === 'PASS' ? (stillOpen ? '允许人工裁定' : '规则门已通过，裁定已记录') : '状态迁移已阻断'}</strong></div></div>
          <p>${escapeHtml(proposal.gateReason)}</p>
          <ul class="check-list">
            ${proposal.policyChecks.map((check) => `<li><span class="check-${check.status.toLowerCase()}">${check.status === 'PASS' ? '✓' : check.status === 'WARN' ? '!' : '×'}</span><b>${escapeHtml(check.label)}</b>${statusPill(check.status)}</li>`).join('')}
          </ul>
        </section>

        <section class="section-card decision-card">
          <span class="eyebrow">HUMAN DECISION</span>
          <h3>${stillOpen ? '记录人工裁定' : '该建议已完成裁定'}</h3>
          <textarea id="quick-note" rows="3" placeholder="先记录复核依据，再选择动作" ${stillOpen ? '' : 'disabled'}></textarea>
          <div class="decision-actions">
            <button type="button" class="button button-primary" data-review="APPROVE" ${!stillOpen || proposal.gateStatus !== 'PASS' ? 'disabled' : ''}>批准迁移</button>
            <button type="button" class="button button-secondary" data-review="MODIFY" ${!stillOpen || proposal.gateStatus !== 'PASS' ? 'disabled' : ''}>修正建议</button>
            <button type="button" class="button button-ghost button-danger-text" data-review="REJECT" ${!stillOpen ? 'disabled' : ''}>拒绝建议</button>
          </div>
          ${stillOpen && proposal.gateStatus === 'PASS' ? `<button type="button" class="text-button decision-link" data-request-evidence="${escapeHtml(proposal.id)}">证据仍不足？创建调查任务</button>` : ''}
          <div class="decision-footnote"><i></i><span>没有“自动执行”路径。每次动作都会写入审计与反馈。</span></div>
        </section>

        <section class="section-card ontology-mini">
          <div class="section-header"><div><span class="eyebrow">OBJECT GRAPH</span><h3>当前对象关系</h3></div></div>
          <div class="mini-graph">
            <span class="graph-node node-matter">Matter</span><i></i><span class="graph-node node-proposal">Proposal</span>
            <span class="graph-node node-observation">${observations.length}× Observation</span><i></i><span class="graph-node node-model">Model ${escapeHtml(model.versionLabel)}</span>
          </div>
        </section>
      </aside>
    </div>`;
}

function renderLearning() {
  const active = state.computed.activeModel;
  const candidate = state.computed.candidateModel;
  const feedback = state.computed.feedbackTotals;
  const totalFeedback = feedback.accepted + feedback.corrected + feedback.rejected + feedback.gateBlocked;
  const bars = [
    ['接受', feedback.accepted, 'bar-green'],
    ['人工修正', feedback.corrected, 'bar-blue'],
    ['拒绝', feedback.rejected, 'bar-red'],
    ['规则阻断', feedback.gateBlocked, 'bar-amber'],
  ];
  const maxBar = Math.max(1, ...bars.map((entry) => entry[1]));

  return `
    <div class="page-intro learning-intro">
      <div><span class="eyebrow">GOVERNED LEARNING</span><h2>学习发生在线外，晋级发生在人手中</h2><p>反馈只进入候选训练集；活动模型不会在线改权重、改规则或改生产事实。</p></div>
      <div class="learning-cycle"><span>反馈</span><i>→</i><span>离线训练</span><i>→</i><span>评测</span><i>→</i><span>人工晋级</span></div>
    </div>

    <div class="metrics-grid">
      ${renderMetric('已裁定反馈', state.computed.totalReviewed, `本轮新增 ${state.learning.newEligibleLabels} 条`, 'metric-primary')}
      ${renderMetric('模型接受率', pct(state.computed.acceptanceRate, 1), '不含规则阻断')}
      ${renderMetric('活动模型', active?.versionLabel ?? '—', active ? `验证 ${active.validationScore.toFixed(2)}` : '无活动版本')}
      ${renderMetric('实际训练轮次', state.learning.rounds, '合成 CPU 参考模型；手动触发')}
    </div>

    <div class="learning-layout">
      <div class="learning-main">
        <section class="section-card feedback-card">
          <div class="section-header"><div><span class="eyebrow">FEEDBACK SIGNALS</span><h3>人工反馈分布</h3></div><span class="mono-label">${totalFeedback} EVENTS</span></div>
          <div class="feedback-bars">
            ${bars.map(([label, value, tone]) => `<div class="bar-row"><span>${label}</span><div class="bar-track"><i class="${tone}" style="width:${Math.max(8, value / maxBar * 100)}%"></i></div><b>${value}</b></div>`).join('')}
          </div>
          <div class="dataset-boundary"><span>训练数据边界</span><b>${state.learning.newEligibleLabels} 条独立核验的新标签</b><small>未核验反馈不得入训；合成留出集成绩不代表真实法律能力。</small></div>
          <button type="button" class="button button-primary" data-train ${!state.learning.newEligibleLabels || candidate ? 'disabled' : ''}>执行训练与独立评测</button>
          ${state.feedback.map(f => `<div class="task-row"><span>${escapeHtml(f.id)} · ${escapeHtml(f.outcome)} · ${escapeHtml(f.eligibility)}</span>${f.eligibility === 'PENDING' ? `<button type="button" class="button button-secondary" data-qualify="${escapeHtml(f.id)}">独立核验标签</button>` : ''}${f.eligibility === 'ELIGIBLE' ? `<button type="button" class="button button-ghost" data-withdraw="${escapeHtml(f.id)}">撤回标签</button>` : ''}</div>`).join('')}
        </section>

        <section class="section-card audit-card">
          <div class="section-header"><div><span class="eyebrow">IMMUTABLE-STYLE LOG</span><h3>审计事件流</h3></div><button type="button" class="text-button" data-show-ontology>查看对象图 →</button></div>
          <div class="audit-table-wrap">
            <table class="audit-table">
              <thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>目标</th><th>结果</th></tr></thead>
              <tbody>${state.audit.slice(0, 9).map((event) => `<tr><td>${formatDate(event.at, true)}</td><td>${escapeHtml(event.actor)}</td><td><code>${escapeHtml(event.action)}</code></td><td>${escapeHtml(event.target)}</td><td>${statusPill(event.result === 'DENIED' ? 'BLOCKED' : 'PASS')}</td></tr>`).join('')}</tbody>
            </table>
          </div>
          <p class="audit-disclaimer">平台事务内持久化审计及待投递事件，并记录哈希链。哈希链不等于外部 WORM 存储；云端归档需部署验收。</p>
        </section>
      </div>

      <aside class="model-rail">
        <section class="section-card model-card model-active">
          <div class="model-card-head"><div><span class="eyebrow">ACTIVE</span><h3>${escapeHtml(active?.versionLabel ?? '无')}</h3></div>${statusPill('ACTIVE')}</div>
          <div class="model-stats"><div><span>验证得分</span><b>${active?.validationScore.toFixed(2) ?? '—'}</b></div><div><span>校准误差</span><b>${active?.calibrationError.toFixed(2) ?? '—'}</b></div><div><span>漂移</span><b>${active?.drift.toFixed(2) ?? '—'}</b></div></div>
          <small>合成 CPU 参考模型；制品 ${escapeHtml(active?.artifactHash?.slice(0, 12))}。不代表研究 LWM 能力。</small>
        </section>

        ${candidate ? `<section class="section-card model-card model-candidate">
          <div class="model-card-head"><div><span class="eyebrow">RELEASE CANDIDATE</span><h3>${escapeHtml(candidate.versionLabel)}</h3></div>${statusPill('CANDIDATE')}</div>
          <div class="promotion-score"><span>离线评测</span><strong>${candidate.validationScore.toFixed(2)}</strong><small>阈值 0.85</small></div>
          <ul class="promotion-gates">${state.computed.promotionGates.map((gate) => `<li><span class="${gate.pass ? 'gate-pass' : 'gate-blocked'}">${gate.pass ? '✓' : '×'}</span><div><b>${escapeHtml(gate.label)}</b><small>${escapeHtml(gate.value)}</small></div></li>`).join('')}</ul>
          <button class="button button-primary button-block" type="button" data-model-action="promote" ${state.computed.promotionReady ? '' : 'disabled'}>人工批准晋级</button>
        </section>` : `<section class="section-card no-candidate"><span>✓</span><h3>没有待晋级候选</h3><p>当前活动版本已经过人工批准。</p></section>`}

        ${state.models.some((model) => model.stage === 'STANDBY') ? `<button class="button button-ghost button-block rollback-button" type="button" data-model-action="rollback">回滚到上一稳定版本</button>` : ''}
      </aside>
    </div>`;
}

function renderOntologyDialog() {
  const existing = document.querySelector('#ontology-dialog');
  if (existing) existing.remove();
  const dialog = document.createElement('dialog');
  dialog.id = 'ontology-dialog';
  dialog.className = 'modal ontology-dialog';
  dialog.innerHTML = `
    <div class="modal-header"><div><span class="eyebrow">ONTOLOGY GRAPH</span><h2>LWM 对象与反馈闭环</h2></div><button class="icon-button" type="button" data-close-dialog aria-label="关闭">×</button></div>
    <div class="ontology-map">
      <div class="ontology-row"><span class="ontology-node primary">Matter</span><i>包含</i><span class="ontology-node">Observation</span><span class="ontology-node">InvestigationTask</span></div>
      <div class="ontology-connector">↓ 生成建议</div>
      <div class="ontology-row"><span class="ontology-node accent">TransitionProposal</span><i>由</i><span class="ontology-node">ModelVersion</span><i>受约束</i><span class="ontology-node">RuleVersion</span></div>
      <div class="ontology-connector">↓ 人工裁定</div>
      <div class="ontology-row"><span class="ontology-node primary">HumanReview</span><i>产生</i><span class="ontology-node accent">FeedbackEvent</span><i>进入</i><span class="ontology-node">离线训练窗口</span></div>
    </div>
    <div class="ontology-legend"><span><i class="legend-object"></i>Open Foundry ObjectType</span><span><i class="legend-link"></i>受治理关系</span><span><i class="legend-action"></i>Action 管道</span></div>`;
  document.body.append(dialog);
  dialog.querySelector('[data-close-dialog]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  dialog.showModal();
}

function render() {
  if (!state) return;
  queueNavCount.textContent = state.computed.pendingCount;
  viewContainer.innerHTML = activeView === 'queue' ? renderQueue() : activeView === 'review' ? renderReview() : renderLearning();
}

async function refresh(message) {
  state = await api('/api/state');
  render();
  if (message) toast(message);
}

document.querySelectorAll('[data-view]').forEach((button) => {
  button.addEventListener('click', () => setView(button.dataset.view));
});

document.addEventListener('click', async (event) => {
  const target = event.target.closest('button');
  if (!target) return;
  try {
    if (target.hasAttribute('data-login')) {
      accessToken = ''; currentUser = null; state = null;
      document.querySelector('#current-user').textContent = '未登录';
      viewContainer.replaceChildren();
      loginDialog.showModal();
    } else if (target.hasAttribute('data-train')) {
      state = await api('/api/learning/train', { method: 'POST', body: '{}' });
      render(); toast('训练与留出集评测已完成；失败候选会自动暂停');
    } else if (target.dataset.qualify) {
      const label = window.prompt('独立核验后的正确目标状态（不是简单复述模型建议）：');
      const outcomeEvidence = window.prompt('业务结果证据引用：');
      if (!label || !outcomeEvidence) return;
      if (!window.confirm('确认已独立核验结果，且该合成数据符合训练资格？')) return;
      state = await api(`/api/feedback/${encodeURIComponent(target.dataset.qualify)}/qualify`, { method: 'POST', body: JSON.stringify({ label, outcomeEvidence, outcomeVerified: true, privacyApproved: true }) });
      render();
    } else if (target.dataset.withdraw) {
      const reason = window.prompt('撤回原因（至少四个字符）；相关模型将禁止继续使用：');
      if (!reason) return;
      state = await api(`/api/feedback/${encodeURIComponent(target.dataset.withdraw)}/withdraw`, { method: 'POST', body: JSON.stringify({ reason }) }); render();
    } else if (target.hasAttribute('data-ingest')) {
      const caseId = window.prompt('合成事项唯一标识（字母、数字、短横线）：');
      const title = window.prompt('事项标题（至少四个字符）：');
      const fromState = window.prompt('来源状态：EVIDENCE_COMPLETE / NOTICE_RECEIVED / CLAIM_RECEIVED');
      if (!caseId || !title || !fromState) return;
      state = await api('/api/matters', { method: 'POST', body: JSON.stringify({ caseId, title, fromState }) }); setView('queue');
    } else if (target.dataset.openMatter) {
      selectedMatterId = target.dataset.openMatter;
      setView('review');
    } else if (target.dataset.viewJump) {
      setView(target.dataset.viewJump);
    } else if (target.dataset.risk) {
      riskFilter = target.dataset.risk;
      render();
    } else if (target.dataset.review) {
      const matter = getMatter();
      const proposal = getProposal(matter);
      reviewDialog.querySelector('[name="proposalId"]').value = proposal.id;
      reviewDialog.querySelector('[name="decision"]').value = target.dataset.review;
      reviewDialog.querySelector('[name="reviewer"]').value = currentUser.id;
      reviewDialog.querySelector('[name="reviewer"]').readOnly = true;
      reviewDialog.querySelector('#review-dialog-title').textContent = {
        APPROVE: '批准模型建议', MODIFY: '修正模型建议', REJECT: '拒绝模型建议',
      }[target.dataset.review];
      reviewDialog.querySelector('#target-state-field').hidden = target.dataset.review !== 'MODIFY';
      reviewDialog.querySelector('[name="targetState"]').required = target.dataset.review === 'MODIFY';
      reviewDialog.querySelector('[name="note"]').value = document.querySelector('#quick-note')?.value ?? '';
      reviewDialog.showModal();
    } else if (target.dataset.requestEvidence) {
      taskDialog.querySelector('[name="proposalId"]').value = target.dataset.requestEvidence;
      const tomorrow = new Date(Date.now() + 48 * 60 * 60 * 1000);
      taskDialog.querySelector('[name="dueAt"]').value = tomorrow.toISOString().slice(0, 16);
      taskDialog.showModal();
    } else if (target.dataset.completeTask) {
      const task = state.tasks.find(t => t.id === target.dataset.completeTask);
      const verifying = task.status === 'AWAITING_REVIEW';
      const evidenceDigest = window.prompt('输入已核对的证据文件 SHA-256（64 位小写十六进制）：');
      if (!evidenceDigest) return;
      const note = window.prompt(verifying ? '独立核验依据（至少四个字符）：' : '补证结果（至少四个字符）：');
      if (!note) return;
      const source = verifying ? undefined : window.prompt('证据来源引用（至少四个字符）：');
      if (!verifying && !source) return;
      if (verifying && !window.confirm('确认已独立核对该证据，而不是仅确认摘要格式？')) return;
      target.disabled = true;
      state = await api(`/api/tasks/${encodeURIComponent(target.dataset.completeTask)}/${verifying ? 'verify' : 'complete'}`, {
        method: 'POST', body: JSON.stringify({ result: note, note, source, evidenceDigest, confirmed: verifying }),
      });
      render();
      toast(verifying ? '独立复核已记录，规则已重新计算' : '证据已提交，等待另一名复核员核验');
    } else if (target.dataset.modelAction) {
      const operation = target.dataset.modelAction;
      confirmDialog.querySelector('[name="operation"]').value = operation;
      confirmDialog.querySelector('[name="approver"]').value = currentUser.id;
      confirmDialog.querySelector('[name="approver"]').readOnly = true;
      confirmDialog.querySelector('#confirm-title').textContent = operation === 'promote' ? '批准候选模型晋级' : '确认模型回滚';
      confirmDialog.querySelector('#confirm-copy').textContent = operation === 'promote'
        ? '候选版本已通过当前离线门禁。晋级后，上一版本保留为可恢复的待命版本。'
        : '当前活动版本将被暂停，上一稳定版本恢复为活动状态。';
      confirmDialog.querySelector('#rollback-reason-field').hidden = operation !== 'rollback';
      confirmDialog.querySelector('[name="reason"]').required = operation === 'rollback';
      confirmDialog.querySelector('[name="confirmed"]').checked = false;
      confirmDialog.showModal();
    } else if (target.hasAttribute('data-show-ontology')) {
      renderOntologyDialog();
    } else if (target.hasAttribute('data-tour')) {
      tourDialog.showModal();
    } else if (target.hasAttribute('data-start-tour')) {
      tourDialog.close();
      selectedMatterId = 'matter-037';
      setView('review');
      toast('第 1 步：观察确定性门如何阻止缺证据的模型建议', 'info');
    } else if (target.hasAttribute('data-reset')) {
      if (window.confirm('重置所有演示操作，恢复到初始合成数据？')) {
        state = await api('/api/reset', { method: 'POST', body: '{}' });
        selectedMatterId = 'matter-014';
        setView('queue');
        toast('演示数据已恢复');
      }
    } else if (target.hasAttribute('data-close-dialog')) {
      target.closest('dialog')?.close();
    }
  } catch (error) {
    toast(error.message, 'error');
    target.disabled = false;
  }
});

viewContainer.addEventListener('input', (event) => {
  if (event.target.id === 'queue-search') {
    searchQuery = event.target.value;
    const cursor = event.target.selectionStart;
    render();
    const next = document.querySelector('#queue-search');
    next?.focus();
    next?.setSelectionRange(cursor, cursor);
  }
});

document.querySelector('#review-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    state = await api('/api/reviews', {
      method: 'POST',
      body: JSON.stringify(Object.fromEntries(form.entries())),
    });
    reviewDialog.close();
    render();
    toast('人工裁定、反馈与审计记录已同时写入');
  } catch (error) {
    toast(error.message, 'error');
  }
});

document.querySelector('#task-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.currentTarget).entries());
  body.dueAt = new Date(body.dueAt).toISOString();
  try {
    state = await api('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
    taskDialog.close();
    render();
    toast('调查任务已创建，建议保持阻断');
  } catch (error) {
    toast(error.message, 'error');
  }
});

document.querySelector('#confirm-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const operation = form.get('operation');
  const body = {
    approver: form.get('approver'),
    reason: form.get('reason'),
    confirmed: form.get('confirmed') === 'on',
  };
  try {
    state = await api(operation === 'promote' ? '/api/models/promote' : '/api/models/rollback', {
      method: 'POST', body: JSON.stringify(body),
    });
    confirmDialog.close();
    render();
    toast(operation === 'promote' ? '候选模型已人工晋级，上一版本进入待命' : '模型已回滚到上一稳定版本');
  } catch (error) {
    toast(error.message, 'error');
  }
});

for (const dialog of [reviewDialog, taskDialog, confirmDialog, tourDialog]) {
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
}

document.querySelector('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const loginForm = event.currentTarget;
  accessToken = new FormData(loginForm).get('token');
  try {
    currentUser = await api('/api/me');
    await refresh();
    document.querySelector('#current-user').textContent = currentUser.id;
    loginForm.reset();
    document.querySelector('#login-error').textContent = '';
    loginDialog.close();
  } catch (error) {
    accessToken = ''; currentUser = null;
    document.querySelector('#login-error').textContent = error.message;
  }
});
loginDialog.showModal();
