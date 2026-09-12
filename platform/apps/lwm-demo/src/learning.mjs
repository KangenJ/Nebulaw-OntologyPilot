import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const TRANSITIONS = Object.freeze({
  EVIDENCE_COMPLETE: ['RETENTION_REQUIRED', 'MANUAL_REVIEW'],
  NOTICE_RECEIVED: ['NOTICE_TIMELY', 'NOTICE_REQUIRES_CLARIFICATION'],
  CLAIM_RECEIVED: ['RESPONSE_READY', 'MANUAL_REVIEW'],
});
export const POLICY = Object.freeze({ version: 'synthetic-v2', minLabels: 80, minAccuracy: 0.85, maxCalibration: 0.12, maxDrift: 0.08 });
export const codeHash = hash(readFileSync(new URL(import.meta.url)));

// Deliberately small CPU reference learner, NOT the research LWM/LLM.
// Corpus and held-out examples have separate case identities. Labels are synthetic.
const domains = Object.entries(TRANSITIONS);
export const corpus = domains.flatMap(([feature, targets], d) => Array.from({ length: 30 }, (_, i) => ({
  id: `bootstrap-${d}-${i}`, caseId: `bootstrap-case-${d}-${i}`, feature, label: targets[0], source: 'synthetic-bootstrap-v1',
})));
export const holdout = domains.flatMap(([feature, targets], d) => Array.from({ length: 12 }, (_, i) => ({
  id: `holdout-${d}-${i}`, caseId: `holdout-case-${d}-${i}`, feature, label: targets[0], source: 'frozen-synthetic-holdout-v1',
})));
export const holdoutHash = hash(holdout);

export function train(rows) {
  const counts = Object.fromEntries(domains.map(([feature, targets]) => [feature, Object.fromEntries(targets.map(label => [label, 1]))]));
  for (const row of rows) {
    if (!counts[row.feature] || !(row.label in counts[row.feature])) throw new Error('Invalid training label');
    counts[row.feature][row.label] += 1;
  }
  return { algorithm: 'categorical-counts-laplace-v1', counts };
}
export function predict(artifact, feature) {
  const entries = Object.entries(artifact.counts[feature] ?? {});
  if (!entries.length) throw new Error('Unsupported feature');
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { label: entries[0][0], confidence: entries[0][1] / entries.reduce((sum, [, n]) => sum + n, 0) };
}
export function evaluate(artifact, activeArtifact) {
  const rows = holdout.map(row => ({ ...row, prediction: predict(artifact, row.feature) }));
  const accuracy = rows.filter(row => row.prediction.label === row.label).length / rows.length;
  const calibrationError = rows.reduce((sum, row) => sum + Math.abs(Number(row.prediction.label === row.label) - row.prediction.confidence), 0) / rows.length;
  const groups = Object.fromEntries(domains.map(([feature]) => [feature, rows.filter(r => r.feature === feature && r.prediction.label === r.label).length / rows.filter(r => r.feature === feature).length]));
  const baseline = activeArtifact ? evaluate(activeArtifact).accuracy : accuracy;
  return { accuracy, calibrationError, groups, sampleCount: rows.length, regressionPass: accuracy >= baseline && Object.values(groups).every(score => score >= POLICY.minAccuracy) };
}
export function buildModel(rows, active, number, at, actor) {
  if (new Set(rows.map(row => row.caseId)).size !== rows.length) throw new Error('Duplicate training case');
  if (rows.some(row => holdout.some(test => test.caseId === row.caseId))) throw new Error('Holdout leakage');
  const artifact = train(rows);
  const metrics = evaluate(artifact, active?.artifact);
  const distribution = Object.fromEntries(domains.map(([feature]) => [feature, rows.filter(row => row.feature === feature).length / rows.length]));
  const drift = active ? Math.max(...domains.map(([feature]) => Math.abs(distribution[feature] - active.distribution[feature]))) : 0;
  const datasetSnapshot = { rows: structuredClone(rows), hash: hash(rows), createdAt: at };
  const evaluation = { ...metrics, holdoutHash, artifactHash: hash(artifact), policy: POLICY, codeHash };
  return {
    id: `model-${number}`, versionLabel: `reference-${number}`, stage: active ? 'CANDIDATE' : 'ACTIVE',
    artifact, artifactHash: hash(artifact), datasetSnapshotId: datasetSnapshot.hash, datasetSnapshot,
    evaluationRunId: hash(evaluation), evaluation, trainingRunId: hash({ dataset: datasetSnapshot.hash, codeHash, number }),
    trainedBy: actor, codeHash, seed: 0, algorithm: artifact.algorithm, distribution,
    trainingWindow: datasetSnapshot.hash.slice(0, 12), validationScore: metrics.accuracy,
    calibrationError: metrics.calibrationError, regressionPass: metrics.regressionPass,
    supportLabels: rows.length, drift, approvedBy: null, rollbackTarget: null, createdAt: at,
  };
}
export function validateArtifact(model) {
  if (!model?.artifact || !model.evaluation || !model.datasetSnapshot?.rows) return false;
  const actual = evaluate(model.artifact);
  return Boolean(hash(model.artifact) === model.artifactHash
    && hash(model.datasetSnapshot?.rows) === model.datasetSnapshotId
    && hash(model.evaluation) === model.evaluationRunId
    && model.evaluation.artifactHash === model.artifactHash && model.evaluation.holdoutHash === holdoutHash
    && model.codeHash === codeHash && model.supportLabels === model.datasetSnapshot.rows.length
    && model.validationScore === actual.accuracy && model.calibrationError === actual.calibrationError
    && hash(train(model.datasetSnapshot.rows)) === model.artifactHash
    && model.evaluation.accuracy === actual.accuracy && model.evaluation.calibrationError === actual.calibrationError);
}
export function promotionGates(model) {
  return [
    { key: 'data', label: '训练数据未撤回', pass: model.dataRevoked !== true, value: model.dataRevoked ? '已撤回' : '有效' },
    { key: 'lineage', label: '制品、数据和评测血缘完整', pass: validateArtifact(model), value: model.artifactHash ?? '缺失' },
    { key: 'labels', label: `训练样本 ≥ ${POLICY.minLabels}`, pass: model.supportLabels >= POLICY.minLabels, value: String(model.supportLabels) },
    { key: 'quality', label: `合成留出集得分 ≥ ${POLICY.minAccuracy}`, pass: model.validationScore >= POLICY.minAccuracy, value: String(model.validationScore) },
    { key: 'calibration', label: `校准误差 ≤ ${POLICY.maxCalibration}`, pass: model.calibrationError <= POLICY.maxCalibration, value: String(model.calibrationError) },
    { key: 'regression', label: '不低于活动基线且所有分组通过', pass: model.regressionPass === true, value: String(model.regressionPass) },
    { key: 'drift', label: `训练特征分布变化 ≤ ${POLICY.maxDrift}`, pass: model.drift <= POLICY.maxDrift, value: String(model.drift) },
  ];
}
