import {openSync,closeSync,fstatSync,readFileSync,constants} from 'node:fs';
import {isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {digest} from '../../platform/packages/plus-contracts/dist/index.js';
import {knownPrivatePolicyDigest} from './private-policy-loader.mjs';
import {registeredFitEngineIds} from '../../services/plus-engine/private-fit-registry.mjs';
import {learnedCompositionEstimatorId} from '../../services/plus-engine/learned-composition.mjs';
import {validateNativeRecipeSelection} from './native-recipe-selection.mjs';

const fail=()=>{throw Object.assign(Error('REVIEWED_FIT_CONFIGURATION_INVALID'),{code:'REVIEWED_FIT_CONFIGURATION_INVALID'});};
const shape=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const selectionKey=s=>JSON.stringify([s.key,s.revision,s.engineId,s.definitionHash,s.bindingHash,s.scopeKey,s.classification]);
const bindingKey=s=>JSON.stringify([s.engineId,s.definitionHash,s.bindingHash,s.scopeKey,s.classification]);
const graph=['taskDomain','taskLearning','taskRules','evaluation','modelGovernance','actionIntervals','replayGovernance','beliefRuntime','scenarioPlanning','actionRequests','learnedCompositionReplay'];
// Internal loader identity only, never a cache of approval or current policy.
// Composition roots may receive an already-checked loader for the SAME exact
// private capability. Stacking that identical check at each graph level adds
// repeated file parsing/hash validation without adding an authority boundary.
const checkedRegistrations=new WeakMap();

export function validateReviewedFitDeployment(value){
  if(!shape(value,['version','tenantId','ontologyHash','policyHash','recipeSelections'])||value.version!=='plus-reviewed-native-fit-v1'
    ||typeof value.tenantId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(value.tenantId)||!hash(value.ontologyHash)||!hash(value.policyHash)
    ||!Array.isArray(value.recipeSelections)||value.recipeSelections.length<1||value.recipeSelections.length>10)fail();
  const keys=new Set();for(const raw of value.recipeSelections){let s;try{s=validateNativeRecipeSelection(raw);}catch{fail();}const key=selectionKey(s);
    if(s.engineId!==learnedCompositionEstimatorId||keys.has(key))fail();keys.add(key);}
  return structuredClone(value);
}
export function assertReviewedFitPolicy(deployment,policy){
  const initial=validateReviewedFitDeployment(deployment);
  if((knownPrivatePolicyDigest(policy)??digest(policy))!==initial.policyHash||graph.some(k=>policy?.[k]?.enabled!==true)
    ||!shape(policy.compute,['version','enabled','grants','workers'])||policy.compute.version!=='plus-private-compute-v4'||policy.compute.enabled!==true
    ||policy.computeAuthorizations?.version!=='plus-private-compute-authorizations-v1'||policy.computeAuthorizations.enabled!==true
    ||!Array.isArray(policy.computeAuthorizations.targets))fail();
  const targets=policy.computeAuthorizations.targets.filter(t=>t?.policy?.engineId===learnedCompositionEstimatorId);
  if(!targets.length||targets.some(t=>!initial.recipeSelections.some(s=>bindingKey(s)===bindingKey(t.policy)))
    ||initial.recipeSelections.some(s=>!targets.some(t=>bindingKey(s)===bindingKey(t.policy))))fail();
}

// A private operator-reviewed capability allowlist, NOT a native approval or
// evidence of efficacy. Its exact bytes and policy are pinned. Each real job
// still requires the SAME graph's independent native recipe/data/compute review.
// Unlike the synthetic constructor seam, this production path only supports
// native v4 authorizations. File jobs, arbitrary engines and "latest" are absent.
export function readReviewedFitDeployment(reference){
  if(!shape(reference,['path','sha256'])||!hash(reference.sha256)||typeof reference.path!=='string'||!isAbsolute(reference.path)||/[\x00-\x1f\x7f]/.test(reference.path))fail();
  let fd;
  try{
    fd=openSync(reference.path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));const stat=fstatSync(fd);
    if(!stat.isFile()||stat.nlink!==1||stat.size<1||stat.size>262144||process.platform!=='win32'&&(stat.uid!==process.getuid()||(stat.mode&0o077)!==0))fail();
    const bytes=readFileSync(fd);if(createHash('sha256').update(bytes).digest('hex')!==reference.sha256)fail();
    return validateReviewedFitDeployment(JSON.parse(bytes.toString('utf8')));
  }catch{fail();}finally{if(fd!==undefined)closeSync(fd);}
}

export function createReviewedNativeFitRegistration({tenantId,loadPolicy,reviewedCompleteFit}){
  if(typeof loadPolicy!=='function')fail();
  const existing=checkedRegistrations.get(loadPolicy);
  if(existing&&tenantId===existing.tenantId&&shape(reviewedCompleteFit,['path','sha256'])
    &&reviewedCompleteFit.path===existing.reference.path&&reviewedCompleteFit.sha256===existing.reference.sha256){
    loadPolicy(); // Reuse wiring, not a past grant: revalidate the live file now.
    return {...existing.registration};
  }
  const reference=structuredClone(reviewedCompleteFit),initial=readReviewedFitDeployment(reference);
  if(initial.tenantId!==tenantId)fail();
  const pins=new Set(initial.recipeSelections.map(selectionKey));
  const checkedLoad=()=>{
    const current=readReviewedFitDeployment(reference); // Deletion/replacement/permission change revokes new use.
    if(digest(current)!==digest(initial))fail();
    const policy=loadPolicy();assertReviewedFitPolicy(initial,policy);
    return policy;
  };
  checkedLoad();
  const allowsMetadata=item=>{
    checkedLoad();if(item?.engineId!==learnedCompositionEstimatorId)return registeredFitEngineIds.includes(item?.engineId);
    try{return pins.has(selectionKey(validateNativeRecipeSelection({key:item.key,revision:item.revision,engineId:item.engineId,definitionHash:item.definitionHash,
      bindingHash:item.bindingHash,scopeKey:item.scopeKey,classification:item.classification})));}catch{return false;}
  };
  const requireQualified=approved=>{
    checkedLoad();const r=approved?.record,p=approved?.payload;if(!r||!p||r.engineId!==p.engineId)fail();
    if(r.engineId!==learnedCompositionEstimatorId){if(!registeredFitEngineIds.includes(r.engineId))fail();return;}
    if(r._tenantId!==tenantId||r.status!=='APPROVED'||r.definitionHash!==p.compiled?.definitionHash||!allowsMetadata({key:r.recipeKey,revision:r.revision,
      engineId:r.engineId,definitionHash:r.definitionHash,bindingHash:p.config?.bindingHash,scopeKey:p.compiled?.definition?.scope?.key,classification:p.config?.classification}))fail();
  };
  const registration={engineIds:Object.freeze([...registeredFitEngineIds,learnedCompositionEstimatorId]),loadPolicy:checkedLoad,
    reviewedOntologyHash:initial.ontologyHash,nativeRecipeQualification:Object.freeze({allowsMetadata,requireQualified})};
  checkedRegistrations.set(checkedLoad,{tenantId,reference,registration:Object.freeze({...registration})});
  return registration;
}
