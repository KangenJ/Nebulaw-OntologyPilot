import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '@openfoundry/plus-contracts';
import { NativeModelDecision,NativeModelDeployment,NativePublishedModelReference,NativeEvaluationProtocolRegistry } from '../dist/index.js';
import { writeFileSync,rmSync } from 'node:fs';
import { createPrivateIdentityProvider } from '../../../../ops/plus-v2/private-identity.mjs';
import { createPrivateEvaluationServices } from '../../../../ops/plus-v2/evaluation-services.mjs';
import { modelEvaluationFixture,ctx,trainer,reviewer,owner,at } from './model-evaluation-fixture.mjs';
import { observationRecipe } from '../../../../services/plus-engine/native-fit-verifier.mjs';
import { fitObservationModel } from '../../../../services/plus-engine/observation-fit.mjs';
import { neuralObservationRecipe,neuralRecipeConfig } from '../../../../services/plus-engine/native-neural-fit-verifier.mjs';
import { fitNeuralObservationModel } from '../../../../services/plus-engine/neural-observation-fit.mjs';

// Actual native reference/candidate qualification and prospective comparison.
// Same TRAIN reused deliberately to isolate model comparison, NOT two feedback rounds.
for(const neural of [false,true])test(`${neural?'U3 batch':'U2 single'} real published reference is frozen before fresh labels, state-scored and survives candidate replacing its own reference head`,async t=>{
 const f=await modelEvaluationFixture(t,{stateEvaluation:true,batch:neural,neural}),oldEvaluation=await f.evaluations.evaluate(f.request,trainer);
 const oldProtocol=(await f.protocols.read(f.approved.id,owner)).record,oldRecipe=(await f.recipes.requireApproved(oldProtocol.payload.recipe.hash,owner)).payload;
 const nextTrainer={id:'prospective-next-trainer',tenantId:ctx.tenantId,roles:['trainer']};
 const policy={version:'plus-model-admission-v1',id:'native-comparison',definitionHash:oldRecipe.compiled.definitionHash,bindingHash:oldRecipe.config.bindingHash,
  scopeKey:oldRecipe.compiled.definition.scope.key,classification:'SYNTHETIC',task:'STATE_ESTIMATION',clockHash:digest(oldProtocol.payload.configuration.clock)};
 let controlEpoch=1;const authority=async p=>digest({upstream:await f.evaluationConfig.authorizationRevision(p),policy,controlEpoch});
 const decisions=new NativeModelDecision({storage:f.storage,tenantId:ctx.tenantId,evaluations:f.evaluations,recipes:f.recipes,readConsistency:'SHARED_NATIVE_AND_AUTHORITY',
  authorize:async p=>[trainer.id,nextTrainer.id,owner.id].includes(p.id),policyFor:async()=>structuredClone(policy),authorizationRevision:authority,clock:f.evaluationConfig.clock});
 const decide=(evaluation,reason)=>decisions.decide({key:'comparison.admission',evaluationId:evaluation.id,evaluationVersion:evaluation.version,decision:'APPROVE',reason},owner);
 const firstDecision=await decide(oldEvaluation,'Independent initial admission before new holdout');
 const {version:_v,id:_id,...target}=policy;
 const deploymentConfig={storage:f.storage,tenantId:ctx.tenantId,decisions,readConsistency:'SHARED_NATIVE_AND_AUTHORITY',
  authorize:async p=>[trainer.id,nextTrainer.id,owner.id].includes(p.id),targetFor:async()=>structuredClone(target),authorizationRevision:authority,clock:f.evaluationConfig.clock};
 const deployments=new NativeModelDeployment(deploymentConfig),first=await deployments.activate({key:'comparison.selection',expectedVersion:0,decisionId:firstDecision.id,requestKey:'initial',reason:'SYNTHETIC current reference'},owner);
 const references=new NativePublishedModelReference({storage:f.storage,tenantId:ctx.tenantId,deployments,recipes:f.recipes,compute:f.compute,authorizationRevision:authority});
 f.protocolConfig.publishedReferences=references;f.evaluationConfig.publishedReferences=references;
 // A second explicit trainer has a separately approved recipe policy. Both jobs
 // remain in the SAME native queue; original policy/material is not overwritten.
 // Predefined engineering candidate, not a search against the new holdout.
 // U3 changes actual fitted weights, preserving the ontology layout and all gates.
 const nextConfig=neural?{...neuralRecipeConfig(oldRecipe),network:{...oldRecipe.network,epochs:120}}:{...oldRecipe.config,smoothingAlpha:.5};
 const {recipe,recipeHash}=(neural?neuralObservationRecipe:observationRecipe)(oldRecipe.compiled,oldRecipe.baseline,nextConfig);
 const rd=await f.recipes.propose({key:'comparison.candidate',revision:1,definitionKey:f.definition.key,payload:recipe},nextTrainer);
 await f.recipes.review(rd.id,rd.version,'APPROVE','Fixed candidate recipe before new validation labels',owner);
 const originalPolicy=f.computeConfig.policyFor,originalResolve=f.computeConfig.resolvePrincipal;
 const nextPolicy={...await originalPolicy(trainer,f.training.id,'FIT'),recipeHash};
 f.computeConfig.policyFor=async(p,...a)=>p.id===nextTrainer.id?structuredClone(nextPolicy):originalPolicy(p,...a);
 f.computeConfig.resolvePrincipal=async id=>id===nextTrainer.id?structuredClone(nextTrainer):originalResolve(id);controlEpoch++;
 const job=await f.compute.enqueue(neural?f.ids:f.training.id,'FIT',nextTrainer,'next-comparison-fit');
 const worker={id:nextPolicy.workerId,tenantId:ctx.tenantId,roles:[]},lease=await f.compute.claim(job.id,worker);
 const artifact=(neural?fitNeuralObservationModel:fitObservationModel)(recipe.compiled,recipe.baseline,neural?lease.inputBatch.materials:[lease.input],nextConfig);
 assert.notEqual(digest(artifact),digest(f.candidate));
 await f.compute.completeFit(job.id,lease.version,lease.leaseToken,artifact,worker);
 const cohortProtocol={...f.policy,key:'fresh-comparison-holdout',partition:'VALIDATION',expectedSampleCount:1,inputVisibleFrom:at(31),inputVisibleUntil:at(32),labelReceivedFrom:at(33),labelReceivedUntil:at(37),approvalUntil:at(39)};
 const protocolFor=f.datasetConfig.protocolFor;f.datasetConfig.protocolFor=async(p,key)=>key===cohortProtocol.key?structuredClone(cohortProtocol):protocolFor(p,key);
 f.advance(32);const root=await f.storage.createObject(ctx,'Machine',{actual:'UNKNOWN',status:'REGISTERED',priority:1,createdAt:at(30),receivedAt:at(30),classification:'SYNTHETIC'});
 let group;for(let i=0;i<1000;i++){const key='fresh-comparison-'+i,bucket=parseInt(digest(['dataset-frozen-fixture',ctx.tenantId,['synthetic-group',key]]).slice(0,8),16)%10000;if(bucket>=6000&&bucket<7500){group=key;break;}}
 assert.ok(group);const groupFor=f.partitionConfig.groupFor;f.partitionConfig.groupFor=async(p,ref)=>ref.id===root._id?{primary:{namespace:'synthetic-group',key:group},aliases:[]}:groupFor(p,ref);
 await f.add({rootId:root._id,origin:'fresh-comparison-report',value:'READY',minute:31,received:31});
 const episode=await f.runtime.open({definitionKey:f.definition.key,rootId:root._id,startedAt:at(30)},trainer,'fresh-comparison-episode');
 const snapshot=async key=>{const s=await f.runtime.capture(episode._id,trainer,'comparison-stream-'+key);return (await f.runtime.snapshot({streamId:s.record._id,targetTime:at(31)},trainer,'comparison-snapshot-'+key)).record;};
 const input=await snapshot('input');await f.partitions.reserve(input._id,nextTrainer);
 const cd=await f.registry.proposeCohort(cohortProtocol.key,[input._id],nextTrainer),cohort=await f.registry.reviewCohort(cd.id,cd.version,'APPROVE','Independent fresh holdout membership',reviewer);
 const purpose={...f.evaluationPurpose,recipeHashes:[recipeHash],reference:{mode:'CURRENT_PUBLICATION',controlKey:'comparison.selection'}};
 const purposeFor=f.protocolConfig.policyFor;f.protocolConfig.policyFor=async(p,key)=>key==='published-comparison'?structuredClone(purpose):purposeFor(p,key);controlEpoch++;
 const protocolInput={key:'published-comparison',revision:1,recipeHash,cohortIds:[cohort.id],evaluatorId:oldProtocol.evaluatorId,configuration:oldProtocol.payload.configuration};
 const faultStorage=new Proxy(f.storage,{get(storage,key){if(key!=='beginTransaction'){const value=Reflect.get(storage,key);return typeof value==='function'?value.bind(storage):value;}
  return async(...a)=>{const tx=await storage.beginTransaction(...a);return new Proxy(tx,{get(transaction,method){
   if(method==='createLink')return async(type,...args)=>{if(type==='PlusEvaluationReferenceTraining')throw new Error('INJECTED_REFERENCE_LINK_FAILURE');return transaction.createLink(type,...args);};
   const value=Reflect.get(transaction,method);return typeof value==='function'?value.bind(transaction):value;
  }});};}});
 const beforeFault=await f.storage.getReadRevision(ctx);
 const oldSchema=new Proxy(f.storage,{get(storage,key){if(key==='getSchema')return async(...a)=>{const schema=await storage.getSchema(...a);return {...schema,linkTypes:schema.linkTypes.filter(l=>l.name!=='PlusEvaluationReferenceTraining')};};
  const value=Reflect.get(storage,key);return typeof value==='function'?value.bind(storage):value;}});
 await assert.rejects(()=>new NativeEvaluationProtocolRegistry({...f.protocolConfig,storage:oldSchema}).propose(protocolInput,nextTrainer),/EVALUATION_REFERENCE_SCHEMA_NOT_CONFIGURED/);
 assert.equal(await f.storage.getReadRevision(ctx),beforeFault);
 await assert.rejects(()=>new NativeEvaluationProtocolRegistry({...f.protocolConfig,storage:faultStorage}).propose(protocolInput,nextTrainer),/INJECTED_REFERENCE_LINK_FAILURE/);
 assert.equal(await f.storage.getReadRevision(ctx),beforeFault);
 const authPath=f.path+'.comparison-identities.json',permissions=['evaluation:draft','evaluation:review','evaluation:read','evaluation:use','evaluation:run','evaluation:result-read'];
 writeFileSync(authPath,JSON.stringify([trainer,nextTrainer,owner].map(p=>({...p,tokenHash:digest('synthetic-comparison-'+p.id),expiresAt:new Date(f.evaluationConfig.clock()+3600000).toISOString()}))),{mode:0o600});
 t.after(()=>rmSync(authPath,{force:true}));
 const identities=createPrivateIdentityProvider({authPath,tenantId:ctx.tenantId,clock:f.evaluationConfig.clock});
 const privatePolicy={version:1,evaluation:{version:'plus-private-evaluation-v1',enabled:true,protocols:[{key:'published-comparison',purpose}],
  grants:[nextTrainer,owner].map(p=>({principalId:p.id,requiredRoles:p.roles,protocolKeys:['published-comparison'],permissions:[...permissions]}))}};
 const services=createPrivateEvaluationServices({storage:f.storage,tenantId:ctx.tenantId,identities,loadPolicy:()=>structuredClone(privatePolicy),
  learning:{datasets:f.registry,recipes:f.recipes,temporalInputs:f.runtime},compute:f.compute,publishedReferences:references,clock:f.evaluationConfig.clock});services.assertConfigured();
 const pd=await services.protocols.propose(protocolInput,nextTrainer);
 const intermediate=await deployments.activate({key:'comparison.selection',expectedVersion:first.version,decisionId:firstDecision.id,requestKey:'change-during-review',reason:'SYNTHETIC selection changes during draft'},owner);
 await assert.rejects(()=>services.protocols.review(pd.id,pd.version,'APPROVE','Must not follow changed head',owner),/EVALUATION_REFERENCE_SELECTION_CHANGED/);
 const revised=await services.protocols.propose({...protocolInput,revision:2},nextTrainer);
 const approved=await services.protocols.review(revised.id,revised.version,'APPROVE','Freeze current publication before any fresh GOLD',owner);
 const frozen=(await services.protocols.requireApproved(approved.id,nextTrainer)).record.payload.reference;
 assert.equal(frozen.selection.id,intermediate.revisionId);assert.equal((await f.storage.getLinks(ctx,approved.id,'PlusEvaluationReferenceTraining','outbound')).totalCount,neural?2:1);
 f.advance(34);const gold=await f.add({rootId:root._id,origin:'fresh-comparison-gold',kind:'VERIFICATION',value:'READY',minute:31,received:34}),labels=await snapshot('labels');
 await f.partitions.reserve(labels._id,nextTrainer);f.advance(35);
 const feedback=await f.feedback.propose({inputSnapshotId:input._id,labelSnapshotId:labels._id,eventId:gold.event._id},nextTrainer);await f.feedback.review(feedback.id,feedback.version,'APPROVE','Independent later GOLD',reviewer);
 f.advance(39);const data=await f.registry.freeze(cohort.id,nextTrainer),request={protocolId:approved.id,executionId:job.id,validationDatasetIds:[data.id]};
 const score=await services.evaluations.evaluate(request,nextTrainer),stored=(await services.evaluations.read(score.id,owner,{recompute:true})).record;
 assert.equal(score.decision,'ELIGIBLE_FOR_REVIEW');assert.equal(stored.inputReadSet.publishedReferenceHash,digest(frozen));
 assert.equal(stored.result.metrics.publishedReferenceHash,digest(frozen));
 const comparison=neural?stored.result.metrics.comparisons.currentPublication:stored.result.metrics.publishedComparison;
 assert.ok(comparison.groupMacroNllDelta<0);
 const newDecision=await decide(score,'Independent candidate admission after actual frozen-reference comparison');
 const next=await deployments.activate({key:'comparison.selection',expectedVersion:intermediate.version,decisionId:newDecision.id,requestKey:'candidate',reason:'Actual qualified replacement'},owner);
 assert.equal(next.generation,3);assert.notEqual(next.revisionId,intermediate.revisionId);
 const reopened=new NativeModelDeployment({...deploymentConfig,storage:f.openStorage()}),current=await reopened.read('comparison.selection',owner);
 assert.equal(current.selection.decision.id,newDecision.id);assert.equal(current.predictionReady,false);
 assert.equal((await services.protocols.requireApproved(approved.id,owner)).record.payload.reference.selection.id,intermediate.revisionId);
 privatePolicy.evaluation.grants.find(g=>g.principalId===owner.id).permissions=[];
 await assert.rejects(()=>services.evaluations.read(score.id,owner),/CONFIGURATION_INVALID/);
 privatePolicy.evaluation.grants.find(g=>g.principalId===owner.id).permissions=['evaluation:read'];
 await assert.rejects(()=>services.evaluations.read(score.id,owner),/FORBIDDEN/);
 privatePolicy.evaluation.grants.find(g=>g.principalId===owner.id).permissions=[...permissions];
 await decisions.revoke(firstDecision.id,firstDecision.version,'Withdraw the frozen reference admission',owner);
 await assert.rejects(()=>reopened.read('comparison.selection',owner),/STALE/);
 assert.equal((await f.rows('PlusDeployment')).totalCount,1);assert.equal((await f.storage.getObject(ctx,'Machine',root._id)).actual,'UNKNOWN');
});
