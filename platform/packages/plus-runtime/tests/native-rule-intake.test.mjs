import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
import {planNativeDomain,applyNativeDomainPlan,readBootstrapFile} from '../../../../ops/plus-v2/native-domain-bootstrap.mjs';
import {startNativeRuntime,readNativeRuntimeProfile} from '../../../../ops/plus-v2/runtime-host.mjs';
import {createNativeStorage} from '../../../apps/lwm-demo/src/native-storage.mjs';
import {createTaskDomainAccess} from '../../../apps/lwm-demo/src/task-access.mjs';
import {createRuleIntakeDomain} from '../../../apps/lwm-demo/src/rule-intake.mjs';
import {NativeOntologyCatalog,buildOntologyBundle,ontologyStorageSchema} from '../dist/index.js';
import {CelClient} from '../../actions/dist/index.js';
import {loadDomainPacks} from '../../api/dist/schema-loader.js';
import {buildTaskVerificationInput} from '../../../domain-packs/lwm-plus/mechanisms/task-verification.mjs';
import {buildTaskPriorityInput} from '../../../domain-packs/lwm-plus/mechanisms/task-priority.mjs';
import {buildTaskRulesInput} from '../../../domain-packs/lwm-plus/mechanisms/task-rules.mjs';
import {buildTaskSourceGovernanceInput} from '../../../domain-packs/lwm-plus/mechanisms/task-source-governance.mjs';
import {buildMatterIntakeInput} from '../../../domain-packs/lwm-plus/mechanisms/matter-intake.mjs';
import {buildRuleIntakeInput} from '../../../domain-packs/lwm-plus/mechanisms/rule-intake.mjs';

const linux={skip:process.platform!=='linux',timeout:45000},route='/actions/NativeImportTaskRule';
const source=(n=1)=>({ruleKey:'synthetic-rule-'+n,title:'SYNTHETIC priority policy source',versionTag:'v1',effectiveFrom:new Date(Date.now()-5000).toISOString(),sourceCitation:'SYNTHETIC reviewed source description; not an executable expression',sourceSystem:'demo-rule',sourceRecordId:'rule-'+n,sourceRevision:'1'});
async function fixture(t){
  const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const celPort=probe.address().port;await new Promise(r=>probe.close(r));
  const parent=mkdtempSync(join(tmpdir(),'plus-rule-intake-')),plan=await planNativeDomain({schema:'plus-domain-bootstrap-request-v1',parentDir:parent,directoryName:'native',tenantId:'rule-intake-test',workspaceKey:'synthetic',ports:{control:0,workbench:0,cel:celPort},credentialHours:1});
  const receipt=await applyNativeDomainPlan(plan,plan.planHash),profile=readNativeRuntimeProfile(receipt.profilePath),storage=createNativeStorage(profile.dbPath),ctx={tenantId:profile.tenantId};let runtime;
  t.after(async()=>{await runtime?.close();storage.close();rmSync(parent,{recursive:true,force:true});});
  const start=async()=>{runtime=await startNativeRuntime(profile,{celBinary:process.env.LWM_CEL_BINARY});};await start();
  const token=role=>readBootstrapFile(receipt.personalAccessFiles.find(p=>p.roles.includes(role)).path).token;
  const call=async(role,path,body,key='native-rule-import-key')=>{const r=await fetch(runtime.state().workbenchUrl+'/api'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token(role),...(body?{'content-type':'application/json','idempotency-key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};};
  const rows=async type=>(await storage.queryObjects(ctx,type,{and:[]},{limit:100})).items;
  return {parent,plan,profile,storage,ctx,call,rows,runtime:()=>runtime,async restart(){await runtime.close();await start();},policy:()=>readBootstrapFile(profile.policyPath),save:value=>writeFileSync(profile.policyPath,JSON.stringify(value))};
}

test('normal empty installation imports a scoped native RuleVersion with source receipt, audit and restart, never a rule or model approval',linux,async t=>{
  const f=await fixture(t),input=source();assert.equal((await f.rows('RuleVersion')).length,0);
  const result=await f.call('data_reviewer',route,input);assert.equal(result.status,200,JSON.stringify(result));
  const receipt=result.body.data.receipt;assert.equal(receipt.resultType,'RuleVersion');assert.equal(receipt.actionName,'NativeImportTaskRule');
  const read=await f.call('viewer','/objects/RuleVersion/'+receipt.resultId);assert.equal(read.status,200,JSON.stringify(read));
  const rule=read.body.data.object;assert.equal(rule.workspaceKey,'synthetic');assert.equal(rule.dataClassification,'SYNTHETIC');assert.equal(rule.importedBy,'demo-data_reviewer');assert.equal(rule.importSourceRecordId,input.sourceRecordId);
  assert.equal(rule.deterministic,true);assert.equal(rule.lifecycle,'ACTIVE');assert.equal(rule.sourceCitation,input.sourceCitation);
  for(const type of ['PlusRuleSpecification','PlusModelRecipe','PlusDeployment','PlusEvent','TaskCompletionVerification','PlusComputeJob'])assert.equal((await f.rows(type)).length,0,type);
  assert.equal(Object.hasOwn(f.policy(),'taskRules'),false);assert.equal(f.runtime().state().predictionReady,false);assert.equal(f.runtime().state().computeEnabled,false);
  const audits=await f.rows('PlusOutbox');assert.ok(audits.some(row=>JSON.stringify(row).includes('NativeImportTaskRule')),'actual native audit outbox');
  await f.restart();assert.deepEqual((await f.call('viewer','/objects/RuleVersion/'+receipt.resultId)).body.data.object,rule);
  assert.equal((await f.call('data_reviewer',route,input)).body.data.replayed,true);assert.equal((await f.rows('RuleVersion')).length,1);
});

test('rule import rejects arbitrary effects and scope, reauthorizes receipts, deduplicates concurrent source deliveries and preserves source conflicts',linux,async t=>{
  const f=await fixture(t),input=source();
  for(const role of ['viewer','investigator','trainer','model_owner'])assert.equal((await f.call(role,route,input)).status,403);
  for(const patch of [{workspaceKey:'foreign'},{lifecycle:'ACTIVE'},{deterministic:false},{expression:'true'},{classification:'AUTHORIZED_REAL'},{effectiveFrom:'2026-02-30T00:00:00.000Z'}])assert.equal((await f.call('data_reviewer',route,{...input,...patch})).status,400);
  assert.equal((await f.call('data_reviewer',route,{...input,sourceSystem:'not-approved'})).status,403);
  assert.equal((await f.call('data_reviewer',route,input)).status,200);
  assert.equal((await f.call('data_reviewer',route,{...input,title:'Different payload'})).status,409);
  assert.equal((await f.call('data_reviewer',route,input,'lost-ack-same-source')).body.data.sourceReplay,true);
  assert.equal((await f.call('data_reviewer',route,{...input,title:'Different source content'},'conflicting-source')).status,409);
  assert.equal((await f.call('data_reviewer',route,{...input,sourceRevision:'2',versionTag:'v2'},'different-revision')).status,409,'no implicit overwrite of reviewed source dependencies');
  const next=source(2),keys=['concurrent-rule-first','concurrent-rule-second'];
  const results=await Promise.all(keys.map(key=>f.call('data_reviewer',route,next,key)));assert.ok(results.some(r=>r.status===200));assert.ok(results.every(r=>[200,409].includes(r.status)));
  for(const key of keys)assert.equal((await f.call('data_reviewer',route,next,key)).status,200);
  assert.equal((await f.rows('RuleVersion')).length,2);
  const policy=f.policy(),grant=policy.taskDomain.grants.find(g=>g.actions.includes('NativeImportTaskRule'));
  grant.workspaces=['foreign'];f.save(policy);assert.equal((await f.call('data_reviewer',route,input)).status,403);assert.equal((await f.call('data_reviewer',route,source(3),'foreign-create-rule')).status,403);
  grant.workspaces=['synthetic'];grant.types.RuleVersion.write=grant.types.RuleVersion.write.filter(k=>k!=='importContentHash');f.save(policy);
  assert.equal((await f.call('data_reviewer',route,source(3),'missing-write-field')).status,403);
  grant.types.RuleVersion.write.push('importContentHash');delete policy.taskDomain.ruleImportSources['demo-rule'];f.save(policy);
  assert.equal((await f.call('data_reviewer',route,input)).status,403);assert.equal((await f.rows('RuleVersion')).length,2);
});

test('source authority withdrawal during actual native staging atomically rolls back RuleVersion, receipt and audit',linux,async t=>{
  const f=await fixture(t),p={id:'demo-data_reviewer',tenantId:f.profile.tenantId,roles:['data_reviewer']};let inject=true;
  const storage=new Proxy(f.storage,{get(target,key){if(key!=='beginTransaction')return target[key];return async(...args)=>{const tx=await target.beginTransaction(...args);return new Proxy(tx,{get(transaction,property){if(property!=='createObject')return transaction[property];return async(...values)=>{const value=await transaction.createObject(...values);if(inject&&values[0]==='NativeCommandReceipt'){inject=false;const policy=f.policy();delete policy.taskDomain.ruleImportSources['demo-rule'];f.save(policy);}return value;};}});};}});
  const access=createTaskDomainAccess({storage,tenantId:p.tenantId,loadPolicy:f.policy,reauthenticate:async()=>{}}),catalog=new NativeOntologyCatalog({storage,tenantId:p.tenantId,authorize:async()=>true});
  const client=new CelClient({address:'127.0.0.1:'+f.profile.ports.cel,maxRetries:0,timeoutMs:2000});t.after(()=>client.close());
  const domain=createRuleIntakeDomain({storage,catalog,cel:client,tenantId:p.tenantId,...access}),before=(await f.rows('PlusOutbox')).length;
  await assert.rejects(()=>domain.execute(source(),p,'withdraw-rule-in-stage'));assert.equal(inject,false,'actual transaction staging reached');
  assert.equal((await f.rows('RuleVersion')).length,0);assert.equal((await f.rows('NativeCommandReceipt')).length,0);assert.equal((await f.rows('PlusOutbox')).length,before);
});

test('existing ontology receives additive independently reviewed rule intake without seeding sources or reviving legacy actions',linux,async t=>{
  const parent=mkdtempSync(join(tmpdir(),'plus-rule-publication-')),storage=createNativeStorage(join(parent,'platform.sqlite')),tenantId='rule-publication',ctx={tenantId};
  t.after(()=>{storage.close();rmSync(parent,{recursive:true,force:true});});
  const loaded=await loadDomainPacks(fileURLToPath(new URL('../../../domain-packs',import.meta.url)),['core','lwm-demo','lwm-plus','plus-core'],[]);
  const odl=loaded.packInfos.flatMap(p=>p.manifest.schema.map(path=>readFileSync(join(p.packDir,path),'utf8'))).join('\n');
  const baseline=buildMatterIntakeInput(buildTaskSourceGovernanceInput(buildTaskRulesInput(buildTaskPriorityInput(buildTaskVerificationInput({odl,manifests:{},disabledActions:loaded.parsed.actionTypes.map(a=>a.name)}),{initializePriority:true}))));
  const initial=buildOntologyBundle(baseline);await storage.applySchema(ctx,ontologyStorageSchema(initial,1));
  const author={id:'author',tenantId,roles:['data_reviewer']},owner={id:'owner',tenantId,roles:['model_owner']},catalog=new NativeOntologyCatalog({storage,tenantId,authorize:async p=>[author.id,owner.id].includes(p.id)&&p.tenantId===tenantId});
  await catalog.adoptInstalledBaseline(baseline,owner);
  const next=buildRuleIntakeInput(baseline),draft=await catalog.submit(next,author,'publish-rule-intake',initial.contentHash),valid=await catalog.validate(draft._id,draft._version,author);
  await assert.rejects(()=>catalog.review(valid._id,valid._version,'APPROVE','self approval',author),/INDEPENDENT/);
  await catalog.review(valid._id,valid._version,'APPROVE','Reviewed native source registration and unchanged model gates',owner);
  const current=await catalog.read(owner);assert.equal(current.bundle.contentHash,buildOntologyBundle(next).contentHash);assert.equal(current.head.storageVersion,2);
  assert.ok(current.bundle.manifests.NativeImportTaskRule);for(const name of initial.disabledActions)assert.ok(current.bundle.disabledActions.includes(name));
  for(const type of ['RuleVersion','PlusRuleSpecification','PlusModelRecipe'])assert.equal((await storage.queryObjects(ctx,type,{and:[]},{limit:10})).items.length,0);
});
