import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeOntologyWorkbench} from '../public-plus/native-ontology-ui.js';

// Explicit component DOM/network adapters, not native publication or browser
// evidence. Native HTTP tests independently cover actual schema changes.
function fixture(){
  const nodes=new Map(),buttons=[],suggestionButtons=[];const $=key=>{
    if(!nodes.has(key)){let html='';const node={value:'',disabled:false};Object.defineProperty(node,'innerHTML',{get:()=>html,set:v=>{html=v;if(key==='#content'){buttons.length=0;suggestionButtons.length=0;for(const m of v.matchAll(/data-ontology-revision="([^"]+)"/g))buttons.push({dataset:{ontologyRevision:m[1]}});for(const m of v.matchAll(/data-ontology-suggestion="([^"]+)"/g))suggestionButtons.push({dataset:{ontologySuggestion:m[1]}});}}});nodes.set(key,node);}return nodes.get(key);
  };
  let principal={id:'author',roles:['data_reviewer']},busy=false,last=Promise.resolve(),error,failSave=false,published=false;
  const source={odl:'type WorkItem @objectType { id:ID! @primary }',manifests:{},disabledActions:[]};
  const catalog={bundle:{source,contentHash:'base-hash',parsed:{objectTypes:[{name:'WorkItem',fields:[]},{name:'PlusMetadata',fields:[]}]}}};
  const candidate={...source,odl:'type WorkItem @objectType { id:ID! @primary note:String }'};
  const record={_id:'revision-2',_version:1,revision:2,status:'DRAFT',submittedBy:'author',parentHash:'base-hash',contentHash:'candidate-hash'};
  const calls=[];
  const api=async(path,epoch,body,key)=>{
    calls.push({path,epoch,body:structuredClone(body),key});
    if(path==='/ontology/property-previews')return {source:candidate,expectedParentHash:'base-hash',contentHash:'candidate-hash',changes:[{objectType:'WorkItem',field:'note',valueType:'String'}],readOnly:true};
    if(path==='/ontology/revisions'&&body){if(failSave){failSave=false;throw Error('NETWORK_TIMEOUT');}return structuredClone(record);}
    if(path==='/ontology/revisions')return [structuredClone(record)];
    if(path.endsWith('/validate')){assert.equal(body.expectedVersion,1);record.status='VALIDATED';record._version=2;return structuredClone(record);}
    if(path.endsWith('/review')){assert.equal(body.expectedVersion,2);assert.equal(body.reason,'Reviewed exact optional addition');record.status=body.decision==='APPROVE'?'PUBLISHED':'REJECTED';return structuredClone(record);}
    if(path==='/ontology/revisions/revision-2')return {record:structuredClone(record),bundle:{parsed:{objectTypes:[]},manifests:{},disabledActions:[]}};
    assert.fail(path);
  };
  const run=task=>{if(busy)return;busy=true;last=task(1).catch(e=>{error=e;}).finally(()=>{busy=false;});return last;};
  const ui=createNativeOntologyWorkbench({document:{querySelector:$,querySelectorAll:selector=>selector==='[data-ontology-revision]'?buttons:selector==='[data-ontology-suggestion]'?suggestionButtons:[]},api,run,isBusy:()=>busy,getCatalog:()=>catalog,getPrincipal:()=>principal,onPublished:async()=>{published=true;}});
  ui.render();
  const preview=async()=>{$('#ontology-property-type').value='WorkItem';$('#ontology-property-name').value='note';$('#ontology-property-value-type').value='String';$('#ontology-property-form').onsubmit({preventDefault(){}});await last;};
  return {$,ui,calls,buttons,suggestionButtons,catalog,record,preview,settle:()=>last,error:()=>error,published:()=>published,failSave:()=>failSave=true,owner:()=>{principal={id:'owner',roles:['model_owner']};ui.reset();ui.render();}};
}
test('form preview and retry keep a stable draft key and exact base, then validate and independently review a selected revision',async()=>{
  const f=fixture();await f.preview();assert.deepEqual(f.calls[0].body,{objectType:'WorkItem',field:'note',valueType:'String',expectedParentHash:'base-hash'});
  assert.equal(f.calls.length,1,'preview alone cannot save or publish');
  f.failSave();f.$('#ontology-save-draft').onclick();await f.settle();assert.match(f.error().message,/NETWORK_TIMEOUT/);
  f.$('#ontology-save-draft').onclick();await f.settle();
  const saves=f.calls.filter(c=>c.path==='/ontology/revisions'&&c.body);assert.equal(saves.length,2);assert.equal(saves[0].key,saves[1].key);assert.match(saves[0].key,/^[a-z0-9-]+$/);assert.deepEqual(saves[0].body,saves[1].body);
  assert.equal(saves[0].body.expectedParentHash,'base-hash');assert.equal(saves[0].body.principal,undefined);
  f.$('#ontology-validate').onclick();await f.settle();assert.equal(f.record.status,'VALIDATED');
  assert.match(f.$('#content').innerHTML,/id="ontology-approve" disabled/,'author cannot self-approve in UI');
  f.owner();f.$('#ontology-revisions-refresh').onclick();await f.settle();f.buttons[0].onclick();await f.settle();
  f.$('#ontology-review-reason').value='Reviewed exact optional addition';f.$('#ontology-approve').onclick();await f.settle();assert.equal(f.published(),true);
  assert.deepEqual(f.calls.at(-1).body,{expectedVersion:2,decision:'APPROVE',reason:'Reviewed exact optional addition'});
});
test('editing a preview invalidates save, reset removes cross-session revision material, and blank review never writes',async()=>{
  const f=fixture();await f.preview();f.$('#ontology-property-name').value='changed';f.$('#ontology-property-name').oninput();assert.equal(f.$('#ontology-save-draft').disabled,true);
  const count=f.calls.length;f.$('#ontology-save-draft').onclick();await f.settle();assert.equal(f.calls.length,count);
  f.ui.reset();f.ui.render();assert.doesNotMatch(f.$('#content').innerHTML,/candidate-hash|base-hash|待保存的精确变更/);
  f.record.status='VALIDATED';f.record._version=2;f.owner();f.$('#ontology-revisions-refresh').onclick();await f.settle();f.buttons[0].onclick();await f.settle();
  f.$('#ontology-review-reason').value='';const before=f.calls.length;f.$('#ontology-approve').onclick();await f.settle();assert.equal(f.calls.length,before);assert.match(f.error().message,/审批理由/);
});

test('sample assistance performs no network write; choosing a suggestion only fills editable form and rejecting discards it',async()=>{
  const f=fixture(),raw=JSON.stringify([{effort:3,channel:'private sample'}]);
  f.$('#ontology-suggestion-file').files=[{size:raw.length,text:async()=>raw}];f.$('#ontology-suggestion-file').onchange();await f.settle();assert.equal(f.error(),undefined);
  assert.equal(f.calls.length,0);assert.equal(f.suggestionButtons.length,2);assert.doesNotMatch(f.$('#content').innerHTML,/private sample/);
  f.suggestionButtons[1].onclick();assert.equal(f.calls.length,0);assert.match(f.$('#content').innerHTML,/value="effort"/);
  f.$('#ontology-suggestions-discard').onclick();assert.equal(f.suggestionButtons.length,0);assert.equal(f.calls.length,0);
});

test('stale ontology and late file reads after identity reset cannot populate usable suggestions',async()=>{
  const f=fixture();f.$('#ontology-suggestion-file').files=[{size:10,text:async()=>'[{"effort":3}]'}];f.$('#ontology-suggestion-file').onchange();await f.settle();
  const oldButton=f.suggestionButtons[0];f.catalog.bundle.contentHash='new-hash';oldButton.onclick();assert.equal(f.suggestionButtons.length,0);assert.equal(f.calls.length,0);
  let finish;f.$('#ontology-suggestion-file').files=[{size:10,text:()=>new Promise(r=>finish=r)}];f.$('#ontology-suggestion-file').onchange();f.ui.reset();f.ui.render();finish('[{"late":true}]');await f.settle();
  assert.equal(f.error()?.discarded,true);assert.equal(f.suggestionButtons.length,0);assert.equal(f.calls.length,0);
});
