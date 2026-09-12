import test from 'node:test';
import assert from 'node:assert/strict';
import {ctx,trainer,owner} from './model-evaluation-fixture.mjs';
import {jointBeliefNativeFixture} from './joint-belief-native-fixture.mjs';

test('discovery after actual native finite FIT, evaluation, admission and selection is metadata-only and current read requalifies',async t=>{
  const f=await jointBeliefNativeFixture(t,false),epoch=await f.storage.getReadRevision(ctx);
  const index=await f.deployments.listAvailable(owner);assert.equal(index.items.length,1);
  assert.equal(index.items[0].key,f.key);assert.equal(index.items[0].recordedSelection.revisionId,f.selected.revisionId);
  assert.equal(index.items[0].qualification,'NOT_CHECKED');assert.equal(index.predictionReady,false);assert.equal(index.executionAuthorized,false);
  assert.deepEqual((await f.deployments.listAvailable(trainer)).items,[]);
  const selected=await f.deployments.read(f.key,owner);assert.equal(selected.revision._id,index.items[0].recordedSelection.revisionId);
  assert.equal(selected.predictionReady,false);assert.equal(selected.replayRequired,true);
  const history=await f.deployments.listRevisions(f.key,owner);assert.equal(history.items[0].id,f.selected.revisionId);
  assert.equal(history.items[0].qualification,'NOT_CHECKED');assert.equal(history.predictionReady,false);
  const historical=await f.deployments.readRevision(f.key,history.items[0].id,owner);assert.deepEqual(historical.selection,selected.selection);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.deepEqual(await f.storage.getObject(ctx,'Machine',f.root._id),f.root);
  f.historyPolicy.validationAllowed=false;
  assert.equal((await f.deployments.listAvailable(owner)).items[0].qualification,'NOT_CHECKED');
  await assert.rejects(()=>f.deployments.read(f.key,owner),/FORBIDDEN|STALE/);
  assert.equal((await f.deployments.listRevisions(f.key,owner)).items[0].qualification,'NOT_CHECKED');
  await assert.rejects(()=>f.deployments.readRevision(f.key,history.items[0].id,owner),/FORBIDDEN|STALE/);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);
});
