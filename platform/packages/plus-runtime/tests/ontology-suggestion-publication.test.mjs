import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {planNativeDomain,applyNativeDomainPlan} from '../../../../ops/plus-v2/native-domain-bootstrap.mjs';
import {readNativeRuntimeProfile,startNativeRuntime} from '../../../../ops/plus-v2/runtime-host.mjs';
import {inspectNativeDatabase} from '../../../../ops/plus-v2/native-backup.mjs';
import {suggestOptionalProperties,suggestBusinessStructure} from '../../../apps/lwm-demo/public-plus/ontology-suggestions.js';

test('new sample suggestion is editable, remains readonly until native approval and actually publishes through normal private gateway',
  {skip:process.platform!=='linux',timeout:45000},async t=>{
    const dir=mkdtempSync(join(tmpdir(),'plus-suggestion-publish-'));let host;
    t.after(async()=>{await host?.close();rmSync(dir,{recursive:true,force:true});});
    const plan=await planNativeDomain({schema:'plus-domain-bootstrap-request-v1',parentDir:dir,directoryName:'demo',tenantId:'suggestion-demo',workspaceKey:'synthetic',ports:{control:0,workbench:0,cel:0},credentialHours:1});
    const installed=await applyNativeDomainPlan(plan,plan.planHash),p=readNativeRuntimeProfile(installed.profilePath);
    host=await startNativeRuntime(p,{celBinary:process.env.LWM_CEL_BINARY});
    const credentials=Object.fromEntries(installed.personalAccessFiles.map(f=>[f.roles[0],JSON.parse(readFileSync(f.path,'utf8'))]));
    const request=async(path,role,body,key)=>{const r=await fetch(host.state().workbenchUrl+'/api'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+credentials[role].token,...(body?{'content-type':'application/json'}:{}),...(key?{'idempotency-key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};};
    const ok=async(...args)=>{const r=await request(...args);assert.equal(r.status,200,JSON.stringify(r.body));return r.body.data;};
    const catalog=await ok('/ontology','data_reviewer'),before=inspectNativeDatabase(p.dbPath);
    const suggestions=suggestOptionalProperties({rows:[{externalReference:'never-upload-private-a'},{externalReference:'never-upload-private-b'}],objectType:'Matter',catalog});
    assert.deepEqual(suggestions.suggestions.map(s=>[s.field,s.valueType]),[['externalReference','String']]);
    // Human edit of the proposed name, then existing authoritative native path.
    const input={objectType:'Matter',field:'reviewedReference',valueType:'String',expectedParentHash:catalog.bundle.contentHash};
    assert.equal((await request('/ontology/property-previews','viewer',input)).status,403);
    const afterDenied=inspectNativeDatabase(p.dbPath);assert.equal(afterDenied.stateHash,before.stateHash);assert.equal(afterDenied.auditRecords,before.auditRecords+1,'Rejected access must leave its existing audit record');
    const preview=await ok('/ontology/property-previews','data_reviewer',input);assert.deepEqual(inspectNativeDatabase(p.dbPath),afterDenied);
    const draft=await ok('/ontology/revisions','data_reviewer',{...preview.source,expectedParentHash:preview.expectedParentHash},'suggestion-edited-once');
    await ok('/ontology/revisions/'+draft._id+'/validate','data_reviewer',{expectedVersion:draft._version});
    const current=await ok('/ontology/revisions/'+draft._id,'data_reviewer');
    assert.equal((await request('/ontology/revisions/'+draft._id+'/review','data_reviewer',{expectedVersion:current.record._version,decision:'APPROVE',reason:'Not independent'})).status,403);
    await ok('/ontology/revisions/'+draft._id+'/review','model_owner',{expectedVersion:current.record._version,decision:'APPROVE',reason:'Reviewed optional attribute inferred from new sample'});
    const published=await ok('/ontology','viewer'),type=published.bundle.parsed.objectTypes.find(t=>t.name==='Matter');
    assert.ok(type.fields.some(f=>f.name==='reviewedReference'));assert.ok(!type.fields.some(f=>f.name==='externalReference'));
    assert.notEqual(published.bundle.contentHash,catalog.bundle.contentHash);assert.equal(host.state().computeEnabled,false);
    const after=inspectNativeDatabase(p.dbPath);assert.equal(after.objectsByType.PlusModelRelease,undefined);assert.equal(after.objectsByType.Matter,undefined);
  });

test('fresh collection object and reviewed reference publish through actual managed native HTTP without ingesting samples or granting model authority',
  {skip:process.platform!=='linux',timeout:45000},async t=>{
    const dir=mkdtempSync(join(tmpdir(),'plus-structure-publish-'));let host;
    t.after(async()=>{await host?.close();rmSync(dir,{recursive:true,force:true});});
    const plan=await planNativeDomain({schema:'plus-domain-bootstrap-request-v1',parentDir:dir,directoryName:'demo',tenantId:'structure-demo',workspaceKey:'synthetic',ports:{control:0,workbench:0,cel:0},credentialHours:1});
    const installed=await applyNativeDomainPlan(plan,plan.planHash),p=readNativeRuntimeProfile(installed.profilePath);
    host=await startNativeRuntime(p,{celBinary:process.env.LWM_CEL_BINARY});
    const credentials=Object.fromEntries(installed.personalAccessFiles.map(f=>[f.roles[0],JSON.parse(readFileSync(f.path,'utf8'))]));
    const request=async(path,role,body,key)=>{const r=await fetch(host.state().workbenchUrl+'/api'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+credentials[role].token,...(body?{'content-type':'application/json'}:{}),...(key?{'idempotency-key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};};
    const ok=async(...args)=>{const r=await request(...args);assert.equal(r.status,200,JSON.stringify(r.body));return r.body.data;};
    const publish=async(input,key)=>{
      const before=inspectNativeDatabase(p.dbPath),preview=await ok('/ontology/structure-previews','data_reviewer',input);
      assert.deepEqual(inspectNativeDatabase(p.dbPath),before);assert.equal(preview.permissionsGranted,false);
      const draft=await ok('/ontology/revisions','data_reviewer',{...preview.source,expectedParentHash:preview.expectedParentHash},key);
      assert.equal((await ok('/ontology/revisions','data_reviewer',{...preview.source,expectedParentHash:preview.expectedParentHash},key))._id,draft._id);
      const validated=await ok('/ontology/revisions/'+draft._id+'/validate','data_reviewer',{expectedVersion:draft._version});
      assert.equal((await request('/ontology/revisions/'+draft._id+'/review','data_reviewer',{expectedVersion:validated._version,decision:'APPROVE',reason:'self'})).status,403);
      await ok('/ontology/revisions/'+draft._id+'/review','model_owner',{expectedVersion:validated._version,decision:'APPROVE',reason:'Independent additive business structure review'});
      return await ok('/ontology','viewer');
    };
    const tables={Deliverable:[{title:'never-upload-source-value',matterId:'never-upload-reference'}]},catalog=await ok('/ontology','viewer');
    const candidate=suggestBusinessStructure({tables,catalog}).objects[0];
    let published=await publish({kind:'OBJECT',name:candidate.name,properties:[{name:'reviewedTitle',valueType:candidate.properties[0].valueType}],expectedParentHash:catalog.bundle.contentHash},'structure-new-object');
    assert.ok(published.bundle.parsed.objectTypes.find(o=>o.name==='Deliverable').fields.some(f=>f.name==='reviewedTitle'));
    const link=suggestBusinessStructure({tables,catalog:published}).links[0];assert.equal(link.endpointsPublished,true);
    published=await publish({kind:'LINK',name:'ReviewedMatterDeliverable',from:link.to,to:link.from,cardinality:'ONE_TO_MANY',expectedParentHash:published.bundle.contentHash},'structure-new-link');
    const actual=published.bundle.parsed.linkTypes.find(l=>l.name==='ReviewedMatterDeliverable');assert.equal(actual.from,'Matter');assert.equal(actual.to,'Deliverable');assert.equal(actual.cardinality,'ONE_TO_MANY');
    assert.deepEqual(published.bundle.manifests,catalog.bundle.manifests);assert.deepEqual(published.bundle.disabledActions,catalog.bundle.disabledActions);
    const inventory=inspectNativeDatabase(p.dbPath);assert.equal(inventory.objectsByType.Deliverable,undefined);assert.equal(inventory.objectsByType.PlusModelRelease,undefined);
    assert.equal(host.state().computeEnabled,false);assert.doesNotMatch(JSON.stringify(published.bundle),/never-upload/);
  });
