import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { fitObservationModel } from './observation-fit.mjs';
import { fittingContract, fittingConfig, syntheticMaterialForUnitTest } from './observation-fit-fixture.mjs';
import { observationRecipe, observationEstimatorId, createNativeObservationFitVerifier } from './native-fit-verifier.mjs';

// Isolated adapter tests. The native completion test separately uses real registry/storage.
function fixture() {
  const { compiled, baseline } = fittingContract();
  const data = syntheticMaterialForUnitTest(compiled, 'adapter-training', [{ report: 'READY' }]);
  const config = fittingConfig([data.sourceManifest.protocol]);
  const { recipe, recipeHash } = observationRecipe(compiled, baseline, config);
  const artifact = fitObservationModel(compiled, baseline, [data], config);
  const approved = { record: { _id: 'unit-recipe', _version: 2, recipeHash, engineId: observationEstimatorId,
    definitionHash: compiled.definitionHash, status: 'APPROVED' }, payload: recipe };
  const request = { recipeHash, engineId: observationEstimatorId, data, artifact: structuredClone(artifact),
    submitter: { id: 'unit-author', tenantId: 'unit-tenant', roles: ['trainer'] } };
  return { approved, request };
}

test('native verifier loads fresh approved content before and after real recomputation, without a recipe closure', async () => {
  const f = fixture(), calls = [], recipes = { requireApproved: async (...args) => { calls.push(args); return f.approved; } };
  const verify = createNativeObservationFitVerifier({ recipes }), result = await verify(f.request);
  assert.equal(calls.length, 2);
  for (const args of calls) assert.deepEqual(args, [f.request.recipeHash, f.request.submitter, 'recipe:use']);
  assert.deepEqual(result.payload, f.request.artifact); assert.equal(result.updateKind, 'U2');
  assert.equal(result.payload.predictionReady, false);
  assert.throws(() => createNativeObservationFitVerifier(), /FIT_RECIPE_AUTHORITY_REQUIRED/);
  await assert.rejects(() => verify({ ...f.request, engineId: 'unregistered-code' }), /FIT_RECIPE_MISMATCH/);
  assert.equal(calls.length, 2);
});

test('native verifier rejects stale/tampered recipes, forged fits and authority changes during verification', async () => {
  const f = fixture(); let calls = 0, mode = 'forged';
  const verify = createNativeObservationFitVerifier({ recipes: { requireApproved: async () => {
    calls++; const result = structuredClone(f.approved);
    if (mode === 'revoked' && calls % 2 === 0) throw new Error('RECIPE_NOT_APPROVED');
    if (mode === 'changed' && calls % 2 === 0) result.record._version++;
    if (mode === 'payload') result.payload.config.smoothingAlpha++;
    if (mode === 'unapproved') result.record.status = 'DRAFT';
    return result;
  } } });
  await assert.rejects(() => verify({ ...f.request, artifact: { ...f.request.artifact, statisticallyFitted: false } }), /FIT_ARTIFACT_RECOMPUTE_MISMATCH/);
  for (const [next, error] of [['revoked', /RECIPE_NOT_APPROVED/], ['changed', /FIT_RECIPE_CHANGED_DURING_VERIFICATION/],
    ['payload', /FIT_RECIPE_MISMATCH/], ['unapproved', /FIT_RECIPE_MISMATCH/]]) {
    mode = next; calls = 0; await assert.rejects(() => verify(f.request), error);
  }
});

test('adapter freezes the supplied request before its first authorization await', async () => {
  const f = fixture(), expected = digest(f.request.artifact);
  const verify = createNativeObservationFitVerifier({ recipes: { requireApproved: async () => {
    f.request.artifact.statisticallyFitted = false;
    return f.approved;
  } } });
  assert.equal(digest((await verify(f.request)).payload), expected);
});
