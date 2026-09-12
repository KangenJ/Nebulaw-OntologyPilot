// Non-Transformer U3 channel estimator: one-hot latent support -> tanh MLP ->
// typed report probabilities. GOLD is a training-only channel covariate; online
// inference enumerates states in the finite filter, never receives a GOLD label.
import { canonicalJson,digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { EngineError,createFiniteEngine } from './finite-engine.mjs';
import { prepareObservationTraining,validateObservationRecipe,fitObservationModel,prepareObservationValidation,scoreObservationChannel } from './observation-fit.mjs';

export const neuralObservationEstimatorId='ontology-categorical-tanh-channel-v1';
const check=(v,code)=>{if(!v)throw new EngineError(code);};
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&same(Object.keys(v).sort(),[...keys].sort());
const integer=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};

/** Data-free review contract. No weights, class order, labels, arbitrary feature
 * paths or user code are accepted in this recipe. Dictionaries are compiled. */
export function validateNeuralObservationRecipe(compiled,baseline,config){
  check(exact(config,['schema','supervision','network'])&&config.schema==='plus-neural-observation-config-v1','NEURAL_CONFIG');
  validateObservationRecipe(compiled,baseline,config.supervision);
  const n=config.network;
  check(exact(n,['schema','hiddenWidth','epochs','learningRate','l2','seed'])&&n.schema==='one-hot-tanh-softmax-v1','NEURAL_NETWORK_CONFIG');
  check(integer(n.hiddenWidth,1,32)&&integer(n.epochs,1,2000)&&integer(n.seed,0,0xffffffff),'NEURAL_CAPACITY');
  check(Number.isFinite(n.learningRate)&&n.learningRate>=1e-6&&n.learningRate<=1&&Number.isFinite(n.l2)&&n.l2>=0&&n.l2<=1,'NEURAL_OPTIMIZER');
  const target=compiled.variables.find(v=>v.key===config.supervision.targetVariable),report=compiled.variables.find(v=>v.key===config.supervision.observationVariable);
  check(target.support.length>=2&&target.support.length<=64&&report.support.length+report.unknownValues.length+(report.nullable?1:0)<=128,'NEURAL_SUPPORT_BUDGET');
}

function initialWeights(layout,network){
  const k=layout.inputs.length,c=layout.outputs.length,h=network.hiddenWidth;
  const weight=(matrix,row,column,scale)=>(parseInt(digest([network.seed,matrix,row,column]).slice(0,8),16)/0x100000000*2-1)*scale;
  return {input:Array.from({length:h},(_,j)=>Array.from({length:k},(_,i)=>weight('input',j,layout.inputs[i],Math.sqrt(6/(k+h))))),
    hiddenBias:Array(h).fill(0),output:Array.from({length:c},(_,o)=>Array.from({length:h},(_,j)=>weight('output',layout.outputs[o],j,Math.sqrt(6/(h+c))))),outputBias:Array(c).fill(0)};
}
function forward(weights,state){
  const hidden=weights.input.map((row,j)=>Math.tanh(row[state]+weights.hiddenBias[j]));
  const logits=weights.output.map((row,o)=>row.reduce((sum,w,j)=>sum+w*hidden[j],weights.outputBias[o]));
  const max=Math.max(...logits),exp=logits.map(v=>Math.exp(v-max)),z=exp.reduce((a,b)=>a+b,0),probabilities=exp.map(v=>v/z);
  check(probabilities.every(p=>Number.isFinite(p)&&p>0&&p<=1),'NEURAL_NUMERIC_FAILURE');return {hidden,probabilities};
}
function channelSpec(baseline,model,weights){
  const spec=structuredClone(baseline);
  for(const hypothesis of spec.hypotheses){
    const channel=hypothesis.channels.find(c=>c.variable===model.observation.key&&c.kind==='OBSERVATION'&&c.mode==='NONE');
    check(channel,'FIT_CHANNEL_MISSING');
    for(const row of channel.rows){const state=model.states.findIndex(v=>same(v,row.state[model.target.key]));check(state>=0,'NEURAL_LAYOUT_MISMATCH');
      const {probabilities}=forward(weights,state);row.probabilities=model.outcomes.map((value,i)=>({value:structuredClone(value),p:probabilities[i]}));}
  }
  return spec;
}
function score(weights,samples){let loss=0;for(const s of samples)loss-=Math.log(forward(weights,s.state).probabilities[s.outcome]);return loss/samples.length;}
function train(weights,samples,config){
  const h=weights.input.length,k=weights.input[0].length,c=weights.output.length,rate=config.learningRate;
  for(let epoch=0;epoch<config.epochs;epoch++){
    const gradient={input:Array.from({length:h},()=>Array(k).fill(0)),hiddenBias:Array(h).fill(0),output:Array.from({length:c},()=>Array(h).fill(0)),outputBias:Array(c).fill(0)};
    // Deterministic full-batch gradient. Every update uses the pre-update weights;
    // no VALIDATION/FINAL_EVAL material is accepted by the shared collector.
    for(const s of samples){const {hidden,probabilities}=forward(weights,s.state),dz=probabilities.map((p,o)=>(p-(o===s.outcome?1:0))/samples.length);
      for(let o=0;o<c;o++){gradient.outputBias[o]+=dz[o];for(let j=0;j<h;j++)gradient.output[o][j]+=dz[o]*hidden[j];}
      for(let j=0;j<h;j++){const dh=dz.reduce((sum,d,o)=>sum+d*weights.output[o][j],0)*(1-hidden[j]**2);gradient.hiddenBias[j]+=dh;gradient.input[j][s.state]+=dh;}
    }
    for(const name of ['input','output'])for(let i=0;i<weights[name].length;i++)for(let j=0;j<weights[name][i].length;j++)weights[name][i][j]-=rate*(gradient[name][i][j]+config.l2*weights[name][i][j]);
    for(const name of ['hiddenBias','outputBias'])for(let i=0;i<weights[name].length;i++)weights[name][i]-=rate*gradient[name][i];
    check(Object.values(weights).flat(2).every(Number.isFinite),'NEURAL_NUMERIC_FAILURE');
  }
}

/** Pure fitting only. Native admission MUST re-materialize qualified data and
 * verify this candidate before storing/reviewing it. No automatic publication. */
export function fitNeuralObservationModel(compiled,baseline,materials,rawConfig){
  const config=structuredClone(rawConfig);validateNeuralObservationRecipe(compiled,baseline,config);
  const {model,data,counts}=prepareObservationTraining(compiled,baseline,materials,config.supervision);
  // A shared network can change every state row, including unsupervised ones.
  // Unlike U2's explicit prior-only rows, U3 therefore needs coverage of ALL
  // target states. Do not extrapolate unlabelled states into a learned kernel.
  check(counts.every(row=>row.some(n=>n>0)),'NEURAL_UNSUPERVISED_STATE');
  const layout={schema:'plus-ontology-channel-layout-v1',definitionHash:compiled.definitionHash,bindingHash:config.supervision.bindingHash,
    inputRole:'ENUMERATED_LATENT_STATE_NOT_ONLINE_GOLD',targetVariable:model.target.key,observationVariable:model.observation.key,
    inputs:model.states.map(value=>({kind:'ONE_HOT_STATE',value})),outputs:model.outcomes,
    missingness:'EXPLICIT_TYPED_OUTCOMES_UNOBSERVED_EXCLUDED',context:'NONE_BY_REVIEWED_MODULE_CONTRACT'};
  const parameterCount=config.network.hiddenWidth*(model.states.length+1)+model.outcomes.length*(config.network.hiddenWidth+1);
  const operationBudget=data.samples.length*config.network.epochs*config.network.hiddenWidth*(model.outcomes.length+1)*4;
  check(operationBudget<=50000000,'NEURAL_COMPUTE_BUDGET');
  const samples=data.samples.map(s=>({state:model.states.findIndex(v=>same(v,s.state)),outcome:model.outcomes.findIndex(v=>same(v,s.outcome))}));
  const untrainedWeights=initialWeights(layout,config.network),weights=structuredClone(untrainedWeights),initialLoss=score(weights,samples);
  train(weights,samples,config.network);const trainedLoss=score(weights,samples),spec=channelSpec(baseline,model,weights),untrainedSpec=channelSpec(baseline,model,untrainedWeights);
  const engine=createFiniteEngine(compiled,spec),control=createFiniteEngine(compiled,untrainedSpec);
  const body={schema:'plus-neural-observation-model-v1',implementation:neuralObservationEstimatorId,definitionHash:compiled.definitionHash,
    config,configHash:digest(config),layout,layoutHash:digest(layout),parameterCount,weights,weightHash:digest(weights),
    exactUntrainedControl:{weights:untrainedWeights,weightHash:digest(untrainedWeights),spec:untrainedSpec,kernelHash:control.modelHash},
    spec,kernelHash:engine.modelHash,baselineModelHash:model.baselineModelHash,
    training:{optimizer:'DETERMINISTIC_FULL_BATCH_GRADIENT_DESCENT',epochs:config.network.epochs,initialMeanNll:initialLoss,finalMeanNll:trainedLoss,operationBudget,
      weightsChanged:digest(weights)!==digest(untrainedWeights),selection:'FIXED_FINAL_EPOCH_NO_VALIDATION_SELECTION'},
    coverage:data.coverage,consumption:data.consumption,fittedSampleKeys:data.samples.map(s=>s.sampleKey).sort(),
    unobservedOutcomes:model.outcomes.filter((_,i)=>counts.every(row=>row[i]===0)),
    learnedComponents:['OBSERVATION:'+model.observation.key],frozenComponents:['INITIAL','TRANSITION','MECHANISM_PRIORS','OTHER_CHANNELS'],
    parameterSemantics:'POINT_OBSERVATION_KERNEL_WITH_REVIEWED_TRANSITION_HYPOTHESES',mechanismUncertaintyLearned:false,
    learningKind:'U3',neuralTrained:true,statisticallyFitted:false,readiness:'CANDIDATE_UNEVALUATED',predictionReady:false,publicationAuthorized:false};
  return freeze({...body,artifactHash:digest(body)});
}
export function verifyNeuralObservationFit(compiled,baseline,materials,config,candidate){
  const expected=fitNeuralObservationModel(compiled,baseline,materials,config);
  check(same(expected,candidate),'NEURAL_ARTIFACT_RECOMPUTE_MISMATCH');return expected;
}

/** Same-information conditional channel comparison. The statistical control is
 * refitted on exactly the candidate TRAIN union; exact initialization is frozen
 * by the recipe. Neither a gradient nor epoch/seed selection sees holdout labels.
 * Current published-model qualification and state scoring belong to the native
 * evaluator integration, not to this pure channel diagnostic. */
export function validateNeuralObservationModel(compiled,baseline,trainingMaterials,config,candidate,validationMaterials,protocol){
  verifyNeuralObservationFit(compiled,baseline,trainingMaterials,config,candidate);
  const statistical=fitObservationModel(compiled,baseline,trainingMaterials,config.supervision);
  check(same(candidate.consumption,statistical.consumption)&&same(candidate.fittedSampleKeys,statistical.fittedSampleKeys),'NEURAL_CONTROL_INFORMATION_MISMATCH');
  // Reuse current holdout policy, maturity, coverage and contamination checks;
  // a structural data hash alone still does not represent native approval.
  const {model,data}=prepareObservationValidation(compiled,baseline,trainingMaterials,config.supervision,statistical,validationMaterials,protocol);
  const references={configuredNoUpdate:scoreObservationChannel(baseline,model,data),sameInformationStatistical:scoreObservationChannel(statistical.spec,model,data),
    exactUntrained:scoreObservationChannel(candidate.exactUntrainedControl.spec,model,data)};
  const score=scoreObservationChannel(candidate.spec,model,data),comparisons=Object.fromEntries(Object.entries(references).map(([name,ref])=>[name,{groupMacroNllDelta:score.groupMacroNll-ref.groupMacroNll,
    meanBrierDelta:score.meanBrier-ref.meanBrier,regresses:score.groupMacroNll-ref.groupMacroNll>protocol.maximumNllRegression}]));
  const body={schema:'plus-neural-channel-validation-result-v1',artifactHash:candidate.artifactHash,protocolHash:digest(protocol),metric:'CONDITIONAL_REPORT_GIVEN_GOLD',
    referenceSemantics:'CONFIGURED_BASELINE_IS_NOT_A_VERIFIED_CURRENT_PUBLICATION',candidate:score,references,comparisons,
    statisticalArtifactHash:statistical.artifactHash,untrainedWeightHash:candidate.exactUntrainedControl.weightHash,trainingConsumptionHash:digest(candidate.consumption),
    coverage:data.coverage,validationDatasets:data.consumption.datasets,validationConsumptionHash:digest(data.consumption),
    decision:Object.values(comparisons).some(c=>c.regresses)?'REJECT_REGRESSION':'ELIGIBLE_FOR_REVIEW',deploymentAuthorized:false,
    notEvaluated:['STATE_ESTIMATION','STATE_FORECAST','CURRENT_PUBLISHED_MODEL_COMPARISON','TRANSITION_LEARNING','CAUSAL_BENEFIT','SEALED_FINAL_EVALUATION','REAL_BUSINESS_BENEFIT']};
  return freeze({...body,contentHash:digest(body)});
}
