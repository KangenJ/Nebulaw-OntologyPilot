import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '@openfoundry/plus-contracts';
import { readFitTrainingContext,fitArtifactDefinitionHash,trainingFields,trainingReferences } from '../dist/fit-training-context.js';
const p={id:'unit-reader',tenantId:'unit',roles:[]},refs=['a','b'].map(id=>({id,version:1,hash:digest(id)}));
const batch=()=>({response:{fixture:true},recipeHash:digest('recipe'),trainingDatasets:structuredClone(refs),trainingMaterials:refs.map(r=>({contentHash:r.hash}))});
test('verified native definition survives single and batch handoff without mutating old artifacts or inferring composition fields',async()=>{
 const definition=digest('full parent'),payload={parentDefinitionHash:definition,statisticalDefinitionHash:digest('statistical view')};
 const value={...batch(),response:{payload},nativeArtifactDefinitionHash:definition};
 const single={response:value.response,nativeArtifactDefinitionHash:definition,recipeHash:value.recipeHash,trainingDataset:refs[0],trainingMaterial:value.trainingMaterials[0]};
 const original=structuredClone(payload);
 for(const provider of [{readFitForEvaluation:async()=>single},{readFitForEvaluation:async()=>single,readFitBatchForEvaluation:async()=>value}])
  assert.equal(fitArtifactDefinitionHash(await readFitTrainingContext(provider,'job',p)),definition);
 assert.deepEqual(payload,original);
 assert.equal(fitArtifactDefinitionHash({response:{payload:{definitionHash:definition}}}),definition);
 for(const invalid of [{response:{payload}},{...value,nativeArtifactDefinitionHash:undefined},{...value,nativeArtifactDefinitionHash:'bad'},
  {...value,response:{payload:{definitionHash:digest('other')}}}])assert.throws(()=>fitArtifactDefinitionHash(invalid),/FIT_TRAINING_CONTEXT_INVALID/);
});
test('legacy handoff preserves the exact single read-set field; native batch carries every member and never retries denial as single',async()=>{
 const old={response:{fixture:true},recipeHash:digest('recipe'),trainingDataset:refs[0],trainingMaterial:{contentHash:refs[0].hash}};
 const one=await readFitTrainingContext({readFitForEvaluation:async()=>old},'job',p);assert.deepEqual(trainingFields(one),{trainingDataset:refs[0]});
 let singles=0;const provider={readFitForEvaluation:async()=>{singles++;return old;},readFitBatchForEvaluation:async()=>batch()};
 assert.deepEqual(trainingFields(await readFitTrainingContext(provider,'job',p)),{trainingDatasets:refs});assert.equal(singles,0);
 provider.readFitBatchForEvaluation=async()=>{throw new Error('REVOKED_SECOND_MEMBER');};await assert.rejects(()=>readFitTrainingContext(provider,'job',p),/REVOKED_SECOND_MEMBER/);assert.equal(singles,0);
});
test('ambiguous, duplicate, unordered and hash-mismatched training contexts reject before consumer computation',async()=>{
 for(const invalid of [{},{trainingDataset:refs[0],trainingDatasets:refs},{trainingDatasets:[]},{trainingDatasets:[refs[0]]},{trainingDatasets:[...refs].reverse()},{trainingDatasets:[refs[0],refs[0]]}])assert.throws(()=>trainingReferences(invalid),/FIT_TRAINING_CONTEXT_INVALID/);
 for(const mutate of [v=>v.trainingMaterials.pop(),v=>v.trainingMaterials[1].contentHash=digest('changed'),v=>v.trainingDatasets[1].version=0]){
  const value=batch();mutate(value);await assert.rejects(()=>readFitTrainingContext({readFitForEvaluation:async()=>{throw new Error('NO_FALLBACK');},readFitBatchForEvaluation:async()=>value},'job',p),/FIT_TRAINING_CONTEXT_INVALID/);
 }
});
