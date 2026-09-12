import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { validateRegisteredRecipe } from './estimator-registry.mjs';
import { EngineError } from './finite-engine.mjs';

// Native recipe/dependency qualification. The separate FIT-only registry may
// train candidates; neither recipe approval nor FIT grants online eligibility.
export const compositionEstimatorId='ontology-composed-observation-v1';
const fail=code=>{throw new EngineError(code);};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
export function compositionRecipe({compiled,composition,statistics,ruleSpecification}){
  const payload=structuredClone({schema:'plus-composition-observation-recipe-v1',engineId:compositionEstimatorId,compiled,composition,statistics,
    config:statistics.config,ruleSpecificationHash:ruleSpecification.specificationHash,
    nativeDependencies:[{kind:'RULE_SPECIFICATION',id:ruleSpecification._id,version:ruleSpecification._version,hash:digest(ruleSpecification)}]});
  return {recipe:payload,recipeHash:digest(payload)};
}

/** Native parent and rule/source qualification providers are trusted server
 * dependencies. This never accepts a draft's approval boolean or worker URL. */
export function createNativeCompositionRecipeValidation({definitions,ruleSpecifications}){
  if(typeof definitions?.previewComposition!=='function'||typeof ruleSpecifications?.requireApproved!=='function')fail('COMPOSITION_RECIPE_QUALIFIER_REQUIRED');
  async function validateRecipe(payload,compiled,p){
    if(!exact(payload,['schema','engineId','compiled','composition','statistics','config','ruleSpecificationHash','nativeDependencies'])
      ||payload.schema!=='plus-composition-observation-recipe-v1'||payload.engineId!==compositionEstimatorId
      ||digest(payload.compiled)!==digest(compiled)||!Array.isArray(payload.nativeDependencies)||payload.nativeDependencies.length!==1
      ||!/^[a-f0-9]{64}$/.test(payload.ruleSpecificationHash??''))fail('COMPOSITION_RECIPE_INVALID');
    const preview=await definitions.previewComposition(compiled.definition.key,p);
    if(preview.reviewRequired!==true||preview.predictionReady!==false||digest(payload.composition)!==digest(preview.composition)
      ||preview.composition.parent.definitionHash!==compiled.definitionHash||digest(payload.config)!==digest(payload.statistics?.config))fail('COMPOSITION_RECIPE_STALE');
    // Inner statistical validators are fixed code-owned U2/U3 implementations.
    // An outer model cannot smuggle new network/capacity/feature semantics.
    await validateRegisteredRecipe(payload.statistics,preview.composition.statistics);
  }
  async function qualifyDependencies(payload,compiled,p){
    const dependency=payload.nativeDependencies?.[0];
    if(payload.engineId!==compositionEstimatorId||payload.nativeDependencies?.length!==1
      ||!exact(dependency,['kind','id','version','hash'])||dependency.kind!=='RULE_SPECIFICATION')fail('COMPOSITION_RECIPE_DEPENDENCY_INVALID');
    const rule=await ruleSpecifications.requireApproved(payload.ruleSpecificationHash,p),row=rule.record;
    if(rule.authorityChecked!==true||row?.status!=='APPROVED'||row._id!==dependency.id||row._version!==dependency.version||digest(row)!==dependency.hash
      ||row.specificationHash!==payload.ruleSpecificationHash||row.definitionHash!==compiled.definitionHash||digest(rule.compiled)!==digest(compiled))fail('COMPOSITION_RECIPE_DEPENDENCY_STALE');
  }
  return {validateRecipe,qualifyDependencies};
}
