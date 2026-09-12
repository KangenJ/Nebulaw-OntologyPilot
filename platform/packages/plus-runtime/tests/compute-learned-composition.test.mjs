import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '@openfoundry/plus-contracts';
import { NativeComputeAdmission } from '../dist/index.js';
import { datasetFixture,trainer,owner } from './dataset-fixture.mjs';
import { ctx,at } from './episode-fixture.mjs';
import { createNativeReadQualificationPhase,qualifiedNativeRead } from '../dist/read-qualification-phase.js';

// Actual native SQLite jobs/links/exposures/transactions with EXPLICIT recipe,
// protected-material and numerical-verifier doubles. Not component admission,
// model efficacy, complete Task HTTP or deployment acceptance.
async function fixture(t){
  const f=await datasetFixture(t);await f.addLabel();f.advance(9);let now=9;
  const frozen=await f.registry.freeze(f.cohort.id,trainer),observation=await f.registry.materialize(frozen.id,'FIT',trainer);
  const original=await f.storage.getObject(ctx,'PlusDatasetRevision',frozen.id),ancestor=structuredClone(observation);
  ancestor.sourceManifest.samples=ancestor.sourceManifest.samples.map(s=>({...s,sampleKey:s.sampleKey+'-later'}));
  ancestor.contentHash=digest({...ancestor,contentHash:null});
  const fields=Object.fromEntries(Object.entries(original).filter(([k])=>!k.startsWith('_')));
  const ancestorRow=await f.storage.createObject(ctx,'PlusDatasetRevision',{...fields,datasetKey:digest('explicit-ancestor-double'),contentHash:ancestor.contentHash});
  const refs=[{id:frozen.id,version:original._version,hash:observation.contentHash},{id:ancestorRow._id,version:ancestorRow._version,hash:ancestor.contentHash}];
  const recipe={engineId:'ontology-composed-dynamics-v1',testOnly:true},recipeHash=digest(recipe);
  const record=await f.storage.createObject(ctx,'PlusModelRecipe',{recipeKey:'explicit-compute-double',recipeHash,engineId:recipe.engineId,
    revisionKey:digest('explicit-recipe-double'),revision:1,definitionKey:f.definition.key,definitionReference:{testOnly:true},payload:recipe,
    policyHash:digest('explicit-recipe-policy'),submittedBy:trainer.id,submittedAt:at(9),
    definitionHash:observation.sourceManifest.protocol.definitionHash,proposalHash:digest('fixture'),status:'APPROVED'});
  const worker={...trainer,id:'composition-worker'},state={allow:true,readerAllowed:true,revision:0,verifications:0,revalidations:0};
  const material=()=>{const body={schema:'plus-learned-composition-fit-material-v1',purpose:'FIT',tenantId:ctx.tenantId,recipeHash,
    recipeReference:{id:record._id,version:record._version,hash:recipeHash},component:{testOnlyReference:state.revision},
    observation:{datasets:[refs[0]],materials:[observation]},transition:{datasets:[refs[1]],materials:[ancestor],
      exposure:{id:'original-component-exposure-double',version:1,hash:digest('original')},material:{original:true}},
    closure:{datasets:refs.map((r,i)=>({reference:r,uses:[i?'TRANSITION':'OBSERVATION']})).sort((a,b)=>a.reference.id.localeCompare(b.reference.id)),
      sourceRefs:observation.sourceManifest.sourceRefs,
      samples:[...observation.sourceManifest.samples,...ancestor.sourceManifest.samples].map(({sampleKey,entityKey,splitGroupHash})=>({sampleKey,entityKey,splitGroupHash})).sort((a,b)=>a.sampleKey.localeCompare(b.sampleKey))},
    nativeReadQualificationsChecked:true,evaluationAuthorized:false,predictionReady:false};return structuredClone({...body,contentHash:digest(body)});};
  const protectedProvider={materializeForFit:async(hash,ids,p)=>{
    assert.equal(hash,recipeHash);assert.deepEqual(ids,[frozen.id]);
    if(!state.allow||p.id===owner.id&&!state.readerAllowed)throw Error('ANCESTOR_FIT_FORBIDDEN');
    const row=await f.storage.getObject(ctx,'PlusDatasetRevision',ancestorRow._id);
    if(row._version!==ancestorRow._version)throw Error('ANCESTOR_DATASET_STALE');return material();
  },revalidateForFit:async(saved,p)=>{state.revalidations++;const current=await protectedProvider.materializeForFit(recipeHash,[frozen.id],p);
    assert.deepEqual(saved,current);return {nativeQualificationChecked:true,contentHash:current.contentHash};}};
  const payload={testOnlyFittedPayload:true},config={storage:f.storage,tenantId:ctx.tenantId,datasets:f.registry,
    recipes:{requireApproved:async()=>structuredClone({record,payload:recipe})},learnedComposition:protectedProvider,
    verifyLearnedCompositionFitResult:async request=>{state.verifications++;assert.deepEqual(request.artifact,payload);assert.deepEqual(request.material,material());
      state.onVerify?.();return {payload,definitionHash:record.definitionHash,classification:'SYNTHETIC',updateKind:'U2'};},
    authorize:async()=>true,policyFor:async()=>({version:'plus-compute-policy-v1',workerId:worker.id,engineId:recipe.engineId,recipeHash,leaseMs:300000,maxAttempts:2}),
    resolvePrincipal:async()=>trainer,clock:()=>Date.parse(at(now))};
  const admission=new NativeComputeAdmission(config);
  return {...f,frozen,refs,ancestorRow,record,config,admission,worker,state,payload,material,advanceCompute:n=>{now=n;},
    enqueue:key=>admission.enqueue(frozen.id,'FIT',trainer,key??'composition-fit')};
}

test('complete enqueue binds its initial qualified closure once and independently requalifies before commit',async t=>{
  const f=await fixture(t),provider=f.config.learnedComposition.materializeForFit,calls=[];
  f.config.learnedComposition.materializeForFit=async(...args)=>{calls.push(args[2].id);return provider(...args);};
  const job=await f.enqueue();assert.deepEqual(calls,[trainer.id,trainer.id],'initial qualification plus independent precommit qualification');
  const row=await f.storage.getObject(ctx,'PlusExecution',job.id);
  assert.equal(row.inputReadSet.composition.materialHash,f.material().contentHash);
  assert.deepEqual(row.inputReadSet.composition.datasets,f.material().closure.datasets.map(r=>r.reference));
  calls.length=0;assert.equal((await f.enqueue()).id,job.id);assert.deepEqual(calls,[trainer.id],'idempotent invocation still freshly qualifies its own inputs');
  calls.length=0;await f.admission.claim(job.id,f.worker);assert.ok(calls.length>0,'dispatch must not reuse enqueue material');
});

test('complete enqueue read phases reuse recipe qualification locally but independently qualify again before commit',async t=>{
  const f=await fixture(t),reader=f.config.recipes,original=reader.requireApproved;let qualifications=0;
  reader.requireApproved=(hash,p,permission='recipe:use')=>qualifiedNativeRead(reader,f.storage,'recipe',{hash,permission},p,async()=>{qualifications++;return original(hash,p,permission);});
  f.config.readQualificationPhase=createNativeReadQualificationPhase({storage:f.storage,tenantId:ctx.tenantId,readers:[reader],
    authorizationRevision:async()=>digest({allow:f.state.allow,revision:f.state.revision})});
  const job=await f.enqueue();assert.equal(qualifications,2,'Initial phase and independent precommit phase, not a cross-command certificate');
  assert.equal((await f.storage.getObject(ctx,'PlusExecution',job.id)).status,'PENDING');
  await f.admission.claim(job.id,f.worker);assert.ok(qualifications>2,'Dispatch cannot reuse an expired enqueue phase');
});

test('a changed native read phase invalidates complete precommit and rolls back all staged job writes',async t=>{
  const f=await fixture(t),reader=f.config.recipes,original=reader.requireApproved,material=f.config.learnedComposition.materializeForFit;let passes=0;
  reader.requireApproved=(hash,p,permission='recipe:use')=>qualifiedNativeRead(reader,f.storage,'recipe',{hash,permission},p,()=>original(hash,p,permission));
  f.config.readQualificationPhase=createNativeReadQualificationPhase({storage:f.storage,tenantId:ctx.tenantId,readers:[reader],
    authorizationRevision:async()=>digest({allow:f.state.allow,revision:f.state.revision})});
  f.config.learnedComposition.materializeForFit=async(...args)=>{const result=await material(...args);if(++passes===2)f.state.revision++;return result;};
  await assert.rejects(()=>f.enqueue(),/NATIVE_QUALIFICATION_AUTHORITY_STALE/);
  assert.equal((await f.storage.queryObjects(ctx,'PlusExecution',{and:[]})).totalCount,0);
  assert.equal((await f.storage.queryObjects(ctx,'PlusDataExposure',{and:[]})).totalCount,0);
});

test('claim uses separate initial, precommit and postcommit read phases without dropping material or exposure revalidation',async t=>{
  const f=await fixture(t),reader=f.config.recipes,original=reader.requireApproved;let qualifications=0;
  reader.requireApproved=(hash,p,permission='recipe:use')=>qualifiedNativeRead(reader,f.storage,'recipe',{hash,permission},p,async()=>{qualifications++;return original(hash,p,permission);});
  f.config.readQualificationPhase=createNativeReadQualificationPhase({storage:f.storage,tenantId:ctx.tenantId,readers:[reader],authorizationRevision:async()=>digest('explicit-claim-authority')});
  const job=await f.enqueue();qualifications=0;const before=f.state.revalidations;
  const result=await f.admission.claim(job.id,f.worker);
  assert.equal(qualifications,3);assert.equal(f.state.revalidations-before,2);
  assert.deepEqual(result.compositionInput.material,f.material());assert.equal((await f.rows('PlusDataExposure')).totalCount,1);
});

test('claim phase failures roll back before commit and preserve exposure after commit without delivering a lease',async t=>{
  for(const timing of ['precommit','delivery']){
    const f=await fixture(t);let revision=0,claims=0;
    const authorize=f.config.authorize,revalidate=f.config.learnedComposition.revalidateForFit;
    f.config.readQualificationPhase=createNativeReadQualificationPhase({storage:f.storage,tenantId:ctx.tenantId,readers:[f.config.recipes],authorizationRevision:async()=>digest(revision)});
    f.config.authorize=async(...args)=>{const value=await authorize(...args);if(args[1]==='compute:claim'&&++claims===3&&timing==='delivery')revision++;return value;};
    f.config.learnedComposition.revalidateForFit=async(...args)=>{const value=await revalidate(...args);if(timing==='precommit')revision++;return value;};
    const job=await f.enqueue();await assert.rejects(()=>f.admission.claim(job.id,f.worker),/NATIVE_QUALIFICATION_AUTHORITY_STALE/);
    const row=await f.storage.getObject(ctx,'PlusExecution',job.id);
    assert.equal(row.status,timing==='precommit'?'PENDING':'LEASED');
    assert.equal((await f.rows('PlusDataExposure')).totalCount,timing==='precommit'?0:1);
  }
});

test('completion verification phase rejects changed authority; retry and independent read preserve the single native candidate',async t=>{
  const f=await fixture(t);let revision=0;
  f.config.readQualificationPhase=createNativeReadQualificationPhase({storage:f.storage,tenantId:ctx.tenantId,readers:[f.config.recipes],authorizationRevision:async()=>digest(revision)});
  const job=await f.enqueue(),lease=await f.admission.claim(job.id,f.worker);
  f.state.onVerify=()=>revision++;
  await assert.rejects(()=>f.admission.completeFit(job.id,lease.version,lease.leaseToken,f.payload,f.worker),/NATIVE_QUALIFICATION_AUTHORITY_STALE/);
  assert.equal((await f.rows('PlusModelArtifact')).totalCount,0);assert.equal((await f.rows('PlusModelRelease')).totalCount,0);
  assert.equal((await f.storage.getObject(ctx,'PlusExecution',job.id)).status,'LEASED');
  f.state.onVerify=undefined;
  const completed=await f.admission.completeFit(job.id,lease.version,lease.leaseToken,f.payload,f.worker);
  assert.deepEqual(await f.admission.completeFit(job.id,lease.version,lease.leaseToken,f.payload,f.worker),completed);
  assert.equal((await f.rows('PlusModelRelease')).totalCount,1);assert.equal(f.state.verifications,2);
  const material=await f.admission.readLearnedCompositionFitForEvaluation(job.id,trainer);
  assert.deepEqual(material.composition.material,f.material());assert.equal((await f.rows('PlusDeployment')).totalCount,0);
  f.state.readerAllowed=false;await assert.rejects(()=>f.admission.readLearnedCompositionFitForEvaluation(job.id,owner),/ANCESTOR_FIT_FORBIDDEN/);
});

test('changed closure and revoked ancestor permission in the independent precommit pass leave no job or exposure',async t=>{
  for(const change of ['closure','permission']){
    const f=await fixture(t),provider=f.config.learnedComposition.materializeForFit;let calls=0;
    f.config.learnedComposition.materializeForFit=async(...args)=>{if(++calls===2){if(change==='closure')f.state.revision++;else f.state.allow=false;}return provider(...args);};
    await assert.rejects(()=>f.enqueue(),change==='closure'?/COMPUTE_COMPOSITION_INPUT_STALE/:/ANCESTOR_FIT_FORBIDDEN/);
    assert.equal(calls,2);assert.equal((await f.rows('PlusExecution')).totalCount,0);
    assert.equal((await f.rows('PlusDataExposure')).totalCount,0);
    const outbox=await f.rows('PlusOutbox');assert.ok(outbox.items.every(r=>r.envelope.audit.operation.actionType!=='PlusEnqueueCompute'));
  }
});

test('composition job binds every ancestor, preserves original exposure, completes once and requires an explicit complete evaluator',async t=>{
  const f=await fixture(t),job=await f.enqueue();assert.equal((await f.enqueue()).id,job.id);
  assert.deepEqual((await f.storage.getLinks(ctx,job.id,'PlusExecutionDataset','outbound')).items.map(r=>r._toId).sort(),f.refs.map(r=>r.id).sort());
  const dispatch=await f.admission.claim(job.id,f.worker);
  assert.deepEqual(dispatch.compositionInput.material,f.material());assert.equal(dispatch.input,undefined);assert.equal(dispatch.inputBatch,undefined);
  const exposure=await f.storage.getObject(ctx,'PlusDataExposure',dispatch.exposureId);
  assert.equal(exposure.sourceManifest.samples.length,2);assert.equal(new Set(exposure.sourceManifest.samples.map(r=>r.entityKey)).size,1);
  assert.deepEqual(exposure.sourceManifest.composition.material.transition.exposure,f.material().transition.exposure);
  const result=await f.admission.completeFit(job.id,dispatch.version,dispatch.leaseToken,f.payload,f.worker);
  assert.equal(result.status,'SUCCEEDED');assert.equal(result.deploymentAuthorized,false);
  assert.deepEqual((await f.storage.getLinks(ctx,result.candidateId,'PlusReleaseDataset','outbound')).items.map(r=>r._toId).sort(),f.refs.map(r=>r.id).sort());
  const reopened=new NativeComputeAdmission({...f.config,storage:f.openStorage()}),before=await f.storage.getReadRevision(ctx);
  assert.deepEqual(await reopened.completeFit(job.id,dispatch.version,dispatch.leaseToken,f.payload,f.worker),result);
  assert.deepEqual((await reopened.readFitResult(job.id,trainer)).payload,f.payload);
  assert.equal((await reopened.readFitResult(job.id,trainer)).composition,undefined);
  const handoff=await reopened.readLearnedCompositionFitForEvaluation(job.id,trainer);
  assert.deepEqual(handoff.composition.material,f.material());assert.ok(f.state.revalidations>=4);
  await assert.rejects(()=>reopened.readFitForEvaluation(job.id,trainer),/COMPUTE_COMPOSITION_EVALUATOR_REQUIRED/);
  await assert.rejects(()=>reopened.readFitBatchForEvaluation(job.id,trainer),/COMPUTE_COMPOSITION_EVALUATOR_REQUIRED/);
  assert.equal(await f.storage.getReadRevision(ctx),before);assert.equal(f.state.verifications,1);
  f.state.readerAllowed=false;await assert.rejects(()=>reopened.readFitResult(job.id,owner),/ANCESTOR_FIT_FORBIDDEN/);
  assert.equal((await f.rows('PlusDeployment')).totalCount,0);assert.equal((await f.storage.getObject(ctx,'Machine',f.root._id)).actual,'UNKNOWN');
});

test('missing providers, changed ancestor binding and current withdrawal fail closed before exposure or completion',async t=>{
  const f=await fixture(t),provider=f.config.learnedComposition;delete f.config.learnedComposition;
  await assert.rejects(()=>f.enqueue(),/COMPUTE_COMPOSITION_PROVIDER_REQUIRED/);f.config.learnedComposition=provider;
  const job=await f.enqueue();f.state.revision++;
  await assert.rejects(()=>f.admission.claim(job.id,f.worker),/COMPUTE_COMPOSITION_INPUT_STALE/);
  assert.equal((await f.rows('PlusDataExposure')).totalCount,0);f.state.revision--;
  const dispatch=await f.admission.claim(job.id,f.worker);f.state.allow=false;
  await assert.rejects(()=>f.admission.completeFit(job.id,dispatch.version,dispatch.leaseToken,f.payload,f.worker),/ANCESTOR_FIT_FORBIDDEN/);
  assert.equal((await f.rows('PlusModelArtifact')).totalCount,0);assert.equal((await f.rows('PlusDataExposure')).totalCount,1);
  f.state.allow=true;await f.storage.updateObject(ctx,'PlusDatasetRevision',f.ancestorRow._id,{readiness:'SUSPENDED'});
  await assert.rejects(()=>f.admission.claim(job.id,f.worker),/COMPUTE_STATE_CONFLICT/);
  await assert.rejects(()=>f.admission.completeFit(job.id,dispatch.version,dispatch.leaseToken,f.payload,f.worker),/ANCESTOR_DATASET_STALE/);
});

test('verification-time changes, stale leases and release-link faults cannot partially complete a composition',async t=>{
  const f=await fixture(t),job=await f.enqueue(),first=await f.admission.claim(job.id,f.worker);
  f.advanceCompute(15);const next=await f.admission.claim(job.id,f.worker);
  await assert.rejects(()=>f.admission.completeFit(job.id,first.version,first.leaseToken,f.payload,f.worker),/COMPUTE_LEASE_CONFLICT/);
  f.state.onVerify=()=>{f.state.allow=false;};
  await assert.rejects(()=>f.admission.completeFit(job.id,next.version,next.leaseToken,f.payload,f.worker),/ANCESTOR_FIT_FORBIDDEN/);
  assert.equal((await f.rows('PlusModelArtifact')).totalCount,0);f.state.onVerify=undefined;f.state.allow=true;
  const storage=new Proxy(f.storage,{get(target,key){if(key==='beginTransaction')return async(...args)=>{const tx=await target.beginTransaction(...args),link=tx.createLink.bind(tx);let count=0;
    tx.createLink=async(...args)=>{if(args[0]==='PlusReleaseDataset'&&++count===2)throw Error('ANCESTOR_LINK_FAILURE');return link(...args);};return tx;};
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  const fault=new NativeComputeAdmission({...f.config,storage}),epoch=await f.storage.getReadRevision(ctx);
  await assert.rejects(()=>fault.completeFit(job.id,next.version,next.leaseToken,f.payload,f.worker),/ANCESTOR_LINK_FAILURE/);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.rows('PlusModelRelease')).totalCount,0);
  const result=await f.admission.completeFit(job.id,next.version,next.leaseToken,f.payload,f.worker);assert.equal(result.status,'SUCCEEDED');
  f.state.revision++;await assert.rejects(()=>f.admission.completeFit(job.id,next.version,next.leaseToken,f.payload,f.worker),/COMPUTE_COMPOSITION_INPUT_STALE/);
});

test('local material handoff removes duplicate graph traversals, not precommit, exposure or reader qualifications',async t=>{
  const f=await fixture(t),counts={recipe:0,material:0},stages=[];
  const recipe=f.config.recipes.requireApproved,material=f.config.learnedComposition.materializeForFit;
  f.config.recipes.requireApproved=async(...args)=>{counts.recipe++;return recipe(...args);};
  f.config.learnedComposition.materializeForFit=async(...args)=>{counts.material++;return material(...args);};
  const checkpoint=(stage,expected)=>{stages.push({stage,...counts});assert.deepEqual(counts,expected,stage);counts.recipe=0;counts.material=0;};
  const job=await f.enqueue();checkpoint('enqueue',{recipe:5,material:2});
  const dispatch=await f.admission.claim(job.id,f.worker);checkpoint('claim',{recipe:6,material:4});
  await f.admission.completeFit(job.id,dispatch.version,dispatch.leaseToken,f.payload,f.worker);checkpoint('complete',{recipe:6,material:4});
  await f.admission.readFitResult(job.id,owner);checkpoint('independent-read',{recipe:5,material:3});
  assert.equal(f.state.revalidations,5);
  process.stdout.write(JSON.stringify({schema:'plus-compute-qualification-counts-v1',stages,
    scope:'Native lifecycle with explicit recipe/material doubles; call counts, not actual Task latency'})+'\n');
});

test('local material handoff cannot bypass late source denial or a lease expiring during final delivery revalidation',async t=>{
  const f=await fixture(t),job=await f.enqueue(),authorize=f.config.authorize;let claims=0;
  f.config.authorize=async(...args)=>{if(args[1]==='compute:claim'&&++claims===2)f.state.allow=false;return authorize(...args);};
  // Denial just before commit must still be observed by the postcommit delivery
  // revalidation: conservative exposure remains, but no protected data returns.
  await assert.rejects(()=>f.admission.claim(job.id,f.worker),/ANCESTOR_FIT_FORBIDDEN/);
  assert.equal((await f.rows('PlusDataExposure')).totalCount,1);
  assert.equal((await f.admission.inspect(job.id,trainer)).status,'LEASED');
  f.state.allow=true;f.config.authorize=authorize;f.advanceCompute(15);
  const material=f.config.learnedComposition.materializeForFit;let reads=0;
  f.config.learnedComposition.materializeForFit=async(...args)=>{const result=await material(...args);
    if(++reads===4)f.advanceCompute(30);return result;};
  await assert.rejects(()=>f.admission.claim(job.id,f.worker),/COMPUTE_LEASE_EXPIRED_BEFORE_DELIVERY/);
  assert.equal(reads,4);assert.equal((await f.rows('PlusDataExposure')).totalCount,2);
  assert.equal((await f.rows('PlusModelRelease')).totalCount,0);
});

test('each fresh material pass rechecks the recipe after dataset reads even when its initial recipe result was reused',async t=>{
  const f=await fixture(t),original=f.config.datasets.materialize,recipe=f.config.recipes.requireApproved;let changed=false;
  f.config.datasets.materialize=async(...args)=>{const result=await original.apply(f.config.datasets,args);changed=true;return result;};
  f.config.recipes.requireApproved=async(...args)=>{if(changed)throw Error('RECIPE_WITHDRAWN_DURING_DATA_READ');return recipe(...args);};
  await assert.rejects(()=>f.enqueue(),/RECIPE_WITHDRAWN_DURING_DATA_READ/);
  assert.equal((await f.rows('PlusExecution')).totalCount,0);assert.equal((await f.rows('PlusDataExposure')).totalCount,0);
});

// These tests isolate read traversal/fences with the explicit providers above.
// They do not certify the canonical complete-model graph or real-world speed.
test('shared complete-result read reuses only this invocation and original exposure; independent readers still traverse every ancestor',async t=>{
  const f=await fixture(t),job=await f.enqueue(),lease=await f.admission.claim(job.id,f.worker);
  await f.admission.completeFit(job.id,lease.version,lease.leaseToken,f.payload,f.worker);
  const expected=await f.admission.readLearnedCompositionFitForEvaluation(job.id,trainer),calls=[];
  const original=f.config.learnedComposition.materializeForFit;
  f.config.learnedComposition.materializeForFit=async(...args)=>{calls.push(args[2].id);return original(...args);};
  const config={...f.config,readConsistency:'SHARED_NATIVE_AND_AUTHORITY',authorizationRevision:async()=>digest({allow:f.state.allow,readerAllowed:f.state.readerAllowed,revision:f.state.revision})};
  const shared=new NativeComputeAdmission(config),before=await f.storage.getReadRevision(ctx),revalidations=f.state.revalidations;
  assert.deepEqual(await shared.readLearnedCompositionFitForEvaluation(job.id,trainer),expected);
  assert.deepEqual(calls,[trainer.id]);calls.length=0;
  await shared.readLearnedCompositionFitForEvaluation(job.id,owner);assert.deepEqual(calls,[trainer.id,owner.id]);calls.length=0;
  const reopened=new NativeComputeAdmission({...config,storage:f.openStorage()});
  assert.deepEqual(await reopened.readLearnedCompositionFitForEvaluation(job.id,trainer),expected);
  assert.deepEqual(calls,[trainer.id]);assert.equal(f.state.revalidations,revalidations);
  assert.equal(await f.storage.getReadRevision(ctx),before);
  f.state.readerAllowed=false;await assert.rejects(()=>shared.readFitResult(job.id,owner),/ANCESTOR_FIT_FORBIDDEN/);
  f.state.readerAllowed=true;f.state.revision++;await assert.rejects(()=>shared.readFitResult(job.id,trainer),/COMPUTE_COMPOSITION_INPUT_STALE/);
});

test('shared complete-result reads require full authority and reject source, identity expiry and native mutation at the final fence',async t=>{
  const f=await fixture(t),job=await f.enqueue(),lease=await f.admission.claim(job.id,f.worker);
  await f.admission.completeFit(job.id,lease.version,lease.leaseToken,f.payload,f.worker);
  const mode={revision:0,expired:false};
  const revision=async()=>{if(mode.expired)throw Error('CURRENT_IDENTITY_EXPIRED');return digest(mode.revision);};
  const base={...f.config,readConsistency:'SHARED_NATIVE_AND_AUTHORITY',authorizationRevision:revision};
  await assert.rejects(()=>new NativeComputeAdmission({...base,authorizationRevision:undefined}).readFitResult(job.id,trainer),/SHARED_AUTHORITY_REQUIRED/);
  await assert.rejects(()=>new NativeComputeAdmission({...base,authorizationRevision:async()=>''}).readFitResult(job.id,trainer),/SHARED_AUTHORITY_INVALID/);
  const race=mutation=>{
    let checks=0;return new NativeComputeAdmission({...base,authorize:async(...args)=>{
      const allowed=await f.config.authorize(...args);
      if(args[1]==='compute:read-result'&&++checks===2)await mutation();return allowed;
    }});
  };
  await assert.rejects(()=>race(async()=>{mode.revision++;}).readFitResult(job.id,trainer),/SHARED_AUTHORITY_STALE/);
  await assert.rejects(()=>race(async()=>{mode.expired=true;}).readFitResult(job.id,trainer),/CURRENT_IDENTITY_EXPIRED/);mode.expired=false;
  await assert.rejects(()=>race(async()=>{await f.storage.updateObject(ctx,'PlusDatasetRevision',f.ancestorRow._id,{contentHash:f.ancestorRow.contentHash},f.ancestorRow._version);}).readFitResult(job.id,trainer),/CONFLICT/);
});
