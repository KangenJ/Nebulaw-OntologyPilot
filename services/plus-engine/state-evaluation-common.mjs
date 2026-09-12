// Shared scoring only: caller must verify its exact estimator and TRAIN artifact.
// Every kernel receives identical pre-label temporal inputs. GOLD stays in scoring.
import { canonicalJson,digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { EngineError } from './finite-engine.mjs';
import { runFiniteTimeline,validateFiniteClock } from './episode-timeline.mjs';
import { validateObservationEvaluationInputs } from './observation-evaluation-protocol.mjs';
const check=(ok,code)=>{if(!ok)throw new EngineError(code);};
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
export const stateThresholds=c=>({minimumSamples:c.minimumSamples,minimumCoverage:c.minimumCoverage,maximumNllRegression:c.maximumNllRegression});
export function validateStateEvaluationInputs({configuration:c,recipe,cohorts}){
  check(c&&Object.getPrototypeOf(c)===Object.prototype&&Object.keys(c).sort().join(',')==='clock,maximumBrierRegression,maximumNllRegression,minimumCoverage,minimumSamples,task'
    &&c.task==='STATE_ESTIMATION','STATE_EVALUATION_CONFIGURATION');
  validateObservationEvaluationInputs({configuration:stateThresholds(c),recipe,cohorts});
  validateFiniteClock(recipe.compiled,c.clock);
  check(c.clock.bindingHash===recipe.config.bindingHash,'STATE_EVALUATION_CLOCK_BINDING');
  check(Number.isFinite(c.maximumBrierRegression)&&c.maximumBrierRegression>=0&&c.maximumBrierRegression<=2,'STATE_EVALUATION_BRIER_MARGIN');
}
function score(rows,states){
  let nll=0,brier=0;const groups=new Map(),bins=Array.from({length:10},(_,i)=>({lower:i/10,upper:(i+1)/10,count:0,confidenceSum:0,correct:0}));
  for(const {probabilities,label,group} of rows){
    const probability=probabilities[states.findIndex(s=>same(s,label))];
    check(Number.isFinite(probability)&&probability>0,'STATE_EVALUATION_ZERO_LABEL_SUPPORT');
    const loss=-Math.log(probability),squared=probabilities.reduce((sum,p,i)=>sum+(p-(same(states[i],label)?1:0))**2,0);
    nll+=loss;brier+=squared;const g=groups.get(group)??{n:0,nll:0,brier:0};g.n++;g.nll+=loss;g.brier+=squared;groups.set(group,g);
    const max=Math.max(...probabilities),winner=probabilities.indexOf(max),bin=bins[Math.min(9,Math.floor(max*10))];
    bin.count++;bin.confidenceSum+=max;bin.correct+=same(states[winner],label)?1:0;
  }
  return {meanNll:nll/rows.length,meanBrier:brier/rows.length,groupCount:groups.size,
    groupMacroNll:[...groups.values()].reduce((sum,g)=>sum+g.nll/g.n,0)/groups.size,
    groupMacroBrier:[...groups.values()].reduce((sum,g)=>sum+g.brier/g.n,0)/groups.size,
    calibration:{method:'TOP_CLASS_10_FIXED_BINS_DESCRIPTIVE_NOT_CALIBRATION_CERTIFICATION',
      bins:bins.map(b=>({lower:b.lower,upper:b.upper,count:b.count,meanConfidence:b.count?b.confidenceSum/b.count:null,accuracy:b.count?b.correct/b.count:null})),
      expectedCalibrationError:bins.reduce((sum,b)=>sum+(b.count?Math.abs(b.confidenceSum/b.count-b.correct/b.count)*b.count/rows.length:0),0)}};
}

export function scoreStateKernels({compiled,clock,model,data,validationMaterials,validationTemporalInputs,kernels}){
  const nativeSamples=validationMaterials.flatMap(v=>v.sourceManifest.samples),bySnapshot=new Map();
  check(Array.isArray(validationTemporalInputs)&&validationTemporalInputs.length===nativeSamples.length,'STATE_EVALUATION_HISTORY_REQUIRED');
  for(const item of validationTemporalInputs){
    check(item&&item.predictionReady===false&&item.contentHash===digest({temporalInput:item.temporalInput,readSet:item.readSet}),'STATE_EVALUATION_HISTORY_INTEGRITY');
    const sample=nativeSamples.find(s=>s.inputSnapshotId===item.readSet?.snapshot?.id);
    check(sample&&!bySnapshot.has(sample.inputSnapshotId)&&item.readSet.snapshotHash===sample.inputHash,'STATE_EVALUATION_SNAPSHOT_MISMATCH');
    const input=item.temporalInput;
    for(const field of ['definitionHash','bindingHash','classification','startedAt','visibleAt','targetTime'])check(input[field]===sample.input[field],'STATE_EVALUATION_SNAPSHOT_MISMATCH');
    check(same(input.events.map(e=>e.event),sample.input.events),'STATE_EVALUATION_EVENT_MISMATCH');
    bySnapshot.set(sample.inputSnapshotId,item);
  }

  const entries=Object.entries(kernels);
  check(entries.length>=1&&entries.length<=5,'STATE_EVALUATION_KERNEL_BUDGET');
  const rows=Object.fromEntries(entries.map(([key])=>[key,[]])),receipts=[];
  for(const sample of data.samples){
    const temporal=bySnapshot.get(sample.inputSnapshotId),estimates={};
    for(const [key,spec]of entries){
      const result=runFiniteTimeline(compiled,spec,temporal.temporalInput,clock);
      const probabilities=model.states.map(value=>result.summary.states.filter(row=>same(row.state[model.target.key],value)).reduce((sum,row)=>sum+row.p,0));
      rows[key].push({probabilities,label:sample.state,group:sample.splitGroupHash});estimates[key]=result.contentHash;
    }
    receipts.push({sampleKeyHash:digest(sample.sampleKey),snapshotHash:sample.inputHash,temporalHash:temporal.contentHash,estimates});
  }
  return {scores:Object.fromEntries(entries.map(([key])=>[key,score(rows[key],model.states)])),receipts};
}

