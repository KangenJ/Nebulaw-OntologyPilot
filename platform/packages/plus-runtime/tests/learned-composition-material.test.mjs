import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '@openfoundry/plus-contracts';
import { NativeLearnedCompositionMaterial,createNativeReadQualificationPhase } from '../dist/index.js';
import { qualifiedNativeRead } from '../dist/read-qualification-phase.js';

// EXPLICIT provider/graph doubles for the protected handoff's local invariants.
// This is not native component approval, dataset qualification or end-to-end FIT.
function fixture(){
  const p={id:'trainer',tenantId:'test',roles:['trainer']},state={allow:true,fitAllowed:true,epoch:'0',revision:0,reads:[]};
  const definitionHash=digest('definition'),transition={testOnlyRecipe:'transition'},transitionHash=digest(transition),candidate={testOnlyCandidate:'fitted'};
  const material=(key,sourceId)=>{const body={sourceManifest:{protocol:{partition:'TRAIN',definitionHash},samples:[{sampleKey:key,entityKey:'same-longitudinal-entity',splitGroupHash:digest('group')}],
    sourceRefs:[{id:sourceId,version:1,hash:digest(sourceId)}],feedbackRefs:[]},partitionManifest:{partition:'TRAIN',reservations:[]}};return {...body,contentHash:digest(body),readiness:'READY'};};
  const materials={observation:material('first-time','first-source'),ancestor:material('second-time','second-source')};
  const rows=new Map(),put=(type,id,fields)=>{const row={_id:id,_type:type,_tenantId:p.tenantId,_version:1,...fields};rows.set(id,row);return row;};
  for(const [id,m]of Object.entries(materials))put('PlusDatasetRevision',id,{contentHash:m.contentHash});
  const sourceRecipe={id:'source-recipe',version:1,hash:transitionHash},execution={id:'execution',version:3};
  const release=put('PlusModelRelease','release',{artifactHash:digest(candidate)});
  const evaluation=put('PlusModelEvaluation','evaluation',{contentHash:digest('evaluation'),inputReadSet:{recipe:sourceRecipe,execution,candidateId:release._id,artifactHash:digest(candidate)}});
  const decision=put('PlusModelDecision','decision',{inputReadSet:{recipe:sourceRecipe,evaluation:{id:evaluation._id,version:1,hash:evaluation.contentHash},release:{id:release._id,version:1,hash:digest(release)}}});
  const payload={schema:'plus-learned-composition-recipe-v1',engineId:'ontology-composed-dynamics-v1',compiled:{definitionHash},transition,
    nativeDependencies:[{kind:'TRANSITION_COMPONENT',id:decision._id,version:1,hash:digest(decision)}]};
  const recipeHash=digest(payload),record=put('PlusModelRecipe','outer',{recipeHash});
  const fit={recipeHash:transitionHash,nativeArtifactDefinitionHash:definitionHash,response:{execution,candidateId:release._id,payload:candidate},
    trainingDatasets:[{id:'ancestor',version:1,hash:materials.ancestor.contentHash}],trainingMaterials:[materials.ancestor],
    transition:{exposure:{id:'exposure',version:1,hash:digest('exposure')},material:{testOnlyOriginalExposure:'not reconstructed'},dependencyHash:digest('dependency')}};
  const config={tenantId:p.tenantId,storage:{getReadRevision:async()=>state.epoch,getObject:async(_ctx,_type,id)=>structuredClone(rows.get(id))},
    recipes:{requireApproved:async(hash,actor,purpose)=>{assert.equal(hash,recipeHash);assert.deepEqual(actor,p);assert.equal(purpose,'recipe:use');return structuredClone({record,payload});}},
    componentDecisions:{requireComponentApproved:async(id,actor)=>{assert.equal(id,decision._id);assert.deepEqual(actor,p);return structuredClone({record:decision,modelComponentApproved:true,modelApproved:false,modelDeploymentAuthorized:false});}},
    compute:{readTransitionFitForEvaluation:async(id,actor)=>{assert.equal(id,execution.id);assert.deepEqual(actor,p);if(!state.fitAllowed)throw Error('READER_FIT_DENIED');return structuredClone(fit);}},
    datasets:{materialize:async(id,purpose,actor)=>{assert.equal(purpose,'FIT');assert.deepEqual(actor,p);state.reads.push(id);state.onRead?.();return structuredClone(materials[id]);}},
    authorize:async(actor,permission,hash)=>{assert.deepEqual(actor,p);assert.equal(permission,'composition:FIT');assert.equal(hash,recipeHash);return state.allow;},
    authorizationRevision:async()=>digest(state.revision)};
  const reader=new NativeLearnedCompositionMaterial(config),rehash=id=>{const m=materials[id],{contentHash,readiness,...body}=m;m.contentHash=digest(body);rows.get(id).contentHash=m.contentHash;};
  return {p,state,materials,rows,payload,fit,config,reader,recipeHash,rehash,run:ids=>reader.materializeForFit(recipeHash,ids??['observation'],p)};
}

test('protected composition material retains original component exposure and unions native datasets without inventing independence',async()=>{
  const f=fixture(),result=await f.run(['ancestor','observation']);
  assert.deepEqual(result.transition.material,f.fit.transition.material);
  assert.deepEqual(result.closure.datasets.map(d=>[d.reference.id,d.uses]),[['ancestor',['OBSERVATION','TRANSITION']],['observation',['OBSERVATION']]]);
  assert.equal(result.closure.samples.length,2);assert.equal(new Set(result.closure.samples.map(s=>s.entityKey)).size,1);
  assert.equal(result.closure.sourceRefs.length,2);assert.equal(result.evaluationAuthorized,false);assert.equal(result.predictionReady,false);
  assert.deepEqual(await f.reader.revalidateForFit(result,f.p),{nativeQualificationChecked:true,contentHash:result.contentHash});
  const bad=structuredClone(result);bad.transition.material.testOnlyOriginalExposure='substituted';
  bad.contentHash=digest(Object.fromEntries(Object.entries(bad).filter(([k])=>k!=='contentHash')));
  await assert.rejects(()=>f.reader.revalidateForFit(bad,f.p),/DEPENDENCIES_STALE/);
});
test('protected handoff requires current reader permission and bounded unambiguous input',async()=>{
  const f=fixture();f.state.allow=false;await assert.rejects(()=>f.run(),/FORBIDDEN/);assert.equal(f.state.reads.length,0);
  f.state.allow=true;f.state.fitAllowed=false;await assert.rejects(()=>f.run(),/READER_FIT_DENIED/);
  await assert.rejects(()=>f.run([]),/INVALID_INPUT/);await assert.rejects(()=>f.run(['observation','observation']),/INVALID_INPUT/);
  await assert.rejects(()=>f.reader.materializeForFit(f.recipeHash,['observation'],{...f.p,tenantId:'other'}),/FORBIDDEN/);
});
test('component release substitution and current version drift cannot supply training material',async()=>{
  const f=fixture();f.fit.response.candidateId='different-release';await assert.rejects(()=>f.run(),/LINEAGE/);
  f.fit.response.candidateId='release';f.rows.get('release')._version++;await assert.rejects(()=>f.run(),/LINEAGE/);
});
test('validation-labelled or differently bound ancestor data remains ineligible for FIT',async()=>{
  const f=fixture();f.fit.trainingMaterials[0].sourceManifest.protocol.partition='VALIDATION';await assert.rejects(()=>f.run(),/TRAIN_ONLY/);
});
test('same source with different reference and same sample with conflicting content reject the union',async()=>{
  const f=fixture();f.materials.observation.sourceManifest.sourceRefs=[{...f.materials.ancestor.sourceManifest.sourceRefs[0],version:2}];f.rehash('observation');
  await assert.rejects(()=>f.run(),/SOURCE_CONFLICT/);
  const g=fixture();g.materials.observation.sourceManifest.samples[0].sampleKey='second-time';g.materials.observation.sourceManifest.samples[0].label='different';g.rehash('observation');
  await assert.rejects(()=>g.run(),/SAMPLE_CONFLICT/);
});
test('complete authority and native storage fences reject changes during protected materialization',async()=>{
  const f=fixture();f.state.onRead=()=>f.state.revision++;await assert.rejects(()=>f.run(),/AUTHORITY_STALE/);
  const g=fixture();g.state.onRead=()=>g.state.epoch='1';await assert.rejects(()=>g.run(),/CONFLICT/);
});

// Explicit registered provider doubles isolate scope ownership, not actual
// component approval or full Task HTTP performance (covered separately).
function scopedFixture(){
  const f=fixture(),{config}=f;let decisionReads=0;
  const originalDecision=config.componentDecisions.requireComponentApproved;
  config.componentDecisions.requireComponentApproved=(id,p)=>qualifiedNativeRead(config.componentDecisions,config.storage,'component',{id},p,async()=>{
    decisionReads++;return originalDecision(id,p);
  });
  const originalRecipe=config.recipes.requireApproved;
  config.recipes.requireApproved=async(hash,p,permission)=>{
    await config.componentDecisions.requireComponentApproved('decision',p);
    return originalRecipe(hash,p,permission);
  };
  config.readQualificationPhase=createNativeReadQualificationPhase({storage:config.storage,tenantId:f.p.tenantId,
    readers:[config.componentDecisions],authorizationRevision:config.authorizationRevision});
  return {...f,decisionReads:()=>decisionReads};
}
test('standalone material and revalidation each qualify afresh; nested read shares only its active phase',async()=>{
  const f=scopedFixture(),first=await f.run();assert.equal(f.decisionReads(),1);
  await f.reader.revalidateForFit(first,f.p);assert.equal(f.decisionReads(),2);
  await f.config.readQualificationPhase.run(f.p,async()=>{
    assert.deepEqual(await f.run(),first);assert.deepEqual(await f.run(),first);
    assert.equal(f.decisionReads(),3);
  });
  await f.run();assert.equal(f.decisionReads(),4);
  f.state.fitAllowed=false;await assert.rejects(()=>f.run(),/READER_FIT_DENIED/);
  assert.equal(f.decisionReads(),5); // no earlier qualified exposure is reused
});
test('material phase snapshots caller input and rejects changed native or authority views',async()=>{
  const f=scopedFixture(),ids=['observation'],pending=f.reader.materializeForFit(f.recipeHash,ids,f.p);
  ids[0]='missing';const saved=await pending;assert.equal(saved.observation.datasets[0].id,'observation');
  f.state.onRead=()=>f.state.epoch='changed';await assert.rejects(()=>f.run(),/CONFLICT/);
  const g=scopedFixture();g.state.onRead=()=>g.state.revision++;await assert.rejects(()=>g.run(),/AUTHORITY_STALE/);
  g.state.onRead=undefined;assert.equal((await g.run()).nativeReadQualificationsChecked,true);
});
