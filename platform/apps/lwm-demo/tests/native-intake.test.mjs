import test from 'node:test';
import assert from 'node:assert/strict';
import {planNativeIntake,createNativeIntakeCommand} from '../public-plus/native-intake.js';
const catalog={bundle:{contentHash:'catalog-1',manifests:{NativeImportTaskMatter:{},NativeRegisterInvestigationTask:{}},disabledActions:[],parsed:{enums:[{name:'RiskBand',values:[{name:'LOW'},{name:'HIGH'}]}]}}};
const input={matterNumber:'ROOT-1',title:'New source',jurisdiction:'TEST',currentState:'UNASSESSED',riskBand:'LOW',openedAt:'2026-01-01T00:00:00.000Z',sourceSystem:'source',sourceRecordId:'record',sourceRevision:'1'};
const plan=()=>planNativeIntake({kind:'MATTER',input,catalog});

test('rule source preview binds the native action without a Matter, labels, executable rules or client authority',()=>{
  const ruleCatalog={bundle:{contentHash:'rule-schema',manifests:{NativeImportTaskRule:{}},disabledActions:[]}},source={ruleKey:'rule-1',title:'Source',versionTag:'v1',effectiveFrom:'2026-01-01T00:00:00.000Z',sourceCitation:'SYNTHETIC source declaration, not an approved expression',sourceSystem:'demo-rule',sourceRecordId:'r1',sourceRevision:'1'};
  const p=planNativeIntake({kind:'RULE',input:source,catalog:ruleCatalog});assert.equal(p.action,'NativeImportTaskRule');assert.equal(p.resultType,'RuleVersion');assert.deepEqual(p.body,source);
  for(const patch of [{classification:'GOLD'},{workspaceKey:'foreign'},{expression:'true'},{deterministic:true},{effectiveFrom:'2099-01-01T00:00:00.000Z'},{effectiveFrom:'2026-02-30T00:00:00.000Z'}])assert.throws(()=>planNativeIntake({kind:'RULE',input:{...source,...patch},catalog:ruleCatalog}));
  assert.throws(()=>planNativeIntake({kind:'RULE',input:source,catalog:{bundle:{...ruleCatalog.bundle,disabledActions:['NativeImportTaskRule']}}}),/尚未发布/);
});
test('intake preflight uses published enum/action and exact source fields without inventing labels',()=>{
  const p=plan();assert.deepEqual(p.body,input);assert.equal(p.resultType,'Matter');assert.equal(Object.hasOwn(p.body,'workspaceKey'),false);
  for(const patch of [{classification:'GOLD'},{riskBand:'UNKNOWN'},{openedAt:'2026-02-30T00:00:00.000Z'},{sourceSystem:''}])assert.throws(()=>planNativeIntake({kind:'MATTER',input:{...input,...patch},catalog}));
  assert.throws(()=>planNativeIntake({kind:'MATTER',input,catalog:{bundle:{...catalog.bundle,disabledActions:['NativeImportTaskMatter']}}}),/尚未发布/);
  const task={taskNumber:'T-1',title:'Check',priority:'HIGH',assignee:'actor',instructions:'collect evidence',dueAt:'2027-01-01T00:00:00.000Z'};
  assert.throws(()=>planNativeIntake({kind:'TASK',input:task,catalog}),/Matter/);
  const t=planNativeIntake({kind:'TASK',input:task,catalog,matter:{type:'Matter',id:'m1',version:3}});assert.equal(t.body.expectedVersion,3);assert.equal(t.resultType,'InvestigationTask');
});
test('uncertain receipt reuses immutable request and key even if caller edits its preview; successful submission never repeats',async()=>{
  const p=plan(),command=createNativeIntakeCommand(p,{newKey:()=> 'stable-intake-key'}),calls=[];let lose=true;
  const api=async(path,epoch,body,key)=>{if(path==='/ontology')return catalog;calls.push({body,key});if(lose){lose=false;throw Object.assign(Error('response lost after commit'),{status:502});}return {success:true,replayed:true,receipt:{_id:'receipt',actionName:p.action,resultType:'Matter',resultId:'m1'}};};
  await assert.rejects(()=>command.submit(api,1));assert.equal(command.snapshot().status,'UNCERTAIN');p.body.title='mutated';
  await command.submit(api,1);assert.deepEqual(calls[0],calls[1]);assert.equal(calls[1].body.title,input.title);assert.equal(command.snapshot().status,'REPLAYED');
  await command.submit(api,1);assert.equal(calls.length,2);
});
test('known denial and catalog drift cannot look committed; reset discards late response and source replay has no fabricated receipt',async()=>{
  const c=createNativeIntakeCommand(plan());await assert.rejects(()=>c.submit(async path=>{if(path==='/ontology')return catalog;throw Object.assign(Error('FORBIDDEN'),{status:403});},1));assert.equal(c.snapshot().status,'FAILED');assert.equal(c.snapshot().reference,null);
  let writes=0;const stale=createNativeIntakeCommand(plan());await assert.rejects(()=>stale.submit(async path=>{if(path==='/ontology')return {bundle:{contentHash:'new'}};writes++;},1));assert.equal(writes,0);
  const late=createNativeIntakeCommand(plan());let release;const active=late.submit(async path=>path==='/ontology'?catalog:new Promise(r=>release=r),1);await new Promise(r=>setImmediate(r));late.invalidate();release({success:true,sourceReplay:true,replayed:true,result:{type:'Matter',id:'source-matter',version:1}});await assert.rejects(()=>active,e=>e.discarded===true);
  const source=createNativeIntakeCommand(plan());await source.submit(async path=>path==='/ontology'?catalog:{success:true,sourceReplay:true,replayed:true,result:{type:'Matter',id:'source-matter',version:1}},1);assert.equal(source.snapshot().status,'REPLAYED');assert.equal(source.snapshot().receiptId,null);
});
