import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {nativeLearningInstallFixture} from './native-learning-install-fixture.mjs';
import {inspectNativeDatabase} from '../../../../ops/plus-v2/native-backup.mjs';
import {createNativeIntakeWorkbench} from '../../../apps/lwm-demo/public-plus/native-intake-ui.js';
import {ruleIntakeFields} from '../../../apps/lwm-demo/public-plus/native-intake.js';

// Actual normal bootstrap, published ontology, gateway, current identities,
// native action/CEL and persistence. DOM is a handler adapter, not a browser.
// Lost-response injection happens AFTER the real action commits.
test('delivered rule source form crosses the actual native gateway, recovers the original commit and refuses unauthorized imports without approving a model',
  {skip:process.platform!=='linux',timeout:90000},async t=>{
  const f=await nativeLearningInstallFixture(t);await f.start(f.profile);
  const catalog=await f.ok('data_reviewer','/ontology'),policy=readFileSync(f.profile.policyPath),auth=readFileSync(f.profile.authPath);
  const nodes=new Map(),$=key=>{if(!nodes.has(key))nodes.set(key,{value:'',disabled:false});return nodes.get(key);};
  let role='data_reviewer',last=Promise.resolve(),busy=false,error,html='',opened,lose=true;const sent=[];
  const api=async(path,epoch,body,key)=>{
    if(body)sent.push({path,body:structuredClone(body),key,role});
    const response=await f.call(role,path,body,key);
    if(response.status!==200)throw Object.assign(Error(response.body.error?.code??'HTTP_REFUSED'),{status:response.status});
    if(body&&lose){lose=false;throw Object.assign(Error('Injected response loss after real commit'),{status:502});}
    return response.body.data;
  };
  const run=fn=>{if(busy)return;busy=true;last=Promise.resolve().then(()=>fn(1)).catch(e=>{error=e;}).finally(()=>busy=false);return last;};
  const render=()=>{html=ui.markup();ui.bind();};
  const ui=createNativeIntakeWorkbench({document:{querySelector:$},api,run,isBusy:()=>busy,getCatalog:()=>catalog,getDetail:()=>null,
    onOpenObject:async ref=>{opened=await f.ok(role,'/objects/'+ref.type+'/'+ref.id);},onRender:render});render();
  const source={ruleKey:'form-source',title:'<script>not executed</script>',versionTag:'v1',effectiveFrom:new Date(Date.now()-1000).toISOString(),
    sourceCitation:'SYNTHETIC source, no automatic approval',sourceSystem:'demo-rule',sourceRecordId:'form-record',sourceRevision:'1'};
  const fill=input=>ruleIntakeFields.forEach(key=>$('#intake-RULE-'+key).value=input[key]);
  const preview=async input=>{fill(input);$('#intake-RULE').onsubmit({preventDefault(){}});await last;};
  await preview(source);assert.equal(sent.length,0);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);assert.match(html,/不批准规则、模型或训练/);
  $('#intake-confirm').onclick();await last;assert.equal(error.status,502);assert.match(html,/结果未知/);
  await preview({...source,title:'Not allowed to replace uncertain command'});
  $('#intake-confirm').onclick();await last;assert.equal(sent.length,2);assert.deepEqual(sent[0],sent[1]);assert.deepEqual(sent[1].body,source);assert.match(html,/原生幂等返回/);
  $('#intake-open').onclick();await last;assert.equal(opened.object._type,'RuleVersion');assert.equal(opened.object.title,source.title);assert.equal(opened.object.importedBy,'demo-data_reviewer');
  const original=opened.object,inventory=inspectNativeDatabase(f.profile.dbPath);assert.equal(inventory.objectsByType.RuleVersion,1);
  for(const type of ['PlusRuleSpecification','PlusModelRecipe','PlusModelRelease','PlusDeployment','TaskCompletionVerification','PlusExecution'])assert.equal(inventory.objectsByType[type],undefined,type);
  ui.reset();role='trainer';render();await preview({...source,ruleKey:'forbidden-source',sourceRecordId:'forbidden-source'});
  $('#intake-confirm').onclick();await last;assert.equal(error.status,403);assert.doesNotMatch(html,/原生事务已提交|原生幂等返回/);
  const afterDenied=inspectNativeDatabase(f.profile.dbPath),{auditHash:beforeAudit,auditRecords:beforeCount,...beforeFacts}=inventory,
    {auditHash:afterAudit,auditRecords:afterCount,...afterFacts}=afterDenied;
  assert.deepEqual(afterFacts,beforeFacts,'Refusal changes no native business objects, lineage, receipts or versions');
  assert.equal(afterCount,beforeCount+1,'Refusal must retain its independent failure audit');assert.notEqual(afterAudit,beforeAudit);
  assert.deepEqual(readFileSync(f.profile.policyPath),policy);assert.deepEqual(readFileSync(f.profile.authPath),auth);
  await f.runtime().close();await f.start(f.profile);role='data_reviewer';
  assert.deepEqual((await f.ok(role,'/objects/RuleVersion/'+original._id)).object,original);
  assert.equal(f.runtime().state().predictionReady,false);assert.equal(f.runtime().state().computeEnabled,false);
});
