import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '@openfoundry/plus-contracts';
import { NativePublishedModelReference } from '../dist/index.js';
// Dependency fault injection only. No native-publication/material claim here.
test('reference dependency traversal refuses cycles/depth and releases async context after failure',async()=>{
 const principal={id:'reader',tenantId:'guard',roles:['trainer']};let mode='cycle',calls=0;
 const config={tenantId:'guard',storage:{getReadRevision:async()=> 'native-epoch'},authorizationRevision:async()=>digest('complete-authority'),
  deployments:{read:async key=>{calls++;if(mode==='cycle')return references.capture(key,principal);
    if(mode==='depth')return references.capture(key+'x',principal);throw new Error('ORIGINAL_NATIVE_DENIAL');}}};
 const references=new NativePublishedModelReference(config);
 await assert.rejects(()=>references.capture('a',principal),/DEPENDENCY_CYCLE/);assert.equal(calls,1);
 mode='depth';calls=0;await assert.rejects(()=>references.capture('a',principal),/DEPENDENCY_LIMIT/);assert.equal(calls,16);
 mode='denial';calls=0;
 const outcomes=await Promise.allSettled([references.capture('a',principal),references.capture('a',principal)]);
 assert.equal(calls,2);assert.ok(outcomes.every(r=>r.status==='rejected'&&r.reason.message==='ORIGINAL_NATIVE_DENIAL'));
});
