// Shared synthetic native belief fixture. Real storage, fitting and filtering;
// upstream approval/recipe/FIT handoffs are explicit governance doubles.
import assert from 'node:assert/strict';
import { digest } from '@openfoundry/plus-contracts';
import { NativeBeliefRuntime } from '../dist/index.js';
import { episodeFixture,principal,ctx,at } from './episode-fixture.mjs';
import { baselineFor,fittingConfig,syntheticMaterialForUnitTest,rehash } from '../../../../services/plus-engine/observation-fit-fixture.mjs';
import { fitObservationModel } from '../../../../services/plus-engine/observation-fit.mjs';
import { observationRecipe } from '../../../../services/plus-engine/native-fit-verifier.mjs';
import { createObservationReplayEngine } from '../../../../services/plus-engine/online-replay.mjs';
export async function beliefFixture(t,{batchTraining=false}={}){
  const f=await episodeFixture(t);f.config.qualifyContextHistory=async()=>({allowed:true,policyHash:digest('native-belief-history')});
  const published=await f.definitions.requirePublished(f.definition.key,principal),compiled=published.compiled,bindingHash=digest(f.binding),baseline=baselineFor(compiled);
  const trainRoot=await f.storage.createObject(ctx,'Machine',{actual:'UNKNOWN',status:'REGISTERED',priority:1,createdAt:at(0),receivedAt:at(0),classification:'SYNTHETIC'});
  const trainReport=await f.add({rootId:trainRoot._id,origin:'training-report'}),trainGold=await f.add({rootId:trainRoot._id,origin:'training-gold',kind:'VERIFICATION',minute:1,received:3});
  const material=syntheticMaterialForUnitTest(compiled,'belief-native-unit',[{state:'READY',report:'READY'}]),sample=material.sourceManifest.samples[0];
  sample.entityKey=digest([ctx.tenantId,'Machine',trainRoot._id]);sample.input.bindingHash=bindingHash;
  sample.input.events[0].key=trainReport.event.sourceKey;sample.input.events[0].dependenceKey=digest([trainReport.event.sourceSystem,trainReport.event.sourceRecordId]);
  material.sourceManifest.sourceRefs=[trainReport.event,trainGold.event].map(e=>({id:e._id,version:e._version,hash:e.contentHash}));rehash(material);
  const materials=[material];let secondTraining;
  if(batchTraining){
    const root=await f.storage.createObject(ctx,'Machine',{actual:'UNKNOWN',status:'REGISTERED',priority:1,createdAt:at(0),receivedAt:at(0),classification:'SYNTHETIC'});
    const report=await f.add({rootId:root._id,origin:'second-training-report'}),gold=await f.add({rootId:root._id,origin:'second-training-gold',kind:'VERIFICATION',minute:1,received:3});
    const data=syntheticMaterialForUnitTest(compiled,'belief-native-unit-second',[{state:'READY',report:'READY'}]),s=data.sourceManifest.samples[0];
    s.entityKey=digest([ctx.tenantId,'Machine',root._id]);s.input.bindingHash=bindingHash;s.input.events[0].key=report.event.sourceKey;s.input.events[0].dependenceKey=digest([report.event.sourceSystem,report.event.sourceRecordId]);
    data.sourceManifest.sourceRefs=[report.event,gold.event].map(e=>({id:e._id,version:e._version,hash:e.contentHash}));rehash(data);materials.push(data);secondTraining={root,report,gold};
  }
  const config=fittingConfig(materials.map(m=>m.sourceManifest.protocol),bindingHash),candidate=fitObservationModel(compiled,baseline,materials,config),{recipe:recipePayload,recipeHash}=observationRecipe(compiled,baseline,config);
  const recipe=await f.storage.createObject(ctx,'PlusModelRecipe',{revisionKey:'belief-unit-recipe',recipeKey:'belief.unit.recipe',revision:1,definitionKey:f.definition.key,definitionHash:compiled.definitionHash,
    definitionReference:{id:published.record._id,version:published.record._version,compiledHash:digest(compiled)},engineId:recipePayload.engineId,recipeHash,payload:recipePayload,policyHash:digest('unit'),submittedBy:'trainer',submittedAt:at(0),proposalHash:digest('explicit-upstream-double'),status:'APPROVED'});
  const execution=await f.storage.createObject(ctx,'PlusExecution',{executionKey:'unit-fit',kind:'FIT',inputReadSet:{},principalId:'trainer',status:'SUCCEEDED',attempts:1});
  const release=await f.storage.createObject(ctx,'PlusModelRelease',{releaseKey:'belief-unit-release',estimatorId:recipePayload.engineId,updateKind:'U2',classification:'SYNTHETIC',artifactHash:digest(candidate),artifactKey:'unit-artifact',consumedSources:[],evaluation:{state:'NOT_EVALUATED'},dependencyHash:compiled.definitionHash,status:'CANDIDATE',createdBy:'trainer'});
  await f.storage.createLink(ctx,'PlusReleaseExecution',release._id,execution._id);
  const deployment=await f.storage.createObject(ctx,'PlusDeployment',{deploymentKey:'unit-deployment',definitionHash:compiled.definitionHash,scopeKey:compiled.definition.scope.key,releaseKey:release.releaseKey,streamCursor:0,readiness:'INSUFFICIENT_DATA'});
  const revision=await f.storage.createObject(ctx,'PlusDeploymentRevision',{revisionKey:'unit-selection',deploymentKey:'unit-deployment',generation:1,requestHash:digest('unit'),payload:{},createdBy:'owner',createdAt:at(0),contentHash:digest('unit')});
  const authorization=await f.storage.createObject(ctx,'PlusReplayAuthorization',{authorizationKey:'unit-authorization',controlKey:'unit.belief',requestHash:digest('unit'),payload:{},createdBy:'owner',createdAt:at(0),contentHash:digest('unit-authorization'),readiness:'READY'});
  const clock={schema:'plus-fixed-step-clock-v1',definitionHash:compiled.definitionHash,bindingHash,stepMilliseconds:60000,maxSteps:16,transitionContext:'INTERVAL_START',interventions:'WAIT_ONLY'};
  const a={record:authorization,material:{deployment:{id:deployment._id,version:deployment._version,hash:digest(deployment)},revision:{id:revision._id,version:revision._version,hash:revision.contentHash},generation:1,
    selection:{release:{id:release._id,version:release._version,hash:digest(release)},definition:{id:published.record._id,version:published.record._version,hash:digest(compiled)}},
    policy:{clock,classification:'SYNTHETIC',scopeKey:compiled.definition.scope.key}},replayAuthorized:true,predictionReady:false};
  const state={allow:true,active:true,epoch:1,runs:0,beforeRun:async()=>{}},engine=createObservationReplayEngine();
  const bc={storage:f.storage,tenantId:ctx.tenantId,episodes:f.runtime,
    authorizations:{requireApproved:async id=>{if(!state.active||id!==authorization._id)throw new Error('REPLAY_AUTHORIZATION_STALE');return structuredClone(a);}},
    recipes:{requireApproved:async hash=>{assert.equal(hash,recipeHash);return {record:recipe,payload:recipePayload};}},
    compute:{readFitForEvaluation:async id=>{assert.equal(id,execution._id);return {recipeHash,trainingDataset:{id:'unit-training-dataset',version:1,hash:material.contentHash},trainingMaterial:structuredClone(material),
      response:{candidateId:release._id,status:'CANDIDATE',payload:structuredClone(candidate),execution:{id:execution._id,version:execution._version,status:'SUCCEEDED'},deploymentAuthorized:false}};}},
    authorize:async()=>state.allow,authorizationRevision:async()=>digest({epoch:state.epoch,allow:state.allow}),clock:()=>Date.parse(at(9)),
    engine:{id:engine.id,run:async request=>{state.runs++;await state.beforeRun();return engine.run(request);}}};
  if(batchTraining){
    const single=bc.compute.readFitForEvaluation;state.batchAllowed=true;
    bc.compute.readFitBatchForEvaluation=async id=>{
      if(!state.batchAllowed)throw Object.assign(new Error('COMPUTE_FORBIDDEN'),{code:'COMPUTE_FORBIDDEN'});
      const old=await single(id);return {response:old.response,recipeHash,trainingDatasets:materials.map((m,i)=>({id:'unit-training-dataset-'+i,version:1,hash:m.contentHash})),trainingMaterials:structuredClone(materials)};
    };
    bc.compute.readFitForEvaluation=async()=>{throw new Error('COMPUTE_BATCH_EVALUATOR_REQUIRED');};
  }
  f.setTime(9);const episode=await f.begin();await f.add({origin:'online-report'});
  const capture=async(key,target=at(1),episodeId=episode._id)=>{const s=await f.runtime.capture(episodeId,principal,'belief-stream-'+key);return (await f.runtime.snapshot({streamId:s.record._id,targetTime:target},principal,'belief-input-'+key)).record;};
  const snapshot=await capture('first');
  return {...f,compiled,candidate,clock,trainRoot,trainReport,trainGold,secondTraining,bc,state,authorization,episode,snapshot,capture,beliefs:new NativeBeliefRuntime(bc),input:{authorizationId:authorization._id,snapshotId:snapshot._id,expectedVersion:0}};
}
