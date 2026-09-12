import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { NativeComputeAdmission,NativeRecipeRegistry } from '../../platform/packages/plus-runtime/dist/index.js';
import { datasetFixture, trainer, reviewer, owner } from '../../platform/packages/plus-runtime/tests/dataset-fixture.mjs';
import { ctx, at } from '../../platform/packages/plus-runtime/tests/episode-fixture.mjs';
import { baselineFor, fittingConfig } from './observation-fit-fixture.mjs';
import { fitObservationModel } from './observation-fit.mjs';
import { observationRecipe, observationEstimatorId, createObservationFitVerifier,createNativeObservationFitVerifier,validateNativeObservationRecipe } from './native-fit-verifier.mjs';
const worker = { id: 'private-fit-worker', tenantId: ctx.tenantId, roles: [] };

async function setup(t, { nativeVerifier = false } = {}) {
  const f = await datasetFixture(t); await f.addLabel(); f.advance(9); let now = 9, current = true;
  const frozen = await f.registry.freeze(f.cohort.id, trainer);
  const { compiled } = await f.definitions.requirePublished(f.definition.key, trainer);
  const baseline = baselineFor(compiled), fitting = fittingConfig([f.policy], f.inputs[0].compiledInput.bindingHash);
  const { recipe, recipeHash } = observationRecipe(compiled, baseline, fitting);
  const recipePolicy={version:'plus-recipe-policy-v1',id:'synthetic-recipe-purpose',engineIds:[observationEstimatorId],classifications:['SYNTHETIC'],
    collectionPolicyHashes:[fitting.collectionPolicyHash],populationPolicyHashes:[fitting.populationPolicyHash],scopeKeys:[compiled.definition.scope.key]};
  const recipeConfig={storage:f.storage,tenantId:ctx.tenantId,definitions:f.definitions,authorize:async()=>true,policyFor:async()=>structuredClone(recipePolicy),
    validateRecipe:validateNativeObservationRecipe,clock:()=>Date.parse(at(now))};
  const recipes=new NativeRecipeRegistry(recipeConfig),draft=await recipes.propose({key:'machine.observation',revision:1,definitionKey:f.definition.key,payload:recipe},trainer);
  const approved=await recipes.review(draft.id,draft.version,'APPROVE','independent recipe review',owner);
  const policy = { version: 'plus-compute-policy-v1', workerId: worker.id, engineId: observationEstimatorId, recipeHash, leaseMs: 1000, maxAttempts: 2 };
  const verify = nativeVerifier ? createNativeObservationFitVerifier({ recipes }) : createObservationFitVerifier({ recipe, assertCurrent: async ({ definitionHash, submitter }) => {
    const latest = await f.definitions.requirePublished(f.definition.key, submitter);
    return current && latest.compiled.definitionHash === definitionHash && digest(latest.compiled) === digest(compiled);
  } });
  const config = { storage: f.storage, tenantId: ctx.tenantId, datasets: f.registry, authorize: async () => true,
    policyFor: async () => structuredClone(policy), resolvePrincipal: async id => id === trainer.id ? structuredClone(trainer) : { ...trainer, id: 'invalid' },
    verifyFitResult: verify, recipes, clock: () => Date.parse(at(now)) };
  const admission = new NativeComputeAdmission(config);
  const job = await admission.enqueue(frozen.id, 'FIT', trainer, 'native-model-fit');
  const dispatch = await admission.claim(job.id, worker);
  const candidate = () => fitObservationModel(compiled, baseline, [dispatch.input], fitting);
  const complete = payload => admission.completeFit(job.id, dispatch.version, dispatch.leaseToken, payload ?? candidate(), worker);
  return { ...f, frozen, compiled, baseline, fitting, recipe, recipeHash, policy, config, verify, admission, job, dispatch, candidate, complete,recipes,recipeConfig,recipePolicy,approved,
    advance: n => { now = n; f.advance(n); }, setCurrent: v => current = v };
}

test('real fit process → verified atomic native candidate; durable retry, source grants and revocation hold', async t => {
  const f = await setup(t, { nativeVerifier: true });
  assert.equal(f.dispatch.recipeHash, f.recipeHash); assert.deepEqual(f.dispatch.recipe,f.recipe);
  const process = spawnSync(globalThis.process.execPath, [fileURLToPath(new URL('./fit-once.mjs', import.meta.url))], {
    input: JSON.stringify({ schema: 'plus-observation-fit-request-v1', compiled: f.compiled, baseline: f.baseline, materials: [f.dispatch.input], config: f.fitting }),
    encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  });
  assert.equal(process.status, 0, process.stdout + process.stderr); const payload = JSON.parse(process.stdout).candidate;
  // Reconstruct the verifier without carrying any recipe/baseline/config closure.
  const restoredRecipes = new NativeRecipeRegistry({ ...f.recipeConfig, storage: f.openStorage() });
  f.config.verifyFitResult = createNativeObservationFitVerifier({ recipes: restoredRecipes });
  const result = await f.complete(payload);
  assert.equal(result.status, 'SUCCEEDED'); assert.equal(result.deploymentAuthorized, false);
  assert.equal((await f.rows('PlusModelArtifact')).totalCount, 1); assert.equal((await f.rows('PlusModelRelease')).totalCount, 1);
  const release = await f.storage.getObject(ctx, 'PlusModelRelease', result.candidateId), stored = await f.storage.getObject(ctx, 'PlusModelArtifact', result.artifactId);
  assert.equal(release.status, 'CANDIDATE'); assert.equal(release.evaluation.state, 'NOT_EVALUATED');
  assert.deepEqual(stored.payload, payload); assert.equal(stored.contentHash, digest(payload));
  const exposure = await f.storage.getObject(ctx, 'PlusDataExposure', f.dispatch.exposureId);
  assert.equal(exposure.phase, 'AUTHORIZED_DISPATCH');
  assert.deepEqual(release.consumedSources.identities, exposure.sourceManifest.identities);
  assert.ok(release.consumedSources.identities.length > 5);
  for (const [link, count] of [['PlusReleaseArtifact', 1], ['PlusReleaseExecution', 1], ['PlusReleaseDataset', 1], ['PlusReleaseExposure', 1], ['PlusReleaseRecipe',1], ['PlusReleaseIdentity', exposure.sourceManifest.identities.length]])
    assert.equal((await f.storage.getLinks(ctx, release._id, link, 'outbound')).totalCount, count);
  const epoch = await f.storage.getReadRevision(ctx), reopened = new NativeComputeAdmission({ ...f.config, storage: f.openStorage() });
  assert.deepEqual(await reopened.completeFit(f.job.id, f.dispatch.version, f.dispatch.leaseToken, payload, worker), result);
  assert.deepEqual((await reopened.readFitResult(f.job.id, trainer)).payload, payload);
  assert.equal(await f.storage.getReadRevision(ctx), epoch);
  const audits = (await f.rows('PlusOutbox')).items.filter(r => r.envelope.audit.operation.actionType === 'PlusCompleteVerifiedFit');
  assert.equal(audits.length, 1); assert.equal(JSON.stringify(audits).includes(f.dispatch.leaseToken), false);
  assert.equal(JSON.stringify(audits).includes('PRIVATE_RAW_EVIDENCE'), false);
  const reader = { ...trainer, id: 'restricted-result-reader' };
  f.datasetConfig.authorize = async p => p.id !== reader.id;
  await assert.rejects(() => reopened.readFitResult(f.job.id, reader), /DATASET_FORBIDDEN/);
  f.datasetConfig.authorize = async () => true;
  const source = (await f.rows('PlusEvent')).items.find(e => e.eventKind === 'OBSERVATION');
  const change = await f.runtime.proposeSourceChange({ episodeId: f.episodes[0]._id, kind: 'REVOCATION', eventId: source._id, eventVersion: source._version,
    reason: 'withdraw fitted source' }, reviewer, 'withdraw-fitted-source');
  await f.runtime.reviewSourceChange(change._id, change._version, 'APPROVE', 'withdraw training data', owner);
  assert.equal((await f.storage.getObject(ctx, 'PlusModelRelease', release._id)).status, 'REVOKED');
  assert.equal((await f.storage.getObject(ctx, 'PlusExecution', f.job.id)).status, 'SUCCEEDED'); // historical computation happened
  assert.deepEqual((await f.storage.getObject(ctx, 'PlusModelArtifact', stored._id)).payload, payload);
  await assert.rejects(() => reopened.readFitResult(f.job.id, trainer), /DATASET_STALE/);
  await assert.rejects(() => f.complete(payload), /DATASET_STALE/);
  assert.equal((await f.rows('PlusDeployment')).totalCount, 0);
});

test('native recipe revocation fences existing jobs and idempotent results even with a permissive local verifier',async t=>{
 const f=await setup(t),payload=f.candidate(),done=await f.complete(payload);
 const pending=await f.admission.enqueue(f.frozen.id,'FIT',trainer,'pending-native-recipe-job');
 const another=await f.admission.enqueue(f.frozen.id,'FIT',trainer,'leased-native-recipe-job'),lease=await f.admission.claim(another.id,worker);
 const restored=new NativeRecipeRegistry({...f.recipeConfig,storage:f.openStorage()});
 assert.deepEqual((await restored.requireApproved(f.recipeHash,trainer)).payload,f.recipe);
 const revoked=await restored.revoke(f.approved.id,f.approved.version,'withdraw native recipe approval',owner);
 assert.equal(revoked.status,'REVOKED');assert.equal((await f.storage.getObject(ctx,'PlusExecution',pending.id)).status,'STALE');
 assert.equal((await f.storage.getObject(ctx,'PlusExecution',another.id)).leaseToken,null);
 assert.equal((await f.storage.getObject(ctx,'PlusExecution',f.job.id)).status,'SUCCEEDED');
 assert.equal((await f.storage.getObject(ctx,'PlusModelRelease',done.candidateId)).status,'REVOKED');
 await assert.rejects(()=>f.complete(payload),/RECIPE_NOT_APPROVED/);
 await assert.rejects(()=>f.admission.readFitResult(f.job.id,trainer),/RECIPE_NOT_APPROVED/);
 await assert.rejects(()=>f.admission.enqueue(f.frozen.id,'FIT',trainer,'new-after-revocation'),/RECIPE_NOT_APPROVED/);
 await assert.rejects(()=>f.admission.completeFit(another.id,lease.version,lease.leaseToken,payload,worker),/COMPUTE_LEASE_CONFLICT/);
 const epoch=await f.storage.getReadRevision(ctx);assert.deepEqual(await restored.revoke(f.approved.id,f.approved.version,'withdraw native recipe approval',owner),revoked);
 assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.rows('PlusDataExposure')).totalCount,2);
});

test('worker cannot submit fabricated fits, different recipes or results after source/identity authority changed', async t => {
  const f = await setup(t), payload = f.candidate();
  await assert.rejects(() => f.admission.completeFit(f.job.id, f.dispatch.version, f.dispatch.leaseToken, payload, { ...worker, id: 'wrong-worker' }), /COMPUTE_WORKER_FORBIDDEN/);
  const forged = structuredClone(payload); forged.statisticallyFitted = false;
  await assert.rejects(() => f.complete(forged), /FIT_ARTIFACT_RECOMPUTE_MISMATCH/);
  f.config.policyFor = async () => ({ ...f.policy, recipeHash: digest('different-recipe') });
  await assert.rejects(() => f.complete(payload), /COMPUTE_POLICY_STALE/); f.config.policyFor = async () => f.policy;
  f.setCurrent(false); await assert.rejects(() => f.complete(payload), /FIT_RECIPE_NO_LONGER_AUTHORIZED/); f.setCurrent(true);
  f.config.resolvePrincipal = async () => ({ ...trainer, roles: [] });
  await assert.rejects(() => f.complete(payload), /COMPUTE_SUBMITTER_STALE/); f.config.resolvePrincipal = async () => trainer;
  f.config.verifyFitResult = undefined; await assert.rejects(() => f.complete(payload), /COMPUTE_FIT_VERIFIER_REQUIRED/);
  assert.equal((await f.rows('PlusModelRelease')).totalCount, 0); assert.equal((await f.rows('PlusModelArtifact')).totalCount, 0);
  assert.equal((await f.admission.inspect(f.job.id, trainer)).status, 'LEASED');
});

test('expiration during verification and a reclaimed lease reject old completion; latest lease can finish', async t => {
  const f = await setup(t), payload = f.candidate();
  f.config.verifyFitResult = async request => { const verified = await f.verify(request); f.advance(9.1); return verified; };
  await assert.rejects(() => f.complete(payload), /COMPUTE_LEASE_CONFLICT/);
  assert.equal((await f.rows('PlusModelArtifact')).totalCount, 0);
  f.config.verifyFitResult = f.verify; const second = await f.admission.claim(f.job.id, worker);
  assert.equal(second.attempt, 2); await assert.rejects(() => f.complete(payload), /COMPUTE_LEASE_CONFLICT/);
  const result = await f.admission.completeFit(f.job.id, second.version, second.leaseToken, payload, worker);
  assert.equal(result.status, 'SUCCEEDED'); assert.equal((await f.rows('PlusDataExposure')).totalCount, 2);
  assert.equal((await f.storage.getObject(ctx, 'PlusModelRelease', result.candidateId)).consumedSources.exposureId, second.exposureId);
});

test('precommit permission denial rolls back artifact, release, links and job; concurrent read-set changes reject', async t => {
  const f = await setup(t), payload = f.candidate(); let calls = 0;
  f.config.authorize = async (_p, permission) => permission !== 'compute:complete' || ++calls === 1;
  const epoch = await f.storage.getReadRevision(ctx);
  await assert.rejects(() => f.complete(payload), /COMPUTE_FORBIDDEN/);
  assert.equal(await f.storage.getReadRevision(ctx), epoch); assert.equal((await f.rows('PlusModelArtifact')).totalCount, 0);
  assert.equal((await f.rows('PlusModelRelease')).totalCount, 0); assert.equal((await f.admission.inspect(f.job.id, trainer)).status, 'LEASED');
  f.config.authorize = async () => true;
  f.config.verifyFitResult = async request => {
    const checked = await f.verify(request);
    await f.storage.createObject(ctx, 'Machine', { actual: 'UNKNOWN', status: 'REGISTERED', priority: 1, createdAt: at(9), receivedAt: at(9), classification: 'SYNTHETIC' });
    return checked;
  };
  await assert.rejects(() => f.complete(payload), /CONFLICT/);
  assert.equal((await f.rows('PlusModelArtifact')).totalCount, 0); assert.equal((await f.rows('PlusModelRelease')).totalCount, 0);
  f.config.verifyFitResult = f.verify; assert.equal((await f.complete(payload)).status, 'SUCCEEDED');
});

test('postcommit response loss does not undo success; repeat completion is idempotent and payload-bound', async t => {
  const f = await setup(t), payload = f.candidate(); let calls = 0;
  f.config.authorize = async (_p, permission) => permission !== 'compute:complete' || ++calls <= 2;
  await assert.rejects(() => f.complete(payload), /COMPUTE_FORBIDDEN/);
  assert.equal((await f.storage.getObject(ctx, 'PlusExecution', f.job.id)).status, 'SUCCEEDED');
  assert.equal((await f.rows('PlusModelArtifact')).totalCount, 1); assert.equal((await f.rows('PlusModelRelease')).totalCount, 1);
  f.config.authorize = async () => true; const epoch = await f.storage.getReadRevision(ctx), result = await f.complete(payload);
  assert.equal(result.status, 'SUCCEEDED'); assert.equal(await f.storage.getReadRevision(ctx), epoch);
  await assert.rejects(() => f.complete({ ...payload, success: true }), /COMPUTE_COMPLETION_CONFLICT/);
  await assert.rejects(() => f.admission.completeFit(f.job.id, f.dispatch.version, 'different-token', payload, worker), /COMPUTE_COMPLETION_CONFLICT/);
  const release=await f.storage.getObject(ctx,'PlusModelRelease',result.candidateId);
  await f.storage.updateObject(ctx,'PlusModelRelease',release._id,{classification:'AUTHORIZED_REAL'});
  await assert.rejects(()=>f.admission.readFitResult(f.job.id,trainer),/COMPUTE_RESULT_INTEGRITY/);
  await f.storage.updateObject(ctx,'PlusModelRelease',release._id,{classification:'SYNTHETIC'});
  const stored = await f.storage.getObject(ctx, 'PlusModelArtifact', result.artifactId);
  await f.storage.updateObject(ctx, 'PlusModelArtifact', stored._id, { payload: { replaced: true } });
  await assert.rejects(() => f.admission.readFitResult(f.job.id, trainer), /COMPUTE_RESULT_INTEGRITY/);
});
