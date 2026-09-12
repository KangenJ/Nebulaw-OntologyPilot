import {compileTransitionSupervision,digest} from '../../platform/packages/plus-contracts/dist/index.js';
import {transitionRecipe} from './transition-fit.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const name=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(v);

// Pure authoring, never native inventory authority. Current catalog/definition
// and independent recipe review are supplied by the platform around this code.
export function transitionAuthoringLayout(compiled,binding,bundle){
  if(compiled?.definitionHash!==digest(compiled?.definition)||compiled?.dependencyHash!==digest(compiled?.dependencies)
    ||binding?.rootType!==compiled.definition.rootType)fail('TRANSITION_AUTHORING_PARENT');
  const modules=compiled.definition.modules.filter(m=>m.kind==='TRANSITION');
  if(modules.length!==1)fail('TRANSITION_AUTHORING_MODULE');
  const stateVariables=compiled.variables.filter(v=>v.role==='LATENT').sort((a,b)=>a.key.localeCompare(b.key));
  const contextVariables=modules[0].inputs.map(k=>compiled.variables.find(v=>v.key===k)).filter(v=>v?.role==='CONTEXT').sort((a,b)=>a.key.localeCompare(b.key));
  if(!stateVariables.length||[...stateVariables,...contextVariables].some(v=>!v.support.length||v.support.length>16||v.sourceType.isList||v.referenceType
    ||v.support.some(x=>v.unknownValues.includes(x))))fail('TRANSITION_AUTHORING_SUPPORT');
  const link=bundle?.parsed?.linkTypes.find(l=>l.name===binding.rootEpisodeLink);
  if(!link||link.from!==binding.rootType||link.to!=='PlusEpisode')fail('TRANSITION_AUTHORING_EPISODE_LINK');
  const nativeActions=Object.keys(bundle.manifests).sort();
  if(!nativeActions.length||nativeActions.length>32||compiled.definition.actions.some(a=>!nativeActions.includes(a.nativeAction)))fail('TRANSITION_AUTHORING_ACTIONS');
  const contextSupport=Object.fromEntries(contextVariables.map(v=>[v.key,[...v.support]]));
  return {schema:'plus-transition-authoring-layout-v1',transitionModule:modules[0].key,bindingHash:digest(binding),rootType:binding.rootType,rootEpisodeLink:binding.rootEpisodeLink,
    stateVariables:stateVariables.map(v=>({key:v.key,support:[...v.support],verification:structuredClone(v.verification)})),contextSupport,
    controls:['WAIT',...compiled.definition.actions.map(a=>'ACTION:'+a.key)].sort(),nativeActions,
    requiredNativeActions:[...new Set(compiled.definition.actions.map(a=>a.nativeAction))].sort(),
    semantics:'OBSERVED_NATIVE_HISTORY_NOT_CAUSAL',missingSupport:'UNAVAILABLE_NOT_SMOOTHED_EVIDENCE',
    trainingAuthorized:false,predictionReady:false};
}

export function buildAuthoredTransitionRecipe(compiled,binding,bundle,raw){
  if(!exact(raw,['supervisionKey','supervisionRevision','stepMs','maxSteps','controls','nativeActions','historyPolicyId','maxPairs','maxTrajectories',
    'classification','collectionPolicyHash','populationPolicyHash','trainingProtocolHashes','smoothingAlpha','minimumPairs','minimumTrajectories','minimumGroups','minimumPerCondition','minimumCoverage']))fail('TRANSITION_AUTHORING_CONFIG');
  const layout=transitionAuthoringLayout(compiled,binding,bundle),c=structuredClone(raw);
  if(!name(c.historyPolicyId)||!Array.isArray(c.controls)||!c.controls.length||c.controls.some(k=>!layout.controls.includes(k))
    ||!Array.isArray(c.nativeActions)||!c.nativeActions.length||new Set(c.nativeActions).size!==c.nativeActions.length||c.nativeActions.some(k=>!layout.nativeActions.includes(k))
    ||layout.requiredNativeActions.some(k=>!c.nativeActions.includes(k)))fail('TRANSITION_AUTHORING_ACTIONS');
  const time={schema:'plus-transition-time-v1',definitionHash:compiled.definitionHash,bindingHash:layout.bindingHash,stepMs:c.stepMs,maxSteps:c.maxSteps,
    origin:'EPISODE_STARTED_AT',alignment:'EXACT_GRID',contextKnowledge:'INTERVAL_START',endpointKnowledge:'PRELABEL_SNAPSHOT',actionWindow:'HALF_OPEN',actionTimestamp:'NATIVE_EXECUTION_RECEIPT'};
  const supervision=compileTransitionSupervision({schema:'plus-transition-supervision-v1',key:c.supervisionKey,revision:c.supervisionRevision,parentDefinitionHash:compiled.definitionHash,
    bindingHash:layout.bindingHash,timeContractHash:digest(time),transitionModule:layout.transitionModule,classification:c.classification,collectionPolicyHash:c.collectionPolicyHash,
    populationPolicyHash:c.populationPolicyHash,stepMs:c.stepMs,contextSupport:layout.contextSupport,controls:c.controls,
    sampling:'ALL_ADJACENT_PRE_ENROLLED_PAIRS',actionSemantics:'OBSERVED_NATIVE_HISTORY_NOT_CAUSAL',budget:{maxPairs:c.maxPairs,maxTrajectories:c.maxTrajectories}},compiled);
  const history={version:'plus-native-action-interval-policy-v3',id:c.historyPolicyId,rootType:layout.rootType,rootEpisodeLink:layout.rootEpisodeLink,
    nativeActions:[...c.nativeActions].sort(),inventory:'TENANT_WIDE',orphanPolicy:'REJECT_INTERVAL'};
  const config=Object.fromEntries(['classification','collectionPolicyHash','populationPolicyHash','trainingProtocolHashes','smoothingAlpha','minimumPairs','minimumTrajectories','minimumGroups','minimumPerCondition','minimumCoverage'].map(k=>[k,c[k]]));
  return transitionRecipe(compiled,supervision,config,time,history).recipe;
}
