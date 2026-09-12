import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { NativeLearnedCompositionEvaluationPopulation,assertIndependentLearnedCompositionPopulations,learnedCompositionStateEvaluatorId } from '../../platform/packages/plus-runtime/dist/index.js';
import { transitionValidationFixture } from './transition-validation-fixture.mjs';
import { trainer,owner } from '../../platform/packages/plus-runtime/tests/dataset-fixture.mjs';
import { ctx } from '../../platform/packages/plus-runtime/tests/episode-fixture.mjs';

// Actual native multi-dataset TRAIN/VALIDATION cohorts, missing GOLD and current
// partition ledger. Complete FIT/protocol qualification is an EXPLICIT DOUBLE
// to isolate the population reader, not a full-model or Task-host acceptance.
test('full-model population reads all ancestor cohorts and unlabelled members with native identity/source partitions',async t=>{
  const f=await transitionValidationFixture(t,{secondary:true,missing:true,componentReview:true});
  const refs=[];for(const id of f.frozenIds){const r=await f.storage.getObject(ctx,'PlusDatasetRevision',id);refs.push({id,version:r._version,hash:r.contentHash});}
  const recipeHash=digest('explicit-complete-fit-provider-double'),protocol=structuredClone(f.protocol);
  protocol.evaluatorId=learnedCompositionStateEvaluatorId;protocol.payload.recipe.hash=recipeHash;
  const fit={recipeHash,response:{execution:{id:'native-fit-provider-double',version:3,status:'SUCCEEDED'},status:'CANDIDATE'},
    composition:{exposure:{id:'native-exposure-provider-double',version:1,hash:digest('exposure-double')},
      material:{recipeHash,tenantId:ctx.tenantId,contentHash:digest('material-double'),closure:{datasets:refs.map(reference=>({reference,uses:['TRANSITION']}))}}}};
  let revision=0,allowed=true,reads=0;
  const config={storage:f.storage,tenantId:ctx.tenantId,
    compute:{readLearnedCompositionFitForEvaluation:async(id,p)=>{assert.equal(id,fit.response.execution.id);assert.ok([trainer.id,owner.id].includes(p.id));return structuredClone(fit);}},
    protocols:{requireApproved:async id=>{assert.equal(id,protocol._id);return {record:structuredClone(protocol)};}},
    datasets:{materialize:(id,purpose,p)=>(purpose==='FIT'?f.endpointConfig.datasets:f.validationDatasets).materialize(id,purpose,p),
      readCohort:async(id,p)=>{const row=await f.storage.getObject(ctx,'PlusCohort',id);return (row.payload.protocol.partition==='TRAIN'?f.endpointConfig.datasets:f.validationDatasets).readCohort(id,p);}},
    partitions:{read:async(id,p)=>{reads++;const row=await f.storage.getObject(ctx,'PlusInputSnapshot',id);
      return (row.readSet.root.id===f.root._id?f.validationEndpointConfig.partitions:f.partitions).read(id,p);}},
    authorize:async()=>allowed,authorizationRevision:async()=>digest(['explicit-whole-population-authority',revision])};
  const reader=new NativeLearnedCompositionEvaluationPopulation(config),input={executionId:fit.response.execution.id,protocolId:protocol._id,validationDatasetIds:f.validationDatasetIds};
  const epoch=await f.storage.getReadRevision(ctx),result=await reader.read(input,trainer);
  assert.equal(result.trainingDatasets.length,4);assert.equal(result.validationDatasets.length,2);
  assert.equal(result.training.population.enrolled,4);assert.equal(result.validation.population.enrolled,4);
  assert.equal(result.validation.population.eligible,2);assert.equal(result.validation.population.missing,2);
  assert.equal(result.validation.population.sampleKeys.length,4);assert.equal(result.validation.population.snapshotIds.length,4);
  assert.ok(result.validation.population.identityKeys.length>0);assert.equal(result.scoringReady,false);assert.equal(result.modelDeploymentAuthorized,false);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);const firstReads=reads;
  const reopened=new NativeLearnedCompositionEvaluationPopulation({...config,storage:f.openStorage()});
  assert.deepEqual(await reopened.read(input,owner),result);assert.ok(reads>firstReads,'No cross-request population cache');
  // Exercise every independent set guard, including members without GOLD. Native
  // ledger mutations would fail earlier; these are explicitly pure set cases.
  for(const key of ['datasetIds','cohortIds','sampleKeys','snapshotIds','entityKeys','groupHashes','sourceIds','feedbackIds','identityKeys']){
    const validation=structuredClone(result.validation.population);validation[key].push(result.training.population[key][0]);
    assert.throws(()=>assertIndependentLearnedCompositionPopulations(result.training.population,validation),{code:'COMPOSITION_POPULATION_OVERLAP_'+key.toUpperCase()});
  }
  assert.throws(()=>assertIndependentLearnedCompositionPopulations(result.training.population,{...result.validation.population,policyHash:digest('other-partition-policy')}),{code:'COMPOSITION_POPULATION_PARTITION_POLICY'});
  await assert.rejects(()=>reader.read({...input,validationDatasetIds:[input.validationDatasetIds[0]]},trainer),/COMPOSITION_POPULATION_PROTOCOL_COHORTS/);
  const old=fit.composition.material.closure.datasets[0].reference.hash;fit.composition.material.closure.datasets[0].reference.hash=digest('forged-ancestor');
  await assert.rejects(()=>reader.read(input,trainer),/COMPOSITION_POPULATION_DATASET_STALE/);fit.composition.material.closure.datasets[0].reference.hash=old;
  allowed=false;await assert.rejects(()=>reader.read(input,trainer),/COMPOSITION_POPULATION_FORBIDDEN/);allowed=true;
  const partitionRead=config.partitions.read;config.partitions.read=async()=>{throw Error('PARTITION_READER_REVOKED');};
  await assert.rejects(()=>reader.read(input,owner),/PARTITION_READER_REVOKED/);config.partitions.read=partitionRead;
  const cohort=(await f.validationDatasets.readCohort(result.validation.cohorts[0].id,trainer)).record;
  const unlabelledKey=result.validation.materials[0].sourceManifest.coverage.missingSampleKeys[0];
  const unlabelled=cohort.payload.members.find(m=>m.sampleKey===unlabelledKey);assert.ok(unlabelled);
  config.partitions.read=async(id,p)=>{if(id===unlabelled.snapshotId)throw Error('UNLABELLED_MEMBER_REVOKED');return partitionRead(id,p);};
  await assert.rejects(()=>reader.read(input,trainer),/UNLABELLED_MEMBER_REVOKED/);config.partitions.read=partitionRead;
  const inputIds=new Set(cohort.payload.members.map(m=>m.snapshotId));let labelOnly;
  for(const ref of result.validation.reservations){const row=await f.storage.getObject(ctx,'PlusPartitionReservation',ref.id);
    if(!inputIds.has(row.snapshotId)){labelOnly=row.snapshotId;break;}}
  assert.ok(labelOnly);config.partitions.read=async(id,p)=>{if(id===labelOnly)throw Error('GOLD_ONLY_ORIGIN_REVOKED');return partitionRead(id,p);};
  await assert.rejects(()=>reader.read(input,trainer),/GOLD_ONLY_ORIGIN_REVOKED/);config.partitions.read=partitionRead;
  const materialize=config.datasets.materialize;config.datasets.materialize=async(...args)=>{const value=await materialize(...args);revision++;return value;};
  await assert.rejects(()=>reader.read(input,trainer),/COMPOSITION_POPULATION_AUTHORITY_STALE/);config.datasets.materialize=materialize;
  let authorizations=0;config.authorize=async()=>{if(++authorizations===2){
    const fields=Object.fromEntries(Object.entries(f.root).filter(([key])=>!key.startsWith('_')));await f.storage.createObject(ctx,'Machine',fields);
  }return true;};
  await assert.rejects(()=>reader.read(input,trainer),/CONFLICT/);
  assert.equal((await f.rows('PlusModelEvaluation')).totalCount,0);assert.equal((await f.rows('PlusDeployment')).totalCount,0);
});
