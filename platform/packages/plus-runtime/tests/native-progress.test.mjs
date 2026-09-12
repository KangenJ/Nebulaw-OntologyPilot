import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { episodeFixture,ctx } from './episode-fixture.mjs';
import { inspectNativeProgress } from '../../../../ops/plus-v2/inspect-native-progress.mjs';

test('native diagnostic returns aggregate state without facts/identities or mutation, and does not infer process or prediction readiness',async t=>{
  const f=await episodeFixture(t),before=await f.storage.getReadRevision(ctx),root=await f.storage.getObject(ctx,'Machine',f.root._id);
  const result=inspectNativeProgress(f.path),raw=JSON.stringify(result);
  assert.equal(String(result.revision),before);assert.equal(await f.storage.getReadRevision(ctx),before);
  assert.deepEqual(await f.storage.getObject(ctx,'Machine',f.root._id),root);
  assert.equal(raw.includes(f.root._id),false);assert.equal(raw.includes(ctx.tenantId),false);assert.equal(raw.includes('REGISTERED'),false);
  assert.equal(result.processLivenessChecked,false);assert.equal(result.predictionReadinessChecked,false);assert.equal(result.businessFactsWritten,false);
});
test('native diagnostic requires an existing database and cannot create one as a read side effect',async t=>{
  const f=await episodeFixture(t),missing=f.path+'.does-not-exist';assert.equal(existsSync(missing),false);
  assert.throws(()=>inspectNativeProgress(missing));assert.equal(existsSync(missing),false);
  assert.throws(()=>inspectNativeProgress(':memory:'),/EXISTING_DATABASE_REQUIRED/);
});
