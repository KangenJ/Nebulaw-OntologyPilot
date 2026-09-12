import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './transition-plan-fixture.mjs';
import { trainer } from './dataset-fixture.mjs';
import { ctx } from './episode-fixture.mjs';
import { digest } from '@openfoundry/plus-contracts';
import { NativeTransitionPlanReader } from '../dist/index.js';
import { transitionFitDependencies } from '../dist/transition-fit-dependencies.js';
import { fitTransitionModel,verifyTransitionFit } from '../../../../services/plus-engine/transition-fit.mjs';
import { createPrivateIdentityProvider } from '../../../../ops/plus-v2/private-identity.mjs';
import { createPrivateActionIntervalAccess } from '../../../../ops/plus-v2/action-interval-services.mjs';

// Real native recipes/cohorts/feedback/FIT materials plus actual file-backed
// private inventory/identity qualification. Source and endpoint authorization
// adapters remain the explicit synthetic Machine fixture; not a Task host.
async function setup(t,version='plus-native-action-interval-policy-v2'){
  const f=await fixture(t,{actionBound:true,historyVersion:version});
  const dir=mkdtempSync(join(tmpdir(),'plus-transition-authority-')),authPath=join(dir,'identity.json');
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let now=Date.now();
  const rows=[{...trainer,tokenHash:createHash('sha256').update('synthetic-transition-token').digest('hex'),
    expiresAt:new Date(now+60000).toISOString()}];
  const save=()=>writeFileSync(authPath,JSON.stringify(rows),{mode:0o600});save();
  const policy={actionIntervals:{version:'plus-private-action-intervals-v1',enabled:true,
    targets:[{episodeId:f.episodes[0]._id,rootId:f.root._id,purpose:'TRANSITION_FIT',policy:structuredClone(f.recipe.actionHistoryContract)}],
    grants:[{principalId:trainer.id,requiredRoles:trainer.roles,episodeIds:[f.episodes[0]._id],permissions:['action-interval:inventory']}]}};
  const identities=createPrivateIdentityProvider({authPath,tenantId:ctx.tenantId,clock:()=>now});
  const access=createPrivateActionIntervalAccess({identities,tenantId:ctx.tenantId,loadPolicy:()=>structuredClone(policy)});
  access.assertConfigured();
  Object.assign(f.intervalConfig,{policyFor:access.policyFor,authorize:access.authorize,authorizationRevision:access.authorizationRevision});
  f.endpointConfig.authorizationRevision=access.authorizationRevision;
  f.planConfig.authorizationRevision=access.authorizationRevision;
  const grantUnrelated=()=>{
    // A valid grant for a separately named future scope, not a new label or a
    // fabricated native cohort. It must not change this training interval.
    policy.actionIntervals.targets.push({...structuredClone(policy.actionIntervals.targets[0]),episodeId:'future-feedback-episode',rootId:'future-feedback-root'});
    policy.actionIntervals.grants[0].episodeIds.push('future-feedback-episode');access.assertConfigured();
  };
  return {...f,policy,access,rows,save,grantUnrelated,advance:ms=>now+=ms,
    read:()=>f.plan.materializeForFit(f.recipeHash,f.frozenIds,trainer),
    recheck:saved=>f.plan.revalidateForFit(saved,f.recipeHash,f.frozenIds,trainer)};
}

test('reproduction: private unrelated target grant changes history-v2 saved dependency despite fresh native qualification',async t=>{
  const f=await setup(t),saved=await f.read(),original=structuredClone(saved),epoch=await f.storage.getReadRevision(ctx);
  f.grantUnrelated();const current=await f.read();
  assert.equal(await f.storage.getReadRevision(ctx),epoch);
  assert.notEqual(current.sourcePlan.contextPlan.plan.readSet.authorizationRevision,saved.sourcePlan.contextPlan.plan.readSet.authorizationRevision);
  assert.notEqual(transitionFitDependencies(current).dependencyHash,transitionFitDependencies(saved).dependencyHash);
  await assert.rejects(()=>f.recheck(saved),/TRANSITION_FIT_DEPENDENCIES_STALE/);
  assert.deepEqual(saved,original);
});

test('reviewed history-v3 requalifies current private authority and retains exact original native fitting bytes',async t=>{
  const f=await setup(t,'plus-native-action-interval-policy-v3'),saved=await f.read(),original=structuredClone(saved);
  const candidate=fitTransitionModel(f.recipe,[saved]),before=transitionFitDependencies(saved);
  f.grantUnrelated();const current=await f.read();
  assert.notEqual(current.contentHash,saved.contentHash);
  assert.notEqual(current.sourcePlan.intervals[0].material.readSet.authorizationRevision,saved.sourcePlan.intervals[0].material.readSet.authorizationRevision);
  assert.equal(transitionFitDependencies(current).dependencyHash,before.dependencyHash);
  const proof=await f.recheck(saved);assert.equal(proof.materialHash,saved.contentHash);
  assert.equal(proof.currentMaterialHash,current.contentHash);assert.equal(proof.nativeQualificationChecked,true);
  assert.equal(proof.trainingAuthorized,false);assert.equal(proof.predictionReady,false);
  assert.deepEqual(saved,original);assert.deepEqual(verifyTransitionFit(f.recipe,[saved],candidate),candidate);
  const reopened=new NativeTransitionPlanReader({...f.planConfig,storage:f.openStorage()});
  assert.equal((await reopened.revalidateForFit(saved,f.recipeHash,f.frozenIds,trainer)).contentHash,proof.contentHash);
  // A valid credential rotation changes the private authority snapshot again,
  // not the archived model; current expiry and disabled status still apply.
  f.rows[0].tokenHash=createHash('sha256').update('synthetic-rotated-token').digest('hex');f.save();
  assert.equal((await f.recheck(saved)).materialHash,saved.contentHash);
  f.rows[0].disabled=true;f.save();await assert.rejects(()=>f.recheck(saved),/IDENTITY_FORBIDDEN/);
  delete f.rows[0].disabled;f.save();f.advance(60000);await assert.rejects(()=>f.recheck(saved),/IDENTITY_FORBIDDEN/);
  assert.deepEqual(saved,original);
});

test('history-v3 never ignores actual private grant withdrawal, endpoint permission or changed native semantic references',async t=>{
  const f=await setup(t,'plus-native-action-interval-policy-v3'),saved=await f.read();
  const grants=structuredClone(f.policy.actionIntervals.grants);
  f.policy.actionIntervals.grants=[];await assert.rejects(()=>f.recheck(saved),/ACTION_INTERVAL_FORBIDDEN/);
  f.policy.actionIntervals.grants=grants;
  const authorize=f.endpointConfig.authorize;f.endpointConfig.authorize=async()=>false;
  await assert.rejects(()=>f.recheck(saved),/FORBIDDEN/);f.endpointConfig.authorize=authorize;
  const root=await f.storage.getObject(ctx,'Machine',f.root._id);
  await f.storage.updateObject(ctx,'Machine',root._id,{status:'REGISTERED'},root._version);
  await assert.rejects(()=>f.recheck(saved),/TRANSITION_FIT_DEPENDENCIES_STALE/);
});

function reseal(v){if(!v||typeof v!=='object')return;for(const value of Object.values(v))reseal(value);
  if(Object.hasOwn(v,'contentHash')){const {contentHash,...body}=v;v.contentHash=digest(v.temporalInput?{temporalInput:v.temporalInput,readSet:v.readSet}:body);}}

test('history-v3 rejects missing evidence, mismatched authority, downgraded interval and self-rehashed native forgery',async t=>{
  const f=await setup(t,'plus-native-action-interval-policy-v3'),saved=await f.read();
  const missing=structuredClone(saved);delete missing.sourcePlan.intervals[0].material.readSet.intervalEvidence;reseal(missing);
  assert.throws(()=>transitionFitDependencies(missing),/ACTION_INTERVAL_DEPENDENCY_CONTRACT/);
  assert.throws(()=>fitTransitionModel(f.recipe,[missing]),/ACTION_INTERVAL_DEPENDENCY_CONTRACT/);
  const incoherent=structuredClone(saved);incoherent.sourcePlan.contextPlan.plan.readSet.authorizationRevision=digest('other-read-authority');reseal(incoherent);
  assert.throws(()=>transitionFitDependencies(incoherent),/TRANSITION_FIT_DEPENDENCY_CONTRACT/);
  const downgrade=structuredClone(saved);downgrade.sourcePlan.intervals[0].material.policy.version='plus-native-action-interval-policy-v2';reseal(downgrade);
  assert.throws(()=>transitionFitDependencies(downgrade),/TRANSITION_FIT_DEPENDENCY_CONTRACT/);
  // Pure equality is not authority: a self-consistent forged reference may
  // hash successfully but must fail against a new full native material read.
  const forged=structuredClone(saved);forged.sourcePlan.intervals[0].material.readSet.intervalEvidence.rootReferences[0].hash=digest('forged-native-reference');reseal(forged);
  assert.doesNotThrow(()=>transitionFitDependencies(forged));
  await assert.rejects(()=>f.recheck(forged),/TRANSITION_FIT_DEPENDENCIES_STALE/);
  const policy=f.policy.actionIntervals.targets[0].policy;policy.id='changed-reviewed-scope';
  await assert.rejects(()=>f.recheck(saved),e=>e.code==='TRANSITION_PLAN_ACTION_MISMATCH');
});

test('history-v3 still rejects a mid-read authority race and suspended original source material',async t=>{
  const f=await setup(t,'plus-native-action-interval-policy-v3'),saved=await f.read();
  const authorize=f.intervalConfig.authorize;let change=true;
  f.intervalConfig.authorize=async(p,scope)=>{const result=await authorize(p,scope);if(change){change=false;f.grantUnrelated();}return result;};
  await assert.rejects(()=>f.recheck(saved),/AUTHORITY_STALE/);f.intervalConfig.authorize=authorize;
  await f.storage.updateObject(ctx,'PlusInputSnapshot',f.inputs[0]._id,{readiness:'SUSPENDED'},f.inputs[0]._version);
  await assert.rejects(()=>f.recheck(saved),/SUSPENDED/);
});
