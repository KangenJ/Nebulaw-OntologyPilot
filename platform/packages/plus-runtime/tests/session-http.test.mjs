import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPlusControlHandler} from '../dist/index.js';
import {createPrivateIdentityProvider} from '../../../../ops/plus-v2/private-identity.mjs';
import {createAppServer} from '../../../apps/lwm-demo/server.mjs';

// Real HTTP gateway/control handler and file identity provider. The clock is
// explicit; ontology/model storage is a fail-on-use sentinel because /me must
// neither expose business facts nor claim that a model/workspace is ready.
async function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'plus-native-session-')),authPath=join(dir,'auth.json'),tenantId='session-test';
  let now=Date.parse('2026-09-08T00:00:00Z'),authenticateCalls=0,revokeOnFinal=false;
  const rows=[{id:'individual',tenantId,roles:['viewer'],tokenHash:createHash('sha256').update('synthetic-token').digest('hex'),expiresAt:new Date(now+60000).toISOString()}];
  const save=()=>writeFileSync(authPath,JSON.stringify(rows),{mode:0o600});save();
  const identities=createPrivateIdentityProvider({authPath,tenantId,clock:()=>now});
  const unused=()=>assert.fail('Identity route must not touch business/model storage or grants');
  const handler=createPlusControlHandler({storage:new Proxy({},{get:unused}),tenantId,
    authenticate:request=>{authenticateCalls++;if(revokeOnFinal&&authenticateCalls===2){rows.length=0;save();}
      return {...identities.authenticate(request),token:'PRIVATE_PROVIDER_METADATA',tokenHash:'NEVER_RETURN'};},
    authorizeOntology:unused,authorizeDefinition:unused,policyFor:unused,recordFailure:async()=>{}});
  const upstream=createServer((request,response)=>{void handler(request,response).then(handled=>{if(!handled){response.writeHead(404);response.end('{}');}});});
  const servers=[upstream];
  t.after(async()=>{for(const server of servers.reverse()){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}rmSync(dir,{recursive:true,force:true});});
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const gateway=createAppServer({platformUrl:'http://127.0.0.1:'+upstream.address().port,platformApiPrefix:'/api/plus/v2'});servers.push(gateway);
  gateway.listen(0,'127.0.0.1');await once(gateway,'listening');const base='http://127.0.0.1:'+gateway.address().port;
  async function request({token='synthetic-token',path='/api/me',method='GET',headers={}}={}){
    authenticateCalls=0;const response=await fetch(base+path,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),...headers}});
    return {status:response.status,headers:response.headers,body:await response.json()};
  }
  return {request,rows,save,advance:ms=>now+=ms,revokeOnFinal:()=>{revokeOnFinal=true;}};
}
test('v2 gateway identity exposes only current server identity, never provider secrets or model readiness',async t=>{
  const f=await fixture(t),r=await f.request({path:'/api/me?platformApiPrefix=/api/lwm&principal=owner',headers:{'x-principal-id':'owner','x-roles':'model_owner'}});
  assert.equal(r.status,200);assert.deepEqual(r.body.data,{id:'individual',tenantId:'session-test',roles:['viewer']});
  assert.equal(r.headers.get('cache-control'),'no-store');assert.match(r.headers.get('content-security-policy'),/default-src 'self'/);
  assert.doesNotMatch(JSON.stringify(r.body),/PRIVATE_PROVIDER_METADATA|NEVER_RETURN|predictionReady|tokenHash/);
  assert.equal((await f.request({token:null})).status,401);assert.equal((await f.request({token:'wrong'})).status,401);
  f.rows[0].roles=['investigator'];f.save();assert.deepEqual((await f.request()).body.data.roles,['investigator']);
  f.rows[0].tenantId='foreign';f.save();assert.equal((await f.request()).status,403);
});
test('v2 identity rejects expiry, removal and withdrawal between authentication and response',async t=>{
  const f=await fixture(t);f.advance(60000);assert.equal((await f.request()).status,401);
  f.advance(-60000);f.rows[0].disabled=true;f.save();assert.equal((await f.request()).status,401);
  delete f.rows[0].disabled;f.save();f.revokeOnFinal();const r=await f.request();assert.equal(r.status,401);assert.equal(r.body.data,undefined);
  assert.equal((await f.request()).status,401);
});
test('gateway rejects arbitrary API prefix instead of selecting a caller-provided authority',()=>{
  for(const platformApiPrefix of ['/api','/api/plus/v2/','//evil.invalid','https://evil.invalid','/api/../admin','']){
    assert.throws(()=>createAppServer({platformUrl:'http://127.0.0.1:1',platformApiPrefix}),/Unsupported platform API prefix/);
  }
});
