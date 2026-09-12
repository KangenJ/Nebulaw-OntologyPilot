import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeComputeAdmission} from '../../platform/packages/plus-runtime/dist/index.js';
import {ctx,at} from '../../platform/packages/plus-runtime/tests/episode-fixture.mjs';
import {trainer,owner} from '../../platform/packages/plus-runtime/tests/dataset-fixture.mjs';
import {fixture as trainingFixture} from '../../platform/packages/plus-runtime/tests/transition-plan-fixture.mjs';
import {transitionEstimatorId} from './transition-fit.mjs';
import {createPrivateNativeFitVerifiers,privateFitRequest} from './private-fit-registry.mjs';
import {fitInProcess} from './fit-worker.mjs';

// Real native Machine TRAIN sources, qualified longitudinal material, immutable
// FIT exposure, fixed numerical fitter and verified candidate completion.
// Controlled synthetic authority/clock adapters; not private Task deployment.
async function fixture(t){
  const f=await trainingFixture(t,{actionBound:true,historyVersion:'plus-native-action-interval-policy-v3'});
  f.endpointConfig.authorize=async p=>[trainer.id,owner.id].includes(p.id);
  f.intervalConfig.authorize=async p=>[trainer.id,owner.id].includes(p.id);
  const worker={...trainer,id:'transition-material-worker',roles:['plus_compute_worker']};
  const config={storage:f.storage,tenantId:ctx.tenantId,datasets:f.endpointConfig.datasets,recipes:f.recipes,transitionPlans:f.plan,
    ...createPrivateNativeFitVerifiers({recipes:f.recipes}),clock:()=>Date.parse(at(29)),
    authorize:async p=>[trainer.id,worker.id,owner.id].includes(p.id),
    policyFor:async()=>({version:'plus-compute-policy-v1',workerId:worker.id,engineId:transitionEstimatorId,recipeHash:f.recipeHash,leaseMs:300000,maxAttempts:2}),
    resolvePrincipal:async id=>structuredClone(id===trainer.id?trainer:worker),authorizationRevision:f.planConfig.authorizationRevision};
  const compute=new NativeComputeAdmission(config),job=await compute.enqueue(f.frozenIds[0],'FIT',trainer,'transition-material-fit');
  const dispatch=await compute.claim(job.id,worker),candidate=await fitInProcess(privateFitRequest(dispatch.recipe,[dispatch.transitionInput.material]));
  await compute.completeFit(job.id,dispatch.version,dispatch.leaseToken,candidate,worker);
  return {...f,config,compute,job,dispatch};
}

test('current native transition result qualifies material once per distinct actor and retains exact original FIT exposure',async t=>{
  const f=await fixture(t),materialize=f.plan.materializeForFit.bind(f.plan);let calls=[];
  f.plan.materializeForFit=(...args)=>{calls.push(args[2].id);return materialize(...args);};
  const read=p=>f.compute.readTransitionFitForEvaluation(f.job.id,p);
  const legacy=await read(trainer);assert.deepEqual(calls,[trainer.id,trainer.id,trainer.id],'Original result path reproduces three same-actor material traversals');
  f.config.readConsistency='SHARED_NATIVE_AND_AUTHORITY';calls=[];
  const current=await read(trainer);assert.deepEqual(calls,[trainer.id],'Only the freshly qualified current material may be reused');assert.deepEqual(current,legacy);
  assert.deepEqual(current.transition.material,f.dispatch.transitionInput.material,'The original exposure, never the current read-set, remains the scoring material');
  calls=[];const other=await read(owner);assert.deepEqual(calls,[trainer.id,owner.id],'An independent reader must qualify their own TRAIN/history grants');
  assert.deepEqual(other.transition.material,current.transition.material);
  calls=[];await read(trainer);assert.deepEqual(calls,[trainer.id],'Independent requests always requalify');
  f.endpointConfig.authorize=async p=>p.id===trainer.id;
  await assert.rejects(()=>read(owner),/FORBIDDEN/,'Independent reader does not inherit surviving submitter permission');
});

test('shared result qualification fails if full authority is absent and never masks late native or secondary-identity changes',async t=>{
  for(const race of ['missing-authority','native','authority','submitter-expiry','reader-permission']){
    await t.test(race,async sub=>{
      const f=await fixture(sub);f.config.readConsistency='SHARED_NATIVE_AND_AUTHORITY';
      let expired=false,reached=false;
      const authority=f.config.authorizationRevision;
      f.config.authorizationRevision=async p=>{if(expired&&p.id===trainer.id)throw Object.assign(Error('ORIGINAL_TRAINER_EXPIRED'),{code:'ORIGINAL_TRAINER_EXPIRED'});return authority(p);};
      if(race==='missing-authority'){delete f.config.authorizationRevision;await assert.rejects(()=>f.compute.readTransitionFitForEvaluation(f.job.id,trainer),/SHARED_AUTHORITY_REQUIRED/);return;}
      const stored=f.compute.storedResult.bind(f.compute);
      f.compute.storedResult=async(...args)=>{const value=await stored(...args);reached=true;
        if(race==='native'){const row=await f.storage.getObject(ctx,'PlusExecution',f.job.id);await f.storage.updateObject(ctx,'PlusExecution',row._id,{status:row.status},row._version);}
        if(race==='authority')f.bump();
        if(race==='submitter-expiry')expired=true;
        if(race==='reader-permission')f.config.authorize=async p=>p.id!==owner.id;
        return value;
      };
      await assert.rejects(()=>f.compute.readTransitionFitForEvaluation(f.job.id,owner),/CONFLICT|STALE|EXPIRED|FORBIDDEN/);assert.equal(reached,true,'Race occurs after real native material qualification');
      assert.equal((await f.storage.queryObjects(ctx,'PlusDeployment',{and:[]})).totalCount,0);
    });
  }
});
