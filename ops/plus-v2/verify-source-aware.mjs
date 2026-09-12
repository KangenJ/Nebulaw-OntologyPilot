import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const dir=resolve(process.argv[2]),read=p=>JSON.parse(readFileSync(join(dir,p))),result=read('results.json'),data=read('data.json'),predictions=read('predictions.json');
for(const [p,h]of Object.entries(result.hashes))assert.equal(createHash('sha256').update(readFileSync(join(dir,p))).digest('hex'),h);
const groups=new Map(),groupKey=r=>JSON.stringify([r.regime,r.seed,r.budget,r.split,r.model]);
for(const p of predictions){const k=groupKey(p);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(p);}
for(const score of result.scores){const rows=groups.get(groupKey(score));assert.ok(rows);assert.equal(new Set(rows.map(p=>p.id)).size,rows.length);const valid=rows.filter(r=>r.p);assert.equal(score.coverage,valid.length/rows.length);if(!valid.length){assert.equal(score.nll,null);continue;}const nll=valid.reduce((s,r)=>s-Math.log(r.p[r.y]),0)/valid.length,accuracy=valid.filter(r=>r.p.indexOf(Math.max(...r.p))===r.y).length/valid.length;assert.ok(Math.abs(nll-score.nll)<1e-12);assert.equal(accuracy,score.accuracy);}
for(const set of data){const parts=['old','fresh','validation','retentionValidation','test','retentionTest'].map(k=>set[k]);assert.equal(new Set(parts.flat().map(r=>r.id)).size,parts.flat().length);const training=new Set([...set.old,...set.fresh].map(r=>r.id));for(const meta of result.metadata.filter(m=>m.key.startsWith(set.regime+'-'+set.seed+'-')))assert.ok(meta.trainingIds.every(id=>training.has(id)));}
for(const selection of result.selections){const scores=result.scores.filter(r=>r.regime===selection.regime&&r.seed===selection.seed&&r.budget===selection.budget&&r.split==='validation');const frozen=scores.find(s=>s.model==='frozen'),eligible=scores.filter(s=>s.coverage===1&&Number.isFinite(s.nll)).sort((a,b)=>a.nll-b.nll||a.model.localeCompare(b.model));const expected=!eligible.length?null:frozen.coverage===1&&eligible[0].nll>frozen.nll-.02?'frozen':eligible[0].model;assert.equal(selection.key,expected);assert.equal(selection.deploymentAuthorized,false);
  for(const row of predictions.filter(r=>r.regime===selection.regime&&r.seed===selection.seed&&r.budget===selection.budget&&r.model==='source_validation_selected'))assert.equal(row.artifactKey,selection.selectedArtifactKey??'UNAVAILABLE');}
const checked={status:'PASS',metricRows:result.scores.length,predictionRows:predictions.length,selectionDecisions:result.selections.length,trainTestPartitionChecks:data.length,decisionPolicyIndependentlyRecomputed:true};
writeFileSync(join(dir,'verification.json'),JSON.stringify(checked,null,2),{flag:'wx'});console.log(JSON.stringify(checked));
