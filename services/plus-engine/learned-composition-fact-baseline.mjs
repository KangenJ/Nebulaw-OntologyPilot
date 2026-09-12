import assert from 'node:assert/strict';

// Test evidence helper, not model/runtime authority. GOLD is an independent
// native business action, whereas scoring/approval/selection must not write it.
export async function captureGoldFactBaseline(storage,ctx,{before,observation,receipt,eventId,reviewerId,value,target}){
  const nativeReceipt=await storage.getObject(ctx,'NativeCommandReceipt',receipt._id);
  assert.deepEqual(nativeReceipt,receipt);assert.equal(receipt.actionName,'NativeVerifyTaskObservation');
  assert.equal(receipt.actorId,reviewerId);assert.equal(receipt.resultType,'TaskCompletionVerification');
  const check=await storage.getObject(ctx,'TaskCompletionVerification',receipt.resultId),event=await storage.getObject(ctx,'PlusEvent',eventId);
  assert.equal(check.mode,'GOLD');assert.equal(check.result,value);assert.equal(check.targetTime,target);assert.equal(check.recordedBy,reviewerId);
  assert.equal(check.taskVersion,before._version);assert.equal(check.observationVersion,observation._version);
  assert.equal(event.sourceReference.id,check._id);assert.equal(event.verification.mode,'GOLD');assert.equal(event.verification.verifiedBy,reviewerId);
  assert.equal(event.verification.observation.id,observation._id);assert.equal(event.revoked,false);
  const links=await storage.getLinks(ctx,before._id,'TaskCompletionCheck','outbound');
  assert.equal(links.items.filter(l=>l._toId===check._id).length,1);
  const task=await storage.getObject(ctx,'InvestigationTask',before._id);
  assert.equal(task._version,before._version+1);assert.equal(task.actualCompletion,value);assert.equal(task.actualCompletionAt,target);
  assert.equal(task.actualCompletionRecordedAt,check.recordedAt);
  return structuredClone(task);
}

export async function assertGoldFactsUnchanged(storage,ctx,baselines){
  assert.ok(baselines.length>0,'Nonempty independently verified business baseline required');
  for(const baseline of baselines){
    assert.ok(baseline?._id&&baseline._type==='InvestigationTask','GOLD baseline must be captured before model evaluation');
    assert.deepEqual(await storage.getObject(ctx,'InvestigationTask',baseline._id),baseline,'Model operation must preserve the entire post-GOLD native task, including version and times');
  }
}
