import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeRecipeRegistry } from '../../platform/packages/plus-runtime/dist/index.js';
import { episodeFixture,ctx,at } from '../../platform/packages/plus-runtime/tests/episode-fixture.mjs';
import { baselineFor,fittingConfig,protocolFor } from './observation-fit-fixture.mjs';
import { observationRecipe,observationEstimatorId,validateNativeObservationRecipe } from './native-fit-verifier.mjs';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
const trainer={id:'recipe-author',tenantId:ctx.tenantId,roles:['trainer']},owner={id:'recipe-owner',tenantId:ctx.tenantId,roles:['model_owner']};
async function setup(t){
 const f=await episodeFixture(t),{compiled}=await f.definitions.requirePublished(f.definition.key,trainer);
 const config=fittingConfig([protocolFor(compiled,'preapproved-future-software-cohort',1)]);
 const {recipe,recipeHash}=observationRecipe(compiled,baselineFor(compiled),config);
 const policy={version:'plus-recipe-policy-v1',id:'synthetic-only-recipes',engineIds:[observationEstimatorId],classifications:['SYNTHETIC'],
  collectionPolicyHashes:[config.collectionPolicyHash],populationPolicyHashes:[config.populationPolicyHash],scopeKeys:[compiled.definition.scope.key]};
 const options={storage:f.storage,tenantId:ctx.tenantId,definitions:f.definitions,authorize:async()=>true,policyFor:async()=>structuredClone(policy),validateRecipe:validateNativeObservationRecipe,clock:()=>Date.parse(at(1))};
 const registry=new NativeRecipeRegistry(options),input={key:'machine.observation',revision:1,definitionKey:f.definition.key,payload:recipe};
 return {...f,compiled,recipe,recipeHash,policy,options,registry,input,propose:()=>registry.propose(input,trainer)};
}

test('native recipe requires real contracts, independent approval, durable hashes and explicit use/read permissions',async t=>{
 const f=await setup(t),draft=await f.propose(),epoch=await f.storage.getReadRevision(ctx);
 assert.deepEqual(await f.propose(),draft);assert.equal(await f.storage.getReadRevision(ctx),epoch);
 const review=await f.registry.readRevision(f.input.key,draft.id,owner);assert.deepEqual(review.record.payload,f.recipe);assert.equal(review.usable,false);assert.equal(review.predictionReady,false);
 const history=await f.registry.listRevisions(f.input.key,owner);assert.equal(history.length,1);assert.equal('payload' in history[0],false);
 await assert.rejects(()=>f.registry.requireApproved(f.recipeHash,trainer),/RECIPE_NOT_APPROVED/);
 await assert.rejects(()=>f.registry.review(draft.id,draft.version,'APPROVE','self review',{...trainer,roles:['trainer','model_owner']}),/RECIPE_INDEPENDENT_REVIEW_REQUIRED/);
 const approved=await f.registry.review(draft.id,draft.version,'APPROVE','review explicit mechanisms and fit policy',owner);
 const reopened=new NativeRecipeRegistry({...f.options,storage:f.openStorage()}),before=await f.storage.getReadRevision(ctx);
 const result=await reopened.requireApproved(f.recipeHash,trainer);assert.deepEqual(result.payload,f.recipe);
 assert.equal(result.record.proposalHash,digest(Object.fromEntries(['revisionKey','recipeKey','revision','definitionKey','definitionHash','definitionReference','engineId','recipeHash','payload','policyHash','submittedBy','submittedAt'].map(k=>[k,result.record[k]]))));
 assert.deepEqual(await reopened.review(draft.id,draft.version,'APPROVE','review explicit mechanisms and fit policy',owner),approved);
 assert.equal(await f.storage.getReadRevision(ctx),before);
 await assert.rejects(()=>reopened.requireApproved(f.recipeHash,trainer,'recipe:draft'),/RECIPE_INVALID_INPUT/);
 f.options.authorize=async(_p,permission)=>permission!=='recipe:use';await assert.rejects(()=>f.registry.requireApproved(f.recipeHash,trainer),/RECIPE_FORBIDDEN/);
 const audits=(await f.rows('PlusOutbox')).items.filter(r=>r.envelope.audit.operation.actionType.includes('ModelRecipe'));
 assert.equal(audits.length,2);assert.equal(JSON.stringify(audits).includes('smoothingAlpha'),false);
});

test('policy drift blocks approval/use but not explicit rejection; invalid probability tables never become drafts',async t=>{
 const f=await setup(t),invalid=structuredClone(f.input);invalid.payload.baseline.hypotheses[0].initial[0].probabilities[0].p=.9;
 await assert.rejects(()=>f.registry.propose(invalid,trainer),/PROBABILITY_NORMALIZATION/);
 assert.equal((await f.rows('PlusModelRecipe')).totalCount,0);
 const draft=await f.propose();f.options.policyFor=async()=>({...f.policy,id:'changed-approved-purpose'});
 await assert.rejects(()=>f.registry.review(draft.id,draft.version,'APPROVE','stale policy',owner),/RECIPE_STALE/);
 const rejected=await f.registry.review(draft.id,draft.version,'REJECT','no longer approved policy',owner);assert.equal(rejected.status,'REJECTED');
 await assert.rejects(()=>f.registry.requireApproved(f.recipeHash,trainer),/RECIPE_NOT_APPROVED/);
});

test('same content cannot bypass a revocation under another key, and native definition changes stale prior recipes',async t=>{
 const f=await setup(t),draft=await f.propose(),approved=await f.registry.review(draft.id,draft.version,'APPROVE','approved',owner);
 await assert.rejects(()=>f.registry.propose({...f.input,key:'new-name',revision:2},trainer),/RECIPE_HASH_ALREADY_REGISTERED/);
 const author={...trainer,id:'new-definition-author',roles:['data_reviewer']};
 const d=await f.definitions.submit({...f.definition,revision:2},author),valid=await f.definitions.validate(f.definition.key,d._id,d._version,author);
 await f.definitions.review(f.definition.key,valid._id,valid._version,'APPROVE',owner);
 await assert.rejects(()=>f.registry.requireApproved(f.recipeHash,trainer),/RECIPE_CONTRACT_FORBIDDEN/);
 const historical=await f.registry.readRevision(f.input.key,draft.id,owner);assert.equal(historical.usable,false);assert.equal('payload' in historical.record,false);
 // Revocation remains available without resurrecting a superseded definition.
 assert.equal((await f.registry.revoke(approved.id,approved.version,'definition superseded',owner)).status,'REVOKED');
});

test('precommit permission loss and concurrent changes leave no partially approved recipe',async t=>{
 const f=await setup(t),draft=await f.propose();let calls=0;
 f.options.authorize=async(_p,permission)=>permission!=='recipe:review'||++calls===1;
 const epoch=await f.storage.getReadRevision(ctx);await assert.rejects(()=>f.registry.review(draft.id,draft.version,'APPROVE','denied at commit',owner),/RECIPE_FORBIDDEN/);
 assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.storage.getObject(ctx,'PlusModelRecipe',draft.id)).status,'DRAFT');
 f.options.authorize=async()=>true;const normal=f.options.validateRecipe;
 f.options.validateRecipe=async(...args)=>{await normal(...args);await f.storage.createObject(ctx,'Machine',{actual:'UNKNOWN',status:'REGISTERED',priority:1,createdAt:at(1),receivedAt:at(1),classification:'SYNTHETIC'});};
 await assert.rejects(()=>f.registry.review(draft.id,draft.version,'APPROVE','concurrent write',owner),/CONFLICT/);
 assert.equal((await f.storage.getObject(ctx,'PlusModelRecipe',draft.id)).status,'DRAFT');
});

test('revocation atomically cascades metadata fixtures without undoing completed computation or business execution',async t=>{
 const f=await setup(t),draft=await f.propose(),approved=await f.registry.review(draft.id,draft.version,'APPROVE','approved',owner),s=f.storage;
 // Deliberate lifecycle-only fixtures; actual fitting/job integration has separate tests.
 const jobs=[];for(const status of ['LEASED','SUCCEEDED']){const j=await s.createObject(ctx,'PlusExecution',{executionKey:status,kind:'FIT',inputReadSet:{},principalId:'fixture',status,attempts:1,leaseToken:'fixture-token',leaseUntil:at(3)});await s.createLink(ctx,'PlusExecutionRecipe',j._id,approved.id);jobs.push(j);}
 const release=await s.createObject(ctx,'PlusModelRelease',{releaseKey:'fixture-release',estimatorId:'fixture',updateKind:'U2',classification:'SYNTHETIC',artifactHash:'fixture',artifactKey:'fixture',consumedSources:[],evaluation:{},dependencyHash:'fixture',status:'APPROVED',createdBy:'fixture'});
 await s.createLink(ctx,'PlusReleaseRecipe',release._id,approved.id);
 const deploy=await s.createObject(ctx,'PlusDeployment',{deploymentKey:'fixture-deploy',definitionHash:'fixture',scopeKey:'synthetic',releaseKey:'fixture-release',streamCursor:0,readiness:'READY'});await s.createLink(ctx,'PlusDeploymentRelease',deploy._id,release._id);
 const belief=await s.createObject(ctx,'PlusBeliefSnapshot',{beliefKey:'fixture-belief',classification:'SYNTHETIC',distribution:{},explanation:{},engineVersion:'fixture',contentHash:'fixture',readiness:'READY'});await s.createLink(ctx,'PlusBeliefRelease',belief._id,release._id);
 const scenario=await s.createObject(ctx,'PlusScenarioRun',{scenarioKey:'fixture-scenario',classification:'SYNTHETIC',plans:[],predictions:[],utilityVersion:'fixture',contentHash:'fixture',readiness:'READY'});await s.createLink(ctx,'PlusScenarioBelief',scenario._id,belief._id);
 const requests=[];for(const status of ['APPROVED','EXECUTED']){const r=await s.createObject(ctx,'PlusActionRequest',{requestKey:status,requestHash:status,actionName:'fixture',typedParams:{},readSet:{},submittedBy:'fixture',submittedAt:at(0),status});await s.createLink(ctx,'PlusRequestScenario',r._id,scenario._id);requests.push(r);}
 let calls=0;f.options.authorize=async(_p,permission)=>permission!=='recipe:revoke'||++calls===1;
 const epoch=await s.getReadRevision(ctx);await assert.rejects(()=>f.registry.revoke(approved.id,approved.version,'deny during cascade',owner),/RECIPE_FORBIDDEN/);
 assert.equal(await s.getReadRevision(ctx),epoch);assert.equal((await s.getObject(ctx,'PlusModelRelease',release._id)).status,'APPROVED');
 f.options.authorize=async()=>true;const revoked=await f.registry.revoke(approved.id,approved.version,'withdraw approval',owner);
 assert.equal((await s.getObject(ctx,'PlusExecution',jobs[0]._id)).status,'STALE');assert.equal((await s.getObject(ctx,'PlusExecution',jobs[0]._id)).leaseToken,null);
 assert.equal((await s.getObject(ctx,'PlusExecution',jobs[1]._id)).status,'SUCCEEDED');assert.equal((await s.getObject(ctx,'PlusModelRelease',release._id)).status,'REVOKED');
 for(const r of [deploy,belief,scenario])assert.equal((await s.getObject(ctx,r._type,r._id)).readiness,'SUSPENDED');
 assert.equal((await s.getObject(ctx,'PlusActionRequest',requests[0]._id)).status,'STALE');assert.equal((await s.getObject(ctx,'PlusActionRequest',requests[1]._id)).status,'EXECUTED');
 const after=await s.getReadRevision(ctx);assert.deepEqual(await f.registry.revoke(approved.id,approved.version,'withdraw approval',owner),revoked);assert.equal(await s.getReadRevision(ctx),after);
 await assert.rejects(()=>f.registry.propose({...f.input,key:'revoked-under-another-name'},trainer),/RECIPE_HASH_ALREADY_REGISTERED/);
});

test('payload/approval corruption and a backwards server clock cannot silently produce usable recipes',async t=>{
 const f=await setup(t),draft=await f.propose();f.options.clock=()=>Date.parse(at(0));
 await assert.rejects(()=>f.registry.review(draft.id,draft.version,'APPROVE','backwards clock',owner),/RECIPE_CLOCK_ORDER/);
 f.options.clock=()=>Date.parse(at(1));await f.registry.review(draft.id,draft.version,'APPROVE','correct clock',owner);
 await f.storage.updateObject(ctx,'PlusModelRecipe',draft.id,{payload:{replaced:true}});
 await assert.rejects(()=>f.registry.requireApproved(f.recipeHash,trainer),/RECIPE_INTEGRITY/);
});

test('recipe revisions are monotonic and history rechecks current read authority without payload leakage',async t=>{
 const f=await setup(t);await f.propose();
 const next=structuredClone(f.input);next.revision=3;next.payload.config.smoothingAlpha=2;
 const draft=await f.registry.propose(next,trainer);
 const backwards=structuredClone(next);backwards.revision=2;backwards.payload.config.smoothingAlpha=3;
 await assert.rejects(()=>f.registry.propose(backwards,trainer),/RECIPE_NON_MONOTONIC_REVISION/);
 assert.deepEqual((await f.registry.listRevisions(f.input.key,owner)).map(r=>r.revision),[3,1]);
 await assert.rejects(()=>f.registry.readRevision('different.recipe',draft.id,owner),/RECIPE_NOT_FOUND/);
 f.options.policyFor=async()=>({...f.policy,id:'changed-recipe-read-policy'});
 const stale=await f.registry.readRevision(f.input.key,draft.id,owner);assert.equal(stale.staleReason,'RECIPE_STALE');assert.equal('payload' in stale.record,false);
 let calls=0;f.options.authorize=async(_p,permission)=>permission!=='recipe:read'||++calls===1;
 const epoch=await f.storage.getReadRevision(ctx);
 await assert.rejects(()=>f.registry.listRevisions(f.input.key,owner),/RECIPE_FORBIDDEN/);
 assert.equal(await f.storage.getReadRevision(ctx),epoch);
 calls=0;await assert.rejects(()=>f.registry.readRevision(f.input.key,draft.id,owner),/RECIPE_FORBIDDEN/);
});
