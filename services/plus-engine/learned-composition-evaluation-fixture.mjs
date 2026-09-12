import assert from 'node:assert/strict';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { NativeComputeAdmission,NativeEvaluationProtocolRegistry,NativeModelEvaluation,NativeLearnedCompositionEvaluationPopulation,NativeLearnedCompositionEvaluationHistory,learnedCompositionStateEvaluatorId,NativeModelDeployment,NativePublishedModelReference,NativeModelDecision } from '../../platform/packages/plus-runtime/dist/index.js';
import { ctx,trainer,owner,at } from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import { learnedCompositionStateFixture } from './learned-composition-state-fixture.mjs';
import { createPrivateActionIntervalServices } from '../../ops/plus-v2/action-interval-services.mjs';
import { createNativeLearnedCompositionFitVerifier } from './learned-composition-fit.mjs';
import { fitInProcess } from './fit-worker.mjs';
import { privateFitRequest } from './private-fit-registry.mjs';
import { createLearnedCompositionStateEvaluator,validateLearnedCompositionStateConfiguration } from './learned-composition-state-evaluation.mjs';

// Actual native Task cohorts/data, complete compute lifecycle with fixed child,
// prospective native protocol, population/history and native evaluation. ONLY
// outer component/recipe admission and protected-material approval are explicit
// doubles; not a complete actual component-decision or private-host acceptance.
export async function learnedCompositionEvaluationFixture(t,{missing=false,published=false,coldStart=false,sharedComputeReads=false,evaluationFactory}={}){
  assert.ok(!(published&&coldStart));
  const f=await learnedCompositionStateFixture(t,false,{missing,protocolFactory:async f=>{
    const recipeHash=digest(f.recipe),worker={id:'complete-score-worker',tenantId:ctx.tenantId,roles:['plus_compute_worker']};f.people.set(worker.id,worker);
    const policy=f.recipe.transition.actionHistoryContract;
    f.policy.actionIntervals.targets.push(...f.members.map(m=>({episodeId:m.episode._id,rootId:m.task._id,purpose:'LEARNED_COMPOSITION_VALIDATE',policy})));
    f.policy.actionIntervals.grants[0].episodeIds.push(...f.members.map(m=>m.episode._id));
    if(coldStart)f.policy.actionIntervals.grants.push({...structuredClone(f.policy.actionIntervals.grants[0]),principalId:owner.id,requiredRoles:owner.roles});
    const inventory=createPrivateActionIntervalServices({...f.options,usagePurpose:'LEARNED_COMPOSITION_VALIDATE',requests:{read:async()=>assert.fail('Fixture has no governed requests')}});
    const authority=async()=>digest({policy:f.policy,people:[...f.people.values()],state:f.state,approvalDouble:state});
    const definition=await f.definitions.requirePublished(f.compiled.definition.key,trainer);
    const record=await f.storage.createObject(ctx,'PlusModelRecipe',{recipeKey:'explicit-complete-admission-double',recipeHash,engineId:f.recipe.engineId,
      revisionKey:digest('complete-admission-double'),revision:1,definitionKey:f.compiled.definition.key,definitionReference:{id:definition.record._id,version:definition.record._version,compiledHash:digest(definition.compiled)},payload:f.recipe,
      policyHash:digest('complete-recipe-policy-double'),submittedBy:trainer.id,submittedAt:at(32),definitionHash:f.compiled.definitionHash,proposalHash:digest('double'),status:'APPROVED'});
    const state={recipeAllowed:true,materialAllowed:true,publicationAllowed:true};
    const recipes={requireApproved:async(hash,p)=>{assert.equal(hash,recipeHash);assert.ok(f.people.has(p.id));if(!state.recipeAllowed)throw Error('COMPLETE_RECIPE_DOUBLE_REVOKED');return {record:structuredClone(record),payload:structuredClone(f.recipe)};}};
    const observation={datasets:[],materials:f.materials},transition={datasets:[],materials:[]};
    for(const r of f.frozenRows){const row=await f.storage.getObject(ctx,'PlusDatasetRevision',r.id);observation.datasets.push({id:row._id,version:row._version,hash:row.contentHash});}
    for(const id of f.transitionDatasetIds){const row=await f.storage.getObject(ctx,'PlusDatasetRevision',id);transition.datasets.push({id,version:row._version,hash:row.contentHash});transition.materials.push(await f.services.datasets.materialize(id,'FIT',trainer));}
    const sources=new Map(),samples=new Map(),datasets=[];
    for(const [use,part]of [['OBSERVATION',observation],['TRANSITION',transition]])part.datasets.forEach((reference,i)=>{
      datasets.push({reference,uses:[use]});for(const ref of part.materials[i].sourceManifest.sourceRefs)sources.set(ref.id,ref);
      for(const sample of part.materials[i].sourceManifest.samples)samples.set(sample.sampleKey,sample);
    });
    const body={schema:'plus-learned-composition-fit-material-v1',purpose:'FIT',tenantId:ctx.tenantId,recipeHash,recipeReference:{id:record._id,version:record._version,hash:recipeHash},component:{decision:f.recipe.nativeDependencies[1]},
      observation,transition:{...transition,recipe:f.recipe.transition,candidate:f.transitionCandidate,material:f.transitionMaterials[0],exposure:{id:'explicit-component-exposure-double',version:1,hash:digest('component-exposure-double')}},
      closure:{datasets:datasets.sort((a,b)=>a.reference.id.localeCompare(b.reference.id)),sourceRefs:[...sources.values()].sort((a,b)=>a.id.localeCompare(b.id)),
        samples:[...samples.values()].map(({sampleKey,entityKey,splitGroupHash})=>({sampleKey,entityKey,splitGroupHash})).sort((a,b)=>a.sampleKey.localeCompare(b.sampleKey))},
      nativeReadQualificationsChecked:true,evaluationAuthorized:false,predictionReady:false};
    const material={...body,contentHash:digest(body)};
    const materialProvider={materializeForFit:async(hash,ids,p)=>{
      assert.equal(hash,recipeHash);assert.deepEqual(ids,[...observation.datasets.map(r=>r.id)].sort());if(!state.materialAllowed)throw Error('COMPLETE_COMPONENT_DOUBLE_REVOKED');
      for(const part of [observation,transition])for(const [i,ref]of part.datasets.entries())assert.deepEqual(await f.services.datasets.materialize(ref.id,'FIT',p),part.materials[i]);
      return structuredClone(material);
    },revalidateForFit:async(saved,p)=>{assert.deepEqual(saved,await materialProvider.materializeForFit(recipeHash,observation.datasets.map(r=>r.id).sort(),p));return {nativeQualificationChecked:true,contentHash:material.contentHash};}};
    const computeConfig={storage:f.storage,tenantId:ctx.tenantId,datasets:f.services.datasets,recipes,learnedComposition:materialProvider,
      // Explicit scoped fixture authority includes ALL synthetic approval and
      // source-provider state. This does not claim canonical host qualification.
      ...(sharedComputeReads?{readConsistency:'SHARED_NATIVE_AND_AUTHORITY',authorizationRevision:authority}:{}),
      verifyLearnedCompositionFitResult:createNativeLearnedCompositionFitVerifier({recipes}),clock:f.options.clock,
      authorize:async p=>[trainer.id,worker.id,owner.id].includes(p.id),resolvePrincipal:f.options.identities.resolvePrincipal,
      policyFor:async()=>({version:'plus-compute-policy-v1',workerId:worker.id,engineId:f.recipe.engineId,recipeHash,leaseMs:300000,maxAttempts:2})};
    const compute=new NativeComputeAdmission(computeConfig);let fit=await compute.enqueue(observation.datasets[0].id,'FIT',trainer,'complete-state-evaluation-fit');
    const lease=await compute.claim(fit.id,worker),candidate=await fitInProcess(privateFitRequest(f.recipe,[lease.compositionInput.material]));
    let completion=await compute.completeFit(fit.id,lease.version,lease.leaseToken,candidate,worker),publication;
    if(published){
      // Real native selection/history and reference, but FIRST admission remains
      // an explicit double until cold-start and whole-model decisions qualify.
      const release=await f.storage.getObject(ctx,'PlusModelRelease',completion.candidateId),originalFit=fit;
      const policy={version:'plus-model-admission-v1',id:'EXPLICIT_COMPLETE_ADMISSION_DOUBLE',definitionHash:f.compiled.definitionHash,bindingHash:f.recipe.config.bindingHash,
        scopeKey:f.compiled.definition.scope.key,classification:'SYNTHETIC',task:'STATE_ESTIMATION',clockHash:digest(f.recipe.clock)};
      const decision=await f.storage.createObject(ctx,'PlusModelDecision',{decisionKey:'explicit-reference-admission-double',policyKey:'explicit-reference-admission-double',decision:'APPROVE',
        reason:'EXPLICIT first admission double; not cold-start qualification',policy,inputReadSet:{recipe:{id:record._id,version:record._version,hash:recipeHash},release:{id:release._id,version:release._version,hash:digest(release)}},
        createdBy:owner.id,createdAt:at(32),contentHash:digest('explicit-reference-admission-double'),readiness:'READY'});
      const {version:_version,id:_id,...target}=policy;
      const deployments=new NativeModelDeployment({storage:f.storage,tenantId:ctx.tenantId,decisions:{requireApproved:async(id,p)=>{
        assert.equal(id,decision._id);assert.ok(f.people.has(p.id));if(!state.publicationAllowed)throw Error('PUBLICATION_ADMISSION_DOUBLE_REVOKED');return {record:structuredClone(decision),modelApproved:true,modelDeploymentAuthorized:false};}},
        authorize:async p=>[trainer.id,owner.id].includes(p.id),targetFor:async()=>structuredClone(target),authorizationRevision:authority,readConsistency:'SHARED_NATIVE_AND_AUTHORITY',clock:f.options.clock});
      const activation={key:'complete.reference',expectedVersion:0,decisionId:decision._id,requestKey:'first-selection',reason:'Synthetic native pointer; admission is explicitly doubled'};
      const selected=await deployments.activate(activation,owner);
      const references=new NativePublishedModelReference({storage:f.storage,tenantId:ctx.tenantId,deployments,recipes,compute,learnedCompositionCompute:compute,authorizationRevision:authority});
      // A different native FIT execution with the same frozen recipe/TRAIN:
      // isolates governance comparison, NOT a new learning round or efficacy.
      fit=await compute.enqueue(observation.datasets[0].id,'FIT',trainer,'complete-state-comparison-candidate');
      const nextLease=await compute.claim(fit.id,worker),next=await fitInProcess(privateFitRequest(f.recipe,[nextLease.compositionInput.material]));
      completion=await compute.completeFit(fit.id,nextLease.version,nextLease.leaseToken,next,worker);
      publication={references,deployments,selected,activation,decision,originalFit,release};
    }
    let coldStartServices;
    if(coldStart){
      const policy={version:'plus-model-admission-v1',id:'complete-native-cold-start',definitionHash:f.compiled.definitionHash,bindingHash:f.recipe.config.bindingHash,
        scopeKey:f.compiled.definition.scope.key,classification:'SYNTHETIC',task:'STATE_ESTIMATION',clockHash:digest(f.recipe.clock)};
      const {version:_version,id:_id,...target}=policy,holder={current:null};
      // Construction-cycle adapter only. Every use delegates to the actual
      // NativeModelDecision; it cannot manufacture an approval result.
      const deploymentConfig={storage:f.storage,tenantId:ctx.tenantId,decisions:{requireApproved:(...args)=>{assert.ok(holder.current);return holder.current.requireApproved(...args);}},
        authorize:async p=>[trainer.id,owner.id].includes(p.id),targetFor:async()=>structuredClone(target),authorizationRevision:authority,readConsistency:'SHARED_NATIVE_AND_AUTHORITY',clock:f.options.clock};
      coldStartServices={deployments:new NativeModelDeployment(deploymentConfig),deploymentConfig,policy,holder};
    }
    const protocolConfig={storage:f.storage,tenantId:ctx.tenantId,recipes,datasets:f.services.datasets,authorize:async p=>[trainer.id,owner.id].includes(p.id),
      ...(publication?{learnedCompositionReferences:publication.references}:{}),
      ...(coldStartServices?{coldStarts:coldStartServices.deployments}:{}),
      policyFor:async()=>({version:'plus-evaluation-purpose-v1',id:'complete-state-native-protocol',recipeHashes:[recipeHash],evaluatorIds:[learnedCompositionStateEvaluatorId],classifications:['SYNTHETIC'],
        ...(publication?{reference:{mode:'CURRENT_PUBLICATION',controlKey:'complete.reference'}}:coldStartServices?{reference:{mode:'COLD_START',controlKey:'complete.first-model'}}:{})}),
      validateConfiguration:validateLearnedCompositionStateConfiguration,clock:f.options.clock};
    // Test-only assembly hook runs BEFORE held-out labels. It may wire real
    // private factories/HTTP, not replace a recorded score or approve a model.
    const privateServices=await evaluationFactory?.({fixture:f,recipes,compute,computeConfig,inventory,protocolConfig,coldStartServices,state});
    const protocols=privateServices?.protocols??new NativeEvaluationProtocolRegistry(protocolConfig),draft=await protocols.propose({key:'complete-state-native-score',revision:1,recipeHash,cohortIds:[f.cohort.id],
      evaluatorId:learnedCompositionStateEvaluatorId,configuration:{minimumSamples:f.missing?1:2,minimumCoverage:f.missing?0.5:1,maximumNllRegression:0,maximumBrierRegression:0,task:'STATE_ESTIMATION',clock:f.recipe.clock}},trainer);
    const approved=await protocols.review(draft.id,draft.version,'APPROVE','Actual protocol before heldout GOLD; synthetic data only',owner);
    const population=new NativeLearnedCompositionEvaluationPopulation({storage:f.storage,tenantId:ctx.tenantId,compute,protocols,datasets:f.services.datasets,partitions:f.services.partitions,
      ...(publication?{publishedReferences:publication.references}:{}),authorize:async p=>p.id===trainer.id||coldStart&&p.id===owner.id,authorizationRevision:authority});
    const history=new NativeLearnedCompositionEvaluationHistory({storage:f.storage,tenantId:ctx.tenantId,protocols,recipes,datasets:f.services.datasets,episodes:f.episodes,
      actionIntervals:inventory.actionIntervals,historyAuthority:inventory.historyAuthority,authorize:async p=>p.id===trainer.id||coldStart&&p.id===owner.id,authorizationRevision:authority,clock:f.options.clock});
    return {compute,computeConfig,fit,completion,protocols,protocolConfig,approved,population,history,authority,state,material,recipes,candidate,publication,coldStartServices,privateServices};
  }});
  const setup=f.evaluationSetup,config={storage:f.storage,tenantId:ctx.tenantId,protocols:setup.protocols,compute:setup.compute,datasets:f.services.datasets,recipes:setup.recipes,
    learnedComposition:{population:setup.population,history:setup.history},authorize:async p=>p.id===trainer.id||coldStart&&p.id===owner.id,evaluator:createLearnedCompositionStateEvaluator(),
    authorizationRevision:setup.authority,readConsistency:'SHARED_NATIVE_AND_AUTHORITY',clock:f.options.clock};
  const evaluations=new NativeModelEvaluation(config);
  if(setup.coldStartServices){const c=setup.coldStartServices;
    c.decisionConfig={storage:f.storage,tenantId:ctx.tenantId,evaluations,recipes:setup.recipes,coldStarts:c.deployments,
      authorize:async p=>[trainer.id,owner.id].includes(p.id),policyFor:async()=>structuredClone(c.policy),authorizationRevision:setup.authority,readConsistency:'SHARED_NATIVE_AND_AUTHORITY',clock:f.options.clock};
    c.decisions=new NativeModelDecision(c.decisionConfig);c.holder.current=c.decisions;
  }
  return {...f,...setup,config,evaluations,evaluationInput:{protocolId:setup.approved.id,executionId:setup.fit.id,validationDatasetIds:[f.validation.id]}};
}
