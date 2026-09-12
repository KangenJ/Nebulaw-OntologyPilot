// Server-constructor-only seam for qualifying the real, isolated canonical
// host. No policy/HTTP/environment flag can extend the ordinary FIT registry.
import { registeredFitEngineIds } from '../../services/plus-engine/private-fit-registry.mjs';
import { learnedCompositionEstimatorId } from '../../services/plus-engine/learned-composition.mjs';
import { validateNativeRecipeSelection } from './native-recipe-selection.mjs';
import { createReviewedNativeFitRegistration } from './reviewed-fit-registration.mjs';

const fail=()=>{throw Object.assign(new Error('COMPLETE_FIT_QUALIFICATION_INVALID'),{code:'COMPLETE_FIT_QUALIFICATION_INVALID'});};
const shape=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const selectionKey=v=>JSON.stringify([v.key,v.revision,v.engineId,v.definitionHash,v.bindingHash,v.scopeKey,v.classification]);
const bindingKey=v=>JSON.stringify([v.engineId,v.definitionHash,v.bindingHash,v.scopeKey,v.classification]);

export function createPrivateFitRegistration({tenantId,loadPolicy,syntheticCompleteFitQualification,reviewedCompleteFit}){
  if(typeof loadPolicy!=='function')fail();
  if(reviewedCompleteFit!==undefined){
    if(syntheticCompleteFitQualification!==undefined)fail();
    return createReviewedNativeFitRegistration({tenantId,loadPolicy,reviewedCompleteFit});
  }
  if(syntheticCompleteFitQualification===undefined)return {engineIds:registeredFitEngineIds,loadPolicy};
  const q=structuredClone(syntheticCompleteFitQualification);
  if(!shape(q,['version','tenantId','recipeSelections'])||q.version!=='plus-synthetic-complete-fit-qualification-v1'
    ||typeof tenantId!=='string'||!tenantId||q.tenantId!==tenantId||!Array.isArray(q.recipeSelections)||!q.recipeSelections.length||q.recipeSelections.length>10)fail();
  const pins=new Set();
  for(const raw of q.recipeSelections){
    let selection;try{selection=validateNativeRecipeSelection(raw);}catch{fail();}
    if(selection.engineId!==learnedCompositionEstimatorId||selection.classification!=='SYNTHETIC')fail();
    const key=selectionKey(selection);if(pins.has(key))fail();pins.add(key);
  }
  const checkedLoad=()=>{
    const policy=loadPolicy();
    // Required actual graph, not injectable approval/material providers. All
    // its own schema, identity, grant and native-use checks still execute.
    if(['taskDomain','taskLearning','taskRules','evaluation','modelGovernance','actionIntervals','replayGovernance','beliefRuntime','scenarioPlanning','actionRequests']
      .some(name=>policy?.[name]?.enabled!==true))fail();
    if(policy?.compute?.enabled!==true)fail();
    if(policy.compute.version==='plus-private-compute-v3'){
      if(!Array.isArray(policy.compute.jobs))fail();
      for(const job of policy.compute.jobs){
        if(job?.policy?.engineId!==learnedCompositionEstimatorId)continue;
        const p=job.policy;
        let selection;try{selection=validateNativeRecipeSelection(p.recipeSelection);}catch{fail();}
        if(Object.hasOwn(p,'recipeHash')||!shape(job.authorization,['key','version'])||!pins.has(selectionKey(selection)))fail();
      }
    }else if(policy.compute.version==='plus-private-compute-v4'){
      // Native membership is NOT converted into file jobs. The target fixes
      // only a purpose/binding; the exact recipe revision is checked after the
      // SAME native registry qualifies its actual approved record, every use.
      if(!shape(policy.compute,['version','enabled','grants','workers'])||policy.computeAuthorizations?.enabled!==true||!Array.isArray(policy.computeAuthorizations.targets))fail();
      for(const target of policy.computeAuthorizations.targets)if(target?.policy?.engineId===learnedCompositionEstimatorId
        &&!q.recipeSelections.some(s=>bindingKey(s)===bindingKey(target.policy)))fail();
    }else fail();
    return policy;
  };
  checkedLoad();
  const allowsMetadata=item=>{
    checkedLoad();if(item?.engineId!==learnedCompositionEstimatorId)return registeredFitEngineIds.includes(item?.engineId);
    let selection;try{selection=validateNativeRecipeSelection({key:item.key,revision:item.revision,engineId:item.engineId,definitionHash:item.definitionHash,
      bindingHash:item.bindingHash,scopeKey:item.scopeKey,classification:item.classification});}catch{return false;}
    return pins.has(selectionKey(selection));
  };
  const requireQualified=approved=>{
    const r=approved?.record,p=approved?.payload;if(!r||!p||r.engineId!==p.engineId)fail();
    if(r.engineId!==learnedCompositionEstimatorId){checkedLoad();if(!registeredFitEngineIds.includes(r.engineId))fail();return;}
    if(r._tenantId!==tenantId||r.status!=='APPROVED'||r.definitionHash!==p.compiled?.definitionHash||!allowsMetadata({key:r.recipeKey,revision:r.revision,
      engineId:r.engineId,definitionHash:r.definitionHash,bindingHash:p.config?.bindingHash,scopeKey:p.compiled?.definition?.scope?.key,classification:p.config?.classification}))fail();
  };
  return {engineIds:Object.freeze([...registeredFitEngineIds,learnedCompositionEstimatorId]),loadPolicy:checkedLoad,
    nativeRecipeQualification:Object.freeze({allowsMetadata,requireQualified})};
}
