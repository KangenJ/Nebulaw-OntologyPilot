import { MemoryStore } from './store.mjs';
import { hash, TRANSITIONS, corpus, buildModel, predict, validateArtifact, promotionGates } from './learning.mjs';

const WORKSPACE_KEY = 'lwm-demo';

export class DemoError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DemoError';
    this.code = code;
    this.status = status;
  }
}

const initialState = {
  meta: {
    product: 'Atlas Loop',
    subtitle: 'LWM 决策与学习控制台',
    workspaceKey: WORKSPACE_KEY,
    dataClassification: 'SYNTHETIC',
    tenantMode: 'SINGLE_TENANT',
    executionMode: 'HUMAN_APPROVAL_REQUIRED',
    ontologyVersion: 'lwm.demo@0.1.0',
    platform: 'Open Foundry v0.2.3',
  },
  matters: [
    {
      id: 'matter-014',
      matterNumber: 'MAT-2026-014',
      title: '数据保留义务复核',
      jurisdiction: 'Synthetic-CN',
      status: 'IN_REVIEW',
      currentState: 'EVIDENCE_COMPLETE',
      riskBand: 'HIGH',
      owner: '林岚',
      summary: '供应商终止后是否仍需保留审计材料。',
      openedAt: '2026-09-01T08:30:00Z',
      dueAt: '2026-09-06T10:00:00Z',
      proposalId: 'proposal-014',
      observationIds: ['obs-014-01', 'obs-014-02'],
      taskIds: [],
    },
    {
      id: 'matter-021',
      matterNumber: 'MAT-2026-021',
      title: '供应商通知期限判断',
      jurisdiction: 'Synthetic-SG',
      status: 'IN_REVIEW',
      currentState: 'NOTICE_RECEIVED',
      riskBand: 'MEDIUM',
      owner: '周然',
      summary: '判断通知是否落在约定期限内。',
      openedAt: '2026-09-02T02:15:00Z',
      dueAt: '2026-09-07T09:00:00Z',
      proposalId: 'proposal-021',
      observationIds: ['obs-021-01'],
      taskIds: [],
    },
    {
      id: 'matter-037',
      matterNumber: 'MAT-2026-037',
      title: '劳动争议证据完整性',
      jurisdiction: 'Synthetic-EU',
      status: 'NEEDS_EVIDENCE',
      currentState: 'CLAIM_RECEIVED',
      riskBand: 'CRITICAL',
      owner: '许宁',
      summary: '关键送达凭证缺失，确定性门禁止状态迁移。',
      openedAt: '2026-09-03T06:45:00Z',
      dueAt: '2026-09-05T15:00:00Z',
      proposalId: 'proposal-037',
      observationIds: ['obs-037-01'],
      taskIds: ['task-037'],
    },
  ],
  observations: [
    {
      id: 'obs-014-01', title: '保留政策版本已确认', kind: 'DOCUMENT',
      source: 'Synthetic policy registry', confidence: 1, verified: true,
      summary: '政策第 4.2 节要求终止后保留审计材料 24 个月。',
      observedAt: '2026-09-01T09:12:00Z',
    },
    {
      id: 'obs-014-02', title: '终止日期已核验', kind: 'EVENT',
      source: 'Synthetic contract ledger', confidence: 0.98, verified: true,
      summary: '终止事件发生于 2026-08-31，签名链完整。',
      observedAt: '2026-09-01T09:18:00Z',
    },
    {
      id: 'obs-021-01', title: '通知邮件时间戳', kind: 'DOCUMENT',
      source: 'Synthetic mail archive', confidence: 0.94, verified: true,
      summary: '邮件时间戳与合同通知窗口相差 6 小时。',
      observedAt: '2026-09-02T03:20:00Z',
    },
    {
      id: 'obs-037-01', title: '送达凭证缺失', kind: 'SYSTEM_SIGNAL',
      source: 'Synthetic evidence index', confidence: 1, verified: true,
      summary: '记录中未发现带签收时间的送达凭证。',
      observedAt: '2026-09-03T07:05:00Z',
    },
  ],
  proposals: [
    {
      id: 'proposal-014', proposalNumber: 'PRP-2026-014-A', matterId: 'matter-014',
      modelId: 'model-active', title: '进入持续保留状态', fromState: 'EVIDENCE_COMPLETE',
      toState: 'RETENTION_REQUIRED', status: 'PENDING', riskBand: 'HIGH', confidence: 0.92,
      rationale: '规则版本 3 与终止事件共同满足保留触发条件。',
      evidenceSummary: '2/2 必要证据已核验。', gateStatus: 'PASS',
      gateReason: '必要证据、规则有效期和状态前置条件均满足',
      createdAt: '2026-09-04T01:20:00Z',
      policyChecks: [
        { label: '规则版本有效', status: 'PASS' },
        { label: '必要证据完整', status: 'PASS' },
        { label: '当前状态未漂移', status: 'PASS' },
      ],
    },
    {
      id: 'proposal-021', proposalNumber: 'PRP-2026-021-A', matterId: 'matter-021',
      modelId: 'model-active', title: '确认通知及时', fromState: 'NOTICE_RECEIVED',
      toState: 'NOTICE_TIMELY', status: 'PENDING', riskBand: 'MEDIUM', confidence: 0.81,
      rationale: '通知时间落在约定窗口内，但时区元数据需要人工确认。',
      evidenceSummary: '主要证据已核验；存在一项低风险时区歧义。', gateStatus: 'PASS',
      gateReason: '硬性期限门通过；软性时区提示需人工复核',
      createdAt: '2026-09-04T01:32:00Z',
      policyChecks: [
        { label: '通知窗口有效', status: 'PASS' },
        { label: '时间戳签名完整', status: 'PASS' },
        { label: '时区元数据人工确认', status: 'WARN' },
      ],
    },
    {
      id: 'proposal-037', proposalNumber: 'PRP-2026-037-A', matterId: 'matter-037',
      modelId: 'model-active', title: '进入答辩准备状态', fromState: 'CLAIM_RECEIVED',
      toState: 'RESPONSE_READY', status: 'NEEDS_EVIDENCE', riskBand: 'CRITICAL', confidence: 0.74,
      rationale: '现有材料提示可准备答辩，但送达日决定期限计算。',
      evidenceSummary: '送达凭证缺失；不得计算最终答辩期限。', gateStatus: 'BLOCKED',
      gateReason: '缺少经核验的送达凭证', createdAt: '2026-09-04T01:40:00Z',
      policyChecks: [
        { label: '请求材料已登记', status: 'PASS' },
        { label: '送达凭证已核验', status: 'BLOCKED' },
        { label: '期限计算可重放', status: 'BLOCKED' },
      ],
    },
  ],
  tasks: [
    {
      id: 'task-037', taskNumber: 'TSK-2026-037-01', matterId: 'matter-037',
      proposalId: 'proposal-037', title: '补充送达凭证', status: 'OPEN', priority: 'CRITICAL',
      assignee: '调查组 A', instructions: '获取带签收时间的送达记录，并由第二人复核。',
      dueAt: '2026-09-05T08:00:00Z', createdAt: '2026-09-04T01:42:00Z', completedAt: null,
    },
  ],
  reviews: [],
  feedback: [],
  models: [],
  learning: {},
  audit: [],
};


const clone = value => structuredClone(value);
function fail(code, message, status = 409) { throw new DemoError(code, message, status); }
function text(value, label, min = 1) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > 10000) fail('INVALID_INPUT', label + '无效', 422);
  return value.trim();
}
const roles = {
  reviewProposal: ['case_reviewer'], requestEvidence: ['case_reviewer'],
  completeTask: ['investigator'], verifyTask: ['case_reviewer'],
  qualifyFeedback: ['data_reviewer'], withdrawFeedback: ['data_reviewer'],
  trainModel: ['trainer'], promoteModel: ['model_owner'], rollbackModel: ['model_owner'],
  ingestMatter: ['investigator'],
  acknowledgeEvent: ['event_worker'],
};
function authorize(principal, action) {
  if (!principal?.id) fail('UNAUTHENTICATED', '需要认证身份', 401);
  if (principal.tenantId !== WORKSPACE_KEY) fail('FORBIDDEN', '工作区不匹配', 403);
  if (!Array.isArray(principal.roles) || !principal.roles.some(role => roles[action]?.includes(role))) fail('FORBIDDEN', '没有此操作权限', 403);
}
function seed(clock) {
  const state = clone(initialState);
  state.revision = 0;
  state.sequence = 100;
  state.schemaVersion = 2;
  state.receipts = {};
  state.outbox = [];
  state.reviews = [];
  state.feedback = [];
  state.audit = [];
  state.learning = { baseline: { accepted: 0, corrected: 0, rejected: 0, gateBlocked: 0 }, newEligibleLabels: 0, lastTrainingCutoff: null, nextWindow: null, rounds: 0, mode: 'CPU_REFERENCE_LEARNER' };
  state.models = [buildModel(corpus, null, 0, clock().toISOString(), 'bootstrap')];
  state.meta.executionBackend = 'DURABLE_EXTENSION';
  state.meta.modelScope = 'SYNTHETIC_CPU_REFERENCE_NOT_RESEARCH_LWM';
  for (const proposal of state.proposals) {
    proposal.modelId = state.models[0].id;
    const prediction = predict(state.models[0].artifact, proposal.fromState);
    proposal.toState = prediction.label;
    proposal.confidence = prediction.confidence;
    proposal.rationale = '合成 CPU 参考模型推理；不是法律意见或研究 LWM 输出。';
  }
  return state;
}

export function createDemoEngine({ clock = () => new Date(), store = new MemoryStore() } = {}) {
  if (!store.load()) store.commit(seed(clock), undefined);
  const read = () => {
    const state = store.load();
    if (state?.schemaVersion !== 2) fail('MIGRATION_REQUIRED', '存储版本不匹配，禁止静默重置', 503);
    return state;
  };
  function snapshot() {
    const state = read();
    const pending = state.proposals.filter(p => ['PENDING', 'NEEDS_EVIDENCE'].includes(p.status));
    const activeModel = state.models.find(m => m.stage === 'ACTIVE') ?? null;
    const candidateModel = state.models.find(m => m.stage === 'CANDIDATE') ?? null;
    const feedbackTotals = {
      accepted: state.feedback.filter(f => f.outcome === 'ACCEPTED').length,
      corrected: state.feedback.filter(f => f.outcome === 'CORRECTED').length,
      rejected: state.feedback.filter(f => f.outcome === 'REJECTED').length,
      gateBlocked: state.learning.baseline.gateBlocked,
    };
    const totalReviewed = state.feedback.length;
    // Keep data snapshots and receipts server-side; hashes are visible in model cards.
    const visible = clone(state);
    delete visible.receipts;
    visible.models = visible.models.map(({ artifact, datasetSnapshot, ...model }) => model);
    const visibleModel = m => m ? visible.models.find(v => v.id === m.id) : null;
    return { ...visible, computed: {
      pendingCount: pending.length, highRiskCount: pending.filter(p => ['HIGH', 'CRITICAL'].includes(p.riskBand)).length,
      blockedCount: pending.filter(p => p.gateStatus === 'BLOCKED').length,
      openTaskCount: state.tasks.filter(t => !['COMPLETED', 'CANCELLED'].includes(t.status)).length,
      activeModel: visibleModel(activeModel), candidateModel: visibleModel(candidateModel),
      promotionGates: candidateModel ? promotionGates(candidateModel) : [],
      promotionReady: !!candidateModel && promotionGates(candidateModel).every(g => g.pass),
      feedbackTotals, totalReviewed, acceptanceRate: totalReviewed ? feedbackTotals.accepted / totalReviewed : 0,
    } };
  }
  function infer(feature) {
    const model = read().models.find(m => m.stage === 'ACTIVE');
    if (model?.dataRevoked || !validateArtifact(model)) fail('ARTIFACT_INVALID', '活动制品校验失败', 503);
    return { ...predict(model.artifact, feature), modelVersion: model.versionLabel, artifactHash: model.artifactHash };
  }
  function execute(action, input = {}, context = {}) {
    authorize(context.principal, action);
    if (!Number.isSafeInteger(context.expectedRevision)) fail('PRECONDITION_REQUIRED', '必须提供快照版本', 428);
    const key = text(context.idempotencyKey, '幂等键', 8);
    const actor = context.principal.id;
    let state = read();
    const fingerprint = hash({ action, input, actor, tenant: context.principal.tenantId });
    const receiptKey = hash({ actor, key });
    const previous = state.receipts[receiptKey];
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', '同一幂等键不能对应不同操作');
      return snapshot();
    }
    if (state.revision !== context.expectedRevision) fail('CONFLICT', '快照已过期，请刷新');
    const at = clock().toISOString();
    const find = (list, id) => list.find(v => v.id === id) ?? fail('NOT_FOUND', '对象不存在', 404);
    const nextId = prefix => prefix + '-' + (++state.sequence);
    const audit = (event, target) => {
      const entry = { id: nextId('audit'), at, actor, action: event, target, result: 'SUCCESS', previousHash: state.audit[0]?.hash ?? null };
      entry.hash = hash(entry);
      state.audit.unshift(entry);
      state.outbox.push({ id: entry.id, event: clone(entry), status: 'PENDING' });
    };
    const linked = proposal => {
      const matter = find(state.matters, proposal.matterId);
      if (matter.proposalId !== proposal.id) fail('LINK_MISMATCH', '建议与事项关联不匹配');
      find(state.models, proposal.modelId);
      return matter;
    };
    const open = proposal => {
      if (!['PENDING', 'NEEDS_EVIDENCE'].includes(proposal.status)) fail('ALREADY_REVIEWED', '建议已经终结');
    };
    const gate = (proposal, matter) => {
      const model = find(state.models, proposal.modelId);
      if (model.dataRevoked || !validateArtifact(model)) fail('ARTIFACT_INVALID', '建议来源模型制品或数据不可用');
      if (matter.currentState !== proposal.fromState) fail('STALE_PROPOSAL', '事项状态已变化');
      if (proposal.gateStatus !== 'PASS' || proposal.policyChecks.some(c => c.status === 'BLOCKED')) fail('GATE_BLOCKED', '必要证据或规则未通过');
      if (state.tasks.some(t => t.proposalId === proposal.id && t.status !== 'COMPLETED' && t.status !== 'CANCELLED')) fail('GATE_BLOCKED', '调查尚未独立复核');
    };
    if (action === 'reviewProposal') {
      const proposal = find(state.proposals, input.proposalId), matter = linked(proposal);
      open(proposal);
      const note = text(input.note, '复核依据', 4);
      if (!['APPROVE', 'MODIFY', 'REJECT'].includes(input.decision)) fail('INVALID_DECISION', '不支持的裁定', 422);
      let target = null;
      if (input.decision !== 'REJECT') {
        gate(proposal, matter);
        target = input.decision === 'MODIFY' ? text(input.targetState, '目标状态', 3) : proposal.toState;
        if (!TRANSITIONS[proposal.fromState]?.includes(target)) fail('INVALID_TRANSITION', '不允许的状态迁移', 422);
        matter.currentState = target;
        matter.status = 'DECIDED';
      }
      proposal.status = { APPROVE: 'APPROVED', MODIFY: 'MODIFIED', REJECT: 'REJECTED' }[input.decision];
      if (input.decision === 'REJECT') {
        matter.status = 'IN_REVIEW';
        state.tasks.filter(t => t.proposalId === proposal.id && t.status !== 'COMPLETED').forEach(t => { t.status = 'CANCELLED'; });
      }
      const review = { id: nextId('review'), proposalId: proposal.id, reviewer: actor, decision: input.decision, previousState: proposal.fromState, appliedState: target, note, reviewedAt: at };
      state.reviews.unshift(review);
      state.feedback.unshift({ id: nextId('feedback'), proposalId: proposal.id, caseId: matter.id, reviewId: review.id,
        outcome: { APPROVE: 'ACCEPTED', MODIFY: 'CORRECTED', REJECT: 'REJECTED' }[input.decision],
        label: target, feature: proposal.fromState, reason: note, eligibility: 'PENDING', reviewer: actor,
        modelVersion: find(state.models, proposal.modelId).versionLabel, createdAt: at });
      audit('PROPOSAL_' + proposal.status, proposal.id);
    } else if (action === 'requestEvidence') {
      const proposal = find(state.proposals, input.proposalId), matter = linked(proposal);
      open(proposal);
      if (proposal.status !== 'PENDING' || state.tasks.some(t => t.proposalId === proposal.id && !['COMPLETED', 'CANCELLED'].includes(t.status))) fail('TASK_EXISTS', '建议已有调查任务');
      const task = { id: nextId('task'), proposalId: proposal.id, matterId: matter.id, title: text(input.title, '标题', 3),
        instructions: text(input.instructions, '调查要求', 4), assignee: text(input.assignee, '调查人'), dueAt: input.dueAt ?? at,
        status: 'OPEN', priority: proposal.riskBand, createdAt: at };
      if (!Number.isFinite(Date.parse(task.dueAt))) fail('INVALID_INPUT', '截止时间无效', 422);
      task.taskNumber = task.id;
      state.tasks.push(task); matter.taskIds.push(task.id);
      proposal.status = matter.status = 'NEEDS_EVIDENCE'; proposal.gateStatus = 'BLOCKED';
      proposal.gateReason = '调查任务尚未完成独立复核';
      audit('EVIDENCE_TASK_CREATED', task.id);
    } else if (action === 'completeTask' || action === 'verifyTask') {
      const task = find(state.tasks, input.taskId), proposal = find(state.proposals, task.proposalId), matter = linked(proposal);
      open(proposal);
      if (task.matterId !== matter.id || !matter.taskIds.includes(task.id) || proposal.status !== 'NEEDS_EVIDENCE') fail('LINK_MISMATCH', '调查关联或状态不匹配');
      if (action === 'completeTask') {
        if (!['OPEN', 'IN_PROGRESS'].includes(task.status)) fail('INVALID_STATE', '任务不可提交');
        const result = text(input.result, '补证结果', 4), source = text(input.source, '证据来源', 4);
        const evidenceDigest = text(input.evidenceDigest, '证据 SHA-256', 64);
        if (!/^[a-f0-9]{64}$/.test(evidenceDigest)) fail('INVALID_INPUT', '证据摘要格式无效', 422);
        task.submission = { result, source, evidenceDigest, submittedBy: actor, submittedAt: at };
        task.status = 'AWAITING_REVIEW';
        audit('EVIDENCE_SUBMITTED', task.id);
      } else {
        if (task.status !== 'AWAITING_REVIEW' || task.submission.submittedBy === actor) fail('SEPARATION_OF_DUTIES', '需要另一名复核员核验');
        text(input.note, '核验依据', 4);
        if (input.evidenceDigest !== task.submission.evidenceDigest || input.confirmed !== true) fail('EVIDENCE_MISMATCH', '核验摘要不匹配或未确认');
        const observation = { id: nextId('obs'), title: '补充证据已独立核验', kind: 'DOCUMENT', source: task.submission.source, confidence: 1,
          verified: true, summary: task.submission.result, evidenceDigest: task.submission.evidenceDigest,
          submittedBy: task.submission.submittedBy, verifiedBy: actor, verificationNote: input.note, observedAt: at };
        state.observations.push(observation); matter.observationIds.push(observation.id);
        task.status = 'COMPLETED'; task.completedAt = at; task.verifiedBy = actor;
        // Synthetic policy v2: verified independent evidence, no pending tasks and unchanged source state.
        const allComplete = state.tasks.filter(t => t.proposalId === proposal.id).every(t => t.status === 'COMPLETED');
        const evidenceValid = observation.verified && observation.submittedBy !== observation.verifiedBy;
        const stateValid = matter.currentState === proposal.fromState;
        proposal.policyChecks = [
          { label: '证据来源与摘要经过独立人工核验', status: evidenceValid ? 'PASS' : 'BLOCKED' },
          { label: '所有调查已完成', status: allComplete ? 'PASS' : 'BLOCKED' },
          { label: '当前状态未漂移', status: stateValid ? 'PASS' : 'BLOCKED' },
        ];
        proposal.gateStatus = proposal.policyChecks.every(c => c.status === 'PASS') ? 'PASS' : 'BLOCKED';
        proposal.gateReason = 'synthetic-v2：基于独立核验证据、任务状态和当前事项重算';
        proposal.evidenceSummary = matter.observationIds.length + ' 条观察记录；新增证据已独立核验';
        if (proposal.gateStatus === 'PASS') { proposal.status = 'PENDING'; matter.status = 'IN_REVIEW'; }
        audit('EVIDENCE_VERIFIED', task.id);
      }
    } else if (action === 'qualifyFeedback') {
      const feedback = find(state.feedback, input.feedbackId);
      if (feedback.eligibility !== 'PENDING' || feedback.reviewer === actor) fail('SEPARATION_OF_DUTIES', '需要独立的数据核验人');
      const review = find(state.reviews, feedback.reviewId);
      const proposal = find(state.proposals, feedback.proposalId);
      const label = text(input.label, '独立结果标签', 3);
      if (review.proposalId !== proposal.id || !TRANSITIONS[feedback.feature]?.includes(label)) fail('INVALID_LABEL', '标签或关联不合法', 422);
      if (input.privacyApproved !== true || input.outcomeVerified !== true) fail('INELIGIBLE', '必须确认数据资格和业务结果', 422);
      const evidence = text(input.outcomeEvidence, '结果证据', 4);
      if (state.feedback.some(f => f.id !== feedback.id && f.caseId === feedback.caseId && f.eligibility === 'ELIGIBLE')) fail('DUPLICATE_LABEL', '同一事项已有有效标签');
      Object.assign(feedback, { label, eligibility: 'ELIGIBLE', qualifiedBy: actor, qualifiedAt: at, outcomeEvidence: evidence });
      audit('FEEDBACK_QUALIFIED', feedback.id);
    } else if (action === 'withdrawFeedback') {
      const feedback = find(state.feedback, input.feedbackId);
      text(input.reason, '撤回原因', 4);
      feedback.eligibility = 'WITHDRAWN'; feedback.withdrawnBy = actor;
      // Tainted artifacts cannot be published; an active artifact is suspended fail-closed.
      for (const model of state.models) if (model.datasetSnapshot.rows.some(r => r.id === feedback.id)) model.dataRevoked = true;
      audit('FEEDBACK_WITHDRAWN', feedback.id);
    } else if (action === 'trainModel') {
      if (state.models.some(m => m.stage === 'CANDIDATE')) fail('CANDIDATE_EXISTS', '请先发布或处理已有候选');
      const eligible = state.feedback.filter(f => f.eligibility === 'ELIGIBLE');
      if (!eligible.some(f => !f.consumedAt)) fail('NO_NEW_LABELS', '没有新的合格反馈');
      const active = state.models.find(m => m.stage === 'ACTIVE');
      const rows = [...corpus, ...eligible.map(f => ({ id: f.id, caseId: f.caseId, feature: f.feature, label: f.label, source: f.outcomeEvidence }))];
      const model = buildModel(rows, active, ++state.learning.rounds, at, actor);
      if (!promotionGates(model).every(g => g.pass)) model.stage = 'HELD';
      state.models.push(model);
      eligible.forEach(f => { f.consumedAt = at; });
      state.learning.lastTrainingCutoff = at;
      audit(model.stage === 'HELD' ? 'MODEL_EVALUATION_REJECTED' : 'MODEL_TRAINED', model.id);
    } else if (action === 'promoteModel') {
      const candidate = state.models.find(m => m.stage === 'CANDIDATE');
      const active = state.models.find(m => m.stage === 'ACTIVE');
      if (input.confirmed !== true) fail('CONFIRMATION_REQUIRED', '需要明确批准', 422);
      if (!candidate || !active) fail('MODEL_STATE_INVALID', '没有候选或活动版本');
      if (candidate.trainedBy === actor) fail('SEPARATION_OF_DUTIES', '训练人与发布人必须不同');
      if (candidate.dataRevoked || !promotionGates(candidate).every(g => g.pass) || !validateArtifact(active) || active.dataRevoked) fail('PROMOTION_BLOCKED', '制品或门禁未通过');
      // Inference reads this same atomic state; no independent process-local model cache.
      active.stage = 'STANDBY'; candidate.stage = 'ACTIVE'; candidate.rollbackTarget = active.id; candidate.approvedBy = actor;
      candidate.approvedAt = at;
      audit('MODEL_PROMOTED', candidate.id);
    } else if (action === 'rollbackModel') {
      const active = state.models.find(m => m.stage === 'ACTIVE');
      const target = state.models.find(m => m.id === active?.rollbackTarget);
      text(input.reason, '回滚原因', 6);
      if (input.confirmed !== true || !target || target.stage !== 'STANDBY' || target.dataRevoked || !validateArtifact(target)) fail('ROLLBACK_UNAVAILABLE', '没有可恢复的已验证目标');
      active.stage = 'HELD'; target.stage = 'ACTIVE';
      audit('MODEL_ROLLED_BACK', target.id);
    } else if (action === 'acknowledgeEvent') {
      const event = find(state.outbox, input.eventId);
      if (event.event.hash !== input.eventHash) fail('EVENT_MISMATCH', '归档事件摘要不一致');
      event.status = 'DELIVERED'; event.deliveredAt = at;
    } else if (action === 'ingestMatter') {
      const feature = text(input.fromState, '来源状态');
      if (!Object.hasOwn(TRANSITIONS, feature)) fail('INVALID_INPUT', '不支持的领域状态', 422);
      const id = text(input.caseId, '事项唯一标识', 4);
      if (!/^[a-zA-Z0-9_-]+$/.test(id) || id.startsWith('bootstrap-') || id.startsWith('holdout-')) fail('INVALID_INPUT', '事项标识无效', 422);
      if (state.matters.some(m => m.id === id)) fail('DUPLICATE_CASE', '事项已存在');
      const title = text(input.title, '事项标题', 4);
      const model = state.models.find(m => m.stage === 'ACTIVE');
      if (model.dataRevoked || !validateArtifact(model)) fail('ARTIFACT_INVALID', '活动制品不可用', 503);
      const prediction = predict(model.artifact, feature);
      const proposalId = nextId('proposal'), taskId = nextId('task');
      state.matters.push({ id, matterNumber: id, title, jurisdiction: 'Synthetic', status: 'NEEDS_EVIDENCE', currentState: feature,
        owner: actor, riskBand: 'HIGH', summary: title, openedAt: at, dueAt: at, proposalId, observationIds: [], taskIds: [taskId] });
      state.proposals.push({ id: proposalId, proposalNumber: proposalId, matterId: id, modelId: model.id, title, fromState: feature, toState: prediction.label,
        confidence: prediction.confidence, status: 'NEEDS_EVIDENCE', riskBand: 'HIGH', rationale: 'CPU 参考模型实际推理',
        evidenceSummary: '待独立核验证据', gateStatus: 'BLOCKED', gateReason: '缺少核验证据', createdAt: at,
        policyChecks: [{ label: '证据已核验', status: 'BLOCKED' }] });
      state.tasks.push({ id: taskId, taskNumber: taskId, matterId: id, proposalId, title: '核验业务证据', instructions: '提交来源和摘要，由另一人核验',
        assignee: actor, status: 'OPEN', priority: 'HIGH', dueAt: at, createdAt: at });
      audit('MATTER_INGESTED', id);
    } else fail('UNKNOWN_ACTION', '不支持的操作', 404);
    state.learning.newEligibleLabels = state.feedback.filter(f => f.eligibility === 'ELIGIBLE' && !f.consumedAt).length;
    state.revision += 1;
    state.receipts[receiptKey] = { fingerprint, revision: state.revision, at };
    store.commit(state, context.expectedRevision);
    return snapshot();
  }
  return { snapshot, execute, infer, exportState: read, close: () => store.close() };
}
