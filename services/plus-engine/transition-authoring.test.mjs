import test from 'node:test';
import assert from 'node:assert/strict';
import {compileDefinition,digest} from '../../platform/packages/plus-contracts/dist/index.js';
import {fixture} from '../../platform/packages/plus-contracts/tests/fixture.mjs';
import {transitionAuthoringLayout,buildAuthoredTransitionRecipe} from './transition-authoring.mjs';
const setup=(states=['A','B','C'],root='Machine')=>{
  const f=fixture({root,states,signal:'Reading',enumName:'OperatingState'});f.definition.variables.find(v=>v.key==='priority').support=[1,2];
  const compiled=compileDefinition(f.definition,f.context),binding={rootType:root,rootEpisodeLink:'RootEpisode'};
  // Pure shape fixture, NOT native ontology or inventory authority. The normal
  // authenticated integration test supplies the actual published catalog.
  const bundle={parsed:{linkTypes:[{name:'RootEpisode',from:root,to:'PlusEpisode'}]},manifests:{VerifyObject:f.manifest}};
  return {compiled,binding,bundle};
};
const config={supervisionKey:'generic.transition',supervisionRevision:1,stepMs:60000,maxSteps:8,controls:['WAIT','ACTION:verify'],nativeActions:['VerifyObject'],historyPolicyId:'explicit-history',maxPairs:10,maxTrajectories:5,
  classification:'SYNTHETIC',collectionPolicyHash:digest('collection'),populationPolicyHash:digest('population'),trainingProtocolHashes:[digest('training')],smoothingAlpha:1,minimumPairs:2,minimumTrajectories:1,minimumGroups:1,minimumPerCondition:1,minimumCoverage:1};
test('transition authoring compiles actual variable support, explicit time and information-control parameter sharing without fixed learned probabilities',()=>{
  const f=setup(),layout=transitionAuthoringLayout(f.compiled,f.binding,f.bundle),r=buildAuthoredTransitionRecipe(f.compiled,f.binding,f.bundle,config);
  assert.equal(layout.stateVariables[0].support.length,3);assert.equal(r.supervision.layout.states.length,3);assert.equal(r.supervision.layout.parameterControl['ACTION:verify'],'WAIT');
  assert.equal(r.schema,'plus-transition-recipe-v3');assert.equal(r.actionHistoryContract.version,'plus-native-action-interval-policy-v3');assert.equal(r.timeContract.stepMs,60000);
  assert.equal(r.supervision.predictionReady,false);assert.equal(Object.hasOwn(r,'table'),false);assert.equal(r.supervision.constraints.endpoints,'INDEPENDENT_CURRENTLY_QUALIFIED_GOLD');
  const different=setup(['X','Y','Z','W'],'Asset');assert.equal(buildAuthoredTransitionRecipe(different.compiled,different.binding,different.bundle,config).supervision.layout.states.length,4);
});
test('transition authoring refuses unknown actions, empty support, caller layout injection and inconsistent training budgets',()=>{
  const f=setup();for(const patch of [{nativeActions:['shell.execute']},{controls:['WAIT','ACTION:unknown']},{controls:['ACTION:verify']},{stepMs:0},{maxSteps:1025},{minimumGroups:5},{maxPairs:0},{smoothingAlpha:NaN},{contextSupport:{priority:[99]}}])
    assert.throws(()=>buildAuthoredTransitionRecipe(f.compiled,f.binding,f.bundle,{...config,...patch}));
  assert.throws(()=>transitionAuthoringLayout(f.compiled,f.binding,{...f.bundle,parsed:{linkTypes:[]}}),/EPISODE_LINK/);
  const unbounded=fixture();const c=compileDefinition(unbounded.definition,unbounded.context);assert.throws(()=>transitionAuthoringLayout(c,{rootType:'Task',rootEpisodeLink:'RootEpisode'},f.bundle),/SUPPORT/);
});
