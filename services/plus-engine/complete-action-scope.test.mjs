import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {digest} from '../../platform/packages/plus-contracts/dist/index.js';
import {ctx,trainer,owner} from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import {createPrivateIdentityProvider} from '../../ops/plus-v2/private-identity.mjs';
import {createPrivateActionRequestAccess} from '../../ops/plus-v2/action-request-services.mjs';
import {completeActionRequestPolicy} from './learned-composition-private-action.mjs';

// Exact production permission gates and file identity; scope-only preflight.
// No fabricated model approval, action result, or complete-chain acceptance.
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'plus-complete-action-scope-')),path=join(dir,'auth.json');t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const investigator={id:'complete-investigator',tenantId:ctx.tenantId,roles:['investigator']},reviewer={id:'complete-private-action-reviewer',tenantId:ctx.tenantId,roles:['case_reviewer']};
  const now=Date.now(),rows=[trainer,owner,investigator,reviewer].map(p=>({...p,tokenHash:createHash('sha256').update('synthetic-'+p.id).digest('hex'),expiresAt:new Date(now+60000).toISOString()}));
  const save=()=>writeFileSync(path,JSON.stringify(rows),{mode:0o600});save();
  const policy={actionRequests:completeActionRequestPolicy('task.complete','online-episode',investigator,reviewer)};
  const options={tenantId:ctx.tenantId,identities:createPrivateIdentityProvider({authPath:path,tenantId:ctx.tenantId,clock:()=>now}),loadPolicy:()=>structuredClone(policy)};
  return {policy,access:createPrivateActionRequestAccess(options),rows,save,investigator,reviewer,
    scope:{scenarioId:'native-scenario',key:'task.complete',episodeId:'online-episode',actionName:'NativeRegisterInvestigationTask'}};
}

test('old full-host policy denies original model trainer history although action reviewer is authorized; fixed pre-FIT policy adds exact read only',async t=>{
  const f=fixture(t),fixed=structuredClone(f.policy.actionRequests);
  f.policy.actionRequests.grants=fixed.grants.filter(g=>![trainer.id,owner.id].includes(g.principalId));f.access.assertConfigured();
  assert.equal(await f.access.authorize(f.reviewer,'action-request:decide',f.scope),true);
  assert.equal(await f.access.authorize(f.reviewer,'action-request:read',f.scope),true);
  assert.equal(await f.access.authorize(trainer,'action-request:read',f.scope),false);
  assert.equal(await f.access.authorize(owner,'action-request:read',f.scope),false);
  f.policy.actionRequests=fixed;f.access.assertConfigured();const before=digest(f.policy);
  for(const p of [trainer,owner]){
    assert.equal(await f.access.authorize(p,'action-request:read',f.scope),true);
    for(const permission of ['action-request:submit','action-request:decide','action-request:execute'])assert.equal(await f.access.authorize(p,permission,f.scope),false);
  }
  assert.equal(digest(f.policy),before,'Preflight does not write policy or authorize an action');
  assert.equal(await f.access.authorize(f.investigator,'action-request:decide',f.scope),false);
  assert.equal(await f.access.authorize(f.reviewer,'action-request:execute',f.scope),false);
});

test('new history grant cannot read another purpose, episode, action or tenant and is not shared mutable actor configuration',async t=>{
  const f=fixture(t);
  for(const change of [{key:'another-purpose'},{episodeId:'another-episode'},{actionName:'NativeVerifyTaskObservation'},{extra:true}]){
    assert.equal(await f.access.authorize(trainer,'action-request:read',{...f.scope,...change}),false);
  }
  await assert.rejects(()=>f.access.authorize({...trainer,tenantId:'another-tenant'},'action-request:read',f.scope),/FORBIDDEN/);
  const grant=f.policy.actionRequests.grants.find(g=>g.principalId===trainer.id);assert.deepEqual(grant.permissions,['action-request:read']);
  const initialRoles=[...trainer.roles];grant.requiredRoles.push('forged-role');assert.deepEqual(trainer.roles,initialRoles);
  assert.equal(await f.access.authorize(trainer,'action-request:read',f.scope),false);
  grant.targets[0].episodeIds.push('another-episode');assert.deepEqual(f.policy.actionRequests.targets[0].episodeIds,['online-episode']);
  assert.throws(()=>f.access.assertConfigured(),/CONFIGURATION_INVALID/);
});

test('current file identity revocation still rejects read-only history; reviewer rights never rescue the original trainer',async t=>{
  const f=fixture(t);f.rows.find(p=>p.id===trainer.id).disabled=true;f.save();
  await assert.rejects(()=>f.access.authorize(trainer,'action-request:read',f.scope),/IDENTITY_FORBIDDEN/);
  assert.equal(await f.access.authorize(f.reviewer,'action-request:decide',f.scope),true);
  delete f.rows.find(p=>p.id===trainer.id).disabled;f.save();
  f.policy.actionRequests.grants=f.policy.actionRequests.grants.filter(g=>g.principalId!==trainer.id);
  assert.equal(await f.access.authorize(trainer,'action-request:read',f.scope),false);
});
