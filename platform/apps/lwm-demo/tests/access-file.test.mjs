import test from 'node:test';
import assert from 'node:assert/strict';
import {parseAccessFile} from '../public-plus/access-file.js';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createAppServer} from '../server.mjs';
const now=Date.parse('2026-09-08T00:00:00Z');
const personal={schema:'plus-private-personal-credential-v1',tenantId:'synthetic',id:'individual',roles:['investigator'],token:'synthetic-test-only-token',expiresAt:'2026-09-08T01:00:00Z'};
const parse=value=>parseAccessFile(JSON.stringify(value),now);
test('individual rotation output can be imported as exactly one identity without trusting file roles',()=>{
  const result=parse({...personal,warning:'not a role grant'});
  assert.equal(result.kind,'PERSONAL');assert.deepEqual(result.credentials,[{id:personal.id,role:'investigator',token:personal.token}]);
  assert.equal(result.principal,undefined);assert.equal(result.authenticated,undefined);
});
test('legacy assigned bundle remains supported and returns only presentation fields',()=>{
  const r=parse({expiresAt:personal.expiresAt,credentials:[{id:'demo',role:'viewer',token:'synthetic-viewer',ignored:'extra'}]});
  assert.equal(r.kind,'LEGACY_BUNDLE');assert.deepEqual(Object.keys(r.credentials[0]).sort(),['id','role','token']);
});
test('expired and invalid expiry files are rejected without exposing tokens',()=>{
  for(const expiresAt of ['2026-09-07T00:00:00Z','2026-09-08T00:00:00Z','invalid',null,undefined]){
    assert.throws(()=>parse({...personal,expiresAt}),e=>!e.message.includes(personal.token)&&/过期|到期时间/.test(e.message));
  }
});
test('server hashes, malformed credentials and ambiguous bundles are rejected',()=>{
  for(const value of [[{...personal,tokenHash:'not-a-token'}],{...personal,token:undefined}, {...personal,token:'Bearer secret'},
    {...personal,roles:[]},{...personal,roles:['viewer','viewer']},{...personal,schema:'unknown'},
    {expiresAt:personal.expiresAt,credentials:[]},{expiresAt:personal.expiresAt,credentials:[{id:'a',role:'viewer',token:'same'},{id:'b',role:'viewer',token:'same'}]}])assert.throws(()=>parse(value));
});
test('parser bounds input and never echoes malformed file contents',()=>{
  for(const raw of ['sensitive-invalid-json',JSON.stringify(personal).repeat(1000)])assert.throws(()=>parseAccessFile(raw,now),e=>!e.message.includes('sensitive-invalid-json'));
  assert.throws(()=>parseAccessFile(JSON.stringify(personal),NaN));
});
test('actual gateway serves personal-credential module with same-origin security headers',async t=>{
  // Static-asset check only. The upstream is deliberately unused: this is not
  // authentication, browser rendering, native model health or deployment proof.
  const server=createAppServer({platformUrl:'http://127.0.0.1:1',assetsRoot:fileURLToPath(new URL('../public-plus/',import.meta.url))});
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
  const module=await fetch(base+'/access-file.js');assert.equal(module.status,200);
  assert.match(module.headers.get('content-type'),/^text\/javascript/);assert.equal(module.headers.get('cache-control'),'no-store');
  assert.match(module.headers.get('content-security-policy'),/script-src 'self'/);assert.match(await module.text(),/export function parseAccessFile/);
  const app=await fetch(base+'/app.js');assert.match(await app.text(),/import \{parseAccessFile\} from '\.\/access-file.js'/);
  const page=await fetch(base+'/');const html=await page.text();assert.match(html,/credential\.json/);assert.doesNotMatch(html,/260 参数/);
});
