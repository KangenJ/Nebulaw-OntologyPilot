import {candidateFactory,chooseByValidation} from './source-aware-candidate.mjs';
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=resolve(process.argv[2]),out=resolve(process.argv[3]);
const seeds=10,budgets=[2,4,8,12],oldCount=8,validationCount=20,testCount=100,retentionCount=50;
const stable=[[.85,.1,.05],[.05,.85,.1],[.1,.05,.85]],mobile=[[.15,.7,.15],[.15,.15,.7],[.7,.15,.15]];
const reliable=q=>[0,1,2].map(y=>[0,1,2].map(x=>x===y?q:(1-q)/2));
const oldE=[reliable(.9),reliable(.65)],newE=[[[.15,.75,.1],[.1,.15,.75],[.75,.1,.15]],reliable(.9)];
const regimes=[{name:'no_shift',T:stable,E:oldE},{name:'source_shift',T:stable,E:newE},{name:'transition_shift',T:mobile,E:oldE},{name:'combined_shift',T:mobile,E:newE}];
const plan={schema:'source-aware-validation-plan-v1',seeds,budgets,oldCount,validationCount,testCount,retentionCount,regimes,oldT:stable,oldE,
  selection:{criterion:'Full coverage, lowest current validation NLL among frozen/cumulative/recent',minimumImprovement:.02,retentionWarningMargin:.10,retentionWarning:'Warning only, no automatic publish or deletion',tieBreak:'Lexicographic key'},
  labelBudget:'Each trajectory has 6 GOLD labels; 20 current plus 20 historical validation trajectories cost 240 additional labels per seed, fixed across budgets, not training data',
  precommitted:'Fresh random streams offset 9000000, no reuse of prior test entities; same known synthetic task family; no tuning during this run',
  models:['pooled_cumulative','source_cumulative','source_recent','source_validation_selected','matched_standard_forward_audit'],
  limits:['SYNTHETIC ONLY; no native approval, model publication or Palantir','Two explicitly compiled observation variables; source fits use existing one-report fixture projected per source/time, not a native longitudinal sampling approval','All sources conditionally independent given state; no learned source correlation','Uniform initial prior, shared point transition, no latent mechanism discovery','Change boundary given to all; no autonomous drift detection','Validation candidate selection is an offline experiment, not server-side authorization','Matched statistical model uses identical priors, supports and smoothing; equivalence is expected, not superiority','Current and historical tests never used in selection; validation metadata is separately included in label costs','Time only measured as experiment wall clock, not industrial speed or labor cost']};
writeFileSync(join(out,'plan.json'),JSON.stringify(plan,null,2),{flag:'wx'});
const {fit}=await candidateFactory(root);
const rng=seed=>()=>{seed=(seed+0x6D2B79F5)|0;let t=Math.imul(seed^seed>>>15,1|seed);t^=t+Math.imul(t^t>>>7,61|t);return ((t^t>>>14)>>>0)/4294967296;};
const draw=(p,r)=>{let u=r();for(let i=0;i<p.length;i++){u-=p[i];if(u<0)return i;}return p.length-1;};
const gen=(count,seed,T,E,prefix)=>{const r=rng(seed);return Array.from({length:count},(_,i)=>{let y=draw([1/3,1/3,1/3],r);const frames=[];for(let t=0;t<6;t++){if(t)y=draw(T[y],r);frames.push({y,reports:E.map(e=>draw(e[y],r))});}return {id:prefix+'-'+i,frames};});};
const norm=p=>{const s=p.reduce((a,b)=>a+b,0);assert.ok(s>0);return p.map(x=>x/s);};
function standard(rows,separate){const T=Array.from({length:3},()=>[0,0,0]),E=Array.from({length:separate?2:1},()=>Array.from({length:3},()=>[0,0,0]));for(const row of rows)row.frames.forEach((f,i)=>{if(i)T[row.frames[i-1].y][f.y]++;f.reports.forEach((x,s)=>E[separate?s:0][f.y][x]++);});const e=E.map(c=>c.map(v=>v.map(n=>(n+1)/(v.reduce((a,b)=>a+b,0)+5))));return {T:T.map(v=>v.reduce((a,b)=>a+b,0)?norm(v.map(n=>n+1)):null),E:separate?e:[e[0],e[0]]};}
function forward(row,{T,E}){let p=[1/3,1/3,1/3];for(let t=0;t<6;t++){if(t){if(T.some((r,i)=>r===null&&p[i]>0))return null;p=[0,1,2].map(j=>p.reduce((s,v,i)=>s+v*T[i][j],0));}for(let s=0;s<2;s++)p=norm(p.map((v,y)=>v*E[s][y][row.frames[t].reports[s]]));}return p;}
let maxKernelError=0,maxPredictionError=0;const metadata=[];
function make(rows,key,separate=true){const candidate=fit(rows,key,{separate}),reference=standard(rows,separate),cache=new Map();for(const k of ['T','E']){const flat=v=>Array.isArray(v)?v.flatMap(flat):[v],a=flat(candidate[k]),b=flat(reference[k]);assert.equal(a.length,b.length);for(let i=0;i<a.length;i++)if(a[i]===null||b[i]===null)assert.equal(a[i],b[i]);else maxKernelError=Math.max(maxKernelError,Math.abs(a[i]-b[i]));}
  metadata.push({key,separate,trainingIds:rows.map(r=>r.id),fitMs:candidate.fitMs,compiledHash:candidate.compiledHash,artifactHashes:candidate.artifacts});
  return {key,predict(row){if(cache.has(row.id))return cache.get(row.id);const p=candidate.predict(row),q=forward(row,reference);if(p===null||q===null)assert.equal(p,q);else maxPredictionError=Math.max(maxPredictionError,...p.map((v,i)=>Math.abs(v-q[i])));cache.set(row.id,p);return p;}};
}
const predictions=[],scores=[],selections=[],datasets=[];
function score(rows,model,ctx){let count=0,correct=0,nll=0,brier=0;for(const row of rows){const p=model.predict(row),y=row.frames.at(-1).y;predictions.push({...ctx,id:row.id,y,p,artifactKey:model.key});if(!p)continue;count++;assert.ok(p.every(v=>v>0&&Number.isFinite(v)));assert.ok(Math.abs(p.reduce((a,b)=>a+b,0)-1)<1e-10);correct+=p.indexOf(Math.max(...p))===y;nll-=Math.log(p[y]);brier+=p.reduce((s,v,i)=>s+(v-(y===i?1:0))**2,0);}const result={...ctx,artifactKey:model.key,coverage:count/rows.length,accuracy:count?correct/count:null,nll:count?nll/count:null,brier:count?brier/count:null};scores.push(result);return result;}
for(const [ri,regime]of regimes.entries())for(let seed=1;seed<=seeds;seed++){
  const prefix=regime.name+'-'+seed,base=9000000+ri*10000+seed;
  const old=gen(oldCount,base,stable,oldE,prefix+'-old'),fresh=gen(12,base+100000,regime.T,regime.E,prefix+'-fresh'),validation=gen(validationCount,base+200000,regime.T,regime.E,prefix+'-validation'),retentionValidation=gen(validationCount,base+300000,stable,oldE,prefix+'-retention-validation');
  const frozen=make(old,prefix+'-frozen'),decisions=[];
  // Choose every budget before generating/reading the final test trajectories.
  for(const budget of budgets){const cumulative=make(old.concat(fresh.slice(0,budget)),prefix+'-cumulative-'+budget),recent=make(fresh.slice(0,budget),prefix+'-recent-'+budget),pooled=make(old.concat(fresh.slice(0,budget)),prefix+'-pooled-'+budget,false),models={frozen,cumulative,recent};
    const validationScores=Object.entries(models).map(([key,model])=>({...score(validation,model,{regime:regime.name,seed,budget,split:'validation',model:key}),key}));
    const choice=chooseByValidation(validationScores),selected=choice.key?models[choice.key]:null;
    const frozenOld=score(retentionValidation,frozen,{regime:regime.name,seed,budget,split:'retention_validation',model:'frozen'}),candidateOld=selected?score(retentionValidation,selected,{regime:regime.name,seed,budget,split:'retention_validation',model:'selected'}):null;
    const retentionWarning=candidateOld===null||candidateOld.coverage!==1||frozenOld.coverage!==1||candidateOld.nll>frozenOld.nll+.1;
    const decision={regime:regime.name,seed,budget,...choice,selectedArtifactKey:selected?.key??null,validationScores,retentionWarning,deploymentAuthorized:false,retentionNllDelta:candidateOld?.nll!=null&&frozenOld.nll!=null?candidateOld.nll-frozenOld.nll:null};selections.push(decision);decisions.push({budget,cumulative,recent,pooled,selected});
  }
  const test=gen(testCount,base+400000,regime.T,regime.E,prefix+'-test'),retentionTest=gen(retentionCount,base+500000,stable,oldE,prefix+'-retention-test');
  const parts={old,fresh,validation,retentionValidation,test,retentionTest};assert.equal(new Set(Object.values(parts).flat().map(r=>r.id)).size,Object.values(parts).flat().length);datasets.push({regime:regime.name,seed,...parts});
  for(const {budget,cumulative,recent,pooled,selected}of decisions)for(const [split,rows]of [['test',test],['retention_test',retentionTest]])for(const [model,candidate]of Object.entries({pooled_cumulative:pooled,source_cumulative:cumulative,source_recent:recent,source_validation_selected:selected??{key:'UNAVAILABLE',predict:()=>null}}))score(rows,candidate,{regime:regime.name,seed,budget,split,model});
  console.log(JSON.stringify({regime:regime.name,seed,maxKernelError,maxPredictionError}));
}
assert.ok(maxKernelError<1e-12&&maxPredictionError<1e-10);
const mean=a=>a.reduce((s,v)=>s+v,0)/a.length,summary=[];
for(const regime of regimes)for(const budget of budgets)for(const split of ['test','retention_test'])for(const model of ['pooled_cumulative','source_cumulative','source_recent','source_validation_selected']){const rows=scores.filter(r=>r.regime===regime.name&&r.budget===budget&&r.split===split&&r.model===model),complete=rows.every(r=>r.coverage===1);summary.push({regime:regime.name,budget,split,model,coverage:mean(rows.map(r=>r.coverage)),nll:complete?mean(rows.map(r=>r.nll)):null,accuracy:complete?mean(rows.map(r=>r.accuracy)):null});}
const paired=[];for(const regime of regimes)for(const budget of budgets){const ds=[];for(let seed=1;seed<=seeds;seed++){const a=scores.find(r=>r.regime===regime.name&&r.budget===budget&&r.split==='test'&&r.seed===seed&&r.model==='source_validation_selected'),b=scores.find(r=>r.regime===regime.name&&r.budget===budget&&r.split==='test'&&r.seed===seed&&r.model==='pooled_cumulative');if(a.coverage===1&&b.coverage===1)ds.push(a.nll-b.nll);}if(ds.length===seeds){const delta=mean(ds),sd=Math.sqrt(ds.reduce((s,d)=>s+(d-delta)**2,0)/(seeds-1));paired.push({regime:regime.name,budget,selectedMinusPooledNll:delta,approx95SeedInterval:[delta-2.262*sd/Math.sqrt(seeds),delta+2.262*sd/Math.sqrt(seeds)]});}}
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
writeFileSync(join(out,'data.json'),JSON.stringify(datasets),{flag:'wx'});writeFileSync(join(out,'predictions.json'),JSON.stringify(predictions),{flag:'wx'});
const results={schema:'source-aware-candidate-result-v1',createdAt:new Date().toISOString(),sourceRoot:root,node:process.version,maxKernelError,maxPredictionError,hashes:Object.fromEntries(['plan.json','data.json','predictions.json'].map(p=>[p,sha(join(out,p))])),scriptHash:sha(new URL(import.meta.url)),candidateHash:sha(new URL('./source-aware-candidate.mjs',import.meta.url)),sourceHashes:Object.fromEntries(['observation-fit.mjs','transition-fit.mjs','finite-engine.mjs','observation-fit-fixture.mjs','transition-fit-fixture.mjs'].map(p=>[p,sha(join(root,'services/plus-engine',p))])),summary,paired,scores,selections,metadata};
writeFileSync(join(out,'results.json'),JSON.stringify(results,null,2),{flag:'wx'});
console.log(JSON.stringify({complete:true,out,summary:summary.filter(r=>r.budget===12),selected:selections.reduce((a,s)=>(a[s.key??'NONE']=(a[s.key??'NONE']??0)+1,a),{}),retentionWarnings:selections.filter(s=>s.retentionWarning).length}));
