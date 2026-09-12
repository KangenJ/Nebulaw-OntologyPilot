import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareNativeRecipePreview} from '../public-plus/native-recipe-ui.js';
// Form-only metadata doubles. These never supply native approval qualification.
const options={schema:'plus-recipe-authoring-options-v1',canDraft:true,input:{engineId:'ontology-composed-dynamics-v1'},optionsHash:'options',
  layout:{schema:'plus-complete-authoring-layout-v1',observations:[{recipeHash:'observation'}],transitions:[{recipeHash:'transition',component:{maxSteps:8}}],
    components:[{id:'decision',recipe:{hash:'transition'},decision:'APPROVE',recordedReadiness:'READY',revoked:false,configuredPolicyMatches:true}],transitionMechanisms:['SHARED_LEARNED_POINT_KERNEL']}};
const values={observationRecipe:'0',transitionRecipe:'0',componentDecision:'0',maxSteps:'4',transitionMechanisms:'0'};
test('complete form sends only selected native references and explicit coupling/time budget, never an approval or recipe payload',()=>{
  const v=prepareNativeRecipePreview(options,values);assert.equal(v.probabilities,null);assert.equal(v.config.maxSteps,4);assert.equal(v.config.transitionMechanisms,'SHARED_LEARNED_POINT_KERNEL');
  assert.deepEqual(Object.keys(v.config).sort(),['componentDecisionId','maxSteps','observationRecipeHash','transitionMechanisms','transitionRecipeHash']);
});
test('complete form refuses missing/revoked/mismatched components and unsupported or implicit time/coupling choices',()=>{
  for(const patch of [{componentDecision:'2'},{maxSteps:''},{maxSteps:'9'},{maxSteps:'1.5'},{transitionMechanisms:''}])assert.throws(()=>prepareNativeRecipePreview(options,{...values,...patch}));
  for(const patch of [{revoked:true},{recordedReadiness:'SUSPENDED'},{configuredPolicyMatches:false},{recipe:{hash:'other'}},{decision:'REJECT'}])assert.throws(()=>prepareNativeRecipePreview({...options,layout:{...options.layout,components:[{...options.layout.components[0],...patch}]}},values));
});
