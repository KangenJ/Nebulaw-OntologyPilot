// Actual numerical conditional-transition scoring. Pure input verification is
// NOT current native authorization; private scoring/admission must wrap this.
import { canonicalJson as key,digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { EngineError } from './finite-engine.mjs';
import { validateTransitionRecipe,verifyTransitionFit } from './transition-fit.mjs';
import { qualifyCompleteTransitionMaterial,qualifyCompleteTransitionValidationMaterial } from './transition-material.mjs';
const check=(ok,code)=>{if(!ok)throw new EngineError(code);};
const same=(a,b)=>key(a)===key(b);
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const intersects=(a,b)=>{const values=new Set(b);return a.some(v=>values.has(v));};

// Independence control using the SAME conditional training counts, smoothing,
// latent inputs, context and control. It does not inspect validation outcomes.
// Marginalizing the jointly smoothed table preserves the recipe's prior mass.
export function factorizeTransitionProbabilities(states,variables,probabilities){
  check(Array.isArray(states)&&states.length>0&&Array.isArray(variables)&&variables.length>0&&new Set(variables).size===variables.length
    &&variables.every(v=>typeof v==='string'&&states.every(s=>s&&Object.hasOwn(s,v)))&&new Set(states.map(key)).size===states.length
    &&Array.isArray(probabilities)&&probabilities.length===states.length&&probabilities.every(p=>Number.isFinite(p)&&p>0&&p<=1)
    &&Math.abs(probabilities.reduce((a,b)=>a+b,0)-1)<=1e-12,'TRANSITION_REFERENCE_PROBABILITY');
  if(variables.length===1)return [...probabilities];
  const marginals=variables.map(v=>{const values=new Map();for(let i=0;i<states.length;i++){
    check(Object.hasOwn(states[i],v),'TRANSITION_REFERENCE_STATE');const k=key(states[i][v]);values.set(k,(values.get(k)??0)+probabilities[i]);}return values;});
  const weights=states.map(s=>variables.reduce((p,v,i)=>p*marginals[i].get(key(s[v])),1)),mass=weights.reduce((a,b)=>a+b,0);
  check(Number.isFinite(mass)&&mass>0,'TRANSITION_REFERENCE_PROBABILITY');return weights.map(p=>p/mass);
}

// Pure set guard on ALREADY structurally qualified complete populations. This
// exported check is not an authorization API and must never accept HTTP data.
// In particular, missing-GOLD rows remain in the population used for isolation.
export function assertIndependentTransitionPopulations(train,validation,trainPlan,valPlan){
  check(trainPlan.tenantId===valPlan.tenantId,'TRANSITION_SCORE_TENANT_MISMATCH');
  const policies=rows=>[...new Set(rows.map(r=>r.partitionPolicyHash))].sort();
  check(policies(trainPlan.pairs).length===1&&same(policies(trainPlan.pairs),policies(valPlan.pairs)),'TRANSITION_SCORE_PARTITION_POLICY_MISMATCH');
  for(const [name,a,b]of [
    ['ENTITY',train.rows.map(r=>r.entityKey),validation.rows.map(r=>r.entityKey)],
    ['GROUP',train.rows.map(r=>r.groupHash),validation.rows.map(r=>r.groupHash)],
    ['SOURCE',train.sourceFamilyKeys,validation.sourceFamilyKeys],
    ['COHORT',train.cohortIds,validation.cohortIds],['DATASET',train.datasetIds,validation.datasetIds],
  ])check(!intersects(a,b),'TRANSITION_SCORE_'+name+'_OVERLAP');
  const evidenceIds=q=>q.referenceEvidence.filter(r=>['PlusInputSnapshot','PlusFeedback','PlusEvent','Observation','TaskCompletionVerification'].includes(r.type)).map(r=>key([r.type,r.id]));
  check(!intersects(evidenceIds(train),evidenceIds(validation)),'TRANSITION_SCORE_EVIDENCE_OVERLAP');
  return policies(trainPlan.pairs)[0];
}

export function evaluateConditionalTransition({recipe,candidate,trainingMaterial,validationMaterial,protocol}){
  const supervision=validateTransitionRecipe(recipe,recipe?.compiled),c=protocol?.payload?.configuration;
  const factorized=c?.schema==='plus-conditional-transition-evaluation-v2';
  check(c&&Object.keys(c).sort().join(',')===(factorized?'maximumBrierRegression,maximumNllRegression,minimumCoverage,minimumGroups,minimumPairs,reference,schema,task':'maximumBrierRegression,maximumNllRegression,minimumCoverage,minimumGroups,minimumPairs,schema,task')
    &&['plus-conditional-transition-evaluation-v1','plus-conditional-transition-evaluation-v2'].includes(c.schema)&&c.task==='CONDITIONAL_TRANSITION','TRANSITION_SCORE_CONFIGURATION');
  if(factorized)check(same(c.reference,{schema:'plus-transition-reference-v1',kind:'SAME_CONDITION_FACTORIZED_COUNTS'}),'TRANSITION_SCORE_REFERENCE');
  check(Number.isSafeInteger(c.minimumPairs)&&c.minimumPairs>=1&&c.minimumPairs<=supervision.specification.budget.maxPairs
    &&Number.isSafeInteger(c.minimumGroups)&&c.minimumGroups>=1&&c.minimumGroups<=Math.min(c.minimumPairs,supervision.specification.budget.maxTrajectories)
    &&Number.isFinite(c.minimumCoverage)&&c.minimumCoverage>0&&c.minimumCoverage<=1
    &&Number.isFinite(c.maximumNllRegression)&&c.maximumNllRegression>=0&&c.maximumNllRegression<=100
    &&Number.isFinite(c.maximumBrierRegression)&&c.maximumBrierRegression>=0&&c.maximumBrierRegression<=2,'TRANSITION_SCORE_THRESHOLDS');
  check(!Object.hasOwn(protocol.payload,'reference'),'TRANSITION_SCORE_PUBLISHED_REFERENCE_NOT_IMPLEMENTED');
  verifyTransitionFit(recipe,[trainingMaterial],candidate);
  const train=qualifyCompleteTransitionMaterial(recipe,trainingMaterial,supervision),validation=qualifyCompleteTransitionValidationMaterial(recipe,validationMaterial,supervision,protocol);
  const trainPlan=trainingMaterial.sourcePlan.contextPlan.plan,valPlan=validationMaterial.sourcePlan.contextPlan.plan;
  const partitionPolicyHash=assertIndependentTransitionPopulations(train,validation,trainPlan,valPlan);
  const states=supervision.layout.states,table=new Map(candidate.table.map(r=>[key(r.condition),r])),rows=[],excluded=[];
  const referenceTable=factorized?candidate.table.map(r=>({condition:r.condition,status:r.status,observations:r.observations,
    probabilities:r.probabilities===null?null:factorizeTransitionProbabilities(states,supervision.layout.stateVariables,r.probabilities)})):undefined;
  const referenceRows=referenceTable?new Map(referenceTable.map(r=>[key(r.condition),r])):undefined;
  for(const pair of validation.rows){
    if(pair.status==='MISSING_GOLD'){excluded.push({pairKey:pair.pairKey,reason:'MISSING_GOLD',missingSampleKeys:pair.missingSampleKeys});continue;}
    const condition={control:pair.parameterControl,from:Object.fromEntries(supervision.layout.latentInputs.map(k=>[k,pair.from[k]])),context:pair.context};
    const fitted=table.get(key(condition));check(fitted,'TRANSITION_SCORE_LAYOUT');
    if(fitted.status==='UNSUPPORTED'){excluded.push({pairKey:pair.pairKey,reason:'UNSUPPORTED_CONDITION',conditionHash:digest(condition)});continue;}
    const probabilities=fitted.probabilities,index=states.findIndex(s=>same(s,pair.to));
    check(index>=0&&Array.isArray(probabilities)&&probabilities.length===states.length&&probabilities.every(p=>Number.isFinite(p)&&p>0&&p<=1)
      &&Math.abs(probabilities.reduce((a,b)=>a+b,0)-1)<=1e-12,'TRANSITION_SCORE_PROBABILITY');
    const nll=-Math.log(probabilities[index]),brier=probabilities.reduce((sum,p,i)=>sum+(p-(i===index?1:0))**2,0);
    const prior=1/states.length;
    const referenceProbabilities=factorized?referenceRows.get(key(condition)).probabilities:null;
    rows.push({pairKey:pair.pairKey,entityKey:pair.entityKey,groupHash:pair.groupHash,conditionHash:digest(condition),targetHash:digest(pair.to),
      probabilities:[...probabilities],nll,brier,referenceNll:factorized?-Math.log(referenceProbabilities[index]):-Math.log(prior),
      referenceBrier:factorized?referenceProbabilities.reduce((sum,p,i)=>sum+(p-(i===index?1:0))**2,0):1-prior,
      ...(factorized?{referenceProbabilities:[...referenceProbabilities],priorNll:-Math.log(prior),priorBrier:1-prior}:{})});
  }
  const scoredGroups=[...new Set(rows.map(r=>r.groupHash))],coverage={enrolledPairs:validation.rows.length,scoredPairs:rows.length,
    missingGold:excluded.filter(r=>r.reason==='MISSING_GOLD').length,unsupportedConditions:excluded.filter(r=>r.reason==='UNSUPPORTED_CONDITION').length,
    fraction:rows.length/validation.rows.length,enrolledGroups:new Set(validation.rows.map(r=>r.groupHash)).size,scoredGroups:scoredGroups.length};
  const average=(values,k)=>values.reduce((sum,v)=>sum+v[k],0)/values.length;
  const score=(n,b)=>rows.length?{meanNll:average(rows,n),meanBrier:average(rows,b),
    groupMacroNll:scoredGroups.reduce((sum,g)=>sum+average(rows.filter(r=>r.groupHash===g),n),0)/scoredGroups.length,
    groupMacroBrier:scoredGroups.reduce((sum,g)=>sum+average(rows.filter(r=>r.groupHash===g),b),0)/scoredGroups.length}:null;
  const estimated=score('nll','brier'),reference=score('referenceNll','referenceBrier');
  const sufficient=coverage.scoredPairs>=c.minimumPairs&&coverage.scoredGroups>=c.minimumGroups&&coverage.fraction>=c.minimumCoverage;
  const tolerance=factorized?1e-12:0,priorScores=factorized?score('priorNll','priorBrier'):undefined;
  const regressesAgainst=r=>estimated!==null&&(estimated.meanNll-r.meanNll>c.maximumNllRegression+tolerance||estimated.groupMacroNll-r.groupMacroNll>c.maximumNllRegression+tolerance
    ||estimated.meanBrier-r.meanBrier>c.maximumBrierRegression+tolerance||estimated.groupMacroBrier-r.groupMacroBrier>c.maximumBrierRegression+tolerance);
  const regresses=regressesAgainst(reference)||(factorized&&regressesAgainst(priorScores));
  const referenceArtifact=factorized?{schema:'plus-factorized-transition-reference-v1',recipeHash:digest(recipe),trainingMaterialHash:trainingMaterial.contentHash,
    sourceArtifactHash:candidate.artifactHash,statesHash:digest(states),variables:supervision.layout.stateVariables,table:referenceTable,
    semantics:'SAME_TRAINING_AND_CONDITION_SMOOTHED_MARGINAL_PRODUCT_NOT_MECHANISM_POSTERIOR',numericalTolerance:tolerance}:undefined;
  const body={schema:factorized?'plus-conditional-transition-score-v2':'plus-conditional-transition-score-v1',task:'CONDITIONAL_TRANSITION',recipeHash:digest(recipe),artifactHash:candidate.artifactHash,
    protocolHash:protocol.contentHash,configurationHash:digest(c),trainingMaterialHash:trainingMaterial.contentHash,validationMaterialHash:validationMaterial.contentHash,
    classification:recipe.config.classification,semantics:'CONDITIONAL_TRANSITION_GIVEN_VERIFIED_START_NOT_ONLINE_FORECAST_OR_CAUSAL_EFFECT',
    candidate:estimated,reference:factorized?{kind:'SAME_CONDITION_FACTORIZED_COUNTS',scores:reference,sameScoredPairs:true,sameTrainingExposure:true,sameConditioningInformation:true,
      artifact:referenceArtifact,artifactHash:digest(referenceArtifact)}:{kind:'UNTRAINED_SYMMETRIC_DIRICHLET_PRIOR',scores:reference,sameScoredPairs:true},
    ...(factorized?{priorReference:{kind:'UNTRAINED_SYMMETRIC_DIRICHLET_PRIOR',scores:priorScores,sameScoredPairs:true},comparisonRule:'NO_REGRESSION_AGAINST_EITHER_FIXED_REFERENCE'}:{}),coverage,
    decision:!sufficient?'INSUFFICIENT_COVERAGE':regresses?'REJECT_REGRESSION':'ELIGIBLE_FOR_REVIEW',predictionReceipts:rows,excluded,
    isolation:{tenantId:trainPlan.tenantId,partitionPolicyHash,trainingDatasets:train.datasetIds,validationDatasets:validation.datasetIds,
      trainingSourceHash:digest(train.sourceFamilyKeys),validationSourceHash:digest(validation.sourceFamilyKeys),structuralSeparationChecked:true,nativeAuthorityChecked:false},
    notEvaluated:['CURRENT_PUBLICATION_COMPARISON','ONLINE_FORECAST','CAUSAL_EFFECT','REAL_BUSINESS_BENEFIT','PRIVATE_SCORING_ADMISSION'],
    trainingAuthorized:false,predictionReady:false,deploymentAuthorized:false};
  return freeze({...body,contentHash:digest(body)});
}
