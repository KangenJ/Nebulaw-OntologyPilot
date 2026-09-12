import { createHash } from 'node:crypto';
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clip = x => Math.max(1e-6, Math.min(1 - 1e-6, x));
const logit = p => Math.log(clip(p) / (1 - clip(p)));
export function calibrate(artifact, probability) { return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, artifact.a * logit(probability) + artifact.b)))); }
export const identityPolicy = { algorithm: 'logistic-calibration-SGD-v1', a: 1, b: 0 };
// Frozen synthetic calibration benchmark, not a claim of field effectiveness.
// Distinct IDs; never added to training. Both outcomes occur at each p band.
export const benchmark = [0.1,0.3,0.5,0.7,0.9].flatMap((p, band) => Array.from({length:20}, (_,i) => ({id:'eval-'+band+'-'+i,p,y:i < Math.round(p*20) ? 1 : 0})));
export function metrics(artifact, rows = benchmark) {
  const values = rows.map(row => ({...row,q:clip(calibrate(artifact,row.p))}));
  return { count: values.length, brier: values.reduce((s,r)=>s+(r.q-r.y)**2,0)/values.length,
    nll: values.reduce((s,r)=>s-r.y*Math.log(r.q)-(1-r.y)*Math.log(1-r.q),0)/values.length };
}
export function trainPolicy(rows, active = identityPolicy) {
  if (rows.length < 2 || new Set(rows.map(r=>r.caseId)).size !== rows.length || rows.some(r=>!(r.p>0&&r.p<1)||![0,1].includes(r.y))) throw new Error('At least two unique, verified cases required');
  const artifact = {...active};
  // Regularized calibration: feedback updates real a/b parameters, not the
  // frozen neural weights. Evaluation may reject this update.
  for (let epoch=0;epoch<120;epoch++) {
    let da=0,db=0;
    for (const r of rows) { const delta=calibrate(artifact,r.p)-r.y; da+=delta*logit(r.p); db+=delta; }
    artifact.a -= 0.02 * (da/rows.length + 0.1*(artifact.a-1));
    artifact.b -= 0.02 * (db/rows.length + 0.1*artifact.b);
  }
  const evaluation=metrics(artifact), baseline=metrics(active);
  return {artifact, evaluation:{...evaluation, baseline, benchmarkHash:digest(benchmark), datasetHash:digest(rows),
    // Small explicit demo tolerance, not a promise of improvement each round.
    passed:evaluation.brier<=baseline.brier+0.002 && evaluation.nll<=baseline.nll+0.005,
    tolerance:{brier:0.002,nll:0.005}, benchmarkKind:'frozen-synthetic-calibration', artifactHash:digest(artifact)}};
}
