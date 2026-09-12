import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { datasetFixture, trainer, reviewer, owner } from '../../platform/packages/plus-runtime/tests/dataset-fixture.mjs';
import { ctx, principal, at } from '../../platform/packages/plus-runtime/tests/episode-fixture.mjs';
import { baselineFor, fittingConfig } from './observation-fit-fixture.mjs';
import { fitObservationModel, verifyObservationFit } from './observation-fit.mjs';

test('same native SQLite ledger: two prospective cohorts, new independent GOLD, frozen data and reproducible U2 process fitting', async t => {
  const f = await datasetFixture(t);
  const { compiled } = await f.definitions.requirePublished(f.definition.key, trainer);
  const baseline = baselineFor(compiled);
  // Both software sampling protocols and estimator thresholds are fixed before
  // first-round labels. This is not a production protocol approval mechanism.
  const secondPolicy = { ...f.policy, key: 'cohort-round-2', inputVisibleFrom: at(11), inputVisibleUntil: at(12),
    labelReceivedFrom: at(13), labelReceivedUntil: at(17), approvalUntil: at(19) };
  const protocols = new Map([[f.policy.key, f.policy], [secondPolicy.key, secondPolicy]]);
  f.datasetConfig.protocolFor = async (_p, key) => structuredClone(protocols.get(key));
  const config = fittingConfig([...protocols.values()], f.inputs[0].compiledInput.bindingHash);
  await f.addLabel(0, { value: 'READY' }); f.advance(9);
  const firstDataset = await f.registry.freeze(f.cohort.id, trainer);
  const firstData = await f.registry.materialize(firstDataset.id, 'FIT', trainer);
  const first = fitObservationModel(compiled, baseline, [firstData], config);
  assert.equal(first.coverage.fitted, 1);
  assert.equal(first.consumption.feedback[0].id, firstData.sourceManifest.feedbackRefs[0].id);
  assert.equal(first.consumption.allSamples[0].inputSnapshotId, f.inputs[0]._id);

  f.advance(12);
  const root = await f.storage.createObject(ctx, 'Machine', { actual: 'UNKNOWN', status: 'REGISTERED', priority: 1,
    createdAt: at(10), receivedAt: at(10), classification: 'SYNTHETIC' });
  await f.add({ rootId: root._id, origin: 'round-2-new-observation', value: 'BUSY', minute: 11, received: 11 });
  const episode = await f.runtime.open({ definitionKey: f.definition.key, rootId: root._id, startedAt: at(10) }, principal, 'round-2-episode');
  const snapshot = async key => {
    const stream = await f.runtime.capture(episode._id, principal, 'capture-' + key);
    return (await f.runtime.snapshot({ streamId: stream.record._id, targetTime: at(11) }, principal, 'input-' + key)).record;
  };
  const input = await snapshot('round-2-early'); await f.partitions.reserve(input._id, trainer);
  const draft = await f.registry.proposeCohort(secondPolicy.key, [input._id], trainer);
  const cohort = await f.registry.reviewCohort(draft.id, draft.version, 'APPROVE', 'independent approval before round-2 label window', reviewer);
  f.advance(14);
  const check = await f.add({ rootId: root._id, origin: 'round-2-independent-gold', kind: 'VERIFICATION', value: 'READY', minute: 11, received: 14 });
  const labels = await snapshot('round-2-labels'); await f.partitions.reserve(labels._id, trainer); f.advance(14.1);
  const feedback = await f.feedback.propose({ inputSnapshotId: input._id, labelSnapshotId: labels._id, eventId: check.event._id }, trainer);
  await f.feedback.review(feedback.id, feedback.version, 'APPROVE', 'independent same-target gold qualification', reviewer);
  f.advance(19);
  const secondDataset = await f.registry.freeze(cohort.id, trainer);
  const materials = await Promise.all([firstDataset.id, secondDataset.id].map(id => f.registry.materialize(id, 'FIT', trainer)));
  assert.deepEqual(materials[0], firstData); // no future labels retroactively mutate round 1
  const readEpoch = await f.storage.getReadRevision(ctx);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./fit-once.mjs', import.meta.url))], {
    input: JSON.stringify({ schema: 'plus-observation-fit-request-v1', compiled, baseline, materials, config }),
    encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const response = JSON.parse(result.stdout), second = response.candidate;
  assert.equal(response.deploymentAuthorized, false); assert.equal(second.coverage.fitted, 2);
  assert.notEqual(second.artifactHash, first.artifactHash); assert.notEqual(second.kernelHash, first.kernelHash);
  const p = (artifact, value) => artifact.spec.hypotheses[0].channels[0].rows.find(r => r.state.state === 'READY')
    .probabilities.find(r => r.value.kind === 'VALUE' && r.value.value === value).p;
  assert.ok(Math.abs(p(first, 'READY') - 1 / 3) < 1e-12);
  assert.ok(Math.abs(p(first, 'BUSY') - 1 / 6) < 1e-12);
  assert.ok(Math.abs(p(second, 'READY') - 2 / 7) < 1e-12);
  assert.ok(Math.abs(p(second, 'BUSY') - 2 / 7) < 1e-12);
  assert.equal(second.consumption.entityKeys.length, 2); assert.equal(second.consumption.feedback.length, 2);
  assert.equal(second.consumption.sources.length, 4); assert.equal(second.consumption.datasets.length, 2);
  assert.equal(second.fittedSampleKeys.filter(k => !first.fittedSampleKeys.includes(k)).length, 1);
  assert.deepEqual(verifyObservationFit(compiled, baseline, materials, config, second), second);
  assert.equal(await f.storage.getReadRevision(ctx), readEpoch); // computation has no native mutation
  assert.equal((await f.rows('PlusModelRelease')).totalCount, 0);
  assert.equal((await f.rows('PlusExecution')).totalCount, 0); // not falsely reported as worker integration
  assert.equal((await f.storage.getObject(ctx, 'Machine', root._id)).actual, 'UNKNOWN');
  assert.equal(JSON.stringify(second).includes('PRIVATE_RAW_EVIDENCE'), false);

  // A previously computed file cannot authorize reusing a withdrawn native source.
  const event = (await f.rows('PlusEvent')).items.find(e => e.sourceRecordId === 'round-2-new-observation');
  const withdrawal = await f.runtime.proposeSourceChange({ episodeId: episode._id, kind: 'REVOCATION', eventId: event._id,
    eventVersion: event._version, reason: 'withdraw training observation' }, reviewer, 'withdraw-round-2-training');
  await f.runtime.reviewSourceChange(withdrawal._id, withdrawal._version, 'APPROVE', 'independent withdrawal', owner);
  await assert.rejects(() => f.registry.materialize(secondDataset.id, 'FIT', trainer), /DATASET_STALE/);
  assert.equal((await f.storage.getObject(ctx, 'PlusDatasetRevision', secondDataset.id)).readiness, 'SUSPENDED');
  assert.equal(second.readiness, 'CANDIDATE_UNEVALUATED'); // immutable file is not a live eligibility check
});
