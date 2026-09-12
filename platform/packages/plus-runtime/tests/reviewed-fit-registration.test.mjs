import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,chmodSync,unlinkSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {digest} from '../../plus-contracts/dist/index.js';
import {createPrivateFitRegistration} from '../../../../ops/plus-v2/fit-qualification.mjs';
import {readReviewedFitDeployment} from '../../../../ops/plus-v2/reviewed-fit-registration.mjs';
import {registeredFitEngineIds} from '../../../../services/plus-engine/private-fit-registry.mjs';

// Private-file/policy registration boundary only. Approval-shaped records below
// are EXPLICIT doubles; actual native authorization/HTTP is tested separately.
const tenantId='reviewed-fit-test',engineId='ontology-composed-dynamics-v1';
const graph=['taskDomain','taskLearning','taskRules','evaluation','modelGovernance','actionIntervals','replayGovernance','beliefRuntime','scenarioPlanning','actionRequests','learnedCompositionReplay'];
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'plus-reviewed-fit-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const selection={key:'task.complete',revision:3,engineId,definitionHash:'a'.repeat(64),bindingHash:'b'.repeat(64),scopeKey:'synthetic',classification:'SYNTHETIC'};
  const policy={...Object.fromEntries(graph.map(k=>[k,{enabled:true}])),compute:{version:'plus-private-compute-v4',enabled:true,grants:[],workers:[]},
    computeAuthorizations:{version:'plus-private-compute-authorizations-v1',enabled:true,targets:[{key:'task.fit',policy:{...selection}}]}};
  const deployment={version:'plus-reviewed-native-fit-v1',tenantId,ontologyHash:'c'.repeat(64),policyHash:digest(policy),recipeSelections:[selection]};
  const reference={path:join(dir,'reviewed.json'),sha256:''};
  const save=()=>{writeFileSync(reference.path,JSON.stringify(deployment),{mode:0o600});reference.sha256=createHash('sha256').update(readFileSync(reference.path)).digest('hex');};save();
  const options={tenantId,loadPolicy:()=>policy,reviewedCompleteFit:reference};
  return {dir,selection,policy,deployment,reference,save,options,register:()=>createPrivateFitRegistration(options)};
}
test('reviewed native pins are separate from synthetic qualification and never approve data/model or widen the global registry',t=>{
  const f=fixture(t),r=f.register(),before=JSON.stringify(f.policy);assert.ok(r.engineIds.includes(engineId));assert.ok(Object.isFrozen(r.engineIds));
  assert.equal(r.reviewedOntologyHash,f.deployment.ontologyHash);assert.equal(registeredFitEngineIds.includes(engineId),false);
  assert.equal(r.nativeRecipeQualification.allowsMetadata(f.selection),true);
  assert.equal(r.nativeRecipeQualification.allowsMetadata({...f.selection,revision:4}),false);
  assert.equal(r.nativeRecipeQualification.allowsMetadata({...f.selection,classification:'AUTHORIZED_REAL'}),false);
  assert.equal(r.nativeRecipeQualification.allowsMetadata({...f.selection,engineId:'arbitrary'}),false);
  f.reference.sha256='0'.repeat(64);assert.equal(r.loadPolicy(),f.policy); // caller reference mutation cannot change the captured pin
  assert.equal(JSON.stringify(f.policy),before);
  assert.throws(()=>createPrivateFitRegistration({...f.options,syntheticCompleteFitQualification:{}}),/COMPLETE_FIT_QUALIFICATION_INVALID/);
});
test('ordinary v1 registration does not read file flags or register a complete engine',t=>{
  const f=fixture(t);f.policy.reviewedCompleteFit=f.reference;
  assert.equal(createPrivateFitRegistration({tenantId,loadPolicy:()=>f.policy}).engineIds,registeredFitEngineIds);
});

test('same exact reviewed loader is not wrapped recursively; every reuse and call still checks live private authority',t=>{
  const f=fixture(t),first=f.register();
  const second=createPrivateFitRegistration({...f.options,loadPolicy:first.loadPolicy,reviewedCompleteFit:structuredClone(f.reference)});
  assert.equal(second.loadPolicy,first.loadPolicy);assert.notEqual(second,first);
  first.nativeRecipeQualification=null;first.engineIds=[];
  const third=createPrivateFitRegistration({...f.options,loadPolicy:second.loadPolicy});
  assert.ok(third.nativeRecipeQualification);assert.ok(third.engineIds.includes(engineId));assert.equal(third.loadPolicy,second.loadPolicy);
  f.policy.compute.grants.push({unreviewed:true});
  assert.throws(third.loadPolicy,/REVIEWED_FIT_CONFIGURATION_INVALID/);
  assert.throws(()=>createPrivateFitRegistration({...f.options,loadPolicy:second.loadPolicy}),/REVIEWED_FIT_CONFIGURATION_INVALID/);
});

test('distinct exact reviewed references are not deduplicated even for identical bytes',t=>{
  const f=fixture(t),first=f.register(),other={...f.reference,path:join(f.dir,'other-reviewed.json')};
  writeFileSync(other.path,readFileSync(f.reference.path),{mode:0o600});
  const second=createPrivateFitRegistration({...f.options,loadPolicy:first.loadPolicy,reviewedCompleteFit:other});
  assert.notEqual(second.loadPolicy,first.loadPolicy);
  unlinkSync(f.reference.path);assert.throws(second.loadPolicy,/REVIEWED_FIT_CONFIGURATION_INVALID/,'Both exact authorities remain checked');
});
test('private deployment references reject unpinned, broad, malformed and cross-tenant selections',t=>{
  const mutations=[f=>f.options.tenantId='other',f=>f.reference.sha256='x',f=>f.reference.path='relative',f=>f.reference.token='secret',
    f=>{f.deployment.version='unknown';f.save();},f=>{f.deployment.recipeSelections=[];f.save();},f=>{f.deployment.recipeSelections.push(f.selection);f.save();},
    f=>{f.selection.revision='latest';f.save();},f=>{f.selection.engineId='arbitrary';f.save();},f=>{f.deployment.approved=true;f.save();}];
  for(const mutate of mutations){const f=fixture(t);mutate(f);assert.throws(f.register,/REVIEWED_FIT_CONFIGURATION_INVALID/);}
});
test('policy and private artifact must remain exact on every use, including deletion and permissions',t=>{
  for(const mutate of [f=>{f.policy.compute.grants.push({unreviewed:true});},f=>writeFileSync(f.reference.path,'{}'),f=>unlinkSync(f.reference.path),
    ...(process.platform==='win32'?[]:[f=>chmodSync(f.reference.path,0o644)])]){
    const f=fixture(t),r=f.register();mutate(f);assert.throws(r.loadPolicy,/REVIEWED_FIT_CONFIGURATION_INVALID/);
    assert.throws(()=>r.nativeRecipeQualification.allowsMetadata(f.selection),/REVIEWED_FIT_CONFIGURATION_INVALID/);
  }
});
test('even newly pinned policies cannot use file jobs, missing graph, unbound purpose or wider native targets',t=>{
  const mutations=[...graph.map(k=>p=>{p[k].enabled=false;}),p=>p.compute.jobs=[],p=>p.compute.version='plus-private-compute-v3',
    p=>p.computeAuthorizations.enabled=false,p=>p.computeAuthorizations.targets=[],p=>p.computeAuthorizations.targets[0].policy.bindingHash='d'.repeat(64)];
  for(const mutate of mutations){const f=fixture(t);mutate(f.policy);f.deployment.policyHash=digest(f.policy);f.save();assert.throws(f.register,/REVIEWED_FIT_CONFIGURATION_INVALID/);}
});
test('recipe restriction follows current approved record identity and exact binding, not a model-ready boolean',t=>{
  const f=fixture(t),r=f.register(),approved={record:{_tenantId:tenantId,recipeKey:f.selection.key,revision:3,engineId,definitionHash:f.selection.definitionHash,status:'APPROVED'},
    payload:{engineId,compiled:{definitionHash:f.selection.definitionHash,definition:{scope:{key:'synthetic'}}},config:{bindingHash:f.selection.bindingHash,classification:'SYNTHETIC'}}};
  assert.doesNotThrow(()=>r.nativeRecipeQualification.requireQualified(approved));
  for(const mutate of [v=>v.record.status='DRAFT',v=>v.record.revision=4,v=>v.record._tenantId='foreign',v=>v.payload.config.classification='AUTHORIZED_REAL',v=>v.payload.engineId='arbitrary']){
    const value=structuredClone(approved);mutate(value);assert.throws(()=>r.nativeRecipeQualification.requireQualified(value),/REVIEWED_FIT_CONFIGURATION_INVALID/);
  }
});
test('private capability manifest can pin authorized-real classification but supplies neither data consent nor native approval',t=>{
  const f=fixture(t);f.selection.classification='AUTHORIZED_REAL';f.policy.computeAuthorizations.targets[0].policy.classification='AUTHORIZED_REAL';
  f.deployment.policyHash=digest(f.policy);f.save();const r=f.register();assert.equal(r.nativeRecipeQualification.allowsMetadata(f.selection),true);
  assert.throws(()=>r.nativeRecipeQualification.requireQualified({}),/REVIEWED_FIT_CONFIGURATION_INVALID/);
});
test('Linux manifest refuses symlink substitution even when target bytes match',{skip:process.platform!=='linux'},t=>{
  const f=fixture(t),copy=join(f.dir,'other.json');writeFileSync(copy,readFileSync(f.reference.path),{mode:0o600});unlinkSync(f.reference.path);symlinkSync(copy,f.reference.path);
  assert.throws(()=>readReviewedFitDeployment(f.reference),/REVIEWED_FIT_CONFIGURATION_INVALID/);
});
