import assert from 'node:assert/strict';
import {trainer,owner} from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import {transitionEstimatorId} from './transition-fit.mjs';
import {learnedCompositionEstimatorId} from './learned-composition.mjs';

export function nativeCompleteFitCommand(datasetIds,authorization){
 assert.ok(Array.isArray(datasetIds)&&datasetIds.length>0&&datasetIds.length<=10&&new Set(datasetIds).size===datasetIds.length);
 assert.ok(datasetIds.every(id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(id)));
 const ids=[...datasetIds].sort();return {...(ids.length===1?{datasetId:ids[0]}:{datasetIds:ids}),purpose:'FIT',authorization:structuredClone(authorization)};
}

// Test fixture declaration BEFORE host start/FIT. Not a migration, policy-file
// writer or approval provider. Real authoring/review below uses actual HTTP.
export function nativeCompleteComputeConfiguration({selection,transitionWorker,completeWorker,transitionAuthorization,completeAuthorization}){
 const pairs=[[transitionWorker,transitionAuthorization,transitionEstimatorId],[completeWorker,completeAuthorization,learnedCompositionEstimatorId]];
 const keys=pairs.map(([,ref])=>ref.key);
 const computeAuthorizations={version:'plus-private-compute-authorizations-v1',enabled:true,targets:pairs.map(([worker,ref,engineId])=>({key:ref.key,
  policy:{version:'plus-compute-authorization-policy-v1',id:ref.key,submitterId:trainer.id,workerId:worker.id,workerRoles:worker.roles,engineId,
   definitionHash:selection.definitionHash,bindingHash:selection.bindingHash,scopeKey:selection.scopeKey,classification:'SYNTHETIC',leaseMs:300000,maxAttempts:2,maxDatasets:10}})),
  grants:[{principalId:trainer.id,requiredRoles:trainer.roles,keys,permissions:['compute-authorization:propose','compute-authorization:read','compute-authorization:use']},
   {principalId:owner.id,requiredRoles:owner.roles,keys,permissions:['compute-authorization:review','compute-authorization:read','compute-authorization:revoke']},
   ...pairs.map(([worker,ref])=>({principalId:worker.id,requiredRoles:worker.roles,keys:[ref.key],permissions:['compute-authorization:read']}))]};
 const compute={version:'plus-private-compute-v4',enabled:true,workers:pairs.map(([worker])=>({principalId:worker.id,requiredRoles:worker.roles,maxItems:1})),
  grants:[{principalId:trainer.id,requiredRoles:trainer.roles,keys,permissions:['compute:submit','compute:inspect','compute:read-result','compute:cancel']},
   {principalId:owner.id,requiredRoles:owner.roles,keys,permissions:['compute:inspect','compute:read-result','compute:cancel']},
   ...pairs.map(([worker,ref])=>({principalId:worker.id,requiredRoles:worker.roles,keys:[ref.key],permissions:['compute:inspect','compute:claim','compute:complete','compute:fail','compute:reconcile']}))]};
 return {compute,computeAuthorizations};
}

export async function authorizeNativeCompleteBatch(f,ref,datasetIds,recipeHash){
 assert.equal(f.policy.compute.version,'plus-private-compute-v4');assert.equal(Object.hasOwn(f.policy.compute,'jobs'),false);
 const before=JSON.stringify({compute:f.policy.compute,authorizations:f.policy.computeAuthorizations});
 const draft=await f.ok('/learning/compute-authorizations',{key:ref.key,revision:ref.version,datasetIds:[...datasetIds].sort(),recipeHash},trainer);
 assert.equal(draft.status,'DRAFT');assert.equal(draft.trainingStarted,false);
 const self=await f.request('/learning/compute-authorizations/'+draft.id+'/review',{expectedVersion:draft.version,decision:'APPROVE',reason:'Self review must not authorize'},trainer);
 assert.equal(self.status,403);
 const approved=await f.ok('/learning/compute-authorizations/'+draft.id+'/review',{expectedVersion:draft.version,decision:'APPROVE',reason:'Independent complete native batch and qualified recipe'},owner);
 assert.equal(approved.status,'APPROVED');assert.equal(approved.trainingStarted,false);
 assert.equal(JSON.stringify({compute:f.policy.compute,authorizations:f.policy.computeAuthorizations}),before);
 return approved;
}
