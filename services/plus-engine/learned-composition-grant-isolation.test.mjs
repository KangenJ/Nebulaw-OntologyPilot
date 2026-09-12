import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { ctx,trainer,owner } from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import { createPrivateActionIntervalAccess } from '../../ops/plus-v2/action-interval-services.mjs';
import { completeActionIntervalGrants } from './learned-composition-native-admission.mjs';

// Actual private configuration and current-identity checks, synthetic ids only.
// This regression is NOT a substitute for the full newly trained model chain.
test('complete-model actor grants do not alias when new validation and online episodes are appended; duplicate authority remains rejected',async()=>{
  const principals=[trainer,owner],episodes=['original-fit'];
  const history={version:'plus-native-action-interval-policy-v3',id:'complete-fixture',rootType:'InvestigationTask',rootEpisodeLink:'TaskPlusEpisode',
    nativeActions:['NativeRegisterInvestigationTask'],inventory:'TENANT_WIDE',orphanPolicy:'REJECT_INTERVAL'};
  const target=id=>({episodeId:id,rootId:'root-'+id,purpose:'TRANSITION_FIT',policy:history});
  const policy={actionIntervals:{version:'plus-private-action-intervals-v1',enabled:true,targets:[target(episodes[0])],grants:[]}};
  const identities={authorizationRevision:()=>digest(principals),resolvePrincipal:async id=>{
    const p=principals.find(p=>p.id===id);assert.ok(p);return structuredClone(p);
  }};
  const access=createPrivateActionIntervalAccess({tenantId:ctx.tenantId,identities,loadPolicy:()=>policy});
  // Reproduce the exact old alias: the second append mutates the first actor's
  // array too. The private validator must reject, not silently deduplicate it.
  policy.actionIntervals.grants=principals.map(p=>({principalId:p.id,requiredRoles:p.roles,episodeIds:episodes,permissions:['action-interval:inventory']}));
  policy.actionIntervals.targets.push(target('new-heldout'));
  for(const grant of policy.actionIntervals.grants)grant.episodeIds.push('new-heldout');
  assert.throws(()=>access.assertConfigured(),{code:'ACTION_INTERVAL_CONFIGURATION_INVALID'});
  const original=['original-fit'];policy.actionIntervals.grants=completeActionIntervalGrants(original,principals);
  const [one,two]=policy.actionIntervals.grants;
  assert.notEqual(one.episodeIds,two.episodeIds);assert.notEqual(one.episodeIds,original);
  assert.notEqual(one.requiredRoles,trainer.roles);
  for(const grant of policy.actionIntervals.grants)grant.episodeIds.push('new-heldout');
  access.assertConfigured();assert.deepEqual(original,['original-fit']);
  for(const p of principals)assert.deepEqual(await access.policyFor(p,'new-heldout'),history);
  policy.actionIntervals.targets.push(target('new-online'));
  one.episodeIds.push('new-online');
  assert.equal(two.episodeIds.includes('new-online'),false);
  await assert.rejects(()=>access.policyFor(owner,'new-online'),{code:'ACTION_INTERVAL_FORBIDDEN'});
  two.episodeIds.push('new-online');access.assertConfigured();
  assert.deepEqual(await access.policyFor(owner,'new-online'),history);
  one.episodeIds.push('new-online');assert.throws(()=>access.assertConfigured(),{code:'ACTION_INTERVAL_CONFIGURATION_INVALID'});
});
