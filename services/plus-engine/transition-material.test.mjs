import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { fixture } from '../../platform/packages/plus-runtime/tests/transition-plan-fixture.mjs';
import { trainer,owner } from '../../platform/packages/plus-runtime/tests/dataset-fixture.mjs';
import { ctx,at } from '../../platform/packages/plus-runtime/tests/episode-fixture.mjs';
import { qualifyCompleteTransitionMaterial } from './transition-material.mjs';
import { fitTransitionModel,verifyTransitionFit } from './transition-fit.mjs';
const observations=model=>model.table.reduce((n,row)=>n+row.observations,0);
function reseal(v){if(!v||typeof v!=='object')return v;for(const item of Object.values(v))reseal(item);
  if(Object.hasOwn(v,'contentHash')){const {contentHash,...body}=v;v.contentHash=digest(v.temporalInput?{temporalInput:v.temporalInput,readSet:v.readSet}:body);}return v;}

test('actual multi-cohort native assembly fits one interval, retains every consistent GOLD and reconstructs without business writes',async t=>{
  const f=await fixture(t,{actionBound:true,splitCohorts:true,extraGold:true}),epoch=await f.storage.getReadRevision(ctx);
  const material=await f.plan.materializeForFit(f.recipeHash,f.frozenIds,trainer),model=fitTransitionModel(f.recipe,[material]);
  assert.equal(material.schema,'plus-transition-fit-material-v2');assert.equal(model.schema,'plus-transition-fit-result-v2');
  assert.equal(observations(model),1);assert.equal(model.coverage.enrolled,1);assert.equal(model.coverage.eligible,1);
  assert.equal(model.consumption.provenance.cohortIds.length,2);assert.equal(model.consumption.provenance.datasetIds.length,2);
  const p=material.sourcePlan.contextPlan.plan,pair=p.pairs[0];assert.equal(pair.from[0].labels.length,2);
  for(const point of [...pair.from,...pair.to])for(const label of point.labels){
    assert.ok(model.consumption.references.some(r=>r.type==='PlusFeedback'&&r.id===label.feedback.id));
    assert.ok(model.consumption.references.some(r=>r.id===label.labelSnapshot.id));assert.ok(model.consumption.sourceFamilyKeys.includes(label.sourceFamilyKey));}
  assert.ok(model.consumption.references.some(r=>r.hashKind==='CONTEXT_PROJECTION'));
  assert.equal(model.trainingAuthorized,false);assert.equal(model.predictionReady,false);
  assert.deepEqual(verifyTransitionFit(f.recipe,[material],model),model);
  assert.equal((await f.storage.getObject(ctx,'Machine',f.root._id)).actual,'UNKNOWN');assert.equal(await f.storage.getReadRevision(ctx),epoch);
  assert.equal((await f.plan.materializeForFit(f.recipeHash,[...f.frozenIds].reverse(),trainer)).contentHash,material.contentHash);
  await f.recipes.revoke(f.approved.id,f.approved.version,'Withdraw full transition recipe',owner);
  await assert.rejects(()=>f.plan.materializeForFit(f.recipeHash,f.frozenIds,trainer),/RECIPE_NOT_APPROVED/);
  // Archived computation is reproducible, but this does NOT restore native use.
  assert.equal(fitTransitionModel(f.recipe,[material]).trainingAuthorized,false);
});

test('two native latent components from four independent cohorts fit a nine-state joint transition once',async t=>{
  const f=await fixture(t,{actionBound:true,splitCohorts:true,secondary:true,extraGold:true});
  const material=await f.plan.materializeForFit(f.recipeHash,f.frozenIds,trainer),model=fitTransitionModel(f.recipe,[material]);
  assert.deepEqual(model.layout.stateVariables,['secondary','state']);assert.equal(model.layout.states.length,9);
  assert.equal(observations(model),1);assert.equal(model.consumption.provenance.cohortIds.length,4);
  assert.equal(material.sourcePlan.contextPlan.plan.coverage.enrolledEndpoints,4);
  const row=model.table.find(r=>r.observations===1);assert.deepEqual(row.condition.from,{secondary:'READY',state:'READY'});
  assert.deepEqual(model.layout.states[row.counts.findIndex(n=>n===1)],{secondary:'OFFLINE',state:'BUSY'});
  const root=await f.storage.getObject(ctx,'Machine',f.root._id);assert.equal(root.actual,'UNKNOWN');assert.equal(root.secondary,'UNKNOWN');
  const incomplete=structuredClone(material);incomplete.sourcePlan.contextPlan.plan.pairs[0].to.pop();reseal(incomplete);
  assert.throws(()=>fitTransitionModel(f.recipe,[incomplete]),/TRANSITION_MATERIAL_BUDGET|TRANSITION_MATERIAL_COMPONENTS/);
  assert.equal(model.trainingAuthorized,false);
});

test('structural v2 receipt mapping is explicit, information-only shares WAIT, and never proves native execution',async t=>{
  const f=await fixture(t,{actionBound:true,alterSpec:s=>s.controls.push('ACTION:verify')}),base=await f.plan.materializeForFit(f.recipeHash,f.frozenIds,trainer);
  const ref=(type,id)=>({type,id,version:1,hash:digest([type,id])});
  // These receipt objects are PURE fabricated contract input, not native actions.
  // Real CEL/receipt authenticity is tested separately in task-domain.acceptance.
  const receipt={request:ref('PlusActionRequest','synthetic-request'),decision:ref('PlusActionDecision','synthetic-decision'),
    nativeReceipt:ref('NativeCommandReceipt','synthetic-receipt'),journals:[ref('PlusOutbox','native-journal'),ref('PlusOutbox','governed-journal')],
    nativeAction:'VerifyObject',executedAt:at(1.5),executedBy:'synthetic-executor'};
  const material=structuredClone(base);material.sourcePlan.intervals[0].material.executions=[receipt];reseal(material);
  const q=qualifyCompleteTransitionMaterial(f.recipe,material,f.recipe.supervision);assert.equal(q.rows[0].control,'ACTION:verify');assert.equal(q.rows[0].parameterControl,'WAIT');
  assert.equal(q.authorityChecked,false);assert.equal(q.trainingAuthorized,false);assert.equal(observations(fitTransitionModel(f.recipe,[material])),1);
  for(const patch of [{nativeAction:'UnboundAction'},{executedAt:at(2)},{request:ref('PlusFeedback','not-a-request')},
    {journals:[receipt.journals[0],receipt.journals[0]]}]){
    const m=structuredClone(base);m.sourcePlan.intervals[0].material.executions=[{...receipt,...patch}];reseal(m);assert.throws(()=>fitTransitionModel(f.recipe,[m]));}
  const multi=structuredClone(base);multi.sourcePlan.intervals[0].material.executions=[receipt,{...receipt,executedAt:at(1.7)}];reseal(multi);
  assert.throws(()=>fitTransitionModel(f.recipe,[multi]),/TRANSITION_MATERIAL_BUDGET/);
});
test('missing native endpoint preserves partial GOLD, original denominator and input-only source consumption',async t=>{
  const f=await fixture(t,{actionBound:true,thirdMissing:true,extraGold:true}),material=await f.plan.materializeForFit(f.recipeHash,f.frozenIds,trainer);
  const model=fitTransitionModel(f.recipe,[material]);assert.equal(observations(model),1);
  assert.deepEqual(model.coverage,{enrolled:2,eligible:1,missing:1,fraction:0.5});
  const missing=material.sourcePlan.contextPlan.plan.pairs.find(p=>p.status==='MISSING_GOLD');
  assert.ok(model.consumption.missing[0].missingSampleKeys.includes(missing.to[0].sampleKey));
  for(const point of [...missing.from,...missing.to])for(const event of point.input.compiledInput.events)assert.ok(model.consumption.sourceFamilyKeys.includes(event.dependenceKey));
  for(const label of missing.from[0].labels)assert.ok(model.consumption.references.some(r=>r.id===label.feedback.id));
});
test('complete material rejects self-rehashed omissions, conflicts, leakage and altered action evidence',async t=>{
  const f=await fixture(t,{actionBound:true,splitCohorts:true,extraGold:true}),source=await f.plan.materializeForFit(f.recipeHash,f.frozenIds,trainer);
  const cases=[
    ['omitted cohort',m=>m.sourcePlan.contextPlan.plan.datasets.pop()],
    ['omitted endpoint',m=>m.sourcePlan.contextPlan.plan.pairs[0].to=[]],
    ['unknown member',m=>m.sourcePlan.contextPlan.plan.pairs[0].to[0].sampleKey=digest('unregistered')],
    ['inconsistent duplicate GOLD',m=>m.sourcePlan.contextPlan.plan.pairs[0].from[0].labels[1].value.value='BUSY'],
    ['duplicated review',m=>m.sourcePlan.contextPlan.plan.pairs[0].from[0].labels.push(structuredClone(m.sourcePlan.contextPlan.plan.pairs[0].from[0].labels[0]))],
    ['late enrollment',m=>{const p=m.sourcePlan.contextPlan.plan,d=p.datasets[0];d.enrollment.approvedAt=at(6);for(const point of [...p.pairs[0].from,...p.pairs[0].to])if(point.enrollment.reference.id===d.enrollment.reference.id)point.enrollment.approvedAt=at(6);}],
    ['self approval',m=>{const r=m.sourcePlan.contextPlan.plan.pairs[0].from[0].labels[0];r.approvedBy=r.proposedBy;}],
    ['false missing status',m=>m.sourcePlan.contextPlan.plan.pairs[0].status='MISSING_GOLD'],
    ['cross-group endpoint',m=>m.sourcePlan.contextPlan.plan.pairs[0].to[0].partition.groupHash=digest('other')],
    ['future context',m=>m.sourcePlan.contextPlan.pairs[0].context.priority.receivedAt=at(2)],
    ['missing captured context history',m=>m.sourcePlan.contextPlan.histories=[]],
    ['root-context corruption',m=>m.sourcePlan.contextPlan.histories[0].material.temporalInput.contexts.at(-1).values.priority=1],
    ['partial inventory',m=>m.sourcePlan.intervals[0].material.coverage='PARTIAL'],
    ['foreign interval',m=>m.sourcePlan.intervals[0].material.root.id='other'],
    ['foreign interval tenant',m=>m.sourcePlan.intervals[0].material.root.tenantId='other'],
    ['assignment substituted for reservation',m=>m.sourcePlan.contextPlan.plan.pairs[0].from[0].partition.reference.type='PlusPartitionAssignment'],
    ['lost source family',m=>m.sourcePlan.contextPlan.plan.sourceFamilyKeys.pop()],
    ['invented coverage',m=>m.sourcePlan.contextPlan.plan.coverage.enrolledEndpoints=1],
  ];
  for(const [name,change]of cases){const m=structuredClone(source);change(m);reseal(m);assert.throws(()=>fitTransitionModel(f.recipe,[m]),undefined,name);}
  const model=fitTransitionModel(f.recipe,[source]),forged=structuredClone(model);forged.table[0].counts[0]++;forged.artifactHash=digest('forged');
  assert.throws(()=>verifyTransitionFit(f.recipe,[source],forged),/TRANSITION_FIT_RECOMPUTE_MISMATCH/);
  assert.throws(()=>fitTransitionModel(f.recipe,[source,source]),/TRANSITION_FIT_COMPLETE_PLAN_REQUIRED/);
  const q=qualifyCompleteTransitionMaterial(f.recipe,source,f.recipe.supervision);assert.equal(q.authorityChecked,false);assert.equal(q.rows.length,1);
});
