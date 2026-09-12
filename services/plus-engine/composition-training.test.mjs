import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { NativeComputeAdmission } from '../../platform/packages/plus-runtime/dist/index.js';
import { ctx,trainer,owner,at } from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import { compositionEstimatorId } from './native-composition-recipe.mjs';
import { projectCompositionTraining,fitCompositionObservations,verifyCompositionObservationFit,createNativeCompositionTraining,createNativeCompositionFitVerifiers } from './composition-training.mjs';

import { compositionTrainingFixture as fixture } from './composition-training-fixture.mjs';
function rehash(data){data.partitionManifest.protocolHash=digest(data.sourceManifest.protocol);data.contentHash=digest({sourceManifest:data.sourceManifest,partitionManifest:data.partitionManifest});return data;}

for(const neural of [false,true])test(`actual native Task training projection and real ${neural?'U3':'U2'} fit preserve original authority, labels and source identity`,async t=>{
  const f=await fixture(t,{neural}),epoch=await f.storage.getReadRevision(ctx),original=structuredClone(f.material);
  const prepared=await f.adapter.prepareTraining(f.request,trainer),projection=prepared.projection;
  assert.equal(prepared.nativeSourcesChecked,true);assert.equal(prepared.computeAuthorized,false);assert.equal(prepared.predictionReady,false);
  assert.equal(projection.nativeSourcesChecked,false);assert.equal(projection.nativeDatasets[0].contentHash,f.material.contentHash);
  assert.equal(projection.protocolMapping[0].nativeProtocolHash,digest(f.protocol));
  assert.notEqual(projection.protocolMapping[0].projectedProtocolHash,digest(f.protocol));
  const row=projection.projectedMaterials[0].sourceManifest.samples[0],source=f.material.sourceManifest.samples[0];
  assert.deepEqual(row.label,source.label);assert.deepEqual(row.input.events,source.input.events);
  assert.deepEqual(Object.keys(row.input.features),['priority']);assert.ok(projection.sampleMapping[0].omittedFeatures.includes('administrativeStatus'));
  assert.equal(row.inputSnapshotId,source.inputSnapshotId);assert.notEqual(row.inputHash,source.inputHash);
  assert.equal(projection.sampleMapping[0].nativeInputHash,source.inputHash);
  assert.equal(row.input.events.some(e=>e.kind==='VERIFICATION'),false);
  const artifact=await fitCompositionObservations(f.recipe,[f.material]);
  assert.equal(artifact.updateKind,neural?'U3':'U2');assert.equal(artifact.nativeAdmissionChecked,false);assert.equal(artifact.predictionReady,false);
  assert.deepEqual(await verifyCompositionObservationFit(f.recipe,[f.material],artifact),artifact);
  assert.notEqual(digest(artifact.statistics.spec),digest(f.recipe.statistics.baseline));
  assert.deepEqual(f.material,original);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);
  assert.deepEqual((await f.make(f.open()).adapter.prepareTraining(f.request,trainer)).projection,projection);
  assert.equal((await f.storage.queryObjects(ctx,'PlusModelArtifact',{and:[]})).totalCount,0);
  assert.equal((await f.storage.queryObjects(ctx,'PlusDeployment',{and:[]})).totalCount,0);
});

test('projected records cannot hide rule output, native parent mismatch, future GOLD, repeated source or holdout relabeling',async t=>{
  const f=await fixture(t);
  for(const mutate of [
    d=>{d.sourceManifest.samples[0].input.features.recommendedPriority={kind:'VALUE',value:'HIGH'};},
    d=>{d.sourceManifest.samples[0].input.events[0].variable='recommendedPriority';},
    d=>{d.sourceManifest.samples[0].input.definitionHash=digest('different native parent');},
    d=>{d.sourceManifest.samples[0].input.events[0].receivedAt=at(99);},
    d=>{const e=d.sourceManifest.samples[0].input.events[0];e.variable='completion';e.kind='VERIFICATION';e.verificationMode='GOLD';},
    d=>{d.sourceManifest.protocol.partition='VALIDATION';d.partitionManifest.partition='VALIDATION';},
  ]){const bad=structuredClone(f.material);mutate(bad);rehash(bad);await assert.rejects(()=>projectCompositionTraining(f.recipe,[bad]));}
  await assert.rejects(()=>projectCompositionTraining(f.recipe,[f.material,f.material]),/COMPOSITION_TRAINING_SOURCE_INTEGRITY/);
  const artifact=await fitCompositionObservations(f.recipe,[f.material]);artifact.nativeDatasets[0].contentHash=digest('forged native source');artifact.artifactHash=digest(artifact);
  await assert.rejects(()=>verifyCompositionObservationFit(f.recipe,[f.material],artifact),/COMPOSITION_TRAINING_ARTIFACT_MISMATCH/);
});

test('native preparation requires current dataset FIT grants, rule source eligibility and exact dependency versions',async t=>{
  const f=await fixture(t),grant=f.policy.taskLearning.grants.find(g=>g.principalId===trainer.id),permissions=[...grant.permissions];
  grant.permissions=permissions.filter(p=>p!=='dataset:FIT');await assert.rejects(()=>f.adapter.prepareTraining(f.request,trainer),/FORBIDDEN/);
  grant.permissions=permissions;f.state.sourceAllowed=false;await assert.rejects(()=>f.adapter.prepareTraining(f.request,trainer),/RULE_SOURCE_FORBIDDEN/);
  f.state.sourceAllowed=true;await f.rules.revoke(f.rule.id,f.rule.version,'Withdraw rule training dependency',owner);
  await assert.rejects(()=>f.adapter.prepareTraining(f.request,trainer),/RECIPE_DEPENDENCY_STALE/);
  await assert.rejects(()=>f.adapter.prepareTraining({...f.request,datasetIds:[f.frozen.id,f.frozen.id]},trainer),/COMPOSITION_TRAINING_REQUEST/);
  await assert.rejects(()=>f.adapter.prepareTraining(f.request,{...trainer,tenantId:'foreign'}),/COMPOSITION_TRAINING_FORBIDDEN/);
});

test('source or full authorization changes after first native read cannot produce a qualified mixed-version projection',async t=>{
  const f=await fixture(t);let calls=0;
  const datasets={materialize:async(...args)=>{const result=await f.config.datasets.materialize(...args);if(++calls===1)f.state.sourceAllowed=false;return result;}};
  await assert.rejects(()=>createNativeCompositionTraining({...f.config,datasets}).prepareTraining(f.request,trainer),/RULE_SOURCE_FORBIDDEN/);
  f.state.sourceAllowed=true;calls=0;
  const changingAuthority=async p=>{const result=await f.config.authorizationRevision(p);if(++calls===2)return digest('changed full policy revision');return result;};
  await assert.rejects(()=>createNativeCompositionTraining({...f.config,authorizationRevision:changingAuthority}).prepareTraining(f.request,trainer),/COMPOSITION_TRAINING_AUTHORITY_STALE/);
  calls=0;
  const concurrent={materialize:async(...args)=>{
    const result=await f.config.datasets.materialize(...args);
    if(++calls===2){const task=await f.storage.getObject(ctx,'InvestigationTask',f.initial.task._id);await f.storage.updateObject(ctx,'InvestigationTask',task._id,{title:'Concurrent native source edit'},task._version);}
    return result;
  }};
  await assert.rejects(()=>createNativeCompositionTraining({...f.config,datasets:concurrent}).prepareTraining(f.request,trainer),/COMPOSITION_TRAINING_NATIVE_CONFLICT/);
});

for(const {neural,batch} of [{neural:false,batch:false},{neural:true,batch:false},{neural:true,batch:true}])test(`real ${neural?'U3':'U2'} ${batch?'multi-dataset':'single-dataset'} composition fit becomes only a native CANDIDATE after recomputation, with parent dataset/exposure/recipe links`,async t=>{
  const f=await fixture(t,{neural,batch}),worker={id:'composition-worker',tenantId:ctx.tenantId,roles:['plus_compute_worker']};
  const configuration={storage:f.storage,tenantId:ctx.tenantId,datasets:f.services.datasets,recipes:f.services.recipes,
    authorize:async(p,_permission,id,purpose)=>[trainer.id,worker.id].includes(p.id)&&f.request.datasetIds.includes(id)&&purpose==='FIT',
    policyFor:async()=>({version:'plus-compute-policy-v1',engineId:compositionEstimatorId,recipeHash:f.recipeHash,workerId:worker.id,leaseMs:300000,maxAttempts:2}),
    resolvePrincipal:async id=>f.options.identities.resolvePrincipal(id),...createNativeCompositionFitVerifiers({recipes:f.services.recipes}),clock:f.options.clock};
  if(batch){
    const denySecond=new NativeComputeAdmission({...configuration,authorize:async(p,permission,id,purpose)=>id!==f.frozenRows[1].id&&await configuration.authorize(p,permission,id,purpose)});
    await assert.rejects(()=>denySecond.enqueue(f.request.datasetIds,'FIT',trainer,'partial-grant'),/FORBIDDEN/);
    assert.equal((await f.storage.queryObjects(ctx,'PlusExecution',{and:[]})).totalCount,0);
    const view=await f.adapter.prepareTraining(f.request,trainer);assert.equal(view.readSet.datasets.length,2);
    assert.deepEqual((await f.adapter.prepareTraining({...f.request,datasetIds:[...f.request.datasetIds].reverse()},trainer)).projection,view.projection);
  }
  const compute=new NativeComputeAdmission(configuration),job=await compute.enqueue(batch?f.request.datasetIds:f.frozen.id,'FIT',trainer,'native-composition-fit');
  const lease=await compute.claim(job.id,worker),artifact=await fitCompositionObservations(lease.recipe,batch?lease.inputBatch.materials:[lease.input]);
  const fake={...structuredClone(artifact),parentDefinitionHash:digest('forged native parent')};fake.artifactHash=digest(fake);
  await assert.rejects(()=>compute.completeFit(job.id,lease.version,lease.leaseToken,fake,worker),/COMPOSITION_TRAINING_ARTIFACT_MISMATCH/);
  assert.equal((await f.storage.queryObjects(ctx,'PlusModelArtifact',{and:[]})).totalCount,0);
  const result=await compute.completeFit(job.id,lease.version,lease.leaseToken,artifact,worker);
  assert.equal(result.status,'SUCCEEDED');assert.equal(result.deploymentAuthorized,false);
  const candidate=await f.storage.getObject(ctx,'PlusModelRelease',result.candidateId),stored=await f.storage.getObject(ctx,'PlusModelArtifact',result.artifactId);
  assert.equal(candidate.status,'CANDIDATE');assert.equal(candidate.evaluation.state,'NOT_EVALUATED');assert.equal(candidate.updateKind,neural?'U3':'U2');
  assert.deepEqual(stored.payload,artifact);assert.equal(stored.definitionHash,f.compiled.definitionHash);
  assert.deepEqual((batch?candidate.consumedSources.datasets:[candidate.consumedSources.dataset]).map(r=>r.id).sort(),[...f.request.datasetIds].sort());
  assert.deepEqual((await f.storage.getLinks(ctx,candidate._id,'PlusReleaseDataset','outbound')).items.map(r=>r._toId).sort(),[...f.request.datasetIds].sort());
  assert.equal((await f.storage.getLinks(ctx,candidate._id,'PlusReleaseRecipe','outbound')).totalCount,1);
  assert.equal((await f.storage.getLinks(ctx,candidate._id,'PlusReleaseExposure','outbound')).totalCount,1);
  const storage=f.open(),reopened=f.make(storage),again=new NativeComputeAdmission({...configuration,storage,datasets:reopened.services.datasets,recipes:reopened.services.recipes,
    ...createNativeCompositionFitVerifiers({recipes:reopened.services.recipes})});
  assert.equal((await again.completeFit(job.id,lease.version,lease.leaseToken,artifact,worker)).candidateId,candidate._id);
  await again.readFitResult(job.id,trainer);
  assert.equal((await f.storage.queryObjects(ctx,'PlusModelRelease',{and:[]})).totalCount,1);
  assert.equal((await f.storage.queryObjects(ctx,'PlusDeployment',{and:[]})).totalCount,0);
  await f.rules.revoke(f.rule.id,f.rule.version,'Withdraw native dependency after fitting',owner);
  await assert.rejects(()=>again.readFitResult(job.id,trainer),/STALE|REVOKED|NOT_APPROVED/);
});
