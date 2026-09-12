import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareNativeRecipePreview} from '../public-plus/native-recipe-ui.js';
const options={schema:'plus-recipe-authoring-options-v1',canDraft:true,input:{engineId:'ontology-finite-transition-counts-v1'},optionsHash:'options',populationPolicyHashes:['population'],
  layout:{schema:'plus-transition-authoring-layout-v1',stateVariables:[{key:'state'}],controls:['WAIT','ACTION:verify'],nativeActions:['VerifyObject'],requiredNativeActions:['VerifyObject']},
  trainingProtocols:[{key:'train-a',variable:'state',classification:'SYNTHETIC',collectionPolicyHash:'collection',hash:'a'},{key:'train-b',variable:'state',classification:'SYNTHETIC',collectionPolicyHash:'collection',hash:'b'}]};
const values={trainingProtocolKeys:'train-a,train-b',population:'0',supervisionKey:'reviewed.transition',supervisionRevision:'1',stepMs:'60000',maxSteps:'8',controls:'WAIT,ACTION:verify',nativeActions:'VerifyObject',historyPolicyId:'reviewed-history',maxPairs:'10',maxTrajectories:'5',smoothingAlpha:'1',minimumPairs:'2',minimumTrajectories:'1',minimumGroups:'1',minimumPerCondition:'1',minimumCoverage:'1'};
test('typed transition form binds multiple selected TRAIN protocols and explicit time/budgets, never asks for learned probability values',()=>{
  const r=prepareNativeRecipePreview(options,values);assert.equal(r.probabilities,null);assert.equal(r.ruleSpecificationHash,null);assert.deepEqual(r.config.trainingProtocolHashes,['a','b']);assert.equal(r.config.stepMs,60000);assert.equal(r.config.minimumPairs,2);
  assert.equal(Object.hasOwn(r.config,'bindingHash'),false);assert.equal(Object.hasOwn(r,'compiled'),false);
});
test('transition form rejects arbitrary or incomplete sources/actions, missing variables and nonnumeric or inconsistent thresholds',()=>{
  for(const patch of [{trainingProtocolKeys:'train-a,unknown'},{trainingProtocolKeys:'train-a,train-a'},{controls:'ACTION:verify'},{nativeActions:'shell'},{stepMs:''},{stepMs:'Infinity'},{maxSteps:'1.5'},{minimumGroups:'2'},{maxPairs:'1'},{population:'3'}])assert.throws(()=>prepareNativeRecipePreview(options,{...values,...patch}));
  assert.throws(()=>prepareNativeRecipePreview({...options,layout:{...options.layout,stateVariables:[{key:'state'},{key:'other'}]}},values));
});
