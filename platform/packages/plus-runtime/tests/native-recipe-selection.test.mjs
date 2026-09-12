import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '@openfoundry/plus-contracts';
import { taskLearningFixture,trainer,owner,ctx } from './task-learning-fixture.mjs';
import { createNativeRecipeSelectionResolver,createNativeComputeRecipeBindingResolver,validateNativeRecipeSelection } from '../../../../ops/plus-v2/native-recipe-selection.mjs';
import { createPrivateComputeAccess } from '../../../../ops/plus-v2/compute-access.mjs';
import { createPrivateEvaluationAccess } from '../../../../ops/plus-v2/evaluation-access.mjs';
import { createNativeReadQualificationPhase } from '../dist/index.js';
import { createPrivateAuthorizationRevision } from '../../../../ops/plus-v2/private-authority.mjs';

// Actual native recipe approval/read/revocation. Fixed synthetic domain/identity
// adapters and a planned dataset identifier: no FIT, evaluation or HTTP claim.
async function fixture(t){
  const f=await taskLearningFixture(t),recipe=f.recipe().recipe,worker={id:'selection-worker',tenantId:ctx.tenantId,roles:['plus_compute_worker']};f.people.set(worker.id,worker);
  const selection={key:'task.observation',revision:1,engineId:recipe.engineId,definitionHash:f.compiled.definitionHash,bindingHash:recipe.config.bindingHash,scopeKey:f.compiled.definition.scope.key,classification:'SYNTHETIC'};
  const authorization={key:'planned.exact.recipe',version:1};
  f.policy.compute={version:'plus-private-compute-v3',enabled:true,jobs:[{datasetId:'planned-dataset',submitterId:trainer.id,requiredRoles:trainer.roles,authorization,
    policy:{version:'plus-compute-policy-v1',workerId:worker.id,engineId:recipe.engineId,leaseMs:300000,maxAttempts:2,recipeSelection:selection}}],
    grants:[{principalId:trainer.id,requiredRoles:trainer.roles,datasetIds:['planned-dataset'],permissions:['compute:submit','compute:read-result']}],
    workers:[{principalId:worker.id,requiredRoles:worker.roles,maxItems:1}]};
  f.policy.evaluation={version:'plus-private-evaluation-v2',enabled:true,protocols:[{key:'planned.score',purpose:{version:'plus-evaluation-purpose-v1',id:'planned.score',
    evaluatorIds:['fixed-test-evaluator'],recipeSelections:[selection],classifications:['SYNTHETIC']}}],grants:[{principalId:trainer.id,requiredRoles:trainer.roles,protocolKeys:['planned.score'],permissions:['evaluation:run','evaluation:read']}]};
  const options={...f.options,recipes:f.services.recipes},resolver=createNativeRecipeSelectionResolver(options);
  const computeOptions={...f.options,engineId:recipe.engineId,recipeSelections:resolver};
  const evaluationOptions={...f.options,evaluatorIds:['fixed-test-evaluator'],recipeSelections:resolver};
  const compute=createPrivateComputeAccess(computeOptions),evaluation=createPrivateEvaluationAccess(evaluationOptions);
  const approve=async(payload=recipe,revision=1)=>{const draft=await f.services.recipes.propose({key:selection.key,revision,definitionKey:f.compiled.definition.key,payload},trainer);
    return f.services.recipes.review(draft.id,draft.version,'APPROVE','Independent exact native revision',owner);};
  return {...f,recipe,worker,selection,authorization,resolver,options,computeOptions,evaluationOptions,compute,evaluation,approve};
}
test('predeclared exact native revision resolves only after approval without changing file authority; later revisions never become latest fallback',async t=>{
  const f=await fixture(t),policyHash=digest(f.policy),authority=await f.evaluation.authorizationRevision(trainer);
  f.compute.assertConfigured();f.evaluation.assertConfigured();
  await assert.rejects(()=>f.compute.policyFor(trainer,'planned-dataset','FIT',f.authorization),/NOT_APPROVED/);
  await assert.rejects(()=>f.evaluation.policyFor(trainer,'planned.score'),/NOT_APPROVED/);
  const approved=await f.approve(),resolved=await f.compute.policyFor(trainer,'planned-dataset','FIT',f.authorization);
  assert.equal(resolved.recipeHash,approved.recipeHash);assert.equal(resolved.version,'plus-compute-policy-v2');assert.equal(resolved.recipeSelection,undefined);
  assert.deepEqual((await f.evaluation.policyFor(trainer,'planned.score')).recipeHashes,[approved.recipeHash]);
  assert.equal((await f.evaluation.policyFor(trainer,'planned.score')).recipeSelections,undefined);
  assert.equal(digest(f.policy),policyHash);assert.equal(await f.evaluation.authorizationRevision(trainer),authority);
  const next=structuredClone(f.recipe);next.config.smoothingAlpha=2;const second=await f.approve(next,2);assert.notEqual(second.recipeHash,approved.recipeHash);
  assert.deepEqual(await f.compute.policyFor(trainer,'planned-dataset','FIT',f.authorization),resolved);
  await f.services.recipes.revoke(approved.id,approved.version,'Withdraw pinned revision; do not silently select revision 2',owner);
  await assert.rejects(()=>f.compute.policyFor(trainer,'planned-dataset','FIT',f.authorization),/NOT_APPROVED/);
  await assert.rejects(()=>f.evaluation.policyFor(trainer,'planned.score'),/NOT_APPROVED/);
});
test('native selectors are exact, bounded and do not admit client hashes, wildcard/latest or a mismatched ontology target',async t=>{
  const f=await fixture(t);await f.approve();
  for(const value of [null,{},[],{...f.selection,revision:'latest'},{...f.selection,revision:0},{...f.selection,recipeHash:'a'.repeat(64)},
    {...f.selection,approved:true},{...f.selection,classification:'ANY'},{...f.selection,bindingHash:'*'}])assert.throws(()=>validateNativeRecipeSelection(value),/INVALID/);
  for(const patch of [{definitionHash:digest('other')},{bindingHash:digest('other')},{scopeKey:'other'},{classification:'AUTHORIZED_REAL'},{engineId:'different-fixed-engine'}]){
    await assert.rejects(()=>f.resolver.resolve({...f.selection,...patch},trainer),/MISMATCH/);
  }
  await assert.rejects(()=>f.resolver.resolve(f.selection,{...trainer,roles:[...trainer.roles,'model_owner']}),/FORBIDDEN/);
  await assert.rejects(()=>f.compute.policyFor(trainer,'ungranted-dataset','FIT',f.authorization),/FORBIDDEN/);
  await assert.rejects(()=>f.compute.policyFor(trainer,'planned-dataset','FIT',{...f.authorization,recipeHash:'b'.repeat(64)}),/INVALID_AUTHORIZATION/);
  await assert.rejects(()=>f.evaluation.policyFor(owner,'planned.score'),/FORBIDDEN/);
});
test('in-flight native/identity/policy changes and missing fixed resolver fail closed; legacy contracts cannot opt into selectors',async t=>{
  const f=await fixture(t);await f.approve();
  assert.throws(()=>createPrivateComputeAccess({...f.computeOptions,recipeSelections:undefined}).assertConfigured(),/INVALID_COMPUTE_CONFIGURATION/);
  assert.throws(()=>createPrivateEvaluationAccess({...f.evaluationOptions,recipeSelections:undefined}).assertConfigured(),/CONFIGURATION_INVALID/);
  f.policy.compute.version='plus-private-compute-v2';assert.throws(()=>f.compute.assertConfigured(),/INVALID_COMPUTE_CONFIGURATION/);f.policy.compute.version='plus-private-compute-v3';
  f.policy.evaluation.version='plus-private-evaluation-v1';assert.throws(()=>f.evaluation.assertConfigured(),/CONFIGURATION_INVALID/);f.policy.evaluation.version='plus-private-evaluation-v2';
  const make=race=>createNativeRecipeSelectionResolver({...f.options,recipes:{listRevisions:(...a)=>f.services.recipes.listRevisions(...a),requireApproved:async(...a)=>{const r=await f.services.recipes.requireApproved(...a);await race();return r;}}});
  await assert.rejects(()=>make(async()=>{f.policy.compute.jobs[0].policy.maxAttempts=3;}).resolve(f.selection,trainer),/AUTHORITY_STALE/);
  await assert.rejects(()=>make(async()=>{await f.storage.updateObject(ctx,'InvestigationTask',f.initial.task._id,{title:'Concurrent change'},f.initial.task._version);}).resolve(f.selection,trainer),/CONFLICT/);
  const delayed={resolve:async(...a)=>{const result=await f.resolver.resolve(...a);f.people.delete(f.worker.id);return result;}};
  const compute=createPrivateComputeAccess({...f.computeOptions,recipeSelections:delayed});
  await assert.rejects(()=>compute.policyFor(trainer,'planned-dataset','FIT',f.authorization),/WORKER_FORBIDDEN/);
});

test('compute metadata binding is exact and protected but never claims recipe-use qualification',async t=>{
  const f=await fixture(t);let qualified=0;
  const recipes={listRevisions:(...a)=>f.services.recipes.listRevisions(...a),requireApproved:async(...a)=>{qualified++;return f.services.recipes.requireApproved(...a);}};
  const binding=createNativeComputeRecipeBindingResolver({...f.options,recipes});
  await assert.rejects(()=>binding.resolve(f.selection,trainer),/NOT_APPROVED/);
  const approved=await f.approve(),resolved=await binding.resolve(f.selection,trainer);
  assert.equal(qualified,0,'Name resolution must not recursively recompute a component score');
  assert.deepEqual(Object.keys(resolved).sort(),['recipeHash','reference']);
  assert.deepEqual(resolved,{recipeHash:approved.recipeHash,reference:{id:approved.id,version:approved.version,hash:approved.recipeHash}});
  assert.deepEqual(await createNativeRecipeSelectionResolver({...f.options,recipes}).resolve(f.selection,trainer),resolved);assert.equal(qualified,1);
  for(const patch of [{definitionHash:digest('other')},{bindingHash:digest('other')},{scopeKey:'other'},{classification:'AUTHORIZED_REAL'},{engineId:'other'}])
    await assert.rejects(()=>binding.resolve({...f.selection,...patch},trainer),/MISMATCH/);
  for(const grant of f.policy.taskLearning.grants)if(grant.principalId===trainer.id)grant.permissions=grant.permissions.filter(p=>p!=='recipe:use');
  assert.deepEqual(await binding.resolve(f.selection,trainer),resolved,'Readable metadata is not usable material');
  await assert.rejects(()=>f.resolver.resolve(f.selection,trainer),/FORBIDDEN/);
  for(const grant of f.policy.taskLearning.grants)if(grant.principalId===trainer.id)grant.permissions=grant.permissions.filter(p=>p!=='recipe:read');
  await assert.rejects(()=>binding.resolve(f.selection,trainer),/FORBIDDEN/);
});

test('compute binding retains current authority and native fences without reusing a metadata list across requests',async t=>{
  const f=await fixture(t);await f.approve();let lists=0,race;
  const recipes={requireApproved:()=>assert.fail('Binding must not grant use'),listRevisions:async(...args)=>{lists++;const rows=await f.services.recipes.listRevisions(...args);await race?.();return rows;}};
  const binding=createNativeComputeRecipeBindingResolver({...f.options,recipes});
  await binding.resolve(f.selection,trainer);await binding.resolve(f.selection,trainer);assert.equal(lists,2);
  race=async()=>{f.policy.compute.jobs[0].policy.maxAttempts=3;};
  await assert.rejects(()=>binding.resolve(f.selection,trainer),/AUTHORITY_STALE/);
  race=async()=>{await f.storage.updateObject(ctx,'InvestigationTask',f.initial.task._id,{title:'Concurrent binding read'},f.initial.task._version);};
  await assert.rejects(()=>binding.resolve(f.selection,trainer),/CONFLICT/);
  race=async()=>{f.people.delete(trainer.id);};await assert.rejects(()=>binding.resolve(f.selection,trainer),/FORBIDDEN/);
});

test('fully qualified selectors never fall back to readable metadata when an approval provider returns no result',async t=>{
  const f=await fixture(t);await f.approve();
  for(const invalid of [undefined,null,false,0,'',[],{}]){
    const resolver=createNativeRecipeSelectionResolver({...f.options,recipes:{listRevisions:(...a)=>f.services.recipes.listRevisions(...a),requireApproved:async()=>invalid}});
    await assert.rejects(()=>resolver.resolve(f.selection,trainer),/NATIVE_RECIPE_SELECTION_INTEGRITY|NATIVE_RECIPE_SELECTION_MISMATCH/);
  }
});

test('actual native recipe use is qualified once per read phase and freshly in independent phases; revocation still rejects',async t=>{
  const f=await fixture(t),approved=await f.approve(),registry=f.services.recipes;
  const validate=registry.config.validateRecipe;let validations=0;
  registry.config.validateRecipe=async(...args)=>{validations++;return validate(...args);};
  const phase=createNativeReadQualificationPhase({...f.options,readers:[registry],authorizationRevision:createPrivateAuthorizationRevision(f.options)});
  await phase.run(trainer,async()=>{
    const first=await registry.requireApproved(approved.recipeHash,trainer);first.payload.config.smoothingAlpha=99;
    assert.notEqual((await registry.requireApproved(approved.recipeHash,trainer)).payload.config.smoothingAlpha,99);
  });assert.equal(validations,1);
  await phase.run(trainer,()=>registry.requireApproved(approved.recipeHash,trainer));assert.equal(validations,2);
  await registry.requireApproved(approved.recipeHash,trainer);assert.equal(validations,3,'No phase means original full native qualification');
  await registry.revoke(approved.id,approved.version,'Withdraw after read-phase proof',owner);
  await assert.rejects(()=>phase.run(trainer,()=>registry.requireApproved(approved.recipeHash,trainer)),/NOT_APPROVED/);
});
