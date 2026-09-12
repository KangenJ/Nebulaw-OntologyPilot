import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync,writeFileSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeStorage } from '../../../apps/lwm-demo/src/native-storage.mjs';
import { tokenAuthenticator } from '../../../apps/lwm-demo/src/auth.mjs';
import { NativeOntologyCatalog,buildOntologyBundle,ontologyStorageSchema,createPlusControlHandler } from '../dist/index.js';
import { fixture as contractFixture } from '../../plus-contracts/tests/fixture.mjs';

const metadata=readFileSync(new URL('../../../domain-packs/plus-core/schema/metadata.odl',import.meta.url),'utf8');
const odl=`enum Completion { DONE NOT_DONE UNKNOWN }
type Task @objectType {id:ID! @primary actual:Completion! status:String! priority:Int! createdAt:DateTime! receivedAt:DateTime! signals:[Signal!]! @link(type:"RootSignal",direction:OUTBOUND)}
type Signal @objectType {id:ID! @primary report:Completion! @sensitive observedAt:DateTime! receivedAt:DateTime!}
type RootSignal @linkType(from:"Task",to:"Signal",cardinality:ONE_TO_MANY) {id:ID! @primary}
type VerifyObject @actionType(permission:"can_review") {task:Task! @param expectedVersion:Int! @param note:String! @param}`;
const ctx={tenantId:'lwm-demo'};
const people={author:{id:'author',tenantId:ctx.tenantId,roles:['data_reviewer']},owner:{id:'owner',tenantId:ctx.tenantId,roles:['model_owner']},viewer:{id:'viewer',tenantId:ctx.tenantId,roles:['viewer']},foreign:{id:'foreign',tenantId:'foreign',roles:['model_owner']}};
const permit=async(p,permission)=>permission.endsWith(':read')||p.roles.includes(permission.endsWith(':publish')||permission.endsWith(':adopt')?'model_owner':'data_reviewer');
async function fixture(t,extra={}){
  const dir=mkdtempSync(join(tmpdir(),'plus-http-test-')),db=join(dir,'platform.sqlite'),auth=join(dir,'credentials.json');
  const contract=contractFixture(),baseline={odl:metadata+odl,manifests:{VerifyObject:contract.manifest},disabledActions:[]};
  const records=Object.entries(people).map(([token,p])=>({...p,tokenHash:createHash('sha256').update(token).digest('hex'),expiresAt:new Date(Date.now()+60000).toISOString()}));
  const save=()=>writeFileSync(auth,JSON.stringify(records));save();
  const storage=createNativeStorage(db);await storage.applySchema(ctx,ontologyStorageSchema(buildOntologyBundle(baseline),1));
  const catalog=new NativeOntologyCatalog({storage,tenantId:ctx.tenantId,authorize:permit});await catalog.adoptInstalledBaseline(baseline,people.owner);
  let authorize=permit,policy=structuredClone(contract.context.policy),failAudit=false;
  const {wrapStorage,...httpExtra}=extra;
  const handler=createPlusControlHandler({storage:wrapStorage?wrapStorage(storage):storage,tenantId:ctx.tenantId,authenticate:tokenAuthenticator(auth),authorizeOntology:(...args)=>authorize(...args),authorizeDefinition:(...args)=>authorize(...args),policyFor:async()=>structuredClone(policy),recordFailure:r=>{if(failAudit)throw new Error('disk error and secret');return storage.auditStore.appendIdempotent(r);},...httpExtra});
  const server=createServer(async(req,res)=>{if(!await handler(req,res)){res.writeHead(404);res.end('outside');}});
  server.requestTimeout=5000;await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));storage.close();rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}/api/plus/v2`;
  async function request(path,{token='viewer',method='GET',body,raw,headers={}}={}){
    const response=await fetch(base+path,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),...(body!==undefined||raw!==undefined?{'content-type':'application/json'}:{}),...headers},...(body!==undefined||raw!==undefined?{body:raw??JSON.stringify(body)}:{})});
    return {status:response.status,headers:response.headers,value:await response.json()};
  }
  async function draft(){const r=await request('/ontology/revisions',{method:'POST',token:'author',body:{...baseline,odl:baseline.odl.replace('priority:Int!','priority:Int! description:String')},headers:{'idempotency-key':'schema-request-001'}});assert.equal(r.status,200,JSON.stringify(r.value));return r.value.data;}
  return {storage,catalog,baseline,definition:contract.definition,request,draft,records,save,setAuthorize:fn=>authorize=fn,setPolicy:p=>policy=p,policy:()=>structuredClone(policy),failAudit:()=>failAudit=true};
}

test('candidate and pinned preview HTTP authoring uses current native policy, exact hashes and existing revision lifecycle',async t=>{
  let f;f=await fixture(t,{definitionKeys:async()=>[f.definition.key],definitionCandidateFor:async()=>structuredClone(f.definition)});
  const base='/definitions/'+f.definition.key,epoch=await f.storage.getReadRevision(ctx);
  const index=await f.request('/definition-candidates');assert.equal(index.status,200);assert.equal(index.value.data.items.length,1);
  const candidate=await f.request(base+'/candidate');assert.equal(candidate.status,200);assert.equal(candidate.value.data.predictionReady,false);
  for(const url of ['/definition-candidates?keys=hidden',base+'/candidate?policy=forged'])assert.equal((await f.request(url)).status,400);
  const raw={...candidate.value.data.definition,title:'Form edited title'};
  assert.equal((await f.request(base+'/previews',{method:'POST',body:raw})).status,403);
  const p=await f.request(base+'/previews',{method:'POST',token:'author',body:raw});assert.equal(p.status,200,JSON.stringify(p.value));assert.equal(p.value.data.definition.title,raw.title);
  const body={definition:p.value.data.definition,expectedCompiledHash:p.value.data.compiledHash};
  const d=await f.request(base+'/revisions',{method:'POST',token:'author',body});assert.equal(d.status,200);assert.equal(d.value.data.compiledHash,body.expectedCompiledHash);
  const again=await f.request(base+'/revisions',{method:'POST',token:'author',body});assert.equal(again.value.data._id,d.value.data._id);
  assert.equal((await f.request(base+'/revisions',{method:'POST',token:'author',body:{...body,principal:people.owner}})).status,400);
  const v=await f.request(base+'/revisions/'+d.value.data._id+'/validate',{method:'POST',token:'author',body:{expectedVersion:d.value.data._version}});assert.equal(v.status,200);
  const a=await f.request(base+'/revisions/'+d.value.data._id+'/review',{method:'POST',token:'owner',body:{expectedVersion:v.value.data._version,decision:'APPROVE'}});assert.equal(a.status,200);assert.equal(a.value.data.status,'PUBLISHED');
  assert.equal((await f.request(base+'/candidate')).value.data.nextRevision,2);assert.equal((await f.storage.queryObjects(ctx,'PlusModelRelease',{and:[]})).totalCount,0);assert.notEqual(await f.storage.getReadRevision(ctx),epoch);
  const next=await f.request(base+'/candidate'),p2=await f.request(base+'/previews',{method:'POST',token:'author',body:next.value.data.definition});assert.equal(p2.status,200);
  const policy=f.policy();policy.id+='-changed';f.setPolicy(policy);assert.equal((await f.request(base+'/revisions',{method:'POST',token:'author',body:{definition:p2.value.data.definition,expectedCompiledHash:p2.value.data.compiledHash}})).status,409);
});

test('candidate HTTP reauthenticates after private material access and does not return it after token revocation',async t=>{
  let f,calls=0;f=await fixture(t,{definitionKeys:async()=>[f.definition.key],definitionCandidateFor:async()=>{if(++calls===2){f.records.find(r=>r.id==='viewer').expiresAt='2000-01-01T00:00:00Z';f.save();}return structuredClone(f.definition);}});
  const r=await f.request('/definitions/'+f.definition.key+'/candidate');assert.equal(r.status,401);assert.doesNotMatch(JSON.stringify(r.value),/variables|actual|report/);
});

test('snapshot pause error maps to a sanitized HTTP conflict (transport-only service stub)',async t=>{
 const f=await fixture(t,{createEpisodeRuntime:()=>({readSnapshot:async()=>{throw Object.assign(new Error('PRIVATE_PAYLOAD'),{code:'EPISODE_INPUT_SUSPENDED'});}})});
 const response=await f.request('/snapshots/paused-input');assert.equal(response.status,409);assert.equal(response.value.error.code,'EPISODE_INPUT_SUSPENDED');assert.equal(JSON.stringify(response.value).includes('PRIVATE_PAYLOAD'),false);
});

test('reviewed context history repair errors are explicit conflicts, not internal failures (transport-only service stub)',async t=>{
  let code='CONTEXT_HISTORY_PARTIAL_TIME';
  const f=await fixture(t,{createEpisodeRuntime:()=>({readTemporalInput:async()=>{throw Object.assign(new Error('PRIVATE_TASK_HISTORY'),{code});}})});
  for(code of ['CONTEXT_HISTORY_PARTIAL_TIME','CONTEXT_HISTORY_INITIAL_CLOCK_CHANGED','CONTEXT_HISTORY_INITIAL_REENTRY']){
    const response=await f.request('/snapshots/time-input/temporal-input');assert.equal(response.status,409);assert.equal(response.value.error.code,code);
    assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(JSON.stringify(response.value).includes('PRIVATE_TASK_HISTORY'),false);
  }
});

test('native HTTP uses the real token authenticator; missing, expired, malformed and foreign credentials are rejected',async t=>{
  const f=await fixture(t);
  for(const token of ['', 'unknown'])assert.equal((await f.request('/ontology',{token})).status,401);
  assert.equal((await f.request('/ontology',{token:'foreign'})).status,403);
  const before=await f.storage.getReadRevision(ctx),read=await f.request('/ontology');
  assert.equal(read.status,200);assert.equal(read.headers.get('cache-control'),'no-store');assert.equal(await f.storage.getReadRevision(ctx),before);
  f.records.find(r=>r.id==='viewer').expiresAt='2000-01-01T00:00:00Z';f.save();
  assert.equal((await f.request('/ontology')).status,401);
});
test('HTTP ontology authoring, exact replay, independent approval and read-only version history operate on native storage',async t=>{
  const f=await fixture(t),d=await f.draft(),replay=await f.draft();assert.equal(replay._id,d._id);
  const list=await f.request('/ontology/revisions');assert.equal(list.value.data.length,2);assert.equal(list.value.data.some(r=>r.bundle),false);
  const detail=await f.request('/ontology/revisions/'+d._id);assert.equal(detail.value.data.bundle.contentHash,d.contentHash);
  const v=await f.request(`/ontology/revisions/${d._id}/validate`,{method:'POST',token:'author',body:{expectedVersion:d._version}});assert.equal(v.status,200);
  const self=await f.request(`/ontology/revisions/${d._id}/review`,{method:'POST',token:'author',body:{expectedVersion:v.value.data._version,decision:'APPROVE',reason:'self'}});assert.equal(self.status,403);
  const approved=await f.request(`/ontology/revisions/${d._id}/review`,{method:'POST',token:'owner',body:{expectedVersion:v.value.data._version,decision:'APPROVE',reason:'reviewed'}});
  assert.equal(approved.status,200);assert.equal(approved.value.data.status,'PUBLISHED');
  assert.equal((await f.request('/ontology')).value.data.head.storageVersion,2);
  const stale=await f.request(`/ontology/revisions/${d._id}/review`,{method:'POST',token:'owner',body:{expectedVersion:v.value.data._version,decision:'APPROVE',reason:'double click'}});assert.equal(stale.status,409);
});
test('form-driven native property preview is read-only and goes through draft, validation, independent publication and actual schema',async t=>{
  const f=await fixture(t),current=await f.catalog.read(people.viewer),epoch=await f.storage.getReadRevision(ctx);
  const input={objectType:'Task',field:'reviewNote',valueType:'String',expectedParentHash:current.bundle.contentHash};
  const p=await f.request('/ontology/property-previews',{method:'POST',token:'author',body:input});
  assert.equal(p.status,200,JSON.stringify(p.value));const preview=p.value.data;
  assert.equal(preview.readOnly,true);assert.deepEqual(preview.changes,[{kind:'ADD_OPTIONAL_PROPERTY',objectType:'Task',field:'reviewNote',valueType:'String'}]);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.request('/ontology/revisions')).value.data.length,1);
  const next=buildOntologyBundle(preview.source),field=next.parsed.objectTypes.find(t=>t.name==='Task').fields.find(f=>f.name==='reviewNote');
  assert.equal(field.type.nonNull,false);assert.equal(field.type.name,'String');assert.deepEqual(next.manifests,current.bundle.manifests);assert.deepEqual(next.disabledActions,current.bundle.disabledActions);
  const body={...preview.source,expectedParentHash:preview.expectedParentHash},headers={'idempotency-key':'property-form-test-001'};
  const d=await f.request('/ontology/revisions',{method:'POST',token:'author',body,headers});assert.equal(d.status,200);
  assert.equal((await f.request('/ontology')).value.data.bundle.contentHash,current.bundle.contentHash,'draft does not publish');
  assert.equal((await f.request('/ontology/revisions',{method:'POST',token:'author',body,headers})).value.data._id,d.value.data._id);
  const id=d.value.data._id,v=await f.request(`/ontology/revisions/${id}/validate`,{method:'POST',token:'author',body:{expectedVersion:d.value.data._version}});assert.equal(v.status,200);
  const approved=await f.request(`/ontology/revisions/${id}/review`,{method:'POST',token:'owner',body:{expectedVersion:v.value.data._version,decision:'APPROVE',reason:'Reviewed optional property and unchanged action definitions'}});
  assert.equal(approved.status,200);assert.equal(approved.value.data.status,'PUBLISHED');
  assert.equal((await f.storage.getSchema(ctx)).objectTypes.find(t=>t.name==='Task').properties.find(p=>p.name==='reviewNote').required,false);
  assert.equal((await f.request('/ontology')).value.data.bundle.contentHash,preview.contentHash);
  assert.equal((await f.request('/ontology/revisions',{method:'POST',token:'author',body,headers})).value.data._id,id,'exact draft retry after publication');
  assert.equal((await f.request('/ontology/revisions',{method:'POST',token:'author',body,headers:{'idempotency-key':'property-form-stale-002'}})).status,409);
});

test('property previews reject stale bases, control metadata, role widening, required fields and invalid identifiers',async t=>{
  const f=await fixture(t),current=await f.catalog.read(people.viewer),input={objectType:'Task',field:'note',valueType:'String',expectedParentHash:current.bundle.contentHash};
  const send=(body,token='author')=>f.request('/ontology/property-previews',{method:'POST',token,body});
  assert.equal((await send(input,'viewer')).status,403);
  for(const patch of [{field:'status'},{objectType:'PlusOntologyRevision'},{objectType:'Missing'},{valueType:'String!'},{field:'note: String! }'},{field:'_id'},{required:true},{principal:people.owner}]){
    assert.equal((await send({...input,...patch})).status,400,JSON.stringify(patch));
  }
  assert.equal((await send({...input,expectedParentHash:'stale'})).status,409);
  let once=true;const catalog=new NativeOntologyCatalog({storage:f.storage,tenantId:ctx.tenantId,authorize:async(p,permission)=>{if(once&&permission==='ontology:draft'){once=false;input.field='injected: String! }';}return permit(p,permission);}});
  const safe=await catalog.previewOptionalProperty(input,people.author);assert.equal(input.field,'injected: String! }');assert.equal(safe.changes[0].field,'note','caller mutation cannot change validated preview');
  assert.equal((await f.request('/ontology/revisions')).value.data.length,1);
});

test('bounded native structure previews reject control/ambiguous/injected definitions and preserve current authorization',async t=>{
  const f=await fixture(t),current=await f.catalog.read(people.viewer),input={kind:'OBJECT',name:'Deliverable',properties:[{name:'title',valueType:'String'}],expectedParentHash:current.bundle.contentHash};
  const send=(body,token='author')=>f.request('/ontology/structure-previews',{method:'POST',token,body});
  assert.equal((await send(input,'viewer')).status,403);
  for(const patch of [{name:'PlusControl'},{name:'Task'},{name:'Injected }'},{properties:[]},{properties:[{name:'id',valueType:'String'}]},
    {properties:[{name:'title',valueType:'String!'}]},{properties:[{name:'title',valueType:'String',required:true}]},
    {properties:[{name:'title',valueType:'String'},{name:'title',valueType:'Int'}]},{principal:people.owner},{kind:'DELETE'}])assert.equal((await send({...input,...patch})).status,400,JSON.stringify(patch));
  assert.equal((await send({...input,expectedParentHash:'stale'})).status,409);
  const link={kind:'LINK',name:'TaskSignalReviewed',from:'Task',to:'Signal',cardinality:'MANY_TO_MANY',expectedParentHash:current.bundle.contentHash};
  for(const patch of [{from:'PlusOutbox'},{to:'Absent'},{cardinality:''},{cardinality:'ONE'},{properties:[]},{name:'RootSignal'}])assert.equal((await send({...link,...patch})).status,400);
  const epoch=await f.storage.getReadRevision(ctx),object=await send(input),relation=await send(link);
  assert.equal(object.status,200,JSON.stringify(object.value));assert.equal(relation.status,200,JSON.stringify(relation.value));
  assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.request('/ontology/revisions')).value.data.length,1);
  assert.deepEqual(object.value.data.source.manifests,current.bundle.source.manifests);assert.equal(relation.value.data.permissionsGranted,false);
});

test('mechanism draft/validate/publish is reachable over HTTP; metadata lists exclude raw IR and publication is not model readiness',async t=>{
  const f=await fixture(t),base='/definitions/'+f.definition.key;
  assert.equal((await f.request(base+'/published')).status,503);
  const d=await f.request(base+'/revisions',{method:'POST',token:'author',body:f.definition});assert.equal(d.status,200,JSON.stringify(d.value));
  const v=await f.request(`${base}/revisions/${d.value.data._id}/validate`,{method:'POST',token:'author',body:{expectedVersion:1}});assert.equal(v.status,200);
  const p=await f.request(`${base}/revisions/${d.value.data._id}/review`,{method:'POST',token:'owner',body:{expectedVersion:v.value.data._version,decision:'APPROVE'}});assert.equal(p.status,200);
  const epoch=await f.storage.getReadRevision(ctx),published=await f.request(base+'/published');assert.equal(published.status,200);assert.equal(published.value.data.predictionReady,false);
  const history=await f.request(base+'/revisions');assert.equal(history.value.data.length,1);assert.equal('compiled' in history.value.data[0],false);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);
  const policy=f.policy();policy.readableFields=policy.readableFields.filter(n=>n!=='Signal.report');f.setPolicy(policy);
  assert.equal((await f.request(base+'/published')).status,409);
  const stale=await f.request(`${base}/revisions/${d.value.data._id}`);assert.equal(stale.status,200);assert.equal('compiled' in stale.value.data,false);assert.equal('definition' in stale.value.data.record,false);
});
test('parameter index and manifest use native publication, reject caller-selected discovery scope and withhold revoked fields',async t=>{
  let f;f=await fixture(t,{definitionKeys:async()=>[f.definition.key]});
  assert.deepEqual((await f.request('/definitions')).value.data.items,[]);
  const base='/definitions/'+f.definition.key;
  const draft=await f.request(base+'/revisions',{method:'POST',token:'author',body:f.definition});assert.equal(draft.status,200,JSON.stringify(draft.value));
  const path=base+'/revisions/'+draft.value.data._id,valid=await f.request(path+'/validate',{method:'POST',token:'author',body:{expectedVersion:draft.value.data._version}});assert.equal(valid.status,200);
  const publish=await f.request(path+'/review',{method:'POST',token:'owner',body:{expectedVersion:valid.value.data._version,decision:'APPROVE'}});assert.equal(publish.status,200);
  const epoch=await f.storage.getReadRevision(ctx),index=await f.request('/definitions'),manifest=await f.request(base+'/parameters');
  assert.equal(index.value.data.items[0].key,f.definition.key);assert.equal(manifest.status,200,JSON.stringify(manifest.value));assert.equal(manifest.value.data.schema,'plus-parameter-manifest-v1');assert.equal(manifest.value.data.predictionReady,false);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.request('/definitions?keys=private')).status,400);
  assert.equal((await f.request(base+'/parameters',{method:'POST',token:'owner',body:{}})).status,404);
  const policy=f.policy();policy.readableFields=policy.readableFields.filter(field=>field!=='Signal.report');f.setPolicy(policy);
  const revoked=await f.request(base+'/parameters');assert.equal(revoked.status,409);assert.equal(revoked.value.data,undefined);assert.doesNotMatch(JSON.stringify(revoked.value),/Signal.report/);
});

test('definition discovery defaults closed and rechecks live credentials around the server key provider',async t=>{
  const f=await fixture(t);assert.equal((await f.request('/definitions')).status,403);
  let revoked;revoked=await fixture(t,{definitionKeys:async()=>{revoked.records.splice(revoked.records.findIndex(r=>r.id==='viewer'),1);revoked.save();return [];}});
  const response=await revoked.request('/definitions');assert.equal(response.status,401);assert.equal(response.value.data,undefined);
});

test('revocation during a schema command rolls back its native transaction and writes a separate denied audit without credential leakage',async t=>{
  const f=await fixture(t),outboxes=(await f.storage.queryObjects(ctx,'PlusOutbox',{and:[]})).totalCount;
  f.setAuthorize(async(p,permission)=>{if(permission==='ontology:draft'){f.records.splice(f.records.findIndex(r=>r.id==='author'),1);f.save();}return permit(p,permission);});
  const r=await f.request('/ontology/revisions',{method:'POST',token:'author',body:{...f.baseline,odl:f.baseline.odl.replace('priority:Int!','priority:Int! more:String')},headers:{'idempotency-key':'revoked-request'}});
  assert.equal(r.status,401);assert.equal((await f.storage.queryObjects(ctx,'PlusOntologyRevision',{and:[]})).totalCount,1);
  assert.equal((await f.storage.queryObjects(ctx,'PlusOutbox',{and:[]})).totalCount,outboxes);
  const audits=await f.storage.auditStore.query();assert.equal(audits.length,1);assert.equal(audits[0].detail.result,'denied');assert.equal(audits[0].detail.denialReason,'UNAUTHENTICATED');assert.equal(JSON.stringify(audits).includes('Bearer'),false);
});
test('a read finishing after token revocation does not deliver the stored bundle',async t=>{
  const f=await fixture(t);let checks=0;
  f.setAuthorize(async(p,permission)=>{if(permission==='ontology:read'&&++checks===1){f.records.splice(f.records.findIndex(r=>r.id==='viewer'),1);f.save();}return permit(p,permission);});
  const epoch=await f.storage.getReadRevision(ctx),r=await f.request('/ontology');assert.equal(r.status,401);assert.equal('data' in r.value,false);assert.equal(await f.storage.getReadRevision(ctx),epoch);
});

test('postcommit credential revocation withholds command data but preserves native history and exact replay',async t=>{
  let revoked=false;
  // Native SQLite exposes methods through a get trap; assignment does not replace
  // those methods. Intercept the actual commit through an outer proxy instead.
  const f=await fixture(t,{wrapStorage:storage=>new Proxy(storage,{get(target,property){
    if(property!=='beginTransaction')return target[property];
    return async(...args)=>{const tx=await target.beginTransaction(...args);return new Proxy(tx,{get(transaction,method){
      if(method!=='commit')return transaction[method];
      return async()=>{const result=await transaction.commit();if(!revoked){revoked=true;f.records.splice(f.records.indexOf(original),1);f.save();}return result;};
    }});};
  }})});
  const original=f.records.find(r=>r.id==='author');
  const body={...f.baseline,odl:f.baseline.odl.replace('priority:Int!','priority:Int! more:String')},headers={'idempotency-key':'postcommit-revocation'};
  const response=await f.request('/ontology/revisions',{method:'POST',token:'author',body,headers});
  assert.equal(revoked,true);assert.equal(response.status,401);assert.equal('data' in response.value,false);
  const revisions=await f.storage.queryObjects(ctx,'PlusOntologyRevision',{and:[]}),outboxes=await f.storage.queryObjects(ctx,'PlusOutbox',{and:[]});
  assert.equal(revisions.totalCount,2);assert.equal(outboxes.totalCount,2);
  const draft=revisions.items.find(r=>r.status==='DRAFT');assert.ok(draft);
  f.records.push({...original,tokenHash:createHash('sha256').update('rotated-author').digest('hex')});f.save();
  const replay=await f.request('/ontology/revisions',{method:'POST',token:'rotated-author',body,headers});
  assert.equal(replay.status,200,JSON.stringify(replay.value));assert.equal(replay.value.data._id,draft._id);
  assert.equal((await f.storage.queryObjects(ctx,'PlusOntologyRevision',{and:[]})).totalCount,2);
  assert.equal((await f.storage.queryObjects(ctx,'PlusOutbox',{and:[]})).totalCount,2);
  const audits=await f.storage.auditStore.query();assert.equal(audits.length,1);assert.equal(audits[0].detail.denialReason,'UNAUTHENTICATED');
});
test('no public baseline adoption, raw object write, injected principal or missing concurrency guard',async t=>{
  const f=await fixture(t);
  for(const path of ['/ontology/adopt','/objects/Task','/ontology/revisions/anything/execute'])assert.equal((await f.request(path,{method:'POST',token:'owner',body:{}})).status,404);
  const injected=await f.request('/ontology/revisions',{method:'POST',token:'viewer',body:{...f.baseline,principal:people.owner},headers:{'idempotency-key':'injected-request'}});assert.equal(injected.status,400);
  const denied=await f.request('/ontology/revisions',{method:'POST',token:'viewer',body:f.baseline,headers:{'idempotency-key':'denied-request'}});assert.equal(denied.status,403);
  const d=await f.draft();assert.equal((await f.request(`/ontology/revisions/${d._id}/validate`,{method:'POST',token:'author',body:{}})).status,400);
});
test('malformed JSON, oversized body, content type, wrong mechanism key and unknown operation fail closed',async t=>{
  const f=await fixture(t),post={method:'POST',token:'author'};
  assert.equal((await f.request('/ontology/revisions',{...post,raw:'{broken'})).status,400);
  assert.equal((await f.request('/ontology/revisions',{...post,raw:' '.repeat(1_048_577)})).status,413);
  assert.equal((await f.request('/ontology/revisions',{...post,body:{},headers:{'content-type':'text/plain'}})).status,400);
  assert.equal((await f.request('/definitions/other/revisions',{...post,body:f.definition})).status,400);
  assert.equal((await f.request('/unknown')).status,404);
  assert.equal((await f.storage.queryObjects(ctx,'PlusOntologyRevision',{and:[]})).totalCount,1);
});
test('failure-audit outage is explicit and never produces a successful response',async t=>{
  const f=await fixture(t);f.failAudit();
  const r=await f.request('/ontology/revisions',{method:'POST',token:'viewer',body:f.baseline,headers:{'idempotency-key':'denied-request'}});
  assert.equal(r.status,503);assert.equal(r.value.error.code,'AUDIT_UNAVAILABLE');assert.equal(JSON.stringify(r.value).includes('secret'),false);
});
