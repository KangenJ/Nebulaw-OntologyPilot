// Real native SQLite metadata/cohorts/feedback, controlled synthetic Machine
// source ingestion and clock. Not canonical Task or production efficacy evidence.
import { NativeComputeAdmission,NativeRecipeRegistry } from '../../platform/packages/plus-runtime/dist/index.js';
import { datasetFixture,trainer,reviewer,owner } from '../../platform/packages/plus-runtime/tests/dataset-fixture.mjs';
import { ctx,principal,at } from '../../platform/packages/plus-runtime/tests/episode-fixture.mjs';
import { baselineFor,fittingConfig } from './observation-fit-fixture.mjs';
import { observationRecipe,observationEstimatorId,validateNativeObservationRecipe,createNativeObservationFitVerifier,createNativeObservationBatchFitVerifier } from './native-fit-verifier.mjs';
import { neuralObservationRecipe,neuralObservationEstimatorId,validateNativeNeuralObservationRecipe,createNativeNeuralObservationFitVerifier,createNativeNeuralObservationBatchFitVerifier } from './native-neural-fit-verifier.mjs';
export const batchWorker={id:'native-batch-worker',tenantId:ctx.tenantId,roles:[]};
export async function batchFitFixture(t,{neural=false}={}){
 const f=await datasetFixture(t,{count:3}),secondPolicy={...f.policy,key:'batch-round-2',inputVisibleFrom:at(11),inputVisibleUntil:at(12),labelReceivedFrom:at(13),labelReceivedUntil:at(17),approvalUntil:at(19)};
 const protocols=new Map([[f.policy.key,f.policy],[secondPolicy.key,secondPolicy]]);f.datasetConfig.protocolFor=async(_p,key)=>structuredClone(protocols.get(key));
 const values=['READY','BUSY','OFFLINE'];for(const [i,value]of values.entries())await f.addLabel(i,{value});f.advance(9);
 const first=await f.registry.freeze(f.cohort.id,trainer);f.advance(12);
 const secondRoots=[],secondEpisodes=[],inputs=[];
 const snapshot=async(i,key)=>{const stream=await f.runtime.capture(secondEpisodes[i]._id,principal,'batch-capture-'+key);return (await f.runtime.snapshot({streamId:stream.record._id,targetTime:at(11)},principal,'batch-input-'+key)).record;};
 for(let i=0;i<3;i++){
  const root=await f.storage.createObject(ctx,'Machine',{actual:'UNKNOWN',status:'REGISTERED',priority:1,createdAt:at(10),receivedAt:at(10),classification:'SYNTHETIC'});secondRoots.push(root);
  await f.add({rootId:root._id,origin:'batch-round-2-report-'+i,value:values[i],minute:11,received:11});
  secondEpisodes.push(await f.runtime.open({definitionKey:f.definition.key,rootId:root._id,startedAt:at(10)},principal,'batch-round-2-episode-'+i));
  const input=await snapshot(i,'early-'+i);inputs.push(input);await f.partitions.reserve(input._id,trainer);
 }
 const draft=await f.registry.proposeCohort(secondPolicy.key,inputs.map(r=>r._id),trainer),cohort=await f.registry.reviewCohort(draft.id,draft.version,'APPROVE','Prospective second synthetic cohort',reviewer);
 for(let i=0;i<3;i++){
  const received=14+i*.4;f.advance(received);
  const label=await f.add({rootId:secondRoots[i]._id,origin:'batch-round-2-gold-'+i,kind:'VERIFICATION',value:values[i],minute:11,received});
  const labels=await snapshot(i,'gold-'+i);await f.partitions.reserve(labels._id,trainer);f.advance(received+.1);
  const feedback=await f.feedback.propose({inputSnapshotId:inputs[i]._id,labelSnapshotId:labels._id,eventId:label.event._id},trainer);
  await f.feedback.review(feedback.id,feedback.version,'APPROVE','Independent same-target synthetic GOLD',reviewer);
 }
 f.advance(19);const second=await f.registry.freeze(cohort.id,trainer),ids=[first.id,second.id].sort(),{compiled}=await f.definitions.requirePublished(f.definition.key,trainer),baseline=baselineFor(compiled);
 const supervision=fittingConfig([...protocols.values()],f.inputs[0].compiledInput.bindingHash),config=neural?{schema:'plus-neural-observation-config-v1',supervision,network:{schema:'one-hot-tanh-softmax-v1',hiddenWidth:4,epochs:100,learningRate:.2,l2:.001,seed:41}}:supervision;
 const {recipe,recipeHash}=(neural?neuralObservationRecipe:observationRecipe)(compiled,baseline,config),engineId=neural?neuralObservationEstimatorId:observationEstimatorId;
 const policy={version:'plus-recipe-policy-v1',id:'batch-software-purpose',engineIds:[engineId],classifications:['SYNTHETIC'],collectionPolicyHashes:[supervision.collectionPolicyHash],populationPolicyHashes:[supervision.populationPolicyHash],scopeKeys:[compiled.definition.scope.key]};
 const recipeConfig={storage:f.storage,tenantId:ctx.tenantId,definitions:f.definitions,authorize:async()=>true,policyFor:async()=>structuredClone(policy),validateRecipe:neural?validateNativeNeuralObservationRecipe:validateNativeObservationRecipe,clock:()=>Date.parse(at(19))};
 const recipes=new NativeRecipeRegistry(recipeConfig),proposed=await recipes.propose({key:'machine.batch-channel',revision:1,definitionKey:f.definition.key,payload:recipe},trainer);
 await recipes.review(proposed.id,proposed.version,'APPROVE','Review actual native two-cohort training recipe',owner);
 const computePolicy={version:'plus-compute-policy-v1',workerId:batchWorker.id,engineId,recipeHash,leaseMs:1000,maxAttempts:2};
 const admissionConfig={storage:f.storage,tenantId:ctx.tenantId,datasets:f.registry,recipes,authorize:async()=>true,clock:()=>Date.parse(at(19)),resolvePrincipal:async id=>id===trainer.id?structuredClone(trainer):undefined,policyFor:async()=>structuredClone(computePolicy),
  verifyFitResult:(neural?createNativeNeuralObservationFitVerifier:createNativeObservationFitVerifier)({recipes}),verifyFitBatchResult:(neural?createNativeNeuralObservationBatchFitVerifier:createNativeObservationBatchFitVerifier)({recipes})};
 return {...f,runtimeConfig:f.config,ids,secondRoots,secondEpisodes,compiled,baseline,config,recipe,recipeHash,recipes,recipeConfig,computePolicy,admissionConfig,admission:new NativeComputeAdmission(admissionConfig)};
}
