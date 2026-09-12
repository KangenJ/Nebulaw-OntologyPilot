import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeRecipeRegistry } from '../../platform/packages/plus-runtime/dist/index.js';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { ruleFixture, author, owner, ctx } from '../../platform/packages/plus-runtime/tests/rule-registry-fixture.mjs';
import { baselineFor, fittingConfig, protocolFor } from './observation-fit-fixture.mjs';
import { observationRecipe } from './native-fit-verifier.mjs';
import { neuralObservationRecipe, neuralObservationEstimatorId } from './native-neural-fit-verifier.mjs';
import { registeredEstimatorIds, registeredFitRequest } from './estimator-registry.mjs';
import { compositionRecipe, compositionEstimatorId, createNativeCompositionRecipeValidation } from './native-composition-recipe.mjs';

// Real native ontology/definition/rule approvals and transactions. Synthetic
// Machine domain and explicit test permission adapters; not Task HTTP or FIT.
const trainer = { ...author, roles: [...author.roles, 'trainer'] };
const count = async (storage, type) => (await storage.queryObjects(ctx, type, { and: [] })).totalCount;
async function fixture(t) {
  const f = await ruleFixture(t), rule = await f.approve();
  const compiled = (await f.definitions.requirePublished(f.definition.key, trainer)).compiled;
  const preview = await f.definitions.previewComposition(f.definition.key, trainer);
  const fit = fittingConfig([protocolFor(preview.composition.statistics, 'composition-native-test', 1)]);
  const statistics = observationRecipe(preview.composition.statistics, baselineFor(preview.composition.statistics), fit).recipe;
  const ruleSpecification = (await f.registry.requireApproved(rule.specificationHash, trainer)).record;
  const { recipe: payload } = compositionRecipe({ compiled, composition: preview.composition, statistics, ruleSpecification });
  const policy = { version: 'plus-recipe-policy-v1', id: 'synthetic-composition-recipe', engineIds: [compositionEstimatorId], classifications: ['SYNTHETIC'],
    collectionPolicyHashes: [fit.collectionPolicyHash], populationPolicyHashes: [fit.populationPolicyHash], scopeKeys: [compiled.definition.scope.key] };
  const configuration = { storage: f.storage, tenantId: ctx.tenantId, definitions: f.definitions,
    authorize: async p => [trainer.id, owner.id].includes(p.id), policyFor: async () => structuredClone(policy),
    ...createNativeCompositionRecipeValidation({ definitions: f.definitions, ruleSpecifications: f.registry }),
    dependencyAuthorizationRevision: async () => digest({ state: f.state, policy }), clock: f.config.clock };
  const recipes = new NativeRecipeRegistry(configuration);
  const input = { key: 'machine.composed', revision: 1, definitionKey: f.definition.key, payload };
  const approve = async () => { const d = await recipes.propose(input, trainer); return recipes.review(d.id, d.version, 'APPROVE', 'Independent composition recipe review', owner); };
  return { ...f, rule, compiled, payload, input, recipes, configuration, approveRecipe: approve };
}
function faultStorage(storage, hook) {
  return new Proxy(storage, { get(target, prop) {
    if (prop === 'beginTransaction') return async (...args) => {
      const tx = await target.beginTransaction(...args);
      return new Proxy(tx, { get(t, k) {
        if (['createLink', 'createObject'].includes(k)) return async (...args) => { await hook(k, args); return t[k](...args); };
        const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v;
      } });
    };
    const v = Reflect.get(target, prop); return typeof v === 'function' ? v.bind(target) : v;
  } });
}

test('composition recipe has real independently approved native dependency, reopens and never grants model readiness', async t => {
  const f = await fixture(t), draft = await f.recipes.propose(f.input, trainer);
  await assert.rejects(() => f.recipes.review(draft.id, draft.version, 'APPROVE', 'self', { ...trainer, roles: [...trainer.roles, 'model_owner'] }), /INDEPENDENT_REVIEW/);
  const approved = await f.recipes.review(draft.id, draft.version, 'APPROVE', 'reviewed', owner);
  const checked = await f.recipes.requireApproved(approved.recipeHash, trainer);
  assert.deepEqual(checked.payload, f.payload);
  const links = await f.storage.getLinks(ctx, draft.id, 'PlusRecipeRuleSpecification', 'outbound');
  assert.deepEqual(links.items.map(r => r._toId), [f.rule.id]);
  const before = await count(f.storage, 'PlusOutbox');
  assert.equal((await f.recipes.propose(f.input, trainer)).id, draft.id);
  assert.equal((await f.recipes.review(draft.id, draft.version, 'APPROVE', 'reviewed', owner)).id, draft.id);
  assert.equal(await count(f.storage, 'PlusOutbox'), before);
  f.close(f.storage); const g = f.reopen();
  const reopened = new NativeRecipeRegistry({ ...f.configuration, storage: g.storage, definitions: g.definitions,
    ...createNativeCompositionRecipeValidation({ definitions: g.definitions, ruleSpecifications: g.registry }) });
  assert.deepEqual((await reopened.requireApproved(approved.recipeHash, trainer)).payload, f.payload);
  const read = await reopened.readRevision(f.input.key, draft.id, owner);
  assert.equal(read.usable, true); assert.equal(read.predictionReady, false);
  assert.equal(await count(g.storage, 'PlusModelRelease'), 0); assert.equal(await count(g.storage, 'PlusDeployment'), 0);
  assert.equal(registeredEstimatorIds.includes(compositionEstimatorId), false);
  assert.throws(() => registeredFitRequest(f.payload, []), /FIT_ENGINE_UNSUPPORTED/);
});

test('composition recipe rejects self-rehashed projection, malformed inner estimator and forged dependencies before writes', async t => {
  const f = await fixture(t), before = await count(f.storage, 'PlusOutbox');
  const attacks = [
    p => { p.composition.constraints.ruleToGold = 'ALLOWED'; p.composition.contentHash = digest(p.composition); },
    p => { p.statistics.baseline.hypotheses[0].prior = -1; },
    p => { p.compiled.definition.title = 'forged parent'; },
    p => { p.nativeDependencies[0].hash = '0'.repeat(64); },
    p => { p.nativeDependencies[0].kind = 'CLIENT_APPROVAL'; },
    p => { p.nativeDependencies.push(structuredClone(p.nativeDependencies[0])); },
    p => { p.ruleSpecificationHash = digest('unknown native rule'); },
  ];
  for (const mutate of attacks) {
    const payload = structuredClone(f.payload); mutate(payload);
    await assert.rejects(() => f.recipes.propose({ ...f.input, payload }, trainer));
  }
  assert.equal(await count(f.storage, 'PlusModelRecipe'), 0); assert.equal(await count(f.storage, 'PlusOutbox'), before);
});

test('composition binds the fixed non-Transformer U3 layout and rejects capacity forgery without registering a new FIT worker', async t => {
  const f = await fixture(t), payload = structuredClone(f.payload), base = payload.statistics;
  payload.statistics = neuralObservationRecipe(base.compiled, base.baseline, { schema: 'plus-neural-observation-config-v1', supervision: base.config,
    network: { schema: 'one-hot-tanh-softmax-v1', hiddenWidth: 4, epochs: 100, learningRate: .2, l2: .001, seed: 41 } }).recipe;
  const draft = await f.recipes.propose({ ...f.input, payload }, trainer);
  const approved = await f.recipes.review(draft.id, draft.version, 'APPROVE', 'Reviewed U3 composition recipe, not a fitted model', owner);
  assert.equal((await f.recipes.requireApproved(approved.recipeHash, trainer)).payload.statistics.engineId, neuralObservationEstimatorId);
  const bad = structuredClone(payload); bad.statistics.network.hiddenWidth = 1000000;
  await assert.rejects(() => f.recipes.propose({ ...f.input, revision: 2, payload: bad }, trainer), /NEURAL_/);
  assert.throws(() => registeredFitRequest(payload, []), /FIT_ENGINE_UNSUPPORTED/);
  assert.equal(await count(f.storage, 'PlusModelRecipe'), 1); assert.equal(await count(f.storage, 'PlusModelRelease'), 0);
});

test('native rule withdrawal, changed source and source-field withdrawal invalidate recipe use while history and revocation remain possible', async t => {
  for (const fault of ['rule', 'source', 'fields']) {
    const f = await fixture(t), approved = await f.approveRecipe();
    if (fault === 'rule') await f.registry.revoke(f.rule.id, f.rule.version, 'Withdraw rule', owner);
    if (fault === 'source') await f.storage.updateObject(ctx, 'RuleDocument', f.source._id, { lifecycle: 'WITHDRAWN' }, f.source._version);
    if (fault === 'fields') f.state.sourceReadable = false;
    await assert.rejects(() => f.recipes.requireApproved(approved.recipeHash, trainer), /RECIPE_DEPENDENCY_STALE|RULE_SOURCE_STALE|RULE_SOURCE_FORBIDDEN/);
    assert.equal((await f.recipes.listRevisions(f.input.key, owner))[0].id, approved.id);
    assert.equal((await f.recipes.revoke(approved.id, approved.version, 'Retire dependent recipe', owner)).status, 'REVOKED');
  }
});

test('composition recipe requires fixed source qualifier and full authorization revision', async t => {
  const f = await fixture(t);
  for (const missing of ['qualifyDependencies', 'dependencyAuthorizationRevision']) {
    const config = { ...f.configuration, [missing]: undefined };
    await assert.rejects(() => new NativeRecipeRegistry(config).propose(f.input, trainer), /RECIPE_DEPENDENCY_QUALIFIER_REQUIRED/);
  }
  await assert.rejects(() => new NativeRecipeRegistry({ ...f.configuration, dependencyAuthorizationRevision: async () => 'unversioned' }).propose(f.input, trainer), /RECIPE_DEPENDENCY_AUTHORITY_INVALID/);
  assert.equal(await count(f.storage, 'PlusModelRecipe'), 0);
});

test('dependency link or outbox failure rolls back native recipe and all its links', async t => {
  for (const fault of ['link', 'outbox']) {
    const f = await fixture(t), before = await count(f.storage, 'PlusOutbox');
    const storage = faultStorage(f.storage, async (operation, args) => {
      if ((fault === 'link' && operation === 'createLink' && args[0] === 'PlusRecipeRuleSpecification')
        || (fault === 'outbox' && operation === 'createObject' && args[0] === 'PlusOutbox')) throw Error('injected composition failure');
    });
    await assert.rejects(() => new NativeRecipeRegistry({ ...f.configuration, storage }).propose(f.input, trainer), /injected composition failure/);
    assert.equal(await count(f.storage, 'PlusModelRecipe'), 0); assert.equal(await count(f.storage, 'PlusOutbox'), before);
    assert.equal((await f.storage.getLinks(ctx, f.rule.id, 'PlusRecipeRuleSpecification', 'inbound')).totalCount, 0);
  }
});

test('full source authority changes while staging draft or approval rollback even when recipe role still allows access', async t => {
  for (const operation of ['draft', 'review']) {
    const f = await fixture(t), draft = operation === 'review' ? await f.recipes.propose(f.input, trainer) : undefined;
    const before = await count(f.storage, 'PlusOutbox');
    const storage = faultStorage(f.storage, async (op, args) => {
      if (op === 'createObject' && args[0] === 'PlusOutbox') { f.state.sourceReadable = false; f.state.authorizationRevision++; }
    });
    const recipes = new NativeRecipeRegistry({ ...f.configuration, storage });
    await assert.rejects(() => draft ? recipes.review(draft.id, draft.version, 'APPROVE', 'reviewed', owner) : recipes.propose(f.input, trainer), /RECIPE_DEPENDENCY_AUTHORITY_STALE/);
    assert.equal(await count(f.storage, 'PlusOutbox'), before);
    if (draft) assert.equal((await f.storage.getObject(ctx, 'PlusModelRecipe', draft.id)).status, 'DRAFT');
    else assert.equal(await count(f.storage, 'PlusModelRecipe'), 0);
  }
});

test('missing or substituted dependency relationship is rejected on approved current read', async t => {
  const f = await fixture(t), approved = await f.approveRecipe();
  const link = (await f.storage.getLinks(ctx, approved.id, 'PlusRecipeRuleSpecification', 'outbound')).items[0];
  await f.storage.deleteLink(ctx, 'PlusRecipeRuleSpecification', link._id);
  await assert.rejects(() => f.recipes.requireApproved(approved.recipeHash, trainer), /RECIPE_DEPENDENCY_LINK_INVALID/);
});
