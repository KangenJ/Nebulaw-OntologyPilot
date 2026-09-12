import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { createPrivateAuthorizationRevision } from './private-authority.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const key=v=>typeof v==='string'&&v.length>0&&v.length<=256&&v.trim()===v&&!/[\x00-\x1f\x7f]/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const shape=['key','revision','engineId','definitionHash','bindingHash','scopeKey','classification'];
export function validateNativeRecipeSelection(v){
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==[...shape].sort().join(',')
    ||!key(v.key)||!Number.isSafeInteger(v.revision)||v.revision<1||!key(v.engineId)||!key(v.scopeKey)
    ||!hash(v.definitionHash)||!hash(v.bindingHash)||!['SYNTHETIC','AUTHORIZED_REAL'].includes(v.classification))fail('NATIVE_RECIPE_SELECTION_INVALID');
  return structuredClone(v);
}
/** Exact predeclared key/revision, NOT latest, wildcard, client hash or approval.
 * The fixed same-graph native registry must independently qualify current use.
 * File grants stay unchanged when that exact revision is later approved.
 */
export function createNativeRecipeSelectionResolver({storage,tenantId,identities,loadPolicy,reauthenticate,recipes}){
  return createResolver({storage,tenantId,identities,loadPolicy,reauthenticate,recipes},true);
}
/** Server-only metadata binding for NativeComputeAdmission's SAME-graph policy
 * lookup. It is NOT recipe:use qualification: the native compute lifecycle must
 * still call requireApproved before material, commit, delivery and result use.
 * No caller flag, payload, approval certificate or cross-invocation cache. Other
 * consumers keep the fully qualified selection resolver above.
 */
export function createNativeComputeRecipeBindingResolver({storage,tenantId,identities,loadPolicy,reauthenticate,recipes}){
  if(typeof storage?.getObject!=='function')fail('NATIVE_RECIPE_SELECTION_PROVIDER_REQUIRED');
  return createResolver({storage,tenantId,identities,loadPolicy,reauthenticate,recipes},false);
}
function createResolver({storage,tenantId,identities,loadPolicy,reauthenticate,recipes},qualifyUse){
  if(typeof storage?.getReadRevision!=='function'||typeof recipes?.listRevisions!=='function'||typeof recipes?.requireApproved!=='function')fail('NATIVE_RECIPE_SELECTION_PROVIDER_REQUIRED');
  const authority=createPrivateAuthorizationRevision({tenantId,identities,loadPolicy,reauthenticate});
  return {async resolve(raw,principal){
    const selection=validateNativeRecipeSelection(raw),p=structuredClone(principal),revision=await authority(p),ctx={tenantId:p.tenantId,actorId:p.id};
    const epoch=await storage.getReadRevision(ctx),rows=await recipes.listRevisions(selection.key,p);
    if(!Array.isArray(rows)||rows.length>1000)fail('NATIVE_RECIPE_SELECTION_INTEGRITY');
    const found=rows.filter(r=>r.revision===selection.revision);
    if(found.length!==1||found[0].status!=='APPROVED')fail('NATIVE_RECIPE_SELECTION_NOT_APPROVED');
    const summary=found[0];if(!key(summary.id)||!Number.isSafeInteger(summary.version)||summary.version<1||!hash(summary.recipeHash))fail('NATIVE_RECIPE_SELECTION_INTEGRITY');
    // listRevisions has already authorized recipe:read and checked native row,
    // approval history and dependency-link integrity. The following private row
    // read checks the complete planned binding but never returns its payload.
    // Native epoch and current authority fence this entire lookup, including
    // identity expiry and mutations after the metadata list was returned.
    const qualified=qualifyUse?await recipes.requireApproved(summary.recipeHash,p,'recipe:use'):undefined;
    if(qualifyUse&&(!qualified||typeof qualified!=='object'||Array.isArray(qualified)))fail('NATIVE_RECIPE_SELECTION_INTEGRITY');
    const record=qualifyUse?qualified.record:await storage.getObject(ctx,'PlusModelRecipe',summary.id);
    const payload=qualifyUse?qualified.payload:record?.payload;
    if(!record||record._deletedAt||record._tenantId!==tenantId||record._id!==summary.id||record._version!==summary.version
      ||record.recipeKey!==selection.key||record.revision!==selection.revision||record.status!=='APPROVED'
      ||record.recipeHash!==summary.recipeHash||digest(payload)!==summary.recipeHash||digest(record.payload)!==summary.recipeHash
      ||record.engineId!==selection.engineId||payload.engineId!==selection.engineId||record.definitionHash!==selection.definitionHash
      ||payload.compiled?.definitionHash!==selection.definitionHash||payload.compiled?.definition?.scope?.key!==selection.scopeKey
      ||payload.config?.bindingHash!==selection.bindingHash||payload.config?.classification!==selection.classification)fail('NATIVE_RECIPE_SELECTION_MISMATCH');
    if(await authority(p)!==revision)fail('NATIVE_RECIPE_SELECTION_AUTHORITY_STALE');
    if(await storage.getReadRevision(ctx)!==epoch)fail('NATIVE_RECIPE_SELECTION_CONFLICT');
    return {recipeHash:summary.recipeHash,reference:{id:record._id,version:record._version,hash:summary.recipeHash}};
  }};
}
