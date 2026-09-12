// Offline synthetic benchmark. No native admissions, credentials or API writes.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=resolve(process.argv[2]),out=resolve(process.argv[3]);
const mod=p=>import(pathToFileURL(join(root,p)).href);
const {fitObservationModel}=await mod('services/plus-engine/observation-fit.mjs');
const {fittingContract,fittingConfig,syntheticMaterialForUnitTest}=await mod('services/plus-engine/observation-fit-fixture.mjs');
const {compiled,baseline}=fittingContract();
const names=['READY','BUSY','OFFLINE'];
const sizes=[20,50,100,300],seeds=20,testSize=2000;
const rng=seed=>()=>{seed=(seed+0x6D2B79F5)|0;let t=Math.imul(seed^seed>>>15,1|seed);t^=t+Math.imul(t^t>>>7,61|t);return ((t^t>>>14)>>>0)/4294967296;};
const draw=(ps,r)=>{let u=r();for(let i=0;i<ps.length;i++){u-=ps[i];if(u<0)return i;}return ps.length-1;};
const reliable=[[.8,.1,.1],[.1,.8,.1],[.1,.1,.8]],shifted=[[.2,.7,.1],[.7,.2,.1],[.1,.6,.3]];
const regimes=[{name:'balanced',prior:[1/3,1/3,1/3],testChannel:reliable},{name:'imbalanced',prior:[.8,.15,.05],testChannel:reliable},{name:'report_quality_shift',prior:[1/3,1/3,1/3],testChannel:shifted}];
const make=(n,seed,prior,channel,prefix)=>{const r=rng(seed);return Array.from({length:n},(_,i)=>{const y=draw(prior,r),x=draw(channel[y],r);return {id:prefix+'-'+i,y,x};});};
const normalize=p=>{const s=p.reduce((a,b)=>a+b,0);return p.map(x=>x/s);};
const metrics=(data,predict)=>{let nll=0,correct=0,brier=0;for(const r of data){const p=predict(r.x);assert.ok(p.every(v=>Number.isFinite(v)&&v>0));assert.ok(Math.abs(p.reduce((a,b)=>a+b,0)-1)<1e-10);nll-=Math.log(p[r.y]);correct+=p.indexOf(Math.max(...p))===r.y;for(let j=0;j<3;j++)brier+=(p[j]-(r.y===j?1:0))**2;}return {nll:nll/data.length,accuracy:correct/data.length,brier:brier/data.length};};
const runs=[],datasets=[];let maximumEquivalentKernelError=0;
for(const [ri,regime]of regimes.entries())for(let seed=1;seed<=seeds;seed++){
  const train=make(300,10000*ri+seed,regime.prior,reliable,`${regime.name}-${seed}-train`);
  const test=make(testSize,1000000+10000*ri+seed,regime.prior,regime.testChannel,`${regime.name}-${seed}-test`);
  assert.equal(new Set([...train,...test].map(r=>r.id)).size,train.length+test.length);
  datasets.push({regime:regime.name,seed,train,test});
  for(const n of sizes){
    const selected=train.slice(0,n),materials=[];
    for(let i=0;i<n;i+=100)materials.push(syntheticMaterialForUnitTest(compiled,`${regime.name}-${seed}-${n}-${i}`,selected.slice(i,i+100).map(r=>({state:names[r.y],report:names[r.x]}))));
    const config=fittingConfig(materials.map(m=>m.sourceManifest.protocol));
    const start=performance.now();const fit=fitObservationModel(compiled,baseline,materials,config);const fitMs=performance.now()-start;
    assert.equal(fit.coverage.fitted,n);assert.equal(fit.neuralTrained,false);
    const kernel=names.map(name=>{const row=fit.spec.hypotheses[0].channels[0].rows.find(r=>r.state.state===name);return names.map(report=>row.probabilities.find(p=>p.value.kind==='VALUE'&&p.value.value===report).p);});
    const baselineStart=performance.now();const counts=Array.from({length:3},()=>[0,0,0]);for(const r of selected)counts[r.y][r.x]++;
    const equivalent=counts.map(row=>row.map(c=>(c+1)/(row.reduce((a,b)=>a+b,0)+5)));
    const direct=[0,1,2].map(x=>normalize(counts.map(row=>row[x]+1)));
    const baselineFitMs=performance.now()-baselineStart;
    for(let y=0;y<3;y++)for(let x=0;x<3;x++)maximumEquivalentKernelError=Math.max(maximumEquivalentKernelError,Math.abs(kernel[y][x]-equivalent[y][x]));
    // One-observation posterior under the unchanged uniform prior. Not a full temporal replay.
    const ours=x=>normalize(kernel.map(row=>row[x]));
    const standard=x=>normalize(equivalent.map(row=>row[x]));
    const models={frozen_uniform:()=>[1/3,1/3,1/3],fixed_report_rule:x=>names.map((_,y)=>x===y?.8:.1),plus_u2:ours,standard_same_dirichlet:standard,empirical_classifier:x=>direct[x]};
    for(const [model,predict]of Object.entries(models))runs.push({regime:regime.name,seed,n,model,...metrics(test,predict),fitMs:model==='plus_u2'?fitMs:model==='empirical_classifier'||model==='standard_same_dirichlet'?baselineFitMs:0});
  }
  process.stdout.write(JSON.stringify({progress:regime.name,seed})+'\n');
}
assert.ok(maximumEquivalentKernelError<1e-12);
const mean=a=>a.reduce((s,x)=>s+x,0)/a.length;
const summary=[];
for(const regime of regimes)for(const n of sizes)for(const model of [...new Set(runs.map(r=>r.model))]){
  const rows=runs.filter(r=>r.regime===regime.name&&r.n===n&&r.model===model);
  summary.push({regime:regime.name,n,model,...Object.fromEntries(['nll','accuracy','brier','fitMs'].map(k=>[k,mean(rows.map(r=>r[k]))])),nllSeedSd:Math.sqrt(mean(rows.map(r=>(r.nll-mean(rows.map(r=>r.nll)))**2)))});
}
const paired=[];for(const regime of regimes)for(const n of sizes){const ds=Array.from({length:seeds},(_,i)=>{const pick=model=>runs.find(r=>r.regime===regime.name&&r.n===n&&r.seed===i+1&&r.model===model).nll;return pick('plus_u2')-pick('empirical_classifier');});const delta=mean(ds),sd=Math.sqrt(ds.reduce((s,d)=>s+(d-delta)**2,0)/(seeds-1));paired.push({regime:regime.name,n,plusMinusEmpiricalNll:delta,approx95AcrossSeeds:[delta-2.093*sd/Math.sqrt(seeds),delta+2.093*sd/Math.sqrt(seeds)]});}
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const dataJson=JSON.stringify({classification:'SYNTHETIC',states:names,regimes,sizes,seeds,testSize,datasets});
writeFileSync(join(out,'synthetic-data.json'),dataJson,{flag:'wx'});
const result={schema:'plus-offline-observation-benchmark-v1',createdAt:new Date().toISOString(),sourceRoot:root,node:process.version,sourceHashes:Object.fromEntries(['services/plus-engine/observation-fit.mjs','services/plus-engine/observation-fit-fixture.mjs','services/plus-engine/finite-engine.mjs','platform/packages/plus-contracts/dist/index.js'].map(p=>[p,sha(join(root,p))])),dataSha256:sha(join(out,'synthetic-data.json')),seeds,sizes,testSize,uniqueSyntheticRows:datasets.length*(300+testSize),maximumEquivalentKernelError,summary,paired,runs,limits:['Offline software fixture only; no native approval or publication','Only U2 observation-channel learning; no mechanism/transition learning','Single-report Bayes adapter, not full temporal engine replay','Uniform state prior is frozen by this recipe','Same-Dirichlet baseline has identical knowledge and smoothing','Empirical classifier uses the same reports and labels but learns reverse conditionals','Fixed report rule is deliberately well-specified for the stationary generator','Elapsed FIT timing includes Plus validation/hashing but baseline is bare numerical fitting; not an algorithm speed ratio','No Palantir execution, customer data, human-cost measurement or causal business benefit','Repeated IID synthetic seeds, not supplier-group or production temporal generalization','No hyperparameter tuning or model selection on test data']};
writeFileSync(join(out,'results.json'),JSON.stringify(result,null,2),{flag:'wx'});
const table=summary.filter(r=>r.n===300).map(r=>`| ${r.regime} | ${r.model} | ${r.nll.toFixed(4)} | ${(100*r.accuracy).toFixed(2)}% | ${r.fitMs.toFixed(3)} |`).join('\n');
writeFileSync(join(out,'REPORT.md'),`# 合成学习效率测试\n\n真实调用冻结源码的 U2 观测学习函数；不测试 Palantir，不发布模型。\n\n20 个随机种子，三种分布，训练预算 20/50/100/300，每次独立测试 2000 条。共 ${result.uniqueSyntheticRows} 条独立标识合成数据；各预算重复使用相同测试集，不计为独立样本。\n\n## 300 条反馈结果（20 次均值）\n\n| 分布 | 模型 | NLL，越低越好 | 准确率 | FIT 毫秒 |\n|---|---|---:|---:|---:|\n${table}\n\n## 结论与边界\n\n与同先验、同平滑的标准 Dirichlet 方法，最大核参数差为 ${maximumEquivalentKernelError}，没有独有数据效率优势。固定规则已知稳定生成器的可靠度，属于强参照，不是从测试集调参。观察学习只更新报告通道，不更新状态先验；失衡与分布变化会暴露限制。\n\n时间仅为本次调用墙钟时间，Plus 包含合同验证、摘要和工件构建，标准基线不包含这些，不能直接宣称算法快慢倍数。全部限制、每次结果和配对区间见 results.json；数据见 synthetic-data.json。\n`,{flag:'wx'});
console.log(JSON.stringify({finished:true,out,maximumEquivalentKernelError,summary:summary.filter(r=>r.n===300)}));
